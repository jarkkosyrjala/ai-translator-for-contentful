import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';

// Bundles the Lambda handler and its dependencies into build/index.mjs, an ES
// module for the nodejs24.x runtime (handler `index.handler`), and writes the
// licenses of the bundled third-party packages beside it, as the app build does.
const out = 'build';
await rm(out, { recursive: true, force: true });
const { metafile } = await build({
  entryPoints: ['src/index.ts'],
  outfile: `${out}/index.mjs`,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // Prefer the ES module builds of the AWS SDK so the bundle has no require().
  mainFields: ['module', 'main'],
  sourcemap: true,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

// node_modules/.pnpm/<id>/node_modules/@scope/name/dist/x.js -> node_modules/.pnpm/<id>/node_modules/@scope/name
function packageDir(input) {
  const marker = input.lastIndexOf('node_modules/');
  if (marker < 0) return undefined;
  const parts = input.slice(marker + 'node_modules/'.length).split('/');
  return input.slice(0, marker) + ['node_modules', ...parts.slice(0, parts[0].startsWith('@') ? 2 : 1)].join('/');
}

async function notices(dir) {
  const files = (await readdir(dir)).filter(name => /^(?:licen[cs]e|notice)(?:\.(?:md|txt))?$/i.test(name)).sort();
  return Promise.all(files.map(async name => (await readFile(join(dir, name), 'utf8')).trim()));
}

const dirs = [...new Set(Object.keys(metafile.inputs).map(packageDir).filter(Boolean))];
const packages = await Promise.all(
  dirs.map(async dir => {
    const { name, version, license } = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    return { name, version, license, texts: await notices(dir) };
  }),
);
const sections = packages
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  .map(({ name, version, license, texts }) =>
    [
      `## ${name} - ${version} (${license})`,
      ...(texts.length ? texts : [`${license}. No license file is included.`]),
    ].join('\n\n'),
  );
await writeFile(
  join(out, 'THIRD_PARTY_LICENSES.md'),
  `# Licenses\n\nThe AWS Lambda backend bundles dependencies which contain the following licenses:\n\n${sections.join('\n\n')}\n`,
);
