import type { ContextField, TranslateRequest, WorkField } from '../contract';
import type { InstructionProfile } from '../instructions/profile';
import { attributes, escapeText, illegalCharacter } from './markup';
import { BLOCK_TAGS, INLINE_TAGS, serializeBlocks } from './richtext';

// Element names of the request and response envelope. Ordinary text escapes
// them; Rich Text units also escape their block and inline vocabulary.
export const ENVELOPE_TAGS: ReadonlySet<string> = new Set([
  'translation',
  'runGuidance',
  'variables',
  'variable',
  'context',
  'fields',
  'field',
  'constraints',
  'outputGuidance',
  'source',
  'item',
]);
export const RICH_TEXT_VOCABULARY: ReadonlySet<string> = new Set([...ENVELOPE_TAGS, ...BLOCK_TAGS, ...INLINE_TAGS]);

// Metadata such as field names only informs the model. Characters a reader
// could not accept are replaced; source text with them is rejected earlier.
function metadata(value: string): string {
  let result = value;
  while (illegalCharacter(result) !== undefined) {
    const index = illegalCharacter(result) as number;
    result = `${result.slice(0, index)}�${result.slice(index + 1)}`;
  }
  return result;
}

const text = (value: string) => escapeText(value, ENVELOPE_TAGS);

function contextField(item: ContextField): string {
  return `<field${attributes([
    ['id', item.id],
    ['role', item.role],
    ['entryId', item.entryId],
    ['fieldId', item.fieldId],
    ['name', metadata(item.name)],
    ['locale', item.locale],
    ['provenance', item.provenance],
    ['version', item.version],
    ['for', item.for],
    ['position', item.position],
    ['omittedUnits', item.omittedUnits],
  ])}>${text(item.value)}</field>`;
}

export function serializeSource(work: WorkField): string {
  if (work.type === 'text') return text(work.source);
  if (work.type === 'array')
    return work.items.map(item => `<item${attributes([['id', item.id]])}>${text(item.text)}</item>`).join('');
  return serializeBlocks(work.source, RICH_TEXT_VOCABULARY);
}

function workField(work: WorkField): string {
  const constraints = work.constraints ?? {};
  return [
    `    <field${attributes([
      ['id', work.id],
      ['fieldId', work.fieldId],
      ['name', metadata(work.name)],
      ['type', work.type],
      ['part', work.part],
      ['parts', work.parts],
    ])}>`,
    `      <constraints${attributes([
      ['min', constraints.min],
      ['max', constraints.max],
      ['countMin', constraints.countMin],
      ['countMax', constraints.countMax],
      ['itemMin', constraints.itemMin],
      ['itemMax', constraints.itemMax],
    ])}/>${work.outputGuidance ? `<outputGuidance>${text(work.outputGuidance)}</outputGuidance>` : ''}`,
    `      <source>${serializeSource(work)}</source>`,
    '    </field>',
  ].join('\n');
}

/**
 * The user message of a translation request: run guidance, variables and
 * context, then the fields to translate. Every value is data inside an
 * element; nothing is substituted into instructions.
 */
export function serializeTranslationRequest(
  request: TranslateRequest,
  profile: InstructionProfile,
  values: Record<string, string>,
  runGuidance: string,
): string {
  const lines = [
    `<translation${attributes([
      ['sourceLocale', request.sourceLocale],
      ['targetLocale', request.targetLocale],
    ])}>`,
  ];
  if (runGuidance) lines.push(`  <runGuidance>${text(runGuidance)}</runGuidance>`);
  if (profile.variables.length)
    lines.push(
      `  <variables>${profile.variables
        .map(
          variable =>
            `<variable${attributes([
              ['key', variable.key],
              ['name', metadata(variable.name)],
              ['type', variable.type],
              ['purpose', variable.description ? metadata(variable.description) : undefined],
            ])}>${text(values[variable.key] ?? '')}</variable>`,
        )
        .join('')}</variables>`,
    );
  if (request.context?.length) lines.push(`  <context>${request.context.map(contextField).join('')}</context>`);
  lines.push('  <fields>', ...request.fields.map(workField), '  </fields>', '</translation>');
  return lines.join('\n');
}
