export type Theme = 'dark' | 'light';
export type Density = 'comfortable' | 'compact';
export type AttachedAgent = 'claude-code' | 'codex' | 'cursor' | 'none';

export interface AppSettings {
  notifications: boolean;
  autostart: boolean;
  theme: Theme;
  density: Density;
  agent: AttachedAgent;
  maxTokensPerRun: number;
  maxTokensPerMinute: number;
  showArtifacts: boolean;
  showTasks: boolean;
}

export const defaultSettings: AppSettings = {
  notifications: true,
  autostart: false,
  theme: 'dark',
  density: 'comfortable',
  agent: 'claude-code',
  maxTokensPerRun: 200000,
  maxTokensPerMinute: 20000,
  showArtifacts: true,
  showTasks: true,
};

const STORAGE_KEY = 'qiansi.settings';
const LEGACY_KEY = 'agentweave.settings';

export function loadSettings(): AppSettings {
  try {
    const raw =
      window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_KEY);
    if (raw) {
      const parsed = { ...defaultSettings, ...(JSON.parse(raw) as Partial<AppSettings>) };
      if (!window.localStorage.getItem(STORAGE_KEY)) saveSettings(parsed);
      return parsed;
    }
  } catch {
    // localStorage can be unavailable in private windows; defaults are fine.
  }
  return defaultSettings;
}

export function saveSettings(settings: AppSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}
