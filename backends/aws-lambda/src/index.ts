import { SecretsProvider } from '@aws-lambda-powertools/parameters/secrets';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createEnvironmentHandler } from './handler';

// Lambda entry point, `index.handler`. Clients are created once per execution
// environment and reused across invocations.

// Cached per execution environment, so a rotated secret applies within a minute.
const SECRET_CACHE_SECONDS = 60;
const secrets = new SecretsProvider({ awsSdkV3Client: new SecretsManagerClient({}) });

const relay = createEnvironmentHandler(process.env, {
  dynamodb: new DynamoDBClient({}),
  async getSecret(secretId) {
    const value = await secrets.get(secretId, { maxAge: SECRET_CACHE_SECONDS });
    if (value !== undefined && typeof value !== 'string') throw new Error('secret_not_string');
    return value;
  },
});

export const handler = relay.handler;

// Fetch the secret during initialization, as Lambda recommends for async
// setup. A failure here is retried and logged by the first request.
await relay.loadSecret().catch(() => undefined);
