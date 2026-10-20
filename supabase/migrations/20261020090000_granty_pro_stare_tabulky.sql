-- Výslovné granty pro tabulky z prvních migrací.
--
-- Supabase od 30. 10. 2026 přestává novým tabulkám ve schématu `public`
-- automaticky dávat přístup přes Data API. Běžícího projektu se to netýká —
-- jeho tabulky si granty drží. Týká se to ale každého nového sešlápnutí
-- schématu z migrací: nový projekt, preview branch, `supabase db reset`.
-- A čtyři nejstarší migrace spoléhaly právě na ten automatický grant, takže
-- by po tom datu vznikly tabulky, na které appka dostane „permission denied".
--
-- Novější migrace (#84 a dál) granty píšou samy, tahle jen dorovnává zbytek.
-- V běžícím projektu je to no-op: tyhle granty tam dávno jsou.
--
-- Rozsah je stejný jako u ostatních tabulek: anon čte (divácká stránka umí
-- jedinou metodu, GET), authenticated píše a kdo z přihlášených smí doopravdy
-- zapisovat, hlídá RLS přes je_zapisovatel().
--
-- service_role tu schválně není: projekt žádný serverový klíč nepoužívá
-- (appka i divácká stránka jedou na anon klíči a přihlášení uživatele), a co
-- se nepoužívá, nemá mít přístup. Kdyby někdy přibyla edge funkce, přidá se
-- grant s ní.
GRANT SELECT ON public.vb_sezony        TO anon, authenticated;
GRANT SELECT ON public.vb_hraci         TO anon, authenticated;
GRANT SELECT ON public.vb_hraci_sezony  TO anon, authenticated;
GRANT SELECT ON public.vb_zapasy        TO anon, authenticated;
GRANT SELECT ON public.vb_statistiky    TO anon, authenticated;
GRANT SELECT ON public.vb_tymy          TO anon, authenticated;
GRANT SELECT ON public.vb_hraci_tymy    TO anon, authenticated;
GRANT SELECT ON public.vb_souteze       TO anon, authenticated;
GRANT SELECT ON public.vb_zapas_hraci   TO anon, authenticated;

GRANT INSERT, UPDATE, DELETE ON public.vb_sezony        TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.vb_hraci         TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.vb_hraci_sezony  TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.vb_zapasy        TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.vb_statistiky    TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.vb_tymy          TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.vb_hraci_tymy    TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.vb_souteze       TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.vb_zapas_hraci   TO authenticated;

-- Sekvence pod sloupci `id`: bez USAGE neprojde INSERT, který si id nechává
-- dopočítat. Automatický grant je dával taky, tak ať o ně nový projekt
-- nepřijde — platí to i pro novější tabulky (udalosti, oddechove_casy,
-- stridani), jejichž migrace granty na sekvence taky nepsaly.
--
-- „ALL SEQUENCES" bere jen to, co v tu chvíli existuje. Migrace, které
-- přijdou po téhle, si granty musí napsat samy — stejně jako tabulky.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- vb_zapisovatele tu schválně není. Čte se jen přes je_zapisovatel(), což je
-- SECURITY DEFINER funkce — allowlist zapisovatelů nemá přes API svítit vůbec.
