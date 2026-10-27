# AI Translator for Contentful

AI Translator for Contentful suggests translations for localized entry fields. Editors choose what to translate, compare each suggestion with the current value, and write the values they accept to the entry's draft. An editor starts every translation, and the app never publishes. The app checks field limits, placeholders, and Rich Text structure; editors judge the wording.

This is an independent project built for Contentful. It is not affiliated with or endorsed by Contentful.

## Features

- Translate localized Short text, Long text, Short text list, and Rich Text fields into one or more locales.
- Start from the entry sidebar to translate several fields, or from a single field with the optional field editor.
- Use the values shown in the editor, including unsaved changes, as the source. Context fields from other entries use their saved values.
- Add guidance and context fields for each run. Administrators set shared instruction templates and variables for each installation.
- Compare the source, current value, and suggestion for each field and locale. Keep the current value, use or edit the suggestion, or retry.
- Keep Rich Text blocks, formatting, links, and embedded entries and assets in place.
- Write accepted values to the draft only after checking that the entry has not changed in the editor since translation.

## Requirements

- A Contentful space where you can create and install a [custom app](https://www.contentful.com/developers/docs/extensibility/app-framework/overview/).
- An OpenAI-compatible Chat Completions API and a model. Supply a credential if the provider requires one. The provider may charge for usage.
- One backend that calls the model and keeps any provider credential out of the browser:

| Backend | Runs in | App Bundle | Guide |
| --- | --- | --- | --- |
| Cloudflare Worker | Your Cloudflare account | Static | [Worker guide](docs/cloudflare-worker.md) |
| Azure Functions | Your Azure subscription | Static | [Azure guide](docs/azure-functions.md) |
| AWS Lambda | Your AWS account | Static | [AWS guide](docs/aws-lambda.md) |
| Contentful Function | Contentful, on Premium and Enterprise plans | Function | [Function guide](docs/contentful-function.md) |

The Worker, Azure, and AWS backends are **Custom backends**: HTTPS services that follow the [backend contract](docs/backend-contract.md). The [npm package](packages/backend/README.md), built from this repository and not published to the npm registry, runs the same backend in a Node.js server, another serverless platform, or a route of an existing Azure Function App. Another host can implement the same contract.

Contentful serves the app's frontend from an [App Bundle](https://www.contentful.com/developers/docs/extensibility/app-framework/app-bundle/) uploaded to your App Definition. This project builds two:

- The **static App Bundle** contains only the frontend. Use it with a Custom backend. Each GitHub release includes it as `static-app-bundle-v<version>.zip`.
- The **Function App Bundle** adds the Contentful Functions. Build it from source for each App Definition, because it lists the provider hosts the Functions may call.

## Documentation

- [Installation](docs/installation.md): create the App Definition, install, configure, and uninstall.
- [Editor guide](docs/editor-guide.md): translate, review, and apply.
- [Privacy and data flow](docs/privacy.md): what is sent where.
- [Backend contract](docs/backend-contract.md): the HTTP contract for Custom backends.
- [Local development](docs/local-development.md): run the frontend from your computer.

See [Support](SUPPORT.md), [Security](SECURITY.md), and [Contributing](CONTRIBUTING.md).

## Workspace

- [apps/contentful-app/](apps/contentful-app/): Contentful frontend and editor flow.
- [backends/cloudflare-worker/](backends/cloudflare-worker/): Cloudflare Worker backend.
- [backends/azure-functions/](backends/azure-functions/): Azure Functions backend.
- [backends/aws-lambda/](backends/aws-lambda/): AWS Lambda backend.
- [backends/contentful-function/](backends/contentful-function/): Contentful Function backend.
- [packages/backend/](packages/backend/): the npm package for Node.js servers and existing Azure Function Apps.
- [packages/protocol/](packages/protocol/): shared request types and instruction templates.
- [packages/provider/](packages/provider/): server-side provider adapter.
- [packages/relay/](packages/relay/): shared Custom backend logic.
- [packages/relay-conformance/](packages/relay-conformance/): backend contract tests.
- [docs/](docs/): installation, editor, backend, and contract guides.
- [scripts/](scripts/): packaging, upload, and release tooling.
- [tests/](tests/): cross-package checks.

## Development

Install Node.js 24 or later and pnpm 11 or later. Run pnpm directly; it switches to the version pinned in `package.json`.

- `pnpm install`: install workspace dependencies.
- `pnpm test`: run the automated tests.
- `pnpm typecheck`: check TypeScript across the workspace.
- `pnpm lint`: check formatting, imports, and lint rules.
- `pnpm build`: build the frontend and backend packages.
- `pnpm dev`: serve the frontend at `http://localhost:3000` for [local development](docs/local-development.md).
- `pnpm dev:https`: serve it at `https://localhost:3000`, for Safari.

The backend guides describe each backend's local development and deployment commands.

## License

[MIT](LICENSE)
