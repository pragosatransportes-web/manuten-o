window.AVARIAS_REMOTE_CONFIG = {
  supabaseUrl: "https://gmurqvlcdevyinieqdgy.supabase.co",
  supabaseAnonKey: "sb_publishable_TV_kENAdnHySj5SQN9wLtQ_uqc748t7",
  operator: "Equipa Oficina",
  trello: {
    // Integração Trello: a "key" identifica a aplicação (pública por definição).
    // O token de autorização NUNCA deve ser colocado aqui (ficaria público no site):
    // é pedido uma vez em cada dispositivo, ao clicar no botão "Trello", e fica
    // guardado apenas no browser (localStorage).
    // Para gerar um token, abrir com sessão iniciada na conta Trello:
    // https://trello.com/1/authorize?expiration=never&name=Gestao%20de%20Avarias&scope=read,write&response_type=token&key=9a11efeeefe7adb7c00e5f90fea635c9
    key: "9a11efeeefe7adb7c00e5f90fea635c9"
  },
  email: {
    // Envio do relatório de reunião por e-mail via Edge Function do Supabase.
    // Pôr enabled: true depois de a função "send-meeting-report" estar publicada
    // e as chaves (RESEND_API_KEY / EMAIL_FROM) configuradas no Supabase.
    // Enquanto estiver false, o botão de e-mail abre o cliente de correio (mailto).
    enabled: false,
    functionName: "send-meeting-report",
    to: "manutencao@pragosa.pt, logistica@pragosa.pt" // destinatários por defeito
  }
};
