import { useState, useEffect } from 'react';
import type { WorkspaceBinding } from '../types';
export default function WorkspaceEditor({
  value,
  onChange,
}: {
  value?: WorkspaceBinding;
  onChange: (value: WorkspaceBinding) => void;
}) {
  const [draft, setDraft] = useState(
    value ?? { path: '', branch: '', ref: 'HEAD' },
  );
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(value ?? { path: '', branch: '', ref: 'HEAD' });
  }, [value, dirty]);
  return (
    <div className="space-y-2">
      <div className="text-muted text-[10px] uppercase">
        Git workspace on backend host
      </div>
      {(['path', 'branch', 'ref'] as const).map((key) => (
        <label key={key} className="block text-xs">
          {key}
          <input
            className="form-input mt-1"
            value={draft[key]}
            placeholder={
              key === 'path'
                ? '/absolute/existing/worktree'
                : key === 'branch'
                  ? 'Currently checked-out branch'
                  : 'HEAD'
            }
            onChange={(e) => {
              setDirty(true);
              setDraft({ ...draft, [key]: e.target.value });
            }}
          />
        </label>
      ))}
      <button
        type="button"
        className="small-button"
        disabled={
          !draft.path.startsWith('/') ||
          !draft.branch.trim() ||
          !draft.ref.trim()
        }
        onClick={() => {
          onChange(draft);
          setDirty(false);
        }}
      >
        Apply workspace
      </button>
      <p className="text-muted text-[10px]">
        Use an existing Git folder/worktree on the backend host. The checked-out
        branch must match. Ref is resolved at start; this does not switch
        branches.
      </p>
    </div>
  );
}
