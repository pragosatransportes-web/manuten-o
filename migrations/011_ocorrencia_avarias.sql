-- Lista de avarias por ocorrência (multi-avaria): cada avaria tem tipo,
-- prioridade e estado (resolvida). Permite calcular a % de resolução.
-- Executar no Supabase SQL Editor.

ALTER TABLE avarias_breakdowns ADD COLUMN IF NOT EXISTS faults JSONB DEFAULT '[]'::jsonb;
