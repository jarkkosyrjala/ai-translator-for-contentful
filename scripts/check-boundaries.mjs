import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scope = '@ai-translator-for-contentful/';
const sourceFile = /\.(?:[cm]?[jt]sx?)$/;
const skipped = new Set(['node_modules', 'build', 'dist', 'coverage', '.wrangler']);
const specifiers = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bvi\.mock\s*\(\s*)(['"])([^'"\n]+)\1/g;

// Allowed workspace dependencies by package. `test` edges apply only to test
// files. Dependencies point toward the shared packages: protocol depends on
// nothing, provider on protocol, and relay on both. Hosts build on relay, and
// the frontend shares only protocol, so provider code stays out of its bundle.
const edges = {
  app: { runtime: ['protocol'] },
  'backend-function': { runtime: ['protocol', 'provider'] },
  'backend-cloudflare': { runtime: ['relay'], test: ['relay-conformance'] },
  'backend-azure': { runtime: ['backend'], test: ['relay-conformance'] },
  'backend-aws-lambda': { runtime: ['relay'], test: ['relay-conformance'] },
  // The npm package: the shared relay plus its Node and Azure adapters.
  backend: { runtime: ['protocol', 'relay'], test: ['relay-conformance'] },
  relay: { runtime: ['protocol', 'provider'], test: ['relay-conformance'] },
  provider: { runtime: ['protocol'] },
  'relay-conformance': { runtime: ['protocol'] },
  protocol: { runtime: [] },
};
// Host-neutral packages may import only workspace packages and these
// browser- and host-safe libraries; tests may also use Vitest. The protocol's
// strict XML reader uses parse-xml, which has no host dependencies.
const pure = { protocol: ['@rgrove/parse-xml'], provider: [], relay: [], 'relay-conformance': ['vitest'] };

const isTest = file => /(?:^|[\\/])tests?[\\/]|\.test\.[cm]?[jt]sx?$/.test(file);

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function files(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else if (sourceFile.test(entry.name)) found.push(path);
  }
  return found;
}

async function packages() {
  const found = [];
  for (const group of ['apps', 'backends', 'packages']) {
    const base = join(root, group);
    if (!(await exists(base))) continue;
    for (const entry of await readdir(base, { withFileTypes: true })) {
      const dir = join(base, entry.name);
      if (!entry.isDirectory() || !(await exists(join(dir, 'package.json')))) continue;
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      if (typeof manifest.name !== 'string' || !manifest.name.startsWith(scope)) {
        throw new Error(`${relative(root, dir)}/package.json must be named ${scope}*.`);
      }
      const declared = new Set(
        Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }),
      );
      found.push({ dir, name: manifest.name.slice(scope.length), declared });
    }
  }
  return found;
}

export async function checkBoundaries() {
  const problems = [];
  for (const pkg of await packages()) {
    const rule = edges[pkg.name];
    if (!rule) {
      problems.push(`${pkg.name}: not in the boundary table in scripts/check-boundaries.mjs`);
      continue;
    }
    for (const file of await files(pkg.dir)) {
      const source = await readFile(file, 'utf8');
      const where = relative(root, file);
      for (const [, , specifier] of source.matchAll(specifiers)) {
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(file), specifier);
          if (target !== pkg.dir && !target.startsWith(pkg.dir + sep))
            problems.push(`${where}: relative import leaves its package: ${specifier}`);
          continue;
        }
        if (specifier.startsWith(scope)) {
          const target = specifier.slice(scope.length).split('/')[0];
          const allowed = [...rule.runtime, ...(isTest(file) ? (rule.test ?? []) : [])];
          if (!allowed.includes(target)) problems.push(`${where}: ${pkg.name} must not import ${scope}${target}`);
          else if (!pkg.declared.has(`${scope}${target}`))
            problems.push(`${where}: ${scope}${target} is not declared in package.json`);
          continue;
        }
        if (pkg.name in pure) {
          const bare = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
          if (!(pure[pkg.name].includes(bare) || (isTest(file) && bare === 'vitest')))
            problems.push(`${where}: host-neutral ${pkg.name} must not import ${specifier}`);
        }
      }
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await checkBoundaries();
  if (problems.length) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Workspace boundaries hold.\n');
  }
}
