// The Tuesday post. Crown and clown for every board, plus the three lines that actually start
// arguments: the one-point game, the beatdown, and whoever put up a number and still lost.
//
// The point of this one is that it needs nobody. It reads ESPN, which is already keeping score
// whether anyone opens Discord or not, so the server has something worth looking at on a
// Tuesday morning from the very first week — and the nudge to make a card rides along at the
// bottom of it instead of being its own nagging announcement.
//
//   node tools/weekly-post.mjs --dry            print what it would post
//   node tools/weekly-post.mjs --week 2         force a week
//   node tools/weekly-post.mjs                  post it (needs WEBHOOK_WEEKLY)

const LEAGUES = [
  ["Board 1", "951407474", 0xFFC62F],
  ["Board 2", "1963204215", 0x00A8FC],
  ["Board 3", "976183547", 0x1D9E75]
];
const SEASON = 2026;
const arg = n => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : null; };
const DRY = process.argv.includes("--dry");
const pts = n => (Math.round(n * 10) / 10).toFixed(1);

async function board(id) {
  const r = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${id}?view=mMatchupScore&view=mTeam`);
  if (!r.ok) throw new Error(`ESPN ${r.status} on league ${id}`);
  const d = await r.json();
  const team = {};
  for (const t of d.teams || []) team[t.id] = { name: String(t.name || "").trim(), logo: t.logo || "" };

  // Trust the scores, not the calendar. A period counts as played once every matchup in it has
  // both sides on the board — that way a Tuesday run can't post a week that hasn't happened and
  // a late run can't skip one that has.
  const by = new Map();
  for (const m of d.schedule || []) {
    if (!m.away) continue; // byes
    if (!by.has(m.matchupPeriodId)) by.set(m.matchupPeriodId, []);
    by.get(m.matchupPeriodId).push(m);
  }
  const done = [...by.entries()]
    .filter(([, ms]) => ms.every(m => (m.home.totalPoints || 0) > 0 && (m.away.totalPoints || 0) > 0))
    .map(([w]) => w);
  return { team, by, done };
}

function readWeek(b, week) {
  const games = (b.by.get(week) || []).map(m => {
    const h = { ...b.team[m.home.teamId], pf: m.home.totalPoints || 0 };
    const a = { ...b.team[m.away.teamId], pf: m.away.totalPoints || 0 };
    const [win, lose] = h.pf >= a.pf ? [h, a] : [a, h];
    return { win, lose, gap: win.pf - lose.pf };
  });
  if (!games.length) return null;
  const all = games.flatMap(g => [g.win, g.lose]);
  const crown = all.reduce((x, y) => (y.pf > x.pf ? y : x));
  const clown = all.reduce((x, y) => (y.pf < x.pf ? y : x));
  const close = games.reduce((x, y) => (y.gap < x.gap ? y : x));
  const blow = games.reduce((x, y) => (y.gap > x.gap ? y : x));
  const robbed = games.reduce((x, y) => (y.lose.pf > x.lose.pf ? y : x));
  return { crown, clown, close, blow, robbed };
}

const nm = t => t.name.replace(/[*_`~|]/g, ""); // team names are user input; don't let them style the post

// Go get it's board is public JSON on the site. Folding it in here is the only way the people
// who played get seen by the people who haven't — and a name at the top of a list is the
// cheapest dare there is. If the site is down this just doesn't appear; it never fails the post.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
async function gameBoard() {
  try {
    const r = await fetch("https://www.crownorclown.com/api/board", { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const top = ((await r.json()).scores || []).slice(0, 5);
    if (!top.length) return null;
    const fresh = top.filter(s => Date.now() - Number(s.ts || 0) < WEEK_MS).length;
    const line = (s, i) => `**${i + 1}.** \`${String(s.i || "???").replace(/[^A-Z0-9]/gi, "").slice(0, 3)}\` — **${pts(s.p)}**` +
      `  ${s.team || "?"} over ${s.opp || "?"} ${s.pf ?? "?"}-${s.pa ?? "?"}` +
      (Date.now() - Number(s.ts || 0) < WEEK_MS ? "  ✨" : "");
    return {
      title: "🏈 Go get it · top of the board",
      color: 0xE24B4A,
      description: top.map(line).join("\n"),
      fields: [{
        name: fresh ? `${fresh} new this week` : "Nobody moved it this week",
        value: `Beat **${pts(top[0].p)}** at crownorclown.com — one series, DraftKings scoring, your team against a division rival.`
      }]
    };
  } catch { return null; }
}

function embed(label, color, w, r) {
  const f = [
    { name: "👑 CROWN", value: `**${nm(r.crown)}**\n${pts(r.crown.pf)}`, inline: true },
    { name: "🤡 CLOWN", value: `**${nm(r.clown)}**\n${pts(r.clown.pf)}`, inline: true },
    { name: "Came down to it", value: `${nm(r.close.win)} over ${nm(r.close.lose)} by **${pts(r.close.gap)}**`, inline: false },
    { name: "Beatdown", value: `${nm(r.blow.win)} over ${nm(r.blow.lose)} by **${pts(r.blow.gap)}**`, inline: false }
  ];
  // Only worth saying when the loser actually put up a number — otherwise it's just the clown again.
  if (r.robbed.lose.pf > r.crown.pf * 0.82 && r.robbed.lose !== r.clown)
    f.push({ name: "Robbed", value: `${nm(r.robbed.lose)} scored **${pts(r.robbed.lose.pf)}** and lost`, inline: false });
  // Every stock ESPN logo is an SVG and Discord won't render those in an embed, so the crown's
  // logo only shows for someone who uploaded their own. Right now that's nobody; it costs a
  // line to be ready for the first person who does.
  const raster = /\.(png|jpe?g|gif|webp)(\?|$)/i.test(r.crown.logo || "");
  return { title: `${label} · Week ${w}`, color, thumbnail: raster ? { url: r.crown.logo } : undefined, fields: f };
}

const boards = await Promise.all(LEAGUES.map(async ([label, id, color]) => ({ label, color, ...await board(id) })));

// Everybody plays the same NFL week, so settle on the newest week all three boards have finished.
const forced = arg("week") ? Number(arg("week")) : null;
const week = forced || Math.max(0, ...boards[0].done.filter(w => boards.every(b => b.done.includes(w))));
if (!week) { console.log("No completed week on all three boards yet. Nothing to post."); process.exit(0); }

const embeds = [];
for (const b of boards) {
  const r = readWeek(b, week);
  if (r) embeds.push(embed(b.label, b.color, week, r));
}
if (!embeds.length) { console.log(`Week ${week} had no scored matchups. Nothing to post.`); process.exit(0); }

const game = await gameBoard();
if (game) embeds.push(game);

embeds[embeds.length - 1].footer = { text: "No card in the pack yet? Type /intro — takes a minute. Shopping somebody? /block already knows your roster." };

const body = { username: "Crown or Clown", content: `**Week ${week} is in the books.**`, embeds, allowed_mentions: { parse: [] } };

if (DRY) { console.log(JSON.stringify(body, null, 2)); process.exit(0); }
const hook = process.env.WEBHOOK_WEEKLY;
if (!hook) { console.error("WEBHOOK_WEEKLY isn't set."); process.exit(1); }
const res = await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
if (!res.ok) { console.error(`Discord said no (${res.status}): ${await res.text()}`); process.exit(1); }
console.log(`Posted week ${week}.`);
