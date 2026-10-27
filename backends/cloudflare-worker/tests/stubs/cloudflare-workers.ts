// Node test shim for the Worker entrypoint import. Runtime behavior is checked
// against Wrangler separately; this shim is never included in the deployment.
export class DurableObject {
  ctx: unknown;
  constructor(ctx: unknown, _env: unknown) {
    this.ctx = ctx;
  }
}
