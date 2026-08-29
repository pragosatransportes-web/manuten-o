-- Entidades (mini-CRM): oficinas, fornecedores, motoristas, clientes, contactos.
-- Fonte única para os dropdowns de oficina preferencial, contactos, etc.
-- Executar no Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS avarias_entidades (
  id             TEXT PRIMARY KEY,
  empresa        TEXT NOT NULL,
  tipo           TEXT,                 -- "Interna" | "Externa"
  categoria      TEXT,                 -- "Oficina" | "Fornecedor" | "Motorista" | "Cliente" | "Outro"
  contacto_nome  TEXT,
  telefone       TEXT,
  email          TEXT,
  notas          TEXT,
  created_at     TIMESTAMPTZ DEFAULT now(),
  created_by     TEXT
);

CREATE INDEX IF NOT EXISTS idx_entidades_categoria ON avarias_entidades(categoria);
CREATE INDEX IF NOT EXISTS idx_entidades_empresa ON avarias_entidades(empresa);

-- Mesmo esquema de permissões das outras tabelas
ALTER TABLE avarias_entidades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Leitura pública" ON avarias_entidades
  FOR SELECT USING (true);

CREATE POLICY "Escrita autenticada" ON avarias_entidades
  FOR ALL USING (true);
