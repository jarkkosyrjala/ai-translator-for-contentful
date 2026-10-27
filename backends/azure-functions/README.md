# Azure Functions local settings

[`local.settings.example.json`](local.settings.example.json) is the template for running the backend with Azure Functions Core Tools on your computer. Copy it to `local.settings.json`, which Git ignores, and enter the signing secret and provider API key only there. The template's empty `PROVIDER_API_KEY` is intentional: never put a real key in it.

A Function App in Azure does not use this file. It reads the secrets that `RELAY_CONFIG` names from Azure Key Vault through `@Microsoft.KeyVault(...)` app setting references. Do not publish local settings with `--publish-local-settings`.

See [Local development](../../docs/azure-functions.md#local-development) and [Configure the app settings](../../docs/azure-functions.md#3-configure-the-app-settings) in the Azure guide.
