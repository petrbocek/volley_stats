-- Pole se rozpadá na tři věci (#124).
--
-- Dosud mělo jedinou variantu, „vybraný balon". Klepalo se pod ni ale
-- všechno, co se v poli zvedlo — obrana po útoku i zvednutý volný míč od
-- soupeře. Volný míč se uhrává líp, takže konverze z obrany vycházela líp,
-- než jaká obrana opravdu byla. A chyba v poli (balon spadl) se nedala
-- zapsat vůbec, takže se ztracený bod připisoval soupeři, ne obraně.
--
--   pole_neutral  `/`  vybraný balon po útoku — obrana, výměna pokračuje
--   pole_minus    `−`  balon spadl: ztracený bod jako každé jiné minus
--   pole_free     `~`  zvednutý volný míč od soupeře, výměna pokračuje
--
-- pole_minus patří do skóre (SKORE_JEJICH) i do „celkem" v appce; ostatní
-- dvě varianty se skóre nedotknou.
--
-- DEFAULT 0 a NOT NULL: odehrané zápasy se tím nemění a starší verze appky
-- sloupce prostě ignoruje. Co je v datech staršího, zůstane smíchané pod
-- pole_neutral — to už se zpětně nerozplete.
ALTER TABLE public.vb_statistiky
  ADD COLUMN IF NOT EXISTS pole_minus int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pole_free  int NOT NULL DEFAULT 0;

DO $$
BEGIN
  ALTER TABLE public.vb_statistiky
    ADD CONSTRAINT vb_statistiky_pole_minus_chk CHECK (pole_minus >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.vb_statistiky
    ADD CONSTRAINT vb_statistiky_pole_free_chk CHECK (pole_free >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.vb_statistiky.pole_minus IS
  'Chyba v poli: balon spadl, obrana neprošla. Ztracený bod, jako každé jiné minus.';
COMMENT ON COLUMN public.vb_statistiky.pole_free IS
  'Zvednutý volný míč od soupeře. Není to obrana po útoku ani ztráta bodu.';

-- Whitelist v zápisu akcí je jmenný seznam, takže nové sloupce se musí
-- přidat i sem — jinak by RPC zápis odmítla jako neznámé pole.
CREATE OR REPLACE FUNCTION public.vb_zapis_akce(p_zmeny jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  povolena text[] := ARRAY[
    'servis_plus','servis_neutral','servis_minus',
    'prijem_plus','prijem_neutral','prijem_minus',
    'utok_plus','utok_neutral','utok_minus','utok_free',
    'blok_plus','blok_neutral','blok_minus',
    'chyba_plus','chyba_neutral','chyba_minus',
    'pole_neutral','pole_minus','pole_free'];
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
END $fn$;

REVOKE ALL ON FUNCTION public.vb_zapis_akce(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vb_zapis_akce(jsonb) TO authenticated;
