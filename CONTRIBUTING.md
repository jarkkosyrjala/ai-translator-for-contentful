# Contributing

Contributions are welcome. For anything larger than a small fix, open an issue first so we can agree on the approach.

## Scope

The app stays editor-initiated: editors review every suggestion, and the app writes drafts only. It does not translate automatically, publish, keep translation history, or score translation quality. Changes that alter this are out of scope.

## Development

Requirements: Node.js 24 or later and pnpm 11 or later. See the [README](README.md#development) for the commands.

Before opening a pull request, run:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check:boundaries
pnpm check:artifacts
pnpm check:backend-package
git diff --check
```

- `pnpm lint` runs [Biome](https://biomejs.dev) formatting, import order, and lint checks, and fails on warnings. `pnpm format` applies formatting and safe fixes. Configure your editor's Biome extension to format on save.
- CI also runs `pnpm test:dynamodb` against DynamoDB Local; see the [AWS guide](docs/aws-lambda.md#update) to run it yourself.
- Keep provider credentials and provider code out of the frontend; `check:boundaries` and `check:artifacts` enforce this.
- A change to the backend contract must update [docs/backend-contract.md](docs/backend-contract.md) and the `relay-conformance` suites.
- Build the UI with Forma 36 components from `@contentful/f36-components`.
- Use synthetic content in tests and screenshots. Never commit credentials, real space, environment, or App Definition IDs, or customer content.

## Commits and pull requests

Use `type(scope): short imperative summary`, for example `fix(app): keep focus after Apply`. Use `feat` for features, `fix` for fixes, `perf` for performance changes, `docs` for documentation, and `chore` for maintenance. Add a `BREAKING CHANGE:` footer for an incompatible change. The commit types determine release versions. Keep each pull request focused and explain user-visible changes in its description.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).

## Conduct

Be respectful and constructive. Harassment and personal attacks are not accepted. The maintainer may remove comments, issues, or contributors that break this.
