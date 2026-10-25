-- anon smí jen číst.
--
-- Automatický grant, který Supabase dával každé nové tabulce ve `public`,
-- byl GRANT ALL. Anon tím měl na všech tabulkách i INSERT/UPDATE/DELETE,
-- přestože migrace pouštěly jen SELECT — zapsat se díky RLS stejně nedalo,
-- ale stálo to na jedné pojistce místo dvou.
--
-- Nic to nerozbije: divácká stránka jede na anon klíči a umí jedinou
-- metodu, GET; appka zapisuje až po přihlášení, tedy rolí authenticated.
--
-- TRUNCATE, REFERENCES a TRIGGER jdou pryč se zbytkem. PostgREST je neumí
-- zavolat, ale TRUNCATE je jediná písnička, kterou RLS nehlídá — a co se
-- nepoužívá, nemá být povolené.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public FROM anon;

-- Sekvence anon nepotřebuje, když nesmí vkládat.
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- „ALL TABLES" bere jen to, co existuje teď. Co přibude později, si granty
-- (a tedy i jejich rozsah) píše ve své migraci — viz supabase/README.md.
