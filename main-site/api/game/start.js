// POST /api/game/start  { client_key, mode, level? }
//   -> { game_id, seed, created_at }
// The start ticket. A game can only go on the leaderboard if it began here,
// which gives it a start time no browser can move and a seed nobody could
// have practised: the server always picks it. Games started offline, and
// games on a pasted seed, play the same; they just have no ticket.
//
// mode is "computer" or "network". level is easy, medium, hard or expert,
// for a computer game only. The browser that asks is Red: the player against
// the computer, or the host of a network game.

import { randomInt } from "node:crypto";
import { endpoint, HttpError, clientKey, limit } from "../_lib/http.js";
import { rest, rpc } from "../_lib/supabase.js";
import { makeSeed, COMPUTER_LEVELS } from "../../js/engine.js";

export default endpoint("POST", async ({ req, body }) => {
  const key = clientKey(body.client_key);
  const mode = body.mode;
  if (mode !== "computer" && mode !== "network") throw new HttpError(400, "bad_mode");

  let level = null;
  if (mode === "computer") {
    level = body.level;
    if (!COMPUTER_LEVELS.includes(level)) throw new HttpError(400, "bad_level");
  }

  await limit(req, "start", 600, 120);

  const seed = makeSeed(() => randomInt(256));
  const [row] = await rest("connect4_games?select=id,created_at", {
    method: "POST",
    prefer: "return=representation",
    body: { mode, seed, level, host_key: key },
  });

  // Now and then, clear out what nobody will submit.
  if (Math.random() < 0.02) rpc("connect4_prune", {}).catch(() => {});

  return { game_id: row.id, seed, created_at: row.created_at };
});
