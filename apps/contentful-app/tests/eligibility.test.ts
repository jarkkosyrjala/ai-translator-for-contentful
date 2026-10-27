import type { ContentTypeField, EditorInterface } from '@contentful/app-sdk';
import { describe, expect, it } from 'vitest';
import { eligibility } from '../src/app/eligibility';

const field = (extra: Partial<ContentTypeField>): ContentTypeField => ({
  id: 'name',
  name: 'Name',
  type: 'Symbol',
  localized: true,
  required: false,
  validations: [],
  ...extra,
});
const controls = (widgetId: string): EditorInterface['controls'] => [
  { fieldId: 'name', widgetNamespace: 'builtin', widgetId },
];

describe('field eligibility', () => {
  it('includes localized text, Rich Text, and free-text arrays with size limits', () => {
    expect(eligibility(field({ validations: [{ size: { max: 80 } }] }), controls('singleLine'))).toMatchObject({
      eligible: true,
      kind: 'text',
      size: { max: 80 },
    });
    expect(eligibility(field({ type: 'RichText' }), controls('richTextEditor'))).toMatchObject({
      eligible: true,
      kind: 'richText',
      size: { max: 200_000 },
    });
    expect(
      eligibility(
        field({ type: 'Array', items: { type: 'Symbol', validations: [{ size: { max: 40 } }] } }),
        controls('tagEditor'),
      ),
    ).toMatchObject({ eligible: true, kind: 'array', size: { max: 1_000 }, itemSize: { max: 40 } });
    expect(eligibility(field({ type: 'Array', items: { type: 'Symbol' } }), controls('listInput'))).toMatchObject({
      eligible: true,
      kind: 'array',
      size: { max: 1_000 },
      itemSize: { max: 256 },
    });
  });
  it('enforces technical limits when field validation is absent or looser', () => {
    expect(eligibility(field({}), controls('singleLine'))).toMatchObject({ size: { max: 256 } });
    expect(
      eligibility(field({ type: 'Text', validations: [{ size: { max: 100_000 } }] }), controls('multipleLine')),
    ).toMatchObject({ size: { max: 50_000 } });
    expect(
      eligibility(
        field({
          type: 'Array',
          validations: [{ size: { max: 2_000 } }],
          items: { type: 'Symbol', validations: [{ size: { max: 400 } }] },
        }),
        controls('listInput'),
      ),
    ).toMatchObject({ size: { max: 1_000 }, itemSize: { max: 256 } });
  });
  it('excludes options, regex, custom controls, nonlocal and nontext', () => {
    expect(eligibility(field({ type: 'Array', items: { type: 'Symbol' } }), controls('checkbox')).eligible).toBe(false);
    expect(eligibility(field({ validations: [{ in: ['a', 'b'] }] }), controls('singleLine')).eligible).toBe(false);
    expect(
      eligibility(
        field({ type: 'Array', items: { type: 'Symbol', validations: [{ regexp: { pattern: '^x', flags: '' } }] } }),
        controls('listInput'),
      ).eligible,
    ).toBe(false);
    expect(eligibility(field({ localized: false }), controls('singleLine')).eligible).toBe(false);
    expect(eligibility(field({ type: 'Number' }), controls('numberEditor')).eligible).toBe(false);
    expect(eligibility(field({ type: 'Array', items: { type: 'Symbol' } }), []).eligible).toBe(false);
    expect(eligibility(field({}), [{ fieldId: 'name', widgetNamespace: 'app', widgetId: 'custom' }]).eligible).toBe(
      false,
    );
  });
});
