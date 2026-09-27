import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export default function Modal({ labelledBy, describedBy, busy = false, onClose, children }: {
  labelledBy: string;
  describedBy?: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!opener.current) opener.current = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => {
      element?.close();
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, []);
  return createPortal(
    <dialog ref={dialog} className="annotation-dialog space-y-4" aria-labelledby={labelledBy} aria-describedby={describedBy}
      onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
      onClick={event => {
        if (busy || event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}>
      {children}
    </dialog>, document.body,
  );
}
