-- Co se v setu spotřebovalo: oddechové časy a střídání. Odvodit se to nedá —
-- oddechový čas není akce hráčky a historie střídání se nikde nedrží (#84).
CREATE TABLE IF NOT EXISTS public.vb_set_info (
  zapas_id       bigint NOT NULL REFERENCES public.vb_zapasy(id) ON DELETE CASCADE,
  set_cislo      int    NOT NULL CHECK (set_cislo BETWEEN 1 AND 5),
  oddechove_casy int    NOT NULL DEFAULT 0 CHECK (oddechove_casy >= 0),
  stridani       int    NOT NULL DEFAULT 0 CHECK (stridani >= 0),
  PRIMARY KEY (zapas_id, set_cislo)
);

ALTER TABLE public.vb_set_info ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cteni_verejne ON public.vb_set_info;
DROP POLICY IF EXISTS zapis_zapisovatel ON public.vb_set_info;
CREATE POLICY cteni_verejne ON public.vb_set_info
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY zapis_zapisovatel ON public.vb_set_info
  FOR ALL TO authenticated USING (public.je_zapisovatel()) WITH CHECK (public.je_zapisovatel());

GRANT SELECT ON public.vb_set_info TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.vb_set_info TO authenticated;

-- Přírůstkově jako všechno ostatní, kvůli dvěma zapisovatelům u jednoho zápasu.
CREATE OR REPLACE FUNCTION public.vb_zapis_set_info(p_zapas bigint, p_set int, p_pole text, p_delta int)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE v_oddechove int; v_stridani int;
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

  SELECT oddechove_casy, stridani INTO v_oddechove, v_stridani
    FROM public.vb_set_info WHERE zapas_id = p_zapas AND set_cislo = p_set;

  RETURN jsonb_build_object('zapas_id', p_zapas, 'set_cislo', p_set,
                            'oddechove_casy', v_oddechove, 'stridani', v_stridani);
END $$;

REVOKE ALL ON FUNCTION public.vb_zapis_set_info(bigint,int,text,int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vb_zapis_set_info(bigint,int,text,int) TO authenticated;
