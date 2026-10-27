import { createAzureRelayHandler, relayMethods } from '@ai-translator-for-contentful/backend/azure';
import { pruneUsageGate, tableUsageGates } from '@ai-translator-for-contentful/backend/azure-tables';
import { app } from '@azure/functions';
import { readRelaySettings } from './settings';
import { usageGateStorage } from './storage';

app.setup({ enableHttpStream: true });

const storage = usageGateStorage(process.env);
if (!storage.ok && storage.reason !== 'not_configured')
  console.error(JSON.stringify({ event: 'usage_gate_misconfigured', reason: storage.reason }));

// host.json removes the `api` route prefix, so the relay serves /v1/health and
// /v1/translate at the root. The relay authenticates each request with its
// Contentful signature; Functions access keys would need a query string or a
// header the app frontend cannot keep secret. An invalid RELAY_CONFIG is
// logged by property path when the handler is created.
app.http('relay', {
  route: '{*path}',
  methods: [...relayMethods],
  authLevel: 'anonymous',
  handler: createAzureRelayHandler({
    ...readRelaySettings(process.env),
    gateFor: storage.ok ? tableUsageGates(storage.table) : undefined,
  }),
});

if (storage.ok) {
  const { table } = storage;
  app.timer('pruneUsageGate', {
    // Daily at 03:17 UTC. Flex Consumption runs timers in UTC.
    schedule: '0 17 3 * * *',
    handler: async (_timer, context) => {
      context.log(JSON.stringify({ event: 'usage_gate_pruned', rows: await pruneUsageGate(table) }));
    },
  });
}
