import { LockSimpleIcon } from '@contentful/f36-icons';
import { documentToReactComponents } from '@contentful/rich-text-react-renderer';
import { BLOCKS, type Document, INLINES } from '@contentful/rich-text-types';
import type React from 'react';
import { isRichDocument } from '../../richtext/editor';

export function richTextWordCount(value: unknown): number {
  function plain(node: unknown): string {
    if (!node || typeof node !== 'object') return '';
    const item = node as { value?: unknown; content?: unknown };
    if (typeof item.value === 'string') return item.value;
    return Array.isArray(item.content) ? item.content.map(plain).join(' ') : '';
  }
  return plain(value).trim().split(/\s+/u).filter(Boolean).length;
}

export function DialogRichTextPreview({ value, expanded = false }: { value: unknown; expanded?: boolean }) {
  if (!isRichDocument(value)) return <span className="dialog-empty">Empty</span>;
  const locked = (kind: string) => (
    <span className="dialog-locked" contentEditable={false}>
      <LockSimpleIcon size="tiny" />
      {kind}
    </span>
  );
  const options = {
    preserveWhitespace: true,
    renderNode: {
      [INLINES.HYPERLINK]: (_node: unknown, children: React.ReactNode) => (
        <span className="dialog-rich-link">{children}</span>
      ),
      [INLINES.ENTRY_HYPERLINK]: (_node: unknown, children: React.ReactNode) => (
        <span className="dialog-rich-link">{children}</span>
      ),
      [INLINES.ASSET_HYPERLINK]: (_node: unknown, children: React.ReactNode) => (
        <span className="dialog-rich-link">{children}</span>
      ),
      [INLINES.RESOURCE_HYPERLINK]: (_node: unknown, children: React.ReactNode) => (
        <span className="dialog-rich-link">{children}</span>
      ),
      [INLINES.EMBEDDED_ENTRY]: () => locked('Embedded entry'),
      [INLINES.EMBEDDED_RESOURCE]: () => locked('Embedded resource'),
      [BLOCKS.EMBEDDED_ENTRY]: () => <div className="dialog-locked-block">{locked('Embedded entry')}</div>,
      [BLOCKS.EMBEDDED_ASSET]: () => <div className="dialog-locked-block">{locked('Embedded asset')}</div>,
      [BLOCKS.EMBEDDED_RESOURCE]: () => <div className="dialog-locked-block">{locked('Embedded resource')}</div>,
      [BLOCKS.HR]: () => <hr aria-label="horizontal rule" />,
      [BLOCKS.TABLE]: (_node: unknown, children: React.ReactNode) => (
        <div className="dialog-rich-table">
          <table>
            <tbody>{children}</tbody>
          </table>
        </div>
      ),
    },
  };
  return (
    <div className={`dialog-rich-preview${expanded ? ' dialog-rich-preview-expanded' : ''}`}>
      {documentToReactComponents(value as Document, options)}
    </div>
  );
}
