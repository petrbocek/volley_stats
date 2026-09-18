-- Zápis statistik po inkrementech místo upsertu celého řádku (#27) a zároveň
-- základ pro vzetí zpět (#29) — záporná delta.
--
-- Upsert celého řádku znamenal, že při dvou zapisovatelích u jednoho zápasu
-- vyhrál ten, kdo klikl později, a kliky toho druhého zmizely včetně těch,
-- co už byly uložené. Inkrement se do řádku přičte, takže se nemůžou přebít.
--
-- SECURITY INVOKER (výchozí pro plpgsql), takže se uplatní RLS: zapisovat
-- smí jen ten, koho pustí policy zapis_zapisovatel.

CREATE OR REPLACE FUNCTION public.vb_zapis_akce(p_zmeny jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  povolena text[] := ARRAY[
    'servis_plus','servis_neutral','servis_minus',
    'prijem_plus','prijem_neutral','prijem_minus',
    'utok_plus','utok_neutral','utok_minus',
    'blok_plus','blok_neutral','blok_minus',
    'chyba_plus','chyba_neutral','chyba_minus'];
  zmena jsonb;
  v_zapas bigint;
  v_hrac bigint;
  v_pole text;
  v_delta int;
  v_nova int;
  vysledek jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_zmeny) <> 'array' THEN
    RAISE EXCEPTION 'Očekávám pole změn, dostal jsem %', jsonb_typeof(p_zmeny);
  END IF;
  IF jsonb_array_length(p_zmeny) > 200 THEN
    RAISE EXCEPTION 'Příliš mnoho změn naráz: %', jsonb_array_length(p_zmeny);
  END IF;

  FOR zmena IN SELECT * FROM jsonb_array_elements(p_zmeny)
  LOOP
    v_zapas := (zmena->>'zapas_id')::bigint;
    v_hrac  := (zmena->>'hrac_id')::bigint;
    v_pole  := zmena->>'pole';
    v_delta := (zmena->>'delta')::int;

    -- Název sloupce jde do dynamického SQL, takže whitelist, ne důvěra vstupu.
    IF v_pole IS NULL OR NOT (v_pole = ANY(povolena)) THEN
      RAISE EXCEPTION 'Neznámé pole statistiky: %', coalesce(v_pole,'(null)');
    END IF;
    IF v_delta IS NULL OR v_delta < -50 OR v_delta > 50 THEN
      RAISE EXCEPTION 'Nesmyslná změna pro %: %', v_pole, coalesce(v_delta::text,'(null)');
    END IF;

    EXECUTE format(
      'INSERT INTO public.vb_statistiky (zapas_id, hrac_id, %1$I)
         VALUES ($1, $2, greatest(0, $3))
       ON CONFLICT (zapas_id, hrac_id) DO UPDATE
         SET %1$I = greatest(0, public.vb_statistiky.%1$I + $3)
       RETURNING %1$I', v_pole)
      USING v_zapas, v_hrac, v_delta
      INTO v_nova;

    vysledek := vysledek || jsonb_build_object(
      'zapas_id', v_zapas, 'hrac_id', v_hrac, 'pole', v_pole, 'hodnota', v_nova);
  END LOOP;

  RETURN vysledek;
END $$;

REVOKE ALL ON FUNCTION public.vb_zapis_akce(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vb_zapis_akce(jsonb) TO authenticated;
