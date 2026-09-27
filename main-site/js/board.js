// The board on screen: seven column buttons of six slots each. Tap or click a
// column to drop a disc, or move along the columns with the arrow keys and
// press Enter or Space. The last move's disc is marked and its row lit, and a
// win lights its line of four.

import { COLS, ROWS, RED, YELLOW, colourName } from "./engine.js";

const CLASS = { [RED]: "red", [YELLOW]: "yellow" };

export class BoardView {
  // onColumn(col) is called for a column the player picks.
  constructor(el, { onColumn }) {
    this.el = el;
    this.onColumn = onColumn;
    this.interactive = false;
    el.classList.add("board");
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", "Board");
    el.innerHTML = Array.from(
      { length: COLS },
      (_, c) =>
        `<button class="col" type="button" data-col="${c}">${Array.from(
          { length: ROWS },
          (_, r) => `<span class="slot" data-row="${r}"><span class="disc"></span></span>`
        ).join("")}</button>`
    ).join("");
    this.cols = [...el.querySelectorAll(".col")];

    el.addEventListener("click", (e) => {
      const btn = e.target.closest(".col");
      if (!btn || !this.interactive || btn.getAttribute("aria-disabled") === "true") return;
      this.onColumn(Number(btn.dataset.col));
    });
    el.addEventListener("keydown", (e) => {
      const btn = e.target.closest(".col");
      if (!btn) return;
      const c = Number(btn.dataset.col);
      let next = null;
      if (e.key === "ArrowLeft") next = Math.max(0, c - 1);
      else if (e.key === "ArrowRight") next = Math.min(COLS - 1, c + 1);
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = COLS - 1;
      else if (/^[1-7]$/.test(e.key) && this.interactive) {
        e.preventDefault();
        this.cols[Number(e.key) - 1].focus();
        this.cols[Number(e.key) - 1].click();
        return;
      }
      if (next === null) return;
      e.preventDefault();
      this.cols[next].focus();
    });
  }

  // pos: an engine position. interactive: whether the player may drop a disc
  // now. animate: whether to drop the last move's disc in.
  set({ pos, interactive = false, animate = false }) {
    this.interactive = interactive && !pos.winner;
    const last = pos.last;
    const win = new Set(pos.winLine ?? []);
    this.el.classList.toggle("can-play", this.interactive);
    this.el.dataset.turn = CLASS[pos.toMove];

    for (let c = 0; c < COLS; c++) {
      const btn = this.cols[c];
      const free = ROWS - pos.heights[c];
      const nextRow = free - 1;
      btn.setAttribute("aria-disabled", String(!this.interactive || free === 0));
      btn.setAttribute(
        "aria-label",
        free === 0 ? `Column ${c + 1}, full` : `Column ${c + 1}, ${free} ${free === 1 ? "space" : "spaces"} left`
      );
      const slots = btn.children;
      for (let r = 0; r < ROWS; r++) {
        const idx = r * COLS + c;
        const slot = slots[r];
        const disc = slot.firstElementChild;
        const owner = pos.cells[idx];
        disc.className = `disc${owner ? ` ${CLASS[owner]}` : ""}`;
        slot.classList.toggle("next", r === nextRow);
        slot.classList.toggle("last-row", Boolean(last) && r === last.row);
        slot.classList.toggle("last", Boolean(last) && idx === last.idx);
        slot.classList.toggle("win", win.has(idx));
        if (animate && last && idx === last.idx) {
          disc.style.setProperty("--fall", String(r + 1));
          // Restart the animation even when the same slot is filled again.
          void disc.offsetWidth;
          disc.classList.add("drop");
        }
      }
    }
    this.el.setAttribute(
      "aria-label",
      last ? `Board. Last move: ${colourName(last.player)} in column ${last.col + 1}.` : "Board. Empty."
    );
  }
}
