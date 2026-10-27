# Custom backend contract

This is the HTTP contract between the AI Translator for Contentful frontend and a **Custom backend**: the HTTPS service an installer hosts and enters as the **Backend URL** on the app's configuration screen. Changing it requires a new contract version and updated conformance suites.

The shared implementation is [`packages/relay`](../packages/relay). The included hosts are [Cloudflare Worker](../backends/cloudflare-worker), [Azure Functions](../backends/azure-functions), and [AWS Lambda](../backends/aws-lambda). The npm package [`@ai-translator-for-contentful/backend`](../packages/backend), built from this repository and not published to the npm registry, runs the same implementation in a Node.js server, another serverless platform, or an existing Azure Function App. Another host must implement the rules below and pass the [`relay-conformance`](../packages/relay-conformance) suites, which are not published either: run them from a checkout of this repository. Contentful Function uses App Actions instead of this HTTP contract.

All examples use synthetic values. Never put real space IDs, users, secrets, or content in fixtures or documentation.

## Versions and compatibility

| Item | Version | Notes |
| --- | --- | --- |
| Health request and response | contract `1` | Every backend must answer it. |
| Translation request and response | contract `1` | One request translates several fields of one entry into one target locale. |

There is one contract version. A backend answers any other version with `400 unsupported_contract`, and the app asks for a backend update.

The frontend calls health when an administrator selects **Test connection** and whenever the translate dialog opens; the dialog generates only after health succeeds. A health response with any other `contract`, `status`, or `modelCall` value, a non-boolean `providerConfigured`, a `providers` value that is not an array of objects with nonempty `alias` and `host` strings, a positive integer `timeoutSeconds`, an optional positive integer `maxCompletionTokens`, and either a nonempty `model` or `modelSelection: "installation"` (not both), or missing `limits` is rejected as incompatible.

## Relay configuration

One backend URL can serve several Contentful spaces, App Definitions, and provider configurations. A host reads two settings and the secrets they name:

| Setting | Meaning |
| --- | --- |
| `RELAY_CONFIG` | One JSON document, described below. Not secret. |
| `MOCK_TRANSLATION_ENABLED` | For automated contract checks only: `true` answers translation requests with a deterministic suggestion, without the provider or the usage gate. The app never applies mock suggestions. |

```json
{
  "appDefinitions": {
    "example-app-a": {
      "signingSecretRef": "APP_A_SIGNING",
      "spaces": {
        "example-space-one": ["primary", "Self-hosted model", "Admin selects"],
        "example-space-two": ["Self-hosted model"]
      }
    },
    "example-app-b": {
      "signingSecretRef": "APP_B_SIGNING",
      "spaces": { "example-space-three": ["primary"] }
    }
  },
  "providers": {
    "primary": {
      "baseUrl": "https://model.example/v1",
      "model": "example-model",
      "authMode": "bearer",
      "credentialRef": "MODEL_CREDENTIAL"
    },
    "Self-hosted model": {
      "baseUrl": "https://another-model.example/v1",
      "model": "another-example-model",
      "authMode": "bearer",
      "credentialRef": "SECOND_MODEL_CREDENTIAL"
    },
    "Admin selects": {
      "baseUrl": "https://model.example/v1",
      "authMode": "bearer",
      "credentialRef": "MODEL_CREDENTIAL",
      "models": { "deny": ["premium-model", "*-pro*"] }
    }
  }
}
```

- `appDefinitions` is keyed by Contentful App Definition ID. Its `spaces` map is keyed by the IDs of the spaces whose installations may call the backend; each value lists, in order, the provider aliases those installations may use. Every environment of a listed space is accepted, so a cloned environment needs no change here.
- `signingSecretRef` names the App Definition's [Contentful app signing secret](https://www.contentful.com/developers/docs/extensibility/app-framework/request-verification/#establishing-a-signing-secret). While it rotates, the optional `previousSigningSecretRef` names the old one and either verifies. Each App Definition must have its own signing secrets.
- Each key of `providers` is an alias the operator chooses: any name of 1–100 characters without leading or trailing spaces or control characters, matched exactly. The provider is the OpenAI-compatible model API that generates translation suggestions; the backend calls it, and the browser never does.
- An optional top-level `debug`, `true` or `false` (the default), adds what the provider sent, unredacted, to failed translations; see [debug mode](#errors-and-retries).

| Provider property | Required | Meaning |
| --- | --- | --- |
| `baseUrl` | Yes | Base URL of the model API, including any path prefix, for example `https://model.example/v1`. HTTPS, with no credentials, query, or fragment. The relay appends `/chat/completions` unless the URL already ends with it. This is not the **Backend URL**, which is the backend's own address. |
| `model` | Either this or `models` | A fixed model: the model ID sent to this provider and the only one the relay accepts for this alias. |
| `models` | Either this or `model` | Lets space admins choose this provider's models in app configuration. An object with optional `allow` and `deny` arrays of model ID patterns, described below. |
| `authMode` | No | `bearer` (default), `header`, or `none`. |
| `authHeader` | With `header` | Header name that carries the credential. |
| `credentialRef` | Unless `authMode` is `none` | Names the provider credential. Omit it with `none`. |
| `headersRef` | No | Names a secret holding a JSON object of up to 16 extra provider headers. |
| `options` | No | An object of `temperature`, `topP`, `maxCompletionTokens`, `outputTokenField`, `reasoningEffort`, and `extraBody`, validated by [`provider-settings.ts`](../packages/protocol/src/provider-settings.ts). Reserved properties such as `model`, `messages`, `stream`, and `stream_options` cannot be overridden. |
| `timeoutSeconds` | No | The provider deadline for one translation request, in whole seconds, counted from the request's arrival. Defaults to the host's: 600 on Cloudflare, 600 on AWS or the Lambda timeout minus 10 when that is shorter, and 220 on Azure. A value above the host's bound is rejected: 900 on Cloudflare, the Lambda timeout minus 10 on AWS, and 220 on Azure. |
| `idleTimeoutSeconds` | No | The longest wait for the provider's first or next streamed bytes, at most `timeoutSeconds`. Defaults to 60, or `timeoutSeconds` when that is shorter. |

Several aliases can share a provider: give them the same `baseUrl`, `credentialRef`, and other connection settings with different `model` or `options`, and the credential is stored once. The `options` of an alias apply to every model under it, so put model families that reject different temperature, token, or reasoning options under separate aliases.

**Admin-selected models.** With `models`, the relay accepts a request's `model` when it is a valid model ID (1–100 letters, digits, `.`, `_`, `:`, `/`, or `-`, starting with a letter or digit), is not `mock`, matches at least one `allow` pattern (or `allow` is omitted), and matches no `deny` pattern. Deny wins over allow. Omitted `allow` permits every valid ID; an empty `allow` permits none; omitted or empty `deny` excludes none. A pattern matches the whole ID, case-sensitively; `*` matches zero or more characters and every other character is literal. Each list holds at most 64 patterns of the model ID characters plus `*`. In the example above, space admins can enable any model the credential reaches except `premium-model` and IDs containing `-pro`, including models released after deployment. An exclusion belongs to its alias, for every space that uses it; to exclude a model across the relay, restrict every selectable alias that can reach it and remove any fixed alias that offers it.

**Limits.** An optional top-level `limits` object sets the backend's software safety ceilings, as whole numbers. Omitted values use the defaults below. A value above the host's bound is rejected, never clamped; actual platform quotas still apply.

| Limit | Default | Meaning |
| --- | --- | --- |
| `requestBytes` | 2 MiB | The complete translation request body, envelope included. |
| `providerBodyBytes` | 4 MiB | The complete provider request: both messages, options, markup and escaping. |
| `generatedBytes` | 2 MiB | Decoded generated content, independent of stream framing. |
| `resultBytes` | 4 MiB; 2 MiB on AWS | The complete result JSON. AWS keeps room for the function URL's second escaping inside its 6 MiB payload. |
| `streamBytes`, `eventBytes` | 64 MiB, 256 KiB | Provider stream bytes on the wire, and one event. |
| `parserNodes`, `parserDepth` | 100,000, 64 | Elements and nesting the response reader accepts. |

Health reports `requestBytes`, `providerBodyBytes`, and `resultBytes` so the app plans requests within them.

Every `*Ref` is the name of a secret in the host's secret store: `^[A-Z][A-Z0-9_]*$`, not `RELAY_CONFIG` or `MOCK_TRANSLATION_ENABLED`, and not a name the host itself uses, such as Cloudflare's `USAGE_GATE` binding. Each must resolve to a nonempty string. Keep every secret in the host's secret store, never in `RELAY_CONFIG`, the App Bundle, or a tracked file.

The relay validates the whole configuration when it starts: the JSON, unknown properties, IDs, aliases, refs and their values, provider settings, timeouts and limits against the host's bounds, model patterns, nonempty space provider lists without repeated aliases, aliases that name a configured provider, and signing secrets shared by two App Definitions. If anything is invalid, all three POST routes return `503 relay_misconfigured` without checking signatures or calling a provider, and the host logs the property path and reason, never a value.

### Set a chosen signing secret

Generating a signing secret in the App Definition's **Security** tab replaces the old one at once. To rotate without failed requests, the backend must accept the new secret first, so choose its value yourself: 64 characters from `A–Z`, `a–z`, `0–9`, `+`, `/`, `=`, `_`, and `-`. After the backend accepts it, set it with the Content Management API and a personal access token, keeping both values out of your shell history and the process list. Put the secret in `signing-secret.json`, readable only by you; Git ignores that name. `read -rs` takes the token without echoing it, and `printf` is a shell builtin, so the token never appears in a command line:

```sh
# signing-secret.json: {"value":"<new signing secret>"}
read -rs CONTENTFUL_ACCESS_TOKEN
printf 'Authorization: Bearer %s\n' "$CONTENTFUL_ACCESS_TOKEN" |
  curl -X PUT "https://api.contentful.com/organizations/<organization-id>/app_definitions/<app-definition-id>/signing_secret" \
    -H @- \
    -H "Content-Type: application/vnd.contentful.management.v1+json" \
    --data @signing-secret.json
rm signing-secret.json
unset CONTENTFUL_ACCESS_TOKEN
```

If the secret leaked, do not rotate gradually: the old secret stays valid until the rotation ends. Set a new secret as the only one in the backend and in Contentful at once, accepting failed requests in between, and revoke any personal access token that was exposed with it.

### Change the configuration

To add or revoke a space, add or remove its key under the App Definition. To add an App Definition, add its key, its own signing secret, and its spaces. To offer another provider or model, add a configuration under a new alias and list the alias for the spaces that may use it. Each installation shows a new alias unchecked until a space admin enables it under **Editors may choose**. Removing an alias from a space's list, changing a fixed alias's model, or adding a `deny` pattern stops matching requests once the new configuration is active, including from dialogs that are already open; a provider call already in progress finishes. Installations that saved a removed choice must remove it before they can save again.

The space admin's **Editors may choose** list narrows what the app offers editors in one environment. It is not enforced by the backend: anyone who can open the app in a listed space can sign a request by hand for any alias the space lists and, for an admin-selectable alias, any model its patterns permit. `RELAY_CONFIG` is the enforced boundary. For admin-selectable aliases, use a dedicated provider key and restrict models at the provider where it supports that, for example with [OpenAI project limits](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform).

## Routes and CORS

- `POST /v1/health`, `POST /v1/translate`, and `POST /v1/models` are the only routes, beneath the Backend URL's path. A backend at the root serves `/v1/health`; one at `https://functions.example/api/ai-translator` serves `/api/ai-translator/v1/health`. `OPTIONS` on any of them returns `204`. Any other path or method returns `404 not_found`, including a path beside the prefix such as `/api/ai-translator2/v1/health`.
- A Backend URL path has segments of letters, digits, `.`, `_`, `~`, and `-`, without empty, `.`, or `..` segments; a trailing slash is ignored and the match is case-sensitive. The URL has no query, fragment, or credentials.
- Responses carry `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: POST, OPTIONS`, and `Access-Control-Allow-Headers: Content-Type, X-Contentful-Signature, X-Contentful-Signed-Headers, X-Contentful-Timestamp, X-Contentful-Space-Id, X-Contentful-Environment-Id, X-Contentful-User-Id, X-Contentful-CRN`. CORS lets the frontend call the relay from Contentful's hosting or a local development server; every POST still needs a valid Contentful signature.
- JSON responses use `Content-Type: application/json`.

## Request bodies

- Health and model list bodies are at most 4,096 bytes and translation bodies at most `limits.requestBytes` (2 MiB by default), checked against `Content-Length` and while reading. Larger bodies return `413 too_large`.
- The body must be valid UTF-8 (`400 invalid_encoding`). The signature is checked next, then JSON parsing (`400 invalid_json`).

## Signed requests

The frontend signs each request with Contentful's [app signing request](https://www.contentful.com/developers/docs/extensibility/app-framework/request-verification/) and sends the returned headers. Contentful adds the space, environment, and user headers; the frontend adds no identity of its own. The relay accepts a request only when all of these hold; otherwise it returns `401 invalid_signature`:

1. An App Definition in `RELAY_CONFIG` lists the `x-contentful-space-id` value as a space. A space no App Definition lists gets the same `401`.
2. `x-contentful-environment-id` and `x-contentful-user-id` are present.
3. `x-contentful-timestamp` is a decimal millisecond timestamp within 60 seconds of the relay's clock.
4. `x-contentful-signed-headers` is a comma-separated list of unique lowercase names, without surrounding spaces, that includes `content-type`, `x-contentful-timestamp`, `x-contentful-signed-headers`, `x-contentful-space-id`, `x-contentful-environment-id`, and `x-contentful-user-id`. Every listed header is present.
5. `x-contentful-signature` is 64 hexadecimal characters.
6. The URL has no query string.
7. The signature equals HMAC-SHA256, keyed with the current or previous signing secret of an App Definition that lists the space, over the canonical request: the method, `encodeURI(path)`, the signed headers sorted by name as `name:value` (value trimmed) joined by `;`, and the exact body, joined by newlines. The path is the full path the backend receives, including the Backend URL's path; a backend removes its prefix only to choose the route, after verifying.

The App Definition whose secret verifies the request is the caller; because signing secrets are unique, at most one can. The space header only selects the candidates. The verified App Definition, space, environment, and user identify the request from then on.

The signature is the backend's caller authentication. Contentful creates it server-side for a user with access to the space environment, so the signing secret never reaches the browser, and each signature binds that user, the request body, and a 60-second window. Do not add or substitute a static API key or bearer token: the frontend would have to read it from installation parameters or the App Bundle, where every user who opens the app can copy it and reuse it without expiry. CORS is not authentication.

## Health

Request: a JSON object with `contract: 1`. The frontend sends `{ "contract": 1 }`; other properties are ignored. Any other contract returns `400 unsupported_contract`.

Response `200`:

```json
{
  "contract": 1,
  "status": "ok",
  "modelCall": false,
  "providerConfigured": true,
  "providers": [
    { "alias": "primary", "host": "model.example", "timeoutSeconds": 600, "model": "example-model" },
    { "alias": "Admin selects", "host": "model.example", "timeoutSeconds": 600, "modelSelection": "installation" }
  ],
  "limits": { "requestBytes": 2097152, "providerBodyBytes": 4194304, "resultBytes": 4194304 }
}
```

Health never calls the provider. `providers` lists the verified space's allowed providers in configured order, without credentials or full provider URLs. A fixed alias names its `model`; an admin-selectable alias has `modelSelection: "installation"` and no `model`. Each provider reports its effective `timeoutSeconds`, and `maxCompletionTokens` when its options set one, so the app can warn when a request's estimated output exceeds it. `limits` are the backend's current request and result bounds. App configuration offers them under **Editors may choose** and **Default provider and model**; the dialog starts at the editor's saved default while it is still enabled, otherwise at the installation default, and offers the other enabled choices under **Advanced settings**. Health cannot show whether a saved model still exists or matches the current patterns; translation checks that. `providerConfigured` is true when the host supplies a usage gate.

## Model list

Only app configuration calls this route, when a space admin selects **Load models** for an admin-selectable alias. Requests require `Content-Type: application/json` (`415 invalid_content_type`) and the exact body `{ "provider": "<alias>" }`; other properties return `400 unexpected_property` and a missing or non-string `provider` returns `400 invalid_request`.

A `provider` the verified space does not list returns `400 provider_not_allowed`, and a fixed alias returns `400 model_list_unavailable`, both before any upstream request. Otherwise the relay sends `GET` to the alias's base URL path with `/models` appended (`https://model.example/v1/models`; a trailing `/chat/completions` is dropped first), with the alias's credential and headers, its timeout, and redirects not followed. It reads at most 4 MiB and a `data` array of at most 1,000 entries in the OpenAI-compatible [list format](https://developers.openai.com/api/reference/resources/models/methods/list), keeps only valid model IDs other than `mock`, removes duplicates, sorts them, drops all other metadata, and filters them with the alias's patterns:

```json
{ "models": ["chat-large", "chat-small"] }
```

An empty list is valid. A failed, redirected, timed-out, oversized, or malformed upstream response returns `502 model_list_unavailable`, never a partial list. The route calls no model and reserves no usage. Any user who can sign requests for a listed space can call it; it returns only model IDs. Providers that lack this endpoint, list IDs their chat endpoint rejects, or paginate are not handled; space admins add model IDs by hand instead.

## Translate

Requests require `Content-Type: application/json` (`415 invalid_content_type`). The body is an envelope with exactly two properties: the chosen provider alias and the shared translation request.

```json
{ "provider": "primary", "request": { "contract": 1, "requestId": "example-request", "...": "..." } }
```

A `provider` the verified space does not list returns `400 provider_not_allowed`; a missing or non-string `provider` or a missing `request` returns `400 invalid_request`. For a fixed alias the request's `model` must equal its `model`; for an admin-selectable alias it must pass the alias's patterns (`400 model_not_allowed`). All of these are checked before a usage reservation or provider call. The relay does not fetch the model list per request; the provider rejects an unknown ID itself.

Within the envelope, unknown properties return `400 unexpected_property`, another contract `400 unsupported_contract`, equal source and target locales `400 same_locale`, a request above `limits.requestBytes` `413 request_too_large`, and any other invalid value `400 invalid_request`. Lengths count Unicode code points. Text may not contain characters that XML cannot carry, such as most control characters.

The request is typed JSON. The backend compiles the model messages from it with the shared [compiler](../packages/protocol/src/instructions/compiler.ts); the frontend never sends markup.

| Property | Rule |
| --- | --- |
| `contract` | `3` |
| `requestId` | 1–100 of `A–Z`, `a–z`, `0–9`, `.`, `_`, `:`, `~`, `-`, starting with a letter or digit |
| `entryId` | ID of the entry being translated, 1–100 characters. The usage gate allows one active request per entry. |
| `model` | 1–100 characters |
| `sourceLocale`, `targetLocale` | 1–35 characters, different, both in `availableLocales` |
| `availableLocales` | at most 50 locales |
| `profile`, `profileRevision` | a valid instruction profile version 1 (at most 8 KiB; see [`profile.ts`](../packages/protocol/src/instructions/profile.ts)), and its revision |
| `runGuidance` | optional, at most 1,000 characters, using the profile's variables |
| `variableValues` | optional object of strings (at most 1,000 characters) for the profile's variables only, satisfying their required, choice, and locale rules |
| `context` | optional, at most 200 context fields |
| `fields` | 1–200 work fields with unique `id`s |

Each work field has an `id` (an identifier like `requestId`), the Contentful `fieldId` (1–100), a display `name` (1–200), `part` and `parts` when the field is split, optional `constraints` (`min`, `max`, `countMin`, `countMax`, `itemMin`, `itemMax`, integers ≥ 0), optional `outputGuidance` (at most 4,000), and its `type`:

| `type` | Source |
| --- | --- |
| `text` | `source`: nonblank text of at most 50,000 code points. Long text may be split into parts at paragraphs, line breaks or sentence ends. |
| `array` | `items`: 1–1,000 items with unique `id`s and nonblank `text` of at most 256 code points. Empty and whitespace-only items stay in the app. |
| `richText` | `source`: a typed tree of blocks: units (`unit`, `tag` `p` or `h1`–`h6`, `content`), containers (`tag` `ul`, `ol`, `li`, `blockquote`, `table`, `tr`, `th`, `td`, optional `colspan` and `rowspan`, `children`), rules (`tag: "hr"`), and embeds (`tag: "embed"`, `kind`). Unit content is text and inline anchors: marks (`mark`, `tag` `strong`, `em`, `u`, `s`, `sup`, `sub`, `code`, `children`), links (`link`, `children`), breaks (`break`), placeholders and fixed code text (`placeholder` or `fixed`, `text`), and references (`ref`). Anchor IDs are scoped to their unit. At least one unit and at most 200,000 readable code points. |

A context field has an `id`, a `role` (`explicit` for the editor's selection, `sibling` for another selected field sent in a different request, `outline` and `neighbor` for a split part's headings and surrounding source), `entryId`, `fieldId`, `name`, `locale`, `provenance` (`current-editor`, or `saved-entry` with the saved entry's `version`), `omittedUnits`, and its readable `value`. An `outline` or `neighbor` names its work field in `for`; a `neighbor` also has `position` `before` or `after`.

Response `200`:

```json
{
  "contract": 1,
  "requestId": "example-request",
  "provider": "openai-compatible",
  "profileRevision": "factory-1",
  "results": [
    { "id": "f-title", "status": "ok", "type": "text", "text": "Toimitus & palautukset" },
    { "id": "f-tags", "status": "ok", "type": "array", "items": [{ "id": "i0", "text": "Kotiinkuljetus" }] },
    { "id": "f-body", "status": "ok", "type": "richText", "markup": "<p id=\"u0\">Toimitamme <strong data-mark=\"m0\">ovellesi</strong>.</p>" },
    { "id": "f-note", "status": "failed", "error": "missing" }
  ]
}
```

The response echoes `contract`, `requestId`, and `profileRevision`, and has one result per requested work field in request order. `provider` is `mock` or `openai-compatible`. A text result contains the model's text; an array result contains its item IDs and text in the returned order; a Rich Text result contains its canonical markup. The backend checks the response format, not preservation of the source: changed item counts or IDs, missing formatting or anchors, and changed Rich Text blocks are returned for frontend review. It does not restore locked text or replace the model's block tree with the source tree. A missing field or invalid field format fails alone (`missing`, `invalid_items`, or `invalid_structure`) while valid siblings survive.

The frontend reconstructs suggestions and compares them with its frozen source. Changes to formatting, blocks, links, embeds, breaks, code or protected text, and additional request tags in text, produce warnings that require approval of the exact suggestion before Apply; editing clears that approval. Contentful document, field and reference validity remain hard frontend checks. If a value cannot be reconstructed safely, its returned content is still shown as escaped text for inspection and retry, with Apply disabled. Model markup is never rendered directly as HTML.

### Model-facing markup

The model receives one user message of custom markup and writes plain characters back. Text is serialized verbatim except a `<` that would begin a tag of the markup's vocabulary, a declaration or a comment, and an `&` that would begin a reference, so `Delivery & returns <fast>` stays as written. The reader recognizes a tag only by position: in a text value, `<p>` is text; in a Rich Text unit, inline tags are structure and `<unknown>` is text. Only the `amp`, `lt`, `gt`, `quot`, and `apos` references and character references are decoded, once. Inside a field, declarations, comments, CDATA, processing instructions, namespaces, and a literal closing tag of an open element are rejected, and markup is never repaired. The reader looks only for `<field>` elements: the `<translation>` root, an echoed `<fields>` wrapper or any other wrapper, commentary, code fences, and declarations around the fields are ignored, and so are fields with IDs the request did not ask for. When the request has one field, a result field without an `id` answers it. Unreadable or truncated field markup, a literal `<field>` inside a value, and a stray `</field>` fail the whole response with `502 invalid_provider_response`; a requested field that appears twice fails alone with `invalid_structure`. Only `id` is read from result fields and items; other attributes, including `type`, are ignored, and values are read by the requested type. The [paired example](../packages/protocol/tests/fixtures.ts) shows a request and its response.

At a field boundary, the reader removes an echoed `<source>…</source>` wrapper or a lone trailing `</source>`, including whitespace after that delimiter. Text sources that mention literal or escaped source tags are kept unchanged; additional request tags in their suggestions are left for frontend warning approval. Ordinary Markdown and HTML are preserved.

## Provider and model policy

- The request `model` must equal the chosen provider's fixed `model` or pass its `models` patterns (`400 model_not_allowed`). The relay sends that model to the alias's provider without changing the alias's configuration, so two models under one alias stay separate. It calls only that provider's configured HTTPS endpoint, with redirects not followed.
- The provider call streams (`stream: true`). The relay parses server-sent events incrementally across split UTF-8 sequences, lines, and events, within the stream, event, and generated-content limits. A buffered JSON completion is also accepted. Success needs a `stop` finish; a `length` finish returns `provider_truncated`, a refusal or content filter `provider_refused`, tool calls `invalid_provider_response`, and a stream that ends without a finish `provider_incomplete`. No partial content is ever returned.
- The deadline is the request's arrival time plus the alias's `timeoutSeconds`; the idle timeout restarts with every received chunk but never extends the deadline. Either ends the call with `504 provider_timeout`. A provider `413`, or a `400` that names a context-length or size problem, returns `413 provider_request_too_large`. A result above `limits.resultBytes` returns `502 result_too_large`.
- Mock mode (`MOCK_TRANSLATION_ENABLED=true`) applies the same signature, provider-list, and model checks, then answers through the same reader: text and items marked `[<targetLocale> example]` or `[<targetLocale>]`, and Rich Text unchanged.
- Editors choose only among the choices the installation enabled from those health lists. They cannot supply endpoints, credentials, headers, or provider options; those come only from `RELAY_CONFIG` and its secrets. A rejected choice shows the editor “This choice is no longer available”, and the app never retries with another choice.
- The model receives the instruction profile of the signed request between a code-owned description of the request and code-owned output rules, then the request content, compiled by [`compiler.ts`](../packages/protocol/src/instructions/compiler.ts). Source text, context, and variable values are data. The relay does not check the profile against the installation's saved one: the app sends the administrator's templates, but anyone who can open the app in a listed space can sign a request with other instructions and any content up to the request limits. The aliases and model patterns in `RELAY_CONFIG`, the request limits, and the provider's own quotas are the only limits on what the operator's credential pays for; see [Usage gate](#usage-gate).
- Response time grows with the amount of text. Planning assumes about 0.825 output tokens per source character and 50 tokens per second, so 20,000 source characters take about 330 seconds; these are estimates, not guarantees for any model. On a host with a short limit, lower the request size per model in app configuration, or let editors retry in smaller batches.

## Usage gate

Each verified scope has one usage gate. The scope is the SHA-256 hex digest of the JSON array `[appDefinitionId, spaceId, environmentId]`, so equal entry IDs in different environments, spaces, or App Definitions never contend. A request reserves its entry after validation and before the provider call; mock mode skips the gate. At most one request for that entry can run at a time, with no scope or user active-request cap; requests for other entries can run concurrently. The caller chooses the entry ID, so the gate prevents accidental parallel runs on one entry, not deliberate parallel use: set spending limits at the provider. The reservation is released when the request completes, including after a provider failure. A later request for the same entry can start immediately with a new request ID; review and Apply do not hold the reservation. An unreleased reservation expires at the request's deadline plus a 10-second cleanup margin, as a recovery measure, not a cooldown; the backend sets that time, and the host's runtime limit must leave the margin.

A request ID already seen is rejected (`429 duplicate_request`). A refused reservation (`429 concurrency_limit`) is not recorded, so the frontend can retry that same request ID. Gates store only request and entry IDs and times, and keep a request ID for a day after its reservation, well beyond the signature window. Storage is the host's choice; the Cloudflare host uses one SQLite Durable Object per scope, the Azure Functions host uses one Azure Table Storage partition per scope with optimistic concurrency, and the AWS Lambda host uses DynamoDB items keyed by scope with conditional writes, keeping request IDs for a day. The npm package offers a process-local memory gate for a single Node.js process, the Azure Table Storage gate, and an interface for a shared gate of the consumer's own.

## Errors and retries

Every error body is exactly `{ "error": "<code>" }`. Provider response text, credentials, and request content never appear in errors, unless the relay runs in debug mode.

**Debug mode.** With `"debug": true` at the top level of `RELAY_CONFIG`, a failed translation also returns `debug`, an object of what the provider sent: `reason` (the reader's or relay's explanation), `answer` (the model's whole answer so far), `finishReason`, or the provider's HTTP `status` and error `body`, as applicable. The translate dialog shows it under the failed field to anyone who can use the app. This content is not redacted: answers contain the editor's translated content, and a provider or gateway error body can contain account details or echo a submitted credential or header. Turn relay debug mode on only while troubleshooting, and off again afterwards. It is separate from the app's own **Debug mode** setting, which shows editors the messages the app sends.

| Status | Code | Meaning | Frontend retry |
| --- | --- | --- | --- |
| 400 | `invalid_encoding`, `invalid_json`, `unexpected_property`, `same_locale`, `invalid_request`, `model_not_allowed` | Invalid request | No |
| 400 | `unsupported_contract` | The app and backend versions differ | No; update the backend |
| 400 | `provider_not_allowed` | The space does not list the chosen provider alias | No |
| 400 | `model_list_unavailable` | Model list requested for a fixed-model alias | No |
| 401 | `invalid_signature` | Signature, identity, or timestamp check failed, or no App Definition lists the space | No |
| 404 | `not_found` | Unknown route or method | No |
| 413 | `too_large`, `request_too_large` | Body too large | Editor may retry in smaller batches |
| 413 | `provider_request_too_large` | The provider rejected the request as too large for its context or body | Editor may retry in smaller batches |
| 415 | `invalid_content_type` | Translation or model list body is not JSON | No |
| 429 | `concurrency_limit` | Another request for the same entry is still running | Yes: the same request ID, after 1, 2, 4, then 8-second waits, for at most 2 minutes of backoff, unless cancelled; then show the editor a retry message |
| 429 | `duplicate_request` | Request ID already used | No |
| 429 | `provider_rate_limited` | Provider rate limit | No |
| 502 | `provider_failed`, `provider_auth_failed`, `provider_refused`, `invalid_provider_response`, `relay_unavailable` | Provider error, rejected credential, refusal, unusable provider result, or other failure | Editor may retry |
| 502 | `provider_truncated`, `provider_incomplete`, `result_too_large` | The answer was cut off, ended early, or is too large to return | Editor may retry in smaller batches |
| 502 | `model_list_unavailable` | The provider's model list failed or was unusable | No; the space admin can retry or add IDs by hand |
| 503 | `relay_misconfigured` | `RELAY_CONFIG` or a secret it names is invalid | No |
| 503 | `translation_not_enabled` | The host supplies no usage gate | No |
| 504 | `provider_timeout` | Provider did not finish before the deadline or stalled past the idle timeout | Editor may retry in smaller batches |

The app retries automatically only for `concurrency_limit`. Every other retry is the editor's explicit choice: **Retry** repeats the failed work with new request IDs, and **Retry in smaller batches** separates grouped fields and splits arrays, Rich Text, and Long text at safe boundaries.

## Conformance mapping

Each mandatory rule has a case in [`relay-suite.ts`](../packages/relay-conformance/src/relay-suite.ts) or [`usage-gate-suite.ts`](../packages/relay-conformance/src/usage-gate-suite.ts). A host runs `describeRelayConformance` against its HTTP adapter and `describeUsageGateConformance` against its gate. `pnpm test` runs them against the relay handler with the in-memory reference gate and with the npm package's memory gates, at the root and beneath a base path, the Cloudflare Worker with its Durable Object gate, the npm package's Azure handler with an in-memory gate, beneath a route prefix, and with Table Storage on Azurite, the standalone Azure Functions settings, the npm package's Node.js listener beneath a base path, and the AWS Lambda function URL adapter with an in-memory gate store. `pnpm test:dynamodb` runs the Lambda gate against DynamoDB Local.

| Rule | Conformance case |
| --- | --- |
| Routes, methods, preflight | serves only POST /v1/health, /v1/translate and /v1/models and answers their preflight |
| CORS headers | returns wildcard CORS headers while requiring a valid signature for POST; accepts a signed request from any origin or without Origin |
| Signature, identity, and timestamp | rejects an unlisted space, stale timestamp, and tampered body; rejects incomplete or malformed signatures |
| Every environment of a listed space | accepts any signed environment of a listed space, such as a clone |
| App Definition chosen by its secret | identifies the App Definition by the signing secret that verifies the request |
| Signing secret rotation | accepts the previous signing key during rotation and rejects an unrelated key; identifies the App Definition by the signing secret that verifies the request |
| Configuration validation | answers relay_misconfigured for an invalid configuration before verifying signatures |
| Body limits, UTF-8, JSON | bounds request bodies and requires UTF-8 JSON; rejects an oversize body |
| Health contract, providers, timeouts and limits, no model call | accepts valid request and returns safe contract metadata; negotiates health contract 1 without a model call; lists only the providers the calling space allows |
| Envelope and translation request validation | rejects invalid translation requests with stable codes |
| Provider choice and model | routes each allowed provider to its configured endpoint, model, and credential; rejects unlisted providers, mismatched models, and tampered envelopes before any provider call; enforces the provider model and usage gate before a provider call |
| Admin-selectable aliases in health | lists an admin-selectable alias in health without a model |
| Model list | lists provider models for an admin-selectable alias within the deployer policy, without a model call or usage reservation; refuses model lists outside the caller space, for fixed aliases, and for malformed requests; maps missing, malformed, redirected, and failing model list endpoints to model_list_unavailable |
| Admin-selected model policy | translates with an admin-selected model the configuration does not name, within the deployer policy; rejects excluded, malformed, and mock models for an admin-selectable alias before the usage gate or provider; rejects a previously listed model once a deny rule is active |
| Distinct models and shared providers | keeps concurrent requests for two models under one admin-selectable alias distinct; routes two fixed aliases that share an endpoint and credential with their own model and options |
| Mock mode only when enabled | keeps the translation route disabled without a usage gate unless mock translation is on; answers mock translation only for a listed provider and its model |
| One contract version | rejects other contracts so the app asks for a backend update; rejects invalid translation requests with stable codes |
| Deadline, idle timeout, and result bound | reserves until the request deadline plus cleanup margin and ends an idle provider at its timeout; answers result_too_large when the result exceeds the configured result bound |
| Provider settings | calls a configured provider only after a usage reservation and releases it; accepts an explicitly unauthenticated provider with request options |
| Reservation before provider call, release after | calls a configured provider only after a usage reservation and releases it; maps provider failures to safe error codes and releases the reservation |
| Gate scope | reserves equal entry IDs separately per verified environment, space, and App Definition |
| Busy request can be retried | rejects a busy request before reserving it so the same request can be retried |
| Safe error mapping | maps provider failures to safe error codes and releases the reservation |
| Gate policy: limits and duplicates | rejects duplicate IDs and one active request per entry while allowing other entries; has no daily budget once earlier requests finish |
| Gate policy: server-owned expiry | expires an unreleased reservation at its server-owned expiry |

The frontend's envelope and retry behavior is covered by the root `signed-client` tests. Host tests also check that the Cloudflare Worker names one Durable Object per verified scope and rejects a ref that reuses its `USAGE_GATE` binding, that the Azure gate prunes stale request rows across every scope partition, and that the Lambda backend reads secrets only from its JSON secret and keys its DynamoDB items by scope, also against DynamoDB Local in `pnpm test:dynamodb`.

## Host choices

These are not part of the wire contract: how the host stores the usage gate, where it keeps `RELAY_CONFIG` and how it resolves refs from its secret store, which setting names it reserves, how it converts its event type to a Web `Request` and `Response`, logging (never log request content, credentials, or provider bodies), and deployment tooling.
