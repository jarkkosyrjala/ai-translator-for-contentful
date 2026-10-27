import type { ContentTypeField, DialogAppSDK } from '@contentful/app-sdk';
import { describe, expect, it, vi } from 'vitest';
import { createReviewField } from '../src/app/dialog/review-field';

describe('dialog-local Contentful field adapter', () => {
  it('keeps read-only source/current values immutable while allowing live snapshot updates', async () => {
    const onChange = vi.fn();
    const bridge = createReviewField(
      { ids: {}, parameters: {} } as DialogAppSDK,
      'entry',
      'page',
      { id: 'body', name: 'Body', type: 'Text' } as ContentTypeField,
      'en',
      '## Source\n\n**Original** text',
      onChange,
      {},
      true,
    );
    const disabled = vi.fn();
    const changed = vi.fn();
    bridge.field.onIsDisabledChanged(disabled);
    bridge.field.onValueChanged(changed);
    expect(bridge.field.getIsDisabled()).toBe(true);
    expect(disabled).toHaveBeenCalledWith(true);
    await bridge.field.setValue('Overwritten');
    await bridge.field.removeValue();
    expect(bridge.field.getValue()).toBe('## Source\n\n**Original** text');
    expect(onChange).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    bridge.setExternal('## Updated source');
    expect(bridge.field.getValue()).toBe('## Updated source');
    expect(changed).toHaveBeenCalledWith('## Updated source');
    expect(onChange).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it('keeps native editor writes in the suggestion until Apply', async () => {
    const onChange = vi.fn();
    const dialog = {
      ids: { space: 'space', environment: 'master' },
      parameters: { installation: {}, invocation: {} },
    } as unknown as DialogAppSDK;
    const definition = {
      id: 'body',
      name: 'Body',
      type: 'Text',
      localized: true,
      required: false,
      validations: [],
    } as ContentTypeField;
    const bridge = createReviewField(dialog, 'entry', 'page', definition, 'fi', 'Original', onChange, {
      customSetting: true,
    });
    const listener = vi.fn();
    bridge.field.onValueChanged(listener);
    expect(bridge.sdk.ids.entry).toBe('entry');
    expect(bridge.sdk.parameters.instance).toEqual({ customSetting: true });
    expect(bridge.field.getValue()).toBe('Original');
    await bridge.field.setValue('Edited');
    expect(bridge.field.getValue()).toBe('Edited');
    expect(listener).toHaveBeenCalledWith('Edited');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('Edited');
    bridge.setExternal('Restored');
    expect(bridge.field.getValue()).toBe('Restored');
    expect(onChange).toHaveBeenCalledOnce();
    bridge.dispose();
    await bridge.field.setValue('Late edit');
    expect(onChange).toHaveBeenCalledOnce();
  });
});
