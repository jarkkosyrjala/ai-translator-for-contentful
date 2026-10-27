import { describe, expect, it } from 'vitest';
import {
  backendPath,
  DEFAULT_LIMITS,
  estimatedOutputTokens,
  FUNCTION_LIMITS,
  parseLimits,
  parseModelChoices,
  parseModelSelection,
  parseTranslationSettings,
  resolveTranslationSettings,
  SOURCE_CHARACTER_PRESETS,
  TRANSLATION_DEFAULTS,
} from '../src';

describe('translation settings and limits', () => {
  it('applies defaults to unset properties and the transport preset to the request size', () => {
    expect(resolveTranslationSettings(undefined, SOURCE_CHARACTER_PRESETS.function)).toEqual({
      ...TRANSLATION_DEFAULTS,
      requestSourceCharacters: 10_000,
    });
    expect(resolveTranslationSettings({ outlineCharacters: 500, contextMaxFields: 0 }, 20_000)).toMatchObject({
      requestSourceCharacters: 20_000,
      outlineCharacters: 500,
      contextMaxFields: 0,
      maxWorkFields: 20,
      retrySizeFactor: 0.5,
    });
    expect(SOURCE_CHARACTER_PRESETS).toEqual({ custom: 20_000, function: 10_000 });
  });

  it('rejects non-integers, out-of-range values, unknown names and a retry factor outside (0, 1)', () => {
    expect(parseTranslationSettings({ requestSourceCharacters: 10_000, neighborCharacters: 0 })).toEqual({
      requestSourceCharacters: 10_000,
      neighborCharacters: 0,
    });
    for (const value of [
      { requestSourceCharacters: 0 },
      { requestSourceCharacters: 1.5 },
      { maxWorkFields: 0 },
      { contextFieldCharacters: -1 },
      { retrySizeFactor: 0 },
      { retrySizeFactor: 1 },
      { retrySizeFactor: Number.NaN },
      { longTextMode: 'split' },
      { modelCeiling: 5 },
      Object.fromEntries([['toString', 5]]),
      [],
    ])
      expect(() => parseTranslationSettings(value), JSON.stringify(value)).toThrow('invalid_translation_settings');
  });

  it('stores settings on saved model choices and rejects bare model IDs', () => {
    const saved = JSON.stringify([
      { model: 'a' },
      { model: 'b', translationSettings: { requestSourceCharacters: 5_000 } },
    ]);
    expect(parseModelChoices(saved)).toEqual([
      { model: 'a' },
      { model: 'b', translationSettings: { requestSourceCharacters: 5_000 } },
    ]);
    expect(parseModelSelection(saved, 'b')).toMatchObject({ models: ['a', 'b'], defaultModel: 'b' });
    expect(() => parseModelChoices('["a"]')).toThrow('invalid_model_list');
    expect(() =>
      parseModelChoices(JSON.stringify([{ model: 'a', translationSettings: { maxWorkFields: 0 } }])),
    ).toThrow('invalid_model_list');
  });

  it('keeps software ceilings within host maxima without clamping', () => {
    expect(parseLimits(undefined, DEFAULT_LIMITS, DEFAULT_LIMITS)).toEqual(DEFAULT_LIMITS);
    expect(parseLimits({ resultBytes: 1_000 }, DEFAULT_LIMITS, DEFAULT_LIMITS).resultBytes).toBe(1_000);
    expect(() => parseLimits({ resultBytes: DEFAULT_LIMITS.resultBytes + 1 }, DEFAULT_LIMITS, DEFAULT_LIMITS)).toThrow(
      'resultBytes',
    );
    expect(() => parseLimits({ pages: 1 }, DEFAULT_LIMITS, DEFAULT_LIMITS)).toThrow('pages');
    expect(() => parseLimits({ parserDepth: 0 }, DEFAULT_LIMITS, DEFAULT_LIMITS)).toThrow('parserDepth');
    expect(FUNCTION_LIMITS).toMatchObject({ requestBytes: 524_288, resultBytes: 524_288 });
  });

  it('estimates output with the documented planning assumptions', () => {
    expect([1_000, 10_000, 20_000, 50_000].map(estimatedOutputTokens)).toEqual([825, 8_250, 16_500, 41_250]);
  });
});

describe('backend path prefix', () => {
  it('normalizes the root and a trailing slash', () => {
    expect(backendPath('')).toBe('');
    expect(backendPath('/')).toBe('');
    expect(backendPath('/api/ai-translator')).toBe('/api/ai-translator');
    expect(backendPath('/api/ai-translator/')).toBe('/api/ai-translator');
    expect(backendPath('/v1.2/x_y~z')).toBe('/v1.2/x_y~z');
  });
  it('rejects relative, empty, dot, encoded, query and fragment paths', () => {
    for (const path of [
      'api',
      '//',
      '/api//translator',
      '/api/./translator',
      '/api/..',
      '/api/ai%2Dtranslator',
      '/api translator',
      '/api?x=1',
      '/api#x',
      '/api\\x',
    ])
      expect(backendPath(path)).toBeUndefined();
  });
});
