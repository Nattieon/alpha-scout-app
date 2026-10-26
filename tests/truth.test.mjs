import test from "node:test";
import assert from "node:assert/strict";
import { solveCounted } from "../js/truth.js";

// Week 1 of the real league, Yuki bless my tank: the app showed 548.85 (proj 446.92).
const g = (date, fp, pj) => ({ date, fp, pj });
const slots = [
  { key: "VanVleet", games: [g("10-21", 44.7, 40), g("10-23", 43.5, 41), g("10-24", 0, 40)] },
  { key: "Mitchell", games: [g("10-22", 65.85, 55), g("10-24", 45.75, 54)] },
  { key: "Fox", games: [g("10-20", 41.35, 45), g("10-23", 51.15, 46), g("10-24", 60.15, 45.5)] },
];

test("score alone can be ambiguous; the projection total picks one", () => {
  // two slots, two games each: 10 + 20 and 20 + 10 both make 30; their projections (12 vs 15) don't tie
  const amb = [{ key: "a", games: [g("1", 10, 5), g("2", 20, 9)] }, { key: "b", games: [g("1", 20, 7), g("2", 10, 6)] }];
  assert.equal(solveCounted(amb, { points: 30 }).length, 2);
  assert.deepEqual(solveCounted(amb, { points: 30, proj: 12 }), [{ a: "1", b: "1" }]);
  assert.deepEqual(solveCounted(amb, { points: 30, proj: 15 }), [{ a: "2", b: "2" }]);
});

test("a game he didn't play can only count if it's his last", () => {
  const sols = solveCounted(slots, { points: 44.7 + 65.85 + 51.15 });
  assert.deepEqual(sols, [{ VanVleet: "10-21", Mitchell: "10-22", Fox: "10-23" }]);
  const dnp = solveCounted(slots, { points: 0 + 45.75 + 60.15 });
  assert.deepEqual(dnp, [{ VanVleet: "10-24", Mitchell: "10-24", Fox: "10-24" }]);
});
