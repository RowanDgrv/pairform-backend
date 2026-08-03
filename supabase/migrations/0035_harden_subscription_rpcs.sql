-- Durcissement RPC (constat sécurité audit 03/08/2026) : has_active_subscription
-- et has_ai_addon acceptent un user_id/target arbitraire et étaient exécutables
-- directement via PostgREST (POST /rest/v1/rpc/...) par anon/authenticated —
-- un oracle public permettant de tester le statut d'abonnement de n'importe
-- quel utilisateur (testé en direct par l'audit : 200/false sur un UUID
-- arbitraire).
--
-- Les deux seuls appelants légitimes (edge functions video-url et
-- session-summary) tournent avec la service_role key et résolvent déjà
-- l'utilisateur via son JWT avant d'appeler la fonction avec SON PROPRE id —
-- ils n'ont donc besoin d'aucun accès public à cette RPC. On ne change pas
-- la signature des fonctions (auth.uid() y vaudrait NULL dans un contexte
-- service_role, ça casserait ces deux appelants) : on retire simplement le
-- droit d'exécution des rôles publics, la service_role continue de bypasser
-- les grants comme d'habitude.
revoke execute on function has_active_subscription(uuid) from public, anon, authenticated;
revoke execute on function has_ai_addon(uuid) from public, anon, authenticated;
