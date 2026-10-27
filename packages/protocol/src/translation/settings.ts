// Planner tuning per model choice, and the backend's software safety
// ceilings. Tuning defaults are not predictions of model capacity; actual
// host and Contentful quotas stay hard bounds that no setting can raise.

export type TranslationSettings = {
  requestSourceCharacters?: number;
  maxWorkFields?: number;
  contextMaxFields?: number;
  contextFieldCharacters?: number;
  contextTotalCharacters?: number;
  neighborCharacters?: number;
  outlineCharacters?: number;
  retrySizeFactor?: number;
};
export type ResolvedTranslationSettings = Required<TranslationSettings>;

// Source-character targets by transport: any Custom backend, or the
// Contentful Function, whose 30-second limit a slow model may need a lower
// target for. Administrators override them per model. Every field type except Short text splits above the target, so a
// target under 50,000 also splits the longest Long text values.
export const SOURCE_CHARACTER_PRESETS = { custom: 20_000, function: 10_000 } as const;

export const TRANSLATION_DEFAULTS: Omit<ResolvedTranslationSettings, 'requestSourceCharacters'> = {
  maxWorkFields: 20,
  contextMaxFields: 8,
  contextFieldCharacters: 2_000,
  contextTotalCharacters: 6_000,
  neighborCharacters: 2_000,
  outlineCharacters: 2_000,
  retrySizeFactor: 0.5,
};

// Upper bounds that keep a typo from producing an unusable plan. They are
// software sanity ceilings, not model-specific limits.
const integerSettings: Record<string, { min: number; max: number }> = {
  requestSourceCharacters: { min: 1, max: 200_000 },
  maxWorkFields: { min: 1, max: 200 },
  contextMaxFields: { min: 0, max: 64 },
  contextFieldCharacters: { min: 0, max: 200_000 },
  contextTotalCharacters: { min: 0, max: 200_000 },
  neighborCharacters: { min: 0, max: 50_000 },
  outlineCharacters: { min: 0, max: 50_000 },
};

/**
 * Validates saved settings. Unset properties use the defaults.
 * @throws Error `invalid_translation_settings` for unknown properties,
 *   non-integers, values out of range, or a retry factor outside (0, 1).
 */
export function parseTranslationSettings(value: unknown): TranslationSettings {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_translation_settings');
  const settings: TranslationSettings = {};
  for (const name of Object.keys(value)) {
    const item = (value as Record<string, unknown>)[name];
    if (name === 'retrySizeFactor') {
      if (typeof item !== 'number' || !Number.isFinite(item) || item <= 0 || item >= 1)
        throw new Error('invalid_translation_settings');
      settings.retrySizeFactor = item;
    } else {
      // An own property only: inherited names such as `toString` are unknown.
      const bounds = Object.hasOwn(integerSettings, name) ? integerSettings[name] : undefined;
      if (!bounds || typeof item !== 'number' || !Number.isInteger(item) || item < bounds.min || item > bounds.max)
        throw new Error('invalid_translation_settings');
      (settings as Record<string, number>)[name] = item;
    }
  }
  return settings;
}

export function resolveTranslationSettings(
  saved: TranslationSettings | undefined,
  requestSourceCharacters: number,
): ResolvedTranslationSettings {
  return { ...TRANSLATION_DEFAULTS, requestSourceCharacters, ...saved };
}

// Planning assumptions, not claims about a model: translated text 1.5 times
// the source, 10% markup and 2 output code points per token.
export const OUTPUT_TOKENS_PER_SOURCE_CHARACTER = 0.825;
export function estimatedOutputTokens(sourceCharacters: number): number {
  return Math.ceil(sourceCharacters * OUTPUT_TOKENS_PER_SOURCE_CHARACTER);
}

export type BackendLimits = {
  // The complete translation request the backend accepts, in UTF-8 bytes.
  requestBytes: number;
  // The complete provider HTTP body: messages, options, markup and escaping.
  providerBodyBytes: number;
  // Decoded generated content, independent of stream framing.
  generatedBytes: number;
  // The complete result JSON after canonical serialization.
  resultBytes: number;
  // Provider stream bytes on the wire, and one event.
  streamBytes: number;
  eventBytes: number;
  parserNodes: number;
  parserDepth: number;
};
export const MiB = 1_048_576;
export const DEFAULT_LIMITS: BackendLimits = {
  requestBytes: 2 * MiB,
  providerBodyBytes: 4 * MiB,
  generatedBytes: 2 * MiB,
  resultBytes: 4 * MiB,
  streamBytes: 64 * MiB,
  eventBytes: 256 * 1024,
  parserNodes: 100_000,
  parserDepth: 64,
};
// Conservative application defaults for the Contentful Function's App Action
// payloads; not claims about Contentful's quotas.
export const FUNCTION_LIMITS: BackendLimits = { ...DEFAULT_LIMITS, requestBytes: 512 * 1024, resultBytes: 512 * 1024 };
export const LIMIT_NAMES = Object.keys(DEFAULT_LIMITS) as (keyof BackendLimits)[];

// The limits a planner needs from the backend's current policy.
export type PlanningLimits = Pick<BackendLimits, 'requestBytes' | 'providerBodyBytes' | 'resultBytes'>;
export function planningLimits(limits: BackendLimits): PlanningLimits {
  return {
    requestBytes: limits.requestBytes,
    providerBodyBytes: limits.providerBodyBytes,
    resultBytes: limits.resultBytes,
  };
}

/**
 * Applies a deployer's `limits` object to the defaults. A value above the
 * host's hard maximum is rejected, never clamped.
 * @throws Error naming the first invalid property.
 */
export function parseLimits(value: unknown, defaults: BackendLimits, maxima: BackendLimits): BackendLimits {
  if (value === undefined) {
    for (const name of LIMIT_NAMES) if (defaults[name] > maxima[name]) throw new Error(name);
    return { ...defaults };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('limits');
  const limits = { ...defaults };
  for (const name of Object.keys(value)) {
    const item = (value as Record<string, unknown>)[name];
    if (!(LIMIT_NAMES as string[]).includes(name)) throw new Error(name);
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1) throw new Error(name);
    limits[name as keyof BackendLimits] = item;
  }
  for (const name of LIMIT_NAMES) if (limits[name] > maxima[name]) throw new Error(name);
  return limits;
}

export function validPlanningLimits(value: unknown): value is PlanningLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const names = ['requestBytes', 'providerBodyBytes', 'resultBytes'];
  return (
    Object.keys(value).length === names.length &&
    names.every(name => {
      const item = (value as Record<string, unknown>)[name];
      return typeof item === 'number' && Number.isInteger(item) && item > 0;
    })
  );
}
