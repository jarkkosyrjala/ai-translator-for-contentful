import {
  type AttributeValue,
  ConditionalCheckFailedException,
  type DynamoDBClient,
  GetItemCommand,
  TransactionCanceledException,
  TransactionConflictException,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { ActiveReservations, GateStore, Reservation } from './usage-gate';

// A request ID is remembered for a day to reject duplicates. DynamoDB's
// time to live deletes the item some time after `expiresAt` (epoch seconds).
const REQUEST_ID_RETENTION_SECONDS = 24 * 60 * 60;
const RELEASE_ATTEMPTS = 3;

type Item = Record<string, AttributeValue>;

function parseReservation(value: AttributeValue): Reservation {
  const entryId = value.M?.entryId?.S;
  const expires = Number(value.M?.expires?.N);
  if (!entryId || !Number.isSafeInteger(expires)) throw new Error('invalid_usage_gate_item');
  return { entryId, expires };
}

function parseInstallation(item: Item | undefined): { version: number; active: ActiveReservations } {
  if (!item) return { version: 0, active: new Map() };
  const version = Number(item.version?.N);
  const active = item.active?.M;
  if (!Number.isSafeInteger(version) || version < 1 || !active) throw new Error('invalid_usage_gate_item');
  return {
    version,
    active: new Map(Object.entries(active).map(([requestId, value]) => [requestId, parseReservation(value)])),
  };
}

function serializeActive(active: ActiveReservations): Record<string, AttributeValue> {
  return Object.fromEntries(
    [...active].map(([requestId, { entryId, expires }]) => [
      requestId,
      { M: { entryId: { S: entryId }, expires: { N: String(expires) } } },
    ]),
  );
}

// One table holds every verified scope: an App Definition, space, and
// environment. Each scope has one item with its active reservations and one
// item per request ID. Only Contentful entry IDs, request IDs, and times are
// stored.
export function createDynamoDbGateStore(client: DynamoDBClient, tableName: string, scope: string): GateStore {
  const installationKey: Item = { pk: { S: `installation#${scope}` } };
  const requestKey = (requestId: string): Item => ({ pk: { S: `request#${scope}#${requestId}` } });
  return {
    async read(requestId) {
      const [installation, request] = await Promise.all([
        client.send(new GetItemCommand({ TableName: tableName, Key: installationKey, ConsistentRead: true })),
        client.send(
          new GetItemCommand({
            TableName: tableName,
            Key: requestKey(requestId),
            ConsistentRead: true,
            ProjectionExpression: 'pk',
          }),
        ),
      ]);
      return { ...parseInstallation(installation.Item), seen: request.Item !== undefined };
    },

    async commit(requestId, expected, active, now) {
      const unchanged =
        expected === 0
          ? { ConditionExpression: 'attribute_not_exists(pk)' }
          : {
              ConditionExpression: '#version = :expected',
              ExpressionAttributeNames: { '#version': 'version' },
              ExpressionAttributeValues: { ':expected': { N: String(expected) } },
            };
      try {
        await client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: {
                    ...requestKey(requestId),
                    expiresAt: { N: String(Math.floor(now / 1000) + REQUEST_ID_RETENTION_SECONDS) },
                  },
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: {
                    ...installationKey,
                    version: { N: String(expected + 1) },
                    active: { M: serializeActive(active) },
                  },
                  ...unchanged,
                },
              },
            ],
          }),
        );
        return 'committed';
      } catch (error) {
        if (!(error instanceof TransactionCanceledException)) throw error;
        // Reasons follow the order of TransactItems.
        const [request, installation] = (error.CancellationReasons ?? []).map(reason => reason.Code);
        if (request === 'ConditionalCheckFailed') return 'duplicate';
        if (installation === 'ConditionalCheckFailed' || [request, installation].includes('TransactionConflict'))
          return 'conflict';
        throw error;
      }
    },

    async remove(requestId) {
      for (let attempt = 1; ; attempt++) {
        try {
          await client.send(
            new UpdateItemCommand({
              TableName: tableName,
              Key: installationKey,
              UpdateExpression: 'REMOVE #active.#request SET #version = #version + :one',
              ConditionExpression: 'attribute_exists(#active.#request)',
              ExpressionAttributeNames: { '#active': 'active', '#request': requestId, '#version': 'version' },
              ExpressionAttributeValues: { ':one': { N: '1' } },
            }),
          );
          return;
        } catch (error) {
          // Already released, or pruned after it expired.
          if (error instanceof ConditionalCheckFailedException) return;
          // A reservation transaction is writing the same item.
          if (!(error instanceof TransactionConflictException) || attempt >= RELEASE_ATTEMPTS) throw error;
        }
      }
    },
  };
}
