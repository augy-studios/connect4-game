// POST /api/game/finish  { game_id, client_key, moves } -> { elapsed_ms }
// Sent by the page the moment a game ends, so the server's clock stops then
// and not whenever somebody gets round to submitting: watching the replay or
// typing a name costs nothing. The moves are replayed, but the computer's are
// left for submit to check: this has to be quick.

import { endpoint, HttpError, clientKey, gameId, limit } from "../_lib/http.js";
import { rest, rpc } from "../_lib/supabase.js";
import { readMoves, settle, movesText } from "../_lib/verify.js";

const REFUSALS = {
  not_found: [404, "That game does not exist."],
  expired: [410, "That game started more than 12 hours ago."],
  not_yours: [403, "That game was started in a different browser."],
  mismatch: [409, "That game is already on the leaderboard with other moves."],
};

export default endpoint("POST", async ({ req, body }) => {
  const id = gameId(body.game_id);
  const key = clientKey(body.client_key);
  const moves = readMoves(body.moves);

  await limit(req, "finish", 600, 120);

  const [game] = (await rest(`connect4_games?id=eq.${id}&select=*`)) ?? [];
  if (!game) throw new HttpError(404, "not_found", REFUSALS.not_found[1]);
  settle(game, moves);

  const [row] = (await rpc("connect4_finish", { p_game_id: id, p_client_key: key, p_moves: movesText(moves) })) ?? [];
  if (row?.status !== "ok") {
    const [status, message] = REFUSALS[row?.status] ?? [500, "Could not record the end of the game."];
    throw new HttpError(status, row?.status ?? "server", message);
  }
  return { elapsed_ms: Date.parse(row.finished_at) - Date.parse(row.created_at) };
});
