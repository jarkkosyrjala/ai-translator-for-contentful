import { MODEL_LIST_LIMIT, validModelId } from '@ai-translator-for-contentful/protocol';
import { Badge, Button, Checkbox, FormControl, Note, Select, TextInput } from '@contentful/f36-components';
import { useEffect, useRef, useState } from 'react';

type Props = {
  id: string;
  // Enabled model IDs, in the order editors see them.
  selected: string[];
  onChange: (next: string[]) => void;
  // Loads the provider's model IDs through the backend. Without it, Load
  // models is unavailable for the reason in `discoverHint`.
  discover?: () => Promise<string[]>;
  discoverHint?: string;
  // Identifies the backend, alias, and provider settings. A response that
  // arrives after it changed is ignored.
  discoveryKey: string;
  // Sends one synthetic translation to the model. Only explicit Test model calls it.
  test?: (model: string) => Promise<string>;
  testHint?: (model: string) => string | undefined;
};

type Discovery = { key: string; models: string[] } | { key: string; error: string };
type TestResult = { model: string; variant: 'positive' | 'negative'; text: string };

/**
 * The admin's model choice for one provider: Load models from the provider's
 * list, check models, or add an ID by hand. Discovery never enables a model,
 * and refresh, filtering, failures, and empty responses keep every selection.
 */
export function ModelPicker(props: Props) {
  const [discovery, setDiscovery] = useState<Discovery>();
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [manual, setManual] = useState('');
  const [manualError, setManualError] = useState('');
  const [testModel, setTestModel] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult>();
  const keyRef = useRef(props.discoveryKey);
  keyRef.current = props.discoveryKey;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed backend or provider starts over.
  useEffect(() => {
    setLoading(false);
    setTestResult(undefined);
  }, [props.discoveryKey]);

  const current = discovery?.key === props.discoveryKey ? discovery : undefined;
  const discovered = current && 'models' in current ? current.models : undefined;
  const rows = [...new Set([...(discovered ?? []), ...props.selected])].sort();
  const needle = filter.trim().toLowerCase();
  const visible = needle ? rows.filter(model => model.toLowerCase().includes(needle)) : rows;
  const chosenTest = props.selected.includes(testModel) ? testModel : (props.selected[0] ?? '');
  const testBlocked = props.test ? props.testHint?.(chosenTest) : 'Test model is not available here.';

  async function load() {
    if (!props.discover || loading) return;
    const key = props.discoveryKey;
    setLoading(true);
    try {
      const models = await props.discover();
      if (keyRef.current === key) setDiscovery({ key, models });
    } catch (error) {
      if (keyRef.current === key)
        setDiscovery({
          key,
          error: error instanceof Error ? error.message : 'The model list could not be loaded.',
        });
    } finally {
      if (keyRef.current === key) setLoading(false);
    }
  }

  function toggle(model: string, checked: boolean) {
    props.onChange(checked ? [...props.selected, model] : props.selected.filter(item => item !== model));
  }

  function add() {
    const model = manual.trim();
    if (!validModelId(model)) {
      setManualError(
        model === 'mock'
          ? 'mock is reserved for automated checks.'
          : 'Use up to 100 letters, numbers, dots, underscores, colons, slashes or hyphens, starting with a letter or number.',
      );
      return;
    }
    if (props.selected.includes(model)) {
      setManualError('This model is already enabled.');
      return;
    }
    if (props.selected.length >= MODEL_LIST_LIMIT) {
      setManualError(`Enable at most ${MODEL_LIST_LIMIT} models.`);
      return;
    }
    props.onChange([...props.selected, model]);
    setManual('');
    setManualError('');
  }

  async function runTest() {
    if (!props.test || testing || testBlocked || !chosenTest) return;
    const key = props.discoveryKey;
    setTesting(true);
    setTestResult(undefined);
    try {
      const suggestion = await props.test(chosenTest);
      if (keyRef.current === key)
        setTestResult({ model: chosenTest, variant: 'positive', text: `${chosenTest} answered: “${suggestion}”` });
    } catch (error) {
      if (keyRef.current === key)
        setTestResult({
          model: chosenTest,
          variant: 'negative',
          text: `${chosenTest} did not answer. ${error instanceof Error ? error.message : ''}`.trim(),
        });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="model-picker">
      <div className="model-picker-actions">
        <Button size="small" onClick={() => void load()} isLoading={loading} isDisabled={!props.discover}>
          {discovered ? 'Refresh models' : 'Load models'}
        </Button>
        <span className="muted">
          {props.discover
            ? `${props.selected.length} enabled. Loading lists IDs from the provider; it calls no model.`
            : props.discoverHint}
        </span>
      </div>
      {current && 'error' in current && (
        <Note variant="warning" role="alert">
          {current.error} You can still add model IDs below.
        </Note>
      )}
      {discovered?.length === 0 && <Note variant="neutral">The provider listed no models. Add model IDs below.</Note>}
      {rows.length > 0 && (
        <>
          <FormControl marginBottom="none">
            <FormControl.Label htmlFor={`${props.id}-filter`}>Filter models</FormControl.Label>
            <TextInput
              id={`${props.id}-filter`}
              size="small"
              value={filter}
              onChange={event => setFilter(event.target.value)}
              placeholder="Type part of a model ID"
            />
          </FormControl>
          <Checkbox.Group
            name={`${props.id}-models`}
            value={props.selected}
            onChange={event => toggle(event.target.value, event.target.checked)}
            className="model-list"
          >
            {visible.map(model => (
              <Checkbox key={model} value={model} id={`${props.id}-model-${model}`}>
                <span className="model-id">{model}</span>
                {discovered && props.selected.includes(model) && !discovered.includes(model) && (
                  <Badge variant="warning" size="small">
                    Not returned by model discovery
                  </Badge>
                )}
              </Checkbox>
            ))}
          </Checkbox.Group>
          {visible.length === 0 && <p className="muted">No model ID matches the filter.</p>}
        </>
      )}
      <FormControl marginBottom="none" isInvalid={Boolean(manualError)}>
        <FormControl.Label htmlFor={`${props.id}-manual`}>Add model ID</FormControl.Label>
        <div className="secret-row">
          <TextInput
            id={`${props.id}-manual`}
            size="small"
            value={manual}
            onChange={event => {
              setManual(event.target.value);
              setManualError('');
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
            placeholder="provider-model-id"
          />
          <Button size="small" onClick={add} isDisabled={!manual.trim()}>
            Add
          </Button>
        </div>
        <FormControl.HelpText>
          For models the provider does not list. The ID is not checked with the provider.
        </FormControl.HelpText>
        {manualError && <FormControl.ValidationMessage>{manualError}</FormControl.ValidationMessage>}
      </FormControl>
      {props.test && props.selected.length > 0 && (
        <FormControl marginBottom="none">
          <FormControl.Label htmlFor={`${props.id}-test`}>Test model</FormControl.Label>
          <div className="secret-row">
            <Select
              id={`${props.id}-test`}
              size="small"
              value={chosenTest}
              onChange={event => {
                setTestModel(event.target.value);
                setTestResult(undefined);
              }}
            >
              {props.selected.map(model => (
                <Select.Option key={model} value={model}>
                  {model}
                </Select.Option>
              ))}
            </Select>
            <Button size="small" onClick={() => void runTest()} isLoading={testing} isDisabled={Boolean(testBlocked)}>
              Test model
            </Button>
          </div>
          <FormControl.HelpText>
            {testBlocked ??
              'Sends one short synthetic translation. This is a paid model call; no entry content is sent.'}
          </FormControl.HelpText>
        </FormControl>
      )}
      {testResult && testResult.model === chosenTest && (
        <Note variant={testResult.variant} role={testResult.variant === 'negative' ? 'alert' : 'status'}>
          {testResult.text}
        </Note>
      )}
    </div>
  );
}
