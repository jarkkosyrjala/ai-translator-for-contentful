import type { InstructionProfile, ResolvedTranslationSettings } from '@ai-translator-for-contentful/protocol';
import type { ContentTypeField } from '@contentful/app-sdk';
import {
  Accordion,
  Autocomplete,
  Button,
  Card,
  Checkbox,
  FormControl,
  Note,
  Pill,
  Popover,
  Select,
  TextInput,
} from '@contentful/f36-components';
import { CaretDownIcon, PlusIcon } from '@contentful/f36-icons';
import { useState } from 'react';
import { type DialogChoice, dialogChoiceLabel } from '../choices';
import type { BoundedContext, ContextCandidate } from '../context';
import type { EditorSnapshot } from '../editor-snapshot';
import type { PlannedRequest } from '../planner';
import type { EntryHit } from '../saved-context';
import { TemplateEditor } from '../TemplateEditor';
import { canShowRequestDetails, fieldPreview, fieldTypeLabel, localeName } from './model';

type Props = {
  snapshot: EditorSnapshot;
  launchField?: ContentTypeField;
  localeNames: Record<string, string>;
  source: string;
  onSource: (value: string) => void;
  saveDefault: boolean;
  onSaveDefault: (value: boolean) => void;
  canSaveDefault: boolean;
  targets: string[];
  onTarget: (value: string) => void;
  saveTargetDefault: boolean;
  onSaveTargetDefault: (value: boolean) => void;
  canSaveTargetDefault: boolean;
  fields: string[];
  eligibleFields: ContentTypeField[];
  onField: (value: string) => void;
  onSelectAll: () => void;
  guidance: string;
  onGuidance: (value: string) => void;
  selectedContext: ContextCandidate[];
  contextCandidates: ContextCandidate[];
  onContext: (key: string) => void;
  contextKey: (item: ContextCandidate) => string;
  sentContext: BoundedContext[];
  contextError?: string;
  search: string;
  onSearch: (value: string) => void;
  hits: EntryHit[];
  onLoadEntry: (entryId: string) => void;
  contextStatus: string;
  planned: PlannedRequest[];
  planWarnings: string[];
  planError?: string;
  settings?: ResolvedTranslationSettings;
  debugMode?: unknown;
  destination: string;
  model: string;
  transport: 'custom' | 'function';
  // The choice this dialog uses and the installation's choices.
  choice?: DialogChoice;
  choices: DialogChoice[];
  onChoice: (key: string) => void;
  saveChoiceDefault: boolean;
  onSaveChoiceDefault: (value: boolean) => void;
  canSaveChoiceDefault: boolean;
  profile?: InstructionProfile;
  variableValues: Record<string, string>;
  onVariableValue: (key: string, value: string) => void;
};

function RequestMessages({ planned }: { planned: PlannedRequest }) {
  return (
    <>
      <p className="dialog-muted">
        {planned.sourceCharacters.toLocaleString('en-US')} source characters · {planned.bytes.toLocaleString('en-US')}{' '}
        bytes
        {planned.context.length
          ? ` · context: ${planned.context
              .map(item => `${item.name} (${item.role}${item.omittedUnits ? `, ${item.omittedUnits} omitted` : ''})`)
              .join(', ')}`
          : ''}
        {planned.omittedFields.length ? ` · context not sent: ${planned.omittedFields.join(', ')}` : ''}
      </p>
      {planned.messages.map((message, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed preview whose messages can repeat.
        <div key={index}>
          <strong>{message.role}</strong>
          <pre>{message.content}</pre>
        </div>
      ))}
    </>
  );
}

export function ChooseScreen(props: Props) {
  const { snapshot, localeNames, source } = props;
  const [entryFieldsOpen, setEntryFieldsOpen] = useState(false);
  const selectedKeys = new Set(props.selectedContext.map(props.contextKey));
  const fieldRow = (field: ContentTypeField, selectable: boolean) => {
    const value = snapshot.fields[field.id]?.[source];
    const type = fieldTypeLabel(field, value, snapshot.controls?.find(item => item.fieldId === field.id)?.widgetId);
    return (
      <div className={`dialog-field-row${selectable ? '' : ' dialog-field-row-fixed'}`} key={field.id}>
        {selectable && (
          <Checkbox
            name={`field-${field.id}`}
            isChecked={props.fields.includes(field.id)}
            onChange={() => props.onField(field.id)}
            aria-label={`Translate ${field.name}`}
          />
        )}
        <span className="dialog-field-name">
          {field.name}
          <span className="dialog-field-type"> · {type}</span>
        </span>
        <span className="dialog-field-preview" title={fieldPreview(value)}>
          {fieldPreview(value)}
        </span>
      </div>
    );
  };
  const contextLength = props.sentContext.reduce((sum, item) => sum + [...item.value].length, 0);
  const guidance = (
    <div className="dialog-guidance-content">
      <FormControl>
        <div className="dialog-label-line">
          <FormControl.Label htmlFor="run-guidance">Guidance for this run</FormControl.Label>
          <span className="dialog-muted">{props.guidance.length} / 1000</span>
        </div>
        <TemplateEditor
          id="run-guidance"
          placeholder="For example: This text appears on the checkout page. ‘Delivery’ refers to shipping a physical order."
          value={props.guidance}
          onChange={props.onGuidance}
          rows={3}
          maxLength={1000}
          variables={props.profile?.variables ?? []}
          excludeVariables={['perRunGuidance']}
        />
        <FormControl.HelpText>
          Type {'{'} to insert a variable, such as {'{targetLocale}'}
          {props.profile?.variables.length ? ` or {${props.profile.variables[0].key}}` : ''}. Double braces insert
          literal braces.
        </FormControl.HelpText>
        {(props.planError || props.planWarnings.length > 0) && (
          <div className="dialog-plan-notes">
            {props.planError && (
              <Note variant="warning" role="alert">
                {props.planError}
              </Note>
            )}
            {props.planWarnings.map(warning => (
              <Note variant="neutral" key={warning}>
                {warning}
              </Note>
            ))}
          </div>
        )}
      </FormControl>
      {props.profile?.variables.map(variable => {
        const value = props.variableValues[variable.key] ?? variable.defaultValue ?? '';
        return (
          <FormControl key={variable.key}>
            <FormControl.Label htmlFor={`run-variable-${variable.key}`}>
              {variable.name}
              {variable.required ? ' (required)' : ''}
            </FormControl.Label>
            {variable.type === 'text' ? (
              <TextInput
                id={`run-variable-${variable.key}`}
                value={value}
                onChange={event => props.onVariableValue(variable.key, event.target.value)}
                maxLength={1000}
              />
            ) : (
              <Select
                id={`run-variable-${variable.key}`}
                value={value}
                onChange={event => props.onVariableValue(variable.key, event.target.value)}
              >
                <Select.Option value="">{variable.required ? 'Select a value' : 'No value'}</Select.Option>
                {(variable.type === 'choice' ? (variable.choices ?? []) : snapshot.locales).map(option => (
                  <Select.Option value={option} key={option}>
                    {variable.type === 'locale' ? localeName(option, localeNames) : option}
                  </Select.Option>
                ))}
              </Select>
            )}
            {variable.description && <FormControl.HelpText>{variable.description}</FormControl.HelpText>}
          </FormControl>
        );
      })}
      <div>
        <div className="dialog-label-line">
          <strong>Context</strong>
          <span className="dialog-muted">
            {contextLength.toLocaleString('en-US')} of{' '}
            {(props.settings?.contextTotalCharacters ?? 0).toLocaleString('en-US')} characters
          </span>
        </div>
        <p className="dialog-muted">
          Add fields here to help the translator understand your content. These fields provide context; only the fields
          selected for translation are translated.
        </p>
        {props.selectedContext.length > 0 && (
          <ul className="dialog-pills" aria-label="Selected context">
            {props.selectedContext.map(item => {
              const label = `${item.fieldName} · ${localeName(item.locale, localeNames)}`;
              const sent = props.sentContext.find(
                value =>
                  value.entryId === item.entryId && value.fieldId === item.fieldId && value.locale === item.locale,
              );
              const dropped = !sent;
              return (
                <li key={props.contextKey(item)}>
                  <Pill
                    label={label}
                    onClose={() => props.onContext(props.contextKey(item))}
                    closeButtonAriaLabel={`Remove ${label}`}
                  />
                  {sent?.omittedUnits ? (
                    <small className="dialog-omission">
                      {sent.omittedUnits} whole section{sent.omittedUnits === 1 ? '' : 's'} omitted
                    </small>
                  ) : dropped ? (
                    <small className="dialog-omission">Not sent: over this model’s context field limit</small>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <div className="dialog-context-controls">
          <Popover isOpen={entryFieldsOpen} onClose={() => setEntryFieldsOpen(false)} placement="bottom-start">
            <Popover.Trigger>
              <Button
                startIcon={<PlusIcon />}
                endIcon={<CaretDownIcon />}
                onClick={() => setEntryFieldsOpen(open => !open)}
              >
                From this entry
              </Button>
            </Popover.Trigger>
            <Popover.Content className="dialog-context-popover">
              {props.contextCandidates
                .filter(item => item.provenance === 'current-editor')
                .map(item => (
                  <Checkbox
                    key={props.contextKey(item)}
                    name={`context-${props.contextKey(item)}`}
                    isChecked={selectedKeys.has(props.contextKey(item))}
                    onChange={() => props.onContext(props.contextKey(item))}
                  >
                    {item.fieldName} · {localeName(item.locale, localeNames)}
                  </Checkbox>
                ))}
            </Popover.Content>
          </Popover>
          <FormControl marginBottom="none">
            <FormControl.Label htmlFor="context-entry-search">Search other entries</FormControl.Label>
            <Autocomplete<EntryHit>
              id="context-entry-search"
              items={props.hits}
              inputValue={props.search}
              onInputValueChange={props.onSearch}
              onSelectItem={item => props.onLoadEntry(item.id)}
              itemToString={item => item.label}
              renderItem={item => item.label}
              placeholder="Type an entry title"
              noMatchesMessage="No entries found"
              textOnAfterSelect="clear"
              usePortal
            />
          </FormControl>
        </div>
        {props.contextCandidates.filter(
          item => item.provenance === 'saved-entry' && !selectedKeys.has(props.contextKey(item)),
        ).length > 0 && (
          <details className="dialog-saved-fields">
            <summary>Add a field from a loaded entry</summary>
            <div className="dialog-context-list">
              {props.contextCandidates
                .filter(item => item.provenance === 'saved-entry' && !selectedKeys.has(props.contextKey(item)))
                .map(item => (
                  <Checkbox
                    key={props.contextKey(item)}
                    name={`context-${props.contextKey(item)}`}
                    onChange={() => props.onContext(props.contextKey(item))}
                  >
                    {item.fieldName} · {localeName(item.locale, localeNames)}
                  </Checkbox>
                ))}
            </div>
          </details>
        )}
        {props.contextStatus && (
          <p className="dialog-context-status" role="status">
            {props.contextStatus}
          </p>
        )}
        {props.contextError && <Note variant="warning">{props.contextError}</Note>}
      </div>
    </div>
  );

  return (
    <div className="dialog-choose">
      <section className="dialog-scope" aria-label="What to translate">
        {props.launchField ? (
          <p className="dialog-fixed-source">
            <strong>Translate from</strong> {localeName(source, localeNames)}
          </p>
        ) : (
          <FormControl>
            <FormControl.Label htmlFor="source-locale">Translate from</FormControl.Label>
            <div className="dialog-source-line">
              <Select id="source-locale" value={source} onChange={event => props.onSource(event.target.value)}>
                {snapshot.locales.map(locale => (
                  <Select.Option key={locale} value={locale}>
                    {localeName(locale, localeNames)}
                  </Select.Option>
                ))}
              </Select>
              <Checkbox
                name="save-source"
                isChecked={props.saveDefault}
                isDisabled={!props.canSaveDefault}
                onChange={event => props.onSaveDefault(event.target.checked)}
              >
                Save as my default
              </Checkbox>
            </div>
          </FormControl>
        )}
        <fieldset className="dialog-targets">
          <legend>Translate into</legend>
          <div className="dialog-target-line">
            <div className="dialog-target-options">
              {snapshot.locales
                .filter(locale => locale !== source)
                .map(locale => (
                  <Checkbox
                    key={locale}
                    name={`target-${locale}`}
                    isChecked={props.targets.includes(locale)}
                    onChange={() => props.onTarget(locale)}
                  >
                    {localeName(locale, localeNames)}
                  </Checkbox>
                ))}
            </div>
            <Checkbox
              name="save-targets"
              isChecked={props.saveTargetDefault}
              isDisabled={!props.canSaveTargetDefault}
              onChange={event => props.onSaveTargetDefault(event.target.checked)}
            >
              Save as my default
            </Checkbox>
          </div>
        </fieldset>
        {props.launchField ? (
          <fieldset className="dialog-field-group" aria-labelledby="dialog-fields-title">
            <div className="dialog-fields-heading">
              <strong id="dialog-fields-title">Field</strong>
            </div>
            <div className="dialog-fields">{fieldRow(props.launchField, false)}</div>
          </fieldset>
        ) : (
          <fieldset className="dialog-field-group" aria-labelledby="dialog-fields-title">
            <div className="dialog-fields-heading">
              <strong id="dialog-fields-title">Fields</strong>
              <Button variant="transparent" size="small" onClick={props.onSelectAll}>
                Select all
              </Button>
            </div>
            <div className="dialog-fields">{props.eligibleFields.map(field => fieldRow(field, true))}</div>
          </fieldset>
        )}
        {props.choice && (
          <div className="dialog-provider">
            <p className="dialog-destination">
              Sends to{' '}
              {props.choice.alias === undefined ? (
                <strong>{props.choice.model}</strong>
              ) : (
                <>
                  <strong>{props.choice.alias}</strong>
                  <span className="dialog-muted"> · {props.choice.model}</span>
                </>
              )}
              <span className="dialog-muted"> · {props.choice.host}</span>
            </p>
            {props.choices.length > 1 && (
              <details className="dialog-advanced">
                <summary>
                  Advanced settings{' '}
                  <span className="dialog-muted">
                    ·{' '}
                    {props.choice.alias === undefined
                      ? props.choice.model
                      : `${props.choice.alias} · ${props.choice.model}`}
                  </span>
                </summary>
                <FormControl marginBottom="none">
                  <FormControl.Label htmlFor="dialog-choice">
                    {props.transport === 'function' ? 'Model' : 'Provider and model'}
                  </FormControl.Label>
                  <div className="dialog-source-line dialog-choice-line">
                    <Select
                      id="dialog-choice"
                      value={props.choice.key}
                      onChange={event => props.onChoice(event.target.value)}
                    >
                      {props.choices.map(choice => (
                        <Select.Option key={choice.key} value={choice.key}>
                          {dialogChoiceLabel(choice)}
                        </Select.Option>
                      ))}
                    </Select>
                    <Checkbox
                      name="save-choice"
                      isChecked={props.saveChoiceDefault}
                      isDisabled={!props.canSaveChoiceDefault}
                      onChange={event => props.onSaveChoiceDefault(event.target.checked)}
                    >
                      Save as my default
                    </Checkbox>
                  </div>
                  <FormControl.HelpText>
                    Applies until you close this window. Save it as your default to start with it next time in this
                    browser; otherwise the next translation starts with the installation’s default.
                  </FormControl.HelpText>
                </FormControl>
              </details>
            )}
          </div>
        )}
      </section>
      <Card className="dialog-guidance" aria-label="Guidance and context">
        {guidance}
      </Card>
      {canShowRequestDetails(props.debugMode) && (
        <Accordion className="dialog-request-details">
          <Accordion.Item
            titleElement="h3"
            title={`What gets sent · ${props.planned.length} request${props.planned.length === 1 ? '' : 's'}`}
          >
            <div className="dialog-request-content">
              <p>Destination: {props.destination}</p>
              <p>Model: {props.model || 'Not configured'}. Credentials are never included.</p>
              <p>Instructions: revision {props.profile?.revision ?? 'not available'}</p>
              {props.settings && (
                <p>
                  Request size {props.settings.requestSourceCharacters.toLocaleString('en-US')} source characters · up
                  to {props.settings.maxWorkFields} fields
                </p>
              )}
              <Accordion className="dialog-request-list">
                {props.planned.map((item, index) => (
                  <Accordion.Item
                    key={item.request.requestId}
                    titleElement="h4"
                    title={
                      <>
                        Request {index + 1} · {localeName(item.request.sourceLocale, localeNames)} →{' '}
                        {localeName(item.request.targetLocale, localeNames)} ·{' '}
                        {item.parts
                          .map(part =>
                            part.parts
                              ? `${part.task.fieldName} (part ${part.part} of ${part.parts})`
                              : part.task.fieldName,
                          )
                          .join(', ')}
                      </>
                    }
                  >
                    <RequestMessages planned={item} />
                  </Accordion.Item>
                ))}
              </Accordion>
            </div>
          </Accordion.Item>
        </Accordion>
      )}
    </div>
  );
}
