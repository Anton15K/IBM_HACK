import { useState, useEffect, useRef } from 'react';
import type { WorkspaceBinding } from '../types';
import { sessionGeneration, sessionRequest, useStore } from '../store';

// ---------------------------------------------------------------------------
// Types for the API responses
// ---------------------------------------------------------------------------

interface RootsResponse {
  roots: string[];
  configured: boolean;
  hint?: string;
}

interface BrowseEntry {
  name: string;
  path: string;
  gitWorktree: boolean;
}

interface BrowseCurrentEntry {
  path: string;
  gitWorktree: boolean;
}

interface BrowseResponse {
  parentPath: string | null;
  entries: BrowseEntry[];
  /** The currently-browsed directory itself (path mode) */
  current?: BrowseCurrentEntry | null;
  /** Selectable root-level entries (root mode) */
  rootEntries?: BrowseCurrentEntry[];
}

interface ValidateOk {
  ok: true;
  path: string;
  branch: string;
  commit: string;
  dirty: boolean;
}

interface ValidateFail {
  ok: false;
  code: string;
  message: string;
  checkedOutBranch?: string;
}

type ValidateResponse = ValidateOk | ValidateFail;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Build a breadcrumb label from a confined path relative to a root list.
 * Returns the path itself if no root matches.
 */
export function buildBreadcrumb(path: string, roots: string[]): string {
  for (const root of roots) {
    if (path === root) return '/';
    if (path.startsWith(root + '/')) return path.slice(root.length);
  }
  return path;
}

/**
 * Given a current browse path and the list of resolved roots, decide whether
 * the "Up" button should be enabled (false = we are at the merged root level).
 */
export function canGoUp(currentPath: string | null, roots: string[]): boolean {
  if (currentPath === null) return false;
  return !roots.includes(currentPath);
}

/**
 * Normalize a raw path string from an input — trim whitespace only.
 */
export function normalizeEntryName(raw: string): string {
  return raw.trim();
}

/**
 * Platform-neutral absolute path check.
 * Accepts:
 *   - POSIX absolute: starts with /
 *   - Windows backslash: starts with \
 *   - Windows drive letter: X:\ or X:/
 *   - UNC: \\server\share
 */
export function isAbsoluteLikePath(p: string): boolean {
  if (!p) return false;
  // POSIX or backslash root
  if (p[0] === '/' || p[0] === '\\') return true;
  // Drive letter: e.g. C:\ or C:/
  if (/^[A-Za-z]:[/\\]/.test(p)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// WorkspaceEditor component
// ---------------------------------------------------------------------------

export default function WorkspaceEditor({
  value,
  onChange,
  onPendingChange,
  onDraftChange,
  allowPrepare = true,
  showApply = true,
}: {
  value?: WorkspaceBinding;
  onChange: (value: WorkspaceBinding) => void;
  onPendingChange?: () => void;
  onDraftChange?: (value: WorkspaceBinding) => void;
  allowPrepare?: boolean;
  showApply?: boolean;
}) {
  const [draft, setDraft] = useState<WorkspaceBinding>(
    value ?? { path: '', branch: '', ref: 'HEAD' },
  );
  const [dirty, setDirty] = useState(false);
  const draftRevision = useRef(0);
  const validationPending = useRef(false);
  const mounted = useRef(false);
  const generation = useRef(sessionGeneration());
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const isCurrent = () => mounted.current && generation.current === sessionGeneration();

  function changeDraft(next: WorkspaceBinding) {
    draftRevision.current += 1;
    setDraft(next);
    setDirty(true);
    onPendingChange?.();
    onDraftChange?.(next);
    setValidateResult(null);
  }

  // Browse popover state
  const [browseOpen, setBrowseOpen] = useState(false);
  const [roots, setRoots] = useState<string[]>([]);
  const [rootsConfigured, setRootsConfigured] = useState<boolean | null>(null);
  const [rootsHint, setRootsHint] = useState<string | null>(null);
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [browseEntries, setBrowseEntries] = useState<BrowseEntry[]>([]);
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const [browseCurrent, setBrowseCurrent] = useState<BrowseCurrentEntry | null>(null);
  const [browseRootEntries, setBrowseRootEntries] = useState<BrowseCurrentEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  const isAdmin = useStore((state) => state.auth?.role === 'admin');
  const canPrepare = allowPrepare && isAdmin;
  const [createKind, setCreateKind] = useState<'folder' | 'clone' | 'init' | null>(null);
  const [createName, setCreateName] = useState('');
  const [cloneUrl, setCloneUrl] = useState('');
  const [createParent, setCreateParent] = useState('');
  const [preparing, setPreparing] = useState(false);

  async function prepareWorkspace() {
    if (preparing || !createKind) return;
    setPreparing(true);
    setBrowseError(null);
    try {
      const result = await sessionRequest<WorkspaceBinding>('/workspace/create', 'POST', {
        parentPath: createParent, name: createName.trim(), kind: createKind,
        ...(createKind === 'clone' ? { url: cloneUrl.trim() } : {}),
      });
      if (!isCurrent()) return;
      setCreateKind(null);
      setCreateName('');
      if (createKind !== 'folder') {
        changeDraft(result);
        setBrowseOpen(false);
      } else {
        await loadBrowse(result.path);
      }
    } catch (error) {
      if (isCurrent()) setBrowseError((error as Error).message);
    } finally {
      if (isCurrent()) setPreparing(false);
    }
  }

  // Validate state
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState<ValidateResponse | null>(null);

  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dirty) {
      draftRevision.current += 1;
      setDraft(value ?? { path: '', branch: '', ref: 'HEAD' });
    }
  }, [value, dirty]);

  // Close popover on outside click
  useEffect(() => {
    if (!browseOpen) return;
    function handle(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setBrowseOpen(false);
      }
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [browseOpen]);

  async function loadRoots() {
    try {
      const res = await sessionRequest<RootsResponse>('/workspace/roots');
      if (!isCurrent()) return null;
      setRoots(res.roots);
      setRootsConfigured(res.configured);
      setRootsHint(res.hint ?? null);
      return res;
    } catch (error) {
      if (!isCurrent()) return null;
      setBrowseError((error as Error).message || 'Could not load workspace folders.');
      setRootsConfigured(false);
      setRootsHint(null);
      return null;
    }
  }

  async function loadBrowse(path: string | null) {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const url = path ? `/workspace/browse?path=${encodeURIComponent(path)}` : '/workspace/browse';
      const res = await sessionRequest<BrowseResponse>(url);
      if (!isCurrent()) return;
      setBrowsePath(path);
      setBrowseEntries(res.entries);
      setBrowseParent(res.parentPath);
      setBrowseCurrent(res.current ?? null);
      setBrowseRootEntries(res.rootEntries ?? []);
    } catch (err: unknown) {
      if (isCurrent()) setBrowseError((err as Error).message ?? 'Browse failed');
    } finally {
      if (isCurrent()) setBrowseLoading(false);
    }
  }

  async function openBrowse() {
    setBrowseOpen(true);
    setCreateKind(null);
    setBrowseError(null);
    setBrowseEntries([]);
    setBrowsePath(null);
    setBrowseParent(null);
    setBrowseCurrent(null);
    setBrowseRootEntries([]);
    const res = await loadRoots();
    if (res?.configured) {
      await loadBrowse(null);
    }
  }

  function handleEntryClick(entry: BrowseEntry) {
    if (entry.gitWorktree) {
      changeDraft({ ...draft, path: entry.path });
      setBrowseOpen(false);
    } else {
      void loadBrowse(entry.path);
    }
  }

  function handleCurrentClick(entry: BrowseCurrentEntry) {
    changeDraft({ ...draft, path: entry.path });
    setBrowseOpen(false);
  }

  async function handleApply() {
    if (validationPending.current) return;
    validationPending.current = true;
    const revision = draftRevision.current;
    const isSameDraft = () => isCurrent() && revision === draftRevision.current;
    setValidating(true);
    setValidateResult(null);
    try {
      const body: Record<string, string> = { path: draft.path };
      if (draft.branch.trim()) body.branch = draft.branch.trim();
      if (draft.ref.trim()) body.ref = draft.ref.trim();
      const res = await sessionRequest<ValidateResponse>('/workspace/validate', 'POST', body);
      if (!isSameDraft()) return;
      setValidateResult(res);
      if (res.ok) {
        const finalBinding: WorkspaceBinding = {
          path: res.path,
          branch: res.branch,
          ref: draft.ref.trim() || 'HEAD',
        };
        // Pre-fill branch if the user hadn't typed one
        if (!draft.branch.trim()) {
          setDraft((d) => ({ ...d, branch: res.branch }));
        }
        onChange(finalBinding);
        setDirty(false);
      }
    } catch (err: unknown) {
      if (isSameDraft()) setValidateResult({ ok: false, code: 'NETWORK_ERROR', message: (err as Error).message });
    } finally {
      validationPending.current = false;
      if (isCurrent()) setValidating(false);
    }
  }

  const applyDisabled =
    !isAbsoluteLikePath(draft.path) ||
    !draft.ref.trim() ||
    validating;

  return (
    <div className="space-y-2">
      <div className="text-muted text-[10px] uppercase">
        Git workspace on backend host
      </div>

      {/* Path input + Browse button */}
      <label className="block text-xs">
        path
        <div className="flex gap-1 mt-1">
          <input
            className="form-input flex-1"
            value={draft.path}
            placeholder="/absolute/existing/worktree"
            onChange={(e) => {
              changeDraft({ ...draft, path: e.target.value });
            }}
          />
          <button
            type="button"
            className="small-button shrink-0"
            onClick={openBrowse}
          >
            Browse…
          </button>
        </div>
      </label>

      {/* Browse popover */}
      {browseOpen && (
        <div
          ref={popoverRef}
          className="border border-line bg-panel rounded p-2 text-xs space-y-1 max-h-64 overflow-y-auto"
          role="dialog"
          aria-label="Browse workspace directories"
        >
          {/* Breadcrumb + Up */}
          <div className="flex items-center gap-1 text-muted text-[10px] mb-1">
            <button
              type="button"
              className="small-button"
              disabled={!canGoUp(browsePath, roots)}
              onClick={() => { void loadBrowse(browseParent); }}
            >
              ↑ Up
            </button>
            <span className="truncate">
              {browsePath ? buildBreadcrumb(browsePath, roots) : '/'}
            </span>
          </div>

          {browseLoading && <p className="text-muted">Loading…</p>}
          {browseError && <p className="text-err">{browseError}</p>}

          {rootsConfigured === false && rootsHint && (
            <div className="space-y-1">
              <p className="text-muted">No workspace roots configured.</p>
              <code className="block text-[9px] break-all bg-surface rounded p-1">{rootsHint}</code>
            </div>
          )}

          {!browseLoading && !browseError && browseEntries.length === 0 && rootsConfigured && browseCurrent === null && browseRootEntries.length === 0 && (
            <p className="text-muted">No subdirectories found.</p>
          )}

          {canPrepare && rootsConfigured && (
            <fieldset disabled={preparing || browseLoading} className="space-y-2 border-b border-line pb-2">
              <div className="flex flex-wrap gap-1">
                <button type="button" className="small-button" onClick={() => {
                  setCreateKind('folder'); setCreateParent(browsePath ?? roots[0] ?? ''); setBrowseError(null);
                }}>New folder</button>
                <button type="button" className="small-button" onClick={() => {
                  setCreateKind('init'); setCreateParent(browsePath ?? roots[0] ?? ''); setBrowseError(null);
                }}>New Git repository</button>
                <button type="button" className="small-button" onClick={() => {
                  setCreateKind('clone'); setCreateParent(browsePath ?? roots[0] ?? ''); setBrowseError(null);
                }}>Clone repository</button>
              </div>
              {createKind && <div className="space-y-2">
                <label className="block">Create in
                  <select className="form-input" value={createParent} onChange={(e) => setCreateParent(e.target.value)}>
                    {[...new Set([...roots, ...(browsePath ? [browsePath] : [])])].map((path) => <option key={path} value={path}>{path}</option>)}
                  </select>
                </label>
                <label className="block">Folder name
                  <input className="form-input" value={createName} maxLength={80} onChange={(e) => setCreateName(e.target.value)} placeholder="my-project" />
                </label>
                {createKind === 'init' && <p className="text-muted text-[10px]">Creates a new folder with a Git repository on main and an empty initial commit by TeamWeave. No remote is connected.</p>}
                {createKind === 'clone' && <label className="block">Public repository HTTPS URL
                  <input className="form-input" value={cloneUrl} onChange={(e) => setCloneUrl(e.target.value)} placeholder="https://github.com/owner/repository" />
                  <span className="text-muted text-[10px]">GitHub, GitLab or Bitbucket. Public repositories only; no keys or passwords.</span>
                </label>}
                <button type="button" className="small-button" disabled={!createName.trim() || !createParent || (createKind === 'clone' && !cloneUrl.trim())} onClick={() => void prepareWorkspace()}>
                  {preparing ? 'Preparing…' : createKind === 'clone' ? 'Clone into new folder' : createKind === 'init' ? 'Create Git repository' : 'Create folder'}
                </button>
                <button type="button" className="small-button ml-1" onClick={() => setCreateKind(null)}>Cancel</button>
              </div>}
              {preparing && <p role="status">Preparing workspace… Cloning may take up to 90 seconds.</p>}
            </fieldset>
          )}

          {/* F2b: root mode — each root selectable */}
          {browseRootEntries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="w-full text-left small-button flex items-center gap-1 font-medium"
              onClick={() => entry.gitWorktree ? handleCurrentClick(entry) : void loadBrowse(entry.path)}
              title={entry.path}
            >
              <span>🏠</span>
              <span className="flex-1 truncate">{entry.path}</span>
              {entry.gitWorktree && (
                <span className="text-accent text-[9px]">git</span>
              )}
            </button>
          ))}

          {/* F2b: path mode — current directory selectable */}
          {browseCurrent && (
            <button
              type="button"
              className="w-full text-left small-button flex items-center gap-1 italic"
              onClick={() => handleCurrentClick(browseCurrent)}
              title={browseCurrent.path}
            >
              <span>·</span>
              <span className="flex-1">(this directory)</span>
              {browseCurrent.gitWorktree && (
                <span className="text-accent text-[9px]">git</span>
              )}
            </button>
          )}

          {browseEntries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="w-full text-left small-button flex items-center gap-1"
              onClick={() => handleEntryClick(entry)}
            >
              <span>📁</span>
              <span className="flex-1">{entry.name}</span>
              {entry.gitWorktree && (
                <span className="text-accent text-[9px]">git</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Branch and ref inputs */}
      {(['branch', 'ref'] as const).map((key) => (
        <label key={key} className="block text-xs">
          {key}
          <input
            className="form-input mt-1"
            value={draft[key]}
            placeholder={
              key === 'branch'
                ? 'Currently checked-out branch'
                : 'HEAD'
            }
            onChange={(e) => {
              changeDraft({ ...draft, [key]: e.target.value });
            }}
          />
        </label>
      ))}

      {/* Apply button */}
      {showApply && <button
        type="button"
        className="small-button"
        disabled={applyDisabled}
        onClick={handleApply}
      >
        {validating ? 'Validating…' : 'Apply workspace'}
      </button>}

      {/* Validation result */}
      {validateResult && validateResult.ok && (
        <p className="text-[10px] text-accent">
          ✓ {validateResult.branch}@{validateResult.commit.slice(0, 7)}
          {validateResult.dirty ? ' (dirty)' : ''}
        </p>
      )}
      {validateResult && !validateResult.ok && (
        <p className="text-[10px] text-err">{validateResult.message}</p>
      )}

      <p className="text-muted text-[10px]">
        Browse server folders to select a Git workspace.
        {canPrepare && ' Admins can create folders, initialize Git repositories and clone public repositories.'}
        {' '}The checked-out branch must match. Ref is resolved at start; this does not switch
        branches.
      </p>
    </div>
  );
}
