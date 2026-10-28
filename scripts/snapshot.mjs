// Alpha Scout snapshots: saves what the app would have shown, for every matchup, so any
// decision point can be reviewed later and new math can be re-run on old days.
//
//   node scripts/snapshot.mjs nightly --data <dir>          full snapshot of every matchup (after the night's games)
//   node scripts/snapshot.mjs tick    --data <dir>          light check: lineups, transactions, injuries; full
//                                                           snapshot only when something changed. Rebuilds a week when
//                                                           its app-totals.json (the Sleeper app's final numbers) changes
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
//     app-totals.json                                 the Sleeper app's final numbers, {teams: {rosterId: {points, proj}}}:
//                                                     Sleeper's public final is unreliable for Lock-In, these decide
//                                                     which game counted in each slot
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import * as S from "../js/sleeper.js";
import { buildModel, DEFAULTS, fantasyPoints, todayET } from "../js/model.js";
import { solveCounted } from "../js/truth.js";
import { lockBars } from "../js/lockmath.js";

const V1 = "https://api.sleeper.app/v1";
const args = process.argv.slice(2);
const mode = args[0];
const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const DATA = path.resolve(opt("data", "data"));
// --variant lab: the experimental formula (the lab app). It only replays finished weeks and scores them,
// into <week>/lab/ and calibration-lab.json, so the main snapshots are never touched.
const VARIANT = opt("variant", "");
const vdir = (dir) => (VARIANT ? `${dir}/${VARIANT}` : dir);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const CONFIG = JSON.parse(fs.readFileSync(opt("config", path.join(HERE, "snapshot.config.json")), "utf8"));
const MODEL_VERSION = (() => { try { return execSync("git rev-parse --short=7 HEAD", { cwd: HERE, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "dev"; } })();
// The math itself: replays are rebuilt whenever these files change, so they always show the current model.
const MATH_FILES = ["model.js", "lockmath.js", "availability.js", "swaps.js", "chains.js", "truth.js"];
const MODEL_HASH = crypto.createHash("sha1").update(MATH_FILES.map((f) => { try { return fs.readFileSync(path.join(HERE, "../js", f), "utf8"); } catch { return ""; } }).join("\n")).digest("hex").slice(0, 10);
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
const LOG = [];
const log = (...m) => { console.log(...m); LOG.push(m.join(" ")); };

const BROWSERISH = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", Accept: "application/json, text/plain, */*" };
async function getJSON(url, headers = {}) {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) { const e = new Error(`${r.status} ${url}`); e.final = r.status >= 400 && r.status < 500; throw e; }
      return await r.json();
    } catch (e) { if (a >= 3 || e.final) throw e; await new Promise((res) => setTimeout(res, 1500 * (a + 1))); }
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

// ------------------------------------------------------------------ tip-off times
// Sleeper's schedule has dates only. The NBA's public schedule has tip-off times; they let the model
// plan same-day late swaps. Saved as {date: {TEAM: "HH:MM"}} in Eastern time.
const TEAM_FIX = { GS: "GSW", NO: "NOP", NY: "NYK", SA: "SAS", PHO: "PHX", WSH: "WAS", UTAH: "UTA" };
async function saveTipoffs(season, { force = false } = {}) {
  const f = `tipoffs/${season}.json`;
  if (!force && rd(f)) return rd(f);
  const out = { ...(rd(f) || {}) };
  let n = 0;
  const put = (utc, h, a) => {
    if (!utc || !h || !a) return;
    const et = etStamp(new Date(utc));
    const day = (out[et.slice(0, 10)] ||= {});
    day[TEAM_FIX[h] || h] = et.slice(11); day[TEAM_FIX[a] || a] = et.slice(11); n++;
  };
  // 1) the NBA's season schedule
  try {
    const j = await getJSON("https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json", { ...BROWSERISH, Referer: "https://www.nba.com/", Origin: "https://www.nba.com" });
    for (const d of j?.leagueSchedule?.gameDates || []) for (const g of d.games || []) {
      if (/T00:00:00/.test(g.gameDateTimeEst || "")) continue;   // time not set yet
      put(g.gameDateTimeUTC, g.homeTeam?.teamTricode, g.awayTeam?.teamTricode);
    }
    log(`tip-off times from nba.com: ${n} games`);
  } catch (e) { log(`nba.com schedule unavailable (${e.message})`); }
  // 2) ESPN's scoreboard, day by day, for the next two weeks and the past week (fills gaps)
  if (!n) {
    const today = todayET(NOW);
    for (let k = -7; k <= 14; k++) {
      const d = shift(today, k).replaceAll("-", "");
      try {
        const j = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${d}`, BROWSERISH);
        for (const ev of j?.events || []) {
          const c = ev.competitions?.[0]?.competitors || [];
          const home = c.find((x) => x.homeAway === "home")?.team?.abbreviation, away = c.find((x) => x.homeAway === "away")?.team?.abbreviation;
          put(ev.date, home, away);
        }
      } catch (e) { if (k === -7) log(`espn scoreboard unavailable (${e.message})`); break; }
    }
    if (n) log(`tip-off times from espn: ${n} games`);
  }
  if (n) { wr(f, out); return out; }
  log("tip-off times unavailable: same-day games stay simultaneous");
  return rd(f);
}

// ------------------------------------------------------------------ official totals
// Sleeper's matchups endpoint returns inconsistent slot scores for Lock-In (different servers, different
// wrong combinations), but the standings on each roster (fpts, fpts_against) match the Sleeper app to
// the cent. They're season totals, so a week's score = season total after it - season total before it.
const standingsOf = (r) => { const st = r.settings || {}; return {
  fpts: r2((st.fpts || 0) + (st.fpts_decimal || 0) / 100), against: r2((st.fpts_against || 0) + (st.fpts_against_decimal || 0) / 100),
  games: (st.wins || 0) + (st.losses || 0) + (st.ties || 0) }; };

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
  const tipoffs = await saveTipoffs(season, { force: refreshLogs && mode === "nightly" });
  return {
    tipoffs,
    league: { league_id: league.league_id, name: league.name, season: league.season, scoring_settings: scoring, roster_positions: league.roster_positions },
    rosters: rosters.map((r) => ({ roster_id: r.roster_id, owner_id: r.owner_id, co_owners: r.co_owners || null, reserve: r.reserve || [], players: r.players || [], standings: standingsOf(r) })),
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
  if (s.plan?.length) o.plan = s.plan.map((x) => ({ who: x.who, name: x.name, d: x.date, tip: x.tip ? x.tip.slice(11) : null, mu: r2(x.mu), bar: r2(x.bar) }));
  if (s.call?.cushion) o.call.cushion = r2(s.call.cushion);
  if (s.call && s.contGames?.length) {
    // what passing meant: the games the slot would go on to (whose, when) and the bar to lock each
    const bars = lockBars(s.contGames);
    o.cont = s.contGames.map((g, k) => ({ who: g.who || s.pid, d: g.date, bar: bars[k] !== undefined ? r2(bars[k]) : null }));
  }
  if (s.p?.injury) o.injury = s.p.injury;
  return o;
}
function teamOut(t, swaps) {
  return { rosterId: t.rosterId, name: t.name, points: r2(t.points), proj: r2(t.proj), banked: r2(t.banked),
    slots: t.slots.map(slotOut),
    bench: (t.bench || []).map((b) => ({ pid: b.pid, name: b.p?.name, nextProj: r2(b.nextProj) })),
    swaps: (swaps || []).map((x) => ({ slot: x.slot.label, in: x.into.key, inName: x.into.p?.name, out: x.out?.pid || null, outName: x.out?.name || null, by: x.deadline, gain: r2(x.gain) })) };
}
function runMatchups(raw, cfg, marks = {}) {
  const ids = new Map();
  for (const m of raw.matchups) if (m.matchup_id) (ids.get(m.matchup_id) || ids.set(m.matchup_id, []).get(m.matchup_id)).push(m.roster_id);
  const out = [];
  for (const [mid, rids] of [...ids.entries()].sort((a, b) => a[0] - b[0])) {
    const a = Math.min(...rids);
    const m = buildModel({ ...raw, viewRosterId: a }, null, cfg, marks);
    out.push({ matchupId: mid, win: r3(m.win), mode: m.mode, teams: [teamOut(m.me, m.swaps), m.opp ? teamOut(m.opp, m.oppSwaps) : null].filter(Boolean) });
  }
  return out;
}
const CFG = { ...DEFAULTS, b2bFlags: {} };

function inputsOf(raw) {   // everything but the shared files (logs, season schedule)
  const { logs, schedule, tipoffs, ...rest } = raw;
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
    // The Sleeper app's own totals (score + projection per team), when someone has entered them:
    // they decide which game counted in each slot. Sleeper's public final is only a fallback.
    const appTotals = weekTotals(dir);
    const truth = {}, candidates = {};
    if (appTotals) {
      const pjOn = {};
      for (const r of raw.projections) (pjOn[r.player_id] ||= {})[r.date] = fantasyPoints(r.stats, scoring, { projected: true }) || 0;
      for (const m of raw.matchups) {
        const t = appTotals.teams?.[m.roster_id];
        if (!t) continue;
        const slots = (m.starters || []).map((pid, i) => ({ key: `${m.roster_id}:${i}`,
          games: pid && pid !== "0" ? (teamDates[teamOf[pid]] || []).sort().map((d) => ({ date: d, fp: fpOn[pid]?.[d] ?? 0, pj: pjOn[pid]?.[d] ?? 0 })) : [] }));
        const sols = solveCounted(slots, t, { limit: 6 });
        truth[m.roster_id] = sols.length === 1 ? "solved" : sols.length ? "ambiguous" : "no match";
        if (sols.length === 1) Object.assign(counted, sols[0]);
        else if (sols.length) candidates[m.roster_id] = sols;   // History lists these; app totals with projections settle it
      }
    }
    const finalMatchups = raw.matchups.map((m) => {
      const t = appTotals?.teams?.[m.roster_id];
      if (!t) return m;
      const sp = (m.starters || []).map((pid, i) => { const d = counted[`${m.roster_id}:${i}`]; return d ? fpOn[pid]?.[d] ?? 0 : 0; });
      return { ...m, points: t.points, starters_points: truth[m.roster_id] === "solved" ? sp : m.starters_points };
    });
    // The truth from the finalized week, as marks: once a lock window has closed, the slot is known
    // to be locked on its game (or not locked through that game). The decision night itself stays open.
    const marksFor = (D) => {
      const mk = {};
      for (const m of raw.matchups) (m.starters || []).forEach((pid, i) => {
        if (!pid || pid === "0") return;
        const dates = (teamDates[teamOf[pid]] || []).sort();
        const doneD = dates.filter((d) => d <= D);   // his team's games so far (a DNP still closes a lock window)
        const latest = doneD.at(-1);
        const lockD = counted[`${m.roster_id}:${i}`];
        const isLock = lockD && lockD !== dates.at(-1);
        if (isLock && latest && lockD < latest) mk[pid] = lockD;
        else { const prevDone = doneD.at(-2); if (prevDone) mk[pid] = `pass:${prevDone}`; }   // earlier, closed windows weren't locked
      });
      return mk;
    };
    // every rostered player's actual score in each of his team's games this week (0 = didn't play):
    // the scorecard uses it to see how each lock-or-pass call turned out
    const actuals = {};
    for (const m of raw.matchups) for (const pid of m.players || []) {
      if (!pid || pid === "0" || actuals[pid]) continue;
      actuals[pid] = Object.fromEntries((teamDates[teamOf[pid]] || []).map((d) => [d, r2(fpOn[pid]?.[d] ?? 0)]));
    }
    for (const D of weekDates) {
      const rawD = {
        ...raw, today: shift(D, 1),
        schedule: raw.schedule.map((g) => ({ ...g, status: g.date <= D ? "complete" : "pre_game" })),
        stats: raw.stats.filter((r) => r.date <= D),
        logs: Object.fromEntries(Object.entries(raw.logs).map(([pid, l]) => [pid, l.filter((g) => g.date <= D)])),
        matchups: finalMatchups.map((m) => {
          // what Sleeper displayed that night: his latest game he played in (locks aren't shown mid-week)
          const sp = (m.starters || []).map((pid) => {
            if (!pid || pid === "0") return 0;
            const played = (teamDates[teamOf[pid]] || []).filter((d) => d <= D && fpOn[pid]?.[d] !== undefined).sort();
            return played.length ? fpOn[pid][played.at(-1)] : 0;
          });
          const pp = Object.fromEntries((m.players || []).map((pid) => { const ds = (teamDates[teamOf[pid]] || []).filter((d) => d <= D).sort(); return [pid, ds.length ? fpOn[pid]?.[ds.at(-1)] ?? 0 : 0]; }));
          return { ...m, starters_points: sp, players_points: pp, points: sp.reduce((t, x) => t + x, 0) };
        }),
      };
      const snap = { at: `${shift(D, 1)}T04:30`, today: rawD.today, week: raw.week, season, league: raw.league.name, leagueId, model: MODEL_VERSION, cfg: CFG, kind: "replay",
        caveats: ["Rebuilt from Sleeper's finalized week: locks are the real ones, but mid-week lineup moves aren't known (the final lineup is assumed all week).", "Injury tags are today's, not the ones shown that night."],
        unknownSlots: unknown, matchups: runMatchups(rawD, CFG, marksFor(D)), actuals };
      wr(`${vdir(dir)}/replay/${D}.json`, snap);
      if (!VARIANT) touchIndex(leagueId, raw.league.name, season, raw.week, "replay", D);
    }
    // the actual final, for "what happened"
    wr(`${vdir(dir)}/final.json`, { variant: VARIANT || null, week: raw.week, fetched: NOW.toISOString(), source: appTotals ? appTotals.source : "sleeper public data (unreliable for Lock-In)",
      truth, candidates, truthHash: appTotals ? hashOf(appTotals) : null, modelHash: MODEL_HASH, scorecard: 1, tipHash: weekTipHash(raw.tipoffs, weekDates),
      matchups: finalMatchups.map((m) => ({ rosterId: m.roster_id, matchupId: m.matchup_id, points: m.points, starters: m.starters, starters_points: m.starters_points })), counted });
    if (!VARIANT) touchIndex(leagueId, raw.league.name, season, raw.week, "final");
    log(`${raw.league.name} w${raw.week}: replayed ${weekDates.length} nights${appTotals ? `, totals (${appTotals.source}): ${JSON.stringify(truth)}` : ""}${unknown.length ? `, ${unknown.length} slot(s) whose counted game couldn't be matched` : ""}`);
  }
}

/** The totals that decide a week: the Sleeper app's (entered by hand, with projections) if present,
 *  else the official ones from the standings. */
function weekTotals(dir) {
  const app = rd(`${dir}/app-totals.json`);
  if (app) return { ...app, source: app.source || "sleeper app totals" };
  return rd(`${dir}/official-totals.json`);
}

/** Once a week is over: its official totals (from the standings) and Sleeper's final lineups. */
async function finals() {
  const rebuild = new Set();
  const st = await S.state();
  const season = st.league_season, week = st.week || st.display_week || 1;
  const idx = rd("index.json", { leagues: {} });
  for (const [leagueId, L] of Object.entries(idx.leagues)) {
    const weeks = Object.keys(L.seasons[season]?.weeks || {}).map(Number).filter((w) => w < week).sort((a, b) => a - b);
    if (!weeks.length) continue;
    const rosters = await S.rosters(leagueId, true);
    const stand = Object.fromEntries(rosters.map((r) => [r.roster_id, standingsOf(r)]));
    const played = Math.min(...Object.values(stand).map((x) => x.games));
    for (const w of weeks) {
      const W = L.seasons[season].weeks[w];
      const dir = weekDir(leagueId, season, w);
      if (!rd(`${dir}/official-totals.json`) && played === w) {
        // season totals now cover weeks 1..w exactly: subtract the earlier weeks' official totals
        const before = {};
        let ok = true;
        for (let k = 1; k < w; k++) {
          const o = rd(`${weekDir(leagueId, season, k)}/official-totals.json`) || rd(`${weekDir(leagueId, season, k)}/app-totals.json`);
          if (!o) { ok = false; break; }
          for (const [rid, t] of Object.entries(o.teams)) before[rid] = (before[rid] || 0) + t.points;
        }
        if (ok) {
          wr(`${dir}/official-totals.json`, { source: "sleeper standings (fpts)", at: NOW.toISOString(),
            teams: Object.fromEntries(Object.entries(stand).map(([rid, x]) => [rid, { points: r2(x.fpts - (before[rid] || 0)) }])) });
          log(`${L.name} w${w}: official totals from the standings`);
        } else log(`${L.name} w${w}: standings cover it, but an earlier week's official totals are missing`);
      }
      if (!rd(`${dir}/final.json`) || (weekTotals(dir) && rd(`${dir}/final.json`)?.truthHash !== hashOf(weekTotals(dir)))) {
        if (W.replay?.length || weekTotals(dir)) rebuild.add(w);       // a finished week with real totals gets a replay (calibration)
        else {   // no replay for this week: store Sleeper's final lineups (scores from the official totals)
          const ms = await S.matchups(leagueId, w, true);
          const t = weekTotals(dir);
          wr(`${dir}/final.json`, { week: w, fetched: NOW.toISOString(), source: t?.source || "sleeper public data (unreliable for Lock-In)", truthHash: t ? hashOf(t) : null,
            matchups: ms.map((m) => ({ rosterId: m.roster_id, matchupId: m.matchup_id, points: t?.teams?.[m.roster_id]?.points ?? m.points, starters: m.starters, starters_points: m.starters_points })) });
          W.final = true;
          log(`${L.name} w${w}: final saved`);
        }
      }
    }
  }
  wr("index.json", idx);
  for (const w of rebuild) await replay(w);
}

/** Tip-off times for one week's dates (a replay is rebuilt when they arrive or change). */
const weekTipHash = (tipoffs, dates) => hashOf(dates.map((d) => tipoffs?.[d] || null));
const hashOf = (v) => crypto.createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 12);
/** Rebuild any week whose app totals were added or changed since its replay was made. */
async function truthCheck() {
  const st = await S.state();
  const season = st.league_season;
  const idx = rd("index.json", { leagues: {} });
  for (const [leagueId, L] of Object.entries(idx.leagues)) for (const w of Object.keys(L.seasons[season]?.weeks || {})) {
    const W = L.seasons[season].weeks[w];
    const dir = weekDir(leagueId, season, Number(w));
    const t = weekTotals(dir), fin = rd(`${vdir(dir)}/final.json`);
    if (!t) continue;
    if (fin?.truthHash !== hashOf(t)) { log(`w${w}: totals changed, rebuilding`); await replay(Number(w)); }
    else if (!fin?.scorecard) { log(`w${w}: adding scorecard data to its replay`); await replay(Number(w)); }
    else if (fin?.modelHash !== MODEL_HASH) { log(`w${w}: the math changed, rebuilding its replay`); await replay(Number(w)); }
    else if (W.replay?.length && fin?.tipHash !== weekTipHash(rd(`tipoffs/${season}.json`), [...W.replay].sort())) { log(`w${w}: tip-off times changed, rebuilding its replay`); await replay(Number(w)); }
  }
}

/** How well the win % holds up: every night of every finished week (replayed with the current math),
 *  against how the matchup actually ended. Skips each week's last night (nothing left to predict). */
function calibrate() {
  const idx = rd("index.json", { leagues: {} });
  const pts = [];   // {p: favourite's win %, y: favourite won, nightsLeft, week}
  const calls = [], seenCalls = new Set();
  let weeks = 0, matchups = 0;
  for (const [leagueId, L] of Object.entries(idx.leagues)) for (const [season, S_] of Object.entries(L.seasons)) for (const [w, W] of Object.entries(S_.weeks)) {
    const dir = weekDir(leagueId, season, Number(w));
    const fin = rd(`${vdir(dir)}/final.json`);
    if (!fin?.truthHash || !W.replay?.length) continue;   // only weeks whose final is known for sure
    const pointsOf = Object.fromEntries(fin.matchups.map((m) => [m.rosterId, m.points]));
    const nights = [...W.replay].sort();
    weeks++;
    nights.slice(0, -1).forEach((d, k) => {
      const snap = rd(`${vdir(dir)}/replay/${d}.json`);
      for (const m of snap?.matchups || []) {
        if (m.teams.length < 2 || m.win === null) continue;
        const [a, b] = m.teams, pa = pointsOf[a.rosterId], pb = pointsOf[b.rosterId];
        if (pa === undefined || pb === undefined || pa === pb) continue;
        const fav = m.win >= 0.5;
        pts.push({ p: fav ? m.win : 1 - m.win, y: (pa > pb) === fav ? 1 : 0, nightsLeft: nights.length - 1 - k, week: Number(w) });
        if (k === 0) matchups++;
      }
    });
    // Lock calls: each just-finished game's call, the first night it came up. Following the call vs doing
    // the opposite, with real results. Passing plays on with the formula's own later bars.
    for (const d of nights) {
      const snap = rd(`${vdir(dir)}/replay/${d}.json`);
      const act = snap?.actuals || {};
      for (const m of snap?.matchups || []) for (const t of m.teams) for (const sl of t.slots) {
        if (!sl.call || !sl.cont?.length || sl.forcedPass) continue;
        const key = `${w}:${t.rosterId}:${sl.pid}:${sl.decisionGame}`;
        if (seenCalls.has(key)) continue;
        seenCalls.add(key);
        let passValue = 0;
        for (const [i, g] of sl.cont.entries()) {
          const fp = act[g.who]?.[g.d] ?? 0;
          if (i === sl.cont.length - 1 || (g.bar !== null && fp >= g.bar)) { passValue = fp; break; }
        }
        const lockValue = sl.score;
        const lock = sl.call.verdict === "LOCK";
        const gain = lock ? lockValue - passValue : passValue - lockValue;
        calls.push({ week: Number(w), team: t.name, player: sl.name, game: sl.decisionGame, verdict: sl.call.verdict, score: lockValue, passValue: r2(passValue), gain: r2(gain) });
      }
    }
  }
  const callsRight = calls.filter((c) => c.gain >= 0).length;
  const decisions = { calls: calls.length, right: callsRight, points: r2(calls.reduce((t, c) => t + c.gain, 0)),
    locks: calls.filter((c) => c.verdict === "LOCK").length, passes: calls.filter((c) => c.verdict === "PASS").length,
    best: [...calls].sort((a, b) => b.gain - a.gain).slice(0, 5), worst: [...calls].sort((a, b) => a.gain - b.gain).slice(0, 5) };
  const mean = (xs) => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : null);
  const brier = mean(pts.map((x) => (x.p - x.y) ** 2));
  const buckets = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]].map(([lo, hi]) => {
    const xs = pts.filter((x) => x.p >= lo && x.p < hi);
    return { range: `${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}%`, n: xs.length, predicted: r3(mean(xs.map((x) => x.p))), actual: r3(mean(xs.map((x) => x.y))) };
  });
  const byNightsLeft = [...new Set(pts.map((x) => x.nightsLeft))].sort((a, b) => b - a).map((k) => {
    const xs = pts.filter((x) => x.nightsLeft === k);
    return { nightsLeft: k, n: xs.length, brier: r3(mean(xs.map((x) => (x.p - x.y) ** 2))), predicted: r3(mean(xs.map((x) => x.p))), actual: r3(mean(xs.map((x) => x.y))) };
  });
  const calFile = `calibration${VARIANT ? `-${VARIANT}` : ""}.json`;
  const body = { variant: VARIANT || "standard", modelHash: MODEL_HASH, weeks, matchups, nights: pts.length,
    brier: r3(brier), coinFlipBrier: 0.25, buckets, byNightsLeft, decisions,
    note: "Each matchup counts once per night, so nights of the same matchup aren't independent; read with care until there are several weeks." };
  const prev = rd(calFile);
  const same = prev && (({ updated, ...rest }) => JSON.stringify(rest) === JSON.stringify(body))(prev);
  if (!same) wr(calFile, { ...body, updated: NOW.toISOString() });   // unchanged: no rewrite, no commit
  log(`calibration${VARIANT ? ` (${VARIANT})` : ""}: ${weeks} week(s), ${matchups} matchups, ${pts.length} matchup-nights, Brier ${r3(brier)}; lock calls ${decisions.right}/${decisions.calls} right, ${decisions.points >= 0 ? "+" : ""}${decisions.points} pts vs the opposite`);
}

if (VARIANT && !["calibrate", "replay"].includes(mode)) { console.error("--variant only replays and scores finished weeks (calibrate, replay)"); process.exit(2); }
process.on("exit", () => { try { wr(`runs/last-${mode}${VARIANT ? `-${VARIANT}` : ""}.json`, { at: NOW.toISOString(), model: MODEL_VERSION, modelHash: MODEL_HASH, log: LOG }); } catch { /* ignore */ } });
if (mode === "nightly") { await nightlyOrTick("nightly"); await finals(); await truthCheck(); calibrate(); }
else if (mode === "tick") { await nightlyOrTick("tick"); await finals(); await truthCheck(); calibrate(); }
else if (mode === "calibrate") { if (!VARIANT) await saveTipoffs((await S.state()).league_season, { force: true }); await truthCheck(); calibrate(); }
else if (mode === "replay") await replay(opt("week"));
else { console.error("usage: snapshot.mjs nightly|tick|replay --data <dir> [--week N]"); process.exit(2); }
