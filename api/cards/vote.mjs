/**
 * The ballot, and casting a vote.
 *
 *   GET  /api/cards/vote?t=<link token>   the cards, the window, and your own vote if you have one
 *   POST /api/cards/vote  { t, card }     cast or change it
 *
 * Identity is the signed link the bot hands out for /vote — the same mechanism /intro and
 * /block already use. It is an HMAC over the Discord user id, so the page cannot claim to be
 * somebody else, and every rule below is checked here rather than in the page.
 */

import { readToken } from "../../lib/cards-token.mjs";
import { update, readJSON, configured } from "../../lib/board-data.mjs";
import { ballot, check, tally, phase, OPENS, CLOSES, VOTES_FILE } from "../../lib/cards-vote.mjs";

const json = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

const window_ = () => ({ phase: phase(), opens: new Date(OPENS).toISOString(), closes: new Date(CLOSES).toISOString() });

export async function GET(request) {
  const t = new URL(request.url).searchParams.get("t") || "";
  const tok = readToken(t);
  if (!tok) return json({ error: "This link expired. Type /vote in Discord again for a fresh one." }, 401);

  const cards = await ballot();
  let votes = {};
  if (configured()) {
    const got = await readJSON(VOTES_FILE, {}).catch(() => ({ data: {} }));
    votes = got.data || {};
  }
  const mine = (votes[tok.u] && votes[tok.u].card) || "";

  // The count stays hidden until it closes. A running tally turns a vote on somebody's work
  // into a bandwagon, and the cards that posted late never recover from it.
  const closed = phase() === "closed";
  const list = closed ? tally(votes, cards) : cards;
  return json({
    ...window_(),
    you: tok.u,
    mine,
    cast: closed ? Object.keys(votes).length : undefined,
    cards: list.map(c => ({
      id: c.id, owner: c.owner, image: c.image, team: c.team, at: c.at,
      yours: c.owner === tok.u,
      ...(closed ? { votes: c.votes } : {}),
    })),
  });
}

export async function POST(request) {
  let p;
  try { p = await request.json(); } catch { return json({ error: "Bad request." }, 400); }
  const tok = readToken(p.t);
  if (!tok) return json({ error: "This link expired. Type /vote in Discord again for a fresh one." }, 401);
  if (!configured()) return json({ error: "Voting isn't switched on yet. Tell the commish." }, 500);

  const card = String(p.card || "");
  const cards = await ballot();
  const ok = check({ voter: tok.u, card, cards });
  if (!ok.ok) return json({ error: ok.why }, 400);

  // One row per person: changing a vote overwrites it, so "one vote each" holds however many
  // times the button is pressed.
  const r = await update(VOTES_FILE, {}, v => `Vote from ${tok.u.slice(-4)} → card ${card.slice(-4)}`,
    votes => ({ ...(votes || {}), [tok.u]: { card, at: new Date().toISOString() } }));
  if (!r.ok) return json({ error: "Couldn't record that — try once more." }, 503);

  return json({ ok: true, mine: card, ...window_() });
}
