# Privacy and data flow

Each organization installs and runs AI Translator for Contentful itself. The author operates no service for the app, receives no installation data, and adds no app telemetry.

The organization that installs the app chooses the backend and the model provider, and decides whether they meet its requirements, including where data is processed. The app does not enforce a processing region. Contentful's EU data residency covers content stored in Contentful; it does not extend to an external backend or provider.

## What a translation sends

When an editor selects **Translate**, the app groups the selected fields into requests, one target locale per request, in the content type's field order. A request holds up to the model's request size in source characters (20,000 by default for a Custom backend, 10,000 for the Contentful Function; administrators can change it per model). A larger Long text field is split at paragraphs, then at line breaks or sentence ends when needed, and a larger list or Rich Text field between items or blocks. Rich Text is sent as a typed structure of its text blocks; link targets and embedded entry and asset IDs are replaced by anchors. Each request contains:

- the source text of its fields as shown in the editor, including unsaved changes;
- the entry ID, a request ID, the field IDs, names and limits, the model ID, and the locale codes of the environment;
- output rules the app derives from each field and its source text, such as length limits and placeholders to keep;
- the editor's guidance for the run;
- the context fields the editor chose, with their entry and field IDs, field names, and locales: values from the current entry as shown in the editor, and saved values from other entries with their version;
- as context, the source of other selected fields that are sent in a different request, within the context limits;
- for a split field, its heading outline and the source text just before and after the part;
- the instruction templates and variable definitions, the saved ones or the app's defaults, and the editor's variable values.

Requests contain no credentials. A request to a Custom backend also carries Contentful's signature headers, which include the space, environment, and user IDs. Like any web request, it also reaches the backend and its host with the editor's IP address and browser details, which the host's request logs may record. When an administrator turns on the app's **Debug mode**, editors can see the messages each request sends to the model.

The app's code, styles, and icons come only from its App Bundle; it loads no fonts or scripts from third parties, and its requests go only to Contentful and the configured backend. A Markdown preview in the dialog shows any images the content itself links to, as Contentful's own editor does.

In app configuration, **Load models** sends only the provider alias (Custom backend) or nothing (Contentful Function), and the backend asks the provider for its model IDs. **Test model** sends one fixed synthetic sentence and no entry content.

## Where it goes

**Custom backend (Cloudflare Worker).** The browser asks Contentful to sign the request; to do that, Contentful's API receives the request body. The browser then sends the request to your Worker, which calls your provider. The Worker:

- does not log request text or provider responses;
- keeps the request ID, Contentful entry ID, and time of each translation request in its usage gate to reject duplicates and allow one active request per entry. Rows older than a day are deleted when the next translation request for the same space environment arrives;
- records request metadata, such as time, path, and status, in Cloudflare Workers Logs, and traces of its outgoing calls, such as the provider request, because `observability` and its `traces` are enabled in `wrangler.jsonc`. Turn them off there if you do not want this.

**Custom backend (Azure Functions).** The request flow is the same as for the Worker. The Function App:

- does not log request text or provider responses;
- keeps a SHA-256 digest of each request ID and its time in Azure Table Storage to reject duplicates, and the Contentful entry ID only while a request is active. A daily job deletes request rows older than a day;
- records request metadata, such as time, path, and status, in Application Insights, which `az functionapp create` sets up by default.

**Custom backend (AWS Lambda).** The request flow is the same as for the Worker; the request goes to your Lambda function URL. The function:

- does not log request text or provider responses;
- keeps the Contentful entry ID and the time of each active request in its DynamoDB usage table until the request ends, and each request ID for at least a day to reject duplicates. DynamoDB's time to live deletes expired request IDs, typically within a few days;
- writes Lambda's request metadata, such as duration and memory use, to its CloudWatch log group, which keeps it for the retention period set when deploying.

**Custom backend (npm package).** A host built on the npm backend package receives the same requests. It does not log request text or provider responses. Its process-local memory gate keeps request and entry IDs in memory for a day; a shared gate keeps what its implementer stores. Request metadata, logs, and retention depend on where you run it.

**Relay debug mode.** With `debug` turned on in a Custom backend's `RELAY_CONFIG`, a failed translation returns what the provider sent, unredacted, to the dialog: the model's answer so far, which contains translated content, or the provider's error body, which can contain account details or an echoed credential. This is separate from the app's **Debug mode**. Turn it on only while troubleshooting.

**Contentful Function.** The browser calls a Contentful App Action, which runs the Function inside Contentful. The Function calls your provider. Contentful processes and may keep App Action calls and their results under its own terms.

**Model provider.** The provider receives the messages compiled from the request described above. Its terms decide whether it stores or uses that data.

## In the browser

When an editor checks **Save as my default**, the app stores the chosen source or target locales, or the chosen provider and model, in the browser's local storage, separately for each space, environment, and user. The sidebar or field editor passes the entry's current values to the translation dialog through the browser, within the same Contentful session.

## Credentials

- Custom backend: any provider credential and the App Definition's signing secret stay in the backend: as Worker secrets, as Azure Key Vault secrets referenced by app settings, or in one AWS Secrets Manager secret together with any extra provider headers. They never reach the browser.
- Contentful Function: any provider credential and extra provider headers are Contentful Secret installation parameters, readable only by the Function. Contentful's APIs return a redacted value.

## Usage terms

The software is provided under the [MIT License](../LICENSE), without warranty. The installing organization is responsible for its use of the app, its backend and provider accounts, the provider's terms and charges, and its own legal requirements for the content it sends.

Questions: [Support](../SUPPORT.md). Security reports: [Security policy](../SECURITY.md).
