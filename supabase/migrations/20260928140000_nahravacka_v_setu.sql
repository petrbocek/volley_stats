-- Posty v šestce se nedají brát z nastavení hráčky: jedna holka hraje podle
-- potřeby smečařku i univerzálku (#84). Postavení je ale dané — po zónách jde
-- N-S-B-U-S-B proti směru hodin — takže stačí vědět, kde stojí nahrávačka,
-- a zbytek postů z toho plyne sám.
--
-- Patří to k setu, ne k zápasu: mezi sety se sestava mění.
ALTER TABLE public.vb_set_info
  ADD COLUMN IF NOT EXISTS nahravacka_hrac_id bigint
    REFERENCES public.vb_hraci(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.vb_set_info.nahravacka_hrac_id IS
  'Kdo je v tomhle setu nahrávačka. Od její zóny se odvozují posty ostatních.';
