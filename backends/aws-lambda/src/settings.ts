import { validSecretRef } from '@ai-translator-for-contentful/relay';

export type Environment = Readonly<Record<string, string | undefined>>;
// Secret values by the refs that RELAY_CONFIG names.
export type SecretValues = Readonly<Record<string, string>>;

// Environment variables the function reads besides RELAY_CONFIG and
// MOCK_TRANSLATION_ENABLED. A secret ref must not reuse one of them.
export const LAMBDA_SETTINGS: readonly string[] = ['RELAY_SECRET_ID', 'USAGE_TABLE_NAME', 'FUNCTION_TIMEOUT_SECONDS'];

// Lambda does not tell a function its own timeout, so the template passes the
// same value. Provider deadlines stay 10 seconds below it.
export function functionTimeoutSeconds(environment: Environment): number | undefined {
  const value = environment.FUNCTION_TIMEOUT_SECONDS;
  const seconds = value && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return seconds >= 60 && seconds <= 900 ? seconds : undefined;
}

export class SecretFormatError extends Error {
  constructor(readonly code: 'not_json' | 'not_object' | 'unexpected_key' | 'not_string') {
    super(code);
  }
}

// The Secrets Manager secret is one JSON object of secret refs to strings:
// Contentful signing secrets, provider credentials, and provider header JSON.
// Anything else is rejected whole, so a misplaced setting is reported, not
// ignored.
export function parseSecretValues(text: string | undefined): SecretValues {
  if (text === undefined || text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SecretFormatError('not_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SecretFormatError('not_object');
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!validSecretRef(name, LAMBDA_SETTINGS)) throw new SecretFormatError('unexpected_key');
    if (typeof value !== 'string') throw new SecretFormatError('not_string');
    values[name] = value;
  }
  return values;
}
