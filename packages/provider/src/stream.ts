import type { BackendLimits } from '@ai-translator-for-contentful/protocol';
import { ProviderError } from './errors';

// Reads one chat completion choice from a streamed (server-sent events) or
// buffered JSON response. Success needs terminal evidence: a `stop` finish.
// EOF, a length finish, refusals, errors and tool calls never yield content.

type Choice = { content: string; bytes: number; finish?: string; refused: boolean; tools: boolean };

const highSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

// The UTF-8 bytes `text` adds after `before`, as TextEncoder counts them: a
// lone surrogate takes three bytes (U+FFFD), and a low surrogate completing a
// pair split across deltas adds one more to make four.
function utf8Growth(before: string, text: string): number {
  let bytes = 0;
  let previous = before.charCodeAt(before.length - 1);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xdc00 && code <= 0xdfff && highSurrogate(previous)) bytes += 1;
    else bytes += 3;
    previous = code;
  }
  return bytes;
}

function applyChoice(choice: Choice, data: unknown, generatedBytes: number): void {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new ProviderError('invalid_provider_response', {
      reason: 'An event is not an object.',
      body: JSON.stringify(data),
    });
  if ('error' in data && data.error) throw new ProviderError('provider_failed', { body: JSON.stringify(data.error) });
  const choices = 'choices' in data ? data.choices : undefined;
  if (!Array.isArray(choices))
    throw new ProviderError('invalid_provider_response', {
      reason: 'An event has no choices.',
      body: JSON.stringify(data),
    });
  const first = choices.find(item => item && typeof item === 'object' && (item.index ?? 0) === 0);
  if (!first) return;
  const part = first.delta ?? first.message;
  if (part && typeof part === 'object') {
    if (typeof part.content === 'string' && part.content) {
      choice.bytes += utf8Growth(choice.content, part.content);
      choice.content += part.content;
      if (choice.bytes > generatedBytes) throw new Error('result_too_large');
    }
    if (typeof part.refusal === 'string' && part.refusal) choice.refused = true;
    if (Array.isArray(part.tool_calls) && part.tool_calls.length) choice.tools = true;
    if (part.function_call) choice.tools = true;
  }
  if (typeof first.finish_reason === 'string' && first.finish_reason) choice.finish = first.finish_reason;
}

function outcome(choice: Choice): string {
  const fail = (code: string, reason?: string) =>
    new ProviderError(code, {
      ...(reason ? { reason } : {}),
      ...(choice.finish ? { finishReason: choice.finish } : {}),
      answer: choice.content,
    });
  if (choice.refused || choice.finish === 'content_filter') throw fail('provider_refused');
  if (choice.finish === 'length') throw fail('provider_truncated');
  if (choice.tools || choice.finish === 'tool_calls' || choice.finish === 'function_call')
    throw fail('invalid_provider_response', 'The model called a tool.');
  if (choice.finish !== 'stop') throw fail('provider_incomplete');
  if (!choice.content.trim()) throw fail('invalid_provider_response', 'The answer is empty.');
  return choice.content;
}

async function readJson(response: Response, limits: BackendLimits, touch: () => void): Promise<string> {
  if (!response.body) throw new Error('invalid_provider_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  // A buffered body carries the content JSON-escaped, at most about six bytes
  // per content byte, plus metadata.
  const limit = Math.min(limits.streamBytes, limits.generatedBytes * 6 + 65_536);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    touch();
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('result_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ProviderError('invalid_provider_response', {
      reason: 'The response is not JSON.',
      body: new TextDecoder().decode(bytes),
    });
  }
  const choice: Choice = { content: '', bytes: 0, refused: false, tools: false };
  applyChoice(choice, data, limits.generatedBytes);
  return outcome(choice);
}

/**
 * Parses server-sent events incrementally across split UTF-8 sequences,
 * lines and events, with bounded line, event and total sizes.
 */
async function readEvents(response: Response, limits: BackendLimits, touch: () => void): Promise<string> {
  if (!response.body) throw new Error('invalid_provider_response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  const choice: Choice = { content: '', bytes: 0, refused: false, tools: false };
  let wire = 0;
  let pending = '';
  let data: string[] = [];
  let eventBytes = 0;
  let done = false;
  // A chunk ended with `\r`: a `\n` starting the next chunk completes that
  // CRLF and is not an empty line.
  let afterCarriageReturn = false;
  const dispatch = () => {
    if (!data.length) return;
    const payload = data.join('\n');
    data = [];
    eventBytes = 0;
    if (payload.trim() === '[DONE]') {
      done = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new ProviderError('invalid_provider_response', { reason: 'An event is not JSON.', body: payload });
    }
    applyChoice(choice, parsed, limits.generatedBytes);
  };
  const line = (value: string) => {
    if (value === '') return dispatch();
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    if (field !== 'data') return;
    let item = colon < 0 ? '' : value.slice(colon + 1);
    if (item.startsWith(' ')) item = item.slice(1);
    eventBytes += encoder.encode(item).length + 1;
    if (eventBytes > limits.eventBytes) throw new Error('invalid_provider_response');
    data.push(item);
  };
  try {
    while (!done) {
      const { done: end, value } = await reader.read();
      if (end) break;
      touch();
      wire += value.byteLength;
      if (wire > limits.streamBytes) throw new Error('result_too_large');
      let text: string;
      try {
        text = decoder.decode(value, { stream: true });
      } catch {
        throw new Error('invalid_provider_response');
      }
      pending += text;
      let start = 0;
      if (afterCarriageReturn && pending) {
        if (pending[0] === '\n') start = 1;
        afterCarriageReturn = false;
      }
      for (let index = start; index < pending.length && !done; index++) {
        const char = pending[index];
        if (char !== '\n' && char !== '\r') continue;
        line(pending.slice(start, index));
        if (char === '\r' && index + 1 === pending.length) afterCarriageReturn = true;
        else if (char === '\r' && pending[index + 1] === '\n') index++;
        start = index + 1;
      }
      pending = pending.slice(start);
      if (encoder.encode(pending).length > limits.eventBytes) throw new Error('invalid_provider_response');
    }
  } finally {
    if (done) void reader.cancel().catch(() => undefined);
  }
  if (!done) {
    try {
      pending += decoder.decode();
    } catch {
      throw new Error('invalid_provider_response');
    }
    if (pending) line(pending);
    dispatch();
  }
  return outcome(choice);
}

export async function readCompletion(response: Response, limits: BackendLimits, touch: () => void): Promise<string> {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type === 'text/event-stream') return readEvents(response, limits, touch);
  if (type === 'application/json') return readJson(response, limits, touch);
  throw new ProviderError('invalid_provider_response', { reason: `Unexpected content type ${type ?? '(none)'}.` });
}
