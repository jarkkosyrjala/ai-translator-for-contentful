import {
  defaultInstructionProfile,
  effectiveInstructionProfile,
  type InstructionProfile,
  installationParametersError,
  instructionProfileFromParameters,
  SOURCE_CHARACTER_PRESETS,
  serializeModelChoices,
  type TranslationSettings,
  validateInstructionProfile,
} from '@ai-translator-for-contentful/protocol';
import type { AppState, ConfigAppSDK, EditorInterface } from '@contentful/app-sdk';
import {
  Accordion,
  Button,
  Checkbox,
  DisplayText,
  FormControl,
  Note,
  Radio,
  Select,
  Subheading,
  Switch,
  TextInput,
} from '@contentful/f36-components';
import { useEffect, useRef, useState } from 'react';
import { modelTestRequest, modelTestText, savedDefault, serializeRelayChoices } from './choices';
import {
  configuredKeyPresent,
  configuredParameters,
  FUNCTION_PROVIDER_EXAMPLE,
  functionConnectionError,
  functionModelChoices,
  functionModelList,
  functionModelsError,
  functionProviderHost,
  type KeyEdit,
  type SecretEdit,
} from './function-config';
import { functionHealth, functionModels, functionTranslate } from './function-transport';
import { InstructionSettings } from './InstructionSettings';
import { ModelPicker } from './ModelPicker';
import { ProviderAdvancedSettings } from './ProviderAdvancedSettings';
import { RelayChoices } from './RelayChoices';
import {
  backendHealthMessage,
  buildTargetState,
  type ConnectionMessage,
  type ContentTypeChoice,
  connectionErrorMessage,
  countTranslatableFields,
  relaySaveError,
  setupErrors,
} from './setup-model';
import { type HealthResult, RelayError, signedHealth, signedModels, signedTranslate } from './signed';
import { TranslationSettingsEditor } from './TranslationSettingsEditor';
import type { Params } from './transport-config';

type LoadState = { choices: ContentTypeChoice[]; current: AppState | null };
function newProfileRevision(): string {
  return crypto.randomUUID();
}
// The Function's provider connection, without its model choices.
function functionSettingsSnapshot(values: Params): string {
  return JSON.stringify([
    values.functionProviderUrl ?? '',
    values.functionKeyPresent === true,
    values.functionAuthMode ?? 'bearer',
    values.functionAuthHeader ?? '',
    values.functionTemperature ?? null,
    values.functionTopP ?? null,
    values.functionMaxCompletionTokens ?? null,
    values.functionOutputTokenField ?? '',
    values.functionReasoningEffort ?? '',
    values.functionExtraBody ?? '',
    values.functionHeadersPresent === true,
    values.functionTimeoutSeconds ?? null,
    values.functionIdleTimeoutSeconds ?? null,
  ]);
}
// What the Function last saved, read back after each save. Saved-state
// actions wait until this is known.
type SavedFunction = { known: boolean; connection: string; models: string[] };
function savedFunctionOf(values: Params | null | undefined): SavedFunction {
  return values
    ? { known: true, connection: functionSettingsSnapshot(values), models: functionModelList(values) }
    : { known: false, connection: '', models: [] };
}
function discoveryError(error: unknown): string {
  if (error instanceof RelayError)
    return error.code === 'model_list_unavailable'
      ? 'The provider’s model list could not be loaded.'
      : error.code === 'provider_not_allowed'
        ? 'The backend no longer offers this provider to this space. Test the connection again.'
        : connectionErrorMessage(error, 'custom').text;
  return error instanceof Error ? error.message : 'The model list could not be loaded.';
}
// The Custom backend choices before a connection test confirms them.
function untestedChoices(params: Params): string {
  const chosen = savedDefault(params);
  return chosen
    ? `Default: ${chosen.model === undefined ? chosen.alias : `${chosen.alias} · ${chosen.model}`}. Test the connection to change what editors may choose.`
    : 'Test the connection, then choose the providers and models editors may use.';
}
const profileContent = (profile: InstructionProfile) => JSON.stringify({ ...profile, revision: '' });
function initialProfile(raw: string | undefined): InstructionProfile {
  try {
    return instructionProfileFromParameters({ instructionProfile: raw }) ?? defaultInstructionProfile();
  } catch {
    return defaultInstructionProfile();
  }
}
// The profile the saved installation translates with, for model tests.
function savedProfileOf(values: Params | null | undefined): InstructionProfile | undefined {
  try {
    return effectiveInstructionProfile(values ?? {});
  } catch {
    return undefined;
  }
}
function initialProfileError(raw: string | undefined): string | undefined {
  try {
    instructionProfileFromParameters({ instructionProfile: raw });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function Config({ sdk }: { sdk: ConfigAppSDK<Params> }) {
  const savedSecret = useRef<unknown>(sdk.parameters.installation.functionApiKey);
  const savedHeaders = useRef<unknown>(sdk.parameters.installation.functionExtraHeaders);
  const [params, setParams] = useState<Params>({
    ...sdk.parameters.installation,
    functionApiKey: undefined,
    functionExtraHeaders: undefined,
    transport: sdk.parameters.installation.transport ?? 'custom',
    backendUrl: sdk.parameters.installation.backendUrl ?? '',
    relayProvider: sdk.parameters.installation.relayProvider ?? '',
    relayModel: sdk.parameters.installation.relayModel ?? '',
    relayProviderChoices: sdk.parameters.installation.relayProviderChoices ?? '',
    debugMode: sdk.parameters.installation.debugMode === true,
  });
  const savedProfile = useRef(savedProfileOf(sdk.parameters.installation));
  // Invalid per-model request settings by editor ID; saving waits for them.
  const settingsErrors = useRef(new Map<string, string>());
  const [, setSettingsErrorCount] = useState(0);
  function settingsError(id: string, message: string | undefined) {
    if (message) settingsErrors.current.set(id, message);
    else settingsErrors.current.delete(id);
    setSettingsErrorCount(settingsErrors.current.size);
  }
  const [keyEdit, setKeyEdit] = useState<KeyEdit>({ mode: 'keep' });
  const [headersEdit, setHeadersEdit] = useState<SecretEdit>({ mode: 'keep' });
  const [profileDraft, setProfileDraft] = useState<InstructionProfile>(() =>
    initialProfile(sdk.parameters.installation.instructionProfile),
  );
  const [profileLoadError, setProfileLoadError] = useState(() =>
    initialProfileError(sdk.parameters.installation.instructionProfile),
  );
  const profileTouched = useRef(false);
  const profileDraftRef = useRef(profileDraft);
  const savedProfileContent = useRef(
    sdk.parameters.installation.instructionProfile
      ? profileContent(initialProfile(sdk.parameters.installation.instructionProfile))
      : '',
  );
  const pendingProfile = useRef<InstructionProfile | undefined>(undefined);
  const keyEditRef = useRef(keyEdit);
  const headersEditRef = useRef(headersEdit);
  const [savedFunction, setSavedFunction] = useState(() => savedFunctionOf(sdk.parameters.installation));
  const [loaded, setLoaded] = useState<LoadState>();
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [health, setHealth] = useState<HealthResult>();
  const healthRef = useRef(health);
  const [connection, setConnection] = useState<ConnectionMessage>();
  const [testing, setTesting] = useState(false);
  const paramsRef = useRef(params);
  const selectedRef = useRef(selected);
  const touchedRef = useRef(new Set<string>());
  const loadedRef = useRef(loaded);
  const profileLoadErrorRef = useRef(profileLoadError);
  paramsRef.current = params;
  profileDraftRef.current = profileDraft;
  keyEditRef.current = keyEdit;
  headersEditRef.current = headersEdit;
  selectedRef.current = selected;
  loadedRef.current = loaded;
  profileLoadErrorRef.current = profileLoadError;
  healthRef.current = health;
  const errors = setupErrors(params);
  const functionSelection = functionModelList(params);
  const functionModelError = params.transport === 'function' ? functionModelsError(params) : undefined;
  // Discovery and Test model use the saved provider settings, so they wait
  // until the connection shown here is the one saved.
  const functionSaved =
    savedFunction.known &&
    keyEdit.mode === 'keep' &&
    headersEdit.mode === 'keep' &&
    functionSettingsSnapshot(params) === savedFunction.connection &&
    !functionConnectionError(params);

  useEffect(() => {
    let cancelled = false;
    sdk.app.onConfigure(async () => {
      const values = paramsRef.current;
      const current = loadedRef.current;
      const invalid = setupErrors(values);
      if (!current || invalid.backendUrl || invalid.functionProviderUrl) return false;
      const settingsProblem = settingsErrors.current.values().next().value;
      if (settingsProblem) {
        sdk.notifier.error(settingsProblem);
        return false;
      }
      if (values.transport !== 'function') {
        const choiceError = relaySaveError(healthRef.current, values);
        if (choiceError) {
          sdk.notifier.error(choiceError);
          return false;
        }
      }
      if (profileLoadErrorRef.current && !profileTouched.current) {
        sdk.notifier.error('The saved instruction profile is invalid. Reset it to the defaults before saving.');
        return false;
      }
      const draft = { ...values };
      if (draft.instructionProfile !== undefined) {
        try {
          const profile = validateInstructionProfile(profileDraftRef.current);
          draft.instructionProfile = JSON.stringify({
            ...profile,
            revision: profileContent(profile) === savedProfileContent.current ? profile.revision : newProfileRevision(),
          });
        } catch (error) {
          sdk.notifier.error(error instanceof Error ? error.message : 'Instruction profile is invalid.');
          return false;
        }
      }
      const parameters = configuredParameters(
        draft,
        savedSecret.current,
        keyEditRef.current,
        savedHeaders.current,
        headersEditRef.current,
      );
      if (!parameters) {
        sdk.notifier.error(
          'A provider Secret could not be saved or preserved. Check the credential and headers, then reopen app configuration if needed.',
        );
        return false;
      }
      if (parameters.transport === 'function' && parameters.functionProviderUrl) {
        // Provider settings can be saved before any model is chosen, so the
        // models can then be loaded with them.
        const settingsError = functionConnectionError(parameters) ?? functionModelsError(parameters);
        if (settingsError) {
          sdk.notifier.error(settingsError);
          return false;
        }
        parameters.functionModels = serializeModelChoices(functionModelChoices(parameters));
      }
      const sizeError = installationParametersError(parameters);
      if (sizeError) {
        sdk.notifier.error(sizeError);
        return false;
      }
      pendingProfile.current = draft.instructionProfile ? instructionProfileFromParameters(draft) : undefined;
      savedProfile.current = savedProfileOf(draft);
      const latestState = await sdk.app.getCurrentState();
      return {
        parameters,
        targetState: buildTargetState(latestState, current.choices, selectedRef.current, touchedRef.current),
      };
    });
    sdk.app.onConfigurationCompleted(error => {
      if (error) return;
      setSavedFunction(savedFunctionOf(undefined));
      if (pendingProfile.current) {
        savedProfileContent.current = profileContent(pendingProfile.current);
        setProfileDraft(pendingProfile.current);
        setProfileLoadError(undefined);
      }
      setParams(previous => ({
        ...previous,
        instructionProfile: pendingProfile.current
          ? JSON.stringify(pendingProfile.current)
          : previous.instructionProfile,
        functionKeyPresent: configuredKeyPresent(previous.functionKeyPresent, keyEditRef.current),
        functionHeadersPresent:
          headersEditRef.current.mode === 'replace'
            ? true
            : headersEditRef.current.mode === 'clear'
              ? false
              : previous.functionHeadersPresent,
      }));
      setKeyEdit({ mode: 'keep' });
      setHeadersEdit({ mode: 'keep' });
      void sdk.app
        .getParameters()
        .then(saved => {
          savedSecret.current = (saved as Params | null)?.functionApiKey;
          savedHeaders.current = (saved as Params | null)?.functionExtraHeaders;
          setSavedFunction(savedFunctionOf(saved as Params | null));
        })
        .catch(() => {
          savedSecret.current = undefined;
          savedHeaders.current = undefined;
        });
    });
    async function load() {
      try {
        const current = await sdk.app.getCurrentState();
        const ids = { spaceId: sdk.ids.space, environmentId: sdk.ids.environment };
        // One request returns every content type's editor interface.
        const editors = new Map(
          (await sdk.cma.editorInterface.getMany(ids)).items.map(item => [item.sys.contentType.sys.id, item]),
        );
        const choices: ContentTypeChoice[] = [];
        let skip = 0;
        for (;;) {
          const page = await sdk.cma.contentType.getMany({ ...ids, query: { limit: 100, skip } });
          for (const type of page.items) {
            const editor = editors.get(type.sys.id);
            const count = countTranslatableFields(
              type.fields,
              editor?.controls as EditorInterface['controls'],
              sdk.ids.app,
            );
            if (count)
              choices.push({
                id: type.sys.id,
                name: type.name,
                translatableFields: count,
                sidebarPosition: editor?.sidebar?.length ?? 0,
              });
          }
          skip += page.items.length;
          if (!page.items.length || skip >= page.total) break;
        }
        if (cancelled) return;
        choices.sort((a, b) => a.name.localeCompare(b.name));
        const next = { choices, current };
        loadedRef.current = next;
        setLoaded(next);
        const assigned = new Set(
          choices.filter(choice => current?.EditorInterface[choice.id]?.sidebar).map(choice => choice.id),
        );
        selectedRef.current = assigned;
        setSelected(assigned);
      } catch (error) {
        if (!cancelled)
          setLoadError(
            `Content types could not be loaded. ${error instanceof Error ? error.message : 'Try reopening app configuration.'}`,
          );
      } finally {
        // Contentful shows its loading state until the page is ready, even
        // when content types failed to load and the page shows why.
        if (!cancelled) await sdk.app.setReady();
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [sdk]);

  function update(next: Params) {
    setParams(next);
    paramsRef.current = next;
    setHealth(undefined);
    setConnection(undefined);
  }

  // Changes that do not affect the connection, such as choices, models and
  // instructions, keep the connection result and the health they rely on.
  function updateKeepingConnection(next: Partial<Params>) {
    setParams(previous => {
      const merged = { ...previous, ...next };
      paramsRef.current = merged;
      return merged;
    });
  }

  function setFunctionModels(models: string[]) {
    const current = functionModelChoices(params);
    let defaultModel = params.functionDefaultModel ?? '';
    // An empty list has no default. A first model in a new setup becomes the
    // default; an existing default is never replaced.
    if (!models.length) defaultModel = '';
    else if (!defaultModel && !current.length && models.length === 1) defaultModel = models[0];
    // Kept models keep their request settings.
    const choices = models.map(model => current.find(choice => choice.model === model) ?? { model });
    updateKeepingConnection({ functionModels: serializeModelChoices(choices), functionDefaultModel: defaultModel });
  }

  function setFunctionModelSettings(model: string, translationSettings: TranslationSettings | undefined) {
    const choices = functionModelChoices(paramsRef.current).map(choice =>
      choice.model === model ? (translationSettings ? { model, translationSettings } : { model }) : choice,
    );
    updateKeepingConnection({ functionModels: serializeModelChoices(choices) });
  }

  async function testRelayModel(alias: string, model: string): Promise<string> {
    // The backend receives the profile with the request, so the draft is tested.
    let profile: InstructionProfile;
    try {
      profile = validateInstructionProfile(profileDraftRef.current);
    } catch {
      profile = defaultInstructionProfile();
    }
    const result = await signedTranslate(
      sdk,
      params.backendUrl ?? '',
      alias,
      modelTestRequest(model, crypto.randomUUID(), profile),
    );
    return modelTestText(result);
  }

  async function testFunctionModel(model: string): Promise<string> {
    // The Function trusts only its saved profile.
    const profile = savedProfile.current;
    if (!profile) throw new Error('Reset and save the instruction profile before testing a model.');
    const result = await functionTranslate(sdk, modelTestRequest(model, crypto.randomUUID(), profile));
    return modelTestText(result);
  }

  function editKey(next: KeyEdit) {
    keyEditRef.current = next;
    setKeyEdit(next);
    setConnection(undefined);
  }

  function editHeaders(next: SecretEdit) {
    headersEditRef.current = next;
    setHeadersEdit(next);
    setConnection(undefined);
  }

  async function testConnection() {
    if (testing || errors.backendUrl) return;
    const testedTransport = params.transport;
    const testedUrl = params.backendUrl;
    setTesting(true);
    setHealth(undefined);
    setConnection(undefined);
    try {
      if (params.transport === 'function') {
        const settingsError = functionConnectionError(params);
        if (settingsError) {
          setConnection({ variant: 'warning', text: settingsError });
          return;
        }
        if (!functionSaved) {
          setConnection({
            variant: 'warning',
            text: 'Save the changed Function settings, then test the saved configuration.',
          });
          return;
        }
        const result = await functionHealth(sdk);
        if (paramsRef.current.transport !== testedTransport) return;
        if (
          result.providerHost !== functionProviderHost(params) ||
          JSON.stringify(result.models) !== JSON.stringify(savedFunction.models)
        )
          throw new Error('The Function is using different saved settings. Save and reopen app configuration.');
        setConnection(
          result.models.length
            ? {
                variant: 'positive',
                text: 'The Function ran in this environment. Provider network access was not tested.',
              }
            : {
                variant: 'warning',
                text: 'The Function ran in this environment. Load or add models, choose a default model, and save before editors can translate.',
              },
        );
      } else {
        const result = await signedHealth(sdk, params.backendUrl ?? '');
        if (paramsRef.current.transport !== testedTransport || paramsRef.current.backendUrl !== testedUrl) return;
        setHealth(result.providerConfigured ? result : undefined);
        setConnection(backendHealthMessage(result));
        // A new setup takes a sole fixed-model provider. Saved choices and a
        // saved default are never switched; problems are shown for repair.
        const only = result.providers.length === 1 ? result.providers[0] : undefined;
        if (
          result.providerConfigured &&
          only?.modelSelection !== 'installation' &&
          only &&
          !paramsRef.current.relayProviderChoices &&
          !savedDefault(paramsRef.current)
        )
          updateKeepingConnection({
            relayProviderChoices: serializeRelayChoices([{ alias: only.alias }]),
            relayProvider: only.alias,
            relayModel: '',
          });
      }
    } catch (error) {
      if (
        paramsRef.current.transport === testedTransport &&
        (testedTransport === 'function' || paramsRef.current.backendUrl === testedUrl)
      ) {
        setConnection(connectionErrorMessage(error, testedTransport === 'function' ? 'function' : 'custom'));
      }
    } finally {
      setTesting(false);
    }
  }

  function toggleContentType(id: string, checked: boolean) {
    touchedRef.current.add(id);
    setSelected(previous => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <main className="config">
      <header className="config-intro">
        <DisplayText as="h1" marginBottom="spacingXs">
          AI Translator settings
        </DisplayText>
        <p>Connect a translation service, then choose where editors can translate.</p>
      </header>

      <section className="config-section" aria-labelledby="service-heading">
        <Subheading as="h2" id="service-heading" marginBottom="none">
          Translation service
        </Subheading>
        <div role="radiogroup" aria-labelledby="service-heading" className="service-options">
          <Radio
            className={`service-card ${params.transport !== 'function' ? 'selected' : ''}`}
            name="transport"
            value="custom"
            isChecked={params.transport !== 'function'}
            onChange={() => update({ ...params, transport: 'custom' })}
          >
            <span>
              <strong>Custom backend</strong>
              <small>
                Connect an HTTPS service you host that follows the backend contract. Configure the provider API key as a
                secret on that service.
              </small>
            </span>
          </Radio>
          <Radio
            className={`service-card ${params.transport === 'function' ? 'selected' : ''}`}
            name="transport"
            value="function"
            isChecked={params.transport === 'function'}
            onChange={() => update({ ...params, transport: 'function' })}
          >
            <span>
              <span className="service-name">
                <strong>Contentful Function</strong>
              </span>
              <small>
                Runs inside Contentful on Premium and Enterprise plans. The provider key is stored as a secret.
              </small>
            </span>
          </Radio>
        </div>

        {params.transport === 'function' ? (
          <>
            <FormControl isInvalid={Boolean(errors.functionProviderUrl)}>
              <FormControl.Label htmlFor="function-provider-url">Provider URL</FormControl.Label>
              <TextInput
                id="function-provider-url"
                type="url"
                value={params.functionProviderUrl ?? ''}
                onChange={event => update({ ...params, functionProviderUrl: event.target.value })}
                placeholder={FUNCTION_PROVIDER_EXAMPLE}
              />
              <FormControl.HelpText>
                Use your OpenAI-compatible HTTPS base URL. The uploaded Function bundle must allow its host; the
                Function appends /chat/completions.
              </FormControl.HelpText>
              {errors.functionProviderUrl && (
                <FormControl.ValidationMessage>{errors.functionProviderUrl}</FormControl.ValidationMessage>
              )}
            </FormControl>
            <FormControl>
              <FormControl.Label htmlFor="function-api-key">Provider API key</FormControl.Label>
              {keyEdit.mode === 'keep' && params.functionKeyPresent ? (
                <div className="secret-row">
                  <TextInput id="function-api-key" value="Saved as a secret" isReadOnly />
                  <Button onClick={() => editKey({ mode: 'replace', value: '' })}>Replace</Button>
                  <Button variant="transparent" onClick={() => editKey({ mode: 'clear' })}>
                    Clear
                  </Button>
                </div>
              ) : keyEdit.mode === 'clear' ? (
                <div className="secret-row">
                  <TextInput id="function-api-key" value="Will be cleared when you save" isReadOnly />
                  <Button onClick={() => editKey({ mode: 'keep' })}>Undo clear</Button>
                </div>
              ) : (
                <div className="secret-row">
                  <TextInput
                    id="function-api-key"
                    type="password"
                    autoComplete="new-password"
                    value={keyEdit.mode === 'replace' ? keyEdit.value : ''}
                    onChange={event => editKey({ mode: 'replace', value: event.target.value })}
                    placeholder="Enter a provider API key"
                  />
                  {keyEdit.mode === 'replace' && params.functionKeyPresent && (
                    <Button onClick={() => editKey({ mode: 'keep' })}>Cancel</Button>
                  )}
                </div>
              )}
              <FormControl.HelpText>
                The API key for the OpenAI-compatible provider at the Provider URL. It is stored as a Contentful Secret.
                Test connection checks saved configuration and Function access; it cannot verify that the provider
                accepts the key. A translation will make a provider call.
              </FormControl.HelpText>
            </FormControl>
            <ProviderAdvancedSettings
              params={params}
              onChange={update}
              headersEdit={headersEdit}
              onHeadersEdit={editHeaders}
            />
            <Button
              onClick={() => void testConnection()}
              isLoading={testing}
              isDisabled={Boolean(errors.functionProviderUrl)}
            >
              {connection ? 'Test again' : 'Test connection'}
            </Button>
            {connection && (
              <Note variant={connection.variant} role={connection.variant === 'negative' ? 'alert' : 'status'}>
                {connection.text}
              </Note>
            )}
            <fieldset className="relay-choices">
              <legend>Models editors may use</legend>
              <p className="muted">
                Save the provider settings first, then load the provider’s models or add IDs, choose a default, and save
                again. The Function accepts only saved models.
              </p>
              <ModelPicker
                id="function-models"
                selected={functionSelection}
                onChange={setFunctionModels}
                discover={functionSaved ? () => functionModels(sdk) : undefined}
                discoverHint="Save the provider URL and credential, then load the provider’s models here."
                discoveryKey={savedFunction.connection}
                test={testFunctionModel}
                testHint={model =>
                  !functionSaved
                    ? 'Save the provider settings before testing a model.'
                    : savedFunction.models.includes(model)
                      ? undefined
                      : 'Save this model first. Only saved models can be tested.'
                }
              />
              <FormControl className="model-control" isInvalid={Boolean(functionModelError)} marginBottom="none">
                <FormControl.Label htmlFor="function-default-model">Default model</FormControl.Label>
                <Select
                  id="function-default-model"
                  value={
                    functionSelection.includes(params.functionDefaultModel ?? '') ? params.functionDefaultModel : ''
                  }
                  onChange={event => updateKeepingConnection({ functionDefaultModel: event.target.value })}
                  isDisabled={!functionSelection.length}
                >
                  <Select.Option value="">
                    {functionSelection.length ? 'Choose a default model' : 'Enable a model first'}
                  </Select.Option>
                  {functionSelection.map(model => (
                    <Select.Option key={model} value={model}>
                      {model}
                    </Select.Option>
                  ))}
                </Select>
                <FormControl.HelpText>
                  Editors start with the default and can pick another enabled model for one translation under Advanced
                  settings.
                </FormControl.HelpText>
                {functionModelError && (
                  <FormControl.ValidationMessage>{functionModelError}</FormControl.ValidationMessage>
                )}
              </FormControl>
              {functionSelection.length > 0 && (
                <Accordion className="provider-advanced">
                  <Accordion.Item titleElement="h3" title="Request size per model">
                    <div className="provider-advanced-content">
                      <p className="muted">
                        Fields are grouped into requests of about this many source characters, by default{' '}
                        {SOURCE_CHARACTER_PRESETS.function.toLocaleString('en-US')}, and larger Long text, Rich Text and
                        lists are split. Contentful stops a Function after 30 seconds, so lower it if a model’s requests
                        time out.
                      </p>
                      {functionModelChoices(params).map(choice => (
                        <TranslationSettingsEditor
                          key={choice.model}
                          id={`function-settings-${choice.model}`}
                          label={choice.model}
                          settings={choice.translationSettings}
                          presetCharacters={SOURCE_CHARACTER_PRESETS.function}
                          onChange={next => setFunctionModelSettings(choice.model, next)}
                          onError={message => settingsError(`function:${choice.model}`, message)}
                        />
                      ))}
                    </div>
                  </Accordion.Item>
                </Accordion>
              )}
            </fieldset>
          </>
        ) : (
          <>
            <FormControl isInvalid={Boolean(errors.backendUrl)}>
              <FormControl.Label htmlFor="backend-url">Backend URL</FormControl.Label>
              <div className="backend-connection-row">
                <TextInput
                  id="backend-url"
                  type="url"
                  value={params.backendUrl}
                  onChange={event =>
                    update({
                      ...params,
                      backendUrl: event.target.value,
                      relayProvider: '',
                      relayModel: '',
                      relayProviderChoices: '',
                    })
                  }
                  placeholder="https://translator.example.com"
                />
                <Button
                  onClick={() => void testConnection()}
                  isDisabled={!params.backendUrl?.trim() || Boolean(errors.backendUrl)}
                  isLoading={testing}
                >
                  {connection ? 'Test again' : 'Test connection'}
                </Button>
              </div>
              <FormControl.HelpText>
                Include the path when the backend is served beneath one, for example
                https://functions.example.com/api/ai-translator.
              </FormControl.HelpText>
              {errors.backendUrl && <FormControl.ValidationMessage>{errors.backendUrl}</FormControl.ValidationMessage>}
            </FormControl>
            {connection && (
              <Note variant={connection.variant} role={connection.variant === 'negative' ? 'alert' : 'status'}>
                {connection.text}
              </Note>
            )}
            {health ? (
              <RelayChoices
                health={health}
                params={params}
                onChange={updateKeepingConnection}
                discover={alias =>
                  signedModels(sdk, params.backendUrl ?? '', alias).catch(error => {
                    throw new Error(discoveryError(error));
                  })
                }
                test={testRelayModel}
                onSettingsError={settingsError}
              />
            ) : (
              params.backendUrl?.trim() && <p className="muted">{untestedChoices(params)}</p>
            )}
          </>
        )}
      </section>

      {profileLoadError && (
        <Note variant="negative" role="alert">
          <span className="relay-choice-problem">
            The saved instruction profile is invalid, so translation is blocked. Reset it to the defaults, review it,
            and save.
            <Button
              size="small"
              onClick={() => {
                const profile = { ...defaultInstructionProfile(), revision: newProfileRevision() };
                profileTouched.current = true;
                setProfileDraft(profile);
                updateKeepingConnection({ instructionProfile: JSON.stringify(profile) });
              }}
            >
              Reset to defaults
            </Button>
          </span>
        </Note>
      )}
      <InstructionSettings
        profile={profileDraft}
        active={Boolean(params.instructionProfile)}
        model={
          params.transport === 'function'
            ? (params.functionDefaultModel ?? '')
            : params.relayModel ||
              (health?.providers.find(choice => choice.alias === params.relayProvider)?.model ?? '')
        }
        provider={params.transport === 'function' ? 'Contentful Function' : 'Custom backend'}
        sampling={
          params.transport === 'function'
            ? params.functionTemperature === undefined
              ? 'provider default'
              : `temperature ${params.functionTemperature}`
            : 'configured in the backend'
        }
        onChange={profile => {
          profileTouched.current = true;
          setProfileDraft(profile);
          updateKeepingConnection({ instructionProfile: JSON.stringify(profile) });
        }}
      />

      <section className="config-section" aria-labelledby="types-heading">
        <div className="section-heading">
          <Subheading as="h2" id="types-heading" marginBottom="none">
            Content types
          </Subheading>
          <Button
            variant="transparent"
            size="small"
            onClick={() => {
              const ids = loaded?.choices.map(choice => choice.id) ?? [];
              for (const id of ids) touchedRef.current.add(id);
              setSelected(new Set(ids));
            }}
            isDisabled={!loaded?.choices.length}
          >
            Select all
          </Button>
        </div>
        <p>
          Choose the content types whose entries show AI Translator in the sidebar. To translate a single field from
          where you edit it, choose AI Translator under that field’s Appearance settings in the content model.
        </p>
        {loadError && (
          <Note variant="negative" role="alert">
            {loadError}
          </Note>
        )}
        {!loaded && !loadError && <p role="status">Loading content types…</p>}
        {loaded?.choices.length === 0 && <p>No content types have translatable fields yet.</p>}
        <div className="content-type-list">
          {loaded?.choices.map(choice => (
            <Checkbox
              key={choice.id}
              isChecked={selected.has(choice.id)}
              onChange={event => toggleContentType(choice.id, event.target.checked)}
            >
              {choice.name}{' '}
              <span className="muted">
                · {choice.translatableFields} translatable {choice.translatableFields === 1 ? 'field' : 'fields'}
              </span>
            </Checkbox>
          ))}
        </div>
      </section>

      <section className="config-section" aria-labelledby="options-heading">
        <Subheading as="h2" id="options-heading" marginBottom="none">
          Editor options
        </Subheading>
        <div className="editor-option">
          <Switch
            isChecked={Boolean(params.debugMode)}
            onChange={event => updateKeepingConnection({ debugMode: event.target.checked })}
            inputProps={{ 'aria-describedby': 'debug-mode-help' }}
          >
            Debug mode
          </Switch>
          <p id="debug-mode-help">
            Shows editors the model destination and messages in a “What gets sent” section of the translate dialog.
            Credentials are never included.
          </p>
        </div>
      </section>
      <p className="config-footer">
        This page stores service settings, instruction templates and editor options for this environment.{' '}
        {params.transport === 'function'
          ? 'Contentful stores the provider API key as a Secret; save before testing changes.'
          : 'Configure the provider API key as a secret on your backend.'}
      </p>
    </main>
  );
}
