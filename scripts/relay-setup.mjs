// Guided Custom backend setup: `pnpm relay:setup --host <host>`. Cloudflare
// Workers is the first host with one; see docs/cloudflare-worker.md.
const hosts = { cloudflare: '../backends/cloudflare-worker/scripts/setup.mjs' };
const [flag, host, ...rest] = process.argv.slice(2);
if (flag !== '--host' || !Object.hasOwn(hosts, host) || rest.length) {
  console.error(`Use: pnpm relay:setup --host ${Object.keys(hosts).join('|')}`);
  process.exit(1);
}
await import(hosts[host]);
