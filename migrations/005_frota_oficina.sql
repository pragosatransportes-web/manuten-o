-- Oficina preferencial de cada equipamento da frota (vem das Entidades, categoria "Oficina").
-- Executar no Supabase SQL Editor.

ALTER TABLE avarias_fleet ADD COLUMN IF NOT EXISTS preferred_workshop TEXT;
