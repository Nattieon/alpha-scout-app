// Late swaps. An open slot isn't tied to one player for the rest of the week: before each tip-off you
// can put whoever you like in it, and once a game is over you lock it or move on. So a slot's plan is a
// time-ordered sequence of games, possibly from several players ("Markkanen at 3:30; if he's under the
// bar, Reed at 7"), played with the same lock-or-pass math as one player's games.
//
// Games tipping at the same time can't both be used (one player in the slot), and when a day's tip-off
// times aren't known its games are treated as simultaneous: no reacting within that day.
import { canFill } from "./swaps.js?v=__V__";
import { gameEmax, slotValue } from "./lockmath.js?v=__V__";

const prevDay = (d) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };

/**
 * The best sequence for one slot from a group of players.
 * cands: [{key, p?, games: [{date, tip?, mu, p, ...}]}]  ->  games in time order, each tagged {who, whoName}
 */
export function chainOf(cands) {
  const all = cands.flatMap((c) => (c.games || []).map((g) => ({ ...g, who: c.key, whoName: c.p?.name || c.key })));
  if (!all.length) return [];
  const untimed = new Set(all.filter((g) => !g.tip).map((g) => g.date));
  const keyOf = (g) => (untimed.has(g.date) ? `${g.date}T~` : g.tip);
  const groups = new Map();
  for (const g of all) (groups.get(keyOf(g)) || groups.set(keyOf(g), []).get(keyOf(g))).push(g);
  const order = [...groups.keys()].sort();
  // Backward: at each time, put in whoever makes the rest of the week worth most.
  const pick = new Array(order.length);
  let V = null;
  for (let i = order.length - 1; i >= 0; i--) {
    let best = null, bestV = -Infinity;
    for (const g of groups.get(order[i])) {
      const p = Math.min(Math.max(g.p || 0, 0), 1);
      const v = V === null ? (1 - p) * g.mu : p * Math.max(V, 0) + (1 - p) * gameEmax(g, V);
      if (v > bestV) { bestV = v; best = g; }
    }
    pick[i] = best; V = bestV;
  }
  // A night-2 risk linked to night 1 only holds when night 1 is the same player's previous game here.
  return pick.map((g, i) => {
    const prev = pick[i - 1];
    if (g.pIfPrevPlayed !== undefined && !(prev && prev.who === g.who && prev.date === prevDay(g.date))) {
      const { pIfPrevPlayed, pIfPrevSat, ...rest } = g;
      return rest;
    }
    return g;
  });
}

/**
 * Hand the players nobody starts to the open slots as late-swap options, greedily where each adds most.
 * rows: [{key, label, current}]  groups: {slotKey: [cand]} (each slot's main player, if any)
 * Returns {slotKey: [cand]} with the extra players added. A player can back up one slot only.
 */
export function addBackups(rows, groups, candidates, { minGain = 0.25 } = {}) {
  const used = new Set(Object.values(groups).flat().map((c) => c.key));
  const free = candidates.filter((c) => !used.has(c.key) && c.games?.length);
  const out = Object.fromEntries(rows.map((r) => [r.key, [...(groups[r.key] || [])]]));
  const valueOf = (key) => slotValue(chainOf(out[key]));
  const cur = Object.fromEntries(rows.map((r) => [r.key, valueOf(r.key)]));
  for (;;) {
    let best = null;
    for (const c of free) for (const r of rows) {
      if (c.key !== r.current && !canFill(r.label, c.positions)) continue;
      const gain = slotValue(chainOf([...out[r.key], c])) - cur[r.key];
      if (gain > minGain && (!best || gain > best.gain)) best = { c, r, gain };
    }
    if (!best) break;
    out[best.r.key].push(best.c);
    cur[best.r.key] += best.gain;
    free.splice(free.indexOf(best.c), 1);
  }
  return out;
}
