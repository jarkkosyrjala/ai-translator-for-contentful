import type { ContentTypeField } from '@contentful/app-sdk';
import type { Eligibility } from './eligibility';
import { sourceProblem } from './source-text';

export type FieldAction = { visible: false } | { visible: true; label: string; tooltip: string; disabled: boolean };

// The translate button beside a field. A field that cannot be translated, or
// has no other locale to translate into, gets no button. Otherwise the button
// explains why it is disabled.
export function fieldAction(input: {
  result?: Eligibility;
  definition?: ContentTypeField;
  fieldName: string;
  value: unknown;
  locale: string;
  targets: string[];
  configured: boolean;
  localeNames: Record<string, string>;
}): FieldAction {
  const { result } = input;
  if (!result?.eligible || !input.targets.length) return { visible: false };
  const from = input.localeNames[input.locale] || input.locale;
  const label = `Translate ${input.fieldName} from ${from}`;
  if (!input.configured)
    return {
      visible: true,
      label,
      tooltip: 'AI Translator isn’t set up yet. A space admin needs to connect a translation service.',
      disabled: true,
    };
  const problem = sourceProblem(input.value, result.kind, input.definition);
  if (problem)
    return {
      visible: true,
      label,
      tooltip: problem === 'empty' ? `Add text in ${from} to translate it.` : problem,
      disabled: true,
    };
  return { visible: true, label, tooltip: `Translate from ${from}`, disabled: false };
}
