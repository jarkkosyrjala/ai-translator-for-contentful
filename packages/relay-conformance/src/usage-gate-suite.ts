import { describe, expect, it, vi } from 'vitest';
import type { ConformanceGate } from './fixtures';

export type DisposableGate = ConformanceGate & { close?(): void };

// Every host's usage gate must enforce the same policy as the reference gate.
export function describeUsageGateConformance(name: string, createGate: () => DisposableGate): void {
  // Reservations in these cases last a minute unless a case sets otherwise.
  const later = () => Date.now() + 60_000;
  describe(`usage gate conformance: ${name}`, () => {
    it('rejects duplicate IDs and one active request per entry while allowing other entries', async () => {
      const gate = createGate();
      try {
        expect(await gate.reserve('entry-a', 'r1', later())).toEqual({ ok: true });
        expect(await gate.reserve('entry-b', 'r1', later())).toEqual({
          ok: false,
          reason: 'duplicate_request',
        });
        expect(await gate.reserve('entry-a', 'r2', later())).toEqual({
          ok: false,
          reason: 'concurrency_limit',
        });
        expect(await gate.reserve('entry-a', 'r3', later())).toEqual({ ok: false, reason: 'concurrency_limit' });
        for (let i = 0; i < 5; i++)
          expect(await gate.reserve(`entry-${i}`, `other-${i}`, later())).toEqual({
            ok: true,
          });
        await gate.release('r1');
        expect(await gate.reserve('entry-a', 'r4', later())).toEqual({ ok: true });
      } finally {
        gate.close?.();
      }
    });
    it('has no daily budget once earlier requests finish', async () => {
      const gate = createGate();
      try {
        for (let i = 0; i < 150; i++) {
          expect(await gate.reserve('entry-a', `r${i}`, later())).toEqual({ ok: true });
          await gate.release(`r${i}`);
        }
        expect(await gate.reserve('entry-a', 'r0', later())).toEqual({
          ok: false,
          reason: 'duplicate_request',
        });
      } finally {
        gate.close?.();
      }
    });
    it('keeps a released request ID a duplicate across midnight', async () => {
      vi.useFakeTimers({ now: new Date('2026-01-01T23:59:49Z') });
      const gate = createGate();
      try {
        expect(await gate.reserve('entry-a', 'late', Date.now() + 15_000)).toEqual({ ok: true });
        await gate.release('late');
        vi.advanceTimersByTime(16_000);
        expect(await gate.reserve('entry-b', 'next', later())).toEqual({ ok: true });
        expect(await gate.reserve('entry-a', 'late', later())).toEqual({ ok: false, reason: 'duplicate_request' });
      } finally {
        gate.close?.();
        vi.useRealTimers();
      }
    });
    it('expires an unreleased reservation at its server-owned expiry', async () => {
      vi.useFakeTimers({ now: new Date('2026-01-01T12:00:00Z') });
      const gate = createGate();
      try {
        expect(await gate.reserve('entry-a', 'stuck', Date.now() + 45_000)).toEqual({ ok: true });
        vi.advanceTimersByTime(44_000);
        expect(await gate.reserve('entry-a', 'next', later())).toEqual({
          ok: false,
          reason: 'concurrency_limit',
        });
        vi.advanceTimersByTime(2_000);
        expect(await gate.reserve('entry-a', 'next', later())).toEqual({ ok: true });
        expect(await gate.reserve('entry-a', 'stuck', later())).toEqual({
          ok: false,
          reason: 'duplicate_request',
        });
      } finally {
        gate.close?.();
        vi.useRealTimers();
      }
    });
  });
}
