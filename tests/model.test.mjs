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
  stat("pending", "CCC", 1, 8), stat("pending", "CCC", 2, 30),              // played Tue (poor, not worth locking), Wed; plays Sun
  stat("final", "DDD", 3, 25),                                              // Thu then Fri (today) is last
  stat("live", "BBB", 0, 12), stat("live", "BBB", 2, 14), stat("live", "BBB", 4, 9),   // game tonight in progress; earlier games not worth locking
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
  assert.equal(k.lockedEarly.kind, "assumed-locked");            // Tue 40 beat his rest of week: a sensible manager locked it
  assert.ok(k.lockedEarly.guess);
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
  assert.ok(hot.markKey);
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

test("any earlier game can be marked as the locked one, for either team", () => {
  // lockedEarly: Tue 40, Thu 18. Unmarked, Tue is guessed as locked (Sleeper never shows locks).
  const auto = buildModel(raw, "me");
  const le = auto.me.slots.find((x) => x.pid === "lockedEarly");
  assert.equal(le.kind, "assumed-locked"); assert.ok(le.guess);
  assert.deepEqual(le.lockable.map((g) => g.date), ["2026-10-20", "2026-10-22"]);

  // Viewer says it was actually Thursday's game that got locked: the mark wins.
  const thu = buildModel(raw, "me", {}, { lockedEarly: "2026-10-22" }).me.slots.find((x) => x.pid === "lockedEarly");
  assert.equal(thu.kind, "locked"); assert.ok(thu.manual);
  assert.equal(thu.lockedGame.date, "2026-10-22");
  assert.equal(thu.value.mean, fp(18));

  // Viewer says nothing is locked: the slot reopens with his remaining games.
  const open = buildModel(raw, "me", {}, { lockedEarly: "open" }).me.slots.find((x) => x.pid === "lockedEarly");
  assert.ok(open.kind !== "locked");
  assert.ok(open.value.variance > 0);

  // Opponent: mark an earlier game (Tue) even though his latest game is Thu.
  const opp = buildModel(raw, "me", {}, { oppHot: "2026-10-20" }).opp.slots.find((x) => x.pid === "oppHot");
  assert.equal(opp.kind, "locked");
  assert.equal(opp.value.mean, fp(48));
});

test("old mark formats still load", () => {
  const a = buildModel(raw, "me", {}, new Set(["pending@2026-10-21"])).me.slots.find((x) => x.pid === "pending");
  assert.equal(a.kind, "locked"); assert.equal(a.lockedGame.date, "2026-10-21");
  const b = buildModel(raw, "me", {}, { "oppHot@2026-10-22": "open" }).opp.slots.find((x) => x.pid === "oppHot");
  assert.equal(b.kind, "open");
});

test("projected total: next-game basis vs expected-final basis", () => {
  const next = buildModel(raw, "me");                       // default: next game
  const smart = buildModel(raw, "me", { projBasis: "smart" });
  const fresh = next.me.slots.find((x) => x.pid === "fresh");
  assert.equal(fresh.shownProj, fresh.nextProj);            // not locked -> Sleeper's next-game projection
  const le = next.me.slots.find((x) => x.pid === "lockedEarly");
  assert.equal(le.shownProj, le.value.mean);                // locked -> its score
  assert.ok(Math.abs(next.me.proj - smart.me.proj) > 0.01);
  assert.equal(next.win, smart.win);                        // win odds never depend on the display basis
});

test("bench players are listed with their next projection", () => {
  const withBench = { ...raw, matchups: raw.matchups.map((m) => m.roster_id === 1 ? { ...m, players: [...m.starters, "benchGuy"], players_points: { benchGuy: 12 } } : m),
    projections: [...raw.projections, proj("benchGuy", "AAA", 5, 30)] };
  const m = buildModel(withBench, "me");
  assert.equal(m.me.bench.length, 1);
  assert.equal(m.me.bench[0].pid, "benchGuy");
  assert.ok(m.me.bench[0].nextProj > 0);
  assert.ok(!m.me.slots.some((x) => x.pid === "benchGuy"));
});

test("an undecided slot the app says to LOCK counts its score, unless marked Not locked", () => {
  const m = buildModel(raw, "me");
  const pend = m.me.slots.find((x) => x.pid === "pending");
  assert.equal(pend.call.verdict, "LOCK");
  assert.equal(pend.shownProj, pend.score);
  const open = buildModel(raw, "me", {}, { pending: "open" }).me.slots.find((x) => x.pid === "pending");
  assert.equal(open.kind, "pending");                      // still your decision...
  assert.equal(open.shownProj, open.nextProj);              // ...but Proj now uses his next game
});

test("sit-risk profile from his log, and the 'sits back-to-backs' checkbox", () => {
  // "fresh" (team FFF) plays Thu, Fri(today), Sat: Fri-Sat is a back-to-back that ends his week.
  const base = buildModel(raw, "me");
  const fresh = () => (m) => m.me.slots.find((x) => x.pid === "fresh");
  const f0 = fresh()(base);
  const sat0 = f0.games.find((g) => g.date === "2026-10-24");
  assert.equal(sat0.b2b, 2);                                       // night 2 of Fri-Sat
  assert.ok(sat0.pIfPrevPlayed > sat0.pIfPrevSat);

  const flagged = buildModel(raw, "me", { b2bFlags: { fresh: true } });
  const f1 = fresh()(flagged);
  const sat1 = f1.games.find((g) => g.date === "2026-10-24");
  assert.ok(sat1.pIfPrevPlayed > 0.9);
  assert.ok(f1.tonight.evBar < f0.tonight.evBar - 10, `${f1.tonight.evBar} vs ${f0.tonight.evBar}`);   // lock tonight much more readily

  // A log full of second-night rests raises his back-to-back risk without any checkbox.
  const dates = []; let d = "2025-10-21";
  for (let k = 0; k < 80; k++) { dates.push(d); d = new Date(Date.parse(d + "T12:00:00Z") + (k % 6 === 4 ? 1 : 2) * 86400000).toISOString().slice(0, 10); }
  const log = dates.map((date, i) => ({ date, team: "FFF", stats: i > 0 && dates[i - 1] === new Date(Date.parse(date + "T12:00:00Z") - 86400000).toISOString().slice(0, 10) ? null : line(24) }));
  const fromLog = buildModel({ ...raw, logs: { fresh: log } }, "me");
  const f2 = fresh()(fromLog);
  assert.ok(f2.p.avail.q > 0.5, `q ${f2.p.avail.q}`);
  assert.ok(f2.games.find((g) => g.date === "2026-10-24").pIfPrevPlayed > sat0.pIfPrevPlayed + 0.3);
});

test("bench swaps: a stronger bench guard takes the G slot, a bench center fills the empty UTIL", () => {
  const withPos = (row, pos) => ({ ...row, player: { ...row.player, fantasy_positions: pos } });
  const bench = {
    ...raw,
    matchups: raw.matchups.map((m) => (m.roster_id === 1 ? { ...m, players: [...m.starters, "benchG", "benchC"] } : m)),
    // benchG: guard, plays Sun (team CCC) with a big projection. benchC: center, plays Sat (team EEE).
    projections: [...raw.projections, withPos(proj("benchG", "CCC", 6, 40), ["PG", "SG"]), withPos(proj("benchC", "EEE", 5, 30), ["C"])],
  };
  const m = buildModel(bench, "me");
  const slot = (pid) => m.me.slots.find((x) => x.pid === pid);
  const g = slot("final");                                  // G slot: Thu done, Fri (today) is his last game
  assert.equal(g.kind, "pending");
  assert.equal(g.call.verdict, "PASS");                     // passing + swapping in benchG beats keeping Thu
  assert.equal(g.swapIn?.key, "benchG");
  assert.ok(g.call.bar > g.score);
  const util = m.me.slots.find((x) => x.label === "UTIL");
  assert.equal(util.swapIn?.key, "benchC");                 // a C can't play G, but can fill UTIL
  const moves = m.swaps.map((x) => `${x.into.key}->${x.slot.label}`);
  assert.deepEqual(moves.sort(), ["benchC->UTIL", "benchG->G"]);
  assert.ok(m.swaps.every((x) => x.deadline && x.gain >= 1));
  // the plan's values feed the projection and win odds
  assert.ok(m.me.proj > buildModel(raw, "me").me.proj);
});

test("a swap whose bench player starts later keeps the current player in until then", () => {
  const withPos = (row, pos) => ({ ...row, player: { ...row.player, fantasy_positions: pos } });
  // "fresh" (PF, team FFF) plays tonight (Fri) and Sat; benchF plays only Sun with a big projection.
  const bench = {
    ...raw,
    matchups: raw.matchups.map((m) => (m.roster_id === 1 ? { ...m, players: [...m.starters, "benchF"] } : m)),
    projections: [...raw.projections, withPos(proj("benchF", "CCC", 6, 60), ["PF"])],
    league: { ...raw.league, roster_positions: ["PG", "SG", "G", "SF", "PF", "C", "BN"] },
  };
  const m = buildModel(bench, "me");
  const sw = m.swaps.find((x) => x.into.key === "benchF");
  assert.ok(sw, "swap suggested");
  assert.equal(sw.slot.pid, "fresh");
  assert.deepEqual(sw.keepFirst.map((g) => g.date), ["2026-10-23", "2026-10-24"]);   // let him play Fri + Sat first
  const fresh = m.me.slots.find((x) => x.pid === "fresh");
  assert.ok(fresh.tonight && fresh.tonight.afterBy?.key === "benchF");                // tonight's bar counts the fallback
  assert.ok(fresh.tonight.bar > 0);
});

test("'benched through' marks: games played from the bench can't be locked", () => {
  // "pending" (SG, team CCC): Tue 22, Wed 30, then Sun.
  const base = buildModel(raw, "me").me.slots.find((x) => x.pid === "pending");
  assert.equal(base.kind, "pending");
  assert.equal(base.lastDone.date, "2026-10-21");
  // Benched through Wed: nothing lockable this week, the slot rides on his Sun game.
  const b = buildModel(raw, "me", {}, { pending: "after:2026-10-21" }).me.slots.find((x) => x.pid === "pending");
  assert.equal(b.kind, "open");
  assert.equal(b.call, undefined);
  assert.equal(b.lockable.length, 0);
  assert.ok(b.value.mean < base.score);
  // Benched only on Tue: Wed's game is his and still the decision.
  const c = buildModel(raw, "me", {}, { pending: "after:2026-10-20" }).me.slots.find((x) => x.pid === "pending");
  assert.equal(c.kind, "pending");
  assert.equal(c.lastDone.date, "2026-10-21");
  assert.deepEqual(c.lockable.map((g) => g.date), ["2026-10-21"]);
});

test("opponent bench swaps are a setting", () => {
  const withPos = (row, pos) => ({ ...row, player: { ...row.player, fantasy_positions: pos } });
  // Opponent's oppCold (FFF) is weak; his bench has a big Sun game.
  const r = {
    ...raw,
    matchups: raw.matchups.map((m) => (m.roster_id === 2 ? { ...m, players: [...m.starters, "oppBench"] } : m)),
    projections: [...raw.projections, withPos(proj("oppBench", "CCC", 6, 50), ["PG", "SG", "SF", "PF", "C"])],
  };
  const off = buildModel(r, "me", { oppSwaps: false });
  const on = buildModel(r, "me");                           // on by default
  assert.equal(off.oppSwaps.length, 0);
  assert.ok(on.oppSwaps.some((x) => x.into.key === "oppBench"));
  assert.ok(on.opp.slots.some((x) => x.swapIn?.key === "oppBench"));
  assert.ok(on.win < off.win);                               // his swap makes the matchup harder
});

test("any team's side of the week can be viewed", () => {
  const m = buildModel({ ...raw, viewRosterId: 2 }, "me");
  assert.equal(m.me.name, "Them");
  assert.equal(m.opp.name, "Me");
  assert.deepEqual(m.me.slots.map((s) => s.pid).filter(Boolean), ["oppHot", "oppCold"]);
});

test("win % is the same matchup from either side: yours + theirs = 100%", () => {
  const withPos = (row, pos) => ({ ...row, player: { ...row.player, fantasy_positions: pos } });
  const r = {   // give both teams a bench, so swaps are planned on both sides
    ...raw,
    matchups: raw.matchups.map((m) => ({ ...m, players: [...m.starters, m.roster_id === 1 ? "myBench" : "oppBench"] })),
    projections: [...raw.projections, withPos(proj("myBench", "AAA", 5, 30), ["PG", "SG"]), withPos(proj("oppBench", "CCC", 6, 50), ["SF", "PF"])],
  };
  const cases = [
    [{}, {}], [{ mode: "ev" }, {}],
    [{}, { pending: "open" }], [{}, { oppHot: "open", oppCold: "locked" }], [{}, { pending: "2026-10-20" }],
  ];
  for (const [cfg, marks] of cases) {
    const a = buildModel(r, "me", cfg, marks), b = buildModel({ ...r, viewRosterId: 2 }, "me", cfg, marks);
    assert.ok(Math.abs(a.win + b.win - 1) < 1e-9, `${JSON.stringify([cfg, marks])}: ${a.win} + ${b.win}`);
    assert.ok(Math.abs(a.me.proj - b.opp.proj) < 1e-9 && Math.abs(a.opp.proj - b.me.proj) < 1e-9);
  }
});

test("Sleeper's slot score is never read as a lock (it shows his latest game until the week is finalized)", () => {
  // final (DDD): Thu 25, Fri tonight. Sleeper shows a stale-looking number: no lock may be inferred from it.
  const r = { ...raw, matchups: raw.matchups.map((m) => (m.roster_id === 1 ? { ...m, starters_points: m.starters_points.map((x, i) => (i === 2 ? 99 : x)) } : m)) };
  const s = buildModel(r, "me").me.slots.find((x) => x.pid === "final");
  assert.notEqual(s.kind, "locked");
  assert.ok(!s.certain);
});

test("'not locked through' marks close earlier lock windows without a guess", () => {
  const le = buildModel(raw, "me", {}, { lockedEarly: "pass:2026-10-20" }).me.slots.find((x) => x.pid === "lockedEarly");
  assert.equal(le.kind, "pending");                      // Tue wasn't locked; Thu is the open decision
  assert.equal(le.lastDone.date, "2026-10-22");
  assert.equal(le.passedThrough, "2026-10-20");
  assert.deepEqual(le.lockable.map((g) => g.date), ["2026-10-22"]);
  // and the two sides still mirror each other
  const a = buildModel(raw, "me", {}, { lockedEarly: "pass:2026-10-20" }), b = buildModel({ ...raw, viewRosterId: 2 }, "me", {}, { lockedEarly: "pass:2026-10-20" });
  assert.ok(Math.abs(a.win + b.win - 1) < 1e-9);
});
