import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('./backends/cloudflare-worker/tests/stubs/cloudflare-workers.ts', import.meta.url),
      ),
    },
    projects: [
      'apps/*',
      'backends/*',
      'packages/*',
      { extends: true, test: { name: 'root', include: ['tests/**/*.test.{ts,tsx,mjs}'] } },
    ],
  },
});
