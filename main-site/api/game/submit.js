// POST /api/game/submit
//   { game_id, client_key, name, side, moves, turns, undos? }
//   -> { name, score, elapsed_ms, rank, best_score, total, games, total_rank }
// side is the winner being submitted, "r" or "y". moves is the whole game as
// column numbers, 0 to 6. turns is one time per move, in milliseconds. The
// score is computed here from the replayed moves, the server's own time for
// the whole game, and the winner's turn times; see verify.js for the checks
// on the game and connect4_submit in the migration for the rest.

import { endpoint, HttpError, clientKey, gameId, side as readSide, limit } from "../_lib/http.js";
import { cleanName } from "../_lib/names.js";
import { rest, rpc } from "../_lib/supabase.js";
import { readMoves, readTurns, verify, movesText } from "../_lib/verify.js";

const REFUSALS = {
  not_found: [404, "That game does not exist."],
  expired: [410, "That game started more than 12 hours ago."],
  not_yours: [403, "That game was started in a different browser."],
  same_device: [409, "Both sides of that game were played from one browser, so it stays off the leaderboard."],
  already_submitted: [409, "That game is already on the leaderboard."],
  mismatch: [409, "Those moves do not match the end of the game the server recorded."],
  too_fast: [409, "That game was played too quickly to count."],
  overlap: [409, "That game was played at the same time as another one already on the leaderboard under this name."],
};

export default endpoint("POST", async ({ req, body }) => {
  const id = gameId(body.game_id);
  const key = clientKey(body.client_key);
  const name = cleanName(body.name);
  const who = readSide(body.side);
  const moves = readMoves(body.moves);
  const turns = readTurns(body.turns, moves.length);
  const reported = Number.isInteger(body.undos) && body.undos >= 0 ? Math.min(body.undos, 10000) : 0;

  // Replaying against Expert is real work, so this is limited harder than
  // anything else.
  await limit(req, "submit", 600, 60);

  const [game] = (await rest(`connect4_games?id=eq.${id}&select=*`)) ?? [];
  if (!game) throw new HttpError(404, "not_found", REFUSALS.not_found[1]);

  // The game's end as the server saw it: when the page reported it, if the
  // moves then are these moves, and otherwise now.
  const text = movesText(moves);
  const endedAt = game.finished_at && game.moves === text ? Date.parse(game.finished_at) : Date.now();
  const elapsed = endedAt - Date.parse(game.created_at);

  const recorded = who === "r" ? game.undos_r : game.undos_y;
  const result = verify(game, moves, who, turns, Math.max(reported, recorded ?? 0), elapsed);

  const [row] =
    (await rpc("connect4_submit", {
      p_game_id: id,
      p_side: who,
      p_name: name,
      p_client_key: key,
      p_moves: text,
      p_score: result.score,
      p_own_moves: result.ownMoves,
    })) ?? [];
  if (row?.status !== "ok") {
    const [status, message] = REFUSALS[row?.status] ?? [500, "Could not submit."];
    throw new HttpError(status, row?.status ?? "server", message);
  }

  return {
    name,
    score: result.score,
    elapsed_ms: elapsed,
    rank: Number(row.rank),
    best_score: row.best_score,
    total: Number(row.total),
    games: row.games,
    total_rank: Number(row.total_rank),
  };
});
