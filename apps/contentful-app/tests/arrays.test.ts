import { describe, expect, it } from 'vitest';
import { arrayIntegrityError, assembleArraySuggestion, planArrayItems } from '../src/app/arrays';

describe('free-text array task planning', () => {
  it('uses stable indexes and preserves commas inside items', () => {
    expect(planArrayItems(['red, green', 'blue'])).toEqual([
      { index: 0, text: 'red, green' },
      { index: 1, text: 'blue' },
    ]);
    expect(
      assembleArraySuggestion(
        ['red, green', 'blue'],
        [
          { index: 1, text: 'bleu' },
          { index: 0, text: 'rouge, vert' },
        ],
      ),
    ).toEqual(['rouge, vert', 'bleu']);
  });
  it('rejects missing, duplicate, unexpected, and invalid items atomically', () => {
    expect(() => assembleArraySuggestion(['a', 'b'], [{ index: 0, text: 'A' }])).toThrow();
    expect(() =>
      assembleArraySuggestion(
        ['a', 'b'],
        [
          { index: 0, text: 'A' },
          { index: 0, text: 'B' },
        ],
      ),
    ).toThrow();
    expect(() => assembleArraySuggestion(['a'], [{ index: 2, text: 'A' }])).toThrow();
    expect(() => assembleArraySuggestion(['a'], [{ index: 0, text: '' }], { item: { min: 1 } })).toThrow();
    expect(() => assembleArraySuggestion(['a'], [{ index: 0, text: 'Long' }], { item: { max: 3 } })).toThrow();
    expect(() => assembleArraySuggestion(['a'], [{ index: 0, text: 'A' }], { count: { min: 2 } })).toThrow();
    expect(() => planArrayItems(['a', 2])).toThrow();
  });
  it('keeps each item’s placeholders with its original index', () => {
    expect(
      assembleArraySuggestion(
        ['Hello {name}', 'Use {{code}}'],
        [
          { index: 1, text: 'Käytä {{code}}' },
          { index: 0, text: 'Hei {name}' },
        ],
      ),
    ).toEqual(['Hei {name}', 'Käytä {{code}}']);
    expect(arrayIntegrityError(['Hello {name}', 'Use {{code}}'], ['Hei {name}', 'Käytä {{code}}'])).toBeUndefined();
    expect(arrayIntegrityError(['Hello {name}', 'Use {{code}}'], ['Hei {{code}}', 'Käytä {name}'])).toBe(
      'Array item 0: Suggested text changed placeholders',
    );
  });
});
