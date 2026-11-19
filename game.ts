export const COLORS = ["#5577F5","#16B8A6","#E7A23B","#C45BD7","#FF5A76","#3ECF6A","#FF8A3D"];
export const MAX_PLAYERS = 7;
export const MIN_PLAYERS = 2;

export function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
export function genId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
export function genToken() { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36); }

/**
 * Authoritative territory physics.
 * Called on every state poll / voice update. Advances simulation by dt seconds.
 * power_i = smoothed level. Advantage = power_i - mean(power of active)
 * dTerr_i = K * advantage * dt * (territory_i/ share?) — edge-fair: transfer is
 * proportional but clamped so quiet players bleed slowly, loud bursts gain fast.
 * Sum of advantages = 0  => total stays exactly 100. Then clamp & renormalize,
 * eliminate anyone <= 0.15%.
 */
export function tickTerritories(
  players: { id: string; territory: number; smoothed: number; eliminated: boolean }[],
  dtSec: number
) {
  const active = players.filter(p => !p.eliminated && p.territory > 0);
  if (active.length < 2 || dtSec <= 0) return { players, newlyEliminated: [] as string[], winnerId: null as string | null };
  const dt = Math.min(dtSec, 1.5); // cap catch-up
  const mean = active.reduce((a, p) => a + p.smoothed, 0) / active.length;
  const K = 14; // % per second at full advantage
  const next = players.map(p => ({ ...p }));
  // only move territory if someone is actually making noise above silence gate
  const anySound = active.some(p => p.smoothed > 0.04);
  if (anySound) {
    for (const p of next) {
      if (p.eliminated || p.territory <= 0) continue;
      const adv = p.smoothed - mean;
      // loud bursts rewarded: positive advantage amplified 1.25x
      const rate = adv > 0 ? adv * 1.25 : adv * 0.9;
      p.territory += K * rate * dt;
    }
    // clamp negatives, renormalize to exactly 100 among active
    for (const p of next) if (!p.eliminated && p.territory < 0) p.territory = 0;
    const sum = next.filter(p => !p.eliminated).reduce((a, p) => a + p.territory, 0);
    if (sum > 0) for (const p of next) if (!p.eliminated) p.territory = (p.territory / sum) * 100;
  }
  const newlyEliminated: string[] = [];
  for (const p of next) {
    if (!p.eliminated && p.territory <= 0.15) { p.territory = 0; p.eliminated = true; newlyEliminated.push(p.id); }
  }
  // redistribute eliminated scraps (renormalize again)
  if (newlyEliminated.length) {
    const remaining = next.filter(p => !p.eliminated);
    const sum = remaining.reduce((a, p) => a + p.territory, 0);
    if (sum > 0) for (const p of remaining) p.territory = (p.territory / sum) * 100;
  }
  const alive = next.filter(p => !p.eliminated);
  const winnerId = alive.length === 1 ? alive[0].id : null;
  if (winnerId) { const w = next.find(p => p.id === winnerId)!; w.territory = 100; }
  return { players: next, newlyEliminated, winnerId };
}
