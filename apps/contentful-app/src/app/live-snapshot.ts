import type { EditorSnapshot } from './editor-snapshot';

export interface SnapshotChannel {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

export type SnapshotChannelFactory = (name: string) => SnapshotChannel;

const browserChannel: SnapshotChannelFactory = name => new BroadcastChannel(name);
const channelName = (sessionId: string) => `ai-translator-for-contentful:snapshot:${sessionId}`;

export function serveSnapshotSession(
  sessionId: string,
  getSnapshot: () => EditorSnapshot,
  createChannel: SnapshotChannelFactory = browserChannel,
) {
  const channel = createChannel(channelName(sessionId));
  channel.onmessage = event => {
    if (event.data?.type === 'request')
      channel.postMessage({ type: 'snapshot', snapshot: getSnapshot(), requestId: event.data.requestId });
  };
  return {
    publish(snapshot: EditorSnapshot) {
      channel.postMessage({ type: 'snapshot', snapshot });
    },
    close() {
      channel.close();
    },
  };
}

export function receiveSnapshotSession(
  sessionId: string,
  onSnapshot: (snapshot: EditorSnapshot) => void,
  createChannel: SnapshotChannelFactory = browserChannel,
) {
  const channel = createChannel(channelName(sessionId));
  channel.onmessage = event => {
    if (event.data?.type === 'snapshot' && !event.data.requestId) onSnapshot(event.data.snapshot);
  };
  channel.postMessage({ type: 'request' });
  return () => channel.close();
}

export function requestCurrentSnapshot(
  sessionId: string,
  createChannel: SnapshotChannelFactory = browserChannel,
  timeoutMs = 60000,
): Promise<EditorSnapshot> {
  const channel = createChannel(channelName(sessionId));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      channel.close();
      reject(new Error('Current editor snapshot timed out'));
    }, timeoutMs);
    channel.onmessage = event => {
      if (event.data?.type !== 'snapshot' || event.data.requestId !== requestId) return;
      clearTimeout(timeout);
      channel.close();
      resolve(event.data.snapshot);
    };
    channel.postMessage({ type: 'request', requestId });
  });
}

// A launch from a field names the field and locale to translate from.
export type FieldLaunch = { fieldId: string; locale: string };

export function dialogInvocation(snapshot: EditorSnapshot, sessionId: string, launch?: FieldLaunch) {
  return {
    entryId: snapshot.entryId,
    contentTypeId: snapshot.contentTypeId,
    sessionId,
    ...(launch ? { fieldId: launch.fieldId, sourceLocale: launch.locale } : {}),
  };
}
