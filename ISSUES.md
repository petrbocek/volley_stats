# Backlog — Volejbal · Statistiky

Zdroj pro `gh_issues.py`. Formát: `## Milník`, `### #N Titulek`, v těle řádek s `labels:`.

Stav zjištěn revizí `app.js` (915 ř.), `schema.sql` a produkční databáze
Supabase `cqcjdslqygayijxfhzof` (16 hráček, 98 řádků statistik) k 18. 9. 2026.

## M1 · Bezpečnost a integrita dat

### #1 RLS policy anon_all dovoluje komukoli smazat celou databázi

`labels: security, db, P0`

**Zjištěno v produkci.** Všech 9 tabulek má RLS zapnuté, ale jedinou policy:

```
policyname = anon_all
cmd        = ALL
roles      = {anon}
using      = true
with_check = true
```

To je funkčně totéž jako RLS vypnuté. Anon klíč je ve veřejném repu
(`app.js:2`), takže kdokoli, kdo repo najde, může proti REST API spustit:

```
curl -X DELETE 'https://cqcjdslqygayijxfhzof.supabase.co/rest/v1/vb_statistiky?id=gt.0' \
  -H "apikey: <anon key z app.js>" -H "Authorization: Bearer <týž klíč>"
```

a smazat nebo přepsat všechna data sezóny. Anon klíč je určený k tomu, aby byl
veřejný — chyba není v jeho zveřejnění, ale v tom, že za ním nestojí žádná
autorizace.

**Návrh řešení** (od nejlevnějšího):

1. **Supabase Auth + login** — zapisovat smí jen přihlášený uživatel,
   policy `using (auth.role() = 'authenticated')`. Čtení může zůstat veřejné,
   pokud mají statistiky být viditelné rodičům/hráčkám.
2. **Anon jen pro čtení** — `anon` dostane `SELECT`, zápis přes edge funkci
   s tajným klíčem. Menší zásah, ale zapisovatel potřebuje heslo někde uložené.
3. Minimálně: oddělit `DELETE` — i bez plného loginu je mazání to nejhorší,
   co může anonym udělat.

Než se to vyřeší, stojí za to zapnout PITR / zálohy, aby šlo obnovit stav.

**Poznámka k rozsahu:** tohle je jediná issue, která může přijít o data
nevratně. Ostatní jsou opravitelné.

---

### #2 schema.sql neodpovídá produkční databázi

`labels: db, bug, P1`

`schema.sql` se rozešel s realitou nejméně ve třech bodech:

| | schema.sql | produkce |
|---|---|---|
| `vb_statistiky.chyba_plus` | chybí | existuje |
| `vb_statistiky.chyba_neutral` | chybí | existuje |
| RLS | `DISABLE ROW LEVEL SECURITY` | zapnuté + policy `anon_all` |

Důsledek: kdo si z tohoto schématu postaví čistý projekt (nebo dev/staging
instanci), tomu aplikace spadne hned při prvním kliku v Live — `makeEmptyStat()`
(`app.js:410`) generuje pole pro **všechny** kombinace `ACTIONS × VARIANTS`,
tedy i `chyba_plus` a `chyba_neutral`, a PostgREST na neexistující sloupec
vrátí 400.

**Návrh řešení:** buď schema.sql doplnit a přidat migraci `ALTER TABLE ... ADD
COLUMN IF NOT EXISTS`, nebo (lépe) přejít na `supabase/migrations/` a schéma
generovat z DB, ať se to nemůže znovu rozejít. Součástí opravy je i sekce RLS,
aby soubor nepopisoval jiný stav zabezpečení, než jaký reálně platí.

---

### #3 Statistiky z posledních 800 ms se ztratí při zavření stránky

`labels: bug, data-loss, P1`

`bump()` (`app.js:424`) zapíše klik do `dirtyStats` a naplánuje `flushStat()`
s 800ms debounce. Pokud během té doby zapisovatel přepne tab v prohlížeči,
zamkne telefon nebo mu spadne spojení, timeout se nikdy nespustí a kliky jsou
pryč — v UI přitom zůstanou zobrazené, takže si toho nikdo nevšimne.

Na lavičce je to reálné: zapíše se poslední bod setu a telefon jde do kapsy.

**Kroky k reprodukci:** v Live kliknout na libovolné tlačítko a do 800 ms
zavřít záložku. Po znovunačtení je počítadlo o jedna níž.

**Návrh řešení:**

- `visibilitychange` (`document.hidden`) a `pagehide` → synchronní flush všech
  klíčů v `dirtyStats`; pro spolehlivé odeslání při zavírání použít
  `navigator.sendBeacon()`.
- Flushnout i při `onLiveZapasChange()` a `onSeasonChange()`, než se přepne kontext.
- Zvážit snížení debounce na ~300 ms; úspora requestů je při pěti hráčkách zanedbatelná.

---

### #4 Dvě zařízení u jednoho zápasu si navzájem přepisují statistiky

`labels: bug, data-loss, P1`

`flushStat()` posílá upsert **celého řádku** (`app.js:433`), ne inkrement.
Když zápas zapisují dva lidé (trenér + asistent, nebo jeden na tabletu a druhý
na telefonu), vyhraje ten, kdo klikl později, a kliky toho druhého zmizí —
včetně těch, co už byly v databázi uložené. `state.statistiky` se navíc mezi
zařízeními nikdy nesynchronizuje, takže ani jeden z nich nevidí, že o data přišel.

**Návrh řešení:**

- Psát inkrementy místo absolutních hodnot — RPC funkce v Postgresu
  (`increment_stat(zapas_id, hrac_id, field, delta)`) s `UPDATE ... SET x = x + delta`.
- Doplnit Supabase Realtime subscription na `vb_statistiky` filtrovanou na
  `zapas_id`, aby se druhé zařízení dorovnalo.
- Minimální varianta, pokud je souběžný zápis mimo záměr: při otevření zápasu,
  který už má statistiky, zobrazit varování.

Souvisí s #3 — obojí je o tom, že zápis z Live tabu není spolehlivý.

---

### #5 init() načítá celé tabulky bez stránkování, nad 1000 řádky tiše ztrácí data

`labels: bug, infra, P2`

`init()` (`app.js:52`) tahá devět tabulek celé, bez `limit`/`Range`. Supabase má
výchozí `max-rows` 1000; po jeho dosažení PostgREST vrátí prvních 1000 řádků
**bez chyby**. Aplikace to nepozná a začne počítat statistiky z neúplných dat.

Dnes je v `vb_statistiky` 98 řádků. Řádek vzniká pro každou dvojici
hráčka × zápas, takže při 14 hráčkách v sestavě je to ~14 řádků na zápas —
strop kolem 70 zápasů, tedy zhruba dvě až tři sezóny.

**Návrh řešení:** načítat statistiky až pro zvolenou sezónu
(`vb_statistiky?zapas_id=in.(...)`) místo všech najednou, případně doplnit
stránkování přes `Range` hlavičku. Při té příležitosti zkontrolovat i ostatní
tabulky — `vb_zapasy` a `vb_hraci_sezony` porostou podobně.

---

## M2 · Live zapisování

### #6 Nelze vzít zpět překliknuté tlačítko

`labels: ux, volleyball, P1`

`bump()` umí jen `+1`. Když zapisovatel klepne vedle — na mobilu při pěti
sloupcích na řádek dost snadné — nemá jak číslo snížit. Jediná oprava je zásah
přímo v Supabase.

**Návrh řešení:**

- Dlouhý stisk (nebo pravé tlačítko) na počítadle = `−1`, s podlahou na nule.
- Nebo tlačítko „Zpět“ v hlavičce Live, které vrátí poslední akci — vyžaduje
  držet zásobník posledních klik, což se hodí i pro #4.
- Ať už to bude cokoli, mělo by to jít ovládat palcem a bez modalu.

---

### #7 Odebrání hráčky ze sestavy nic nepotvrzuje a mlčí o jejích statistikách

`labels: ux, bug, P2`

Křížek na řádku hráčky (`removeZeSestava()`, `app.js:394`) smaže řádek
z `vb_zapas_hraci` okamžitě, bez `confirm()` — na rozdíl od mazání zápasu
i týmu, které se ptají. Křížek je přitom hned vedle počítadel, po kterých se
během zápasu rychle klepe.

Horší je druhá část: hráčka zmizí z Live tabulky, ale její řádek ve
`vb_statistiky` zůstane. Ve Statistikách se tedy pořád počítá, včetně sloupce
„Záp.“, a není jak se k těm číslům přes UI vrátit.

**Návrh řešení:** potvrzení před odebráním, a pokud hráčka už má v zápase
nenulové statistiky, říct to v dotazu naplno („Hráčka má v tomto zápase
zaznamenané akce, ty zůstanou ve statistikách.“). Případně nabídnout i smazání
jejích statistik k danému zápasu.

---

### #8 Změna sezóny nevyresetuje vybraný zápas v Live

`labels: bug, P2`

`onSeasonChange()` (`app.js:97`) přepočítá stav, ale `state.liveZapasId` nechá
být. `renderLiveSelect()` pak sáhne po `prev` a snaží se předvybrat zápas, který
do nové sezóny nepatří; když v novém seznamu není, spadne to na auto-výběr,
ale `state.liveZapasId` mezitím ukazuje na cizí zápas.

**Kroky k reprodukci:** otevřít Live, vybrat zápas, přepnout nahoře sezónu,
vrátit se do Live.

**Návrh řešení:** v `onSeasonChange()` vynulovat `state.liveZapasId`
(a flushnout `dirtyStats`, viz #3) dřív, než se překreslí Live.

---

### #9 Statistiky po setech

`labels: volleyball, feature, P2`

`vb_statistiky` má `UNIQUE(zapas_id, hrac_id)` — jeden řádek na hráčku a zápas.
Vývoj v rámci zápasu se z toho nedá vyčíst: kdy přestal padat servis, jestli
příjem povolil až ve čtvrtém setu, co udělalo střídání.

Přitom detailní skóre setů se už ukládá (`set1_my` … `set5_oni`), takže se
sety v datovém modelu jinak počítá.

**Návrh řešení:** přidat `set_cislo` do klíče
(`UNIQUE(zapas_id, hrac_id, set_cislo)`) a v Live tabu přepínač aktuálního setu.
Migrace existujících dat: stávající řádky jako `set_cislo = NULL` (= celý zápas),
nebo je přiřadit prvnímu setu. Ve Statistikách pak součet přes sety, s možností
rozpadu.

Je to největší zásah do schématu v backlogu — stojí za to rozhodnout dřív, než
naroste objem dat.

---

### #10 Blok nemá zápornou variantu

`labels: volleyball, P3`

`ACTIONS` (`app.js:8`) definuje blok jen s `varianty:['plus']`. Blok do autu,
dotyk sítě při bloku nebo přeloženy blok jsou přitom chyby, které dnes musí
zapisovatel schovat pod obecnou „Chybu“ — a ta se pak nedá rozpadnout na to,
čím vznikla.

Sloupce `blok_minus` a `blok_neutral` v databázi **už existují** (obojí
v schema.sql i v produkci), takže jde čistě o změnu v UI.

**Otázka na zadavatele:** blok byl na jen `+` zúžen záměrně v #6 (PR). Pokud to
byl záměr kvůli šířce tabulky na mobilu, dá se `−` přidat jen pro tablet.

---

## M3 · Statistiky a přehledy

### #11 Export statistik do CSV

`labels: feature, P2`

Tabulka ve Statistikách se dá číst jen v prohlížeči. Pro rozbor po zápase,
poslání do klubu nebo srovnání přes sezóny je potřeba dostat čísla ven.

**Návrh řešení:** tlačítko „Export CSV“ vedle filtrů, exportuje právě to, co je
podle aktuálních filtrů na obrazovce, včetně řádku `Σ Celkem`. Generovat
klientsky přes `Blob` — žádná serverová část není potřeba. Oddělovač `;`
a UTF-8 BOM, ať se to otevře v českém Excelu rovnou.

---

### #12 Jména hráček a soupeřů se vkládají do HTML bez escapování

`labels: bug, security, P2`

Veškeré renderování jede přes `innerHTML` s interpolovanými řetězci z databáze —
`${h.jmeno}`, `${z.soupet}`, `${t.nazev}`, `${s.nazev}` (mj. `app.js:157`,
`app.js:205`, `app.js:576`). Žádný z nich se neescapuje.

Prakticky: jméno s `&` nebo `<` rozbije zobrazení řádku. Ve spojení s #1
(kdokoli může do tabulky zapsat cokoli) je to i cesta, jak do aplikace dostat
cizí skript — proto `security`, ne jen kosmetika.

**Návrh řešení:** helper `esc(s)` (nahradit `& < > " '`) a protáhnout jím
všechna místa, kde do šablony jde text z databáze. Čísla a ID interpolovaná do
`onclick` jsou v pořádku, ty projdou přes `parseInt`.

---

### #13 Profil hráčky s vývojem v čase

`labels: feature, P3`

Filtr „hráčka“ ve Statistikách zúží tabulku na jeden řádek se součty za období.
Není vidět, jak se čísla vyvíjejí zápas po zápase — což je přesně to, na co se
trenér ptá při rozhovoru s hráčkou.

**Návrh řešení:** klik na jméno v tabulce otevře detail: hlavička se součty,
pod tím řádek na zápas a jednoduchý graf vývoje (útok %, příjem %, celkem).
Data jsou už všechna v `state.statistiky`, jde čistě o zobrazení.

---

### #14 Úspěšnost útoku vedle procenta výborných

`labels: volleyball, P3`

Sloupec `%` u útoku počítá `pct(plus, minus, neutral)` = podíl výborných ze všech
pokusů (`app.js:489`). To je jen půlka obrázku — hráčka s 30 % výborných
a 5 % chyb je něco úplně jiného než hráčka s 30 % výborných a 25 % chyb, a v
tabulce vypadají stejně.

**Návrh řešení:** přidat sloupec úspěšnosti `(plus − minus) / pokusy`, jak se
běžně vykazuje ve volejbalové statistice. Totéž dává smysl u příjmu.
Pozor na šířku tabulky na mobilu — možná to patří až do detailu hráčky (#13).

---

## M4 · Kvalita kódu a provoz

### #15 Odstranit mrtvé sloupce vykop_ a nahravka_

`labels: cleanup, db, P3`

Akce Výkop a Nahrávka byly z UI odstraněny (PR #6 a #7), jejich sloupce
v `vb_statistiky` ale zůstaly — šest sloupců, do kterých se od té doby nikdy
nic nezapsalo. Matou při čtení schématu i při psaní dotazů nad daty.

**Návrh řešení:** ověřit, že jsou všude nulové, pak `ALTER TABLE ... DROP COLUMN`
a srovnat schema.sql (souvisí s #2). Jde o destruktivní změnu — nejdřív záloha.

---

### #16 Sjednotit trojí kopii karty hráčky

`labels: refactor, P3`

Stejný kus HTML se staví na třech místech: `playerCardHtml()` (`app.js:202`),
`openHracPicker()` (`app.js:373`) a `renderTymManage()` (`app.js:618`). V každé
kopii je znovu opsané mapování pozice na CSS třídu:

```js
const posClass=`pos-${h.pozice==='nahrávač'?'nahravac':h.pozice==='libero'?'libero':...}`;
```

Při přidání pozice Blokař (PR #21) se to muselo opravit na všech třech místech.
Další pozice nebo změna vzhledu karty na to narazí znovu.

**Návrh řešení:** jedna funkce `playerCard(h, {action})` a mapa
`POZICE = {'nahrávač':'nahravac', ...}` místo řetězu ternárních operátorů.
Souvisí s #12 — escapování se pak dělá na jednom místě.

---

### #17 README se setupem projektu

`labels: infra, P3`

V repu je jen `index.html`, `app.js`, `style.css` a `schema.sql`, žádný popis.
Není nikde napsané, že aplikace potřebuje projekt v Supabase, že se schéma
zakládá ručně ze `schema.sql`, kde se mění klíče (`app.js:1-2`) ani jak se to
spouští lokálně.

**Návrh řešení:** stručný README — k čemu to je, jak založit Supabase projekt
a schéma, kde přepsat URL a klíč, jak spustit lokálně
(`python3 -m http.server`), jak je to nasazené. Plus poznámka o zabezpečení,
až se vyřeší #1.

---

### #18 Mazání hráček

`labels: feature, P3`

Hráčku lze přidat a upravit, ale ne smazat — jde ji jen odebrat ze sezóny.
Překlep v prvním zadávání soupisky tak v databázi zůstane napořád a plete se ve
výběru při správě týmů, kde se zobrazují všechny hráčky bez ohledu na sezónu.

**Návrh řešení:** mazání v modalu editace hráčky, s potvrzením. Pokud už má
zaznamenané statistiky, nabídnout místo smazání archivaci — sloupec
`vb_hraci.aktivni` už existuje a dnes se nikde nepoužívá.
