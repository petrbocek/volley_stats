-- Střídání se stavem a jmény (#102). Dosud se vedl jen počet ve
-- vb_set_info.stridani — z toho se nepozná, kdo šel z place a kdo na něj,
-- takže se střídání nedalo ukázat divákům ani dohledat po zápase.
--
-- Stejný tvar jako time-outy: řádek na každé střídání, počet z nich plyne.
CREATE TABLE IF NOT EXISTS public.vb_stridani (
  id            bigserial PRIMARY KEY,
  zapas_id      bigint      NOT NULL REFERENCES public.vb_zapasy(id) ON DELETE CASCADE,
  set_cislo     int         NOT NULL CHECK (set_cislo BETWEEN 1 AND 5),
  skore_my      int         NOT NULL CHECK (skore_my >= 0),
  skore_oni     int         NOT NULL CHECK (skore_oni >= 0),
  -- ON DELETE SET NULL: smazaná hráčka nesmí vzít s sebou historii zápasu
  hrac_ven      bigint      REFERENCES public.vb_hraci(id) ON DELETE SET NULL,
  hrac_dovnitr  bigint      REFERENCES public.vb_hraci(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vb_stridani_zapas_set_idx
  ON public.vb_stridani (zapas_id, set_cislo, id);

ALTER TABLE public.vb_stridani ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cteni_verejne ON public.vb_stridani;
DROP POLICY IF EXISTS zapis_zapisovatel ON public.vb_stridani;
CREATE POLICY cteni_verejne ON public.vb_stridani
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY zapis_zapisovatel ON public.vb_stridani
  FOR ALL TO authenticated USING (public.je_zapisovatel()) WITH CHECK (public.je_zapisovatel());

GRANT SELECT ON public.vb_stridani TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.vb_stridani TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.vb_stridani_id_seq TO authenticated;

CREATE OR REPLACE FUNCTION public.vb_zapis_stridani(p_zapas bigint, p_set int,
                                                    p_my int, p_oni int,
                                                    p_ven bigint, p_dovnitr bigint)
RETURNS public.vb_stridani
LANGUAGE plpgsql
AS $$
DECLARE v_radek public.vb_stridani;
BEGIN
  IF p_zapas IS NULL THEN RAISE EXCEPTION 'Chybí zápas'; END IF;
  IF p_set IS NULL OR p_set < 1 OR p_set > 5 THEN
    RAISE EXCEPTION 'Set mimo rozsah 1-5: %', coalesce(p_set::text,'(null)');
  END IF;
  IF p_my IS NULL OR p_oni IS NULL OR p_my < 0 OR p_oni < 0 THEN
    RAISE EXCEPTION 'Nesmyslný stav: %:%', coalesce(p_my::text,'(null)'), coalesce(p_oni::text,'(null)');
  END IF;

  INSERT INTO public.vb_stridani (zapas_id, set_cislo, skore_my, skore_oni, hrac_ven, hrac_dovnitr)
    VALUES (p_zapas, p_set, p_my, p_oni, p_ven, p_dovnitr)
    RETURNING * INTO v_radek;
  RETURN v_radek;
END $$;

REVOKE ALL ON FUNCTION public.vb_zapis_stridani(bigint,int,int,int,bigint,bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vb_zapis_stridani(bigint,int,int,int,bigint,bigint) TO authenticated;

CREATE OR REPLACE FUNCTION public.vb_smaz_posledni_stridani(p_zapas bigint, p_set int)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE v_id bigint;
BEGIN
  SELECT id INTO v_id FROM public.vb_stridani
    WHERE zapas_id = p_zapas AND set_cislo = p_set
    ORDER BY id DESC LIMIT 1;
  IF v_id IS NULL THEN RETURN NULL; END IF;
  DELETE FROM public.vb_stridani WHERE id = v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.vb_smaz_posledni_stridani(bigint,int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vb_smaz_posledni_stridani(bigint,int) TO authenticated;
