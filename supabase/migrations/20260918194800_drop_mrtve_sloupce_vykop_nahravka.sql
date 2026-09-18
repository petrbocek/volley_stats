-- Akce Výkop a Nahrávka byly z UI odstraněny v PR #6 a #7, jejich sloupce
-- v vb_statistiky ale zůstaly — šest sloupců, do kterých se od té doby nikdy
-- nic nezapsalo. Před dropem ověřeno, že jsou ve všech 98 řádcích nulové.
--
-- Destruktivní změna: sloupce se zahozením ztratí i s obsahem. Návrat je
-- jen přidat je zpět prázdné, historická data v nich žádná nebyla.
ALTER TABLE vb_statistiky
  DROP COLUMN IF EXISTS vykop_plus,
  DROP COLUMN IF EXISTS vykop_minus,
  DROP COLUMN IF EXISTS vykop_neutral,
  DROP COLUMN IF EXISTS nahravka_plus,
  DROP COLUMN IF EXISTS nahravka_minus,
  DROP COLUMN IF EXISTS nahravka_neutral;
