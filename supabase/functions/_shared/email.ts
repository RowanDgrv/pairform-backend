// =============================================================================
//  Lib partagée — envoi d'emails transactionnels via Resend.
//  Si RESEND_API_KEY est absent, l'envoi est ignoré (renvoie false) : le flux
//  d'invitation continue de fonctionner en renvoyant le lien à partager.
//  Secrets : RESEND_API_KEY, RESEND_FROM (ex: "PairForm <invite@pairform.app>").
// =============================================================================
export async function sendEmail(opts: { to: string; subject: string; html: string }): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("RESEND_FROM") ?? "PairForm <onboarding@resend.dev>";
  if (!key) return false;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [opts.to], subject: opts.subject, html: opts.html }),
  });
  if (!res.ok) {
    console.error("Resend:", res.status, await res.text());
    return false;
  }
  return true;
}

/** Gabarit d'email d'invitation coach → athlète. */
export function inviteEmailHtml(opts: { coachName: string; inviteUrl: string }): string {
  return `
  <div style="font-family:system-ui,Segoe UI,sans-serif;max-width:480px;margin:0 auto;color:#0f1720">
    <h2 style="font-weight:800;letter-spacing:.4px">PairForm</h2>
    <p>${escapeHtml(opts.coachName)} t'invite à rejoindre son espace coaching sur PairForm.</p>
    <p>Tu y retrouveras ton plan d'entraînement, tes séances et ton suivi.</p>
    <p style="margin:28px 0">
      <a href="${opts.inviteUrl}" style="background:#46C2D8;color:#06222a;text-decoration:none;
         padding:12px 22px;border-radius:10px;font-weight:700;display:inline-block">
        Accepter l'invitation
      </a>
    </p>
    <p style="font-size:12px;color:#6b7682">Ou copie ce lien : <br>${opts.inviteUrl}</p>
  </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
  ));
}
