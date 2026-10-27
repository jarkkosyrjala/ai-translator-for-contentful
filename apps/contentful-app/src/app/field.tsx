import type { FieldAppSDK } from '@contentful/app-sdk';
import { Button, Note, Tooltip } from '@contentful/f36-components';
import { TranslateIcon } from '@contentful/f36-icons';
import React, { useEffect, useRef, useState } from 'react';
import 'codemirror/lib/codemirror.css';
import './field-editor-i18n';
import { eligibility, fieldAppEditor, resolveAppControls } from './eligibility';
import { fieldAction } from './field-model';
import { openTranslator } from './launch';
import { isConfigured, outcomeNotice } from './sidebar-model';
import type { Params } from './transport-config';

const SingleLineEditor = React.lazy(() =>
  import('@contentful/field-editor-single-line').then(module => ({ default: module.SingleLineEditor })),
);
const MultipleLineEditor = React.lazy(() =>
  import('@contentful/field-editor-multiple-line').then(module => ({ default: module.MultipleLineEditor })),
);
const MarkdownEditor = React.lazy(() =>
  import('@contentful/field-editor-markdown').then(module => ({ default: module.MarkdownEditor })),
);
const RichTextEditor = React.lazy(() =>
  import('@contentful/field-editor-rich-text').then(module => ({ default: module.RichTextEditor })),
);
const ListEditor = React.lazy(() =>
  import('@contentful/field-editor-list').then(module => ({ default: module.ListEditor })),
);
const TagsEditor = React.lazy(() =>
  import('@contentful/field-editor-tags').then(module => ({ default: module.TagsEditor })),
);

// The entry field location replaces Contentful's editor for this field, so the
// app renders the same built-in editor and adds a translate button beside it.
function BuiltInEditor({ sdk, editor }: { sdk: FieldAppSDK; editor: string }) {
  switch (editor) {
    case 'singleLine':
      return <SingleLineEditor field={sdk.field} locales={sdk.locales} isInitiallyDisabled />;
    case 'multipleLine':
      return <MultipleLineEditor field={sdk.field} locales={sdk.locales} isInitiallyDisabled withCharValidation />;
    case 'markdown':
      return <MarkdownEditor sdk={sdk} isInitiallyDisabled />;
    case 'richTextEditor':
      return <RichTextEditor sdk={sdk} isInitiallyDisabled />;
    case 'listInput':
      return <ListEditor field={sdk.field} locales={sdk.locales} isInitiallyDisabled />;
    case 'tagEditor':
      return <TagsEditor field={sdk.field} isInitiallyDisabled />;
    default:
      return (
        <Note variant="warning">
          AI Translator can’t edit this field type. Choose another editor under the field’s Appearance settings.
        </Note>
      );
  }
}

export function Field({ sdk }: { sdk: FieldAppSDK<Params> }) {
  const [value, setValue] = useState<unknown>(() => sdk.field.getValue());
  const [running, setRunning] = useState(false);
  const runInProgress = useRef(false);
  useEffect(() => {
    sdk.window.startAutoResizer();
    return () => sdk.window.stopAutoResizer();
  }, [sdk]);
  useEffect(() => sdk.field.onValueChanged(setValue), [sdk]);

  const definition = sdk.contentType.fields.find(field => field.id === sdk.field.id);
  const editor = definition && fieldAppEditor(definition, sdk.parameters.instance);
  const action = fieldAction({
    result:
      definition &&
      eligibility(
        definition,
        resolveAppControls(sdk.editor.editorInterface.controls, sdk.contentType.fields, sdk.ids.app),
      ),
    definition,
    fieldName: definition?.name ?? sdk.field.id,
    value,
    locale: sdk.field.locale,
    targets: sdk.locales.available.filter(
      locale => locale !== sdk.field.locale && sdk.entry.fields[sdk.field.id]?.locales.includes(locale),
    ),
    configured: isConfigured(sdk.parameters.installation),
    localeNames: sdk.locales.names,
  });

  async function translate() {
    if (runInProgress.current) return;
    runInProgress.current = true;
    setRunning(true);
    try {
      const lines = await openTranslator(sdk, { fieldId: sdk.field.id, locale: sdk.field.locale });
      const notice = lines && outcomeNotice(lines, sdk.contentType.fields, sdk.locales.names);
      if (notice) sdk.notifier[notice.variant](notice.message);
    } catch (caught) {
      sdk.notifier.error(
        caught instanceof Error ? caught.message : 'The dialog or draft update failed. Please try again.',
      );
    } finally {
      runInProgress.current = false;
      setRunning(false);
    }
  }

  // The field label is outside this iframe, so the button sits just under it.
  // Markdown's Editor and Preview tabs leave that row empty on the left.
  return (
    <div className="field-app">
      {action.visible && (
        <div className={`field-app-header${editor === 'markdown' ? ' field-app-header-tabs' : ''}`}>
          <Tooltip content={action.tooltip} placement="right">
            <Button
              variant="transparent"
              size="small"
              className="field-app-translate"
              startIcon={<TranslateIcon />}
              aria-label={action.label}
              isDisabled={action.disabled || running}
              onClick={() => void translate()}
            >
              Translate
            </Button>
          </Tooltip>
        </div>
      )}
      <React.Suspense fallback={null}>
        <BuiltInEditor sdk={sdk} editor={editor ?? ''} />
      </React.Suspense>
    </div>
  );
}
