-- Pole (anglicky dig): vybraný balon v poli (#84). Zatím se vede jen počet —
-- je to pokus, ne bodovaná akce, takže se skóre nedotkne. Proto neutrální
-- varianta: ta v celé appce znamená „výměna pokračuje".
--
-- DEFAULT 0 a NOT NULL: odehrané zápasy se tím nemění a starší verze appky
-- sloupec prostě ignoruje.
ALTER TABLE public.vb_statistiky
  ADD COLUMN IF NOT EXISTS pole_neutral int NOT NULL DEFAULT 0;

DO $$
BEGIN
  ALTER TABLE public.vb_statistiky
    ADD CONSTRAINT vb_statistiky_pole_neutral_chk CHECK (pole_neutral >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.vb_statistiky.pole_neutral IS
  'Pole / dig — vybraný balon. Pokus bez vlivu na skóre.';

-- Whitelist v zápisu akcí je jmenný seznam, takže nový sloupec se musí přidat
-- i sem — jinak by RPC zápis odmítla jako neznámé pole.
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
    'chyba_plus','chyba_neutral','chyba_minus',
    'pole_neutral'];
  zmena jsonb;
  v_zapas bigint;
  v_hrac bigint;
  v_set int;
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
    v_set   := coalesce((zmena->>'set_cislo')::int, 1);
    v_pole  := zmena->>'pole';
    v_delta := (zmena->>'delta')::int;

    IF v_pole IS NULL OR NOT (v_pole = ANY(povolena)) THEN
      RAISE EXCEPTION 'Neznámé pole statistiky: %', coalesce(v_pole,'(null)');
    END IF;
    IF v_delta IS NULL OR v_delta < -50 OR v_delta > 50 THEN
      RAISE EXCEPTION 'Nesmyslná změna pro %: %', v_pole, coalesce(v_delta::text,'(null)');
    END IF;
    IF v_set < 1 OR v_set > 5 THEN
      RAISE EXCEPTION 'Set mimo rozsah 1-5: %', v_set;
    END IF;

    EXECUTE format(
      'INSERT INTO public.vb_statistiky (zapas_id, hrac_id, set_cislo, %1$I)
         VALUES ($1, $2, $3, greatest(0, $4))
       ON CONFLICT (zapas_id, hrac_id, set_cislo) DO UPDATE
         SET %1$I = greatest(0, public.vb_statistiky.%1$I + $4)
       RETURNING %1$I', v_pole)
      USING v_zapas, v_hrac, v_set, v_delta
      INTO v_nova;

    vysledek := vysledek || jsonb_build_object(
      'zapas_id', v_zapas, 'hrac_id', v_hrac, 'set_cislo', v_set,
      'pole', v_pole, 'hodnota', v_nova);
  END LOOP;

  RETURN vysledek;
END $$;

REVOKE ALL ON FUNCTION public.vb_zapis_akce(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vb_zapis_akce(jsonb) TO authenticated;
