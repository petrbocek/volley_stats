-- Statistiky po setech (#32). Dosud byl jeden řádek na hráčku a zápas, takže
-- vývoj v rámci zápasu se z dat nedal vyčíst.
--
-- Stávajících 98 řádků z rozehrané sezóny set u sebe nemá; podle rozhodnutí
-- majitele se přiřazují 1. setu. Znamená to, že u starých zápasů je "1. set"
-- ve skutečnosti celý zápas — rozpad po setech má smysl až od nové sezóny.
ALTER TABLE vb_statistiky
  ADD COLUMN IF NOT EXISTS set_cislo int NOT NULL DEFAULT 1;

ALTER TABLE vb_statistiky
  DROP CONSTRAINT IF EXISTS vb_statistiky_zapas_id_hrac_id_key;

ALTER TABLE vb_statistiky
  DROP CONSTRAINT IF EXISTS vb_statistiky_set_rozsah;
ALTER TABLE vb_statistiky
  ADD CONSTRAINT vb_statistiky_set_rozsah CHECK (set_cislo BETWEEN 1 AND 5);

ALTER TABLE vb_statistiky
  DROP CONSTRAINT IF EXISTS vb_statistiky_zapas_hrac_set_key;
ALTER TABLE vb_statistiky
  ADD CONSTRAINT vb_statistiky_zapas_hrac_set_key UNIQUE (zapas_id, hrac_id, set_cislo);
