-- Time-outy se stavem, ve kterém padly (#84). Počítadlo v vb_set_info říkalo
-- jen „dva jsou pryč"; zajímavé je ale kdy — jestli se bralo za stavu 8:12
-- nebo 22:24.
--
-- Vlastní řádek na každý time-out: počet z nich plyne (COUNT), takže nevzniká
-- druhá pravda vedle počítadla.
CREATE TABLE IF NOT EXISTS public.vb_oddechove_casy (
  id         bigserial PRIMARY KEY,
  zapas_id   bigint      NOT NULL REFERENCES public.vb_zapasy(id) ON DELETE CASCADE,
  set_cislo  int         NOT NULL CHECK (set_cislo BETWEEN 1 AND 5),
  skore_my   int         NOT NULL CHECK (skore_my >= 0),
  skore_oni  int         NOT NULL CHECK (skore_oni >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vb_oddechove_casy_zapas_set_idx
  ON public.vb_oddechove_casy (zapas_id, set_cislo, id);

ALTER TABLE public.vb_oddechove_casy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cteni_verejne ON public.vb_oddechove_casy;
DROP POLICY IF EXISTS zapis_zapisovatel ON public.vb_oddechove_casy;
CREATE POLICY cteni_verejne ON public.vb_oddechove_casy
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY zapis_zapisovatel ON public.vb_oddechove_casy
  FOR ALL TO authenticated USING (public.je_zapisovatel()) WITH CHECK (public.je_zapisovatel());

GRANT SELECT ON public.vb_oddechove_casy TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.vb_oddechove_casy TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.vb_oddechove_casy_id_seq TO authenticated;

-- Zápis time-outu se vrací celý, ať appka ví, co si má dát do stavu.
CREATE OR REPLACE FUNCTION public.vb_zapis_oddechovy(p_zapas bigint, p_set int,
                                                     p_my int, p_oni int)
RETURNS public.vb_oddechove_casy
LANGUAGE plpgsql
AS $$
DECLARE v_radek public.vb_oddechove_casy;
BEGIN
  IF p_zapas IS NULL THEN RAISE EXCEPTION 'Chybí zápas'; END IF;
  IF p_set IS NULL OR p_set < 1 OR p_set > 5 THEN
    RAISE EXCEPTION 'Set mimo rozsah 1-5: %', coalesce(p_set::text,'(null)');
  END IF;
  IF p_my IS NULL OR p_oni IS NULL OR p_my < 0 OR p_oni < 0 THEN
    RAISE EXCEPTION 'Nesmyslný stav: %:%', coalesce(p_my::text,'(null)'), coalesce(p_oni::text,'(null)');
  END IF;

  INSERT INTO public.vb_oddechove_casy (zapas_id, set_cislo, skore_my, skore_oni)
    VALUES (p_zapas, p_set, p_my, p_oni)
    RETURNING * INTO v_radek;
  RETURN v_radek;
END $$;

REVOKE ALL ON FUNCTION public.vb_zapis_oddechovy(bigint,int,int,int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vb_zapis_oddechovy(bigint,int,int,int) TO authenticated;

-- Mazání posledního: stejná cesta jako u logu výměn, ať „zpět" nepotřebuje
-- znát id a nesmazalo se přitom víc, než co poslední klik přidal.
CREATE OR REPLACE FUNCTION public.vb_smaz_posledni_oddechovy(p_zapas bigint, p_set int)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE v_id bigint;
BEGIN
  SELECT id INTO v_id FROM public.vb_oddechove_casy
    WHERE zapas_id = p_zapas AND set_cislo = p_set
    ORDER BY id DESC LIMIT 1;
  IF v_id IS NULL THEN RETURN NULL; END IF;
  DELETE FROM public.vb_oddechove_casy WHERE id = v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.vb_smaz_posledni_oddechovy(bigint,int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vb_smaz_posledni_oddechovy(bigint,int) TO authenticated;

-- Zápis do vb_set_info vracel jen svoje dvě počítadla. Appka si tou odpovědí
-- přepsala celý řádek, takže po time-outu zmizelo první podání i nahrávačka
-- a musely se zadávat znovu. Vracet celý řádek je odolné i proti dalším
-- sloupcům, které v tabulce teprve přibydou.
CREATE OR REPLACE FUNCTION public.vb_zapis_set_info(p_zapas bigint, p_set int, p_pole text, p_delta int)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE v_radek public.vb_set_info;
BEGIN
  IF p_zapas IS NULL THEN RAISE EXCEPTION 'Chybí zápas'; END IF;
  IF p_pole IS NULL OR p_pole NOT IN ('oddechove_casy','stridani') THEN
    RAISE EXCEPTION 'Neznámé pole: %', coalesce(p_pole,'(null)');
  END IF;
  IF p_set IS NULL OR p_set < 1 OR p_set > 5 THEN
    RAISE EXCEPTION 'Set mimo rozsah 1-5: %', coalesce(p_set::text,'(null)');
  END IF;
  IF p_delta IS NULL OR p_delta < -20 OR p_delta > 20 THEN
    RAISE EXCEPTION 'Nesmyslná změna: %', coalesce(p_delta::text,'(null)');
  END IF;

  EXECUTE format(
    'INSERT INTO public.vb_set_info (zapas_id, set_cislo, %1$I)
       VALUES ($1, $2, greatest(0, $3))
     ON CONFLICT (zapas_id, set_cislo) DO UPDATE
       SET %1$I = greatest(0, public.vb_set_info.%1$I + $3)', p_pole)
    USING p_zapas, p_set, p_delta;

  SELECT * INTO v_radek FROM public.vb_set_info
    WHERE zapas_id = p_zapas AND set_cislo = p_set;
  RETURN to_jsonb(v_radek);
END $$;

REVOKE ALL ON FUNCTION public.vb_zapis_set_info(bigint,int,text,int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vb_zapis_set_info(bigint,int,text,int) TO authenticated;
