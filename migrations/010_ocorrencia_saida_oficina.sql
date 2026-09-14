-- Data de saída da oficina por ocorrência (detalhe da ocorrência).
-- Executar no Supabase SQL Editor.

ALTER TABLE avarias_breakdowns ADD COLUMN IF NOT EXISTS workshop_exit_at DATE;
