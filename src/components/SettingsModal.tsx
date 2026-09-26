import { useEffect, useRef, useState } from 'react';
import { useStore, sessionRequest, sessionGeneration, requireSession } from '../store';

interface ModelDescriptor {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
}

const DEFAULT_BASE_URL = 'https://api.z.ai/api/paas/v4';
const DEFAULT_MODEL = 'glm-4.7-flash';

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
    setApiKey(''); // clear key on close regardless
    toggleSettings();
  };

  return (
    <div className="modal-shade" onClick={handleClose}>
      <div className="modal-panel space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between">
          <h2 className="font-semibold">Backend configuration</h2>
          <button onClick={handleClose}>×</button>
        </div>
        {c ? (
          <>
            <p>
              Bob Shell:{' '}
              <span className={c.bobConfigured ? 'text-ok' : 'text-warn'}>
                {c.bobConfigured ? 'Configured' : 'Not configured'}
              </span>
            </p>
            <p>Providers: {c.providers.join(', ')}</p>
            <p>Output modes: {c.outputModes.join(', ')}</p>
            <p>
              Workspace roots:{' '}
              {c.workspaceRootsConfigured ? 'Configured' : 'Not configured'}
            </p>
            <p>
              Bobcoin budget: default {c.maxCost.default}, maximum {c.maxCost.max}
            </p>
            <p className="text-muted text-xs">
              Bob uses the Shell model configuration. Set Bob credentials and
              TEAMWEAVE_WORKSPACE_ROOTS on the backend host. Select Mock
              explicitly for a no-spend demonstration.
            </p>
          </>
        ) : (
          <p className="text-err">
            Capabilities unavailable. Reload or sign in again.
          </p>
        )}

        <hr className="border-line" />
        <h3 className="font-semibold text-sm">API model connections</h3>
        <p className="text-muted text-xs">
          Each profile represents a different model. API tokens are separate
          from Bobcoins and are charged by the external provider.
        </p>
        {loadingConns && <p className="text-muted text-xs">Loading…</p>}
        {connError && <p className="text-err text-xs">{connError}</p>}
        {connections.map((conn) => (
          <div key={conn.id} className="bg-card border border-line rounded-lg p-2 text-xs space-y-1">
            <p className="font-medium">{conn.label}</p>
            <p className="text-muted">{conn.model} · {conn.baseUrl}</p>
          </div>
        ))}
        {!loadingConns && connections.length === 0 && !connError && (
          <p className="text-muted text-xs">No API model connections yet.</p>
        )}
        {isAdmin && (
          <>
            {!creating ? (
              <button className="text-accent text-xs" onClick={() => setCreating(true)}>
                + Add API model connection
              </button>
            ) : (
              <form className="space-y-2 text-xs" onSubmit={(e) => void handleCreate(e)}>
                <input
                  className="form-input"
                  required
                  placeholder="Label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
                <input
                  className="form-input"
                  required
                  placeholder={`Base URL (default: ${DEFAULT_BASE_URL})`}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
                <input
                  className="form-input"
                  required
                  placeholder={`Model (default: ${DEFAULT_MODEL})`}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
                <input
                  className="form-input"
                  required
                  type="password"
                  placeholder="API key (not stored in browser)"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                {saveError && <p className="text-err">{saveError}</p>}
                <div className="flex gap-2">
                  <button className="action-button" disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    className="small-button"
                    onClick={() => { setCreating(false); setApiKey(''); setSaveError(''); }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </>
        )}
        {!isAdmin && (
          <p className="text-muted text-xs">Members can view connections. Contact an org admin to add profiles.</p>
        )}
      </div>
    </div>
  );
}
