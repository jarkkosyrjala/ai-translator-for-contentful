import { BUILT_IN_VARIABLE_OPTIONS, type CustomVariable } from '@ai-translator-for-contentful/protocol';
import type React from 'react';
import { useLayoutEffect, useRef, useState } from 'react';

type Option = { key: string; label: string; detail?: string };

function highlighted(value: string, known: ReadonlySet<string>): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let from = 0;
  for (const match of value.matchAll(/(?<!\{){([A-Za-z][A-Za-z0-9_]*)}(?!})/g)) {
    const at = match.index;
    parts.push(value.slice(from, at));
    parts.push(
      <mark key={at} className={known.has(match[1]) ? 'template-token' : 'template-token-invalid'}>
        {match[0]}
      </mark>,
    );
    from = at + match[0].length;
  }
  parts.push(value.slice(from));
  return parts;
}

export function TemplateEditor({
  id,
  value,
  onChange,
  variables,
  rows = 6,
  maxLength,
  placeholder,
  excludeVariables = [],
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  variables: CustomVariable[];
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  excludeVariables?: string[];
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const overlay = useRef<HTMLPreElement>(null);
  const [cursor, setCursor] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 12 });
  const options: Option[] = [
    ...BUILT_IN_VARIABLE_OPTIONS.filter(({ key }) => !excludeVariables.includes(key)).map(({ key, label }) => ({
      key,
      label,
    })),
    ...variables.map(variable => ({
      key: variable.key,
      label: variable.name || variable.key,
      detail: variable.description,
    })),
  ];
  const before = value.slice(0, cursor);
  const partial = /(?<!\{)\{([A-Za-z0-9_]*)$/.exec(before);
  const start = partial ? cursor - partial[0].length : -1;
  const filtered = partial
    ? options
        .filter(option => `${option.key} ${option.label}`.toLowerCase().includes(partial[1].toLowerCase()))
        .slice(0, 12)
    : [];
  const open = !dismissed && start >= 0 && filtered.length > 0;
  const selected = Math.min(active, filtered.length - 1);
  const known = new Set(options.map(option => option.key));

  useLayoutEffect(() => {
    const field = textarea.current;
    if (!open || !field) return;
    const style = getComputedStyle(field);
    const mirror = document.createElement('div');
    Object.assign(mirror.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      visibility: 'hidden',
      boxSizing: style.boxSizing,
      width: `${field.getBoundingClientRect().width}px`,
      padding: style.padding,
      border: style.border,
      font: style.font,
      letterSpacing: style.letterSpacing,
      whiteSpace: 'pre-wrap',
      overflowWrap: 'break-word',
      tabSize: style.tabSize,
    });
    mirror.textContent = value.slice(0, cursor);
    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const markerRect = marker.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    const lineHeight = Number.parseFloat(style.lineHeight) || 21;
    setMenuPosition({
      top: Math.max(0, markerRect.top - mirrorRect.top + lineHeight - field.scrollTop),
      left: Math.max(0, Math.min(field.clientWidth - 220, markerRect.left - mirrorRect.left - field.scrollLeft)),
    });
    mirror.remove();
  }, [open, cursor, value]);

  function syncCursor(element: HTMLTextAreaElement, reset = false) {
    setCursor(element.selectionStart);
    if (reset) {
      setActive(0);
      setDismissed(false);
    }
  }
  function insert(option: Option) {
    if (start < 0) return;
    const next = `${value.slice(0, start)}{${option.key}}${value.slice(cursor)}`;
    const position = start + option.key.length + 2;
    if (maxLength !== undefined && next.length > maxLength) return;
    onChange(next);
    setCursor(position);
    setDismissed(true);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(position, position);
    });
  }
  return (
    <div className="template-editor">
      <pre aria-hidden="true" ref={overlay} className="template-editor-overlay">
        {highlighted(value, known)}
        {'\n'}
      </pre>
      <textarea
        id={id}
        ref={textarea}
        className="template-editor-input"
        value={value}
        rows={rows}
        spellCheck={false}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={event => {
          onChange(event.target.value);
          syncCursor(event.target, true);
        }}
        onClick={event => syncCursor(event.currentTarget, true)}
        onSelect={event => syncCursor(event.currentTarget)}
        onScroll={event => {
          if (overlay.current) {
            overlay.current.scrollTop = event.currentTarget.scrollTop;
            overlay.current.scrollLeft = event.currentTarget.scrollLeft;
          }
        }}
        onKeyDown={event => {
          if (!open) return;
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive(index => (index + 1) % filtered.length);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(index => (index + filtered.length - 1) % filtered.length);
          } else if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            insert(filtered[selected]);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setDismissed(true);
          }
        }}
      />
      {open && (
        <div className="template-options" role="listbox" aria-label="Template variables" style={menuPosition}>
          {filtered.map((option, index) => (
            <button
              type="button"
              key={option.key}
              role="option"
              aria-selected={index === selected}
              className={index === selected ? 'selected' : ''}
              onMouseDown={event => event.preventDefault()}
              onClick={() => insert(option)}
            >
              <span>{option.label}</span>
              <code>{`{${option.key}}`}</code>
              {option.detail && <small>{option.detail}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
