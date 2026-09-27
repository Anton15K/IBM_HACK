import { useEffect, useRef, useState } from 'react';
import {
  sessionRequest,
  sessionGeneration,
  requireSession,
  useStore,
} from '../store';
interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
  teamRoles: { teamId: string; role: string }[];
}
export default function AdminModal() {
  const state = useStore();
  const panelRef = useRef<HTMLDivElement>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const memberSelectRef = useRef<HTMLSelectElement>(null);
  const focusMemberRef = useRef(false);
  const close = () => useStore.setState({ showAdmin: false });
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const opener = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex]',
    )).filter((element) => element.tabIndex >= 0
      && !element.matches(':disabled') && element.getClientRects().length > 0);
    const focusFirst = () => (focusable()[0] ?? panel).focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        useStore.setState({ showAdmin: false });
      } else if (event.key === 'Tab') {
        const elements = focusable();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!first || !last) {
          event.preventDefault();
          panel.focus();
        } else if (event.shiftKey && (document.activeElement === first
          || document.activeElement === panel)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !panel.contains(event.target)) focusFirst();
    };
    panel.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    focusFirst();
    return () => {
      panel.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => {
    let alive = true;
    void sessionRequest<Member[]>('/members')
      .then((data) => {
        if (alive) setMembers(data);
      })
      .catch((err) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!busy && focusMemberRef.current) {
      focusMemberRef.current = false;
      memberSelectRef.current?.focus();
    }
  }, [busy]);
  const submit = async (path: string, body: unknown, method = 'POST', form?: HTMLFormElement) => {
    const generation = sessionGeneration();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const saved = await sessionRequest<Member>(path, method, body);
      requireSession(generation);
      if (path === '/members') {
        // Clear the credential as soon as account creation succeeds.
        const password = form?.elements.namedItem('password');
        if (password instanceof HTMLInputElement) password.value = '';
        setMembers((existing) => [...existing, saved]);
        setSelectedMemberId(saved.id);
        focusMemberRef.current = saved.role === 'member';
        setMessage(saved.role === 'admin'
          ? `${saved.name} can now log in as an administrator with access to the whole company.`
          : `${saved.name}'s account is ready. Next, choose their team and assign Editor or Viewer below. Share the login address, email and password privately.`);
      } else {
        setMessage(path.startsWith('/teams/')
          ? 'Team access saved. The member can log in using their account; an open session will update automatically.'
          : 'Saved.');
      }
      await state.refresh();
      requireSession(generation);
      const data = await sessionRequest<Member[]>('/members');
      requireSession(generation);
      setMembers(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const parent = state.selectedTeamId
    ? state.teams.find((t) => t.id === state.selectedTeamId)?.parentId
    : state.navigationId;
  return (
    <div className="modal-shade">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-modal-title"
        tabIndex={-1}
        className="modal-panel space-y-5 max-h-[85vh] overflow-y-auto"
      >
        <div className="flex justify-between">
          <h2 id="admin-modal-title" className="font-semibold">Manage company</h2>
          <button type="button" aria-label="Close company management" onClick={close}>×</button>
        </div>
        <fieldset disabled={busy} className="space-y-5">
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              const data = Object.fromEntries(new FormData(e.currentTarget));
              void submit('/teams', {
                ...data,
                parentId: data.parentId || null,
              });
            }}
          >
            <h3>New department or team</h3>
            <input
              name="name"
              required
              className="form-input"
              placeholder="Name"
            />
            <select name="kind" className="form-input">
              <option value="team">Team</option>
              <option value="department">Department</option>
            </select>
            <select
              name="parentId"
              className="form-input"
              defaultValue={parent ?? ''}
            >
              <option value="">Company</option>
              {state.teams
                .filter((t) => t.kind !== 'team')
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
            <button className="action-button">Create</button>
          </form>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(
                '/members',
                Object.fromEntries(new FormData(e.currentTarget)),
                'POST',
                e.currentTarget,
              );
            }}
          >
            <h3>1. Create a team member account</h3>
            <p className="text-muted text-xs">
              Members use the same login page. After creating their account, assign team access in step 2.
              Administrators have access to the whole company.
            </p>
            <label className="block text-xs" htmlFor="member-name">Member name</label>
            <input
              id="member-name"
              name="name"
              required
              className="form-input"
              placeholder="Name"
            />
            <label className="block text-xs" htmlFor="member-email">Email</label>
            <input
              id="member-email"
              name="email"
              type="email"
              required
              className="form-input"
              placeholder="Email"
            />
            <label className="block text-xs" htmlFor="member-password">Password (10+ characters)</label>
            <input
              id="member-password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
              className="form-input"
              placeholder="Password (10+ characters)"
            />
            <label className="block text-xs" htmlFor="member-company-role">Company role</label>
            <select id="member-company-role" name="role" className="form-input">
              <option value="member">Member</option>
              <option value="admin">Administrator</option>
            </select>
            <button className="action-button">Create member</button>
          </form>
          <div className="space-y-2">
            <h3>Members</h3>
            {members.map((m) => (
              <div
                key={m.id}
                className="bg-card border border-line rounded-lg p-2"
              >
                <p>
                  {m.name} · {m.email} · {m.role}
                </p>
                <p className="text-muted text-[10px]">
                  {m.teamRoles
                    .map(
                      (r) =>
                        `${state.teams.find((t) => t.id === r.teamId)?.name ?? r.teamId}: ${r.role}`,
                    )
                    .join(' · ') || (m.role === 'admin' ? 'Full company access' : 'No team access yet — complete step 2')}
                </p>
              </div>
            ))}
          </div>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              const data = Object.fromEntries(new FormData(e.currentTarget));
              void submit(
                `/teams/${data.teamId}/members/${data.userId}`,
                { role: data.role },
                'PUT',
              );
            }}
          >
            <h3>2. Assign team access</h3>
            <label className="block text-xs" htmlFor="access-member">Member</label>
            <select id="access-member" ref={memberSelectRef} name="userId" className="form-input" required
              value={selectedMemberId} onChange={(event) => setSelectedMemberId(event.target.value)}>
              <option value="" disabled>Choose a member</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <label className="block text-xs" htmlFor="access-team">Team or department</label>
            <select id="access-team" name="teamId" className="form-input" required>
              {state.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <label className="block text-xs" htmlFor="access-role">Team role</label>
            <select id="access-role" name="role" className="form-input">
              <option value="editor">Editor — create, edit and run tasks</option>
              <option value="viewer">Viewer — read only</option>
            </select>
            <p className="text-muted text-[10px]">
              Roles inherit to descendants. A closer explicit role takes
              precedence.
            </p>
            {members.find((member) => member.id === selectedMemberId)?.role === 'admin' && (
              <p className="text-muted text-xs">Administrators already have full company access; no team role is needed.</p>
            )}
            <button
              disabled={!state.teams.length || !selectedMemberId || members.find((member) => member.id === selectedMemberId)?.role === 'admin'}
              className="action-button"
            >
              Assign role
            </button>
          </form>
        </fieldset>
        {error && (
          <p role="alert" className="text-err text-xs">
            {error}
          </p>
        )}
        {message && <p role="status" className="text-ok text-xs">{message}</p>}
      </div>
    </div>
  );
}
