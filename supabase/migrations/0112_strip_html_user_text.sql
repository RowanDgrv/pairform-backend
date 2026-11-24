-- =============================================================================
--  0112 — SECURITY : retire « < » et « > » des textes courts saisis par les
--  utilisateurs et affichés chez d'AUTRES utilisateurs (noms, titres, lieux).
--  ---------------------------------------------------------------------------
--  Pourquoi (audit du 24/11/2026) : l'app insère plusieurs de ces champs dans le
--  HTML sans les échapper (ex. nom d'athlète dans la vue coach, titre de séance,
--  nom de groupe, titre d'activité Strava/COROS). La CSP bloque les scripts en
--  ligne, mais un nom piégé du type <iframe srcdoc="<script src=…>"> chargeait du
--  code depuis un domaine autorisé (esm.sh) : vol de session possible. esm.sh est
--  retiré de la CSP côté site ; ce trigger ferme la porte côté serveur, pour tous
--  les clients (site, app mobile, connecteur), quel que soit le rendu.
--  Aucun nom ou titre légitime n'a besoin de ces deux caractères (vérifié : 0
--  valeur concernée en base au 24/11). Les messages et publications, eux, sont
--  échappés à l'affichage et ne sont PAS modifiés ici (« <3 » y reste possible).
-- =============================================================================
create or replace function public.strip_angle_brackets()
returns trigger language plpgsql set search_path = public as $$
declare
  c text;
  j jsonb := to_jsonb(new);
  v text;
begin
  -- SECURITY: les noms de colonnes viennent de la définition du trigger (TG_ARGV), jamais de l'utilisateur
  foreach c in array tg_argv loop
    v := j->>c;
    if v is not null and v ~ '[<>]' then
      j := jsonb_set(j, array[c], to_jsonb(translate(v, '<>', '')));
    end if;
  end loop;
  new := jsonb_populate_record(new, j);
  return new;
end $$;

do $$
declare r record;
begin
  for r in select * from (values
    ('profiles',           array['first_name','last_name','full_name']),
    ('clubs',              array['name']),
    ('club_groups',        array['name','description']),
    ('club_competitions',  array['name']),
    ('coach_cycles',       array['name']),
    ('coach_offers',       array['name']),
    ('conversations',      array['title']),
    ('creneaux',           array['title','description','place']),
    ('scheduled_sessions', array['title']),
    ('sessions',           array['title']),
    ('library_sessions',   array['title']),
    ('races',              array['name','location']),
    ('race_debriefs',      array['race_name']),
    ('spectator_links',    array['race_name']),
    ('gear',               array['name']),
    ('athlete_equipment',  array['label']),
    ('records',            array['label']),
    ('external_activities',array['name']),
    ('assistant_tokens',   array['label'])
  ) as t(tbl, cols)
  loop
    execute format('drop trigger if exists trg_strip_angle_brackets on public.%I', r.tbl);
    execute format(
      'create trigger trg_strip_angle_brackets before insert or update on public.%I
         for each row execute function public.strip_angle_brackets(%s)',
      r.tbl, (select string_agg(quote_literal(x), ',') from unnest(r.cols) x));
  end loop;
end $$;
