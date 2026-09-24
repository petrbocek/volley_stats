-- Pořadí hráčky v sestavě zápasu. Live ji podle něj řadí místo abecedy (#75).
--
-- Nullable schválně: u zápasů odehraných dřív se pořadí vložení nedá zjistit
-- (tabulka neměla id ani created_at), takže zůstanou prázdné a appka u nich
-- spadne zpátky na abecedu. Žádná dopočítávaná migrace dat.
ALTER TABLE vb_zapas_hraci ADD COLUMN IF NOT EXISTS poradi integer;

COMMENT ON COLUMN vb_zapas_hraci.poradi IS
  'Pořadí vložení do sestavy; NULL u zápasů z doby před #75 — tam se řadí abecedně.';
