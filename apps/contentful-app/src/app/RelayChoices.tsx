import { SOURCE_CHARACTER_PRESETS, type TranslationSettings } from '@ai-translator-for-contentful/protocol';
import { Accordion, Button, Checkbox, FormControl, Note, Select } from '@contentful/f36-components';
import {
  choiceKey,
  dialogChoiceLabel,
  effectiveRelayChoices,
  parseRelayChoices,
  relayChoiceProblems,
  type SavedChoice,
  sameChoice,
  savedDefault,
  serializeRelayChoices,
} from './choices';
import { ModelPicker } from './ModelPicker';
import { problemText, relaySaveError } from './setup-model';
import type { HealthResult } from './signed';
import { TranslationSettingsEditor } from './TranslationSettingsEditor';
import type { Params } from './transport-config';

type ChoiceParams = Pick<Params, 'relayProvider' | 'relayModel' | 'relayProviderChoices'>;

type Props = {
  health: HealthResult;
  params: Params;
  // Receives only the changed choice settings.
  onChange: (next: ChoiceParams) => void;
  discover: (alias: string) => Promise<string[]>;
  test: (alias: string, model: string) => Promise<string>;
  onSettingsError: (id: string, message: string | undefined) => void;
};

function readChoices(params: Params): { choices: SavedChoice[]; unreadable: boolean } {
  try {
    return { choices: parseRelayChoices(params.relayProviderChoices), unreadable: false };
  } catch {
    return { choices: [], unreadable: true };
  }
}

/**
 * The Custom backend providers and models editors may choose, and the
 * installation default. The backend operator decides what the space can use;
 * this list only narrows what editors see. New aliases start unchecked, and
 * saved choices the backend no longer honors must be removed explicitly.
 */
export function RelayChoices({ health, params, onChange, discover, test, onSettingsError }: Props) {
  const { choices, unreadable } = readChoices(params);
  const problems = relayChoiceProblems(health.providers, choices);
  const effective = effectiveRelayChoices(health.providers, choices);
  const chosen = savedDefault(params);
  const defaultKey = chosen && effective.some(choice => choice.key === choiceKey(chosen)) ? choiceKey(chosen) : '';
  const saveError = relaySaveError(health, params);
  const only = health.providers.length === 1 ? health.providers[0] : undefined;

  // A new setup whose list goes from empty to one choice takes it as the
  // default. An existing default is never replaced.
  function change(next: SavedChoice[]) {
    const nextEffective = effectiveRelayChoices(health.providers, next);
    const update: ChoiceParams = { relayProviderChoices: serializeRelayChoices(next) };
    if (!params.relayProvider && !effective.length && nextEffective.length === 1) {
      update.relayProvider = nextEffective[0].alias;
      update.relayModel = next.find(choice => choice.alias === nextEffective[0].alias)?.model ?? '';
    }
    onChange(update);
  }

  function setSettings(choice: SavedChoice, translationSettings: TranslationSettings | undefined) {
    onChange({
      relayProviderChoices: serializeRelayChoices(
        choices.map(item =>
          sameChoice(item, choice)
            ? {
                alias: item.alias,
                ...(item.model === undefined ? {} : { model: item.model }),
                ...(translationSettings ? { translationSettings } : {}),
              }
            : item,
        ),
      ),
    });
  }
  const settings = (
    <Accordion className="provider-advanced">
      <Accordion.Item titleElement="h3" title="Request size per choice">
        <div className="provider-advanced-content">
          <p className="muted">
            Fields are grouped into requests of about this many source characters, by default{' '}
            {SOURCE_CHARACTER_PRESETS.custom.toLocaleString('en-US')}. Each request may take up to its provider’s
            timeout, so lower it for slow models or a backend with a short timeout.
          </p>
          {effective.map(item => {
            const saved = choices.find(choice => choiceKey(choice) === item.key);
            return saved ? (
              <TranslationSettingsEditor
                key={item.key}
                id={`relay-settings-${effective.indexOf(item)}`}
                label={dialogChoiceLabel(item)}
                settings={saved.translationSettings}
                presetCharacters={SOURCE_CHARACTER_PRESETS.custom}
                onChange={next => setSettings(saved, next)}
                onError={message => onSettingsError(`relay:${item.key}`, message)}
              />
            ) : null;
          })}
        </div>
      </Accordion.Item>
    </Accordion>
  );

  if (
    only &&
    only.modelSelection !== 'installation' &&
    !problems.length &&
    choices.length === 1 &&
    sameChoice(choices[0], { alias: only.alias }) &&
    defaultKey
  )
    return (
      <>
        <p className="muted">
          Editors use {only.alias} · {only.model} · {only.host}.
        </p>
        {settings}
      </>
    );

  const fixed = health.providers.filter(provider => provider.modelSelection !== 'installation');
  const selectable = health.providers.filter(provider => provider.modelSelection === 'installation');
  const blocked = (alias: string) => problems.some(problem => problem.choice.alias === alias);
  return (
    <fieldset className="relay-choices">
      <legend>Editors may choose</legend>
      <p className="muted">
        The backend operator decides which providers this space can use; this list controls what editors see in this
        environment. It is not enforced by the backend.
      </p>
      {unreadable && (
        <Note variant="negative" role="alert">
          The saved editor choices could not be read. Choose them again.
        </Note>
      )}
      {problems.map(problem => (
        <Note key={choiceKey(problem.choice)} variant="warning" role="alert">
          <span className="relay-choice-problem">
            {problemText(problem)}
            <Button size="small" onClick={() => change(choices.filter(choice => !sameChoice(choice, problem.choice)))}>
              Remove
            </Button>
          </span>
        </Note>
      ))}
      {fixed.length > 0 && (
        <Checkbox.Group
          name="relay-fixed-choices"
          value={choices.filter(choice => choice.model === undefined).map(choice => choice.alias)}
          onChange={event => {
            const alias = event.target.value;
            change(
              event.target.checked ? [...choices, { alias }] : choices.filter(choice => !sameChoice(choice, { alias })),
            );
          }}
        >
          {fixed.map(provider => (
            <Checkbox key={provider.alias} value={provider.alias} isDisabled={blocked(provider.alias)}>
              {provider.alias} · {provider.model} · {provider.host}
            </Checkbox>
          ))}
        </Checkbox.Group>
      )}
      {selectable.map(provider => (
        <div className="relay-choice-group" key={provider.alias}>
          <strong>
            {provider.alias} <span className="muted">· {provider.host}</span>
          </strong>
          {blocked(provider.alias) ? (
            <p className="muted">Remove the saved choice above before choosing models for this provider.</p>
          ) : (
            <ModelPicker
              id={`relay-models-${health.providers.indexOf(provider)}`}
              selected={choices.filter(choice => choice.alias === provider.alias).map(choice => choice.model ?? '')}
              onChange={models =>
                change([
                  ...choices.filter(choice => choice.alias !== provider.alias),
                  // Kept models keep their request settings.
                  ...models.map(
                    model =>
                      choices.find(choice => choice.alias === provider.alias && choice.model === model) ?? {
                        alias: provider.alias,
                        model,
                      },
                  ),
                ])
              }
              discover={() => discover(provider.alias)}
              discoveryKey={`${params.backendUrl ?? ''}\u0000${provider.alias}`}
              test={model => test(provider.alias, model)}
            />
          )}
        </div>
      ))}
      <FormControl className="model-control" isInvalid={Boolean(saveError)} marginBottom="none">
        <FormControl.Label htmlFor="backend-default-choice">Default provider and model</FormControl.Label>
        <Select
          id="backend-default-choice"
          value={defaultKey}
          onChange={event => {
            const choice = effective.find(item => item.key === event.target.value);
            if (!choice?.alias) return;
            const selected = choices.find(item => choiceKey(item) === choice.key);
            onChange({ relayProvider: choice.alias, relayModel: selected?.model ?? '' });
          }}
          isDisabled={!effective.length}
        >
          <Select.Option value="">{effective.length ? 'Choose a default' : 'Enable a choice first'}</Select.Option>
          {effective.map(choice => (
            <Select.Option key={choice.key} value={choice.key}>
              {dialogChoiceLabel(choice)}
            </Select.Option>
          ))}
        </Select>
        <FormControl.HelpText>
          Editors start with the default and can pick another enabled choice for one translation under Advanced
          settings.
        </FormControl.HelpText>
        {saveError && <FormControl.ValidationMessage>{saveError}</FormControl.ValidationMessage>}
      </FormControl>
      {effective.length > 0 && settings}
    </fieldset>
  );
}
