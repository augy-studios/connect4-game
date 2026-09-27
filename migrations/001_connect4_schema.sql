-- Connect 4 Game (connect4.uwuapps.org) schema, in the shared uwuapps Supabase
-- project. Paste into the Supabase SQL editor and run once. Safe to run
-- again: everything is "if not exists" or "or replace".
--
-- Access model: only the Vercel functions touch these tables, with the
-- service role key. RLS is on with no policies, so an anon key reads nothing.
--
-- The rules of Connect 4 are not in here. The API replays every submitted
-- game with the same js/engine.js the browser plays with, checks every one of
-- the computer's moves, recomputes the score, and only then calls
-- connect4_submit, which does the checks that need the database.
--
-- Sides are 'r' (Red) and 'y' (Yellow). The player against the computer, and
-- the host of a network game, is always Red; the seed decides who moves first.

-- One row per game that could go on the leaderboard: a game against the
-- computer, or a network game, started while online on a seed the server
-- picked. The row is the start ticket; created_at is the server's clock,
-- which a browser cannot move.
create table if not exists connect4_games (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('computer', 'network')),
  seed text not null,                   -- eight characters, see js/engine.js
  level text check (level in ('easy', 'medium', 'hard', 'expert')),
  host_key text not null,               -- the client_key that started it
  created_at timestamptz not null default now(),
  -- Undos the API was told about while the game went on, per side. The
  -- submit charges the higher of these and what the browser reports.
  undos_r int not null default 0,
  undos_y int not null default 0,
  -- The moves as one string of columns, "3342...", and the server's time when
  -- the page reported the game over. Sent again after an undo reopened it.
  moves text,
  finished_at timestamptz,
  check ((mode = 'computer') = (level is not null))
);

create index if not exists connect4_games_created on connect4_games (created_at);

-- Wins only: a game has one winner, so at most one entry.
create table if not exists connect4_leaderboard (
  id bigserial primary key,
  name text not null,
  score int not null check (score >= 0),
  game_id uuid not null unique references connect4_games(id) on delete cascade,
  side text not null check (side in ('r', 'y')),
  mode text not null,
  level text,
  moves smallint not null,              -- the winner's own moves
  created_at timestamptz not null default now()
);

create index if not exists connect4_lb_name on connect4_leaderboard (lower(name), score desc);

-- Each name's best game. The earliest of an equal top score wins, and the
-- casing shown is the one attached to that score.
create or replace view connect4_leaderboard_best
with (security_invoker = true) as
select distinct on (lower(name)) name, score, mode, level, moves, created_at
from connect4_leaderboard
order by lower(name), score desc, created_at asc;

-- Every submitted game added up per name. The casing shown is the most
-- recent one.
create or replace view connect4_leaderboard_total
with (security_invoker = true) as
select
  (array_agg(name order by created_at desc))[1] as name,
  sum(score)::bigint as total,
  count(*)::int as games,
  max(created_at) as last_at
from connect4_leaderboard
group by lower(name);

-- Fixed window counters for rate limiting by (hashed) IP. There are no
-- accounts to limit against, and Vercel functions share no memory.
create table if not exists connect4_rate_limits (
  bucket text primary key,
  window_start timestamptz not null,
  hits int not null
);

alter table connect4_games enable row level security;
alter table connect4_leaderboard enable row level security;
alter table connect4_rate_limits enable row level security;

-- True while the bucket is under its limit. One statement, so concurrent
-- hits cannot both read the old count.
create or replace function connect4_hit(p_bucket text, p_window_seconds int, p_max int)
returns boolean
language sql
volatile
as $$
  insert into connect4_rate_limits as r (bucket, window_start, hits)
  values (p_bucket, now(), 1)
  on conflict (bucket) do update set
    window_start = case
      when r.window_start < now() - make_interval(secs => p_window_seconds) then now()
      else r.window_start end,
    hits = case
      when r.window_start < now() - make_interval(secs => p_window_seconds) then 1
      else r.hits + 1 end
  returning hits <= p_max;
$$;

-- Records one undo against a side of a live game, until the game is on the
-- leaderboard. A computer game's undo only counts from the browser that
-- started it; a network game's Red side likewise, and its Yellow side from
-- any other browser.
create or replace function connect4_undo(p_game_id uuid, p_client_key text, p_side text)
returns int
language plpgsql
volatile
as $$
declare
  v_game connect4_games%rowtype;
begin
  select * into v_game from connect4_games where id = p_game_id for update;
  if not found or v_game.created_at < now() - interval '12 hours' then
    return null;
  end if;
  if exists (select 1 from connect4_leaderboard l where l.game_id = p_game_id) then
    return null;
  end if;
  if (v_game.mode = 'computer' or p_side = 'r') and p_client_key <> v_game.host_key then
    return null;
  end if;
  if v_game.mode = 'network' and p_side = 'y' and p_client_key = v_game.host_key then
    return null;
  end if;
  if p_side = 'r' then
    update connect4_games set undos_r = undos_r + 1 where id = p_game_id returning undos_r into v_game.undos_r;
    return v_game.undos_r;
  end if;
  if p_side = 'y' then
    update connect4_games set undos_y = undos_y + 1 where id = p_game_id returning undos_y into v_game.undos_y;
    return v_game.undos_y;
  end if;
  return null;
end;
$$;

-- Records the end of a game: its moves and the server's time. The API has
-- replayed the moves first. Sent again after an undo reopened the game, it
-- records the new ending; once the game is on the leaderboard it is fixed.
--
--   not_found, expired, not_yours  as for connect4_submit
--   mismatch                       the game is on the board with other moves
create or replace function connect4_finish(p_game_id uuid, p_client_key text, p_moves text)
returns table (status text, created_at timestamptz, finished_at timestamptz)
language plpgsql
volatile
as $$
#variable_conflict use_column
declare
  v_game connect4_games%rowtype;
begin
  select * into v_game from connect4_games where id = p_game_id for update;
  if not found then
    return query select 'not_found'::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  if v_game.created_at < now() - interval '12 hours' then
    return query select 'expired'::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  -- A computer game's end only from the browser that started it. Either
  -- player of a network game may send it; it is the same game on both.
  if v_game.mode = 'computer' and p_client_key <> v_game.host_key then
    return query select 'not_yours'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if exists (select 1 from connect4_leaderboard l where l.game_id = p_game_id) then
    if v_game.moves is distinct from p_moves then
      return query select 'mismatch'::text, null::timestamptz, null::timestamptz;
      return;
    end if;
  elsif v_game.moves is distinct from p_moves then
    -- A new ending: the first, or one after an undo.
    update connect4_games set moves = p_moves, finished_at = now() where id = p_game_id
    returning finished_at into v_game.finished_at;
  end if;

  return query select 'ok'::text, v_game.created_at, v_game.finished_at;
end;
$$;

-- Puts the winner of a verified game on the board. The API has already
-- replayed the moves, checked the computer's, checked the turn times against
-- its own clock, and computed the score; this checks what only the database
-- can:
--
--   not_found          no such game
--   expired            started more than 12 hours ago
--   not_yours          a computer game, or a network game's Red side,
--                      submitted from a browser other than the one that
--                      started it
--   same_device        a network game's Yellow side submitted from the host's
--                      own browser: one person playing both sides
--   already_submitted  this game is already on the board
--   mismatch           the page reported the game ending with other moves
--   too_fast           finished sooner than half a second per own move, or
--                      under four seconds in all
--   overlap            played while another game on the board under this
--                      name was also being played
create or replace function connect4_submit(
  p_game_id uuid,
  p_side text,
  p_name text,
  p_client_key text,
  p_moves text,
  p_score int,
  p_own_moves int
)
returns table (status text, best_score int, rank bigint, total bigint, games int, total_rank bigint)
language plpgsql
volatile
as $$
#variable_conflict use_column
declare
  v_game connect4_games%rowtype;
  v_ended timestamptz;
  v_best int;
  v_best_at timestamptz;
  v_total bigint;
  v_games int;
begin
  select * into v_game from connect4_games where id = p_game_id for update;

  if not found then
    return query select 'not_found'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  if v_game.created_at < now() - interval '12 hours' then
    return query select 'expired'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;

  if (v_game.mode = 'computer' or p_side = 'r') and p_client_key <> v_game.host_key then
    return query select 'not_yours'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  if v_game.mode = 'network' and p_side = 'y' and p_client_key = v_game.host_key then
    return query select 'same_device'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;

  if exists (select 1 from connect4_leaderboard l where l.game_id = p_game_id) then
    return query select 'already_submitted'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  if v_game.moves is not null and v_game.moves <> p_moves then
    return query select 'mismatch'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;

  -- The end as the server saw it: when the page reported it, or now.
  v_ended := coalesce(v_game.finished_at, now());
  if v_ended - v_game.created_at < make_interval(secs => greatest(4, p_own_moves * 0.5)) then
    return query select 'too_fast'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;

  -- One submission per name at a time, so two sent together cannot both
  -- miss each other in the check below.
  perform pg_advisory_xact_lock(hashtext('connect4_submit:' || lower(p_name)));

  -- Another game on the board under this name whose play time crosses this
  -- one's: a person plays one game at a time.
  if exists (
    select 1
    from connect4_leaderboard l
    join connect4_games g on g.id = l.game_id
    where lower(l.name) = lower(p_name)
      and l.game_id <> p_game_id
      and g.created_at < v_ended
      and coalesce(g.finished_at, l.created_at) > v_game.created_at
  ) then
    return query select 'overlap'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;

  if v_game.moves is null then
    update connect4_games set moves = p_moves, finished_at = now() where id = p_game_id;
  end if;

  insert into connect4_leaderboard (name, score, game_id, side, mode, level, moves)
  values (p_name, p_score, p_game_id, p_side, v_game.mode, v_game.level, p_own_moves);

  select l.score, l.created_at into v_best, v_best_at
  from connect4_leaderboard l
  where lower(l.name) = lower(p_name)
  order by l.score desc, l.created_at asc
  limit 1;

  select sum(l.score)::bigint, count(*)::int into v_total, v_games
  from connect4_leaderboard l
  where lower(l.name) = lower(p_name);

  return query
  select
    'ok'::text,
    v_best,
    (
      select count(*) + 1
      from connect4_leaderboard_best b
      where b.score > v_best or (b.score = v_best and b.created_at < v_best_at)
    ),
    v_total,
    v_games,
    (
      select count(*) + 1
      from connect4_leaderboard_total t
      where lower(t.name) <> lower(p_name)
        and (
          t.total > v_total
          or (t.total = v_total and t.games < v_games)
          -- This name's total was only just reached, so an equal one got there first.
          or (t.total = v_total and t.games = v_games)
        )
    );
end;
$$;

-- Housekeeping, called now and then by /api/game/start: old counters, and
-- games nobody submitted that are past any use.
create or replace function connect4_prune()
returns void
language sql
volatile
as $$
  delete from connect4_rate_limits where window_start < now() - interval '1 day';
  delete from connect4_games g
  where g.created_at < now() - interval '2 days'
    and not exists (select 1 from connect4_leaderboard l where l.game_id = g.id);
$$;

-- Service role only.
revoke all on function connect4_hit(text, int, int) from public, anon, authenticated;
revoke all on function connect4_undo(uuid, text, text) from public, anon, authenticated;
revoke all on function connect4_finish(uuid, text, text) from public, anon, authenticated;
revoke all on function connect4_submit(uuid, text, text, text, text, int, int) from public, anon, authenticated;
revoke all on function connect4_prune() from public, anon, authenticated;
grant execute on function connect4_hit(text, int, int) to service_role;
grant execute on function connect4_undo(uuid, text, text) to service_role;
grant execute on function connect4_finish(uuid, text, text) to service_role;
grant execute on function connect4_submit(uuid, text, text, text, text, int, int) to service_role;
grant execute on function connect4_prune() to service_role;
