const MAX_NETWORKS = 16;

export function parseFunctionAllowNetworks(raw) {
  if (!raw) throw new Error('Set CONTENTFUL_FUNCTION_ALLOW_NETWORKS to a JSON array of exact hostnames.');
  if (raw.length > 8192) throw new Error('CONTENTFUL_FUNCTION_ALLOW_NETWORKS is too large.');
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new Error('CONTENTFUL_FUNCTION_ALLOW_NETWORKS must be a JSON array.');
  }
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_NETWORKS) {
    throw new Error(`CONTENTFUL_FUNCTION_ALLOW_NETWORKS must contain 1–${MAX_NETWORKS} hostnames.`);
  }

  const networks = entries.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length > 259 || entry !== entry.trim()) {
      throw new Error(`Invalid host at CONTENTFUL_FUNCTION_ALLOW_NETWORKS index ${index}.`);
    }
    const match = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(entry);
    if (!match) throw new Error(`Invalid host at CONTENTFUL_FUNCTION_ALLOW_NETWORKS index ${index}.`);
    const hostname = match[1].toLowerCase();
    const labels = hostname.split('.');
    if (
      hostname.length > 253 ||
      labels.length < 2 ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      labels.some(label => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
      !/^[a-z]{2,63}$/.test(labels.at(-1))
    ) {
      throw new Error(`Invalid host at CONTENTFUL_FUNCTION_ALLOW_NETWORKS index ${index}.`);
    }
    const port = match[2] ? Number(match[2]) : undefined;
    if (match[2] && (port < 1 || port > 65535 || String(port) !== match[2])) {
      throw new Error(`Invalid port at CONTENTFUL_FUNCTION_ALLOW_NETWORKS index ${index}.`);
    }
    return port ? `${hostname}:${port}` : hostname;
  });
  if (new Set(networks).size !== networks.length) {
    throw new Error('CONTENTFUL_FUNCTION_ALLOW_NETWORKS contains a duplicate host.');
  }
  return networks;
}

// The Functions that call the provider: model discovery and translation. Every
// other Function keeps an empty network list.
export const PROVIDER_FUNCTIONS = ['providerModels', 'translateProvider'];

export function functionUploadManifest(manifest, networks) {
  if (!Array.isArray(manifest?.functions)) throw new Error('Invalid tracked Function manifest.');
  const counts = new Map(PROVIDER_FUNCTIONS.map(id => [id, 0]));
  const functions = manifest.functions.map(fn => {
    if (!Array.isArray(fn.allowNetworks) || fn.allowNetworks.length !== 0) {
      throw new Error('The tracked Function manifest must have empty allowNetworks lists.');
    }
    if (!counts.has(fn.id)) return fn;
    counts.set(fn.id, counts.get(fn.id) + 1);
    return { ...fn, allowNetworks: networks };
  });
  for (const [id, count] of counts) if (count !== 1) throw new Error(`Expected one ${id} Function.`);
  return { ...manifest, functions };
}
