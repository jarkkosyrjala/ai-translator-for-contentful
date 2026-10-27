import {
  codePoints,
  DEFAULT_LIMITS,
  type RichInline,
  type RichTextWork,
  readRichTextMarkup,
  readRichTextResult,
  SIZE_ERROR_CODES,
  type TranslateRequest,
  type TranslateResponse,
  type WorkResult,
} from '@ai-translator-for-contentful/protocol';
import { type Block, type Document, validateRichTextDocument } from '@contentful/rich-text-types';
import { createContract, joinChangedParts, reconstructChangedPart } from '../richtext/contract';
import { rebuildRichText, richTextReviewValidation } from '../richtext/editor';
import type { Dependency, Task, TaskResult } from './batch';
import { arraySuggestionValidation, textSuggestionValidation } from './draft';
import { referenceWarning, restoreText } from './placeholders';
import {
  type FieldSource,
  type PlannedRequest,
  partText,
  type RetryGroup,
  type RunPlan,
  sourceOf,
  type WorkPart,
} from './planner';

export type RequestStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'stale';
export type RequestRun = { planned: PlannedRequest; status: RequestStatus; code?: string; detail?: string };
export type PartOutcome =
  | { status: 'pending' | 'cancelled' }
  | { status: 'ok'; result: WorkResult; provider: TranslateResponse['provider']; profileRevision: string }
  | { status: 'failed'; code: string; detail?: string; debug?: string };
// One attempt at one part; `request` indexes the run's requests.
export type PartRun = { part: WorkPart; request: number; outcome: PartOutcome };
export type RunState = { requests: RequestRun[]; parts: PartRun[] };

export type Send = (request: TranslateRequest, signal: AbortSignal) => Promise<TranslateResponse>;

const parserLimits = { nodes: DEFAULT_LIMITS.parserNodes, depth: DEFAULT_LIMITS.parserDepth };

export function startRun(plan: RunPlan, previous: RunState = { requests: [], parts: [] }): RunState {
  const offset = previous.requests.length;
  return {
    requests: [...previous.requests, ...plan.requests.map(planned => ({ planned, status: 'pending' as const }))],
    parts: [
      ...previous.parts,
      ...plan.requests.flatMap((planned, index) =>
        planned.parts.map(part => ({ part, request: offset + index, outcome: { status: 'pending' as const } })),
      ),
    ],
  };
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (error as { code?: unknown })?.code && typeof (error as { code?: unknown }).code === 'string'
    ? ((error as { code: string }).code as string)
    : message;
}

/**
 * Sends pending requests one at a time. A request whose dependencies changed
 * is not sent; cancellation stops dispatch and late replies are ignored, and
 * earlier results always survive.
 */
export async function executeRun(
  get: () => RunState,
  set: (next: RunState) => void,
  send: Send,
  signal: AbortSignal,
  current: (dependencies: Dependency[]) => boolean,
): Promise<void> {
  const update = (
    index: number,
    status: RequestStatus,
    outcome: (part: PartRun) => PartOutcome,
    code?: string,
    detail?: string,
  ) => {
    const state = get();
    set({
      requests: state.requests.map((request, position) =>
        position === index ? { ...request, status, ...(code ? { code } : {}), ...(detail ? { detail } : {}) } : request,
      ),
      parts: state.parts.map(part => (part.request === index ? { ...part, outcome: outcome(part) } : part)),
    });
  };
  for (let index = 0; index < get().requests.length; index++) {
    const run = get().requests[index];
    if (run.status !== 'pending') continue;
    if (signal.aborted) {
      update(index, 'cancelled', () => ({ status: 'cancelled' }));
      continue;
    }
    if (!current(run.planned.dependencies)) {
      update(index, 'stale', () => ({
        status: 'failed',
        code: 'stale',
        detail: 'Editor values changed before generation',
      }));
      continue;
    }
    update(index, 'running', part => part.outcome);
    try {
      const response = await send(run.planned.request, signal);
      if (signal.aborted) {
        update(index, 'cancelled', () => ({ status: 'cancelled' }));
        continue;
      }
      update(index, 'done', ({ part }) => {
        const result = response.results.find(item => item.id === part.work.id);
        if (!result) return { status: 'failed', code: 'missing' };
        return result.status === 'ok'
          ? { status: 'ok', result, provider: response.provider, profileRevision: response.profileRevision }
          : { status: 'failed', code: result.error, ...(response.debug ? { debug: response.debug.answer } : {}) };
      });
    } catch (error) {
      if (signal.aborted) update(index, 'cancelled', () => ({ status: 'cancelled' }));
      else {
        const code = errorCode(error);
        const detail = error instanceof Error ? error.message : String(error);
        const debug = (error as { debug?: unknown })?.debug;
        update(
          index,
          'failed',
          () => ({ status: 'failed', code, detail, ...(typeof debug === 'string' ? { debug } : {}) }),
          code,
          detail,
        );
      }
    }
  }
}

// The current attempts of a task, ordered by their source range.
export function taskParts(state: RunState, key: string): PartRun[] {
  return state.parts.filter(part => part.part.task.key === key).sort((a, b) => a.part.start - b.part.start);
}

/**
 * Whether the parts cover a task's source exactly once: no gaps, overlaps or
 * duplicates.
 */
export function exactCoverage(parts: PartRun[], segments: number): boolean {
  let position = 0;
  for (const { part } of parts) {
    if (part.start !== position || part.end <= part.start) return false;
    position = part.end;
  }
  return position === segments;
}

function dependenciesOf(state: RunState, parts: PartRun[]): Dependency[] {
  const result: Dependency[] = [];
  for (const index of new Set(parts.map(part => part.request))) {
    const planned = state.requests[index].planned;
    for (const dependency of planned.dependencies) {
      // Dispatch checks every grouped target, but a completed suggestion only
      // depends on its own target. A sibling target matters if sent as context.
      const targetOf = (task: Task) => task.fieldId === dependency.fieldId && task.targetLocale === dependency.locale;
      const siblingTarget =
        planned.parts.some(part => targetOf(part.task)) && !parts.some(part => targetOf(part.part.task));
      const context = planned.request.context?.some(
        item =>
          item.provenance === 'current-editor' &&
          item.entryId === planned.request.entryId &&
          item.fieldId === dependency.fieldId &&
          item.locale === dependency.locale,
      );
      if (siblingTarget && !context) continue;
      if (!result.some(item => item.fieldId === dependency.fieldId && item.locale === dependency.locale))
        result.push(dependency);
    }
  }
  return result;
}

function assembleText(task: Task, source: FieldSource, parts: PartRun[]): string {
  const text = task.sourceSnapshot as string;
  const translated = (part: PartRun) => {
    const outcome = part.outcome as Extract<PartOutcome, { status: 'ok' }>;
    return (outcome.result as Extract<WorkResult, { type: 'text' }>).text;
  };
  if (parts.length === 1 && parts[0].part.start === 0 && parts[0].part.end === source.segments.length)
    return restoreText(text, translated(parts[0]));
  // Text before the first paragraph, between parts and after the last stays
  // as in the source, restored exactly once.
  const spans = source.spans as [number, number][];
  let result = text.slice(0, spans[0][0]);
  for (const [index, part] of parts.entries()) {
    const own = partText(task, source, part.part.start, part.part.end);
    result += restoreText(own, translated(part));
    result += index < parts.length - 1 ? text.slice(spans[part.part.end - 1][1], spans[part.part.end][0]) : '';
  }
  return result + text.slice(spans[spans.length - 1][1]);
}

function assembleArray(task: Task, parts: PartRun[]): string[] {
  const translated = new Map<string, string>();
  for (const part of parts) {
    const outcome = part.outcome as Extract<PartOutcome, { status: 'ok' }>;
    const items = (outcome.result as Extract<WorkResult, { type: 'array' }>).items;
    const work = part.part.work;
    if (
      work.type !== 'array' ||
      items.length !== work.items.length ||
      items.some((item, index) => item.id !== work.items[index].id)
    )
      throw new Error('The model changed the array items or their order.');
    for (const item of items) translated.set(item.id, item.text);
  }
  return (task.sourceSnapshot as string[]).map((text, index) => {
    if (!text.trim()) return text;
    const value = translated.get(`i${index}`);
    if (value === undefined) throw new Error(`Missing array item ${index + 1}`);
    return restoreText(text, value);
  });
}

function assembleRich(task: Task, parts: PartRun[]): Document {
  try {
    return assemblePreservedRich(task, parts);
  } catch {
    const contract = createContract(task.sourceSnapshot as Document);
    let content: Block[] = [];
    let previous: PartRun | undefined;
    for (const part of parts) {
      const outcome = part.outcome as Extract<PartOutcome, { status: 'ok' }>;
      const markup = (outcome.result as Extract<WorkResult, { type: 'richText' }>).markup;
      const blocks = readRichTextMarkup(markup, part.part.work as RichTextWork, parserLimits);
      const fragment = reconstructChangedPart(contract, blocks, part.part.start, part.part.end);
      content = previous
        ? joinChangedParts(
            content,
            fragment,
            contract.leaves[previous.part.end - 1].path,
            contract.leaves[part.part.start].path,
          )
        : fragment;
      previous = part;
    }
    const document = { ...structuredClone(contract.source), content } as Document;
    if (validateRichTextDocument(document).length) throw new Error('The Rich Text document has an invalid structure');
    return document;
  }
}

function assemblePreservedRich(task: Task, parts: PartRun[]): Document {
  const units = new Map<string, RichInline[]>();
  for (const part of parts) {
    const outcome = part.outcome as Extract<PartOutcome, { status: 'ok' }>;
    const markup = (outcome.result as Extract<WorkResult, { type: 'richText' }>).markup;
    for (const [id, content] of readRichTextResult(markup, part.part.work as RichTextWork, parserLimits, {
      allowMissingAnchors: true,
    }))
      units.set(id, content);
  }
  return rebuildRichText(task.sourceSnapshot as Document, units);
}

// Suggestions far beyond the field limit are generation failures; up to
// twice the limit they stay editable for the editor to shorten.
function overLimit(task: Task, suggestion: string | string[]): string | undefined {
  if (task.kind === 'text' && task.size?.max !== undefined && codePoints(suggestion as string) > task.size.max * 2)
    return 'The suggestion is more than twice the field’s maximum length.';
  if (
    task.kind === 'array' &&
    task.itemSize?.max !== undefined &&
    (suggestion as string[]).some(item => codePoints(item) > (task.itemSize?.max ?? 0) * 2)
  )
    return 'An item is more than twice the field’s maximum item length.';
}

// The part failure that decides the task's message and retry actions: a
// size failure first, since only it offers a smaller retry.
function failureOf(parts: PartRun[]): { code: string; detail?: string; debug?: string } | undefined {
  const failures = parts
    .map(part => part.outcome)
    .filter((outcome): outcome is Extract<PartOutcome, { status: 'failed' }> => outcome.status === 'failed');
  return failures.find(failure => SIZE_ERROR_CODES.includes(failure.code)) ?? failures[0];
}

/**
 * The review state of each task: pending while parts run, a failure while any
 * part failed (successful parts are kept for retry), or the assembled and
 * validated suggestion once every part succeeded with exact coverage.
 */
export function taskResult(state: RunState, task: Task, sources: Map<string, FieldSource>): TaskResult | undefined {
  const parts = taskParts(state, task.key);
  if (!parts.length || parts.some(part => part.outcome.status === 'pending')) return undefined;
  const failure = failureOf(parts);
  const dependencies = dependenciesOf(state, parts);
  if (failure)
    return {
      task,
      status: 'error',
      code: failure.code,
      detail: failure.detail ?? failure.code,
      ...(failure.debug ? { debug: failure.debug } : {}),
      dependencies,
    };
  if (parts.some(part => part.outcome.status === 'cancelled')) return { task, status: 'cancelled', dependencies };
  const source = sourceOf(task, sources);
  if (!exactCoverage(parts, source.segments.length))
    return {
      task,
      status: 'error',
      code: 'coverage',
      detail: 'The results do not cover the field exactly.',
      dependencies,
    };
  const outcomes = parts.map(part => part.outcome as Extract<PartOutcome, { status: 'ok' }>);
  const provider = outcomes[0].provider;
  const profileRevision = outcomes[0].profileRevision;
  if (outcomes.some(outcome => outcome.provider !== provider || outcome.profileRevision !== profileRevision))
    return { task, status: 'error', code: 'mixed', detail: 'Parts came from different settings.', dependencies };
  try {
    const suggestion =
      task.kind === 'text'
        ? assembleText(task, source, parts)
        : task.kind === 'array'
          ? assembleArray(task, parts)
          : assembleRich(task, parts);
    if (task.kind !== 'richText') {
      const tooLong = overLimit(task, suggestion as string | string[]);
      if (tooLong) return { task, status: 'error', code: 'too_long', detail: tooLong, dependencies };
    }
    const detail =
      task.kind === 'text'
        ? textSuggestionValidation(task.sourceSnapshot as string, suggestion as string, task.size).error
        : task.kind === 'array'
          ? arraySuggestionValidation(task.sourceSnapshot, suggestion as string[], {
              count: task.size,
              item: task.itemSize,
            }).error
          : richTextReviewValidation(task.sourceSnapshot, suggestion, task.definition).error;
    const warning =
      task.kind === 'text'
        ? referenceWarning(task.sourceSnapshot as string, suggestion as string)
        : task.kind === 'array'
          ? referenceWarning((task.sourceSnapshot as string[]).join('\n'), (suggestion as string[]).join('\n'))
          : undefined;
    return {
      task,
      status: 'ready',
      suggestion,
      provider,
      profileRevision,
      ...(detail ? { detail } : {}),
      ...(warning ? { warning } : {}),
      dependencies,
    };
  } catch (error) {
    return {
      task,
      status: 'error',
      code: 'invalid_structure',
      detail: error instanceof Error ? error.message : String(error),
      rawSuggestion: outcomes
        .map(outcome => {
          const result = outcome.result;
          return result.status !== 'ok'
            ? ''
            : result.type === 'richText'
              ? result.markup
              : result.type === 'array'
                ? result.items.map(item => item.text).join('\n')
                : result.text;
        })
        .join('\n'),
      dependencies,
    };
  }
}

// The attempts a retry of the tasks replaces: failed and cancelled parts, and
// every part of a task whose parts all succeeded but whose assembled value
// failed local validation, such as a suggestion far beyond the field limit.
function retriedParts(state: RunState, keys: readonly string[], sources: Map<string, FieldSource>): Set<PartRun> {
  const retried = new Set<PartRun>();
  for (const key of keys) {
    const parts = taskParts(state, key);
    const failed = parts.filter(part => part.outcome.status === 'failed' || part.outcome.status === 'cancelled');
    const rejected =
      !failed.length && parts.length > 0 && taskResult(state, parts[0].part.task, sources)?.status === 'error';
    for (const part of rejected ? parts : failed) retried.add(part);
  }
  return retried;
}

// The attempts a retry replaces, grouped by the request they were in.
export function failedGroups(
  state: RunState,
  keys: readonly string[],
  sources: Map<string, FieldSource> = new Map(),
): RetryGroup[] {
  const retried = retriedParts(state, keys, sources);
  const groups = new Map<number, WorkPart[]>();
  for (const part of state.parts)
    if (retried.has(part)) groups.set(part.request, [...(groups.get(part.request) ?? []), part.part]);
  return [...groups].map(([index, parts]) => ({
    parts,
    requestCharacters: state.requests[index].planned.sourceCharacters,
    requestParts: state.requests[index].planned.parts.length,
  }));
}

// Successful ranges a retry keeps, for numbering retry parts.
export function keptRanges(
  state: RunState,
  keys: readonly string[],
  sources: Map<string, FieldSource> = new Map(),
): Map<string, [number, number][]> {
  const retried = retriedParts(state, keys, sources);
  const kept = new Map<string, [number, number][]>();
  for (const part of state.parts)
    if (keys.includes(part.part.task.key) && part.outcome.status === 'ok' && !retried.has(part))
      kept.set(part.part.task.key, [...(kept.get(part.part.task.key) ?? []), [part.part.start, part.part.end]]);
  return kept;
}

// Whether a failure may succeed with less work per request.
export function smallerRetryApplies(code: string | undefined): boolean {
  return code !== undefined && SIZE_ERROR_CODES.includes(code);
}

/**
 * Replaces the attempts a retry of the tasks covers with a retry plan.
 * Successful parts of other tasks stay; the retry must cover exactly what
 * failed.
 */
export function retryRun(
  state: RunState,
  keys: readonly string[],
  plan: RunPlan,
  sources: Map<string, FieldSource> = new Map(),
): RunState {
  const retried = retriedParts(state, keys, sources);
  return startRun(plan, { requests: state.requests, parts: state.parts.filter(part => !retried.has(part)) });
}
