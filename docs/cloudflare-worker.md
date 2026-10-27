# Cloudflare Worker installer guide

The Cloudflare Worker is a **Custom backend** that runs in your own Cloudflare account. It stores the provider credentials and the App Definitions' signing secrets, and calls the model. The browser never receives a secret.

One Worker URL serves every space, App Definition, and provider listed in its [`RELAY_CONFIG`](backend-contract.md#relay-configuration), including every environment of a listed space. Its usage gate, one SQLite-backed Durable Object per App Definition, space, and environment, allows one active translation request per entry; other entries can translate at the same time. The HTTP behavior is specified in the [backend contract](backend-contract.md).

## Before you start

- An App Definition created as in [Installation](installation.md#3-create-the-app-definition).
- A Cloudflare account. SQLite-backed Durable Objects are available on the Workers Free plan.
- An OpenAI-compatible Chat Completions API, a model ID, and a credential if required.
- This repository at the release tag, with dependencies installed: `pnpm install`.

## 1. Upload the static App Bundle

A Custom backend uses the static App Bundle, the frontend without Contentful Functions. Never upload it to an App Definition that has Functions: the upload can remove them.

On the App Definition's **Bundles** tab, either:

- click **Choose files** and select `static-app-bundle-v<version>.zip` from the GitHub release, or
- run `pnpm package:artifacts` from a clean checkout and drag the `artifacts/ai-translator-for-contentful-<commit>/static-app-bundle` folder into the upload area.

To upload from the shell instead, use a [personal access token](https://www.contentful.com/help/faq/personal-access-tokens/) (CMA token):

```sh
cp .env.static.local.example .env.static.local
# Fill in CONTENTFUL_ORG_ID, CONTENTFUL_APP_DEF_ID, and CONTENTFUL_ACCESS_TOKEN.
pnpm check:static-upload
pnpm upload:static-ci
```

`upload:static-ci` builds the frontend and uploads it only after Contentful confirms that the App Definition has no Functions; `check:static-upload` runs only that check. Both read the Git-ignored `.env.static.local`; shell or CI variables take precedence. For several installations, keep one ignored `.env.<name>.local` file per installation and pass `--env-file <path>`.

## 2. Deploy the Worker

Sign in to Cloudflare once, then run the guided setup from the repository root:

```sh
cd backends/cloudflare-worker && pnpm exec wrangler login && cd ../..
pnpm relay:setup --host cloudflare
```

The first run asks for:

- the Worker name, by default `ai-translator-for-contentful`;
- the first provider: an alias you choose (by default `primary`; any readable name such as `Self-hosted model` works), the base URL of its OpenAI-compatible API including any path prefix (for example `https://model.example/v1`; the Worker adds `/chat/completions`), either one fixed model ID or [models chosen by space admins](#models-chosen-by-space-admins), its authentication, and its credential;
- the App Definition ID and the first space ID, both shown in Contentful;
- the App Definition's signing secret from its [**Security** tab](https://app.contentful.com/deeplink?link=app-definition&tab=security). Press Enter instead to generate a new one. Setup saves a generated secret in `signing-secret-<app-definition-id>.json`, readable only by you and ignored by Git; [set it in Contentful](backend-contract.md#set-a-chosen-signing-secret) after deployment and delete the file.

Setup deploys the Worker from this checkout, stores the credential and signing secret as Worker secrets, sends an unsigned health request to confirm that the deployed configuration is valid, and prints the Worker URL. Apart from a generated signing secret, secret values are never written to a file. The configuration is kept in `backends/cloudflare-worker/relay-setup.local.json`, which Git ignores, with the names of the secrets setup manages.

### Change the configuration

Run `pnpm relay:setup --host cloudflare` again. It shows the current configuration and lets you add or remove a space, App Definition, or provider; add a model at an existing provider; change which providers a space allows; replace a provider credential; and rotate a signing secret. Each change is checked as you make it, and **Validate and deploy** validates the whole configuration again before anything is deployed. You can also edit `relayConfig` in the local file, for example to add provider `options` or a `headersRef`, and then choose **Validate and deploy**; setup asks for any secret the Worker does not have yet.

New secrets are stored before the configuration that uses them is deployed, so the live configuration never names a missing secret. Secrets that the new configuration no longer names are deleted only after it is live. The Worker URL and its usage-gate Durable Object binding stay the same.

**Add a model at an existing provider** creates a new alias with another model ID that reuses the provider's URL, authentication, credential, and headers, so it asks for no secret. It offers to keep the source alias's request options or replace them with JSON, because model families can reject different temperature, token, and reasoning options. **Replace a provider credential** names the other aliases that share the credential. A shared credential stays bound until no alias uses it.

After a deployment that adds a provider to a space, each installation in that space shows it unchecked; a space admin must enable it under **Editors may choose** before editors see it.

To serve another space, add it under its App Definition and enter the same Worker URL in that space's app installation. Each new App Definition needs its own signing secret; setup refuses to deploy two App Definitions that share one.

### Models chosen by space admins

When you add a provider, setup asks whether it has one fixed model or lets space admins choose its models. For the second, space admins load the provider's model list in app configuration and enable models, including ones released after deployment, without a Worker change. Setup then asks for optional allowed and excluded patterns, such as `chat-*` or `*-preview`; exclusions win, and the Worker enforces them on every request and filters the model list with them. Leave both empty to permit every model the credential can use, except `mock`. The [backend contract](backend-contract.md#relay-configuration) describes the rules. Edit the patterns later in `relayConfig` in the local file, then choose **Validate and deploy**. A new exclusion also rejects a model an installation saved earlier.

The tradeoffs:

- The installation's list only controls what editors see. A hand-built signed request from a listed space can use any model the provider key accepts within your patterns. Use a dedicated provider key, and restrict models at the provider where it supports that.
- The provider's model list has no capability or price data and can include embedding, image, audio, and moderation models, or IDs its chat endpoint rejects. Some providers have no list; space admins can add IDs by hand and use **Test model**, a paid call.
- One option set applies to every model of the alias. A model that rejects an option fails as a provider error.
- A saved model that the provider retires fails as a provider error until a space admin removes it.

### Deploy without guided setup

To deploy a packaged build or manage the Worker yourself, pass the configuration as a text variable and any new secrets in a file, so both arrive in the same Worker version. From `backends/cloudflare-worker`:

```sh
# secrets.json, outside the repository and readable only by you:
# {"APP_SIGNING_SECRET":"<signing secret>","PROVIDER_API_KEY":"<provider API key>"}
pnpm exec wrangler deploy --name <worker-name> --var "RELAY_CONFIG:$(cat relay-config.json)" --secrets-file <path>/secrets.json
rm <path>/secrets.json
```

Secrets from earlier deployments are kept. For a packaged build, add `--config ../../artifacts/ai-translator-for-contentful-<commit>/cloudflare-worker/wrangler.jsonc`. A deployment without `--var RELAY_CONFIG` removes the variable, so the Worker answers `relay_misconfigured`; pass it every time. A secret name in `RELAY_CONFIG` must not be `USAGE_GATE`, the usage gate's binding.

## 3. Connect the app

1. Install the app in a listed space environment if you have not yet, and open its configuration. Choose **Custom backend**.
2. Enter the Worker's URL as **Backend URL**, for example `https://ai-translator-for-contentful.<subdomain>.workers.dev`.
3. Select **Test connection**. A signed health check runs; no model is called. Under **Editors may choose**, check the providers and models editors may use, and choose the **Default provider and model**; a single fixed-model provider is selected for you. Click **Save**.
4. With test content, translate one field, apply the suggestion, and reload to confirm the draft value. Nothing is published.

Editors start with the default. When the installation enables several choices, they can pick another for one translation under **Advanced settings** in the translate dialog. A provider added later stays hidden until a space admin enables it. Cloning an environment copies the installation, its choices, and its default; the clone needs no Worker change, and its admin can change them.

Each translation request groups several fields into one language, up to the request size the space admin sets per model under **Request size per choice** (20,000 source characters by default, the app's default for a Custom backend). The relay streams the model's answer and stops it at the provider deadline: 600 seconds by default, at most 900. The Worker keeps the connection open while the provider streams. Long text above the request size is split at paragraphs, line breaks or sentence ends, so a whole 50,000-character Long text field is sent only when the model's request size is at least 50,000. Under the planning estimate of 50 tokens per second it needs about 825 seconds; set `timeoutSeconds` to 850 for it. Set `timeoutSeconds` and `idleTimeoutSeconds` per provider, and the optional `limits` object for request and result sizes, in the [relay configuration](backend-contract.md#relay-configuration). A value beyond the host's bound makes the backend answer `relay_misconfigured`; it is never shortened silently.

## Local development

Wrangler reads `backends/cloudflare-worker/.dev.vars`, which Git ignores. Fill in `RELAY_CONFIG` for the App Definition and space that will call the local Worker, and one line per secret it names:

```sh
cp backends/cloudflare-worker/.dev.vars.example backends/cloudflare-worker/.dev.vars
pnpm worker:dev --local-protocol https   # Worker on https://localhost:8787
pnpm dev                                 # frontend on http://localhost:3000
```

The configuration screen accepts only an HTTPS **Backend URL**, so the local Worker uses Wrangler's self-signed certificate. Open `https://localhost:8787` in the browser once and accept the certificate. Point the App Definition's frontend at `http://localhost:3000` (see [Local development](local-development.md)) and enter `https://localhost:8787` as the **Backend URL**.

Before deploying a change, run `pnpm --filter @ai-translator-for-contentful/backend-cloudflare test`, `pnpm typecheck`, `pnpm worker:dry-run`, and `pnpm check:artifacts`.

## Rotate the signing secret

Each App Definition rotates on its own.

1. Run setup and choose **Start signing-secret rotation**. Press Enter to generate the new secret. Setup stores it under a new name and keeps the current secret as the previous one; the Worker accepts both once you deploy.
2. [Set the new secret in Contentful](backend-contract.md#set-a-chosen-signing-secret).
3. Run setup again, choose **Finish signing-secret rotation**, and deploy. The previous secret is deleted after the new configuration is live.
4. Select **Test connection** in an installation. While both secrets were accepted, a passing test could not show which one Contentful used; now it confirms the new secret.

To replace a provider credential, run setup and choose **Replace a provider credential**.

## Roll back

Before each deployment, note the active version with `pnpm exec wrangler deployments list --name <worker-name>`. To roll back, run `pnpm exec wrangler rollback <version-id> --name <worker-name>`. To roll back the frontend, reactivate the last working bundle on the App Definition's **Bundles** tab.

## Remove

From `backends/cloudflare-worker`, run `pnpm exec wrangler delete --name <worker-name>`.

## Troubleshooting

| Message | Check |
| --- | --- |
| The backend rejected this app's signed request (`invalid_signature`) | The App Definition's signing secret in the Worker matches its **Security** tab, and `RELAY_CONFIG` lists this space under this App Definition. |
| The backend's configuration is invalid (`relay_misconfigured`) | Run setup and choose **Validate and deploy**. The Worker logs `relay_config_invalid` with the property path, never a value. |
| The default is no longer available in this space | The space's provider list and the alias's model patterns. After **Test connection**, a space admin removes choices marked "No longer offered by the backend" and chooses another **Default provider and model**. |
| This choice is no longer available | The backend rejected the provider or model with `provider_not_allowed` or `model_not_allowed`, for example after an alias was removed or an exclusion added. Reopen the dialog; a space admin checks **Editors may choose**. |
| The provider's model list could not be loaded (`model_list_unavailable`) | The provider's `/models` endpoint, credential, and response. Add model IDs by hand if the provider has no list. |
| The backend is reachable, but no translation provider is configured yet (`translation_not_enabled`) | The `USAGE_GATE` Durable Object binding. |
| The backend could not be reached | The **Backend URL** and the deployment. |
| Another translation for this entry is still running (`concurrency_limit`) | Another request for this entry was still running after the app had retried for two minutes. Retry when it finishes. |

Do not log or paste credentials, signing secrets, request text, or provider responses. The full error table is in the [backend contract](backend-contract.md#errors-and-retries).
