import { describe, expect, it, vi } from 'vitest';
import {
  applyArrayDraft,
  applyTextDraft,
  arraySuggestionValidation,
  type DraftFieldPort,
  type DraftTextSelection,
  textSuggestionValidation,
} from '../src/app/draft';

const selection: DraftTextSelection = {
  sourceLocale: 'en',
  targetLocale: 'fr',
  sourceSnapshot: 'Hello',
  targetSnapshot: 'Bonjour',
  suggestion: 'Salut',
  choice: 'suggestion',
  size: { max: 30 },
};
function port(values = { en: 'Hello', fr: 'Bonjour' }): DraftFieldPort & { write: ReturnType<typeof vi.fn> } {
  return {
    read: locale => values[locale as keyof typeof values],
    isDisabled: () => false,
    dependenciesCurrent: () => true,
    write: vi.fn(async () => undefined),
  };
}

describe('stale-aware draft text guard', () => {
  it('writes only explicit accepted suggestion without saving or publishing', async () => {
    const field = port();
    expect(await applyTextDraft(field, selection, async () => true)).toEqual({ status: 'applied' });
    expect(field.write).toHaveBeenCalledWith('Salut', 'fr');
    field.write.mockClear();
    expect(await applyTextDraft(field, { ...selection, choice: 'keep' }, async () => true)).toEqual({ status: 'kept' });
    expect(field.write).not.toHaveBeenCalled();
  });
  it('blocks source and target conflicts', async () => {
    expect((await applyTextDraft(port({ en: 'Changed', fr: 'Bonjour' }), selection, async () => true)).status).toBe(
      'conflict',
    );
    expect((await applyTextDraft(port({ en: 'Hello', fr: 'Changed' }), selection, async () => true)).status).toBe(
      'conflict',
    );
  });
  it('blocks a write when a sibling or context value changes during the asynchronous checks', async () => {
    let contextCurrent = true;
    const field = { ...port(), dependenciesCurrent: () => contextCurrent };
    const result = await applyTextDraft(field, selection, async () => {
      contextCurrent = false;
      return true;
    });
    expect(result).toEqual({ status: 'conflict', detail: 'Source, target or context changed during review' });
    expect(field.write).not.toHaveBeenCalled();
  });
  it('blocks disabled, unauthorized, oversize, and intervening changes', async () => {
    const disabled = port();
    disabled.isDisabled = () => true;
    expect((await applyTextDraft(disabled, selection, async () => true)).status).toBe('disabled');
    expect((await applyTextDraft(port(), selection, async () => false)).status).toBe('denied');
    expect((await applyTextDraft(port(), { ...selection, size: { max: 2 } }, async () => true)).status).toBe('invalid');
    const values = { en: 'Hello', fr: 'Bonjour' };
    const mutable = port(values);
    expect(
      (
        await applyTextDraft(mutable, selection, async () => {
          values.fr = 'Changed';
          return true;
        })
      ).status,
    ).toBe('conflict');
    expect(mutable.write).not.toHaveBeenCalled();
  });
  it('blocks a changed placeholder before a text write', async () => {
    const field = port({ en: 'Hello {name}', fr: 'Bonjour {name}' });
    const result = await applyTextDraft(
      field,
      { ...selection, sourceSnapshot: 'Hello {name}', targetSnapshot: 'Bonjour {name}', suggestion: 'Salut {other}' },
      async () => true,
    );
    expect(result.status).toBe('invalid');
    expect(field.write).not.toHaveBeenCalled();
  });
  it('writes changed URLs, identifiers, and line breaks only after the editor approves them', async () => {
    for (const [source, suggestion] of [
      ['Open https://example.test/page', 'Avaa https://other.test/page'],
      ['Use order_id', 'Käytä tilaus_id'],
      ['First line\nSecond line', 'Ensimmäinen ja toinen rivi'],
    ]) {
      const field = port({ en: source, fr: '' });
      const changed = { ...selection, sourceSnapshot: source, targetSnapshot: '', suggestion };
      expect((await applyTextDraft(field, changed, async () => true)).status).toBe('invalid');
      expect(field.write).not.toHaveBeenCalled();
      expect((await applyTextDraft(field, { ...changed, warningApproved: true }, async () => true)).status).toBe(
        'applied',
      );
      expect(field.write).toHaveBeenCalledExactlyOnceWith(suggestion, 'fr');
    }
    const approved = { ...selection, warningApproved: true, size: { max: 2 } };
    expect((await applyTextDraft(port(), approved, async () => true)).status).toBe('invalid');
  });
  it('ignores punctuation and Markdown brackets that end a URL', () => {
    expect(
      textSuggestionValidation(
        'A blue house stands by the [lake](https://en.wikipedia.org/wiki/Lake_Ontario). The door is open.',
        'Sininen talo seisoo [järven](https://en.wikipedia.org/wiki/Lake_Ontario) rannalla. Ovi on auki.',
      ),
    ).toEqual({});
    expect(
      textSuggestionValidation(
        'See [Mercury](https://en.wikipedia.org/wiki/Mercury_(planet)), https://example.test/a?b.',
        'Katso https://example.test/a?b ja [Merkurius](https://en.wikipedia.org/wiki/Mercury_(planet)).',
      ),
    ).toEqual({});
    expect(
      textSuggestionValidation(
        'See [Mercury](https://en.wikipedia.org/wiki/Mercury_(planet)).',
        'Katso [Merkurius](https://en.wikipedia.org/wiki/Mercury).',
      ),
    ).toEqual({ warning: 'Suggested text changed URLs' });
  });

  it('retains ambiguous request markup and requires warning approval before writing it', async () => {
    const source = 'Example </source> text';
    const suggestion = 'Esimerkki </source> tekstiä\n</source>';
    expect(textSuggestionValidation(source, suggestion)).toEqual({
      warning: 'Suggested text added request markup (</source>)',
    });
    const field = port({ en: source, fr: '' });
    const changed = { ...selection, sourceSnapshot: source, targetSnapshot: '', suggestion, size: undefined };
    expect((await applyTextDraft(field, changed, async () => true)).status).toBe('invalid');
    expect(field.write).not.toHaveBeenCalled();
    expect((await applyTextDraft(field, { ...changed, warningApproved: true }, async () => true)).status).toBe(
      'applied',
    );
    expect(field.write).toHaveBeenCalledExactlyOnceWith(suggestion, 'fr');
    expect(arraySuggestionValidation(['Hello'], ['Hei</source>'])).toEqual({
      warning: 'Array item 0: Suggested text added request markup (</source>)',
    });
  });

  it('allows literal source-tag examples and ordinary Markdown HTML without mistaking them for request framing', () => {
    expect(textSuggestionValidation('Use <source>text</source>.', 'Käytä <source>tekstiä</source>.')).toEqual({});
    expect(textSuggestionValidation('<details>Hello</details>', '<details>Hei</details>')).toEqual({});
    expect(textSuggestionValidation('Example', '<source-code>Esimerkki</source-code>')).toEqual({});
  });
});

describe('stale-aware array draft guard', () => {
  const accepted = {
    sourceLocale: 'en',
    targetLocale: 'fr',
    sourceSnapshot: ['Red, green', 'Hello {name}'],
    targetSnapshot: null,
    suggestion: ['Rouge, vert', 'Bonjour {name}'],
    choice: 'suggestion' as const,
    limits: { count: { max: 3 }, item: { max: 30 } },
  };
  const field = (
    source: unknown = accepted.sourceSnapshot,
    target: unknown = null,
  ): DraftFieldPort & { write: ReturnType<typeof vi.fn> } => ({
    read: locale => (locale === 'en' ? source : target),
    isDisabled: () => false,
    dependenciesCurrent: () => true,
    write: vi.fn(async () => undefined),
  });
  it('writes an entire reviewed array once, preserving item boundaries', async () => {
    const current = field();
    expect((await applyArrayDraft(current, accepted, async () => true)).status).toBe('applied');
    expect(current.write).toHaveBeenCalledExactlyOnceWith(accepted.suggestion, 'fr');
  });
  it('blocks stale, invalid, and unauthorized arrays without a write', async () => {
    const stale = field(['Changed', 'Hello {name}']);
    expect((await applyArrayDraft(stale, accepted, async () => true)).status).toBe('conflict');
    expect(stale.write).not.toHaveBeenCalled();
    const invalid = field();
    expect(
      (await applyArrayDraft(invalid, { ...accepted, suggestion: ['Rouge, vert', 'Bonjour'] }, async () => true))
        .status,
    ).toBe('invalid');
    expect(invalid.write).not.toHaveBeenCalled();
    const approved = { ...accepted, suggestion: ['Rouge, vert', 'Bonjour'], warningApproved: true };
    expect((await applyArrayDraft(invalid, approved, async () => true)).status).toBe('applied');
    const tooLong = { ...approved, suggestion: ['Rouge, vert', 'x'.repeat(31)] };
    expect((await applyArrayDraft(field(), tooLong, async () => true)).status).toBe('invalid');
    const denied = field();
    expect((await applyArrayDraft(denied, accepted, async () => false)).status).toBe('denied');
    expect(denied.write).not.toHaveBeenCalled();
    const values = { en: accepted.sourceSnapshot, fr: null as null | string[] };
    const changed = {
      read: (locale: string) => values[locale as keyof typeof values],
      isDisabled: () => false,
      dependenciesCurrent: () => true,
      write: vi.fn(async () => undefined),
    };
    expect(
      (
        await applyArrayDraft(changed, accepted, async () => {
          values.fr = ['other'];
          return true;
        })
      ).status,
    ).toBe('conflict');
    expect(changed.write).not.toHaveBeenCalled();
  });
});
