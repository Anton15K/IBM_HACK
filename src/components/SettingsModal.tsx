import { useEffect, useRef, useState } from 'react';
import { useStore, sessionRequest, sessionGeneration, requireSession } from '../store';
import Modal from './Modal';

interface ModelDescriptor {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'openrouter/free';

export default function SettingsModal() {
  const { capabilities: c, toggleSettings, auth } = useStore();
  const isAdmin = auth?.role === 'admin';

  const [connections, setConnections] = useState<ModelDescriptor[]>([]);
  const [loadingConns, setLoadingConns] = useState(false);
  const [connError, setConnError] = useState('');

  // Create form state (in-memory only, never stored)
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const gen = sessionGeneration();
    setLoadingConns(true);
    setConnError('');
    sessionRequest<{ connections: ModelDescriptor[] }>('/model-connections')
      .then((data) => {
        try { requireSession(gen); } catch { return; }
        if (mountedRef.current) setConnections(data.connections);
      })
      .catch((err: Error) => {
        try { requireSession(gen); } catch { return; }
        if (mountedRef.current) setConnError(err.message);
      })
      .finally(() => {
        if (mountedRef.current) setLoadingConns(false);
      });
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const gen = sessionGeneration();
    setSaving(true);
    setSaveError('');
    try {
      const created = await sessionRequest<ModelDescriptor>(
        '/model-connections',
        'POST',
        { label: label.trim(), baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim() },
      );
      requireSession(gen);
      if (mountedRef.current) {
        setConnections((prev) => [...prev, created]);
        setCreating(false);
        setLabel('');
        setBaseUrl(DEFAULT_BASE_URL);
        setModel(DEFAULT_MODEL);
        setApiKey(''); // clear key immediately on success
      }
    } catch (err: unknown) {
      try { requireSession(gen); } catch { return; }
      if (mountedRef.current) setSaveError((err as Error).message);
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const handleClose = () => {
    if (saving) return;
    setApiKey(''); // clear key on close regardless
    toggleSettings();
  };

  return (
    <Modal labelledBy="settings-title" describedBy="settings-help" busy={saving} onClose={handleClose}>
      <div className="flex items-center justify-between gap-4">
        <h2 id="settings-title" className="text-xl font-semibold">Model settings</h2>
        <button className="small-button" aria-label="Close model settings" disabled={saving} onClick={handleClose}>×</button>
      </div>
      <section className="space-y-3" aria-labelledby="connections-title">
        <h3 id="connections-title" className="font-semibold text-sm">API model connections</h3>
        <p id="settings-help" className="text-muted text-xs">
          Choose the models available to tasks and the project planner. API usage is
          billed by the external provider, separately from Bobcoins.
        </p>
        {loadingConns && <p className="text-muted text-xs" role="status">Loading connections…</p>}
        {connError && <p className="text-err text-xs" role="alert">{connError}</p>}
        {connections.map((conn) => (
          <div key={conn.id} className="bg-card border border-line rounded-lg p-3 text-xs space-y-1">
            <p className="font-medium">{conn.label}</p>
            <p className="text-muted break-words">{conn.model} · {conn.baseUrl}</p>
          </div>
        ))}
        {!loadingConns && connections.length === 0 && !connError && (
          <p className="text-muted text-xs">No API model connections yet.</p>
        )}
        {isAdmin && (
          <>
            {!creating ? (
              <button className="small-button" onClick={() => setCreating(true)}>
                + Add API model connection
              </button>
            ) : (
              <form className="space-y-3 text-xs" onSubmit={(e) => void handleCreate(e)}>
                <label className="block" htmlFor="connection-label">Connection name</label>
                <input id="connection-label" className="form-input" required disabled={saving}
                  placeholder="e.g. OpenRouter free models" value={label} onChange={(e) => setLabel(e.target.value)} />
                <label className="block" htmlFor="connection-base-url">API base URL</label>
                <input id="connection-base-url" className="form-input" required disabled={saving}
                  value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                <label className="block" htmlFor="connection-model">Model ID</label>
                <input id="connection-model" className="form-input" required disabled={saving}
                  value={model} onChange={(e) => setModel(e.target.value)} aria-describedby="connection-model-help" />
                <p id="connection-model-help" className="text-muted">
                  The default openrouter/free routes to free models on OpenRouter. Other model IDs may incur provider charges.
                </p>
                <label className="block" htmlFor="connection-api-key">API key</label>
                <input id="connection-api-key" className="form-input" required disabled={saving} type="password"
                  placeholder="Provider API key" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                  aria-describedby="connection-key-help" />
                <p id="connection-key-help" className="text-muted">Encrypted on the server; never stored in your browser.</p>
                {saveError && <p className="text-err" role="alert">{saveError}</p>}
                <div className="flex gap-2">
                  <button className="action-button" disabled={saving}>{saving ? 'Saving…' : 'Save connection'}</button>
                  <button type="button" className="small-button" disabled={saving}
                    onClick={() => { setCreating(false); setApiKey(''); setSaveError(''); }}>Cancel</button>
                </div>
              </form>
            )}
          </>
        )}
        {!isAdmin && (
          <p className="text-muted text-xs">Members can view connections. Contact an org admin to add profiles.</p>
        )}
      </section>
      <details className="border-t border-line pt-4 text-xs">
        <summary className="cursor-pointer font-medium">Backend diagnostics</summary>
        <div className="space-y-2 pt-3">
          {c ? (
            <>
              <p>Bob Shell: <span className={c.bobConfigured ? 'text-ok' : 'text-warn'}>{c.bobConfigured ? 'Configured' : 'Not configured'}</span></p>
              <p>Providers: {c.providers.join(', ')}</p>
              <p>Output modes: {c.outputModes.join(', ')}</p>
              <p>Workspace roots: {c.workspaceRootsConfigured ? 'Configured' : 'Not configured'}</p>
              <p>Bobcoin budget: default {c.maxCost.default}, maximum {c.maxCost.max}</p>
              <p className="text-muted">
                Bob uses the Shell model configuration. Set Bob credentials and
                TEAMWEAVE_WORKSPACE_ROOTS on the backend host. Select Mock
                explicitly for a no-spend demonstration.
              </p>
            </>
          ) : <p className="text-err">Capabilities unavailable. Reload or sign in again.</p>}
        </div>
      </details>
    </Modal>
  );
}
