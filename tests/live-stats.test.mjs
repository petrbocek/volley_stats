// Testy zápisu statistik v Live tabu — issues #26 a #31.
//
// Supabase REST je odchycený přes page.route(), takže test nesahá na produkční
// data. Ověřuje se, co aplikace POSLALA, ne co je v databázi.
//
// Spuštění:
//   npm i playwright                      (jednorázově)
//   python3 -m http.server 8099 &         (v kořeni repa)
//   node tests/live-stats.test.mjs
//
// Proti kódu před opravou padá T1, T2, T3, T6b-d a T7.

import { chromium } from 'playwright';

const FIX = {
  vb_sezony: [{id:1,nazev:'2025/26',aktivni:true},{id:2,nazev:'2024/25',aktivni:false},{id:3,nazev:'2023/24 (bez zápasů)',aktivni:false}],
  vb_hraci: [{id:10,jmeno:'Alfa',cislo:1,pozice:'smečař',aktivni:true},
             {id:11,jmeno:'Beta',cislo:2,pozice:'blokař',aktivni:true}],
  vb_hraci_sezony: [{hrac_id:10,sezona_id:1},{hrac_id:11,sezona_id:1},{hrac_id:10,sezona_id:2}],
  vb_zapasy: [{id:100,sezona_id:1,datum:'2026-09-10',soupet:'Soupeř A',misto:'doma',stav:'probihajici'},
              {id:200,sezona_id:2,datum:'2025-03-01',soupet:'Soupeř B',misto:'venku',stav:'dokonceny',sety_my:3,sety_oni:1}],
  vb_statistiky: [], vb_tymy: [], vb_hraci_tymy: [], vb_souteze: [],
  vb_zapas_hraci: [{zapas_id:100,hrac_id:10},{zapas_id:100,hrac_id:11},{zapas_id:200,hrac_id:10}],
};

const writes = [];
let failNext = false;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await b.newPage();

await page.route('**/rest/v1/**', async route => {
  const req = route.request();
  const url = new URL(req.url());
  const table = url.pathname.split('/rest/v1/')[1].split('?')[0];
  if (req.method() === 'GET') {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIX[table] ?? []) });
  }
  const body = req.postDataJSON();
  writes.push({ table, method: req.method(), body });
  if (failNext && table === 'vb_statistiky') { failNext = false; return route.fulfill({ status: 500, body: 'boom' }); }
  const row = Array.isArray(body) ? body[0] : body;
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 999, ...row }]) });
});

const errors = [];
page.on('pageerror', e => errors.push(String(e)));

await page.goto(process.env.APP_URL || 'http://127.0.0.1:8099/index.html');
await page.waitForFunction(() => !document.getElementById('loading') || document.getElementById('loading').classList.contains('hidden'));

const ok = (n, c) => console.log(`${c ? '  OK  ' : ' FAIL '} ${n}`) || c;
let pass = true;

// ── T1: klik se uloží po debounce, a jen za tu jednu hráčku ─────────────────
await page.click('.nav-tab:nth-child(4)');
await page.waitForSelector('#cnt-10-servis_plus');
writes.length = 0;
await page.click('#cnt-10-servis_plus');
await page.waitForTimeout(600);
const t1 = writes.filter(w => w.table === 'vb_statistiky');
pass &= ok('T1 klik uloží právě jeden řádek', t1.length === 1);
pass &= ok('T1 uloží se správná hráčka a pole', t1[0]?.body.hrac_id === 10 && t1[0]?.body.servis_plus === 1);
pass &= ok('T1 hráčka bez kliku se neuloží (žádné nulové řádky)',
           !t1.some(w => w.body.hrac_id === 11));

// ── T2: #26 — flush při skrytí záložky, dřív než doběhne debounce ───────────
writes.length = 0;
await page.click('#cnt-10-utok_plus');
await page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForTimeout(150);   // kratší než STAT_FLUSH_MS=300
const t2 = writes.filter(w => w.table === 'vb_statistiky');
pass &= ok('T2 skrytí záložky uloží hned (#26)', t2.length === 1 && t2[0].body.utok_plus === 1);

// ── T3: #26 — pagehide ─────────────────────────────────────────────────────
writes.length = 0;
await page.click('#cnt-11-blok_plus');
await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
await page.waitForTimeout(150);
const t3 = writes.filter(w => w.table === 'vb_statistiky');
pass &= ok('T3 pagehide uloží hned (#26)', t3.length === 1 && t3[0].body.hrac_id === 11);

// ── T4: po uložení už se neposílá znovu ────────────────────────────────────
writes.length = 0;
await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
await page.waitForTimeout(150);
pass &= ok('T4 nic rozepsaného = žádný request', writes.length === 0);

// ── T5: neúspěšný zápis zůstane rozepsaný a uloží se příště ────────────────
failNext = true;
writes.length = 0;
await page.click('#cnt-10-prijem_plus');
await page.waitForTimeout(600);
const afterFail = writes.filter(w => w.table === 'vb_statistiky').length;
writes.length = 0;
await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
await page.waitForTimeout(200);
const retry = writes.filter(w => w.table === 'vb_statistiky');
pass &= ok('T5 selhaný zápis se zopakuje, ne že se ztratí',
           afterFail === 1 && retry.length === 1 && retry[0].body.prijem_plus === 1);

// ── T6: #31 — změna sezóny vyresetuje live zápas ───────────────────────────
const before = await page.evaluate(() => state.liveZapasId);
await page.selectOption('#season-select', '2');
await page.waitForTimeout(300);
const a = await page.evaluate(() => ({
  sezona: state.activeSeason?.id,
  zapasSezona: state.zapasy.find(z => z.id === state.liveZapasId)?.sezona_id,
}));
pass &= ok('T6a přepnutí na sezónu se zápasy vybere zápas z ní (#31)',
           before === 100 && a.sezona === 2 && a.zapasSezona === 2);

// vlastní jádro #31: sezóna BEZ zápasů — tady se renderLiveSelect sám neopraví
await page.selectOption('#season-select', '1');
await page.waitForTimeout(200);
await page.selectOption('#season-select', '3');
await page.waitForTimeout(300);
const b3 = await page.evaluate(() => ({
  live: state.liveZapasId,
  tabulka: document.querySelectorAll('#live-table-wrap .live-table').length,
  startVidno: document.getElementById('btn-start-zapas').style.display !== 'none',
  koncVidno: document.getElementById('btn-end-zapas').style.display !== 'none',
}));
pass &= ok('T6b sezóna bez zápasů nenechá viset cizí liveZapasId (#31)', b3.live === null);
pass &= ok('T6c sezóna bez zápasů nenechá na obrazovce starou tabulku (#31)', b3.tabulka === 0);
pass &= ok('T6d sezóna bez zápasů skryje Zahájit/Ukončit (#31)', !b3.startVidno && !b3.koncVidno);
await page.selectOption('#season-select', '2');
await page.waitForTimeout(200);

// ── T7: rozepsané kliky se uloží i při změně sezóny ────────────────────────
await page.selectOption('#season-select', '1');
await page.waitForTimeout(200);
await page.waitForSelector('#cnt-10-chyba_minus');
writes.length = 0;
await page.click('#cnt-10-chyba_minus');
await page.selectOption('#season-select', '2');
await page.waitForTimeout(200);
const t7 = writes.filter(w => w.table === 'vb_statistiky');
pass &= ok('T7 změna sezóny nejdřív uloží rozepsané', t7.length === 1 && t7[0].body.chyba_minus === 1);

pass &= ok('žádná chyba v konzoli', errors.length === 0);
if (errors.length) console.log(errors);

await b.close();
console.log(pass ? '\nVŠE PROŠLO' : '\nNĚCO SELHALO');
process.exit(pass ? 0 : 1);
