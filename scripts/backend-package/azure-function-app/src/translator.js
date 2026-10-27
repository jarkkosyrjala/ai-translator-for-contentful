import { createAzureRelayHandler, relayMethods } from '@ai-translator-for-contentful/backend/azure';
import { pruneUsageGate, tableUsageGates } from '@ai-translator-for-contentful/backend/azure-tables';
import { TableClient } from '@azure/data-tables';
import { app } from '@azure/functions';

// The app's own settings, under names it chose. A deployed app would keep the
// secrets in Key Vault references and use a managed identity for the table.
const env = process.env;
const table = TableClient.fromConnectionString(env.TRANSLATOR_GATE_CONNECTION, 'translatorgate', {
  allowInsecureConnection: true,
});
const options = {
  config: JSON.parse(env.TRANSLATOR_CONFIG),
  secret: ref => env[ref],
  gateFor: tableUsageGates(table),
};
const prefix = `/${env.FIXTURE_ROUTE_PREFIX}`;

const translator = createAzureRelayHandler({ ...options, basePath: `${prefix}/ai-translator` });
app.http('contentfulTranslator', {
  route: 'ai-translator/{*relayPath}',
  methods: [...relayMethods],
  authLevel: 'anonymous',
  handler: translator,
});

// The same handler inside one of the app's own handlers.
const wrapped = createAzureRelayHandler({ ...options, basePath: `${prefix}/wrapped-translator` });
app.http('wrappedTranslator', {
  route: 'wrapped-translator/{*relayPath}',
  methods: [...relayMethods],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    context.log(JSON.stringify({ event: 'translator_request', path: new URL(request.url).pathname }));
    const response = await wrapped(request, context);
    return { ...response, headers: { ...response.headers, 'x-wrapped': 'true' } };
  },
});

// Behind a proxy that waits 60 seconds.
app.http('shortTranslator', {
  route: 'short-translator/{*relayPath}',
  methods: [...relayMethods],
  authLevel: 'anonymous',
  handler: createAzureRelayHandler({ ...options, basePath: `${prefix}/short-translator`, responseSeconds: 60 }),
});

// The app registers cleanup itself, under a name it chose.
app.timer('translatorGatePrune', {
  schedule: '0 17 3 * * *',
  handler: async (_timer, context) => {
    context.log(JSON.stringify({ event: 'translator_gate_pruned', rows: await pruneUsageGate(table) }));
  },
});
