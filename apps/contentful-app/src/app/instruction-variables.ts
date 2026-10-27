import type { InstructionProfile } from '@ai-translator-for-contentful/protocol';

function removeReferences(template: string, key: string): string {
  // Match the same single-brace grammar as instruction profile validation. Doubled braces are literal text.
  return template.replace(/\{\{|\}\}|\{([^{}]*)\}|[{}]/g, (token, raw: string | undefined) =>
    raw?.trim() === key ? '' : token,
  );
}

export function removeCustomVariable(profile: InstructionProfile, key: string): InstructionProfile {
  return {
    ...profile,
    alwaysApplied: removeReferences(profile.alwaysApplied, key),
    taskTemplate: removeReferences(profile.taskTemplate, key),
    variables: profile.variables.filter(variable => variable.key !== key),
  };
}
