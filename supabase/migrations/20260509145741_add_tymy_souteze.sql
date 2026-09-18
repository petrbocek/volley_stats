CREATE TABLE vb_tymy (
  id bigserial PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  nazev text NOT NULL
);
CREATE TABLE vb_hraci_tymy (
  hrac_id bigint REFERENCES vb_hraci(id) ON DELETE CASCADE,
  tym_id bigint REFERENCES vb_tymy(id) ON DELETE CASCADE,
  PRIMARY KEY (hrac_id, tym_id)
);
CREATE TABLE vb_souteze (
  id bigserial PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  sezona_id bigint REFERENCES vb_sezony(id),
  nazev text NOT NULL
);
ALTER TABLE vb_zapasy ADD COLUMN IF NOT EXISTS soutez_id bigint REFERENCES vb_souteze(id);
ALTER TABLE vb_tymy DISABLE ROW LEVEL SECURITY;
ALTER TABLE vb_hraci_tymy DISABLE ROW LEVEL SECURITY;
ALTER TABLE vb_souteze DISABLE ROW LEVEL SECURITY;
