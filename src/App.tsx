import { useEffect } from 'react';
import TopBar from './components/TopBar';
import Sidebar from './components/Sidebar';
import FlowCanvas from './components/FlowCanvas';
import Inspector from './components/Inspector';
import TemplatesDrawer from './components/TemplatesDrawer';
import SettingsModal from './components/SettingsModal';
import AdminModal from './components/AdminModal';
import AuthScreen from './components/AuthScreen';
import { useStore } from './store';
import { connectHashNavigation } from './hash-navigation';
export default function App() {
  const state = useStore();
  useEffect(() => connectHashNavigation(window), []);
  useEffect(() => {
    void useStore.getState().bootstrap();
  }, []);
  useEffect(() => {
    if (!state.auth) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await useStore.getState().refresh();
      if (!disposed) timer = setTimeout(poll, 1500);
    };
    timer = setTimeout(poll, 1500);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [state.auth]);
  if (state.loading)
    return (
      <div className="h-screen bg-canvas text-ink flex items-center justify-center">
        Loading TeamWeave…
      </div>
    );
  if (!state.auth) return <AuthScreen />;
  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-canvas font-sans text-ink">
      <TopBar />
      {state.error && (
        <div
          role="alert"
          className="bg-err/10 text-err px-4 py-2 text-xs flex justify-between"
        >
          {state.error}
          <button onClick={() => useStore.setState({ error: null })}>
            Dismiss
          </button>
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 relative overflow-hidden" aria-labelledby="current-view-heading">
          <h1 id="current-view-heading" className="sr-only">
            {state.selectedTeamId
              ? `${state.teams.find(t => t.id === state.selectedTeamId)?.name ?? 'Team'} — ${state.graphContexts.find(g => g.id === state.selectedGraphId)?.name ?? 'Task board'}`
              : state.teams.find(t => t.id === state.navigationId)?.name ?? 'Company overview'}
          </h1>
          <FlowCanvas key={state.navigationId ?? 'company'} />
        </main>
        {state.selectedNodeId && <Inspector key={state.selectedNodeId} />}
      </div>
      {state.showTemplatesDrawer && <TemplatesDrawer />}
      {state.showSettings && <SettingsModal />}
      {state.showAdmin && <AdminModal />}
    </div>
  );
}
