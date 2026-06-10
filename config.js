window.AVARIAS_REMOTE_CONFIG = {
  supabaseUrl: "https://gmurqvlcdevyinieqdgy.supabase.co",
  supabaseAnonKey: "sb_publishable_TV_kENAdnHySj5SQN9wLtQ_uqc748t7",
  operator: "Equipa Oficina",
  trello: {
    // Integração Trello: a "key" identifica a aplicação; o "token" autoriza a conta.
    // Para gerar o token, abrir (com sessão iniciada na conta Trello desejada):
    // https://trello.com/1/authorize?expiration=never&name=Gestao%20de%20Avarias&scope=read,write&response_type=token&key=9a11efeeefe7adb7c00e5f90fea635c9
    // Colar o token abaixo. Enquanto estiver vazio, a integração fica desativada.
    key: "9a11efeeefe7adb7c00e5f90fea635c9",
    token: "",
    boardName: "Gestão de Avarias"
  }
};
