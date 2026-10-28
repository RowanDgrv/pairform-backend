-- =============================================================================
--  0073 — Journal des échecs de l'assistant IA (28/10/2026)
--  Alimenté par _shared/aiAlert.ts (session-summary, week-review,
--  ai-report-failure). Sert aussi d'anti-spam : 1 email par utilisateur et
--  par fonction toutes les 30 min (colonne alerted). Lecture/écriture
--  service_role uniquement (RLS activée, aucune policy).
-- =============================================================================
create table if not exists public.ai_failures (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  user_id     uuid references public.profiles(id) on delete set null,
  fn          text not null,
  stage       text not null,
  detail      text not null,
  attempts    jsonb,
  error       text,
  context     jsonb,
  alerted     boolean not null default true
);
alter table public.ai_failures enable row level security;
create index if not exists idx_ai_failures_user_fn on public.ai_failures (user_id, fn, created_at desc);
