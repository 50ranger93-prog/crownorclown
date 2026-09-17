// Thursday's polls. One per board, built from that league's own standings and this week's own
// matchups, so the question is never the same twice and never the same in two leagues at once.
//
// A poll is the lowest-effort thing on Discord — one tap, no typing, no opinion to defend. The
// people who will never post a message will absolutely vote, which makes this the cheapest way
// to find out the server isn't actually dead.
//
//   node tools/poll-post.mjs --dry           print what each board would get
//   node tools/poll-post.mjs --week 3        force the week
//   node tools/poll-post.mjs --per 2         two polls a board instead of one
//   node tools/poll-post.mjs                 post them

// Each board's poll goes in that board's own room. A Board 2 question in front of Board 1 is
// twelve names nobody recognises, which is how a poll gets scrolled past.
const LEAGUES = [
  ["Board 1", "951407474", "WEBHOOK_LEAGUE1"],
  ["Board 2", "1963204215", "WEBHOOK_LEAGUE2"],
  ["Board 3", "976183547", "WEBHOOK_LEAGUE3"]
];

// A second poll a board goes somewhere everyone can see it instead of doubling up in the same
// room, rotating so it isn't always the same channel. Only used with --per 2.
const SHARED = ["WEBHOOK_TRASH", "WEBHOOK_WAIVERS", "WEBHOOK_GENERAL"];
const SEASON = 2026;
const HOURS = 72;               // opens Thursday, closes Sunday
const A_MAX = 55;               // Discord's cap on answer text
const arg = n => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : null; };
const DRY = process.argv.includes("--dry");
const PER = Math.min(2, Math.max(1, Number(arg("per") || 1)));

const clean = s => String(s || "").replace(/[*_`~|]/g, "").trim();
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const ans = (text, emoji) => ({ text: cut(clean(text), A_MAX), ...(emoji ? { emoji: { name: emoji } } : {}) });

async function league(id) {
  const r = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${id}?view=mMatchupScore&view=mTeam`);
  if (!r.ok) throw new Error(`ESPN ${r.status} on league ${id}`);
  const d = await r.json();
  const teams = (d.teams || []).map(t => {
    const o = (t.record && t.record.overall) || {};
    return { id: t.id, name: clean(t.name), w: o.wins || 0, l: o.losses || 0, pf: o.pointsFor || 0, pa: o.pointsAgainst || 0 };
  });
  const at = Object.fromEntries(teams.map(t => [t.id, t]));
  const week = Number(arg("week")) || d.status.currentMatchupPeriod;
  const games = (d.schedule || [])
    .filter(m => m.matchupPeriodId === week && m.away)
    .map(m => ({ home: at[m.home.teamId], away: at[m.away.teamId] }))
    .filter(g => g.home && g.away);
  return { teams, games, week };
}

// Every template returns null when the league can't support it yet (week 1 has no records to
// argue about), and the picker just moves to the next one.
const TEMPLATES = [
  (L, b) => L.games.length < 2 ? null : {
    q: `${b}: which one comes down to the last play?`,
    a: L.games.slice(0, 8).map(g => ans(`${cut(g.home.name, 24)} vs ${cut(g.away.name, 24)}`, "🔥"))
  },
  (L, b) => {
    const top = [...L.teams].sort((x, y) => y.pf - x.pf).slice(0, 4);
    return { q: `${b}: who hangs the biggest number this week?`, a: top.map(t => ans(t.name, "👑")) };
  },
  (L, b) => {
    const bot = [...L.teams].sort((x, y) => x.pf - y.pf).slice(0, 4);
    return { q: `${b}: who gets run off the field this week?`, a: bot.map(t => ans(t.name, "🤡")) };
  },
  (L, b) => {
    const best = [...L.teams].sort((x, y) => (y.w - y.l) - (x.w - x.l) || y.pf - x.pf)[0];
    if (!best || best.w + best.l < 2) return null;
    return {
      q: `${b}: ${cut(best.name, 40)} is ${best.w}-${best.l}. For real or fraud?`,
      a: [ans("For real, that's the best team", "✅"), ans("Fraud, easy schedule", "🚩"), ans("Ask me in three weeks", "🤷")]
    };
  },
  (L, b) => {
    const dogs = L.games.map(g => {
      const [fav, dog] = (g.home.w - g.home.l) >= (g.away.w - g.away.l) ? [g.home, g.away] : [g.away, g.home];
      return { fav, dog, gap: (fav.w - fav.l) - (dog.w - dog.l) };
    }).filter(x => x.gap > 0).sort((x, y) => y.gap - x.gap).slice(0, 4);
    if (dogs.length < 2) return null;
    return { q: `${b}: which underdog wins outright?`, a: dogs.map(x => ans(`${cut(x.dog.name, 22)} over ${cut(x.fav.name, 22)}`, "🐶")) };
  },
  (L, b) => {
    const unlucky = [...L.teams].filter(t => t.w + t.l > 1).sort((x, y) => y.pa - x.pa).slice(0, 4);
    if (unlucky.length < 3) return null;
    return { q: `${b}: who's the unluckiest team so far?`, a: unlucky.map(t => ans(`${t.name} (${t.w}-${t.l})`, "🎲")) };
  },
  (L, b) => {
    // Deterministic shuffle off the week, so it isn't the same four names every time it comes up.
    const seeded = [...L.teams].sort((x, y) => ((x.id * 37 + L.week * 11) % 101) - ((y.id * 37 + L.week * 11) % 101));
    return { q: `${b}: who makes the first real trade?`, a: seeded.slice(0, 4).map(t => ans(t.name, "🤝")) };
  }
];

function pick(L, label, boardIdx, nth) {
  // Offset by the board so no two leagues get the same question in the same week, and by the
  // week so no league gets the same question two weeks running.
  const start = (L.week + boardIdx * 2 + nth * 3) % TEMPLATES.length;
  for (let i = 0; i < TEMPLATES.length; i++) {
    const t = TEMPLATES[(start + i) % TEMPLATES.length](L, label);
    if (t && t.a.length >= 2) return { ...t, a: t.a.slice(0, 10) };
  }
  return null;
}

async function send(hook, poll) {
  const body = {
    username: "Crown or Clown",
    poll: { question: { text: cut(poll.q, 300) }, answers: poll.a.map(a => ({ poll_media: a })), duration: HOURS, allow_multiselect: false }
  };
  let r = await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (r.ok) return "poll";
  // If this webhook or channel won't take a native poll, the question is still worth asking.
  const txt = await r.text();
  console.error(`  poll refused (${r.status}): ${txt.slice(0, 200)} — falling back to a message`);
  const lines = poll.a.map((a, i) => `${i + 1}. ${a.text}`).join("\n");
  r = await fetch(hook, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "Crown or Clown", content: `**${poll.q}**\n${lines}\n-# React with the number.`, allowed_mentions: { parse: [] } })
  });
  if (!r.ok) throw new Error(`Discord said no (${r.status}): ${(await r.text()).slice(0, 200)}`);
  return "message";
}

const ROOM_LABEL = { WEBHOOK_LEAGUE1: "#expansion-league", WEBHOOK_LEAGUE2: "#expansion-league-2", WEBHOOK_LEAGUE3: "#expansion-league-3", WEBHOOK_TRASH: "#trash-talk", WEBHOOK_WAIVERS: "#waivers-and-lineups", WEBHOOK_GENERAL: "#general", WEBHOOK_CROWN: "#crown-and-vest" };
const shared = SHARED.filter(v => process.env[v]);

for (const [i, [label, id, own]] of LEAGUES.entries()) {
  const L = await league(id);
  for (let n = 0; n < PER; n++) {
    const poll = pick(L, label, i, n);
    if (!poll) { console.log(`${label}: nothing to ask yet.`); continue; }
    const room = n === 0
      ? (process.env[own] ? own : (shared[0] || (process.env.WEBHOOK_CROWN ? "WEBHOOK_CROWN" : null)))
      : (shared.length ? shared[(L.week + i) % shared.length] : (process.env[own] ? own : null));
    if (DRY) {
      console.log(`\n${label} (week ${L.week}) → ${room ? ROOM_LABEL[room] || room : "nowhere — no webhook set"}\n  ${poll.q}`);
      poll.a.forEach(a => console.log(`   - ${a.emoji ? a.emoji.name + " " : ""}${a.text}`));
      continue;
    }
    if (!room) { console.error(`${label}: no poll webhook configured.`); process.exitCode = 1; continue; }
    console.log(`${label} → ${room}: posted as ${await send(process.env[room], poll)}.`);
  }
}
