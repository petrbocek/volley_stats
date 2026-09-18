CREATE TABLE vb_zapas_hraci (
  zapas_id bigint REFERENCES vb_zapasy(id) ON DELETE CASCADE,
  hrac_id bigint REFERENCES vb_hraci(id) ON DELETE CASCADE,
  PRIMARY KEY (zapas_id, hrac_id)
);
ALTER TABLE vb_zapas_hraci DISABLE ROW LEVEL SECURITY;
