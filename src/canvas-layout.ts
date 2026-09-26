import type { Team } from './types';

// Older teams share the default origin. Spread only those collisions in the
// view; keep saved coordinates untouched, including a single explicit origin.
export function teamPositions(teams: Team[]) {
  const positions = new Map<string, { x: number; y: number }>();
  const occupied = teams
    .filter((team) => team.space.x !== 0 || team.space.y !== 0)
    .map((team) => ({ x: team.space.x, y: team.space.y }));
  let originUsed = false;
  let slot = 1;
  for (const team of [...teams].sort((a, b) => a.id.localeCompare(b.id))) {
    let position = { x: team.space.x, y: team.space.y };
    if (position.x === 0 && position.y === 0) {
      if (originUsed) {
        do {
          position = { x: (slot % 3) * 300, y: Math.floor(slot / 3) * 220 };
          slot++;
        } while (occupied.some((p) => Math.abs(p.x - position.x) < 260 && Math.abs(p.y - position.y) < 180));
      }
      originUsed = true;
      occupied.push(position);
    }
    positions.set(team.id, position);
  }
  return positions;
}
