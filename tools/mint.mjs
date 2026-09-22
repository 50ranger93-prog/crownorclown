#!/usr/bin/env node
/**
 * Crown or Clown — the card mint.
 *
 * Turns the league's own data into collectible cards: a piece of SVG art plus a metadata file
 * for each one. Zero dependencies, same as everything else in tools/.
 *
 *   node tools/mint.mjs                      # every card it can build, into cards/collection
 *   node tools/mint.mjs --week 1             # just that NFL week's moments and players
 *   node tools/mint.mjs --offline            # skip ESPN; build only from weeks/<season>/*.json
 *   node tools/mint.mjs --base ipfs://CID    # point the metadata somewhere else (see "going on-chain")
 *
 * ── what gets minted ───────────────────────────────────────────────────────────────────────
 *
 *   team    one per fantasy team, per season. The manager's identity card — record, points,
 *           logo. Re-minting refreshes the numbers; the token id never moves.
 *   crown   the week's high scorer in a league. One per league per week, and that is the
 *           entire supply. Nobody can mint themselves one.
 *   clown   the week's low scorer. Same supply, less bragging.
 *   moment  an NFL game that finished — score, venue, weather, and what the line said before
 *           anyone knew.
 *   player  the week's best DraftKings scorers, with the stat line that earned it.
 *
 * ── why the art is SVG ─────────────────────────────────────────────────────────────────────
 *
 * A card has to survive being handed to somebody else. SVG is text, so the whole card lives in
 * git as a diffable file, renders crisp at any size, and needs no image library to generate.
 * Team logos are fetched once and inlined as data URIs, so a card file is self-contained: it
 * still draws correctly years later when ESPN has long since moved the image.
 *
 * ── going on-chain later ───────────────────────────────────────────────────────────────────
 *
 * Nothing here touches a blockchain, costs money, or needs a wallet. What it does is emit
 * metadata already in ERC-721 shape, so minting is a later add-on and not a rewrite:
 *
 *   1. Upload cards/collection/img and cards/collection/meta somewhere content-addressed.
 *   2. Re-run with --base ipfs://<CID> so every image URI points at that upload.
 *   3. Deploy any standard ERC-721 whose tokenURI is <base>/meta/<tokenId>.json.
 *
 * Token ids are already uint256-safe and deterministic (see tokenId below), so the ids in
 * collection.json ARE the on-chain ids. manifest.json carries a sha256 of every file, which is
 * what lets you prove later that the thing on-chain is the thing that was minted here.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEASON = Number(process.env.SEASON) || 2026;
const SITE = "https://www.crownorclown.com";

// Same three leagues the rest of the bot reads. League index is part of the token id, so the
// order of this list is load-bearing: append, never reorder.
export const LEAGUES = [
  { index: 1, name: "League 1", id: 951407474 },
  { index: 2, name: "League 2", id: 1963204215 },
  { index: 3, name: "League 3", id: 976183547 },
];

/* ── token ids ─────────────────────────────────────────────────────────────────────────────
   An id has to mean the same card forever — re-running the mint must not renumber anything,
   or every card anyone saved points at something else. So the id is not a counter and not a
   hash: it is the card's identity written in decimal.

       K SSSS WW L III
       │ │    │  │ └── slot    0-999  which team / game / player, in a sorted order
       │ │    │  └───── league 0-9    0 when the card isn't league-specific
       │ │    └──────── week   0-99   0 for season-long cards
       │ └───────────── season
       └─────────────── kind

   Eleven digits, so it stays an exact integer in JS and fits a uint256 with room to spare.
   Readable too: 22026002001 is season 2026, week 2, league 1 — a crown.
────────────────────────────────────────────────────────────────────────────────────────── */

export const KIND = { team: 1, crown: 2, clown: 3, moment: 4, player: 5 };
export const KIND_OF = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k]));

export function tokenId({ kind, season, week = 0, league = 0, slot = 0 }) {
  const n = (v, hi, what) => {
    if (!Number.isInteger(v) || v < 0 || v >= hi) throw new RangeError(`${what} out of range: ${v}`);
    return v;
  };
  return n(kind, 10, "kind") * 1e10
       + n(season, 10000, "season") * 1e6
       + n(week, 100, "week") * 1e4
       + n(league, 10, "league") * 1e3
       + n(slot, 1000, "slot");
}

export function decodeToken(id) {
  const n = Number(id);
  return {
    kind: Math.floor(n / 1e10),
    season: Math.floor(n / 1e6) % 1e4,
    week: Math.floor(n / 1e4) % 100,
    league: Math.floor(n / 1e3) % 10,
    slot: n % 1000,
  };
}

/* ── rarity ────────────────────────────────────────────────────────────────────────────────
   Every tier is earned by something that actually happened, never rolled. A crown card is rare
   because exactly one team scored the most that week, not because a random number said so.
────────────────────────────────────────────────────────────────────────────────────────── */

export const RARITY = {
  common:    { label: "Common",    ink: "#8b93a3", glow: "#2a3040", bg: "#0e1016" },
  uncommon:  { label: "Uncommon",  ink: "#5dd39e", glow: "#14503a", bg: "#0b1512" },
  rare:      { label: "Rare",      ink: "#5b9cf8", glow: "#16346e", bg: "#0a0f1c" },
  epic:      { label: "Epic",      ink: "#b78cf7", glow: "#452073", bg: "#120c1c" },
  legendary: { label: "Legendary", ink: "#ff8c42", glow: "#7c3407", bg: "#190d04" },
  crown:     { label: "Crown",     ink: "#ffd83d", glow: "#8a6206", bg: "#1a1303" },
  clown:     { label: "Clown",     ink: "#ff6b6b", glow: "#7c1d1d", bg: "#190909" },
};

export function playerRarity(dk) {
  if (dk >= 30) return "legendary";
  if (dk >= 24) return "epic";
  if (dk >= 18) return "rare";
  if (dk >= 12) return "uncommon";
  return "common";
}

// A game is worth a card for a reason, and the reason goes on the card. First match wins, so
// the order here is the priority order.
export function momentStory(g) {
  const margin = Math.abs(g.hScore - g.aScore);
  const total = g.hScore + g.aScore;
  const dog = g.line && g.line.spread ? upsetSize(g) : 0;
  if (margin === 0)      return { rarity: "legendary", story: "Tie game" };
  if (dog >= 10)         return { rarity: "legendary", story: `Upset — ${dog}-point dog won` };
  if (total >= 60)       return { rarity: "epic",      story: `Shootout — ${total} combined` };
  if (margin <= 3)       return { rarity: "epic",      story: `One score — ${margin}-point game` };
  if (dog > 0)           return { rarity: "rare",      story: `Upset — ${dog}-point dog won` };
  if (margin >= 28)      return { rarity: "rare",      story: `Blowout — ${margin}-point margin` };
  if (total <= 30)       return { rarity: "uncommon",  story: `Rock fight — ${total} combined` };
  return { rarity: "common", story: "Regulation" };
}

// How big an underdog won, in points. Zero if the favourite held or the line is unreadable.
function upsetSize(g) {
  const m = /^([A-Z]{2,4})\s*-([\d.]+)$/.exec(String(g.line.spread || "").trim());
  if (!m) return 0;
  const [, fav, num] = m;
  const favScore = fav === g.home ? g.hScore : fav === g.away ? g.aScore : null;
  if (favScore === null) return 0;
  const dogScore = fav === g.home ? g.aScore : g.hScore;
  return favScore < dogScore ? Math.round(Number(num)) : 0;
}

/* ── drawing ───────────────────────────────────────────────────────────────────────────── */

// Anything that reaches the SVG came from ESPN or a Discord display name, which means it is
// somebody else's text. Escaped on the way in, every time — a team called `</text><script>`
// should draw as a silly name and nothing more.
export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Drop the characters that have no business in a card at all, then escape what's left. Control
// characters render as nothing useful and can break a line box.
const clean = (s, max = 64) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

// SVG has no text wrapping, so lines get broken here. Long words are cut rather than allowed
// to run off the card.
export function wrap(text, maxChars, maxLines = 2) {
  const words = clean(text, 400).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const next = line ? line + " " + w : w;
    if (next.length <= maxChars) { line = next; continue; }
    if (line) lines.push(line);
    line = w.length > maxChars ? w.slice(0, maxChars - 1) + "…" : w;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length + 1) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{1}$/, "…");
  }
  return lines;
}

// Shrink the headline rather than let it overhang the frame.
export function fitSize(text, base, fits) {
  const len = String(text || "").length;
  if (len <= fits) return base;
  return Math.max(Math.round(base * 0.52), Math.round(base * fits / len));
}

// Two letters to stand in for a logo that wouldn't load.
export function monogram(name) {
  const words = clean(name).split(/\s+/).filter(Boolean);
  if (!words.length) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}


/**
 * What goes in the window at the top of the card.
 *
 * A real logo when there is one. A scoreboard when the card is about a game — "NE at SEA"
 * squeezed into two initials said nothing, and the score is the entire point of a moment card.
 * Initials only as the last resort, where they actually stand for a name.
 */
function artwork(card, r, title) {
  if (card.logo) {
    return `<image href="${esc(card.logo)}" x="285" y="182" width="180" height="180" preserveAspectRatio="xMidYMid meet"/>`;
  }
  const a = card.art;
  if (a && a.type === "matchup") {
    // The winner is lit, the loser is dimmed. You can read the result without reading a word.
    const tie = a.aScore === a.hScore;
    const awayWon = a.aScore > a.hScore;
    const side = (x, team, score, won) => {
      const fill = tie || won ? r.ink : "#6d7688";
      return `<text x="${x}" y="233" text-anchor="middle" font-size="46" font-weight="700" fill="${fill}">${esc(clean(team, 4))}</text>
     <text x="${x}" y="327" text-anchor="middle" font-size="76" font-weight="700" fill="${tie || won ? "#ffffff" : "#6d7688"}">${esc(String(score))}</text>`;
    };
    return `${side(204, a.away, a.aScore, awayWon)}
     <text x="375" y="252" text-anchor="middle" font-size="26" letter-spacing="2" fill="#5e6678">AT</text>
     <line x1="375" y1="276" x2="375" y2="340" stroke="#ffffff" stroke-width="1" opacity=".12"/>
     ${side(546, a.home, a.hScore, !awayWon && !tie)}
     <text x="375" y="398" text-anchor="middle" font-size="21" letter-spacing="1.6" fill="#6d7688">${esc(clean(a.note, 40).toUpperCase())}</text>`;
  }
  if (a && a.type === "score") {
    return `<text x="375" y="300" text-anchor="middle" font-size="150" font-weight="700" fill="#ffffff">${esc(clean(a.value, 6))}</text>
     <text x="375" y="352" text-anchor="middle" font-size="22" letter-spacing="3.2" fill="${r.ink}">${esc(clean(a.label, 26).toUpperCase())}</text>
     <text x="375" y="176" text-anchor="middle" font-size="24" letter-spacing="2.4" fill="#6d7688">${esc(clean(a.note, 26).toUpperCase())}</text>`;
  }
  return `<circle cx="375" cy="275" r="88" fill="none" stroke="${r.ink}" stroke-width="3" opacity=".55"/>
     <text x="375" y="275" text-anchor="middle" dominant-baseline="central" font-size="72" font-weight="700" fill="${r.ink}" opacity=".9">${esc(monogram(title))}</text>`;
}

/**
 * One card, as an SVG document.
 *
 * card = { tokenId, kindLabel, rarity, title, subtitle, stats:[{k,v}], flavor, logo, badge }
 */
export function cardSvg(card) {
  const r = RARITY[card.rarity] || RARITY.common;
  const W = 750, H = 1050;
  const title = clean(card.title, 48);
  const titleSize = fitSize(title, 56, 18);
  const art = artwork(card, r, title);

  const rows = (card.stats || []).slice(0, 4).map((s, i) => {
    const y = 640 + i * 62;
    return `<line x1="70" y1="${y - 34}" x2="680" y2="${y - 34}" stroke="#ffffff" stroke-width="1" opacity=".08"/>
    <text x="70" y="${y}" font-size="22" letter-spacing="1.5" fill="#9aa3b2">${esc(clean(s.k, 22).toUpperCase())}</text>
    <text x="680" y="${y}" text-anchor="end" font-size="27" font-weight="700" fill="#f2f4f8">${esc(clean(s.v, 26))}</text>`;
  }).join("\n    ");

  const flavor = wrap(card.flavor || "", 52, 2)
    .map((l, i) => `<text x="375" y="${900 + i * 30}" text-anchor="middle" font-size="21" fill="#7f8899">${esc(l)}</text>`)
    .join("\n    ");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}">
  <title>${esc(card.name || title)}</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${r.glow}"/><stop offset="55%" stop-color="${r.bg}"/><stop offset="100%" stop-color="${r.bg}"/>
    </linearGradient>
    <radialGradient id="halo" cx="50%" cy="26%" r="46%">
      <stop offset="0%" stop-color="${r.ink}" stop-opacity=".26"/><stop offset="100%" stop-color="${r.ink}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <g font-family="'Helvetica Neue',Helvetica,Arial,sans-serif">
    <rect width="${W}" height="${H}" rx="34" fill="${r.bg}"/>
    <rect width="${W}" height="${H}" rx="34" fill="url(#bg)"/>
    <rect width="${W}" height="${H}" rx="34" fill="url(#halo)"/>
    <rect x="16" y="16" width="${W - 32}" height="${H - 32}" rx="24" fill="none" stroke="${r.ink}" stroke-width="3" opacity=".85"/>
    <rect x="27" y="27" width="${W - 54}" height="${H - 54}" rx="17" fill="none" stroke="${r.ink}" stroke-width="1" opacity=".3"/>

    <text x="56" y="82" font-size="23" font-weight="700" letter-spacing="3.4" fill="${r.ink}">${esc(clean(card.badge, 22).toUpperCase())}</text>
    <text x="694" y="82" text-anchor="end" font-size="20" letter-spacing="2.2" fill="#9aa3b2">${esc(r.label.toUpperCase())}</text>

    <rect x="56" y="112" width="638" height="330" rx="18" fill="#000000" opacity=".26"/>
    <rect x="56" y="112" width="638" height="330" rx="18" fill="none" stroke="${r.ink}" stroke-width="1" opacity=".25"/>
    ${art}

    <text x="375" y="512" text-anchor="middle" font-size="${titleSize}" font-weight="700" fill="#ffffff">${esc(title)}</text>
    <text x="375" y="556" text-anchor="middle" font-size="24" letter-spacing="1.2" fill="${r.ink}">${esc(clean(card.subtitle, 44))}</text>

    ${rows}
    <line x1="70" y1="${640 + (card.stats || []).slice(0, 4).length * 62 - 34}" x2="680" y2="${640 + (card.stats || []).slice(0, 4).length * 62 - 34}" stroke="#ffffff" stroke-width="1" opacity=".08"/>
    ${flavor}

    <text x="56" y="994" font-size="19" font-weight="700" letter-spacing="2.6" fill="#6c7484">CROWN OR CLOWN</text>
    <text x="694" y="994" text-anchor="end" font-size="19" letter-spacing="1.4" fill="#6c7484">#${esc(card.tokenId)}</text>
  </g>
</svg>
`;
}

/* ── metadata ──────────────────────────────────────────────────────────────────────────────
   ERC-721 metadata, which is a loose standard held together by what marketplaces read. name,
   description, image and attributes are the parts everything agrees on; display_type is how a
   number is shown as a number instead of a label.
────────────────────────────────────────────────────────────────────────────────────────── */

export function metadataFor(card, base) {
  const r = RARITY[card.rarity] || RARITY.common;
  return {
    name: card.name,
    description: card.description,
    image: `${base}/img/${card.tokenId}.svg`,
    external_url: `${SITE}/cards/collection/#${card.tokenId}`,
    background_color: r.bg.replace("#", "").toUpperCase(),
    attributes: card.attributes,
  };
}

const trait = (trait_type, value) => ({ trait_type, value });
const num = (trait_type, value) => ({ trait_type, value: Number(value), display_type: "number" });

/* ── builders ──────────────────────────────────────────────────────────────────────────────
   Each one is pure: data in, cards out. That is what makes them testable without a network,
   and what keeps the mint reproducible — same input, same cards, same ids.
────────────────────────────────────────────────────────────────────────────────────────── */

const byName = (a, z) => String(a.name).toLowerCase().localeCompare(String(z.name).toLowerCase());
const one = (n) => (Math.round(Number(n) * 10) / 10).toFixed(1);

/** A manager's season-long identity card. Slot is the team's alphabetical position, so the id
 *  survives ESPN shuffling the order between requests. */
export function teamCards(league, season = SEASON) {
  const teams = league.teams.slice().sort(byName);
  return teams.map((t, slot) => {
    const rank = t.rank || 0;
    const rarity = rank === 1 ? "legendary" : rank > 0 && rank <= Math.ceil(league.teams.length / 2) ? "rare" : "common";
    const record = `${t.wins}-${t.losses}${t.ties ? "-" + t.ties : ""}`;
    const id = tokenId({ kind: KIND.team, season, week: 0, league: league.index, slot });
    return {
      tokenId: id, kind: "team", rarity, league: league.index, week: 0, season,
      badge: league.name, title: t.name, subtitle: t.manager ? `Managed by ${t.manager}` : league.name,
      logoUrl: t.logo,
      name: `${t.name} — ${season} ${league.name}`,
      description: `The ${season} franchise card for ${t.name} in ${league.name}. ${record} on ${one(t.pf)} points scored.`,
      stats: [
        { k: "Record", v: record },
        { k: "Points for", v: one(t.pf) },
        { k: "Points against", v: one(t.pa) },
        { k: "Standing", v: rank ? `${ordinal(rank)} of ${league.teams.length}` : "—" },
      ],
      flavor: rank === 1 ? "First place. For now." : t.wins === 0 ? "Still hunting win number one." : "",
      attributes: [
        trait("Card type", "Franchise"), trait("League", league.name), trait("Rarity", RARITY[rarity].label),
        trait("Manager", t.manager || "Unclaimed"), trait("Record", record),
        num("Points for", one(t.pf)), num("Points against", one(t.pa)), num("Season", season),
      ],
    };
  });
}

/** The week's high and low in one league. Supply is one each, decided by the scoreboard. */
export function crownClownCards(league, week, scores, season = SEASON) {
  if (!Array.isArray(scores) || scores.length < 2) return [];
  const sorted = scores.slice().sort((a, z) => z.pts - a.pts || byName(a, z));
  const hi = sorted[0], lo = sorted[sorted.length - 1];
  const spread = one(hi.pts - lo.pts);
  const runnerUp = sorted[1], secondLast = sorted[sorted.length - 2];
  const nextClosest = `${runnerUp.name} ${one(runnerUp.pts)}`;
  const nextLowest = `${secondLast.name} ${one(secondLast.pts)}`;
  const make = (kind, t, rarity, badge, flavor) => ({
    tokenId: tokenId({ kind: KIND[kind], season, week, league: league.index, slot: 0 }),
    kind, rarity, league: league.index, week, season,
    badge, title: t.name, subtitle: `${league.name} · Week ${week}`,
    logoUrl: t.logo || "",
    name: `${badge} — ${league.name} Week ${week}`,
    description: `${t.name} ${kind === "crown" ? "scored the most" : "scored the least"} in ${league.name} in Week ${week} of the ${season} season: ${one(t.pts)} points. One of these exists.`,
    stats: [
      { k: "Points", v: one(t.pts) },
      { k: kind === "crown" ? "Next closest" : "Next lowest", v: kind === "crown" ? nextClosest : nextLowest },
      { k: "Field", v: `${sorted.length} teams` },
      { k: kind === "crown" ? "Margin over last" : "Behind the crown", v: spread },
    ],
    flavor,
    attributes: [
      trait("Card type", kind === "crown" ? "Crown" : "Clown"), trait("League", league.name),
      trait("Rarity", RARITY[rarity].label), trait("Team", t.name),
      num("Points", one(t.pts)), num("Week", week), num("Season", season),
    ],
  });
  return [
    make("crown", hi, "crown", "Crown", "Highest score in the league that week."),
    make("clown", lo, "clown", "Clown", "Lowest score in the league that week. The vest fits."),
  ];
}

/** NFL games that finished. A game still being played gets no card — a card minted off a live
 *  score would be wrong the moment somebody scores, and there is no taking it back. */
export function momentCards(weekJson, season = SEASON) {
  const week = Number(weekJson.week);
  const games = (weekJson.games || [])
    .filter(g => g.state === "post" && Number.isFinite(g.hScore) && Number.isFinite(g.aScore))
    .sort((a, z) => String(a.id).localeCompare(String(z.id)));
  return games.map((g, slot) => {
    const { rarity, story } = momentStory(g);
    const winner = g.hScore === g.aScore ? null : g.hScore > g.aScore ? g.home : g.away;
    const score = `${g.away} ${g.aScore} — ${g.hScore} ${g.home}`;
    return {
      tokenId: tokenId({ kind: KIND.moment, season, week, league: 0, slot }),
      kind: "moment", rarity, league: 0, week, season,
      badge: `Week ${week}`, title: `${g.away} at ${g.home}`, subtitle: g.city || g.venue || score,
      logoUrl: "",
      art: { type: "matchup", away: g.away, home: g.home, aScore: g.aScore, hScore: g.hScore, note: g.indoor ? "Indoors" : weatherLine(g.weather) },
      name: `${g.away} at ${g.home} — ${season} Week ${week}`,
      description: `${score}. ${story}. Played at ${g.venue || "an unnamed field"}${g.city ? ", " + g.city : ""}.`,
      stats: [
        { k: "Result", v: winner ? `${winner} by ${Math.abs(g.hScore - g.aScore)}` : "Tie" },
        { k: "Combined", v: `${g.hScore + g.aScore} points` },
        { k: "The line said", v: g.line && g.line.spread ? `${g.line.spread}, o/u ${g.line.total}` : "—" },
        { k: "Venue", v: g.venue || "—" },
      ],
      flavor: story,
      attributes: [
        trait("Card type", "Moment"), trait("Rarity", RARITY[rarity].label),
        trait("Home", g.home), trait("Away", g.away),
        trait("Winner", winner || "Tie"), trait("Storyline", story),
        trait("Venue", g.venue || "Unknown"), trait("Indoors", g.indoor ? "Yes" : "No"),
        num("Combined points", g.hScore + g.aScore), num("Margin", Math.abs(g.hScore - g.aScore)),
        num("Week", week), num("Season", season),
      ],
    };
  });
}

function weatherLine(w) {
  if (!w || (!w.text && w.temp == null)) return "—";
  const bits = [];
  if (w.text) bits.push(clean(w.text, 18));
  if (w.temp != null) bits.push(`${Math.round(w.temp)}°`);
  if (w.wind) bits.push(`${Math.round(w.wind)} mph`);
  return bits.join(", ") || "—";
}

/** The week's best DraftKings scores, from games that finished. Capped, because a card for
 *  everybody who played is not a collection, it is a phone book. */
export function playerCards(weekJson, season = SEASON, limit = 24) {
  const week = Number(weekJson.week);
  const best = new Map();
  for (const g of weekJson.games || []) {
    if (g.state !== "post") continue;
    for (const p of [...(g.top || []), ...(g.dst || [])]) {
      if (!p || !p.name || !Number.isFinite(Number(p.dk))) continue;
      const key = `${p.name}|${p.team}`;
      const prev = best.get(key);
      if (!prev || Number(p.dk) > Number(prev.dk)) best.set(key, { ...p, gameId: g.id, opp: p.team === g.home ? g.away : g.home });
    }
  }
  const top = [...best.values()]
    .sort((a, z) => Number(z.dk) - Number(a.dk) || String(a.name).localeCompare(String(z.name)))
    .slice(0, limit);
  return top.map((p, slot) => {
    const dk = Number(p.dk);
    const rarity = playerRarity(dk);
    return {
      tokenId: tokenId({ kind: KIND.player, season, week, league: 0, slot }),
      kind: "player", rarity, league: 0, week, season,
      badge: `Week ${week}`, title: p.name, subtitle: `${season} · Week ${week}`,
      logoUrl: "",
      art: { type: "score", value: one(dk), label: "DraftKings points", note: `${p.pos || ""} ${p.team || ""}`.trim() },
      name: `${p.name} — ${season} Week ${week}`,
      description: `${p.name} (${p.pos}, ${p.team}) put up ${one(dk)} DraftKings points in Week ${week}: ${p.line || "no line recorded"}.`,
      stats: [
        { k: "Position", v: p.pos || "—" },
        { k: "Team", v: p.team || "—" },
        { k: "Opponent", v: p.opp ? `vs ${p.opp}` : "—" },
        { k: "Week rank", v: `${ordinal(slot + 1)} of ${top.length}` },
      ],
      flavor: p.line || "",
      attributes: [
        trait("Card type", "Player"), trait("Rarity", RARITY[rarity].label),
        trait("Position", p.pos || "Unknown"), trait("Team", p.team || "Unknown"),
        trait("Stat line", clean(p.line, 80) || "Not recorded"),
        num("DK points", one(dk)), num("Week", week), num("Season", season),
        num("Week rank", slot + 1),
      ],
    };
  });
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* ── reading the league ────────────────────────────────────────────────────────────────── */

const UA = { accept: "application/json", "user-agent": "Mozilla/5.0 CrownOrClownBot" };
const fantasy = (id, q) => `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${id}?${q}`;
const teamName = (t) => (t.name || `${t.location || ""} ${t.nickname || ""}`).trim() || `Team ${t.id}`;

async function get(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// A league the mint can't reach is a league it skips. Half a collection beats a crashed run.
async function safe(what, fn) {
  try { return await fn(); } catch (e) { console.error(`  skipped ${what}: ${e.message || e}`); return null; }
}

async function leagueSnapshot(l) {
  const j = await get(fantasy(l.id, "view=mTeam"));
  const members = {};
  for (const m of j.members || []) members[m.id] = String(m.displayName || "").trim();
  const teams = (j.teams || []).map(t => {
    const o = (t.record && t.record.overall) || {};
    return {
      name: teamName(t), logo: t.logo || "",
      wins: o.wins | 0, losses: o.losses | 0, ties: o.ties | 0,
      pf: Number(o.pointsFor || 0), pa: Number(o.pointsAgainst || 0),
      manager: members[(t.owners || [])[0]] || "",
    };
  });
  const ranked = teams.slice().sort((a, z) => z.wins - a.wins || z.pf - a.pf);
  ranked.forEach((t, i) => { t.rank = i + 1; });
  return { ...l, teams, currentWeek: (j.status && j.status.latestScoringPeriod) || 0 };
}

async function weekScores(l, week) {
  const box = await get(fantasy(l.id, `view=mMatchupScore&view=mTeam&scoringPeriodId=${week}`));
  const names = {}, logos = {};
  for (const t of box.teams || []) { names[t.id] = teamName(t); logos[t.id] = t.logo || ""; }
  const scores = [];
  for (const m of box.schedule || []) {
    if (m.matchupPeriodId !== week) continue;
    for (const side of ["home", "away"]) {
      const s = m[side];
      if (s && s.totalPoints != null) scores.push({ name: names[s.teamId] || `Team ${s.teamId}`, logo: logos[s.teamId] || "", pts: Number(s.totalPoints) });
    }
  }
  // A week where nobody scored is a week that hasn't been played, not a 0.0 clown card.
  return scores.some(s => s.pts > 0) ? scores : [];
}

/* ── logos ─────────────────────────────────────────────────────────────────────────────── */

// Same allowlist the image proxy uses. A card is a file other people open, so it only ever
// embeds bytes from a host we already trust — never an arbitrary URL out of an API response.
const LOGO_HOSTS = new Set(["g.espncdn.com", "a.espncdn.com", "raw.githubusercontent.com", "mystique-api.fantasy.espn.com"]);
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
const logoCache = new Map();

async function inlineLogo(url) {
  if (!url) return "";
  if (logoCache.has(url)) return logoCache.get(url);
  let out = "";
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || !LOGO_HOSTS.has(u.hostname)) throw new Error("host not allowed");
    const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    // A logo bigger than this is a mistake upstream, and inlining it would bloat every card.
    if (buf.length > 400 * 1024) throw new Error("too big");
    const ext = (u.pathname.split(".").pop() || "").toLowerCase();
    const type = MIME[ext] || r.headers.get("content-type") || "image/png";
    if (!String(type).startsWith("image/") || String(type).includes("svg")) {
      // An SVG logo would be a second document inside the card, scripts and all. Not worth it.
      throw new Error("unsupported type");
    }
    out = `data:${type};base64,${buf.toString("base64")}`;
  } catch (e) {
    out = "";   // a monogram is a perfectly good card
  }
  logoCache.set(url, out);
  return out;
}

/* ── writing it out ────────────────────────────────────────────────────────────────────── */

function arg(n, fallback = null) {
  const i = process.argv.indexOf("--" + n);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

function loadWeek(season, week) {
  const f = path.join(ROOT, "weeks", String(season), `wk${String(week).padStart(2, "0")}.json`);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}

function availableWeeks(season) {
  const dir = path.join(ROOT, "weeks", String(season));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map(f => /^wk(\d{2})\.json$/.exec(f))
    .filter(Boolean).map(m => Number(m[1])).sort((a, z) => a - z);
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function main() {
  const offline = !!arg("offline", false);
  const out = path.resolve(ROOT, String(arg("out", "cards/collection")));
  const base = String(arg("base", `${SITE}/cards/collection`)).replace(/\/+$/, "");
  const onlyWeek = arg("week", null);
  const noLogos = !!arg("no-logos", false);

  const weeks = onlyWeek && onlyWeek !== true && onlyWeek !== "all"
    ? [Number(onlyWeek)]
    : availableWeeks(SEASON);

  const cards = [];

  // Local data first — it needs nothing and can never fail halfway.
  for (const w of weeks) {
    const j = loadWeek(SEASON, w);
    if (!j) { console.error(`  no archive for week ${w}`); continue; }
    const m = momentCards(j, SEASON), p = playerCards(j, SEASON);
    cards.push(...m, ...p);
    console.log(`week ${w}: ${m.length} moments, ${p.length} players`);
  }

  // Then the league, which needs ESPN.
  if (!offline) {
    for (const l of LEAGUES) {
      const snap = await safe(l.name, () => leagueSnapshot(l));
      if (!snap) continue;
      const t = teamCards(snap, SEASON);
      cards.push(...t);
      let cc = 0;
      for (let w = 1; w < snap.currentWeek; w++) {
        const scores = await safe(`${l.name} week ${w}`, () => weekScores(l, w));
        if (!scores || !scores.length) continue;
        const made = crownClownCards(snap, w, scores, SEASON);
        cards.push(...made); cc += made.length;
      }
      console.log(`${l.name}: ${t.length} franchise, ${cc} crown/clown`);
    }
  } else {
    console.log("offline: skipping franchise and crown/clown cards");
  }

  if (!cards.length) { console.error("nothing to mint"); process.exit(1); }

  // Two cards with one id means one of them silently overwrites the other on disk and, later,
  // on-chain. Cheap to check, catastrophic to miss.
  const seen = new Map();
  for (const c of cards) {
    if (seen.has(c.tokenId)) throw new Error(`token id collision ${c.tokenId}: "${seen.get(c.tokenId)}" and "${c.name}"`);
    seen.set(c.tokenId, c.name);
  }

  fs.mkdirSync(path.join(out, "img"), { recursive: true });
  fs.mkdirSync(path.join(out, "meta"), { recursive: true });

  const manifest = {};
  const index = [];
  for (const c of cards.sort((a, z) => a.tokenId - z.tokenId)) {
    c.logo = noLogos ? "" : await inlineLogo(c.logoUrl);
    const svg = cardSvg(c);
    const meta = metadataFor(c, base);
    const svgPath = path.join(out, "img", `${c.tokenId}.svg`);
    const metaPath = path.join(out, "meta", `${c.tokenId}.json`);
    const metaText = JSON.stringify(meta, null, 1) + "\n";
    fs.writeFileSync(svgPath, svg);
    fs.writeFileSync(metaPath, metaText);
    manifest[c.tokenId] = { image: `img/${c.tokenId}.svg`, metadata: `meta/${c.tokenId}.json`, imageSha256: sha256(svg), metadataSha256: sha256(metaText) };
    index.push({ tokenId: c.tokenId, kind: c.kind, rarity: c.rarity, name: c.name, title: c.title, subtitle: c.subtitle, badge: c.badge, league: c.league, week: c.week, season: c.season });
  }

  const counts = {};
  for (const c of index) counts[c.kind] = (counts[c.kind] || 0) + 1;

  fs.writeFileSync(path.join(out, "collection.json"),
    JSON.stringify({ season: SEASON, mintedAt: new Date().toISOString(), base, total: index.length, counts, cards: index }, null, 1) + "\n");

  // Collection-level metadata, the shape marketplaces read for the collection itself rather
  // than any one token.
  fs.writeFileSync(path.join(out, "contract.json"),
    JSON.stringify({
      name: `Crown or Clown ${SEASON}`,
      description: "Cards minted from a fantasy football league's own season: franchises, the weekly crown and clown, the games that actually happened, and the players who earned it.",
      image: `${base}/img/${index[0].tokenId}.svg`,
      external_link: `${SITE}/cards/collection/`,
      seller_fee_basis_points: 0,
    }, null, 1) + "\n");

  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");

  console.log(`\nminted ${index.length} cards into ${path.relative(ROOT, out)}`);
  console.log(Object.entries(counts).map(([k, v]) => `  ${k}: ${v}`).join("\n"));
}

// Only run when invoked directly, so the test file can import the pure parts.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
