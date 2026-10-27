import { randomUUID } from 'node:crypto';
import {
  completion,
  conformanceScope,
  describeUsageGateConformance,
  envelope,
  relayConfig,
  relaySecrets,
  signRequest,
  translationRequest,
} from '@ai-translator-for-contentful/relay-conformance';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  GetItemCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDynamoDbGateStore } from '../src/dynamodb-store';
import { createEnvironmentHandler } from '../src/handler';
import { createUsageGate } from '../src/usage-gate';
import { toEvent, toResponse } from './function-url';

// Runs the usage gate against DynamoDB Local, for conditional-write and
// transaction behavior an in-memory store cannot prove:
// docker run --rm -p 8000:8000 amazon/dynamodb-local:3.3.2
// DYNAMODB_ENDPOINT=http://localhost:8000 pnpm test:dynamodb

const endpoint = process.env.DYNAMODB_ENDPOINT;
if (!endpoint) throw new Error('Set DYNAMODB_ENDPOINT to a DynamoDB Local URL, for example http://localhost:8000.');

const client = new DynamoDBClient({
  endpoint,
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const tableName = `usage-gate-${randomUUID()}`;
await client.send(
  new CreateTableCommand({
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  }),
);
await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
afterAll(() => client.send(new DeleteTableCommand({ TableName: tableName })));

const gate = (scope: string = randomUUID()) => createUsageGate(createDynamoDbGateStore(client, tableName, scope));

describeUsageGateConformance('AWS Lambda gate with DynamoDB', () => gate());

describe('AWS Lambda DynamoDB usage gate store', () => {
  it('admits many simultaneous reservations for distinct entries', async () => {
    const shared = gate();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => shared.reserve(`entry-${i}`, `r-${i}`, Date.now() + 60_000)),
    );
    expect(results).toEqual(Array.from({ length: 8 }, () => ({ ok: true })));
  });

  it('keeps installations in one table apart and ignores an unknown release', async () => {
    const first = gate('space-a:master');
    const second = gate('space-b:master');
    expect(await first.reserve('entry-a', 'shared-id', Date.now() + 60_000)).toEqual({ ok: true });
    expect(await second.reserve('entry-a', 'shared-id', Date.now() + 60_000)).toEqual({ ok: true });
    await expect(second.release('never-reserved')).resolves.toBeUndefined();
  });

  it('wires the gate from the function environment for the verified scope', async () => {
    const fetcher = vi.fn(async () => completion('Hei'));
    vi.stubGlobal('fetch', fetcher);
    try {
      const { handler } = createEnvironmentHandler(
        {
          RELAY_CONFIG: JSON.stringify(relayConfig()),
          RELAY_SECRET_ID: 'example-secret',
          USAGE_TABLE_NAME: tableName,
          FUNCTION_TIMEOUT_SECONDS: '900',
        },
        {
          dynamodb: client,
          getSecret: async secretId => (secretId === 'example-secret' ? JSON.stringify(relaySecrets) : undefined),
        },
      );
      const requestId = randomUUID();
      const payload = envelope(translationRequest({ requestId }));
      const response = toResponse(await handler(await toEvent(await signRequest({}, payload, '/v1/translate'))));
      expect(response.status).toBe(200);
      expect(fetcher).toHaveBeenCalledOnce();
      const scope = await conformanceScope('app', 'space', 'master');
      const installation = await client.send(
        new GetItemCommand({ TableName: tableName, Key: { pk: { S: `installation#${scope}` } } }),
      );
      expect(installation.Item?.active?.M).toEqual({});
      const request = await client.send(
        new GetItemCommand({ TableName: tableName, Key: { pk: { S: `request#${scope}#${requestId}` } } }),
      );
      expect(Number(request.Item?.expiresAt?.N)).toBeGreaterThan(Date.now() / 1000);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
