-- Tým patří sezóně, ve které vznikl (#62). Bez toho se tým z loňska nabízel
-- i letos a hráčky se do něj přiřazovaly bez ohledu na sezónu.
--
-- Členství v vb_hraci_tymy zůstává bez sezóny schválně: tým sám je nově
-- vázaný na jednu sezónu, takže členství je tím pádem vázané taky.
ALTER TABLE vb_tymy ADD COLUMN IF NOT EXISTS sezona_id bigint REFERENCES vb_sezony(id);

-- U16Z je z loňské sezóny, U16ZA vzniklo pro aktuální (všech 14 členek je
-- v její soupisce). Ostatní týmy by připadly nejstarší sezóně.
UPDATE vb_tymy SET sezona_id = 1 WHERE sezona_id IS NULL AND nazev = 'U16Z';
UPDATE vb_tymy SET sezona_id = 2 WHERE sezona_id IS NULL AND nazev = 'U16ZA';
UPDATE vb_tymy SET sezona_id = (SELECT min(id) FROM vb_sezony) WHERE sezona_id IS NULL;

ALTER TABLE vb_tymy ALTER COLUMN sezona_id SET NOT NULL;
