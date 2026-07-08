-- Motorista responsável por cada equipamento da frota.
-- Executar no Supabase SQL Editor.

ALTER TABLE avarias_fleet ADD COLUMN IF NOT EXISTS driver TEXT;
