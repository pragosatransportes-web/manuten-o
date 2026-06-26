# Envio do relatório de reunião por e-mail (Edge Function)

Esta função envia o relatório de reunião por e-mail, com o Excel em anexo, sem abrir o cliente de correio.

## 1. Criar conta de envio (Resend)
1. Criar conta em https://resend.com (tem plano gratuito).
2. **Domínios** → adicionar e **verificar** o domínio da empresa (ex.: `pragosa.pt`) seguindo os registos DNS indicados.
   - Para testes rápidos, pode usar o remetente `onboarding@resend.dev` (só envia para o e-mail da própria conta Resend).
3. **API Keys** → criar uma chave e copiar (`re_...`).

## 2. Publicar a função no Supabase
Opção A — CLI (recomendado):
```bash
supabase login
supabase link --project-ref gmurqvlcdevyinieqdgy
supabase functions deploy send-meeting-report --no-verify-jwt
```
Opção B — Dashboard: Supabase → **Edge Functions** → **Create a function** → nome `send-meeting-report` → colar o conteúdo de `index.ts` → **Deploy**. Depois, em **Details**, desligar "Verify JWT".

## 3. Configurar os segredos
Supabase → **Project Settings → Edge Functions → Secrets** (ou `supabase secrets set`):
- `RESEND_API_KEY` = a chave `re_...` do Resend
- `EMAIL_FROM` = remetente verificado, ex.: `Gestão de Avarias <avarias@pragosa.pt>`

```bash
supabase secrets set RESEND_API_KEY=re_xxx "EMAIL_FROM=Gestão de Avarias <avarias@pragosa.pt>"
```

## 4. Ativar na app
Em `config.js`, no bloco `email`, pôr `enabled: true` (e, se quiser, um destinatário por defeito em `to`). Fazer commit/push.

A partir daí, o botão **"Enviar por e-mail"** no relatório de reunião pergunta o destinatário e envia automaticamente com o Excel anexado. Se a função falhar, a app recorre ao cliente de e-mail (mailto).
