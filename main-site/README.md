# main-site

What Vercel deploys, served at <https://connect4.uwuapps.org>. No build step:
the files are served as they are, and `api/` holds the serverless functions.

| Path | What it is |
| --- | --- |
| `index.html` | The only page. Its `<head>` is the template for any page added later. |
| `404.html`, `404.css` | The shared not-found page, left as it was. |
| `sw.js` | Service worker: the offline shell, and the update bar's waiting worker. |
| `manifest.json` | PWA manifest. |
| `css/theme.css` | The uwuapps theme, verbatim from `uwuapps-theme.md`, time-based mode included. |
| `css/style.css` | Layout and the board. Disc, board and QR colours are tokens at the top. |
| `js/` | ES modules, below. |
| `api/` | The leaderboard API, below. |
| `images/` | Manifest screenshots, at the sizes `manifest.json` gives. |

## js

Every file here is precached; `scripts/check-precache.mjs` fails if one is
not. `engine.js` is pure, with no DOM, and the API imports it too, so the
browser and the server always agree on a game.

| File | What it does |
| --- | --- |
| `engine.js` | The rules, seeds, the computer (alpha-beta search), checking a finished game, and scoring. |
| `ai-worker.js`, `computer.js` | The computer's Web Worker, and the page's side of it. |
| `board.js` | The board on screen: tap a column, or arrow keys and Enter, or the number keys 1 to 7. |
| `game.js` | The game screen: setup, play, undo, result, submit, saving. |
| `replay.js` | The instant replay. |
| `net.js` | Pairing over PeerJS, STUN only, from `STUN-p2p-spec.md`. |
| `multiplayer.js` | Network games on top of `net.js`: hosting, joining, and the messages. |
| `qr.js` | QR encoder for the join link, from uwuPromptr, so it works offline. |
| `confetti.js` | Confetti for a win, in the theme's colours. Off under reduced motion. |
| `api.js`, `leaderboard.js`, `settings.js` | The API client, and the leaderboard and settings windows, after MRT Station Guesser's. |
| `theme.js`, `icons.js`, `ui.js`, `update-bar.js`, `app.js` | Theme, inline SVG icons, modal and storage helpers, the update bar, and boot. |

## The game

**Modes.** Against the computer; two people taking turns on this device; or
two devices on one network, one hosting with a six character code, a link or a
QR code, and the other joining. The player against the computer, and a network
game's host, is Red; the seed decides who moves first.

**Seeds.** Eight letters and numbers, such as `K7XQ2MPD`. A seed decides who
moves first and every choice the computer makes, so the same seed and the same
moves are always the same game. It shows during play and at the end, where it
can be copied; paste one into the new-game screen to play that game again.
**A pasted seed is practice and is never scored**: the computer is
deterministic, so a winning line against a known seed could be replayed for
full points every time.

**The computer.** Four levels, searching further ahead each time. Easy and
Medium sometimes play a random column; Hard and Expert never do, and pick
between equally good columns by the seed. It runs in a Web Worker and never
reads the clock or `Math.random`, which is what lets the API replay a game and
check every one of its moves.

| Level | Looks ahead | Random column | Score multiplier |
| --- | --- | --- | --- |
| Easy | 2 moves | 35% | ×1 |
| Medium | 4 | 10% | ×2 |
| Hard | 6 | never | ×3.5 |
| Expert | 10 | never | ×5 |
| Network game | | | ×2 |

**Moving.** Tap or click a column. A ghost disc shows where it will land (a
setting turns this off). The last move's disc is marked and its row lit, and a
win rings its four.

**Undo.** Unlimited, in every mode, including after the game has ended, until
it is on the leaderboard. Against the computer it takes back your move and its
reply. In a network game it asks the other player, who accepts or declines.
Each undo takes 10% off a win's score. It gives no time back.

**Replay.** When a game ends the winning line stays up for a moment, then the
game plays back on the board by itself (a setting turns this off), with play,
pause, a step back or forward, a jump to either end, a slider and the move
list. It plays at 0.5×, 1×, 2× or 4×, remembered in this browser.

**Sharing a replay.** Share replay, on any finished game, makes a link such
as `/?watch=3322114&seed=K7XQ2MPD&game=hard`, through the device's share
sheet where it has one and the clipboard otherwise, after chess-game's. The
link is the whole game: the seed, each column played as one digit, and the kind
of game (`easy` to `expert` against the computer, `local` or `network`).
Nothing is stored anywhere, and a link opens offline once the site has been
visited. Opening one plays the replay from the empty board without touching
the viewer's own saved game; Close replay goes back to it, and Play this seed
fills in the new-game screen, where it is practice like any pasted seed. A
shared replay shows no score, since a link can be edited and only the
leaderboard's scores are checked.

**Scoring.** Only wins score. The "Win now" figure during play is what a win
on the next move would be worth, and it falls as the game goes on.

| | Points |
| --- | --- |
| A win | 500 |
| Each of the winner's moves under 21 | 40 |
| Each of the winner's turns | up to 20, one fewer per second taken |
| The whole game | up to 300, one fewer per second taken |

The total is multiplied by the level (table above), then each undo takes 10%
off. The whole game's time is the server's, from the start ticket to the moment
the page reports the win (`/api/game/finish`), so watching the replay or typing
a name afterwards costs nothing.

## The leaderboard and anti-cheat

Wins against the computer and network wins count; games on one device do
not. Two boards: each name's best win, and every win under a name added up.
Whoever wins, host or guest, gets the name box on their own screen and can
type any name, with their saved name filled in.

A game counts only if it started online: starting asks `/api/game/start` for a
ticket, whose seed and start time come from the server. Games started offline,
and games on a pasted seed, play the same and say they are not scored.

On submit the API trusts nothing but the name and the per-turn times. It
replays every move from the seed and refuses an illegal one. It reads the
winner off the final position. It replays the computer at every one of its
moves and refuses any that differ. It computes the score itself. It refuses:

| Code | When |
| --- | --- |
| `not_computer` | a computer move is not the one this computer plays at this level and seed |
| `not_won` | the side submitted did not win |
| `too_fast` | one of the winner's turns, or in a network game any turn, took under 0.25 s |
| `clock` | the winner's turn times add up to more than the game took on the server's clock |

The database then refuses a submission that:

| Code | When |
| --- | --- |
| `not_yours` | a computer game, or a network game's Red side, sent from a browser other than the one that started it |
| `same_device` | a network game's Yellow side, sent from the host's own browser |
| `already_submitted` | the game is already on the board |
| `mismatch` | the moves differ from the ending the page reported |
| `too_fast` | the game took under half a second per own move, or under four seconds |
| `overlap` | the game was played at the same time as another on the board under the same name |

Undos are counted on the server as they happen, from browsers that are
online, and a submission is charged the higher of that count and its own.

None of this stops somebody using a Connect 4 solver in another tab, two people
agreeing to let one of them win a network game, or an undo made offline and
then hidden. It is meant to stop scripted and replayed games, not to prove who
played the moves.

## Network games

Per `STUN-p2p-spec.md`: STUN only, no TURN relay. **Both devices have to be
on the same network**: the same wifi, or one sharing a hotspot with the
other. PeerJS loads from cdnjs only when somebody hosts or joins, and is never
cached. The host holds the game and sends it in full 20 times a second; the
guest sends moves and undo requests. A guest that reloads or drops rejoins
with the same code, and leaving on purpose retires it. A join link is
`/?join=CODE`.

## Offline and updates

Everything the page loads is precached, the computer's worker and the Jua
font included, so the site opens and plays with no connection. Only the
leaderboard and network games need the network. Nothing under `/api/` is
ever cached.

A new service worker installs and waits. The update bar offers Reload or Not
now, and nothing reloads until the reader asks. Bump `VERSION` in `sw.js` on
every change to anything in this directory.

## API

| Endpoint | Body | Returns |
| --- | --- | --- |
| `POST /api/game/start` | `client_key, mode, level?` | `game_id, seed, created_at` |
| `POST /api/game/undo` | `game_id, client_key, side` | `undos` |
| `POST /api/game/finish` | `game_id, client_key, moves` | `elapsed_ms` |
| `POST /api/game/submit` | `game_id, client_key, name, side, moves, turns, undos?` | `name, score, elapsed_ms, rank, best_score, total, games, total_rank` |
| `POST /api/leaderboard/name` | `name` | `name`, cleaned, or a `400` saying why not |
| `GET /api/leaderboard` | `?board=best` or `?board=total` | `board, entries`, cached 30 s |

`mode` is `computer` or `network`; `level` is `easy`, `medium`, `hard` or
`expert`. `side` is `r` or `y`. `moves` is the columns played, 0 to 6, and
`turns` the milliseconds each move took, one per move. Errors are
`{ error, message? }` with a matching status. Start and finish are limited to
120 an address per 10 minutes, and submit to 60. Submit replays the whole
game, so `vercel.json` gives it up to 60 seconds, although an Expert game
takes around a second.

## Environment variables (Vercel)

Documented in `.env.example`. `.vercelignore` keeps every env file out of
deployments, since anything in this directory would otherwise be served.

| Variable | Used for |
| --- | --- |
| `SUPABASE_URL` | The shared uwuapps project. |
| `SUPABASE_SERVICE_KEY` | Service role key. Server side only, never sent to a browser. |
