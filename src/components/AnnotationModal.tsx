import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { flushEdits, useStore } from '../store';

export default function AnnotationModal({ nodeId, field, onClose }: {
  nodeId: string;
  field: 'refinements' | 'comments';
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const staged = useRef(false);
  const timestamp = useRef(new Date().toISOString());
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const refinement = field === 'refinements';
  useEffect(() => {
    const element = dialog.current;
    if (!opener.current) opener.current = document.activeElement as HTMLElement | null;
    element?.showModal();
    element?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    return () => {
      element?.close();
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, []);
  const save = async () => {
    if (saving || !text.trim()) return;
    const state = useStore.getState();
    const node = state.nodes.find(n => n.id === nodeId);
    if (!node || !state.auth || !state.canEdit(node.teamId)) {
      setError('This task is no longer available for editing.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const entries = node.prompt[field];
      const exists = entries.some(item => item.ts === timestamp.current && item.author === state.auth!.user.email);
      // Requeue on retry: optimistic presence is not proof of persistence.
      state.updateNode(nodeId, { prompt: { ...node.prompt, [field]: exists ? entries : [
        ...entries,
        { ts: timestamp.current, author: state.auth.user.email, text: text.trim() },
      ] } });
      staged.current = true;
      await flushEdits();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save. Please retry.');
    } finally { setSaving(false); }
  };
  return createPortal(
    <dialog ref={dialog} aria-labelledby="annotation-title" aria-describedby="annotation-help"
      className="annotation-dialog"
      onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-accent text-xs mb-2">{refinement ? 'TASK CONTEXT' : 'DISCUSSION'}</p>
            <h2 id="annotation-title" className="text-xl font-semibold">{refinement ? 'Add refinement' : 'Add comment'}</h2>
          </div>
          <button type="button" className="small-button" aria-label="Close dialog" disabled={saving} onClick={onClose}>✕</button>
        </div>
        <p id="annotation-help" className="text-muted text-sm mt-3 mb-5">
          {refinement ? 'Clarify the task, add requirements or describe the expected result.' : 'Share feedback, a question or additional context for this task.'}
          {' '}This will be included in the next execution context.
        </p>
        <label className="block text-sm" htmlFor="annotation-text">{refinement ? 'Refinement' : 'Comment'}</label>
        <textarea id="annotation-text" rows={7} value={text} disabled={saving || staged.current}
          className="form-input mt-2 !text-sm !leading-relaxed resize-y min-h-40"
          placeholder={refinement ? 'What should the agent clarify or change?' : 'Write your comment…'}
          onChange={event => setText(event.target.value)} />
        {error && <p role="alert" className="text-err text-sm mt-3">{error}</p>}
        <div className="flex justify-end gap-3 mt-6">
          <button type="button" className="small-button !px-4 !py-2" disabled={saving} onClick={onClose}>Cancel</button>
          <button type="submit" className="action-button !px-4 !py-2" disabled={saving || !text.trim()}>
            {saving ? 'Saving…' : staged.current ? 'Retry save' : refinement ? 'Add refinement' : 'Post comment'}
          </button>
        </div>
      </form>
    </dialog>, document.body,
  );
}
