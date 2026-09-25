-- Formát zápasu (#84). Turnajové zápasy se hrají na dva vítězné sety, ligové
-- na tři — a z toho plyne, kdy zápas končí a který set je zkrácený tiebreak.
-- Dosud to appka brala napevno jako tři vítězné sety, takže u turnaje nabídla
-- konec zápasu o set později a zkrácený set hledala v pátém místo ve třetím.
--
-- DEFAULT 3 schválně: odehrané zápasy se tím nemění a starší verze appky
-- sloupec prostě ignoruje.
ALTER TABLE public.vb_zapasy
  ADD COLUMN IF NOT EXISTS vitezne_sety smallint NOT NULL DEFAULT 3;

DO $$
BEGIN
  ALTER TABLE public.vb_zapasy
    ADD CONSTRAINT vb_zapasy_vitezne_sety_chk CHECK (vitezne_sety IN (2, 3));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.vb_zapasy.vitezne_sety IS
  'Kolik vítězných setů zápas rozhoduje: 2 (hraje se max 3 sety) nebo 3 (max 5).';
