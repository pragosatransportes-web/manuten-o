-- Plano de preventiva periódica de uma ocorrência: qual a intervenção da Frota
-- a reagendar (inspeção, tacógrafo, …) e a periodicidade em meses (12/24).
-- Ao concluir a ocorrência, a app aplica a próxima data na Frota.
-- Executar no Supabase SQL Editor.

ALTER TABLE avarias_breakdowns ADD COLUMN IF NOT EXISTS preventive_plan JSONB;
