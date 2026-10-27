// The protocol runs in browsers and every server host, so it compiles against
// ES2022 plus only these WHATWG globals. Other host APIs fail to typecheck.
// Kept out of the package exports: consumers use their own DOM or host types.
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class URL {
  constructor(url: string, base?: string | URL);
  readonly origin: string;
  href: string;
  protocol: string;
  username: string;
  password: string;
  hostname: string;
  pathname: string;
  search: string;
  hash: string;
  toString(): string;
}
