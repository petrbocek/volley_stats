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
    // dva dohrané s výsledkem: jeden vyhraný, jeden prohraný
    { id: 9, datum: '2026-09-27', cas: null, soupet: 'VK Trutnov', stav: STAV.DOKONCENY,
      vitezne_sety: 3, sezona_id: 1, set1_my: 25, set1_oni: 20, set2_my: 25, set2_oni: 18,
      set3_my: 20, set3_oni: 25, set4_my: 25, set4_oni: 22 },
    { id: 10, datum: '2026-08-15', cas: null, soupet: 'TJ Jih', stav: STAV.DOKONCENY,
      vitezne_sety: 3, sezona_id: 1, set1_my: 25, set1_oni: 21, set2_my: 18, set2_oni: 25,
      set3_my: 20, set3_oni: 25, set4_my: 23, set4_oni: 25 },
    // plánovaný: na zápase, který nezačal, není co koukat
    { id: 11, datum: '2026-11-01', cas: '18:00:00', soupet: 'Budoucí soupeř',
      stav: STAV.PLANOVANY, vitezne_sety: 3, sezona_id: 1 },
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
  // order= se respektuje: pořadí v seznamu je věc dotazu, ne náhody
  const order = url.searchParams.get('order');
  if (order) {
    const klice = order.split(',').map(x => {
      const [k, smer] = x.split('.'); return { k, desc: smer === 'desc' };
    });
    data.sort((a, b) => {
      for (const { k, desc } of klice) {
        const av = a[k] ?? '', bv = b[k] ?? '';
        if (av === bv) continue;
        return (av > bv ? 1 : -1) * (desc ? -1 : 1);
      }
      return 0;
    });
  }
  const limit = parseInt(url.searchParams.get('limit'));
  if (limit) data = data.slice(0, limit);
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
});

// ── seznam zápasů ─────────────────────────────────────────────────────────
await page.goto(`${ADRESA}/divak.html`);
await page.waitForSelector('.divak-polozka');

pass &= ok('D0a úvodní stránka je seznam, ne rovnou zápas',
  await page.$('.divak-seznam') !== null && await page.$('.divak-skore-cisla') === null);
pass &= ok('D0b rozehraný zápas je první', await page.evaluate(() => {
  const prvni = document.querySelector('.divak-polozka');
  return prvni.classList.contains('zive') && /VK Ostrava/.test(prvni.textContent);
}));
pass &= ok('D0c odehrané jdou od nejnovějšího', await page.evaluate(() => {
  const jmena = [...document.querySelectorAll('.divak-polozka:not(.zive) .divak-polozka-soupet')]
    .map(e => e.textContent.trim());
  return JSON.stringify(jmena) === JSON.stringify(['VK Trutnov', 'Starý zápas', 'TJ Jih']);
}));
pass &= ok('D0d plánovaný zápas se nenabízí',
  !/Budoucí soupeř/.test(await page.textContent('#divak')));
pass &= ok('D0e u rozehraného je stav právě běžícího setu', await (async () => {
  const t = (await page.textContent('.divak-polozka.zive')).replace(/\s+/g, ' ');
  return /2\. set 3:1/.test(t) && /0:0/.test(t);
})());
pass &= ok('D0f u odehraného jsou sety i výsledek', await page.evaluate(() => {
  const p = [...document.querySelectorAll('.divak-polozka')]
    .find(e => /VK Trutnov/.test(e.textContent));
  const t = p.textContent.replace(/\s+/g, ' ');
  return /3:1/.test(t) && /25:20/.test(t) &&
         p.querySelector('.divak-polozka-sety').classList.contains('vyhra');
}));
pass &= ok('D0g prohra se odliší od výhry', await page.evaluate(() => {
  const p = [...document.querySelectorAll('.divak-polozka')]
    .find(e => /TJ Jih/.test(e.textContent));
  return p.querySelector('.divak-polozka-sety').classList.contains('prohra');
}));
pass &= ok('D0g2 dohraný zápas bez výsledku se nevydává za 0:0', await page.evaluate(() => {
  const p = [...document.querySelectorAll('.divak-polozka')]
    .find(e => /Starý zápas/.test(e.textContent));
  return p.querySelector('.divak-polozka-sety').textContent.trim() === '\u2014';
}));
pass &= ok('D0h položka je odkaz na ten zápas', await page.evaluate(() =>
  document.querySelector('.divak-polozka').getAttribute('href') === '?zapas=7'));
pass &= ok('D0i seznam tahá jen zápasy a stav těch rozehraných',
  dotazy.every(q => q.tabulka === 'vb_zapasy' ||
    (['vb_statistiky', 'vb_chyby_souperu'].includes(q.tabulka) && /zapas_id=in\./.test(q.query))));

const dotazySeznamu = dotazy.slice();

// ── detail zápasu ─────────────────────────────────────────────────────────
dotazy = [];
await page.goto(`${ADRESA}/divak.html?zapas=7`);
await page.waitForSelector('.divak-skore-cisla');

pass &= ok('D1 odkaz otevře zápas i s hlavičkou', await (async () => {
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
pass &= ok('D15b ptá se na stavy, které appka opravdu zapisuje',
  STAV.PROBIHA === 'probihajici' && STAV.DOKONCENY === 'dokonceny' &&
  dotazySeznamu.some(q => q.tabulka === 'vb_zapasy' &&
    q.query.includes(`stav=in.(${STAV.PROBIHA},${STAV.DOKONCENY})`)));
pass &= ok('D16 nesahá na tabulky, které nejsou veřejné',
  !dotazy.some(q => ['vb_zapisovatele', 'vb_zaloha_smazane'].includes(q.tabulka)));
pass &= ok('D17 nikde není tlačítko, co by zapisovalo', await page.evaluate(() =>
  document.querySelectorAll('button, input, select, [onclick]').length === 0));
// Prolistování je odkazy, ne skriptem — ať se tím do stránky nepřinese ovládání.
pass &= ok('D17b odkazy vedou jen po téhle stránce', await page.evaluate(() =>
  [...document.querySelectorAll('a')].every(a => {
    const h = a.getAttribute('href') || '';
    return /^\?zapas=\d+(&set=\d+)?$/.test(h) || h === 'divak.html';
  })));

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

// ── odehrané zápasy se dají prolistovat ───────────────────────────────────
await page.goto(`${ADRESA}/divak.html?zapas=9`);
await page.waitForSelector('.divak-hlavicka');
pass &= ok('D21 dohraný zápas se otevře i s výsledkem', await (async () => {
  const t = await page.textContent('.divak-hlavicka');
  return /VK Trutnov/.test(t) && /Dokončený/.test(t) &&
    (await page.textContent('.divak-sety-cislo')).replace(/\s/g, '') === '3:1';
})());
pass &= ok('D21c zapsaný výsledek setu platí i bez statistik', await (async () => {
  // starší zápas nemá zapsané akce, ale výsledky setů ano — nesmí to hlásit 0:0
  return /4\. set/.test(await page.textContent('.divak-skore-popis')) &&
    (await page.textContent('.divak-skore-cisla')).replace(/\s/g, '') === '25:22' &&
    await page.$$eval('.skore-sety a', els => els.length) === 4;
})());
pass &= ok('D21b cesta zpátky na seznam je vidět',
  await page.getAttribute('.divak-zpet', 'href') === 'divak.html');

// set v adrese prolistuje zápas po setech
await page.goto(`${ADRESA}/divak.html?zapas=7&set=1`);
await page.waitForSelector('.divak-skore-cisla');
pass &= ok('D22 set z adresy se ukáže, ne ten poslední', await (async () => {
  return /1\. set/.test(await page.textContent('.divak-skore-popis')) &&
    (await page.textContent('.divak-skore-cisla')).replace(/\s/g, '') === '2:0';
})());
pass &= ok('D22b sety v detailu jsou odkazy na sebe', await page.evaluate(() =>
  [...document.querySelectorAll('.skore-sety a')].some(a =>
    a.getAttribute('href') === '?zapas=7&set=2')));
pass &= ok('D22c nesmyslný set v adrese spadne zpátky na rozehraný', await (async () => {
  await page.goto(`${ADRESA}/divak.html?zapas=7&set=9`);
  await page.waitForSelector('.divak-skore-cisla');
  return /2\. set/.test(await page.textContent('.divak-skore-popis'));
})());
pass &= ok('D23 smazaný zápas v adrese nerozbije stránku', await (async () => {
  await page.goto(`${ADRESA}/divak.html?zapas=999`);
  await page.waitForSelector('.divak-nehraje');
  const t = await page.textContent('#divak');
  return /Tenhle zápas tu není/.test(t) && await page.$('.divak-zpet') !== null;
})());
pass &= ok('D24 zápas bez zápisu nevypadá rozbitě', await (async () => {
  await page.goto(`${ADRESA}/divak.html?zapas=8`);
  await page.waitForSelector('.divak-hlavicka');
  const t = await page.textContent('#divak');
  return /nezapsala/.test(t) && /žádná výměna/.test(t);
})());

// po ukončení zápasu se seznam sám srovná, aniž by kdokoli sahal na adresu
FIX.vb_zapasy[0].stav = STAV.DOKONCENY;
await page.goto(`${ADRESA}/divak.html`);
await page.waitForSelector('.divak-polozka');
pass &= ok('D25 ukončený zápas přestane být v seznamu živý', await page.evaluate(() =>
  document.querySelector('.divak-polozka.zive') === null &&
  !/Právě se hraje/.test(document.getElementById('divak').textContent) &&
  /VK Ostrava/.test(document.getElementById('divak').textContent)));
FIX.vb_zapasy[0].stav = STAV.PROBIHA;

await b.close();
console.log(pass ? '\nVŠE PROŠLO' : '\nNĚCO SELHALO');
process.exit(pass ? 0 : 1);
