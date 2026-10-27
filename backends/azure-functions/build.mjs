import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Bundles the Function App into one ES module with every dependency, so a
// deployment needs no npm install. The Functions Node.js worker provides
// @azure/functions-core through CommonJS require, so the bundle creates a
// require function for its CommonJS dependencies.
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'build');

await rm(out, { recursive: true, force: true });
const { metafile } = await build({
  absWorkingDir: here,
  entryPoints: ['src/index.ts'],
  outfile: 'build/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['@azure/functions-core'],
  banner: { js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" },
  sourcemap: 'linked',
  sourcesContent: false,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

// The bundle redistributes its npm dependencies, so ship their licenses.
const packageRoot = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/@][^/]*)\//;
const roots = new Set();
for (const input of Object.keys(metafile.inputs)) {
  const match = packageRoot.exec(input.replaceAll('\\', '/'));
  if (match) roots.add(join(here, match[1]));
}
const sections = [];
for (const root of [...roots].sort()) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const file = (await readdir(root)).find(name => /^licen[cs]e(?:\.(?:md|txt))?$/i.test(name));
  const text = file ? (await readFile(join(root, file), 'utf8')).trim() : 'No license file is included in the package.';
  sections.push(
    `## ${manifest.name}@${manifest.version}\n\nLicense: ${manifest.license ?? 'see below'}\n\n\`\`\`text\n${text}\n\`\`\``,
  );
}
const unique = [...new Map(sections.map(section => [section.split('\n')[0], section])).values()];
await writeFile(
  join(out, 'THIRD_PARTY_LICENSES.md'),
  `# Third-party licenses\n\nThe Azure Functions bundle \`index.js\` includes these packages.\n\n${unique.join('\n\n')}\n`,
);
process.stdout.write(`Built ${relative(process.cwd(), join(out, 'index.js'))} with ${unique.length} npm packages.\n`);
