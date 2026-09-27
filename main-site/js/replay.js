// The instant replay: a finished game played back on the same board, one
// disc at a time, with play, pause, a step either way, a jump to either end,
// and a jump to any move from the list or the slider. The speed is 0.5x, 1x,
// 2x or 4x, remembered in this browser.

import { firstMover, positionFrom, colourName } from "./engine.js";
import { hydrateIcons, store } from "./ui.js";

// A move every 900 ms at 1x. The drop itself takes 300 ms, so even 4x (225
// ms a move) still shows each disc fall.
const STEP_MS = 900;
const SPEEDS = [0.5, 1, 2, 4];
const SPEED_STORAGE = "connect4.replaySpeed";

const $ = (id) => document.getElementById(id);

export class Replay {
  constructor(board) {
    this.board = board;
    this.timer = null;
    this.ticking = null;
    this.index = 0;
    this.frames = [];
    this.active = false;
    const saved = Number(store.get(SPEED_STORAGE));
    this.speed = SPEEDS.includes(saved) ? saved : 1;
    this.syncSpeed();

    $("rpSpeed").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-speed]");
      if (btn) this.setSpeed(Number(btn.dataset.speed));
    });
    $("rpStart").addEventListener("click", () => this.jump(0));
    $("rpBack").addEventListener("click", () => this.step(-1));
    $("rpForward").addEventListener("click", () => this.step(1));
    $("rpEnd").addEventListener("click", () => this.jump(this.frames.length - 1));
    $("rpPlay").addEventListener("click", () => (this.timer ? this.pause() : this.play()));
    $("rpScrub").addEventListener("input", (e) => this.jump(Number(e.target.value)));
    $("moveList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-ply]");
      if (btn) this.jump(Number(btn.dataset.ply) + 1);
    });
    document.addEventListener("keydown", (e) => {
      if (!this.active || e.target.closest("input, textarea, .board")) return;
      if (e.key === "ArrowLeft") this.step(-1);
      else if (e.key === "ArrowRight") this.step(1);
      else return;
      e.preventDefault();
    });
  }

  // Starts at the end, dropping the last disc in when `animateLast` is set.
  // With `autoplay`, the finished board stays up for a moment, long enough to
  // see the winning line, and then plays back from the empty board.
  load(seed, moves, { autoplay = false, animateLast = false } = {}) {
    this.pause();
    this.active = true;
    const first = firstMover(seed);
    this.frames = moves.map((_, i) => positionFrom(first, moves.slice(0, i))).concat([positionFrom(first, moves)]);

    $("rpScrub").max = String(this.frames.length - 1);
    $("moveList").innerHTML = moves
      .map((col, i) => {
        const who = this.frames[i].toMove;
        return `<li><button type="button" class="ply-btn ${who === 1 ? "red" : "yellow"}" data-ply="${i}" aria-label="Move ${i + 1}, ${colourName(who)} in column ${col + 1}"><span class="ply-dot" aria-hidden="true"></span>${col + 1}</button></li>`;
      })
      .join("");

    this.show(this.frames.length - 1, animateLast);
    if (autoplay && this.frames.length > 1) {
      this.timer = setTimeout(() => this.play(), 2200);
      this.syncPlayButton(true);
    }
  }

  stop() {
    this.pause();
    this.active = false;
  }

  show(i, animate) {
    const pos = this.frames[i];
    if (!pos) return;
    this.index = i;
    this.board.set({ pos, interactive: false, animate });
    $("rpScrub").value = String(i);
    const total = this.frames.length - 1;
    $("rpLabel").textContent =
      i === 0
        ? `Empty board, ${total} ${total === 1 ? "move" : "moves"}`
        : `Move ${i} of ${total}: ${colourName(pos.last.player)} in column ${pos.last.col + 1}`;
    const list = $("moveList");
    list.querySelectorAll(".ply-btn").forEach((b) => {
      const on = Number(b.dataset.ply) === i - 1;
      b.classList.toggle("current", on);
      if (on) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    });
    // Keep the current move in view within the list, not the page.
    const current = list.querySelector(".ply-btn.current");
    if (current) {
      const left = current.offsetLeft - list.offsetLeft;
      if (left < list.scrollLeft || left > list.scrollLeft + list.clientWidth - 40) list.scrollLeft = left - 40;
    } else if (i === 0) {
      list.scrollLeft = 0;
    }
    $("rpBack").disabled = $("rpStart").disabled = i === 0;
    $("rpForward").disabled = $("rpEnd").disabled = i === total;
  }

  step(delta, fromTimer = false) {
    if (!fromTimer) this.pause();
    const next = this.index + delta;
    if (next < 0 || next >= this.frames.length) return false;
    // A disc drops in going forward; going back it simply goes.
    this.show(next, delta > 0);
    return true;
  }

  jump(i) {
    this.pause();
    const target = Math.max(0, Math.min(this.frames.length - 1, i));
    if (target - this.index === 1) this.step(1);
    else this.show(target, false);
  }

  get stepMs() {
    return STEP_MS / this.speed;
  }

  // Remembered in this browser. A replay that is playing picks the new pace
  // up from its next move, without restarting.
  setSpeed(speed) {
    if (!SPEEDS.includes(speed)) return;
    this.speed = speed;
    store.set(SPEED_STORAGE, String(speed));
    this.syncSpeed();
    if (this.timer && this.ticking) {
      clearTimeout(this.timer);
      this.timer = setTimeout(this.ticking, this.stepMs);
    }
  }

  syncSpeed() {
    document.querySelectorAll("#rpSpeed [data-speed]").forEach((el) => {
      const on = Number(el.dataset.speed) === this.speed;
      el.setAttribute("aria-checked", String(on));
      el.classList.toggle("active", on);
    });
  }

  play() {
    clearTimeout(this.timer);
    // Played to the end already: start over.
    if (this.index >= this.frames.length - 1) this.show(0, false);
    this.syncPlayButton(true);
    const tick = () => {
      if (!this.step(1, true) || this.index >= this.frames.length - 1) {
        this.pause();
        return;
      }
      this.timer = setTimeout(tick, this.stepMs);
    };
    this.ticking = tick;
    this.timer = setTimeout(tick, this.index === 0 ? Math.min(400, this.stepMs) : this.stepMs / 2);
  }

  pause() {
    clearTimeout(this.timer);
    this.timer = null;
    this.ticking = null;
    this.syncPlayButton(false);
  }

  syncPlayButton(playing) {
    const btn = $("rpPlay");
    btn.setAttribute("aria-label", playing ? "Pause" : "Play");
    btn.querySelector("[data-icon]").setAttribute("data-icon", playing ? "pause" : "play");
    hydrateIcons(btn);
  }
}
