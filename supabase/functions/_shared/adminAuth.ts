// =============================================================================
//  Vérification admin — CÔTÉ SERVEUR (21/09/2026).
//  ---------------------------------------------------------------------------
//  Le front a un ADMIN_EMAILS purement cosmétique (sillance-integration.js —
//  débloque juste des tuiles UI, aucune donnée serveur n'en dépend). Ceci est
//  le premier vrai contrôle d'identité admin de la plateforme : sans lui,
//  RLS empêche déjà n'importe qui de lire les données d'autrui (profiles,
//  subscriptions, coach_athlete ne s'ouvrent qu'à soi-même ou via
//  is_coach_of) — donc la fonction admin-crm doit vérifier l'appelant
//  elle-même avant d'utiliser admin() (service_role, qui contourne la RLS).
//  ADMIN_EMAILS ici est un secret Supabase (liste séparée par des virgules),
//  jamais exposé au front — à distinguer du const front de même nom.
// =============================================================================
import { admin } from "./providers.ts";

function adminEmails(): string[] {
  return (Deno.env.get("ADMIN_EMAILS") ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Vérifie le JWT de la requête et renvoie l'utilisateur SEULEMENT s'il est
 *  admin ; sinon renvoie null (l'appelant doit répondre 401/403). Ne fait
 *  jamais confiance à un champ envoyé par le client (body, header custom) —
 *  seule l'identité prouvée par le JWT (vérifié par Supabase Auth) compte. */
export async function requireAdmin(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const sb = admin();
  const { data, error } = await sb.auth.getUser(jwt);
  if (error || !data.user?.email) return null;
  const emails = adminEmails();
  if (!emails.length || !emails.includes(data.user.email.toLowerCase())) return null;
  return data.user;
}
