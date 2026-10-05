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

/** Everything, in one pass, for a picker that wants the whole table in front of it. */
export async function everything(wk) {
  const [a, b, c] = await Promise.all([bunk(wk), benched(wk), faab(wk)]);
  return [...a, ...b, ...c];
}
