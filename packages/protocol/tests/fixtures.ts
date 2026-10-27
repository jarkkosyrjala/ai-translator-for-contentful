import { defaultInstructionProfile, type TranslateRequest } from '../src';

// Synthetic paired fixtures: a grouped request with every work type and its
// matching response. Never use real content here.
export const profile = defaultInstructionProfile();

export function groupedRequest(change: Partial<TranslateRequest> = {}): TranslateRequest {
  return {
    contract: 1,
    requestId: 'request-1',
    entryId: 'example',
    model: 'test-model',
    sourceLocale: 'en-US',
    targetLocale: 'fi-FI',
    availableLocales: ['en-US', 'fi-FI'],
    profile,
    profileRevision: profile.revision,
    context: [
      {
        id: 'ctx-1',
        role: 'explicit',
        entryId: 'example',
        fieldId: 'placement',
        name: 'Placement',
        locale: 'en-US',
        provenance: 'current-editor',
        omittedUnits: 0,
        value: 'Checkout page.',
      },
    ],
    fields: [
      {
        id: 'f-title',
        fieldId: 'title',
        name: 'Title',
        type: 'text',
        constraints: { max: 100 },
        outputGuidance: 'Preserve placeholders and whitespace.',
        source: 'Delivery & returns',
      },
      {
        id: 'f-tags',
        fieldId: 'tags',
        name: 'Tags',
        type: 'array',
        constraints: { countMax: 5, itemMax: 50 },
        outputGuidance: 'Translate each item separately.',
        items: [
          { id: 'i0', text: 'Home delivery' },
          { id: 'i1', text: 'Collection' },
        ],
      },
      {
        id: 'f-body',
        fieldId: 'body',
        name: 'Body',
        type: 'richText',
        outputGuidance: 'Preserve structure and anchors.',
        source: [
          {
            unit: 'u0',
            tag: 'p',
            content: ['We deliver to your ', { mark: 'm0', tag: 'strong', children: ['door'] }, '.'],
          },
        ],
      },
    ],
    ...change,
  };
}

export const groupedResponse = `<translation>
  <field id="f-title" type="text">Toimitus & palautukset</field>
  <field id="f-tags" type="array"><item id="i0">Kotiinkuljetus</item><item id="i1">Nouto</item></field>
  <field id="f-body" type="richText"><p id="u0">Toimitamme tilauksesi <strong data-mark="m0">ovellesi</strong>.</p></field>
</translation>`;

// A Rich Text part with every block and anchor kind.
export const richRequest = groupedRequest({
  context: undefined,
  fields: [
    {
      id: 'f-doc',
      fieldId: 'doc',
      name: 'Document',
      type: 'richText',
      part: 2,
      parts: 3,
      source: [
        { unit: 'u4', tag: 'h2', content: ['Pricing'] },
        {
          unit: 'u5',
          tag: 'p',
          content: [
            'Save ',
            { mark: 'm0', tag: 'strong', children: ['20%'] },
            ' with ',
            { placeholder: 'p0', text: '{code}' },
            ' on ',
            { link: 'l0', children: ['the <p> guide'] },
            { break: 'b0' },
            'Run ',
            { mark: 'm1', tag: 'code', children: [{ fixed: 'f0', text: 'npm i' }] },
            ' ',
            { ref: 'r0' },
          ],
        },
        {
          tag: 'ul',
          children: [{ tag: 'li', children: [{ unit: 'u6', tag: 'p', content: ['Free plan'] }] }],
        },
        { tag: 'hr' },
        { tag: 'embed', kind: 'asset' },
        {
          tag: 'table',
          children: [
            {
              tag: 'tr',
              children: [{ tag: 'td', colspan: 2, children: [{ unit: 'u7', tag: 'p', content: ['Plan'] }] }],
            },
          ],
        },
      ],
    },
  ],
});
