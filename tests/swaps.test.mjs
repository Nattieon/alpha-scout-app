import test from "node:test";
import assert from "node:assert/strict";
import { bestAssignment, canFill, planSlots } from "../js/swaps.js";

test("slot eligibility follows Sleeper positions", () => {
  assert.ok(canFill("G", ["PG"]) && canFill("G", ["SG", "SF"]) && !canFill("G", ["C"]));
  assert.ok(canFill("F", ["PF", "C"]) && !canFill("F", ["PG"]));
  assert.ok(canFill("UTIL", ["C"]) && canFill("C", ["PF", "C"]) && !canFill("PG", ["SG"]));
});

test("assignment matches brute force on random boards", () => {
  let seed = 5; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const brute = (w) => {
    const n = w.length, m = w[0].length; let best = -Infinity;
    const go = (i, used, tot) => {
      if (i === n) { best = Math.max(best, tot); return; }
      for (let j = 0; j < m; j++) if (!used.has(j) && Number.isFinite(w[i][j])) { used.add(j); go(i + 1, used, tot + w[i][j]); used.delete(j); }
    };
    go(0, new Set(), 0); return best;
  };
  for (let t = 0; t < 60; t++) {
    const n = 1 + Math.floor(rnd() * 5), m = n + Math.floor(rnd() * 4);
    const w = Array.from({ length: n }, () => Array.from({ length: m }, () => (rnd() < 0.2 ? -Infinity : Math.round(rnd() * 60))));
    w.forEach((row, i) => { if (!row.some(Number.isFinite)) row[i] = 0; });
    const res = bestAssignment(w);
    assert.equal(res.total, brute(w), `board ${t}`);
    assert.equal(new Set(res.cols).size, n);
  }
});

test("a bench guard replaces a starter who is out for his last game", () => {
  const slots = [{ key: "PG", label: "PG", current: "fvv", keepScore: null }];
  const cands = [
    { key: "fvv", positions: ["PG"], value: 0 },        // out for his only remaining game
    { key: "suggs", positions: ["PG", "SG"], value: 33 },
    { key: "gobert", positions: ["C"], value: 34 },      // can't play PG
  ];
  const plan = planSlots(slots, cands);
  assert.equal(plan.assign.PG, "suggs");
  assert.equal(plan.total, 33);
});

test("the current player keeps his score when that beats every bench option", () => {
  const slots = [{ key: "PG", label: "PG", current: "fvv", keepScore: 43.5 }];
  const plan = planSlots(slots, [{ key: "fvv", positions: ["PG"], value: 0 }, { key: "suggs", positions: ["PG"], value: 33 }]);
  assert.equal(plan.assign.PG, "fvv");
  assert.ok(plan.keep.PG);
  assert.equal(plan.openValue("PG").value, 33);            // the bar to lock his 43.5 is the bench option
});

test("one bench player can't fill two slots; the solver sends him where he's worth most", () => {
  const slots = [
    { key: "S1", label: "UTIL", current: "a", keepScore: null },
    { key: "S2", label: "UTIL", current: "b", keepScore: null },
  ];
  const cands = [{ key: "a", positions: ["SF"], value: 10 }, { key: "b", positions: ["SF"], value: 30 }, { key: "x", positions: ["SF"], value: 25 }];
  const plan = planSlots(slots, cands);
  assert.equal(plan.total, 55);                            // b stays, x replaces a
  assert.deepEqual(new Set(Object.values(plan.assign)), new Set(["b", "x"]));
});

test("lock bar for a pending slot = value of keeping it open with the bench", () => {
  const slots = [
    { key: "F", label: "F", current: "a", keepScore: 25 },
    { key: "U", label: "UTIL", current: "b", keepScore: null },
  ];
  const cands = [{ key: "a", positions: ["PF"], value: 20 }, { key: "b", positions: ["SG"], value: 35 }, { key: "x", positions: ["SF"], value: 40 }];
  // Without bench: a's own continuation is 20, so 25 looks lockable. With x on the bench, keeping F open
  // adds 35 to the lineup (75 with F open vs 40 without it: x would otherwise just replace b at UTIL).
  const { value, assign } = planSlots(slots, cands).openValue("F");
  assert.equal(value, 35);
  assert.equal(assign.F, "x");
});

test("lock slot: take the specific slot so a bench big can use UTIL", async () => {
  const { chooseLockSlot } = await import("../js/swaps.js");
  // Haliburton (PG/SG) is in UTIL and gets locked. PG holds a weak PG; a strong C sits on the bench, C slot full.
  const me = { key: "U", label: "UTIL", positions: ["PG", "SG"] };
  const rows = [{ key: "PG", label: "PG", current: "weakPG", keepScore: null }];
  const cands = [{ key: "weakPG", positions: ["PG"], value: 20 }, { key: "benchC", positions: ["C"], value: 45 }];
  const pos = (k) => cands.find((c) => c.key === k)?.positions || [];
  const r = chooseLockSlot(me, rows, cands, pos);
  assert.equal(r.label, "PG");
  assert.equal(r.reason, "points");
  assert.ok(Math.abs(r.gain - 25) < 1e-9);          // benchC (45) gets UTIL instead of weakPG (20)
  assert.equal(r.newcomer, "benchC");
  assert.equal(r.moved, "weakPG");
});

test("lock slot: on a points tie, keep the flexible slot open", async () => {
  const { chooseLockSlot } = await import("../js/swaps.js");
  const me = { key: "U", label: "UTIL", positions: ["PG"] };
  const rows = [{ key: "PG", label: "PG", current: null, keepScore: null }];
  const r = chooseLockSlot(me, rows, [], () => []);
  assert.equal(r.label, "PG");
  assert.equal(r.reason, "flex");
  // already in the most specific slot he fits: nothing to recommend
  assert.equal(chooseLockSlot({ key: "PG", label: "PG", positions: ["PG"] }, [{ key: "U", label: "UTIL", current: null, keepScore: null }], [], () => []), null);
});

test("lock slot: two locked centers can't both take the one C slot", async () => {
  const { chooseLockSlot } = await import("../js/swaps.js");
  const pos = { sab: ["C", "PF"] };
  const rows = [{ key: "C", label: "C", current: "sab", keepScore: null }];
  const cands = [{ key: "sab", positions: ["C", "PF"], value: 40 }];
  const first = chooseLockSlot({ key: "U1", label: "UTIL", positions: ["C"] }, rows, cands, (k) => pos[k] || []);
  assert.equal(first.label, "C");
  // after the first center takes C (Sabonis moves to his UTIL), the second has nowhere better
  const after = [{ key: "U1", label: "UTIL", current: "sab", keepScore: null }];
  assert.equal(chooseLockSlot({ key: "U2", label: "UTIL", positions: ["C"] }, after, cands, (k) => pos[k] || []), null);
});
