import type { ContentTypeField, DialogAppSDK } from '@contentful/app-sdk';
import type { Document } from '@contentful/rich-text-types';
import React, { type CSSProperties, useEffect, useRef, useState } from 'react';
import 'codemirror/lib/codemirror.css';
import '../field-editor-i18n';
import { createReviewField, type ReviewFieldValue } from './review-field';

const RichTextEditor = React.lazy(() =>
  import('@contentful/field-editor-rich-text').then(module => ({ default: module.RichTextEditor })),
);
const MarkdownEditor = React.lazy(() =>
  import('@contentful/field-editor-markdown').then(module => ({ default: module.MarkdownEditor })),
);
const MultipleLineEditor = React.lazy(() =>
  import('@contentful/field-editor-multiple-line').then(module => ({ default: module.MultipleLineEditor })),
);

type Props = {
  sdk: DialogAppSDK;
  entryId: string;
  contentTypeId: string;
  definition: ContentTypeField;
  instanceParameters?: Record<string, unknown>;
  locale: string;
  value: ReviewFieldValue;
  kind: 'richText' | 'markdown' | 'multipleLine';
  readOnly?: boolean;
  minHeight?: number;
  onChange?: (value: ReviewFieldValue) => void;
};

const ignoreChange = () => undefined;

type MarkdownEditorHandle = {
  events: { onChange: (listener: (value: string) => void) => void };
};

export default function NativeFieldEditor(props: Props) {
  const [bridge] = useState(() =>
    createReviewField(
      props.sdk,
      props.entryId,
      props.contentTypeId,
      props.definition,
      props.locale,
      props.value,
      props.onChange ?? ignoreChange,
      props.instanceParameters,
      props.readOnly,
    ),
  );
  const previous = useRef(props.value);
  bridge.setOnChange(props.onChange ?? ignoreChange);
  useEffect(() => {
    if (previous.current !== props.value) {
      previous.current = props.value;
      if (JSON.stringify(bridge.field.getValue()) !== JSON.stringify(props.value)) bridge.setExternal(props.value);
    }
  }, [bridge, props.value]);
  useEffect(() => () => bridge.disposeAfterPendingChange(), [bridge]);

  if (props.kind === 'richText')
    return (
      <React.Suspense fallback={<p className="dialog-muted">Loading Rich Text editor…</p>}>
        <RichTextEditor
          sdk={bridge.sdk}
          isInitiallyDisabled={props.readOnly ?? false}
          value={props.value as Document}
          minHeight={360}
          withCharValidation={false}
        />
      </React.Suspense>
    );
  if (props.kind === 'markdown')
    return (
      <div
        className="dialog-markdown-editor"
        data-read-only={props.readOnly || undefined}
        style={{ '--markdown-min-height': `${props.minHeight ?? 360}px` } as CSSProperties}
      >
        <React.Suspense fallback={<p className="dialog-muted">Loading Markdown editor…</p>}>
          <MarkdownEditor
            sdk={bridge.sdk}
            isInitiallyDisabled={props.readOnly ?? false}
            isDisabled={props.readOnly}
            minHeight={props.minHeight ?? 360}
            onReady={(editor: MarkdownEditorHandle) => {
              // The native connector debounces field writes by 300 ms. Keep the
              // review value current so Apply also sees the editor's last edit.
              if (!props.readOnly)
                editor.events.onChange(value => {
                  void bridge.field.setValue(value.replace(/^\s+$/gm, ''));
                });
            }}
          />
        </React.Suspense>
      </div>
    );
  return (
    <React.Suspense fallback={<p className="dialog-muted">Loading text editor…</p>}>
      <MultipleLineEditor
        field={bridge.sdk.field}
        locales={bridge.sdk.locales}
        isInitiallyDisabled={props.readOnly ?? false}
        withCharValidation
      />
    </React.Suspense>
  );
}
