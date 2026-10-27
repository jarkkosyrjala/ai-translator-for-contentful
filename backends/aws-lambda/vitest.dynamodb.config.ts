import { defineConfig } from 'vitest/config';

// DynamoDB Local integration tests, run with `pnpm test:dynamodb`. The default
// test run leaves them out because they need a running DynamoDB Local.
export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.integration.ts'] },
});
