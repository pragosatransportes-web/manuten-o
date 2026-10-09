-- Modelo de 2 eixos da ocorrência (ARGOS 07/10 item 17):
-- estado_avaria   = Comunicada | Agendada | Em intervenção | Concluída
-- estado_viatura  = A circular | A circular condicionada | Não pode circular | Parada
-- Substituem a lógica de "Estado inicial" + "Situação". O app deriva o estado
-- antigo (status/situation) a partir destes para o Dashboard/Planeamento.
-- Executar no Supabase SQL Editor.

ALTER TABLE avarias_breakdowns ADD COLUMN IF NOT EXISTS estado_avaria TEXT;
ALTER TABLE avarias_breakdowns ADD COLUMN IF NOT EXISTS estado_viatura TEXT;
