import { describe, expect, it } from 'vitest';
import {
  compileTranslationMessages,
  DEFAULT_LIMITS,
  defaultInstructionProfile,
  escapeText,
  MarkupError,
  mockResponseMarkup,
  OUTPUT_INSTRUCTION,
  parseTranslateRequest,
  parseTranslateResponse,
  REQUEST_INSTRUCTION,
  RICH_TEXT_VOCABULARY,
  type RichTextWork,
  readRichTextResult,
  readTranslationResponse,
  serializeBlocks,
  type TextWork,
  type TranslateRequest,
  validateInstructionProfile,
  workSourceCharacters,
} from '../src';
import { parseStrict } from '../src/translation/markup';
import { groupedRequest, groupedResponse, profile, richRequest } from './fixtures';

const limits = { nodes: DEFAULT_LIMITS.parserNodes, depth: DEFAULT_LIMITS.parserDepth };
const read = (content: string, request: Pick<TranslateRequest, 'fields'> = groupedRequest()) =>
  readTranslationResponse(content, request, limits);

function textRequest(source: string): TranslateRequest {
  return groupedRequest({
    context: undefined,
    fields: [{ id: 'f-text', fieldId: 'text', name: 'Text', type: 'text', source }],
  });
}
// A response that echoes the serialized source as the field's value.
function echo(request: TranslateRequest): string {
  const user = compileTranslationMessages(profile, request)[1].content;
  const [, source] = /<source>([\s\S]*?)<\/source>\n {4}<\/field>/.exec(user) ?? [];
  return `<translation><field id="${request.fields[0].id}" type="${request.fields[0].type}">${source}</field></translation>`;
}

describe('contract 1 request and paired example', () => {
  it('serializes the documented user message with bare text characters', () => {
    const [system, user] = compileTranslationMessages(profile, groupedRequest());
    expect(system.role).toBe('system');
    expect(system.content.startsWith(REQUEST_INSTRUCTION)).toBe(true);
    expect(system.content.endsWith(OUTPUT_INSTRUCTION)).toBe(true);
    expect(system.content).toContain('Translate <fields> from en-US to fi-FI.');
    expect(system.content).toContain('Use <context> for meaning');
    expect(system.content).toContain('Follow <runGuidance> when provided');
    expect(user.content).toBe(`<translation sourceLocale="en-US" targetLocale="fi-FI">
  <context><field id="ctx-1" role="explicit" entryId="example" fieldId="placement" name="Placement" locale="en-US" provenance="current-editor" omittedUnits="0">Checkout page.</field></context>
  <fields>
    <field id="f-title" fieldId="title" name="Title" type="text">
      <constraints max="100"/><outputGuidance>Preserve placeholders and whitespace.</outputGuidance>
      <source>Delivery & returns</source>
    </field>
    <field id="f-tags" fieldId="tags" name="Tags" type="array">
      <constraints countMax="5" itemMax="50"/><outputGuidance>Translate each item separately.</outputGuidance>
      <source><item id="i0">Home delivery</item><item id="i1">Collection</item></source>
    </field>
    <field id="f-body" fieldId="body" name="Body" type="richText">
      <constraints/><outputGuidance>Preserve structure and anchors.</outputGuidance>
      <source><p id="u0">We deliver to your <strong data-mark="m0">door</strong>.</p></source>
    </field>
  </fields>
</translation>`);
  });

  it('places run guidance once and variables as data', () => {
    const custom = validateInstructionProfile({
      ...defaultInstructionProfile(),
      revision: 'custom-1',
      taskTemplate: 'Write for {audience} in {targetLocale}.',
      variables: [
        {
          key: 'audience',
          name: 'Audience',
          description: 'Reader',
          type: 'choice',
          required: true,
          choices: ['Consumers', 'Partners'],
        },
      ],
    });
    const request = groupedRequest({
      profile: custom,
      profileRevision: 'custom-1',
      runGuidance: 'Delivery means shipment to {audience} in {targetLocale}.',
      variableValues: { audience: 'Consumers' },
    });
    const [system, user] = compileTranslationMessages(custom, request);
    expect(system.content).toContain('Write for <variable key="audience"> in fi-FI.');
    expect(user.content).toContain(
      '<runGuidance>Delivery means shipment to &lt;variable key="audience"> in fi-FI.</runGuidance>\n  <variables><variable key="audience" name="Audience" type="choice" purpose="Reader">Consumers</variable></variables>',
    );
    expect(user.content.match(/<runGuidance>/g)).toHaveLength(1);
    expect(() => compileTranslationMessages(custom, { ...request, runGuidance: 'Use {fieldName}.' })).toThrow(
      'Unknown template variable: fieldName',
    );
  });

  it('teaches preservation with a paired example that the frontend can reconstruct', () => {
    const [system] = compileTranslationMessages(profile, groupedRequest());
    expect(system.content).toContain('Every source data-mark id MUST remain');
    const [source, translated] = [...system.content.matchAll(/<p id="u1">.*?<\/p>/g)].map(match => match[0]);
    const work: RichTextWork = {
      id: 'example',
      fieldId: 'body',
      name: 'Body',
      type: 'richText',
      source: [
        { unit: 'u1', tag: 'p', content: ['Visit the ', { mark: 'm0', tag: 'strong', children: ['blue house'] }, '.'] },
      ],
    };
    expect(source).toBe(serializeBlocks(work.source, RICH_TEXT_VOCABULARY));
    expect(readRichTextResult(translated, work, limits).get('u1')).toContainEqual({
      mark: 'm0',
      tag: 'strong',
      children: ['sinisessä talossa'],
    });
  });

  it('rejects unknown variables in saved templates and unsupported profile versions', () => {
    for (const removed of [
      'fieldId',
      'fieldName',
      'fieldType',
      'fieldConstraints',
      'guidance',
      'context',
      'runGuidance',
    ])
      expect(() =>
        validateInstructionProfile({ ...defaultInstructionProfile(), taskTemplate: `Use {${removed}}.` }),
      ).toThrow(`Unknown template variable: ${removed}`);
    expect(() => validateInstructionProfile({ ...defaultInstructionProfile(), version: 2, factoryVersion: 2 })).toThrow(
      'instruction profile is invalid',
    );
  });

  it('rejects invalid locale codes and run guidance before a backend reserves the request', () => {
    const codes = (sourceLocale: string, targetLocale = 'fi-FI') =>
      groupedRequest({ sourceLocale, targetLocale, availableLocales: [sourceLocale, targetLocale] });
    expect(() => parseTranslateRequest(codes('not a locale'))).toThrow('invalid_request');
    expect(() => parseTranslateRequest(codes('en-US', 'en_US!'))).toThrow('invalid_request');
    expect(() => parseTranslateRequest(groupedRequest({ runGuidance: 'Use {unknown}.' }))).toThrow('invalid_request');
    expect(() => parseTranslateRequest(groupedRequest({ runGuidance: 'Use {perRunGuidance}.' }))).toThrow(
      'invalid_request',
    );
    expect(parseTranslateRequest(groupedRequest({ runGuidance: 'Keep it short for {targetLocale}.' }))).toBeTruthy();
  });

  it('never resolves inherited object properties as variables', () => {
    const custom = validateInstructionProfile({
      ...defaultInstructionProfile(),
      taskTemplate: 'Use {toString}.',
      variables: [{ key: 'toString', name: 'Tone', description: '', type: 'text', required: false }],
    });
    const request = groupedRequest({ profile: custom, profileRevision: custom.revision });
    const [system, user] = compileTranslationMessages(custom, request);
    expect(system.content).toContain('Use <variable key="toString">.');
    expect(system.content).not.toContain('native code');
    expect(user.content).not.toContain('native code');
  });

  it('validates typed work fields, identities and bounds', () => {
    expect(parseTranslateRequest(groupedRequest())).toEqual(groupedRequest());
    expect(parseTranslateRequest(richRequest)).toEqual(richRequest);
    const work = groupedRequest().fields;
    const cases: [unknown, string][] = [
      [{ ...groupedRequest(), contract: 2 }, 'unsupported_contract'],
      [{ ...groupedRequest(), basePrompt: '' }, 'unexpected_property'],
      [groupedRequest({ targetLocale: 'en-US', availableLocales: ['en-US'] }), 'same_locale'],
      [groupedRequest({ availableLocales: ['en-US'] }), 'invalid_request'],
      [groupedRequest({ fields: [] }), 'invalid_request'],
      [groupedRequest({ fields: [work[0], { ...work[0] }] }), 'invalid_request'],
      [groupedRequest({ fields: [{ ...work[0], id: 'has space' }] }), 'invalid_request'],
      [groupedRequest({ fields: [{ ...(work[0] as TextWork), source: 'bell\u0007' }] }), 'invalid_request'],
      [groupedRequest({ fields: [{ ...(work[0] as TextWork), source: '   ' }] }), 'invalid_request'],
      [groupedRequest({ fields: [{ ...work[1], items: [{ id: 'i0', text: ' ' }] } as never] }), 'invalid_request'],
      [groupedRequest({ fields: [{ ...work[0], part: 1 } as never] }), 'invalid_request'],
      [groupedRequest({ fields: [{ ...work[0], sourceText: 'x' } as never] }), 'unexpected_property'],
      [groupedRequest({ profileRevision: 'other' }), 'invalid_request'],
      [
        groupedRequest({
          fields: [
            {
              ...(work[2] as RichTextWork),
              source: [
                {
                  unit: 'u0',
                  tag: 'p',
                  content: [
                    { link: 'l0', children: [] },
                    { link: 'l0', children: [] },
                  ],
                },
              ],
            },
          ],
        }),
        'invalid_request',
      ],
      [
        groupedRequest({
          context: [{ ...(groupedRequest().context?.[0] as never), role: 'neighbor', for: 'f-title' }],
        }),
        'invalid_request',
      ],
    ];
    for (const [value, code] of cases) expect(() => parseTranslateRequest(value), code).toThrow(code);
    expect(() => parseTranslateRequest(groupedRequest(), 1_000)).toThrow('request_too_large');
    expect(() =>
      parseTranslateRequest(
        groupedRequest({ fields: [{ ...(work[0] as TextWork), source: 'x'.repeat(50_001) }] }),
        DEFAULT_LIMITS.requestBytes,
      ),
    ).toThrow('invalid_request');
  });

  it('counts readable source in Unicode code points', () => {
    expect(workSourceCharacters({ ...(groupedRequest().fields[0] as TextWork), source: 'a👋b' })).toBe(3);
    expect(workSourceCharacters(groupedRequest().fields[1])).toBe('Home delivery'.length + 'Collection'.length);
    expect(workSourceCharacters(richRequest.fields[0])).toBe(
      ['Pricing', 'Save 20% with {code} on the <p> guide\nRun npm i ', 'Free plan', 'Plan'].join('').length,
    );
  });
});

describe('contract 1 response reader', () => {
  it('reads the documented response into keyed results', () => {
    const results = read(groupedResponse);
    expect(results).toEqual([
      { id: 'f-title', status: 'ok', type: 'text', text: 'Toimitus & palautukset' },
      {
        id: 'f-tags',
        status: 'ok',
        type: 'array',
        items: [
          { id: 'i0', text: 'Kotiinkuljetus' },
          { id: 'i1', text: 'Nouto' },
        ],
      },
      {
        id: 'f-body',
        status: 'ok',
        type: 'richText',
        markup: '<p id="u0">Toimitamme tilauksesi <strong data-mark="m0">ovellesi</strong>.</p>',
      },
    ]);
    const response = {
      contract: 1,
      requestId: 'request-1',
      provider: 'mock',
      profileRevision: profile.revision,
      results,
    };
    expect(parseTranslateResponse(response, groupedRequest())).toEqual(response);
    expect(() => parseTranslateResponse({ ...response, results: results.slice(1) }, groupedRequest())).toThrow(
      'invalid_response',
    );
    expect(() => parseTranslateResponse({ ...response, requestId: 'other' }, groupedRequest())).toThrow(
      'invalid_response',
    );
  });

  it('round-trips bare characters, literal references, tags, Unicode and whitespace exactly', () => {
    const values = [
      'Delivery & returns <3 > 2',
      'Use &amp; and &#169; literally; AT&T',
      'A literal </field> and <field x="1"> and </translation> stay text',
      'Ordinary <p>paragraph</p> and <unknown> tags',
      '  Hei 👋\r\nmaailma\n\n  \tlopuksi  ',
      'A <!-- comment --> and <?pi?> and <![CDATA[x]]>',
      'Quotes "double" and \'single\' {name} %1$s',
    ];
    for (const value of values) {
      const request = textRequest(value);
      expect(read(echo(request), request)).toEqual([{ id: 'f-text', status: 'ok', type: 'text', text: value }]);
    }
    expect(escapeText('a &amp; <field> <p> <fieldset>', new Set(['field']))).toBe(
      'a &amp;amp; &lt;field> <p> <fieldset>',
    );
  });

  it('decodes references once and keeps bare model characters literal', () => {
    const request = textRequest('x');
    const answer = (value: string) =>
      read(`<translation><field id="f-text" type="text">${value}</field></translation>`, request)[0];
    expect(answer('A & B <3 > 1 &copy; &amp;amp;')).toMatchObject({ text: 'A & B <3 > 1 &copy; &amp;' });
    expect(answer('&lt;p&gt; &#x1F44B; &#65;')).toMatchObject({ text: '<p> 👋 A' });
  });

  it('reads result fields inside one echoed <fields> wrapper', () => {
    // A real model answered with the request's wrapper and attributes.
    const echoed = groupedResponse
      .replace('<translation>', '\n\n<translation sourceLocale="en-US" targetLocale="fi-FI">\n  <fields>')
      .replace('</translation>', '</fields>\n</translation>');
    expect(read(echoed)).toEqual(read(groupedResponse));
  });

  it('reads fields inside any wrapper and ignores everything around them', () => {
    const fields = groupedResponse.replace(/^<translation>|<\/translation>$/g, '');
    const answers = [
      // Real models answered with a bare <field> element and an echoed <fields> wrapper.
      `\n\n${fields}`,
      `<fields>${fields}</fields>`,
      `<translation><fields>${fields}</fields><fields></fields></translation>`,
      `<result>${fields}</result>`,
      `\`\`\`xml\n<?xml version="1.0"?>\n<!DOCTYPE translation>${groupedResponse}\n\`\`\``,
      `Here is the translation: <!-- note --><translation><foo/>Note: ${fields}<![CDATA[x]]>`,
      `<translation>${fields}<field id="f-other">x</field><field>y</field>`,
    ];
    for (const answer of answers) expect(read(answer), answer).toEqual(read(groupedResponse));
  });

  it('reads a field without an ID only when one field was requested', () => {
    const request = groupedRequest({
      fields: [{ id: 'f-title', fieldId: 'title', name: 'Title', type: 'text', source: 'Delivery' }],
    });
    for (const answer of [
      "Here's the answer: <field>Toimitus</field>",
      'Sure!\n\n```xml\n<field type="text">Toimitus</field>\n```\nLet me know if you need more.',
    ])
      expect(read(answer, request), answer).toEqual([{ id: 'f-title', status: 'ok', type: 'text', text: 'Toimitus' }]);
    expect(read('<field>Toimitus</field><field id="f-title">Toimitus</field>', request)[0]).toMatchObject({
      error: 'invalid_structure',
    });
    expect(read('<translation><field>Toimitus</field></translation>')[0]).toMatchObject({ error: 'missing' });
  });

  it('fails only a field whose ID repeats', () => {
    expect(read(groupedResponse.replace('</translation>', '<field id="f-title">Toinen</field></translation>'))).toEqual(
      [{ id: 'f-title', status: 'failed', error: 'invalid_structure' }, ...read(groupedResponse).slice(1)],
    );
  });

  it('fails the whole response for unreadable, truncated or ambiguous fields', () => {
    const failures = [
      groupedResponse.slice(0, 120),
      groupedResponse.replace('</field>\n  <field id="f-tags"', '\n  <field id="f-tags"'),
      '<translation><field id="f-title">A <!-- note --></field></translation>',
      '<translation><field id="f-title">A <![CDATA[x]]></field></translation>',
      '<translation><field id="f-title">A </field> B</field></translation>',
      '<translation><field id="f-title">A <field id="f-tags">B</field></field></translation>',
      '<translation><field id="f-title" xmlns:a="urn:x">A</field></translation>',
      '<translation><field id="f-title" a:b="x">A</field></translation>',
      '<translation><field id="f-title" id="again">A</field></translation>',
      '<translation><field id="f-tags"><item id="i0">A</field></translation>',
      '<translation><field id="f-title">&#0;</field></translation>',
      '<translation><field id="f-body"><p id="u0">A <strong data-mark="m0">b</p></strong></field></translation>',
    ];
    for (const failure of failures) expect(() => read(failure), failure).toThrow(MarkupError);
  });

  it('removes an echoed <source> wrapper only when it encloses the whole value', () => {
    // A real model wrapped values in the request's <source> element.
    const wrapped = `<translation>
  <field id="f-title">
    <source>Toimitus & palautukset</source>
  </field>
  <field id="f-tags"><source>
    <item id="i0">Kotiinkuljetus</item><item id="i1">Nouto</item>
  </source></field>
  <field id="f-body"><source><p id="u0">Toimitamme tilauksesi <strong data-mark="m0">ovellesi</strong>.</p></source></field>
</translation>`;
    expect(read(wrapped)).toEqual(read(groupedResponse));
    // A literal <source> inside a value stays text.
    expect(read('<translation><field id="f-title">Käytä <source>-elementtiä</field></translation>')[0]).toMatchObject({
      text: 'Käytä <source>-elementtiä',
    });
    // A source that itself mentions <source> is never unwrapped.
    const request = groupedRequest({
      fields: [{ id: 'f-title', fieldId: 'title', name: 'Title', type: 'text', source: '<source>HTML</source>' }],
    });
    expect(
      read('<translation><field id="f-title"><source>HTML</source></field></translation>', request)[0],
    ).toMatchObject({ text: '<source>HTML</source>' });
  });

  it('removes a stray closing input delimiter without changing the translated content or its line ending', () => {
    const request = textRequest('Some __bold__ text.\n');
    const translation = 'Jotain __paksua__ tekstiä.\n';
    expect(read(`<field id="f-text">${translation}</source>\n</field>`, request)[0]).toMatchObject({
      status: 'ok',
      text: translation,
    });
    // Field-boundary cleanup works for structured values too.
    expect(read(groupedResponse.replaceAll('</field>', '</source>\n</field>'))).toEqual(read(groupedResponse));
  });

  it('retains source-tag examples and ambiguous delimiters as editable text', () => {
    for (const source of ['Use </source>', '<source lang="en">text</source>', 'Use &lt;/source&gt;']) {
      const request = textRequest(source);
      const content = '<source>Esimerkki</source>';
      expect(read(`<field id="f-text">${content}</field>`, request)[0]).toMatchObject({ text: content });
    }
    const content = 'Esimerkki </source> tekstissä';
    expect(read(`<field id="f-text">${content}</field>`, textRequest('Example'))[0]).toMatchObject({
      text: content,
    });
  });

  it('reads quoted > in attributes and ignores envelope attributes and result types', () => {
    const results = read(
      `<translation note="x>y" lang='fi'>
<field id="f-title" type="array" extra='a > b'>Otsikko</field>
<field id="f-tags" type="text"><item id="i0" n="1">Yksi</item><item id='i1'>Kaksi</item></field>
<field id="f-body"><p id="u0">Teksti <strong data-mark="m0">tässä</strong></p></field>
</translation>`,
    );
    expect(results.map(result => result.status)).toEqual(['ok', 'ok', 'ok']);
    expect(results[0]).toMatchObject({ type: 'text', text: 'Otsikko' });
  });

  it('keeps format-valid preservation changes for frontend review while missing fields fail alone', () => {
    const results = read(`<translation>
<field id="f-tags"><item id="i1">Nouto</item><item id="i0">Kotiinkuljetus</item></field>
<field id="f-body"><p id="u0">Ei korostusta</p></field>
</translation>`);
    expect(results).toEqual([
      { id: 'f-title', status: 'failed', error: 'missing' },
      {
        id: 'f-tags',
        status: 'ok',
        type: 'array',
        items: [
          { id: 'i1', text: 'Nouto' },
          { id: 'i0', text: 'Kotiinkuljetus' },
        ],
      },
      { id: 'f-body', status: 'ok', type: 'richText', markup: '<p id="u0">Ei korostusta</p>' },
    ]);
    expect(read(groupedResponse.replace('Toimitus & palautukset', '  '))[0]).toEqual({
      id: 'f-title',
      status: 'ok',
      type: 'text',
      text: '  ',
    });
    expect(read(groupedResponse.replace('<item id="i1">Nouto</item>', ''))[1]).toMatchObject({
      status: 'ok',
      items: [{ id: 'i0', text: 'Kotiinkuljetus' }],
    });
    expect(read(groupedResponse.replace('Nouto</item>', 'Nouto</item> extra'))[1]).toMatchObject({
      error: 'invalid_items',
    });
  });

  it('keeps literal tags in text, structure in Rich Text units, and rejects structure out of place', () => {
    const request = textRequest('x');
    const text = read(
      '<translation><field id="f-text"><p>Kohta</p> <unknown> <item id="i0">x</item></field></translation>',
      request,
    );
    expect(text[0]).toMatchObject({ text: '<p>Kohta</p> <unknown> <item id="i0">x</item>' });
    const rich = (inner: string) =>
      read(groupedResponse.replace(/<field id="f-body"[\s\S]*?<\/field>/, `<field id="f-body">${inner}</field>`))[2];
    expect(rich('<p id="u0">A <unknown> b <strong data-mark="m0">c</strong></p>')).toMatchObject({
      markup: '<p id="u0">A <unknown> b <strong data-mark="m0">c</strong></p>',
    });
    // A literal closing tag of an open element is ambiguous, so the response fails.
    expect(() => rich('<p id="u0">A <p>b</p> <strong data-mark="m0">c</strong></p>')).toThrow(MarkupError);
    expect(rich('<p id="u0">A &lt;p>b&lt;/p> <strong data-mark="m0">c</strong></p>')).toMatchObject({
      markup: '<p id="u0">A &lt;p>b&lt;/p> <strong data-mark="m0">c</strong></p>',
    });
    expect(rich('Lead <p id="u0"><strong data-mark="m0">c</strong></p>')).toMatchObject({ error: 'invalid_structure' });
    expect(rich('<p id="u0"><strong data-mark="m0">c</strong></p><p id="u1">extra</p>')).toMatchObject({
      status: 'ok',
    });
    expect(rich('<h2 id="u0"><strong data-mark="m0">c</strong></h2>')).toMatchObject({ status: 'ok' });
    expect(rich('<p id="u0" class="x"><strong data-mark="m0">c</strong></p>')).toMatchObject({
      error: 'invalid_structure',
    });
  });

  it('returns model content intact and leaves preservation checks to the frontend', () => {
    const work = richRequest.fields[0] as RichTextWork;
    const source = serializeBlocks(work.source, RICH_TEXT_VOCABULARY);
    expect(source).toContain('<a data-link="l0">the &lt;p> guide</a>');
    const answer = (markup: string) =>
      read(`<translation><field id="f-doc">${markup}</field></translation>`, richRequest)[0];
    const translated = source
      .replace('Pricing', 'Hinnoittelu')
      .replace(
        'Save <strong data-mark="m0">20%</strong> with',
        '<strong data-mark="m0">Säästä</strong> <strong data-mark="m0">20 %</strong> käyttäen',
      )
      .replace('<span data-placeholder="p0">{code}</span>', '<span data-placeholder="p0">{koodi}</span>')
      .replace('Free plan', 'Ilmainen');
    const result = answer(`\n${translated}\n`);
    expect(result.status).toBe('ok');
    const markup = (result as { markup: string }).markup;
    expect(markup).toContain('<span data-placeholder="p0">{koodi}</span>');
    expect(markup).toContain('<td colspan="2"><p id="u7">Plan</p></td>');
    const units = readRichTextResult(markup, work, limits);
    expect(units.get('u4')).toEqual(['Hinnoittelu']);
    expect(units.get('u5')).toContainEqual({ placeholder: 'p0', text: '{koodi}' });
    expect(
      serializeBlocks(
        work.source.map(block => ('unit' in block ? { ...block, content: units.get(block.unit) ?? [] } : block)),
        RICH_TEXT_VOCABULARY,
      ),
    ).not.toBe('');
    expect(answer(markup)).toEqual({ ...result });
    const failures = [
      source.replace('<br data-break="b0"/>', ''),
      source.replace('<br data-break="b0"/>', '<br data-break="b0"/><br data-break="b0"/>'),
      source.replace('<span data-ref="r0"/>', ''),
      source.replace('<a data-link="l0">', '<a data-link="l9">'),
      source.replace('<strong data-mark="m0">20%</strong>', '<em data-mark="m0">20%</em>'),
      source.replace(
        '<strong data-mark="m0">20%</strong>',
        '<strong data-mark="m0"><strong data-mark="m0">20%</strong></strong>',
      ),
      source.replace('<strong data-mark="m0">20%</strong>', '20%'),
      source.replace('<hr/>', ''),
      source.replace('<embed data-kind="asset"/>', '<embed data-kind="entry"/>'),
      source.replace('<td colspan="2">', '<td>'),
      source.replace('<ul>', '<ol>').replace('</ul>', '</ol>'),
    ];
    for (const failure of failures) {
      expect(answer(failure), failure).toMatchObject({ id: 'f-doc', status: 'ok', type: 'richText' });
      expect(() => readRichTextResult(failure, work, limits)).toThrow();
    }
    expect(
      answer(
        source.replace(
          '<span data-fixed="f0">npm i</span>',
          '<span data-fixed="f0"><em data-mark="m9">npm</em></span>',
        ),
      ),
    ).toMatchObject({ status: 'failed', error: 'invalid_structure' });
  });

  it('enforces parser bounds and attribute limits', () => {
    const request = textRequest('x');
    const deep = `${'<ul><li>'.repeat(40)}<p id="u0">x</p>${'</li></ul>'.repeat(40)}`;
    expect(() => read(`<translation><field id="f-body">${deep}</field></translation>`)).toThrow(MarkupError);
    expect(() => readTranslationResponse(groupedResponse, groupedRequest(), { nodes: 3, depth: 64 })).toThrow(
      MarkupError,
    );
    const attrs = Array.from({ length: 17 }, (_, index) => ` a${index}="x"`).join('');
    expect(() => read(`<translation><field id="f-text"${attrs}>x</field></translation>`, request)).toThrow(MarkupError);
    expect(() =>
      read(`<translation><field id="f-text" note="${'x'.repeat(4_097)}">x</field></translation>`, request),
    ).toThrow(MarkupError);
  });

  it('scopes item, unit and anchor IDs to their work field', () => {
    const rich = groupedRequest().fields[2] as RichTextWork;
    const request = groupedRequest({
      context: undefined,
      fields: [
        { id: 'f-a', fieldId: 'a', name: 'Same name', type: 'array', items: [{ id: 'i0', text: 'One' }] },
        { id: 'f-b', fieldId: 'b', name: 'Same name', type: 'array', items: [{ id: 'i0', text: 'Two' }] },
        { ...rich, id: 'f-c', fieldId: 'c' },
        { ...rich, id: 'f-d', fieldId: 'd' },
      ],
    });
    expect(parseTranslateRequest(request)).toEqual(request);
    const results = read(mockResponseMarkup(request), request);
    expect(results.map(result => result.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(results[1]).toMatchObject({ items: [{ id: 'i0', text: 'Two [fi-FI]' }] });
    // A unit answered under the wrong field fails only that field.
    const swapped = mockResponseMarkup(request).replace(
      '<field id="f-d" type="richText"><p id="u0">',
      '<field id="f-d" type="richText"><p id="u9">',
    );
    expect(read(swapped, request).map(result => result.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
  });

  it('answers mock translation through the same reader', () => {
    const results = read(mockResponseMarkup(groupedRequest()));
    expect(results[0]).toMatchObject({ text: 'Delivery & returns [fi-FI example]' });
    expect(results[1]).toMatchObject({
      items: [
        { id: 'i0', text: 'Home delivery [fi-FI]' },
        { id: 'i1', text: 'Collection [fi-FI]' },
      ],
    });
    expect(results[2]).toMatchObject({
      markup: '<p id="u0">We deliver to your <strong data-mark="m0">door</strong>.</p>',
    });
    expect(read(mockResponseMarkup(richRequest), richRequest)[0].status).toBe('ok');
  });
});

describe('strict XML parser', () => {
  it('keeps mixed content in order and decodes references once', () => {
    expect(parseStrict('<a x="&amp;amp;&#10;">A &amp;lt; <b>&#13;</b> c</a>', limits)).toEqual({
      name: 'a',
      attrs: { x: '&amp;\n' },
      children: ['A &lt; ', { name: 'b', attrs: {}, children: ['\r'] }, ' c'],
    });
  });

  it('rejects anything but one well-formed element within bounds', () => {
    const failures = [
      '<a><!-- note --></a>',
      '<a><![CDATA[x]]></a>',
      '<a><?pi x?></a>',
      '<!DOCTYPE a><a/>',
      '<!-- note --><a/>',
      '<a/><b/>',
      'Note: <a/>',
      '<a>&nbsp;</a>',
      '<a>&#0;</a>',
      '<a x="1" x="2"/>',
      '<a><b></a>',
      '<a>',
    ];
    for (const failure of failures) expect(() => parseStrict(failure, limits), failure).toThrow(MarkupError);
    expect(() => parseStrict('<a><b><c/></b></a>', { nodes: 3, depth: 2 })).toThrow(MarkupError);
    expect(() => parseStrict('<a><b/><c/></a>', { nodes: 2, depth: 64 })).toThrow(MarkupError);
    expect(parseStrict('<a><b><c/></b></a>', { nodes: 3, depth: 3 }).name).toBe('a');
  });
});
