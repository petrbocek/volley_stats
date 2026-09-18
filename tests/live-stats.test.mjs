// Testy Live tabu — issues #24, #26, #27, #29 a #31.
//
// Supabase REST i Auth jsou odchycené přes page.route(), takže test nesahá na
// produkční data. Stub si drží vlastní stav statistik a na RPC vb_zapis_akce
// aplikuje deltu stejně jako databáze, aby šlo ověřit i souběh dvou zařízení.
//
// Spuštění:
//   npm i playwright                      (jednorázově)
//   python3 -m http.server 8099 &         (v kořeni repa)
//   node tests/live-stats.test.mjs

import { chromium } from 'playwright';

const FIX = {
  vb_sezony: [{ id: 1, nazev: '2025/26', aktivni: true },
              { id: 2, nazev: '2024/25', aktivni: false },
              { id: 3, nazev: '2023/24 (bez zápasů)', aktivni: false }],
  vb_hraci: [{ id: 10, jmeno: 'Alfa', cislo: 1, pozice: 'smečař', aktivni: true },
             { id: 11, jmeno: 'Beta', cislo: 2, pozice: 'blokař', aktivni: true }],
  vb_hraci_sezony: [{ hrac_id: 10, sezona_id: 1 }, { hrac_id: 11, sezona_id: 1 }, { hrac_id: 10, sezona_id: 2 }],
  vb_zapasy: [{ id: 100, sezona_id: 1, datum: '2026-09-10', soupet: 'Soupeř A', misto: 'doma', stav: 'probihajici' },
              { id: 200, sezona_id: 2, datum: '2025-03-01', soupet: 'Soupeř B', misto: 'venku', stav: 'dokonceny', sety_my: 3, sety_oni: 1 }],
  vb_tymy: [], vb_hraci_tymy: [], vb_souteze: [],
  vb_zapas_hraci: [{ zapas_id: 100, hrac_id: 10 }, { zapas_id: 100, hrac_id: 11 }, { zapas_id: 200, hrac_id: 10 }],
};

// stav "databáze" statistik, na který RPC aplikuje delty
const db = new Map();                       // "zapas_hrac" -> { pole: hodnota }
const radek = (z, h) => {
  const k = `${z}_${h}`;
  if (!db.has(k)) db.set(k, { zapas_id: z, hrac_id: h });
  return db.get(k);
};
const statRows = () => [...db.values()];

let rpcCalls = [];        // každé volání = pole změn
let otherWrites = [];     // zápisy mimo RPC (nemají nastat)
let failNextRpc = false;
let authCalls = 0;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await b.newPage();

await page.route('**/auth/v1/token**', async route => {
  authCalls++;
  const body = route.request().postDataJSON();
  if (body.password === 'spatne') {
    return route.fulfill({ status: 400, contentType: 'application/json',
      body: JSON.stringify({ error_description: 'Invalid login credentials' }) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    access_token: 'TESTTOKEN', refresh_token: 'TESTREFRESH', expires_in: 3600,
    user: { email: 'test@example.com' },
  }) });
});

const hlavicky = [];
await page.route('**/rest/v1/rpc/vb_zapis_akce', async route => {
  hlavicky.push(route.request().headers()['authorization']);
  if (failNextRpc) { failNextRpc = false; return route.fulfill({ status: 500, body: 'boom' }); }
  const zmeny = route.request().postDataJSON().p_zmeny;
  rpcCalls.push(zmeny);
  const out = zmeny.map(z => {
    const r = radek(z.zapas_id, z.hrac_id);
    r[z.pole] = Math.max(0, (r[z.pole] || 0) + z.delta);
    return { zapas_id: z.zapas_id, hrac_id: z.hrac_id, pole: z.pole, hodnota: r[z.pole] };
  });
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
});

await page.route('**/rest/v1/**', async route => {
  const req = route.request();
  if (req.url().includes('/rest/v1/rpc/')) return route.fallback();
  const table = new URL(req.url()).pathname.split('/rest/v1/')[1].split('?')[0];
  if (req.method() === 'GET') {
    const data = table === 'vb_statistiky' ? statRows() : (FIX[table] ?? []);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  }
  otherWrites.push({ table, method: req.method() });
  return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
});

const errors = [];
page.on('pageerror', e => errors.push(String(e)));

await page.goto(process.env.APP_URL || 'http://127.0.0.1:8099/index.html');
const nactenoOK = () => page.waitForFunction(() =>
  !document.getElementById('loading') || document.getElementById('loading').classList.contains('hidden'));
await nactenoOK();

const ok = (n, c) => (console.log(`${c ? '  OK  ' : ' FAIL '} ${n}`), !!c);
let pass = true;
const cnt = sel => page.textContent(sel).then(t => parseInt(t.trim()));
const longPress = async sel => { await page.hover(sel); await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up(); };

// ── #24: bez přihlášení se nic nezapíše ────────────────────────────────────
await page.click('.nav-tab:nth-child(4)');
await page.waitForSelector('#cnt-10-servis_plus');
rpcCalls = []; otherWrites = [];
await page.click('#cnt-10-servis_plus');
await page.waitForTimeout(600);
pass &= ok('T8a odhlášený klik neposílá zápis (#24)', rpcCalls.length === 0 && otherWrites.length === 0);
pass &= ok('T8b odhlášenému se počítadlo nezvedne (#24)', await cnt('#cnt-10-servis_plus') === 0);
pass &= ok('T8c odhlášený vidí lištu „jen pro čtení" (#24)', await page.isVisible('#readonly-bar'));

await page.click('#btn-auth');
await page.fill('#in-login-email', 'test@example.com');
await page.fill('#in-login-heslo', 'spatne');
await page.click('#btn-do-login');
await page.waitForTimeout(300);
pass &= ok('T9 špatné heslo nepřihlásí (#24)', await page.evaluate(() => !isLoggedIn()));

await page.fill('#in-login-heslo', 'spravne');
await page.click('#btn-do-login');
await page.waitForTimeout(300);
pass &= ok('T10a přihlášení schová lištu a přepne tlačítko (#24)',
  !(await page.isVisible('#readonly-bar')) && (await page.textContent('#btn-auth')).includes('test@example.com'));

// ── #27: posílá se delta, ne celý řádek ────────────────────────────────────
rpcCalls = []; otherWrites = []; hlavicky.length = 0;
await page.click('#cnt-10-servis_plus');
await page.waitForTimeout(600);
pass &= ok('T1a klik pošle jednu deltu +1 (#27)',
  rpcCalls.length === 1 && rpcCalls[0].length === 1 &&
  rpcCalls[0][0].hrac_id === 10 && rpcCalls[0][0].pole === 'servis_plus' && rpcCalls[0][0].delta === 1);
pass &= ok('T1b zápis nese access token (#24)', hlavicky.some(h => h === 'Bearer TESTTOKEN'));
pass &= ok('T1c nikdo nepíše přímo do vb_statistiky (#27)', otherWrites.length === 0);
pass &= ok('T1d hráčka bez kliku se neuloží (žádné nulové řádky)',
  !rpcCalls.flat().some(z => z.hrac_id === 11));

rpcCalls = [];
await page.click('#cnt-10-utok_plus');
await page.click('#cnt-10-utok_plus');
await page.waitForTimeout(600);
pass &= ok('T1e dva rychlé kliky se spojí do delty +2 (#27)',
  rpcCalls.length === 1 && rpcCalls[0][0].delta === 2 && await cnt('#cnt-10-utok_plus') === 2);

// ── #29: vzetí zpět ────────────────────────────────────────────────────────
rpcCalls = [];
await longPress('#cnt-10-utok_plus');
await page.waitForTimeout(600);
pass &= ok('T11a dlouhý stisk odečte (#29)',
  rpcCalls.length === 1 && rpcCalls[0][0].delta === -1 && await cnt('#cnt-10-utok_plus') === 1);

rpcCalls = [];
await page.click('#cnt-10-utok_plus', { button: 'right' });
await page.waitForTimeout(600);
pass &= ok('T11b pravé tlačítko odečte (#29)',
  rpcCalls.length === 1 && rpcCalls[0][0].delta === -1 && await cnt('#cnt-10-utok_plus') === 0);

rpcCalls = [];
await page.click('#cnt-10-utok_plus', { button: 'right' });
await page.waitForTimeout(600);
pass &= ok('T11c pod nulu to nejde a neposílá se nic (#29)',
  rpcCalls.length === 0 && await cnt('#cnt-10-utok_plus') === 0);

rpcCalls = [];
await page.click('#cnt-10-blok_plus');
await page.waitForTimeout(600);
pass &= ok('T11d běžné klepnutí po dlouhém stisku zase přičítá (#29)',
  rpcCalls.length === 1 && rpcCalls[0][0].delta === 1);

// ── #27: souběh dvou zařízení ──────────────────────────────────────────────
radek(100, 10).servis_plus = 7;                       // druhé zařízení mezitím zapsalo
rpcCalls = [];
await page.click('#cnt-10-servis_plus');
await page.waitForTimeout(600);
pass &= ok('T12a náš klik se přičte k cizímu zápisu, nepřebije ho (#27)',
  radek(100, 10).servis_plus === 8);
pass &= ok('T12b počítadlo se dorovná na serverovou hodnotu (#27)',
  await cnt('#cnt-10-servis_plus') === 8);

radek(100, 11).prijem_plus = 4;                       // cizí zápis u druhé hráčky
await page.evaluate(() => refreshLiveStats());
await page.waitForTimeout(300);
pass &= ok('T12c dorovnání ukáže cizí zápis i bez našeho kliku (#27)',
  await cnt('#cnt-11-prijem_plus') === 4);

// ── #26: flush při skrytí a zavření ────────────────────────────────────────
rpcCalls = [];
await page.click('#cnt-11-utok_plus');
await page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForTimeout(150);
pass &= ok('T2 skrytí záložky uloží hned (#26)', rpcCalls.length === 1);
await page.evaluate(() => Object.defineProperty(document, 'hidden', { value: false, configurable: true }));

rpcCalls = [];
await page.click('#cnt-11-blok_plus');
await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
await page.waitForTimeout(150);
pass &= ok('T3 pagehide uloží hned (#26)', rpcCalls.length === 1);

rpcCalls = [];
await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
await page.waitForTimeout(150);
pass &= ok('T4 nic rozepsaného = žádný request', rpcCalls.length === 0);

// ── selhaný zápis se neztratí ──────────────────────────────────────────────
failNextRpc = true;
rpcCalls = [];
await page.click('#cnt-10-prijem_plus');
await page.waitForTimeout(600);
const poSelhani = rpcCalls.length;
rpcCalls = [];
await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
await page.waitForTimeout(300);
pass &= ok('T5 selhaný zápis se zopakuje, ne že se ztratí',
  poSelhani === 0 && rpcCalls.length === 1 && rpcCalls[0][0].delta === 1);

// ── #31: změna sezóny ──────────────────────────────────────────────────────
const pred = await page.evaluate(() => state.liveZapasId);
await page.selectOption('#season-select', '2');
await page.waitForTimeout(300);
const a = await page.evaluate(() => ({
  sezona: state.activeSeason?.id,
  zapasSezona: state.zapasy.find(z => z.id === state.liveZapasId)?.sezona_id,
}));
pass &= ok('T6a přepnutí na sezónu se zápasy vybere zápas z ní (#31)',
  pred === 100 && a.sezona === 2 && a.zapasSezona === 2);

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

await page.selectOption('#season-select', '1');
await page.waitForTimeout(300);
await page.waitForSelector('#cnt-10-chyba_minus');
rpcCalls = [];
await page.click('#cnt-10-chyba_minus');
await page.selectOption('#season-select', '2');
await page.waitForTimeout(300);
pass &= ok('T7 změna sezóny nejdřív uloží rozepsané', rpcCalls.length === 1);

// ── přihlášení přežije reload ──────────────────────────────────────────────
await page.reload();
await nactenoOK();
pass &= ok('T10d přihlášení přežije reload stránky (#24)', await page.evaluate(() => isLoggedIn()));

pass &= ok('žádná chyba v konzoli', errors.length === 0);
if (errors.length) console.log(errors);

await b.close();
console.log(pass ? '\nVŠE PROŠLO' : '\nNĚCO SELHALO');
process.exit(pass ? 0 : 1);
