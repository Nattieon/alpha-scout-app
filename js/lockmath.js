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

// ---------------------------------------------------------------- one game's score distribution
// A game is either normal {mu, sigma} or player-shaped {mu, shape}: shape is the player's own
// game-to-game pattern as equally likely ratios to his average (mean 1), so X = mu * ratio.
const vals = (g) => g.shape.map((r) => g.mu * r);

/** E[max(X, v)] for one game. */
export function gameEmax(g, v) {
  if (!g.shape) return emax(g.mu, g.sigma, v);
  const xs = vals(g);
  return xs.reduce((s, x) => s + Math.max(x, v), 0) / xs.length;
}

/** P(X < z) for one game. */
export function gameCdf(g, z) {
  if (!g.shape) return g.sigma > 0 ? Phi((z - g.mu) / g.sigma) : (g.mu < z ? 1 : 0);
  const xs = vals(g);
  return xs.filter((x) => x < z).length / xs.length;
}

/** {below: P(X < t), m1: E[X; X >= t], m2: E[X^2; X >= t]} for one game. */
function gameUpper(g, t) {
  if (!g.shape) {
    const { mu, sigma } = g;
    if (!(sigma > 0)) { const b = mu < t ? 1 : 0; return { below: b, m1: (1 - b) * mu, m2: (1 - b) * mu * mu }; }
    const a = (t - mu) / sigma, below = Phi(a);
    return { below, m1: mu * (1 - below) + sigma * phi(a), m2: (mu ** 2 + sigma ** 2) * (1 - below) + sigma * (mu + t) * phi(a) };
  }
  const xs = vals(g), n = xs.length;
  let below = 0, m1 = 0, m2 = 0;
  for (const x of xs) { if (x < t) below++; else { m1 += x; m2 += x * x; } }
  return { below: below / n, m1: m1 / n, m2: m2 / n };
}

const gameMean2 = (g) => (g.shape ? vals(g).reduce((s, x) => s + x * x, 0) / g.shape.length : g.mu ** 2 + g.sigma ** 2);

/** Expected final score of an open slot facing these games (in order). */
export function slotValue(games) {
  let v = null;
  for (let i = games.length - 1; i >= 0; i--) {
    const g = games[i], p = clamp01(g.p);
    v = v === null ? (1 - p) * g.mu : p * Math.max(v, 0) + (1 - p) * gameEmax(g, v);
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
  let m2 = (1 - p) * gameMean2(last);
  for (let i = games.length - 2; i >= 0; i--) {
    const g = games[i];
    p = clamp01(g.p);
    const u = gameUpper(g, m1);                     // lock iff X >= value of continuing
    const n1 = p * m1 + (1 - p) * (u.m1 + u.below * m1);
    const n2 = p * m2 + (1 - p) * (u.m2 + u.below * m2);
    m1 = n1; m2 = n2;
  }
  return { mean: m1, variance: Math.max(m2 - m1 * m1, 0) };
}

/** P(final slot score < x) if you pass now and play the remaining games optimally. */
export function pFinishBelow(x, games) {
  if (!games.length) return 0;
  const bars = lockBars(games);
  const last = games[games.length - 1];
  let p = clamp01(last.p);
  let f = p * (x > 0 ? 1 : 0) + (1 - p) * gameCdf(last, x);
  for (let i = games.length - 2; i >= 0; i--) {
    const g = games[i];
    p = clamp01(g.p);
    const t = bars[i];
    const tookBelow = Math.max(gameCdf(g, x) - gameCdf(g, t), 0);
    f = p * f + (1 - p) * (tookBelow + gameCdf(g, t) * f);
  }
  return Math.min(Math.max(f, 0), 1);
}

// ---------------------------------------------------------------- player shape & percentiles
/**
 * A player's score shape from his own games: ratios to his average, blended with
 * `pseudo` prior games from N(1, cvPrior) so a short log can't produce a wild shape.
 * Returns `q` equally likely ratios with mean exactly 1.
 */
export function buildShape(ratios, { cvPrior = 0.3, pseudo = 8, q = 41 } = {}) {
  const prior = Array.from({ length: pseudo }, (_, k) => 1 + cvPrior * normalQuantile((k + 0.5) / pseudo));
  const xs = [...ratios.filter((r) => Number.isFinite(r)), ...prior].sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k < q; k++) {
    const pos = ((k + 0.5) / q) * xs.length - 0.5;
    const lo = Math.max(0, Math.floor(pos)), hi = Math.min(xs.length - 1, lo + 1), w = Math.min(Math.max(pos - lo, 0), 1);
    out.push(xs[lo] * (1 - w) + xs[hi] * w);
  }
  const m = out.reduce((s, x) => s + x, 0) / out.length;
  return out.map((x) => x / m);
}

/** Share of `values` below x (ties count half), 0..1. */
export function percentileOf(x, values) {
  if (!values.length) return null;
  let below = 0;
  for (const v of values) below += v < x ? 1 : v === x ? 0.5 : 0;
  return below / values.length;
}

/** Inverse standard normal CDF (Acklam's approximation, |error| < 1.2e-9). */
export function normalQuantile(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - lo) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
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
