// Asks the computer for a move. In a Web Worker where the browser supports
// module workers, on this thread otherwise. Only the latest request is
// answered: an undo or a new game makes any pending one stale.

import { chooseMove, firstMover, positionFrom } from "./engine.js";

let worker = null;
let workerFailed = false;
let latest = 0;
const waiting = new Map();
let pendingHere = null;

function runHere(id, resolve) {
  const { seed, level, moves } = pendingHere;
  const pos = positionFrom(firstMover(seed), moves);
  resolve(pos ? chooseMove(pos, level, seed) : null);
}

function getWorker() {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL("./ai-worker.js", import.meta.url), { type: "module" });
    worker.addEventListener("message", (e) => {
      const resolve = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      resolve?.(e.data.col);
    });
    worker.addEventListener("error", () => {
      // A browser without module workers: fall back for this and every
      // later request.
      workerFailed = true;
      worker = null;
      for (const [id, resolve] of waiting) runHere(id, resolve);
      waiting.clear();
    });
  } catch {
    workerFailed = true;
    worker = null;
  }
  return worker;
}

// Resolves with the column, or null if a newer request replaced this one.
export function requestMove(seed, level, moves) {
  const id = ++latest;
  const payload = { id, seed, level, moves: moves.slice() };
  return new Promise((resolve) => {
    const done = (col) => resolve(id === latest ? col : null);
    const w = getWorker();
    pendingHere = payload;
    if (w) {
      waiting.set(id, done);
      w.postMessage(payload);
    } else {
      // Let the page paint "thinking" first.
      setTimeout(() => runHere(id, done), 30);
    }
  });
}

// Makes any request in flight stale.
export function cancelMove() {
  latest++;
}
