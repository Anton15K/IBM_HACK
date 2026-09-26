import { useState, useEffect } from 'react';
import { useStore } from '../store';
import { getStoredKeys, setStoredKeys } from '../executors/keys';
import type { StoredKeys } from '../executors/keys';

type TestState = 'idle' | 'testing' | 'ok' | 'fail';

function MaskedInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="text-muted text-[10px] block mb-0.5">{label}</label>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? 'Paste key here…'}
        autoComplete="off"
        className="w-full bg-card border border-line rounded-lg px-2.5 py-1.5 text-ink text-xs outline-none focus:border-accent placeholder-muted/50"
      />
    </div>
  );
}

async function testOpenAI(key: string): Promise<boolean> {
  try {
    const r = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function testAnthropic(key: string): Promise<boolean> {
  try {
    const r = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function testGoogle(key: string): Promise<boolean> {
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`
    );
    return r.ok;
  } catch {
    return false;
  }
}

async function testBob(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

export default function SettingsModal() {
  const toggleSettings = useStore((s) => s.toggleSettings);
  const resetToSeed = useStore((s) => s.resetToSeed);

  const [keys, setKeys] = useState<StoredKeys>(() => getStoredKeys());
  const [testStates, setTestStates] = useState<Record<string, TestState>>({
    openai: 'idle',
    anthropic: 'idle',
    google: 'idle',
    bob: 'idle',
  });

  useEffect(() => {
    setKeys(getStoredKeys());
  }, []);

  const updateKey = (field: keyof StoredKeys, value: string) => {
    setKeys((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = () => {
    setStoredKeys(keys);
    toggleSettings();
  };

  const setTestState = (provider: string, state: TestState) =>
    setTestStates((prev) => ({ ...prev, [provider]: state }));

  const handleTest = async (provider: string) => {
    setTestState(provider, 'testing');
    let ok = false;
    try {
      switch (provider) {
        case 'openai':
          ok = await testOpenAI(keys.openai);
          break;
        case 'anthropic':
          ok = await testAnthropic(keys.anthropic);
          break;
        case 'google':
          ok = await testGoogle(keys.google);
          break;
        case 'bob':
          ok = await testBob(keys.bobGatewayUrl || 'http://localhost:7142');
          break;
      }
    } catch {
      ok = false;
    }
    setTestState(provider, ok ? 'ok' : 'fail');
  };

  const testBadge = (state: TestState) => {
    switch (state) {
      case 'testing':
        return <span className="text-[10px] text-muted animate-pulse">Testing…</span>;
      case 'ok':
        return <span className="text-[10px] text-ok">✓ Connected</span>;
      case 'fail':
        return <span className="text-[10px] text-err">✗ Failed</span>;
      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={toggleSettings}
      />
      <div className="relative bg-panel border border-line rounded-[20px] w-[480px] max-h-[90vh] overflow-y-auto shadow-panel z-10">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line sticky top-0 bg-panel z-10">
          <span className="text-ink font-semibold">Settings</span>
          <button onClick={toggleSettings} className="text-muted hover:text-ink transition-colors">
            ×
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* API Keys */}
          <div>
            <div className="text-muted text-[10px] font-semibold uppercase tracking-widest mb-3">
              API Keys
            </div>
            <p className="text-muted text-[11px] mb-3">
              🔒 Keys stay in your browser (localStorage). They are never included in exported project JSON.
            </p>

            {/* OpenAI */}
            <div className="bg-card border border-line rounded-lg p-3 mb-2 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-ink text-xs font-medium">OpenAI</span>
                <div className="flex items-center gap-2">
                  {testBadge(testStates.openai)}
                  <button
                    onClick={() => handleTest('openai')}
                    disabled={!keys.openai || testStates.openai === 'testing'}
                    className="text-[10px] px-2 py-0.5 rounded-md bg-line hover:bg-line/80 text-ink disabled:opacity-40 transition-colors"
                  >
                    Test
                  </button>
                </div>
              </div>
              <MaskedInput
                label="OpenAI API Key"
                value={keys.openai}
                onChange={(v) => updateKey('openai', v)}
                placeholder="sk-…"
              />
              <div className="text-muted text-[10px]">Default model: gpt-4o-mini</div>
            </div>

            {/* Anthropic */}
            <div className="bg-card border border-line rounded-lg p-3 mb-2 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-ink text-xs font-medium">Anthropic (Claude)</span>
                <div className="flex items-center gap-2">
                  {testBadge(testStates.anthropic)}
                  <button
                    onClick={() => handleTest('anthropic')}
                    disabled={!keys.anthropic || testStates.anthropic === 'testing'}
                    className="text-[10px] px-2 py-0.5 rounded-md bg-line hover:bg-line/80 text-ink disabled:opacity-40 transition-colors"
                  >
                    Test
                  </button>
                </div>
              </div>
              <MaskedInput
                label="Anthropic API Key"
                value={keys.anthropic}
                onChange={(v) => updateKey('anthropic', v)}
                placeholder="sk-ant-…"
              />
              <div className="text-muted text-[10px]">Default model: claude-sonnet-4-5</div>
            </div>

            {/* Google */}
            <div className="bg-card border border-line rounded-lg p-3 mb-2 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-ink text-xs font-medium">Google (Gemini)</span>
                <div className="flex items-center gap-2">
                  {testBadge(testStates.google)}
                  <button
                    onClick={() => handleTest('google')}
                    disabled={!keys.google || testStates.google === 'testing'}
                    className="text-[10px] px-2 py-0.5 rounded-md bg-line hover:bg-line/80 text-ink disabled:opacity-40 transition-colors"
                  >
                    Test
                  </button>
                </div>
              </div>
              <MaskedInput
                label="Google AI API Key"
                value={keys.google}
                onChange={(v) => updateKey('google', v)}
                placeholder="AIza…"
              />
              <div className="text-muted text-[10px]">Default model: gemini-2.0-flash</div>
            </div>

            {/* Bob Gateway */}
            <div className="bg-card border border-line rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-ink text-xs font-medium">Bob Gateway (local)</span>
                <div className="flex items-center gap-2">
                  {testBadge(testStates.bob)}
                  <button
                    onClick={() => handleTest('bob')}
                    disabled={testStates.bob === 'testing'}
                    className="text-[10px] px-2 py-0.5 rounded-md bg-line hover:bg-line/80 text-ink disabled:opacity-40 transition-colors"
                  >
                    Test
                  </button>
                </div>
              </div>
              <div>
                <label className="text-muted text-[10px] block mb-0.5">Gateway URL</label>
                <input
                  type="text"
                  value={keys.bobGatewayUrl}
                  onChange={(e) => updateKey('bobGatewayUrl', e.target.value)}
                  placeholder="http://localhost:7142"
                  className="w-full bg-[#0D1117] border border-line rounded-lg px-2.5 py-1.5 text-ink text-xs outline-none focus:border-accent"
                />
              </div>
              <div className="text-muted text-[10px]">Run bob-gateway/ locally (next milestone)</div>
            </div>
          </div>

          {/* About */}
          <div>
            <div className="text-muted text-[10px] font-semibold uppercase tracking-widest mb-2">About</div>
            <div className="bg-card border border-line rounded-lg p-3 space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted">Version</span>
                <span className="text-ink">0.2.0 M2</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted">Stack</span>
                <span className="text-ink">React 18 · React Flow · Zustand</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted">LLM executors</span>
                <span className="text-ok">OpenAI · Anthropic · Google · Bob</span>
              </div>
            </div>
          </div>

          {/* Data */}
          <div>
            <div className="text-muted text-[10px] font-semibold uppercase tracking-widest mb-2">Data</div>
            <div className="bg-card border border-line rounded-lg p-3 space-y-2">
              <p className="text-muted text-xs">
                Project data is auto-saved to localStorage. Use Export JSON to back up, Import JSON to restore.
              </p>
              <button
                onClick={() => {
                  if (confirm('This will reset all data to the seed project. Continue?')) {
                    resetToSeed();
                    toggleSettings();
                  }
                }}
                className="w-full py-1.5 rounded-lg text-xs font-medium bg-err/20 hover:bg-err/30 text-err transition-colors border border-err/20"
              >
                Reset to Seed Data
              </button>
            </div>
          </div>

          {/* Status colors reference */}
          <div>
            <div className="text-muted text-[10px] font-semibold uppercase tracking-widest mb-2">Status Colors</div>
            <div className="bg-card border border-line rounded-lg p-3 grid grid-cols-2 gap-1.5">
              {[
                ['draft', '#4B5563'],
                ['ready', '#5B8CFF'],
                ['queued', '#8B94A7'],
                ['running', '#60A5FA'],
                ['blocked', '#5B7A99'],
                ['done', '#34D399'],
                ['failed', '#F87171'],
                ['rework', '#FBBF24'],
                ['needs_approval', '#FBBF24'],
              ].map(([label, color]) => (
                <div key={label} className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                  <span className="text-muted text-[10px] capitalize">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-line flex gap-2 sticky bottom-0 bg-panel">
          <button
            onClick={handleSave}
            className="flex-1 py-2 rounded-lg text-sm font-medium bg-accent hover:bg-blue-500 text-white transition-colors"
          >
            Save & Close
          </button>
          <button
            onClick={toggleSettings}
            className="py-2 px-4 rounded-lg text-sm font-medium bg-card hover:bg-line text-muted hover:text-ink transition-colors border border-line"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
