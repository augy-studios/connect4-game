// The game screen: choosing a game, playing it, and what happens after.
//
// A game is a seed and a list of columns, and everything on screen is derived
// from those two by replaying them. That is also all that is saved, sent to
// the other device in a network game, and submitted to the leaderboard, where
// the API replays it the same way. Alongside them go the time each move took,
// which the score's turn speed part is made from, and the undo counts.

import {
  RED,
  YELLOW,
  DRAW,
  LEVELS,
  COMPUTER_LEVELS,
  colourName,
  firstMover,
  positionFrom,
  canPlay,
  makeSeed,
  normaliseSeed,
  isValidSeed,
  scoreWin,
  turnsOf,
} from "./engine.js";
import { BoardView } from "./board.js";
import { requestMove, cancelMove } from "./computer.js";
import { api } from "./api.js";
import { getSettings, onSettingsChange, saveSettings } from "./settings.js";
import { openLeaderboard } from "./leaderboard.js";
import { Replay } from "./replay.js";
import { copyText, hydrateIcons, store } from "./ui.js";
import { confetti } from "./confetti.js";

const GAME_STORAGE = "connect4.game";
const SETUP_STORAGE = "connect4.setup";
const LETTER = { [RED]: "r", [YELLOW]: "y" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// How long to wait for the server's ticket before starting unscored.
const START_WAIT_MS = 5000;
const TICKETS = ["ok", "pending", "offline", "server", "practice", "none"];

const $ = (id) => document.getElementById(id);

let board = null;
let replayer = null;
let g = null; // the game on screen, or null
let pos = null; // positionFrom(g's first mover, g.moves), refreshed on every change
let thinking = false;
let launching = false;
let gameCounter = 0;
let leaveTimer = null;
let net = null; // set by multiplayer.js for network games

/* ---- setup ---- */

const setup = { mode: "computer", level: "medium" };

function loadSetup() {
  const saved = store.getJSON(SETUP_STORAGE) ?? {};
  if (["computer", "local", "network"].includes(saved.mode)) setup.mode = saved.mode;
  if (COMPUTER_LEVELS.includes(saved.level)) setup.level = saved.level;
}

function saveSetup() {
  store.set(SETUP_STORAGE, setup);
}

const MODE_NOTES = {
  computer: "You are Red. A win goes on the leaderboard when the game starts online on a new seed.",
  local: "Two players taking turns on this device. Not scored.",
  network: "Play someone on the same wifi, or sharing a hotspot. The host is Red. Wins are scored when the game starts online on a new seed.",
};

const SEED_NOTE = "Leave it empty for a new, scored game, or paste a seed to replay that game for practice.";

function renderSetup() {
  const check = (sel, attr, value) =>
    document.querySelectorAll(sel).forEach((el) => {
      const on = el.dataset[attr] === String(value);
      el.setAttribute("aria-checked", String(on));
      el.classList.toggle("active", on);
    });
  check("#modePick [data-pick]", "pick", setup.mode);
  check("#levelPick [data-level]", "level", setup.level);
  $("levelGroup").classList.toggle("hidden", setup.mode !== "computer");
  $("joinForm").classList.toggle("hidden", setup.mode !== "network");
  $("startLabel").textContent = launching ? "Starting" : setup.mode === "network" ? "Host a game" : "Start game";
  $("startBtn").disabled = launching;
  $("playNote").textContent = MODE_NOTES[setup.mode];
}

function shake(input) {
  input.classList.remove("shake");
  void input.offsetWidth;
  input.classList.add("shake");
  input.focus();
}

const newLocalSeed = () => makeSeed(() => crypto.getRandomValues(new Uint8Array(1))[0]);

// What the seed field holds: null when empty, undefined when it is not a seed.
function seedFromField() {
  const raw = $("seedInput").value;
  if (!raw.trim()) return null;
  const seed = normaliseSeed(raw);
  return isValidSeed(seed) ? seed : undefined;
}

function onStart() {
  const seed = seedFromField();
  if (seed === undefined) {
    $("seedNote").textContent = "That is not a seed. Seeds are eight letters and numbers, like K7XQ2MPD.";
    return shake($("seedInput"));
  }
  if (setup.mode === "network") {
    net?.host({ seed });
    return;
  }
  launch({ mode: setup.mode, seed, level: setup.level });
}

function setLaunching(on) {
  launching = on;
  $("againBtn").disabled = on;
  renderSetup();
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

// Starts a game. With no seed, a game that can be scored asks the server for
// a ticket, which carries the seed; if it cannot be reached in a few seconds
// the game starts anyway on a seed of its own, unscored. A pasted seed is
// practice and starts at once. Resolves with the game, or null if a start was
// already under way.
export async function launch(opts) {
  const { mode, role = null } = opts;
  const level = mode === "computer" ? opts.level : null;
  if (mode === "local") return startGame({ mode, seed: opts.seed ?? newLocalSeed(), ticket: "none" });
  if (opts.seed) return startGame({ mode, role, level, seed: opts.seed, ticket: "practice" });
  if (launching) return null;
  setLaunching(true);
  let ticket = null;
  let why = "offline";
  try {
    ticket = await withTimeout(api.start({ mode, level: level ?? undefined }), START_WAIT_MS);
  } catch (err) {
    // No connection, or too slow to wait for: offline. Anything the API
    // itself said: the leaderboard is unavailable.
    if (err?.status) why = "server";
  }
  setLaunching(false);
  if (ticket && isValidSeed(ticket.seed) && UUID.test(ticket.game_id ?? "")) {
    return startGame({ mode, role, level, seed: ticket.seed, gameId: ticket.game_id, ticket: "ok" });
  }
  return startGame({ mode, role, level, seed: newLocalSeed(), ticket: why });
}

/* ---- the game ---- */

// opts: { mode, role?, seed, level?, moves?, turns?, undos?, gameId?, ticket,
// submitted?, submittedText?, startedAt?, turnStart?, endedAt?, elapsed? }
export function startGame(opts) {
  cancelMove();
  thinking = false;
  replayer.stop();
  const now = Date.now();
  g = {
    id: ++gameCounter,
    mode: opts.mode,
    role: opts.role ?? null,
    seed: opts.seed,
    level: opts.mode === "computer" ? opts.level : null,
    first: firstMover(opts.seed),
    moves: opts.moves?.slice() ?? [],
    turns: opts.turns?.slice() ?? [],
    turnStart: opts.turnStart ?? now,
    undos: { r: opts.undos?.r ?? 0, y: opts.undos?.y ?? 0 },
    gameId: opts.gameId ?? null,
    ticket: opts.ticket,
    submitted: opts.submitted ?? false,
    submittedText: opts.submittedText ?? null,
    submitRefused: false,
    startedAt: opts.startedAt ?? now,
    endedAt: opts.endedAt ?? null,
    elapsed: opts.elapsed ?? null,
    finishSent: opts.elapsed != null,
    takeback: null,
    wasOver: false,
    netGame: opts.netGame ?? 0,
  };
  pos = positionFrom(g.first, g.moves);
  if (!pos) {
    // A saved game that no longer replays: start it again from the top.
    g.moves = [];
    pos = positionFrom(g.first, []);
  }
  // One time per move, whatever was saved.
  g.turns = g.moves.map((_, i) => (Number.isInteger(g.turns[i]) && g.turns[i] >= 0 ? g.turns[i] : 0));
  if (pos.winner && !g.endedAt) g.endedAt = now;
  $("status").dataset.last = "";
  disarmLeave();
  showPanel("play");
  resetResult();
  persist();
  update({ fresh: true });
  maybeComputer();
  return g;
}

function isOver() {
  return Boolean(g && pos.winner);
}

// The colour this screen plays: Red against the computer, one end of a
// network game, or, on a shared device, whoever is to move.
function mySide() {
  if (g.mode === "computer") return RED;
  if (g.mode === "network") return g.role === "guest" ? YELLOW : RED;
  return pos.toMove;
}

function interactive() {
  if (isOver() || thinking) return false;
  if (g.mode === "local") return true;
  if (g.mode === "network" && (!net?.connected() || g.takeback)) return false;
  return pos.toMove === mySide();
}

function scoring() {
  return g.mode !== "local";
}

function levelKey() {
  return g.mode === "computer" ? g.level : "network";
}

/* ---- moves ---- */

// Plays a move, from the board, the computer or the network. Returns false
// if it is not legal here and now.
export function playMove(col, { from = "board" } = {}) {
  if (!g || isOver() || !canPlay(pos, col)) return false;
  const now = Date.now();
  g.moves.push(col);
  g.turns.push(Math.max(0, now - g.turnStart));
  g.turnStart = now;
  pos = positionFrom(g.first, g.moves);
  if (isOver()) g.endedAt = now;
  persist();
  announce(col, from);
  update({ animate: true });
  net?.changed();
  if (!isOver()) maybeComputer();
  return true;
}

function announce(col, from) {
  const mover = pos.last.player;
  const who =
    g.mode === "computer"
      ? from === "computer"
        ? "The computer dropped"
        : "You dropped"
      : g.mode === "network"
        ? mover === mySide()
          ? "You dropped"
          : "Your opponent dropped"
        : `${colourName(mover)} dropped`;
  $("status").dataset.last = `${who} in column ${col + 1}.`;
}

async function maybeComputer() {
  if (!g || g.mode !== "computer" || isOver() || pos.toMove !== YELLOW || thinking) return;
  const game = g;
  const ply = g.moves.length;
  thinking = true;
  update();
  // A beat before even an instant reply, so the move is seen to happen.
  const pause = new Promise((r) => setTimeout(r, 350 + COMPUTER_LEVELS.indexOf(g.level) * 80));
  const col = await requestMove(g.seed, g.level, g.moves);
  await pause;
  if (game !== g || g.moves.length !== ply || !thinking || isOver()) return;
  thinking = false;
  if (col == null || !playMove(col, { from: "computer" })) update();
}

/* ---- undo ---- */

// How many moves an undo by `side` takes back: to the last point where it
// was that side's turn, which is one move or two.
export function undoPlies(side) {
  const n = g.moves.length;
  if (!n) return 0;
  if (pos.last.player === side) return 1;
  return n >= 2 ? 2 : 0;
}

function canUndo() {
  if (!g || g.submitted) return false;
  if (g.mode === "local") return g.moves.length > 0;
  if (g.mode === "computer") return thinking || undoPlies(RED) > 0;
  return Boolean(net?.connected()) && !g.takeback && undoPlies(mySide()) > 0;
}

// Takes back `count` moves, charging the undo to `side`. Shared with network
// takebacks, which the host applies once they are accepted. Time already
// spent stays spent: the game clock is not wound back, and the turn starts
// again from now.
export function takeBack(count, side) {
  if (!count || !g) return;
  g.moves.splice(-count);
  g.turns.splice(-count);
  g.turnStart = Date.now();
  g.undos[LETTER[side]]++;
  g.takeback = null;
  // The game is open again: its next ending is a new one to report.
  g.finishSent = false;
  g.elapsed = null;
  g.endedAt = null;
  g.submitRefused = false;
  pos = positionFrom(g.first, g.moves);
  if (g.gameId && (g.mode === "computer" || (g.mode === "network" && side === mySide()))) {
    api.undo(g.gameId, LETTER[side]).catch(() => {});
  }
  persist();
  replayer.stop();
  resetResult();
  $("status").dataset.last = count === 1 ? "Took back a move." : "Took back two moves.";
  update();
  net?.changed();
  maybeComputer();
}

function onUndo() {
  if (!canUndo()) return;
  if (g.mode === "network") {
    net.requestTakeback();
    return;
  }
  if (g.mode === "computer" && thinking) {
    // The computer has not answered yet: take back the move it is answering.
    cancelMove();
    thinking = false;
    takeBack(1, RED);
    return;
  }
  if (g.mode === "computer") takeBack(undoPlies(RED), RED);
  else takeBack(1, pos.last.player);
}

/* ---- leaving ---- */

function disarmLeave() {
  clearTimeout(leaveTimer);
  leaveTimer = null;
  $("leaveBtn").classList.remove("armed");
}

// Back to choosing a game. A game in progress asks for a second tap.
function onLeave() {
  if (g && !isOver() && g.moves.length > 0 && !leaveTimer) {
    $("leaveBtn").classList.add("armed");
    $("leaveLabel").textContent = g.mode === "network" ? "Tap again to leave" : "Tap again to end this game";
    leaveTimer = setTimeout(() => {
      disarmLeave();
      update();
    }, 3000);
    return;
  }
  disarmLeave();
  if (g?.mode === "network") net?.leave();
  endGame();
}

// Drops the game on screen and shows the setup.
export function endGame() {
  cancelMove();
  thinking = false;
  replayer.stop();
  g = null;
  store.remove(GAME_STORAGE);
  showPanel("setup");
  renderSetup();
}

/* ---- drawing ---- */

function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// How long the game took: the server's figure once it has one, this
// device's until then.
function elapsed() {
  if (g.elapsed != null) return g.elapsed;
  return (g.endedAt ?? Date.now()) - g.startedAt;
}

// What a win would score if the next move won: the score falling as the game
// goes on is the point of showing it.
function projected() {
  const me = mySide();
  const own = turnsOf(g.first, g.turns, me);
  const current = pos.toMove === me ? Math.max(0, Date.now() - g.turnStart) : 0;
  return scoreWin({ level: levelKey(), winnerTurns: [...own, current], durationMs: elapsed(), undos: g.undos[LETTER[me]] }).score;
}

function renderChips() {
  if (!g) return;
  const over = isOver();
  $("timeChip").textContent = formatTime(elapsed());
  $("scoreChip").classList.toggle("hidden", !scoring() || over);
  if (scoring() && !over) $("scoreChip").textContent = `Win now: ${projected().toLocaleString()}`;
}

function update({ animate = false, fresh = false } = {}) {
  if (!g) return;
  const over = isOver();

  if (over && !g.wasOver) {
    g.wasOver = true;
    finish(fresh, animate);
  } else if (over) {
    renderSubmit();
  } else {
    g.wasOver = false;
    board.set({ pos, interactive: interactive(), animate });
  }
  board.el.classList.toggle("no-hint", !getSettings().show_drop);

  $("turnChip").dataset.turn = over ? "" : LETTER[pos.toMove];
  $("turnChip").querySelector(".chip-text").textContent = over ? "Game over" : `${colourName(pos.toMove)} to move`;
  $("seedChip").textContent = `Seed ${g.seed}`;
  renderChips();
  renderMatchup(over);
  renderStatus(over);
  renderActions(over);
  renderTakeback();
}

function sideLabel(side) {
  if (g.mode === "computer") return side === RED ? "You" : `Computer, ${LEVELS[g.level].label}`;
  if (g.mode === "network") return side === mySide() ? "You" : "Opponent";
  return colourName(side);
}

function renderMatchup(over) {
  for (const side of [RED, YELLOW]) {
    const el = $(side === RED ? "redPlayer" : "yellowPlayer");
    el.querySelector(".player-name").textContent = sideLabel(side);
    el.classList.toggle("active", !over && pos.toMove === side);
  }
}

function renderStatus(over) {
  const el = $("status");
  const last = el.dataset.last ? `${el.dataset.last} ` : "";
  if (over) {
    el.textContent = last;
    return;
  }
  let now;
  if (g.mode === "computer") now = thinking ? "The computer is thinking." : "Your move.";
  else if (g.mode === "network") {
    if (!net?.connected()) now = "Waiting for your opponent to reconnect.";
    else now = pos.toMove === mySide() ? "Your move." : "Waiting for your opponent.";
  } else now = `${colourName(pos.toMove)} to move.`;
  el.textContent = `${last}${now}`;
}

const TICKET_NOTES = {
  pending: "Checking in with the leaderboard.",
  offline: "This game started without a connection, so it is not scored.",
  server: "The leaderboard could not be reached when this game started, so it is not scored.",
  practice: "This game is on a pasted seed, so it is practice and not scored.",
};

function renderActions(over) {
  // A submitted game cannot be undone. A network game keeps the row anyway,
  // for its way out of the session.
  $("liveActions").classList.toggle("hidden", over && g.submitted && g.mode !== "network");
  $("undoBtn").classList.toggle("hidden", g.submitted);
  $("undoBtn").disabled = !canUndo();
  $("undoLabel").textContent = g.mode === "network" ? "Ask to undo" : "Undo";
  // Once it is over the result has its own buttons; a network game keeps
  // its way out of the session here.
  $("leaveBtn").classList.toggle("hidden", over && g.mode !== "network");
  if (!leaveTimer) {
    $("leaveLabel").textContent = g.mode === "network" ? (g.role === "host" ? "Stop hosting" : "Leave") : "New game";
  }

  let note = "";
  if (g.mode === "computer") {
    note = "Undo as often as you like. Each one takes 10% off a win's score.";
  } else if (g.mode === "network") {
    note = "Undo asks your opponent to take your last move back. Each one they accept takes 10% off your score if you win.";
  } else {
    note = "Undo takes back the last move.";
  }
  if (scoring()) {
    const guestNoTicket = g.role === "guest" && !g.gameId && g.ticket !== "pending" && g.ticket !== "practice";
    const why = guestNoTicket ? "The host's device could not reach the leaderboard, so this game is not scored." : TICKET_NOTES[g.ticket];
    if (why && g.ticket !== "ok") note += ` ${why}`;
    const undone = g.undos[LETTER[mySide()]];
    if (undone) note += ` Undos so far: ${undone}.`;
  }
  $("undoNote").textContent = note;
}

function renderTakeback() {
  const box = $("takeback");
  const pending = g.mode === "network" ? g.takeback : null;
  // Shown after the end too: undo can reopen a finished game.
  if (!pending) {
    box.classList.add("hidden");
    return;
  }
  const mine = pending.by === mySide();
  box.classList.remove("hidden");
  $("takebackText").textContent = mine
    ? "Asked your opponent to take back your last move."
    : "Your opponent asks to take back their last move.";
  // A game already on the leaderboard stays as it was submitted.
  $("takebackYes").classList.toggle("hidden", mine || g.submitted);
  $("takebackNo").textContent = mine ? "Cancel" : "Decline";
}

export function showPanel(name) {
  for (const id of ["setup", "net", "play"]) $(id).classList.toggle("hidden", id !== name);
}

/* ---- the end ---- */

function resetResult() {
  $("result").classList.add("hidden");
  $("replayBar").classList.add("hidden");
  $("submitted").classList.add("hidden");
  $("submitMsg").textContent = "";
}

function renderScoreLine() {
  const me = mySide();
  const took = `Took ${formatTime(elapsed())}`;
  const el = $("resultScore");
  if (!scoring()) {
    el.textContent = `${took}.`;
    return;
  }
  if (pos.winner !== me) {
    el.textContent = `${took}. Only wins score.`;
    return;
  }
  const { score, parts } = scoreWin({
    level: levelKey(),
    winnerTurns: turnsOf(g.first, g.turns, me),
    durationMs: elapsed(),
    undos: g.undos[LETTER[me]],
  });
  const bits = [
    `${LEVELS[levelKey()].label} ×${parts.mult / 100}`,
    `won in ${plural(parts.moves, "move")} +${parts.movePts}`,
    `quick turns +${parts.turnPts}`,
    `game time +${parts.timePts}`,
  ];
  if (parts.undos) bits.push(`${plural(parts.undos, "undo")}, 10% off each`);
  el.textContent = `${score.toLocaleString()} points: ${bits.join(", ")}. ${took}.`;
}

function finish(fresh, animate) {
  const w = pos.winner;
  const me = mySide();
  const s = getSettings();

  let title;
  if (w === DRAW) title = "Draw";
  else if (g.mode === "local") title = `${colourName(w)} wins`;
  else if (g.mode === "computer") title = w === RED ? "You won" : "The computer won";
  else title = w === me ? "You won" : "You lost";
  $("resultTitle").textContent = title;
  $("resultReason").textContent =
    w === DRAW ? `The board is full after ${g.moves.length} moves.` : `Four in a row, on move ${g.moves.length}.`;

  renderScoreLine();
  $("resultSeed").textContent = `Seed ${g.seed}`;
  $("copySeedLabel").textContent = "Copy seed";

  $("nameInput").value = s.name ?? "";
  $("submitBtn").disabled = false;
  g.autoTried = fresh;
  renderSubmit();

  const guest = g.mode === "network" && g.role === "guest";
  $("againBtn").classList.toggle("hidden", guest);
  $("againLabel").textContent = g.mode === "network" ? "Next game" : "Play again";
  $("newGameBtn").classList.toggle("hidden", g.mode === "network");

  $("result").classList.remove("hidden");
  $("replayBar").classList.remove("hidden");
  hydrateIcons($("play"));
  replayer.load(g.seed, g.moves, { autoplay: !fresh && s.auto_replay, animateLast: animate });
  if (!fresh) $("resultTitle").focus({ preventScroll: true });

  // A win as it happens, not on a reload of one. On a shared device somebody
  // at the screen has always won unless it was a draw.
  const won = g.mode === "local" ? w !== DRAW : w === me;
  if (won && !fresh) confetti();
}

// Tells the server the game is won, the moment it is, so its clock stops
// there. Tried again when the connection comes back. Draws score nothing and
// are not reported.
async function reportFinish(game) {
  if (!game.gameId || game.finishSent || game !== g || !isOver() || pos.winner === DRAW) return;
  game.finishSent = true;
  try {
    const r = await api.finish({ game_id: game.gameId, moves: game.moves });
    game.elapsed = r.elapsed_ms;
    if (game === g) {
      persist();
      if (isOver()) renderScoreLine();
    }
  } catch (err) {
    if (err.code !== "offline") return;
    game.finishSent = false;
    window.addEventListener("online", () => reportFinish(game), { once: true });
  }
}

// The leaderboard part of the result. Redrawn on every update while the game
// is over, because a guest only learns of the host's ticket from a snapshot.
// Whichever player won gets the form, with any name they like in it.
function renderSubmit() {
  reportFinish(g);
  const me = mySide();
  const won = pos.winner === me;
  const canSubmit = Boolean(scoring() && g.gameId && !g.submitted && won);
  $("submitForm").classList.toggle("hidden", !canSubmit || g.submitRefused);
  let why = "";
  if (g.mode === "local") why = "Games on one device are not scored.";
  else if (pos.winner === DRAW) why = "Draws are not scored.";
  else if (!won) why = "Only wins go on the leaderboard.";
  else if (!g.gameId) {
    why =
      g.role === "guest" && g.ticket !== "practice" && g.ticket !== "pending"
        ? "The host's device could not reach the leaderboard, so this game is not scored."
        : TICKET_NOTES[g.ticket] ?? "";
  }
  $("notScored").textContent = why;
  $("notScored").classList.toggle("hidden", !why);
  $("submittedText").textContent = g.submittedText || "This game is on the leaderboard.";
  $("submitted").classList.toggle("hidden", !g.submitted);

  const s = getSettings();
  if (canSubmit && !g.autoTried && s.auto_submit && s.name) {
    g.autoTried = true;
    submitAs(s.name, true);
  }
}

async function submitAs(name, auto = false) {
  const msg = $("submitMsg");
  const game = g;
  const me = mySide();
  $("submitBtn").disabled = true;
  msg.textContent = auto ? `Adding as ${name}.` : "Checking the game.";
  try {
    const r = await api.submit({
      game_id: game.gameId,
      name,
      side: LETTER[me],
      moves: game.moves,
      turns: game.turns,
      undos: game.undos[LETTER[me]],
    });
    if (game !== g) return;
    saveSettings({ name: r.name });
    g.submitted = true;
    g.elapsed = r.elapsed_ms;
    g.submittedText =
      `Added as ${r.name} for ${r.score.toLocaleString()} points. Best ${r.best_score.toLocaleString()}, ranked ${r.rank}. ` +
      `Total ${r.total.toLocaleString()} over ${plural(r.games, "game")}, ranked ${r.total_rank}.`;
    persist();
    renderScoreLine();
    $("submittedText").textContent = g.submittedText;
    $("submitForm").classList.add("hidden");
    $("submitted").classList.remove("hidden");
    msg.textContent = "";
    update();
    net?.changed();
  } catch (err) {
    if (game !== g) return;
    if (err.code === "offline") msg.textContent = "No connection. Try again once you are back online.";
    else if (auto && err.status === 400) msg.textContent = "Your saved name was refused, so this game was not added. Change it in Settings.";
    else msg.textContent = err.message || "That did not go through. Try again in a moment.";
    const final = [
      "already_submitted",
      "expired",
      "too_fast",
      "overlap",
      "not_yours",
      "same_device",
      "not_computer",
      "not_won",
      "illegal",
      "unfinished",
      "mismatch",
      "clock",
    ];
    if (final.includes(err.code)) {
      g.submitRefused = true;
      $("submitForm").classList.add("hidden");
    } else $("submitBtn").disabled = false;
  }
}

function onSubmit(event) {
  event.preventDefault();
  const name = $("nameInput").value.trim();
  if (!name) {
    $("submitMsg").textContent = "Enter a name.";
    $("nameInput").focus();
    return;
  }
  submitAs(name);
}

function onAgain() {
  if (!g || launching) return;
  if (g.mode === "network") {
    net?.nextGame();
    return;
  }
  // A fresh seed, picked by the server where it can be.
  launch({ mode: g.mode, seed: null, level: g.level });
}

/* ---- saving ---- */

function persist() {
  if (!g || g.mode === "network") return;
  store.set(GAME_STORAGE, {
    mode: g.mode,
    seed: g.seed,
    level: g.level,
    moves: g.moves,
    turns: g.turns,
    undos: g.undos,
    gameId: g.gameId,
    ticket: g.ticket === "pending" ? "offline" : g.ticket,
    submitted: g.submitted,
    submittedText: g.submittedText ?? null,
    startedAt: g.startedAt,
    turnStart: g.turnStart,
    endedAt: g.endedAt,
    elapsed: g.elapsed,
  });
}

function resume() {
  const saved = store.getJSON(GAME_STORAGE);
  if (!saved || !["computer", "local"].includes(saved.mode) || !isValidSeed(saved.seed) || !Array.isArray(saved.moves)) return false;
  if (saved.mode === "computer" && !COMPUTER_LEVELS.includes(saved.level)) return false;
  const time = (n) => (Number.isFinite(n) && n > 0 ? n : undefined);
  const gameId = typeof saved.gameId === "string" && UUID.test(saved.gameId) ? saved.gameId : null;
  startGame({
    mode: saved.mode,
    seed: saved.seed,
    level: saved.level,
    moves: saved.moves.filter((c) => Number.isInteger(c)),
    turns: Array.isArray(saved.turns) ? saved.turns : [],
    undos: { r: Number(saved.undos?.r) || 0, y: Number(saved.undos?.y) || 0 },
    gameId,
    ticket: gameId ? "ok" : TICKETS.includes(saved.ticket) && saved.ticket !== "ok" ? saved.ticket : saved.mode === "local" ? "none" : "offline",
    submitted: saved.submitted === true,
    submittedText: typeof saved.submittedText === "string" ? saved.submittedText : null,
    startedAt: time(saved.startedAt),
    turnStart: time(saved.turnStart),
    endedAt: time(saved.endedAt) ?? null,
    elapsed: Number.isFinite(saved.elapsed) ? saved.elapsed : null,
  });
  return true;
}

/* ---- for multiplayer.js ---- */

// The network session plugs in here; see multiplayer.js.
export function setNet(adapter) {
  net = adapter;
}

export function current() {
  return g;
}

export function state() {
  return { pos, over: g ? isOver() : false, mySide: g ? mySide() : RED };
}

export function refresh() {
  update();
}

export function setTakeback(value) {
  if (!g) return;
  g.takeback = value;
  update();
}

// Replaces the game with a snapshot from the host. Drops a single new disc in;
// anything else redraws.
export function loadSnapshot(snap) {
  const now = Date.now();
  const same = g && g.mode === "network" && g.role === "guest" && g.netGame === snap.game && g.seed === snap.seed;
  const ticket = snap.gameId ? "ok" : snap.ticket;
  if (!same) {
    startGame({
      mode: "network",
      role: "guest",
      seed: snap.seed,
      moves: snap.moves,
      turns: snap.turns,
      undos: snap.undos,
      gameId: snap.gameId,
      ticket,
      startedAt: now - snap.elapsed,
      turnStart: now - snap.turnMs,
      netGame: snap.game,
    });
    g.takeback = snap.takeback;
    update();
    return;
  }
  const old = g.moves;
  const next = snap.moves;
  const extends1 = next.length === old.length + 1 && old.every((m, i) => m === next[i]);
  const shrank = next.length < old.length && next.every((m, i) => m === old[i]);
  const myUndosBefore = g.undos[LETTER[mySide()]];
  const shown = () => JSON.stringify([g.gameId, g.ticket, g.takeback, g.undos]);
  const before = shown();
  g.gameId = snap.gameId;
  g.ticket = ticket;
  g.takeback = snap.takeback;
  g.undos = { ...snap.undos };
  g.turns = snap.turns.slice();
  g.turnStart = now - snap.turnMs;
  if (!g.endedAt) g.startedAt = now - snap.elapsed;

  if (extends1) {
    g.moves = next.slice();
    pos = positionFrom(g.first, g.moves);
    if (isOver()) g.endedAt = now;
    announce(next.at(-1), "network");
    update({ animate: true });
  } else if (shrank || old.join("") !== next.join("")) {
    g.moves = next.slice();
    pos = positionFrom(g.first, g.moves);
    g.finishSent = false;
    g.elapsed = null;
    g.endedAt = isOver() ? now : null;
    g.submitRefused = false;
    replayer.stop();
    resetResult();
    if (shrank) $("status").dataset.last = "A move was taken back.";
    g.wasOver = false;
    update();
  } else if (shown() === before) {
    // Most snapshots, at 20 a second: nothing but the times moved.
    renderChips();
  } else {
    update();
  }
  // Our own accepted undos, counted on the server from this browser.
  if (g.gameId && g.undos[LETTER[mySide()]] > myUndosBefore) {
    for (let i = myUndosBefore; i < g.undos[LETTER[mySide()]]; i++) api.undo(g.gameId, LETTER[mySide()]).catch(() => {});
  }
}

export function snapshot() {
  const now = Date.now();
  return {
    type: "state",
    v: 1,
    game: g.netGame,
    seed: g.seed,
    gameId: g.gameId,
    ticket: g.ticket,
    moves: g.moves,
    turns: g.turns,
    undos: g.undos,
    takeback: g.takeback && { by: g.takeback.by },
    elapsed: Math.max(0, (g.endedAt ?? now) - g.startedAt),
    turnMs: Math.max(0, now - g.turnStart),
  };
}

export { isOver, renderSetup };

/* ---- wiring ---- */

function buildLevelPick() {
  $("levelPick").innerHTML = COMPUTER_LEVELS.map(
    (id) =>
      `<button class="mode-btn" type="button" role="radio" aria-checked="false" data-level="${id}">${LEVELS[id].label}</button>`
  ).join("");
}

// A radio group in the setup: clicking a button sets `key` from its data.
function pick(id, attr, key) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest(`[data-${attr}]`);
    if (!b) return;
    setup[key] = b.dataset[attr];
    saveSetup();
    renderSetup();
  });
}

export function initGame({ joinCode } = {}) {
  board = new BoardView($("board"), { onColumn: onBoardColumn });
  replayer = new Replay(board);
  loadSetup();
  buildLevelPick();

  pick("modePick", "pick", "mode");
  pick("levelPick", "level", "level");

  $("seedInput").addEventListener("input", () => {
    $("seedNote").textContent = SEED_NOTE;
  });
  $("seedInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onStart();
  });
  $("seedClear").addEventListener("click", () => {
    $("seedInput").value = "";
    $("seedNote").textContent = SEED_NOTE;
    $("seedInput").focus();
  });
  $("startBtn").addEventListener("click", onStart);

  $("undoBtn").addEventListener("click", onUndo);
  $("leaveBtn").addEventListener("click", onLeave);
  $("takebackYes").addEventListener("click", () => net?.answerTakeback(true));
  $("takebackNo").addEventListener("click", () => net?.answerTakeback(false));

  $("submitForm").addEventListener("submit", onSubmit);
  $("againBtn").addEventListener("click", onAgain);
  $("newGameBtn").addEventListener("click", endGame);
  $("resultBoardBtn").addEventListener("click", () => openLeaderboard());
  $("copySeedBtn").addEventListener("click", async () => {
    if (!g) return;
    $("copySeedLabel").textContent = (await copyText(g.seed)) ? "Copied" : "Copy failed";
  });
  $("seedChip").addEventListener("click", async () => {
    if (!g) return;
    const chip = $("seedChip");
    const seed = g.seed;
    chip.textContent = (await copyText(seed)) ? "Seed copied" : `Seed ${seed}`;
    setTimeout(() => g && (chip.textContent = `Seed ${g.seed}`), 1200);
  });

  onSettingsChange(() => update());

  // The game time and the falling "win now" figure, once a second.
  setInterval(() => g && !isOver() && renderChips(), 1000);

  renderSetup();
  if (joinCode) {
    setup.mode = "network";
    renderSetup();
    showPanel("setup");
    return;
  }
  if (!resume()) showPanel("setup");
}

function onBoardColumn(col) {
  if (!g) return;
  if (g.mode === "network" && g.role === "guest") {
    net?.sendMove(col);
    return;
  }
  playMove(col);
}
