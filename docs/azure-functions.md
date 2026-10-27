# Azure Functions installer guide

The Azure Functions backend is a **Custom backend** that runs in your own Azure subscription, on the [Flex Consumption plan](https://learn.microsoft.com/azure/azure-functions/flex-consumption-plan) with Node.js 24. It stores the provider credentials and the App Definitions' signing secrets in Azure Key Vault, and calls the model. The browser never receives a secret.

There are two ways to install it:

- **A dedicated Function App**, deployed from this repository's artifact as in steps 1 to 5 below.
- **A route in a Function App you already run**, from the npm package. See [Add to an existing Function App](#add-to-an-existing-function-app).

One dedicated Function App serves every space, App Definition, and provider listed in its [`RELAY_CONFIG`](backend-contract.md#relay-configuration), including every environment of a listed space:

- One anonymous HTTP function serves `POST /v1/health`, `POST /v1/translate`, and `POST /v1/models` at the app's root, as specified in the [backend contract](backend-contract.md). `host.json` removes the default `api` route prefix. Each request is authenticated by its Contentful signature, so Functions access keys are not used: they would need a query string, which the contract rejects, or a header the browser cannot keep secret.
- The usage gate is a table in Azure Table Storage, reached with the Function App's managed identity, with one partition per App Definition, space, and environment. It allows one active translation request per entry; other entries can translate at the same time.
- A timer function deletes request rows older than a day in every partition every day at 03:17 UTC.

## Before you start

- An App Definition created as in [Installation](installation.md#3-create-the-app-definition).
- An Azure subscription, the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), and [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local) 4.x.
- An OpenAI-compatible Chat Completions API, a model ID, and a credential if required.
- This repository at the release tag, with dependencies installed: `pnpm install`.

## 1. Upload the static App Bundle

Upload the static App Bundle as in [step 1 of the Worker guide](cloudflare-worker.md#1-upload-the-static-app-bundle).

## 2. Create the Function App

1. Sign in, confirm the active subscription, and choose a region that supports Flex Consumption. If needed, switch subscriptions with `az account set --subscription <subscription-id>`:

   ```sh
   az login
   az account show --output table
   az functionapp list-flexconsumption-locations
   ```

2. Use an existing resource group, or create one in the chosen region. Use its name as `<resource-group>` in the commands below:

   ```sh
   az group create --name <resource-group> --location <region>
   ```

3. Choose a unique storage account name (3–24 lowercase letters and digits) and create the account:

   ```sh
   az storage account create --name <storage-name> --resource-group <resource-group> --location <region> \
     --sku Standard_LRS --allow-blob-public-access false
   ```

4. Choose a unique app name and create the Function App:

   ```sh
   az functionapp create --name <app-name> --resource-group <resource-group> --storage-account <storage-name> \
     --flexconsumption-location <region> --runtime node --runtime-version 24 --functions-version 4 \
     --instance-memory 512 --maximum-instance-count 10 --https-only true --assign-identity '[system]'
   ```

   The command also creates Application Insights for the app. 512 MB is the smallest [instance size](https://learn.microsoft.com/azure/azure-functions/flex-consumption-plan#instance-sizes); it has less CPU and handles fewer concurrent HTTP requests per instance than the 2,048 MB default. Treat it and the 10-instance limit as starting values, and adjust them to memory use, response times, and traffic.

5. Give the app's identity access to tables in the storage account:

   ```sh
   principal=$(az functionapp identity show --name <app-name> --resource-group <resource-group> --query principalId -o tsv)
   storage=$(az storage account show --name <storage-name> --resource-group <resource-group> --query id -o tsv)
   az role assignment create --assignee-object-id "$principal" --assignee-principal-type ServicePrincipal \
     --role "Storage Table Data Contributor" --scope "$storage"
   ```

   Role assignments can take a few minutes to apply. The gate creates its table on first use.

6. Allow browser calls from any origin in the Function App's platform CORS:

   ```sh
   az functionapp cors add --name <app-name> --resource-group <resource-group> \
     --allowed-origins '*'
   az functionapp cors show --name <app-name> --resource-group <resource-group>
   ```

   Azure answers browser preflight requests before the function runs. Keep `*` as the only CORS entry; Azure ignores it when another origin is listed. The backend still verifies Contentful's signature on every POST and uses no cookies.

## 3. Configure the app settings

Application settings reach the code as environment variables. Write the relay configuration as described in the [backend contract](backend-contract.md#relay-configuration), on one line in a file such as `relay-config.json`, which Git ignores. Each ref in it names the app setting that holds that secret. For example, with one App Definition, one space, and one provider:

```json
{"appDefinitions":{"<app-definition-id>":{"signingSecretRef":"APP_SIGNING_SECRET","spaces":{"<space-id>":["primary"]}}},"providers":{"primary":{"baseUrl":"https://model.example/v1","model":"example-model","credentialRef":"PROVIDER_API_KEY"}}}
```

Set the non-secret settings:

```sh
az functionapp config appsettings set --name <app-name> --resource-group <resource-group> --settings \
  "RELAY_CONFIG=$(cat relay-config.json)" \
  USAGE_GATE_TABLE_ENDPOINT=https://<storage-name>.table.core.windows.net
```

- `RELAY_CONFIG`: the relay configuration. It is not secret.
- `USAGE_GATE_TABLE_ENDPOINT`: the storage account's Table endpoint. Optional: `USAGE_GATE_TABLE` names the table (default `usagegate`), and `USAGE_GATE_CLIENT_ID` selects a user-assigned identity instead of the system-assigned one. Without a usage gate, the backend refuses translations.

Keep each secret the configuration names, such as `APP_SIGNING_SECRET` (the signing secret from the App Definition's [**Security** tab](https://app.contentful.com/deeplink?link=app-definition&tab=security)) and `PROVIDER_API_KEY`, in Key Vault, and reference it from the app setting with that name, so no value appears on a command line. A ref must not start with `USAGE_GATE_`, `FUNCTIONS_`, `WEBSITE_`, `AZURE_`, `APPSETTING_`, `APPLICATIONINSIGHTS_`, or `SCM_`, which the app or Azure use. Adding secrets requires the **Key Vault Secrets Officer** role on the vault, which the commands below give to you.

```sh
az keyvault create --name <vault-name> --resource-group <resource-group> --location <region>
vault=$(az keyvault show --name <vault-name> --query id -o tsv)
me=$(az ad signed-in-user show --query id -o tsv)
az role assignment create --assignee-object-id "$me" --assignee-principal-type User \
  --role "Key Vault Secrets Officer" --scope "$vault"
az role assignment create --assignee-object-id "$principal" --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" --scope "$vault"
# Write each value to a file outside the repository that only you can read, then delete the file.
az keyvault secret set --vault-name <vault-name> --name app-signing-secret --file <signing-secret-file>
az keyvault secret set --vault-name <vault-name> --name provider-api-key --file <api-key-file>
az functionapp config appsettings set --name <app-name> --resource-group <resource-group> --settings \
  'APP_SIGNING_SECRET=@Microsoft.KeyVault(VaultName=<vault-name>;SecretName=app-signing-secret)' \
  'PROVIDER_API_KEY=@Microsoft.KeyVault(VaultName=<vault-name>;SecretName=provider-api-key)'
```

See [Key Vault references](https://learn.microsoft.com/azure/app-service/app-service-key-vault-references) for how Azure resolves them.

## 4. Deploy

Build the deployment artifacts and publish the `azure-functions` folder. It contains the bundled function code, `host.json`, and a `package.json` without dependencies, so no build runs in Azure.

```sh
pnpm package:artifacts
cd artifacts/ai-translator-for-contentful-<commit>/azure-functions
func azure functionapp publish <app-name> --javascript --no-build
```

When the deployment succeeds, Core Tools lists the `relay` and `pruneUsageGate` functions. The `--javascript` flag identifies the prebuilt artifact's language.

## 5. Connect the app

1. Find the app's address: `az functionapp show --name <app-name> --resource-group <resource-group> --query defaultHostName -o tsv`. New apps can get a unique host name such as `<app-name>-<hash>.<region>-01.azurewebsites.net`.
2. Install the app in a listed space environment if you have not yet, and open its configuration. Choose **Custom backend**.
3. Enter `https://<default-host-name>` as **Backend URL**.
4. Select **Test connection**. A signed health check runs; no model is called. Under **Editors may choose**, check the providers and models editors may use, and choose the **Default provider and model**; a single fixed-model provider is selected for you. Click **Save**.
5. With test content, translate one field, apply the suggestion, and reload to confirm the draft value. Nothing is published.

Editors start with the default. When the installation enables several choices, they can pick another for one translation under **Advanced settings** in the translate dialog. A provider the operator adds later stays hidden until a space admin enables it. A cloned environment of a listed space needs no backend change. To let space admins choose a provider's models, give it `models` instead of `model`; see [the backend contract](backend-contract.md#relay-configuration) for patterns and tradeoffs.

Each translation request groups several fields into one language, up to the request size the space admin sets per model under **Request size per choice** (20,000 source characters by default). The relay streams the model's answer and stops it at the provider deadline: 220 seconds by default and at most, 10 seconds below the 230-second limit Azure sets on an HTTP response. The response is buffered, so a longer request cannot finish here. Under the planning estimate of 50 tokens per second, 20,000 characters take about 330 seconds, so set the request size to about 13,000 characters or less for a model that slow; when a request times out, editors can retry in smaller batches. Set `timeoutSeconds` and `idleTimeoutSeconds` per provider, and the optional `limits` object for request and result sizes, in the [relay configuration](backend-contract.md#relay-configuration). A value beyond the host's bound makes the backend answer `relay_misconfigured`; it is never shortened silently.

## Add to an existing Function App

Use this instead of steps 2 to 4 when you already run a JavaScript or TypeScript Function App and want AI Translator as one more route in it. Your app keeps its function registration, `host.json`, app settings, identity, storage clients, logging, and deployment pipeline. You do not need a new Function App, hosting plan, resource group, storage account, or vault to add the route.

The [`@ai-translator-for-contentful/backend`](../packages/backend/README.md) package provides the handler and an optional Table Storage gate. Importing it registers no functions, reads no settings, and changes no app-wide option.

### Requirements

- Azure Functions runtime 4.x with the [Node.js v4 programming model](https://learn.microsoft.com/azure/azure-functions/functions-reference-node) (`@azure/functions` 4.x), on Node.js 24. The runtime version and the programming model version are separate: check the app's `@azure/functions` version. v3 and v4 functions cannot run in one app, and installing the package does not upgrade the app. A v3 app can call the package's `createRelayHandler` from a handler of its own, as for [other serverless platforms](../packages/backend/README.md#other-serverless-platforms), or upgrade separately.
- An App Definition and the static App Bundle, as in [step 1](#1-upload-the-static-app-bundle).

### 1. Install the package

The first npm publication is pending. Until it is available, [build and install the tarball from source](../packages/backend/README.md#build-from-source). Once published, use the registry command below.

Install the [backend package](https://www.npmjs.com/package/@ai-translator-for-contentful/backend) in your existing app:

```sh
npm install @ai-translator-for-contentful/backend @azure/data-tables @azure/identity
```

The app already depends on `@azure/functions`. `@azure/data-tables` and `@azure/identity` are needed only for the Table Storage gate in the example below; skip them if you supply your own shared gate.

### 2. Configure

Write the [relay configuration](backend-contract.md#relay-configuration) as for a dedicated app, and decide where your app keeps it and the secrets it names. A module of your own creates the configuration, secret lookup, and gate once per worker:

```ts
// translator-config.ts, in your app
import { TableClient } from '@azure/data-tables';
import { ManagedIdentityCredential } from '@azure/identity';
import { tableUsageGates } from '@ai-translator-for-contentful/backend/azure-tables';

// Setting names are your choice. Key Vault references resolve before the code reads them.
export const config = process.env.TRANSLATOR_RELAY_CONFIG;
export const secret = (ref: string) => process.env[ref]?.trim() || undefined;

export const table = new TableClient(
  'https://<storage-name>.table.core.windows.net',
  'translatorgate',
  new ManagedIdentityCredential(),
);
export const gateFor = tableUsageGates(table);
```

- `config` is the JSON text or a typed object in code. Secret refs in it must not start with `FUNCTIONS_`, `WEBSITE_`, `AZURE_`, `APPSETTING_`, `APPLICATIONINSIGHTS_`, or `SCM_`. Pass your own setting names as `reservedNames` to keep refs off them too.
- Keep the signing secrets and provider keys in Key Vault and reference them from app settings, as in [step 3](#3-configure-the-app-settings), or read them from your existing secret store before creating the handler. They stay in the Function App.
- Use the identity and credential your app already uses. Give it **Storage Table Data Contributor** on the storage account, as in [step 2.5](#2-create-the-function-app). The table can live in an existing storage account. Reserve it for these rows, and point every instance serving this backend at the same table. The gate creates it on first use, never at import.

Several workers and instances serve one Function App, so use a shared gate: `tableUsageGates(table)` or your own [shared gate](../packages/backend/README.md#coordinate-requests). The package's memory gate is for a single process. Without a gate, health works but translation answers `translation_not_enabled`.

### 3. Register the route

Add a module that your app's `package.json` `main` entry includes or imports:

```ts
import { app } from '@azure/functions';
import { createAzureRelayHandler, relayMethods } from '@ai-translator-for-contentful/backend/azure';
import { config, gateFor, secret } from './translator-config.js';

const translator = createAzureRelayHandler({
  config,
  secret,
  gateFor,
  basePath: '/api/ai-translator',
});

app.http('contentfulTranslator', {
  route: 'ai-translator/{*relayPath}',
  methods: [...relayMethods],
  authLevel: 'anonymous',
  handler: translator,
});
```

- `basePath` is the external path: the app's `routePrefix` from `host.json` (`api` by default) followed by your route. The `route` leaves out the prefix. With a custom prefix such as `fn`, use `basePath: '/fn/ai-translator'`. Keep the existing `host.json`.
- Use a function name and a narrow route that no other function uses, not the dedicated app's root catch-all.
- `relayMethods` sends every method to the handler, so other methods get the contract's JSON `404`.
- `authLevel: 'anonymous'` is required: Contentful signatures authenticate each POST, and the browser cannot keep a function key.

To run the handler inside a handler of your own, for tracing or other work, call the same instance and pass the request on unread:

```ts
handler: async (request, context) => {
  // Your own tracing or other work that leaves the request body unread.
  return translator(request, context);
},
```

Create the handler once per worker, outside the function. A wrapper must keep the request URL, headers, and raw body: do not read or parse the body first, replace the signature check with your own authentication, or turn the backend's errors into successful responses. A handler that receives an already read body throws. A larger router of your own calls the translator only for its mounted path.

### 4. Check the app-wide settings

| Concern | What to check |
| --- | --- |
| CORS | Platform CORS applies to the whole app, and Azure answers preflight requests before the function when it is configured. With no platform CORS entries, the backend answers preflight itself and nothing is needed. If the app already lists origins, add the origin of the Contentful app frontend (the `Origin` header of the request to the Backend URL, visible in the browser's developer tools) and make sure `POST`, `OPTIONS`, and the `X-Contentful-*` headers are allowed. Do not replace an existing policy with the dedicated app's `*`. Test a preflight and a signed POST after a change. See [Restrict CORS access](https://learn.microsoft.com/azure/azure-functions/security-concepts#restrict-cors-access). |
| Authentication and network access | Editors' browsers call the route directly, without a function key or login. If App Service Authentication requires sign-in, exclude this route's path, for example with `globalValidation.excludedPaths` in the [file-based configuration](https://learn.microsoft.com/azure/app-service/configure-authentication-file-based), instead of relaxing other routes. Access restrictions, private endpoints, and gateways must let browsers reach the route. A gateway must forward the path, headers, and body unchanged and pass `OPTIONS`. |
| HTTP streams | `app.setup({ enableHttpStream: true })` in your entry module lets the backend stop reading an oversized body early. It affects every HTTP function in the app, so it is your choice. Without it, Azure buffers the body before the function runs and the backend's size limits still apply. Streams need `@azure/functions` 4.3.0 or later; see [HTTP streams](https://learn.microsoft.com/azure/azure-functions/functions-reference-node?pivots=nodejs-model-v4#http-streams). |
| Deadlines | Provider deadlines default to and stay at most 220 seconds, 10 seconds below the 230-second [HTTP response limit](https://learn.microsoft.com/azure/azure-functions/functions-scale#timeout). If the app's `functionTimeout` or a proxy in front of it waits less, pass that time as `responseSeconds`, for example `responseSeconds: 120` for 110-second provider deadlines. A provider `timeoutSeconds` above the budget makes the route answer `relay_misconfigured`; it is not shortened. Do not raise the app's timeout for this route. |

### 5. Clean up the gate

The Table Storage gate keeps one `gate` row per scope with the active reservations, and one row per request ID seen, holding a SHA-256 digest of the ID and its reservation time. Request rows reject replayed requests. Pruning deletes request rows reserved more than a day ago; abandoned active reservations lapse at their own expiry whether or not you prune. The gate keeps request and entry IDs, never content or user IDs.

The package never registers cleanup. Call `pruneUsageGate(table)` from an existing maintenance job, or register a timer under a name you choose:

```ts
import { app } from '@azure/functions';
import { pruneUsageGate } from '@ai-translator-for-contentful/backend/azure-tables';
import { table } from './translator-config.js';

app.timer('translatorGatePrune', {
  schedule: '0 17 3 * * *',
  handler: async (_timer, context) => {
    context.log(JSON.stringify({ event: 'translator_gate_pruned', rows: await pruneUsageGate(table) }));
  },
});
```

### 6. Deploy and connect

1. Add the package dependency and your new modules to the app's source and build. Deploy the whole project through its usual pipeline, including its other functions. Do not publish this repository's `azure-functions` artifact over the app: it would replace your functions and `host.json`.
2. Enter `https://<existing-app-host>/api/ai-translator`, your `basePath` on the app's host, as **Backend URL**. The path must match `basePath` exactly, including case.
3. Continue with step 4 of [Connect the app](#5-connect-the-app): **Test connection**, choose what editors may use, save, and translate a test field.

Signing secret rotation and configuration changes work as for a dedicated app, in your app's settings. A `not_found` answer to **Test connection** means the Backend URL path, `basePath`, route, and route prefix do not agree.

## Change the configuration

To add or remove a space, App Definition, or provider, edit `relay-config.json` and set `RELAY_CONFIG` again. Add the Key Vault secrets and app settings a change needs first, and delete settings the configuration no longer names only after the new configuration is live. A settings change restarts the app. Every space that should use the backend enters the same **Backend URL**.

## Local development

Core Tools runs the Function App from `backends/azure-functions`. [Azurite](https://learn.microsoft.com/azure/storage/common/storage-use-azurite) provides local storage for the Functions host and the usage gate.

1. Copy the settings template. Core Tools reads `local.settings.json`, which Git ignores:

   ```sh
   cp backends/azure-functions/local.settings.example.json backends/azure-functions/local.settings.json
   ```

2. In its `Values` object, set `RELAY_CONFIG` to the App Definition and space that will call the local backend and the provider's base URL and model, as in [step 3](#3-configure-the-app-settings). `RELAY_CONFIG` is a JSON string, so its quotes are escaped.
3. Set `APP_SIGNING_SECRET` to the App Definition's signing secret from its **Security** tab and `PROVIDER_API_KEY` to the model API's key, or use the names your `RELAY_CONFIG` gives them. Keep `AzureWebJobsStorage` and `USAGE_GATE_CONNECTION_STRING` set to `UseDevelopmentStorage=true` for Azurite.
4. Start each service in its own terminal:

   ```sh
   pnpm --filter @ai-translator-for-contentful/backend-azure exec azurite --silent --inMemoryPersistence
   ```

   ```sh
   pnpm azure:dev --useHttps
   ```

   ```sh
   pnpm dev
   ```

5. The configuration screen accepts only an HTTPS **Backend URL**; `--useHttps` makes Core Tools serve `https://localhost:7071` with a development certificate. Point the App Definition's frontend at `http://localhost:3000` (see [Local development](local-development.md)), open the app's configuration, choose **Custom backend**, and enter `https://localhost:7071` as **Backend URL**. Select **Test connection**, choose what editors may use and the default, and save.

Keep credentials only in `local.settings.json`. Do not deploy with `--publish-local-settings`; deployed settings use the [Key Vault references](#3-configure-the-app-settings) from step 3.

Before deploying a change, run `pnpm --filter @ai-translator-for-contentful/backend-azure test`, `pnpm typecheck`, and `pnpm check:artifacts`. The tests start Azurite themselves.

## Rotate the signing secret

Each App Definition rotates on its own.

1. Choose a [new signing secret](backend-contract.md#set-a-chosen-signing-secret) and store it in Key Vault under a new name, for example `app-signing-secret-2`, and add an app setting that references it, such as `APP_SIGNING_SECRET_2`.
2. In `RELAY_CONFIG`, set that App Definition's `signingSecretRef` to `APP_SIGNING_SECRET_2` and `previousSigningSecretRef` to the current setting name, then set `RELAY_CONFIG` again. The restarted app accepts both secrets.
3. [Set the new secret in Contentful](backend-contract.md#set-a-chosen-signing-secret).
4. Remove `previousSigningSecretRef` from `RELAY_CONFIG`, set it again, and then delete the old app setting.
5. Select **Test connection** in an installation. While both secrets were accepted, a passing test could not show which one Contentful used.

Azure reads references without a secret version again every 24 hours. To use a new `provider-api-key` version at once, refresh the references:

```sh
app=$(az functionapp show --name <app-name> --resource-group <resource-group> --query id -o tsv)
az rest --method post --url "https://management.azure.com${app}/config/configreferences/appsettings/refresh?api-version=2022-03-01"
```

## Roll back

Keep the artifact folder of each deployment. To roll back, publish the last working `azure-functions` folder with the same `func azure functionapp publish` command. See [Recover a deployment to a Flex Consumption plan](https://learn.microsoft.com/azure/azure-functions/functions-rollback-deployments) for other options. To roll back the frontend, reactivate the last working bundle on the App Definition's **Bundles** tab.

## Uninstall

Delete the Function App, its storage account, and the vault, or the whole resource group if it holds nothing else: `az group delete --name <resource-group>`. This also deletes the usage gate data. If Azure created a Log Analytics workspace for the app's Application Insights outside this group, delete it too; the Application Insights component's `workspaceResourceId` names it. Revoke the provider API key.

## Troubleshooting

Application Insights and the app's log stream show the startup events `relay_config_invalid`, which names the invalid `RELAY_CONFIG` property and the reason, and `usage_gate_misconfigured`, which gives the reason. Neither logs setting values.

| Message | Check |
| --- | --- |
| The backend rejected this app's signed request (`invalid_signature`) | The App Definition's signing secret setting matches its **Security** tab, and `RELAY_CONFIG` lists this space under this App Definition. An unresolved Key Vault reference leaves the reference text as the value: open the setting under **Environment variables** in the portal to see its status. |
| The backend's configuration is invalid (`relay_misconfigured`) | `RELAY_CONFIG` and the settings it names; see the `relay_config_invalid` log entry. |
| The backend could not be reached | The **Backend URL**, the deployment, and the platform CORS setting. |
| The backend is reachable, but no translation provider is configured yet (`translation_not_enabled`) | `USAGE_GATE_TABLE_ENDPOINT`. |
| Another translation for this entry is still running (`concurrency_limit`) | Another request for this entry was still running after the app had retried for two minutes. Retry when it finishes. |
| `relay_unavailable` when translating | The identity's **Storage Table Data Contributor** role on the storage account. |
| `not_found` on every request | The deployment includes `host.json`, which removes the `api` route prefix. |

Do not log or paste credentials, signing secrets, request text, or provider responses. The full error table is in the [backend contract](backend-contract.md#errors-and-retries).
