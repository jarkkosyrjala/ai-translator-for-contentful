import { parseTranslationSettings, type TranslationSettings } from './translation/settings';

// Model IDs and provider aliases that installations and backends exchange.

export const MODEL_LIST_LIMIT = 100;

// A model ID that an installation can save and a backend can accept. `mock` is
// reserved for automated checks.
export function validModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 100 &&
    value !== 'mock' &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  );
}

// Aliases are operator-chosen names, matched exactly, such as `primary` or
// `Self-hosted model`.
export function validProviderAlias(alias: unknown): alias is string {
  return (
    typeof alias === 'string' &&
    alias.length > 0 &&
    alias.length <= 100 &&
    alias.trim() === alias &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: aliases are human-readable names.
    !/[\u0000-\u001f\u007f]/.test(alias)
  );
}

// A model an installation offers editors, with its optional planner tuning.
export type ModelChoice = { model: string; translationSettings?: TranslationSettings };

/**
 * Parses a saved model list: a JSON string encoding unique model choices in
 * the admin's order. A missing value is an empty list.
 * @throws Error `invalid_model_list` for anything else, never an empty fallback.
 */
export function parseModelChoices(value: unknown): ModelChoice[] {
  if (value === undefined || value === null || value === '') return [];
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' && value.length <= 16_384 ? JSON.parse(value) : undefined;
  } catch {
    throw new Error('invalid_model_list');
  }
  if (!Array.isArray(parsed) || parsed.length > MODEL_LIST_LIMIT) throw new Error('invalid_model_list');
  const choices: ModelChoice[] = [];
  for (const item of parsed) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some(key => key !== 'model' && key !== 'translationSettings') ||
      !validModelId(item.model) ||
      choices.some(choice => choice.model === item.model)
    )
      throw new Error('invalid_model_list');
    try {
      const settings = parseTranslationSettings(item.translationSettings);
      choices.push(
        'translationSettings' in item ? { model: item.model, translationSettings: settings } : { model: item.model },
      );
    } catch {
      throw new Error('invalid_model_list');
    }
  }
  return choices;
}

export function parseModelList(value: unknown): string[] {
  return parseModelChoices(value).map(choice => choice.model);
}

export function serializeModelChoices(choices: ModelChoice[]): string {
  return JSON.stringify(choices);
}

/**
 * The saved models and default of an installation. An empty list has no
 * default; a nonempty list needs a default from the list.
 * @throws Error `invalid_model_list` when the two do not agree.
 */
export function parseModelSelection(
  models: unknown,
  defaultModel: unknown,
): { models: string[]; defaultModel?: string; choices: ModelChoice[] } {
  const choices = parseModelChoices(models);
  const list = choices.map(choice => choice.model);
  const chosen = defaultModel === undefined || defaultModel === null || defaultModel === '' ? undefined : defaultModel;
  if (list.length ? typeof chosen !== 'string' || !list.includes(chosen) : chosen !== undefined)
    throw new Error('invalid_model_list');
  return chosen === undefined ? { models: list, choices } : { models: list, defaultModel: chosen as string, choices };
}
