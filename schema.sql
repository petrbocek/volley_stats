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
  chyba_minus int DEFAULT 0,
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

ALTER TABLE vb_sezony      ENABLE ROW LEVEL SECURITY;
ALTER TABLE vb_hraci       ENABLE ROW LEVEL SECURITY;
ALTER TABLE vb_hraci_sezony ENABLE ROW LEVEL SECURITY;
ALTER TABLE vb_zapasy      ENABLE ROW LEVEL SECURITY;
ALTER TABLE vb_statistiky  ENABLE ROW LEVEL SECURITY;
ALTER TABLE vb_tymy        ENABLE ROW LEVEL SECURITY;
ALTER TABLE vb_hraci_tymy  ENABLE ROW LEVEL SECURITY;
ALTER TABLE vb_souteze     ENABLE ROW LEVEL SECURITY;
ALTER TABLE vb_zapas_hraci ENABLE ROW LEVEL SECURITY;

-- App používá anon klíč bez autentizace → permissive policy pro anon roli
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'vb_sezony','vb_hraci','vb_hraci_sezony','vb_zapasy',
    'vb_statistiky','vb_tymy','vb_hraci_tymy','vb_souteze','vb_zapas_hraci'
  ] LOOP
    EXECUTE format('CREATE POLICY anon_all ON %I FOR ALL TO anon USING (true) WITH CHECK (true)', tbl);
  END LOOP;
END $$;
