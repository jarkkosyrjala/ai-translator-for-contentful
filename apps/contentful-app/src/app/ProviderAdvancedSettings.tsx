import { Accordion, Button, FormControl, Select, Textarea, TextInput } from '@contentful/f36-components';
import { FUNCTION_MAX_TIMEOUT_SECONDS, type FunctionAdvancedParams, type SecretEdit } from './function-config';
import type { Params } from './transport-config';

type Settings = Params & FunctionAdvancedParams;

export function ProviderAdvancedSettings({
  params,
  onChange,
  headersEdit,
  onHeadersEdit,
}: {
  params: Settings;
  onChange: (next: Settings) => void;
  headersEdit: SecretEdit;
  onHeadersEdit: (next: SecretEdit) => void;
}) {
  return (
    <Accordion className="provider-advanced">
      <Accordion.Item titleElement="h3" title="Advanced provider settings">
        <div className="provider-advanced-content">
          <p>Set only the options your provider and model support. Blank numeric options use the provider default.</p>
          <FormControl>
            <FormControl.Label htmlFor="function-auth-mode">Authentication</FormControl.Label>
            <Select
              id="function-auth-mode"
              value={params.functionAuthMode ?? 'bearer'}
              onChange={event =>
                onChange({ ...params, functionAuthMode: event.target.value as Settings['functionAuthMode'] })
              }
            >
              <Select.Option value="bearer">Bearer token</Select.Option>
              <Select.Option value="header">Custom header</Select.Option>
              <Select.Option value="none">No authentication</Select.Option>
            </Select>
          </FormControl>
          {params.functionAuthMode === 'header' && (
            <FormControl>
              <FormControl.Label htmlFor="function-auth-header">Authentication header name</FormControl.Label>
              <TextInput
                id="function-auth-header"
                value={params.functionAuthHeader ?? ''}
                onChange={event => onChange({ ...params, functionAuthHeader: event.target.value })}
                placeholder="X-API-Key"
              />
              <FormControl.HelpText>
                The provider API key above becomes this header's value. Use Authorization if your provider expects a
                custom scheme.
              </FormControl.HelpText>
            </FormControl>
          )}
          <div className="provider-options-grid">
            <FormControl>
              <FormControl.Label htmlFor="function-temperature">Temperature</FormControl.Label>
              <TextInput
                id="function-temperature"
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={params.functionTemperature === undefined ? '' : String(params.functionTemperature)}
                onChange={event =>
                  onChange({
                    ...params,
                    functionTemperature: event.target.value === '' ? undefined : Number(event.target.value),
                  })
                }
                placeholder="Provider default"
              />
            </FormControl>
            <FormControl>
              <FormControl.Label htmlFor="function-top-p">Top-p</FormControl.Label>
              <TextInput
                id="function-top-p"
                type="number"
                min="0"
                max="1"
                step="0.1"
                value={params.functionTopP === undefined ? '' : String(params.functionTopP)}
                onChange={event =>
                  onChange({
                    ...params,
                    functionTopP: event.target.value === '' ? undefined : Number(event.target.value),
                  })
                }
                placeholder="Provider default"
              />
            </FormControl>
            <FormControl>
              <FormControl.Label htmlFor="function-max-tokens">Output-token limit</FormControl.Label>
              <TextInput
                id="function-max-tokens"
                type="number"
                min="1"
                max="65536"
                step="1"
                value={
                  params.functionMaxCompletionTokens === undefined ? '' : String(params.functionMaxCompletionTokens)
                }
                onChange={event =>
                  onChange({
                    ...params,
                    functionMaxCompletionTokens: event.target.value === '' ? undefined : Number(event.target.value),
                  })
                }
                placeholder="Provider default"
              />
            </FormControl>
            <FormControl>
              <FormControl.Label htmlFor="function-token-field">Output-token property</FormControl.Label>
              <Select
                id="function-token-field"
                value={params.functionOutputTokenField ?? 'max_completion_tokens'}
                onChange={event =>
                  onChange({
                    ...params,
                    functionOutputTokenField: event.target.value as Settings['functionOutputTokenField'],
                  })
                }
              >
                <Select.Option value="max_completion_tokens">max_completion_tokens</Select.Option>
                <Select.Option value="max_tokens">max_tokens</Select.Option>
              </Select>
            </FormControl>
          </div>
          <FormControl>
            <FormControl.Label htmlFor="function-reasoning-effort">Reasoning effort</FormControl.Label>
            <TextInput
              id="function-reasoning-effort"
              value={params.functionReasoningEffort ?? ''}
              onChange={event => onChange({ ...params, functionReasoningEffort: event.target.value })}
              placeholder="Provider default"
            />
            <FormControl.HelpText>Use a value supported by your provider and model.</FormControl.HelpText>
          </FormControl>
          <FormControl>
            <FormControl.Label htmlFor="function-extra-body">Additional Chat Completions properties</FormControl.Label>
            <Textarea
              id="function-extra-body"
              value={params.functionExtraBody ?? ''}
              onChange={event => onChange({ ...params, functionExtraBody: event.target.value })}
              rows={3}
              placeholder={'{"seed": 1}'}
            />
            <FormControl.HelpText>
              JSON object, at most 4,096 characters. Model, messages, streaming, tool calls, response format and output
              limits cannot be overridden here.
            </FormControl.HelpText>
          </FormControl>
          <FormControl>
            <FormControl.Label htmlFor="function-extra-headers">Additional request headers</FormControl.Label>
            {headersEdit.mode === 'keep' && params.functionHeadersPresent ? (
              <div className="secret-row">
                <TextInput id="function-extra-headers" value="Saved as a secret" isReadOnly />
                <Button onClick={() => onHeadersEdit({ mode: 'replace', value: '' })}>Replace</Button>
                <Button variant="transparent" onClick={() => onHeadersEdit({ mode: 'clear' })}>
                  Clear
                </Button>
              </div>
            ) : headersEdit.mode === 'clear' ? (
              <div className="secret-row">
                <TextInput id="function-extra-headers" value="Will be cleared when you save" isReadOnly />
                <Button onClick={() => onHeadersEdit({ mode: 'keep' })}>Undo clear</Button>
              </div>
            ) : (
              <div className="secret-row">
                <Textarea
                  id="function-extra-headers"
                  value={headersEdit.mode === 'replace' ? headersEdit.value : ''}
                  onChange={event => onHeadersEdit({ mode: 'replace', value: event.target.value })}
                  rows={3}
                  placeholder={'{"X-Provider-Version": "2026-01-01"}'}
                />
                {headersEdit.mode === 'replace' && params.functionHeadersPresent && (
                  <Button onClick={() => onHeadersEdit({ mode: 'keep' })}>Cancel</Button>
                )}
              </div>
            )}
            <FormControl.HelpText>
              JSON object of header names and values, saved as a Contentful Secret. Use the authentication setting above
              for the main credential.
            </FormControl.HelpText>
          </FormControl>
          <div className="provider-options-grid">
            <FormControl>
              <FormControl.Label htmlFor="function-timeout">Provider timeout (seconds)</FormControl.Label>
              <TextInput
                id="function-timeout"
                type="number"
                min="1"
                max={String(FUNCTION_MAX_TIMEOUT_SECONDS)}
                step="1"
                value={params.functionTimeoutSeconds === undefined ? '' : String(params.functionTimeoutSeconds)}
                onChange={event =>
                  onChange({
                    ...params,
                    functionTimeoutSeconds: event.target.value === '' ? undefined : Number(event.target.value),
                  })
                }
                placeholder={String(FUNCTION_MAX_TIMEOUT_SECONDS)}
              />
              <FormControl.HelpText>
                Contentful gives a Function 30 seconds, so a request may use at most {FUNCTION_MAX_TIMEOUT_SECONDS}.
              </FormControl.HelpText>
            </FormControl>
            <FormControl>
              <FormControl.Label htmlFor="function-idle-timeout">Idle timeout (seconds)</FormControl.Label>
              <TextInput
                id="function-idle-timeout"
                type="number"
                min="1"
                max={String(FUNCTION_MAX_TIMEOUT_SECONDS)}
                step="1"
                value={params.functionIdleTimeoutSeconds === undefined ? '' : String(params.functionIdleTimeoutSeconds)}
                onChange={event =>
                  onChange({
                    ...params,
                    functionIdleTimeoutSeconds: event.target.value === '' ? undefined : Number(event.target.value),
                  })
                }
                placeholder="Same as the timeout"
              />
              <FormControl.HelpText>The longest wait for the provider’s next streamed text.</FormControl.HelpText>
            </FormControl>
          </div>
        </div>
      </Accordion.Item>
    </Accordion>
  );
}
