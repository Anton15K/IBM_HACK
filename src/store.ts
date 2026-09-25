import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { WorkerNode, Team, GraphContext, NodeTemplate, NodeStatus, Project } from './types';
import { SEED_PROJECT } from './seed';

interface AppState {
  // Data
  teams: Team[];
  nodes: WorkerNode[];
  graphContexts: GraphContext[];
  templates: NodeTemplate[];

  // UI
  selectedNodeId: string | null;
  selectedTeamId: string | null;
  showTemplatesDrawer: boolean;
  showSettings: boolean;
  runningGraphTeamId: string | null;

  // Node actions
  selectNode: (id: string | null) => void;
  selectTeam: (id: string | null) => void;
  updateNode: (id: string, patch: Partial<WorkerNode>) => void;
  addNode: (node: WorkerNode) => void;
  removeNode: (id: string) => void;

  // Edge/connection actions
  addEdge: (fromNodeId: string, toNodeId: string) => void;
  removeEdge: (fromNodeId: string, toNodeId: string) => void;

  // Mock executor
  runNode: (id: string) => void;
  approveGate: (id: string) => void;
  requestChanges: (gateId: string, targetNodeId: string) => void;

  // Graph runner
  runGraph: (teamId: string) => void;

  // Templates
  toggleTemplatesDrawer: () => void;
  addTemplate: (tpl: NodeTemplate) => void;
  applyTemplate: (templateId: string, teamId: string) => void;

  // Settings
  toggleSettings: () => void;

  // Persistence
  exportProject: () => Project;
  importProject: (p: Project) => void;
  resetToSeed: () => void;
}

function nodeStatusColor(status: NodeStatus): string {
  switch (status) {
    case 'done': return '#34D399';
    case 'running': return '#60A5FA';
    case 'failed': return '#F87171';
    case 'rework': return '#FBBF24';
    case 'needs_approval': return '#FBBF24';
    case 'blocked': return '#5B7A99';
    case 'ready': return '#5B8CFF';
    case 'queued': return '#8B94A7';
    default: return '#8B94A7';
  }
}

const MOCK_SUMMARIES: Record<string, string> = {
  worker: 'Task completed successfully. All objectives met and documented.',
  inbox: 'Investigation complete. Key findings documented with recommendations.',
};

const MOCK_RESULTS: Record<string, string[]> = {
  worker: ['Primary objective achieved', 'Edge cases handled', 'Documentation updated'],
  inbox: ['Research complete', 'Three approaches evaluated', 'Recommendation provided'],
};

function makeId() {
  return `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      teams: SEED_PROJECT.teams,
      nodes: SEED_PROJECT.nodes,
      graphContexts: SEED_PROJECT.graphContexts,
      templates: SEED_PROJECT.templates,

      selectedNodeId: null,
      selectedTeamId: null,
      showTemplatesDrawer: false,
      showSettings: false,
      runningGraphTeamId: null,

      selectNode: (id) => set({ selectedNodeId: id }),
      selectTeam: (id) => set({ selectedTeamId: id }),

      updateNode: (id, patch) =>
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === id ? { ...n, ...patch } : n
          ),
        })),

      addNode: (node) => set((s) => ({ nodes: [...s.nodes, node] })),

      removeNode: (id) =>
        set((s) => ({
          nodes: s.nodes
            .filter((n) => n.id !== id)
            .map((n) => ({
              ...n,
              inputs: n.inputs.filter((inp) => inp.fromNodeId !== id),
            })),
          selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
        })),

      addEdge: (fromNodeId, toNodeId) =>
        set((s) => ({
          nodes: s.nodes.map((n) => {
            if (n.id !== toNodeId) return n;
            if (n.inputs.some((i) => i.fromNodeId === fromNodeId)) return n;
            return { ...n, inputs: [...n.inputs, { fromNodeId, enabled: true }] };
          }),
        })),

      removeEdge: (fromNodeId, toNodeId) =>
        set((s) => ({
          nodes: s.nodes.map((n) => {
            if (n.id !== toNodeId) return n;
            return { ...n, inputs: n.inputs.filter((i) => i.fromNodeId !== fromNodeId) };
          }),
        })),

      runNode: (id) => {
        const node = get().nodes.find((n) => n.id === id);
        if (!node) return;

        if (node.type === 'gate') {
          get().updateNode(id, { status: 'needs_approval', progress: 100 });
          return;
        }

        get().updateNode(id, { status: 'running', progress: 0 });

        // Tick progress 0 → 100 over ~4s
        let prog = 0;
        const interval = setInterval(() => {
          prog = Math.min(prog + 5, 100);
          get().updateNode(id, { progress: prog });
          if (prog >= 100) {
            clearInterval(interval);
            const n = get().nodes.find((nd) => nd.id === id);
            if (!n) return;
            get().updateNode(id, {
              status: 'done',
              progress: 100,
              output: {
                summary: MOCK_SUMMARIES[n.type] ?? 'Task complete.',
                results: MOCK_RESULTS[n.type] ?? [],
                commands: [],
                artifacts: [`output-${n.name.toLowerCase().replace(/\s+/g, '-')}.md`],
              },
            });
          }
        }, 200);
      },

      approveGate: (id) => {
        get().updateNode(id, { status: 'done', progress: 100 });
      },

      requestChanges: (gateId, targetNodeId) => {
        get().updateNode(gateId, { status: 'done', progress: 100 });
        get().updateNode(targetNodeId, { status: 'rework', progress: 0 });
      },

      runGraph: (teamId) => {
        const { nodes, runNode, updateNode } = get();
        const teamNodes = nodes.filter((n) => n.teamId === teamId);

        // Reset non-done/rework nodes to queued
        teamNodes.forEach((n) => {
          if (!['done', 'rework'].includes(n.status)) {
            updateNode(n.id, { status: 'queued', progress: 0 });
          }
        });

        set({ runningGraphTeamId: teamId });

        const executed = new Set<string>(
          teamNodes.filter((n) => n.status === 'done').map((n) => n.id)
        );

        function tryAdvance() {
          const currentNodes = get().nodes.filter((n) => n.teamId === teamId);
          let launched = false;

          for (const node of currentNodes) {
            if (['done', 'running', 'needs_approval'].includes(node.status)) continue;
            if (node.status === 'rework') continue;

            const enabledInputs = node.inputs.filter((i) => i.enabled);
            const allDone = enabledInputs.every((i) =>
              get().nodes.find((n) => n.id === i.fromNodeId)?.status === 'done'
            );

            if (allDone) {
              launched = true;
              get().runNode(node.id);
              executed.add(node.id);
            }
          }

          // Check if graph is complete or stalled
          const fresh = get().nodes.filter((n) => n.teamId === teamId);
          const allSettled = fresh.every((n) =>
            ['done', 'failed', 'needs_approval', 'rework', 'blocked'].includes(n.status)
          );

          if (!allSettled && launched) {
            setTimeout(tryAdvance, 4500);
          } else {
            set({ runningGraphTeamId: null });
          }
        }

        // Small delay so state settles
        setTimeout(tryAdvance, 100);
      },

      toggleTemplatesDrawer: () =>
        set((s) => ({ showTemplatesDrawer: !s.showTemplatesDrawer })),

      addTemplate: (tpl) =>
        set((s) => ({ templates: [...s.templates.filter((t) => t.id !== tpl.id), tpl] })),

      applyTemplate: (templateId, teamId) => {
        const { templates, teams } = get();
        const tpl = templates.find((t) => t.id === templateId);
        const team = teams.find((t) => t.id === teamId);
        if (!tpl || !team) return;

        const newNode: WorkerNode = {
          id: makeId(),
          graphId: `graph-${teamId}`,
          teamId,
          type: tpl.defaults.type ?? 'worker',
          name: tpl.name,
          status: 'draft',
          priority: tpl.defaults.priority ?? 'normal',
          progress: 0,
          position: { x: 100, y: 100 },
          prompt: tpl.defaults.prompt ?? { task: '', refinements: [], comments: [] },
          executor: tpl.defaults.executor ?? {
            provider: 'mock',
            model: 'mock-v1',
            skills: [],
            tools: [],
            maxIterations: 3,
          },
          context: tpl.defaults.context ?? { files: [], extra: '' },
          owners: { author: 'me@acme.com', responsible: [] },
          inputs: [],
          output: { summary: '', results: [], commands: [], artifacts: [] },
          templateId,
          version: 1,
        };
        get().addNode(newNode);
        get().selectNode(newNode.id);
      },

      toggleSettings: () => set((s) => ({ showSettings: !s.showSettings })),

      exportProject: () => ({
        version: 1,
        teams: get().teams,
        nodes: get().nodes,
        graphContexts: get().graphContexts,
        templates: get().templates,
      }),

      importProject: (p) =>
        set({
          teams: p.teams,
          nodes: p.nodes,
          graphContexts: p.graphContexts,
          templates: p.templates,
          selectedNodeId: null,
          selectedTeamId: null,
        }),

      resetToSeed: () =>
        set({
          teams: SEED_PROJECT.teams,
          nodes: SEED_PROJECT.nodes,
          graphContexts: SEED_PROJECT.graphContexts,
          templates: SEED_PROJECT.templates,
          selectedNodeId: null,
          selectedTeamId: null,
        }),
    }),
    {
      name: 'teamweave-project',
      version: 1,
    }
  )
);

// Helper to get status color (exported for canvas use)
export { nodeStatusColor };
