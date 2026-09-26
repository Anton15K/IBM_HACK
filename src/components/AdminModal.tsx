import { useEffect, useState } from 'react';
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
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const close = () => useStore.setState({ showAdmin: false });
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
  const submit = async (path: string, body: unknown, method = 'POST') => {
    const generation = sessionGeneration();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await sessionRequest(path, method, body);
      requireSession(generation);
      await state.refresh();
      requireSession(generation);
      const data = await sessionRequest<Member[]>('/members');
      requireSession(generation);
      setMembers(data);
      setMessage('Saved.');
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
      <div className="modal-panel space-y-5 max-h-[85vh] overflow-y-auto">
        <div className="flex justify-between">
          <h2 className="font-semibold">Manage company</h2>
          <button onClick={close}>×</button>
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
              );
            }}
          >
            <h3>Create member</h3>
            <input
              name="name"
              required
              className="form-input"
              placeholder="Name"
            />
            <input
              name="email"
              type="email"
              required
              className="form-input"
              placeholder="Email"
            />
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
              className="form-input"
              placeholder="Password (10+ characters)"
            />
            <select name="role" className="form-input">
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
                    .join(' · ') || 'No explicit team roles'}
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
            <h3>Assign inherited team role</h3>
            <select name="userId" className="form-input" required>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <select name="teamId" className="form-input" required>
              {state.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <select name="role" className="form-input">
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
            <p className="text-muted text-[10px]">
              Roles inherit to descendants. A closer explicit role takes
              precedence.
            </p>
            <button
              disabled={!state.teams.length || !members.length}
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
        {message && <p className="text-ok text-xs">{message}</p>}
      </div>
    </div>
  );
}
