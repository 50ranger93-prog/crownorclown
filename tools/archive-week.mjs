#!/usr/bin/env node
/**
 * Crown or Clown — weekly gameday snapshot.
 *
 * The Gameday section reads live from ESPN, which means that once a week rolls over the
 * whole thing is gone. The closing line, who was actually ruled out, who produced, and
 * whether the number the market put up was anywhere near what happened — all of it is only
 * interesting later, when you are trying to work out why a lineup went the way it did. So
 * every week gets written down into weeks/<season>/wkNN.json and the site reads that back.
 *
 * Two files come out of a run:
 *
 *   weeks/<season>/wkNN.json   the week itself — one entry per game, closing numbers, the
 *                              out list with team and position, the top five by DraftKings
 *                              scoring, and the call-versus-result comparison.
 *   weeks/<season>/depth.json  team → position → depth order, rebuilt each run. The live
 *                              page uses this to name the next man up without making
 *                              sixty-four extra requests in the browser.
 *
 * weeks/<season>/index.json lists what has been archived so the page can build a picker.
 *
 *   ⚠ TIMING: run AFTER the week is settled (Tuesday). Snapshotting mid-week captures a
 *   live in-play line as the "closing" number, which is a different bet and worth nothing.
 *
 * Usage:
 *   node tools/archive-week.mjs --week 1
 *   node tools/archive-week.mjs --week auto        # the most-recently-settled week
 *   node tools/archive-week.mjs --week auto --depth-only
 *   node tools/archive-week.mjs --week 1 --dry     # print, write nothing
 *
 * No dependencies. Node 18+ (built-in fetch).
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SEASON = Number(env("ARCHIVE_SEASON") || arg("season") || 2026);
const WEEK_ARG = arg("week") || "auto";
const DRY = !!arg("dry");
const DEPTH_ONLY = !!arg("depth-only");
// fileURLToPath, not URL.pathname — the latter leaves the path percent-encoded, so a repo
// living under a directory with a space in it writes the archive to "New%20folder".
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "weeks", String(SEASON));

function arg(n) { const i = process.argv.indexOf("--" + n); if (i === -1) return null; const v = process.argv[i + 1]; return v && !v.startsWith("--") ? v : true; }
function env(n) { return process.env[n]; }

const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";

/* ---- weather ---------------------------------------------------------------------------
   ESPN's weather is thin and temporary: no wind at all, which is the number that actually
   decides whether a passing game shows up, and it is deleted outright the moment a game goes
   final. So the weather comes from Open-Meteo instead, which has two halves —
   a forecast for a game still to come, and an archive of what the conditions ACTUALLY were
   for one already played. That second half is why week 1 can be filled back in.

   No key and no account; the only thing it needs is a latitude and longitude, and ESPN gives
   a city rather than coordinates, so venues are geocoded once and remembered in venues.json.
--------------------------------------------------------------------------------------- */
const GEO  = "https://geocoding-api.open-meteo.com/v1/search";
const WX_F = "https://api.open-meteo.com/v1/forecast";
const WX_A = "https://archive-api.open-meteo.com/v1/archive";

// WMO codes, said the way a broadcast would say them.
const WMO = {
  0:"Clear", 1:"Mainly clear", 2:"Partly cloudy", 3:"Overcast",
  45:"Fog", 48:"Freezing fog",
  51:"Light drizzle", 53:"Drizzle", 55:"Heavy drizzle",
  56:"Freezing drizzle", 57:"Freezing drizzle",
  61:"Light rain", 63:"Rain", 65:"Heavy rain",
  66:"Freezing rain", 67:"Freezing rain",
  71:"Light snow", 73:"Snow", 75:"Heavy snow", 77:"Snow grains",
  80:"Rain showers", 81:"Rain showers", 82:"Heavy rain showers",
  85:"Snow showers", 86:"Heavy snow showers",
  95:"Thunderstorms", 96:"Thunderstorms and hail", 99:"Thunderstorms and hail",
};

let VENUES = {};
async function loadVenues() {
  const f = path.join(OUT_DIR, "venues.json");
  if (!existsSync(f)) return {};
  try { return JSON.parse(await readFile(f, "utf8")) || {}; } catch (e) { return {}; }
}

async function venuePoint(ven) {
  const id = String(ven?.id || "");
  if (id && VENUES[id]) return VENUES[id];
  const city = ven?.address?.city;
  if (!city) return null;
  const q = [city, ven.address.state, ven.address.country].filter(Boolean).join(", ");
  const j = await getJSON(`${GEO}?name=${encodeURIComponent(city)}&count=5&language=en&format=json`);
  let hit = (j?.results || [])[0];
  if (ven.address.state) {
    const better = (j?.results || []).find(r => r.admin1 === ven.address.state
      || String(r.admin1_id || "") === ven.address.state);
    if (better) hit = better;
  }
  if (!hit) { process.stderr.write(`  no coordinates for ${q}\n`); return null; }
  const pt = { lat: hit.latitude, lon: hit.longitude, name: hit.name };
  if (id) VENUES[id] = pt;
  return pt;
}

// The hour the ball is kicked, not the daily average — a game at 8pm in a city that was warm
// at noon is still a cold game.
function nearestHour(hourly, iso) {
  const want = new Date(iso).getTime();
  let best = -1, gap = Infinity;
  (hourly?.time || []).forEach((t, i) => {
    const d = Math.abs(new Date(t + "Z").getTime() - want);
    if (d < gap) { gap = d; best = i; }
  });
  return gap <= 2 * 3600 * 1000 ? best : -1;
}

async function weatherFor(g, ven) {
  if (g.indoor) return null;
  const pt = await venuePoint(ven);
  if (!pt) return null;
  const kick = new Date(g.kick);
  if (isNaN(kick.getTime())) return null;

  const played = kick.getTime() < Date.now();
  const day = kick.toISOString().slice(0, 10);
  const base = `latitude=${pt.lat}&longitude=${pt.lon}` +
    `&hourly=temperature_2m,precipitation,wind_speed_10m,weather_code` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=UTC`;

  // The archive lags real time by a couple of days, so a game played this weekend still has
  // to come out of the forecast endpoint's recent past.
  const url = played && (Date.now() - kick.getTime() > 3 * 864e5)
    ? `${WX_A}?${base}&start_date=${day}&end_date=${day}`
    : `${WX_F}?${base}&past_days=7&forecast_days=16`;

  const j = await getJSON(url);
  const i = nearestHour(j?.hourly, g.kick);
  if (i < 0) return null;

  const code = j.hourly.weather_code[i];
  const temp = Math.round(j.hourly.temperature_2m[i]);
  const wind = Math.round(j.hourly.wind_speed_10m[i]);
  return {
    text: WMO[code] || "",
    temp, wind,
    precip: Number(j.hourly.precipitation[i]) || 0,
    src: played ? "actual" : "forecast",
  };
}

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "cache-control": "no-cache" } });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch (e) { /* fall through to the retry */ }
    await new Promise(r => setTimeout(r, 400 * (i + 1)));
  }
  return null;
}

/* ---------------------------------------------------------------------------------------
   Which week
--------------------------------------------------------------------------------------- */

async function resolveWeek() {
  if (WEEK_ARG !== "auto" && WEEK_ARG !== "upcoming" && WEEK_ARG !== true) return Number(WEEK_ARG);
  const sb = await getJSON(`${SITE}/scoreboard`);
  const cur = Number(sb?.week?.number || 1);
  // "upcoming" is the Sunday-morning beat: the week about to be played, so the closing line
  // gets written down before kickoff turns it into a live in-play number.
  if (WEEK_ARG === "upcoming") return cur;
  // "auto" means the last week that is actually finished. If every game on the current
  // week's board is final we can take it; otherwise the settled week is the one before.
  const events = sb?.events || [];
  const allDone = events.length > 0 && events.every(e => e?.status?.type?.state === "post");
  return allDone ? cur : Math.max(1, cur - 1);
}

/* ---------------------------------------------------------------------------------------
   Depth charts
   The depth-chart feed hands back athlete IDs as $ref links and nothing else, so it is
   paired with the team roster to turn those into names. Grouping is by the athlete's own
   position rather than the feed's slot keys (lde, wr1, rcb …), which vary by scheme.
--------------------------------------------------------------------------------------- */

const TEAM_IDS = {};   // abbreviation -> numeric team id, filled from the scoreboard

async function buildDepth(abbrs) {
  const depth = {};
  for (const ab of abbrs) {
    const tid = TEAM_IDS[ab];
    if (!tid) continue;
    const [chart, roster] = await Promise.all([
      getJSON(`${CORE}/seasons/${SEASON}/teams/${tid}/depthcharts`),
      getJSON(`${SITE}/teams/${ab}/roster`),
    ]);
    if (!chart || !roster) continue;

    const who = {};
    (roster.athletes || []).forEach(grp => {
      (grp.items || []).forEach(a => {
        if (!a?.id) return;
        who[String(a.id)] = { name: a.displayName || "", pos: a.position?.abbreviation || "" };
      });
    });

    const rows = [];
    (chart.items || []).forEach(item => {
      const positions = item.positions || {};
      Object.keys(positions).forEach(key => {
        (positions[key].athletes || []).forEach(slot => {
          const m = /athletes\/(\d+)/.exec(slot?.athlete?.$ref || "");
          if (!m) return;
          rows.push({ id: m[1], slot: Number(slot.slot) || 9, rank: Number(slot.rank) || 9 });
        });
      });
    });
    rows.sort((a, b) => (a.rank - b.rank) || (a.slot - b.slot));

    const byPos = {};
    const seen = new Set();
    rows.forEach(r => {
      if (seen.has(r.id)) return;
      seen.add(r.id);
      const p = who[r.id];
      if (!p || !p.pos || !p.name) return;
      (byPos[p.pos] = byPos[p.pos] || []).push(p.name);
    });
    depth[ab] = byPos;
    process.stderr.write(`  depth ${ab} — ${Object.keys(byPos).length} positions\n`);
  }
  return depth;
}

/* ---------------------------------------------------------------------------------------
   DraftKings from a box score
   Passing 0.04 a yard and 4 a score, rushing and receiving 0.1 a yard and 6, a point a
   catch, minus one for a pick or a lost fumble, and the three-point bonuses at 300 passing
   or 100 on the ground or through the air. A player can show up in three stat groups in the
   same game, so everything accumulates per athlete before it is scored.
--------------------------------------------------------------------------------------- */

function dkFromBox(box, posOf) {
  const acc = {};
  const get = (id, nm, tm) => (acc[id] = acc[id] || {
    n: nm, t: tm, py: 0, ptd: 0, pint: 0, cmp: 0, att: 0,
    car: 0, ry: 0, rtd: 0, rec: 0, recy: 0, rectd: 0, tgt: 0, fl: 0,
  });

  (box?.players || []).forEach(tp => {
    const tm = tp.team?.abbreviation || "";
    (tp.statistics || []).forEach(grp => {
      const keys = grp.keys || [];
      (grp.athletes || []).forEach(a => {
        const ath = a.athlete || {}, st = a.stats || [];
        if (!ath.id) return;
        const v = key => {
          const i = keys.indexOf(key);
          if (i < 0) return 0;
          return parseFloat(String(st[i]).replace(/[^0-9.\-]/g, "")) || 0;
        };
        const r = get(ath.id, ath.displayName || "", tm);
        if (grp.name === "passing") {
          r.py += v("passingYards"); r.ptd += v("passingTouchdowns"); r.pint += v("interceptions");
          const ca = /(\d+)\s*\/\s*(\d+)/.exec(String(st[keys.indexOf("completions/passingAttempts")] || ""));
          if (ca) { r.cmp += Number(ca[1]); r.att += Number(ca[2]); }
        } else if (grp.name === "rushing") {
          r.car += v("rushingAttempts"); r.ry += v("rushingYards"); r.rtd += v("rushingTouchdowns");
        } else if (grp.name === "receiving") {
          r.rec += v("receptions"); r.recy += v("receivingYards");
          r.rectd += v("receivingTouchdowns"); r.tgt += v("receivingTargets");
        } else if (grp.name === "fumbles") {
          r.fl += v("fumblesLost");
        }
      });
    });
  });

  const out = [];
  Object.keys(acc).forEach(id => {
    const r = acc[id];
    let p = r.py * 0.04 + r.ptd * 4 - r.pint
          + r.ry * 0.1 + r.rtd * 6
          + r.rec + r.recy * 0.1 + r.rectd * 6
          - r.fl;
    if (r.py >= 300) p += 3;
    if (r.ry >= 100) p += 3;
    if (r.recy >= 100) p += 3;
    if (p <= 0) return;
    out.push({
      name: r.n, team: r.t, pos: posOf(id, r.n) || "",
      dk: Math.round(p * 10) / 10,
      line: statLine(r),
    });
  });
  return out.sort((a, b) => b.dk - a.dk);
}

// The number on its own says a player scored; the line says how, which is the part that
// tells you whether to expect it again.
function statLine(r) {
  const bits = [];
  if (r.py || r.ptd || r.pint) {
    let s = `${r.cmp ? `${r.cmp}/${r.att} ` : ""}${Math.round(r.py)} pass`;
    if (r.ptd) s += `, ${r.ptd} TD`;
    if (r.pint) s += `, ${r.pint} INT`;
    bits.push(s);
  }
  if (r.car || r.ry || r.rtd) {
    let s = `${Math.round(r.car)} car, ${Math.round(r.ry)} rush`;
    if (r.rtd) s += `, ${r.rtd} TD`;
    bits.push(s);
  }
  if (r.rec || r.recy || r.rectd) {
    let s = `${Math.round(r.rec)}/${Math.round(r.tgt)} for ${Math.round(r.recy)}`;
    if (r.rectd) s += `, ${r.rectd} TD`;
    bits.push(s);
  }
  if (r.fl) bits.push(`${r.fl} fum lost`);
  return bits.join(" · ");
}

/* ---------------------------------------------------------------------------------------
   Shared derivations. These are mirrored in index.html for the live week; if one changes,
   change both, or a Sunday card and its own archive entry will disagree.
--------------------------------------------------------------------------------------- */

const SKILL = new Set(["QB", "RB", "FB", "WR", "TE", "PK", "K"]);

// A spread and a total are two ways of saying the same thing. Together they pin each side's
// expected points, which is the number that actually moves a start/sit.
function implied(total, details, homeAb, awayAb) {
  if (total == null || !isFinite(total)) return null;
  const m = /([A-Za-z]{2,4})\s*(-?\d+(?:\.\d+)?)/.exec(details || "");
  if (!m) return { home: total / 2, away: total / 2 };
  const team = m[1].toUpperCase(), sp = parseFloat(m[2]);
  if (!isFinite(sp) || sp === 0) return { home: total / 2, away: total / 2 };
  const margin = Math.abs(sp), hi = (total + margin) / 2, lo = (total - margin) / 2;
  const named = team === String(homeAb).toUpperCase() ? "home"
              : team === String(awayAb).toUpperCase() ? "away" : null;
  if (!named) return { home: total / 2, away: total / 2 };
  const favHome = named === "home" ? sp < 0 : sp > 0;
  return favHome ? { home: hi, away: lo } : { home: lo, away: hi };
}

function script(points) {
  if (points == null || !isFinite(points)) return null;
  if (points >= 49) return "Shootout";
  if (points <= 41) return "Grind";
  return "Middle";
}

// What the market said would happen, next to what did. A total of 51 that lands on 31 is
// the single most useful thing to know when you are working out why a week went wrong.
function buildCalls(g) {
  if (g.state !== "post" || g.aScore == null || g.hScore == null) return null;
  const actual = g.aScore + g.hScore;
  const calls = {};

  if (g.line?.total != null) {
    const delta = Math.round((actual - g.line.total) * 10) / 10;
    calls.total = {
      called: g.line.total, actual,
      delta: Math.abs(delta),
      verdict: delta > 0 ? "OVER" : delta < 0 ? "UNDER" : "PUSH",
    };
    const called = script(g.line.total), was = script(actual);
    calls.script = { called, actual: was, hit: called === was };
  }

  const m = /([A-Za-z]{2,4})\s*(-?\d+(?:\.\d+)?)/.exec(g.line?.spread || "");
  if (m) {
    const fav = m[1].toUpperCase(), num = Math.abs(parseFloat(m[2]));
    const favHome = fav === String(g.home).toUpperCase();
    const favScore = favHome ? g.hScore : g.aScore;
    const dogScore = favHome ? g.aScore : g.hScore;
    const margin = favScore - dogScore;
    calls.spread = {
      called: g.line.spread, favorite: fav, number: num, margin,
      verdict: margin > num ? `${fav} covered`
             : margin === num ? "Push"
             : `${favHome ? g.away : g.home} covered`,
      favoriteWon: margin > 0,
    };
  }

  if (g.predictor) {
    const pickHome = g.predictor.home >= g.predictor.away;
    const homeWon = g.hScore > g.aScore;
    calls.predictor = {
      pick: pickHome ? g.home : g.away,
      prob: Math.round((pickHome ? g.predictor.home : g.predictor.away) * 10) / 10,
      hit: g.hScore === g.aScore ? null : pickHome === homeWon,
    };
  }
  return calls;
}

// Short, concrete, and only when true. A chip that fires every week teaches nobody anything.
function buildFactors(g) {
  const f = [];
  if (g.intl) f.push(`International · ${g.country} — travel and an early kick`);
  else if (g.neutral) f.push("Neutral site — no home crowd");

  if (g.indoor) f.push("Indoors — weather off the table");
  else if (g.weather) {
    const w = g.weather, t = w.temp, d = w.text || "";
    // Wind is the one that actually moves a passing game, and it is the one ESPN never had.
    // Fifteen is where the kicking game starts getting interesting; twenty is where you stop
    // trusting a deep threat at all.
    if (w.wind >= 15) f.push(`Wind · ${w.wind} mph — downgrade the deep ball and the kicker`);
    const wet = /rain|snow|storm|drizzle|sleet|hail/i.test(d) || (w.precip || 0) > 0.02;
    if (wet) f.push(`Weather · ${[d, t != null ? `${t}°` : ""].filter(Boolean).join(" ")} — ball security`);
    else if (t != null && t <= 25) f.push(`Cold · ${t}° — the run game gets the work`);
  }

  if (g.line?.total != null) {
    const s = script(g.line.total);
    if (s === "Shootout") f.push(`Shootout call · total ${g.line.total} — start the pass game`);
    else if (s === "Grind") f.push(`Grind call · total ${g.line.total} — backs over receivers`);
  }

  const m = /([A-Za-z]{2,4})\s*(-?\d+(?:\.\d+)?)/.exec(g.line?.spread || "");
  if (m) {
    const num = Math.abs(parseFloat(m[2]));
    if (num >= 10) f.push(`Blowout risk · ${m[1].toUpperCase()} by ${num} — the dog throws, the favourite runs`);
  }

  const skillOut = (g.out || []).filter(p => p.sure && SKILL.has(p.pos));
  if (skillOut.length) {
    f.push(`${skillOut.length} skill starter${skillOut.length > 1 ? "s" : ""} out · ${
      skillOut.slice(0, 3).map(p => `${p.name} (${p.team} ${p.pos})`).join(", ")}`);
  }
  return f;
}

// Skill positions get a name, because the next man up is a waiver claim. Everywhere else a
// name means nothing to a fantasy manager, so say what to actually watch instead.
// Who actually took the snaps, from the box score — not a guess off the depth chart.
//
// The depth chart cannot answer this and pretending otherwise produced nonsense. ESPN ranks a
// whole position room in one list and drops injured players to the bottom of it, so the man
// "below" A.J. Brown was the seventh receiver. And when the RB2 is out the carries go UP to
// the RB1, not down to the RB3, so neither direction is right. The box score is not a
// prediction at all: it is the player at that position, on that team, who actually produced
// in the game that was played. For a game that has not kicked off yet there is no honest
// answer, so nothing is shown.
function tookOver(p, scored, outNames) {
  if (!p.pos) return null;
  const best = scored.find(x => x.team === p.team && x.pos === p.pos
                             && x.name !== p.name && !outNames.has(x.name));
  return best ? { name: best.name, dk: best.dk } : null;
}

/* ---------------------------------------------------------------------------------------
   Build one week
--------------------------------------------------------------------------------------- */

// What an earlier run captured beats whatever the feed says now, because the feed forgets.
//
// ESPN carries a forecast only while a game is still to be played: the moment it goes final
// the weather disappears from the scoreboard AND from the summary, and there is no endpoint
// that will give it back. Same story with the matchup predictor, and with the questionables —
// by Tuesday everyone has been resolved, so the injury report the week was actually played
// under is gone. The line is the one thing that usually survives, and even that goes missing
// on the odd game.
//
// So a rebuild never discards: it fills in from the previous snapshot wherever the fresh
// fetch has nothing. That is the whole reason the job runs every morning rather than once.
async function priorGames(week) {
  const f = path.join(OUT_DIR, `wk${String(week).padStart(2, "0")}.json`);
  if (!existsSync(f)) return {};
  try {
    const j = JSON.parse(await readFile(f, "utf8"));
    const map = {};
    (j.games || []).forEach(g => { map[g.id] = g; });
    if (Object.keys(map).length) process.stderr.write(`merging over ${Object.keys(map).length} archived game(s)\n`);
    return map;
  } catch (e) { return {}; }
}

async function buildWeek(week) {
  const carried = await priorGames(week);
  VENUES = await loadVenues();
  const sb = await getJSON(`${SITE}/scoreboard?dates=${SEASON}&seasontype=2&week=${week}`);
  const events = sb?.events || [];
  if (!events.length) { process.stderr.write(`no events for week ${week}\n`); return null; }
  process.stderr.write(`week ${week}: ${events.length} games\n`);

  const abbrs = new Set();
  const shells = events.map(ev => {
    const c = (ev.competitions || [])[0] || {};
    const cs = c.competitors || [];
    const home = cs.find(x => x.homeAway === "home") || cs[0] || {};
    const away = cs.find(x => x.homeAway === "away") || cs[1] || {};
    const hAb = home.team?.abbreviation || "", aAb = away.team?.abbreviation || "";
    if (home.team?.id) TEAM_IDS[hAb] = home.team.id;
    if (away.team?.id) TEAM_IDS[aAb] = away.team.id;
    abbrs.add(hAb); abbrs.add(aAb);

    const ven = c.venue || {}, addr = ven.address || {};
    const country = addr.country || "";
    // ESPN hands back several books; take DraftKings when it is there, because that is the
    // scoring these leagues run on and it keeps one number in one place.
    const odds = c.odds || [];
    const pick = odds.find(o => /draft/i.test(o.provider?.name || "")) || odds[0] || null;

    return {
      id: ev.id, away: aAb, home: hAb, kick: ev.date,
      state: ev.status?.type?.state || "pre",
      detail: ev.status?.type?.shortDetail || "",
      aScore: away.score != null ? Number(away.score) : null,
      hScore: home.score != null ? Number(home.score) : null,
      _ven: ven,
      venue: ven.fullName || "",
      city: [addr.city, addr.state || country].filter(Boolean).join(", "),
      country, intl: !!(country && !/^(usa|us|united states)$/i.test(country)),
      indoor: !!ven.indoor, neutral: !!c.neutralSite,
      line: {
        spread: pick?.details || "",
        total: pick?.overUnder != null ? Number(pick.overUnder) : null,
        book: pick?.provider?.name || "",
      },
      weather: ev.weather ? {
        text: ev.weather.displayValue || "",
        temp: ev.weather.temperature != null ? Number(ev.weather.temperature) : null,
      } : null,
    };
  });

  process.stderr.write(`building depth charts for ${abbrs.size} teams…\n`);
  const depth = await buildDepth([...abbrs].filter(Boolean).sort());

  const games = [];
  for (const g of shells) {
    const s = await getJSON(`${SITE}/summary?event=${encodeURIComponent(g.id)}`);

    if (s?.predictor) {
      const h = Number(s.predictor.homeTeam?.gameProjection), a = Number(s.predictor.awayTeam?.gameProjection);
      if (isFinite(h) && isFinite(a)) g.predictor = { home: h, away: a };
    }

    // The closing number is what the market settled on. Once a game has started ESPN's
    // scoreboard odds go live and in-play, so prefer pickcenter, which stays put.
    const pc = (s?.pickcenter || []).find(o => /draft/i.test(o.provider?.name || "")) || (s?.pickcenter || [])[0];
    if (pc) {
      g.line = {
        spread: pc.details || g.line.spread,
        total: pc.overUnder != null ? Number(pc.overUnder) : g.line.total,
        book: pc.provider?.name || g.line.book,
      };
    }
    // Real weather, with wind, for the hour the ball is kicked. Once a game has been played
    // this is what the conditions actually were rather than what somebody guessed they would
    // be, which is the half ESPN never had at all.
    const wx = await weatherFor(g, g._ven);
    if (wx) g.weather = wx;
    delete g._ven;

    // Fill from the last snapshot anything this fetch no longer has.
    const was = carried[g.id];
    if (was) {
      if (g.line.total == null && !g.line.spread && was.line) g.line = was.line;
      if (!g.weather && was.weather) g.weather = was.weather;
      if (!g.predictor && was.predictor) g.predictor = was.predictor;
    }

    const imp = implied(g.line.total, g.line.spread, g.home, g.away);
    if (imp) g.implied = { away: Math.round(imp.away * 10) / 10, home: Math.round(imp.home * 10) / 10 };

    // The whole injury report, not a headline and a leftover count. Everyone gets a team and
    // a position — "Smith is out" is useless if you do not know which Smith, on which side,
    // doing what — and everyone carries his own status, so a questionable sits in the same
    // list as an out without the two being confused.
    const out = [];
    (s?.injuries || []).forEach(grp => {
      const tm = grp.team?.abbreviation || "";
      (grp.injuries || []).forEach(x => {
        const st = String(x.status || "");
        const nm = x.athlete?.displayName || "";
        if (!nm) return;
        const sure = /^(out|doubtful|injured reserve|suspension|physically unable)/i.test(st);
        if (!sure && !/questionable/i.test(st)) return;
        out.push({
          team: tm, name: nm,
          pos: x.athlete?.position?.abbreviation || "",
          status: st, sure,
          injury: x.details?.type || "",
          back: x.details?.returnDate || "",
        });
      });
    });
    // Sunday's report is the one the week was played under, questionables and all. By Tuesday
    // ESPN has resolved every one of them and they simply vanish, so anyone the earlier
    // snapshot had who is no longer listed is carried through rather than dropped.
    if (was && (was.out || []).length) {
      const have = new Set(out.map(p => p.name));
      (was.out || []).forEach(p => {
        if (!have.has(p.name)) out.push(Object.assign({}, p, { took: null, kept: true }));
      });
    }

    const outNames = new Set(out.filter(p => p.sure).map(p => p.name));

    let scored = [];
    if (g.state !== "pre" && s?.boxscore) {
      const posOf = (id, name) => {
        for (const t of Object.keys(depth)) {
          for (const p of Object.keys(depth[t])) if (depth[t][p].includes(name)) return p;
        }
        return "";
      };
      scored = dkFromBox(s.boxscore, posOf);
      g.top = scored.slice(0, 5);
    }
    if (scored.length) out.forEach(p => { if (p.sure) p.took = tookOver(p, scored, outNames); });

    // Certain before probable, skill before the rest — that is the order you read it in.
    out.sort((a, b) => (b.sure ? 1 : 0) - (a.sure ? 1 : 0)
                    || (SKILL.has(b.pos) ? 1 : 0) - (SKILL.has(a.pos) ? 1 : 0)
                    || a.team.localeCompare(b.team));
    g.out = out;

    g.factors = buildFactors(g);
    g.calls = buildCalls(g);
    delete g.detail;
    games.push(g);
    process.stderr.write(`  ${g.away} @ ${g.home} — ${g.out.length} out, ${(g.top || []).length} scored\n`);
  }

  return { season: SEASON, week, builtAt: new Date().toISOString(), games, depthTeams: Object.keys(depth).length };
}

/* ---------------------------------------------------------------------------------------
   Write
--------------------------------------------------------------------------------------- */

async function writeIndex() {
  const weeks = [];
  for (let w = 1; w <= 18; w++) {
    const f = path.join(OUT_DIR, `wk${String(w).padStart(2, "0")}.json`);
    if (!existsSync(f)) continue;
    try {
      const j = JSON.parse(await readFile(f, "utf8"));
      weeks.push({ week: w, games: (j.games || []).length, builtAt: j.builtAt || "" });
    } catch (e) { /* a half-written file is not an index entry */ }
  }
  const idx = { season: SEASON, updated: new Date().toISOString(), weeks };
  await writeFile(path.join(OUT_DIR, "index.json"), JSON.stringify(idx, null, 1) + "\n");
  process.stderr.write(`index.json — ${weeks.length} week(s)\n`);
}

async function main() {
  const week = await resolveWeek();
  if (!isFinite(week) || week < 1) { process.stderr.write("could not work out a week\n"); process.exit(1); }

  if (!DRY) await mkdir(OUT_DIR, { recursive: true });

  if (DEPTH_ONLY) {
    const sb = await getJSON(`${SITE}/scoreboard?dates=${SEASON}&seasontype=2&week=${week}`);
    const abbrs = new Set();
    (sb?.events || []).forEach(ev => {
      ((ev.competitions || [])[0]?.competitors || []).forEach(c => {
        if (c.team?.abbreviation) { TEAM_IDS[c.team.abbreviation] = c.team.id; abbrs.add(c.team.abbreviation); }
      });
    });
    const depth = await buildDepth([...abbrs].filter(Boolean).sort());
    const body = JSON.stringify({ season: SEASON, updated: new Date().toISOString(), depth }, null, 0) + "\n";
    if (DRY) { process.stdout.write(body.slice(0, 600) + "\n…\n"); return; }
    await writeFile(path.join(OUT_DIR, "depth.json"), body);
    process.stderr.write(`depth.json — ${Object.keys(depth).length} teams\n`);
    return;
  }

  const data = await buildWeek(week);
  if (!data) process.exit(1);

  const file = path.join(OUT_DIR, `wk${String(week).padStart(2, "0")}.json`);
  const body = JSON.stringify(data, null, 0) + "\n";
  if (DRY) {
    process.stdout.write(`would write ${file} (${Math.round(body.length / 1024)}KB)\n`);
    process.stdout.write(JSON.stringify(data.games[0], null, 1) + "\n");
    return;
  }
  await writeFile(file, body);
  process.stderr.write(`wrote ${path.relative(ROOT, file)} — ${Math.round(body.length / 1024)}KB\n`);
  // Geocoding a stadium is a one-off; remembering the answer keeps every later run to the
  // weather calls alone.
  await writeFile(path.join(OUT_DIR, "venues.json"), JSON.stringify(VENUES, null, 1) + "\n");
  await writeIndex();
}

main().catch(e => { process.stderr.write("archive failed: " + (e?.stack || e) + "\n"); process.exit(1); });
