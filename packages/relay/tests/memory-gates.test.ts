import { describeUsageGateConformance } from '@ai-translator-for-contentful/relay-conformance';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryGates } from '../src';

describeUsageGateConformance('process-local memory gates', () => createMemoryGates()('scope'));

describe('process-local memory gates', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps scopes apart and shares state between gates of one scope', () => {
    const gates = createMemoryGates();
    const later = Date.now() + 60_000;
    expect(gates('a').reserve('entry', 'r1', later)).toEqual({ ok: true });
    expect(gates('b').reserve('entry', 'r1', later)).toEqual({ ok: true });
    expect(gates('a').reserve('entry', 'r2', later)).toEqual({ ok: false, reason: 'concurrency_limit' });
    expect(gates('a').reserve('other', 'r1', later)).toEqual({ ok: false, reason: 'duplicate_request' });
    gates('a').release('r1');
    expect(gates('a').reserve('entry', 'r2', later)).toEqual({ ok: true });
    expect(createMemoryGates()('a').reserve('entry', 'r1', later)).toEqual({ ok: true });
  });

  it('ignores a release of an unknown or superseded request', () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T12:00:00Z') });
    const gate = createMemoryGates()('scope');
    expect(gate.reserve('entry', 'stuck', Date.now() + 1_000)).toEqual({ ok: true });
    vi.advanceTimersByTime(2_000);
    expect(gate.reserve('entry', 'next', Date.now() + 60_000)).toEqual({ ok: true });
    gate.release('stuck');
    gate.release('unknown');
    expect(gate.reserve('entry', 'third', Date.now() + 60_000)).toEqual({
      ok: false,
      reason: 'concurrency_limit',
    });
  });

  it('forgets request IDs a day after their reservation', () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T12:00:00Z') });
    const gates = createMemoryGates();
    const gate = gates('scope');
    expect(gate.reserve('entry', 'r1', Date.now() + 60_000)).toEqual({ ok: true });
    gate.release('r1');
    vi.advanceTimersByTime(86_399_000);
    expect(gate.reserve('entry', 'r1', Date.now() + 60_000)).toEqual({
      ok: false,
      reason: 'duplicate_request',
    });
    vi.advanceTimersByTime(1_000);
    expect(gates('another scope').reserve('entry', 'x', Date.now() + 60_000)).toEqual({ ok: true });
    expect(gate.reserve('entry', 'r1', Date.now() + 60_000)).toEqual({ ok: true });
  });
});
