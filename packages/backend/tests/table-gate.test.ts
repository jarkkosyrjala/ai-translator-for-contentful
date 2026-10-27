import { describeUsageGateConformance } from '@ai-translator-for-contentful/relay-conformance';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pruneUsageGate, tableUsageGates } from '../src/azure/table-gate';
import { type Azurite, startAzurite } from './azurite';

let azurite: Azurite;
let tables = 0;
// A fresh table per gate keeps the shared conformance cases independent.
const freshTable = () => azurite.table(`gate${++tables}`);

beforeAll(async () => {
  azurite = await startAzurite();
});
afterAll(async () => {
  await azurite.stop();
});

describeUsageGateConformance('Azure Table Storage gate on Azurite', () =>
  tableUsageGates(freshTable())('space:master'),
);

describe('Azure Table Storage gate', () => {
  it('admits concurrent editors on distinct entries across instances', async () => {
    const table = freshTable();
    const instances = [1, 2, 3].map(() => tableUsageGates(table)('space:master'));
    const results = await Promise.all(
      instances.map((gate, index) => gate.reserve(`entry${index}`, `request${index}`, Date.now() + 60_000)),
    );
    expect(results).toEqual(Array.from({ length: 3 }, () => ({ ok: true })));
  });

  it('accepts one of two concurrent reservations with the same request ID', async () => {
    const table = freshTable();
    const [first, second] = [1, 2].map(() => tableUsageGates(table)('space:master'));
    const results = await Promise.all([
      first.reserve('entry-a', 'same', Date.now() + 60_000),
      second.reserve('entry-b', 'same', Date.now() + 60_000),
    ]);
    expect(results).toContainEqual({ ok: true });
    expect(results).toContainEqual({ ok: false, reason: 'duplicate_request' });
  });

  it('keeps space environments apart', async () => {
    const table = freshTable();
    const master = tableUsageGates(table)('space:master');
    const staging = tableUsageGates(table)('space:staging');
    expect(await master.reserve('entry-a', 'r1', Date.now() + 60_000)).toEqual({ ok: true });
    expect(await staging.reserve('entry-a', 'r1', Date.now() + 60_000)).toEqual({ ok: true });
  });

  it('stores request IDs with characters that table keys reject', async () => {
    const gate = tableUsageGates(freshTable())('space:master');
    expect(await gate.reserve('entry-a', 'a/b\\c#d?e\u0001', Date.now() + 60_000)).toEqual({ ok: true });
    expect(await gate.reserve('entry-b', 'a/b\\c#d?e\u0001', Date.now() + 60_000)).toEqual({
      ok: false,
      reason: 'duplicate_request',
    });
  });

  it('prunes request rows reserved more than a day ago in every scope', async () => {
    const table = freshTable();
    const day = Date.parse('2026-01-01T12:00:00Z');
    let now = day;
    const gates = tableUsageGates(table, () => now);
    const [master, staging] = [gates('scope-master'), gates('scope-staging')];
    for (const id of ['old1', 'old2']) {
      expect(await master.reserve('entry-a', id, Date.now() + 60_000)).toEqual({ ok: true });
      await master.release(id);
    }
    expect(await staging.reserve('entry-a', 'other', Date.now() + 60_000)).toEqual({ ok: true });
    now = day + 86_400_000;
    expect(await master.reserve('entry-a', 'today', Date.now() + 60_000)).toEqual({ ok: true });
    expect(await pruneUsageGate(table, now)).toBe(0);
    now += 1;
    expect(await pruneUsageGate(table, now)).toBe(3);
    expect(await master.reserve('entry-b', 'old1', Date.now() + 60_000)).toEqual({ ok: true });
    expect(await master.reserve('entry-c', 'today', Date.now() + 60_000)).toEqual({
      ok: false,
      reason: 'duplicate_request',
    });
    expect(await staging.reserve('entry-b', 'other', Date.now() + 60_000)).toEqual({ ok: true });
  });

  it('keeps a request ID reserved just before midnight while its signature can still be replayed', async () => {
    const table = freshTable();
    let now = Date.parse('2026-01-01T23:59:59Z');
    const gate = tableUsageGates(table, () => now)('scope-master');
    expect(await gate.reserve('entry-a', 'late', now + 15_000)).toEqual({ ok: true });
    await gate.release('late');
    now += 30_000;
    expect(await pruneUsageGate(table, now)).toBe(0);
    expect(await gate.reserve('entry-a', 'late', now + 15_000)).toEqual({ ok: false, reason: 'duplicate_request' });
  });

  it('prunes more rows than one transaction holds, grouped by partition', async () => {
    const table = freshTable();
    await table.createTable();
    const rows = [
      ...Array.from({ length: 150 }, (_, index) => ({ partitionKey: 'scope-a', index })),
      ...Array.from({ length: 3 }, (_, index) => ({ partitionKey: 'scope-b', index })),
    ];
    for (const { partitionKey, index } of rows)
      await table.createEntity({
        partitionKey,
        rowKey: `request-${String(index).padStart(64, '0')}`,
        reserved: Date.parse('2026-01-01T00:00:00Z'),
      });
    await table.createEntity({ partitionKey: 'scope-a', rowKey: 'gate', active: '[]' });
    expect(await pruneUsageGate(table, Date.parse('2026-01-02T00:00:01Z'))).toBe(153);
    const left = [];
    for await (const row of table.listEntities()) left.push(row.rowKey);
    expect(left).toEqual(['gate']);
  });
});
