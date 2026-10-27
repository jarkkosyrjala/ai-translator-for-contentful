# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and select **Report a vulnerability**. Do not open a public issue.

Include the affected component (frontend, Cloudflare Worker, Azure Functions backend, AWS Lambda backend, npm backend package, Contentful Function, or a script), the version or commit, and steps to reproduce. Never include real credentials, signing secrets, or customer content; use synthetic data.

This is a volunteer-maintained project. Reports are handled on a best-effort basis, without a guaranteed response time. Published fixes are described in their release notes.

## Supported versions

Only the latest release receives security fixes.

## Scope

In scope: this repository's code, its release artifacts, and its documented installation steps. Contentful, Cloudflare, Microsoft Azure, AWS, and model providers are out of scope; report their issues to them.

## Leaked credentials

If a credential may have leaked, replace it first.

- **Signing secret:** do not use the zero-downtime rotation, which keeps the leaked secret valid as the previous one until it finishes. Generate a new secret in the App Definition's **Security** tab, which replaces the old one at once, and set it as the only signing secret in the backend's secret store straight away, without a previous secret. Requests fail until both sides have the new value.
- **Provider API key:** replace it in the backend's secret store, or for a Contentful Function as described in [Secrets](docs/contentful-function.md#secrets), and revoke the old key with the provider.
- **Contentful personal access token:** revoke it under **Account settings > CMA tokens** and create a new one for the scripts or CI that used it.
