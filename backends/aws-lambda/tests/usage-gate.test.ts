import { describeUsageGateConformance } from '@ai-translator-for-contentful/relay-conformance';
import { describe, expect, it, vi } from 'vitest';
import { type CommitResult, createUsageGate, type GateStore } from '../src/usage-gate';
import { createMemoryGateStore } from './function-url';

describeUsageGateConformance('AWS Lambda gate with an in-memory store', () => createUsageGate(createMemoryGateStore()));

describe('AWS Lambda usage gate concurrency', () => {
  it('rereads and retries when another reservation commits first', async () => {
    const store = createMemoryGateStore();
    const rival = createUsageGate(store);
    let raced = false;
    const racing: GateStore = {
      read: requestId => store.read(requestId),
      async commit(requestId, expected, active, now) {
        if (!raced) {
          raced = true;
          expect(await rival.reserve('entry-b', 'bob-1', Date.now() + 60_000)).toEqual({ ok: true });
        }
        return store.commit(requestId, expected, active, now);
      },
      remove: requestId => store.remove(requestId),
    };
    expect(await createUsageGate(racing).reserve('entry-a', 'alice-1', Date.now() + 60_000)).toEqual({
      ok: true,
    });
    expect(await rival.reserve('entry-a', 'carol-1', Date.now() + 60_000)).toEqual({
      ok: false,
      reason: 'concurrency_limit',
    });
  });

  it('reports persistent store contention without recording the request', async () => {
    const store = createMemoryGateStore();
    const commit = vi.fn(async (): Promise<CommitResult> => 'conflict');
    const gate = createUsageGate({ ...store, commit });
    await expect(gate.reserve('entry-a', 'r1', Date.now() + 60_000)).rejects.toThrow('usage_gate_contention');
    expect(commit).toHaveBeenCalledTimes(20);
    expect(await createUsageGate(store).reserve('entry-a', 'r1', Date.now() + 60_000)).toEqual({ ok: true });
  });
});
