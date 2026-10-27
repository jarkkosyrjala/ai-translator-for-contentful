import type { ContentTypeField, DialogAppSDK } from '@contentful/app-sdk';

type ReadSdk = Pick<DialogAppSDK, 'cma' | 'ids'>;
export type SavedEntry = {
  id: string;
  contentTypeId: string;
  version: number;
  fields: Record<string, Record<string, unknown>>;
  definitions: ContentTypeField[];
};
export type EntryHit = { id: string; contentTypeId: string; label: string };

export async function searchSavedEntries(sdk: ReadSdk, term: string): Promise<EntryHit[]> {
  const query = term.trim();
  if (query.length < 2) return [];
  const result = await sdk.cma.entry.getMany({
    spaceId: sdk.ids.space,
    environmentId: sdk.ids.environment,
    query: { query, limit: 10 },
  });
  return result.items.map(entry => {
    const label = Object.values(entry.fields)
      .flatMap(locales => Object.values(locales ?? {}))
      .find(value => typeof value === 'string' && value.trim());
    return {
      id: entry.sys.id,
      contentTypeId: entry.sys.contentType.sys.id,
      label: typeof label === 'string' ? label.slice(0, 80) : entry.sys.id,
    };
  });
}

export async function loadSavedEntry(sdk: ReadSdk, entryId: string): Promise<SavedEntry> {
  const entry = await sdk.cma.entry.get({ spaceId: sdk.ids.space, environmentId: sdk.ids.environment, entryId });
  const contentTypeId = entry.sys.contentType.sys.id;
  const contentType = await sdk.cma.contentType.get({
    spaceId: sdk.ids.space,
    environmentId: sdk.ids.environment,
    contentTypeId,
  });
  return {
    id: entry.sys.id,
    contentTypeId,
    version: entry.sys.version,
    fields: entry.fields as Record<string, Record<string, unknown>>,
    definitions: contentType.fields as ContentTypeField[],
  };
}
