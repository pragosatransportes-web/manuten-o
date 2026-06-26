// Edge Function: send-meeting-report
// Envia o relatório de reunião por e-mail (via Resend), com o Excel em anexo.
//
// Deploy (uma vez):
//   supabase functions deploy send-meeting-report --no-verify-jwt
// Segredos a configurar no Supabase (Project Settings -> Edge Functions -> Secrets):
//   RESEND_API_KEY  -> chave da conta Resend (https://resend.com)
//   EMAIL_FROM      -> remetente verificado, ex: "Gestão de Avarias <avarias@oseudominio.pt>"
//
// O corpo do pedido (POST, JSON):
//   { to: string | string[], subject: string, html?: string, text?: string,
//     filename?: string, fileBase64?: string }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  try {
    const { to, subject, html, text, filename, fileBase64 } = await req.json();

    const recipients = (Array.isArray(to) ? to : String(to || "").split(/[;,]/))
      .map((s: string) => s.trim())
      .filter(Boolean);
    if (!recipients.length) return json({ error: "Sem destinatário." }, 400);

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const EMAIL_FROM = Deno.env.get("EMAIL_FROM") || "onboarding@resend.dev";
    if (!RESEND_API_KEY) return json({ error: "RESEND_API_KEY não configurada no Supabase." }, 500);

    const payload: Record<string, unknown> = {
      from: EMAIL_FROM,
      to: recipients,
      subject: subject || "Relatório de reunião",
      html: html || `<pre>${text || ""}</pre>`,
    };
    if (filename && fileBase64) {
      payload.attachments = [{ filename, content: fileBase64 }];
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: data?.message || "Falha no envio.", detail: data }, res.status);
    return json({ ok: true, id: data?.id });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
