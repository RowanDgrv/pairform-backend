-- =============================================================================
--  0044 — API "assistant" : lecture + écriture du compte de l'athlète depuis un
--  agent externe (ChatGPT custom GPT, Claude, script perso).
--  ---------------------------------------------------------------------------
--  Besoin : Rowan (compte admin) veut piloter SES données Sillance depuis
--  ChatGPT — consulter sa charge, ajouter/modifier des séances, saisir un
--  check-in — comme il le fait avec Claude Code sur le dépôt.
--
--  Modèle : un JETON opaque (Bearer) → un athlete_id + un droit d'écriture.
--  L'edge function `assistant-api` (service_role) résout le jeton et BORNE
--  toutes les requêtes à cet athlete_id. Impossible d'adresser un autre compte.
--
--  Traçabilité : toute écriture est journalisée dans assistant_writes avec
--  l'image AVANT (pour pouvoir annuler à la main) et APRÈS.
--
--  Sécurité :
--    • jetons stockés HACHÉS (sha256) — la valeur en clair n'existe qu'une fois,
--      au moment de la génération (assistant_mint_token).
--    • RLS activée sans policy → service_role uniquement (les edge functions).
--    • révocation : poser revoked_at (le jeton est refusé immédiatement).
--    • can_write=false par défaut → lecture seule tant qu'on ne l'ouvre pas.
-- =============================================================================
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
--  1. Jetons d'accès
-- ---------------------------------------------------------------------------
create table if not exists assistant_tokens (
  token_hash   text        primary key,                 -- sha256 hex du jeton en clair
  athlete_id   uuid        not null references profiles(id) on delete cascade,
  label        text        not null default 'assistant',  -- ex. "ChatGPT perso"
  can_write    boolean     not null default false,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists assistant_tokens_athlete_idx on assistant_tokens(athlete_id);

alter table assistant_tokens enable row level security;  -- aucune policy = service_role only

comment on table assistant_tokens is
  'Jetons Bearer pour l''API assistant (ChatGPT/Claude/script). Hachés. '
  'Un jeton = un athlete_id + un droit d''écriture. Révocation via revoked_at.';

-- ---------------------------------------------------------------------------
--  2. Journal des écritures faites par l'assistant
-- ---------------------------------------------------------------------------
create table if not exists assistant_writes (
  id          uuid        primary key default gen_random_uuid(),
  athlete_id  uuid        not null references profiles(id) on delete cascade,
  op          text        not null,               -- ex. "session.create", "checkin.upsert"
  target_id   text,                                -- id de la ligne touchée (si applicable)
  params      jsonb       not null default '{}'::jsonb,
  before      jsonb,                               -- image avant (update/delete) → annulation manuelle
  after       jsonb,                               -- image après
  ok          boolean     not null default true,
  error       text,
  at          timestamptz not null default now()
);
create index if not exists assistant_writes_athlete_at_idx on assistant_writes(athlete_id, at desc);

alter table assistant_writes enable row level security;  -- service_role only

comment on table assistant_writes is
  'Journal de TOUTE écriture passée par l''API assistant, avec image avant/après '
  'pour permettre une annulation manuelle. Lecture via GET /history.';

-- ---------------------------------------------------------------------------
--  3. Génération d'un jeton — renvoie la valeur EN CLAIR une seule fois
--  ---------------------------------------------------------------------------
--  Usage (SQL Editor du dashboard) :
--    select assistant_mint_token(
--      (select id from profiles where email = 'rowandegraeve@gmail.com'),
--      'ChatGPT perso',
--      true            -- can_write
--    );
--  → copier la chaîne renvoyée : c'est le Bearer à coller dans ChatGPT.
--    Elle n'est PAS récupérable ensuite (seul le hash est stocké).
-- ---------------------------------------------------------------------------
create or replace function assistant_mint_token(
  p_athlete uuid,
  p_label   text default 'assistant',
  p_write   boolean default false
) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token text;
begin
  if p_athlete is null then
    raise exception 'athlete_id requis';
  end if;
  -- 32 octets aléatoires en base32-ish hex → jeton opaque de 64 caractères
  v_token := 'sil_' || encode(gen_random_bytes(32), 'hex');
  insert into assistant_tokens (token_hash, athlete_id, label, can_write)
  values (encode(digest(v_token, 'sha256'), 'hex'), p_athlete, coalesce(p_label, 'assistant'), coalesce(p_write, false));
  return v_token;
end;
$$;

revoke all on function assistant_mint_token(uuid, text, boolean) from public, anon, authenticated;
