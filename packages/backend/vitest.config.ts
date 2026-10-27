import { defineConfig } from 'vitest/config';

// The usage-gate tests run against Azurite in a child process.
export default defineConfig({ test: { environment: 'node', testTimeout: 30_000, hookTimeout: 30_000 } });
