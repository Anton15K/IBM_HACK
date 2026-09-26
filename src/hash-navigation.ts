import { useStore } from './store';

export interface NavigationHost {
  location: { hash: string };
  history: {
    pushState(data: unknown, unused: string, url: string): void;
    replaceState(data: unknown, unused: string, url: string): void;
  };
  addEventListener(type: 'hashchange', listener: () => void): void;
  removeEventListener(type: 'hashchange', listener: () => void): void;
}

function parseHash(hash: string): { team: string | null; graph: string | null } {
  const match = /^#\/teams\/([^/]+)(?:\/projects\/([^/]+))?$/.exec(hash);
  try {
    return match
      ? { team: decodeURIComponent(match[1]!), graph: match[2] ? decodeURIComponent(match[2]) : null }
      : { team: null, graph: null };
  } catch {
    return { team: null, graph: null };
  }
}

function currentHash(): string {
  const state = useStore.getState();
  if (!state.navigationId) return '#/';
  return `#/teams/${encodeURIComponent(state.navigationId)}` +
    (state.selectedGraphId ? `/projects/${encodeURIComponent(state.selectedGraphId)}` : '');
}

/** URL navigation uses only the authenticated project returned by the server. */
export function connectHashNavigation(host: NavigationHost): () => void {
  let session: string | null = null;
  let applying = false;
  const write = (replace: boolean) => {
    const hash = currentHash();
    if (hash !== host.location.hash)
      host.history[replace ? 'replaceState' : 'pushState'](null, '', hash);
  };
  const applyHash = () => {
    const state = useStore.getState();
    if (!state.auth || state.loading) return;
    const route = parseHash(host.location.hash);
    const team = state.teams.find(t => t.id === route.team);
    applying = true;
    try {
      state.navigate(team?.id ?? null);
      if (team && route.graph) useStore.getState().selectGraph(route.graph);
    } finally { applying = false; }
    // Unknown teams and projects never request data outside the loaded scope.
    write(true);
  };
  const sync = () => {
    if (applying) return;
    const state = useStore.getState();
    if (!state.auth) {
      // Keep an initial deep link through login, but discard the previous
      // account's route immediately on logout/401/account switch.
      if (session !== null) host.history.replaceState(null, '', '#/');
      session = null;
      return;
    }
    if (state.loading) return;
    const nextSession = `${state.auth.organization.id}:${state.auth.user.id}`;
    if (session !== nextSession) {
      if (session !== null) host.history.replaceState(null, '', '#/');
      session = nextSession;
      applyHash();
      return;
    }
    if (state.navigationId && !state.teams.some(t => t.id === state.navigationId)) {
      applying = true;
      try { state.navigate(null); } finally { applying = false; }
      write(true);
      return;
    }
    write(false);
  };
  const unsubscribe = useStore.subscribe(sync);
  host.addEventListener('hashchange', applyHash);
  sync();
  return () => {
    unsubscribe();
    host.removeEventListener('hashchange', applyHash);
  };
}
