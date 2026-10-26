// Which game counted in each slot, worked out from the totals the Sleeper app shows.
//
// Sleeper's public data is unreliable for Lock-In scores, but the app's two numbers per team are
// right: the score (one game per starting slot) and, under it, the total of Sleeper's projections
// for those same games. One game per slot must add up to both. Usually exactly one combination does.

/**
 * slots:  [{key, games: [{date, fp, pj}]}]   fp: points scored (0 = didn't play), pj: Sleeper's projection
 * target: {points, proj?}                      the Sleeper app's numbers
 * Returns up to `limit` solutions, each {key: date}. A game he didn't play can only count as his last.
 */
export function solveCounted(slots, target, { limit = 10, tolPoints = 0.011, tolProj = 0.06 } = {}) {
  const opts = slots.map((s) => {
    const last = s.games.at(-1)?.date;
    const o = s.games.filter((g) => g.fp > 0 || g.date === last);
    return o.length ? o : [{ date: null, fp: 0, pj: 0 }];
  });
  // bounds for pruning
  const n = opts.length;
  const minF = new Array(n + 1).fill(0), maxF = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    minF[i] = minF[i + 1] + Math.min(...opts[i].map((g) => g.fp));
    maxF[i] = maxF[i + 1] + Math.max(...opts[i].map((g) => g.fp));
  }
  const out = [], pick = [];
  const useProj = typeof target.proj === "number";
  (function go(i, f, p) {
    if (out.length >= limit) return;
    if (f + minF[i] > target.points + tolPoints || f + maxF[i] < target.points - tolPoints) return;
    if (i === n) {
      if (useProj && Math.abs(p - target.proj) > tolProj) return;
      out.push(Object.fromEntries(slots.map((s, k) => [s.key, pick[k].date])));
      return;
    }
    for (const g of opts[i]) { pick.push(g); go(i + 1, f + g.fp, p + (g.pj || 0)); pick.pop(); }
  })(0, 0, 0);
  return out;
}
