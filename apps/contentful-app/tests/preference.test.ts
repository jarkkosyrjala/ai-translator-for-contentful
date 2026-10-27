import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initialChoice,
  initialTargets,
  readPreference,
  readTargetPreference,
  savePreference,
  saveTargetPreference,
} from '../src/app/preference';

afterEach(() => vi.unstubAllGlobals());

describe('target language defaults', () => {
  it('automatically chooses the other language in a two-language space', () => {
    expect(initialTargets(['en', 'fi'], 'en', [])).toEqual(['fi']);
    expect(initialTargets(['en', 'fi'], 'fi', ['fi'])).toEqual(['en']);
  });

  it('uses only available saved targets in a multilingual space', () => {
    expect(initialTargets(['en', 'fi', 'sv'], 'en', ['sv', 'en', 'de'])).toEqual(['sv']);
  });

  it('round trips selected targets and ignores malformed saved data', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    });
    expect(saveTargetPreference('targets', ['fi', 'sv'])).toBe(true);
    expect(readTargetPreference('targets')).toEqual({ available: true, value: ['fi', 'sv'] });
    values.set('targets', '{bad json');
    expect(readTargetPreference('targets')).toEqual({ available: true, value: [] });
  });
});

describe('provider and model default', () => {
  const choices = [{ key: '["primary"]' }, { key: '["Admin","chat-small"]' }];
  it('starts with the saved choice only while the installation still offers it', () => {
    expect(initialChoice(choices, '["primary"]', '["Admin","chat-small"]')).toBe('["Admin","chat-small"]');
    expect(initialChoice(choices, '["primary"]', '["Admin","removed"]')).toBe('["primary"]');
    expect(initialChoice(choices, '["primary"]', null)).toBe('["primary"]');
  });
  it('saves the choice and reports unavailable storage', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    });
    expect(savePreference('choice', '["Admin","chat-small"]')).toBe(true);
    expect(readPreference('choice')).toEqual({ available: true, value: '["Admin","chat-small"]' });
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readPreference('choice')).toEqual({ available: false, value: null });
    expect(savePreference('choice', 'x')).toBe(false);
  });
});
