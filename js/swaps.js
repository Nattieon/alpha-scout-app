// Bench swaps: who should hold each open slot for the rest of the week.
//
// Sleeper Lock-In rules this follows:
//  - only starters count, and a game counts only if he was in a starting slot at tip-off;
//  - an unlocked slot takes the final game of whoever is in it at week's end (even a 0);
//  - locked players and their slots are fixed; unlocked starters can move between slots.
//
// Level 1: each open slot gets one player for the rest of the week (the best overall
// assignment, each player used once). Its value is that player's optimal-stopping value
// over his remaining games; the slot's current player can also keep his just-played score.

const STAY = 0.01;
const SLOT_FITS = {
  PG: ["PG"], SG: ["SG"], G: ["PG", "SG", "G"],
  SF: ["SF"], PF: ["PF"], F: ["SF", "PF", "F"],
  C: ["C"], GF: ["SG", "SF", "G", "F"], FC: ["SF", "PF", "C", "F"],
};

/** Can a player with these Sleeper fantasy positions fill this starting slot? */
export function canFill(slotLabel, positions) {
  const slot = String(slotLabel || "").toUpperCase();
  if (slot === "UTIL" || slot === "FLEX") return true;
  const fits = SLOT_FITS[slot] || [slot];
  return (positions || []).some((p) => fits.includes(String(p).toUpperCase()));
}

/**
 * Maximum-weight assignment of rows to distinct columns (rows <= columns).
 * Hungarian algorithm, O(rows^2 * cols). Entries of -Infinity mean "not allowed".
 * Returns {cols: column index per row, total}.
 */
export function bestAssignment(weights) {
  const n = weights.length;
  if (!n) return { cols: [], total: 0 };
  const m = weights[0].length;
  if (m < n) throw new Error("need at least as many columns as rows");
  const BIG = 1e7;
  let maxW = 0;
  for (const row of weights) for (const w of row) if (Number.isFinite(w)) maxW = Math.max(maxW, w);
  const cost = (i, j) => (Number.isFinite(weights[i][j]) ? maxW - weights[i][j] : BIG);
  // e-maxx formulation, 1-indexed
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const cols = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) cols[p[j] - 1] = j - 1;
  const total = cols.reduce((t, j, i) => t + (Number.isFinite(weights[i][j]) ? weights[i][j] : 0), 0);
  return { cols, total };
}

/**
 * Plan the open slots.
 *  slots:      [{key, label, current: candidateKey|null, keepScore: number|null}]
 *              keepScore = what the slot banks if its current player stays put without
 *              new games counting (his just-played, lockable score), or null.
 *  candidates: [{key, positions, value}] value = his stopping value over remaining games.
 * Returns {assign: {slotKey: candidateKey|null}, keep: {slotKey: bool}, total, valueOf(excludeSlot)}.
 */
export function planSlots(slots, candidates) {
  const build = (rows, cands) => {
    const cols = cands.length + rows.length;                    // + one "leave it empty" column per slot
    return rows.map((s, r) => {
      const row = new Array(cols).fill(-Infinity);
      cands.forEach((c, k) => {
        if (c.key !== s.current && !canFill(s.label, c.positions)) return;   // he's already in it, so he fits
        // a tiny edge for staying put, so ties never produce pointless moves
        row[k] = c.key === s.current ? Math.max(c.value, s.keepScore ?? -Infinity) + STAY : c.value;
      });
      row[cands.length + r] = s.current === null && s.keepScore != null ? s.keepScore : 0;
      return row;
    });
  };
  const solve = (rows, cands) => {
    if (!rows.length) return { total: 0, assign: {}, keep: {} };
    const res = bestAssignment(build(rows, cands));
    const assign = {}, keep = {};
    let total = 0;
    rows.forEach((s, r) => {
      const k = res.cols[r];
      const c = k < cands.length ? cands[k] : null;
      assign[s.key] = c ? c.key : null;
      keep[s.key] = !!c && c.key === s.current && s.keepScore != null && s.keepScore >= c.value;
      total += !c ? 0 : c.key === s.current ? Math.max(c.value, s.keepScore ?? -Infinity) : c.value;
    });
    return { total, assign, keep };
  };
  const plan = solve(slots, candidates);
  /** Value of keeping `slotKey` open (its banked score not available), minus the plan without it. */
  plan.openValue = (slotKey) => {
    const s = slots.find((x) => x.key === slotKey);
    const withOpen = solve(slots.map((x) => (x.key === slotKey ? { ...x, keepScore: null } : x)), candidates);
    const without = solve(slots.filter((x) => x.key !== slotKey), candidates.filter((c) => c.key !== s.current));
    return { value: withOpen.total - without.total, assign: withOpen.assign };
  };
  return plan;
}
