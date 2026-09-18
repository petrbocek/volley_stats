# Databáze

Zdroj pravdy je **`supabase/migrations/`**, nic jiného. Dřív stál vedle nich
ještě ručně psaný `schema.sql` a přesně ten se rozešel s produkcí (#25):
chyběly mu sloupce `chyba_plus` a `chyba_neutral`, které v databázi byly,
a tvrdil `DISABLE ROW LEVEL SECURITY`, i když RLS zapnuté bylo. Dva zdroje
pravdy znamenaly, že jeden z nich lže — a poznalo se to, až když z něj někdo
založil nový projekt a appka mu spadla při prvním kliku.

Soubor byl proto zrušen. Kdyby byl potřeba přehled celého schématu, generuje
se z databáze:

```sh
supabase db dump --schema public
```

## Založení projektu od nuly

```sh
supabase link --project-ref <ref>
supabase db push
```

Migrace `20260918190714_vb_zapisovatele_allowlist.sql` zapisuje do allowlistu
účet `petrbocek@email.cz`. Na čerstvém projektu, kde takový uživatel v Auth
není, neudělá nic — zapisovatele je pak potřeba přidat ručně (viz níže).

## Změna schématu

Nikdy ne ručně v SQL editoru nebo v dashboardu — tak vznikl původní rozjezd.
Vždy novou migrací:

```sh
supabase migration new nazev_zmeny
# napsat SQL do vzniklého souboru
supabase db push
```

## Zabezpečení

Čtení je veřejné, zápis smí jen uživatel zapsaný v `vb_zapisovatele`.
Podrobně v #24; policy jsou v migraci
`20260918191309_rls_cteni_verejne_zapis_jen_zapisovatel.sql`.

Gating je vázaný na allowlist, ne na roli `authenticated` samotnou. Kdyby
byla v projektu zapnutá veřejná registrace, kdokoli by se zaregistroval
a měl rovnou právo zápisu.

### Přidání zapisovatele

Uživatel musí nejdřív existovat v Supabase Auth (dashboard → Authentication
→ Add user). Pak v SQL editoru:

```sql
INSERT INTO vb_zapisovatele (user_id, poznamka)
SELECT id, 'trenér' FROM auth.users WHERE email = 'nekdo@example.cz';
```

### Odebrání

```sql
DELETE FROM vb_zapisovatele
WHERE user_id = (SELECT id FROM auth.users WHERE email = 'nekdo@example.cz');
```

Účet v Auth zůstane, jen ztratí právo zápisu — číst může dál jako kdokoli jiný.

## Kontrola, že repo sedí s produkcí

```sh
supabase db diff --linked
```

Prázdný výstup znamená, že se nic nerozešlo.
