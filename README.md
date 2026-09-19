# Volejbal · Statistiky

Webová aplikace na zapisování volejbalových statistik. Zápas se zapisuje živě
z telefonu nebo tabletu na lavičce, statistiky se pak dají filtrovat a
vyexportovat.

Statické stránky bez buildu, data v [Supabase](https://supabase.com),
nasazení přes [Vercel](https://vercel.com).

## Struktura

```
index.html              struktura stránky a modaly
app.js                  veškerá logika (bez závislostí)
style.css               styly
supabase/migrations/    schéma databáze — jediný zdroj pravdy
supabase/README.md      práce s databází, zabezpečení, zapisovatelé
tests/                  testy v prohlížeči
gh_issues.py            pomůcka na zakládání issues z ISSUES.md
```

Aplikace záměrně nemá žádné knihovny ani build krok: `index.html` se dá otevřít
rovnou a `app.js` je jeden soubor, ve kterém se dá hledat. Přihlášení proti
Supabase Auth je proto napsané ručně místo `supabase-js`.

## Spuštění lokálně

```sh
python3 -m http.server 8000
```

a otevřít <http://localhost:8000>. Aplikace se připojí k produkční databázi —
klíče jsou v `app.js:1-2`. Pro vlastní instanci viz `supabase/README.md`.

## Zabezpečení

Čtení je veřejné, zapisovat může jen uživatel zapsaný v `vb_zapisovatele`.
Anon klíč v `app.js` je publishable a veřejný být má; autorizace stojí na RLS
policy, ne na jeho utajení. Podrobnosti a postup přidání zapisovatele jsou
v `supabase/README.md`.

Bez přihlášení appka všechno ukáže, ale nepustí zapisovat — nahoře svítí lišta
„jen pro čtení".

## Přehled

Seznam zápasů ukazuje probíhající zápas, nejbližší plánovaný a poslední
dokončené. Klik na řádek (nebo Enter) otevře zápas rovnou v Live.

## Zápis zápasu

V záložce **Live** se vybere zápas a přidají hráčky do sestavy. Klepnutí na
počítadlo přidá akci, **dlouhý stisk nebo pravé tlačítko ji vezme zpět**.

Nahoře je **přepínač setu**. Počítadla ukazují vždy jen právě zvolený set;
tečka u čísla znamená, že v tom setu už něco zapsaného je. Vybraný set si
appka pamatuje pro každý zápas zvlášť, takže reload uprostřed třetího setu
neshodí zápis zpátky do prvního.

První řádek tabulky je **souhrn týmu** — součet každého sloupce za celou
sestavu. Čísla sedí pod svými sloupci, takže není co si splést. Tlačítko
v prvním sloupci přepíná mezi právě zapisovaným setem a celým zápasem.

Ve Statistikách se sety sčítají. Filtrem „set" se dají rozpadnout zpátky.
Pozor: zápasy z doby před zavedením setů (#32) mají všechno pod 1. setem,
takže u nich rozpad nic neřekne.

Zapisovat může víc lidí najednou; posílají se přírůstky, ne celé řádky, takže
se zápisy nepřebíjejí. Čísla z druhého zařízení se dorovnají zhruba do deseti
sekund.

## Týmy

Tým patří sezóně, ve které vznikl, a v jiné se nenabízí. Členství hráček je
tím pádem vázané na sezónu taky — ve správě týmu se nabízejí jen hráčky ze
soupisky té sezóny. Do nové sezóny se tým nepřenáší, založí se znovu.

## Soupiska

Hráčku jde smazat jen dokud nemá zaznamenané akce — cizí klíč ve
`vb_statistiky` má `ON DELETE CASCADE`, takže smazání by vzalo i její čísla.
Jakmile něco odehraje, nabízí se místo toho **archivace**: zmizí ze soupisky,
sestav i správy týmů, ale statistiky zůstanou a v Archivu jde kdykoli obnovit.

## Testy

Testy jedou v Chromiu přes Playwright a Supabase mají odchycené, takže
**nesahají na produkční data** — ověřuje se, co aplikace odeslala.

```sh
npm i playwright            # jednorázově
python3 -m http.server 8099 &
node tests/live-stats.test.mjs
```

Volitelně `APP_URL` (jiná adresa) a `CHROMIUM_PATH` (jiné Chromium).

V CI testy neběží; Vercel dělá jen nasazení, takže je před změnou v `app.js`
potřeba pustit je ručně.

## Nasazení

Push do `main` nasadí Vercel sám. Změny schématu se nasazují zvlášť, viz
`supabase/README.md` — a když se mění obojí, je pořadí důležité: nejdřív
nasadit aplikaci, pak utáhnout databázi, ať nevznikne chvíle, kdy nasazená
verze neumí to, co už databáze vyžaduje.
