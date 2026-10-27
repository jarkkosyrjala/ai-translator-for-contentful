import type { ReservationResult, UsageGate } from '@ai-translator-for-contentful/relay';

export type Reservation = { entryId: string; expires: number };
export type ActiveReservations = ReadonlyMap<string, Reservation>;

// The installation's active reservations and a version that changes on every
// write. Version 0 means nothing is stored yet.
export type GateSnapshot = { version: number; active: ActiveReservations; seen: boolean };
export type CommitResult = 'committed' | 'duplicate' | 'conflict';

// Storage for one installation's gate. `commit` must atomically record the
// request ID, failing as `duplicate` if it was seen before, and replace the
// active reservations only while the version still equals `expected`.
export interface GateStore {
  read(requestId: string): Promise<GateSnapshot>;
  commit(requestId: string, expected: number, active: ActiveReservations, now: number): Promise<CommitResult>;
  remove(requestId: string): Promise<void>;
}

// Rereads and retries when concurrent reservations change the installation
// between the read and the conditional write.
const COMMIT_ATTEMPTS = 20;

// Applies the relay's usage policy with optimistic concurrency, so any store
// with conditional writes can coordinate Lambda instances.
export function createUsageGate(store: GateStore): UsageGate {
  return {
    async reserve(entryId: string, requestId: string, expiresAt: number): Promise<ReservationResult> {
      for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
        const now = Date.now();
        const snapshot = await store.read(requestId);
        if (snapshot.seen) return { ok: false, reason: 'duplicate_request' };
        const active = new Map([...snapshot.active].filter(([, reservation]) => reservation.expires > now));
        if ([...active.values()].some(reservation => reservation.entryId === entryId))
          return { ok: false, reason: 'concurrency_limit' };
        active.set(requestId, { entryId, expires: expiresAt });
        const result = await store.commit(requestId, snapshot.version, active, now);
        if (result === 'committed') return { ok: true };
        if (result === 'duplicate') return { ok: false, reason: 'duplicate_request' };
      }
      // Store contention is an infrastructure failure, not an entry limit.
      throw new Error('usage_gate_contention');
    },
    release: requestId => store.remove(requestId),
  };
}
