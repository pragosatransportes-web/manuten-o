-- Taxonomia editável de tipos de avaria por tipo de viatura (Ocorrências Fatia 3).
-- Executar no Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS avarias_tipos_avaria (
  id                 TEXT PRIMARY KEY,
  vehicle_type       TEXT,              -- "Trator" | "Reboque"
  grupo              TEXT,
  nome               TEXT NOT NULL,
  hint               TEXT,
  suggested_priority TEXT,              -- "P1".."P4"
  position           INTEGER,
  active             BOOLEAN DEFAULT true,
  created_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tipos_avaria_vt ON avarias_tipos_avaria(vehicle_type);

ALTER TABLE avarias_tipos_avaria ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Leitura pública" ON avarias_tipos_avaria
  FOR SELECT USING (true);

CREATE POLICY "Escrita autenticada" ON avarias_tipos_avaria
  FOR ALL USING (true);
