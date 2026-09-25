-- Kdo stojí v které zóně, po setech (#84). Bez toho nejde ukázat hřiště ani
-- střídání — vb_zapas_hraci zná jen sestavu a pořadí vložení (#75).
--
-- Zóny 1-6 jako ve volejbale: 4-3-2 u sítě, 5-6-1 vzadu, zóna 1 podává.
-- Libero se do zóny neukládá, pozná se podle vb_hraci.pozice a stojí stranou.
CREATE TABLE IF NOT EXISTS public.vb_postaveni (
  zapas_id  bigint NOT NULL REFERENCES public.vb_zapasy(id) ON DELETE CASCADE,
  set_cislo int    NOT NULL CHECK (set_cislo BETWEEN 1 AND 5),
  zona      int    NOT NULL CHECK (zona BETWEEN 1 AND 6),
  hrac_id   bigint NOT NULL REFERENCES public.vb_hraci(id) ON DELETE CASCADE,
  PRIMARY KEY (zapas_id, set_cislo, zona)
);

-- Jedna hráčka nemůže stát ve dvou zónách téhož setu naráz.
CREATE UNIQUE INDEX IF NOT EXISTS vb_postaveni_jedna_zona
  ON public.vb_postaveni (zapas_id, set_cislo, hrac_id);

ALTER TABLE public.vb_postaveni ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cteni_verejne ON public.vb_postaveni;
DROP POLICY IF EXISTS zapis_zapisovatel ON public.vb_postaveni;
CREATE POLICY cteni_verejne ON public.vb_postaveni
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY zapis_zapisovatel ON public.vb_postaveni
  FOR ALL TO authenticated USING (public.je_zapisovatel()) WITH CHECK (public.je_zapisovatel());

GRANT SELECT ON public.vb_postaveni TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.vb_postaveni TO authenticated;
