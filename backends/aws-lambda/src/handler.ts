import { awsHost, createRelayHandler, type RelayHandler, type UsageGate } from '@ai-translator-for-contentful/relay';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from 'aws-lambda';
import { createDynamoDbGateStore } from './dynamodb-store';
import { toRequest, toResult } from './http';
import {
  type Environment,
  functionTimeoutSeconds,
  LAMBDA_SETTINGS,
  parseSecretValues,
  SecretFormatError,
  type SecretValues,
} from './settings';
import { createUsageGate } from './usage-gate';

export type LambdaRelayOptions = {
  environment: Environment;
  // Returns the secret's JSON text, or undefined when no secret is configured.
  loadSecret(): Promise<string | undefined>;
  // The usage gate of one verified scope.
  gateFor?: (scope: string) => UsageGate;
};

export type FunctionUrlHandler = (event: LambdaFunctionURLEvent) => Promise<APIGatewayProxyStructuredResultV2>;

export type AwsClients = {
  dynamodb: DynamoDBClient;
  getSecret(secretId: string): Promise<string | undefined>;
};

// An unreadable or malformed secret resolves no ref, so the relay answers
// relay_misconfigured instead of failing open.
async function secretText(loadSecret: LambdaRelayOptions['loadSecret']): Promise<string | undefined> {
  try {
    const text = await loadSecret();
    parseSecretValues(text);
    return text;
  } catch (error) {
    const reason = error instanceof SecretFormatError ? error.code : 'read_failed';
    console.error(JSON.stringify({ event: 'relay_secret_unavailable', reason }));
    return undefined;
  }
}

// Serves the relay contract from a Lambda function URL. The secret is read on
// each request, so a rotated value applies once the secret cache expires; the
// relay configuration is parsed again only when the secret changes.
export function createFunctionUrlHandler(options: LambdaRelayOptions): FunctionUrlHandler {
  const { environment } = options;
  const timeout = functionTimeoutSeconds(environment);
  // Without the function's own timeout, deadlines cannot be checked against
  // it, so the relay answers relay_misconfigured.
  if (timeout === undefined)
    console.error(
      JSON.stringify({ event: 'relay_config_invalid', path: 'FUNCTION_TIMEOUT_SECONDS', reason: 'invalid' }),
    );
  let cached: { text: string | undefined; relay: RelayHandler } | undefined;
  return async event => {
    const text = await secretText(options.loadSecret);
    if (!cached || cached.text !== text) {
      const secrets: SecretValues = text === undefined ? {} : parseSecretValues(text);
      cached = {
        text,
        relay: createRelayHandler({
          config: timeout === undefined ? undefined : environment.RELAY_CONFIG,
          host: awsHost(timeout ?? 60),
          secret: ref => (Object.hasOwn(secrets, ref) ? secrets[ref] : undefined),
          mockTranslation: environment.MOCK_TRANSLATION_ENABLED === 'true',
          gateFor: options.gateFor,
          reservedNames: LAMBDA_SETTINGS,
        }),
      };
    }
    return toResult(await cached.relay(toRequest(event)));
  };
}

// Wires the handler from the function's environment variables. RELAY_SECRET_ID
// names the Secrets Manager secret and USAGE_TABLE_NAME the DynamoDB table of
// the usage gate. Without a table the paid translation route stays disabled.
export function createEnvironmentHandler(
  environment: Environment,
  aws: AwsClients,
): { handler: FunctionUrlHandler; loadSecret(): Promise<string | undefined> } {
  const secretId = environment.RELAY_SECRET_ID;
  const tableName = environment.USAGE_TABLE_NAME;
  const loadSecret = async () => (secretId ? aws.getSecret(secretId) : undefined);
  const gateFor = tableName
    ? (scope: string) => createUsageGate(createDynamoDbGateStore(aws.dynamodb, tableName, scope))
    : undefined;
  return { handler: createFunctionUrlHandler({ environment, loadSecret, gateFor }), loadSecret };
}
