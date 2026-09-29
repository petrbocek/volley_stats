/* Testy divácké stránky (#102). Vlastní soubor, protože to je jiná stránka
   s jiným zdrojem dat — mřížka a Live V2 se testují v live-stats.test.mjs.

   Spuštění:
     python3 -m http.server 8099 &
     CHROMIUM_PATH=/opt/pw-browsers/chromium node tests/divak.test.mjs
*/
import { chromium } from 'playwright';

const ADRESA = process.env.ADRESA || 'http://localhost:8099';
let pass = true;
const ok = (n, c) => (console.log(`${c ? '  OK  ' : ' FAIL '} ${n}`), !!c);

// Stavy zápasu se berou z sdilene.js, ne z hlavy: fixture s vymyšlenou
// hodnotou („probiha" místo „probihajici") nechala projít stránku, která
// v provozu neukázala nic (#102).
const STAV = new Function(await (await fetch(`${ADRESA}/sdilene.js`)).text() +
  '; return STAV;')();

// ── data ──────────────────────────────────────────────────────────────────
const FIX = {
  vb_zapasy: [
    { id: 7, datum: '2026-10-04', cas: '10:00:00', soupet: 'VK Ostrava', stav: STAV.PROBIHA,
      vitezne_sety: 3, sezona_id: 1, set1_my: null, set1_oni: null },
    { id: 8, datum: '2026-09-20', cas: null, soupet: 'Starý zápas', stav: STAV.DOKONCENY,
      vitezne_sety: 3, sezona_id: 1 },
  ],
  vb_hraci: [
    { id: 1, jmeno: 'Alfa', cislo: 1, pozice: 'blokař', aktivni: true },
    { id: 2, jmeno: 'Beta', cislo: 2, pozice: 'blokař', aktivni: true },
    { id: 3, jmeno: 'Gama', cislo: 3, pozice: 'blokař', aktivni: true },
    { id: 4, jmeno: 'Delta', cislo: 4, pozice: 'blokař', aktivni: true },
    { id: 5, jmeno: 'Epsilon', cislo: 5, pozice: 'smečař', aktivni: true },
    { id: 6, jmeno: 'Libuše', cislo: 6, pozice: 'libero', aktivni: true },
    { id: 9, jmeno: 'Nehrající', cislo: 9, pozice: 'smečař', aktivni: true },
  ],
  vb_zapas_hraci: [
    { zapas_id: 7, hrac_id: 1, libero: false }, { zapas_id: 7, hrac_id: 2, libero: false },
    { zapas_id: 7, hrac_id: 3, libero: false }, { zapas_id: 7, hrac_id: 4, libero: false },
    { zapas_id: 7, hrac_id: 5, libero: false }, { zapas_id: 7, hrac_id: 6, libero: true },
  ],
  // 2. set: 3:1 z počítadel i z logu — fixture schválně drží obojí stejně,
  // ať se neměří rozchod, o kterém test nemluví
  vb_statistiky: [
    { id: 1, zapas_id: 7, hrac_id: 1, set_cislo: 1, utok_plus: 2, servis_plus: 0, blok_plus: 0,
      utok_minus: 0, prijem_minus: 0, servis_minus: 0, chyba_minus: 0, pole_neutral: 0 },
    { id: 2, zapas_id: 7, hrac_id: 1, set_cislo: 2, utok_plus: 1, servis_plus: 1, blok_plus: 0,
      utok_minus: 0, prijem_minus: 0, servis_minus: 0, chyba_minus: 0, pole_neutral: 3 },
    { id: 3, zapas_id: 7, hrac_id: 2, set_cislo: 2, utok_plus: 0, servis_plus: 0, blok_plus: 0,
      utok_minus: 0, prijem_minus: 0, servis_minus: 0, chyba_minus: 0, pole_neutral: 0 },
  ],
  vb_chyby_souperu: [{ zapas_id: 7, set_cislo: 2, pocet: 1, body: 1 }],
  vb_postaveni: [
    { zapas_id: 7, set_cislo: 2, zona: 1, hrac_id: 1 },
    { zapas_id: 7, set_cislo: 2, zona: 2, hrac_id: 2 },
    { zapas_id: 7, set_cislo: 2, zona: 3, hrac_id: 3 },
    { zapas_id: 7, set_cislo: 2, zona: 4, hrac_id: 4 },
    { zapas_id: 7, set_cislo: 2, zona: 5, hrac_id: 5 },
  ],
  vb_set_info: [{ zapas_id: 7, set_cislo: 2, oddechove_casy: 1, stridani: 0,
                  prvni_podani: 'oni', nahravacka_hrac_id: 3 }],
  // podává soupeř: side-out → eso z vlastního podání → ztráta → chyba soupeře
  vb_udalosti: [
    { id: 10, zapas_id: 7, set_cislo: 2, hrac_id: 1, pole: 'utok_plus', zona1_hrac_id: 5 },
    { id: 11, zapas_id: 7, set_cislo: 2, hrac_id: 1, pole: 'servis_plus', zona1_hrac_id: 1 },
    { id: 12, zapas_id: 7, set_cislo: 2, hrac_id: null, pole: 'souper_bod', zona1_hrac_id: 1 },
    { id: 13, zapas_id: 7, set_cislo: 2, hrac_id: null, pole: 'souper_chyba', zona1_hrac_id: 1 },
    { id: 14, zapas_id: 7, set_cislo: 2, hrac_id: 1, pole: 'pole_neutral', zona1_hrac_id: 1 },
  ],
  // řádek bez `strana` je schválně: co je v datech starší, je naše (#107)
  vb_oddechove_casy: [
    { id: 1, zapas_id: 7, set_cislo: 2, skore_my: 2, skore_oni: 0 },
    { id: 2, zapas_id: 7, set_cislo: 2, skore_my: 3, skore_oni: 1, strana: 'oni' },
  ],
  // Epsilon (5) šla z place, Nehrající (9) na něj — 9 schválně není v sestavě,
  // ať je vidět, že se jméno dotáhne i tak. U soupeře se vedou jen čísla.
  vb_stridani: [
    { id: 1, zapas_id: 7, set_cislo: 2, skore_my: 2, skore_oni: 1,
      hrac_ven: 5, hrac_dovnitr: 9 },
    { id: 2, zapas_id: 7, set_cislo: 2, skore_my: 1, skore_oni: 0, strana: 'oni',
      hrac_ven: null, hrac_dovnitr: null, cislo_ven: 4, cislo_dovnitr: 12 },
  ],
};

let dotazy = [];
let zapisy = [];
let vypadek = false;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const page = await b.newPage({ viewport: { width: 390, height: 844 } });

await page.route('**/rest/v1/**', async route => {
  const req = route.request();
  const url = new URL(req.url());
  const tabulka = url.pathname.split('/rest/v1/')[1].split('?')[0];
  if (req.method() !== 'GET') { zapisy.push({ tabulka, method: req.method() }); }
  dotazy.push({ tabulka, query: url.search });
  if (vypadek) return route.fulfill({ status: 500, body: 'mimo provoz' });

  let data = (FIX[tabulka] || []).slice();
  // jednoduchý filtr: id=eq.X, zapas_id=eq.X, stav=eq.X, id=in.(...)
  for (const [klic, hodnota] of url.searchParams) {
    if (['order', 'limit', 'select'].includes(klic)) continue;
    if (hodnota.startsWith('eq.')) {
      const v = hodnota.slice(3);
      data = data.filter(r => String(r[klic]) === v);
    } else if (hodnota.startsWith('in.')) {
      const seznam = hodnota.slice(4, -1).split(',');
      data = data.filter(r => seznam.includes(String(r[klic])));
    }
  }
  const limit = parseInt(url.searchParams.get('limit'));
  if (limit) data = data.slice(0, limit);
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
});

// ── rozehraný zápas ───────────────────────────────────────────────────────
await page.goto(`${ADRESA}/divak.html`);
await page.waitForSelector('.divak-skore-cisla');

pass &= ok('D1 stránka sama najde rozehraný zápas', await (async () => {
  const t = await page.textContent('.divak-hlavicka');
  return /VK Ostrava/.test(t) && /Probíhá/.test(t);
})());

pass &= ok('D2 stav rozehraného setu se skládá z akcí i soupeřovy strany',
  (await page.textContent('.divak-skore-cisla')).replace(/\s/g, '') === '3:1');
pass &= ok('D3 rozehraný set se pozná podle dat, nezůstane na prvním',
  /2\. set/.test(await page.textContent('.divak-skore-popis')));
pass &= ok('D4 vedle je i průběh po setech',
  /1\. 2:0/.test(await page.textContent('.divak-skore')) &&
  /2\. 3:1/.test(await page.textContent('.divak-skore')));

// ── postavení ─────────────────────────────────────────────────────────────
pass &= ok('D5 hřiště ukáže šestku po zónách', await page.evaluate(() =>
  document.querySelectorAll('.divak-plocha .hriste-zona:not(.prazdna):not(.libero)').length === 5));
pass &= ok('D6 posty plynou z nahrávačky, ne z profilu hráčky', await page.evaluate(() => {
  const zony = [...document.querySelectorAll('.divak-plocha .hriste .hriste-zona')];
  const post = c => zony.find(z => z.textContent.trim().startsWith(c))
    ?.querySelector('.hriste-post')?.textContent;
  // nahrávačka ve trojce → 3 N, 4 S, 5 B, 1 S, 2 B
  return post('3') === 'N' && post('4') === 'S' && post('5') === 'B' && post('1') === 'S';
}));
pass &= ok('D7 libero je stranou hřiště',
  /Libuše/.test(await page.textContent('.divak-libera')));
pass &= ok('D8 je vidět, kdo podává a kdo je na řadě', await (async () => {
  const t = await page.textContent('.divak-radek');
  return /Podává/.test(t) && /Alfa/.test(t) && /Beta/.test(t);
})());

// ── průběh ────────────────────────────────────────────────────────────────
pass &= ok('D9 průběh má proužek za každou bodovou výměnu',
  await page.$$eval('.prubeh-tik', els => els.length) === 4);
pass &= ok('D10 neutrální akce se do výměn nepočítá (pole)',
  await page.$$eval('.prubeh-radek:not(.prerus)', els => els.length) === 4);
pass &= ok('D11 v rozpisu je stav, akce i hráčka', await (async () => {
  // jen výměny: přerušení (time-out, střídání) mají vlastní řádky mezi nimi
  const radky = await page.$$eval('.prubeh-radek:not(.prerus)',
    els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  // nejnovější nahoře: 3:1 chyba soupeře, 2:1 bod soupeře, 2:0 eso Alfy
  return /3:1/.test(radky[0]) && /Chyba soupeře/.test(radky[0]) && /Soupeř/.test(radky[0]) &&
         /Servis/.test(radky[2]) && /Alfa/.test(radky[2]);
})());
pass &= ok('D12 zisk podání je označený',
  await page.$$eval('.prubeh-break:not(.prazdny)', els => els.length) === 3);
pass &= ok('D13 side-out se počítá z prvního podání',
  /Side-out 100%/.test(await page.textContent('#divak-prubeh')));

// ── čte se jen, nikdy nepíše ──────────────────────────────────────────────
// ── time-out a střídání v logu ────────────────────────────────────────────
pass &= ok('D13a time-out je v průběhu vidět i se stavem', await (async () => {
  const t = await page.textContent('#divak-prubeh');
  const radek = await page.$$eval('.prubeh-radek.prerus', els =>
    els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  return /Time-out/.test(t) && radek.some(r => /Time-out/.test(r) && /2:0/.test(r));
})());
pass &= ok('D13b střídání ukáže, kdo za koho', await (async () => {
  const radek = await page.$$eval('.prubeh-radek.prerus', els =>
    els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  return radek.some(r => /Střídání/.test(r) && /Nehrající/.test(r) && /za/.test(r) &&
                         /Epsilon/.test(r) && /2:1/.test(r));
})());
pass &= ok('D13c přerušení sedí mezi výměny podle stavu', await page.evaluate(() => {
  // pořadí odshora: 3:1, střídání 2:1, 2:1, time-out 2:0, 2:0, 1:0
  const radky = [...document.querySelectorAll('.prubeh-radek')]
    .map(e => ({ prerus: e.classList.contains('prerus'),
                 skore: e.querySelector('.prubeh-skore').textContent.replace(/\s/g, '') }));
  const i = radky.findIndex(r => r.prerus && r.skore === '2:1');
  const j = radky.findIndex(r => r.prerus && r.skore === '2:0');
  return i > 0 && radky[i - 1].skore === '3:1' && radky[i + 1].skore === '2:1' &&
         j > i && radky[j - 1].skore === '2:1' && radky[j + 1].skore === '2:0';
}));
pass &= ok('D13d přerušení se nepočítají mezi výměny',
  await page.$$eval('.prubeh-tik', els => els.length) === 4);

// ── strana sítě: naše přerušení vs. soupeřova (#107) ──────────────────────
pass &= ok('D13e soupeřova přerušení jsou od našich poznat', await page.evaluate(() => {
  const radky = [...document.querySelectorAll('.prubeh-radek.prerus')];
  const text = r => r.textContent.replace(/\s+/g, ' ').trim();
  const oni = radky.filter(r => r.classList.contains('oni')).map(text);
  const nase = radky.filter(r => !r.classList.contains('oni')).map(text);
  return oni.length === 2 && nase.length === 2 &&
         oni.some(t => /Time-out soupeře/.test(t) && /3:1/.test(t)) &&
         nase.some(t => /Time-out/.test(t) && !/soupeře/.test(t));
}));
pass &= ok('D13f u soupeře se ukážou čísla na dresech, ne jména', await page.evaluate(() => {
  const r = [...document.querySelectorAll('.prubeh-radek.prerus.oni')]
    .map(e => e.textContent.replace(/\s+/g, ' ').trim());
  return r.some(t => /Střídání soupeře/.test(t) && /#12 za #4/.test(t) && /1:0/.test(t));
}));

pass &= ok('D14 stránka nikam nezapisuje', zapisy.length === 0);
pass &= ok('D15 tahá jen tenhle zápas, ne celou databázi',
  dotazy.every(q => q.tabulka === 'vb_zapasy' || q.tabulka === 'vb_hraci' ||
    /zapas_id=eq\.7/.test(q.query)) &&
  !dotazy.some(q => ['vb_sezony', 'vb_tymy', 'vb_souteze', 'vb_hraci_tymy'].includes(q.tabulka)));
pass &= ok('D15b ptá se na stav, který appka opravdu zapisuje',
  STAV.PROBIHA === 'probihajici' &&
  dotazy.some(q => q.tabulka === 'vb_zapasy' &&
    q.query.includes(`stav=eq.${STAV.PROBIHA}`)));
pass &= ok('D16 nesahá na tabulky, které nejsou veřejné',
  !dotazy.some(q => ['vb_zapisovatele', 'vb_zaloha_smazane'].includes(q.tabulka)));
pass &= ok('D17 nikde není tlačítko, co by zapisovalo', await page.evaluate(() =>
  document.querySelectorAll('button, input, select, [onclick]').length === 0));

// ── živě ──────────────────────────────────────────────────────────────────
pass &= ok('D18 je vidět, jak čerstvá data jsou',
  /Aktualizováno před \d+ s/.test(await page.textContent('.divak-paticka')));

FIX.vb_udalosti.push({ id: 15, zapas_id: 7, set_cislo: 2, hrac_id: 2, pole: 'utok_plus', zona1_hrac_id: 1 });
FIX.vb_statistiky[2].utok_plus = 1;
await page.waitForFunction(() =>
  document.querySelector('.divak-skore-cisla').textContent.replace(/\s/g, '') === '4:1',
  null, { timeout: 15000 }).catch(() => {});
pass &= ok('D19 nový bod se sám objeví, bez obnovení stránky',
  (await page.textContent('.divak-skore-cisla')).replace(/\s/g, '') === '4:1' &&
  await page.$$eval('.prubeh-tik', els => els.length) === 5);

// výpadek se přizná, čísla nezmrznou potichu
vypadek = true;
await page.waitForFunction(() => /Spojení vázne/.test(
  document.querySelector('.divak-paticka')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
pass &= ok('D20 výpadek spojení se přizná', await (async () => {
  const t = await page.textContent('.divak-paticka');
  return /Spojení vázne/.test(t) &&
    (await page.textContent('.divak-skore-cisla')).replace(/\s/g, '') === '4:1';
})());
vypadek = false;

// ── jen rozehraný zápas, nic jiného ───────────────────────────────────────
// Po ukončení zápasu se stránka nemá čím chlubit — ať to řekne, místo aby
// ukazovala starý výsledek jako živý.
FIX.vb_zapasy[0].stav = STAV.DOKONCENY;
await page.waitForFunction(() => !!document.querySelector('.divak-nehraje'),
  null, { timeout: 15000 }).catch(() => {});
pass &= ok('D21 po ukončení zápasu stránka řekne, že se nehraje', await (async () => {
  const t = await page.textContent('#divak');
  return /Teď se nehraje/.test(t) && !/VK Ostrava/.test(t);
})());
pass &= ok('D22 dohraný zápas se nevydává za živý',
  await page.$('.divak-skore-cisla') === null);

// další zápas dne se chytne sám, bez sahání na adresu
FIX.vb_zapasy[1].stav = STAV.PROBIHA;
await page.waitForFunction(() => /Starý zápas/.test(document.body.textContent),
  null, { timeout: 15000 }).catch(() => {});
pass &= ok('D23 další rozehraný zápas se chytne sám',
  /Starý zápas/.test(await page.textContent('.divak-hlavicka')));
pass &= ok('D24 zápas bez zápisu nevypadá rozbitě', await (async () => {
  const t = await page.textContent('#divak');
  return /nezapsala/.test(t) && /žádná výměna/.test(t);
})());
FIX.vb_zapasy[0].stav = STAV.PROBIHA;
FIX.vb_zapasy[1].stav = STAV.DOKONCENY;

await b.close();
console.log(pass ? '\nVŠE PROŠLO' : '\nNĚCO SELHALO');
process.exit(pass ? 0 : 1);
