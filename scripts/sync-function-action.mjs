import { readFile } from 'node:fs/promises';
import { functionEnvPath, loadEnvFileOption } from './local-env.mjs';

if (loadEnvFileOption(process.argv.slice(2), functionEnvPath).length)
  throw new Error('Use no arguments or --env-file <path>.');
const {
  CONTENTFUL_ORG_ID: organizationId,
  CONTENTFUL_APP_DEF_ID: appDefinitionId,
  CONTENTFUL_ACCESS_TOKEN: token,
} = process.env;
if (!organizationId || !appDefinitionId || !token) {
  throw new Error('Set CONTENTFUL_ORG_ID, CONTENTFUL_APP_DEF_ID, and CONTENTFUL_ACCESS_TOKEN.');
}

const actions = [
  ['functionHealth', '../backends/contentful-function/contentful-function-health-action.json'],
  ['providerModels', '../backends/contentful-function/contentful-function-models-action.json'],
  ['translateProvider', '../backends/contentful-function/contentful-function-provider-action.json'],
];
const base = `https://api.contentful.com/organizations/${encodeURIComponent(organizationId)}/app_definitions/${encodeURIComponent(appDefinitionId)}/actions`;
const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/vnd.contentful.management.v1+json',
};

for (const [id, file] of actions) {
  const action = JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
  const endpoint = `${base}/${id}`;
  const existing = await fetch(endpoint, { headers });
  if (existing.status !== 404 && !existing.ok) throw new Error(`Reading ${id} failed: HTTP ${existing.status}`);
  const updated = await fetch(existing.status === 404 ? base : endpoint, {
    method: existing.status === 404 ? 'POST' : 'PUT',
    headers,
    body: JSON.stringify(existing.status === 404 ? { ...action, id } : action),
  });
  if (!updated.ok) throw new Error(`Creating/updating ${id} failed: HTTP ${updated.status}`);
  const saved = await updated.json();
  if (saved.sys?.id !== id || !saved.parametersSchema || !saved.resultSchema) {
    throw new Error(`${id} response did not contain the expected ID and schemas.`);
  }
  process.stdout.write(`${id} request and result schemas are active.\n`);
}
