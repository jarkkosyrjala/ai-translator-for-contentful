import { describe, expect, it } from 'vitest';
import { readRelaySettings } from '../src/settings';
import { usageGateStorage } from '../src/storage';

describe('relay settings from application settings', () => {
  it('reads RELAY_CONFIG, the mock flag, and trimmed secrets by ref', () => {
    const settings = readRelaySettings({
      RELAY_CONFIG: '{"appDefinitions":{}}',
      MOCK_TRANSLATION_ENABLED: ' true',
      APP_SIGNING: ` ${'a'.repeat(64)}\n`,
      MODEL_CREDENTIAL: '',
      FUNCTIONS_WORKER_RUNTIME: 'node',
    });
    expect(settings).toMatchObject({ config: '{"appDefinitions":{}}', mockTranslation: true });
    expect(settings.secret('APP_SIGNING')).toBe('a'.repeat(64));
    expect(settings.secret('MODEL_CREDENTIAL')).toBeUndefined();
    expect(readRelaySettings({}).mockTranslation).toBe(false);
  });
});

describe('usage gate storage', () => {
  it('is off until a table endpoint or connection string is set', () => {
    expect(usageGateStorage({})).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('uses the managed identity for an HTTPS table endpoint', () => {
    const storage = usageGateStorage({ USAGE_GATE_TABLE_ENDPOINT: 'https://account.table.core.windows.net/' });
    expect(storage.ok && storage.table.url).toBe('https://account.table.core.windows.net');
    expect(storage.ok && storage.table.tableName).toBe('usagegate');
  });

  it('rejects endpoints with another scheme, path, query, or credentials', () => {
    for (const endpoint of [
      'http://account.table.core.windows.net',
      'https://account.table.core.windows.net/usagegate',
      'https://account.table.core.windows.net/?sv=token',
      'https://user:pass@account.table.core.windows.net',
      'not a url',
    ])
      expect(usageGateStorage({ USAGE_GATE_TABLE_ENDPOINT: endpoint })).toEqual({
        ok: false,
        reason: 'invalid_endpoint',
      });
  });

  it('validates the table name', () => {
    expect(usageGateStorage({ USAGE_GATE_TABLE: 'usage-gate', USAGE_GATE_CONNECTION_STRING: 'x' })).toEqual({
      ok: false,
      reason: 'invalid_table_name',
    });
  });

  it('accepts a local Azurite connection string', () => {
    const storage = usageGateStorage({
      USAGE_GATE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
      USAGE_GATE_TABLE: 'gate',
    });
    expect(storage.ok && storage.table.tableName).toBe('gate');
  });
});
