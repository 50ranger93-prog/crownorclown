#!/usr/bin/env node
// Proof that jab selection never repeats a player or a comment, and that jabs fan out across every
// channel. Zero-dep. Run: node tools/pulse.test.mjs
//
// These test the PURE selection functions with mock data — no network, no Discord, no ESPN — so the
// result is deterministic and provable, exactly the logic that runs in production.

import assert from "node:assert/strict";
import { jabCandidates, chooseFresh, pickQuietestRoom } from "./pulse.mjs";

// Deterministic RNG so runs are reproducible.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Realistic mock facts across 3 leagues: the always-present angles (crown/vest/fraud) plus streaks.
const FACTS = [
  { angle: "crown",   m: { L: "League 1", t: "REDBIRDSKELLY" } },
  { angle: "vest",    m: { L: "League 1", t: "Payton's Pointed Team" } },
  { angle: "crown",   m: { L: "League 2", t: "Last Jaxon Hero" } },
  { angle: "vest",    m: { L: "League 2", t: "TumbleWEED Tactics" } },
  { angle: "crown",   m: { L: "League 3", t: "Toxic Toots" } },
  { angle: "vest",    m: { L: "League 3", t: "Sack Queen Supreme" } },
  { angle: "fraud",   m: { L: "League 2", t: "AREA 51", r: "1-1", p: "180" } },
  { angle: "heater",  m: { L: "League 3", t: "Robert's Rowdy Team", n: 2 } },
  { angle: "skid",    m: { L: "League 1", t: "Flag Throwers", n: 2 } },
];

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

// --- 1. Candidate pool -------------------------------------------------------
const cands = jabCandidates(FACTS);
ok(cands.length >= 20, `deep candidate pool (got ${cands.length})`);
ok(cands.every(c => c.subject && c.text), "every candidate has a subject and text");
ok(cands.some(c => c.text.includes("**")), "candidates render the player in bold");

// --- 2. No repeated player, no repeated comment, across a full run -----------
const distinctPlayers = new Set(cands.map(c => c.subject)).size;
const seenTexts = new Set(), seenSubjects = new Set();
const rng = mulberry32(1234);
for (let i = 0; i < distinctPlayers; i++) {
  const c = chooseFresh(cands, seenSubjects, seenTexts, rng);
  ok(c, `tick ${i}: produced a jab (not quiet)`);
  ok(!seenTexts.has(c.text), `tick ${i}: comment is NEW -> ${c.text}`);
  ok(!seenSubjects.has(c.subject), `tick ${i}: player is NEW -> ${c.subject}`);
  seenTexts.add(c.text); seenSubjects.add(c.subject);
}
ok(seenSubjects.size === distinctPlayers, `every distinct player used exactly once (${seenSubjects.size})`);

// --- 3. After players exhaust, still a FRESH comment (never a repeat, never quiet) ---
for (let i = 0; i < 5; i++) {
  const c = chooseFresh(cands, seenSubjects, seenTexts, rng);
  ok(c && !seenTexts.has(c.text), `post-exhaust tick ${i}: still a fresh comment`);
  seenTexts.add(c.text);
}

// --- 4. Empty / all-avoided degrade gracefully ------------------------------
ok(chooseFresh([], new Set(), new Set()) === null, "empty pool -> null (caller goes quiet)");
const allSubs = new Set(cands.map(c => c.subject));
const allTxts = new Set(cands.map(c => c.text.slice(0, 1900).trim()));
ok(chooseFresh(cands, allSubs, allTxts) !== null, "fully-saturated -> still returns something, never crashes");

// --- 5. Channel routing fans out across ALL rooms ---------------------------
const rooms = [0, 1, 2, 3];
const lastTs = [0, 0, 0, 0];
const used = new Set();
let clock = 1000;
for (let i = 0; i < rooms.length; i++) {
  const idx = pickQuietestRoom(rooms, lastTs);
  used.add(idx);
  lastTs[idx] = clock++;            // that room just posted
}
ok(used.size === 4, `all four channels used across four jabs (got ${used.size})`);
ok(pickQuietestRoom(rooms, lastTs) === 0, "rotation returns to the longest-quiet room");

// A never-posted room (ts 0) always wins over posted ones.
ok(pickQuietestRoom(rooms, [500, 0, 900, 800]) === 1, "a silent channel is filled first");

console.log(`\nALL TESTS PASSED (${passed} assertions)`);
