// =============================================================================
//  Edge Function : video-url
//  Renvoie une URL signée (60 min) vers une vidéo du Storage privé.
//  Gating : les vidéos premium exigent un abonnement actif ; les gratuites
//  sont accessibles à tout utilisateur connecté.
//  Body : { video_id: string }
//  Convention : videos.src contient le CHEMIN dans le bucket 'videos'
//  (ex. 'swim/crawl-rattrape.mp4'), pas une URL publique.
// =============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const BUCKET = "videos";
const SIGNED_TTL = 60 * 60; // 1h

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { video_id } = await req.json();
    if (!video_id) return json({ error: "video_id requis" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Non authentifié" }, 401);

    const { data: video } = await supabase
      .from("videos").select("id, src, is_premium").eq("id", video_id).single();
    if (!video) return json({ error: "Vidéo introuvable" }, 404);
    if (!video.src) return json({ error: "Vidéo non encore uploadée" }, 409);

    // Gating premium.
    if (video.is_premium) {
      const { data: ok } = await supabase.rpc("has_active_subscription", { target: user.id });
      if (!ok) return json({ error: "premium_required" }, 402); // 402 Payment Required
    }

    const { data: signed, error } = await supabase
      .storage.from(BUCKET).createSignedUrl(video.src, SIGNED_TTL);
    if (error) throw error;

    return json({ url: signed.signedUrl });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
