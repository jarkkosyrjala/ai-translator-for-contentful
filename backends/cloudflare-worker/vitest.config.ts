import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    alias: { 'cloudflare:workers': fileURLToPath(new URL('./tests/stubs/cloudflare-workers.ts', import.meta.url)) },
  },
});
