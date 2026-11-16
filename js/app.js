import * as S from "./sleeper.js?v=__V__";
import { buildModel, DEFAULTS, dow, md, normalizeMarks, todayET } from "./model.js?v=__V__";
import { openHistory } from "./history.js?v=__V__";
import { openRankings, rankMap, seasonPlayers } from "./rankings.js?v=__V__";
import { LAB } from "./lab.js?v=__V__";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** Last name for tight spaces, skipping suffixes: "Jaren Jackson Jr." -> "Jackson". */
const shortName = (n) => { const w = String(n || "").split(" ").filter((x) => !/^(jr|sr|ii|iii|iv|v)\.?$/i.test(x)); return w.at(-1) || n; };
const f1 = (x) => (x === null || x === undefined || Number.isNaN(x) ? "–" : (Math.round(x * 10) / 10).toFixed(1));
const pct = (x) => `${Math.round(x * 100)}%`;
const ord = (q) => { const n = Math.min(99, Math.max(1, Math.round(q * 100))); const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

// ------------------------------------------------------------------ storage (best effort)
// The lab version keeps its own settings, marks and views, so experimenting never touches the real ones.
const NS = LAB ? "as.lab." : "as.";
const store = {
  get(k, d) { try { const v = localStorage.getItem(NS + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(NS + k); } catch { /* ignore */ } },
};
if (LAB) {
  document.documentElement.classList.add("lab");
  addEventListener("DOMContentLoaded", () => { const a = document.getElementById("lab-link"); if (a) { a.href = "../"; a.textContent = "Back to the standard app"; a.parentElement.lastChild.textContent = ": the formula you use every day."; } });
  document.title = "Alpha Scout LAB";
  const b = document.querySelector(".brand span");
  if (b) b.textContent = "Lab";
  // first visit: start from the real app's username and matchup (copied, not shared)
  try { if (localStorage.getItem("as.lab.me") === null) for (const k of ["me", "view", "username", "league", "recent"]) { const v = localStorage.getItem("as." + k); if (v !== null) localStorage.setItem("as.lab." + k, v); } } catch { /* ignore */ }
}

let ctx = null;        // {user, leagueId, rosterId|null, raw}
let model = null;
let view = "me";
let timer = null;

// "me" is the person using the app ({username, user_id}); "view" is the matchup on screen ({u, l, r}),
// so the app reopens wherever you left it. "recent" keeps the last few matchups you looked at.
const me = () => store.get("me", null);

// ------------------------------------------------------------------ boot
async function boot() {
  const q = new URLSearchParams(location.search);
  const saved = store.get("view", null) || (store.get("league", "") ? { u: store.get("username", ""), l: store.get("league", "") } : null);
  const u = q.get("u") || saved?.u || store.get("username", "");
  const l = q.get("l") || saved?.l || "";
  const r = q.get("r") ? Number(q.get("r")) : q.get("u") ? null : saved?.r ?? null;
  if (u && l) return openLeague(u, l, r);
  showOnboard(u, { auto: true });
}

function showOnboard(username = "", { auto = false } = {}) {
  clearInterval(timer);
  closeSwitcher();
  $("dash").hidden = true; $("history").hidden = true; $("rankings").hidden = true; $("nav").hidden = true; $("onboard").hidden = false; $("who").hidden = true;
  $("username").value = username;
  $("find-msg").textContent = ""; $("leagues").innerHTML = "";
  if (username && auto) findLeagues(username, { auto: true });
  $("username").focus();
}

$("find").addEventListener("submit", (e) => { e.preventDefault(); findLeagues($("username").value, { asMe: true, auto: true }); });
$("home").addEventListener("click", (e) => {
  e.preventDefault();
  if (me()) goMine(); else showOnboard(store.get("username", ""));
});
$("who").addEventListener("click", () => toggleSwitcher());

/** Onboarding lookup. asMe: the typed username becomes "me". auto: open a lone league straight away. */
async function findLeagues(username, { auto = false, asMe = false } = {}) {
  const msg = $("find-msg"), list = $("leagues");
  msg.className = "muted"; msg.textContent = "Looking you up on Sleeper…"; list.innerHTML = "";
  try {
    const [st, user] = await Promise.all([S.state(), S.findUser(username)]);
    const leagues = await S.nbaLeagues(user.user_id, st.league_season);
    const name = user.username || username.trim();
    store.set("username", name);
    if (asMe || !me()) store.set("me", { username: name, user_id: user.user_id });
    if (!leagues.length) { msg.textContent = `No ${st.league_season} NBA leagues on this account.`; return; }
    msg.textContent = `${leagues.length} NBA league${leagues.length > 1 ? "s" : ""} for ${st.league_season}. Pick one:`;
    list.innerHTML = leagues.map((l) => `
      <button class="league" data-id="${esc(l.league_id)}">
        <span><b>${esc(l.name)}</b><br><span class="muted">${l.total_rosters} teams · ${esc(l.status.replace("_", " "))}</span></span>
        <span class="chip">Open</span>
      </button>`).join("");
    list.querySelectorAll(".league").forEach((b) => b.addEventListener("click", () => openLeague(name, b.dataset.id, null)));
    if (auto && leagues.length === 1) openLeague(name, leagues[0].league_id, null);
  } catch (err) {
    msg.className = "err"; msg.textContent = err.message;
  }
}

// ------------------------------------------------------------------ league
async function openLeague(username, leagueId, rosterId = null) {
  closeSwitcher();
  $("history").hidden = true; $("rankings").hidden = true;
  $("onboard").hidden = true; $("dash").hidden = false; $("nav").hidden = false; setNav("dash");
  $("board").innerHTML = '<div class="skeleton"></div>';
  ["ask", "todo"].forEach((id) => ($(id).innerHTML = ""));
  $("lineup").innerHTML = "";
  try {
    const user = await S.findUser(username);
    const name = user.username || username;
    if (me()) store.set("username", me().username);
    store.set("league", leagueId);
    ctx = { user, leagueId, rosterId: rosterId ?? null };
    store.set("view", { u: name, l: leagueId, r: ctx.rosterId });
    history.replaceState(null, "", `?u=${encodeURIComponent(name)}&l=${leagueId}${ctx.rosterId != null ? `&r=${ctx.rosterId}` : ""}`);
    view = "me";
    $("who").hidden = false; $("who").textContent = "Matchups ▾";
    await load(false);
    rememberView();
    refreshRankBadges();
    clearInterval(timer);
    timer = setInterval(() => { if (document.visibilityState === "visible") load(true); }, 120000);
  } catch (err) {
    $("board").innerHTML = `<p class="err">${esc(err.message)}</p><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn ghost" onclick="location.reload()">Try again</button></div>`;
    $("who").hidden = false; $("who").textContent = "Matchups ▾";
  }
}

/** Is the team on screen the app user's own? */
function viewingMine() {
  const m = me();
  const r = ctx?.raw?.rosters?.find((x) => x.roster_id === myRosterId(ctx.raw.rosters));
  return !!(m && r && (r.owner_id === m.user_id || (r.co_owners || []).includes(m.user_id)));
}

function rememberView() {
  if (!model || model.missingRoster) return;
  const rid = myRosterId(ctx.raw.rosters);
  const entry = { u: ctx.user.username || ctx.user.display_name, l: ctx.leagueId, r: rid, mine: viewingMine(),
    label: `${model.me.name}${model.opp ? ` vs ${model.opp.name}` : ""}`, league: ctx.raw.league.name };
  const oppR = ctx.raw.matchups.find((x) => x.matchup_id && x.roster_id !== rid && x.matchup_id === ctx.raw.matchups.find((y) => y.roster_id === rid)?.matchup_id)?.roster_id;
  entry.key = `${entry.l}:${[rid, oppR].sort().join("-")}`;
  const list = store.get("recent", []).filter((x) => (x.key || `${x.l}:${x.r}`) !== entry.key && !(x.l === entry.l && (x.r === rid || x.r === oppR)));
  store.set("recent", [entry, ...list].slice(0, 8));
  if (entry.mine) { const m = me(); store.set("me", { ...m, view: { l: ctx.leagueId } }); }
  $("who").textContent = "Matchups ▾";
}

// ------------------------------------------------------------------ switcher
function closeSwitcher() { $("switcher").hidden = true; $("who").setAttribute("aria-expanded", "false"); }
function toggleSwitcher() { if ($("switcher").hidden) openSwitcher(); else closeSwitcher(); }
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("switcher").hidden) closeSwitcher(); });

function teamName(raw, rid) {
  const r = raw.rosters.find((x) => x.roster_id === rid);
  const u = r && raw.users.find((x) => x.user_id === r.owner_id);
  return u ? (u.metadata?.team_name || u.display_name) : `Team ${rid}`;
}

// ------------------------------------------------------------------ rankings
let ranks = null;          // {pid: rank} for the open league's scoring (badges in the lineups)
let ranksKey = null;
function refreshRankBadges() {
  const sc = ctx?.raw?.league?.scoring_settings;
  if (!sc) return;
  seasonPlayers(sc).then((d) => {
    ranks = rankMap(d); ranksKey = ctx.leagueId;
    if (model && !$("dash").hidden) renderLineup(model);
  }).catch(() => { /* badges are optional */ });
}
function rankBadge(pid) {
  const r = ranks && ranksKey === ctx?.leagueId ? ranks[pid] : undefined;
  if (!r) return "";
  return ` <span class="rkb${r <= 70 ? " t70" : ""}" title="Season rank by fantasy points per game">#${r}</span>`;
}
function showRankings() {
  closeSwitcher();
  const raw = ctx.raw;
  const owners = {};
  for (const r of raw.rosters) for (const pid of [...(r.players || []), ...(r.reserve || [])]) owners[pid] = { rosterId: r.roster_id, team: teamName(raw, r.roster_id) };
  const m = me();
  const mine = m && raw.rosters.find((r) => r.owner_id === m.user_id || (r.co_owners || []).includes(m.user_id));
  $("dash").hidden = true; $("history").hidden = true; $("rankings").hidden = false; setNav("rank");
  window.scrollTo(0, 0);
  openRankings($("rankings"), { scoring: raw.league.scoring_settings, owners, myRosterId: mine?.roster_id ?? myRosterId(raw.rosters), leagueName: raw.league.name,
    onClose: showDash });
}
function setNav(which) { for (const k of ["dash", "rank", "hist"]) { const b = $(`nav-${k}`); if (k === which) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); } }
function showDash() { $("history").hidden = true; $("rankings").hidden = true; $("dash").hidden = false; setNav("dash"); refreshRankBadges(); }
$("nav-dash").addEventListener("click", () => { closeSwitcher(); if (ctx?.raw) showDash(); });
$("nav-rank").addEventListener("click", () => { if (ctx?.raw) showRankings(); });
$("nav-hist").addEventListener("click", () => { if (ctx?.raw) showHistory(); });

function showHistory() {
  closeSwitcher();
  const m = me(), raw = ctx.raw;
  const mine = m && raw.rosters.find((r) => r.owner_id === m.user_id || (r.co_owners || []).includes(m.user_id));
  $("dash").hidden = true; $("rankings").hidden = true; $("history").hidden = false; setNav("hist");
  window.scrollTo(0, 0);
  openHistory($("history"), { leagueId: ctx.leagueId, mineRosterId: mine?.roster_id ?? null, preferRosterId: myRosterId(raw.rosters),
    onClose: showDash });
}

/** Back to the app user's own matchup: this league if he has a team here, else his last league. */
function goMine() {
  const m = me();
  if (!m) return showOnboard("");
  const raw = ctx?.raw;
  const mineHere = raw?.rosters.find((r) => r.owner_id === m.user_id || (r.co_owners || []).includes(m.user_id));
  const l = mineHere ? ctx.leagueId : m.view?.l;
  if (l) openLeague(m.username, l, null); else { openSwitcher(); }
}

function openSwitcher() {
  const el = $("switcher");
  el.hidden = false; $("who").setAttribute("aria-expanded", "true");
  const raw = ctx?.raw;
  const cur = raw ? myRosterId(raw.rosters) : null;
  const m = me();
  // this league, every pairing this week
  let leagueHtml = "", s_pairs = null;
  if (raw) {
    const byId = new Map();
    raw.matchups.filter((x) => x.matchup_id).forEach((x) => { if (!byId.has(x.matchup_id)) byId.set(x.matchup_id, []); byId.get(x.matchup_id).push(x); });
    const owner = (rid) => raw.rosters.find((x) => x.roster_id === rid);
    const isMe = (rid) => { const r = owner(rid); return !!(m && r && (r.owner_id === m.user_id || (r.co_owners || []).includes(m.user_id))); };
    const curPair = raw.matchups.find((x) => x.roster_id === cur)?.matchup_id;
    const pairs = [...byId.entries()].sort(([a, pa], [b, pb]) => (pb.some((x) => isMe(x.roster_id)) - pa.some((x) => isMe(x.roster_id))) || a - b);
    const line = (x) => `<span class="pt"><span class="nm">${esc(teamName(raw, x.roster_id))}${isMe(x.roster_id) ? ' <span class="tag">you</span>' : ""}</span><b class="num">${f1(x.points)}</b></span>`;
    leagueHtml = `<div class="sw-sec"><h3>${esc(raw.league.name)} · week ${raw.week}</h3>
      <div class="pairs">${pairs.map(([id, pair]) => `<button class="pair-btn${id === curPair ? " on" : ""}" data-pair="${id}">${pair.map(line).join("")}</button>`).join("")}</div>
      </div>`;
    s_pairs = { byId, isMe };
  }
  const curOpp = raw?.matchups.find((x) => x.roster_id !== cur && x.matchup_id && x.matchup_id === raw.matchups.find((y) => y.roster_id === cur)?.matchup_id)?.roster_id;
  const recent = store.get("recent", []).filter((x) => !(raw && x.l === ctx.leagueId && (x.r === cur || x.r === curOpp)));
  const recentHtml = recent.length ? `<div class="sw-sec"><h3>Recent</h3><div class="rows">${recent.map((x, i) =>
    `<button class="row-btn" data-recent="${i}"><span>${esc(x.label)}${x.mine ? ' <span class="tag">you</span>' : ""}</span><span class="muted">${esc(x.league)}</span></button>`).join("")}</div></div>` : "";
  el.innerHTML = `
    <div class="sw-head"><b>Switch matchup</b><button class="chip" id="sw-close" aria-label="Close">Close</button></div>
    <div class="sw-actions">${raw && !viewingMine() && m ? `<button class="btn" id="sw-mine">Back to my matchup</button>` : ""}</div>
    ${leagueHtml}
    <div class="sw-sec"><h3>Leagues</h3>
      <form class="find" id="sw-find"><input id="sw-user" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Any Sleeper username" value="${esc(m?.username || "")}">
        <button class="btn ghost" type="submit">Look up</button></form>
      <div id="sw-msg" class="muted" role="status"></div><div class="rows" id="sw-leagues"></div></div>
    ${recentHtml}
    <p class="muted sw-foot">${m ? `You're <b>${esc(m.username)}</b> on Sleeper.` : "You haven't said who you are yet."} <button class="linkish" id="sw-me">${m ? "Not you?" : "Find my team"}</button></p>`;
  $("sw-close").onclick = closeSwitcher;
  if ($("sw-mine")) $("sw-mine").onclick = goMine;
  if ($("sw-hist")) $("sw-hist").onclick = showHistory;
  if ($("sw-rank")) $("sw-rank").onclick = showRankings;
  el.querySelectorAll(".pair-btn").forEach((b) => (b.onclick = () => {
    const pair = s_pairs.byId.get(Number(b.dataset.pair)) || s_pairs.byId.get(b.dataset.pair);
    // default side: your team if it's in this matchup, else whichever side you're on now, else the first team
    const pick = pair.find((x) => s_pairs.isMe(x.roster_id)) || pair.find((x) => x.roster_id === cur) || pair[0];
    if (pick.roster_id === cur) return closeSwitcher();
    setSide(pick.roster_id);
    closeSwitcher();
  }));
  el.querySelectorAll("[data-recent]").forEach((b) => (b.onclick = () => { const x = recent[Number(b.dataset.recent)]; openLeague(x.u, x.l, x.r); }));
  $("sw-find").onsubmit = (e) => { e.preventDefault(); switcherLeagues($("sw-user").value); };
  $("sw-me").onclick = () => { store.del("me"); store.del("view"); history.replaceState(null, "", location.pathname); showOnboard(""); };
  if (m) switcherLeagues(m.username);
}

async function switcherLeagues(username) {
  const msg = $("sw-msg"), list = $("sw-leagues");
  if (!msg || !username.trim()) return;
  msg.className = "muted"; msg.textContent = "Looking up…"; list.innerHTML = "";
  try {
    const [st, user] = await Promise.all([S.state(), S.findUser(username)]);
    const leagues = await S.nbaLeagues(user.user_id, st.league_season);
    const name = user.username || username.trim();
    const mine = me()?.user_id === user.user_id;
    msg.textContent = leagues.length ? `${mine ? "Your" : `${user.display_name}'s`} ${st.league_season} NBA leagues:` : `No ${st.league_season} NBA leagues for ${name}.`;
    list.innerHTML = leagues.map((l) => `<button class="row-btn" data-id="${esc(l.league_id)}"><span><b>${esc(l.name)}</b></span>
      <span class="muted">${mine ? "my matchup" : `${esc(user.display_name)}'s matchup`}${ctx && l.league_id === ctx.leagueId ? " · open now" : ""}</span></button>`).join("");
    list.querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => openLeague(name, b.dataset.id, null)));
  } catch (err) {
    msg.className = "err"; msg.textContent = err.message;
  }
}

async function load(fresh) {
  if (fresh) S.clearFreshCaches();
  const st = await S.state();
  const season = st.league_season, week = st.week || st.display_week || 1;
  const id = ctx.leagueId;
  const weeks = []; for (let w = Math.max(1, week - 3); w <= week; w++) weeks.push(w);
  const [league, rosters, users, matchups, schedule, statsW, projW] = await Promise.all([
    S.league(id), S.rosters(id, fresh), S.users(id), S.matchups(id, week, fresh), S.schedule(season, fresh),
    Promise.all(weeks.map((w) => S.weekStats(season, w, fresh || w === week))),
    Promise.all(weeks.map((w) => S.weekProjections(season, w, fresh || w === week))),
  ]);
  const raw = { league, rosters, users, matchups, schedule, week, viewRosterId: ctx.rosterId, stats: statsW.flat(), projections: projW.flat(), today: todayET(),
    tipoffs: await tipoffs(season) };
  // Names for rostered players who appear in no stats rows (long injuries).
  const known = new Set([...raw.stats, ...raw.projections].map((r) => r.player_id));
  const needed = matchups.flatMap((m) => m.starters || []).filter((p) => p && p !== "0" && !known.has(p));
  if (needed.length) raw.players = await S.allPlayers();
  // Each starter's own game log (last season cached on this device + this season so far).
  const starters = [...new Set(matchups.filter((m) => m.matchup_id && (m.roster_id === myRosterId(rosters) || m.matchup_id === myMatchupId(rosters, matchups))).flatMap((m) => m.starters || []).filter((p) => p && p !== "0"))];
  const myRoster = rosters.find((x) => x.roster_id === myRosterId(rosters));
  const myMatch = matchups.find((x) => x.roster_id === myRosterId(rosters));
  const reserve = new Set(myRoster?.reserve || []);
  const myBench = (myMatch?.players || []).filter((p) => p && !(myMatch.starters || []).includes(p) && !reserve.has(p));
  const myMid = myMatch?.matchup_id;
  const oppMatch = matchups.find((x) => x.matchup_id === myMid && x.roster_id !== myMatch?.roster_id);
  const oppRoster = oppMatch && rosters.find((x) => x.roster_id === oppMatch.roster_id);
  const oppReserve = new Set(oppRoster?.reserve || []);
  const oppBench = (oppMatch?.players || []).filter((p) => p && !(oppMatch.starters || []).includes(p) && !oppReserve.has(p));
  raw.logs = await loadLogs([...new Set([...starters, ...myBench, ...oppBench])], season, fresh);
  ctx.raw = raw;
  rebuild();
  $("updated").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · data from Sleeper`;
}

function myRosterId(rosters) {
  if (ctx.rosterId != null && rosters.some((x) => x.roster_id === ctx.rosterId)) return ctx.rosterId;
  const r = rosters.find((x) => x.owner_id === ctx.user.user_id || (x.co_owners || []).includes(ctx.user.user_id));
  return r && r.roster_id;
}
function myMatchupId(rosters, matchups) {
  const rid = myRosterId(rosters);
  const m = matchups.find((x) => x.roster_id === rid);
  return m && m.matchup_id;
}

// Tip-off times (Eastern), saved by the snapshot job from the NBA's schedule: they let the model plan
// same-day late swaps. Without them, same-day games are treated as simultaneous.
let tipCache = null;
async function tipoffs(season) {
  tipCache ||= fetch(`https://raw.githubusercontent.com/Nattieon/alpha-scout-app/data/tipoffs/${season}.json?t=${Math.floor(Date.now() / 3.6e6)}`)
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return tipCache;
}

const logCache = new Map();
async function loadLogs(pids, season, fresh) {
  const prev = String(Number(season) - 1);
  const out = {};
  const queue = [...pids];
  async function worker() {
    while (queue.length) {
      const pid = queue.shift();
      const key = `${season}:${pid}`;
      if (!fresh && logCache.has(key)) { out[pid] = logCache.get(key); continue; }
      const [a, b] = await Promise.all([S.playerSeasonLog(pid, prev, { final: true }), S.playerSeasonLog(pid, season)]);
      out[pid] = [...a, ...b];
      logCache.set(key, out[pid]);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

function savedCfg() {
  const saved = store.get("cfg", {});
  if ((saved.cfgv || 1) < 2) delete saved.oppSwaps;   // v2: opponent swaps default to on (keeps both sides consistent)
  return saved;
}
let liveCushion = null;   // while the slider is being dragged
function cfg() {
  const c = { ...DEFAULTS, ...savedCfg() };
  if (liveCushion !== null) c.cushion = liveCushion;
  c.b2bFlags = ctx ? store.get(`b2bflags.${ctx.leagueId}`, {}) : {};
  return c;
}
function toggleB2b(pid) {
  const key = `b2bflags.${ctx.leagueId}`;
  const flags = store.get(key, {});
  if (flags[pid]) delete flags[pid]; else flags[pid] = true;
  store.set(key, flags);
  rebuild();
}
function marksKey() { return `marks3.${ctx.leagueId}.${ctx.raw.week}`; }
function getMarks() {
  const marks = store.get(marksKey(), null);
  if (marks) return marks;
  // carry over older formats ({"pid@date": "locked"|"open"} and the "I locked this" list)
  const old = store.get(`marks.${ctx.leagueId}.${ctx.raw.week}`, null)
    || Object.fromEntries(store.get(`locks.${ctx.leagueId}.${ctx.raw.week}`, []).map((k) => [k, "locked"]));
  return normalizeMarks(old);
}
function setMark(pid, value) {
  const marks = getMarks();
  if (value) marks[pid] = value; else delete marks[pid];
  store.set(marksKey(), marks);
  rebuild();
}

function rebuild() {
  cushionBase = null;
  model = buildModel(ctx.raw, ctx.user.user_id, cfg(), getMarks());
  ctx.shownRoster = myRosterId(ctx.raw.rosters);
  render();
}

// ------------------------------------------------------------------ render
function render() {
  const m = model;
  if (m.missingRoster) {
    $("board").innerHTML = `<p class="muted"><b>${esc(ctx.user.display_name)}</b> doesn't have a team in <b>${esc(ctx.raw.league.name)}</b>. Tap <b>Matchups</b> to pick one.</p>`;
    ["ask", "todo", "lineup"].forEach((id) => ($(id).innerHTML = ""));
    return;
  }
  const mine = viewingMine();
  $("tab-me").textContent = mine ? "You" : m.me.name;
  $("tab-opp").textContent = mine ? "Opponent" : m.opp?.name || "Opponent";
  renderBoard(m); renderSides(m, mine); renderAsk(m); renderTodo(m); renderCushion(m); renderLineup(m);
  const c = cfg();
  $("cfg-mode").value = c.mode; $("cfg-proj").value = c.projBasis; $("cfg-opp").value = c.oppSwaps ? "on" : "off"; $("cfg-base").value = Math.round(c.baseDnp * 100); $("cfg-b2b").value = Math.round(c.pairRest * 100);
}

// ------------------------------------------------------------------ safety cushion slider
// Live: every move of the slider rebuilds the model and redraws everything except the slider itself.
// The value is saved when the slider is let go. Auto = the opponent's biggest single-slot swing.
let cushionBase = null;   // the model with no cushion, for "what changed"
const CU_MAX = 40;
function renderCushion(m) {
  const el = $("cushion");
  if (!m.opp || m.mode !== "win") { el.hidden = true; return; }
  el.hidden = false;
  const saved = cfg().cushion;
  const isAuto = saved === "auto";
  const val = isAuto ? m.autoCushion : Number(saved) || 0;
  if (!$("cu-range")) {
    el.innerHTML = `
      <div class="cu-row">
        <label for="cu-range"><b>Safety cushion</b></label>
        <output id="cu-out" class="num" for="cu-range"></output>
        <button type="button" class="chip" id="cu-auto" aria-pressed="false"></button>
      </div>
      <input type="range" id="cu-range" min="0" max="${CU_MAX}" step="1" aria-describedby="cu-hint">
      <div class="cu-scale num"><span>0 = off</span><span>${CU_MAX} pts</span></div>
      <div id="cu-effect" class="cu-effect" aria-live="polite"></div>
      <p id="cu-hint" class="cu-hint muted">A lead smaller than this isn't treated as safe, so the advice plays it like you're behind. The chance to win at the top doesn't change. Below: what it does to tonight's lines.</p>`;
    const range = $("cu-range");
    let raf = 0;
    const live = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        liveCushion = Number(range.value);
        cushionBase ||= buildModel(ctx.raw, ctx.user.user_id, { ...cfg(), cushion: 0 }, getMarks());
        model = buildModel(ctx.raw, ctx.user.user_id, cfg(), getMarks());
        render();
      });
    };
    range.addEventListener("input", live);
    range.addEventListener("change", () => {
      cancelAnimationFrame(raf);
      liveCushion = null;
      const c = { ...DEFAULTS, ...savedCfg(), cfgv: 2, cushion: Number(range.value) };
      delete c.b2bFlags;
      store.set("cfg", c);
      rebuild();
    });
    $("cu-auto").addEventListener("click", () => {
      const c = { ...DEFAULTS, ...savedCfg(), cfgv: 2 };
      delete c.b2bFlags;
      c.cushion = c.cushion === "auto" ? Math.round(model.autoCushion) : "auto";
      store.set("cfg", c);
      liveCushion = null;
      rebuild();
    });
  }
  const range = $("cu-range");
  if (document.activeElement !== range || liveCushion === null) range.value = String(Math.round(Math.min(val, CU_MAX)));
  range.style.setProperty("--fill", `${(Math.min(val, CU_MAX) / CU_MAX) * 100}%`);
  $("cu-out").textContent = val > 0 ? `${f1(val)} pts` : "Off";
  const a = $("cu-auto");
  a.textContent = `Auto · ${f1(m.autoCushion)}`;
  a.setAttribute("aria-pressed", String(isAuto && liveCushion === null));
  // what the cushion changes right now: decisions and tonight's lock bars, vs no cushion
  const base = liveCushion !== null && cushionBase ? cushionBase : null;
  const bySlot = (mm) => Object.fromEntries(mm.me.slots.map((x) => [x.i, x]));
  const b = base ? bySlot(base) : {};
  const items = [];
  for (const x of m.me.slots) {
    if (x.kind === "pending" && x.call) {
      const was = b[x.i]?.call?.verdict;
      items.push(`<span class="cu-item${was && was !== x.call.verdict ? " changed" : ""}">${esc(shortName(x.p.name))} <b class="${x.call.verdict === "LOCK" ? "lock" : "pass"}">${x.call.verdict === "LOCK" ? "LOCK" : "RIDE"}</b></span>`);
    }
    if (x.tonight?.bar !== undefined && !x.tonight.final) {
      const was = b[x.i]?.tonight?.bar;
      const moved = was !== undefined && Math.abs(was - x.tonight.bar) >= 0.05;
      items.push(`<span class="cu-item${moved ? " changed" : ""}">${esc(shortName(x.p.name))} <b class="num">${f1(x.tonight.bar)}+</b>${moved ? ` <span class="muted num">(${f1(was)})</span>` : ""}</span>`);
    }
  }
  $("cu-effect").innerHTML = items.length ? items.join("") : `<span class="muted">Nothing tonight for it to change.</span>`;
}

/** Flip to the other side of the matchup on screen (no reload: both sides' logs are already loaded). */
function setSide(rid) {
  ctx.rosterId = rid; ctx.raw.viewRosterId = rid;
  const u = ctx.user.username || ctx.user.display_name;
  store.set("view", { u, l: ctx.leagueId, r: rid });
  history.replaceState(null, "", `?u=${encodeURIComponent(u)}&l=${ctx.leagueId}&r=${rid}`);
  view = "me";
  const pairOf = (r) => ctx.raw.matchups.find((x) => x.roster_id === r)?.matchup_id;
  if (pairOf(rid) !== pairOf(model?.me?.rosterId ?? ctx.shownRoster)) {   // a different matchup: fetch its players' logs
    $("board").innerHTML = '<div class="skeleton"></div>';
    load(false).then(rememberView); return;
  }
  rebuild(); rememberView();
}

const clockET = (hhmm) => { const [h, mi] = hhmm.split(":").map(Number); return `${((h + 11) % 12) + 1}${mi ? `:${String(mi).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"} ET`; };
/** "Lock him in at PG, not UTIL": where a lock should go so the rest of the week has the most room. */
function lockSlotNote(x, { tonight = false } = {}) {
  if (!x) return "";
  const move = x.moves ? ` Move <b>${esc(shortName(x.moves.name))}</b> ${x.moves.to === "bench" ? "to the bench" : `to ${esc(x.moves.to)}`} first.` : "";
  const why = x.reason === "points"
    ? `That's worth <b class="num">+${f1(x.gain)}</b> over the rest of the week${x.opens ? `: it opens a spot for <b>${esc(shortName(x.opens.name))}</b>` : ""}.`
    : `Same points either way, but it keeps the more flexible ${esc(x.from)} slot unlocked for later moves.`;
  return `<div class="flip lockslot">${tonight ? "If you lock him, lock" : "Lock"} him in at <b>${esc(x.label)}</b>, not ${esc(x.from)}.${move} ${why}</div>`;
}

// ------------------------------------------------------------------ plain-language helpers
const tipOf = (g) => (g?.tip ? clockET(g.tip.slice(11)) : "");
const whenOf = (g, today, cap = false) => (g ? `${g.date === today ? (cap ? "Tonight" : "tonight") : dow(g.date)}${g.tip ? ` ${tipOf(g)}` : ""}` : "");
const vsOf = (g) => (g ? `${g.home ? "vs" : "@"} ${esc(g.opp)}` : "");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** How often he reaches a score, from its percentile among his games: "about 1 game in 5". */
function often(q) {
  if (q === null || q === undefined) return "";
  const r = 1 - q;
  if (r >= 0.6) return "most of his games";
  if (r >= 0.4) return "about half his games";
  if (r < 0.05) return "rarely";
  return `about 1 game in ${Math.max(2, Math.round(1 / r))}`;
}
/** "Mon: 15% chance he sits (back-to-back)", only for games where it matters. */
function sitLines(games) {
  return (games || []).filter((g) => g.p >= 0.1).map((g) =>
    `<div class="${g.p >= 0.2 ? "warn" : ""}">${dow(g.date)}: ${pct(g.p)} chance he sits${g.why?.length ? ` (${esc(g.why.join(", "))})` : ""}</div>`);
}
/** Late-swap days in words: "Wed: if Missi scores under 26.3, swap in Markkanen (10pm ET)." Only days with a backup. */
function planSentences(s) {
  const days = [];
  s.plan.forEach((x) => { const last = days.at(-1); if (last && last.date === x.date) last.steps.push(x); else days.push({ date: x.date, steps: [x] }); });
  return days.filter((d) => d.steps.length > 1).map((d) => {
    const parts = [];
    for (let i = 0; i < d.steps.length - 1; i++) {
      const a = d.steps[i], b = d.steps[i + 1];
      parts.push(`if <b>${esc(shortName(a.name))}</b> scores under <b class="num">${f1(a.bar)}</b>, swap in <b>${esc(shortName(b.name))}</b>${b.tip ? ` (${clockET(b.tip.slice(11))})` : ""}`);
    }
    return `<div>${dow(d.date)}: ${parts.join("; then ")}.</div>`;
  });
}
const todoItem = ({ pill, pillCls = "soft", title, line, sub = "", body = "", open = false }) => `
  <details class="todo"${open ? " open" : ""}>
    <summary>
      <div class="todo-main"><div class="todo-title">${title}</div><div class="todo-line">${line}</div>${sub ? `<div class="todo-sub">${sub}</div>` : ""}</div>
      <span class="pill ${pillCls}">${pill}</span>
    </summary>
    ${body ? `<div class="todo-body">${body}</div>` : ""}
  </details>`;

// ------------------------------------------------------------------ scoreboard
function renderBoard(m) {
  const range = m.weekDates.length ? `${md(m.weekDates[0])} – ${md(m.weekDates.at(-1))}` : "";
  const top = `<div class="board-top"><span>${esc(ctx.raw.league.name)} · Week ${m.week} · ${range}</span></div>`;
  if (!m.opp) {
    $("board").innerHTML = `${top}
      <div class="team"><div class="who">${esc(m.me.name)}</div><div class="pts num">${f1(m.me.points)}</div><div class="proj num">Projected ${f1(m.me.proj)}</div></div>
      <p class="muted">No opponent this week, so the app goes for the most points.</p>`;
    return;
  }
  const w = m.win;
  $("board").innerHTML = `${top}
    <div class="teams">
      <div class="team"><div class="who">${esc(m.me.name)}</div><div class="pts num">${f1(m.me.points)}</div><div class="proj num">Projected ${f1(m.me.proj)}</div></div>
      <div class="vs">VS</div>
      <div class="team r"><div class="who">${esc(m.opp.name)}</div><div class="pts num">${f1(m.opp.points)}</div><div class="proj num">Projected ${f1(m.opp.proj)}</div></div>
    </div>
    <div class="winbar" aria-label="Chance to win">
      <div class="lbl"><span><b class="num">${pct(w)}</b> chance to win</span><span class="muted num">${pct(1 - w)}</span></div>
      <div class="track"><div class="me" style="width:${(w * 100).toFixed(1)}%"></div></div>
    </div>`;
}

/** Whose side the advice is for. Hidden on your own matchup; there it's a small "see their side" link. */
function renderSides(m, mine) {
  const raw = ctx.raw, m0 = me();
  const cur = myRosterId(raw.rosters);
  const pairId = raw.matchups.find((x) => x.roster_id === cur)?.matchup_id;
  const pair = pairId ? raw.matchups.filter((x) => x.matchup_id === pairId) : [];
  if (pair.length < 2) return;
  const isMe = (rid) => { const r = raw.rosters.find((x) => x.roster_id === rid); return !!(m0 && r && (r.owner_id === m0.user_id || (r.co_owners || []).includes(m0.user_id))); };
  const other = pair.find((x) => x.roster_id !== cur);
  if (mine) {
    $("board").insertAdjacentHTML("beforeend", `<div class="sides-mini"><button class="linkish" data-side="${other.roster_id}">See what ${esc(teamName(raw, other.roster_id))} should do</button></div>`);
  } else {
    const btns = pair.map((x) => `<button role="radio" aria-checked="${x.roster_id === cur}" data-side="${x.roster_id}">${esc(teamName(raw, x.roster_id))}${isMe(x.roster_id) ? ' <span class="tag">you</span>' : ""}</button>`).join("");
    const mineInLeague = raw.rosters.some((r) => isMe(r.roster_id));
    $("board").insertAdjacentHTML("beforeend", `<div class="sides"><span class="lbl">Advice for</span>
      <div class="seg" role="radiogroup" aria-label="Whose advice">${btns}</div>
      ${m0 && mineInLeague ? `<button class="linkish" id="back-mine">Back to my matchup</button>` : ""}</div>`);
  }
  if (!m0) {
    $("board").insertAdjacentHTML("beforeend", `<div class="notme">Looking at <b>${esc(ctx.user.display_name || ctx.user.username)}</b>'s team.
      <button class="linkish" id="is-me">That's me</button> · <button class="linkish" id="find-me">Find my team</button></div>`);
    $("is-me").onclick = () => { store.set("me", { username: ctx.user.username || ctx.user.display_name, user_id: ctx.user.user_id }); rebuild(); rememberView(); };
    $("find-me").onclick = () => showOnboard("");
  }
  $("board").querySelectorAll("[data-side]").forEach((b) => (b.onclick = () => { if (Number(b.dataset.side) !== cur) setSide(Number(b.dataset.side)); }));
  if ($("back-mine")) $("back-mine").onclick = goMine;
}

// ------------------------------------------------------------------ "Did you lock these?"
function renderAsk(m) {
  const el = $("ask");
  // Sleeper never says what you locked, so earlier games are guessed. Your side: ask.
  const guesses = viewingMine() ? m.me.slots.filter((s) => s.kind === "assumed-locked" && s.guess) : [];
  if (!guesses.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<h2>Did you lock these?</h2>
    <p class="hint">Sleeper hides locks until the week is over. The app guessed these; tell it if it's wrong.</p>
    <div class="asks">${guesses.map((s) => `<div class="ask-row">
      <div><b>${esc(s.p.name)}</b> <span class="muted">${dow(s.lockedGame.date)} · <span class="num">${f1(s.lockedGame.fp)}</span></span></div>
      <div class="ask-btns"><button class="btn sm" data-yes="${esc(s.pid)}" data-date="${esc(s.lockedGame.date)}">Yes</button>
        <button class="btn sm ghost" data-no="${esc(s.pid)}" data-date="${esc(s.lockedGame.date)}">No</button></div></div>`).join("")}</div>`;
  el.querySelectorAll("[data-yes]").forEach((b) => (b.onclick = () => setMark(b.dataset.yes, b.dataset.date)));
  el.querySelectorAll("[data-no]").forEach((b) => (b.onclick = () => setMark(b.dataset.no, `pass:${b.dataset.date}`)));
}

// ------------------------------------------------------------------ what to do
function decisionItem(s, m) {
  const c = s.call, lock = c.verdict === "LOCK", g = s.lastDone, next = s.games?.[0];
  const sh = esc(shortName(s.p.name));
  const line = lock
    ? `Lock his ${dow(g.date)} <b class="num">${f1(s.score)}</b>.`
    : `Don't lock ${dow(g.date)}'s <b class="num">${f1(s.score)}</b>. ${s.contBy ? `Swap in <b>${esc(shortName(s.contBy.p.name))}</b> instead.` : `Let it ride: ${plural(s.games.length, "game")} left.`}`;
  const sub = next ? `Decide before ${whenOf(next, m.today)}` : "";
  const why = [];
  if (c.winIfLock !== undefined) why.push(`<div class="duo"><span>Lock: <b class="num">${pct(c.winIfLock)}</b> to win</span><span>Ride: <b class="num">${pct(c.winIfPass)}</b> to win</span></div>`);
  why.push(`<div>Riding the rest of his week is worth about <b class="num">${f1(c.bar)}</b> on average${s.contBy ? ` (with ${esc(shortName(s.contBy.p.name))} swapped in)` : ""}, counting the chance he sits. If you ride, there's a ${pct(c.pBelow)} chance he ends lower than ${f1(s.score)}.</div>`);
  const cushioned = c.cushion > 0 && (c.winIfLock >= c.winIfPass ? "LOCK" : "PASS") !== c.verdict;
  if (cushioned) why.push(`<div class="flip">Your lead is smaller than your ${f1(c.cushion)}-point safety cushion, so the app ${lock ? "plays it safe" : "takes the chance"}.</div>`);
  else if (c.matchupFlip) why.push(`<div class="flip">${lock ? "On points alone you'd ride, but locking protects your lead." : "On points alone you'd lock, but you need upside to catch up."}</div>`);
  if (lock && typeof lockSlotNote === "function") why.push(lockSlotNote(s.lockInto));
  why.push(...sitLines(s.games));
  why.push(`<div class="marks">
      <label class="toggle"><input type="checkbox" data-mark="${esc(s.pid)}" data-date="${esc(g.date)}"> I already locked it</label>
      <label class="toggle"><input type="checkbox" data-mark="${esc(s.pid)}" data-date="after:${esc(g.date)}"> He was on my bench that day</label></div>`);
  return todoItem({ pill: lock ? "LOCK" : "RIDE", pillCls: lock ? "lock" : "pass", title: esc(s.p.name), line, sub, body: why.join("") });
}

function tonightItem(s, m) {
  const t = s.tonight, live = s.kind === "live", g = live ? s.liveGame : s.games?.[0];
  const sh = esc(shortName(s.p.name));
  if (t.final) {
    if (!s.p.injury) return "";
    return todoItem({ pill: "CHECK", pillCls: "pass", title: esc(s.p.name),
      line: `Listed <span class="warn">${esc(s.p.injury)}</span>. Tonight is his last game, so if he sits this slot scores 0. Start someone healthy.`, sub: `${whenOf(g, m.today)} ${vsOf(g)}` });
  }
  const after = t.after.length ? t.after.reduce((a, x) => a + x.mu, 0) / t.after.length : 0;
  const line = live ? `Playing now ${vsOf(g)} · <span class="state live">Live ${f1(s.liveFp)}</span>` : `${whenOf(g, m.today, true)} ${vsOf(g)}`;
  const sub = `${t.pctBar != null ? `He gets there in ${often(t.pctBar)}. ` : ""}Below it, let it ride.`;
  const why = [];
  why.push(`<div>${live ? "" : `Projected tonight: <b class="num">${f1(s.games?.[0]?.mu)}</b>. `}${t.afterBy ? `If you don't lock, swap in <b>${esc(shortName(t.afterBy.p.name))}</b> for ${t.after.map((x) => dow(x.date)).join("/")}` : `After tonight: ${plural(t.after.length, "more game")}`}, worth about <b class="num">${f1(after)}</b> each.</div>`);
  if (Math.abs(t.bar - t.evBar) >= 0.5) why.push(`<div class="muted">On points alone the line would be ${f1(t.evBar)}; the matchup moves it.</div>`);
  if (typeof lockSlotNote === "function") why.push(lockSlotNote(s.lockIntoTonight, { tonight: true }));
  why.push(...sitLines(s.games?.slice(1)));
  why.push(`<div class="whatif"><label for="wi-${s.i}">Check a score:</label><input id="wi-${s.i}" data-wi="${s.i}" type="number" inputmode="decimal" step="0.5" placeholder="${f1(t.bar)}"> <span id="wo-${s.i}" class="muted"></span></div>`);
  return todoItem({ pill: `<small>LOCK AT</small>${f1(t.bar)}+`, pillCls: "line", title: esc(s.p.name), line, sub, body: why.join("") });
}

function swapItem(w, m) {
  const g = w.into.games[0];
  const into = esc(shortName(w.into.p.name));
  const outTxt = w.out ? `for <b>${esc(shortName(w.out.name))}</b>${w.slot.kind === "final" ? " (his week is over)" : w.slot.kind === "none" ? " (no games left)" : ""}` : "in the empty spot";
  const line = `Start <b>${into}</b> at ${esc(w.slot.label)} ${outTxt}${w.into.from !== "bench" ? ` (move him from ${esc(w.into.from)})` : ""}.`;
  const sub = g ? `Before ${whenOf(g, m.today)} · about <b class="num">+${f1(w.gain)}</b> pts` : "";
  const why = [];
  if (w.keepFirst?.length && !(w.slot.planPlayers?.length >= 2))
    why.push(`<div class="flip">No rush: keep ${esc(shortName(w.out.name))} in for ${w.keepFirst.map((x) => dow(x.date)).join("/")}. If he scores ${f1(w.slot.tonight?.bar ?? w.into.value)}+, lock him and skip the swap.</div>`);
  if (w.slot.planPlayers?.length >= 2) why.push(...planSentences(w.slot));
  why.push(`<div class="muted">${w.into.games.map((x) => `${dow(x.date)} ${vsOf(x)} · proj ${f1(x.mu)}`).join(" · ")}</div>`);
  why.push(...sitLines(w.into.games));
  return todoItem({ pill: "SWAP", pillCls: "swap", title: `${esc(w.into.p.name)} → ${esc(w.slot.label)}`, line, sub, body: why.join("") });
}

function planItem(s) {
  const lines = planSentences(s);
  if (!lines.length) return "";
  return todoItem({ pill: "BACKUP", pillCls: "soft", title: `${esc(s.label)}: backup plan`,
    line: `${esc(shortName(s.p?.name || "This slot"))} stays in. Some nights a later game can replace him.`, sub: "Tap for the nights", body: lines.join("") });
}

function renderTodo(m) {
  const el = $("todo");
  const today = m.today;
  const pend = m.me.slots.filter((s) => s.kind === "pending" && s.call);
  const tonight = m.me.slots.filter((s) => s.tonight && !(s.kind === "pending" && s.tonight.final)).map((s) => tonightItem(s, m)).filter(Boolean);
  const swapSlots = new Set((m.swaps || []).map((w) => w.slot));
  const moves = [...(m.swaps || []).map((w) => swapItem(w, m)), ...m.me.slots.filter((s) => s.planPlayers?.length >= 2 && !swapSlots.has(s)).map(planItem)].filter(Boolean);
  const groups = [];
  if (pend.length) groups.push(`<h3>Decide now</h3><div class="todos">${pend.map((s) => decisionItem(s, m)).join("")}</div>`);
  if (tonight.length) groups.push(`<h3>Tonight · ${dow(today)} ${md(today)}</h3><div class="todos">${tonight.join("")}</div>`);
  if (moves.length) groups.push(`<h3>Lineup moves</h3><div class="todos">${moves.join("")}</div>`);
  el.innerHTML = groups.length ? `<h2>What to do</h2>${groups.join("")}<p class="hint">Tap any row for the why.</p>`
    : `<h2>What to do</h2><p class="empty-note">Nothing to decide right now. Check back when your players' games finish.</p>`;
  el.querySelectorAll("[data-mark]").forEach((cb) => cb.addEventListener("change", () => setMark(cb.dataset.mark, cb.checked ? cb.dataset.date : null)));
  el.querySelectorAll("[data-wi]").forEach((inp) => inp.addEventListener("input", () => {
    const s = model.me.slots[+inp.dataset.wi];
    const out = $(`wo-${s.i}`);
    const x = parseFloat(inp.value);
    if (Number.isNaN(x)) { out.textContent = ""; return; }
    const c = model.whatIf(s, x);
    out.innerHTML = `<span class="pill sm ${c.verdict === "LOCK" ? "lock" : "pass"}">${c.verdict === "LOCK" ? "LOCK" : "RIDE"}</span>${c.winIfLock !== undefined ? ` <span class="muted num">${pct(c.winIfLock)} vs ${pct(c.winIfPass)} to win</span>` : ""}`;
  }));
}


function availLine(p) {
  const a = p.avail;
  const bits = [];
  if (a) {
    bits.push(`rests ${pct(a.q)} of back-to-backs`);
    bits.push(`sits ${pct(a.normal)} of other games`);
    if (a.durability >= 0.2) bits.push(`missed ${pct(a.durability)} of his last ${Math.min(82, a.history.rows)} games`);
    if (a.ramp > 0.05) bits.push(`${a.gamesBack} games back from a ${a.absence}-game absence`);
  }
  return `<div class="avail"><span class="pmeta">${bits.length ? esc(bits.join(" · ")) : "No history on how often he sits"}</span>
    <button type="button" class="flag" data-b2b="${esc(p.pid)}" aria-pressed="${p.flagged}">${p.flagged ? "✓ Rests back-to-backs" : "Rests back-to-backs?"}</button></div>`;
}

function lockPicker(s) {
  const played = (s.completed || []).filter((g) => g.played);
  if (!s.completed?.length) return "";
  const autoText = s.kind === "assumed-locked" ? `locked ${dow(s.lockedGame?.date || s.lastDone?.date)}` : s.kind === "assumed-open" ? "not locked"
    : s.kind === "final" ? "last game counts" : s.kind === "pending" ? "your call" : "not locked";
  // Two uses: recording a lock made at the time (any game, earlier ones included), or saying it isn't locked.
  // An earlier game you didn't lock is dead by rule, so "not locked" is only ever about his latest game.
  const latest = s.completed.at(-1);
  let cur = s.mark || "auto";
  if (cur.startsWith?.("after:") && cur !== `after:${latest.date}`) cur = "open";
  const opt = (v, label) => `<option value="${esc(v)}"${cur === v ? " selected" : ""}>${esc(label)}</option>`;
  const games = played.map((g) => opt(g.date, `Locked ${dow(g.date)} · ${f1(g.fp)}`));
  const open = latest.played
    ? [opt("open", `Not locked (${dow(latest.date)} can still be locked)`), opt(`after:${latest.date}`, `Was on the bench ${dow(latest.date)}`)]
    : [opt("open", "Not locked")];
  if (cur.startsWith?.("pass:")) open.unshift(opt(cur, `Not locked through ${dow(cur.slice(5))}`));
  return `<label class="picker"><span>Lock:</span>
    <select data-pick="${esc(s.pid)}">${opt("auto", `App's guess: ${autoText}`)}${games.join("")}${open.join("")}</select></label>`;
}

function gameChips(s) {
  if (!s.p) return "";
  const countsDate = s.lockedGame?.date || (s.kind === "final" ? s.lastDone?.date : null);
  return s.p.games.map((g) => {
    if (g.status === "complete") {
      if (s.benchedThrough && g.date === s.benchedThrough) return `<span class="g out num" title="Played from your bench: doesn't count">${dow(g.date)} ${g.played ? f1(g.fp) : "DNP"} · bench</span>`;
      const cls = g.date === countsDate ? "g counts" : g.played ? "g" : "g out";
      return `<span class="${cls} num">${dow(g.date)} ${g.played ? f1(g.fp) : "DNP"}</span>`;
    }
    if (g.live) return `<span class="g live num">${dow(g.date)} live ${f1(g.fp ?? 0)}</span>`;
    const pj = g.projFp !== null && g.projFp !== undefined ? ` · ${f1(g.projFp)}` : g.projectedOut ? " · out" : "";
    return `<span class="g num" title="Sleeper projection">${dow(g.date)} ${g.home ? "v" : "@"}${esc(g.opp)}${pj}</span>`;
  }).join("");
}

/** One plain status per slot: what counts now, or what happens next. */
function statusOf(s) {
  const next = s.p?.games?.find((g) => g.status === "pre_game");
  const day = (g) => (g ? dow(g.date) : "");
  if (s.swapIn) return { cls: "pending", text: `Swap in ${esc(shortName(s.swapIn.p.name))}` };
  switch (s.kind) {
    case "locked": return { cls: "locked", text: `Locked ${day(s.lockedGame)}${s.manual ? "" : ""}` };
    case "assumed-locked": return { cls: "locked", text: `Locked ${day(s.lockedGame)} <span class="muted">(guess)</span>` };
    case "pending": return { cls: "pending", text: `Your call on ${day(s.lastDone)}` };
    case "live": return { cls: "live", text: "Playing now" };
    case "final": return { cls: "final", text: "Week over" };
    case "none": return { cls: "final", text: "No games left" };
    default: return { cls: "open", text: next ? `Open · next ${day(next)}` : "Open" };
  }
}

function renderLineup(m) {
  const side = view === "me" ? m.me : m.opp;
  $("tab-me").setAttribute("aria-selected", view === "me"); $("tab-opp").setAttribute("aria-selected", view === "opp");
  $("tab-opp").hidden = !m.opp;
  if (!side) { $("lineup").innerHTML = ""; return; }
  const rows = side.slots.map((s) => {
    if (s.empty) return `<div class="lrow"><div class="lsum"><div class="slot">${esc(s.label)}</div><div class="muted">Empty</div><div class="val"><b>0.0</b></div></div></div>`;
    const st = statusOf(s);
    const counted = ["locked", "final", "assumed-locked", "none"].includes(s.kind);
    return `<details class="lrow">
      <summary class="lsum">
        <div class="slot">${esc(s.label)}</div>
        <div style="min-width:0"><div class="lname">${esc(s.p.name)}${rankBadge(s.pid)}${s.p.injury ? ` <span class="warn inj">${esc(s.p.injury)}</span>` : ""}</div>
          <div class="lstat state ${st.cls}">${st.text}</div></div>
        <div class="val"><b class="num">${f1(s.shownProj)}</b><small>${counted ? "counts" : "proj"}</small></div>
      </summary>
      <div class="ldet"><div class="pmeta">${esc(s.p.team || "FA")} · ${esc(s.p.pos || "")}</div><div class="games">${gameChips(s)}</div>${lockPicker(s)}${availLine(s.p)}</div>
    </details>`;
  });
  const bench = (side.bench || []).map((b) => `<details class="lrow bench">
      <summary class="lsum"><div class="slot">BN</div>
        <div style="min-width:0"><div class="lname">${esc(b.p.name)}${rankBadge(b.pid)}${b.p.injury ? ` <span class="warn inj">${esc(b.p.injury)}</span>` : ""}</div>
          <div class="lstat muted">Bench</div></div>
        <div class="val"><b class="num">${b.nextProj != null ? f1(b.nextProj) : "–"}</b><small>next</small></div></summary>
      <div class="ldet"><div class="pmeta">${esc(b.p.team || "FA")}</div><div class="games">${gameChips({ p: b.p, kind: "bench" })}</div></div>
    </details>`);
  $("lineup").innerHTML = rows.join("") + (bench.length ? `<div class="benchhead">Bench (doesn't score)</div>${bench.join("")}` : "");
  $("lineup").querySelectorAll("button[data-b2b]").forEach((b) => b.addEventListener("click", () => toggleB2b(b.dataset.b2b)));
  $("lineup").querySelectorAll("select[data-pick]").forEach((sel) => sel.addEventListener("change", () => setMark(sel.dataset.pick, sel.value === "auto" ? null : sel.value)));
}


$("tab-me").addEventListener("click", () => { view = "me"; renderLineup(model); });
$("tab-opp").addEventListener("click", () => { view = "opp"; renderLineup(model); });
$("refresh").addEventListener("click", async () => { $("refresh").textContent = "Refreshing…"; try { await load(true); } finally { $("refresh").textContent = "Refresh"; } });
const saveCfg = () => {
  const c = { ...DEFAULTS, ...savedCfg(), cfgv: 2 };
  c.mode = $("cfg-mode").value;
  c.projBasis = $("cfg-proj").value;
  c.oppSwaps = $("cfg-opp").value === "on";
  c.baseDnp = Math.min(Math.max((parseFloat($("cfg-base").value) || 0) / 100, 0), 0.3);
  c.pairRest = Math.min(Math.max((parseFloat($("cfg-b2b").value) || 0) / 100, 0), 0.9);
  delete c.b2bDnp; delete c.b2bFlags;
  store.set("cfg", c); rebuild();
};
["cfg-mode", "cfg-proj", "cfg-opp", "cfg-base", "cfg-b2b"].forEach((id) => $(id).addEventListener("change", saveCfg));

boot();
