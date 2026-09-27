#!/usr/bin/env node
// The rules, seeds, the computer and scoring in main-site/js/engine.js, which
// the page and the API share.
//
// Run: node scripts/test-engine.mjs

import * as E from "../main-site/js/engine.js";

let failed = 0;
function check(name, ok) {
  if (!ok) {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

// Rules. With Red first, columns in order.
const play = (moves, first = E.RED) => E.positionFrom(first, moves);

check("horizontal win", play([0, 0, 1, 1, 2, 2, 3])?.winner === E.RED);
check("vertical win", play([0, 1, 0, 1, 0, 1, 0])?.winner === E.RED);
check("diagonal win, rising", play([0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3])?.winner === E.RED);
check("diagonal win, falling", play([6, 5, 5, 4, 4, 3, 4, 3, 3, 0, 3])?.winner === E.RED);
check("Yellow can win", play([0, 1, 0, 1, 0, 1, 6, 1])?.winner === E.YELLOW);
check("no win yet", play([0, 1, 0, 1, 0, 1])?.winner === 0);
check("win line has four cells", play([0, 0, 1, 1, 2, 2, 3])?.winLine.length === 4);
check("a full column refuses a seventh disc", play([0, 0, 0, 0, 0, 0, 0]) === null);
check("no move after the end", play([0, 1, 0, 1, 0, 1, 0, 2]) === null);
check("out of range column", play([7]) === null && play([-1]) === null && play([1.5]) === null);
check("last move recorded", play([3, 4])?.last?.col === 4 && play([3, 4]).last.row === 5);

// A drawn board: columns filled in an order with no four anywhere.
const drawMoves = [];
for (const pair of [[0, 1], [2, 3], [4, 5]]) {
  for (let i = 0; i < 3; i++) drawMoves.push(pair[0], pair[1]);
  for (let i = 0; i < 3; i++) drawMoves.push(pair[1], pair[0]);
}
for (let i = 0; i < 6; i++) drawMoves.push(6);
const drawn = play(drawMoves.slice(0, 36));
check("draw setup has no winner after 36 moves", drawn && drawn.winner === 0);

// Seeds.
const bytes = [...Array(64)].map((_, i) => (i * 97) % 256);
let i = 0;
const seed = E.makeSeed(() => bytes[i++ % bytes.length]);
check("made seed is valid", E.isValidSeed(seed));
check("seed normalises case and spacing", E.normaliseSeed(" k7xq-2mpd ") === "K7XQ2MPD");
check("vowels are not seed characters", !E.isValidSeed("AEIOU234"));
check("first mover is fixed by the seed", E.firstMover("K7XQ2MPD") === E.firstMover("K7XQ2MPD"));
const firsts = new Set(["BCDFGHJK", "QRSTV234", "ZZ99XXLL", "MNPQ5678", "HJKL2345", "PPPPPPPP", "22222222"].map(E.firstMover));
check("both colours can start", firsts.size === 2);

// The computer: the same seed and moves always give the same column.
for (const level of E.COMPUTER_LEVELS) {
  const a = [];
  const b = [];
  for (const out of [a, b]) {
    const pos = E.newPosition(E.firstMover("K7XQ2MPD"));
    while (!pos.winner) {
      const col = E.chooseMove(pos, level, "K7XQ2MPD");
      out.push(col);
      E.play(pos, col);
    }
  }
  check(`${level} is deterministic`, a.join("") === b.join(""));
}
{
  // Takes a win on offer, and blocks one.
  const pos = play([0, 6, 1, 6, 2]);
  check("hard blocks three in a row", E.chooseMove(pos, "hard", "K7XQ2MPD") === 3);
  // Yellow first: Yellow holds 0, 1 and 2 along the bottom, Red has three up
  // column 6. Yellow to move wins at 3 rather than blocking.
  const win = play([0, 6, 1, 6, 2, 6], E.YELLOW);
  check("hard takes a win over a block", win.toMove === E.YELLOW && E.chooseMove(win, "hard", "K7XQ2MPD") === 3);
}

// A game the player wins against the computer, for verifyGame. The "player"
// is Expert against Easy, so it wins; its moves are then checked as a human's.
function winAgainst(level, s) {
  const pos = E.newPosition(E.firstMover(s));
  const moves = [];
  while (!pos.winner) {
    const col = pos.toMove === E.RED ? E.chooseMove(pos, "expert", `${s}-player`) : E.chooseMove(pos, level, s);
    moves.push(col);
    E.play(pos, col);
  }
  return { moves, winner: pos.winner };
}
const game = winAgainst("easy", "K7XQ2MPD");
check("expert beats easy", game.winner === E.RED);
check("verifyGame accepts a real win", E.verifyGame({ seed: "K7XQ2MPD", level: "easy", moves: game.moves }).ok);
{
  // Change one computer move to another legal column.
  const tampered = game.moves.slice();
  const first = E.firstMover("K7XQ2MPD");
  const at = tampered.findIndex((_, n) => (n % 2 === 0 ? first : E.other(first)) === E.YELLOW);
  tampered[at] = (tampered[at] + 1) % 7;
  const r = E.verifyGame({ seed: "K7XQ2MPD", level: "easy", moves: tampered });
  check("verifyGame refuses a changed computer move", !r.ok);
}
check("verifyGame refuses another seed", !E.verifyGame({ seed: "BCDFGHJK", level: "easy", moves: game.moves }).ok);
check("verifyGame refuses another level", !E.verifyGame({ seed: "K7XQ2MPD", level: "expert", moves: game.moves }).ok);
check("verifyGame refuses an unfinished game", !E.verifyGame({ seed: "K7XQ2MPD", level: "easy", moves: game.moves.slice(0, -1) }).ok);
check(
  "verifyGame checks the claimed network winner",
  E.verifyGame({ seed: "K7XQ2MPD", level: "network", moves: [0, 1, 0, 1, 0, 1, 0].slice(), winner: E.firstMover("K7XQ2MPD") }).ok &&
    !E.verifyGame({ seed: "K7XQ2MPD", level: "network", moves: [0, 1, 0, 1, 0, 1, 0], winner: E.other(E.firstMover("K7XQ2MPD")) }).ok
);

// Scoring.
const base = { level: "medium", winnerTurns: [3000, 3000, 3000, 3000], durationMs: 30000, undos: 0 };
const s = (over) => E.scoreWin({ ...base, ...over }).score;
check("harder level scores more", s({ level: "expert" }) > s({ level: "hard" }) && s({ level: "hard" }) > s({ level: "medium" }) && s({ level: "medium" }) > s({ level: "easy" }));
check("fewer moves score more", s({}) > s({ winnerTurns: Array(10).fill(3000) }));
check("quicker turns score more", s({ winnerTurns: [1000, 1000, 1000, 1000] }) > s({}));
check("a shorter game scores more", s({ durationMs: 10000 }) > s({}));
check("undo costs 10%", s({ undos: 1 }) === Math.floor((s({}) * 90) / 100));
check("score never below the floor", s({ undos: 100 }) === E.SCORE.floor);
check("score is an integer", Number.isInteger(s({ winnerTurns: [1234, 5678] })));

if (failed) {
  console.error(`test-engine: ${failed} failed.`);
  process.exit(1);
}
console.log("test-engine: all passed.");
