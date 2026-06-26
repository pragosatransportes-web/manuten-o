# Envio do relatório de reunião por e-mail (Edge Function via Office 365)

Esta função envia o relatório de reunião por e-mail, com o Excel em anexo, usando o
servidor SMTP do Office 365 da empresa (não precisa de serviços externos).

## 1. Pré-requisito no Microsoft 365 (IT)
A caixa de correio que vai enviar (ex.: `avarias@pragosa.pt`) tem de ter o
**Authenticated SMTP (SMTP AUTH)** ativo:
- Microsoft 365 Admin → Utilizadores → a caixa → **Mail** → **Manage email apps** →
  marcar **Authenticated SMTP**.
- Em alternativa (PowerShell Exchange): `Set-CASMailbox -Identity avarias@pragosa.pt -SmtpClientAuthenticationDisabled $false`
- Se a conta tiver MFA, é preciso uma **App Password** para usar como `SMTP_PASS`
  (ou usar uma caixa dedicada sem MFA só para envios).

## 2. Publicar a função
Dashboard: Supabase → **Edge Functions** → **Deploy a new function** → nome
`send-meeting-report` → colar o `index.ts` → **Deploy** → desligar **Verify JWT**.

CLI:
```bash
supabase functions deploy send-meeting-report --no-verify-jwt
```

## 3. Configurar os segredos (Edge Functions → Secrets)
| Name | Value |
|------|-------|
| `SMTP_HOST` | `smtp.office365.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `avarias@pragosa.pt` (caixa que envia) |
| `SMTP_PASS` | password (ou App Password) dessa caixa |
| `EMAIL_FROM` | `avarias@pragosa.pt` (igual ao SMTP_USER) |

## 4. Ativar na app
Em `config.js`, no bloco `email`, pôr `enabled: true` (e opcionalmente `to`). Commit/push.

O botão **"Enviar por e-mail"** passa a enviar automaticamente com o Excel anexado.
Se falhar, a app recorre ao cliente de e-mail (mailto).
