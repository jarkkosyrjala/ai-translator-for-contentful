# Contentful Function installer guide

With this backend, the translation runs in a Contentful Function, so you need no external service. Contentful Functions require a Premium or Enterprise plan; on other plans, use a [Custom backend](installation.md#1-choose-a-backend).

The browser calls a Contentful App Action, which runs the `translateProvider` Function. The Function reads the provider settings, any credential, and the models a space admin enabled from the app's installation parameters and calls the model. It accepts only those saved models. It has no usage gate, so the one-request-per-entry limit of Custom backends does not apply.

## Provider URL and allowed hosts

On the configuration screen, you enter the model API's **Provider URL**, for example `https://model.example/v1`. It must use HTTPS and a hostname, not `localhost` or an IP address. Do not include `/chat/completions`: the Function always appends it. Redirects are not followed.

A Contentful Function can call only the hosts listed in its `allowNetworks` setting, which is fixed when the App Bundle is uploaded. The tracked [manifest](../backends/contentful-function/contentful-app-manifest.json) allows none. The upload grants these hosts to the `providerModels` and `translateProvider` Functions; the connection check, `functionHealth`, has no network access. Set `CONTENTFUL_FUNCTION_ALLOW_NETWORKS` to a JSON array of exact provider hostnames, with a port when it is not the default: for `https://model.example/v1`, use `["model.example"]`. Do not include a scheme or path. The list applies to every installation of the App Definition, so include the hosts of all of them. To allow another host later, upload a new bundle. Enabling more models at a provider whose host is already allowed needs no upload.

The upload command builds the frontend and the Functions, writes a temporary manifest with these hosts outside the repository, runs Contentful's upload there, and then removes the temporary manifest. The tracked manifest never changes.

## Settings file

Copy the example to `.env.function.local` in the repository root, which Git ignores, and fill it in for this installation:

```sh
cp .env.function.local.example .env.function.local
```

- `CONTENTFUL_FUNCTION_ALLOW_NETWORKS`: the provider hosts, as above.
- `CONTENTFUL_ORG_ID`: your organization ID, under **Organization settings & subscriptions** > **Organization information**, or after `/organizations/` in the browser URL. See [Find organization ID](https://www.contentful.com/help/organizations/find-organization-id/).
- `CONTENTFUL_APP_DEF_ID`: the App Definition's ID, shown on its **App details** page and in the browser URL. It is not the space ID.
- `CONTENTFUL_ACCESS_TOKEN`: a [personal access token](https://www.contentful.com/help/faq/personal-access-tokens/) (CMA token) with the `content_management_manage` scope, from a user who can manage apps in the organization. Create it under **Settings** > **CMA tokens**. Delivery and Preview API tokens cannot manage App Definitions.

Shell or CI variables take precedence over the file, so CI can use its secret store instead. To manage several installations from one checkout, keep one ignored `.env.<name>.local` file per installation and pass `--env-file <path>` to `check:function-networks`, `sync:parameters`, `upload:function-ci`, and `sync:function-action`.

## Deploy to a selected environment

1. Confirm the App Definition, its organization, and its installations: a bundle upload affects all of them. Record the active bundle ID, the App Action definitions, and the non-Secret installation parameters for rollback.
2. Run `pnpm check:function-networks`. It validates `CONTENTFUL_FUNCTION_ALLOW_NETWORKS` without printing the hosts.
3. Run `pnpm sync:parameters`. It sets the App Definition's installation parameter definitions to the app's own, including the Secret parameters for the provider API key and extra headers.
4. Run `pnpm upload:function-ci`. It builds and uploads the App Bundle with the `functionHealth`, `providerModels`, and `translateProvider` Functions and your allowed hosts. Check that the new bundle is active and that the App Definition keeps its name and installations. Do not use `upload:static-ci` here.
5. Run `pnpm sync:function-action` to create or update the App Actions that run the three Functions. The health and model list actions never call a model.
6. Install the app in the target space environment if you have not yet, and open its configuration. Choose **Contentful Function** and enter the **Provider URL**. Add a **Provider API key** if required; otherwise choose **No authentication** under **Advanced provider settings**. Click **Save**. If you saved a key, reopen the configuration to check that it shows "Saved as a secret".
7. Under **Models editors may use**, select **Load models**, check the models editors may use, or add model IDs the provider does not list, and choose the **Default model**. Click **Save** again. Optionally, select a saved model and **Test model**; it sends one short synthetic translation and is a paid model call.
8. With test content, translate one field, apply the suggestion, and reload. Nothing is published.

**Load models** asks the `providerModels` Function to list the provider's model IDs with the saved URL, key, and headers; it calls no model, so save provider changes first. A newly listed model starts unchecked, and models missing from a later list stay enabled with "Not returned by model discovery" until you remove them. The list only works if the provider has an OpenAI-compatible `GET /models`; otherwise add IDs by hand. **Test connection** checks only that the Function runs in this environment and finds a saved Provider URL and key: "The Function ran in this environment. Provider network access was not tested." Editors cannot translate until at least one model and a default are saved.

Editors start with the default model and can pick another enabled model for one translation under **Advanced settings**. The Function rejects any model that is not saved, so removing a model and saving stops its use, also from a hand-built App Action call. The provider's model list has no capability or price data and can include models that cannot translate; one set of advanced options applies to every model; and a saved model that the provider retires fails as a provider error until you remove it.

## Advanced provider settings

Under **Advanced provider settings** you can choose Bearer authentication (the default), a custom authentication header, or no authentication; add headers, stored as a Secret; and set temperature, top-p, an output-token limit, reasoning effort, or a JSON object of additional Chat Completions properties. Leave options blank to use the provider's defaults. The app checks their format, but only a translation shows whether the provider accepts them. Custom backends have the same options in each provider of their [relay configuration](backend-contract.md#relay-configuration). Editors cannot change any of them.

**Provider timeout** and **Idle timeout** bound one translation request, in whole seconds up to 27 (the default). Contentful gives a Function 30 seconds in total, so the provider call stops 3 seconds before that; the idle timeout stops a stream that sends nothing for that long. A value above 27 is rejected, not shortened. The Function streams the model's answer and accepts it only after a complete finish.

## Request size

Editors' fields are grouped into requests, one target locale per request. Under **Request size per model**, each model has a **Request size** in source characters. The default is 10,000. Contentful stops a Function after 30 seconds and model speed varies, so lower it if a model's requests time out. Long text, lists and Rich Text above the request size are split at paragraphs (or line breaks and sentence ends), items or blocks. **Advanced request settings** set the fields per request, the context limits, the neighboring text and outline for split parts, and the smaller retry factor. Blank values use the defaults. A larger field is sent alone, with a note to the editor; when a request times out, editors can **Retry in smaller batches**. The estimates are planning aids, not guarantees for any model.

The Function accepts requests and returns results of up to 512 KiB, a conservative application default, and reports these bounds in its connection check so the app plans within them.

## Secrets

The provider API key and the additional headers are Secret installation parameters of this space environment. Only the Function receives their values; the App SDK and personal access token reads return a redacted value.

- Saving without touching the key keeps it. **Replace** writes a new key; **Clear** removes it, and translation stops until a key is saved.
- Switching temporarily to **Custom backend** keeps the saved key.
- If the configuration screen cannot read whether a key is saved, it refuses to save, so an unrelated change cannot erase the key.
- The Function uses the saved parameters: save a changed URL, key, or model list before loading models or testing.
- The Function compiles instructions only with the saved instruction profile, or the app's defaults when none is saved, and rejects a request that names another profile revision. A profile saved by an earlier app version must be reset to the defaults and saved before editors can translate.

## Troubleshooting

A wrong key, model, or provider host shows as an error on the translated field. Check the Provider URL, the allowed hosts of the active bundle, the App Actions, the installation environment, and the Function's logs. Contentful can replace an error thrown by a Function with a generic App Action failure, so the Functions return error codes in their results for expected configuration and provider failures.

Do not log or paste API keys, Authorization headers, request text, context, or provider responses.

## Roll back

Reactivate the last working App Bundle on the App Definition's **Bundles** tab and restore the recorded App Action definitions. If needed, restore the recorded non-Secret installation parameters. A Secret cannot be restored from a redacted record: enter the key again from its owner's copy, or clear it. Then select **Test connection** in the target environment.
