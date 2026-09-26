import { useState } from 'react';
import { useStore } from '../store';
import {
  statusColor,
  statusLabel,
  priorityColor,
  PROVIDER_LABELS,
  NODE_TYPE_LABELS,
} from '../utils/colors';
import type { NodeStatus, Priority, Provider, HistoryEntry } from '../types';
import SendToTeamModal from './SendToTeamModal';
import ReplayModal from './ReplayModal';
import AssembledPromptModal from './AssembledPromptModal';
import { assemblePrompt } from '../executors/registry';

const ALL_STATUSES: NodeStatus[] = [
  'draft', 'ready', 'queued', 'running', 'blocked', 'done', 'failed', 'rework', 'needs_approval',
];
const ALL_PRIORITIES: Priority[] = ['low', 'normal', 'high', 'critical'];
const ALL_PROVIDERS: Provider[] = ['bob', 'openai', 'anthropic', 'google', 'mock'];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-muted text-[10px] font-semibold uppercase tracking-widest mb-2">{title}</div>
      {children}
    </div>
  );
}

function ChipInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState('');

  const add = () => {
    const trimmed = input.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange([...value, trimmed]);
    }
    setInput('');
  };

  return (
    <div className="flex flex-wrap gap-1 mb-1">
      {value.map((chip) => (
        <span
          key={chip}
          className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-line text-ink text-[11px]"
        >
          {chip}
          <button
            onClick={() => onChange(value.filter((v) => v !== chip))}
            className="text-muted hover:text-err ml-0.5"
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
        }}
        onBlur={add}
        placeholder={placeholder}
        className="bg-transparent text-ink text-[11px] outline-none placeholder-muted w-24 min-w-0"
      />
    </div>
  );
}

function HistoryRow({
  entry,
  nodeName,
}: {
  entry: HistoryEntry;
  nodeName: string;
}) {
  const [showReplay, setShowReplay] = useState(false);

  return (
    <>
      <div className="flex items-center gap-2 py-1.5 border-b border-line/50 last:border-0">
        <div
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ backgroundColor: entry.status === 'done' ? '#34D399' : '#F87171' }}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-ink text-[11px] font-medium capitalize">{entry.provider}</span>
            <span className="text-muted text-[10px]">·</span>
            <span className="text-muted text-[10px]">{(entry.durationMs / 1000).toFixed(1)}s</span>
            {entry.simulated && (
              <span className="px-1 py-px rounded text-[9px] font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/30 leading-none">
                simulated
              </span>
            )}
          </div>
          <div className="text-muted text-[10px]">
            {new Date(entry.ts).toLocaleString()}
          </div>
        </div>
        <button
          onClick={() => setShowReplay(true)}
          className="text-[10px] px-1.5 py-0.5 rounded bg-line hover:bg-line/80 text-ink transition-colors shrink-0"
        >
          ▶ Replay
        </button>
      </div>
      {showReplay && (
        <ReplayModal entry={entry} nodeName={nodeName} onClose={() => setShowReplay(false)} />
      )}
    </>
  );
}

export default function Inspector() {
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const nodes = useStore((s) => s.nodes);
  const graphContexts = useStore((s) => s.graphContexts);
  const updateNode = useStore((s) => s.updateNode);
  const selectNode = useStore((s) => s.selectNode);
  const runNode = useStore((s) => s.runNode);
  const approveGate = useStore((s) => s.approveGate);
  const requestChanges = useStore((s) => s.requestChanges);
  const addTemplate = useStore((s) => s.addTemplate);

  const [showSendModal, setShowSendModal] = useState(false);
  const [showPromptModal, setShowPromptModal] = useState(false);

  const node = nodes.find((n) => n.id === selectedNodeId);
  if (!node) return null;

  // Status is primary signal; critical priority shows separately as stripe/icon on card
  const color = statusColor(node.status, 'normal');

  const graphContext = graphContexts.find((g) => g.id === node.graphId);

  const getAssembledPrompt = () => {
    if (!graphContext) return node.prompt.task;
    const incoming = node.inputs
      .filter((i) => i.enabled)
      .map((i) => {
        const upstream = nodes.find((n) => n.id === i.fromNodeId);
        if (!upstream) return null;
        return {
          summary_prev: upstream.output.summary,
          results: upstream.output.results,
          commands: upstream.output.commands,
          artifacts: upstream.output.artifacts,
        };
      })
      .filter(Boolean) as import('../types').EdgeContract[];
    return assemblePrompt(node, graphContext, incoming);
  };

  const addRefinement = () => {
    const text = prompt('Enter refinement text:');
    if (!text) return;
    updateNode(node.id, {
      prompt: {
        ...node.prompt,
        refinements: [
          ...node.prompt.refinements,
          { ts: new Date().toISOString(), author: 'me@acme.com', text },
        ],
      },
    });
  };

  const addComment = () => {
    const text = prompt('Enter comment:');
    if (!text) return;
    updateNode(node.id, {
      prompt: {
        ...node.prompt,
        comments: [
          ...node.prompt.comments,
          { ts: new Date().toISOString(), author: 'me@acme.com', text },
        ],
      },
    });
  };

  const handleSaveAsTemplate = () => {
    const name = prompt('Template name:', node.name);
    if (!name) return;
    addTemplate({
      id: `tpl-custom-${Date.now()}`,
      name,
      description: node.prompt.task.slice(0, 80),
      isBuiltIn: false,
      defaults: {
        type: node.type,
        priority: node.priority,
        prompt: { ...node.prompt },
        executor: { ...node.executor },
        context: { ...node.context },
      },
    });
    alert('Template saved!');
  };

  const handleConvertToWorker = () => {
    updateNode(node.id, {
      type: 'worker',
      status: 'draft',
      inputs: [],
      inboxMeta: undefined,
    });
  };

  const upstreamId = node.inputs[0]?.fromNodeId;

  const history = node.history ?? [];

  return (
    <>
      <aside
        className="w-80 bg-panel border-l border-line flex flex-col overflow-hidden shrink-0"
        style={{ zIndex: 10 }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b border-line"
          style={{ borderTopColor: color, borderTopWidth: 2 }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
            {/* Inbox icon for inbox nodes */}
            {node.type === 'inbox' && (
              <span className="text-[12px]">📥</span>
            )}
            <span className="text-ink text-sm font-semibold truncate">{node.name}</span>
          </div>
          <div className="flex items-center gap-1">
            {/* Source team badge for cross-team inboxes */}
            {node.inboxMeta && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-accent/20 text-accent border border-accent/30">
                cross-team
              </span>
            )}
            <button
              onClick={() => selectNode(null)}
              className="text-muted hover:text-ink ml-1 shrink-0"
            >
              ×
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-1" style={{ scrollbarWidth: 'thin', scrollbarColor: '#242C3D transparent' }}>
          {/* Identity */}
          <Section title="Identity">
            <div className="space-y-2">
              <div>
                <label className="text-muted text-[10px]">Name</label>
                <input
                  value={node.name}
                  onChange={(e) => updateNode(node.id, { name: e.target.value })}
                  className="w-full bg-card border border-line rounded-lg px-2.5 py-1.5 text-ink text-xs mt-0.5 outline-none focus:border-accent"
                />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-muted text-[10px]">Status</label>
                  <select
                    value={node.status}
                    onChange={(e) => updateNode(node.id, { status: e.target.value as NodeStatus })}
                    className="w-full bg-card border border-line rounded-lg px-2 py-1.5 text-xs mt-0.5 outline-none focus:border-accent"
                    style={{ color }}
                  >
                    {ALL_STATUSES.map((s) => (
                      <option key={s} value={s}>{statusLabel(s)}</option>
                    ))}
                  </select>
                </div>
                <div className="flex-1">
                  <label className="text-muted text-[10px]">Priority</label>
                  <select
                    value={node.priority}
                    onChange={(e) => updateNode(node.id, { priority: e.target.value as Priority })}
                    className="w-full bg-card border border-line rounded-lg px-2 py-1.5 text-xs mt-0.5 outline-none focus:border-accent"
                    style={{ color: priorityColor(node.priority) }}
                  >
                    {ALL_PRIORITIES.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </Section>

          {/* Inbox cross-team meta */}
          {node.inboxMeta && (
            <Section title="Cross-Team Origin">
              <div className="bg-card border border-line rounded-lg p-2.5 space-y-1 text-xs">
                <div>
                  <span className="text-muted text-[10px]">Source node ID: </span>
                  <span className="text-ink font-mono text-[10px]">{node.inboxMeta.sourceNodeId}</span>
                </div>
                {node.inboxMeta.message && (
                  <div>
                    <div className="text-muted text-[10px] mb-0.5">Message</div>
                    <div className="text-ink text-[11px] italic">"{node.inboxMeta.message}"</div>
                  </div>
                )}
              </div>
            </Section>
          )}

          {/* Prompt */}
          <Section title="Prompt">
            <textarea
              value={node.prompt.task}
              onChange={(e) => updateNode(node.id, { prompt: { ...node.prompt, task: e.target.value } })}
              rows={4}
              className="w-full bg-card border border-line rounded-lg px-2.5 py-2 text-ink text-xs outline-none focus:border-accent resize-none"
              placeholder="Task description…"
            />
            <div className="flex gap-2 mt-1.5 flex-wrap">
              <button
                onClick={addRefinement}
                className="text-[10px] text-accent hover:text-blue-400 transition-colors"
              >
                + Refinement
              </button>
              <button
                onClick={addComment}
                className="text-[10px] text-muted hover:text-ink transition-colors"
              >
                + Comment
              </button>
              <button
                onClick={() => setShowPromptModal(true)}
                className="text-[10px] text-muted hover:text-ink transition-colors ml-auto"
              >
                View assembled prompt
              </button>
            </div>

            {node.prompt.refinements.length > 0 && (
              <div className="mt-2 space-y-1">
                {node.prompt.refinements.map((r, i) => (
                  <div key={i} className="bg-card/50 border border-line rounded-lg p-2">
                    <div className="text-muted text-[9px] mb-0.5">{r.author} · {new Date(r.ts).toLocaleString()}</div>
                    <div className="text-accent text-[10px]">{r.text}</div>
                  </div>
                ))}
              </div>
            )}
            {node.prompt.comments.length > 0 && (
              <div className="mt-2 space-y-1">
                {node.prompt.comments.map((c, i) => (
                  <div key={i} className="bg-card/50 border border-line rounded-lg p-2">
                    <div className="text-muted text-[9px] mb-0.5">{c.author} · {new Date(c.ts).toLocaleString()}</div>
                    <div className="text-ink text-[10px]">{c.text}</div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Executor */}
          <Section title="Executor">
            <div className="space-y-2">
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-muted text-[10px]">Provider</label>
                  <select
                    value={node.executor.provider}
                    onChange={(e) =>
                      updateNode(node.id, { executor: { ...node.executor, provider: e.target.value as Provider } })
                    }
                    className="w-full bg-card border border-line rounded-lg px-2 py-1.5 text-ink text-xs mt-0.5 outline-none focus:border-accent"
                  >
                    {ALL_PROVIDERS.map((p) => (
                      <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                    ))}
                  </select>
                </div>
                <div className="flex-1">
                  <label className="text-muted text-[10px]">Model</label>
                  <input
                    value={node.executor.model}
                    onChange={(e) =>
                      updateNode(node.id, { executor: { ...node.executor, model: e.target.value } })
                    }
                    className="w-full bg-card border border-line rounded-lg px-2 py-1.5 text-ink text-xs mt-0.5 outline-none focus:border-accent"
                  />
                </div>
              </div>
              <div>
                <label className="text-muted text-[10px]">Skills</label>
                <div className="bg-card border border-line rounded-lg px-2 py-1.5 mt-0.5">
                  <ChipInput
                    value={node.executor.skills}
                    onChange={(v) => updateNode(node.id, { executor: { ...node.executor, skills: v } })}
                    placeholder="Add skill…"
                  />
                </div>
              </div>
              <div>
                <label className="text-muted text-[10px]">Tools</label>
                <div className="bg-card border border-line rounded-lg px-2 py-1.5 mt-0.5">
                  <ChipInput
                    value={node.executor.tools}
                    onChange={(v) => updateNode(node.id, { executor: { ...node.executor, tools: v } })}
                    placeholder="Add tool…"
                  />
                </div>
              </div>
              <div>
                <label className="text-muted text-[10px]">Max Iterations</label>
                <input
                  type="number"
                  value={node.executor.maxIterations}
                  onChange={(e) =>
                    updateNode(node.id, { executor: { ...node.executor, maxIterations: parseInt(e.target.value) || 1 } })
                  }
                  className="w-24 bg-card border border-line rounded-lg px-2 py-1.5 text-ink text-xs mt-0.5 outline-none focus:border-accent"
                />
              </div>
            </div>
          </Section>

          {/* Context */}
          <Section title="Context">
            <div>
              <label className="text-muted text-[10px]">Files / Globs</label>
              <div className="space-y-1 mt-1">
                {node.context.files.map((f, i) => (
                  <div key={i} className="flex gap-1 items-center">
                    <select
                      value={f.kind}
                      onChange={(e) => {
                        const files = [...node.context.files];
                        files[i] = { ...files[i], kind: e.target.value as 'file' | 'glob' };
                        updateNode(node.id, { context: { ...node.context, files } });
                      }}
                      className="bg-card border border-line rounded-md px-1.5 py-1 text-muted text-[10px] outline-none"
                    >
                      <option value="file">file</option>
                      <option value="glob">glob</option>
                    </select>
                    <input
                      value={f.path}
                      onChange={(e) => {
                        const files = [...node.context.files];
                        files[i] = { ...files[i], path: e.target.value };
                        updateNode(node.id, { context: { ...node.context, files } });
                      }}
                      className="flex-1 bg-card border border-line rounded-md px-2 py-1 text-ink text-[11px] outline-none focus:border-accent"
                    />
                    <button
                      onClick={() => {
                        const files = node.context.files.filter((_, j) => j !== i);
                        updateNode(node.id, { context: { ...node.context, files } });
                      }}
                      className="text-muted hover:text-err text-xs"
                    >×</button>
                  </div>
                ))}
                <button
                  onClick={() => {
                    updateNode(node.id, {
                      context: { ...node.context, files: [...node.context.files, { path: '', kind: 'file' }] },
                    });
                  }}
                  className="text-[10px] text-accent hover:text-blue-400 transition-colors"
                >
                  + Add file
                </button>
              </div>
            </div>
            <div className="mt-2">
              <label className="text-muted text-[10px]">Extra context</label>
              <textarea
                value={node.context.extra}
                onChange={(e) => updateNode(node.id, { context: { ...node.context, extra: e.target.value } })}
                rows={2}
                className="w-full bg-card border border-line rounded-lg px-2.5 py-1.5 text-ink text-xs mt-0.5 outline-none focus:border-accent resize-none"
              />
            </div>
          </Section>

          {/* Owners */}
          <Section title="Owners">
            <div className="space-y-1.5">
              <div>
                <label className="text-muted text-[10px]">Author</label>
                <input
                  value={node.owners.author}
                  onChange={(e) =>
                    updateNode(node.id, { owners: { ...node.owners, author: e.target.value } })
                  }
                  className="w-full bg-card border border-line rounded-lg px-2.5 py-1.5 text-ink text-xs mt-0.5 outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className="text-muted text-[10px]">Responsible</label>
                <div className="bg-card border border-line rounded-lg px-2 py-1.5 mt-0.5">
                  <ChipInput
                    value={node.owners.responsible}
                    onChange={(v) => updateNode(node.id, { owners: { ...node.owners, responsible: v } })}
                    placeholder="Add email…"
                  />
                </div>
              </div>
            </div>
          </Section>

          {/* Output (read-only) */}
          {(node.output.summary || node.output.results.length > 0) && (
            <Section title="Output">
              {node.output.summary && (
                <div
                  className="border rounded-lg p-2.5 mb-2"
                  style={{
                    backgroundColor: node.status === 'failed' ? 'rgba(248,113,113,0.08)' : 'rgba(52,211,153,0.08)',
                    borderColor: node.status === 'failed' ? 'rgba(248,113,113,0.2)' : 'rgba(52,211,153,0.2)',
                  }}
                >
                  <div
                    className="text-[11px]"
                    style={{ color: node.status === 'failed' ? '#F87171' : '#34D399' }}
                  >
                    {node.output.summary}
                  </div>
                </div>
              )}
              {node.output.results.length > 0 && (
                <div className="space-y-1">
                  {node.output.results.map((r, i) => (
                    <div key={i} className="flex items-start gap-1.5">
                      <div className="w-1 h-1 rounded-full bg-ok mt-1.5 shrink-0" />
                      <span className="text-ink text-[11px]">{r}</span>
                    </div>
                  ))}
                </div>
              )}
              {node.output.artifacts.length > 0 && (
                <div className="mt-2">
                  <div className="text-muted text-[9px] mb-1">Artifacts</div>
                  {node.output.artifacts.map((a, i) => (
                    <div key={i} className="text-accent text-[10px] font-mono">{a}</div>
                  ))}
                </div>
              )}
            </Section>
          )}

          {/* History */}
          {history.length > 0 && (
            <Section title={`History (${history.length})`}>
              <div className="bg-card border border-line rounded-lg px-2 py-1">
                {[...history].reverse().map((entry, i) => (
                  <HistoryRow key={i} entry={entry} nodeName={node.name} />
                ))}
              </div>
            </Section>
          )}
        </div>

        {/* Actions footer */}
        <div className="border-t border-line p-3 space-y-2">
          {/* Gate approval buttons */}
          {node.status === 'needs_approval' && (
            <div className="flex gap-2">
              <button
                onClick={() => approveGate(node.id)}
                className="flex-1 py-1.5 rounded-lg text-xs font-semibold bg-ok/20 hover:bg-ok/30 text-ok transition-colors"
              >
                ✓ Approve
              </button>
              {upstreamId && (
                <button
                  onClick={() => requestChanges(node.id, upstreamId)}
                  className="flex-1 py-1.5 rounded-lg text-xs font-semibold bg-warn/20 hover:bg-warn/30 text-warn transition-colors"
                >
                  ↩ Request Changes
                </button>
              )}
            </div>
          )}

          {/* Inbox-specific: Convert to worker */}
          {node.type === 'inbox' && (
            <button
              onClick={handleConvertToWorker}
              className="w-full py-1.5 rounded-lg text-xs font-semibold bg-warn/15 hover:bg-warn/25 text-warn transition-colors border border-warn/20"
            >
              ⚙ Convert to Worker
            </button>
          )}

          {/* Run button */}
          {node.status !== 'running' && node.status !== 'needs_approval' && (
            <button
              onClick={() => runNode(node.id)}
              className="w-full py-1.5 rounded-lg text-xs font-semibold bg-accent/20 hover:bg-accent/30 text-accent transition-colors"
            >
              {node.type === 'gate' ? '▶ Start Review' : '▶ Run Node'}
            </button>
          )}

          {/* Send to team */}
          <button
            onClick={() => setShowSendModal(true)}
            className="w-full py-1.5 rounded-lg text-xs font-medium bg-card hover:bg-line text-muted hover:text-ink transition-colors border border-line"
          >
            📤 Send to Team…
          </button>

          {/* Save as template */}
          <button
            onClick={handleSaveAsTemplate}
            className="w-full py-1.5 rounded-lg text-xs font-medium bg-card hover:bg-line text-muted hover:text-ink transition-colors border border-line"
          >
            Save as Template
          </button>
        </div>
      </aside>

      {/* Modals */}
      {showSendModal && (
        <SendToTeamModal node={node} onClose={() => setShowSendModal(false)} />
      )}
      {showPromptModal && (
        <AssembledPromptModal
          prompt={getAssembledPrompt()}
          onClose={() => setShowPromptModal(false)}
        />
      )}
    </>
  );
}
