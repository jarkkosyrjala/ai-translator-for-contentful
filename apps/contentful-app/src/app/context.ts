import { type ContextField, codePoints, illegalCharacter } from '@ai-translator-for-contentful/protocol';
import type { Document } from '@contentful/rich-text-types';
import { createContract } from '../richtext/contract';

export type ContextCandidate = {
  entryId: string;
  fieldId: string;
  fieldName: string;
  locale: string;
  provenance: ContextField['provenance'];
  rawValue: unknown;
  savedVersion?: number;
};
// A context field before the request numbers it.
export type BoundedContext = Omit<ContextField, 'id'>;
export type ContextBudget = { maxFields: number; fieldCharacters: number; totalCharacters: number };

// Context is only read by the model, so characters a reader could not accept
// are replaced instead of failing the request.
export function contextText(value: string): string {
  let result = value;
  for (let index = illegalCharacter(result); index !== undefined; index = illegalCharacter(result))
    result = `${result.slice(0, index)}�${result.slice(index + 1)}`;
  return result;
}

// Readable units of a value, never cut: paragraphs, array items with their
// original positions, or Rich Text blocks.
export function contextUnits(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/\n\s*\n/).filter(unit => unit.trim());
  if (Array.isArray(value) && value.every(item => typeof item === 'string'))
    return value.flatMap((item, index) => (item.trim() ? [`Item ${index + 1}: ${item}`] : []));
  if (value && typeof value === 'object' && 'nodeType' in value && value.nodeType === 'document') {
    return createContract(value as Document)
      .units.map(unit => unit.readable)
      .filter(unit => unit.trim());
  }
  throw new Error('Selected context is not supported text, a free-text array, or Rich Text');
}

/**
 * Keeps whole units of each candidate within the per-field and combined
 * character budgets, counting what was left out. Candidates beyond the field
 * count are returned as omitted.
 */
export function boundContext(
  candidates: ContextCandidate[],
  budget: ContextBudget,
  role: ContextField['role'] = 'explicit',
): { items: BoundedContext[]; omitted: ContextCandidate[]; characters: number } {
  let remaining = budget.totalCharacters;
  const items: BoundedContext[] = [];
  for (const candidate of candidates.slice(0, budget.maxFields)) {
    const kept: string[] = [];
    let length = 0;
    let omittedUnits = 0;
    for (const unit of contextUnits(candidate.rawValue)) {
      const size = codePoints(unit) + (kept.length ? 2 : 0);
      if (length + size > budget.fieldCharacters || size > remaining) {
        omittedUnits++;
        continue;
      }
      kept.push(unit);
      length += size;
      remaining -= size;
    }
    items.push({
      role,
      entryId: candidate.entryId,
      fieldId: candidate.fieldId,
      name: candidate.fieldName,
      locale: candidate.locale,
      provenance: candidate.provenance,
      ...(candidate.provenance === 'saved-entry' && candidate.savedVersion !== undefined
        ? { version: candidate.savedVersion }
        : {}),
      omittedUnits,
      value: contextText(kept.join('\n\n')),
    });
  }
  return {
    items,
    omitted: candidates.slice(budget.maxFields),
    characters: budget.totalCharacters - remaining,
  };
}
