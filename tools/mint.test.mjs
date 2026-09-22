#!/usr/bin/env node
// Proof for the card mint: token ids mean one card forever, rarity is earned rather than rolled,
// and nobody's team name can climb out of the SVG. Zero-dep, no network, no ESPN.
// Run: node tools/mint.test.mjs

import assert from "node:assert/strict";
import {
  KIND, LEAGUES, RARITY,
  tokenId, decodeToken, esc, wrap, fitSize, monogram, cardSvg, metadataFor,
  playerRarity, momentStory, teamCards, crownClownCards, momentCards, playerCards,
} from "./mint.mjs";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("  ok  " + name); };

/* ── mock data, shaped exactly like the real thing ───────────────────────────────────────── */

const LEAGUE = {
  index: 1, name: "League 1",
  teams: [
    { name: "REDBIRDSKELLY",            logo: "https://g.espncdn.com/a.png", wins: 2, losses: 0, ties: 0, pf: 241.6, pa: 190.2, manager: "kelly", rank: 1 },
    { name: "Payton's Pointed Team",    logo: "",                            wins: 0, losses: 2, ties: 0, pf: 150.1, pa: 233.8, manager: "payton", rank: 4 },
    { name: "AREA 51",                  logo: "",                            wins: 1, losses: 1, ties: 0, pf: 180.0, pa: 181.0, manager: "",       rank: 2 },
    { name: "Toxic Toots",              logo: "",                            wins: 1, losses: 1, ties: 0, pf: 175.5, pa: 178.4, manager: "rob",    rank: 3 },
  ],
};

const game = (o) => ({
  id: "4018000", away: "NE", home: "SEA", state: "post", aScore: 10, hScore: 13,
  venue: "Lumen Field", city: "Seattle, WA", indoor: false,
  line: { spread: "SEA -3", total: 44.5, book: "DraftKings" },
  weather: { text: "Overcast", temp: 77, wind: 6, precip: 0, src: "actual" },
  top: [], dst: [], ...o,
});

const WEEK = {
  season: 2026, week: 2,
  games: [
    game({ id: "401872656", away: "NE", home: "SEA", aScore: 10, hScore: 13,
      top: [{ name: "Jaxon Smith-Njigba", team: "SEA", pos: "WR", dk: 29.2, line: "8/11 for 122, 1 TD" },
            { name: "Rhamondre Stevenson", team: "NE", pos: "RB", dk: 14.5, line: "18 car, 51 rush" }],
      dst: [{ name: "SEA D/ST", team: "SEA", pos: "DST", dk: 13, line: "3 sk, 3 int" }] }),
    game({ id: "401872947", away: "NYG", home: "LAR", state: "in", aScore: 0, hScore: 0,
      top: [{ name: "Davante Adams", team: "LAR", pos: "WR", dk: 3, line: "1/2 for 20" }] }),
    game({ id: "401872300", away: "KC", home: "BUF", aScore: 38, hScore: 35, line: { spread: "BUF -7", total: 52.5 },
      top: [{ name: "Patrick Mahomes", team: "KC", pos: "QB", dk: 34.8, line: "31/40 for 402, 4 TD" }] }),
  ],
};

/* ── token ids ───────────────────────────────────────────────────────────────────────────── */

test("a token id decodes back to the card it names", () => {
  for (const kind of Object.values(KIND))
    for (const week of [0, 1, 9, 18, 99])
      for (const league of [0, 1, 3, 9])
        for (const slot of [0, 1, 42, 999]) {
          const id = tokenId({ kind, season: 2026, week, league, slot });
          assert.deepEqual(decodeToken(id), { kind, season: 2026, week, league, slot });
          assert.ok(Number.isSafeInteger(id), `${id} must stay an exact integer`);
        }
});

test("out-of-range parts are refused rather than silently folded into a neighbour", () => {
  for (const bad of [{ slot: 1000 }, { league: 10 }, { week: 100 }, { kind: 10 }, { season: 10000 },
                     { slot: -1 }, { slot: 1.5 }])
    assert.throws(() => tokenId({ kind: 1, season: 2026, week: 1, league: 1, slot: 0, ...bad }), RangeError);
});

test("the id is the card's identity, not its position — shuffling the input changes nothing", () => {
  const ids = (teams) => teamCards({ ...LEAGUE, teams }, 2026)
    .map(c => [c.title, c.tokenId]).sort((a, z) => a[0].localeCompare(z[0]));
  const shuffled = [LEAGUE.teams[2], LEAGUE.teams[0], LEAGUE.teams[3], LEAGUE.teams[1]];
  assert.deepEqual(ids(LEAGUE.teams), ids(shuffled));
});

test("a full mint hands out no id twice", () => {
  const all = [
    ...teamCards(LEAGUE, 2026),
    ...crownClownCards(LEAGUE, 1, LEAGUE.teams.map((t, i) => ({ name: t.name, pts: 100 + i * 7 })), 2026),
    ...crownClownCards(LEAGUE, 2, LEAGUE.teams.map((t, i) => ({ name: t.name, pts: 130 - i * 5 })), 2026),
    ...momentCards(WEEK, 2026),
    ...playerCards(WEEK, 2026),
  ];
  const ids = all.map(c => c.tokenId);
  assert.equal(new Set(ids).size, ids.length, "every card needs its own id");
  assert.ok(all.length > 10, "the mock should actually produce a collection");
});

test("the three leagues keep their index, so an id never points at another league", () => {
  assert.deepEqual(LEAGUES.map(l => l.index), [1, 2, 3]);
  for (const l of LEAGUES) assert.equal(decodeToken(tokenId({ kind: KIND.crown, season: 2026, week: 3, league: l.index })).league, l.index);
});

/* ── rarity is earned ────────────────────────────────────────────────────────────────────── */

test("player rarity climbs with the actual DraftKings score", () => {
  assert.equal(playerRarity(31), "legendary");
  assert.equal(playerRarity(30), "legendary");
  assert.equal(playerRarity(29.9), "epic");
  assert.equal(playerRarity(24), "epic");
  assert.equal(playerRarity(18), "rare");
  assert.equal(playerRarity(12), "uncommon");
  assert.equal(playerRarity(11.9), "common");
  assert.equal(playerRarity(0), "common");
});

test("a moment's tier comes from what happened in the game", () => {
  assert.equal(momentStory(game({ aScore: 21, hScore: 21 })).rarity, "legendary");          // tie
  assert.equal(momentStory(game({ aScore: 38, hScore: 35, line: { spread: "SEA -3" } })).rarity, "epic");  // 73 combined
  assert.equal(momentStory(game({ aScore: 13, hScore: 10, line: {} })).rarity, "epic");      // 3-point game
  assert.equal(momentStory(game({ aScore: 3, hScore: 41, line: {} })).rarity, "rare");       // blowout
  assert.equal(momentStory(game({ aScore: 10, hScore: 13, line: {} })).rarity, "epic");      // one score
  assert.equal(momentStory(game({ aScore: 6, hScore: 17, line: {} })).rarity, "uncommon");   // rock fight
});

test("an upset is read off the line, and the favourite holding is not one", () => {
  // SEA laid 10 and lost: the dog won by the book's own number.
  const upset = momentStory(game({ away: "NE", home: "SEA", aScore: 24, hScore: 20, line: { spread: "SEA -10" } }));
  assert.equal(upset.rarity, "legendary");
  assert.match(upset.story, /Upset/);
  // Same game, favourite wins — no upset claimed.
  const held = momentStory(game({ away: "NE", home: "SEA", aScore: 20, hScore: 24, line: { spread: "SEA -10" } }));
  assert.doesNotMatch(held.story, /Upset/);
  // A spread naming a team that isn't playing can't be used to invent an upset.
  const junk = momentStory(game({ away: "NE", home: "SEA", aScore: 24, hScore: 20, line: { spread: "DAL -10" } }));
  assert.doesNotMatch(junk.story, /Upset/);
});

test("the crown goes to the high score and the clown to the low, and one of each exists", () => {
  const scores = [{ name: "AREA 51", pts: 88.4 }, { name: "REDBIRDSKELLY", pts: 141.2 }, { name: "Toxic Toots", pts: 119.0 }];
  const [crown, clown] = crownClownCards(LEAGUE, 4, scores, 2026);
  assert.equal(crown.title, "REDBIRDSKELLY");
  assert.equal(crown.rarity, "crown");
  assert.equal(clown.title, "AREA 51");
  assert.equal(clown.rarity, "clown");
  assert.notEqual(crown.tokenId, clown.tokenId);
  // Re-running the same week mints the same two ids, not two more cards.
  const again = crownClownCards(LEAGUE, 4, scores.slice().reverse(), 2026);
  assert.deepEqual(again.map(c => c.tokenId), [crown.tokenId, clown.tokenId]);
});

test("a week nobody has played yet mints nothing", () => {
  assert.deepEqual(crownClownCards(LEAGUE, 5, [], 2026), []);
  assert.deepEqual(crownClownCards(LEAGUE, 5, [{ name: "solo", pts: 10 }], 2026), []);
});

/* ── only things that actually finished ──────────────────────────────────────────────────── */

test("a game still being played gets no card", () => {
  const cards = momentCards(WEEK, 2026);
  assert.equal(cards.length, 2, "two of the three mock games are final");
  assert.ok(!cards.some(c => c.title.includes("LAR")), "the in-progress game must not be minted");
});

test("players are taken only from finished games, best score per player, best first", () => {
  const cards = playerCards(WEEK, 2026);
  assert.ok(!cards.some(c => c.title === "Davante Adams"), "his game is still in progress");
  const dk = cards.map(c => Number(c.attributes.find(a => a.trait_type === "DK points").value));
  assert.deepEqual(dk, dk.slice().sort((a, z) => z - a), "best score first");
  assert.equal(cards[0].title, "Patrick Mahomes");
  assert.equal(cards[0].rarity, "legendary");
  assert.equal(new Set(cards.map(c => c.title)).size, cards.length, "one card per player");
});

test("the player cap holds", () => {
  const many = { season: 2026, week: 3, games: [game({ id: "x", top: Array.from({ length: 60 }, (_, i) => ({ name: "P" + i, team: "NE", pos: "WR", dk: 60 - i, line: "x" })) })] };
  assert.equal(playerCards(many, 2026).length, 24);
  assert.equal(playerCards(many, 2026, 5).length, 5);
});

/* ── nobody's team name escapes the card ─────────────────────────────────────────────────── */

const HOSTILE = `</text><script>alert(1)</script><text x="0" y="0">&`;

test("escaping covers every character that means something to XML", () => {
  assert.equal(esc(`<&>"'`), "&lt;&amp;&gt;&quot;&apos;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(0), "0");
});

test("a hostile team name draws as a silly name and nothing more", () => {
  const [card] = teamCards({ ...LEAGUE, teams: [{ ...LEAGUE.teams[0], name: HOSTILE, manager: HOSTILE }] }, 2026);
  const svg = cardSvg({ ...card, logo: "" });
  assert.ok(!svg.includes("<script"), "no element may come out of a name");
  assert.ok(!svg.includes("alert(1)</"), "no tag may close early");
  assert.ok(svg.includes("&lt;"), "the name is still there, escaped");
  // Every & in the document is the start of a real entity — that is what keeps it parseable.
  for (const m of svg.matchAll(/&(?!(amp|lt|gt|quot|apos|#\d+);)/g))
    assert.fail(`raw ampersand at ${m.index}: ${svg.slice(m.index, m.index + 24)}`);
});

test("a hostile stat line and flavour text are escaped too", () => {
  const svg = cardSvg({ tokenId: 1, badge: HOSTILE, rarity: "rare", title: HOSTILE, subtitle: HOSTILE,
    stats: [{ k: HOSTILE, v: HOSTILE }], flavor: HOSTILE, logo: "" });
  assert.ok(!svg.includes("<script"));
  assert.ok(!/<text[^>]*>[^<]*<\/text>[^<]*alert/.test(svg));
});

test("a logo URL is escaped into the href, so a crafted one cannot add an attribute", () => {
  const svg = cardSvg({ tokenId: 1, badge: "x", rarity: "rare", title: "x", subtitle: "x", stats: [], flavor: "",
    logo: `data:image/png;base64,AAA" onload="alert(1)` });
  assert.ok(!svg.includes('onload="alert(1)"'), "the attribute must not break out");
  assert.ok(svg.includes("&quot;"));
});

test("control characters are dropped instead of breaking the text box", () => {
  const svg = cardSvg({ tokenId: 1, badge: "x", rarity: "rare", title: "Team\u0000\u001bName", subtitle: "x", stats: [], flavor: "", logo: "" });
  assert.ok(!/[\u0000-\u001f]/.test(svg.replace(/\n/g, "")), "no control characters survive into the card");
});

/* ── text that fits ──────────────────────────────────────────────────────────────────────── */

test("wrapping respects the line length and the line count", () => {
  const lines = wrap("the quick brown fox jumped over the extremely lazy dog and kept going", 20, 2);
  assert.equal(lines.length, 2);
  for (const l of lines) assert.ok(l.length <= 20, `"${l}" is ${l.length} long`);
  assert.match(lines[1], /…$/, "truncated text says so");
});

test("a single unbreakable word is cut, not allowed to run off the card", () => {
  const [line] = wrap("Supercalifragilisticexpialidocious", 12, 1);
  assert.ok(line.length <= 12);
  assert.match(line, /…$/);
});

test("wrapping empty text yields no lines", () => {
  assert.deepEqual(wrap("", 20, 2), []);
  assert.deepEqual(wrap(null, 20, 2), []);
});

test("a long headline shrinks instead of overhanging", () => {
  assert.equal(fitSize("short", 56, 18), 56);
  assert.ok(fitSize("a team name that is far too long to fit", 56, 18) < 56);
  assert.ok(fitSize("a".repeat(400), 56, 18) >= Math.round(56 * 0.52), "there is a floor");
});

test("a missing logo falls back to initials", () => {
  assert.equal(monogram("Toxic Toots"), "TT");
  assert.equal(monogram("REDBIRDSKELLY"), "RE");
  assert.equal(monogram(""), "??");
  assert.equal(monogram("   "), "??");
});

/* ── metadata a marketplace can actually read ────────────────────────────────────────────── */

test("every card produces valid ERC-721 metadata", () => {
  const all = [...teamCards(LEAGUE, 2026), ...momentCards(WEEK, 2026), ...playerCards(WEEK, 2026),
               ...crownClownCards(LEAGUE, 1, [{ name: "a", pts: 120 }, { name: "b", pts: 80 }], 2026)];
  for (const c of all) {
    const m = metadataFor(c, "https://example.com/c");
    assert.ok(m.name && typeof m.name === "string", "a card needs a name");
    assert.ok(m.description && m.description.length > 20, `${m.name} needs a real description`);
    assert.equal(m.image, `https://example.com/c/img/${c.tokenId}.svg`);
    assert.match(m.background_color, /^[0-9A-F]{6}$/, "background_color is bare 6-digit hex");
    assert.ok(Array.isArray(m.attributes) && m.attributes.length >= 4);
    for (const a of m.attributes) {
      assert.ok(a.trait_type, `${m.name} has a nameless trait`);
      assert.ok(a.value !== undefined && a.value !== null && a.value !== "", `${m.name}/${a.trait_type} is empty`);
      if (a.display_type === "number") assert.ok(Number.isFinite(Number(a.value)), `${a.trait_type} must be a number`);
    }
    assert.ok(m.attributes.some(a => a.trait_type === "Rarity"), "rarity is a trait people filter on");
    assert.ok(RARITY[c.rarity], `unknown rarity ${c.rarity}`);
  }
});

test("the base URI is swappable, which is the whole on-chain story", () => {
  const [c] = momentCards(WEEK, 2026);
  assert.equal(metadataFor(c, "ipfs://bafyCID").image, `ipfs://bafyCID/img/${c.tokenId}.svg`);
});

test("a card draws the same way twice — the mint is reproducible", () => {
  const [a] = momentCards(WEEK, 2026), [b] = momentCards(WEEK, 2026);
  assert.equal(cardSvg({ ...a, logo: "" }), cardSvg({ ...b, logo: "" }));
  assert.deepEqual(metadataFor(a, "x"), metadataFor(b, "x"));
});

test("a card with no stats still draws a well-formed document", () => {
  const svg = cardSvg({ tokenId: 1, badge: "x", rarity: "common", title: "x", subtitle: "x", stats: [], flavor: "", logo: "" });
  assert.match(svg, /^<svg[\s\S]+<\/svg>\n$/);
  assert.equal((svg.match(/<g /g) || []).length, (svg.match(/<\/g>/g) || []).length);
});

/* ── the artwork says the right thing ────────────────────────────────────────────────────── */

test("a moment card draws the scoreboard, with the winner lit and the loser dimmed", () => {
  const [card] = momentCards({ season: 2026, week: 1, games: [game({ away: "NE", home: "SEA", aScore: 10, hScore: 13 })] }, 2026);
  const svg = cardSvg({ ...card, logo: "" });
  assert.match(svg, />NE</);
  assert.match(svg, />SEA</);
  assert.match(svg, />10</);
  assert.match(svg, />13</);
  const dim = "#6d7688";
  // NE lost, so NE's two numbers carry the dim fill and SEA's do not.
  const ne = svg.slice(svg.indexOf(">NE<") - 120, svg.indexOf(">NE<"));
  const sea = svg.slice(svg.indexOf(">SEA<") - 120, svg.indexOf(">SEA<"));
  assert.ok(ne.includes(dim), "the losing side is dimmed");
  assert.ok(!sea.includes(dim), "the winning side is not");
});

test("a tie lights both sides rather than picking one", () => {
  const [card] = momentCards({ season: 2026, week: 1, games: [game({ away: "NE", home: "SEA", aScore: 21, hScore: 21 })] }, 2026);
  const svg = cardSvg({ ...card, logo: "" });
  assert.ok(!svg.includes("#6d7688") || svg.split("#6d7688").length - 1 <= 1, "a tie has no loser to dim");
});

test("a moment card's rows add information instead of repeating the scoreboard", () => {
  const [card] = momentCards({ season: 2026, week: 1, games: [game({ away: "NE", home: "SEA", aScore: 10, hScore: 13 })] }, 2026);
  const keys = card.stats.map(s => s.k);
  assert.ok(!keys.includes("Final"), "the final is already drawn above the title");
  assert.deepEqual(card.stats.find(s => s.k === "Result").v, "SEA by 3");
  assert.deepEqual(card.stats.find(s => s.k === "Combined").v, "23 points");
});

test("a crown card names the team that came closest, and a clown card the one just above it", () => {
  const scores = [{ name: "AREA 51", pts: 88.4 }, { name: "REDBIRDSKELLY", pts: 141.2 },
                  { name: "Toxic Toots", pts: 119.0 }, { name: "Payton's Pointed Team", pts: 95.2 }];
  const [crown, clown] = crownClownCards(LEAGUE, 4, scores, 2026);
  assert.equal(crown.stats.find(s => s.k === "Next closest").v, "Toxic Toots 119.0");
  assert.equal(clown.stats.find(s => s.k === "Next lowest").v, "Payton's Pointed Team 95.2");
});

test("a hostile team abbreviation cannot escape the scoreboard artwork", () => {
  const [card] = momentCards({ season: 2026, week: 1, games: [game({ away: '"><script>x</script>', home: "SEA", aScore: 3, hScore: 7 })] }, 2026);
  const svg = cardSvg({ ...card, logo: "" });
  assert.ok(!svg.includes("<script"));
});

test("a player card's art is the score that earned it, not two initials", () => {
  const [card] = playerCards(WEEK, 2026);
  const svg = cardSvg({ ...card, logo: "" });
  assert.match(svg, />34\.8</, "the DraftKings score is drawn large");
  assert.match(svg, />DRAFTKINGS POINTS</);
  assert.match(svg, />QB KC</);
  assert.ok(!svg.includes(">PM<"), "no monogram where there is real art");
});

console.log(`\n${passed} tests passed.`);
