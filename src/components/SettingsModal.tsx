import { useStore } from '../store';
export default function SettingsModal() {
  const { capabilities: c, toggleSettings } = useStore();
  return (
    <div className="modal-shade" onClick={toggleSettings}>
      <div
        className="modal-panel space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between">
          <h2 className="font-semibold">Backend configuration</h2>
          <button onClick={toggleSettings}>×</button>
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
              Budget: default {c.maxCost.default}, maximum {c.maxCost.max}{' '}
              Bobcoins
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
      </div>
    </div>
  );
}
