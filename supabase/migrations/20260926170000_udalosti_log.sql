-- Log výměn. vb_statistiky jsou počítadla bez pořadí, takže z nich nejde
-- poznat, kdo výměnu uhrál ani v jakém pořadí body padaly — a bez toho se
-- nedá spočítat side-out %, série bodů ani rozpad podle rotací (#84).
--
-- Log je doplněk, ne náhrada: počítadla zůstávají zdrojem pravdy pro
-- statistiky. Kdyby se rozešly, degradují nové metriky, ne tvoje čísla.
CREATE TABLE IF NOT EXISTS public.vb_udalosti (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- pořadí výměn
  zapas_id   bigint NOT NULL REFERENCES public.vb_zapasy(id) ON DELETE CASCADE,
  set_cislo  int    NOT NULL CHECK (set_cislo BETWEEN 1 AND 5),
  hrac_id    bigint REFERENCES public.vb_hraci(id) ON DELETE SET NULL,
  pole       text   NOT NULL,
  -- kdo stál v zóně 1, tedy kterou rotaci se hrálo; rotace se poznává podle
  -- podávající, ne podle pořadového čísla — tak o ní trenér uvažuje
  zona1_hrac_id bigint REFERENCES public.vb_hraci(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vb_udalosti_zapas_set ON public.vb_udalosti (zapas_id, set_cislo, id);

ALTER TABLE public.vb_udalosti ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cteni_verejne ON public.vb_udalosti;
DROP POLICY IF EXISTS zapis_zapisovatel ON public.vb_udalosti;
CREATE POLICY cteni_verejne ON public.vb_udalosti
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY zapis_zapisovatel ON public.vb_udalosti
  FOR ALL TO authenticated USING (public.je_zapisovatel()) WITH CHECK (public.je_zapisovatel());

GRANT SELECT ON public.vb_udalosti TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.vb_udalosti TO authenticated;

-- Kdo v setu začínal podávat. Bez toho se nedá určit, kdo podával u které
-- výměny, a tedy ani co byl side-out.
ALTER TABLE public.vb_set_info ADD COLUMN IF NOT EXISTS prvni_podani text
  CHECK (prvni_podani IN ('my','oni'));
COMMENT ON COLUMN public.vb_set_info.prvni_podani IS
  'Kdo v setu podával jako první; NULL = nezadáno, pak se side-out nepočítá.';

-- „Zpět" musí umět smazat i poslední zalogovanou událost téhož druhu.
CREATE OR REPLACE FUNCTION public.vb_smaz_posledni_udalost(
  p_zapas bigint, p_set int, p_hrac bigint, p_pole text)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE v_id bigint;
BEGIN
  SELECT id INTO v_id FROM public.vb_udalosti
   WHERE zapas_id = p_zapas AND set_cislo = p_set AND pole = p_pole
     AND hrac_id IS NOT DISTINCT FROM p_hrac
   ORDER BY id DESC LIMIT 1;
  IF v_id IS NOT NULL THEN
    DELETE FROM public.vb_udalosti WHERE id = v_id;
  END IF;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.vb_smaz_posledni_udalost(bigint,int,bigint,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vb_smaz_posledni_udalost(bigint,int,bigint,text) TO authenticated;
