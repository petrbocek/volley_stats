-- Volejbal · Statistiky — Supabase schema
-- Projekt: cqcjdslqygayijxfhzof
-- Spusť v SQL editoru Supabase

CREATE TABLE vb_sezony (
  id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now(),
  nazev text NOT NULL, aktivni boolean DEFAULT false
);
CREATE TABLE vb_hraci (
  id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now(),
  jmeno text NOT NULL, cislo int, pozice text DEFAULT 'smečař',
  aktivni boolean NOT NULL DEFAULT true
);
CREATE TABLE vb_hraci_sezony (
  hrac_id bigint REFERENCES vb_hraci(id) ON DELETE CASCADE,
  sezona_id bigint REFERENCES vb_sezony(id) ON DELETE CASCADE,
  PRIMARY KEY (hrac_id, sezona_id)
);
CREATE TABLE vb_zapasy (
  id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now(),
  sezona_id bigint REFERENCES vb_sezony(id),
  datum date NOT NULL, cas time, soupet text NOT NULL,
  misto text DEFAULT 'doma', stav text DEFAULT 'planovany',
  sety_my int, sety_oni int,
  set1_my int, set1_oni int, set2_my int, set2_oni int,
  set3_my int, set3_oni int, set4_my int, set4_oni int,
  set5_my int, set5_oni int, poznamka text
);
CREATE TABLE vb_statistiky (
  id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now(),
  zapas_id bigint REFERENCES vb_zapasy(id) ON DELETE CASCADE,
  hrac_id bigint REFERENCES vb_hraci(id) ON DELETE CASCADE,
  utok_plus int DEFAULT 0, utok_minus int DEFAULT 0, utok_neutral int DEFAULT 0,
  servis_plus int DEFAULT 0, servis_minus int DEFAULT 0, servis_neutral int DEFAULT 0,
  blok_plus int DEFAULT 0, blok_minus int DEFAULT 0, blok_neutral int DEFAULT 0,
  prijem_plus int DEFAULT 0, prijem_minus int DEFAULT 0, prijem_neutral int DEFAULT 0,
  vykop_plus int DEFAULT 0, vykop_minus int DEFAULT 0, vykop_neutral int DEFAULT 0,
  nahravka_plus int DEFAULT 0, nahravka_minus int DEFAULT 0, nahravka_neutral int DEFAULT 0,
  chyba_plus int DEFAULT 0, chyba_minus int DEFAULT 0, chyba_neutral int DEFAULT 0,
  UNIQUE(zapas_id, hrac_id)
);
CREATE TABLE vb_tymy (
  id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now(),
  nazev text NOT NULL
);
CREATE TABLE vb_hraci_tymy (
  hrac_id bigint REFERENCES vb_hraci(id) ON DELETE CASCADE,
  tym_id bigint REFERENCES vb_tymy(id) ON DELETE CASCADE,
  PRIMARY KEY (hrac_id, tym_id)
);
CREATE TABLE vb_souteze (
  id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now(),
  sezona_id bigint REFERENCES vb_sezony(id), nazev text NOT NULL
);
CREATE TABLE vb_zapas_hraci (
  zapas_id bigint REFERENCES vb_zapasy(id) ON DELETE CASCADE,
  hrac_id bigint REFERENCES vb_hraci(id) ON DELETE CASCADE,
  PRIMARY KEY (zapas_id, hrac_id)
);

ALTER TABLE vb_zapasy ADD COLUMN IF NOT EXISTS soutez_id bigint REFERENCES vb_souteze(id);
ALTER TABLE vb_zapasy ADD COLUMN IF NOT EXISTS tym_id bigint REFERENCES vb_tymy(id);

-- ─────────────────────────── ZABEZPEČENÍ (RLS) ───────────────────────────
-- Anon klíč v app.js je veřejný — je to publishable klíč, tak to má být.
-- Autorizace proto musí stát na policy, ne na jeho utajení.
--
--   čtení  : kdokoli (statistiky jde poslat rodičům a hráčkám)
--   zápis  : jen uživatel zapsaný v vb_zapisovatele
--
-- Gating přes allowlist, ne přes samotnou roli 'authenticated': kdyby byla
-- v projektu zapnutá veřejná registrace, kdokoli by se zaregistroval a rovnou
-- měl právo zápisu.

CREATE TABLE IF NOT EXISTS vb_zapisovatele (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  poznamka text,
  created_at timestamptz DEFAULT now()
);
-- RLS zapnuté a žádná policy = přes REST API nedostupná, spravuje se z SQL editoru
ALTER TABLE vb_zapisovatele ENABLE ROW LEVEL SECURITY;

-- SECURITY DEFINER, aby policy viděla do allowlistu i přes jeho vlastní RLS
CREATE OR REPLACE FUNCTION public.je_zapisovatel() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$ SELECT EXISTS (SELECT 1 FROM public.vb_zapisovatele z WHERE z.user_id = auth.uid()) $$;

-- Přidání zapisovatele (uživatel musí existovat v Auth):
--   INSERT INTO vb_zapisovatele(user_id, poznamka)
--   SELECT id, 'trenér' FROM auth.users WHERE email = 'nekdo@example.cz';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vb_sezony','vb_hraci','vb_hraci_sezony','vb_zapasy',
                           'vb_statistiky','vb_tymy','vb_hraci_tymy','vb_souteze','vb_zapas_hraci']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS anon_all ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS cteni_verejne ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS zapis_zapisovatel ON public.%I', t);
    EXECUTE format('CREATE POLICY cteni_verejne ON public.%I FOR SELECT TO anon, authenticated USING (true)', t);
    EXECUTE format('CREATE POLICY zapis_zapisovatel ON public.%I FOR ALL TO authenticated USING (public.je_zapisovatel()) WITH CHECK (public.je_zapisovatel())', t);
  END LOOP;
END $$;
