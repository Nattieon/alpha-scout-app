import test from "node:test";
import assert from "node:assert/strict";
import { buildModel, fantasyPoints, matchupBar } from "../js/model.js";
import { lockCall, slotValue } from "../js/lockmath.js";

// League scoring copied from a real Sleeper Lock-In league.
const SCORING = { ast: 2, blk: 3.5, bonus_ast_15p: 2, bonus_pt_40p: 2, bonus_pt_50p: 2, bonus_reb_20p: 2, dd: 1, ff: 0,
  fga: -0.85, fgm: 2, ftm: 1, ftmi: -1, pts: 1, reb: 1, stl: 4, td: 2, tf: 0, to: -1.5, tpm: 1 };

test("fantasy points match Sleeper (bonuses, dd, missed FT)", () => {
  // 41 pts, 12 reb, 6 ast, 2 stl, 1 blk, 3 to, 14-25 FG, 9-10 FT, 4 3PM
  const s = { pts: 41, reb: 12, ast: 6, stl: 2, blk: 1, to: 3, fgm: 14, fga: 25, ftm: 9, fta: 10, tpm: 4 };
  // 41+12+12+8+3.5-4.5+28-21.25+9-1+4 +dd 1 +40p bonus 2 = 93.75
  assert.equal(fantasyPoints(s, SCORING), 93.75);
  assert.equal(fantasyPoints(s, SCORING, { projected: true }), 91.75);   // no bonus on projections
  assert.equal(fantasyPoints({}, SCORING), null);
});

// ------------------------------------------------------------------ synthetic week
// Week 1 = Mon Oct 19 .. Sun Oct 25; "today" = Fri Oct 23.
const DAYS = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
const TEAMS = { AAA: [1, 3, 5], BBB: [0, 2, 4], CCC: [1, 2, 6], DDD: [3, 4], EEE: [1, 3, 5], FFF: [2, 4, 5] };
const schedule = [];
for (const [t, idx] of Object.entries(TEAMS)) idx.forEach((i) => schedule.push({
  date: DAYS[i], week: 1, game_id: `${t}${i}`, home: { team: t }, away: { team: "ZZZ" },
  status: DAYS[i] < "2026-10-23" ? "complete" : DAYS[i] === "2026-10-23" ? (t === "BBB" ? "in_game" : "pre_game") : "pre_game",
}));
const line = (pts) => ({ min: 32, pts, reb: 6, ast: 4, stl: 1, blk: 1, to: 2, fgm: Math.round(pts / 2.4), fga: Math.round(pts / 1.1), ftm: 2, fta: 3 });
const PL = { first_name: "P", last_name: "", fantasy_positions: ["G"] };
const stat = (pid, team, i, pts) => ({ player_id: pid, date: DAYS[i], team, stats: pts === null ? {} : line(pts), player: { ...PL, last_name: pid, team } });
const proj = (pid, team, i, pts, inj = null) => ({ player_id: pid, date: DAYS[i], team, stats: pts === null ? {} : { ...line(pts), min: 30 }, player: { ...PL, last_name: pid, team, injury_status: inj } });

const fp = (pts) => fantasyPoints(line(pts), SCORING);
const stats = [
  stat("lockedEarly", "AAA", 1, 40), stat("lockedEarly", "AAA", 3, 18),     // locked Tue, played Thu
  stat("pending", "CCC", 1, 22), stat("pending", "CCC", 2, 30),             // played Tue, Wed; plays Sun
  stat("final", "DDD", 3, 25),                                              // Thu then Fri (today) is last
  stat("live", "BBB", 0, 20), stat("live", "BBB", 2, 24), stat("live", "BBB", 4, 9),   // game tonight in progress
  stat("oppHot", "EEE", 1, 48), stat("oppHot", "EEE", 3, 50),
  stat("oppCold", "FFF", 2, 12),
];
const projections = [];
for (const [pid, team] of [["lockedEarly", "AAA"], ["pending", "CCC"], ["final", "DDD"], ["live", "BBB"], ["fresh", "FFF"], ["oppHot", "EEE"], ["oppCold", "FFF"]])
  TEAMS[team].forEach((i) => projections.push(proj(pid, team, i, 24, pid === "pending" ? "Questionable" : null)));

const matchups = [
  { roster_id: 1, matchup_id: 1, starters: ["lockedEarly", "pending", "final", "live", "fresh", "0"],
    starters_points: [fp(40), fp(30), fp(25), fp(9), 0, 0], players_points: {}, points: 0 },
  { roster_id: 2, matchup_id: 1, starters: ["oppHot", "oppCold"], starters_points: [fp(50), fp(12)], players_points: {}, points: 0 },
];
const raw = {
  league: { name: "Test", scoring_settings: SCORING, roster_positions: ["PG", "SG", "G", "SF", "PF", "UTIL", "BN"] },
  rosters: [{ roster_id: 1, owner_id: "me" }, { roster_id: 2, owner_id: "them" }],
  users: [{ user_id: "me", display_name: "Me" }, { user_id: "them", display_name: "Them" }],
  matchups, schedule, stats, projections, week: 1, today: "2026-10-23",
};

test("every slot state is classified from Sleeper's numbers", () => {
  const m = buildModel(raw, "me");
  const k = Object.fromEntries(m.me.slots.map((s) => [s.pid || "empty", s]));
  assert.equal(k.lockedEarly.kind, "locked");                    // slot shows Tue score, not Thu
  assert.equal(k.lockedEarly.lockedGame.date, "2026-10-20");
  assert.equal(k.pending.kind, "pending");                       // Wed done, Sun still to come
  assert.ok(["LOCK", "PASS"].includes(k.pending.call.verdict));
  assert.ok(k.pending.games[0].why.includes("listed Questionable"));
  assert.equal(k.final.kind, "pending");                         // Thu done, last game tonight: lock Thu or take tonight
  assert.equal(k.live.kind, "live");
  assert.equal(k.fresh.kind, "open");
  assert.equal(k.empty.kind, "empty");
  const o = Object.fromEntries(m.opp.slots.map((s) => [s.pid, s]));
  assert.equal(o.oppHot.kind, "assumed-locked");                 // 50-pt game, way above his bar
  assert.equal(o.oppCold.kind, "assumed-open");
  assert.ok(m.win > 0 && m.win < 1);
});

test("final game, tonight bars and manual locks", () => {
  const m = buildModel(raw, "me");
  const final = m.me.slots.find((s) => s.pid === "final");
  assert.ok(final.tonight && final.tonight.final);               // tonight is his last game
  const live = m.me.slots.find((s) => s.pid === "live");
  assert.ok(live.tonight && live.tonight.after.length === 0 ? live.tonight.final : live.tonight.bar > 0);
  const pend = m.me.slots.find((s) => s.pid === "pending");
  const marked = buildModel(raw, "me", {}, new Set([pend.markKey]));
  const p2 = marked.me.slots.find((s) => s.pid === "pending");
  assert.equal(p2.kind, "locked");
  assert.ok(p2.manual);
});

test("points-only mode ignores the opponent", () => {
  const m = buildModel(raw, "me", { mode: "ev" });
  const pend = m.me.slots.find((s) => s.pid === "pending");
  assert.equal(pend.call.winIfLock, undefined);
  assert.equal(m.mode, "ev");
});

test("matchup bar is consistent with lockCall", () => {
  const games = [{ mu: 35, sigma: 11, p: 0.04 }, { mu: 35, sigma: 11, p: 0.04 }];
  const others = [{ mean: 352, variance: 200 }], theirs = [{ mean: 360, variance: 200 }];
  const bar = matchupBar(games, others, theirs);
  assert.ok(bar < slotValue(games));                             // ahead -> lower bar
  assert.equal(lockCall(bar + 0.1, games, others, theirs).verdict, "LOCK");
  assert.equal(lockCall(bar - 0.5, games, others, theirs).verdict, "PASS");
});

test("opponent lock marks override the rational-opponent guess", () => {
  const auto = buildModel(raw, "me");
  const hot = auto.opp.slots.find((s) => s.pid === "oppHot");
  assert.equal(hot.kind, "assumed-locked");
  assert.ok(hot.ambiguous && hot.markKey);
  const cold = auto.opp.slots.find((s) => s.pid === "oppCold");

  const marked = buildModel(raw, "me", {}, { [hot.markKey]: "open", [cold.markKey]: "locked" });
  const hot2 = marked.opp.slots.find((s) => s.pid === "oppHot");
  const cold2 = marked.opp.slots.find((s) => s.pid === "oppCold");
  assert.equal(hot2.kind, "open");
  assert.ok(hot2.value.variance > 0);
  assert.equal(cold2.kind, "locked");
  assert.equal(cold2.value.mean, cold.score);
  assert.ok(marked.opp.banked >= cold.score);           // a marked lock is banked
  assert.ok(marked.win !== auto.win);                   // and it moves the win probability
});

test("a player's own game log sets his percentiles and his bar", () => {
  const steady = Array.from({ length: 70 }, (_, k) => ({ date: `2026-0${1 + (k % 3)}-${String(1 + (k % 28)).padStart(2, "0")}`, stats: line(24 + ((k % 5) - 2)) }));
  const swingy = Array.from({ length: 70 }, (_, k) => ({ date: `2026-0${1 + (k % 3)}-${String(1 + (k % 28)).padStart(2, "0")}`, stats: line([8, 14, 24, 36, 40][k % 5]) }));
  const base = buildModel(raw, "me");
  const pend = base.me.slots.find((s) => s.pid === "pending");
  const withLog = (log) => buildModel({ ...raw, logs: { pending: log } }, "me").me.slots.find((s) => s.pid === "pending");
  const a = withLog(steady), b = withLog(swingy);
  assert.equal(pend.pctScore, null);                   // no log -> no percentile shown
  assert.ok(a.pctScore > 0.95);                         // 30-pt game is a ceiling game for a steady 24-pt guy
  assert.ok(b.pctScore < a.pctScore);                   // ...but routine for a boom-or-bust guy
  // One game left: the bar is just that game's expected score, so spread can't matter.
  assert.ok(Math.abs(b.bar - a.bar) < 1e-6);
  assert.ok(b.call.pBelow !== a.call.pBelow);            // ...but the odds of ending lower do
});
