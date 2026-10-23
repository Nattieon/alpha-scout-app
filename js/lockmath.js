// Lock-In math: optimal stopping with per-game means and DNP risk.
// Same model as Alpha Scout's Python engine (alpha_scout/lockin.py), generalized
// so each remaining game has its own projection (opponent, minutes, etc.).
//
// A game is {mu, sigma, p}: a played game scores X ~ N(mu, sigma); p = P(he misses it).
// Sleeper rule: an open slot takes his LAST game of the week, even a DNP (0 FP).

const SQRT2 = Math.SQRT2;

export function erf(x) {
  // Abramowitz & Stegun 7.1.26 (max error 1.5e-7)
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export const Phi = (z) => 0.5 * (1 + erf(z / SQRT2));
export const phi = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

const clamp01 = (p) => Math.min(Math.max(p || 0, 0), 1);

/** E[max(X, v)] for X ~ N(mu, sigma). */
export function emax(mu, sigma, v) {
  if (!(sigma > 0)) return Math.max(mu, v);
  const a = (v - mu) / sigma;
  return v * Phi(a) + mu * (1 - Phi(a)) + sigma * phi(a);
}

/** Expected final score of an open slot facing these games (in order). */
export function slotValue(games) {
  let v = null;
  for (let i = games.length - 1; i >= 0; i--) {
    const { mu, sigma } = games[i];
    const p = clamp01(games[i].p);
    v = v === null ? (1 - p) * mu : p * Math.max(v, 0) + (1 - p) * emax(mu, sigma, v);
  }
  return v === null ? 0 : v;
}

/** bars[i] = score that makes game i worth locking (the last game has none). */
export function lockBars(games) {
  return games.slice(0, -1).map((_, i) => slotValue(games.slice(i + 1)));
}

/** Mean and variance of the slot's final score when played optimally from here. */
export function slotMoments(games) {
  if (!games.length) return { mean: 0, variance: 0 };
  const last = games[games.length - 1];
  let p = clamp01(last.p);
  let m1 = (1 - p) * last.mu;
  let m2 = (1 - p) * (last.mu ** 2 + last.sigma ** 2);
  for (let i = games.length - 2; i >= 0; i--) {
    const { mu, sigma } = games[i];
    p = clamp01(games[i].p);
    const t = m1;                                   // lock iff X >= value of continuing
    let take1, take2, below;
    if (sigma > 0) {
      const a = (t - mu) / sigma;
      below = Phi(a);
      take1 = mu * (1 - below) + sigma * phi(a);
      take2 = (mu ** 2 + sigma ** 2) * (1 - below) + sigma * (mu + t) * phi(a);
    } else {
      below = mu < t ? 1 : 0;
      take1 = (1 - below) * mu;
      take2 = (1 - below) * mu * mu;
    }
    const n1 = p * m1 + (1 - p) * (take1 + below * m1);
    const n2 = p * m2 + (1 - p) * (take2 + below * m2);
    m1 = n1; m2 = n2;
  }
  return { mean: m1, variance: Math.max(m2 - m1 * m1, 0) };
}

/** P(final slot score < x) if you pass now and play the remaining games optimally. */
export function pFinishBelow(x, games) {
  if (!games.length) return 0;
  const bars = lockBars(games);
  const cdf = (g, z) => (g.sigma > 0 ? Phi((z - g.mu) / g.sigma) : (g.mu < z ? 1 : 0));
  const last = games[games.length - 1];
  let p = clamp01(last.p);
  let f = p * (x > 0 ? 1 : 0) + (1 - p) * cdf(last, x);
  for (let i = games.length - 2; i >= 0; i--) {
    const g = games[i];
    p = clamp01(g.p);
    const t = bars[i];
    const tookBelow = Math.max(cdf(g, x) - cdf(g, t), 0);
    f = p * f + (1 - p) * (tookBelow + cdf(g, t) * f);
  }
  return Math.min(Math.max(f, 0), 1);
}

/** P(my total > opponent total) for independent normal slots: [{mean, variance}]. */
export function winProbability(mine, theirs) {
  const M = mine.reduce((s, x) => s + x.mean, 0) - theirs.reduce((s, x) => s + x.mean, 0);
  const V = mine.reduce((s, x) => s + x.variance, 0) + theirs.reduce((s, x) => s + x.variance, 0);
  if (V < 1e-9) return M > 0 ? 1 : M < 0 ? 0 : 0.5;
  return Phi(M / Math.sqrt(V));
}

/**
 * The lock call for one slot.
 *   score: what the just-finished game scored
 *   games: his remaining games this week
 *   others/theirs: every OTHER slot of mine, and all of the opponent's, as {mean, variance}
 * Returns the points-maximizing call and, when the matchup is known, the win-maximizing one.
 */
export function lockCall(score, games, others = null, theirs = null) {
  const bar = slotValue(games);
  const ev = score >= bar ? "LOCK" : "PASS";
  const out = { bar, ev, pBelow: pFinishBelow(score, games), verdict: ev };
  if (others && theirs) {
    const pass = slotMoments(games);
    out.winIfLock = winProbability([...others, { mean: score, variance: 0 }], theirs);
    out.winIfPass = winProbability([...others, pass], theirs);
    const diff = out.winIfLock - out.winIfPass;
    out.verdict = Math.abs(diff) < 0.002 ? ev : diff > 0 ? "LOCK" : "PASS";
    out.matchupFlip = out.verdict !== ev;
  }
  return out;
}

export const INJURY_DNP = {
  probable: 0.10, dtd: 0.30, "day-to-day": 0.30, gtd: 0.35, questionable: 0.45,
  doubtful: 0.80, out: 0.97, ir: 1.0, suspended: 1.0, inactive: 0.97,
};

/** DNP probability for each upcoming game. dates: ISO strings; teamDates: Set of all team game dates. */
export function gameRisks(dates, teamDates, injuryStatus, cfg = {}, offset = 0) {
  const base = cfg.baseDnp ?? 0.04, b2b = cfg.b2bDnp ?? 0.08, decay = cfg.injuryDecay ?? 0.7;
  const inj = INJURY_DNP[String(injuryStatus || "").trim().toLowerCase()] || 0;
  return dates.map((d, i) => {
    const prev = new Date(d + "T12:00:00Z");
    prev.setUTCDate(prev.getUTCDate() - 1);
    const isB2b = teamDates.has(prev.toISOString().slice(0, 10));
    let p = base + (isB2b ? b2b : 0);
    const extra = inj * decay ** (i + offset);
    if (extra > 0.01) p = 1 - (1 - p) * (1 - extra);
    return { p: Math.min(p, 1), b2b: isB2b, injury: extra > 0.01 ? injuryStatus : null };
  });
}
