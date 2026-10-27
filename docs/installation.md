# Installation

Each installation serves one Contentful space environment and uses one backend. One Custom backend can serve several spaces, App Definitions, and providers. You create a private [App Definition](https://www.contentful.com/developers/docs/extensibility/app-framework/app-definition/) in your Contentful organization, upload an [App Bundle](https://www.contentful.com/developers/docs/extensibility/app-framework/app-bundle/) with the app's frontend, deploy the backend, and connect them on the app's configuration screen.

## 1. Choose a backend

- **Custom backend:** an HTTPS service in your own cloud account that follows the [backend contract](backend-contract.md). It stores the provider credentials and the App Definitions' signing secrets, and calls the model. Its configuration lists the spaces each App Definition may serve and the providers each space may use. The included hosts are the [Cloudflare Worker](cloudflare-worker.md), [Azure Functions](azure-functions.md), and [AWS Lambda](aws-lambda.md). To run it in a server or Azure Function App you already operate, use the [npm package](../packages/backend/README.md). It uses the static App Bundle and works on every Contentful plan.
- **Contentful Function:** runs inside Contentful, on Premium and Enterprise plans. Contentful stores any provider credential as a Secret installation parameter. It uses the Function App Bundle, which you build with the provider hosts the Function may call. See the [Function guide](contentful-function.md).

Use separate App Definitions for the two kinds of installation. Never upload the static App Bundle to an App Definition that has Functions: the upload can remove them.

**Costs and spending.** Every translation, **Test model**, and retry is a model call that the provider charges to your account. The backend's host charges for its own services, such as Workers and Durable Objects on Cloudflare; Functions, Key Vault, Table Storage, and Application Insights on Azure; or Lambda, Secrets Manager, DynamoDB, and CloudWatch on AWS. A Custom backend accepts signed requests from anyone who can use the app in a listed space, with instructions and content they choose, so set spending limits with the provider; see the [backend contract](backend-contract.md#provider-and-model-policy).

## 2. Get the code

```sh
git clone https://github.com/jarkkosyrjala/ai-translator-for-contentful.git
cd ai-translator-for-contentful
git checkout v<version>
pnpm install
```

Use the tag of the release you install, so the frontend and backend come from the same version. To upgrade, check out the new tag, then upload its App Bundle and redeploy its backend together.

## 3. Create the App Definition

Create a private App Definition through [Contentful's web app](https://app.contentful.com/) or the [Create Contentful App CLI](https://www.contentful.com/developers/docs/extensibility/app-framework/create-contentful-app/):

- **Web app:** go to **Organization settings & subscriptions** > **Apps** and click **Create app**. On **App details**, under **Locations**, select **App configuration screen** and **Entry sidebar**. To use the optional [field editor](#field-editor), also select **Entry field**. Turn on **Hosted by Contentful**, then click **Save**.
- **CLI:** run `pnpm create-app-definition`. Select **App configuration screen** and **Entry sidebar**, and optionally **Entry field**. Answer **No** to App Parameter schemas. The CLI points the frontend at `http://localhost:3000` until you upload a bundle.

For a Custom backend, open the App Definition's [**Security** tab](https://app.contentful.com/deeplink?link=app-definition&tab=security), enable request verification, and generate a signing secret. [Contentful's guide](https://www.contentful.com/developers/docs/extensibility/app-framework/request-verification/#establishing-a-signing-secret) shows the steps. Copy the secret when it appears; Contentful does not show it again. You will store it in the backend's secret store.

To set the app's icon in Contentful, click the icon beside the app name on **App details** and upload [`icon.svg`](../apps/contentful-app/public/icon.svg). The SVG uses a 16×16 canvas and scales to larger sizes. App icons are stored separately from the App Bundle; the frontend uses the same file as its browser favicon.

### Field editor

Optional. With the **Entry field** location, AI Translator can replace a field's editor with Contentful's built-in editor plus a **Translate** button that starts from that field and locale. The sidebar works without it.

1. On **App details**, select **Entry field** under **Locations** to show its field types. Select **Short text**, **Short text, list**, **Long text**, and **Rich text**.
2. Optional: add an instance parameter so each field can choose which built-in editor the app renders. Without it, each field gets Contentful's default editor for its type: Single line for Short text, Markdown for Long text, Tags for lists, and the Rich Text editor.

   | Setting | Value |
   | --- | --- |
   | ID | `editor` |
   | Name | Editor |
   | Type | Enum (Select), not required |
   | Options | `markdown` (Markdown), `multipleLine` (Multiple line), `singleLine` (Single line), `tagEditor` (Tags), `listInput` (List) |

   A value that does not fit the field type falls back to the default editor. Long text accepts Markdown, Multiple line, and Single line; lists accept Tags and List.
3. Click **Save**.
4. After installing, open a content type, edit a localized text field, and under **Appearance** choose **AI Translator**. Keep the default appearance for fields with predefined values or a pattern validation: they cannot be translated, and the app's editor has no dropdown for predefined values.

## 4. Upload the App Bundle and deploy the backend

Follow your backend guide:

- Cloudflare Worker: steps 1 and 2 of the [Worker guide](cloudflare-worker.md).
- Azure Functions: steps 1 to 4 of the [Azure guide](azure-functions.md).
- AWS Lambda: steps 1 to 3 of the [AWS guide](aws-lambda.md).
- Contentful Function: steps 1 to 5 of [Deploy to a selected environment](contentful-function.md#deploy-to-a-selected-environment).

A Custom backend can use the static App Bundle ZIP from the GitHub release or a bundle built from the same tag. The Function App Bundle is always built from source with your provider hosts.

A Custom backend's configuration lists, for each App Definition, the spaces it serves:

- **App Definition ID:** shown on the App Definition's page.
- **Space ID:** the ID of each space where you install the app. Find it under **Settings** > **General settings**; see [Find space ID](https://www.contentful.com/help/spaces/find-space-id/).

Every environment of a listed space is served, including cloned environments, so environment IDs are not configured.

## 5. Install and configure

1. On the App Definition page, click **Install to space** and choose the space and environment. The app's configuration screen opens.
2. Under **Translation service**, choose how the app reaches the model:
   - **Custom backend:** enter the **Backend URL**, the address of your deployed backend, such as the Worker's `workers.dev` URL. Include its path when the backend is served beneath one, such as `https://<existing-app-host>/api/ai-translator`. It is not the model API's URL; the backend has that in its own configuration. Select **Test connection**. Under **Editors may choose**, check the providers the backend allows for this space that editors may use; for a provider whose models you choose, select **Load models** and check models, or add model IDs. Then choose the **Default provider and model**. The backend operator decides what the space can use; this list only controls what editors see.
   - **Contentful Function:** enter the model API's **Provider URL**. Add a **Provider API key** if required; otherwise choose **No authentication** under **Advanced provider settings**. Save. Then, under **Models editors may use**, select **Load models** and check models, or add model IDs, choose the **Default model**, and save again.

   Editors start with the default and can pick another enabled choice for one translation under **Advanced settings**. **Load models** lists IDs from the provider without calling a model. **Test model** sends one short synthetic translation; it is a paid model call. A model being listed or answering a test says nothing about its translation quality.

   **Test connection** never calls the model.

   Optional: under **Request size per choice** (Custom backend) or **Request size per model** (Contentful Function), set how many source characters one request carries; larger Long text, list and Rich Text fields are split at paragraphs (or line breaks and sentence ends), items or blocks. **Advanced request settings** hold the context and retry limits. Blank values use the defaults: 20,000 characters for a Custom backend and 10,000 for the Function. Lower the size for slow models or a backend with a short timeout, such as Azure's 220 seconds.
3. Optional: under **Instruction templates**, edit the **Always-applied app instruction** (brand voice, audience, terminology) and the **Task template**, and add **Custom variables** for values editors fill in for each run, such as a tone. Edited templates take effect when you save; until then the app uses its built-in instructions. **Reset to default** restores one template's default text. Templates refer to the request's parts as `{content}` (the fields to translate), `{selectedContext}`, and `{perRunGuidance}`, which the model sees as the request elements `<fields>`, `<context>`, and `<runGuidance>`; locales are inserted as codes. A profile saved by an earlier app version stops translation until you select **Reset to defaults**, review it, and save.
4. Under **Content types**, choose the content types whose entries show AI Translator in the sidebar. Only content types with translatable fields are listed. Fields that use the [field editor](#field-editor) keep it.
5. Under **Editor options**, leave **Debug mode** off unless editors need to see the messages sent to the model.
6. Click **Save**.
7. Open an entry with test content, translate one field, leave it on **Use new**, select **Apply**, and reload. The draft contains the new value; nothing is published.

The configuration screen stores the service settings, instruction templates, and editor options as installation parameters of this environment. A Custom backend keeps any provider credential in the backend; a Contentful Function stores it as a Secret installation parameter.

## Uninstall

1. In each space environment, go to **Apps** > **Installed apps**, open AI Translator's actions menu, and select **Uninstall**. Entry content is not changed.
2. If no environment uses the App Definition, delete it in **Organization settings & subscriptions** > **Apps**.
3. Remove the backend: see [Remove](cloudflare-worker.md#remove) for the Worker, [Uninstall](azure-functions.md#uninstall) for Azure, or [Roll back, pause, and remove](aws-lambda.md#roll-back-pause-and-remove) for AWS.
4. Revoke the provider API key and any personal access tokens you created for the installation.
