import { createServer } from 'node:http';
import {
  createMemoryGates,
  createRelayHandler,
  type RelayConfigDocument,
  RelayConfigError,
  type ReservationResult,
  type TranslateRequest,
  type UsageGate,
} from '@ai-translator-for-contentful/backend';
import { createNodeRequestListener } from '@ai-translator-for-contentful/backend/node';

// A typed configuration object, a consumer's shared gate, and the Node bridge.
const config: RelayConfigDocument = {
  appDefinitions: { 'app-id': { signingSecretRef: 'APP_SIGNING_SECRET', spaces: { 'space-id': ['primary'] } } },
  providers: { primary: { baseUrl: 'https://model.example/v1', model: 'example-model', credentialRef: 'MODEL_KEY' } },
};
const shared: UsageGate = {
  reserve: async (_entryId: string, _requestId: string, _expiresAt: number): Promise<ReservationResult> => ({
    ok: true,
  }),
  release: async (_requestId: string) => {},
};
const local = createMemoryGates();
const handler = createRelayHandler({
  config,
  secret: ref => process.env[ref],
  gateFor: process.env.SHARED === 'true' ? () => shared : local,
  basePath: '/translator',
});
createServer(createNodeRequestListener(handler));
const entry: TranslateRequest['entryId'] = 'entry';
const failure: RelayConfigError = new RelayConfigError('basePath', 'invalid_base_path');
// @ts-expect-error The configuration has no such property.
const unknown: RelayConfigDocument = { appDefinitions: {}, providers: {}, unknown: true };

export { entry, failure, unknown };
