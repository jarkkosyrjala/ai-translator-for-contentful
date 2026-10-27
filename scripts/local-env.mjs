import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

// Installer scripts read Contentful settings from an ignored local file. The
// defaults hold one installation of each kind; pass --env-file <path> to keep
// one file per installation, for example .env.<name>.local. Static uploads
// never read a Function installation's default file, and the reverse.
export const functionEnvPath = fileURLToPath(new URL('../.env.function.local', import.meta.url));
export const staticEnvPath = fileURLToPath(new URL('../.env.static.local', import.meta.url));

// Explicit shell or CI variables take precedence over values in the file.
export function loadLocalEnv(path) {
  try {
    loadEnvFile(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

// Removes `--env-file <path>` from the arguments and loads that file, or the
// default file when the option is absent. Returns the remaining arguments.
export function loadEnvFileOption(args, fallback) {
  const index = args.indexOf('--env-file');
  if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith('--'))) throw new Error('--env-file needs a path.');
  loadLocalEnv(index >= 0 ? resolve(args[index + 1]) : fallback);
  return index >= 0 ? [...args.slice(0, index), ...args.slice(index + 2)] : args;
}
