import test from "node:test";
import assert from "node:assert/strict";
import { availabilityProfile, gameSitRisks, shiftDay, AVAIL_DEFAULTS } from "../js/availability.js";

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

/** A season of team games every other day, with a back-to-back every 6th game. */
function season(start, nGames, team = "AAA") {
  const dates = []; let d = start;
  for (let k = 0; k < nGames; k++) { dates.push(d); d = shiftDay(d, k % 6 === 4 ? 1 : 2); }
  return dates.map((date) => ({ date, team, played: true }));
}
const pairsOf = (rows) => rows.map((r, i) => i).filter((i) => i + 1 < rows.length && rows[i + 1].date === shiftDay(rows[i].date, 1));

test("no history -> league defaults", () => {
  const p = availabilityProfile([], "2026-10-20");
  close(p.normal, AVAIL_DEFAULTS.normalPrior, 1e-12, "normal");
  close(p.q, AVAIL_DEFAULTS.pairPrior, 1e-12, "q");
  close(p.s, AVAIL_DEFAULTS.nightPrior, 1e-12, "s");
  assert.equal(p.ramp, 0);
});

test("a player who rests the second night of most back-to-backs", () => {
  const rows = season("2025-10-21", 80);
  const pairs = pairsOf(rows);
  pairs.slice(0, 10).forEach((i) => (rows[i + 1].played = false));      // sits night 2 of 10 of 13 pairs
  const p = availabilityProfile(rows, "2026-10-20");
  assert.equal(p.history.n2, 10);
  assert.ok(p.q > 0.45 && p.q < 0.65, `q ${p.q}`);
  assert.ok(p.s > 0.85, `s ${p.s}`);
  close(p.normal, AVAIL_DEFAULTS.normalPrior * 20 / (20 + p.history.games), 0.001, "never missed an ordinary game");
});

test("long injuries don't count as rest, but they do start a return ramp", () => {
  const rows = season("2025-10-21", 82);
  for (let i = 30; i < 75; i++) rows[i].played = false;                // 45-game injury
  const p = availabilityProfile(rows, "2026-10-20");
  assert.ok(p.normal < 0.05, "injury stretch excluded from normal rate");
  assert.equal(p.absence, 45);
  assert.equal(p.gamesBack, 7);
  assert.ok(p.ramp > 0 && p.ramp <= 1 - 7 / 25, `ramp ${p.ramp}`);
  close(p.durability, 45 / 82, 1e-9, "durability");
});

test("whole season out, a few games back this season (VanVleet-style)", () => {
  const prev = season("2025-10-21", 82).map((r) => ({ ...r, played: false }));
  const cur = season("2026-10-20", 3);
  const p = availabilityProfile([...prev, ...cur], "2026-10-20");
  assert.equal(p.gamesBack, 3);
  close(p.ramp, 1 - 3 / 25, 1e-9, "ramp");
});

test("linked nights: sits night 1 -> night 2 is safe; plays night 1 -> rest still to come", () => {
  const profile = { normal: 0.03, q: 0.4, s: 0.73, durability: 0, ramp: 0 };
  const team = new Set(["2026-10-23", "2026-10-24"]);
  const [fri, sat] = gameSitRisks(profile, ["2026-10-23", "2026-10-24"], team);
  close(fri.p, 1 - (1 - 0.03) * (1 - 0.4 * 0.27), 1e-9, "night 1");
  assert.ok(sat.pIfPrevPlayed > sat.p && sat.p > sat.pIfPrevSat);
  close(sat.pIfPrevSat, 0.03, 1e-9, "rest used up");
  close(sat.pIfPrevPlayed, 1 - (1 - 0.03) * (1 - 0.4 * 0.73 / (1 - 0.4 * 0.27)), 1e-9, "after playing night 1");
  // night 1 already happened (yesterday): its outcome is known
  const [satKnown] = gameSitRisks(profile, ["2026-10-24"], team, { prevPlayed: true });
  close(satKnown.p, sat.pIfPrevPlayed, 1e-12, "known: played");
  const [satKnown2] = gameSitRisks(profile, ["2026-10-24"], team, { prevPlayed: false });
  close(satKnown2.p, 0.03, 1e-12, "known: sat");
});

test("a Sunday that is night 1 of a Sunday-Monday pair carries night-1 risk", () => {
  const profile = { normal: 0.03, q: 0.4, s: 0.73, durability: 0, ramp: 0 };
  const [sun] = gameSitRisks(profile, ["2026-10-25"], new Set(["2026-10-25", "2026-10-26"]));
  close(sun.p, 1 - 0.97 * (1 - 0.4 * 0.27), 1e-9, "sun");
  assert.ok(sun.why.some((w) => w.includes("back-to-back")));
});

test("the 'sits back-to-backs' checkbox, the ramp and injury tags", () => {
  const plain = { normal: 0.03, q: 0.1, s: 0.73, durability: 0, ramp: 0 };
  const team = new Set(["2026-10-23", "2026-10-24"]);
  const [, sat] = gameSitRisks(plain, ["2026-10-23", "2026-10-24"], team, { flagged: true });
  assert.ok(sat.pIfPrevPlayed > 0.9, `flagged ${sat.pIfPrevPlayed}`);       // 95% pair rest, mostly night 2
  assert.ok(sat.why.includes("you marked him as resting back-to-backs"));
  const returning = { ...plain, ramp: 0.88, absence: 82, gamesBack: 3 };
  const [, satR] = gameSitRisks(returning, ["2026-10-23", "2026-10-24"], team);
  assert.ok(satR.pIfPrevPlayed > 0.5, `ramp ${satR.pIfPrevPlayed}`);
  assert.ok(satR.why.some((w) => w.startsWith("back from a 82-game absence")));
  const [q1, q2] = gameSitRisks(plain, ["2026-10-21", "2026-10-25"], new Set(), { injury: "Questionable" });
  assert.ok(q1.p > 0.45 && q2.p < q1.p);                                // tag fades for later games
});
