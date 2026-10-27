import type { TranslateRequest } from '../contract';
import { serializeTranslationRequest } from '../translation/serialize';
import {
  type InstructionProfile,
  OUTPUT_INSTRUCTION,
  REQUEST_INSTRUCTION,
  validateInstructionProfile,
  validateRunGuidanceTemplate,
} from './profile';

export type InstructionMessage = { role: 'system' | 'user'; content: string };

export function validLocale(locale: string): boolean {
  try {
    return Intl.getCanonicalLocales(locale).length === 1;
  } catch {
    return false;
  }
}

export function resolveVariableValues(
  profile: InstructionProfile,
  values: Record<string, string> = {},
  locales: string[],
): Record<string, string> {
  validateInstructionProfile(profile);
  if (Object.keys(values).some(key => !profile.variables.some(variable => variable.key === key))) {
    throw new Error('A run value names an unknown custom variable.');
  }
  const resolved: Record<string, string> = {};
  for (const variable of profile.variables) {
    const value =
      (Object.hasOwn(values, variable.key) ? values[variable.key] : undefined) ?? variable.defaultValue ?? '';
    if (typeof value !== 'string' || value.length > 1000) throw new Error(`Variable ${variable.name} is too long.`);
    if (variable.required && !value.trim()) throw new Error(`Enter ${variable.name} before translating.`);
    if (value && variable.type === 'choice' && !variable.choices?.includes(value))
      throw new Error(`Choose an allowed value for ${variable.name}.`);
    if (value && variable.type === 'locale' && (!validLocale(value) || !locales.includes(value)))
      throw new Error(`Choose an available locale for ${variable.name}.`);
    resolved[variable.key] = value;
  }
  return resolved;
}

// References render as the user message elements they name. Only validated
// locale codes are substituted; every other value stays data in its element.
const references: Record<string, string> = {
  content: '<fields>',
  selectedContext: '<context>',
  perRunGuidance: '<runGuidance>',
};

export function renderTemplate(
  template: string,
  input: Pick<TranslateRequest, 'sourceLocale' | 'targetLocale'>,
): string {
  return template.replace(/\{\{|\}\}|\{([^{}]*)\}/g, (token, raw: string | undefined) => {
    if (token === '{{') return '{';
    if (token === '}}') return '}';
    if (raw === undefined) return token;
    const key = raw.trim();
    return key === 'sourceLocale'
      ? input.sourceLocale
      : key === 'targetLocale'
        ? input.targetLocale
        : Object.hasOwn(references, key)
          ? references[key]
          : `<variable key="${key}">`;
  });
}

export function renderRunGuidance(
  template: string,
  input: Pick<TranslateRequest, 'sourceLocale' | 'targetLocale'>,
  profile: InstructionProfile,
): string {
  validateRunGuidanceTemplate(template, profile);
  return renderTemplate(template, input);
}

/**
 * The system and user messages of one translation request: the
 * administrator's templates between the code-owned request and output
 * instructions, then the request markup. One substitution pass; values are
 * never executed as templates.
 * @throws Error for an invalid profile, locale or variable value.
 */
export function compileTranslationMessages(
  profile: InstructionProfile,
  request: TranslateRequest,
): InstructionMessage[] {
  validateInstructionProfile(profile);
  if (
    !validLocale(request.sourceLocale) ||
    !validLocale(request.targetLocale) ||
    request.sourceLocale === request.targetLocale ||
    !request.availableLocales.includes(request.sourceLocale) ||
    !request.availableLocales.includes(request.targetLocale)
  ) {
    throw new Error('Select distinct available source and target locales.');
  }
  const values = resolveVariableValues(profile, request.variableValues, request.availableLocales);
  const runGuidance = request.runGuidance ? renderRunGuidance(request.runGuidance, request, profile) : '';
  const system = [
    REQUEST_INSTRUCTION,
    renderTemplate(profile.alwaysApplied, request),
    renderTemplate(profile.taskTemplate, request),
    OUTPUT_INSTRUCTION,
  ]
    .filter(part => part.trim())
    .join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: serializeTranslationRequest(request, profile, values, runGuidance) },
  ];
}
