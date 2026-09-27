// The leaderboard API. Games are played entirely in the browser; the API
// hands out start tickets, counts undos, and checks and scores finished
// games.

const KEY_STORAGE = "connect4.clientKey";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// A random id tying this browser's submissions to the games it started. Not
// an identity: it grants nothing and is never shown.
function makeKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let memoryKey = null;

export function clientKey() {
  try {
    let key = localStorage.getItem(KEY_STORAGE);
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(key ?? "")) {
      key = makeKey();
      localStorage.setItem(KEY_STORAGE, key);
    }
    return key;
  } catch {
    memoryKey ??= makeKey();
    return memoryKey;
  }
}

async function call(method, path, body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "offline", "That needs a connection.");
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // An HTML error page from the platform, not the API.
  }
  if (!response.ok) throw new ApiError(response.status, data?.error ?? "server", data?.message);
  return data;
}

export const api = {
  // The server always picks the seed: a ticket is what makes a game scored.
  start: ({ mode, level }) => call("POST", "/api/game/start", { client_key: clientKey(), mode, level }),
  undo: (gameId, side) => call("POST", "/api/game/undo", { game_id: gameId, client_key: clientKey(), side }),
  finish: (body) => call("POST", "/api/game/finish", { ...body, client_key: clientKey() }),
  submit: (body) => call("POST", "/api/game/submit", { ...body, client_key: clientKey() }),
  checkName: (name) => call("POST", "/api/leaderboard/name", { name }),
  leaderboard: (board) => call("GET", `/api/leaderboard?board=${encodeURIComponent(board)}`),
};
