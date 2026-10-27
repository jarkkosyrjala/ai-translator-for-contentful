export type ProviderAuth =
  | { mode: 'bearer'; secret: string }
  | { mode: 'header'; name: string; secret: string }
  | { mode: 'none' };

export type ProviderRequestOptions = {
  temperature?: number;
  topP?: number;
  maxCompletionTokens?: number;
  outputTokenField?: 'max_completion_tokens' | 'max_tokens';
  reasoningEffort?: string;
  extraBody?: Record<string, unknown>;
};

// The OpenAI-compatible streaming chat completion body. Planners measure
// the same object a backend sends.
export function chatCompletionBody(
  model: string,
  messages: { role: string; content: string }[],
  options: ProviderRequestOptions = {},
): string {
  return JSON.stringify({
    model,
    stream: true,
    n: 1,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.topP !== undefined ? { top_p: options.topP } : {}),
    ...(options.maxCompletionTokens !== undefined
      ? { [options.outputTokenField ?? 'max_completion_tokens']: options.maxCompletionTokens }
      : {}),
    ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
    ...options.extraBody,
    messages,
  });
}

// Room a planner leaves for provider options it cannot see: a backend's
// extra body (at most 4 KiB) and its numeric options.
export const PROVIDER_OPTIONS_ALLOWANCE = 8_192;

export function parseProviderAuth(mode: unknown, secret: unknown, customHeader: unknown): ProviderAuth {
  if (mode === undefined || mode === null || mode === '' || mode === 'bearer') {
    if (typeof secret !== 'string' || !secret) throw new Error('provider_not_configured');
    return { mode: 'bearer', secret };
  }
  if (mode === 'none') return { mode: 'none' };
  if (mode === 'header') {
    if (typeof secret !== 'string' || !secret) throw new Error('provider_not_configured');
    return { mode: 'header', name: providerHeaderName(customHeader, true), secret };
  }
  throw new Error('invalid_provider_config');
}

const forbiddenHeaders = new Set([
  'authorization',
  'content-type',
  'content-length',
  'host',
  'cookie',
  'set-cookie',
  'connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'accept-encoding',
  'origin',
]);
const reservedBody = new Set([
  'model',
  'messages',
  'stream',
  'stream_options',
  'n',
  'tools',
  'tool_choice',
  'functions',
  'function_call',
  'response_format',
  'modalities',
  'audio',
  'prediction',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'reasoning_effort',
]);

export function providerHeaderName(value: unknown, allowAuthorization = false): string {
  if (typeof value !== 'string') throw new Error('invalid_provider_headers');
  const name = value.toLowerCase();
  if (
    !/^[!#$%&'*+.^_`|~0-9a-z-]{1,100}$/.test(name) ||
    (forbiddenHeaders.has(name) && !(allowAuthorization && name === 'authorization')) ||
    name.startsWith('x-contentful-') ||
    name.startsWith('proxy-') ||
    name.startsWith('sec-')
  ) {
    throw new Error('invalid_provider_headers');
  }
  return name;
}

export function providerHeaderValue(value: unknown, maxLength = 1024): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > maxLength ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: header values must not contain control characters.
    /[\r\n\0-\x1f\x7f]/.test(value)
  ) {
    throw new Error('invalid_provider_headers');
  }
  return value;
}

// Validates installer-supplied provider headers without credentials. The
// server-only provider package adds authentication to this result.
export function additionalProviderHeaders(additional: Record<string, string> = {}): Record<string, string> {
  if (
    !additional ||
    typeof additional !== 'object' ||
    Array.isArray(additional) ||
    Object.getPrototypeOf(additional) !== Object.prototype ||
    Object.keys(additional).length > 16
  ) {
    throw new Error('invalid_provider_headers');
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const rawName of Object.keys(additional)) {
    const rawValue = additional[rawName];
    const name = providerHeaderName(rawName);
    if (name in headers) throw new Error('invalid_provider_headers');
    headers[name] = providerHeaderValue(rawValue);
  }
  return headers;
}

function optionalNumber(value: unknown, min: number, max: number, integer = false): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() === value ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw new Error('invalid_provider_options');
  }
  return number;
}

function safeJson(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 1024;
  if (Array.isArray(value)) return value.length <= 32 && value.every(item => safeJson(item, depth + 1));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  return (
    keys.length <= 32 &&
    keys.every(
      key =>
        /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) &&
        !['constructor', 'prototype', '__proto__'].includes(key) &&
        safeJson((value as Record<string, unknown>)[key], depth + 1),
    )
  );
}

export function parseProviderOptions(input: {
  temperature?: unknown;
  topP?: unknown;
  maxCompletionTokens?: unknown;
  outputTokenField?: unknown;
  reasoningEffort?: unknown;
  extraBody?: unknown;
}): ProviderRequestOptions {
  const temperature = optionalNumber(input.temperature, 0, 2);
  const topP = optionalNumber(input.topP, 0, 1);
  const maxCompletionTokens = optionalNumber(input.maxCompletionTokens, 1, 65_536, true);
  const outputTokenField =
    input.outputTokenField === undefined || input.outputTokenField === ''
      ? 'max_completion_tokens'
      : input.outputTokenField;
  if (outputTokenField !== 'max_completion_tokens' && outputTokenField !== 'max_tokens') {
    throw new Error('invalid_provider_options');
  }
  let reasoningEffort: string | undefined;
  if (input.reasoningEffort !== undefined && input.reasoningEffort !== '') {
    if (typeof input.reasoningEffort !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(input.reasoningEffort)) {
      throw new Error('invalid_provider_options');
    }
    reasoningEffort = input.reasoningEffort;
  }
  let extraBody: Record<string, unknown> | undefined;
  if (input.extraBody !== undefined && input.extraBody !== '') {
    let parsed: unknown = input.extraBody;
    if (typeof parsed === 'string') {
      if (parsed.length > 4096) throw new Error('invalid_provider_options');
      try {
        parsed = JSON.parse(parsed);
      } catch {
        throw new Error('invalid_provider_options');
      }
    }
    if (
      !safeJson(parsed) ||
      Array.isArray(parsed) ||
      parsed === null ||
      Object.keys(parsed as object).some(key => reservedBody.has(key)) ||
      JSON.stringify(parsed).length > 4096
    )
      throw new Error('invalid_provider_options');
    extraBody = parsed as Record<string, unknown>;
  }
  return { temperature, topP, maxCompletionTokens, outputTokenField, reasoningEffort, extraBody };
}

export function parseProviderHeaders(value: unknown): Record<string, string> {
  if (value === undefined || value === null || value === '') return {};
  let parsed: unknown = value;
  if (typeof parsed === 'string') {
    if (parsed.length > 4096) throw new Error('invalid_provider_headers');
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error('invalid_provider_headers');
    }
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw new Error('invalid_provider_headers');
  }
  const headers = parsed as Record<string, string>;
  additionalProviderHeaders(headers);
  return headers;
}

export function providerBaseUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 300 || value !== value.trim())
    throw new Error('invalid_provider_url');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('invalid_provider_url');
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.includes('\\') ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) ||
    url.hostname.startsWith('[')
  )
    throw new Error('invalid_provider_url');
  return new URL(`${url.origin}${url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`}`);
}

/**
 * An OpenAI-compatible API route beneath a provider base URL. A base that
 * already ends in `/chat/completions` counts as its prefix, so prefixes such
 * as `/v1` stay in both routes and the path is never doubled.
 */
export function providerApiUrl(base: URL, route: 'chat/completions' | 'models'): string {
  const url = new URL(base.origin);
  url.pathname = `${base.pathname.replace(/\/$/, '').replace(/\/chat\/completions$/, '')}/${route}`;
  return url.href;
}

export function providerEndpoint(value: unknown): string {
  return providerApiUrl(providerBaseUrl(value), 'chat/completions');
}

export function providerModelsEndpoint(value: unknown): string {
  return providerApiUrl(providerBaseUrl(value), 'models');
}
