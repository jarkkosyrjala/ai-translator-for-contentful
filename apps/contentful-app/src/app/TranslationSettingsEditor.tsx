import {
  parseTranslationSettings,
  TRANSLATION_DEFAULTS,
  type TranslationSettings,
} from '@ai-translator-for-contentful/protocol';
import { Accordion, FormControl, TextInput } from '@contentful/f36-components';
import { useEffect, useRef, useState } from 'react';

type NumberSetting = keyof TranslationSettings;

const advanced: { name: Exclude<NumberSetting, 'requestSourceCharacters'>; label: string; help: string }[] = [
  { name: 'maxWorkFields', label: 'Fields per request', help: 'At most this many fields or parts in one request.' },
  { name: 'contextMaxFields', label: 'Context fields', help: 'Selected and sibling context fields per request.' },
  {
    name: 'contextFieldCharacters',
    label: 'Characters per context field',
    help: 'Longer context is cut at whole paragraphs or items.',
  },
  {
    name: 'contextTotalCharacters',
    label: 'Context characters per request',
    help: 'Selected and sibling context combined.',
  },
  { name: 'neighborCharacters', label: 'Neighbor characters per side', help: 'Text before and after a split part.' },
  {
    name: 'outlineCharacters',
    label: 'Outline characters',
    help: 'Headings and table header of a split Rich Text part.',
  },
  {
    name: 'retrySizeFactor',
    label: 'Smaller retry factor',
    help: 'A smaller retry sends at most this share of the failed text per request, between 0 and 1.',
  },
];

/**
 * One model's planner settings: the request size, with the other tuning
 * under Advanced. A blank field uses the default. Only valid
 * settings are reported; an invalid entry is reported as an error instead.
 */
export function TranslationSettingsEditor({
  id,
  label,
  settings,
  presetCharacters,
  onChange,
  onError,
}: {
  id: string;
  label: string;
  settings?: TranslationSettings;
  presetCharacters: number;
  onChange: (next: TranslationSettings | undefined) => void;
  onError: (message: string | undefined) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(settings ?? {}).map(([name, value]) => [name, String(value)])),
  );
  const [error, setError] = useState<string>();
  // An editor that goes away, such as for a removed model, takes its error
  // with it, so the error no longer blocks saving.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => () => onErrorRef.current(undefined), []);
  function update(name: NumberSetting, value: string) {
    const next = { ...drafts, [name]: value };
    setDrafts(next);
    const candidate: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(next)) if (raw.trim()) candidate[key] = Number(raw);
    try {
      const parsed = parseTranslationSettings(candidate);
      setError(undefined);
      onError(undefined);
      onChange(Object.keys(parsed).length ? parsed : undefined);
    } catch {
      const message = `Check the ${label} request settings: whole numbers within range, and a retry factor between 0 and 1.`;
      setError(message);
      onError(message);
    }
  }
  function number(name: NumberSetting, text: string, help: string, placeholder: number) {
    return (
      <FormControl key={name} marginBottom="none">
        <FormControl.Label htmlFor={`${id}-${name}`}>{text}</FormControl.Label>
        <TextInput
          id={`${id}-${name}`}
          size="small"
          type="number"
          value={drafts[name] ?? ''}
          placeholder={String(placeholder)}
          onChange={event => update(name, event.target.value)}
        />
        <FormControl.HelpText>{help}</FormControl.HelpText>
      </FormControl>
    );
  }
  return (
    <div className="translation-settings">
      <strong>{label}</strong>
      <div className="provider-options-grid">
        {number(
          'requestSourceCharacters',
          'Request size (source characters)',
          'Fields are grouped up to this size. Larger Long text, Rich Text and lists are split into parts, which can differ slightly in wording. Lower it for slow models or hosts with short time limits.',
          presetCharacters,
        )}
      </div>
      <Accordion className="provider-advanced">
        <Accordion.Item titleElement="h4" title="Advanced request settings">
          <div className="provider-options-grid">
            {advanced.map(item => number(item.name, item.label, item.help, TRANSLATION_DEFAULTS[item.name]))}
          </div>
        </Accordion.Item>
      </Accordion>
      {error && (
        <FormControl isInvalid marginBottom="none">
          <FormControl.ValidationMessage role="alert">{error}</FormControl.ValidationMessage>
        </FormControl>
      )}
    </div>
  );
}
