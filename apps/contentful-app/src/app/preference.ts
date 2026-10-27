// One saved value, such as the source locale or the provider and model.
export function readPreference(key: string): { available: boolean; value: string | null } {
  try {
    return { available: true, value: localStorage.getItem(key) };
  } catch {
    return { available: false, value: null };
  }
}
export function savePreference(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function readTargetPreference(key: string): { available: boolean; value: string[] } {
  let stored: string | null;
  try {
    stored = localStorage.getItem(key);
  } catch {
    return { available: false, value: [] };
  }
  try {
    const value = JSON.parse(stored ?? '[]');
    return {
      available: true,
      value: Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
    };
  } catch {
    return { available: true, value: [] };
  }
}

export function saveTargetPreference(key: string, locales: string[]): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(locales));
    return true;
  } catch {
    return false;
  }
}

export function initialTargets(locales: string[], source: string, savedTargets: string[]): string[] {
  const available = locales.filter(locale => locale !== source);
  return available.length === 1 ? available : available.filter(locale => savedTargets.includes(locale));
}

// The editor's saved provider and model when the installation still offers
// it; otherwise the installation default.
export function initialChoice(choices: { key: string }[], installationDefault: string, saved: string | null): string {
  return saved && choices.some(choice => choice.key === saved) ? saved : installationDefault;
}
