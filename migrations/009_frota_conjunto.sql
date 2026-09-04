-- Conjunto (trator + reboque) e responsável de logística por equipamento da frota.
-- Afetação manual feita na app (Frota › cartão). Executar no Supabase SQL Editor.

ALTER TABLE avarias_fleet ADD COLUMN IF NOT EXISTS partner_equipment TEXT;
ALTER TABLE avarias_fleet ADD COLUMN IF NOT EXISTS logistics_resp TEXT;
