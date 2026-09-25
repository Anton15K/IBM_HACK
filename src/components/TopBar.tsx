import { useRef } from 'react';
import { useStore } from '../store';

export default function TopBar() {
  const runningGraphTeamId = useStore((s) => s.runningGraphTeamId);
  const selectedTeamId = useStore((s) => s.selectedTeamId);
  const runGraph = useStore((s) => s.runGraph);
  const toggleTemplatesDrawer = useStore((s) => s.toggleTemplatesDrawer);
  const toggleSettings = useStore((s) => s.toggleSettings);
  const exportProject = useStore((s) => s.exportProject);
  const importProject = useStore((s) => s.importProject);
  const resetToSeed = useStore((s) => s.resetToSeed);
  const importRef = useRef<HTMLInputElement>(null);

  const handleRunGraph = () => {
    const teamId = selectedTeamId ?? 'team-security';
    runGraph(teamId);
  };

  const handleExport = () => {
    const project = exportProject();
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'teamweave-project.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const project = JSON.parse(ev.target?.result as string);
        importProject(project);
      } catch {
        alert('Invalid project file');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <header className="flex items-center h-12 px-4 bg-panel border-b border-line gap-3 shrink-0 z-50">
      {/* Logo */}
      <div className="flex items-center gap-2 mr-4">
        <div className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="4" cy="4" r="2" fill="white" />
            <circle cx="12" cy="4" r="2" fill="white" />
            <circle cx="4" cy="12" r="2" fill="white" />
            <circle cx="12" cy="12" r="2" fill="white" />
            <line x1="4" y1="4" x2="12" y2="4" stroke="white" strokeWidth="1.5" />
            <line x1="4" y1="4" x2="4" y2="12" stroke="white" strokeWidth="1.5" />
            <line x1="4" y1="12" x2="12" y2="12" stroke="white" strokeWidth="1.5" />
          </svg>
        </div>
        <span className="text-ink font-semibold text-sm tracking-tight">TeamWeave</span>
      </div>

      {/* Run Graph */}
      <button
        onClick={handleRunGraph}
        disabled={!!runningGraphTeamId}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors"
      >
        {runningGraphTeamId ? (
          <>
            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
            Running…
          </>
        ) : (
          <>
            <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
              <path d="M1 1L9 6L1 11V1Z" fill="white" />
            </svg>
            Run Graph
          </>
        )}
      </button>

      {/* Templates */}
      <button
        onClick={toggleTemplatesDrawer}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-card hover:bg-line text-muted hover:text-ink text-xs font-medium transition-colors border border-line"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <rect x="1" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <rect x="7" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <rect x="1" y="7" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <rect x="7" y="7" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        Templates
      </button>

      <div className="flex-1" />

      {/* Export */}
      <button
        onClick={handleExport}
        className="px-2.5 py-1.5 rounded-lg bg-card hover:bg-line text-muted hover:text-ink text-xs font-medium transition-colors border border-line"
      >
        Export JSON
      </button>

      {/* Import */}
      <button
        onClick={() => importRef.current?.click()}
        className="px-2.5 py-1.5 rounded-lg bg-card hover:bg-line text-muted hover:text-ink text-xs font-medium transition-colors border border-line"
      >
        Import JSON
      </button>
      <input ref={importRef} type="file" accept=".json" className="hidden" onChange={handleImport} />

      {/* Reset — danger style */}
      <button
        onClick={() => { if (confirm('Reset all data to seed project? This cannot be undone.')) resetToSeed(); }}
        className="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors"
        style={{
          background: 'rgba(248,113,113,0.10)',
          color: '#F87171',
          border: '1px solid rgba(248,113,113,0.30)',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(248,113,113,0.20)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(248,113,113,0.10)'; }}
      >
        Reset
      </button>

      {/* Settings */}
      <button
        onClick={toggleSettings}
        className="p-1.5 rounded-lg bg-card hover:bg-line text-muted hover:text-ink transition-colors border border-line"
        title="Settings"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.6 2.6l1.1 1.1M10.3 10.3l1.1 1.1M2.6 11.4l1.1-1.1M10.3 3.7l1.1-1.1"
            stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>
    </header>
  );
}
