import {
  type AzureRelayHandlerOptions,
  createAzureRelayHandler,
  relayMethods,
} from '@ai-translator-for-contentful/backend/azure';
import { pruneUsageGate, tableUsageGates } from '@ai-translator-for-contentful/backend/azure-tables';
import { TableClient } from '@azure/data-tables';
import { app, type HttpRequest, type InvocationContext } from '@azure/functions';

// The Azure entry points' declarations against the app's own Azure SDKs.
const table = TableClient.fromConnectionString('UseDevelopmentStorage=true', 'translatorgate');
const options: AzureRelayHandlerOptions = {
  config: process.env.TRANSLATOR_CONFIG,
  secret: ref => process.env[ref],
  gateFor: tableUsageGates(table),
  basePath: '/api/ai-translator',
  responseSeconds: 120,
};
const translator = createAzureRelayHandler(options);
app.http('contentfulTranslator', {
  route: 'ai-translator/{*relayPath}',
  methods: [...relayMethods],
  authLevel: 'anonymous',
  handler: translator,
});
app.http('wrappedTranslator', {
  route: 'wrapped-translator/{*relayPath}',
  methods: [...relayMethods],
  authLevel: 'anonymous',
  handler: async (request: HttpRequest, context: InvocationContext) => translator(request, context),
});
export const rows: Promise<number> = pruneUsageGate(table);
