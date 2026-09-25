-- Druhá půlka soupeřovy výměny: jeho vlastní bod (smeč v otevřené hře), ne
-- jen jeho chyba. Bez toho odvozené skóre systematicky podhodnocuje soupeře,
-- protože obrana ani přihrávka mezi akcemi nejsou a tu výměnu nemá co zapsat.
ALTER TABLE public.vb_chyby_souperu ADD COLUMN IF NOT EXISTS body integer NOT NULL DEFAULT 0;
ALTER TABLE public.vb_chyby_souperu DROP CONSTRAINT IF EXISTS vb_chyby_souperu_body_check;
ALTER TABLE public.vb_chyby_souperu ADD CONSTRAINT vb_chyby_souperu_body_check CHECK (body >= 0);

COMMENT ON TABLE public.vb_chyby_souperu IS
  'Co se na soupeřově straně stalo: jeho chyby (náš bod) a jeho body. Název tabulky je užší než obsah — přejmenování by rozbilo nasazenou verzi appky bez funkčního přínosu.';
COMMENT ON COLUMN public.vb_chyby_souperu.pocet IS 'Chyby soupeře = náš bod.';
COMMENT ON COLUMN public.vb_chyby_souperu.body IS 'Body soupeře z jeho vlastní iniciativy = jejich bod.';

-- Nová funkce vedle staré, ne místo ní: nasazená verze appky volá
-- vb_zapis_chybu_souperu a musí běžet dál až do svého nasazení.
CREATE OR REPLACE FUNCTION public.vb_zapis_souper(p_zapas bigint, p_set int, p_pole text, p_delta int)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE v_chyby int; v_body int;
BEGIN
  IF p_zapas IS NULL THEN RAISE EXCEPTION 'Chybí zápas'; END IF;
  IF p_pole IS NULL OR p_pole NOT IN ('pocet','body') THEN
    RAISE EXCEPTION 'Neznámé pole: %', coalesce(p_pole,'(null)');
  END IF;
  IF p_set IS NULL OR p_set < 1 OR p_set > 5 THEN
    RAISE EXCEPTION 'Set mimo rozsah 1-5: %', coalesce(p_set::text,'(null)');
  END IF;
  IF p_delta IS NULL OR p_delta < -50 OR p_delta > 50 THEN
    RAISE EXCEPTION 'Nesmyslná změna: %', coalesce(p_delta::text,'(null)');
  END IF;

  EXECUTE format(
    'INSERT INTO public.vb_chyby_souperu (zapas_id, set_cislo, %1$I)
       VALUES ($1, $2, greatest(0, $3))
     ON CONFLICT (zapas_id, set_cislo) DO UPDATE
       SET %1$I = greatest(0, public.vb_chyby_souperu.%1$I + $3)', p_pole)
    USING p_zapas, p_set, p_delta;

  SELECT pocet, body INTO v_chyby, v_body
    FROM public.vb_chyby_souperu WHERE zapas_id = p_zapas AND set_cislo = p_set;

  RETURN jsonb_build_object('zapas_id', p_zapas, 'set_cislo', p_set,
                            'pocet', v_chyby, 'body', v_body);
END $$;

REVOKE ALL ON FUNCTION public.vb_zapis_souper(bigint,int,text,int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vb_zapis_souper(bigint,int,text,int) TO authenticated;
