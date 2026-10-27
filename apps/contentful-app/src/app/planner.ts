import {
  type ContextField,
  chatCompletionBody,
  codePoints,
  compileTranslationMessages,
  estimatedOutputTokens,
  type FieldConstraints,
  type InstructionMessage,
  type InstructionProfile,
  illegalCharacter,
  inlineText,
  type PlanningLimits,
  PROVIDER_OPTIONS_ALLOWANCE,
  parseTranslateRequest,
  RELAY_CONTRACT_VERSION,
  type ResolvedTranslationSettings,
  type TranslateRequest,
  utf8Bytes,
  type WorkField,
  workSourceCharacters,
} from '@ai-translator-for-contentful/protocol';
import type { Document } from '@contentful/rich-text-types';
import { type Contract, createContract, headingOutline, partSource, reopenedTableHeader } from '../richtext/contract';
import type { Dependency, Task } from './batch';
import { type BoundedContext, boundContext, type ContextCandidate, contextText } from './context';
import { outputGuidance } from './placeholders';

// One indivisible piece of a field: a paragraph, array item or Rich Text
// leaf. `penalty` is the cost of a cut before it; lower cuts are preferred.
type Segment = { size: number; penalty: number };
type FieldSource = {
  segments: Segment[];
  // Long and Short text: each segment's [start, end) in the source string.
  spans?: [number, number][];
  // Arrays: the translatable items with their original positions.
  items?: { index: number; text: string }[];
  contract?: Contract;
};

// A contiguous range of a task's segments sent as one work field.
export type WorkPart = {
  task: Task;
  start: number;
  end: number;
  part?: number;
  parts?: number;
  sourceCharacters: number;
  work: WorkField;
};
export type ContextSummary = { role: ContextField['role']; name: string; characters: number; omittedUnits: number };
export type PlannedRequest = {
  targetLocale: string;
  parts: WorkPart[];
  request: TranslateRequest;
  messages: InstructionMessage[];
  // The complete body the backend receives, and the provider body estimate.
  bytes: number;
  providerBytes: number;
  sourceCharacters: number;
  context: ContextSummary[];
  // Context fields that did not fit the field count at all.
  omittedFields: string[];
  dependencies: Dependency[];
};
export type RunPlan = { requests: PlannedRequest[]; warnings: string[] };

export type PlanOptions = {
  settings: ResolvedTranslationSettings;
  limits: PlanningLimits;
  model: string;
  profile: InstructionProfile;
  runGuidance: string;
  variableValues: Record<string, string>;
  availableLocales: string[];
  explicitContext: ContextCandidate[];
  // What the transport sends: the bare request or a Custom backend envelope.
  envelope: (request: TranslateRequest) => unknown;
  id: () => string;
  // Advisory only: the model's output allowance.
  outputAllowance?: number;
};

// Byte room kept for renumbered part attributes after a split.
const BYTE_MARGIN = 256;

export class PlanError extends Error {}

// Cut penalties for Long text, lowest first: a heading (by level), a
// paragraph after a blank line, a line break, then a sentence end.
const PARAGRAPH_CUT = 10;
const LINE_CUT = 20;
const SENTENCE_CUT = 30;
// A sentence ends at . ! ? or …, with closing quotes, brackets or citation
// markers such as [12], before whitespace and an uppercase letter, digit or
// opening quote.
const SENTENCE_END =
  /[.!?\u2026]+(?:["'\u201d\u2019)\]]|\[[^\]\s]{1,12}\])*(\s+)(?=["'\u201c\u2018([]?[\p{Lu}\p{N}])/gu;

/**
 * Cut points of Long text as segment spans with the penalty of a cut before
 * each. Blank lines separate paragraphs, line breaks separate lines and
 * sentences split lines, so text without blank lines can still split. Fenced
 * code and consecutive table rows stay one segment, and separators between
 * segments stay in the source for exact reassembly.
 */
export function textSegments(text: string): { spans: [number, number][]; penalties: number[] } {
  type Unit = { start: number; end: number; penalty: number; split: boolean; table: boolean };
  const units: Unit[] = [];
  let unit: Unit | undefined;
  let fence: string | undefined;
  let paragraphStart = true;
  const close = () => {
    if (unit) units.push(unit);
    unit = undefined;
  };
  let position = 0;
  while (position <= text.length) {
    const next = text.indexOf('\n', position);
    const line = text.slice(position, next < 0 ? text.length : next).replace(/\r$/, '');
    const end = position + line.length;
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence && unit) {
      unit.end = end;
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    } else if (!line.trim()) {
      close();
      paragraphStart = true;
    } else {
      const table = /^\s{0,3}\|/.test(line);
      if (table && unit?.table) unit.end = end;
      else {
        close();
        const level = headingLevel(line);
        const penalty = level ? level - 1 : paragraphStart ? PARAGRAPH_CUT : LINE_CUT;
        unit = { start: position, end, penalty, split: !marker && !table, table };
        fence = marker;
      }
      paragraphStart = false;
    }
    if (next < 0) break;
    position = next + 1;
  }
  close();
  const spans: [number, number][] = [];
  const penalties: number[] = [];
  for (const item of units) {
    let start = item.start;
    let penalty = item.penalty;
    if (item.split)
      for (const match of text.slice(item.start, item.end).matchAll(SENTENCE_END)) {
        const after = item.start + (match.index ?? 0) + match[0].length;
        spans.push([start, after - match[1].length]);
        penalties.push(penalty);
        start = after;
        penalty = SENTENCE_CUT;
      }
    spans.push([start, item.end]);
    penalties.push(penalty);
  }
  return { spans, penalties };
}

function headingLevel(line: string): number | undefined {
  const match = /^\s{0,3}(#{1,6})\s/.exec(line);
  return match ? match[1].length : undefined;
}

export type { FieldSource };

export function sourceOf(task: Task, cache: Map<string, FieldSource>): FieldSource {
  const cached = cache.get(task.fieldId);
  if (cached) return cached;
  const reject = (value: string) => {
    if (illegalCharacter(value) !== undefined)
      throw new PlanError(
        `${task.fieldName} contains a control character that cannot be sent. Remove it and try again.`,
      );
  };
  let source: FieldSource;
  if (task.kind === 'text') {
    const text = task.sourceSnapshot as string;
    reject(text);
    const { spans, penalties } = task.longText
      ? textSegments(text)
      : { spans: [[0, text.length]] as [number, number][], penalties: [0] };
    source = {
      spans,
      segments: spans.map(([start, end], index) => ({
        size: codePoints(text.slice(start, end)),
        penalty: penalties[index],
      })),
    };
  } else if (task.kind === 'array') {
    // Empty and whitespace-only items stay unchanged in the app.
    const items = (task.sourceSnapshot as string[])
      .map((text, index) => ({ index, text }))
      .filter(item => item.text.trim());
    for (const item of items) reject(item.text);
    source = { items, segments: items.map(item => ({ size: codePoints(item.text), penalty: 0 })) };
  } else {
    const contract = createContract(task.sourceSnapshot as Document);
    for (const unit of contract.units) reject(inlineText(unit.content));
    source = {
      contract,
      segments: contract.leaves.map(leaf => {
        const level = leaf.unit && /^h[1-6]$/.test(leaf.unit.tag) ? Number(leaf.unit.tag.slice(1)) : undefined;
        const penalty = leaf.path.length === 1 ? (level ? level - 1 : 10) : 20 + leaf.path.length;
        return { size: leaf.size, penalty };
      }),
    };
  }
  cache.set(task.fieldId, source);
  return source;
}

function sum(segments: Segment[], start: number, end: number): number {
  let total = 0;
  for (let index = start; index < end; index++) total += segments[index].size;
  return total;
}

// Greedy group count within `cap`. Zero-size segments (rules, embeds) join
// the current group, and a group over the cap holds one sized segment only.
function groupCount(segments: Segment[], start: number, end: number, cap: number): number {
  let count = 0;
  let size = 0;
  for (let index = start; index < end; index++) {
    const next = segments[index].size;
    if (count === 0 || (next > 0 && size > 0 && size + next > cap)) {
      count++;
      size = next;
    } else size += next;
  }
  return count;
}

/**
 * Cuts segments [start, end) into the fewest groups within `target`, then
 * prefers cheap cuts (higher headings, top-level blocks) among groups at most
 * a quarter larger than the most balanced split, then balanced sizes. An
 * oversized segment forms a group alone. Deterministic for equal input.
 * @returns Group start indexes.
 */
export function partition(segments: Segment[], start: number, end: number, target: number): number[] {
  if (end - start <= 1 || sum(segments, start, end) <= target) return [start];
  const minimum = groupCount(segments, start, end, target);
  let low = 1;
  let high = target;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (groupCount(segments, start, end, middle) <= minimum) high = middle;
    else low = middle + 1;
  }
  const cap = Math.min(target, Math.ceil(low * 1.25));
  type Best = { parts: number; penalty: number; squares: number; previous: number };
  const best: (Best | undefined)[] = [{ parts: 0, penalty: 0, squares: 0, previous: -1 }];
  for (let j = 1; j <= end - start; j++) {
    let size = 0;
    let sized = 0;
    for (let i = j - 1; i >= 0; i--) {
      const next = segments[start + i].size;
      size += next;
      if (next > 0) sized++;
      if (size > cap && sized > 1) break;
      const before = best[i];
      // A group starts with a sized segment, so none is only rules or embeds.
      if (!before || (i > 0 && sized === 0)) continue;
      const candidate: Best = {
        parts: before.parts + 1,
        penalty: before.penalty + (i > 0 ? segments[start + i].penalty : 0),
        squares: before.squares + size * size,
        previous: i,
      };
      const current = best[j];
      if (
        !current ||
        candidate.parts < current.parts ||
        (candidate.parts === current.parts &&
          (candidate.penalty < current.penalty ||
            (candidate.penalty === current.penalty && candidate.squares < current.squares)))
      )
        best[j] = candidate;
    }
  }
  const cuts: number[] = [];
  for (let j = end - start; j > 0; j = (best[j] as Best).previous) cuts.unshift(start + (best[j] as Best).previous);
  return cuts;
}

function constraintsOf(task: Task, whole: boolean): FieldConstraints | undefined {
  const constraints: FieldConstraints = {};
  if (task.kind === 'array') {
    if (whole && task.size?.min !== undefined) constraints.countMin = task.size.min;
    if (whole && task.size?.max !== undefined) constraints.countMax = task.size.max;
    if (task.itemSize?.min !== undefined) constraints.itemMin = task.itemSize.min;
    if (task.itemSize?.max !== undefined) constraints.itemMax = task.itemSize.max;
  } else if (whole) {
    if (task.size?.min !== undefined) constraints.min = task.size.min;
    if (task.size?.max !== undefined) constraints.max = task.size.max;
  }
  return Object.keys(constraints).length ? constraints : undefined;
}

export function partText(task: Task, source: FieldSource, start: number, end: number): string {
  const text = task.sourceSnapshot as string;
  const spans = source.spans as [number, number][];
  // A single part covering every paragraph keeps the field's edge whitespace.
  if (start === 0 && end === spans.length) return text;
  return text.slice(spans[start][0], spans[end - 1][1]);
}

function workFor(
  task: Task,
  source: FieldSource,
  start: number,
  end: number,
  part?: number,
  parts?: number,
): WorkField {
  const whole = start === 0 && end === source.segments.length;
  const base = {
    id: whole ? `f-${task.fieldId}` : `f-${task.fieldId}~${start}`,
    fieldId: task.fieldId,
    name: task.fieldName,
    ...(parts && parts > 1 ? { part, parts } : {}),
  };
  const constraints = constraintsOf(task, whole);
  const partNote = parts && parts > 1 ? `Part ${part} of ${parts} of one field; translate only this part. ` : '';
  if (task.kind === 'text') {
    const text = partText(task, source, start, end);
    return {
      ...base,
      type: 'text',
      ...(constraints ? { constraints } : {}),
      outputGuidance: `${partNote}${outputGuidance(text, whole ? task.size : undefined, task.format)}`,
      source: text,
    };
  }
  if (task.kind === 'array') {
    const items = (source.items ?? []).slice(start, end);
    return {
      ...base,
      type: 'array',
      ...(constraints ? { constraints } : {}),
      outputGuidance: `${partNote}Translate each item on its own. ${outputGuidance(items.map(item => item.text).join('\n'))}`,
      items: items.map(item => ({ id: `i${item.index}`, text: item.text })),
    };
  }
  return {
    ...base,
    type: 'richText',
    ...(constraints ? { constraints } : {}),
    outputGuidance: `${partNote}Keep every block, unit id and anchor.`,
    source: partSource(source.contract as Contract, start, end),
  };
}

function makePart(task: Task, source: FieldSource, start: number, end: number): WorkPart {
  const work = workFor(task, source, start, end);
  // The shared helper counts readable source the same way everywhere.
  return { task, start, end, sourceCharacters: workSourceCharacters(work), work };
}

// Readable source of segments, for neighbor context.
function segmentText(task: Task, source: FieldSource, index: number): string {
  if (task.kind === 'text') {
    const [start, end] = (source.spans as [number, number][])[index];
    return (task.sourceSnapshot as string).slice(start, end);
  }
  return (source.contract as Contract).leaves[index].unit?.readable ?? '';
}

// Readable source of neighboring segments: Long text keeps the source's own
// separators, and Rich Text blocks are joined by blank lines.
function neighborText(task: Task, source: FieldSource, indexes: number[]): string {
  const sorted = [...indexes].sort((a, b) => a - b);
  if (!sorted.length) return '';
  if (task.kind === 'text') {
    const spans = source.spans as [number, number][];
    return (task.sourceSnapshot as string).slice(spans[sorted[0]][0], spans[sorted[sorted.length - 1]][1]);
  }
  return sorted.map(index => segmentText(task, source, index)).join('\n\n');
}

function neighbors(task: Task, source: FieldSource, part: WorkPart, budget: number): BoundedContext[] {
  if (task.kind === 'array' || budget <= 0) return [];
  const side = (position: 'before' | 'after'): BoundedContext | undefined => {
    const step = position === 'before' ? -1 : 1;
    const kept: number[] = [];
    let omittedUnits = 0;
    for (
      let index = position === 'before' ? part.start - 1 : part.end;
      index >= 0 && index < source.segments.length;
      index += step
    ) {
      if (!segmentText(task, source, index).trim()) continue;
      if (codePoints(neighborText(task, source, [...kept, index])) > budget) {
        if (!kept.length) omittedUnits = 1;
        break;
      }
      kept.push(index);
    }
    if (!kept.length && !omittedUnits) return undefined;
    return {
      role: 'neighbor',
      entryId: task.entryId,
      fieldId: task.fieldId,
      name: task.fieldName,
      locale: task.sourceLocale,
      provenance: 'current-editor',
      for: part.work.id,
      position,
      omittedUnits,
      value: contextText(neighborText(task, source, kept)),
    };
  };
  return [side('before'), side('after')].filter((item): item is BoundedContext => Boolean(item));
}

function outline(task: Task, source: FieldSource, part: WorkPart, budget: number): BoundedContext[] {
  if (task.kind !== 'richText' || budget <= 0) return [];
  const contract = source.contract as Contract;
  const heading = contract.leaves[part.start]?.heading;
  const header = reopenedTableHeader(contract, part.start);
  const lines = [
    ...(heading ? [`Continues under: ${heading.readable.replace(/\s+/g, ' ').trim()}`] : []),
    ...(header ? [`Table header: ${header}`] : []),
    ...(headingOutline(contract).length ? ['Document outline:', ...headingOutline(contract)] : []),
  ];
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    const size = codePoints(line) + (kept.length ? 1 : 0);
    if (length + size > budget) break;
    kept.push(line);
    length += size;
  }
  if (!lines.length) return [];
  return [
    {
      role: 'outline',
      entryId: task.entryId,
      fieldId: task.fieldId,
      name: task.fieldName,
      locale: task.sourceLocale,
      provenance: 'current-editor',
      for: part.work.id,
      omittedUnits: lines.length - kept.length,
      value: contextText(kept.join('\n')),
    },
  ];
}

export type PlanContext = {
  tasks: Task[];
  options: PlanOptions;
  sources: Map<string, FieldSource>;
};

export function planContext(tasks: Task[], options: PlanOptions): PlanContext {
  const sources = new Map<string, FieldSource>();
  for (const task of tasks) sourceOf(task, sources);
  if (options.explicitContext.length > options.settings.contextMaxFields)
    throw new PlanError(
      options.settings.contextMaxFields
        ? `Select at most ${options.settings.contextMaxFields} context fields for this model.`
        : 'This model is set to use no context. Remove the selected context.',
    );
  return { tasks, options, sources };
}

function build(plan: PlanContext, parts: WorkPart[]): PlannedRequest {
  const { options } = plan;
  const { settings } = options;
  const first = parts[0].task;
  const explicit = boundContext(options.explicitContext, {
    maxFields: settings.contextMaxFields,
    fieldCharacters: settings.contextFieldCharacters,
    totalCharacters: settings.contextTotalCharacters,
  });
  const present = new Set(parts.map(part => part.task.fieldId));
  const siblingFields = plan.tasks.filter(
    (task, index, all) =>
      task.targetLocale === first.targetLocale &&
      !present.has(task.fieldId) &&
      all.findIndex(other => other.fieldId === task.fieldId && other.targetLocale === task.targetLocale) === index,
  );
  const siblings = boundContext(
    siblingFields.map(task => ({
      entryId: task.entryId,
      fieldId: task.fieldId,
      fieldName: task.fieldName,
      locale: task.sourceLocale,
      provenance: 'current-editor' as const,
      rawValue: task.sourceSnapshot,
    })),
    {
      maxFields: Math.max(0, settings.contextMaxFields - explicit.items.length),
      fieldCharacters: settings.contextFieldCharacters,
      totalCharacters: Math.max(0, settings.contextTotalCharacters - explicit.characters),
    },
    'sibling',
  );
  const split = parts.flatMap(part =>
    part.parts && part.parts > 1
      ? [
          ...outline(part.task, plan.sources.get(part.task.fieldId) as FieldSource, part, settings.outlineCharacters),
          ...neighbors(
            part.task,
            plan.sources.get(part.task.fieldId) as FieldSource,
            part,
            settings.neighborCharacters,
          ),
        ]
      : [],
  );
  const context: ContextField[] = [...explicit.items, ...siblings.items, ...split].map((item, index) => ({
    id: `ctx-${index + 1}`,
    ...item,
  }));
  const request: TranslateRequest = {
    contract: RELAY_CONTRACT_VERSION,
    requestId: options.id(),
    entryId: first.entryId,
    model: options.model,
    sourceLocale: first.sourceLocale,
    targetLocale: first.targetLocale,
    availableLocales: options.availableLocales,
    profile: options.profile,
    profileRevision: options.profile.revision,
    ...(options.runGuidance ? { runGuidance: options.runGuidance } : {}),
    ...(Object.keys(options.variableValues).length ? { variableValues: options.variableValues } : {}),
    ...(context.length ? { context } : {}),
    fields: parts.map(part => part.work),
  };
  const messages = compileTranslationMessages(options.profile, request);
  const dependencies: Dependency[] = [];
  const depend = (fieldId: string, locale: string, value: unknown) => {
    if (!dependencies.some(item => item.fieldId === fieldId && item.locale === locale))
      dependencies.push({ fieldId, locale, value });
  };
  for (const part of parts) {
    depend(part.task.fieldId, part.task.sourceLocale, part.task.sourceSnapshot);
    depend(part.task.fieldId, part.task.targetLocale, part.task.targetSnapshot);
  }
  for (const task of siblingFields.slice(0, siblings.items.length))
    depend(task.fieldId, task.sourceLocale, task.sourceSnapshot);
  for (const candidate of options.explicitContext)
    if (candidate.provenance === 'current-editor') depend(candidate.fieldId, candidate.locale, candidate.rawValue);
  return {
    targetLocale: first.targetLocale,
    parts,
    request,
    messages,
    bytes: utf8Bytes(JSON.stringify(options.envelope(request))),
    providerBytes: utf8Bytes(chatCompletionBody(options.model, messages)) + PROVIDER_OPTIONS_ALLOWANCE,
    sourceCharacters: parts.reduce((total, part) => total + part.sourceCharacters, 0),
    context: context.map(item => ({
      role: item.role,
      name: item.position ? `${item.name} (${item.position} this part)` : item.name,
      characters: codePoints(item.value),
      omittedUnits: item.omittedUnits,
    })),
    omittedFields: [...explicit.omitted, ...siblings.omitted].map(candidate => candidate.fieldName),
    dependencies,
  };
}

function fits(plan: PlanContext, request: PlannedRequest): boolean {
  const { limits } = plan.options;
  return (
    request.bytes + BYTE_MARGIN <= limits.requestBytes &&
    request.providerBytes + BYTE_MARGIN <= limits.providerBodyBytes
  );
}

// Numbers each task's parts across all planned parts and any kept results, so
// the model sees part i of n. Work IDs depend only on the range start.
function renumber(
  plan: PlanContext,
  groups: WorkPart[][],
  kept: Map<string, [number, number][]>,
  all: WorkPart[][] = groups,
): WorkPart[][] {
  const ranges = new Map<string, number[]>();
  for (const part of all.flat()) ranges.set(part.task.key, [...(ranges.get(part.task.key) ?? []), part.start]);
  for (const [key, list] of kept) ranges.set(key, [...(ranges.get(key) ?? []), ...list.map(([start]) => start)]);
  return groups.map(group =>
    group.map(part => {
      const starts = [...new Set(ranges.get(part.task.key))].sort((a, b) => a - b);
      const parts = starts.length;
      const source = plan.sources.get(part.task.fieldId) as FieldSource;
      const position = starts.indexOf(part.start) + 1;
      return {
        ...part,
        part: parts > 1 ? position : undefined,
        parts: parts > 1 ? parts : undefined,
        work: workFor(part.task, source, part.start, part.end, position, parts),
      };
    }),
  );
}

function tooLarge(plan: PlanContext, request: PlannedRequest): PlanError {
  const part = request.parts[0];
  const { limits } = plan.options;
  const over = request.bytes + BYTE_MARGIN > limits.requestBytes;
  return new PlanError(
    `${part.task.fieldName} cannot be split further and is too large for one request with the selected context and instructions (${over ? request.bytes : request.providerBytes} of ${over ? limits.requestBytes : limits.providerBodyBytes} bytes). Remove context, shorten the field or ask an administrator to check the backend limits.`,
  );
}

/**
 * Builds the requests for parts grouped by request: a group that is too large
 * is halved, and a single part is split within its range until the requests
 * fit or a part cannot be split.
 * @throws PlanError when an indivisible part or the context alone cannot fit.
 */
export function finalize(
  plan: PlanContext,
  groups: WorkPart[][],
  kept: Map<string, [number, number][]> = new Map(),
): PlannedRequest[] {
  const accepted: WorkPart[][] = [];
  const queue = [...groups];
  while (queue.length) {
    // Number the group against every part planned so far, so a part split
    // here is measured with the outline and neighbor context it will carry.
    const next = queue.shift() as WorkPart[];
    const [group] = renumber(plan, [next], kept, [...accepted, next, ...queue]);
    const request = build(plan, group);
    if (fits(plan, request)) {
      accepted.push(group);
      continue;
    }
    if (group.length > 1) {
      const half = Math.ceil(group.length / 2);
      queue.unshift(group.slice(0, half), group.slice(half));
      continue;
    }
    const [part] = group;
    const source = plan.sources.get(part.task.fieldId) as FieldSource;
    const cuts = partition(source.segments, part.start, part.end, Math.max(1, Math.floor(part.sourceCharacters / 2)));
    if (cuts.length < 2) throw tooLarge(plan, request);
    queue.unshift(...cuts.map((cut, index) => [makePart(part.task, source, cut, cuts[index + 1] ?? part.end)]));
  }
  const requests = renumber(plan, accepted, kept).map(group => build(plan, group));
  for (const request of requests) {
    if (!fits(plan, request)) throw tooLarge(plan, request);
    try {
      parseTranslateRequest(request.request, plan.options.limits.requestBytes);
    } catch (error) {
      throw new PlanError(
        `The translation request could not be prepared (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }
  return requests;
}

function warnings(plan: PlanContext, requests: PlannedRequest[]): string[] {
  const { settings, outputAllowance } = plan.options;
  const list: string[] = [];
  for (const request of requests) {
    for (const part of request.parts)
      if (part.sourceCharacters > settings.requestSourceCharacters)
        list.push(
          `${part.task.fieldName} has ${part.sourceCharacters.toLocaleString('en-US')} characters, above this model’s ${settings.requestSourceCharacters.toLocaleString('en-US')}-character request size, so it is sent alone.`,
        );
    const tokens = estimatedOutputTokens(request.sourceCharacters);
    const names = [...new Set(request.parts.map(part => part.task.fieldName))].join(', ');
    if (outputAllowance && tokens > outputAllowance)
      list.push(
        `${names}: the estimated output of about ${tokens.toLocaleString('en-US')} tokens exceeds the model’s ${outputAllowance.toLocaleString('en-US')}-token output allowance. The answer may be cut off.`,
      );
  }
  return [...new Set(list)];
}

/**
 * Plans a run: one target locale per request, fields packed in content-type
 * order within the source-character, work-field and byte budgets. Short text
 * stays whole; Long text splits at paragraphs, arrays between items and Rich
 * Text at block boundaries only when they exceed the request size, whatever
 * the backend.
 * @throws PlanError for a part or context that cannot fit.
 */
export function planRun(tasks: Task[], options: PlanOptions): RunPlan {
  const plan = planContext(tasks, options);
  const { settings } = options;
  const groups: WorkPart[][] = [];
  const locales = [...new Set(tasks.map(task => task.targetLocale))];
  for (const locale of locales) {
    let current: WorkPart[] = [];
    let characters = 0;
    const flush = () => {
      if (current.length) groups.push(current);
      current = [];
      characters = 0;
    };
    for (const task of tasks.filter(item => item.targetLocale === locale).sort((a, b) => a.order - b.order)) {
      const source = plan.sources.get(task.fieldId) as FieldSource;
      const splittable = task.kind === 'array' || task.kind === 'richText' || task.longText;
      const cuts = splittable
        ? partition(source.segments, 0, source.segments.length, settings.requestSourceCharacters)
        : [0];
      for (const [index, cut] of cuts.entries()) {
        const part = makePart(task, source, cut, cuts[index + 1] ?? source.segments.length);
        if (part.sourceCharacters > settings.requestSourceCharacters) {
          flush();
          groups.push([part]);
          continue;
        }
        if (
          current.length >= settings.maxWorkFields ||
          characters + part.sourceCharacters > settings.requestSourceCharacters
        )
          flush();
        current.push(part);
        characters += part.sourceCharacters;
      }
    }
    flush();
  }
  const requests = finalize(plan, groups);
  return { requests, warnings: warnings(plan, requests) };
}

// Failed parts of one request, with the size of the request they failed in.
export type RetryGroup = { parts: WorkPart[]; requestCharacters: number; requestParts: number };
export type RetryPlan = RunPlan & { unavailable?: string };

/**
 * Plans a retry of failed work. Ordinary retry repeats each failed group's
 * parts with their boundaries and frozen inputs under new request IDs.
 * Smaller retry separates grouped fields, then splits each failed part at
 * legal boundaries with a target of the failed source size times the retry
 * factor, capped by the model's request size.
 * @param kept Successful ranges by task key, for part numbering.
 */
export function planRetry(
  tasks: Task[],
  options: PlanOptions,
  failed: RetryGroup[],
  smaller: boolean,
  kept: Map<string, [number, number][]> = new Map(),
): RetryPlan {
  const plan = planContext(tasks, options);
  const fresh = (part: WorkPart) =>
    makePart(part.task, plan.sources.get(part.task.fieldId) as FieldSource, part.start, part.end);
  if (!smaller) {
    const requests = finalize(
      plan,
      failed.map(group => group.parts.map(fresh)),
      kept,
    );
    return { requests, warnings: warnings(plan, requests) };
  }
  const groups: WorkPart[][] = [];
  const indivisible: string[] = [];
  for (const group of failed) {
    // The size of the request that failed, so separating its fields counts
    // as less work even when the field being retried cannot split.
    const target = Math.max(
      1,
      Math.min(
        options.settings.requestSourceCharacters,
        Math.floor(group.requestCharacters * options.settings.retrySizeFactor),
      ),
    );
    for (const part of group.parts) {
      const source = plan.sources.get(part.task.fieldId) as FieldSource;
      const cuts = partition(source.segments, part.start, part.end, target);
      if (group.requestParts === 1 && cuts.length < 2) {
        indivisible.push(part.task.fieldName);
        continue;
      }
      for (const [index, cut] of cuts.entries())
        groups.push([makePart(part.task, source, cut, cuts[index + 1] ?? part.end)]);
    }
  }
  if (indivisible.length)
    return {
      requests: [],
      warnings: [],
      unavailable: `${[...new Set(indivisible)].join(', ')} cannot be split into smaller requests: ${indivisible.length === 1 ? 'it is' : 'they are'} a single paragraph, item or block. Retry as is, or ask an administrator to raise this model’s timeout or output allowance.`,
    };
  const requests = finalize(plan, groups, kept);
  return { requests, warnings: warnings(plan, requests) };
}
