-- Body z chyb soupeře (#74). Vlastní tabulka schválně: nemají hráčku, takže
-- pseudo-řádek ve vb_statistiky s hrac_id = NULL by rozbil hrac_id NOT NULL
-- i každý výpočet, který dnes předpokládá, že řádek patří hráčce.
--
-- Jedno počítadlo na zápas a set, žádný rozpad na druhy chyb — během zápasu
-- jde o rychlost.
CREATE TABLE IF NOT EXISTS public.vb_chyby_souperu (
  zapas_id  bigint NOT NULL REFERENCES public.vb_zapasy(id) ON DELETE CASCADE,
  set_cislo int    NOT NULL DEFAULT 1 CHECK (set_cislo BETWEEN 1 AND 5),
  pocet     int    NOT NULL DEFAULT 0 CHECK (pocet >= 0),
  PRIMARY KEY (zapas_id, set_cislo)
);

-- Stejný režim jako u ostatních tabulek: čtení veřejné, zápis jen zapisovatel.
ALTER TABLE public.vb_chyby_souperu ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cteni_verejne ON public.vb_chyby_souperu;
DROP POLICY IF EXISTS zapis_zapisovatel ON public.vb_chyby_souperu;
CREATE POLICY cteni_verejne ON public.vb_chyby_souperu
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY zapis_zapisovatel ON public.vb_chyby_souperu
  FOR ALL TO authenticated USING (public.je_zapisovatel()) WITH CHECK (public.je_zapisovatel());

GRANT SELECT ON public.vb_chyby_souperu TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.vb_chyby_souperu TO authenticated;

-- Přírůstkově, ne přepisem celého řádku — u jednoho zápasu můžou zapisovat
-- dvě zařízení naráz (#27).
CREATE OR REPLACE FUNCTION public.vb_zapis_chybu_souperu(p_zapas bigint, p_set int, p_delta int)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE v_nova int;
BEGIN
  IF p_zapas IS NULL THEN RAISE EXCEPTION 'Chybí zápas'; END IF;
  IF p_set IS NULL OR p_set < 1 OR p_set > 5 THEN
    RAISE EXCEPTION 'Set mimo rozsah 1-5: %', coalesce(p_set::text,'(null)');
  END IF;
  IF p_delta IS NULL OR p_delta < -50 OR p_delta > 50 THEN
    RAISE EXCEPTION 'Nesmyslná změna: %', coalesce(p_delta::text,'(null)');
  END IF;

  INSERT INTO public.vb_chyby_souperu (zapas_id, set_cislo, pocet)
    VALUES (p_zapas, p_set, greatest(0, p_delta))
  ON CONFLICT (zapas_id, set_cislo) DO UPDATE
    SET pocet = greatest(0, public.vb_chyby_souperu.pocet + p_delta)
  RETURNING pocet INTO v_nova;

  RETURN v_nova;
END $$;

REVOKE ALL ON FUNCTION public.vb_zapis_chybu_souperu(bigint,int,int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vb_zapis_chybu_souperu(bigint,int,int) TO authenticated;
