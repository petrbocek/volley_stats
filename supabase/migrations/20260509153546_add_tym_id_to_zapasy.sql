ALTER TABLE vb_zapasy ADD COLUMN IF NOT EXISTS tym_id bigint REFERENCES vb_tymy(id);
