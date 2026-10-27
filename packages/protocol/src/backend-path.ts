// A Custom backend served beneath a path, such as `/api/ai-translator` in an
// existing Function App, keeps that path in its Backend URL and its relay's
// basePath. Segments use unreserved URL characters only, so the path the app
// signs is the path the backend receives, with no encoding to interpret.
const segment = /^[A-Za-z0-9._~-]+$/;

/**
 * Normalizes a backend path prefix: `''` for the root, otherwise the path
 * without its trailing slash. Returns `undefined` for an ambiguous path, such
 * as one with empty, `.` or `..` segments or encoded characters.
 */
export function backendPath(value: string): string | undefined {
  if (value === '' || value === '/') return '';
  const path = value.endsWith('/') ? value.slice(0, -1) : value;
  if (!path.startsWith('/')) return undefined;
  const segments = path.slice(1).split('/');
  return segments.every(part => segment.test(part) && part !== '.' && part !== '..') ? path : undefined;
}
