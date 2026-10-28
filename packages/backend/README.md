# AI Translator for Contentful backend

`@ai-translator-for-contentful/backend` runs the [AI Translator for Contentful](https://github.com/jarkkosyrjala/ai-translator-for-contentful) **Custom backend** inside a server you already run: a single Node.js process, a cluster, an existing Azure Function App, or a serverless platform with its own event format. It is the same backend as the Cloudflare Worker, Azure Functions, and AWS Lambda hosts, and follows the same [backend contract](../../docs/backend-contract.md): Contentful request signing, request validation, provider and model configuration, provider calls, errors, CORS, and per-entry request coordination.

Your application supplies the server, configuration, secrets, coordination, and deployment. The package registers nothing and reads no settings or environment variables on import. Provider credentials stay on the server.

Node.js 24 or later. JavaScript and TypeScript declarations are included; ES modules and CommonJS are both supported.

## Install

```sh
npm install @ai-translator-for-contentful/backend
```

The [npm package](https://www.npmjs.com/package/@ai-translator-for-contentful/backend) is published through GitHub CI. Its versions and `backend-v<version>` source tags are independent of the app's `v<version>` releases: frontend-only changes do not publish the backend. You can also [build a tarball from source](#build-from-source).

## Entry points

| Import | Exports | Needs |
| --- | --- | --- |
| `@ai-translator-for-contentful/backend` | `createRelayHandler`, `createMemoryGates`, `RelayConfigError`, `CUSTOM_HOST`, and the configuration, gate, and request types | Nothing else |
| `@ai-translator-for-contentful/backend/node` | `createNodeRequestListener` | Nothing else |
| `@ai-translator-for-contentful/backend/azure` | `createAzureRelayHandler`, `relayMethods`, `AZURE_RESERVED_SETTINGS` | Your app's `@azure/functions` 4.x |
| `@ai-translator-for-contentful/backend/azure-tables` | `tableUsageGates`, `pruneUsageGate` | Your app's `@azure/data-tables` 13.x |

The Azure SDKs are optional peer dependencies: install them only for the entry points that use them.

## Configure the handler

`createRelayHandler(options)` returns `(request: Request) => Promise<Response>`. Create it once and reuse it for every request.

| Option | Meaning |
| --- | --- |
| `config` | The [relay configuration](../../docs/backend-contract.md#relay-configuration): a typed `RelayConfigDocument` object or its JSON text. It names App Definitions, their spaces, and providers. An object is validated as its JSON serialization, under the same rules. |
| `secret(ref)` | Returns the secret a `*Ref` property names, such as a signing secret or provider API key, or `undefined`. Read them from your environment, files, or secret service before creating the handler. |
| `gateFor(scope)` | Returns the [usage gate](#coordinate-requests) for one verified App Definition, space, and environment. Without it, health works but translation answers `503 translation_not_enabled`. |
| `basePath` | The path the routes are served beneath, such as `/translator`. Defaults to the root. |
| `host` | Deadlines and size bounds for your runtime. Defaults to `CUSTOM_HOST`: provider deadlines of 600 seconds by default and 900 at most. If a proxy in front of your server waits less, pass `{ ...CUSTOM_HOST, defaultTimeoutSeconds, maxTimeoutSeconds }` at least 10 seconds below its timeout. |
| `reservedNames` | Setting names a ref must not use, such as your own settings. A name ending in `*` reserves the prefix. |
| `mockTranslation` | For automated checks only: answers translations with a deterministic suggestion and no provider call. |

An invalid configuration does not throw. It is logged once as `relay_config_invalid` with the property path and reason, never a value, and POST requests answer `503 relay_misconfigured`. An ambiguous `basePath` throws `RelayConfigError` when the handler is created.

## Base path and Backend URL

With `basePath: '/translator'`, the handler serves `POST /translator/v1/health`, `/translator/v1/models`, and `/translator/v1/translate`, with `OPTIONS` for each. Enter `https://<your-host>/translator` as the **Backend URL** in the app's configuration. A trailing slash on either is ignored. Path segments may contain letters, digits, `.`, `_`, `~`, and `-`; the match is case-sensitive.

Contentful signs the full path, and the handler verifies the full path it receives. It removes the prefix only to choose the route, so the request must reach it with its original URL, headers, and unread body. A proxy that rewrites the path in front of the handler breaks the signature. Paths beside the prefix, such as `/translator2/v1/health`, answer `404 not_found`.

## Run in a Node.js server

```ts
import { createServer } from 'node:http';
import { createMemoryGates, createRelayHandler } from '@ai-translator-for-contentful/backend';
import { createNodeRequestListener } from '@ai-translator-for-contentful/backend/node';

const handler = createRelayHandler({
  config: {
    appDefinitions: {
      '<app-definition-id>': { signingSecretRef: 'APP_SIGNING_SECRET', spaces: { '<space-id>': ['primary'] } },
    },
    providers: {
      primary: { baseUrl: 'https://model.example/v1', model: 'example-model', credentialRef: 'PROVIDER_API_KEY' },
    },
  },
  secret: ref => process.env[ref],
  gateFor: createMemoryGates(),
  basePath: '/translator',
});

createServer(createNodeRequestListener(handler)).listen(8787);
```

Serve it over HTTPS, directly or behind a TLS-terminating proxy that keeps the path. `createNodeRequestListener` also works as a route handler in a framework that passes Node's request and response, mounted where nothing has read the body or rewritten `request.url` first. In Express 5, for example, register it before any body parser, on the full path with a named wildcard (`app.all('/translator/*relayPath', listener)`), not with `app.use('/translator', listener)`, which shortens `request.url`.

## Coordinate requests

The gate allows one active translation per entry and rejects reused request IDs. Pick it by how many processes serve the backend:

| Deployment | `gateFor` |
| --- | --- |
| One long-running process | `createMemoryGates()`. State lasts as long as the process. |
| A Node cluster, replicas, or serverless instances | A shared gate of your own, such as a coordinator in the cluster's primary process reached over IPC, or your application's shared store. |
| An Azure Function App | `tableUsageGates(table)` from `/azure-tables`, or your own shared gate. |

Do not give each process its own memory gate when several serve requests. A shared gate implements this interface:

```ts
import type { ReservationResult } from '@ai-translator-for-contentful/backend';

interface UsageGate {
  reserve(entryId: string, requestId: string, expiresAt: number): ReservationResult | Promise<ReservationResult>;
  release(requestId: string): void | Promise<void>;
}
```

The handler calls `gateFor(scope)` with a storage-safe name for the verified App Definition, space, and environment. A shared gate must:

- Reserve atomically: at most one active reservation per entry in a scope, across every instance.
- Answer `{ ok: false, reason: 'duplicate_request' }` for a request ID reserved in the scope within the last `REQUEST_ID_RETENTION_MS` (one day, counted from the reservation rather than by calendar day), and `{ ok: false, reason: 'concurrency_limit' }` while another request for the entry is active. Do not record a refused reservation.
- Release only the reservation with the given request ID, and treat a reservation as ended at `expiresAt` (epoch milliseconds) even when it was never released.
- Throw when its storage fails. The handler then answers `502 relay_unavailable` without calling the provider.

Gates store request and entry IDs and times, never content or user IDs.

## Other serverless platforms

A platform that passes Web `Request` objects can call the handler directly. For any other event format, convert the method, full path, headers, and raw body to a `Request`, and the `Response` status, headers, and body back:

```ts
export async function invoke(event: PlatformEvent): Promise<PlatformResult> {
  const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  const response = await handler(
    new Request(`https://${event.host}${event.path}`, { method: event.method, headers: event.headers, body }),
  );
  return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
}
```

`PlatformEvent` and `PlatformResult` stand for your platform's types. Do not parse and serialize the JSON body again: the signature covers its exact bytes. Create the handler once per instance and use a shared gate.

## Existing Azure Function App

`createAzureRelayHandler` adapts the handler to an Azure Functions v4 HTTP function. Register it in your app, or call it from your own handler:

```ts
import { app } from '@azure/functions';
import { createAzureRelayHandler, relayMethods } from '@ai-translator-for-contentful/backend/azure';

const translator = createAzureRelayHandler({ config, secret, gateFor, basePath: '/api/ai-translator' });

app.http('contentfulTranslator', {
  route: 'ai-translator/{*relayPath}',
  methods: [...relayMethods],
  authLevel: 'anonymous',
  handler: translator,
});
```

It keeps provider deadlines 10 seconds below Azure's 230-second HTTP response limit; pass `responseSeconds` when your app or a proxy waits less. See [Add to an existing Function App](../../docs/azure-functions.md#add-to-an-existing-function-app) for configuration, the Table Storage gate and its cleanup, CORS, authentication, HTTP streams, and deployment.

## Types

```ts
import type {
  RelayConfigDocument,
  RelayHandlerOptions,
  TranslateRequest,
  TranslateResponse,
  UsageGate,
} from '@ai-translator-for-contentful/backend';
```

The declarations use the global `Request` and `Response` types; include `@types/node` or the `DOM` library.

## Build from source

From a checkout of the repository, with pnpm:

```sh
pnpm install
node packages/backend/build.mjs --version <version>
mkdir -p artifacts
npm pack ./packages/backend/dist --pack-destination artifacts
```

Check out `backend-v<version>` for an npm release, and pass that version; without `--version` the package is `0.0.0`. `npm pack` writes `artifacts/ai-translator-for-contentful-backend-<version>.tgz`, which Git ignores. Install it in your project:

```sh
npm install /path/to/ai-translator-for-contentful-backend-<version>.tgz
```

`packages/backend/dist` is the publishable package, with public npm access configured in its generated manifest. The source workspace's `package.json` remains private to prevent publishing TypeScript sources and internal workspace dependencies. The root and internal packages remain private too.

`pnpm check:backend-package` installs the packed tarball in Node.js, TypeScript, and Azure Function App projects outside the workspace; `-- --version <version>` checks a specific release version. With `-- --core-tools` it also runs the Function App in Azure Functions Core Tools against Azurite.

## License

MIT
