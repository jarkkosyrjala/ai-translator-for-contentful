import { resolveVariableValues, validLocale } from './instructions/compiler';
import {
  type InstructionProfile,
  validateInstructionProfile,
  validateRunGuidanceTemplate,
} from './instructions/profile';
import { codePoints, illegalCharacter, utf8Bytes } from './translation/markup';
import {
  CONTAINER_TAGS,
  type EmbedKind,
  inlineText,
  MARK_TAGS,
  type RichBlock,
  type RichInline,
  richSourceCharacters,
  UNIT_TAGS,
} from './translation/richtext';
import { DEFAULT_LIMITS } from './translation/settings';

// One relay and Function contract. A backend answers other versions with
// `unsupported_contract`, and the app asks for a backend update.
export const RELAY_CONTRACT_VERSION = 1;

export type FieldConstraints = {
  min?: number;
  max?: number;
  countMin?: number;
  countMax?: number;
  itemMin?: number;
  itemMax?: number;
};
type WorkBase = {
  // Unique within the request; identifies the result.
  id: string;
  // The Contentful field the work belongs to.
  fieldId: string;
  name: string;
  // Set together when the field is split: this part's 1-based position.
  part?: number;
  parts?: number;
  constraints?: FieldConstraints;
  outputGuidance?: string;
};
export type ArrayItem = { id: string; text: string };
export type TextWork = WorkBase & { type: 'text'; source: string };
export type ArrayWork = WorkBase & { type: 'array'; items: ArrayItem[] };
export type RichTextWork = WorkBase & { type: 'richText'; source: RichBlock[] };
export type WorkField = TextWork | ArrayWork | RichTextWork;
export type WorkType = WorkField['type'];

export type ContextRole = 'explicit' | 'sibling' | 'outline' | 'neighbor';
export type ContextField = {
  id: string;
  role: ContextRole;
  entryId: string;
  fieldId: string;
  name: string;
  locale: string;
  provenance: 'current-editor' | 'saved-entry';
  // The saved entry version a saved-entry value was read from.
  version?: number;
  // The work field a split-part outline or neighbor belongs to.
  for?: string;
  position?: 'before' | 'after';
  omittedUnits: number;
  value: string;
};

export type TranslateRequest = {
  contract: typeof RELAY_CONTRACT_VERSION;
  requestId: string;
  entryId: string;
  model: string;
  sourceLocale: string;
  targetLocale: string;
  availableLocales: string[];
  profile: InstructionProfile;
  profileRevision: string;
  runGuidance?: string;
  variableValues?: Record<string, string>;
  context?: ContextField[];
  fields: WorkField[];
};

export type WorkErrorCode = 'missing' | 'empty' | 'invalid_items' | 'invalid_structure';
export type WorkResult =
  | { id: string; status: 'ok'; type: 'text'; text: string }
  | { id: string; status: 'ok'; type: 'array'; items: ArrayItem[] }
  // Canonical model markup. Source preservation is checked in the frontend.
  | { id: string; status: 'ok'; type: 'richText'; markup: string }
  | { id: string; status: 'failed'; error: WorkErrorCode };
export type TranslateResponse = {
  contract: typeof RELAY_CONTRACT_VERSION;
  requestId: string;
  provider: 'mock' | 'openai-compatible';
  profileRevision: string;
  results: WorkResult[];
  // What the model answered when a field failed, from a relay in debug mode.
  debug?: { answer: string };
};

// Stable error codes a backend returns for a whole request.
export const TRANSLATION_ERROR_CODES = [
  'unsupported_contract',
  'invalid_request',
  'unexpected_property',
  'same_locale',
  'request_too_large',
  'model_not_allowed',
  'provider_not_allowed',
  'provider_rate_limited',
  'provider_auth_failed',
  'provider_timeout',
  'provider_truncated',
  'provider_incomplete',
  'provider_refused',
  'provider_request_too_large',
  'invalid_provider_response',
  'result_too_large',
  'provider_failed',
] as const;
export type TranslationErrorCode = (typeof TRANSLATION_ERROR_CODES)[number];
// Failures that a plan with less work per request may avoid.
export const SIZE_ERROR_CODES: readonly string[] = [
  'provider_timeout',
  'provider_truncated',
  'provider_incomplete',
  'provider_request_too_large',
  'request_too_large',
  'result_too_large',
];

export const REQUEST_KEYS = [
  'contract',
  'requestId',
  'entryId',
  'model',
  'sourceLocale',
  'targetLocale',
  'availableLocales',
  'profile',
  'profileRevision',
  'runGuidance',
  'variableValues',
  'context',
  'fields',
] as const;
export const RESPONSE_KEYS = ['contract', 'requestId', 'provider', 'profileRevision', 'results'] as const;
const workKeys = ['id', 'fieldId', 'name', 'type', 'part', 'parts', 'constraints', 'outputGuidance'];
const contextKeys = [
  'id',
  'role',
  'entryId',
  'fieldId',
  'name',
  'locale',
  'provenance',
  'version',
  'for',
  'position',
  'omittedUnits',
  'value',
];
const constraintKeys = ['min', 'max', 'countMin', 'countMax', 'itemMin', 'itemMax'];

// Identifiers the app generates: work, item, unit, anchor and context IDs.
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,99}$/;
export const validIdentifier = (value: unknown): value is string => typeof value === 'string' && identifier.test(value);

// Hard software bounds of one request. Byte limits apply on top.
export const REQUEST_BOUNDS = {
  fields: 200,
  items: 1_000,
  context: 200,
  textCodePoints: 200_000,
  // Contentful's own maxima: Long text 50,000 and Rich Text 200,000.
  textSource: 50_000,
  richSource: 200_000,
  itemCodePoints: 256,
  guidance: 4_000,
  runGuidance: 1_000,
  richNodes: 100_000,
  richDepth: 64,
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
function text(value: unknown, max: number, allowEmpty = true): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    codePoints(value) <= max &&
    illegalCharacter(value) === undefined
  );
}
function bounded(value: unknown, max: number): value is string {
  return text(value, max, false);
}
function count(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

function fail(): never {
  throw new Error('invalid_request');
}

type Anchors = { marks: Map<string, string>; once: Set<string> };

function checkInline(nodes: unknown, state: { nodes: number }, depth: number, anchors: Anchors): void {
  if (!Array.isArray(nodes) || depth > REQUEST_BOUNDS.richDepth) fail();
  const once = (kind: string, id: unknown) => {
    if (!validIdentifier(id) || anchors.once.has(`${kind}:${id}`)) fail();
    anchors.once.add(`${kind}:${id}`);
  };
  for (const node of nodes) {
    if (++state.nodes > REQUEST_BOUNDS.richNodes) fail();
    if (typeof node === 'string') {
      if (!text(node, REQUEST_BOUNDS.richSource)) fail();
      continue;
    }
    if (!object(node)) fail();
    const keys = Object.keys(node).sort().join(',');
    if (keys === 'children,mark,tag') {
      // A mark ID may cover several source spans of one formatting run.
      if (!(MARK_TAGS as readonly unknown[]).includes(node.tag) || !validIdentifier(node.mark)) fail();
      const tag = anchors.marks.get(node.mark);
      if (tag !== undefined && tag !== node.tag) fail();
      anchors.marks.set(node.mark, node.tag as string);
      checkInline(node.children, state, depth + 1, anchors);
    } else if (keys === 'children,link') {
      once('l', node.link);
      checkInline(node.children, state, depth + 1, anchors);
    } else if (keys === 'break') once('b', node.break);
    else if (keys === 'placeholder,text' || keys === 'fixed,text') {
      once(keys.startsWith('fixed') ? 'f' : 'p', node.fixed ?? node.placeholder);
      if (!bounded(node.text, REQUEST_BOUNDS.richSource)) fail();
    } else if (keys === 'ref') once('r', node.ref);
    else fail();
  }
}

function checkBlocks(blocks: unknown, state: { nodes: number; units: Set<string> }, depth: number): void {
  if (!Array.isArray(blocks) || depth > REQUEST_BOUNDS.richDepth) fail();
  for (const block of blocks) {
    if (++state.nodes > REQUEST_BOUNDS.richNodes || !object(block)) fail();
    if ('unit' in block) {
      if (
        !only(block, ['unit', 'tag', 'content']) ||
        !validIdentifier(block.unit) ||
        state.units.has(block.unit) ||
        !(UNIT_TAGS as readonly unknown[]).includes(block.tag)
      )
        fail();
      state.units.add(block.unit);
      checkInline(block.content, state, depth + 1, { marks: new Map(), once: new Set() });
    } else if (block.tag === 'hr') {
      if (!only(block, ['tag'])) fail();
    } else if (block.tag === 'embed') {
      if (!only(block, ['tag', 'kind']) || !['entry', 'asset', 'resource'].includes(block.kind as EmbedKind)) fail();
    } else {
      if (
        !only(block, ['tag', 'colspan', 'rowspan', 'children']) ||
        !(CONTAINER_TAGS as readonly unknown[]).includes(block.tag) ||
        (block.colspan !== undefined && !count(block.colspan, 1)) ||
        (block.rowspan !== undefined && !count(block.rowspan, 1))
      )
        fail();
      checkBlocks(block.children, state, depth + 1);
    }
  }
}

function checkConstraints(value: unknown): void {
  if (value === undefined) return;
  if (!object(value) || !only(value, constraintKeys) || Object.keys(value).some(key => !count(value[key]))) fail();
}

function checkWork(value: unknown, ids: Set<string>): WorkField {
  if (!object(value) || !only(value, [...workKeys, 'source', 'items'])) throw new Error('unexpected_property');
  if (
    !validIdentifier(value.id) ||
    ids.has(value.id) ||
    !bounded(value.fieldId, 100) ||
    !bounded(value.name, 200) ||
    (value.part === undefined) !== (value.parts === undefined) ||
    (value.part !== undefined &&
      (!count(value.part, 1) || !count(value.parts, 2) || (value.part as number) > (value.parts as number))) ||
    (value.outputGuidance !== undefined && !text(value.outputGuidance, REQUEST_BOUNDS.guidance))
  )
    fail();
  ids.add(value.id);
  checkConstraints(value.constraints);
  if (value.type === 'text') {
    if ('items' in value || !text(value.source, REQUEST_BOUNDS.textSource) || !value.source.trim()) fail();
  } else if (value.type === 'array') {
    if ('source' in value || !Array.isArray(value.items) || !value.items.length) fail();
    if (value.items.length > REQUEST_BOUNDS.items) fail();
    const itemIds = new Set<string>();
    for (const item of value.items) {
      if (
        !object(item) ||
        !only(item, ['id', 'text']) ||
        !validIdentifier(item.id) ||
        itemIds.has(item.id) ||
        !text(item.text, REQUEST_BOUNDS.itemCodePoints) ||
        // Empty and whitespace-only items stay in the app unchanged.
        !item.text.trim()
      )
        fail();
      itemIds.add(item.id);
    }
  } else if (value.type === 'richText') {
    if ('items' in value) fail();
    const state = { nodes: 0, units: new Set<string>() };
    checkBlocks(value.source, state, 0);
    const blocks = value.source as RichBlock[];
    if (!state.units.size || richSourceCharacters(blocks) > REQUEST_BOUNDS.richSource) fail();
  } else fail();
  return value as WorkField;
}

function checkContext(value: unknown, ids: Set<string>, workIds: Set<string>): void {
  if (!object(value) || !only(value, contextKeys)) throw new Error('unexpected_property');
  if (
    !validIdentifier(value.id) ||
    ids.has(value.id) ||
    workIds.has(value.id) ||
    !['explicit', 'sibling', 'outline', 'neighbor'].includes(value.role as string) ||
    !bounded(value.entryId, 100) ||
    !bounded(value.fieldId, 100) ||
    !bounded(value.name, 200) ||
    !bounded(value.locale, 35) ||
    !['current-editor', 'saved-entry'].includes(value.provenance as string) ||
    (value.version !== undefined && (value.provenance !== 'saved-entry' || !count(value.version))) ||
    (value.for !== undefined && !workIds.has(value.for as string)) ||
    (value.position !== undefined && value.position !== 'before' && value.position !== 'after') ||
    ((value.role === 'outline' || value.role === 'neighbor') && value.for === undefined) ||
    (value.role === 'neighbor') !== (value.position !== undefined) ||
    !count(value.omittedUnits) ||
    !text(value.value, REQUEST_BOUNDS.textCodePoints)
  )
    fail();
  ids.add(value.id);
}

/**
 * Validates a translation request, including its instruction profile,
 * variable values and serialized size.
 * @throws Error `unsupported_contract`, `unexpected_property`, `same_locale`,
 *   `invalid_request`, or `request_too_large`.
 */
export function parseTranslateRequest(value: unknown, requestBytes = DEFAULT_LIMITS.requestBytes): TranslateRequest {
  if (!object(value) || value.contract !== RELAY_CONTRACT_VERSION) throw new Error('unsupported_contract');
  if (!only(value, REQUEST_KEYS)) throw new Error('unexpected_property');
  if (utf8Bytes(JSON.stringify(value)) > requestBytes) throw new Error('request_too_large');
  if (
    !validIdentifier(value.requestId) ||
    !bounded(value.entryId, 100) ||
    !bounded(value.model, 100) ||
    !bounded(value.sourceLocale, 35) ||
    !bounded(value.targetLocale, 35) ||
    !Array.isArray(value.availableLocales) ||
    value.availableLocales.length > 50 ||
    value.availableLocales.some(locale => !bounded(locale, 35)) ||
    !value.availableLocales.includes(value.sourceLocale) ||
    !value.availableLocales.includes(value.targetLocale) ||
    (value.runGuidance !== undefined && !text(value.runGuidance, REQUEST_BOUNDS.runGuidance)) ||
    (value.variableValues !== undefined &&
      (!object(value.variableValues) ||
        Object.keys(value.variableValues).some(
          key => !text((value.variableValues as Record<string, unknown>)[key], 1000),
        ))) ||
    !Array.isArray(value.fields) ||
    !value.fields.length ||
    value.fields.length > REQUEST_BOUNDS.fields ||
    (value.context !== undefined && (!Array.isArray(value.context) || value.context.length > REQUEST_BOUNDS.context))
  )
    fail();
  if (value.sourceLocale === value.targetLocale) throw new Error('same_locale');
  const workIds = new Set<string>();
  for (const work of value.fields) checkWork(work, workIds);
  const contextIds = new Set<string>();
  for (const item of (value.context as unknown[] | undefined) ?? []) checkContext(item, contextIds, workIds);
  // Everything a backend checks again before calling the model is checked
  // here, so a bad request is refused before it reserves anything.
  if (!validLocale(value.sourceLocale) || !validLocale(value.targetLocale)) fail();
  let profile: InstructionProfile;
  try {
    profile = validateInstructionProfile(value.profile);
    resolveVariableValues(
      profile,
      value.variableValues as Record<string, string> | undefined,
      value.availableLocales as string[],
    );
    if (value.runGuidance) validateRunGuidanceTemplate(value.runGuidance, profile);
  } catch {
    fail();
  }
  if (value.profileRevision !== profile.revision) fail();
  return value as TranslateRequest;
}

export function workSourceCharacters(work: WorkField): number {
  if (work.type === 'text') return codePoints(work.source);
  if (work.type === 'array') return work.items.reduce((total, item) => total + codePoints(item.text), 0);
  return richSourceCharacters(work.source);
}

export function requestSourceCharacters(request: Pick<TranslateRequest, 'fields'>): number {
  return request.fields.reduce((total, work) => total + workSourceCharacters(work), 0);
}

/**
 * Validates a backend result against the request it answers: the same
 * request ID, contract and profile revision, and one result per requested work
 * field in request order with the requested type. Source item IDs, counts
 * and content preservation are checked by the frontend.
 * @throws Error `invalid_response`.
 */
function invalid(): never {
  throw new Error('invalid_response');
}

export function parseTranslateResponse(value: unknown, request: TranslateRequest): TranslateResponse {
  if (
    !object(value) ||
    !only(value, [...RESPONSE_KEYS, 'debug']) ||
    (value.debug !== undefined &&
      (!object(value.debug) || !only(value.debug, ['answer']) || typeof value.debug.answer !== 'string')) ||
    value.contract !== RELAY_CONTRACT_VERSION ||
    value.requestId !== request.requestId ||
    value.profileRevision !== request.profileRevision ||
    (value.provider !== 'mock' && value.provider !== 'openai-compatible') ||
    !Array.isArray(value.results) ||
    value.results.length !== request.fields.length
  )
    invalid();
  for (const [index, work] of request.fields.entries()) {
    const result = (value.results as unknown[])[index];
    if (!object(result) || result.id !== work.id) invalid();
    const item = result as Record<string, unknown>;
    if (item.status === 'failed') {
      if (
        !only(item, ['id', 'status', 'error']) ||
        !['missing', 'empty', 'invalid_items', 'invalid_structure'].includes(item.error as string)
      )
        invalid();
      continue;
    }
    if (item.status !== 'ok' || item.type !== work.type) invalid();
    if (work.type === 'text') {
      if (!only(item, ['id', 'status', 'type', 'text']) || typeof item.text !== 'string') invalid();
    } else if (work.type === 'array') {
      if (
        !only(item, ['id', 'status', 'type', 'items']) ||
        !Array.isArray(item.items) ||
        item.items.some(
          entry =>
            !object(entry) ||
            !only(entry, ['id', 'text']) ||
            typeof entry.id !== 'string' ||
            typeof entry.text !== 'string',
        )
      )
        invalid();
    } else if (!only(item, ['id', 'status', 'type', 'markup']) || typeof item.markup !== 'string') invalid();
  }
  return value as TranslateResponse;
}

export type { RichBlock, RichInline };
export { inlineText };
