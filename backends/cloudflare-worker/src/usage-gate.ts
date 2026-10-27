import { DurableObject } from 'cloudflare:workers';
import { REQUEST_ID_RETENTION_MS, type ReservationResult, USAGE_POLICY } from '@ai-translator-for-contentful/relay';

// One object coordinates one verified App Definition, space, and environment.
// Only request and entry IDs and times are retained; source text, suggestions
// and user IDs never enter it.
export class UsageGate extends DurableObject<object> {
  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, reserved INTEGER NOT NULL, expires INTEGER NOT NULL, active INTEGER NOT NULL)',
      );
      ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS reservations_reserved ON reservations (reserved)');
      ctx.storage.sql.exec(
        'CREATE INDEX IF NOT EXISTS reservations_entry_active ON reservations (entry_id, active, expires)',
      );
    });
  }

  reserve(entryId: string, requestId: string, expiresAt: number): ReservationResult {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    // A request ID stays a duplicate for the retention period after it was
    // reserved, and an unexpired reservation is never dropped.
    sql.exec('DELETE FROM reservations WHERE reserved < ? AND expires < ?', now - REQUEST_ID_RETENTION_MS, now);
    if (sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM reservations WHERE id = ?', requestId).one().n)
      return { ok: false, reason: 'duplicate_request' };
    if (
      sql
        .exec<{ n: number }>(
          'SELECT COUNT(*) AS n FROM reservations WHERE active = 1 AND expires > ? AND entry_id = ?',
          now,
          entryId,
        )
        .one().n >= USAGE_POLICY.entryActive
    )
      return { ok: false, reason: 'concurrency_limit' };
    sql.exec(
      'INSERT INTO reservations (id, entry_id, reserved, expires, active) VALUES (?, ?, ?, ?, 1)',
      requestId,
      entryId,
      now,
      expiresAt,
    );
    return { ok: true };
  }

  release(requestId: string): void {
    this.ctx.storage.sql.exec('UPDATE reservations SET active = 0 WHERE id = ?', requestId);
  }
}
