import { TableClient } from '@azure/data-tables';
import { ManagedIdentityCredential } from '@azure/identity';
import type { Environment } from './settings';

export type UsageGateStorage =
  | { ok: true; table: TableClient }
  | { ok: false; reason: 'not_configured' | 'invalid_endpoint' | 'invalid_table_name' };

const DEFAULT_TABLE = 'usagegate';
// Azure Table names: 3–63 alphanumeric characters, starting with a letter.
const tableName = /^[A-Za-z][A-Za-z0-9]{2,62}$/;
const localEndpoint = /(?:^|;)\s*(?:UseDevelopmentStorage=true|TableEndpoint=http:\/\/(?:127\.0\.0\.1|localhost)[:/])/i;

function tableEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

// In Azure, the usage gate uses the Function App's managed identity, which
// needs Storage Table Data Contributor on the account. A connection string is
// for local development against Azurite.
export function usageGateStorage(env: Environment): UsageGateStorage {
  const name = env.USAGE_GATE_TABLE?.trim() || DEFAULT_TABLE;
  if (!tableName.test(name)) return { ok: false, reason: 'invalid_table_name' };
  const endpoint = env.USAGE_GATE_TABLE_ENDPOINT?.trim();
  if (endpoint) {
    const origin = tableEndpoint(endpoint);
    if (!origin) return { ok: false, reason: 'invalid_endpoint' };
    const clientId = env.USAGE_GATE_CLIENT_ID?.trim();
    // Without a client ID, the system-assigned identity is used.
    const credential = clientId ? new ManagedIdentityCredential({ clientId }) : new ManagedIdentityCredential();
    return { ok: true, table: new TableClient(origin, name, credential) };
  }
  const connection = env.USAGE_GATE_CONNECTION_STRING?.trim();
  if (connection)
    return {
      ok: true,
      table: TableClient.fromConnectionString(connection, name, {
        allowInsecureConnection: localEndpoint.test(connection),
      }),
    };
  return { ok: false, reason: 'not_configured' };
}
