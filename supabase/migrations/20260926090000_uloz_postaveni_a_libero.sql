-- Rotace padala na vb_postaveni_jedna_zona: upsert po řádcích znamená, že
-- hráčka na okamžik existuje ve dvou zónách naráz a unikátní index to shodí.
-- Výměna celého postavení musí proběhnout v jedné transakci.
CREATE OR REPLACE FUNCTION public.vb_uloz_postaveni(p_zapas bigint, p_set int, p_postaveni jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_pocet int;
BEGIN
  IF p_zapas IS NULL THEN RAISE EXCEPTION 'Chybí zápas'; END IF;
  IF p_set IS NULL OR p_set < 1 OR p_set > 5 THEN
    RAISE EXCEPTION 'Set mimo rozsah 1-5: %', coalesce(p_set::text,'(null)');
  END IF;
  IF jsonb_typeof(p_postaveni) <> 'array' THEN
    RAISE EXCEPTION 'Očekávám pole, dostal jsem %', jsonb_typeof(p_postaveni);
  END IF;
  IF jsonb_array_length(p_postaveni) > 6 THEN
    RAISE EXCEPTION 'Na hřišti může stát nejvýš šest hráček, dostal jsem %', jsonb_array_length(p_postaveni);
  END IF;

  -- nejdřív pryč všechno, pak nové: jen tak se nikdo nepotká sám se sebou
  DELETE FROM public.vb_postaveni WHERE zapas_id = p_zapas AND set_cislo = p_set;

  INSERT INTO public.vb_postaveni (zapas_id, set_cislo, zona, hrac_id)
  SELECT p_zapas, p_set, (x->>'zona')::int, (x->>'hrac_id')::bigint
    FROM jsonb_array_elements(p_postaveni) x;

  GET DIAGNOSTICS v_pocet = ROW_COUNT;
  RETURN jsonb_build_object('zapas_id', p_zapas, 'set_cislo', p_set, 'pocet', v_pocet);
END $$;

REVOKE ALL ON FUNCTION public.vb_uloz_postaveni(bigint,int,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vb_uloz_postaveni(bigint,int,jsonb) TO authenticated;

-- Libero se nominuje do sestavy zápasu, ne odvozuje z pozice hráčky: pozice
-- je vlastnost hráčky, libero je role v konkrétním zápase a může se lišit.
ALTER TABLE public.vb_zapas_hraci ADD COLUMN IF NOT EXISTS libero boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.vb_zapas_hraci.libero IS
  'Nominované libero pro tento zápas. Nezávisí na vb_hraci.pozice.';
