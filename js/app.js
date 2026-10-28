import * as S from "./sleeper.js?v=__V__";
import { buildModel, DEFAULTS, dow, md, normalizeMarks, todayET } from "./model.js?v=__V__";
import { openHistory } from "./history.js?v=__V__";
import { LAB } from "./lab.js?v=__V__";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** Last name for tight spaces, skipping suffixes: "Jaren Jackson Jr." -> "Jackson". */
const shortName = (n) => { const w = String(n || "").split(" ").filter((x) => !/^(jr|sr|ii|iii|iv|v)\.?$/i.test(x)); return w.at(-1) || n; };
const f1 = (x) => (x === null || x === undefined || Number.isNaN(x) ? "–" : (Math.round(x * 10) / 10).toFixed(1));
const pct = (x) => `${Math.round(x * 100)}%`;
const ord = (q) => { const n = Math.min(99, Math.max(1, Math.round(q * 100))); const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const pctLabel = (q, p) => (q === null || q === undefined ? "" : `${ord(q)} pct of his last ${p.nHistory}`);

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
  $("dash").hidden = true; $("onboard").hidden = false; $("who").hidden = true;
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
  $("history").hidden = true;
  $("onboard").hidden = true; $("dash").hidden = false;
  $("board").innerHTML = '<div class="skeleton"></div>';
  ["decide", "swaps", "tonight"].forEach((id) => ($(id).innerHTML = ""));
  $("lineup").innerHTML = "";
  try {
    const user = await S.findUser(username);
    const name = user.username || username;
    if (!me()) store.set("me", { username: name, user_id: user.user_id });
    store.set("username", me().username); store.set("league", leagueId);
    ctx = { user, leagueId, rosterId: rosterId ?? null };
    store.set("view", { u: name, l: leagueId, r: ctx.rosterId });
    history.replaceState(null, "", `?u=${encodeURIComponent(name)}&l=${leagueId}${ctx.rosterId != null ? `&r=${ctx.rosterId}` : ""}`);
    view = "me";
    $("who").hidden = false; $("who").textContent = "Matchups ▾";
    await load(false);
    rememberView();
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

function showHistory() {
  closeSwitcher();
  const m = me(), raw = ctx.raw;
  const mine = m && raw.rosters.find((r) => r.owner_id === m.user_id || (r.co_owners || []).includes(m.user_id));
  $("dash").hidden = true; $("history").hidden = false;
  window.scrollTo(0, 0);
  openHistory($("history"), { leagueId: ctx.leagueId, mineRosterId: mine?.roster_id ?? null, preferRosterId: myRosterId(raw.rosters),
    onClose: () => { $("history").hidden = true; $("dash").hidden = false; } });
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
      <p class="muted">Pick a matchup, then choose which side is "you" on the matchup screen.</p></div>`;
    s_pairs = { byId, isMe };
  }
  const curOpp = raw?.matchups.find((x) => x.roster_id !== cur && x.matchup_id && x.matchup_id === raw.matchups.find((y) => y.roster_id === cur)?.matchup_id)?.roster_id;
  const recent = store.get("recent", []).filter((x) => !(raw && x.l === ctx.leagueId && (x.r === cur || x.r === curOpp)));
  const recentHtml = recent.length ? `<div class="sw-sec"><h3>Recent</h3><div class="rows">${recent.map((x, i) =>
    `<button class="row-btn" data-recent="${i}"><span>${esc(x.label)}${x.mine ? ' <span class="tag">you</span>' : ""}</span><span class="muted">${esc(x.league)}</span></button>`).join("")}</div></div>` : "";
  el.innerHTML = `
    <div class="sw-head"><b>Switch matchup</b><button class="chip" id="sw-close" aria-label="Close">Close</button></div>
    <div class="sw-actions">${raw && !viewingMine() && m ? `<button class="btn" id="sw-mine">Back to my matchup</button>` : ""}${raw ? `<button class="btn ghost" id="sw-hist">History</button>` : ""}</div>
    ${leagueHtml}
    <div class="sw-sec"><h3>Leagues</h3>
      <form class="find" id="sw-find"><input id="sw-user" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Any Sleeper username" value="${esc(m?.username || "")}">
        <button class="btn ghost" type="submit">Look up</button></form>
      <div id="sw-msg" class="muted" role="status"></div><div class="rows" id="sw-leagues"></div></div>
    ${recentHtml}
    <p class="muted sw-foot">"You" is <b>${esc(m?.username || "—")}</b> on Sleeper: that's whose team the app opens by default. <button class="linkish" id="sw-me">Change</button></p>`;
  $("sw-close").onclick = closeSwitcher;
  if ($("sw-mine")) $("sw-mine").onclick = goMine;
  if ($("sw-hist")) $("sw-hist").onclick = showHistory;
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
    $("board").innerHTML = `<p class="muted"><b>${esc(ctx.user.display_name)}</b> doesn't have a team in <b>${esc(ctx.raw.league.name)}</b>. Use <b>Matchups</b> to pick one.</p>`;
    ["decide", "swaps", "tonight", "lineup"].forEach((id) => ($(id).innerHTML = ""));
    return;
  }
  const mine = viewingMine();
  $("tab-me").textContent = mine ? "You" : m.me.name;
  $("tab-opp").textContent = mine ? "Opponent" : m.opp?.name || "Opponent";
  renderBoard(m); renderCushion(m); renderDecide(m); renderSwaps(m); renderTonight(m); renderLineup(m);
  renderSides(m, mine);
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
      <div class="cu-scale num"><span>0 · best odds to win</span><span>${CU_MAX} pts</span></div>
      <div id="cu-effect" class="cu-effect" aria-live="polite"></div>
      <p id="cu-hint" class="cu-hint muted">Calls treat a lead smaller than the cushion as one move from gone, and play it like a deficit. The win % above stays the plain chance to win.</p>`;
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
      items.push(`<span class="cu-item${was && was !== x.call.verdict ? " changed" : ""}">${esc(shortName(x.p.name))} <b class="${x.call.verdict === "LOCK" ? "lock" : "pass"}">${x.call.verdict}</b></span>`);
    }
    if (x.tonight?.bar !== undefined && !x.tonight.final) {
      const was = b[x.i]?.tonight?.bar;
      const moved = was !== undefined && Math.abs(was - x.tonight.bar) >= 0.05;
      items.push(`<span class="cu-item${moved ? " changed" : ""}">${esc(shortName(x.p.name))} lock ≥ <b class="num">${f1(x.tonight.bar)}</b>${moved ? ` <span class="muted num">(${f1(was)})</span>` : ""}</span>`);
    }
  }
  $("cu-effect").innerHTML = items.length ? items.join("") : `<span class="muted">No lock decisions or games tonight to move.</span>`;
}

/** "You are: [A] [B]" — which side of this matchup the calls, swaps and "your" lineup belong to. */
function renderSides(m, mine) {
  const raw = ctx.raw, m0 = me();
  const cur = myRosterId(raw.rosters);
  const pairId = raw.matchups.find((x) => x.roster_id === cur)?.matchup_id;
  const pair = pairId ? raw.matchups.filter((x) => x.matchup_id === pairId) : [];
  const isMe = (rid) => { const r = raw.rosters.find((x) => x.roster_id === rid); return !!(m0 && r && (r.owner_id === m0.user_id || (r.co_owners || []).includes(m0.user_id))); };
  const hasMine = pair.some((x) => isMe(x.roster_id));
  if (pair.length < 2 && mine) return;
  const btns = pair.map((x) => `<button role="radio" aria-checked="${x.roster_id === cur}" data-side="${x.roster_id}">${esc(teamName(raw, x.roster_id))}${isMe(x.roster_id) ? ' <span class="tag">your team</span>' : ""}</button>`).join("");
  const mineInLeague = raw.rosters.some((r) => isMe(r.roster_id));
  $("board").insertAdjacentHTML("afterbegin", `<div class="sides"><span class="lbl">You are</span>
    <div class="seg" role="radiogroup" aria-label="Which side is you">${btns}</div>
    ${!hasMine && m0 ? `<button class="linkish" id="back-mine">${mineInLeague ? "Back to my matchup" : "My league"}</button>` : ""}</div>`);
  $("board").querySelectorAll("[data-side]").forEach((b) => (b.onclick = () => { if (Number(b.dataset.side) !== cur) setSide(Number(b.dataset.side)); }));
  if ($("back-mine")) $("back-mine").onclick = goMine;
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

function renderBoard(m) {
  const range = m.weekDates.length ? `${md(m.weekDates[0])} – ${md(m.weekDates.at(-1))}` : "";
  if (!m.opp) {
    $("board").innerHTML = `<div class="board-top"><span>${esc(ctx.raw.league.name)} · Week ${m.week} · ${range}</span></div>
      <div class="team"><div class="who">${esc(m.me.name)}</div><div class="pts num">${f1(m.me.points)}</div><div class="proj num">Projected finish ${f1(m.me.proj)}</div></div>
      <p class="muted">No opponent this week, so calls maximize your points.</p>`;
    return;
  }
  const w = m.win;
  $("board").innerHTML = `
    <div class="board-top"><span>${esc(ctx.raw.league.name)} · Week ${m.week} · ${range}</span><span>${m.mode === "win" ? "Calls play to win this matchup" : "Calls maximize points"} · Proj = ${m.projBasis === "smart" ? "expected final" : "next-game projections"}${m.oppSwapsModeled ? " · opponent swaps modeled" : ""}${m.cushion > 0 ? ` · ${f1(m.cushion)}-pt safety cushion` : ""}</span></div>
    <div class="teams">
      <div class="team"><div class="who">${esc(m.me.name)}</div><div class="pts num">${f1(m.me.points)}</div><div class="proj num">Banked ${f1(m.me.banked)} · Proj ${f1(m.me.proj)}</div></div>
      <div class="vs">VS</div>
      <div class="team r"><div class="who">${esc(m.opp.name)}</div><div class="pts num">${f1(m.opp.points)}</div><div class="proj num">Banked ${f1(m.opp.banked)} · Proj ${f1(m.opp.proj)}</div></div>
    </div>
    <div class="winbar" aria-label="Win probability">
      <div class="lbl"><span><b class="num">${pct(w)}</b> to win</span><span class="muted num">${pct(1 - w)}</span></div>
      <div class="track"><div class="me" style="width:${(w * 100).toFixed(1)}%"></div></div>
    </div>`;
}

function whyLines(games) {
  const out = [];
  if (!games?.length) return out;
  const next = games[0];
  out.push(`Next: ${dow(next.date)} ${next.home ? "vs" : "@"} ${esc(next.opp)} · proj ${f1(next.mu)}`);
  games.forEach((g, i) => {
    if (!g.why.length && g.p < 0.1) return;
    const prev = games[i - 1];
    const linked = g.pIfPrevPlayed !== undefined && prev
      ? ` (${pct(g.pIfPrevPlayed)} if he plays ${dow(prev.date)}, ${pct(g.pIfPrevSat)} if he sits it)` : "";
    out.push(`<span class="${g.p >= 0.2 || (g.pIfPrevPlayed || 0) >= 0.3 ? "warn" : ""}">${dow(g.date)}: ${pct(g.p)} sit risk${linked}${g.why.length ? ` · ${esc(g.why.join(", "))}` : ""}</span>`);
  });
  return out;
}

function renderDecide(m) {
  const pend = m.me.slots.filter((s) => s.kind === "pending");
  // Sleeper never says what you locked, so earlier games are guessed. Your side: ask.
  const guesses = viewingMine() ? m.me.slots.filter((s) => s.kind === "assumed-locked" && s.guess) : [];
  const el = $("decide");
  if (!pend.length && !guesses.length) { el.innerHTML = ""; return; }
  const ask = guesses.length ? `<h2>Did you lock these?</h2>
    <p class="muted" style="margin:0 0 8px;font-size:13.5px">Sleeper doesn't share locks until the week is final. These scores beat what the rest of his week was worth, so the app assumes you locked them.</p>
    <div class="cards">${guesses.map((s) => `<div class="card ask">
      <div><b>${esc(s.p.name)}</b><div class="muted" style="font-size:13px">${esc(s.label)} · ${esc(s.p.team || "")}</div></div>
      <div class="num">${dow(s.lockedGame.date)} ${f1(s.lockedGame.fp)}${s.pctScore != null ? ` (${ord(s.pctScore)} pct)` : ""} · rest of week was worth ${f1(s.guessBar)}</div>
      <div class="ask-btns"><button class="btn" data-yes="${esc(s.pid)}" data-date="${esc(s.lockedGame.date)}">Yes, locked</button>
        <button class="btn ghost" data-no="${esc(s.pid)}" data-date="${esc(s.lockedGame.date)}">No</button></div></div>`).join("")}</div>` : "";
  el.innerHTML = `${ask}${pend.length ? `<h2>Decide before his next game</h2>` : ""}<div class="cards">${pend.map((s) => {
    const c = s.call, lock = c.verdict === "LOCK";
    const g = s.lastDone;
    const viaSwap = !lock && s.contBy ? `<div class="flip">Pass and swap in <b>${esc(s.contBy.p.name)}</b> (${s.contBy.from === "bench" ? "bench" : `from ${esc(s.contBy.from)}`}, ${s.contBy.games.map((x) => dow(x.date)).join("/")}). The bar counts that swap.</div>` : "";
    const cushioned = c.cushion > 0 && (c.winIfLock >= c.winIfPass ? "LOCK" : "PASS") !== c.verdict;
    const flip = cushioned ? `<div class="flip">Plain odds favour ${lock ? "passing" : "locking"}, but your lead is thinner than the ${f1(c.cushion)}-point safety cushion, so the call ${lock ? "locks" : "chases upside"}: win by ${f1(c.cushion)}+ ${pct(c.safeIfLock)} if you lock vs ${pct(c.safeIfPass)} if you pass.</div>`
      : c.matchupFlip ? `<div class="flip">${lock ? "Below his bar, but locking protects your lead." : "Above his bar, but you need upside to come back."}</div>` : "";
    const winRow = c.winIfLock !== undefined ? `
      <div class="duel">
        <div class="stat"><small>Win if you lock</small><b class="num">${pct(c.winIfLock)}</b></div>
        <div class="stat"><small>Win if you pass</small><b class="num">${pct(c.winIfPass)}</b></div>
      </div>` : "";
    return `<article class="card ${lock ? "lock" : "pass"}">
      <div class="card-head">
        <div><div class="pname">${esc(s.p.name)}</div><div class="pmeta">${esc(s.label)} · ${esc(s.p.team || "")}${s.p.injury ? ` · <span class="warn">${esc(s.p.injury)}</span>` : ""}</div></div>
        <span class="pill ${lock ? "lock" : "pass"}">${c.verdict}</span>
      </div>
      <div class="duel">
        <div class="stat"><small>${dow(g.date)} ${g.home ? "vs" : "@"} ${esc(g.opp)}</small><b class="num">${f1(s.score)}</b>${s.pctScore != null ? `<span class="pct">${pctLabel(s.pctScore, s.p)}</span>` : ""}</div>
        <div class="stat"><small>Bar · ${s.games.length} left</small><b class="num">${f1(c.bar)}</b>${s.pctBar != null ? `<span class="pct">≈ his ${ord(s.pctBar)} pct</span>` : ""}</div>
      </div>
      ${winRow}${flip}${viaSwap}
      <div class="why">${whyLines(s.games).map((x) => `<div>${x}</div>`).join("")}
        <div>Passing: ${pct(c.pBelow)} chance he ends the week lower than ${f1(s.score)}.</div></div>
      <div class="marks">
        <label class="toggle"><input type="checkbox" data-mark="${esc(s.pid)}" data-date="${esc(g.date)}"> I already locked this game</label>
        <label class="toggle"><input type="checkbox" data-mark="${esc(s.pid)}" data-date="after:${esc(g.date)}"> He wasn't in my starting lineup for it</label>
      </div>
    </article>`;
  }).join("")}</div>`;
  el.querySelectorAll("[data-mark]").forEach((cb) => cb.addEventListener("change", () => setMark(cb.dataset.mark, cb.checked ? cb.dataset.date : null)));
  el.querySelectorAll("[data-yes]").forEach((b) => (b.onclick = () => setMark(b.dataset.yes, b.dataset.date)));
  el.querySelectorAll("[data-no]").forEach((b) => (b.onclick = () => setMark(b.dataset.no, `pass:${b.dataset.date}`)));
}

const tipLabel = (g) => (g.tip ? ` ${clockET(g.tip.slice(11))}` : "");
const clockET = (hhmm) => { const [h, mi] = hhmm.split(":").map(Number); return `${((h + 11) % 12) + 1}${mi ? `:${String(mi).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"} ET`; };
/** One line per day: "Sun: Markkanen 3:30pm ET (lock ≥ 47.2) → Reed 7pm ET (counts)". Days with a
 *  backup come first in bold; days where only the main player plays are summarized. */
function planLine(s) {
  const days = [];
  s.plan.forEach((x, k) => { const last = days.at(-1); const step = { ...x, k }; if (last && last.date === x.date) last.steps.push(step); else days.push({ date: x.date, steps: [step] }); });
  const stepText = (x) => `<b>${esc(shortName(x.name))}</b>${tipLabel(x)}${x.bar != null ? ` (lock ≥ ${f1(x.bar)})` : x.k === s.plan.length - 1 ? " (counts if still open)" : ""}`;
  return days.map((d) => `<div class="${d.steps.length > 1 ? "lsw" : "muted"}">${dow(d.date)}: ${d.steps.map(stepText).join('<span class="arrow"> → </span>')}</div>`).join("");
}

function renderSwaps(m) {
  const el = $("swaps");
  const swapSlots = new Set((m.swaps || []).map((w) => w.slot));
  const plans = m.me.slots.filter((s) => s.planPlayers?.length >= 2 && !swapSlots.has(s));
  if (!m.swaps?.length && !plans.length) { el.innerHTML = ""; return; }
  const planCards = plans.map((s) => `<article class="card swap">
      <div class="card-head"><div><div class="pname">${esc(s.label)}: late-swap plan</div>
        <div class="pmeta">${esc(s.p?.name || "Empty slot")} stays in. On the days in bold, if his game falls short of the bar, swap in the next player before his later tip-off.</div></div>
        <span class="pill soft num">${f1(s.value.mean)}</span></div>
      <div class="plan">${planLine(s)}</div></article>`).join("");
  el.innerHTML = `<h2>Swaps &amp; late-swap plans</h2>
    <p class="muted" style="margin:0;font-size:13.5px">The calls and projections above assume you make these moves in Sleeper before each player's game. Each step's "lock ≥" is the score worth keeping; below it, move to the next player.</p>
    <div class="cards">${planCards}${(m.swaps || []).map((w) => {
      const g = w.into.games[0];
      const outLine = w.out ? `for ${esc(w.out.name)}${w.slot.kind === "final" ? ` (his week is over: ${f1(w.slot.lastDone?.fp ?? 0)})` : w.slot.kind === "none" ? " (no games left)" : ""}` : "into an empty slot";
      return `<article class="card swap">
        <div class="card-head">
          <div><div class="pname">${esc(w.into.p.name)} → ${esc(w.slot.label)}</div>
            <div class="pmeta">${w.into.from === "bench" ? "From bench" : `Move from ${esc(w.into.from)}`} · ${outLine}</div></div>
          <span class="pill soft">BY ${dow(w.deadline).toUpperCase()}</span>
        </div>
        <div class="duel">
          <div class="stat"><small>Slot worth with him</small><b class="num">${f1(w.into.value)}</b></div>
          <div class="stat"><small>Gain</small><b class="num">+${f1(w.gain)}</b></div>
        </div>
        ${w.keepFirst?.length && !(w.slot.planPlayers?.length >= 2) ? `<div class="flip">No rush: keep ${esc(w.out.name)} in for ${w.keepFirst.map((x) => dow(x.date)).join("/")}. Lock him if he scores ${f1(w.slot.tonight?.bar ?? w.into.value)}+; otherwise swap ${esc(w.into.p.name)} in before ${dow(w.deadline)}.</div>` : ""}
        ${w.slot.planPlayers?.length >= 2 ? `<div class="plan">${planLine(w.slot)}</div>` : ""}
        <div class="why"><div>${w.into.games.map((x) => `${dow(x.date)} ${x.home ? "vs" : "@"} ${esc(x.opp)} · proj ${f1(x.mu)}`).join(" · ")}</div>
          ${whyLines(w.into.games).slice(1).map((x) => `<div>${x}</div>`).join("")}</div>
      </article>`;
    }).join("")}</div>`;
}

function renderTonight(m) {
  const el = $("tonight");
  // A pending slot whose last game is tonight is already covered by its decision card.
  const list = m.me.slots.filter((s) => s.tonight && !(s.kind === "pending" && s.tonight.final));
  if (!list.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<h2>Tonight · ${dow(m.today)} ${md(m.today)}</h2><div class="cards">${list.map((s) => {
    const t = s.tonight;
    const live = s.kind === "live";
    const head = `<div class="card-head">
        <div><div class="pname">${esc(s.p.name)}</div><div class="pmeta">${esc(s.label)} · ${esc(s.p.team || "")} ${live ? "·" : (s.games?.[0]?.home === false ? "@" : "vs")} ${live ? `<span class="state live">live</span>` : esc(t.opp)}${s.p.injury ? ` · <span class="warn">${esc(s.p.injury)}</span>` : ""}</div>
        ${s.kind === "pending" ? `<div class="pmeta">If you pass on ${dow(s.lastDone.date)}'s ${f1(s.score)}</div>` : ""}
        ${!t.final && t.pctBar != null ? `<div class="pmeta">Bar ≈ his ${ord(t.pctBar)}-percentile game</div>` : ""}</div>
        ${t.final ? '<span class="pill soft">FINAL GAME</span>' : `<span class="pill soft num">LOCK ≥ ${f1(t.bar)}</span>`}
      </div>`;
    if (t.final) {
      return `<article class="card">${head}<div class="why"><div>His last game this week: it counts automatically if the slot is still open.</div>
        ${s.p.injury ? `<div class="warn">Listed ${esc(s.p.injury)}. If he sits, an open slot scores 0. Swap in a healthy starter.</div>` : ""}</div></article>`;
    }
    const liveLine = live ? `<div class="stat"><small>Live now</small><b class="num">${f1(s.liveFp)}</b></div>` : `<div class="stat"><small>Projected tonight</small><b class="num">${f1(s.games?.[0]?.mu)}</b></div>`;
    const benchNote = t.afterBy ? `<div class="flip">If you pass, swap <b>${esc(t.afterBy.p.name)}</b> in (${t.afterBy.from === "bench" ? "bench" : `from ${esc(t.afterBy.from)}`}) for ${t.after.map((x) => dow(x.date)).join("/")}.</div>` : "";
    const evNote = Math.abs(t.bar - t.evBar) >= 0.5 ? `<div class="flip">Points-only bar is ${f1(t.evBar)}; your matchup moves it to ${f1(t.bar)}.</div>` : "";
    return `<article class="card">${head}
      <div class="duel">${liveLine}<div class="stat"><small>Then ${t.after.length} more game${t.after.length > 1 ? "s" : ""}</small><b class="num">${f1(t.after.reduce((a, g) => a + g.mu, 0) / t.after.length)}</b></div></div>
      ${evNote}${benchNote}
      <div class="whatif"><label for="wi-${s.i}">If he finishes with</label><input id="wi-${s.i}" data-wi="${s.i}" type="number" inputmode="decimal" step="0.5" placeholder="${f1(t.bar)}"> <span id="wo-${s.i}" class="muted">→ type a score</span></div>
    </article>`;
  }).join("")}</div>`;
  el.querySelectorAll("[data-wi]").forEach((inp) => inp.addEventListener("input", () => {
    const s = model.me.slots[+inp.dataset.wi];
    const out = $(`wo-${s.i}`);
    const x = parseFloat(inp.value);
    if (Number.isNaN(x)) { out.textContent = "→ type a score"; out.className = "muted"; return; }
    const c = model.whatIf(s, x);
    const q = s.p.pct(x);
    out.innerHTML = `→ <span class="pill ${c.verdict === "LOCK" ? "lock" : "pass"}">${c.verdict}</span>${c.winIfLock !== undefined ? ` <span class="muted num">win ${pct(c.winIfLock)} vs ${pct(c.winIfPass)}</span>` : ""}${q != null ? ` <span class="muted">· ${ord(q)} pct game</span>` : ""}`;
    out.className = "";
  }));
}

const STATE_LABEL = { locked: "Locked", final: "Final", pending: "Your call", live: "Live", open: "Open", none: "No games", empty: "Empty", "assumed-locked": "Guess: locked", "assumed-open": "Guess: open" };

function availLine(p) {
  const a = p.avail;
  const bits = [];
  if (a) {
    bits.push(`rests ${pct(a.q)} of B2Bs${a.history.n1 + a.history.n2 >= 2 ? ` (night ${a.s >= 0.5 ? "2" : "1"} ${pct(a.s >= 0.5 ? a.s : 1 - a.s)})` : ""}`);
    bits.push(`sits ${pct(a.normal)} of other games`);
    if (a.durability >= 0.2) bits.push(`missed ${pct(a.durability)} of last ${Math.min(82, a.history.rows)}`);
    if (a.ramp > 0.05) bits.push(`back ${a.gamesBack} g from a ${a.absence}-game absence`);
  }
  return `<div class="avail"><span class="pmeta">${bits.length ? esc(bits.join(" · ")) : "no availability history"}</span>
    <button type="button" class="flag" data-b2b="${esc(p.pid)}" aria-pressed="${p.flagged}">${p.flagged ? "✓ Sits B2Bs" : "Sits B2Bs?"}</button></div>`;
}

function lockPicker(s) {
  const played = (s.completed || []).filter((g) => g.played);
  if (!s.completed?.length) return "";
  const autoText = s.kind === "assumed-locked" ? `guess: locked ${dow(s.lockedGame?.date || s.lastDone?.date)}` : s.kind === "assumed-open" ? "guess: open"
    : s.kind === "final" ? "last game counts" : s.kind === "pending" ? "your call" : "not locked";
  // Two uses: recording a lock made at the time (any game, earlier ones included), or saying it isn't locked.
  // An earlier game you didn't lock is dead by rule, so "not locked" is only ever about his latest game.
  const latest = s.completed.at(-1);
  let cur = s.mark || "auto";
  if (cur.startsWith?.("after:") && cur !== `after:${latest.date}`) cur = "open";   // older bench marks on an earlier game
  const opt = (v, label) => `<option value="${esc(v)}"${cur === v ? " selected" : ""}>${esc(label)}</option>`;
  const games = played.map((g) => opt(g.date, `${dow(g.date)} · ${f1(g.fp)}${s.p.pct(g.fp) != null ? ` (${ord(s.p.pct(g.fp))} pct)` : ""}${g !== latest ? " · locked back then" : ""}`));
  const open = latest.played
    ? [opt("open", `Nothing locked · ${dow(latest.date)} still lockable`), opt(`after:${latest.date}`, `${dow(latest.date)} was on the bench: can't lock`)]
    : [opt("open", "Nothing locked")];
  if (cur.startsWith?.("pass:")) open.unshift(opt(cur, `Not locked through ${dow(cur.slice(5))}`));
  return `<label class="picker"><span class="sr">Lock for ${esc(s.p.name)}</span>
    <select data-pick="${esc(s.pid)}">${opt("auto", `Auto: ${autoText}`)}<optgroup label="Locked">${games.join("")}</optgroup><optgroup label="Not locked">${open.join("")}</optgroup></select></label>`;
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

function renderLineup(m) {
  const side = view === "me" ? m.me : m.opp;
  $("tab-me").setAttribute("aria-selected", view === "me"); $("tab-opp").setAttribute("aria-selected", view === "opp");
  $("tab-opp").hidden = !m.opp;
  if (!side) { $("lineup").innerHTML = ""; return; }
  const smart = m.projBasis === "smart";
  const rows = side.slots.map((s) => {
    if (s.empty) return `<div class="row"><div class="slot">${esc(s.label)}</div><div class="muted">Empty slot</div><div class="val"><b>0.0</b></div></div>`;
    const kind = s.kind.startsWith("assumed") ? (s.kind === "assumed-locked" ? "locked" : "open") : s.kind;
    const counted = ["locked", "final", "assumed-locked", "none"].includes(s.kind);
    const sd = Math.sqrt(s.value.variance);
    const sub = counted ? "&nbsp;" : smart ? (s.nextProj != null ? `next ${f1(s.nextProj)}` : "&nbsp;") : `exp ${f1(s.value.mean)}${sd > 0.5 ? ` ± ${f1(sd)}` : ""}`;
    return `<div class="row">
      <div class="slot">${esc(s.label)}</div>
      <div style="min-width:0">
        <div class="pname" style="font-size:16.5px">${esc(s.p.name)} <span class="pmeta">${esc(s.p.team || "FA")}${s.p.injury ? ` · <span class="warn">${esc(s.p.injury)}</span>` : ""}</span></div>
        <div class="games">${gameChips(s)}</div>
        ${availLine(s.p)}
        ${lockPicker(s)}
      </div>
      <div class="val"><span class="state ${kind}">${s.swapIn ? `→ ${esc(shortName(s.swapIn.p.name))}` : STATE_LABEL[s.kind]}${s.manual ? " (you)" : ""}</span><b class="num">${f1(s.shownProj)}</b><small class="num">${sub}</small></div>
    </div>`;
  });
  const bench = (side.bench || []).map((b) => `<div class="row bench">
      <div class="slot">BN</div>
      <div style="min-width:0">
        <div class="pname" style="font-size:15.5px">${esc(b.p.name)} <span class="pmeta">${esc(b.p.team || "FA")}${b.p.injury ? ` · <span class="warn">${esc(b.p.injury)}</span>` : ""}</span></div>
        <div class="games">${gameChips({ p: b.p, kind: "bench" })}</div>
      </div>
      <div class="val"><span class="state open">Bench</span><b class="num">${b.nextProj != null ? f1(b.nextProj) : "–"}</b><small>next game</small></div>
    </div>`);
  $("lineup").innerHTML = rows.join("") + (bench.length ? `<div class="row benchhead"><div></div><div class="pmeta">Bench: not counted, shown for swaps</div><div></div></div>${bench.join("")}` : "");
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
