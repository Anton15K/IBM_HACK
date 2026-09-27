import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sessionGeneration, sessionRequest, useStore } from '../store';
import { createProject, type ProjectSource } from '../project-creation';
import type { WorkspaceBinding } from '../types';
import WorkspaceEditor, { isAbsoluteLikePath } from './WorkspaceEditor';

interface RootsResponse { roots: string[]; configured: boolean }

export default function NewProjectDialog({ teamId, onClose }: { teamId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const generation = useRef(sessionGeneration()).current;
  const canPrepare = useStore(state => state.auth?.role === 'admin');
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [kind, setKind] = useState<ProjectSource['kind']>('existing');
  const [workspace, setWorkspace] = useState<WorkspaceBinding>({ path: '', branch: '', ref: 'HEAD' });
  const [prepared, setPrepared] = useState<WorkspaceBinding>();
  const preparedRef = useRef<WorkspaceBinding>();
  const [parentPath, setParentPath] = useState('');
  const [folderName, setFolderName] = useState('');
  const [url, setUrl] = useState('');
  const [roots, setRoots] = useState<string[]>([]);
  const [rootsLoading, setRootsLoading] = useState(false);
  const [rootsError, setRootsError] = useState('');
  const [rootsAttempt, setRootsAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    if (!opener.current) opener.current = document.activeElement as HTMLElement | null;
    element?.showModal();
    element?.querySelector<HTMLInputElement>('#new-project-name')?.focus();
    return () => {
      mounted.current = false;
      element?.close();
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, []);

  useEffect(() => {
    if (!canPrepare) return;
    let active = true;
    setRootsLoading(true);
    setRootsError('');
    sessionRequest<RootsResponse>('/workspace/roots').then(result => {
      if (!active || generation !== sessionGeneration()) return;
      setRoots(result.configured ? result.roots : []);
      setParentPath(current => result.roots.includes(current) ? current : result.roots[0] ?? '');
    }).catch(error => {
      if (active && generation === sessionGeneration()) setRootsError((error as Error).message);
    }).finally(() => {
      if (active && generation === sessionGeneration()) setRootsLoading(false);
    });
    return () => { active = false; };
  }, [canPrepare, generation, rootsAttempt]);

  const dismiss = () => { if (!inFlight.current) onClose(); };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    try {
      const source: ProjectSource = kind === 'existing'
        ? { kind, workspace }
        : { kind, parentPath, name: folderName.trim(), ...(kind === 'clone' ? { url: url.trim() } : {}) };
      await createProject({ teamId, name, goal, source }, generation, preparedRef.current, binding => {
        if (mounted.current && generation === sessionGeneration()) {
          preparedRef.current = binding;
          setPrepared(binding);
        }
      });
      if (mounted.current && generation === sessionGeneration()) onClose();
    } catch (error) {
      if (mounted.current && generation === sessionGeneration()) setError((error as Error).message);
    } finally {
      inFlight.current = false;
      if (mounted.current && generation === sessionGeneration()) setSubmitting(false);
    }
  };

  const ready = kind === 'existing'
    ? isAbsoluteLikePath(workspace.path.trim()) && !!workspace.ref.trim()
    : canPrepare && (!!prepared || (!rootsLoading && !!parentPath && !!folderName.trim() && (kind !== 'clone' || !!url.trim())));

  return createPortal(
    <dialog ref={dialog} className="annotation-dialog" aria-labelledby="new-project-title" aria-describedby="new-project-help"
      onCancel={event => { event.preventDefault(); dismiss(); }}>
      <form onSubmit={submit}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-accent text-xs mb-2">TEAM PROJECT</p>
            <h2 id="new-project-title" className="text-xl font-semibold">New project</h2>
          </div>
          <button type="button" className="small-button" aria-label="Close dialog" disabled={submitting} onClick={dismiss}>✕</button>
        </div>
        <p id="new-project-help" className="text-muted text-sm mt-3 mb-5">Choose the Git workspace for this project. Folders are on the backend host.</p>
        <fieldset disabled={submitting} className="space-y-4">
          <label className="block text-sm" htmlFor="new-project-name">Project name
            <input id="new-project-name" required className="form-input mt-1" value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Backend refactor" />
          </label>
          <label className="block text-sm" htmlFor="new-project-goal">Goal
            <textarea id="new-project-goal" className="form-input mt-1" rows={2} value={goal} onChange={event => setGoal(event.target.value)} placeholder="Describe the project goal" />
          </label>
          <fieldset disabled={!!prepared} className="space-y-3">
            <legend className="text-sm mb-2">Workspace source</legend>
            <div className="flex flex-wrap gap-2">
              {([
                ['existing', 'Existing Git folder'],
                ['init', 'New Git repository'],
                ['clone', 'Public HTTPS clone'],
              ] as const).filter(([source]) => source === 'existing' || canPrepare).map(([source, label]) => (
                <label key={source} className={`small-button flex items-center gap-2 ${kind === source ? '!border-accent !text-ink' : ''}`}>
                  <input type="radio" name="workspace-source" value={source} checked={kind === source} onChange={() => setKind(source)} />
                  {label}
                </label>
              ))}
            </div>
            <div hidden={kind !== 'existing'}>
              <WorkspaceEditor value={workspace} onChange={setWorkspace} onDraftChange={setWorkspace} allowPrepare={false} showApply={false} />
            </div>
            {kind !== 'existing' && <div className="space-y-3">
              {rootsLoading && <p role="status" className="text-muted text-sm">Loading allowed folders…</p>}
              {rootsError && <p role="alert" className="text-err text-sm">{rootsError}</p>}
              {!rootsLoading && !roots.length && !rootsError && <p className="text-muted text-sm">No workspace folders are configured. Ask the server administrator to configure an allowed folder.</p>}
              {(rootsError || (!rootsLoading && !roots.length)) && <button type="button" className="small-button" onClick={() => setRootsAttempt(value => value + 1)}>Reload folders</button>}
              <label className="block text-sm" htmlFor="new-project-parent">Create in
                <select id="new-project-parent" className="form-input mt-1" value={parentPath} disabled={rootsLoading || !roots.length} onChange={event => setParentPath(event.target.value)}>
                  {!roots.length && <option value="">No allowed folders available</option>}
                  {roots.map(root => <option key={root} value={root}>{root}</option>)}
                </select>
              </label>
              <label className="block text-sm" htmlFor="new-project-folder">New folder name
                <input id="new-project-folder" className="form-input mt-1" value={folderName} maxLength={80} onChange={event => setFolderName(event.target.value)} placeholder="my-project" />
              </label>
              {kind === 'init' ? <p className="text-muted text-xs">Creates a new folder, a Git repository on main and an empty initial commit by TeamWeave. No remote is connected.</p> : <label className="block text-sm" htmlFor="new-project-url">Public repository HTTPS URL
                <input id="new-project-url" className="form-input mt-1" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/owner/repository" />
                <span className="text-muted text-xs">GitHub, GitLab or Bitbucket. Public repositories only; no keys or passwords.</span>
              </label>}
            </div>}
          </fieldset>
        </fieldset>
        {prepared && <p className="text-muted text-xs mt-4 break-words">Workspace prepared at {prepared.path}. It will be reused on retry and remains on the server if you cancel.</p>}
        {submitting && <p role="status" className="text-muted text-sm mt-4">{kind === 'clone' && !prepared ? 'Cloning and creating project… Cloning may take up to 90 seconds.' : 'Validating workspace and creating project…'}</p>}
        {error && <p role="alert" className="text-err text-sm mt-4">{error}</p>}
        <div className="flex justify-end gap-3 mt-6">
          <button type="button" className="small-button !px-4 !py-2" disabled={submitting} onClick={dismiss}>Cancel</button>
          <button type="submit" className="action-button !px-4 !py-2" disabled={submitting || !name.trim() || !ready}>{submitting ? 'Creating…' : 'Create project'}</button>
        </div>
      </form>
    </dialog>, document.body,
  );
}
