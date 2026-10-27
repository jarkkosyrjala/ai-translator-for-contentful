import {
  defaultInstructionProfile,
  type InstructionProfile,
  parseTranslationSettings,
  RELAY_CONTRACT_VERSION,
  type TranslateRequest,
  type TranslationSettings,
  validModelId,
  validProviderAlias,
} from '@ai-translator-for-contentful/protocol';
import type { Params } from './transport-config';

// What the editor sees when the backend rejects a choice that was offered.
export const CHOICE_UNAVAILABLE =
  'This choice is no longer available. Close and reopen the dialog, or ask a space admin to check the app configuration.';

// A provider the calling space may use, as Custom backend health reports it:
// a fixed alias names its model; for an admin-selectable alias the
// installation chooses models.
type ProviderLimits = { timeoutSeconds: number; maxCompletionTokens?: number };
export type RelayProviderChoice =
  | ({ alias: string; model: string; host: string; modelSelection?: undefined } & ProviderLimits)
  | ({ alias: string; model?: undefined; host: string; modelSelection: 'installation' } & ProviderLimits);

// A saved Custom backend choice. A fixed alias stores no model, so the
// operator can change that alias's model without invalidating installations.
export type SavedChoice = { alias: string; model?: string; translationSettings?: TranslationSettings };

// One choice an editor can pick in the dialog, for either transport. The key
// keeps two models under one alias distinct.
export type DialogChoice = {
  key: string;
  alias?: string;
  model: string;
  host: string;
  translationSettings?: TranslationSettings;
  timeoutSeconds?: number;
  // The provider's configured output allowance in tokens, when known.
  outputAllowance?: number;
};

const CHOICE_LIMIT = 100;

export const choiceKey = (choice: SavedChoice) =>
  JSON.stringify(choice.model === undefined ? [choice.alias] : [choice.alias, choice.model]);

export const sameChoice = (a: SavedChoice, b: SavedChoice) => a.alias === b.alias && a.model === b.model;

/**
 * Parses `relayProviderChoices`. A missing value is an empty list.
 * @throws Error for malformed JSON, unknown keys, invalid aliases or model
 *   IDs, repeated choices, and an alias saved both fixed and selectable.
 */
export function parseRelayChoices(value: unknown): SavedChoice[] {
  if (value === undefined || value === null || value === '') return [];
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : undefined;
  } catch {
    throw new Error('invalid_choices');
  }
  if (!Array.isArray(parsed) || parsed.length > CHOICE_LIMIT) throw new Error('invalid_choices');
  const choices: SavedChoice[] = [];
  for (const item of parsed) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some(key => key !== 'alias' && key !== 'model' && key !== 'translationSettings') ||
      !validProviderAlias(item.alias) ||
      ('model' in item && !validModelId(item.model))
    )
      throw new Error('invalid_choices');
    let translationSettings: TranslationSettings | undefined;
    try {
      translationSettings =
        'translationSettings' in item ? parseTranslationSettings(item.translationSettings) : undefined;
    } catch {
      throw new Error('invalid_choices');
    }
    const choice: SavedChoice = {
      alias: item.alias,
      ...('model' in item ? { model: item.model } : {}),
      ...(translationSettings ? { translationSettings } : {}),
    };
    if (
      choices.some(
        other => other.alias === choice.alias && (other.model === undefined) !== (choice.model === undefined),
      )
    )
      throw new Error('invalid_choices');
    if (choices.some(other => sameChoice(other, choice))) throw new Error('invalid_choices');
    choices.push(choice);
  }
  return choices;
}

export function serializeRelayChoices(choices: SavedChoice[]): string {
  return JSON.stringify(
    choices.map(choice => ({
      alias: choice.alias,
      ...(choice.model === undefined ? {} : { model: choice.model }),
      ...(choice.translationSettings && Object.keys(choice.translationSettings).length
        ? { translationSettings: choice.translationSettings }
        : {}),
    })),
  );
}

export function savedDefault(params: Pick<Params, 'relayProvider' | 'relayModel'>): SavedChoice | undefined {
  if (!params.relayProvider) return undefined;
  return params.relayModel
    ? { alias: params.relayProvider, model: params.relayModel }
    : { alias: params.relayProvider };
}

// Why the saved Custom backend choices cannot be used, without health.
export function relayChoicesError(
  params: Pick<Params, 'relayProvider' | 'relayModel' | 'relayProviderChoices'>,
): string | undefined {
  let choices: SavedChoice[];
  try {
    choices = parseRelayChoices(params.relayProviderChoices);
  } catch {
    return 'The saved editor choices could not be read. Choose them again.';
  }
  if (!choices.length) return 'Choose at least one provider or model editors may use.';
  const chosen = savedDefault(params);
  if (!chosen || !choices.some(choice => sameChoice(choice, chosen)))
    return 'Choose the default provider and model for this installation.';
  return undefined;
}

// The dialog's choices: health providers in health order that match the saved
// list and selection mode. A selectable alias adds one choice per saved model,
// in saved order. Missing and incompatible saved choices are left out.
export function effectiveRelayChoices(providers: RelayProviderChoice[], saved: SavedChoice[]): DialogChoice[] {
  return providers.flatMap(provider => {
    if (provider.modelSelection !== 'installation') {
      const choice = saved.find(item => sameChoice(item, { alias: provider.alias }));
      return choice
        ? [
            {
              key: choiceKey({ alias: provider.alias }),
              alias: provider.alias,
              model: provider.model,
              host: provider.host,
              timeoutSeconds: provider.timeoutSeconds,
              ...(provider.maxCompletionTokens ? { outputAllowance: provider.maxCompletionTokens } : {}),
              ...(choice.translationSettings ? { translationSettings: choice.translationSettings } : {}),
            },
          ]
        : [];
    }
    return saved
      .filter(choice => choice.alias === provider.alias && choice.model !== undefined)
      .map(choice => ({
        key: choiceKey(choice),
        alias: provider.alias,
        model: choice.model as string,
        host: provider.host,
        timeoutSeconds: provider.timeoutSeconds,
        ...(provider.maxCompletionTokens ? { outputAllowance: provider.maxCompletionTokens } : {}),
        ...(choice.translationSettings ? { translationSettings: choice.translationSettings } : {}),
      }));
  });
}

export type ChoiceProblem = { choice: SavedChoice; reason: 'missing' | 'mode' };

// Saved choices health cannot honor. Each must be removed explicitly; the app
// never reinterprets one.
export function relayChoiceProblems(providers: RelayProviderChoice[], saved: SavedChoice[]): ChoiceProblem[] {
  return saved.flatMap((choice): ChoiceProblem[] => {
    const provider = providers.find(item => item.alias === choice.alias);
    if (!provider) return [{ choice, reason: 'missing' }];
    return (provider.modelSelection === 'installation') !== (choice.model !== undefined)
      ? [{ choice, reason: 'mode' }]
      : [];
  });
}

export function dialogChoiceLabel(choice: DialogChoice): string {
  return choice.alias === undefined ? choice.model : `${choice.alias} · ${choice.model} · ${choice.host}`;
}

// The synthetic translation behind Test model: one grouped request with one
// text field and no entry content, and a fixed synthetic entry ID so
// repeated tests take turns at a backend's usage gate.
export function modelTestRequest(
  model: string,
  requestId: string,
  profile: InstructionProfile = defaultInstructionProfile(),
): TranslateRequest {
  return {
    contract: RELAY_CONTRACT_VERSION,
    requestId,
    entryId: 'ai-translator-model-test',
    model,
    sourceLocale: 'en-US',
    targetLocale: 'fi-FI',
    availableLocales: ['en-US', 'fi-FI'],
    profile,
    profileRevision: profile.revision,
    fields: [{ id: 'f-modelTest', fieldId: 'modelTest', name: 'Model test', type: 'text', source: 'Good morning.' }],
  };
}

// The text a model test returned, for the admin to read.
export function modelTestText(response: { results: { status: string; type?: string; text?: string }[] }): string {
  const [result] = response.results;
  if (result?.status !== 'ok' || result.type !== 'text' || typeof result.text !== 'string')
    throw new Error('The model answered, but not in the expected format.');
  return result.text;
}
