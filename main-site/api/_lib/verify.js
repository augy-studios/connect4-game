// Replays a submitted game with the same engine the browser plays with, and
// works out what it is worth. Nothing a browser says about a game is taken on
// trust except the per-turn times, and those are held against the server's
// own clock: the moves are replayed from the seed, the winner is read off the
// final position, every one of the computer's moves is played again, and the
// score is computed here.

import { CELLS, COLS, RED, YELLOW, DRAW, firstMover, positionFrom, verifyGame, scoreWin, turnsOf } from "../../js/engine.js";
import { HttpError } from "./http.js";

// A turn quicker than this is not a person reading the board and tapping.
export const MIN_TURN_MS = 250;
// Turn times may add up to this much more than the server's own figure: the
// start ticket's round trip, and a little drift.
const CLOCK_SLACK_MS = 3000;
// A day, as an upper bound on any one turn.
const MAX_TURN_MS = 86_400_000;

export const SIDE_OF = { r: RED, y: YELLOW };

export function readMoves(value) {
  if (Array.isArray(value) && value.length === 0) {
    throw new HttpError(400, "no_moves", "A game needs at least one move to go on the leaderboard.");
  }
  if (!Array.isArray(value) || value.length > CELLS || !value.every((c) => Number.isInteger(c) && c >= 0 && c < COLS)) {
    throw new HttpError(400, "bad_moves", "Those moves could not be read.");
  }
  return value;
}

// One time per move, in milliseconds, from when that move's turn began.
export function readTurns(value, count) {
  if (!Array.isArray(value) || value.length !== count || !value.every((t) => Number.isInteger(t) && t >= 0 && t <= MAX_TURN_MS)) {
    throw new HttpError(400, "bad_turns", "Those turn times could not be read.");
  }
  return value;
}

// The moves as the database stores them: one string of column digits.
export const movesText = (moves) => moves.join("");

// The replayed game, which must be over. For /api/game/finish, which has to
// be quick, so the computer's moves are left for submit.
export function settle(game, moves) {
  const pos = positionFrom(firstMover(game.seed), moves);
  if (!pos) throw new HttpError(409, "illegal", "Those moves are not a legal game.");
  if (!pos.winner) throw new HttpError(409, "unfinished", "That game is not over yet.");
  // A move after the game ended would have been refused by positionFrom.
  return pos;
}

const REFUSED = {
  bad_level: [500, "server", undefined],
  bad_seed: [500, "server", undefined],
  bad_moves: [400, "bad_moves", "Those moves could not be read."],
  illegal_move: [409, "illegal", "Those moves are not a legal game."],
  moves_after_end: [409, "illegal", "Those moves go on after the game ended."],
  wrong_computer_move: [409, "not_computer", "Those moves were not played against this computer."],
  not_won: [409, "not_won", "Only a won game can go on the leaderboard."],
};

// game: the connect4_games row. side: "r" or "y", the winner being
// submitted. turns: per-move times from the browser. undos: already the
// higher of the browser's and the server's count. elapsedMs: the server's
// time from the start ticket to the game's end.
export function verify(game, moves, side, turns, undos, elapsedMs) {
  const player = SIDE_OF[side];
  if (game.mode === "computer" && player !== RED) {
    throw new HttpError(400, "bad_side", "Only the player's side of a computer game can be submitted.");
  }
  const level = game.mode === "computer" ? game.level : "network";
  const checked = verifyGame({ seed: game.seed, level, moves, winner: player });
  if (!checked.ok) {
    const [status, code, message] = REFUSED[checked.reason] ?? [409, "illegal", "That game could not be checked."];
    throw new HttpError(status, code, message);
  }
  if (checked.pos.winner === DRAW) throw new HttpError(409, "not_won", REFUSED.not_won[2]);

  const first = firstMover(game.seed);
  const own = turnsOf(first, turns, player);
  if (own.some((t) => t < MIN_TURN_MS)) {
    throw new HttpError(409, "too_fast", "That game was played too quickly to count.");
  }
  // In a network game both sides are people, so both sides' turns are held
  // to the same floor: a partner tapping instantly is how a win gets farmed.
  if (game.mode === "network" && turns.some((t) => t < MIN_TURN_MS)) {
    throw new HttpError(409, "too_fast", "That game was played too quickly to count.");
  }
  const claimed = own.reduce((sum, t) => sum + t, 0);
  if (claimed > elapsedMs + CLOCK_SLACK_MS) {
    throw new HttpError(409, "clock", "Those turn times add up to more than the game took.");
  }

  const { score } = scoreWin({ level, winnerTurns: own, durationMs: elapsedMs, undos });
  return { score, ownMoves: own.length };
}
