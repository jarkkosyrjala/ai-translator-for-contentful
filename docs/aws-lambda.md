# AWS Lambda installer guide

The AWS Lambda backend is a **Custom backend** that runs in your own AWS account. It stores the provider credentials and the App Definitions' signing secrets in AWS Secrets Manager, and calls the model. The browser never receives a secret.

One stack serves every space, App Definition, and provider listed in its [`RELAY_CONFIG`](backend-contract.md#relay-configuration), including every environment of a listed space. It creates:

- a Lambda function on the `nodejs24.x` runtime (arm64) with a public [function URL](https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html). The URL needs no AWS authentication; the backend accepts only requests with a valid Contentful signature;
- a Secrets Manager secret for the credentials;
- an on-demand DynamoDB table for the usage gate, keyed by App Definition, space, and environment, which allows one active translation request per entry; other entries can translate at the same time;
- a CloudWatch log group with a retention period.

## Before you start

- An App Definition created as in [Installation](installation.md#3-create-the-app-definition).
- An AWS account and a [Region with function URLs](https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html), with permission to create the resources above and IAM roles.
- The [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) and AWS credentials for that account. The AWS CLI is optional.
- An OpenAI-compatible Chat Completions API, a model ID, and a credential if required.
- This repository at the release tag, with dependencies installed: `pnpm install`.

## 1. Upload the static App Bundle

Upload the static App Bundle as in [step 1 of the Worker guide](cloudflare-worker.md#1-upload-the-static-app-bundle).

## 2. Deploy the stack

Write the relay configuration first, as described in the [backend contract](backend-contract.md#relay-configuration): the App Definition ID, the spaces it serves with their allowed provider aliases, each provider's base URL and model, and the names (refs) of the secrets you will store in step 3. For example, with one App Definition, one space, and one provider:

```json
{"appDefinitions":{"<app-definition-id>":{"signingSecretRef":"APP_SIGNING_SECRET","spaces":{"<space-id>":["primary"]}}},"providers":{"primary":{"baseUrl":"https://model.example/v1","model":"example-model","credentialRef":"PROVIDER_API_KEY"}}}
```

Then build the function and deploy the AWS SAM template from the package folder. Keep the stack name for later deployments.

```sh
pnpm lambda:build
cd backends/aws-lambda
sam deploy --guided --stack-name ai-translator-for-contentful
```

To deploy a packaged build instead, run the same `sam deploy` command in the `aws-lambda` folder of `artifacts/ai-translator-for-contentful-<commit>/`; it contains `template.yaml` and the built function.

The guided deployment asks for these parameters. None of them is secret.

| Parameter | Value |
| --- | --- |
| `RelayConfig` | The relay configuration as one line of JSON. Lambda limits a function's environment variables to 4 KB in total. |
| `FunctionTimeout` | The Lambda timeout in seconds, 60–900. Default `610`. Provider deadlines must stay 10 seconds below it, so the default fits the 600-second default deadline; raise it to `900` to allow an alias `timeoutSeconds` of up to 890. The function reads the same value from `FUNCTION_TIMEOUT_SECONDS`. |
| `LogRetentionInDays` | How long CloudWatch keeps the function's logs. Default `30`. |

Answer **Y** to **Allow SAM CLI IAM role creation**, and to **RelayFunction Function Url has no authentication. Is this okay?**: the function authenticates each request with Contentful's signature instead. SAM adds the `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` permissions that a public function URL needs, the latter limited to calls through the URL. Save the answers to `samconfig.toml` when asked; Git ignores it.

The deployment prints three outputs: `BackendUrl`, `SecretArn`, and `FunctionName`. Until step 3 is done, the backend answers `relay_misconfigured`.

## 3. Store the secret

The secret holds one JSON object that maps each ref in `RelayConfig` to its value, for example:

```json
{ "APP_SIGNING_SECRET": "<signing secret>", "PROVIDER_API_KEY": "<provider API key>" }
```

- A signing secret comes from the App Definition's [**Security** tab](https://app.contentful.com/deeplink?link=app-definition&tab=security). Each App Definition needs its own.
- A provider credential is the model API's key. A `headersRef` value is a JSON object of extra provider headers, stored as a string.

Keys must be ref names (`^[A-Z][A-Z0-9_]*$`) other than `RELAY_CONFIG`, `MOCK_TRANSLATION_ENABLED`, `RELAY_SECRET_ID`, `USAGE_TABLE_NAME`, and `FUNCTION_TIMEOUT_SECONDS`, and values must be strings. Any other key, a non-string value, or invalid JSON makes the backend answer every request with `relay_misconfigured` and log `relay_secret_unavailable`; a missing or empty ref logs `relay_config_invalid` with its property path.

In the Secrets Manager console, open the secret named by `SecretArn`, choose **Retrieve secret value**, then **Set secret value** or **Edit**, and enter the keys on the **Key/value** tab. With the AWS CLI, write the JSON to a file outside the repository that only you can read, store it, and delete the file:

```sh
aws secretsmanager put-secret-value --secret-id <SecretArn> --secret-string file://<path>/relay-secret.json
rm <path>/relay-secret.json
```

The stack creates the secret without a value and never changes it, so later deployments keep it. Each function instance caches the secret for up to a minute.

## 4. Connect the app

1. Install the app in a listed space environment if you have not yet, and open its configuration. Choose **Custom backend**.
2. Enter the `BackendUrl` output as **Backend URL**, for example `https://<url-id>.lambda-url.<region>.on.aws/`.
3. Select **Test connection**. A signed health check runs; no model is called. Under **Editors may choose**, check the providers and models editors may use, and choose the **Default provider and model**; a single fixed-model provider is selected for you. Click **Save**.
4. With test content, translate one field, apply the suggestion, and reload to confirm the draft value. Nothing is published.

Editors start with the default. When the installation enables several choices, they can pick another for one translation under **Advanced settings** in the translate dialog. A provider the operator adds later stays hidden until a space admin enables it. A cloned environment of a listed space needs no backend change. To let space admins choose a provider's models, give it `models` instead of `model`; see [the backend contract](backend-contract.md#relay-configuration) for patterns and tradeoffs.

Each translation request groups several fields into one language, up to the request size the space admin sets per model under **Request size per choice** (20,000 source characters by default, the app's default for a Custom backend). The relay streams the model's answer and stops it at the provider deadline: 600 seconds by default, at most the `FunctionTimeout` minus 10 seconds. With `FunctionTimeout` 900 an alias can wait up to 890 seconds, enough for the estimated 825 seconds of a whole 50,000-character Long text field, which is sent whole only when the model's request size is at least 50,000. Results are limited to 2 MiB by default so that the function URL result, with its second JSON escaping, stays within 6 MiB. Set `timeoutSeconds` and `idleTimeoutSeconds` per provider, and the optional `limits` object for request and result sizes, in the [relay configuration](backend-contract.md#relay-configuration). A value beyond the host's bound makes the backend answer `relay_misconfigured`; it is never shortened silently.

## Change the configuration

To add or remove a space, App Definition, or provider, edit the JSON and run `sam deploy --guided` again with the new `RelayConfig`. Add the secrets a change needs before deploying it, and remove secrets the configuration no longer names only after the new configuration is live. Every space that should use the backend enters the same `BackendUrl`.

## Update

Build and deploy again with the saved answers. The configuration, the secret, the usage table, and the function URL are kept.

```sh
pnpm lambda:build
cd backends/aws-lambda
sam deploy
```

Before deploying a change, run `pnpm --filter @ai-translator-for-contentful/backend-aws-lambda test`, `pnpm typecheck`, and `pnpm check:artifacts`. To run the usage gate against DynamoDB Local as CI does:

```sh
docker run --rm -p 8000:8000 amazon/dynamodb-local:3.3.2
DYNAMODB_ENDPOINT=http://localhost:8000 pnpm test:dynamodb
```

## Rotate the signing secret

Each App Definition rotates on its own.

1. Choose a [new signing secret](backend-contract.md#set-a-chosen-signing-secret) and add it to the secret JSON under a new name. In `RelayConfig`, set that App Definition's `signingSecretRef` to the new name and `previousSigningSecretRef` to the current one, deploy, and wait a minute. The backend accepts both.
2. [Set the new secret in Contentful](backend-contract.md#set-a-chosen-signing-secret).
3. Remove `previousSigningSecretRef` from `RelayConfig` and deploy, then remove the old key from the secret.
4. Select **Test connection** in an installation. While both secrets were accepted, a passing test could not show which one Contentful used.

Rotate a provider credential by changing its value in the secret. Requests use the new value within a minute.

## Roll back, pause, and remove

- **Roll back:** run `sam deploy` in the last working `aws-lambda` artifact folder, or check out the tag or commit used to build it, run `pnpm lambda:build`, and deploy from `backends/aws-lambda`. To roll back the frontend, reactivate the last working bundle on the App Definition's **Bundles** tab.
- **Pause:** `aws lambda put-function-concurrency --function-name <FunctionName> --reserved-concurrent-executions 0` makes the function URL answer every request with `429`. Remove it with `aws lambda delete-function-concurrency --function-name <FunctionName>`. A small reserved concurrency, such as 5, caps how many requests run at once.
- **Remove:** `sam delete --stack-name <stack-name>` deletes the function, its URL, the usage table, the secret, and the log group.

## Troubleshooting

| Message | Check |
| --- | --- |
| The backend rejected this app's signed request (`invalid_signature`) | The App Definition's signing secret in the secret matches its **Security** tab, and `RelayConfig` lists this space under this App Definition. |
| The backend's configuration is invalid (`relay_misconfigured`) | `RelayConfig` and the secret. A `relay_config_invalid` log entry names the property, and `relay_secret_unavailable` gives the reason the secret could not be used. `FUNCTION_TIMEOUT_SECONDS` must match the function's timeout, and no alias `timeoutSeconds` may exceed it minus 10. |
| Any other **Test connection** failure | The **Backend URL**. The function URL returns `403 Forbidden` without a JSON body when the function's resource-based policy lacks the invoke permissions, and `429` while the function is paused. |
| Another translation for this entry is still running (`concurrency_limit`) | Another request for this entry was still running after the app had retried for two minutes. Retry when it finishes. |

Logs are in the function's CloudWatch log group. The backend never logs request text, credentials, or provider responses. Do not paste credentials, signing secrets, request text, or provider responses into issues. The full error table is in the [backend contract](backend-contract.md#errors-and-retries).
