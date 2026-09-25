import { useCallback, useRef } from 'react';
import TopBar from './components/TopBar';
import Sidebar from './components/Sidebar';
import FlowCanvas from './components/FlowCanvas';
import Inspector from './components/Inspector';
import TemplatesDrawer from './components/TemplatesDrawer';
import SettingsModal from './components/SettingsModal';
import { useStore } from './store';

export default function App() {
  const showTemplatesDrawer = useStore((s) => s.showTemplatesDrawer);
  const showSettings = useStore((s) => s.showSettings);
  const selectedNodeId = useStore((s) => s.selectedNodeId);

  // Ref to pan/zoom canvas to a team
  const panToTeamRef = useRef<((teamId: string) => void) | null>(null);

  const handlePanToTeam = useCallback((teamId: string) => {
    panToTeamRef.current?.(teamId);
  }, []);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-canvas font-sans">
      <TopBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar onSelectTeam={handlePanToTeam} />
        <div className="flex-1 relative overflow-hidden">
          <FlowCanvas panToTeamRef={panToTeamRef} />
        </div>
        {selectedNodeId && (
          <Inspector />
        )}
      </div>
      {showTemplatesDrawer && <TemplatesDrawer />}
      {showSettings && <SettingsModal />}
    </div>
  );
}
