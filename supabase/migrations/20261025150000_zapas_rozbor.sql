-- Psaný rozbor u zápasu (#129).
--
-- Appka umí spočítat čísla a přiznat, čemu na nich nevěřit. Co neumí, je
-- vážit souvislosti: porovnat dva zápasy, odhadnout sílu soupeře, posoudit,
-- jestli se riziko na servisu vyplatilo. To napíše člověk (nebo asistent)
-- a uloží se to k zápasu.
--
-- Drží se odděleně od postřehů a nese podpis schválně: čtenář musí poznat,
-- co je spočítané z dat a co je něčí výklad.
ALTER TABLE public.vb_zapasy
  ADD COLUMN IF NOT EXISTS rozbor text,
  ADD COLUMN IF NOT EXISTS rozbor_kdo text,
  ADD COLUMN IF NOT EXISTS rozbor_kdy timestamptz;

COMMENT ON COLUMN public.vb_zapasy.rozbor IS
  'Psaný rozbor zápasu. Text od člověka (nebo asistenta), ne počítané číslo — proto se v appce ukazuje odděleně od postřehů a nese podpis.';
COMMENT ON COLUMN public.vb_zapasy.rozbor_kdo IS
  'Kdo rozbor napsal. Aby bylo poznat, co je spočítané a co napsané.';

-- RLS ani granty se nepřidávají: vb_zapasy je má z #84 (čtení veřejné,
-- zápis jen zapisovatel) a nové sloupce jedou pod nimi.
