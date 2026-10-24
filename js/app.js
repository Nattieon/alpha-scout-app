import * as S from "./sleeper.js?v=__V__";
import { buildModel, DEFAULTS, dow, md, normalizeMarks, todayET } from "./model.js?v=__V__";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const f1 = (x) => (x === null || x === undefined || Number.isNaN(x) ? "–" : (Math.round(x * 10) / 10).toFixed(1));
const pct = (x) => `${Math.round(x * 100)}%`;
const ord = (q) => { const n = Math.min(99, Math.max(1, Math.round(q * 100))); const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const pctLabel = (q, p) => (q === null || q === undefined ? "" : `${ord(q)} pct of his last ${p.nHistory}`);

// ------------------------------------------------------------------ storage (best effort)
const store = {
  get(k, d) { try { const v = localStorage.getItem("as." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("as." + k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem("as." + k); } catch { /* ignore */ } },
};

let ctx = null;        // {user, leagueId, raw}
let model = null;
let view = "me";
let timer = null;

// ------------------------------------------------------------------ boot
async function boot() {
  const q = new URLSearchParams(location.search);
  const u = q.get("u") || store.get("username", "");
  const l = q.get("l") || store.get("league", "");
  if (u && l) return openLeague(u, l);
  showOnboard(u);
}

function showOnboard(username = "") {
  clearInterval(timer);
  $("dash").hidden = true; $("onboard").hidden = false; $("who").hidden = true;
  $("username").value = username;
  if (username) findLeagues(username);
}

$("find").addEventListener("submit", (e) => { e.preventDefault(); findLeagues($("username").value); });
$("home").addEventListener("click", (e) => { e.preventDefault(); store.del("league"); history.replaceState(null, "", location.pathname); showOnboard(store.get("username", "")); });
$("who").addEventListener("click", () => $("home").click());

async function findLeagues(username) {
  const msg = $("find-msg"), list = $("leagues");
  msg.className = "muted"; msg.textContent = "Looking you up on Sleeper…"; list.innerHTML = "";
  try {
    const [st, user] = await Promise.all([S.state(), S.findUser(username)]);
    const leagues = await S.nbaLeagues(user.user_id, st.league_season);
    store.set("username", user.username || username.trim());
    if (!leagues.length) { msg.textContent = `No ${st.league_season} NBA leagues on this account.`; return; }
    msg.textContent = `${leagues.length} NBA league${leagues.length > 1 ? "s" : ""} for ${st.league_season}. Pick one:`;
    list.innerHTML = leagues.map((l) => `
      <button class="league" data-id="${esc(l.league_id)}">
        <span><b>${esc(l.name)}</b><br><span class="muted">${l.total_rosters} teams · ${esc(l.status.replace("_", " "))}</span></span>
        <span class="chip">Open</span>
      </button>`).join("");
    list.querySelectorAll(".league").forEach((b) => b.addEventListener("click", () => openLeague(user.username || username, b.dataset.id)));
    if (leagues.length === 1) openLeague(user.username || username, leagues[0].league_id);
  } catch (err) {
    msg.className = "err"; msg.textContent = err.message;
  }
}

// ------------------------------------------------------------------ league
async function openLeague(username, leagueId) {
  $("onboard").hidden = true; $("dash").hidden = false;
  $("board").innerHTML = '<div class="skeleton"></div>';
  ["decide", "tonight"].forEach((id) => ($(id).innerHTML = ""));
  $("lineup").innerHTML = "";
  try {
    const user = await S.findUser(username);
    store.set("username", user.username || username); store.set("league", leagueId);
    history.replaceState(null, "", `?u=${encodeURIComponent(user.username || username)}&l=${leagueId}`);
    ctx = { user, leagueId };
    $("who").hidden = false; $("who").textContent = `${user.display_name} · switch`;
    await load(false);
    clearInterval(timer);
    timer = setInterval(() => { if (document.visibilityState === "visible") load(true); }, 120000);
  } catch (err) {
    $("board").innerHTML = `<p class="err">${esc(err.message)}</p><button class="btn ghost" onclick="location.reload()">Try again</button>`;
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
  const raw = { league, rosters, users, matchups, schedule, week, stats: statsW.flat(), projections: projW.flat(), today: todayET() };
  // Names for rostered players who appear in no stats rows (long injuries).
  const known = new Set([...raw.stats, ...raw.projections].map((r) => r.player_id));
  const needed = matchups.flatMap((m) => m.starters || []).filter((p) => p && p !== "0" && !known.has(p));
  if (needed.length) raw.players = await S.allPlayers();
  // Each starter's own game log (last season cached on this device + this season so far).
  const starters = [...new Set(matchups.filter((m) => m.matchup_id && (m.roster_id === myRosterId(rosters) || m.matchup_id === myMatchupId(rosters, matchups))).flatMap((m) => m.starters || []).filter((p) => p && p !== "0"))];
  raw.logs = await loadLogs(starters, season, fresh);
  ctx.raw = raw;
  rebuild();
  $("updated").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · data from Sleeper`;
}

function myRosterId(rosters) {
  const r = rosters.find((x) => x.owner_id === ctx.user.user_id || (x.co_owners || []).includes(ctx.user.user_id));
  return r && r.roster_id;
}
function myMatchupId(rosters, matchups) {
  const rid = myRosterId(rosters);
  const m = matchups.find((x) => x.roster_id === rid);
  return m && m.matchup_id;
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

function cfg() {
  const c = { ...DEFAULTS, ...store.get("cfg", {}) };
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
  model = buildModel(ctx.raw, ctx.user.user_id, cfg(), getMarks());
  render();
}

// ------------------------------------------------------------------ render
function render() {
  const m = model;
  if (m.missingRoster) {
    $("board").innerHTML = `<p class="muted">You don't own a team in <b>${esc(ctx.raw.league.name)}</b>.</p>`;
    return;
  }
  renderBoard(m); renderDecide(m); renderTonight(m); renderLineup(m);
  const c = cfg();
  $("cfg-mode").value = c.mode; $("cfg-proj").value = c.projBasis; $("cfg-base").value = Math.round(c.baseDnp * 100); $("cfg-b2b").value = Math.round(c.pairRest * 100);
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
    <div class="board-top"><span>${esc(ctx.raw.league.name)} · Week ${m.week} · ${range}</span><span>${m.mode === "win" ? "Calls play to win this matchup" : "Calls maximize points"} · Proj = ${m.projBasis === "smart" ? "expected final" : "next-game projections"}</span></div>
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
  const el = $("decide");
  if (!pend.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<h2>Decide before his next game</h2><div class="cards">${pend.map((s) => {
    const c = s.call, lock = c.verdict === "LOCK";
    const g = s.lastDone;
    const flip = c.matchupFlip ? `<div class="flip">${lock ? "Below his bar, but locking protects your lead." : "Above his bar, but you need upside to come back."}</div>` : "";
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
      ${winRow}${flip}
      <div class="why">${whyLines(s.games).map((x) => `<div>${x}</div>`).join("")}
        <div>Passing: ${pct(c.pBelow)} chance he ends the week lower than ${f1(s.score)}.</div></div>
      <label class="toggle"><input type="checkbox" data-mark="${esc(s.pid)}" data-date="${esc(g.date)}"> I already locked this game</label>
    </article>`;
  }).join("")}</div>`;
  el.querySelectorAll("[data-mark]").forEach((cb) => cb.addEventListener("change", () => setMark(cb.dataset.mark, cb.checked ? cb.dataset.date : null)));
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
    const evNote = Math.abs(t.bar - t.evBar) >= 0.5 ? `<div class="flip">Points-only bar is ${f1(t.evBar)}; your matchup moves it to ${f1(t.bar)}.</div>` : "";
    return `<article class="card">${head}
      <div class="duel">${liveLine}<div class="stat"><small>Then ${t.after.length} more game${t.after.length > 1 ? "s" : ""}</small><b class="num">${f1(t.after.reduce((a, g) => a + g.mu, 0) / t.after.length)}</b></div></div>
      ${evNote}
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
  if (!s.lockable?.length) return "";
  const autoText = s.kind === "locked" && s.auto ? `locked ${dow(s.lockedGame.date)}`
    : s.kind === "assumed-locked" ? "guess: locked" : s.kind === "assumed-open" ? "guess: open"
    : s.kind === "final" ? "last game counts" : s.kind === "pending" ? "your call" : "not locked";
  const cur = s.mark || "auto";
  const opt = (v, label) => `<option value="${esc(v)}"${cur === v ? " selected" : ""}>${esc(label)}</option>`;
  const games = s.lockable.map((g) => opt(g.date, `Locked ${dow(g.date)} · ${f1(g.fp)}${s.p.pct(g.fp) != null ? ` (${ord(s.p.pct(g.fp))} pct)` : ""}`));
  return `<label class="picker"><span class="sr">Lock for ${esc(s.p.name)}</span>
    <select data-pick="${esc(s.pid)}">${opt("auto", `Auto: ${autoText}`)}${opt("open", "Not locked")}${games.join("")}</select></label>`;
}

function gameChips(s) {
  if (!s.p) return "";
  const countsDate = s.lockedGame?.date || (s.kind === "final" ? s.lastDone?.date : null);
  return s.p.games.map((g) => {
    if (g.status === "complete") {
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
      <div class="val"><span class="state ${kind}">${STATE_LABEL[s.kind]}${s.manual ? " (you)" : ""}</span><b class="num">${f1(s.shownProj)}</b><small class="num">${sub}</small></div>
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
  const c = { ...DEFAULTS, ...store.get("cfg", {}) };
  c.mode = $("cfg-mode").value;
  c.projBasis = $("cfg-proj").value;
  c.baseDnp = Math.min(Math.max((parseFloat($("cfg-base").value) || 0) / 100, 0), 0.3);
  c.pairRest = Math.min(Math.max((parseFloat($("cfg-b2b").value) || 0) / 100, 0), 0.9);
  delete c.b2bDnp; delete c.b2bFlags;
  store.set("cfg", c); rebuild();
};
["cfg-mode", "cfg-proj", "cfg-base", "cfg-b2b"].forEach((id) => $(id).addEventListener("change", saveCfg));

boot();
