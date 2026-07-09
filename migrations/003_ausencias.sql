-- Ausências dos motoristas (para planear manutenções/inspeções/aferições).
-- Executar no Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS avarias_ausencias (
  id          TEXT PRIMARY KEY,
  driver      TEXT NOT NULL,
  type        TEXT,                 -- "Férias" | "Baixa médica" | ...
  start_at    DATE,
  end_at      DATE,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  created_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_ausencias_driver ON avarias_ausencias(driver);
CREATE INDEX IF NOT EXISTS idx_ausencias_periodo ON avarias_ausencias(start_at, end_at);

-- Mesmo esquema de permissões das outras tabelas
ALTER TABLE avarias_ausencias ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Leitura pública" ON avarias_ausencias
  FOR SELECT USING (true);

CREATE POLICY "Escrita autenticada" ON avarias_ausencias
  FOR ALL USING (true);
