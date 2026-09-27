import { create, type UseBoundStore, type StoreApi } from 'zustand';
import { api, ApiError } from './api';
import {
  effectiveRole,
  mergePatch,
  nodeDefinition,
  templateDefinition,
  type Auth,
} from './client-helpers';
import type { WorkerNode, GraphContext, NodeTemplate, Project, Team } from './types';
export interface Capabilities {
  providers: string[];
  outputModes: string[];
  bobConfigured: boolean;
  workspaceRootsConfigured: boolean;
  maxCost: { default: number; max: number };
}
export interface GraphRun {
  id: string;
  graphId: string;
  status: string;
  paused: boolean;
  reworkRounds: number;
}
type Patch = Record<string, unknown>;
const empty: Project = {
  version: 1,
  teams: [],
  nodes: [],
  graphContexts: [],
  templates: [],
};
interface State extends Project {
  auth: Auth | null;
  loading: boolean;
  error: string | null;
  capabilities: Capabilities | null;
  navigationId: string | null;
  selectedTeamId: string | null;
  selectedGraphId: string | null;
  selectedNodeId: string | null;
  showTemplatesDrawer: boolean;
  showSettings: boolean;
  showAdmin: boolean;
  busy: string[];
  graphRun: GraphRun | null;
  bootstrap: () => Promise<void>;
  authenticate: (mode: string, body: unknown) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  navigate: (id: string | null) => void;
  selectTeam: (id: string | null) => void;
  selectGraph: (id: string) => void;
  selectNode: (id: string | null) => void;
  canEdit: (teamId: string) => boolean;
  updateNode: (
    id: string,
    patch: Partial<WorkerNode> | { workspace: null },
  ) => void;
  updateGraph: (id: string, patch: Partial<GraphContext>) => void;
  createNode: (type?: WorkerNode['type'], position?: { x: number; y: number }) => Promise<void>;
  createTeam: (
    name: string,
    kind: 'department' | 'team',
    parentId?: string | null,
    position?: { x: number; y: number },
  ) => Promise<Team | null>;
  updateTeam: (
    id: string,
    patch: { name?: string; currentTaskLabel?: string; space?: Partial<Team['space']> },
  ) => void;
  removeNode: (id: string) => Promise<void>;
  addEdge: (from: string, to: string) => void;
  removeEdge: (from: string, to: string) => void;
  runNode: (id: string) => Promise<void>;
  cancelNode: (id: string) => Promise<void>;
  approveGate: (id: string) => Promise<void>;
  requestChanges: (
    id: string,
    target: string,
    feedback: string,
  ) => Promise<void>;
  runGraph: () => Promise<void>;
  resumeGraph: () => Promise<void>;
  cancelGraph: () => Promise<void>;
  addTemplate: (
    tpl: Pick<NodeTemplate, 'name' | 'description' | 'defaults'>,
  ) => Promise<boolean>;
  applyTemplate: (id: string, teamId: string) => Promise<boolean>;
  toggleTemplatesDrawer: () => void;
  toggleSettings: () => void;
  exportProject: () => Project;
}
let generation = 0;
let actionGeneration = 0;
let revision = -1;
let refreshing: Promise<void> | null = null;
const pending = new Map<string, Patch>();
const saving = new Map<string, Promise<void>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const failed = new Map<string, Error>();
function requireSessionBootstrap(expected: number) {
  if (expected !== generation)
    throw new Error('Session changed; stale response ignored');
}
function clearSession() {
  generation++;
  revision = -1;
  refreshing = null;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  pending.clear();
  saving.clear();
  failed.clear();
  useStore.setState({
    ...empty,
    loading: false,
    auth: null,
    capabilities: null,
    selectedNodeId: null,
    selectedTeamId: null,
    selectedGraphId: null,
    navigationId: null,
    busy: [],
    graphRun: null,
    showAdmin: false,
    showSettings: false,
    showTemplatesDrawer: false,
  });
}
export async function sessionRequest<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const current = generation;
  try {
    const result = await api<T>(path, method, body);
    if (current !== generation)
      throw new Error('Session changed; stale response ignored');
    return result;
  } catch (error) {
    if (
      current === generation &&
      error instanceof ApiError &&
      error.status === 401 &&
      path !== '/auth/login' &&
      path !== '/auth/register'
    )
      clearSession();
    throw error;
  }
}
export const sessionGeneration = () => generation;
export function requireSession(expected: number) {
  if (expected !== generation || !useStore.getState().auth)
    throw new Error('Session changed; action canceled');
}
function report(error: unknown) {
  useStore.setState({
    error: error instanceof Error ? error.message : String(error),
  });
}
function authorOverlay(key: string): Patch {
  return pending.get(key) ?? {};
}
function applyProject(project: Project & { revision?: number }) {
  if ((project.revision ?? 0) < revision) return;
  revision = project.revision ?? revision;
  const state = useStore.getState();
  useStore.setState({
    ...project,
    teams: project.teams.map((t) =>
      mergePatch(t, authorOverlay(`teams/${t.id}`)),
    ),
    nodes: project.nodes.map((n) =>
      mergePatch(n, authorOverlay(`nodes/${n.id}`)),
    ),
    graphContexts: project.graphContexts.map((g) =>
      mergePatch(g, authorOverlay(`graphs/${g.id}`)),
    ),
    selectedNodeId: project.nodes.some((n) => n.id === state.selectedNodeId)
      ? state.selectedNodeId
      : null,
  });
}
function acceptCreatedNode(node: WorkerNode & { revision?: number }) {
  revision = Math.max(revision, node.revision ?? revision);
  useStore.setState((s) => ({
    nodes: [...s.nodes.filter((n) => n.id !== node.id), node],
  }));
}
export function acceptCreatedGraph(
  graph: GraphContext & { revision?: number },
) {
  revision = Math.max(revision, graph.revision ?? revision);
  useStore.setState((s) => ({
    graphContexts: [...s.graphContexts.filter((g) => g.id !== graph.id), graph],
  }));
}
export async function flushEdits(): Promise<void> {
  const current = generation;
  for (const key of [...pending.keys(), ...saving.keys()]) {
    requireSession(current);
    await save(key);
  }
  requireSession(current);
  const error = failed.values().next().value;
  if (error) {
    failed.clear();
    throw error;
  }
}
async function save(key: string): Promise<void> {
  const current = generation;
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
  if (saving.has(key)) {
    await saving.get(key);
    if (current !== generation) return;
    if (pending.has(key)) await save(key);
    return;
  }
  const patch = pending.get(key);
  if (!patch) return;
  const promise = (async () => {
    try {
      const result = await sessionRequest<
        (WorkerNode | GraphContext | Team) & { revision?: number }
      >(`/${key}`, 'PATCH', patch);
      if (current !== generation) return;
      const fresh = (result.revision ?? revision) >= revision;
      revision = Math.max(revision, result.revision ?? revision);
      if (pending.get(key) === patch) pending.delete(key);
      const [kind, id] = key.split('/');
      if (!fresh) return;
      useStore.setState((s) =>
        kind === 'nodes'
          ? {
              nodes: s.nodes.map((n) =>
                n.id === id
                  ? mergePatch(result as WorkerNode, authorOverlay(key))
                  : n,
              ),
            }
          : kind === 'teams'
            ? {
                teams: s.teams.map((t) =>
                  t.id === id
                    ? mergePatch(result as Team, authorOverlay(key))
                    : t,
                ),
              }
            : {
                graphContexts: s.graphContexts.map((g) =>
                  g.id === id
                    ? mergePatch(result as GraphContext, authorOverlay(key))
                    : g,
                ),
              },
      );
    } catch (error) {
      if (current !== generation) return;
      if (pending.get(key) === patch) pending.delete(key);
      failed.set(key, error as Error);
      report(error);
      if (refreshing) await refreshing;
      if (current === generation) await useStore.getState().refresh();
    }
  })();
  saving.set(key, promise);
  await promise;
  if (current !== generation) return;
  saving.delete(key);
  if (pending.has(key)) await save(key);
}
function queue(key: string, patch: Patch) {
  failed.delete(key);
  pending.set(key, mergePatch(pending.get(key) ?? {}, patch));
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.set(
    key,
    setTimeout(() => {
      void save(key).catch(report);
    }, 400),
  );
}
async function action(key: string, operation: () => Promise<unknown>) {
  if (useStore.getState().busy.includes(key)) return;
  const current = generation;
  const currentAction = actionGeneration;
  useStore.setState((s) => ({ busy: [...s.busy, key], error: null }));
  try {
    await flushEdits();
    requireSession(current);
    if (currentAction !== actionGeneration) return;
    await operation();
    requireSession(current);
    await useStore.getState().refresh();
  } catch (error) {
    if (current === generation) report(error);
  } finally {
    if (current === generation)
      useStore.setState((s) => ({ busy: s.busy.filter((k) => k !== key) }));
  }
}
const graphAction = (suffix: string): Promise<void> => {
  const id = useStore.getState().selectedGraphId;
  return id
    ? action(`graph:${id}`, () =>
        sessionRequest(`/graphs/${id}/${suffix}`, 'POST'),
      )
    : Promise.resolve();
};
export const useStore: UseBoundStore<StoreApi<State>> = create<State>(
  (set, get) => ({
    ...empty,
    auth: null,
    loading: true,
    error: null,
    capabilities: null,
    navigationId: null,
    selectedTeamId: null,
    selectedGraphId: null,
    selectedNodeId: null,
    showTemplatesDrawer: false,
    showSettings: false,
    showAdmin: false,
    busy: [],
    graphRun: null,
    bootstrap: async () => {
      const current = generation;
      set({ loading: true, error: null });
      try {
        const auth = await sessionRequest<Auth>('/auth/me');
        requireSessionBootstrap(current);
        set({ auth });
        await get().refresh();
        requireSessionBootstrap(current);
        const capabilities =
          await sessionRequest<Capabilities>('/capabilities');
        requireSessionBootstrap(current);
        set({ capabilities });
      } catch (error) {
        if (
          !(error instanceof ApiError && error.status === 401) &&
          current === generation
        )
          report(error);
      } finally {
        if (current === generation) set({ loading: false });
      }
    },
    authenticate: async (mode, body) => {
      clearSession();
      const current = generation;
      set({ loading: true, error: null });
      try {
        const auth = await sessionRequest<Auth>(`/auth/${mode}`, 'POST', body);
        requireSessionBootstrap(current);
        set({ auth });
        await get().refresh();
        const capabilities =
          await sessionRequest<Capabilities>('/capabilities');
        requireSessionBootstrap(current);
        set({ capabilities });
      } catch (error) {
        if (current === generation) report(error);
      } finally {
        if (current === generation) set({ loading: false });
      }
    },
    logout: async () => {
      if (get().loading) return;
      let current = generation;
      // Cancel queued actions while edits drain in the still-valid session.
      actionGeneration++;
      set({ loading: true, error: null });
      try {
        await flushEdits();
        requireSession(current);
        await sessionRequest('/auth/logout', 'POST');
        requireSession(current);
        clearSession();
        current = generation;
      } catch (error) {
        if (current === generation) report(error);
      } finally {
        if (current === generation) set({ loading: false });
      }
    },
    refresh: async () => {
      if (!get().auth) return;
      if (refreshing) return refreshing;
      const current = generation;
      const task = (async () => {
        try {
          const project = await sessionRequest<Project & { revision: number }>(
            '/project',
          );
          requireSession(current);
          applyProject(project);
          const graph = get().selectedGraphId;
          if (graph) {
            const run = await sessionRequest<GraphRun | null>(
              `/graphs/${graph}/run`,
            );
            if (current === generation && get().selectedGraphId === graph)
              set({ graphRun: run });
          }
        } catch (error) {
          if (current === generation) report(error);
        }
      })();
      refreshing = task;
      await task;
      if (current === generation) refreshing = null;
    },
    navigate: (id) => {
      const team = get().teams.find((t) => t.id === id);
      // Old organization URLs resolve to the implicit account home.
      if (team?.kind === 'organization') id = null;
      const isTeam =
        team && (team.kind === 'team' || (!team.kind && team.space.w > 0));
      set({
        navigationId: id,
        selectedTeamId: isTeam ? id : null,
        selectedGraphId: isTeam
          ? (get().graphContexts.find((g) => g.teamId === id)?.id ?? null)
          : null,
        selectedNodeId: null,
        graphRun: null,
      });
    },
    selectTeam: (id) => get().navigate(id),
    selectGraph: (id) => {
      if (
        get().graphContexts.some(
          (g) => g.id === id && g.teamId === get().selectedTeamId,
        )
      )
        set({ selectedGraphId: id, selectedNodeId: null, graphRun: null });
    },
    selectNode: (id) => {
      const node = get().nodes.find((n) => n.id === id);
      if (node && node.teamId === get().selectedTeamId)
        set({ selectedNodeId: id, selectedGraphId: node.graphId });
      else set({ selectedNodeId: null });
    },
    canEdit: (id) =>
      ['admin', 'editor'].includes(
        effectiveRole(get().auth, get().teams, id) ?? '',
      ),
    updateNode: (id, patch) => {
      const node = get().nodes.find((n) => n.id === id);
      if (!node || !get().canEdit(node.teamId)) return;
      const definition = nodeDefinition(patch as Partial<WorkerNode>);
      set({
        nodes: get().nodes.map((n) =>
          n.id === id ? mergePatch(n, definition) : n,
        ),
      });
      queue(`nodes/${id}`, definition);
    },
    updateGraph: (id, patch) => {
      const graph = get().graphContexts.find((g) => g.id === id);
      if (!graph || !get().canEdit(graph.teamId)) return;
      set({
        graphContexts: get().graphContexts.map((g) =>
          g.id === id ? mergePatch(g, patch) : g,
        ),
      });
      queue(`graphs/${id}`, patch);
    },
    createNode: async (type = 'worker', position?: { x: number; y: number }) => {
      const { selectedTeamId: teamId, selectedGraphId: graphId } = get();
      if (!teamId || !graphId || !get().canEdit(teamId)) return;
      await action('createNode', async () => {
        const node = await sessionRequest<WorkerNode>('/nodes', 'POST', {
          teamId,
          graphId,
          name: type === 'gate' ? 'Human review' : 'New task',
          type,
          position: position ?? {
            x:
              80 +
              get().nodes.filter((n) => n.graphId === graphId).length * 240,
            y: 80,
          },
        });
        const current = generation;
        acceptCreatedNode(node);
        await get().refresh();
        requireSession(current);
        get().selectNode(node.id);
      });
    },
    createTeam: async (name, kind, parentId, position) => {
      if (get().auth?.role !== 'admin') return null;
      const current = generation;
      let created: Team | null = null;
      await action('createTeam', async () => {
        const body: Record<string, unknown> = { name, kind };
        if (parentId !== undefined) body.parentId = parentId;
        if (position !== undefined) body.space = { x: position.x, y: position.y };
        const team = await sessionRequest<Team & { revision?: number }>(
          '/teams',
          'POST',
          body,
        );
        // A poll begun before POST may omit both the team and its default graph.
        // Drain it so action() performs a genuinely post-create refresh.
        if (refreshing) await refreshing;
        requireSession(current);
        created = team;
      });
      return current === generation ? created : null;
    },
    updateTeam: (id, patch) => {
      const role = effectiveRole(get().auth, get().teams, id);
      if (!role || role === 'viewer') return;
      if (patch.name !== undefined && role !== 'admin') return;
      const team = get().teams.find((t) => t.id === id);
      if (!team) return;
      const spacePatch: Partial<Team['space']> = patch.space ?? {};
      const mergedSpace: Team['space'] = {
        x: spacePatch.x ?? team.space.x,
        y: spacePatch.y ?? team.space.y,
        w: spacePatch.w ?? team.space.w,
        h: spacePatch.h ?? team.space.h,
      };
      const optimistic: Partial<Team> = {};
      if (patch.name !== undefined) optimistic.name = patch.name;
      if (patch.currentTaskLabel !== undefined)
        optimistic.currentTaskLabel = patch.currentTaskLabel;
      if (patch.space !== undefined) optimistic.space = mergedSpace;
      set({
        teams: get().teams.map((t) =>
          t.id === id ? mergePatch(t, optimistic) : t,
        ),
      });
      const serverPatch: Record<string, unknown> = {};
      if (patch.name !== undefined) serverPatch.name = patch.name;
      if (patch.currentTaskLabel !== undefined)
        serverPatch.currentTaskLabel = patch.currentTaskLabel;
      if (patch.space !== undefined) serverPatch.space = spacePatch;
      queue(`teams/${id}`, serverPatch);
    },
    removeNode: (id) =>
      action(id, () => sessionRequest(`/nodes/${id}`, 'DELETE')),
    addEdge: (from, to) => {
      const source = get().nodes.find((n) => n.id === from);
      const target = get().nodes.find((n) => n.id === to);
      if (!source || !target) return;
      if (source.graphId !== target.graphId) {
        set({
          error:
            'Data edges must connect tasks in the same project. Use a team handoff instead.',
        });
        return;
      }
      if (!target.inputs.some((i) => i.fromNodeId === from))
        get().updateNode(to, {
          inputs: [...target.inputs, { fromNodeId: from, enabled: true }],
        });
    },
    removeEdge: (from, to) => {
      const target = get().nodes.find((n) => n.id === to);
      if (target)
        get().updateNode(to, {
          inputs: target.inputs.filter((i) => i.fromNodeId !== from),
        });
    },
    runNode: (id) =>
      action(id, () => sessionRequest(`/nodes/${id}/run`, 'POST')),
    cancelNode: (id) =>
      action(id, () => sessionRequest(`/nodes/${id}/cancel`, 'POST')),
    approveGate: (id) =>
      action(id, () =>
        sessionRequest(`/nodes/${id}/decision`, 'POST', {
          attemptId: get().nodes.find((n) => n.id === id)?.currentAttemptId,
          decision: 'approve',
        }),
      ),
    requestChanges: (id, targetNodeId, feedback) =>
      action(id, () =>
        sessionRequest(`/nodes/${id}/decision`, 'POST', {
          attemptId: get().nodes.find((n) => n.id === id)?.currentAttemptId,
          decision: 'request_changes',
          targetNodeId,
          feedback,
        }),
      ),
    runGraph: () => graphAction('run'),
    resumeGraph: () => graphAction('resume'),
    cancelGraph: () => graphAction('run/cancel'),
    addTemplate: async (tpl) => {
      const current = generation;
      try {
        await flushEdits();
        requireSession(current);
        await sessionRequest('/templates', 'POST', tpl);
        requireSession(current);
        await get().refresh();
        requireSession(current);
        return true;
      } catch (error) {
        if (current === generation) report(error);
        return false;
      }
    },
    applyTemplate: async (id, teamId) => {
      const template = get().templates.find((t) => t.id === id);
      const graph = get().graphContexts.find(
        (g) => g.id === get().selectedGraphId && g.teamId === teamId,
      );
      if (!template || !graph || !get().canEdit(teamId)) return false;
      const current = generation;
      try {
        await flushEdits();
        requireSession(current);
        const node = await sessionRequest<WorkerNode>(
          '/nodes',
          'POST',
          templateDefinition(template, teamId, graph),
        );
        requireSession(current);
        acceptCreatedNode(node);
        await get().refresh();
        requireSession(current);
        get().selectNode(node.id);
        return true;
      } catch (error) {
        if (current === generation) report(error);
        return false;
      }
    },
    toggleTemplatesDrawer: () =>
      set({ showTemplatesDrawer: !get().showTemplatesDrawer }),
    toggleSettings: () => set({ showSettings: !get().showSettings }),
    exportProject: () => ({
      version: get().version,
      teams: get().teams,
      nodes: get().nodes,
      graphContexts: get().graphContexts,
      templates: get().templates,
    }),
  }),
);
