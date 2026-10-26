// node --test tests/*.test.mjs   (no dependencies)
import test from "node:test";
import assert from "node:assert/strict";
import { slotValue, lockBars, pFinishBelow, slotMoments, winProbability, lockCall, gameRisks, Phi } from "../js/lockmath.js";

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const G = (mu, s, risks) => risks.map((p) => ({ mu, sigma: s, p }));

// Reference values produced by the tested Python engine (alpha_scout/lockin.py)
const PY = [
  { mu: 35, s: 11, r: [0.04, 0.12, 0.04], v: 40.996664265813045, bars: [38.10899619761675, 33.6], pb: 0.4084391782174749 },
  { mu: 35, s: 11, r: [0.5, 0.04], v: 36.161929657736785, bars: [33.6], pb: 0.6117365015242768 },
  { mu: 52, s: 15, r: [0.04, 0.04, 0.04, 0.45], v: 60.95600498532475, bars: [57.45330159410295, 51.43155406333655, 28.6], pb: 0.06678502977768505 },
  { mu: 20, s: 6, r: [0.04], v: 19.2, bars: [], pb: 0.9995881020801309 },
];

test("matches the Python engine", () => {
  for (const c of PY) {
    const g = G(c.mu, c.s, c.r);
    close(slotValue(g), c.v, 1e-4, "slotValue");
    lockBars(g).forEach((b, i) => close(b, c.bars[i], 1e-4, "bar"));
    close(pFinishBelow(40, g), c.pb, 1e-5, "pFinishBelow");
  }
});

test("moments agree with the value function and with brute force", () => {
  const games = [{ mu: 30, sigma: 9, p: 0.04 }, { mu: 42, sigma: 12, p: 0.12 }, { mu: 33, sigma: 10, p: 0.3 }];
  const m = slotMoments(games);
  close(m.mean, slotValue(games), 1e-6, "mean == value");
  // brute force
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const bars = lockBars(games);
  let s1 = 0, s2 = 0; const N = 300000;
  for (let n = 0; n < N; n++) {
    for (let i = 0; i < games.length; i++) {
      const g = games[i];
      const x = rnd() < g.p ? 0 : g.mu + g.sigma * gauss();
      if (i === games.length - 1 || x >= bars[i]) { s1 += x; s2 += x * x; break; }
    }
  }
  const mean = s1 / N, variance = s2 / N - mean * mean;
  close(m.mean, mean, 0.15, "sim mean");
  close(m.variance, variance, 6, "sim variance");
});

test("per-game projections change the bar", () => {
  const easy = [{ mu: 45, sigma: 13, p: 0.04 }];        // juicy matchup left
  const hard = [{ mu: 30, sigma: 9, p: 0.04 }];         // tough matchup left
  assert.ok(slotValue(easy) > slotValue(hard));
});

test("win probability and matchup-aware calls", () => {
  close(winProbability([{ mean: 10, variance: 0 }], [{ mean: 10, variance: 0 }]), 0.5, 1e-9, "tie");
  close(winProbability([{ mean: 110, variance: 100 }], [{ mean: 100, variance: 0 }]), Phi(1), 1e-9, "1 sd");
  const games = [{ mu: 35, sigma: 11, p: 0.04 }, { mu: 35, sigma: 11, p: 0.04 }];
  const bar = slotValue(games);
  // Way ahead: a score a bit under the bar should be locked to kill variance.
  const ahead = lockCall(bar - 3, games, [{ mean: 352, variance: 200 }], [{ mean: 360, variance: 200 }]);
  assert.equal(ahead.ev, "PASS");
  assert.equal(ahead.verdict, "LOCK");
  assert.ok(ahead.matchupFlip && ahead.winIfLock > ahead.winIfPass);
  // Way behind: a score a bit over the bar should be passed to chase upside.
  const behind = lockCall(bar + 3, games, [{ mean: 292, variance: 200 }], [{ mean: 360, variance: 200 }]);
  assert.equal(behind.ev, "LOCK");
  assert.equal(behind.verdict, "PASS");
  // Matchup already decided: falls back to the points rule.
  assert.equal(lockCall(bar - 3, games, [{ mean: 460, variance: 200 }], [{ mean: 360, variance: 200 }]).verdict, "PASS");
  // No matchup info: plain EV rule.
  assert.equal(lockCall(bar + 1, games).verdict, "LOCK");
});

test("risk model matches Python (b2b + questionable, decaying)", () => {
  const r = gameRisks(["2026-10-22", "2026-10-24"], new Set(["2026-10-19", "2026-10-21", "2026-10-22", "2026-10-24"]), "Questionable");
  close(r[0].p, 0.516, 1e-9, "game 1");
  close(r[1].p, 0.3424, 1e-9, "game 2");
  assert.ok(r[0].b2b && !r[1].b2b);
});

// ------------------------------------------------------------------ player-shaped distributions
import { buildShape, percentileOf, normalQuantile, slotValue as sv, slotMoments as sm, pFinishBelow as pfb, lockBars as lb } from "../js/lockmath.js";

test("a shape drawn from a normal reproduces the normal results", () => {
  const ratios = Array.from({ length: 400 }, (_, k) => 1 + 0.3 * normalQuantile((k + 0.5) / 400));
  const shape = buildShape(ratios, { q: 101 });
  const normal = [{ mu: 40, sigma: 12, p: 0.04 }, { mu: 40, sigma: 12, p: 0.12 }, { mu: 40, sigma: 12, p: 0.04 }];
  const shaped = normal.map((g) => ({ mu: g.mu, shape, p: g.p }));
  close(sv(shaped), sv(normal), 0.35, "value");
  close(sm(shaped).variance, sm(normal).variance, 8, "variance");
  close(pfb(45, shaped), pfb(45, normal), 0.02, "pBelow");
});

test("shaped moments agree with brute force", () => {
  const shape = buildShape([0.3, 0.6, 0.8, 0.9, 1.0, 1.0, 1.1, 1.2, 1.4, 1.9, 2.2]);   // boom-or-bust
  const games = [{ mu: 35, shape, p: 0.04 }, { mu: 42, shape, p: 0.12 }, { mu: 30, shape, p: 0.3 }];
  const bars = lb(games), m = sm(games);
  close(m.mean, sv(games), 1e-9, "mean == value");
  let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let s1 = 0, s2 = 0, below = 0; const N = 200000;
  for (let n = 0; n < N; n++) for (let i = 0; i < games.length; i++) {
    const g = games[i];
    const x = rnd() < g.p ? 0 : g.mu * shape[Math.floor(rnd() * shape.length)];
    if (i === games.length - 1 || x >= bars[i]) { s1 += x; s2 += x * x; below += x < 40 ? 1 : 0; break; }
  }
  close(m.mean, s1 / N, 0.15, "sim mean");
  close(m.variance, s2 / N - (s1 / N) ** 2, 8, "sim variance");
  close(pfb(40, games), below / N, 0.006, "sim pBelow");
});

test("a volatile player gets a higher bar than a steady one with the same average", () => {
  const steady = buildShape(Array.from({ length: 60 }, (_, k) => 1 + 0.12 * normalQuantile((k + 0.5) / 60)));
  const volatile = buildShape(Array.from({ length: 60 }, (_, k) => 1 + 0.45 * normalQuantile((k + 0.5) / 60)));
  const games = (shape) => [{ mu: 40, shape, p: 0.04 }, { mu: 40, shape, p: 0.04 }];
  assert.ok(sv(games(volatile)) > sv(games(steady)) + 4);
});

test("shape and percentile helpers", () => {
  const sh = buildShape([0.5, 1, 1.5]);
  close(sh.reduce((s, x) => s + x, 0) / sh.length, 1, 1e-12, "mean 1");
  const prior = buildShape([]);                                  // no games -> pure prior
  assert.ok(prior[0] < 0.6 && prior.at(-1) > 1.4);
  assert.equal(percentileOf(30, [10, 20, 30, 40]), 0.625);
  assert.equal(percentileOf(5, []), null);
  close(normalQuantile(0.975), 1.959964, 1e-5, "z 97.5");
});

// ------------------------------------------------------------------ linked back-to-back nights
test("linked nights reproduce the worked example from the outline", () => {
  // 40-pt player; Fri = night 1, Sat = night 2 and his last game. Checked "sits B2Bs" (q=95%), night split 73%.
  const q = 0.95, s = 0.73, base = 0.03;
  const games = [
    { mu: 40, sigma: 12, p: base + q * (1 - s) },
    { mu: 40, sigma: 12, p: base + q * s, pIfPrevPlayed: base + (q * s) / (1 - q * (1 - s)), pIfPrevSat: base },
  ];
  close(lb(games)[0], 1.5, 0.05, "lock Fri if >=");
  close(sv(games), 39.7, 0.05, "slot value now");
});

test("linked-night recursion agrees with brute force", () => {
  const shape = buildShape([0.4, 0.7, 0.9, 1, 1.05, 1.2, 1.5, 1.9]);
  // Thu (normal), Fri = night 1, Sat = night 2, Sun normal; Sun's risk also depends on Sat (3-in-4 style chain).
  const games = [
    { mu: 38, shape, p: 0.05 },
    { mu: 42, shape, p: 0.09, pIfPrevPlayed: 0.12, pIfPrevSat: 0.04 },
    { mu: 40, shape, p: 0.2, pIfPrevPlayed: 0.45, pIfPrevSat: 0.03 },
    { mu: 35, shape, p: 0.06, pIfPrevPlayed: 0.08, pIfPrevSat: 0.04 },
  ];
  const bars = lb(games), m = sm(games);
  close(m.mean, sv(games), 1e-9, "mean == value");
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let s1 = 0, s2 = 0, below = 0; const N = 300000;
  for (let n = 0; n < N; n++) {
    let prev = null;
    for (let i = 0; i < games.length; i++) {
      const g = games[i];
      const p = prev === null || g.pIfPrevPlayed === undefined ? g.p : prev === "played" ? g.pIfPrevPlayed : g.pIfPrevSat;
      const sat = rnd() < p;
      const x = sat ? 0 : g.mu * shape[Math.floor(rnd() * shape.length)];
      if (i === games.length - 1 || (!sat && x >= bars[i])) { s1 += x; s2 += x * x; below += x < 40 ? 1 : 0; break; }
      prev = sat ? "sat" : "played";
    }
  }
  close(m.mean, s1 / N, 0.15, "sim mean");
  close(m.variance, s2 / N - (s1 / N) ** 2, 8, "sim variance");
  close(pfb(40, games), below / N, 0.006, "sim pBelow");
});

test("once he has played night 1, a likely rest on night 2 lowers the bar for night 1", () => {
  const unlinked = [{ mu: 40, sigma: 12, p: 0.04 }, { mu: 40, sigma: 12, p: 0.12 }];
  const linked = [{ mu: 40, sigma: 12, p: 0.06 }, { mu: 40, sigma: 12, p: 0.55, pIfPrevPlayed: 0.57, pIfPrevSat: 0.03 }];
  assert.ok(lb(linked)[0] < lb(unlinked)[0] - 15);
});

test("safety cushion: a thin lead is played like a deficit", async () => {
  const { lockCall, winProbability } = await import("../js/lockmath.js");
  const theirs = [{ mean: 100, variance: 400 }];
  const others = [{ mean: 95, variance: 0 }];
  const games = [{ mu: 10, sigma: 8, p: 0.05 }];
  assert.ok(Math.abs(winProbability([{ mean: 110, variance: 0 }], [{ mean: 100, variance: 100 }], 10) - 0.5) < 1e-9);
  const plain = lockCall(10, games, others, theirs);
  assert.equal(plain.verdict, "LOCK");                    // ahead by 5: protect it
  const safe = lockCall(10, games, others, theirs, 20);
  assert.equal(safe.verdict, "PASS");                     // ahead by less than 20: chase upside
  assert.ok(safe.safeIfPass > safe.safeIfLock);
  assert.equal(safe.winIfLock, plain.winIfLock);          // the plain win odds are still reported
});
