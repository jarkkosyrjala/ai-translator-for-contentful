import { INSTALLATION_PARAMETER_DEFINITIONS } from '../apps/contentful-app/src/app/parameter-definitions.ts';
import { functionEnvPath, loadEnvFileOption } from './local-env.mjs';

// Replaces the App Definition's installation parameter definitions with the
// app's own, including the Secret parameters the Contentful Function reads.
if (loadEnvFileOption(process.argv.slice(2), functionEnvPath).length)
  throw new Error('Use no arguments or --env-file <path>.');
const {
  CONTENTFUL_ORG_ID: organizationId,
  CONTENTFUL_APP_DEF_ID: appDefinitionId,
  CONTENTFUL_ACCESS_TOKEN: token,
} = process.env;
if (!organizationId || !appDefinitionId || !token)
  throw new Error('Set CONTENTFUL_ORG_ID, CONTENTFUL_APP_DEF_ID, and CONTENTFUL_ACCESS_TOKEN.');

const endpoint = `https://api.contentful.com/organizations/${encodeURIComponent(organizationId)}/app_definitions/${encodeURIComponent(appDefinitionId)}`;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.contentful.management.v1+json' };
const current = await fetch(endpoint, { headers });
if (!current.ok) throw new Error(`Reading App Definition failed: HTTP ${current.status}`);
const definition = await current.json();
const installation = definition.parameters?.installation ?? [];
if (!Array.isArray(installation)) throw new Error('Unexpected installation parameter definitions.');
for (const item of INSTALLATION_PARAMETER_DEFINITIONS) {
  const prior = installation.find(parameter => parameter.id === item.id);
  if (prior && prior.type !== item.type) throw new Error(`${item.id} already exists with a different type.`);
}
const comparable = list =>
  JSON.stringify(list.map(({ id, name, type, required, description }) => ({ id, name, type, required, description })));
if (comparable(installation) === comparable(INSTALLATION_PARAMETER_DEFINITIONS)) {
  process.stdout.write('Installation parameter definitions are current.\n');
  process.exit(0);
}

const { sys, ...body } = definition;
body.parameters = { ...definition.parameters, installation: INSTALLATION_PARAMETER_DEFINITIONS };
// The version makes Contentful refuse the update if the definition changed since it was read.
const updated = await fetch(endpoint, {
  method: 'PUT',
  headers: { ...headers, 'X-Contentful-Version': String(sys.version) },
  body: JSON.stringify(body),
});
if (!updated.ok) throw new Error(`Updating App Definition failed: HTTP ${updated.status}`);
const saved = await updated.json();
if (
  comparable(saved.parameters?.installation ?? []) !== comparable(INSTALLATION_PARAMETER_DEFINITIONS) ||
  saved.bundle?.sys?.id !== definition.bundle?.sys?.id ||
  saved.name !== definition.name
) {
  throw new Error('App Definition update did not preserve its bundle and name or save the parameter definitions.');
}
process.stdout.write('Installation parameter definitions are active; app bundle and name are preserved.\n');
