import type { DialogAppSDK } from '@contentful/app-sdk';
import React from 'react';
import 'codemirror/lib/codemirror.css';
import './field-editor-i18n';

// Contentful's Markdown and Rich Text editors open their link, table, and other
// helper dialogs in the app's own dialog location. Render those instead of the
// translator when the invocation names one of them.
export function editorDialogType(invocation: unknown): 'markdown' | 'richText' | undefined {
  const type = invocation && typeof invocation === 'object' && 'type' in invocation ? invocation.type : undefined;
  if (typeof type !== 'string') return undefined;
  if (type.startsWith('markdown-')) return 'markdown';
  if (type.startsWith('rich-text-')) return 'richText';
  return undefined;
}

const MarkdownDialog = React.lazy(() =>
  import('@contentful/field-editor-markdown').then(module => ({
    default: ({ sdk }: { sdk: DialogAppSDK }) =>
      module.renderMarkdownDialog(sdk as Parameters<typeof module.renderMarkdownDialog>[0]),
  })),
);
const RichTextDialog = React.lazy(() =>
  import('@contentful/field-editor-rich-text').then(module => ({
    default: ({ sdk }: { sdk: DialogAppSDK }) => module.renderRichTextDialog(sdk),
  })),
);

export function EditorDialog({ sdk, type }: { sdk: DialogAppSDK; type: 'markdown' | 'richText' }) {
  return (
    <React.Suspense fallback={null}>
      {type === 'markdown' ? <MarkdownDialog sdk={sdk} /> : <RichTextDialog sdk={sdk} />}
    </React.Suspense>
  );
}
