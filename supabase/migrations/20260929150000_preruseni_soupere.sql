-- Time-outy a střídání soupeře (#107, úroveň A). Divák vidí přerušení jen na
-- naší straně; druhá strana sítě je v logu prázdná, i když se tam taky střídá
-- a bere time-out.
--
-- Rozšířit obě stávající tabulky o `strana` je lepší než zakládat jejich kopie:
-- průběh pak míchá obě strany jedním kódem a DEFAULT 'my' nechá odehrané
-- zápasy být — všechno, co je v datech dnes, je naše.
ALTER TABLE public.vb_oddechove_casy
  ADD COLUMN IF NOT EXISTS strana text NOT NULL DEFAULT 'my'
    CHECK (strana IN ('my','oni'));

ALTER TABLE public.vb_stridani
  ADD COLUMN IF NOT EXISTS strana text NOT NULL DEFAULT 'my'
    CHECK (strana IN ('my','oni'));

-- U soupeře se vede číslo na dresu, ne hráčka: je to jediné, co je na place
-- vidět, a nevzniká tím evidence cizích soupisek.
ALTER TABLE public.vb_stridani
  ADD COLUMN IF NOT EXISTS cislo_ven int CHECK (cislo_ven BETWEEN 0 AND 99);
ALTER TABLE public.vb_stridani
  ADD COLUMN IF NOT EXISTS cislo_dovnitr int CHECK (cislo_dovnitr BETWEEN 0 AND 99);

-- Každá strana má svoje sloupce a do cizích nesahá: naše střídání je vazba na
-- hráčku, soupeřovo dvě čísla. Bez toho by se daly zapsat řádky, u kterých
-- nepoznáš, komu patří jméno.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vb_stridani_strana_sloupce') THEN
    ALTER TABLE public.vb_stridani ADD CONSTRAINT vb_stridani_strana_sloupce CHECK (
      (strana = 'my'  AND cislo_ven IS NULL AND cislo_dovnitr IS NULL) OR
      (strana = 'oni' AND hrac_ven  IS NULL AND hrac_dovnitr  IS NULL)
    );
  END IF;
END $$;

/* Nové parametry mají DEFAULT, takže starší appka volá dál beze změny — ale
   CREATE OR REPLACE by z jiného počtu argumentů udělal přetížení a PostgREST
   by pak u volání se starými jmény nevěděl, kterou funkci vzít. Proto DROP. */
DROP FUNCTION IF EXISTS public.vb_zapis_oddechovy(bigint,int,int,int);
CREATE FUNCTION public.vb_zapis_oddechovy(p_zapas bigint, p_set int,
                                          p_my int, p_oni int,
                                          p_strana text DEFAULT 'my')
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
  IF coalesce(p_strana,'my') NOT IN ('my','oni') THEN
    RAISE EXCEPTION 'Neznámá strana: %', p_strana;
  END IF;

  INSERT INTO public.vb_oddechove_casy (zapas_id, set_cislo, skore_my, skore_oni, strana)
    VALUES (p_zapas, p_set, p_my, p_oni, coalesce(p_strana,'my'))
    RETURNING * INTO v_radek;
  RETURN v_radek;
END $$;

REVOKE ALL ON FUNCTION public.vb_zapis_oddechovy(bigint,int,int,int,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vb_zapis_oddechovy(bigint,int,int,int,text) TO authenticated;

DROP FUNCTION IF EXISTS public.vb_smaz_posledni_oddechovy(bigint,int);
CREATE FUNCTION public.vb_smaz_posledni_oddechovy(p_zapas bigint, p_set int,
                                                  p_strana text DEFAULT 'my')
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE v_id bigint;
BEGIN
  -- „zpět" bere poslední ze své strany: náš klik nesmí smazat soupeřův time-out
  SELECT id INTO v_id FROM public.vb_oddechove_casy
    WHERE zapas_id = p_zapas AND set_cislo = p_set AND strana = coalesce(p_strana,'my')
    ORDER BY id DESC LIMIT 1;
  IF v_id IS NULL THEN RETURN NULL; END IF;
  DELETE FROM public.vb_oddechove_casy WHERE id = v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.vb_smaz_posledni_oddechovy(bigint,int,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vb_smaz_posledni_oddechovy(bigint,int,text) TO authenticated;

DROP FUNCTION IF EXISTS public.vb_zapis_stridani(bigint,int,int,int,bigint,bigint);
CREATE FUNCTION public.vb_zapis_stridani(p_zapas bigint, p_set int,
                                         p_my int, p_oni int,
                                         p_ven bigint, p_dovnitr bigint,
                                         p_strana text DEFAULT 'my',
                                         p_cislo_ven int DEFAULT NULL,
                                         p_cislo_dovnitr int DEFAULT NULL)
RETURNS public.vb_stridani
LANGUAGE plpgsql
AS $$
DECLARE v_radek public.vb_stridani;
        v_strana text := coalesce(p_strana,'my');
BEGIN
  IF p_zapas IS NULL THEN RAISE EXCEPTION 'Chybí zápas'; END IF;
  IF p_set IS NULL OR p_set < 1 OR p_set > 5 THEN
    RAISE EXCEPTION 'Set mimo rozsah 1-5: %', coalesce(p_set::text,'(null)');
  END IF;
  IF p_my IS NULL OR p_oni IS NULL OR p_my < 0 OR p_oni < 0 THEN
    RAISE EXCEPTION 'Nesmyslný stav: %:%', coalesce(p_my::text,'(null)'), coalesce(p_oni::text,'(null)');
  END IF;
  IF v_strana NOT IN ('my','oni') THEN
    RAISE EXCEPTION 'Neznámá strana: %', p_strana;
  END IF;

  INSERT INTO public.vb_stridani (zapas_id, set_cislo, skore_my, skore_oni,
                                  hrac_ven, hrac_dovnitr, strana,
                                  cislo_ven, cislo_dovnitr)
    VALUES (p_zapas, p_set, p_my, p_oni,
            CASE WHEN v_strana='my' THEN p_ven END,
            CASE WHEN v_strana='my' THEN p_dovnitr END,
            v_strana,
            CASE WHEN v_strana='oni' THEN p_cislo_ven END,
            CASE WHEN v_strana='oni' THEN p_cislo_dovnitr END)
    RETURNING * INTO v_radek;
  RETURN v_radek;
END $$;

REVOKE ALL ON FUNCTION public.vb_zapis_stridani(bigint,int,int,int,bigint,bigint,text,int,int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vb_zapis_stridani(bigint,int,int,int,bigint,bigint,text,int,int) TO authenticated;

DROP FUNCTION IF EXISTS public.vb_smaz_posledni_stridani(bigint,int);
CREATE FUNCTION public.vb_smaz_posledni_stridani(p_zapas bigint, p_set int,
                                                 p_strana text DEFAULT 'my')
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE v_id bigint;
BEGIN
  SELECT id INTO v_id FROM public.vb_stridani
    WHERE zapas_id = p_zapas AND set_cislo = p_set AND strana = coalesce(p_strana,'my')
    ORDER BY id DESC LIMIT 1;
  IF v_id IS NULL THEN RETURN NULL; END IF;
  DELETE FROM public.vb_stridani WHERE id = v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.vb_smaz_posledni_stridani(bigint,int,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vb_smaz_posledni_stridani(bigint,int,text) TO authenticated;
