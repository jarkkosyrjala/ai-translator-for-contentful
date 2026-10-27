import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// Shared by the static and Function-bearing App Bundle uploads. On Windows,
// pnpm and npm are .cmd shims that only a shell can start.
export function run(command, args, cwd, env) {
  return new Promise((resolveRun, reject) => {
    const shell = process.platform === 'win32' && command !== process.execPath;
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell });
    const forwardInterrupt = () => child.kill('SIGINT');
    const forwardTerminate = () => child.kill('SIGTERM');
    process.once('SIGINT', forwardInterrupt);
    process.once('SIGTERM', forwardTerminate);
    const finish = error => {
      process.off('SIGINT', forwardInterrupt);
      process.off('SIGTERM', forwardTerminate);
      if (error) reject(error);
      else resolveRun();
    };
    child.once('error', finish);
    child.once('exit', (code, signal) => {
      if (code === 0) finish();
      else
        finish(new Error(signal ? `Child process stopped by ${signal}.` : `Child process exited with code ${code}.`));
    });
  });
}

/**
 * Uploads and activates the App Bundle in `cwd`/build with app-scripts'
 * non-interactive upload, which reads contentful-app-manifest.json from `cwd`.
 * The token reaches it through the environment, never the command line, and
 * app-scripts' usage analytics stay off.
 * @param packageDir The workspace package whose app-scripts dependency runs.
 */
export function uploadBundle({ packageDir, cwd, env, organization, definition, token, comment }) {
  const appScripts = createRequire(join(packageDir, 'package.json')).resolve('@contentful/app-scripts');
  const script = `require(${JSON.stringify(appScripts)})
    .upload.nonInteractive({
      bundleDir: 'build',
      organizationId: process.env.CONTENTFUL_ORG_ID,
      definitionId: process.env.CONTENTFUL_APP_DEF_ID,
      token: process.env.CONTENTFUL_ACCESS_TOKEN,
      comment: process.env.UPLOAD_COMMENT || undefined,
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });`;
  return run(process.execPath, ['-e', script], cwd, {
    ...env,
    DISABLE_ANALYTICS: 'true',
    CONTENTFUL_ORG_ID: organization,
    CONTENTFUL_APP_DEF_ID: definition,
    CONTENTFUL_ACCESS_TOKEN: token,
    UPLOAD_COMMENT: comment ?? '',
  });
}

export async function activeBundleId(organization, definition, token) {
  const response = await fetch(definitionUrl(organization, definition), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Reading App Definition failed: HTTP ${response.status}`);
  const appDefinition = await response.json();
  return appDefinition.bundle?.sys?.id;
}

function definitionUrl(organization, definition) {
  return `https://api.contentful.com/organizations/${encodeURIComponent(organization)}/app_definitions/${encodeURIComponent(definition)}`;
}

// A static App Bundle has no Functions; uploading it to a definition with
// deployed Functions could remove them. Proceed only when Contentful confirms
// an empty Functions collection, and fail closed on any other answer.
export async function readFunctionsCollection(organization, definition, token, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(`${definitionUrl(organization, definition)}/functions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Error('Could not read the App Definition Functions collection. Refusing the static upload.');
  }
  if (!response.ok)
    throw new Error(
      `Reading the App Definition Functions collection failed: HTTP ${response.status}. Refusing the static upload.`,
    );
  try {
    return await response.json();
  } catch {
    throw new Error('The Functions collection response is not JSON. Refusing the static upload.');
  }
}

export function assertNoFunctions(collection) {
  if (
    !collection ||
    typeof collection !== 'object' ||
    Array.isArray(collection) ||
    collection.sys?.type !== 'Array' ||
    !Number.isInteger(collection.total) ||
    collection.total < 0 ||
    !Array.isArray(collection.items)
  ) {
    throw new Error('Unexpected Functions collection response. Refusing the static upload.');
  }
  if (collection.total !== 0 || collection.items.length !== 0) {
    throw new Error(
      `The App Definition has ${collection.total} Function(s). A static App Bundle could remove them; use the Function-bearing upload.`,
    );
  }
}
