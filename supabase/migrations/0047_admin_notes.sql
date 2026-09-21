-- Notes internes admin (page CRM de maintenance, 21/09/2026). Table dédiée,
-- RLS activée SANS AUCUNE policy : ni anon ni authenticated ne peuvent lire
-- ou écrire quoi que ce soit dessus, quel que soit leur rôle applicatif —
-- seule la clé service_role (utilisée par la fonction edge admin-crm, après
-- vérification serveur de l'identité admin) peut y accéder. C'est le même
-- principe que les triggers guard_sensitive_*_columns : la sécurité vient
-- du bypass RLS du service_role, pas d'une policy applicative fragile.
create table if not exists admin_notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  note        text not null,
  created_by  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_admin_notes_user on admin_notes(user_id);
alter table admin_notes enable row level security;
