// Read-only Sleeper data layer. Every endpoint here is public and CORS-enabled.
const V1 = "https://api.sleeper.app/v1";
const API = "https://api.sleeper.com";

const memo = new Map();
async function getJSON(url, { fresh = false } = {}) {
  if (!fresh && memo.has(url)) return memo.get(url);
  const p = fetch(url, { cache: fresh ? "no-store" : "default" }).then(async (r) => {
    if (!r.ok) throw new Error(`Sleeper returned ${r.status} for ${url.replace(/^https:\/\/[^/]+/, "")}`);
    return r.json();
  });
  memo.set(url, p);
  p.catch(() => memo.delete(url));
  return p;
}

export const state = () => getJSON(`${V1}/state/nba`);

export async function findUser(username) {
  const u = await getJSON(`${V1}/user/${encodeURIComponent(username.trim())}`);
  if (!u || !u.user_id) throw new Error(`No Sleeper account named “${username}”. Check the spelling.`);
  return u;
}

export async function nbaLeagues(userId, season) {
  return (await getJSON(`${V1}/user/${userId}/leagues/nba/${season}`)) || [];
}

export const league = (id) => getJSON(`${V1}/league/${id}`);
export const rosters = (id, fresh) => getJSON(`${V1}/league/${id}/rosters`, { fresh });
export const users = (id) => getJSON(`${V1}/league/${id}/users`);
export const matchups = (id, week, fresh) => getJSON(`${V1}/league/${id}/matchups/${week}`, { fresh });
export const schedule = (season, fresh) => getJSON(`${API}/schedule/nba/regular/${season}`, { fresh });
export const weekStats = (season, week, fresh) => getJSON(`${API}/stats/nba/${season}/${week}?season_type=regular`, { fresh });
export const weekProjections = (season, week, fresh) => getJSON(`${API}/projections/nba/${season}/${week}?season_type=regular`, { fresh });

let playersDump = null;
/** The full player list (~5 MB). Only loaded when a rostered player appears in no stats rows. */
export function allPlayers() {
  playersDump ||= getJSON(`${V1}/players/nba`);
  return playersDump;
}

export function clearFreshCaches() {
  for (const k of [...memo.keys()]) if (!k.includes("/players/nba") && !k.includes("/user/")) memo.delete(k);
}
