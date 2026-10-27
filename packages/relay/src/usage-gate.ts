export type ReservationResult = { ok: true } | { ok: false; reason: 'duplicate_request' | 'concurrency_limit' };

// Each host implements this port with its own storage. A gate coordinates one
// verified scope and keeps only request and entry IDs and times; source text,
// suggestions and user IDs never enter it.
export interface UsageGate {
  // `expiresAt` is the server-owned request deadline plus the cleanup margin,
  // in epoch milliseconds. An unreleased reservation lapses then.
  reserve(entryId: string, requestId: string, expiresAt: number): ReservationResult | Promise<ReservationResult>;
  release(requestId: string): void | Promise<void>;
}

// One active request per entry. Duplicate request IDs are rejected within
// the scope.
export const USAGE_POLICY = { entryActive: 1 } as const;

// How long a reserved request ID stays a duplicate, measured from its
// reservation and never by calendar day. It far outlasts the 60-second
// signature window, so a replayed signed request cannot pass again.
export const REQUEST_ID_RETENTION_MS = 86_400_000;

export type VerifiedScope = { appDefinitionId: string; spaceId: string; environmentId: string };

// A storage-safe name for one verified App Definition, space, and environment:
// the SHA-256 hex digest of their JSON array. Equal entry IDs in different
// scopes never contend.
export async function usageScope({ appDefinitionId, spaceId, environmentId }: VerifiedScope): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([appDefinitionId, spaceId, environmentId])),
  );
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
