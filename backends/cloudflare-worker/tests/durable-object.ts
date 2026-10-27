import { DatabaseSync } from 'node:sqlite';
import { UsageGate } from '../src/usage-gate';

// Runs the UsageGate Durable Object against in-memory SQLite in Node tests.
export function durableObjectGate() {
  const db = new DatabaseSync(':memory:');
  const context = {
    storage: {
      sql: {
        exec(query: string, ...args: Array<string | number>) {
          const rows = db.prepare(query).all(...args);
          return Object.assign(rows, { one: () => rows[0] });
        },
      },
    },
    blockConcurrencyWhile(callback: () => Promise<void>) {
      return callback();
    },
  };
  const instance = new UsageGate(context as unknown as DurableObjectState, {});
  return {
    reserve: (entryId: string, requestId: string, expiresAt: number) => instance.reserve(entryId, requestId, expiresAt),
    release: (requestId: string) => instance.release(requestId),
    close: () => db.close(),
  };
}
