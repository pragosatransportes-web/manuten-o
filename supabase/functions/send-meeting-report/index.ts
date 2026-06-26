// Edge Function: send-meeting-report
// Envia o relatório de reunião por e-mail via SMTP do Office 365, com o Excel em anexo.
//
// Deploy (uma vez):
//   supabase functions deploy send-meeting-report --no-verify-jwt
// Segredos a configurar (Supabase -> Edge Functions -> Secrets):
//   SMTP_HOST   -> smtp.office365.com
//   SMTP_PORT   -> 587
//   SMTP_USER   -> caixa de correio que envia, ex: avarias@pragosa.pt
//   SMTP_PASS   -> password (ou app password) dessa caixa
//   EMAIL_FROM  -> remetente (deve ser a mesma caixa do SMTP_USER), ex: avarias@pragosa.pt
//
// Requisito Microsoft 365: a caixa SMTP_USER tem de ter "Authenticated SMTP" ATIVO.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

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

    const host = Deno.env.get("SMTP_HOST") || "smtp.office365.com";
    const port = Number(Deno.env.get("SMTP_PORT") || "587");
    const user = Deno.env.get("SMTP_USER");
    const pass = Deno.env.get("SMTP_PASS");
    const from = Deno.env.get("EMAIL_FROM") || user;
    if (!user || !pass) return json({ error: "SMTP_USER/SMTP_PASS não configurados no Supabase." }, 500);

    const client = new SMTPClient({
      connection: {
        hostname: host,
        port,
        tls: port === 465, // 465 = TLS direto; 587 = STARTTLS (tls: false)
        auth: { username: user, password: pass },
      },
    });

    const message: Record<string, unknown> = {
      from,
      to: recipients,
      subject: subject || "Relatório de reunião",
      content: text || "Relatório de reunião (ver versão HTML).",
      html: html || undefined,
    };
    if (filename && fileBase64) {
      message.attachments = [{
        filename,
        encoding: "base64",
        content: fileBase64,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }];
    }

    await client.send(message as never);
    await client.close();
    return json({ ok: true });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
