import test from "node:test";
import assert from "node:assert/strict";
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
const { rankPlayers, autoMinGames } = await import("../js/rankings.js");

const P = (pid, fps, start = 20) => ({ pid, name: pid, team: "T", pos: ["PG"], games: fps.map((fp, i) => [`2026-10-${String(start + i).padStart(2, "0")}`, fp, 30]) });

test("ranks by points per game; a short hot streak needs the minimum games", () => {
  const players = [P("steady", [50, 52, 48, 50, 50]), P("streak", [90, 85]), P("bench", [10, 12, 8, 9, 11])];
  const { list, hidden } = rankPlayers(players, { minGames: 3 });
  assert.deepEqual(list.map((r) => r.pid), ["steady", "bench"]);
  assert.equal(hidden, 1);
  assert.equal(list[0].rank, 1);
  assert.equal(list[0].pg, 50);
  assert.equal(rankPlayers(players, { minGames: 1 }).list[0].pid, "streak");
});

test("season total ranks volume; asOf ranks as of an earlier date", () => {
  const players = [P("many", [40, 40, 40, 40]), P("few", [60, 60])];
  assert.equal(rankPlayers(players, { by: "total" }).list[0].pid, "many");     // 160 vs 120
  assert.equal(rankPlayers(players, { by: "pg" }).list[0].pid, "few");
  const early = rankPlayers([P("late", [30, 30, 100, 100]), P("even", [50, 50, 50, 50])], { asOf: "2026-10-21" });
  assert.equal(early.list[0].pid, "even");                                       // late's big games hadn't happened
});

test("automatic minimum: 40% of a typical team's games, at least 1", () => {
  assert.equal(autoMinGames(0), 1);
  assert.equal(autoMinGames(2), 1);
  assert.equal(autoMinGames(15), 6);
});
