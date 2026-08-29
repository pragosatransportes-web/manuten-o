-- Ocorrências (redesign ARGOS): tipo de intervenção, numeração e prioridade.
-- Executar no Supabase SQL Editor.

ALTER TABLE avarias_breakdowns ADD COLUMN IF NOT EXISTS intervention_type TEXT;
ALTER TABLE avarias_breakdowns ADD COLUMN IF NOT EXISTS occurrence_number TEXT;
ALTER TABLE avarias_breakdowns ADD COLUMN IF NOT EXISTS priority TEXT;
