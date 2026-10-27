import type { SidebarAppSDK } from '@contentful/app-sdk';
import { describe, expect, it, vi } from 'vitest';
import { capture, type EditorSnapshot, subscribeToEditorValues } from '../src/app/editor-snapshot';
import {
  dialogInvocation,
  receiveSnapshotSession,
  requestCurrentSnapshot,
  type SnapshotChannel,
  serveSnapshotSession,
} from '../src/app/live-snapshot';

function fixture(initial = 'Before', valueOnSubscribe = initial) {
  let value = initial;
  let listener: ((next: unknown) => void) | undefined;
  const unsubscribe = vi.fn();
  const sdk = {
    contentType: { fields: [{ id: 'text' }] },
    locales: { available: ['en-US'], default: 'en-US' },
    ids: { entry: 'entry', contentType: 'test' },
    editor: { getLocaleSettings: () => ({ focused: 'en-US', active: ['en-US'] }), editorInterface: { controls: [] } },
    entry: {
      fields: {
        text: {
          locales: ['en-US'],
          getValue: () => value,
          onValueChanged: (_locale: string, callback: (next: unknown) => void) => {
            listener = callback;
            callback(valueOnSubscribe);
            return unsubscribe;
          },
        },
      },
    },
  } as unknown as SidebarAppSDK;
  return {
    sdk,
    unsubscribe,
    emit(next: string) {
      value = next;
      listener?.(next);
    },
  };
}

describe('editor value propagation', () => {
  it('keeps reporting changes after launch and releases the listener on unmount', () => {
    const editor = fixture();
    const onSnapshot = vi.fn();
    const stop = subscribeToEditorValues(editor.sdk, onSnapshot);
    editor.emit('Before');
    expect(onSnapshot).not.toHaveBeenCalled();
    editor.emit('First unsaved change');
    editor.emit('Second unsaved change');
    expect(onSnapshot.mock.calls.map(([snapshot]) => snapshot.fields.text['en-US'])).toEqual([
      'First unsaved change',
      'Second unsaved change',
    ]);
    stop();
    expect(editor.unsubscribe).toHaveBeenCalledOnce();
  });

  it('keeps an update emitted during registration', () => {
    const editor = fixture('Before', 'During registration');
    const onSnapshot = vi.fn();
    const stop = subscribeToEditorValues(editor.sdk, onSnapshot);
    expect(onSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ fields: { text: { 'en-US': 'During registration' } } }),
      'text',
      'en-US',
    );
    stop();
    expect(editor.unsubscribe).toHaveBeenCalledOnce();
  });

  it('delivers the latest value to a dialog that connects after an update', () => {
    const peers = new Map<string, Set<SnapshotChannel>>();
    const createChannel = (name: string): SnapshotChannel => {
      const channel: SnapshotChannel = {
        onmessage: null,
        postMessage(data) {
          for (const peer of peers.get(name) ?? []) if (peer !== channel) peer.onmessage?.({ data } as MessageEvent);
        },
        close() {
          peers.get(name)?.delete(channel);
        },
      };
      let channels = peers.get(name);
      if (!channels) {
        channels = new Set();
        peers.set(name, channels);
      }
      channels.add(channel);
      return channel;
    };
    const editor = fixture();
    let latest = capture(editor.sdk);
    const serve = serveSnapshotSession('session', () => latest, createChannel);
    const stopWatching = subscribeToEditorValues(editor.sdk, next => {
      latest = next;
      serve.publish(next);
    });
    editor.emit('Change before dialog mounts');
    const received: string[] = [];
    const stopReceiving = receiveSnapshotSession(
      'session',
      next => received.push(next.fields.text['en-US'] as string),
      createChannel,
    );
    editor.emit('Change while dialog is open');
    expect(received).toEqual(['Change before dialog mounts', 'Change while dialog is open']);
    stopReceiving();
    stopWatching();
    serve.close();
  });

  it('keeps dialog launch parameters small even for a large current entry', () => {
    const editor = fixture();
    const snapshot = capture(editor.sdk);
    snapshot.fields.text['en-US'] = 'x'.repeat(200_000);
    const invocation = dialogInvocation(snapshot, 'session-id');
    expect(invocation).toEqual({ entryId: 'entry', contentTypeId: 'test', sessionId: 'session-id' });
    expect(new TextEncoder().encode(JSON.stringify(invocation)).byteLength).toBeLessThan(200);
  });

  it('refreshes the current editor at Generate without replacing an unchanged preview', async () => {
    const peers = new Map<string, Set<SnapshotChannel>>();
    const createChannel = (name: string): SnapshotChannel => {
      const channel: SnapshotChannel = {
        onmessage: null,
        postMessage(data) {
          for (const peer of peers.get(name) ?? []) if (peer !== channel) peer.onmessage?.({ data } as MessageEvent);
        },
        close() {
          peers.get(name)?.delete(channel);
        },
      };
      let channels = peers.get(name);
      if (!channels) {
        channels = new Set();
        peers.set(name, channels);
      }
      channels.add(channel);
      return channel;
    };
    const latest = capture(fixture().sdk);
    const serve = serveSnapshotSession('fresh', () => latest, createChannel);
    const received: EditorSnapshot[] = [];
    const stop = receiveSnapshotSession('fresh', value => received.push(value), createChannel);
    latest.fields.text['en-US'] = 'Latest unsaved text';
    expect((await requestCurrentSnapshot('fresh', createChannel)).fields.text['en-US']).toBe('Latest unsaved text');
    expect(received).toHaveLength(1);
    stop();
    serve.close();
  });
});
