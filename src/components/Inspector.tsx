import { useEffect, useRef, useState } from 'react';
import { useStore, sessionRequest } from '../store';
import type { WorkerNode, WorkspaceSnapshot, Provider } from '../types';
import { assemblePrompt } from '../prompt';
import { resolveOutputMode } from '../output-mode';
import { previewInputs } from '../prompt-preview';
import TaskResult, { type ResultAttempt } from './TaskResult';
import { statusColor } from '../utils/colors';
import { requestTaskDeletion } from '../node-actions';
import SendToTeamModal from './SendToTeamModal';
import AssembledPromptModal from './AssembledPromptModal';
import WorkspaceEditor from './WorkspaceEditor';
import AnnotationModal from './AnnotationModal';

interface ModelDescriptor {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
}

interface Attempt extends ResultAttempt {
  id: string;
  nodeId: string;
  nodeVersion: number;
  status: string;
  startedAt: string;
  finishedAt?: string;
  taskId: string | null;
  sessionCosts: number | null;
  assembledPrompt: string;
  error?: string;
  output?: WorkerNode['output'];
  workspaceBefore: WorkspaceSnapshot | null;
  workspaceAfter: WorkspaceSnapshot | null;
  apiUsage?: { promptTokens: number; completionTokens: number; totalTokens: number; incomplete?: boolean };
  model?: string;
}
interface Handoff {
  id: string;
  recipientTeamId: string;
  recipientNodeId: string;
  sourceAttemptId?: string;
  recipient: {
    id: string;
    name: string;
    status: string;
    summary: string;
    attemptId?: string;
  } | null;
}
function OutputTokenInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!focused) setDraft(String(value)); }, [value, focused]);
  const commit = () => {
    const next = Number(draft);
    if (!Number.isInteger(next) || next < 64 || next > 65536) {
      setError('Enter a whole number from 64 to 65,536.');
      return;
    }
    setError('');
    setFocused(false);
    if (next !== value) onChange(next);
  };
  return <label>
    Max output tokens (64–65,536)
    <input type="number" min={64} max={65536} step={1} className="form-input mt-1"
      value={draft} aria-invalid={!!error} aria-describedby="output-token-help"
      onFocus={() => setFocused(true)} onChange={event => { setDraft(event.target.value); setError(''); }}
      onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />
    <span id="output-token-help" className={error ? 'text-err text-[10px]' : 'text-muted text-[10px]'}>
      {error || 'Per request. The selected model may enforce a lower limit. Larger outputs can take longer and cost more.'}
    </span>
  </label>;
}

function ListInput({
  values,
  onChange,
}: {
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [raw, setRaw] = useState(values.join(', '));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setRaw(values.join(', '));
  }, [values, focused]);
  return (
    <input
      className="form-input mt-1"
      value={raw}
      onFocus={() => setFocused(true)}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={() => {
        const parsed = raw
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
        if (JSON.stringify(parsed) !== JSON.stringify(values)) onChange(parsed);
        setFocused(false);
      }}
    />
  );
}
function Snapshot({
  title,
  value,
}: {
  title: string;
  value: WorkspaceSnapshot | null;
}) {
  return value ? (
    <div className="bg-card border border-line p-2 rounded-lg break-all text-[10px]">
      <p>
        {title}: {value.path}
      </p>
      <p>
        {value.branch} @ {value.commitSha} {value.dirty ? '· dirty' : '· clean'}
      </p>
    </div>
  ) : (
    <p className="text-muted text-[10px]">{title}: not recorded</p>
  );
}

const PROVIDER_LABELS: Record<Provider, string> = {
  bob: 'Bob Shell',
  mock: 'Mock · no spend',
  api: 'API model',
  openai: 'OpenAI · unsupported',
  anthropic: 'Anthropic · unsupported',
  google: 'Google · unsupported',
};

type InspectorTab = 'task' | 'result' | 'history';

function defaultTab(node: WorkerNode): InspectorTab {
  if (node.status === 'done' || node.status === 'failed' || node.status === 'needs_approval') {
    return 'result';
  }
  return 'task';
}

export default function Inspector() {
  const state = useStore();
  const node = state.nodes.find((n) => n.id === state.selectedNodeId)!;
  const reworkTargets = state.nodes.filter(
    (n) =>
      n.type === 'worker' &&
      node.inputs.some((i) => i.enabled && i.fromNodeId === n.id),
  );
  const [override, setOverride] = useState(!!node.workspace);
  const [send, setSend] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [detail, setDetail] = useState<Attempt | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [target, setTarget] = useState(reworkTargets[0]?.id ?? '');
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // App keys the inspector by node ID; polling must preserve the chosen tab.
  const [tab, setTab] = useState<InspectorTab>(() => defaultTab(node));
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // API model connections list for profile picker
  const [apiConnections, setApiConnections] = useState<ModelDescriptor[]>([]);
  const apiMountedRef = useRef(true);
  useEffect(() => {
    apiMountedRef.current = true;
    return () => { apiMountedRef.current = false; };
  }, []);
  useEffect(() => {
    if (!(state.capabilities?.providers ?? []).includes('api')) return;
    sessionRequest<{ connections: ModelDescriptor[] }>('/model-connections')
      .then((data) => { if (apiMountedRef.current) setApiConnections(data.connections); })
      .catch(() => { /* non-critical; user sees configure hint */ });
  }, [state.capabilities?.providers, state.showSettings]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const [a, h] = await Promise.all([
          sessionRequest<Attempt[]>(`/nodes/${node.id}/attempts`),
          sessionRequest<Handoff[]>(`/nodes/${node.id}/handoffs`),
        ]);
        if (!disposed) {
          setAttempts(a);
          setHandoffs(h);
          setError('');
        }
      } catch (err) {
        if (!disposed) setError((err as Error).message);
      }
      if (!disposed) timer = setTimeout(load, 1500);
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [node.id]);
  const editable = state.canEdit(node.teamId);
  const busy = state.busy.includes(node.id);
  const graph = state.graphContexts.find((g) => g.id === node.graphId);
  const update = state.updateNode;
  const color = statusColor(node.status, 'normal');
  const [annotation, setAnnotation] = useState<'refinements' | 'comments' | null>(null);
  const previewPrompt = () => {
    if (!graph) return;
    const { incoming, unavailableInputIds } = previewInputs(node, state.nodes);
    const notice = unavailableInputIds.length
      ? `Preview only: unavailable upstream results omitted (${unavailableInputIds.map((id) => state.nodes.find((source) => source.id === id)?.name ?? 'Unavailable task').join(', ')}). Execution will validate dependencies again.\n\n`
      : '';
    setPreview(notice + assemblePrompt(node, graph, incoming, null));
  };

  const isApiProvider = node.executor.provider === 'api';
  const isBobProvider = node.executor.provider === 'bob';
  const isLegacyUnsupported = !['bob', 'mock', 'api'].includes(node.executor.provider);
  const availableProviders = (state.capabilities?.providers ?? []) as Provider[];
  const isGate = node.type === 'gate';

  const handleTabClick = (t: InspectorTab) => {
    setTab(t);
  };

  return (
    <>
      <aside className="w-80 bg-panel border-l border-line flex flex-col overflow-hidden shrink-0">
        {/* Header */}
        <div
          className="flex justify-between items-center px-4 py-3 border-b border-line"
          style={{ borderTop: `2px solid ${color}` }}
        >
          <span className="text-sm font-semibold truncate">{node.name}</span>
          <button
            onClick={() => state.selectNode(null)}
            aria-label="Close inspector"
            className="text-muted hover:text-ink transition-colors w-7 h-7 flex items-center justify-center rounded"
          >
            ×
          </button>
        </div>

        {/* Status line */}
        <div className="px-4 py-1.5 border-b border-line text-xs" style={{ color }}>
          {node.status.replace(/_/g, ' ')} · v{node.version}
          {busy ? ' · saving…' : ''}
        </div>

        {/* Tabs */}
        <div role="tablist" aria-label="Inspector sections" className="flex border-b border-line text-xs">
          {(['task', 'result', 'history'] as const).map((t, index) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              tabIndex={tab === t ? 0 : -1}
              ref={element => { tabRefs.current[index] = element; }}
              onKeyDown={event => {
                const next = event.key === 'ArrowRight' ? (index + 1) % 3 :
                  event.key === 'ArrowLeft' ? (index + 2) % 3 :
                  event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null;
                if (next === null) return;
                event.preventDefault();
                setTab((['task', 'result', 'history'] as const)[next]);
                tabRefs.current[next]?.focus();
              }}
              aria-controls={`inspector-panel-${t}`}
              id={`inspector-tab-${t}`}
              onClick={() => handleTabClick(t)}
              className="flex-1 py-2 capitalize transition-colors"
              style={{
                borderBottom: tab === t ? `2px solid ${color}` : '2px solid transparent',
                color: tab === t ? '#E7EBF4' : '#8B94A7',
                background: 'none',
              }}
            >
              {t === 'task' ? 'Task' : t === 'result' ? 'Result' : 'History'}
            </button>
          ))}
        </div>

        {/* Tab panels */}
        <div className="flex-1 overflow-y-auto">

          {/* ── TASK TAB ──────────────────────────────────────────────── */}
          <div
            role="tabpanel"
            tabIndex={0}
            id="inspector-panel-task"
            aria-labelledby="inspector-tab-task"
            hidden={tab !== 'task'}
          >
            <div className="p-4 space-y-4 text-xs">
              {/* Name, type, priority, prompt, annotations — editable for gate too */}
              <fieldset disabled={!editable} className="space-y-3">
                <label>
                  Name
                  <input
                    className="form-input mt-1"
                    value={node.name}
                    onChange={(e) => update(node.id, { name: e.target.value })}
                  />
                </label>
                <label>
                  Type
                  <select
                    className="form-input mt-1"
                    value={node.type}
                    onChange={(e) =>
                      update(node.id, {
                        type: e.target.value as WorkerNode['type'],
                      })
                    }
                  >
                    {[
                      'worker',
                      'gate',
                      ...(node.type === 'inbox' ? ['inbox'] : []),
                    ].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Priority
                  <select
                    className="form-input mt-1"
                    value={node.priority}
                    onChange={(e) =>
                      update(node.id, {
                        priority: e.target.value as WorkerNode['priority'],
                      })
                    }
                  >
                    {['low', 'normal', 'high', 'critical'].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
                <label>
                  {isGate ? 'Review instructions' : 'Task prompt'}
                  <textarea
                    rows={5}
                    className="form-input mt-1"
                    value={node.prompt.task}
                    onChange={(e) =>
                      update(node.id, {
                        prompt: { ...node.prompt, task: e.target.value },
                      })
                    }
                  />
                </label>
                <div className="flex gap-3">
                  <button
                    className="text-accent"
                    onClick={() => setAnnotation('refinements')}
                  >
                    + Refinement
                  </button>
                  <button
                    className="text-muted"
                    onClick={() => setAnnotation('comments')}
                  >
                    + Comment
                  </button>
                </div>
                {[...node.prompt.refinements, ...node.prompt.comments].map(
                  (item, i) => (
                    <div
                      key={i}
                      className="bg-card border border-line rounded-lg p-2"
                    >
                      <p className="text-muted text-[10px]">
                        {item.author} · {item.ts}
                      </p>
                      <p className="whitespace-pre-wrap break-words">{item.text}</p>
                    </div>
                  ),
                )}
              </fieldset>

              {!isGate && (
                <>
                  {/* Executor section — primary: provider picker */}
                  <fieldset disabled={!editable} className="space-y-3">
                    <label>
                      Executor
                      <select
                        className="form-input mt-1"
                        value={node.executor.provider}
                        onChange={(e) => {
                          const p = e.target.value as Provider;
                          if (p === 'api') {
                            const conn = apiConnections.find(c => c.id === node.executor.connectionId) ?? apiConnections[0];
                            if (!conn) { setError('Add an API model connection in Backend settings first.'); return; }
                            update(node.id, { executor: { ...node.executor, provider: 'api', model: conn.model, connectionId: conn.id, maxIterations: Math.min(node.executor.maxIterations, 32) } });
                          } else {
                            update(node.id, {
                              executor: {
                                ...node.executor,
                                provider: p,
                                model: p === 'bob' ? 'shell-configured' : 'mock-v1',
                                connectionId: undefined,
                                maxOutputTokens: undefined,
                              },
                            });
                          }
                        }}
                      >
                        {availableProviders.map((p) => (
                          <option key={p} value={p}>
                            {PROVIDER_LABELS[p] ?? p}
                          </option>
                        ))}
                        {isLegacyUnsupported && (
                          <option value={node.executor.provider}>
                            {node.executor.provider} · unsupported
                          </option>
                        )}
                      </select>
                    </label>

                    {/* API provider: profile selector */}
                    {isApiProvider && (
                      <>
                        {apiConnections.length === 0 ? (
                          <p className="text-warn text-[10px]">
                            No API model profiles configured. Ask an org admin to add one
                            in Backend settings before running this node.
                          </p>
                        ) : (
                          <label>
                            API model profile
                            <select
                              className="form-input mt-1"
                              value={node.executor.connectionId ?? ''}
                              onChange={(e) => {
                                const conn = apiConnections.find((c) => c.id === e.target.value);
                                if (!conn) return;
                                update(node.id, {
                                  executor: {
                                    ...node.executor,
                                    provider: 'api',
                                    connectionId: conn.id,
                                    model: conn.model,
                                  },
                                });
                              }}
                            >
                              <option value="">— select a profile —</option>
                              {apiConnections.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.label} ({c.model})
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        {node.executor.connectionId && (
                          <p className="text-muted text-[10px]">
                            Profile: {apiConnections.find((c) => c.id === node.executor.connectionId)?.label ?? node.executor.connectionId} · model: {node.executor.model}
                          </p>
                        )}
                      </>
                    )}

                    {!isApiProvider && (
                      <p className="text-muted text-[10px]">
                        {isBobProvider
                          ? 'Bob model is Shell-configured. Skills and tools are requested task instructions.'
                          : isLegacyUnsupported
                            ? `Provider '${node.executor.provider}' is not supported by this server.`
                            : 'Mock provider: no real execution, no spend.'}
                      </p>
                    )}
                  </fieldset>

                  {/* ── Advanced: collapsed section ── */}
                  <div className="border border-line rounded-lg overflow-hidden">
                    <button
                      type="button"
                      className="w-full flex justify-between items-center px-3 py-2 text-xs text-muted hover:text-ink transition-colors"
                      aria-expanded={advancedOpen}
                      onClick={() => setAdvancedOpen((v) => !v)}
                    >
                      <span>Advanced execution settings</span>
                      <span>{advancedOpen ? '▲' : '▼'}</span>
                    </button>
                    <div hidden={!advancedOpen}>
                      <fieldset disabled={!editable} className="p-3 space-y-3 border-t border-line text-xs">
                        {isApiProvider && (
                          <OutputTokenInput value={node.executor.maxOutputTokens ?? 1024}
                            onChange={maxOutputTokens => update(node.id, { executor: { ...node.executor, maxOutputTokens } })} />
                        )}
                        {(['skills', 'tools'] as const).map((field) => (
                          <label className="block" key={field}>
                            {field}
                            <ListInput
                              values={node.executor[field]}
                              onChange={(values) =>
                                update(node.id, {
                                  executor: { ...node.executor, [field]: values },
                                })
                              }
                            />
                          </label>
                        ))}
                        {(
                          [
                            ...(isBobProvider
                              ? [
                                  {
                                    key: 'maxCost' as const,
                                    label: 'Budget (Bobcoins)',
                                    min: 0.01,
                                    max: 3,
                                    fallback: 0.5,
                                    step: 0.01,
                                  },
                                ]
                              : []),
                            {
                              key: 'maxIterations' as const,
                              label: 'Maximum iterations',
                              min: 1,
                              max: isApiProvider ? 32 : 100,
                              fallback: 3,
                              step: 1,
                            },
                            {
                              key: 'maxAttempts' as const,
                              label: 'Maximum attempts',
                              min: 1,
                              max: 10,
                              fallback: 3,
                              step: 1,
                            },
                          ] as const
                        ).map(({ key, label, min, max, fallback, step }) => (
                          <label className="block" key={key}>
                            {label}
                            <input
                              type="number"
                              min={min}
                              max={max}
                              step={step}
                              className="form-input mt-1"
                              value={node.executor[key] ?? fallback}
                              onChange={(e) =>
                                update(node.id, {
                                  executor: {
                                    ...node.executor,
                                    [key]: Math.min(
                                      max,
                                      Math.max(min, Number(e.target.value) || fallback),
                                    ),
                                  },
                                })
                              }
                            />
                          </label>
                        ))}
                        <label>
                          Desired output
                          <select
                            className="form-input mt-1"
                            value={
                              resolveOutputMode(node)
                            }
                            onChange={(e) =>
                              update(node.id, {
                                desiredOutput: e.target.value as 'report' | 'patch',
                              })
                            }
                          >
                            {(state.capabilities?.outputModes ?? []).map((mode) => (
                              <option key={mode}>{mode}</option>
                            ))}
                            {node.desiredOutput &&
                              !['report', 'patch'].includes(node.desiredOutput) && (
                                <option value={node.desiredOutput}>
                                  {node.desiredOutput} · unsupported
                                </option>
                              )}
                          </select>
                        </label>
                        <label className="flex gap-2">
                          <input
                            type="checkbox"
                            checked={!node.workspace && !override}
                            onChange={(e) => {
                              setOverride(!e.target.checked);
                              if (e.target.checked) update(node.id, { workspace: null });
                            }}
                          />
                          Inherit project workspace
                        </label>
                        {(node.workspace || override) && (
                          <WorkspaceEditor
                            value={node.workspace}
                            onChange={(workspace) => update(node.id, { workspace })}
                          />
                        )}
                        <div>
                          <div className="text-muted text-[10px] uppercase mb-2">
                            Context files / globs
                          </div>
                          {node.context.files.map((file, i) => (
                            <div key={i} className="flex gap-1 mb-1">
                              <select
                                value={file.kind}
                                className="form-input w-16"
                                onChange={(e) =>
                                  update(node.id, {
                                    context: {
                                      ...node.context,
                                      files: node.context.files.map((f, j) =>
                                        j === i
                                          ? {
                                              ...f,
                                              kind: e.target.value as 'file' | 'glob',
                                            }
                                          : f,
                                      ),
                                    },
                                  })
                                }
                              >
                                <option>file</option>
                                <option>glob</option>
                              </select>
                              <input
                                className="form-input"
                                value={file.path}
                                onChange={(e) =>
                                  update(node.id, {
                                    context: {
                                      ...node.context,
                                      files: node.context.files.map((f, j) =>
                                        j === i ? { ...f, path: e.target.value } : f,
                                      ),
                                    },
                                  })
                                }
                              />
                              <button
                                onClick={() =>
                                  update(node.id, {
                                    context: {
                                      ...node.context,
                                      files: node.context.files.filter((_, j) => i !== j),
                                    },
                                  })
                                }
                              >
                                ×
                              </button>
                            </div>
                          ))}
                          <button
                            className="text-accent"
                            onClick={() =>
                              update(node.id, {
                                context: {
                                  ...node.context,
                                  files: [
                                    ...node.context.files,
                                    { kind: 'file', path: '' },
                                  ],
                                },
                              })
                            }
                          >
                            + File reference
                          </button>
                        </div>
                        <label>
                          Extra context
                          <textarea
                            className="form-input mt-1"
                            value={node.context.extra}
                            onChange={(e) =>
                              update(node.id, {
                                context: { ...node.context, extra: e.target.value },
                              })
                            }
                          />
                        </label>
                        <p className="text-muted">Author: {node.owners.author}</p>
                        <label>
                          Responsible (emails)
                          <ListInput
                            values={node.owners.responsible}
                            onChange={(responsible) =>
                              update(node.id, { owners: { ...node.owners, responsible } })
                            }
                          />
                        </label>
                      </fieldset>
                    </div>
                  </div>

                  <button className="text-accent text-xs" onClick={previewPrompt}>
                    Preview assembled prompt
                  </button>
                  <p className="text-muted text-[10px]">
                    Preview uses current definitions, completed visible inputs and pinned
                    handoff results. Unavailable inputs are omitted. The exact frozen
                    prompt, including gate provenance and resolved Git state, is recorded
                    in each attempt.
                  </p>
                </>
              )}

              {node.inboxMeta && (
                <div className="bg-card border border-line rounded-lg p-3 text-xs">
                  <h3 className="text-accent mb-1">Source provenance</h3>
                  <p>{node.inboxMeta.message}</p>
                  <p className="text-muted break-all">
                    Source node {node.inboxMeta.sourceNodeId} · attempt{' '}
                    {node.inboxMeta.sourceAttemptId ?? 'not recorded'}
                  </p>
                  <p>{node.inboxMeta.sourceOutput?.summary}</p>
                </div>
              )}

              {error && (
                <p role="alert" className="text-err text-xs">
                  {error}
                </p>
              )}
            </div>
          </div>

          {/* ── RESULT TAB ────────────────────────────────────────────── */}
          <div
            role="tabpanel"
            tabIndex={0}
            id="inspector-panel-result"
            aria-labelledby="inspector-tab-result"
            hidden={tab !== 'result'}
          >
            <div className="p-4 space-y-4 text-xs">
              <TaskResult node={node} attempts={attempts} />

              {error && (
                <p role="alert" className="text-err text-xs">
                  {error}
                </p>
              )}
            </div>
          </div>

          {/* ── HISTORY TAB ───────────────────────────────────────────── */}
          <div
            role="tabpanel"
            tabIndex={0}
            id="inspector-panel-history"
            aria-labelledby="inspector-tab-history"
            hidden={tab !== 'history'}
          >
            <div className="p-4 space-y-3 text-xs">
              {[...attempts].reverse().map((a) => (
                <button
                  key={a.id}
                  className="small-button block w-full text-left"
                  onClick={() => setDetail(a)}
                >
                  {a.status} · {new Date(a.startedAt).toLocaleString()}
                  <span className="block text-muted text-[11px]">
                    {a.apiUsage
                      ? `${a.apiUsage.totalTokens} tokens (API${a.apiUsage.incomplete ? ", partial usage" : ""})`
                      : a.sessionCosts == null
                        ? 'Cost unknown'
                        : `${a.sessionCosts} Bobcoins`}{' '}
                    · task {a.taskId ?? 'unknown'}
                  </span>
                </button>
              ))}
              {attempts.length === 0 && (
                <p className="text-muted">No attempts yet.</p>
              )}
              {handoffs.length > 0 && (
                <div className="mt-4">
                  <h3 className="text-muted uppercase text-[10px] mb-2">
                    Scoped collaboration results
                  </h3>
                  {handoffs.map((h) => (
                    <div
                      key={h.id}
                      className="bg-card border border-line rounded-lg p-2 mb-2"
                    >
                      <p>
                        {h.recipient?.name ?? 'Recipient unavailable'} ·{' '}
                        {h.recipient?.status ?? 'unknown'}
                      </p>
                      <p className="text-muted">{h.recipient?.summary}</p>
                      {state.graphContexts.some(
                        (g) => g.teamId === h.recipientTeamId,
                      ) && (
                        <button
                          className="text-accent"
                          onClick={() => state.navigate(h.recipientTeamId)}
                        >
                          Open recipient team →
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {error && (
                <p role="alert" className="text-err">
                  {error}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Primary action footer */}
        <fieldset
          disabled={!editable || busy}
          className="border-t border-line p-3 space-y-2 text-xs shrink-0"
        >
          {node.type === 'inbox' ? (
            <button
              className="action-button w-full"
              onClick={() => update(node.id, { type: 'worker' })}
            >
              Convert to Worker
            </button>
          ) : node.type === 'gate' &&
            node.status === 'needs_approval' &&
            node.currentAttemptId ? (
            <>
              <button
                className="action-button w-full"
                onClick={() => void state.approveGate(node.id)}
              >
                Approve current attempt
              </button>
              <select
                className="form-input"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                {reworkTargets.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
              </select>
              <textarea
                className="form-input"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="Rework feedback"
              />
              <button
                className="small-button w-full"
                disabled={!feedback.trim() || !target}
                onClick={() =>
                  void state.requestChanges(node.id, target, feedback)
                }
              >
                Request changes
              </button>
              <button
                className="small-button w-full"
                onClick={() => void state.cancelNode(node.id)}
              >
                Cancel review
              </button>
            </>
          ) : node.status === 'running' || node.status === 'queued' ? (
            <button
              className="small-button w-full"
              onClick={() => void state.cancelNode(node.id)}
            >
              Cancel task
            </button>
          ) : (
            <button
              className="action-button w-full"
              disabled={isApiProvider && !node.executor.connectionId}
              onClick={() => void state.runNode(node.id)}
            >
              {isGate ? 'Start review' : 'Run task'}
            </button>
          )}
          <div className="flex gap-2">
            <button className="small-button flex-1" onClick={() => setSend(true)}>
              Send to Team…
            </button>
            <button
              disabled={savingTemplate}
              className="small-button flex-1"
              onClick={async () => {
                const name = window.prompt('Template name', node.name);
                if (!name) return;
                setSavingTemplate(true);
                await state.addTemplate({
                  name,
                  description: node.prompt.task.slice(0, 80),
                  defaults: {
                    type: node.type,
                    priority: node.priority,
                    prompt: node.prompt,
                    executor: node.executor,
                    context: node.context,
                  },
                });
                setSavingTemplate(false);
              }}
            >
              Save as template
            </button>
          </div>
          <button
            className="small-button w-full"
            onClick={() => void requestTaskDeletion(node, (message) => window.confirm(message), state.removeNode)}
          >
            Delete task
          </button>
        </fieldset>
      </aside>
      {send && <SendToTeamModal node={node} onClose={() => setSend(false)} />}
      {preview !== null && (
        <AssembledPromptModal
          prompt={preview}
          onClose={() => setPreview(null)}
        />
      )}
      {detail && (
        <div className="modal-shade">
          <div className="modal-panel space-y-3 max-h-[85vh] overflow-y-auto">
            <div className="flex justify-between">
              <h2>Attempt {detail.id}</h2>
              <button onClick={() => setDetail(null)}>×</button>
            </div>
            <p>
              {detail.status} · definition version {detail.nodeVersion}{detail.model ? ` · ${detail.model}` : ""}
            </p>
            <p>
              Started {detail.startedAt}
              <br />
              Finished {detail.finishedAt ?? 'pending'}
            </p>
            {detail.apiUsage ? (
              <p>
                API tokens: {detail.apiUsage.promptTokens} prompt +{' '}
                {detail.apiUsage.completionTokens} completion ={' '}
                {detail.apiUsage.totalTokens} total{detail.apiUsage.incomplete ? " (partial usage reported)" : ""}
              </p>
            ) : (
              <p>
                Task ID: {detail.taskId ?? 'unknown'} ·{' '}
                {detail.sessionCosts == null
                  ? 'Cost unknown'
                  : `${detail.sessionCosts} Bobcoins`}
              </p>
            )}
            {detail.error && <p className="text-err">{detail.error}</p>}
            <Snapshot title="Before" value={detail.workspaceBefore} />
            <Snapshot title="After" value={detail.workspaceAfter} />
            <pre className="whitespace-pre-wrap break-words text-[10px]">
              {detail.output?.summary}
            </pre>
            <h3>Exact frozen prompt</h3>
            <pre className="whitespace-pre-wrap break-words text-[10px]">
              {detail.assembledPrompt}
            </pre>
          </div>
        </div>
      )}
      {annotation && <AnnotationModal key={node.id + annotation} nodeId={node.id} field={annotation} onClose={() => setAnnotation(null)} />}
    </>
  );
}
