// Alpha Scout snapshots: saves what the app would have shown, for every matchup, so any
// decision point can be reviewed later and new math can be re-run on old days.
//
//   node scripts/snapshot.mjs nightly --data <dir>          full snapshot of every matchup (after the night's games)
//   node scripts/snapshot.mjs tick    --data <dir>          light check: lineups, transactions, injuries; full
//                                                           snapshot only when something changed
//   node scripts/snapshot.mjs replay  --data <dir> --week N rebuild a finished week, night by night, from Sleeper's final data
//
// Leagues: every NBA league of the users in scripts/snapshot.config.json.
// Layout under <dir>:
//   index.json                                        what exists (read by the app's History view)
//   schedule/{season}.json                            the season schedule (latest statuses)
//   logs/{season}/{pid}.json                          player game logs (shared by every snapshot)
//   leagues/{league}/{season}/w{NN}/
//     nightly/{date}.json                             outputs: every matchup, both teams, every slot and call
//     nightly/{date}.inputs.json.gz                   inputs: what the model read (rostered players only)
//     ticks/{stamp}.json                              outputs at a moment something changed during the day
//     events.json                                     lineup moves, injury changes, transactions, with times
//     state.json                                      last-seen lineups/injuries/transactions (for diffs)
//     replay/{date}.json                              a finished week rebuilt from final data (lower fidelity)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execSync } from "node:child_process";
import * as S from "../js/sleeper.js";
import { buildModel, DEFAULTS, fantasyPoints, todayET } from "../js/model.js";

const V1 = "https://api.sleeper.app/v1";
const args = process.argv.slice(2);
const mode = args[0];
const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const DATA = path.resolve(opt("data", "data"));
const HERE = path.dirname(new URL(import.meta.url).pathname);
const CONFIG = JSON.parse(fs.readFileSync(opt("config", path.join(HERE, "snapshot.config.json")), "utf8"));
const MODEL_VERSION = (() => { try { return execSync("git rev-parse --short=7 HEAD", { cwd: HERE, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "dev"; } })();
const NOW = opt("now") ? new Date(opt("now")) : new Date();

// ------------------------------------------------------------------ files
const rd = (f, d = null) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch { return d; } };
const wr = (f, v) => { const p = path.join(DATA, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); return p; };
const wrGz = (f, v) => { const p = path.join(DATA, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, zlib.gzipSync(JSON.stringify(v), { level: 9 })); };
const r2 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 100) / 100);
const r3 = (x) => (x === null || x === undefined ? null : Math.round(x * 1000) / 1000);
const pad = (n) => String(n).padStart(2, "0");
const etStamp = (d) => {   // "2026-10-26T21:37" in Eastern time
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
const shift = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const log = (...m) => console.log(...m);

async function getJSON(url) {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) { if (a >= 3) throw e; await new Promise((res) => setTimeout(res, 1500 * (a + 1))); }
  }
}

// ------------------------------------------------------------------ leagues
async function leaguesToSnap(season) {
  const ids = new Set(CONFIG.leagues || []);
  for (const name of CONFIG.users || []) {
    const u = await S.findUser(name);
    for (const l of await S.nbaLeagues(u.user_id, season)) ids.add(l.league_id);
  }
  return [...ids];
}

// ------------------------------------------------------------------ logs (shared files)
const prevSeason = (s) => String(Number(s) - 1);
async function playerLogs(pids, season, { refreshCurrent }) {
  const out = {}, queue = [...pids];
  async function worker() {
    while (queue.length) {
      const pid = queue.shift();
      const prevF = `logs/${prevSeason(season)}/${pid}.json`, curF = `logs/${season}/${pid}.json`;
      let prev = rd(prevF);
      if (!prev) { prev = await S.playerSeasonLog(pid, prevSeason(season), { final: true }); wr(prevF, prev); }
      let cur = refreshCurrent ? null : rd(curF);
      if (!cur) { cur = await S.playerSeasonLog(pid, season); wr(curF, cur); }
      out[pid] = [...prev, ...cur];
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

// ------------------------------------------------------------------ raw inputs for one league
const ROW_KEYS = new Set(["min", "pts", "reb", "ast", "stl", "blk", "to", "fgm", "fga", "ftm", "fta", "tpm", "tpa", "dd", "td", "sp"]);
function compactRow(r, scoring) {
  const keep = new Set([...ROW_KEYS, ...Object.keys(scoring)]);
  const stats = r.stats ? Object.fromEntries(Object.entries(r.stats).filter(([k]) => keep.has(k))) : r.stats;
  const p = r.player || {};
  return { player_id: r.player_id, date: r.date, team: r.team, game_id: r.game_id, stats,
    player: { first_name: p.first_name, last_name: p.last_name, team: p.team, injury_status: p.injury_status ?? null, fantasy_positions: p.fantasy_positions, position: p.position } };
}

async function leagueRaw(leagueId, { week, season, refreshLogs }) {
  const weeks = []; for (let w = Math.max(1, week - 3); w <= week; w++) weeks.push(w);
  const [league, rosters, users, matchups, schedule, statsW, projW] = await Promise.all([
    S.league(leagueId), S.rosters(leagueId, true), S.users(leagueId), S.matchups(leagueId, week, true), S.schedule(season, true),
    Promise.all(weeks.map((w) => S.weekStats(season, w, true))), Promise.all(weeks.map((w) => S.weekProjections(season, w, true))),
  ]);
  const scoring = league.scoring_settings || {};
  const reserve = new Set(rosters.flatMap((r) => r.reserve || []));
  const pids = [...new Set(matchups.flatMap((m) => [...(m.starters || []), ...(m.players || [])]))].filter((p) => p && p !== "0" && !reserve.has(p));
  const want = new Set(matchups.flatMap((m) => [...(m.starters || []), ...(m.players || [])]));
  const stats = statsW.flat().filter((r) => want.has(r.player_id)).map((r) => compactRow(r, scoring));
  const projections = projW.flat().filter((r) => want.has(r.player_id)).map((r) => compactRow(r, scoring));
  const known = new Set([...stats, ...projections].map((r) => r.player_id));
  let players;
  const missing = [...want].filter((p) => p && p !== "0" && !known.has(p));
  if (missing.length) {
    const dump = await S.allPlayers();
    players = Object.fromEntries(missing.filter((p) => dump[p]).map((p) => [p, { first_name: dump[p].first_name, last_name: dump[p].last_name, team: dump[p].team, injury_status: dump[p].injury_status, fantasy_positions: dump[p].fantasy_positions, position: dump[p].position }]));
  }
  if (refreshLogs) wr(`schedule/${season}.json`, schedule);   // nightly/replay only: it's big and changes mid-game
  const logs = await playerLogs(pids, season, { refreshCurrent: refreshLogs });
  return {
    league: { league_id: league.league_id, name: league.name, season: league.season, scoring_settings: scoring, roster_positions: league.roster_positions },
    rosters: rosters.map((r) => ({ roster_id: r.roster_id, owner_id: r.owner_id, co_owners: r.co_owners || null, reserve: r.reserve || [], players: r.players || [] })),
    users: users.map((u) => ({ user_id: u.user_id, display_name: u.display_name, metadata: { team_name: u.metadata?.team_name || null } })),
    matchups, schedule, week, stats, projections, players, logs,
  };
}

// ------------------------------------------------------------------ model outputs
function slotOut(s) {
  const o = { slot: s.label, pid: s.pid || null, name: s.p?.name || null, kind: s.kind, shown: r2(s.shown ?? s.value?.mean) };
  if (s.value) o.value = [r2(s.value.mean), r2(Math.sqrt(Math.max(s.value.variance || 0, 0)))];
  if (s.lockedGame) o.lockedGame = s.lockedGame.date;
  if (s.score !== undefined) { o.score = r2(s.score); o.decisionGame = s.lastDone?.date; o.pctScore = r3(s.p?.pct(s.score)); }
  if (s.call) o.call = { verdict: s.call.verdict, bar: r2(s.call.bar), winIfLock: r3(s.call.winIfLock), winIfPass: r3(s.call.winIfPass), flip: !!s.call.matchupFlip };
  if (s.forcedPass) o.forcedPass = true;
  if (s.swapIn) o.swapIn = { pid: s.swapIn.key, name: s.swapIn.p?.name, from: s.swapIn.from };
  if (s.contBy) o.passTo = { pid: s.contBy.key, name: s.contBy.p?.name };
  const games = s.contGames || s.games;
  if (games?.length) o.games = games.map((g) => ({ d: g.date, opp: g.opp, mu: r2(g.mu), p: r3(g.p) }));
  if (s.tonight?.bar !== undefined) o.tonightBar = r2(s.tonight.bar);
  if (s.p?.injury) o.injury = s.p.injury;
  return o;
}
function teamOut(t, swaps) {
  return { rosterId: t.rosterId, name: t.name, points: r2(t.points), proj: r2(t.proj), banked: r2(t.banked),
    slots: t.slots.map(slotOut),
    bench: (t.bench || []).map((b) => ({ pid: b.pid, name: b.p?.name, nextProj: r2(b.nextProj) })),
    swaps: (swaps || []).map((x) => ({ slot: x.slot.label, in: x.into.key, inName: x.into.p?.name, out: x.out?.pid || null, outName: x.out?.name || null, by: x.deadline, gain: r2(x.gain) })) };
}
function runMatchups(raw, cfg) {
  const ids = new Map();
  for (const m of raw.matchups) if (m.matchup_id) (ids.get(m.matchup_id) || ids.set(m.matchup_id, []).get(m.matchup_id)).push(m.roster_id);
  const out = [];
  for (const [mid, rids] of [...ids.entries()].sort((a, b) => a[0] - b[0])) {
    const a = Math.min(...rids);
    const m = buildModel({ ...raw, viewRosterId: a }, null, cfg, {});
    out.push({ matchupId: mid, win: r3(m.win), mode: m.mode, teams: [teamOut(m.me, m.swaps), m.opp ? teamOut(m.opp, m.oppSwaps) : null].filter(Boolean) });
  }
  return out;
}
const CFG = { ...DEFAULTS, b2bFlags: {} };

function inputsOf(raw) {   // everything but the shared files (logs, season schedule)
  const { logs, schedule, ...rest } = raw;
  const weekGames = schedule.filter((g) => g.week === raw.week).map((g) => [g.game_id, g.status, g.date]);
  return { ...rest, weekGames, logPids: Object.keys(logs) };
}

// ------------------------------------------------------------------ index
function touchIndex(leagueId, leagueName, season, week, what, item) {
  const idx = rd("index.json", { leagues: {} });
  const L = (idx.leagues[leagueId] ||= { name: leagueName, seasons: {} });
  L.name = leagueName;
  const W = ((L.seasons[season] ||= { weeks: {} }).weeks[week] ||= { nightly: [], ticks: [], replay: [] });
  if (what === "final") W.final = true;
  else if (item && !W[what].includes(item)) { W[what].push(item); W[what].sort(); }
  idx.updated = NOW.toISOString();
  wr("index.json", idx);
}
const weekDir = (leagueId, season, week) => `leagues/${leagueId}/${season}/w${pad(week)}`;

// ------------------------------------------------------------------ change detection
function lineupState(raw) {
  return Object.fromEntries(raw.matchups.map((m) => [m.roster_id, { starters: m.starters || [], players: [...(m.players || [])].sort() }]));
}
function injuryState(raw) {
  const out = {};
  const want = new Set(raw.matchups.flatMap((m) => m.players || []));
  for (const r of raw.projections) if (want.has(r.player_id) && r.date >= raw.today) out[r.player_id] = r.player?.injury_status || null;
  return out;
}
function diffEvents(prev, raw, txs, at, dump = {}) {
  const ev = [];
  const name = (pid) => {
    const r = [...raw.projections, ...raw.stats].find((x) => x.player_id === pid);
    const d = r?.player || raw.players?.[pid] || dump[pid];
    return d ? `${d.first_name} ${d.last_name}` : pid;
  };
  const team = (rid) => { const r = raw.rosters.find((x) => x.roster_id === Number(rid)); const u = raw.users.find((x) => x.user_id === r?.owner_id); return u?.metadata?.team_name || u?.display_name || `Team ${rid}`; };
  const labels = (raw.league.roster_positions || []).filter((s) => !["BN", "IR", "TAXI"].includes(s));
  const lineups = lineupState(raw), inj = injuryState(raw);
  if (prev?.lineups) for (const [rid, cur] of Object.entries(lineups)) {
    const was = prev.lineups[rid];
    if (!was) continue;
    const moves = [];
    cur.starters.forEach((pid, i) => { if (was.starters[i] !== pid) moves.push({ slot: labels[i] || `S${i}`, out: was.starters[i] || null, outName: was.starters[i] && was.starters[i] !== "0" ? name(was.starters[i]) : null, in: pid, inName: pid && pid !== "0" ? name(pid) : null }); });
    const added = cur.players.filter((p) => !was.players.includes(p)), dropped = was.players.filter((p) => !cur.players.includes(p));
    if (moves.length || added.length || dropped.length) ev.push({ at, type: "lineup", rosterId: Number(rid), team: team(rid), moves, added: added.map((p) => ({ pid: p, name: name(p) })), dropped: dropped.map((p) => ({ pid: p, name: name(p) })) });
  }
  if (prev?.injuries) for (const [pid, st] of Object.entries(inj)) {
    if (pid in prev.injuries && prev.injuries[pid] !== st) ev.push({ at, type: "injury", pid, name: name(pid), from: prev.injuries[pid], to: st });
  }
  const seen = new Set(prev?.txIds || []);
  for (const t of txs || []) if (t.status === "complete" && !seen.has(t.transaction_id)) {
    ev.push({ at, type: "transaction", kind: t.type, when: t.status_updated ? new Date(t.status_updated).toISOString() : null,
      rosters: (t.roster_ids || []).map((r) => team(r)),
      adds: Object.entries(t.adds || {}).map(([pid, rid]) => ({ pid, name: name(pid), to: team(rid) })),
      drops: Object.entries(t.drops || {}).map(([pid, rid]) => ({ pid, name: name(pid), from: team(rid) })) });
  }
  return { events: ev, state: { lineups, injuries: inj, txIds: [...new Set([...(prev?.txIds || []), ...(txs || []).map((t) => t.transaction_id)])], at } };
}

// ------------------------------------------------------------------ modes
async function nightlyOrTick(kind) {
  const st = await S.state();
  const season = st.league_season, week = st.week || st.display_week || 1;
  const today = todayET(NOW);
  const at = etStamp(NOW);
  for (const leagueId of await leaguesToSnap(season)) {
    const dir = weekDir(leagueId, season, week);
    const raw = await leagueRaw(leagueId, { week, season, refreshLogs: kind === "nightly" });
    raw.today = today;
    const txs = await getJSON(`${V1}/league/${leagueId}/transactions/${week}`).catch(() => []);
    const prev = rd(`${dir}/state.json`);
    // players in new transactions who aren't on any roster now (drops) need the full player list for a name
    const seen = new Set(prev?.txIds || []);
    const onRoster = new Set([...raw.projections, ...raw.stats].map((r) => r.player_id));
    const needNames = (txs || []).some((t) => !seen.has(t.transaction_id) && Object.keys({ ...t.adds, ...t.drops }).some((p) => !onRoster.has(p)));
    const { events, state } = diffEvents(prev, raw, txs, at, needNames ? await S.allPlayers() : {});
    if (events.length) wr(`${dir}/events.json`, [...rd(`${dir}/events.json`, []), ...events]);
    wr(`${dir}/state.json`, state);
    const meta = { at, today, week, season, league: raw.league.name, leagueId, model: MODEL_VERSION, cfg: CFG, kind };
    if (kind === "nightly") {
      const snap = { ...meta, matchups: runMatchups(raw, CFG) };
      wr(`${dir}/nightly/${today}.json`, snap);
      wrGz(`${dir}/nightly/${today}.inputs.json.gz`, inputsOf(raw));
      touchIndex(leagueId, raw.league.name, season, week, "nightly", today);
      log(`${raw.league.name} w${week}: nightly ${today}, ${snap.matchups.length} matchups, ${events.length} new events`);
    } else if (events.length && prev) {
      // something moved: save what the app would have shown right now
      const stamp = at.replace(":", "");
      wr(`${dir}/ticks/${stamp}.json`, { ...meta, events, matchups: runMatchups(raw, CFG) });
      touchIndex(leagueId, raw.league.name, season, week, "ticks", stamp);
      log(`${raw.league.name} w${week}: tick ${at}, ${events.length} events: ${events.map((e) => e.type).join(", ")}`);
    } else {
      touchIndex(leagueId, raw.league.name, season, week);
      log(`${raw.league.name} w${week}: tick ${at}, ${prev ? "no changes" : "first check (baseline saved)"}`);
    }
  }
}

/** Rebuild a finished week night by night. Sleeper keeps only the final lineup, so the week is
 *  assumed to have been played with it; a slot's final score tells which game was locked. */
async function replay(week) {
  const st = await S.state();
  const season = st.league_season;
  for (const leagueId of await leaguesToSnap(season)) {
    const raw = await leagueRaw(leagueId, { week: Number(week), season, refreshLogs: true });
    const scoring = raw.league.scoring_settings;
    const weekDates = [...new Set(raw.schedule.filter((g) => g.week === raw.week).map((g) => g.date))].sort();
    const fpOn = {};   // pid -> date -> fantasy points
    for (const r of raw.stats) if (r.stats && (r.stats.min || 0) > 0) (fpOn[r.player_id] ||= {})[r.date] = fantasyPoints(r.stats, scoring);
    const teamOf = {}; for (const r of [...raw.projections, ...raw.stats]) teamOf[r.player_id] = r.team || r.player?.team;
    const teamDates = {}; for (const g of raw.schedule.filter((x) => x.week === raw.week)) for (const t of [g.home?.team, g.away?.team]) (teamDates[t] ||= []).push(g.date);
    // which game each final slot counted
    const counted = {};   // `${rid}:${i}` -> date | null
    const unknown = [];
    for (const m of raw.matchups) (m.starters || []).forEach((pid, i) => {
      if (!pid || pid === "0") return;
      const final = m.starters_points?.[i] ?? 0;
      const dates = (teamDates[teamOf[pid]] || []).sort();
      const hit = dates.filter((d) => Math.abs((fpOn[pid]?.[d] ?? 0) - final) < 0.06);
      // prefer the earliest matching game that isn't his last (a lock); otherwise his last game
      const d = hit.find((x) => x !== dates.at(-1)) || (hit.includes(dates.at(-1)) ? dates.at(-1) : null);
      counted[`${m.roster_id}:${i}`] = d;
      if (!d && final !== 0) unknown.push({ rosterId: m.roster_id, slot: i, pid, final });
    });
    const dir = weekDir(leagueId, season, raw.week);
    const finalMatchups = raw.matchups;
    for (const D of weekDates) {
      const rawD = {
        ...raw, today: shift(D, 1),
        schedule: raw.schedule.map((g) => ({ ...g, status: g.date <= D ? "complete" : "pre_game" })),
        stats: raw.stats.filter((r) => r.date <= D),
        logs: Object.fromEntries(Object.entries(raw.logs).map(([pid, l]) => [pid, l.filter((g) => g.date <= D)])),
        matchups: finalMatchups.map((m) => {
          const sp = (m.starters || []).map((pid, i) => {
            if (!pid || pid === "0") return 0;
            const lockD = counted[`${m.roster_id}:${i}`];
            const dates = (teamDates[teamOf[pid]] || []).filter((d) => d <= D).sort();
            if (lockD && lockD <= D) return fpOn[pid]?.[lockD] ?? 0;
            const last = dates.at(-1);
            return last ? fpOn[pid]?.[last] ?? 0 : 0;
          });
          const pp = Object.fromEntries((m.players || []).map((pid) => { const ds = (teamDates[teamOf[pid]] || []).filter((d) => d <= D).sort(); return [pid, ds.length ? fpOn[pid]?.[ds.at(-1)] ?? 0 : 0]; }));
          return { ...m, starters_points: sp, players_points: pp, points: sp.reduce((t, x) => t + x, 0) };
        }),
      };
      const snap = { at: `${shift(D, 1)}T04:30`, today: rawD.today, week: raw.week, season, league: raw.league.name, leagueId, model: MODEL_VERSION, cfg: CFG, kind: "replay",
        caveats: ["Rebuilt from Sleeper's final lineups: mid-week lineup moves aren't known.", "Injury tags are today's, not the ones shown that night."],
        unknownSlots: unknown, matchups: runMatchups(rawD, CFG) };
      wr(`${dir}/replay/${D}.json`, snap);
      touchIndex(leagueId, raw.league.name, season, raw.week, "replay", D);
    }
    // the actual final, for "what happened"
    wr(`${dir}/final.json`, { week: raw.week, matchups: finalMatchups.map((m) => ({ rosterId: m.roster_id, matchupId: m.matchup_id, points: m.points, starters: m.starters, starters_points: m.starters_points })), counted });
    touchIndex(leagueId, raw.league.name, season, raw.week, "final");
    log(`${raw.league.name} w${raw.week}: replayed ${weekDates.length} nights${unknown.length ? `, ${unknown.length} slot(s) whose counted game couldn't be matched` : ""}`);
  }
}

/** Once a week is over, store its final lineups/scores (used by History for "what happened"). */
async function finals() {
  const st = await S.state();
  const season = st.league_season, week = st.week || st.display_week || 1;
  const idx = rd("index.json", { leagues: {} });
  for (const [leagueId, L] of Object.entries(idx.leagues)) for (const [w, W] of Object.entries(L.seasons[season]?.weeks || {})) {
    if (Number(w) >= week) continue;
    const dir = weekDir(leagueId, season, Number(w));
    if (rd(`${dir}/final.json`)) continue;
    const ms = await S.matchups(leagueId, Number(w), true);
    wr(`${dir}/final.json`, { week: Number(w), matchups: ms.map((m) => ({ rosterId: m.roster_id, matchupId: m.matchup_id, points: m.points, starters: m.starters, starters_points: m.starters_points })) });
    W.final = true;
    log(`${L.name} w${w}: final saved`);
  }
  wr("index.json", idx);
}

if (mode === "nightly") { await nightlyOrTick("nightly"); await finals(); }
else if (mode === "tick") await nightlyOrTick("tick");
else if (mode === "replay") await replay(opt("week"));
else { console.error("usage: snapshot.mjs nightly|tick|replay --data <dir> [--week N]"); process.exit(2); }
