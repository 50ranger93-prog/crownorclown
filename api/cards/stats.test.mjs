#!/usr/bin/env node
// Proof for the live card numbers, against a mock ESPN payload — no network, so it
// is deterministic and it runs in CI. Run: node api/cards/stats.test.mjs

import assert from "node:assert/strict";
import { derive } from "./stats.mjs";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("  ok  " + name); };

// Four teams, three weeks played, one week on the board but not yet played.
const team = (id, name, w, l, pf, pa) => ({
  id, name, logo: "", record: { overall: { wins: w, losses: l, ties: 0, pointsFor: pf, pointsAgainst: pa } },
});
const wk = (period, pairs) => pairs.map(([a, ap, b, bp]) => ({
  matchupPeriodId: period, home: { teamId: a, totalPoints: ap }, away: { teamId: b, totalPoints: bp },
}));

const LEAGUE = {
  status: { latestScoringPeriod: 4 },
  teams: [
    team(1, "TumbleWEED Tactics", 2, 1, 341.5, 318.0),
    team(2, "REDBIRDSKELLY",      3, 0, 402.1, 297.4),
    team(3, "AREA 51",            1, 2, 288.9, 330.2),
    team(4, "Toxic Toots",        0, 3, 251.0, 337.9),
  ],
  schedule: [
    ...wk(1, [[1, 120.5, 2, 141.2], [3, 98.4, 4, 88.1]]),
    ...wk(2, [[1, 131.0, 3, 101.5], [2, 125.9, 4, 77.4]]),
    ...wk(3, [[1,  90.0, 4, 85.5], [2, 135.0, 3,  88.9]]),
    ...wk(4, [[1,   0.0, 2,  0.0], [3,   0.0, 4,  0.0]]),   // not played yet
  ],
};

test("the serial is the team's slot in the league, not something anyone types", () => {
  // Alphabetical: AREA 51, REDBIRDSKELLY, Toxic Toots, TumbleWEED Tactics
  assert.equal(derive(LEAGUE, "Board 1", "AREA 51").serial,            "001 / 36");
  assert.equal(derive(LEAGUE, "Board 1", "TumbleWEED Tactics").serial, "004 / 36");
  // Board 2 starts twelve higher, so two boards can never collide.
  assert.equal(derive(LEAGUE, "Board 2", "AREA 51").serial,            "013 / 36");
  assert.equal(derive(LEAGUE, "Board 3", "AREA 51").serial,            "025 / 36");
});

test("the slot survives ESPN handing the teams back in another order", () => {
  const shuffled = { ...LEAGUE, teams: [LEAGUE.teams[2], LEAGUE.teams[0], LEAGUE.teams[3], LEAGUE.teams[1]] };
  assert.equal(derive(shuffled, "Board 1", "TumbleWEED Tactics").serial,
               derive(LEAGUE,   "Board 1", "TumbleWEED Tactics").serial);
});

test("record, points and standing come straight off the league", () => {
  const d = derive(LEAGUE, "Board 1", "TumbleWEED Tactics");
  assert.equal(d.record, "2-1");
  assert.equal(d.pointsFor, 341.5);
  assert.equal(d.pointsAgainst, 318.0);
  assert.equal(d.of, 4);
  assert.equal(d.standing, 2);                 // behind REDBIRDSKELLY at 3-0
  assert.equal(derive(LEAGUE, "Board 1", "REDBIRDSKELLY").standing, 1);
  assert.equal(derive(LEAGUE, "Board 1", "Toxic Toots").standing, 4);
});

test("best and worst week are read from the schedule, not from the season total", () => {
  const d = derive(LEAGUE, "Board 1", "TumbleWEED Tactics");
  assert.deepEqual(d.bestWeek,  { week: 2, points: 131.0 });
  assert.deepEqual(d.worstWeek, { week: 3, points: 90.0 });
});

test("crowns and vests are counted from who actually scored most and least", () => {
  // wk1 high 141.2 REDBIRDSKELLY, low 88.1 Toxic Toots
  // wk2 high 131.0 TumbleWEED,    low 77.4 Toxic Toots
  // wk3 high 135.0 REDBIRDSKELLY, low 85.5 Toxic Toots
  assert.equal(derive(LEAGUE, "Board 1", "REDBIRDSKELLY").crowns, 2);
  assert.equal(derive(LEAGUE, "Board 1", "TumbleWEED Tactics").crowns, 1);
  assert.equal(derive(LEAGUE, "Board 1", "Toxic Toots").clowns, 3);
  assert.equal(derive(LEAGUE, "Board 1", "Toxic Toots").crowns, 0);
});

test("a week nobody has played is not a week everybody lost", () => {
  const d = derive(LEAGUE, "Board 1", "Toxic Toots");
  assert.equal(d.weeksPlayed, 3, "week 4 is on the schedule at 0-0 and must not count");
  assert.notEqual(d.worstWeek.points, 0, "an unplayed 0.0 must never become the worst week");
  assert.equal(d.clowns, 3, "and must not hand out a fourth vest");
});

test("a team nobody has heard of is a clean miss, with the real names offered", () => {
  const d = derive(LEAGUE, "Board 1", "Team That Isn't");
  assert.ok(d.error);
  assert.ok(d.teams.includes("AREA 51"));
});

test("the team lookup ignores case and stray spacing", () => {
  const a = derive(LEAGUE, "Board 1", "  tumbleweed TACTICS ");
  assert.equal(a.team, "TumbleWEED Tactics");
  assert.equal(a.serial, "004 / 36");
});

test("an empty league does not throw, it misses", () => {
  assert.ok(derive({ teams: [], schedule: [] }, "Board 1", "anyone").error);
});

test("every number a card prints is present and finite", () => {
  const d = derive(LEAGUE, "Board 1", "TumbleWEED Tactics");
  for (const k of ["pointsFor", "pointsAgainst", "standing", "of", "crowns", "clowns", "weeksPlayed", "week"])
    assert.ok(Number.isFinite(d[k]), `${k} must be a number, got ${d[k]}`);
  for (const k of ["record", "serial", "team", "board"])
    assert.ok(typeof d[k] === "string" && d[k].length, `${k} must be a non-empty string`);
});

console.log(`\n${passed} tests passed.`);
