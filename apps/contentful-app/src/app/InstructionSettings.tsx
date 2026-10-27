import {
  BUILT_IN_VARIABLE_OPTIONS,
  type CustomVariable,
  compileTranslationMessages,
  FACTORY_ALWAYS_APPLIED,
  FACTORY_TASK_TEMPLATE,
  type InstructionMessage,
  type InstructionProfile,
  RELAY_CONTRACT_VERSION,
  validateInstructionProfile,
} from '@ai-translator-for-contentful/protocol';
import {
  Accordion,
  Button,
  Checkbox,
  FormControl,
  Note,
  Select,
  Subheading,
  Textarea,
  TextInput,
} from '@contentful/f36-components';
import { Fragment, useState } from 'react';
import { removeCustomVariable } from './instruction-variables';
import { TemplateEditor } from './TemplateEditor';

type Props = {
  profile: InstructionProfile;
  active: boolean;
  model: string;
  provider: string;
  sampling: string;
  onChange: (profile: InstructionProfile) => void;
};

function preview(profile: InstructionProfile): { messages?: InstructionMessage[]; error?: string } {
  try {
    const values = Object.fromEntries(
      profile.variables.map(variable => [
        variable.key,
        variable.defaultValue ||
          (variable.type === 'choice'
            ? (variable.choices?.[0] ?? '')
            : variable.type === 'locale'
              ? 'fi-FI'
              : 'Example value'),
      ]),
    );
    return {
      messages: compileTranslationMessages(profile, {
        contract: RELAY_CONTRACT_VERSION,
        requestId: 'preview',
        entryId: 'example',
        model: 'preview-model',
        sourceLocale: 'en-US',
        targetLocale: 'fi-FI',
        availableLocales: ['en-US', 'fi-FI'],
        profile,
        profileRevision: profile.revision,
        runGuidance: 'Keep a clear, welcoming tone.',
        variableValues: values,
        context: [
          {
            id: 'ctx-1',
            role: 'explicit',
            entryId: 'example',
            fieldId: 'summary',
            name: 'Summary',
            locale: 'en-US',
            provenance: 'current-editor',
            omittedUnits: 0,
            value: 'An example context sentence.',
          },
        ],
        fields: [
          {
            id: 'f-title',
            fieldId: 'title',
            name: 'Title',
            type: 'text',
            constraints: { max: 256 },
            outputGuidance: 'Preserve leading and trailing whitespace and line breaks.',
            source: 'A blue house.',
          },
          {
            id: 'f-tags',
            fieldId: 'tags',
            name: 'Tags',
            type: 'array',
            items: [
              { id: 'i0', text: 'Home' },
              { id: 'i1', text: 'Garden' },
            ],
          },
        ],
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function InstructionSettings({ profile, active, model, provider, sampling, onChange }: Props) {
  const [removedVariable, setRemovedVariable] = useState<{ key: string; index: number } | null>(null);
  let error = '';
  try {
    validateInstructionProfile(profile);
  } catch (reason) {
    error = reason instanceof Error ? reason.message : String(reason);
  }
  const sample = !error ? preview(profile) : { error };
  function changeVariable(index: number, change: Partial<CustomVariable>) {
    onChange({
      ...profile,
      variables: profile.variables.map((variable, i) => (i === index ? { ...variable, ...change } : variable)),
    });
  }
  function removeVariable(key: string, index: number) {
    const updated = removeCustomVariable(profile, key);
    setRemovedVariable(previous =>
      updated.alwaysApplied !== profile.alwaysApplied || updated.taskTemplate !== profile.taskTemplate
        ? { key, index }
        : previous && { ...previous, index: previous.index - (index < previous.index ? 1 : 0) },
    );
    onChange(updated);
  }
  const removalWarning = removedVariable && (
    <Note variant="warning" role="status">
      Removing <code>{`{${removedVariable.key}}`}</code> also removed its placeholders from the instruction templates.
      Review the templates above before saving the app configuration.
      <Button variant="transparent" size="small" onClick={() => setRemovedVariable(null)}>
        Dismiss
      </Button>
    </Note>
  );
  return (
    <section className="config-section" aria-labelledby="instructions-heading">
      <Subheading as="h2" id="instructions-heading" marginBottom="none">
        Instruction templates
      </Subheading>
      <p>
        Installation administrators set the translation instructions. Editors can provide only the run values listed
        below. Source text and selected context stay labeled as data.
      </p>
      {!active && (
        <Note variant="primary">
          Translation uses these default instructions until you edit them and save the app configuration.
        </Note>
      )}
      {provider === 'Custom backend' && (
        <Note variant="warning">
          A Custom backend uses the profile that each signed browser request carries, so it cannot enforce these saved
          instructions. Anyone who can use the app in a listed space can send other instructions to the model.
        </Note>
      )}
      <p className="muted">
        Profile revision: {active ? profile.revision : 'Not saved yet'} · Factory version {profile.factoryVersion}
      </p>
      <FormControl isInvalid={Boolean(error)}>
        <div className="section-heading">
          <FormControl.Label htmlFor="always-applied">Always-applied app instruction</FormControl.Label>
          <Button
            variant="transparent"
            size="small"
            aria-label="Reset always-applied app instruction to default"
            onClick={() => onChange({ ...profile, alwaysApplied: FACTORY_ALWAYS_APPLIED })}
          >
            Reset to default
          </Button>
        </div>
        <TemplateEditor
          id="always-applied"
          rows={5}
          value={profile.alwaysApplied}
          variables={profile.variables}
          onChange={value => onChange({ ...profile, alwaysApplied: value })}
        />
        <FormControl.HelpText>
          Translation behavior shared by every request. The app describes the request before these templates, adds its
          output rules after them, and validates every suggestion.
        </FormControl.HelpText>
      </FormControl>
      <FormControl isInvalid={Boolean(error)}>
        <div className="section-heading">
          <FormControl.Label htmlFor="task-template">Task template</FormControl.Label>
          <Button
            variant="transparent"
            size="small"
            aria-label="Reset task template to default"
            onClick={() => onChange({ ...profile, taskTemplate: FACTORY_TASK_TEMPLATE })}
          >
            Reset to default
          </Button>
        </div>
        <TemplateEditor
          id="task-template"
          rows={6}
          value={profile.taskTemplate}
          variables={profile.variables}
          onChange={value => onChange({ ...profile, taskTemplate: value })}
        />
        <FormControl.HelpText>
          Use single-brace placeholders such as <code>{'{targetLocale}'}</code> or <code>{'{tone}'}</code>. Type{' '}
          <code>{'{'}</code> to choose a variable. Double braces like <code>{'{{'}</code> and <code>{'}}'}</code> insert
          literal braces. Locales are inserted as codes; other values stay in the request, and the instruction refers to
          their elements, for example as <code>{'<fields>'}</code> or <code>{'<variable key="tone">'}</code>.
        </FormControl.HelpText>
      </FormControl>
      <div>
        <Subheading as="h3" marginBottom="spacingXs">
          Built-in variables
        </Subheading>
        <p className="muted">The app fills these in for every request.</p>
        <ul className="variable-list">
          {BUILT_IN_VARIABLE_OPTIONS.map(({ key, label }) => (
            <li key={key}>
              <code>{`{${key}}`}</code> {label}
            </li>
          ))}
        </ul>
      </div>
      <div className="section-heading">
        <Subheading as="h3" marginBottom="spacingXs">
          Custom variables
        </Subheading>
        <Button
          size="small"
          onClick={() =>
            onChange({
              ...profile,
              variables: [
                ...profile.variables,
                {
                  key: `variable${profile.variables.length + 1}`,
                  name: 'New variable',
                  description: '',
                  type: 'text',
                  required: false,
                },
              ],
            })
          }
          isDisabled={profile.variables.length >= 12}
        >
          Add variable
        </Button>
      </div>
      <p className="muted">
        Add your own placeholders, such as <code>{'{tone}'}</code> or <code>{'{audience}'}</code>, for the templates
        above. Editors set their values in the translate dialog; a shared default prefills the value. Removing a
        variable also removes its placeholders from both templates. Review the resulting instructions before saving.
      </p>
      {removedVariable?.index === 0 && removalWarning}
      {profile.variables.map((variable, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: variables have no stable ID; the inputs are controlled.
        <Fragment key={index}>
          <div className="instruction-variable">
            <div className="section-heading">
              <strong>{variable.name || `Variable ${index + 1}`}</strong>
              <Button variant="transparent" size="small" onClick={() => removeVariable(variable.key, index)}>
                Remove
              </Button>
            </div>
            <div className="instruction-variable-grid">
              <FormControl>
                <FormControl.Label htmlFor={`variable-key-${index}`}>Key</FormControl.Label>
                <TextInput
                  id={`variable-key-${index}`}
                  value={variable.key}
                  onChange={event => changeVariable(index, { key: event.target.value })}
                />
              </FormControl>
              <FormControl>
                <FormControl.Label htmlFor={`variable-name-${index}`}>Name</FormControl.Label>
                <TextInput
                  id={`variable-name-${index}`}
                  value={variable.name}
                  onChange={event => changeVariable(index, { name: event.target.value })}
                />
              </FormControl>
              <FormControl>
                <FormControl.Label htmlFor={`variable-type-${index}`}>Type</FormControl.Label>
                <Select
                  id={`variable-type-${index}`}
                  value={variable.type}
                  onChange={event => {
                    const type = event.target.value as CustomVariable['type'];
                    changeVariable(index, {
                      type,
                      choices: type === 'choice' ? ['Option A', 'Option B'] : undefined,
                      defaultValue: undefined,
                    });
                  }}
                >
                  <Select.Option value="text">Text</Select.Option>
                  <Select.Option value="choice">Multiple choice</Select.Option>
                  <Select.Option value="locale">Locale</Select.Option>
                </Select>
              </FormControl>
            </div>
            <FormControl>
              <FormControl.Label htmlFor={`variable-description-${index}`}>Description</FormControl.Label>
              <TextInput
                id={`variable-description-${index}`}
                value={variable.description}
                onChange={event => changeVariable(index, { description: event.target.value })}
              />
            </FormControl>
            {variable.type === 'choice' && (
              <FormControl>
                <FormControl.Label htmlFor={`variable-choices-${index}`}>Choices (one per line)</FormControl.Label>
                <Textarea
                  id={`variable-choices-${index}`}
                  value={(variable.choices ?? []).join('\n')}
                  onChange={event => changeVariable(index, { choices: event.target.value.split('\n') })}
                  rows={3}
                />
              </FormControl>
            )}
            <FormControl>
              <FormControl.Label htmlFor={`variable-default-${index}`}>Shared default (optional)</FormControl.Label>
              {variable.type === 'choice' ? (
                <Select
                  id={`variable-default-${index}`}
                  value={variable.defaultValue ?? ''}
                  onChange={event => changeVariable(index, { defaultValue: event.target.value || undefined })}
                >
                  <Select.Option value="">No default</Select.Option>
                  {variable.choices?.filter(Boolean).map(choice => (
                    <Select.Option value={choice} key={choice}>
                      {choice}
                    </Select.Option>
                  ))}
                </Select>
              ) : (
                <TextInput
                  id={`variable-default-${index}`}
                  value={variable.defaultValue ?? ''}
                  onChange={event => changeVariable(index, { defaultValue: event.target.value || undefined })}
                  placeholder={variable.type === 'locale' ? 'e.g. fi-FI' : 'Leave blank for editor input'}
                />
              )}
            </FormControl>
            <Checkbox
              name={`variable-required-${index}`}
              isChecked={variable.required}
              onChange={event => changeVariable(index, { required: event.target.checked })}
            >
              Required before translation
            </Checkbox>
          </div>
          {removedVariable?.index === index + 1 && removalWarning}
        </Fragment>
      ))}
      {error && (
        <Note variant="negative" role="alert">
          {error}
        </Note>
      )}
      <Accordion className="instruction-preview">
        <Accordion.Item titleElement="h3" title="Preview exact model messages with synthetic data">
          <p>
            Provider: {provider}. Model: {model || 'Not configured'}. Sampling: {sampling}. No credentials or entry
            content are included.
          </p>
          {sample.error ? (
            <Note variant="warning">{sample.error}</Note>
          ) : (
            sample.messages?.map((message, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed preview whose messages can repeat.
              <div key={index}>
                <strong>{message.role}</strong>
                <pre>{message.content}</pre>
              </div>
            ))
          )}
        </Accordion.Item>
      </Accordion>
    </section>
  );
}
