#!/usr/bin/env node
// The API's game check, main-site/api/_lib/verify.js, against made-up
// connect4_games rows. No database, no network.
//
// Run: node scripts/test-verify.mjs

import * as E from "../main-site/js/engine.js";
import { verify, settle, readMoves, readTurns } from "../main-site/api/_lib/verify.js";

let failed = 0;
function check(name, ok) {
  if (!ok) {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}
function refuses(name, code, fn) {
  try {
    fn();
    check(`${name} (expected ${code}, it passed)`, false);
  } catch (err) {
    check(`${name} (expected ${code}, got ${err.code})`, err.code === code);
  }
}

const SEED = "K7XQ2MPD";

// A human win against Easy, played by Expert standing in for the human.
function computerWin(level) {
  const pos = E.newPosition(E.firstMover(SEED));
  const moves = [];
  while (!pos.winner) {
    const col = pos.toMove === E.RED ? E.chooseMove(pos, "expert", "stand-in") : E.chooseMove(pos, level, SEED);
    moves.push(col);
    E.play(pos, col);
  }
  if (pos.winner !== E.RED) throw new Error("the stand-in did not win");
  return moves;
}

const moves = computerWin("easy");
const turns = moves.map(() => 2000);
const computerGame = { mode: "computer", level: "easy", seed: SEED };

{
  const r = verify(computerGame, moves, "r", turns, 0, 60000);
  check("a computer win verifies", r.score > 0 && r.ownMoves === E.turnsOf(E.firstMover(SEED), turns, E.RED).length);
  const withUndo = verify(computerGame, moves, "r", turns, 1, 60000);
  check("an undo lowers the score", withUndo.score < r.score);
}
refuses("the computer's side cannot be submitted", "bad_side", () => verify(computerGame, moves, "y", turns, 0, 60000));
refuses("a changed computer move", "not_computer", () => {
  const first = E.firstMover(SEED);
  const t = moves.slice();
  const at = t.findIndex((_, n) => (n % 2 === 0 ? first : E.other(first)) === E.YELLOW);
  t[at] = (t[at] + 1) % 7;
  verify(computerGame, t, "r", turns, 0, 60000);
});
refuses("another level's game", "not_computer", () => verify({ ...computerGame, level: "expert" }, moves, "r", turns, 0, 60000));
refuses("a turn quicker than a person", "too_fast", () => verify(computerGame, moves, "r", moves.map(() => 100), 0, 60000));
refuses("turns adding up to more than the game took", "clock", () => verify(computerGame, moves, "r", turns, 0, 5000));

// Network: Red the host, Yellow the guest.
const first = E.firstMover(SEED);
const netGame = { mode: "network", level: null, seed: SEED };
// The first mover stacks column 0 and wins on its fourth disc.
const netMoves = [0, 1, 0, 1, 0, 1, 0];
const netWinner = first === E.RED ? "r" : "y";
const netLoser = first === E.RED ? "y" : "r";
check("a network win verifies for its winner", verify(netGame, netMoves, netWinner, netMoves.map(() => 1500), 0, 60000).score > 0);
refuses("a network game's loser cannot submit", "not_won", () => verify(netGame, netMoves, netLoser, netMoves.map(() => 1500), 0, 60000));
refuses("a network partner tapping instantly", "too_fast", () =>
  verify(netGame, netMoves, netWinner, netMoves.map((_, n) => (n % 2 ? 50 : 1500)), 0, 60000)
);
refuses("an unfinished game", "not_won", () => verify(netGame, netMoves.slice(0, 6), netWinner, netMoves.slice(0, 6).map(() => 1500), 0, 60000));

// finish's quicker check.
check("settle accepts a finished game", settle(netGame, netMoves).winner !== 0);
refuses("settle refuses an unfinished game", "unfinished", () => settle(netGame, [0, 1]));
refuses("settle refuses an illegal game", "illegal", () => settle(netGame, [0, 0, 0, 0, 0, 0, 0]));

// Reading the request.
refuses("no moves", "no_moves", () => readMoves([]));
refuses("a column out of range", "bad_moves", () => readMoves([7]));
refuses("a column as a string", "bad_moves", () => readMoves(["3"]));
refuses("too few turn times", "bad_turns", () => readTurns([1000], 2));
refuses("a negative turn time", "bad_turns", () => readTurns([-1], 1));

if (failed) {
  console.error(`test-verify: ${failed} failed.`);
  process.exit(1);
}
console.log("test-verify: all passed.");
