import type { ConformanceGate } from './fixtures';

// In-memory reference gate: one active request per entry until release or
// its expiry, duplicate request IDs rejected.
export function createMemoryUsageGate(now: () => number = Date.now): ConformanceGate {
  const requests = new Map<string, { entryId: string; expires: number; active: boolean }>();
  return {
    reserve(entryId, requestId, expiresAt) {
      const time = now();
      if (requests.has(requestId)) return { ok: false, reason: 'duplicate_request' };
      const active = [...requests.values()].filter(request => request.active && request.expires > time);
      if (active.some(request => request.entryId === entryId)) return { ok: false, reason: 'concurrency_limit' };
      requests.set(requestId, { entryId, expires: expiresAt, active: true });
      return { ok: true };
    },
    release(requestId) {
      const request = requests.get(requestId);
      if (request) request.active = false;
    },
  };
}
