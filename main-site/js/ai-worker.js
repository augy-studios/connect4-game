// The computer thinks here, off the page's thread, so the board stays
// responsive at Expert. It rebuilds the game from the seed and the moves,
// exactly as the API does when it checks a game.

import { chooseMove, firstMover, positionFrom } from "./engine.js";

self.addEventListener("message", (event) => {
  const { id, seed, level, moves } = event.data ?? {};
  const pos = Array.isArray(moves) ? positionFrom(firstMover(seed), moves) : null;
  self.postMessage({ id, col: pos ? chooseMove(pos, level, seed) : null });
});
