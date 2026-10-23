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
