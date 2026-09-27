// Connect 4 rules, the computer player, seeds and scoring.
//
// Shared by the page and the API. The server replays a submitted game through
// this same file to check every computer move and to work out the score, so it
// must stay free of the DOM and of anything a browser and Node might disagree
// on. The search and the score use integers only; the one float, the seeded
// random draw, is plain IEEE arithmetic that both ends compute identically.

export const COLS = 7;
export const ROWS = 6;
export const CELLS = COLS * ROWS;

export const RED = 1;
export const YELLOW = 2;
export const DRAW = 3;

export const other = (player) => 3 - player;
export const colourName = (player) => (player === RED ? "Red" : "Yellow");

/* ---- levels ----

   `mult` is a percentage applied to a win's points. `depth` is how many
   moves ahead the computer looks, and `noise` how often it plays a random
   column instead. Network games have no computer and a flat multiplier. */

export const LEVELS = {
  easy: { label: "Easy", depth: 2, noise: 0.35, mult: 100 },
  medium: { label: "Medium", depth: 4, noise: 0.1, mult: 200 },
  hard: { label: "Hard", depth: 6, noise: 0, mult: 350 },
  expert: { label: "Expert", depth: 10, noise: 0, mult: 500 },
  network: { label: "Network", depth: 0, noise: 0, mult: 200 },
};

export const COMPUTER_LEVELS = ["easy", "medium", "hard", "expert"];

/* ---- lines ----

   Cell index is row * COLS + col, row 0 at the top. LINES holds every run of
   four as flat indexes; LINES_AT lists the runs through each cell, which is
   all a win check after one move needs to look at. */

const LINES = [];
const LINES_AT = Array.from({ length: CELLS }, () => []);

for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const er = r + dr * 3;
      const ec = c + dc * 3;
      if (er < 0 || er >= ROWS || ec < 0 || ec >= COLS) continue;
      const line = [0, 1, 2, 3].map((k) => (r + dr * k) * COLS + (c + dc * k));
      const id = LINES.length;
      LINES.push(line);
      for (const cell of line) LINES_AT[cell].push(id);
    }
  }
}

// Centre first: the strongest columns, searched first, prune the most.
const ORDER = [3, 2, 4, 1, 5, 0, 6];

/* ---- positions ---- */

export function newPosition(first) {
  return {
    cells: new Int8Array(CELLS),
    heights: new Int8Array(COLS),
    first,
    toMove: first,
    ply: 0,
    winner: 0,
    winLine: null,
    last: null,
  };
}

export const canPlay = (pos, col) =>
  !pos.winner && Number.isInteger(col) && col >= 0 && col < COLS && pos.heights[col] < ROWS;

export function legalMoves(pos) {
  if (pos.winner) return [];
  return ORDER.filter((c) => pos.heights[c] < ROWS).sort((a, b) => a - b);
}

// The row a disc dropped in this column lands on.
export const landingRow = (pos, col) => ROWS - 1 - pos.heights[col];

function winningLine(cells, idx, player) {
  for (const id of LINES_AT[idx]) {
    const line = LINES[id];
    if (cells[line[0]] === player && cells[line[1]] === player && cells[line[2]] === player && cells[line[3]] === player) {
      return line;
    }
  }
  return null;
}

// Plays in place. Returns false, and changes nothing, for an illegal move.
export function play(pos, col) {
  if (!canPlay(pos, col)) return false;
  const row = landingRow(pos, col);
  const idx = row * COLS + col;
  const player = pos.toMove;
  pos.cells[idx] = player;
  pos.heights[col]++;
  pos.ply++;
  pos.last = { col, row, idx, player };

  const line = winningLine(pos.cells, idx, player);
  if (line) {
    // Every cell in any line of four through this one, so a move that makes
    // five or two fours at once lights all of them.
    const all = new Set();
    for (const id of LINES_AT[idx]) {
      const l = LINES[id];
      if (l.every((i) => pos.cells[i] === player)) l.forEach((i) => all.add(i));
    }
    pos.winner = player;
    pos.winLine = [...all];
  } else if (pos.ply === CELLS) {
    pos.winner = DRAW;
  }
  pos.toMove = other(player);
  return true;
}

// The position after a list of columns, or null if any of them is illegal.
export function positionFrom(first, moves) {
  const pos = newPosition(first);
  for (const col of moves) {
    if (!play(pos, col)) return null;
  }
  return pos;
}

export function isValidMoveList(moves) {
  return Array.isArray(moves) && moves.length <= CELLS && moves.every((c) => Number.isInteger(c) && c >= 0 && c < COLS);
}

/* ---- seeds ----

   Eight characters with no vowels, so a seed cannot spell a word, and no
   0 O 1 I, so it survives being read aloud or typed off a screenshot. A seed
   decides who moves first and every random choice the computer makes, so the
   same seed and the same moves are always the same game. */

export const SEED_ALPHABET = "BCDFGHJKLMNPQRSTVWXYZ23456789";
export const SEED_LENGTH = 8;

// randomByte returns 0 to 255 from a proper source: crypto.getRandomValues in
// a browser, node:crypto on the server.
export function makeSeed(randomByte) {
  const n = SEED_ALPHABET.length;
  // Bytes at or above this would make some characters likelier than others.
  const limit = 256 - (256 % n);
  let seed = "";
  while (seed.length < SEED_LENGTH) {
    const b = randomByte();
    if (b < limit) seed += SEED_ALPHABET[b % n];
  }
  return seed;
}

export function normaliseSeed(input) {
  return String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, SEED_LENGTH);
}

export function isValidSeed(input) {
  const seed = normaliseSeed(input);
  return seed.length === SEED_LENGTH && [...seed].every((ch) => SEED_ALPHABET.includes(ch));
}

function hashString(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

// A fresh stream per purpose rather than one running stream, so an undo or a
// replay that reaches the same ply draws the same numbers again.
function rngFor(seed, salt) {
  let a = hashString(`${seed}:${salt}`);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Red and Yellow keep their colours; the seed decides which of them starts.
export function firstMover(seed) {
  return rngFor(seed, "first")() < 0.5 ? RED : YELLOW;
}

/* ---- the computer ---- */

const WIN = 1_000_000;
const INF = 10_000_000;

// Positional score for the side to move: open threes and twos, and the
// centre column. Terminal wins are handled by the search, not here.
function evaluate(cells, player) {
  const opp = other(player);
  let score = 0;
  for (let r = 0; r < ROWS; r++) {
    const v = cells[r * COLS + 3];
    if (v === player) score += 3;
    else if (v === opp) score -= 3;
  }
  for (const line of LINES) {
    let mine = 0;
    let theirs = 0;
    for (const i of line) {
      const v = cells[i];
      if (v === player) mine++;
      else if (v === opp) theirs++;
    }
    if (theirs === 0) {
      if (mine === 3) score += 5;
      else if (mine === 2) score += 2;
    } else if (mine === 0) {
      if (theirs === 3) score -= 5;
      else if (theirs === 2) score -= 2;
    }
  }
  return score;
}

function winsWith(cells, heights, col, player) {
  const idx = (ROWS - 1 - heights[col]) * COLS + col;
  cells[idx] = player;
  const won = winningLine(cells, idx, player) !== null;
  cells[idx] = 0;
  return won;
}

// Negamax with alpha-beta, on the arrays in place. Faster wins score higher,
// through `ply`, so the computer finishes a won game rather than toying.
function negamax(cells, heights, filled, player, depth, alpha, beta, ply) {
  if (filled === CELLS) return 0;
  for (const col of ORDER) {
    if (heights[col] < ROWS && winsWith(cells, heights, col, player)) return WIN - ply - 1;
  }
  if (depth === 0) return evaluate(cells, player);

  let best = -INF;
  const opp = other(player);
  for (const col of ORDER) {
    if (heights[col] >= ROWS) continue;
    const idx = (ROWS - 1 - heights[col]) * COLS + col;
    cells[idx] = player;
    heights[col]++;
    const v = -negamax(cells, heights, filled + 1, opp, depth - 1, -beta, -alpha, ply + 1);
    heights[col]--;
    cells[idx] = 0;
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

// The computer's column for this position. Deterministic in (seed, level,
// position): the server calls this for every computer move in a submitted game
// and refuses the game if any of them differ.
export function chooseMove(pos, level, seed) {
  const spec = LEVELS[level];
  const legal = legalMoves(pos);
  if (!spec || !spec.depth || legal.length === 0) return null;

  const rng = rngFor(seed, `${level}:${pos.ply}`);
  // Both drawn every time, so the stream does not depend on which is used.
  const noiseRoll = rng();
  const pickRoll = rng();

  if (noiseRoll < spec.noise) return legal[Math.floor(pickRoll * legal.length)];

  const cells = Int8Array.from(pos.cells);
  const heights = Int8Array.from(pos.heights);
  const player = pos.toMove;
  let best = -INF;
  let bestMoves = [];

  for (const col of ORDER) {
    if (heights[col] >= ROWS) continue;
    let v;
    if (winsWith(cells, heights, col, player)) {
      v = WIN;
    } else {
      const idx = (ROWS - 1 - heights[col]) * COLS + col;
      cells[idx] = player;
      heights[col]++;
      // A lower bound of best - 1 keeps a move that only ties the best exact,
      // so every equal move is found and the seed picks between them.
      v = -negamax(cells, heights, pos.ply + 1, other(player), spec.depth - 1, -INF, -(best - 1), 1);
      heights[col]--;
      cells[idx] = 0;
    }
    if (v > best) {
      best = v;
      bestMoves = [col];
    } else if (v === best) {
      bestMoves.push(col);
    }
  }
  bestMoves.sort((a, b) => a - b);
  return bestMoves[Math.floor(pickRoll * bestMoves.length)];
}

/* ---- checking a finished game ----

   What the server runs on a submission. Against the computer, the player is
   always Red and every Yellow move must be the one chooseMove makes. On the
   network both sides are people, so only the rules and the winner are checked. */

export const COMPUTER_SIDE = YELLOW;
export const PLAYER_SIDE = RED;

export function verifyGame({ seed, level, moves, winner }) {
  if (!LEVELS[level]) return { ok: false, reason: "bad_level" };
  if (!isValidSeed(seed)) return { ok: false, reason: "bad_seed" };
  if (!isValidMoveList(moves)) return { ok: false, reason: "bad_moves" };

  const vsComputer = level !== "network";
  const pos = newPosition(firstMover(seed));
  for (const col of moves) {
    if (pos.winner) return { ok: false, reason: "moves_after_end" };
    if (vsComputer && pos.toMove === COMPUTER_SIDE && chooseMove(pos, level, seed) !== col) {
      return { ok: false, reason: "wrong_computer_move" };
    }
    if (!play(pos, col)) return { ok: false, reason: "illegal_move" };
  }
  const expected = vsComputer ? PLAYER_SIDE : winner;
  if (pos.winner !== expected || (expected !== RED && expected !== YELLOW)) {
    return { ok: false, reason: "not_won" };
  }
  return { ok: true, pos };
}

/* ---- scoring ----

   Only wins score. Points scale with the level, with how early in the game
   the win came, with how quickly each of the winner's turns was played, and
   with how long the whole game took. Every undo takes 10% off. */

export const SCORE = {
  base: 500,
  perMoveSaved: 40, // for each of the winner's moves under the 21 a full board allows
  turnFullMs: 20_000, // a turn this long or longer earns no speed points
  turnMax: 20, // points for an instant turn, one fewer per second taken
  gameFullS: 300, // a game this long or longer earns no time points
  undoKeepPercent: 90,
  floor: 10,
};

// The winner's own turns out of a per-move list of durations.
export function turnsOf(first, turns, player) {
  return turns.filter((_, i) => (i % 2 === 0 ? first : other(first)) === player);
}

export function scoreWin({ level, winnerTurns, durationMs, undos }) {
  const spec = LEVELS[level];
  if (!spec) return { score: 0, parts: null };
  const moves = winnerTurns.length;
  const movePts = Math.max(0, 21 - moves) * SCORE.perMoveSaved;
  let turnPts = 0;
  for (const t of winnerTurns) {
    const left = Math.max(0, SCORE.turnFullMs - Math.max(0, Math.floor(t)));
    turnPts += Math.min(SCORE.turnMax, Math.floor(left / 1000));
  }
  const timePts = Math.max(0, SCORE.gameFullS - Math.floor(Math.max(0, durationMs) / 1000));
  const raw = SCORE.base + movePts + turnPts + timePts;

  let score = Math.floor((raw * spec.mult) / 100);
  const undoCount = Math.min(Math.max(0, Math.floor(undos || 0)), 100);
  for (let i = 0; i < undoCount; i++) score = Math.floor((score * SCORE.undoKeepPercent) / 100);
  score = Math.max(SCORE.floor, score);

  return {
    score,
    parts: { base: SCORE.base, moves, movePts, turnPts, timePts, raw, mult: spec.mult, undos: undoCount },
  };
}
