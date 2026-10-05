/**
 * Every fact the daily bot is allowed to talk about, pulled from the three leagues.
 *
 * The whole point is that the bot never repeats itself, and the only way to guarantee that is to
 * stop writing jokes about situations and start writing them about numbers. "X is undefeated" is
 * a situation — it recurs every season and there are only so many ways to say it, which is how
 * the old beats burned through 21 sentences and started looping. "Christian McCaffrey was
 * projected 18.4 and scored 4.1 on nine carries" happens once in the history of the world.
 *
 * So each fact carries a `key` that is unique forever — league, week, player, kind — and the
 * ledger refuses any key it has already seen. A fact can be used once, ever.
 *
 * Coverage is the other half of the instruction: call out everyone, not the same few names. Facts
 * come back sorted by how badly they deserve it, but the picker in crank.mjs spreads by manager so
 * one unlucky owner doesn't become the bot's whole personality.
 *
 * Nothing here posts, writes, or has an opinion. It returns facts.
 */

const SEASON = Number(process.env.SEASON) || 2026;
const API = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/`;

export const LEAGUES = [
  { name: "Board 1", id: "951407474" },
  { name: "Board 2", id: "1963204215" },
  { name: "Board 3", id: "976183547" },
];

const POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };
const BENCH = new Set([20, 21]);          // 20 bench, 21 IR
const clean = s => String(s || "").replace(/[*_`~|]/g, "").trim();
const r1 = n => Math.round(n * 10) / 10;

/**
 * A hurt player is not a joke. Ja'Marr Chase put up 5.7 and left with a concussion; a bot that
 * calls that a no-show reads as both mean and uninformed, which is worse than saying nothing.
 * Anybody carrying a designation is out of the material entirely — the numbers are cheap and
 * there are two hundred of them, so there is no reason to go near the one with a head injury.
 */
const hurt = p => Boolean(p.injured) || (p.injuryStatus && p.injuryStatus !== "ACTIVE");

async function league(id, view) {
  const r = await fetch(`${API}${id}?${view}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`ESPN ${r.status} on league ${id}`);
  return r.json();
}

// ESPN files a player's week twice: statSourceId 0 is what he did, 1 is what he was expected to
// do. Both are needed — "scored 4" is only a story next to "was supposed to score 18".
function week(player, wk) {
  let got = null, due = null;
  for (const s of player.stats || []) {
    if (s.statSplitTypeId !== 1 || s.scoringPeriodId !== wk) continue;
    if (s.statSourceId === 0) got = s;
    else if (s.statSourceId === 1) due = s;
  }
  return { got, due };
}

/**
 * Starters who did not show up: what they were projected, what they actually did, and the manager
 * who started them. One fact per player per week per league, so a name can be called out once for
 * a given stinker and then never again for it.
 *
 * Only started players count. A bad game on somebody's bench isn't a story, and it isn't fair.
 */
export async function bunk(wk) {
  const out = [];
  for (const L of LEAGUES) {
    const j = await league(L.id, "view=mRoster&view=mTeam");
    const w = wk || j.scoringPeriodId;
    for (const t of j.teams || []) {
      const manager = clean(t.name) || `Team ${t.id}`;
      for (const e of (t.roster && t.roster.entries) || []) {
        if (BENCH.has(e.lineupSlotId)) continue;
        const p = e.playerPoolEntry && e.playerPoolEntry.player;
        if (!p) continue;
        if (hurt(p)) continue;
        const { got, due } = week(p, w);
        if (!got || !due) continue;
        const scored = Number(got.appliedTotal || 0);
        const projected = Number(due.appliedTotal || 0);
        if (projected < 6) continue;             // nobody is owed an apology for a 5-point projection
        const short = projected - scored;
        if (short < 5) continue;                 // a point or two under is a Tuesday, not a crime
        out.push({
          kind: "bunk",
          key: `bunk:${SEASON}:w${w}:${L.id}:${p.id}`,
          league: L.name, week: w, manager, managerId: t.id,
          player: clean(p.fullName), pos: POS[p.defaultPositionId] || "",
          scored: r1(scored), projected: r1(projected), short: r1(short),
          ratio: projected > 0 ? scored / projected : 1,
          weight: short + (scored <= 2 ? 6 : 0),  // a goose egg outranks a merely bad day
        });
      }
    }
  }
  return out.sort((a, b) => b.weight - a.weight);
}

/**
 * Points left on the bench: a benched player who beat the starter in the same slot. The manager's
 * own fault, which is the funny part, and it never lands on the player.
 */
export async function benched(wk) {
  const out = [];
  for (const L of LEAGUES) {
    const j = await league(L.id, "view=mRoster&view=mTeam");
    const w = wk || j.scoringPeriodId;
    for (const t of j.teams || []) {
      const manager = clean(t.name) || `Team ${t.id}`;
      const started = {}, sat = {};
      for (const e of (t.roster && t.roster.entries) || []) {
        const p = e.playerPoolEntry && e.playerPoolEntry.player;
        if (!p) continue;
        if (hurt(p)) continue;
        const { got } = week(p, w);
        if (!got) continue;
        const pos = POS[p.defaultPositionId] || "";
        if (!pos) continue;
        const row = { name: clean(p.fullName), pts: r1(Number(got.appliedTotal || 0)), id: p.id };
        if (e.lineupSlotId === 21) continue;      // IR isn't a decision
        (BENCH.has(e.lineupSlotId) ? (sat[pos] ||= []) : (started[pos] ||= [])).push(row);
      }
      for (const pos of Object.keys(sat)) {
        const bestSat = sat[pos].sort((a, b) => b.pts - a.pts)[0];
        const worstIn = (started[pos] || []).sort((a, b) => a.pts - b.pts)[0];
        if (!bestSat || !worstIn) continue;
        const gap = bestSat.pts - worstIn.pts;
        if (gap < 8) continue;
        out.push({
          kind: "benched",
          key: `benched:${SEASON}:w${w}:${L.id}:${t.id}:${bestSat.id}`,
          league: L.name, week: w, manager, managerId: t.id, pos,
          sat: bestSat.name, satPts: bestSat.pts,
          played: worstIn.name, playedPts: worstIn.pts, gap: r1(gap),
          weight: gap,
        });
      }
    }
  }
  return out.sort((a, b) => b.weight - a.weight);
}

/**
 * The waiver wire: what somebody paid, and what they got for it. A winning bid is a public
 * promise that a player is worth something, which makes it the fairest thing on the board to
 * bring up later.
 */
export async function faab(wk) {
  const out = [];
  for (const L of LEAGUES) {
    const j = await league(L.id, "view=mTransactions2&view=mTeam&view=mRoster");
    const w = wk || j.scoringPeriodId;
    const names = {}, spent = {};
    for (const t of j.teams || []) {
      names[t.id] = clean(t.name) || `Team ${t.id}`;
      spent[t.id] = Number((t.transactionCounter || {}).acquisitionBudgetSpent || 0);
    }
    // What each bought player actually did this week, so a bid can be priced against reality.
    const did = {};
    for (const t of j.teams || []) {
      for (const e of (t.roster && t.roster.entries) || []) {
        const p = e.playerPoolEntry && e.playerPoolEntry.player;
        if (!p) continue;
        const { got } = week(p, w);
        if (got) did[p.id] = { name: clean(p.fullName), pts: r1(Number(got.appliedTotal || 0)) };
      }
    }
    for (const tx of j.transactions || []) {
      const bid = Number(tx.bidAmount || 0);
      if (!bid || tx.status !== "EXECUTED") continue;
      const add = (tx.items || []).find(i => i.type === "ADD");
      if (!add) continue;
      const player = did[add.playerId];
      out.push({
        kind: "faab",
        key: `faab:${SEASON}:${L.id}:${tx.id || `${tx.teamId}:${add.playerId}:${bid}`}`,
        league: L.name, week: w, manager: names[tx.teamId] || "Somebody", managerId: tx.teamId,
        bid, player: player ? player.name : "", pts: player ? player.pts : null,
        spentTotal: spent[tx.teamId] || 0,
        weight: bid + (player && player.pts <= 3 ? 20 : 0),
      });
    }
    // A superlative has to be checked before it is claimed. "Biggest bid in the league" on a $2
    // claim is the kind of thing that makes the whole bot look like it isn't reading its own data.
    const bidsHere = out.filter(f => f.kind === "faab" && f.league === L.name);
    const top = bidsHere.reduce((m, f) => Math.max(m, f.bid), 0);
    for (const f of bidsHere) f.isTop = f.bid === top && top > 0;

    // Whoever has not spent a dollar all season. Doing nothing is a decision too.
    const idle = Object.keys(spent).filter(id => !spent[id]);
    for (const id of idle) {
      out.push({
        kind: "tightwad",
        key: `tightwad:${SEASON}:w${w}:${L.id}:${id}`,
        league: L.name, week: w, manager: names[id], managerId: Number(id),
        spentTotal: 0, weight: 4,
      });
    }
  }
  return out.sort((a, b) => b.weight - a.weight);
}

/**
 * Every manager in all three leagues, with the season they are actually having.
 *
 * The instruction was that everyone gets talked about — no favourites, no "these guys". So this
 * returns one fact per manager per week whether or not they have done anything interesting, and
 * the picker in crank.mjs promotes whoever has been mentioned least. Having a quiet season is not
 * a reason to be invisible; it is its own thing to say.
 */
export async function members(wk) {
  const out = [];
  for (const L of LEAGUES) {
    const j = await league(L.id, "view=mTeam");
    const w = wk || j.scoringPeriodId;
    const who = {};
    for (const m of j.members || []) who[m.id] = clean(m.firstName || m.displayName || "");
    const standings = (j.teams || []).map(t => {
      const o = (t.record && t.record.overall) || {};
      return { id: t.id, pf: o.pointsFor || 0 };
    }).sort((a, b) => b.pf - a.pf);
    const rankOf = Object.fromEntries(standings.map((t, i) => [t.id, i + 1]));

    for (const t of j.teams || []) {
      const o = (t.record && t.record.overall) || {};
      const owner = (t.owners || [])[0];
      out.push({
        kind: "member",
        key: `member:${SEASON}:w${w}:${L.id}:${t.id}`,
        league: L.name, week: w,
        manager: clean(t.name) || `Team ${t.id}`, managerId: t.id,
        person: who[owner] || "",
        w: o.wins || 0, l: o.losses || 0,
        pf: r1(o.pointsFor || 0), pa: r1(o.pointsAgainst || 0),
        rank: rankOf[t.id] || 0, of: (j.teams || []).length,
        streakType: o.streakType || "", streak: o.streakLength || 0,
        weight: 7,
      });
    }
  }
  return out;
}

/**
 * The league's own news, straight from ESPN — the Tyreek and Mixon of it.
 *
 * Nothing here is a joke by default. A headline about a torn Achilles, an arrest, a hospital or a
 * suspension is somebody's actual life, and a bot making a crack about it in front of thirty-six
 * people is the single fastest way to make the whole thing look nasty. Anything matching that list
 * is dropped entirely rather than softened.
 */
const SERIOUS = /(injur|tear|torn|acl|achilles|concussion|surger|hospital|carted|ambulanc|arrest|charg|lawsuit|suspend|suspension|investigat|died|death|passed away|cancer|illness|assault|domestic|dui|retire)/i;

export async function news(limit = 20) {
  const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=${limit}`);
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  const out = [];
  for (const a of j.articles || []) {
    const head = clean(a.headline || "");
    const blurb = clean(a.description || "");
    if (!head) continue;
    if (SERIOUS.test(head) || SERIOUS.test(blurb)) continue;
    out.push({
      kind: "news",
      key: `news:${(a.id || head).toString().slice(0, 60)}`,
      manager: "", league: "", headline: head, blurb: blurb.slice(0, 180),
      weight: 8,
    });
  }
  return out;
}

/**
 * The officials, and how many flags flew. The one group everybody in every league agrees about,
 * which makes it the safest shared joke in the building.
 */
export async function officials(wk) {
  const sb = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${SEASON}&seasontype=2&week=${wk || ""}`)
    .then(r => (r.ok ? r.json() : null)).catch(() => null);
  const out = [];
  for (const ev of (sb && sb.events) || []) {
    if ((ev.status && ev.status.type && ev.status.type.state) !== "post") continue;
    const s = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${ev.id}`)
      .then(r => (r.ok ? r.json() : null)).catch(() => null);
    const crew = ((s && s.gameInfo) || {}).officials || [];
    const ref = crew.find(o => (o.position && o.position.name) === "Referee");
    if (!ref) continue;
    let flags = 0;
    for (const t of ((s && s.boxscore) || {}).teams || []) {
      const p = (t.statistics || []).find(x => /penalt/i.test(x.name || ""));
      if (p) flags += parseInt(String(p.displayValue).split("-")[0], 10) || 0;
    }
    out.push({
      kind: "ref", key: `ref:${ev.id}`, manager: "",
      game: clean(ev.shortName || ""), referee: clean(ref.fullName || ""), flags,
      weight: flags >= 12 ? 10 : 5,
    });
  }
  return out;
}

/**
 * Everything, in one pass — and then the part that stops the bot looking stupid.
 *
 * Half the league starts the same handful of players, so the same bad afternoon shows up as one
 * fact per manager. Naming one of them for it is unfair and obviously unfair to everyone reading,
 * because they did it too. So each fact learns how many managers are in the same boat, and a line
 * that names a single person is only allowed when that person was actually on their own.
 */
export async function everything(wk) {
  const [a, b, c, d, e, f] = await Promise.all([
    bunk(wk), benched(wk), faab(wk),
    members(wk), news().catch(() => []), officials(wk).catch(() => []),
  ]);
  const all = [...a, ...b, ...c, ...d, ...e, ...f];

  const groups = {};
  for (const f of all) {
    const g = f.kind === "bunk" ? `bunk:${f.player}:${f.week}`
            : f.kind === "benched" ? `benched:${f.sat}:${f.week}`
            : null;
    if (g) (groups[g] ||= new Set()).add(f.manager);
  }
  for (const f of all) {
    const g = f.kind === "bunk" ? `bunk:${f.player}:${f.week}`
            : f.kind === "benched" ? `benched:${f.sat}:${f.week}`
            : null;
    f.shared = g ? (groups[g] ? groups[g].size : 1) : 1;
    f.solo = f.shared <= 1;
  }
  return all;
}
