import test from "node:test";
import assert from "node:assert/strict";
import { addBackups, chainOf } from "../js/chains.js";
import { slotValue } from "../js/lockmath.js";

const game = (date, mu, tip = null, p = 0.05) => ({ date, tip: tip ? `${date}T${tip}` : null, mu, sigma: 0.35 * mu, p });

test("a later tip-off is a free second chance: worth more than either player alone", () => {
  const a = { key: "markkanen", games: [game("2026-10-25", 50, "15:30")] };
  const b = { key: "reed", games: [game("2026-10-25", 44, "19:00")] };
  const chain = chainOf([a, b]);
  assert.deepEqual(chain.map((g) => g.who), ["markkanen", "reed"]);
  assert.ok(slotValue(chain) > slotValue(a.games) + 3);         // keep a big early game, else take Reed's
});

test("without tip-off times, same-day games are simultaneous: just the better one", () => {
  const a = { key: "a", games: [game("2026-10-25", 50)] };
  const b = { key: "b", games: [game("2026-10-25", 44)] };
  const chain = chainOf([a, b]);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].who, "a");
  assert.ok(Math.abs(slotValue(chain) - slotValue(a.games)) < 1e-9);
});

test("back-to-back linkage only survives between the same player's consecutive nights", () => {
  const n1 = { ...game("2026-10-24", 40, "19:00"), pIfPrevPlayed: 0.3, pIfPrevSat: 0.01 };
  const a = { key: "a", games: [game("2026-10-23", 40, "19:00"), { ...n1 }] };
  const b = { key: "b", games: [{ ...game("2026-10-24", 60, "19:30"), pIfPrevPlayed: 0.5, pIfPrevSat: 0.02 }] };
  const chain = chainOf([a, b]);
  const bGame = chain.find((g) => g.who === "b");
  assert.ok(bGame && bGame.pIfPrevPlayed === undefined);       // b's night 2 isn't linked to a's game
});

test("leftover bench players go where they add most, one slot each", () => {
  const rows = [{ key: "U1", label: "UTIL", current: "x" }, { key: "U2", label: "UTIL", current: "y" }];
  const x = { key: "x", positions: ["SF"], games: [game("2026-10-25", 30, "15:00")] };
  const y = { key: "y", positions: ["SF"], games: [game("2026-10-25", 50, "15:00")] };
  const z = { key: "z", positions: ["SF"], games: [game("2026-10-25", 40, "21:00")] };
  const groups = addBackups(rows, { U1: [x], U2: [y] }, [x, y, z]);
  assert.deepEqual(groups.U1.map((c) => c.key), ["x", "z"]);   // z backs up the weaker slot
  assert.deepEqual(groups.U2.map((c) => c.key), ["y"]);
});

test("backups only cover the main player's days, later the same day: no streaming across days", () => {
  const main = { key: "miller", games: [game("2026-10-26", 45, "19:00"), game("2026-10-28", 45, "19:00")] };
  const pj = { key: "pj", games: [game("2026-10-26", 40, "19:30"), game("2026-10-27", 60, "19:00"), game("2026-10-28", 40, "18:00")] };
  const chain = chainOf([main, pj]);
  assert.deepEqual(chain.map((g) => `${g.who} ${g.date.slice(5)}`), ["miller 10-26", "pj 10-26", "miller 10-28"]);
});
