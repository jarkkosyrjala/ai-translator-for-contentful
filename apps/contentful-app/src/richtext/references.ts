import type { ContentTypeField } from '@contentful/app-sdk';
import type { Block, Document, Inline, Text } from '@contentful/rich-text-types';

export type EntryReference = { spaceId: string; environmentId: string; entryId: string };
export type ReferenceContext = {
  spaceId: string;
  environmentId: string;
  entryContentType: (reference: EntryReference) => Promise<string>;
};

type AllowedResource = { type: string; source: string; contentTypes?: string[] };
type NodeRule = { linkContentType?: string[] };
type ReferenceRules = { validations: NodeRule[]; allowedResources?: AllowedResource[] };

const resourceUrn = /^crn:contentful:::content:spaces\/([^/]+)\/environments\/([^/]+)\/entries\/([^/]+)$/;

function referenceRules(field: ContentTypeField): Map<string, ReferenceRules> {
  const rules = new Map<string, ReferenceRules>();
  for (const validation of field.validations ?? []) {
    if (!validation.nodes) continue;
    for (const [nodeType, raw] of Object.entries(validation.nodes)) {
      const node = Array.isArray(raw) ? { validations: raw } : raw;
      if (!node || typeof node !== 'object') continue;
      const validations = Array.isArray(node.validations) ? (node.validations as NodeRule[]) : [];
      const allowedResources = 'allowedResources' in node ? (node.allowedResources as AllowedResource[]) : undefined;
      const previous = rules.get(nodeType);
      rules.set(nodeType, {
        validations: [...(previous?.validations ?? []), ...validations],
        allowedResources: allowedResources ?? previous?.allowedResources,
      });
    }
  }
  return rules;
}

// Translation cannot change a reference target, but a content-type rule can
// change after the source was saved. Resolve only references with field rules.
export async function richTextReferenceError(
  document: Document,
  field: ContentTypeField,
  context?: ReferenceContext,
): Promise<string | undefined> {
  const rules = referenceRules(field);
  const cache = new Map<string, Promise<string>>();
  const contentType = (lookup: ReferenceContext, reference: EntryReference) => {
    const key = `${reference.spaceId}/${reference.environmentId}/${reference.entryId}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = lookup.entryContentType(reference);
      cache.set(key, pending);
    }
    return pending;
  };
  async function visit(node: Document | Block | Inline | Text): Promise<string | undefined> {
    const rule = rules.get(node.nodeType);
    const typeRules = rule?.validations.filter(validation => validation.linkContentType !== undefined) ?? [];
    const resources = rule?.allowedResources;
    if (typeRules.length || resources !== undefined) {
      if (!context) return 'Rich Text reference rules cannot be checked in this editor';
      const target = node.data?.target?.sys;
      let reference: EntryReference;
      if (resources !== undefined) {
        const match = typeof target?.urn === 'string' ? resourceUrn.exec(target.urn) : null;
        if (target?.type !== 'ResourceLink' || target?.linkType !== 'Contentful:Entry' || !match)
          return `Invalid ${node.nodeType} resource reference`;
        reference = { spaceId: match[1], environmentId: match[2], entryId: match[3] };
        const source = `crn:contentful:::content:spaces/${reference.spaceId}/environments/${reference.environmentId}`;
        if (!resources.some(item => item.type === 'Contentful:Entry' && item.source === source))
          return `Rich Text ${node.nodeType} reference violates the allowed resource rule`;
      } else {
        if (target?.type !== 'Link' || target?.linkType !== 'Entry' || typeof target?.id !== 'string')
          return `Invalid ${node.nodeType} entry reference`;
        reference = { spaceId: context.spaceId, environmentId: context.environmentId, entryId: target.id };
      }
      let actualType: string;
      try {
        actualType = await contentType(context, reference);
      } catch {
        return `Cannot validate the ${node.nodeType} referenced entry against field rules`;
      }
      if (typeRules.some(validation => !validation.linkContentType?.includes(actualType)))
        return `Rich Text ${node.nodeType} reference violates the field content type rule`;
      if (resources !== undefined) {
        const source = `crn:contentful:::content:spaces/${reference.spaceId}/environments/${reference.environmentId}`;
        if (
          !resources.some(
            item =>
              item.type === 'Contentful:Entry' &&
              item.source === source &&
              (!item.contentTypes || item.contentTypes.includes(actualType)),
          )
        )
          return `Rich Text ${node.nodeType} reference violates the allowed resource content type rule`;
      }
    }
    if (node.nodeType === 'text') return;
    for (const child of node.content) {
      const error = await visit(child);
      if (error) return error;
    }
  }
  return visit(document);
}
