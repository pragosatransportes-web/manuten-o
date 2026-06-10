-- Tabela de custos de portagens importados via Via Verde
-- Executar no Supabase SQL Editor

CREATE TABLE IF NOT EXISTS avarias_custos_portagens (
  id              TEXT PRIMARY KEY,
  plate           TEXT NOT NULL,
  month           TEXT NOT NULL,        -- formato YYYY-MM
  amount          NUMERIC(10, 2) NOT NULL,
  source_file     TEXT,
  imported_at     TIMESTAMPTZ DEFAULT now(),
  imported_by     TEXT
);

-- Índice para consultas por mês e matrícula
CREATE INDEX IF NOT EXISTS idx_custos_portagens_month ON avarias_custos_portagens(month);
CREATE INDEX IF NOT EXISTS idx_custos_portagens_plate ON avarias_custos_portagens(plate);

-- Permissões para anon key (mesmo esquema das outras tabelas)
ALTER TABLE avarias_custos_portagens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Leitura pública" ON avarias_custos_portagens
  FOR SELECT USING (true);

CREATE POLICY "Escrita autenticada" ON avarias_custos_portagens
  FOR ALL USING (true);
