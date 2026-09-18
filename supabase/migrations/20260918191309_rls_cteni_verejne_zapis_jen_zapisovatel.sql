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
