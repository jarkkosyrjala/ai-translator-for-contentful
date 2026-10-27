import { REQUEST_ID_RETENTION_MS, type ReservationResult, type UsageGate } from './usage-gate';

// How often every scope is pruned and empty scopes are dropped.
const SWEEP_INTERVAL_MS = 60_000;

type ScopeState = {
  // Entry ID to its active request, until release or expiry.
  active: Map<string, { requestId: string; expires: number }>;
  // Request ID to its entry and the time it stops being a duplicate, oldest first.
  requests: Map<string, { entryId: string; retainUntil: number }>;
};

function prune(state: ScopeState, time: number): void {
  for (const [entryId, request] of state.active) if (request.expires <= time) state.active.delete(entryId);
  for (const [requestId, request] of state.requests) {
    if (request.retainUntil > time) break;
    state.requests.delete(requestId);
  }
}

/**
 * Usage gates for one long-running process: one active request per entry,
 * and a reused request ID is rejected for a day, as the shared gates do.
 * State lasts as long as the process. Several processes or instances need a
 * shared gate instead.
 */
export function createMemoryGates(): (scope: string) => UsageGate {
  const scopes = new Map<string, ScopeState>();
  let swept = 0;
  function sweep(time: number): void {
    if (time - swept < SWEEP_INTERVAL_MS) return;
    swept = time;
    for (const [scope, state] of scopes) {
      prune(state, time);
      if (!state.active.size && !state.requests.size) scopes.delete(scope);
    }
  }
  return scope => ({
    reserve(entryId: string, requestId: string, expiresAt: number): ReservationResult {
      const time = Date.now();
      sweep(time);
      let state = scopes.get(scope);
      if (!state) {
        state = { active: new Map(), requests: new Map() };
        scopes.set(scope, state);
      }
      prune(state, time);
      if (state.requests.has(requestId)) return { ok: false, reason: 'duplicate_request' };
      if (state.active.has(entryId)) return { ok: false, reason: 'concurrency_limit' };
      state.active.set(entryId, { requestId, expires: expiresAt });
      state.requests.set(requestId, { entryId, retainUntil: Math.max(expiresAt, time + REQUEST_ID_RETENTION_MS) });
      return { ok: true };
    },
    release(requestId: string): void {
      const state = scopes.get(scope);
      const request = state?.requests.get(requestId);
      if (state && request && state.active.get(request.entryId)?.requestId === requestId)
        state.active.delete(request.entryId);
    },
  });
}
