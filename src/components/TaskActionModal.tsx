import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';
import { resolveOutputMode } from '../output-mode';

export default function TaskActionModal({ nodeId, mode, onClose }: {
  nodeId: string; mode: 'template' | 'delete'; onClose: () => void;
}) {
  const node = useStore(state => state.nodes.find(item => item.id === nodeId));
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const inFlight = useRef(false);
  const [name, setName] = useState(node?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const template = mode === 'template';
  useEffect(() => {
    const element = dialog.current;
    if (!opener.current) opener.current = document.activeElement as HTMLElement | null;
    element?.showModal();
    if (template) { const input = element?.querySelector('input'); input?.focus(); input?.select(); }
    else element?.querySelector<HTMLButtonElement>('[data-cancel]')?.focus();
    return () => { element?.close(); if (opener.current?.isConnected) opener.current.focus(); };
  }, [template]);
  const submit = async () => {
    if (inFlight.current || (template && !name.trim())) return;
    const state = useStore.getState();
    const current = state.nodes.find(item => item.id === nodeId);
    if (!current || !state.auth || !state.canEdit(current.teamId)) { setError('This task is no longer available for editing.'); return; }
    inFlight.current = true; setBusy(true); setError('');
    try {
      if (template) {
        const saved = await state.addTemplate({ name: name.trim(), description: current.prompt.task.slice(0, 80), defaults: {
          type: current.type, priority: current.priority, prompt: current.prompt, executor: current.executor, context: current.context,
          desiredOutput: resolveOutputMode(current),
        } });
        if (!saved) throw new Error(useStore.getState().error ?? 'Could not save template. Please try again.');
      } else {
        await state.removeNode(nodeId);
        // The action may have joined a poll started before DELETE. Read a fresh snapshot.
        if (useStore.getState().nodes.some(item => item.id === nodeId) && !useStore.getState().error) await useStore.getState().refresh();
        if (useStore.getState().nodes.some(item => item.id === nodeId)) throw new Error(useStore.getState().error ?? 'Could not delete task. Please try again.');
      }
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.'); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} className="annotation-dialog" aria-labelledby="task-action-title" aria-describedby="task-action-help"
    onCancel={event => { event.preventDefault(); if (!inFlight.current) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="flex items-start justify-between gap-4">
        <div><p className="text-accent text-xs mb-2">{template ? 'TEMPLATE LIBRARY' : 'DELETE TASK'}</p>
          <h2 id="task-action-title" className="text-xl font-semibold">{template ? 'Save as template' : 'Delete this task?'}</h2></div>
        <button type="button" className="small-button" aria-label="Close dialog" disabled={busy} onClick={onClose}>✕</button>
      </div>
      <p id="task-action-help" className="text-muted text-sm mt-3 mb-5 whitespace-pre-wrap break-words">
        {template ? 'Reuse this task’s instructions and settings when creating new tasks. Results and attempt history are not included.' : `“${node?.name ?? 'Task'}” and its saved attempt history will be permanently removed. This cannot be undone.`}
      </p>
      {template && <label className="block text-sm">Template name
        <input className="form-input mt-2 !text-sm !py-3" value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder="e.g. Code review" />
      </label>}
      {error && <p role="alert" className="text-err text-sm mt-3">{error}</p>}
      <div className="flex justify-end gap-3 mt-6">
        <button data-cancel type="button" className="small-button !px-4 !py-2" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className={template ? 'action-button !px-4 !py-2' : 'small-button !text-red-300 !border-red-400/40 !bg-red-500/10 !px-4 !py-2'} disabled={busy || (template && !name.trim())}>
          {busy ? (template ? 'Saving…' : 'Deleting…') : template ? 'Save template' : 'Delete task'}
        </button>
      </div>
    </form>
  </dialog>, document.body);
}
