import type { Document } from '@contentful/rich-text-types';
import type { Dependency } from './batch';
import { applyArrayDraft, applyRichDraft, applyTextDraft } from './draft';
import { capture, type EntryEditorSDK, subscribeToEditorValues } from './editor-snapshot';
import { eligibility, resolveAppControls } from './eligibility';
import { dialogInvocation, type FieldLaunch, serveSnapshotSession } from './live-snapshot';
import type { ApplyLine } from './sidebar-model';

type Accepted = {
  entryId: string;
  fieldId: string;
  kind: 'text' | 'array' | 'richText';
  sourceLocale: string;
  targetLocale: string;
  sourceSnapshot: unknown;
  targetSnapshot: unknown;
  dependencies: Dependency[];
  suggestion?: string | string[] | Document;
  warningApproved?: boolean;
};
type DialogResult = { choice: 'keep' | 'suggestion'; accepted?: Accepted[]; outcomes?: ApplyLine[] };
// The fullscreen modal keeps a 16px edge inset; its titled header takes 57px.
const DIALOG_FRAME_HEIGHT = 'calc(100vh - 89px)';

// Opens the translation dialog for the open entry and writes the accepted
// suggestions to the draft. The dialog has no entry API, so this location keeps
// serving live editor values to it until it closes. Resolves to the outcome
// lines, or undefined when the dialog closed without a result.
export async function openTranslator(sdk: EntryEditorSDK, launch?: FieldLaunch): Promise<ApplyLine[] | undefined> {
  if (typeof BroadcastChannel === 'undefined')
    throw new Error('Live editor synchronization is unavailable in this browser.');
  let latest = capture(sdk);
  const sessionId = crypto.randomUUID();
  const session = serveSnapshotSession(sessionId, () => latest);
  let stopWatching = () => {};
  try {
    stopWatching = subscribeToEditorValues(sdk, next => {
      latest = next;
      session.publish(next);
    });
    const returned = (await sdk.dialogs.openCurrentApp({
      title: 'AI Translator',
      // Forma 36 supports fullscreen; the App SDK passes the width through.
      // @ts-expect-error App SDK 4.75.0 omits fullscreen from its width type.
      width: 'fullscreen',
      minHeight: DIALOG_FRAME_HEIGHT,
      position: 'center',
      parameters: dialogInvocation(latest, sessionId, launch),
    })) as DialogResult | undefined;
    return returned ? await applyDialogResult(sdk, returned) : undefined;
  } finally {
    stopWatching();
    session.close();
  }
}

function validDependencies(value: unknown): value is Dependency[] {
  return (
    Array.isArray(value) &&
    value.every(
      item =>
        item &&
        typeof item === 'object' &&
        typeof item.fieldId === 'string' &&
        typeof item.locale === 'string' &&
        'value' in item,
    )
  );
}

async function applyDialogResult(sdk: EntryEditorSDK, returned: DialogResult): Promise<ApplyLine[]> {
  const lines: ApplyLine[] = [...(returned.outcomes ?? [])];
  const controls = resolveAppControls(sdk.editor.editorInterface.controls, sdk.contentType.fields, sdk.ids.app);
  for (const accepted of returned.accepted ?? []) {
    const key = `${accepted.fieldId}:${accepted.targetLocale}`;
    const definition = sdk.contentType.fields.find(field => field.id === accepted.fieldId);
    const field = sdk.entry.fields[accepted.fieldId];
    const result = definition && eligibility(definition, controls);
    if (
      returned.choice !== 'suggestion' ||
      accepted.entryId !== sdk.ids.entry ||
      !definition ||
      !field ||
      !result?.eligible ||
      result.kind !== accepted.kind ||
      accepted.sourceLocale === accepted.targetLocale ||
      !validDependencies(accepted.dependencies) ||
      !field.locales.includes(accepted.sourceLocale) ||
      !field.locales.includes(accepted.targetLocale) ||
      (accepted.kind === 'text'
        ? typeof accepted.sourceSnapshot !== 'string' || typeof accepted.suggestion !== 'string'
        : accepted.kind === 'array'
          ? !Array.isArray(accepted.sourceSnapshot) || !Array.isArray(accepted.suggestion)
          : !accepted.suggestion || typeof accepted.suggestion !== 'object' || Array.isArray(accepted.suggestion))
    ) {
      lines.push({ key, status: 'invalid', detail: 'Invalid dialog selection' });
      continue;
    }
    try {
      const port = {
        read: (locale: string) => field.getValue(locale),
        isDisabled: (locale: string) => field.getForLocale(locale).getIsDisabled(),
        write: async (value: string | string[] | Document, locale: string) => {
          await field.setValue(value as Parameters<typeof field.setValue>[0], locale);
        },
        // Read live, like the dialog's snapshot, so a sibling or context
        // edit during the asynchronous checks stops the write.
        dependenciesCurrent: () => {
          const fields = capture(sdk).fields;
          return accepted.dependencies.every(
            item => JSON.stringify(fields[item.fieldId]?.[item.locale] ?? null) === JSON.stringify(item.value ?? null),
          );
        },
      };
      const common = {
        sourceLocale: accepted.sourceLocale,
        targetLocale: accepted.targetLocale,
        sourceSnapshot: accepted.sourceSnapshot,
        targetSnapshot: accepted.targetSnapshot,
        choice: 'suggestion' as const,
        warningApproved: accepted.warningApproved === true,
      };
      const outcome =
        accepted.kind === 'text'
          ? await applyTextDraft(
              port,
              { ...common, suggestion: accepted.suggestion as string, size: result.size },
              () => sdk.access.can('update', 'Entry'),
            )
          : accepted.kind === 'array'
            ? await applyArrayDraft(
                port,
                {
                  ...common,
                  suggestion: accepted.suggestion as string[],
                  limits: { count: result.size, item: result.itemSize },
                },
                () => sdk.access.can('update', 'Entry'),
              )
            : await applyRichDraft(
                port,
                { ...common, suggestion: accepted.suggestion as Document, definition },
                () => sdk.access.can('update', 'Entry'),
                {
                  spaceId: sdk.ids.space,
                  environmentId: sdk.ids.environment,
                  entryContentType: async reference => {
                    const entry = await sdk.cma.entry.get(reference);
                    return entry.sys.contentType.sys.id;
                  },
                },
              );
      lines.push({ key, status: outcome.status, detail: outcome.detail });
    } catch {
      lines.push({ key, status: 'failed' });
    }
  }
  return lines;
}
