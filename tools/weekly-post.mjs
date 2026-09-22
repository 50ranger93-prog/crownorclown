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
//   node tools/weekly-post.mjs --force          post even if that week already went out
//   node tools/weekly-post.mjs                  post it (needs WEBHOOK_CROWN)
//
// The week is claimed by key before anything is sent, so a cron landing three hours late can't
// repeat a week that already went out by hand. See tools/posted-state.mjs.

const LEAGUES = [
  ["Board 1", "951407474", 0xFFC62F],
  ["Board 2", "1963204215", 0x00A8FC],
  ["Board 3", "976183547", 0x1D9E75]
];
const SEASON = 2026;
import { has, claim, release, enabled as stateEnabled } from "./posted-state.mjs";

const arg = n => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : null; };
const DRY = process.argv.includes("--dry");
const FORCE = process.argv.includes("--force");
const EDIT = process.argv.includes("--edit");   // fix an already-posted week in place, no repost
const pts = n => (Math.round(n * 10) / 10).toFixed(1);
// Margins carry two decimals. Scores are DraftKings 2-decimal, so a 0.04 game rounded to one
// decimal reads "by 0.0" — which is exactly the bug this fixes.
const gp = n => (Math.round(n * 100) / 100).toFixed(2);

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

// Every stock ESPN logo is an SVG and Discord won't render those in an embed, so a logo only
// shows for someone who uploaded their own. Right now that's nobody; it costs a line to be
// ready for the first person who does.
const thumb = t => (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(t.logo || "") ? { url: t.logo } : undefined);

// The week splits in two. What you'd want your name on goes to #crown-and-vest; what you
// wouldn't goes to #hall-of-shame. "Robbed" sits with the crowns on purpose — hanging 200 and
// losing anyway is bad luck, not a bad team, and it reads as an insult in the wrong room.
function crownEmbed(label, color, w, r) {
  const f = [{ name: "👑 CROWN", value: `**${nm(r.crown)}** — ${pts(r.crown.pf)}`, inline: false },
             { name: "Came down to it", value: `${nm(r.close.win)} over ${nm(r.close.lose)} by **${gp(r.close.gap)}**`, inline: false }];
  if (r.robbed.lose.pf > r.crown.pf * 0.82 && r.robbed.lose !== r.clown)
    f.push({ name: "Robbed", value: `${nm(r.robbed.lose)} scored **${pts(r.robbed.lose.pf)}** and lost`, inline: false });
  return { title: `${label} · Week ${w}`, color, thumbnail: thumb(r.crown), fields: f };
}

function shameEmbed(label, color, w, r) {
  return {
    title: `${label} · Week ${w}`, color, thumbnail: thumb(r.clown),
    fields: [{ name: "🤡 CLOWN", value: `**${nm(r.clown)}** — ${pts(r.clown.pf)}`, inline: false },
             { name: "Run off the field", value: `${nm(r.blow.win)} over ${nm(r.blow.lose)} by **${gp(r.blow.gap)}**`, inline: false }]
  };
}

const boards = await Promise.all(LEAGUES.map(async ([label, id, color]) => ({ label, color, ...await board(id) })));

// Everybody plays the same NFL week, so settle on the newest week all three boards have finished.
const forced = arg("week") ? Number(arg("week")) : null;
const week = forced || Math.max(0, ...boards[0].done.filter(w => boards.every(b => b.done.includes(w))));
if (!week) { console.log("No completed week on all three boards yet. Nothing to post."); process.exit(0); }

const crowns = [], shames = [];
for (const b of boards) {
  const r = readWeek(b, week);
  if (!r) continue;
  crowns.push(crownEmbed(b.label, b.color, week, r));
  shames.push(shameEmbed(b.label, 0x88632A, week, r));
}
if (!crowns.length) { console.log(`Week ${week} had no scored matchups. Nothing to post.`); process.exit(0); }

const game = await gameBoard();
if (game) crowns.push(game);
crowns[crowns.length - 1].footer = { text: "No card in the pack yet? Type /intro — takes a minute. Shopping somebody? /block already knows your roster." };

const CROWN = process.env.WEBHOOK_CROWN;
const SHAME = process.env.WEBHOOK_SHAME;

// With no shame hook the clowns ride along with the crowns rather than vanishing, so a missing
// secret costs you a channel, never a result.
const posts = SHAME
  ? [[CROWN, `**Week ${week} is in the books.**`, crowns], [SHAME, `**Week ${week}.** Somebody has to be down here.`, shames]]
  : [[CROWN, `**Week ${week} is in the books.**`, crowns.concat(shames)]];

if (DRY) {
  for (const [, content, embeds] of posts) console.log(JSON.stringify({ content, embeds }, null, 2));
  process.exit(0);
}
if (!CROWN) { console.error("WEBHOOK_CROWN isn't set."); process.exit(1); }

// --edit: correct a week that already went out, in place, without posting anything new. A webhook
// message can only be edited through its own webhook token, and the id was never stored (the POST
// didn't use ?wait), so: read the webhook to learn its channel, have the bot find this week's
// message in that channel, then PATCH it. If the message can't be found, say so and stop — never
// fall back to posting a duplicate.
if (EDIT) {
  const BOT = process.env.DISCORD_BOT_TOKEN;
  if (!BOT) { console.error("DISCORD_BOT_TOKEN isn't set — can't locate the message to edit."); process.exit(1); }
  const API = "https://discord.com/api/v10";
  let edited = 0, missing = 0;
  for (const [hook, content, embeds] of posts) {
    if (!hook) { console.log("  a channel's webhook isn't set — skipping it."); continue; }
    const wh = await fetch(hook).then(r => r.ok ? r.json() : null).catch(() => null);
    if (!wh || !wh.channel_id) { console.error("  couldn't read a webhook to find its channel — skipping."); missing++; continue; }
    const msgs = await fetch(`${API}/channels/${wh.channel_id}/messages?limit=30`, { headers: { Authorization: `Bot ${BOT}` } })
      .then(r => r.ok ? r.json() : []).catch(() => []);
    const target = msgs.find(m => (m.content || "") === content)
                || msgs.find(m => (m.embeds || []).some(e => (e.title || "").includes(`Week ${week}`)));
    if (!target) { console.error(`  no existing "Week ${week}" message in channel ${wh.channel_id} — NOT posting a new one.`); missing++; continue; }
    const res = await fetch(`${hook}/messages/${target.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, embeds, allowed_mentions: { parse: [] } })
    });
    if (!res.ok) { console.error(`  edit failed on ${target.id} (${res.status}): ${await res.text()}`); missing++; continue; }
    console.log(`  edited message ${target.id} in channel ${wh.channel_id}`);
    edited++;
  }
  console.log(`Edited ${edited} message${edited === 1 ? "" : "s"} in place${missing ? `, ${missing} could not be edited` : ""} — nothing reposted.`);
  process.exit(missing ? 1 : 0);
}
if (!stateEnabled()) console.warn("No GITHUB_TOKEN — posting without the repeat guard.");

const key = `week:${SEASON}:w${week}`;
if (!FORCE && await has(key)) { console.log(`Week ${week} already went out. Skipping.`); process.exit(0); }
if (!FORCE && !await claim(key)) { console.log(`Another run just claimed week ${week}. Skipping.`); process.exit(0); }

let sent = 0;
try {
  for (const [hook, content, embeds] of posts) {
    const res = await fetch(hook, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "Crown or Clown", content, embeds, allowed_mentions: { parse: [] } })
    });
    if (!res.ok) throw new Error(`Discord said no (${res.status}): ${await res.text()}`);
    sent++;
  }
} catch (e) {
  // Only hand the key back if nothing went out. Half a week posted is annoying; a retry that
  // posts the crowns a second time is worse, so a partial send stays claimed and gets fixed
  // with --force.
  if (!FORCE && sent === 0) await release(key);
  console.error(e.message + (sent ? ` (${sent} of ${posts.length} already sent — re-run with --force once fixed)` : ""));
  process.exit(1);
}
console.log(`Posted week ${week} to ${posts.length} channel${posts.length > 1 ? "s" : ""}.`);
