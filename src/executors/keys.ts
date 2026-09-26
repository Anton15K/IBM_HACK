const STORAGE_KEY = 'teamweave-keys';

export interface StoredKeys {
  openai: string;
  anthropic: string;
  google: string;
  bobGatewayUrl: string;
}

export function getStoredKeys(): StoredKeys {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultKeys();
    return { ...defaultKeys(), ...JSON.parse(raw) };
  } catch {
    return defaultKeys();
  }
}

export function setStoredKeys(keys: StoredKeys): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
}

function defaultKeys(): StoredKeys {
  return { openai: '', anthropic: '', google: '', bobGatewayUrl: 'http://localhost:7142' };
}
