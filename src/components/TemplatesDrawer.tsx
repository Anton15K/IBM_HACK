import { useStore } from '../store';
import type { Team } from '../types';

// Only leaf teams (with space dimensions)
function getLeafTeams(teams: Team[]): Team[] {
  return teams.filter((t) => t.kind === 'team' && useStore.getState().canEdit(t.id));
}

export default function TemplatesDrawer() {
  const templates = useStore((s) => s.templates);
  const toggleTemplatesDrawer = useStore((s) => s.toggleTemplatesDrawer);
  const applyTemplate = useStore((s) => s.applyTemplate);
  const selectedTeamId = useStore((s) => s.selectedTeamId);
  const teams = useStore((s) => s.teams);

  const leafTeams = getLeafTeams(teams);
  const targetTeamId = selectedTeamId ?? '';
  const canApply = !!targetTeamId && useStore.getState().canEdit(targetTeamId) && !!useStore.getState().selectedGraphId;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div
        className="flex-1 bg-black/50 backdrop-blur-sm"
        onClick={toggleTemplatesDrawer}
      />
      {/* Drawer */}
      <div className="w-80 bg-panel border-l border-line flex flex-col shadow-panel">
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <span className="text-ink font-semibold text-sm">Templates</span>
          <button
            onClick={toggleTemplatesDrawer}
            className="text-muted hover:text-ink transition-colors"
          >
            ×
          </button>
        </div>

        {/* Team selector */}
        <div className="px-4 py-2 border-b border-line">
          <label className="text-muted text-[10px]">Add to team</label>
          <select
            value={targetTeamId}
            onChange={(e) => useStore.getState().selectTeam(e.target.value)}
            className="w-full bg-card border border-line rounded-lg px-2 py-1.5 text-ink text-xs mt-0.5 outline-none focus:border-accent"
          >
            {leafTeams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {/* Built-in section */}
          <div className="text-muted text-[10px] font-semibold uppercase tracking-widest mb-1">Built-in</div>
          {templates.filter((t) => t.isBuiltIn).map((tpl) => (
            <div
              key={tpl.id}
              className="bg-card border border-line rounded-[14px] p-3 hover:border-accent/40 transition-colors group"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-ink text-xs font-semibold">{tpl.name}</div>
                  <div className="text-muted text-[10px] mt-0.5 line-clamp-2">{tpl.description}</div>
                  <div className="flex gap-1 mt-1.5">
                    <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-line text-muted capitalize">
                      {tpl.defaults.type ?? 'worker'}
                    </span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-line text-muted capitalize">
                      {tpl.defaults.priority ?? 'normal'}
                    </span>
                  </div>
                </div>
                <button
                  disabled={!canApply}
                  onClick={async () => { if (await applyTemplate(tpl.id, targetTeamId)) toggleTemplatesDrawer(); }}
                  className="shrink-0 px-2.5 py-1 rounded-lg bg-accent/20 hover:bg-accent/30 text-accent text-[10px] font-semibold transition-colors"
                >
                  Add
                </button>
              </div>
            </div>
          ))}

          {/* Custom section */}
          {templates.filter((t) => !t.isBuiltIn).length > 0 && (
            <>
              <div className="text-muted text-[10px] font-semibold uppercase tracking-widest mb-1 mt-3">Custom</div>
              {templates.filter((t) => !t.isBuiltIn).map((tpl) => (
                <div
                  key={tpl.id}
                  className="bg-card border border-line rounded-[14px] p-3 hover:border-accent/40 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-ink text-xs font-semibold">{tpl.name}</div>
                      <div className="text-muted text-[10px] mt-0.5 line-clamp-2">{tpl.description}</div>
                    </div>
                    <button
                      disabled={!canApply}
                      onClick={async () => { if (await applyTemplate(tpl.id, targetTeamId)) toggleTemplatesDrawer(); }}
                      className="shrink-0 px-2.5 py-1 rounded-lg bg-accent/20 hover:bg-accent/30 text-accent text-[10px] font-semibold transition-colors"
                    >
                      Add
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
