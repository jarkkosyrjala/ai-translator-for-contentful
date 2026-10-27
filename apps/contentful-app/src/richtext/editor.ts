import type { RichInline } from '@ai-translator-for-contentful/protocol';
import type { ContentTypeField } from '@contentful/app-sdk';
import {
  BLOCKS,
  type Block,
  type Document,
  INLINES,
  type Inline,
  MARKS,
  type Text,
  validateRichTextDocument,
} from '@contentful/rich-text-types';
import { fixedTokenError, referenceWarning } from '../app/placeholders';
import { createContract, reconstruct } from './contract';

// Contentful's enabledNodeTypes lists editor options; these structural nodes
// remain necessary even when the field omits them from that list.
const structuralNodes = new Set<string>([
  BLOCKS.DOCUMENT,
  BLOCKS.PARAGRAPH,
  BLOCKS.LIST_ITEM,
  BLOCKS.TABLE_ROW,
  BLOCKS.TABLE_CELL,
  BLOCKS.TABLE_HEADER_CELL,
  'text',
]);
const blockNodes = new Set<string>(Object.values(BLOCKS));

export function isRichDocument(value: unknown): value is Document {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'nodeType' in value &&
      value.nodeType === BLOCKS.DOCUMENT,
  );
}

export function richTextPlanningError(value: unknown): string | undefined {
  if (!isRichDocument(value)) return 'No Rich Text source document';
  try {
    const contract = createContract(value);
    if (!contract.units.some(unit => unit.readable.trim())) return 'No translatable Rich Text source';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function richTextFieldError(document: Document, field: ContentTypeField): string | undefined {
  const validations = field.validations ?? [];
  const markRule = validations.find(rule => rule.enabledMarks !== undefined)?.enabledMarks;
  const nodeRule = validations.find(rule => rule.enabledNodeTypes !== undefined)?.enabledNodeTypes;
  const sizeRule = validations.find(rule => rule.size !== undefined)?.size;
  let characters = 0;
  const nodeCounts = new Map<string, number>();
  let error: string | undefined;
  function visit(node: Document | Block | Inline | Text) {
    if (error) return;
    if (node.nodeType === 'text') {
      characters += [...node.value].length;
      if (markRule && node.marks.some(mark => !markRule.includes(mark.type)))
        error = 'Rich Text uses a mark disabled by this field';
      return;
    }
    if (nodeRule && !structuralNodes.has(node.nodeType) && !nodeRule.includes(node.nodeType))
      error = `Rich Text node ${node.nodeType} is disabled by this field`;
    nodeCounts.set(node.nodeType, (nodeCounts.get(node.nodeType) ?? 0) + 1);
    for (const child of node.content) visit(child);
  }
  visit(document);
  if (error) return error;
  for (const rule of validations) {
    if (!rule.nodes) continue;
    for (const [nodeType, value] of Object.entries(rule.nodes)) {
      const nodeValidations = Array.isArray(value)
        ? value
        : value && typeof value === 'object' && 'validations' in value
          ? value.validations
          : [];
      for (const nodeValidation of nodeValidations ?? []) {
        const count = nodeCounts.get(nodeType) ?? 0;
        if (
          nodeValidation.size &&
          ((nodeValidation.size.min !== undefined && count < nodeValidation.size.min) ||
            (nodeValidation.size.max !== undefined && count > nodeValidation.size.max))
        )
          return `Rich Text ${nodeType} count violates the field rule`;
      }
    }
  }
  if (
    (sizeRule?.min !== undefined && characters < sizeRule.min) ||
    (sizeRule?.max !== undefined && characters > sizeRule.max) ||
    characters > 200_000
  )
    return 'Rich Text violates the field size rule';
}

const protectedLinks = new Set<string>([
  INLINES.HYPERLINK,
  INLINES.ENTRY_HYPERLINK,
  INLINES.ASSET_HYPERLINK,
  INLINES.RESOURCE_HYPERLINK,
]);
const protectedEmbeds = new Set<string>([
  BLOCKS.EMBEDDED_ENTRY,
  BLOCKS.EMBEDDED_ASSET,
  BLOCKS.EMBEDDED_RESOURCE,
  INLINES.EMBEDDED_ENTRY,
  INLINES.EMBEDDED_RESOURCE,
]);

function protectedContent(document: Document) {
  const links: string[] = [];
  const embeds: string[] = [];
  const rules: string[] = [];
  const code: string[] = [];
  const text: string[] = [];
  const formatting: Record<string, number>[] = [];
  const structure: string[] = [];
  let breaks = 0;
  function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, stable(item)]),
      );
    return value;
  }
  function visit(node: Document | Block | Inline | Text) {
    if (node.nodeType === 'text') {
      text.push(node.value);
      breaks += (node.value.match(/\n/g) ?? []).length;
      return;
    }
    // Keep adjacent text runs together, but separate Rich Text blocks. Without
    // this boundary, neighboring table cells can look like camelCase IDs.
    if (node.nodeType !== BLOCKS.DOCUMENT && blockNodes.has(node.nodeType)) text.push('\n');
    if (blockNodes.has(node.nodeType))
      structure.push(
        `${node.nodeType}:${node.content.filter(child => child.nodeType !== 'text' && blockNodes.has(child.nodeType)).length}`,
      );
    if (node.nodeType === BLOCKS.PARAGRAPH || /^heading-[1-6]$/.test(node.nodeType)) {
      const marks: Record<string, number> = {};
      let active = new Set<string>();
      const collect = (child: Document | Block | Inline | Text) => {
        if (child.nodeType === 'text') {
          const next = new Set(child.marks.map(mark => mark.type));
          for (const kind of next) if (!active.has(kind)) marks[kind] = (marks[kind] ?? 0) + 1;
          active = next;
        } else {
          active = new Set();
          child.content.forEach(collect);
          active = new Set();
        }
      };
      node.content.forEach(collect);
      formatting.push(marks);
    }
    const signature = JSON.stringify({ type: node.nodeType, data: stable(node.data) });
    if (protectedLinks.has(node.nodeType)) links.push(signature);
    if (protectedEmbeds.has(node.nodeType)) embeds.push(signature);
    if (node.nodeType === BLOCKS.HR) rules.push(signature);
    // Contentful may merge adjacent text nodes with the same marks. Compare
    // complete code spans so that this harmless normalization stays valid.
    let codeRun = '';
    for (const child of node.content) {
      if (child.nodeType === 'text' && child.marks.some(mark => mark.type === MARKS.CODE)) codeRun += child.value;
      else if (codeRun) {
        code.push(codeRun);
        codeRun = '';
      }
      visit(child);
    }
    if (codeRun) code.push(codeRun);
  }
  visit(document);
  return { links, embeds, rules, code, formatting, structure, text: text.join(''), breaks };
}

export type RichTextReviewValidation = { error?: string; warning?: string };

export function richTextReviewValidation(
  source: unknown,
  suggestion: unknown,
  field: ContentTypeField,
): RichTextReviewValidation {
  if (!isRichDocument(source) || !isRichDocument(suggestion)) return { error: 'The Rich Text document is unavailable' };
  try {
    if (validateRichTextDocument(suggestion).length)
      return { error: 'The Rich Text document has an invalid structure' };
    const fieldError = richTextFieldError(suggestion, field);
    if (fieldError) return { error: fieldError };
    const sourceContent = protectedContent(source);
    const editedContent = protectedContent(suggestion);
    const warnings: string[] = [];
    if (JSON.stringify(sourceContent.structure) !== JSON.stringify(editedContent.structure))
      warnings.push('Block structure changed');
    if (
      sourceContent.formatting.length !== editedContent.formatting.length ||
      sourceContent.formatting.some((sourceMarks, index) => {
        const targetMarks = editedContent.formatting[index] ?? {};
        return (
          Object.keys(sourceMarks).some(kind => (targetMarks[kind] ?? 0) < sourceMarks[kind]) ||
          Object.keys(targetMarks).some(kind => !sourceMarks[kind])
        );
      })
    )
      warnings.push('Text formatting changed');
    if (JSON.stringify(sourceContent.links.sort()) !== JSON.stringify(editedContent.links.sort()))
      warnings.push('A link changed');
    if (JSON.stringify(sourceContent.embeds.sort()) !== JSON.stringify(editedContent.embeds.sort()))
      warnings.push('An embedded item changed');
    if (JSON.stringify(sourceContent.rules.sort()) !== JSON.stringify(editedContent.rules.sort()))
      warnings.push('A horizontal rule changed');
    if (JSON.stringify(sourceContent.code.sort()) !== JSON.stringify(editedContent.code.sort()))
      warnings.push('Code text changed');
    if (sourceContent.breaks !== editedContent.breaks) warnings.push('A line break changed');
    const tokenError = fixedTokenError(sourceContent.text, editedContent.text);
    if (tokenError) warnings.push(tokenError);
    if (referenceWarning(sourceContent.text, editedContent.text))
      warnings.push('Reference-like text such as &amp; changed');
    return warnings.length ? { warning: warnings.join('; ') } : {};
  } catch {
    return { error: 'The Rich Text document has an invalid structure' };
  }
}

export function richTextEditError(source: unknown, suggestion: unknown, field: ContentTypeField): string | undefined {
  const validation = richTextReviewValidation(source, suggestion, field);
  return validation.error ?? validation.warning;
}

/**
 * Rebuilds a complete document from every unit's validated translation.
 * Throws only when the structure is invalid. A field-rule failure, such as a
 * suggestion over the size limit, and changed protected text stay reviewable
 * for the editor to fix or approve; see richTextReviewValidation.
 */
export function rebuildRichText(source: Document, units: ReadonlyMap<string, RichInline[]>): Document {
  const result = reconstruct(createContract(source), units, { allowTextWarnings: true });
  if (validateRichTextDocument(result).length) throw new Error('The Rich Text document has an invalid structure');
  return result;
}
