import { REQUEST_ID_RETENTION_MS, type ReservationResult, type UsageGate } from '@ai-translator-for-contentful/relay';
import { odata, RestError, type TableClient, type TransactionAction } from '@azure/data-tables';

// One partition per verified App Definition, space, and environment scope holds
// a `gate` row with the active reservations and one row per recent request ID,
// so a reservation is one atomic entity group transaction. Only hashed request
// IDs, Contentful entry IDs, and times are retained; source text, suggestions
// and user IDs never enter it.
const GATE_ROW = 'gate';
const REQUEST_PREFIX = 'request-';
// The first key after every `request-…` key: `.` follows `-` in code point order.
const REQUEST_END = 'request.';
// Optimistic concurrency: a conflicting write makes the transaction fail with
// 409 or 412, and the gate waits briefly, re-reads and tries again.
const MAX_ATTEMPTS = 8;
const BACKOFF_MS = 25;

type Reservation = { id: string; entry: string; expires: number };
type GateEntity = { active: string };
// `reserved` is the reservation time in epoch milliseconds.
type RequestEntity = { reserved: number };
type GateState = { active: Reservation[]; etag?: string };

function isReservation(value: unknown): value is Reservation {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'entry' in value &&
    typeof value.entry === 'string' &&
    'expires' in value &&
    typeof value.expires === 'number'
  );
}

function parseActive(json: string): Reservation[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || !parsed.every(isReservation)) throw new Error('usage_gate_corrupt');
  return parsed;
}

const isStatus = (error: unknown, ...codes: number[]) =>
  error instanceof RestError && error.statusCode !== undefined && codes.includes(error.statusCode);

// A random wait that grows with each attempt, so contending instances spread out.
const backoff = (attempt: number) =>
  new Promise(resolve => setTimeout(resolve, Math.random() * BACKOFF_MS * (attempt + 1)));

// Request IDs are editor-supplied strings of up to 100 characters. Table keys
// must not contain `/`, `\`, `#`, `?`, or control characters, so store a digest.
async function requestKey(requestId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(requestId));
  return REQUEST_PREFIX + Buffer.from(digest).toString('hex');
}

/**
 * Usage gates for every scope in one table that the caller's client names.
 * Every instance serving this backend uses the same table; reserve it for
 * these rows. The table is created on first use, never at import.
 */
export function tableUsageGates(table: TableClient, now = () => Date.now()): (scope: string) => UsageGate {
  let ready: Promise<void> | undefined;
  // createTable succeeds when the table already exists. Retry after a failure.
  const ensureTable = () =>
    (ready ??= table.createTable().catch((error: unknown) => {
      ready = undefined;
      throw error;
    }));
  return scope => scopeGate(table, scope, now, ensureTable);
}

function scopeGate(table: TableClient, scope: string, now: () => number, ensureTable: () => Promise<void>): UsageGate {
  async function readGate(): Promise<GateState> {
    try {
      const entity = await table.getEntity<GateEntity>(scope, GATE_ROW);
      return { active: parseActive(entity.active), etag: entity.etag };
    } catch (error) {
      if (isStatus(error, 404)) return { active: [] };
      throw error;
    }
  }

  async function seen(rowKey: string): Promise<boolean> {
    try {
      await table.getEntity<RequestEntity>(scope, rowKey);
      return true;
    } catch (error) {
      if (isStatus(error, 404)) return false;
      throw error;
    }
  }

  const gateEntity = (active: Reservation[]) => ({
    partitionKey: scope,
    rowKey: GATE_ROW,
    active: JSON.stringify(active),
  });

  return {
    async reserve(entryId: string, requestId: string, expiresAt: number): Promise<ReservationResult> {
      await ensureTable();
      const rowKey = await requestKey(requestId);
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt) await backoff(attempt);
        const [gate, duplicate] = await Promise.all([readGate(), seen(rowKey)]);
        if (duplicate) return { ok: false, reason: 'duplicate_request' };
        const time = now();
        const active = gate.active.filter(reservation => reservation.expires > time);
        if (active.some(reservation => reservation.entry === entryId))
          return { ok: false, reason: 'concurrency_limit' };
        const next = gateEntity([...active, { id: rowKey, entry: entryId, expires: expiresAt }]);
        const actions: TransactionAction[] = [
          ['create', { partitionKey: scope, rowKey, reserved: time }],
          gate.etag ? ['update', next, 'Replace', { etag: gate.etag }] : ['create', next],
        ];
        try {
          await table.submitTransaction(actions);
          return { ok: true };
        } catch (error) {
          // Another reservation changed the gate, or the same request ID won a race.
          if (!isStatus(error, 409, 412)) throw error;
        }
      }
      throw new Error('usage_gate_contention');
    },

    async release(requestId: string): Promise<void> {
      await ensureTable();
      const rowKey = await requestKey(requestId);
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt) await backoff(attempt);
        const gate = await readGate();
        if (!gate.etag || !gate.active.some(reservation => reservation.id === rowKey)) return;
        const time = now();
        const active = gate.active.filter(reservation => reservation.id !== rowKey && reservation.expires > time);
        try {
          await table.updateEntity(gateEntity(active), 'Replace', { etag: gate.etag });
          return;
        } catch (error) {
          if (!isStatus(error, 412)) throw error;
        }
      }
      throw new Error('usage_gate_contention');
    },
  };
}

// Deletes request rows reserved more than a day ago in every scope partition,
// as the Cloudflare gate does, and returns how many. Duplicate detection must
// outlast the 60-second signature window by a wide margin. Abandoned active
// reservations lapse at their own expiry instead. Run it from a timer or job
// you register.
export async function pruneUsageGate(table: TableClient, now = Date.now()): Promise<number> {
  const stale = new Map<string, string[]>();
  const rows = table.listEntities<RequestEntity>({
    queryOptions: {
      filter: odata`RowKey gt ${REQUEST_PREFIX} and RowKey lt ${REQUEST_END} and reserved lt ${now - REQUEST_ID_RETENTION_MS}`,
    },
  });
  for await (const row of rows)
    if (row.partitionKey && row.rowKey)
      stale.set(row.partitionKey, [...(stale.get(row.partitionKey) ?? []), row.rowKey]);
  let deleted = 0;
  // An entity group transaction covers one partition and at most 100 operations.
  for (const [partitionKey, rowKeys] of stale)
    for (let start = 0; start < rowKeys.length; start += 100) {
      const batch = rowKeys.slice(start, start + 100);
      await table.submitTransaction(batch.map((rowKey): TransactionAction => ['delete', { partitionKey, rowKey }]));
      deleted += batch.length;
    }
  return deleted;
}
