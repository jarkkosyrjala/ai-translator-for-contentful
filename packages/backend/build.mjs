import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

// Builds the publishable npm package in dist/: ES modules with shared chunks,
// a CommonJS copy of each, and declarations. The workspace packages it uses
// are bundled; @rgrove/parse-xml stays a dependency and the Azure SDKs stay
// the consumer's optional peers. Pass --sourcemap for the artifact scan.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const out = join(here, 'dist');
const scope = '@ai-translator-for-contentful/';
const entries = {
  index: 'src/index.ts',
  node: 'src/node.ts',
  azure: 'src/azure/adapter.ts',
  'azure-tables': 'src/azure/table-gate.ts',
};
const external = ['@rgrove/parse-xml', '@azure/functions', '@azure/data-tables'];

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}

await rm(out, { recursive: true, force: true });
await rm(join(here, 'build'), { recursive: true, force: true });

const { metafile } = await build({
  absWorkingDir: here,
  entryPoints: entries,
  outdir: 'dist/esm',
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external,
  sourcemap: process.argv.includes('--sourcemap') ? 'linked' : false,
  sourcesContent: false,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});
// Only this repository's package sources are bundled; every npm package stays
// a dependency or peer.
const bundled = Object.keys(metafile.inputs).filter(
  input => !/^(?:src|\.\.\/(?:protocol|provider|relay)\/src)\//.test(input),
);
if (bundled.length) throw new Error(`Unexpected bundled inputs:\n${bundled.join('\n')}`);

// CommonJS keeps the same files and chunks, so each class exists once.
for (const file of await walk(join(out, 'esm'))) {
  if (!file.endsWith('.js')) continue;
  const { code } = await transform(await readFile(file, 'utf8'), { format: 'cjs', target: 'node24', platform: 'node' });
  const target = join(out, 'cjs', relative(join(out, 'esm'), file));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, code);
}
await writeFile(join(out, 'cjs/package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);

// Declarations: workspace imports become relative and every relative import
// names its .js file, as Node's ESM resolution and TypeScript's node16 expect.
const tsc = spawnSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], {
  cwd: here,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (tsc.status !== 0) throw new Error('Declaration build failed.');
const declarations = join(here, 'build/types');
const files = new Set((await walk(declarations)).map(file => relative(declarations, file).replaceAll('\\', '/')));
const specifier = /(\bfrom\s*|\bimport\s*\(\s*)(['"])([^'"]+)\2/g;
for (const file of files) {
  const text = await readFile(join(declarations, file), 'utf8');
  const rewritten = text.replace(specifier, (match, keyword, quote, path) => {
    let target;
    if (path.startsWith(scope)) target = `${path.slice(scope.length)}/src/index`;
    else if (path.startsWith('.')) target = posix.join(posix.dirname(file), path);
    else return match;
    const resolved = files.has(`${target}.d.ts`)
      ? `${target}.js`
      : files.has(`${target}/index.d.ts`)
        ? `${target}/index.js`
        : undefined;
    if (!resolved) throw new Error(`${file}: cannot resolve ${path}`);
    let next = posix.relative(posix.dirname(file), resolved);
    if (!next.startsWith('.')) next = `./${next}`;
    return `${keyword}${quote}${next}${quote}`;
  });
  for (const dir of ['types', 'cjs/types']) {
    await mkdir(dirname(join(out, dir, file)), { recursive: true });
    await writeFile(join(out, dir, file), rewritten);
  }
}
await rm(join(here, 'build'), { recursive: true, force: true });

const manifest = await readJson(join(here, 'package.json'));
const project = await readJson(join(root, 'package.json'));
const repository = project.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
const protocol = await readJson(join(root, 'packages/protocol/package.json'));
const versionArg = process.argv.indexOf('--version');
const version = versionArg < 0 ? manifest.version : process.argv[versionArg + 1];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? ''))
  throw new Error('Pass --version with a version such as 1.0.0.');
const types = entry => `backend/src/${entries[entry].slice('src/'.length).replace(/\.ts$/, '.d.ts')}`;
const exports = Object.fromEntries(
  Object.keys(entries).map(entry => [
    entry === 'index' ? '.' : `./${entry}`,
    {
      import: { types: `./types/${types(entry)}`, default: `./esm/${entry}.js` },
      require: { types: `./cjs/types/${types(entry)}`, default: `./cjs/${entry}.js` },
    },
  ]),
);
await writeFile(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: manifest.name,
      version,
      description: manifest.description,
      license: manifest.license,
      author: project.author,
      repository: { ...project.repository, directory: 'packages/backend' },
      homepage: `${repository}/tree/main/packages/backend#readme`,
      bugs: project.bugs,
      keywords: ['contentful', 'translation', 'azure-functions'],
      type: 'module',
      engines: { node: '>=24' },
      sideEffects: false,
      // For TypeScript's older `node10` resolution, such as the Azure
      // Functions CommonJS template, which ignores `exports`.
      main: './cjs/index.js',
      types: `./cjs/types/${types('index')}`,
      typesVersions: {
        '*': Object.fromEntries(
          Object.keys(entries)
            .filter(entry => entry !== 'index')
            .map(entry => [entry, [`./cjs/types/${types(entry)}`]]),
        ),
      },
      exports: { ...exports, './package.json': './package.json' },
      dependencies: { '@rgrove/parse-xml': protocol.dependencies['@rgrove/parse-xml'] },
      peerDependencies: { '@azure/data-tables': '^13.0.0', '@azure/functions': '^4.0.0' },
      peerDependenciesMeta: { '@azure/data-tables': { optional: true }, '@azure/functions': { optional: true } },
    },
    null,
    2,
  )}\n`,
);
// The README links to the repository's docs relatively; inside the tarball
// those links point to the repository on GitHub instead.
await writeFile(
  join(out, 'README.md'),
  (await readFile(join(here, 'README.md'), 'utf8')).replaceAll('](../../', `](${repository}/blob/main/`),
);
await cp(join(root, 'LICENSE'), join(out, 'LICENSE'));
process.stdout.write(`Built ${relative(process.cwd(), out)} for ${manifest.name}@${version}.\n`);
