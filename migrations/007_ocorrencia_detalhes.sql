-- Ocorrências Fatia 2: detalhes do formulário sequencial.
-- Executar no Supabase SQL Editor.

ALTER TABLE avarias_breakdowns ADD COLUMN IF NOT EXISTS communicated_at DATE;
ALTER TABLE avarias_breakdowns ADD COLUMN IF NOT EXISTS on_site BOOLEAN;
ALTER TABLE avarias_breakdowns ADD COLUMN IF NOT EXISTS km INTEGER;
ALTER TABLE avarias_breakdowns ADD COLUMN IF NOT EXISTS registered_by TEXT;
ALTER TABLE avarias_breakdowns ADD COLUMN IF NOT EXISTS logistics_resp TEXT;
ALTER TABLE avarias_breakdowns ADD COLUMN IF NOT EXISTS recurrent_of TEXT;
ALTER TABLE avarias_breakdowns ADD COLUMN IF NOT EXISTS expected_entry_at DATE;
