// Testy Live tabu — issues #24, #26, #27, #29 a #31.
//
// Supabase REST i Auth jsou odchycené přes page.route(), takže test nesahá na
// produkční data. Stub si drží vlastní stav statistik a na RPC vb_zapis_akce
// aplikuje deltu stejně jako databáze, aby šlo ověřit i souběh dvou zařízení.
//
// Spuštění viz README.md — stručně:
//   npm i playwright ; python3 -m http.server 8099 & ; node tests/live-stats.test.mjs

import { chromium } from 'playwright';

// #35 — text z databáze, který se nesmí vyhodnotit jako HTML
const JMENO_S_HTML = 'Gama & <b>tučně</b>';
const TYM_S_XSS = '<img src=x onerror="window.__xss_tym=1">';
const JMENO_SE_STREDNIKEM = 'Delta; \'Dé\' a "uvozovky"';   // #34 — musí přežít CSV
const SOUTEZ_S_XSS = 'Pohár <img src=y onerror="window.__xss_soutez=1">';

const FIX = {
  vb_sezony: [{ id: 1, nazev: '2025/26', aktivni: true },
              { id: 2, nazev: '2024/25', aktivni: false },
              { id: 3, nazev: '2023/24 (bez zápasů)', aktivni: false }],
  vb_hraci: [{ id: 10, jmeno: 'Alfa', cislo: 1, pozice: 'smečař', aktivni: true },
             { id: 11, jmeno: 'Beta', cislo: 2, pozice: 'blokař', aktivni: true },
             // #35 — jména, která by neescapovaný innerHTML rozbila
             { id: 12, jmeno: JMENO_S_HTML, cislo: 3, pozice: 'libero', aktivni: true },
             { id: 13, jmeno: JMENO_SE_STREDNIKEM, cislo: 4, pozice: 'smečař', aktivni: true },
             { id: 14, jmeno: 'Libuše', cislo: 5, pozice: 'libero', aktivni: true }],
  vb_hraci_sezony: [{ hrac_id: 10, sezona_id: 1 }, { hrac_id: 11, sezona_id: 1 },
                    { hrac_id: 12, sezona_id: 1 }, { hrac_id: 13, sezona_id: 1 },
                    { hrac_id: 14, sezona_id: 1 },
                    { hrac_id: 10, sezona_id: 2 }],
  vb_zapasy: [{ id: 100, sezona_id: 1, soutez_id: 7, datum: '2026-09-10', soupet: 'Soupeř A', misto: 'doma', stav: 'probihajici' },
              { id: 102, sezona_id: 1, datum: '2026-10-05', soupet: 'Soupeř D', misto: 'doma', stav: 'planovany' },
              { id: 200, sezona_id: 2, datum: '2025-03-01', soupet: 'Soupeř B', misto: 'venku', stav: 'dokonceny', sety_my: 3, sety_oni: 1 }],
  vb_tymy: [{ id: 5, nazev: TYM_S_XSS, sezona_id: 1 },
            { id: 6, nazev: 'Loňský tým', sezona_id: 2 }],
  vb_hraci_tymy: [{ hrac_id: 12, tym_id: 5 }, { hrac_id: 10, tym_id: 6 }],
  vb_souteze: [{ id: 7, sezona_id: 1, nazev: SOUTEZ_S_XSS }],
  vb_chyby_souperu: [{ zapas_id: 100, set_cislo: 1, pocet: 2, body: 0 }],
  vb_postaveni: [],
  vb_zapas_hraci: [{ zapas_id: 100, hrac_id: 10 }, { zapas_id: 100, hrac_id: 11 },
                   { zapas_id: 100, hrac_id: 12 }, { zapas_id: 100, hrac_id: 13 },
                   { zapas_id: 200, hrac_id: 10 }],
};

// stav "databáze" statistik, na který RPC aplikuje delty
const db = new Map();                       // "zapas_hrac_set" -> { pole: hodnota }
const radek = (z, h, set = 1) => {
  const k = `${z}_${h}_${set}`;
  if (!db.has(k)) db.set(k, { zapas_id: z, hrac_id: h, set_cislo: set });
  return db.get(k);
};
const statRows = () => [...db.values()];

const SERVER_MAX_ROWS = 1000;   // jako Supabase
let getPozadavky = [];
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
    const set = z.set_cislo ?? 1;
    const r = radek(z.zapas_id, z.hrac_id, set);
    r[z.pole] = Math.max(0, (r[z.pole] || 0) + z.delta);
    return { zapas_id: z.zapas_id, hrac_id: z.hrac_id, set_cislo: set, pole: z.pole, hodnota: r[z.pole] };
  });
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
});

let postaveniRpc = [];
await page.route('**/rest/v1/rpc/vb_uloz_postaveni', async route => {
  const { p_zapas, p_set, p_postaveni } = route.request().postDataJSON();
  postaveniRpc.push({ p_zapas, p_set, pocet: p_postaveni.length });
  return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ zapas_id: p_zapas, set_cislo: p_set, pocet: p_postaveni.length }) });
});

let chybyRpc = [];
await page.route('**/rest/v1/rpc/vb_zapis_souper', async route => {
  const { p_zapas, p_set, p_pole, p_delta } = route.request().postDataJSON();
  chybyRpc.push({ p_zapas, p_set, p_pole, p_delta });
  let r = FIX.vb_chyby_souperu.find(c => c.zapas_id === p_zapas && c.set_cislo === p_set);
  if (!r) { r = { zapas_id: p_zapas, set_cislo: p_set, pocet: 0, body: 0 }; FIX.vb_chyby_souperu.push(r); }
  r[p_pole] = Math.max(0, (r[p_pole] || 0) + p_delta);
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(r) });
});

await page.route('**/rest/v1/**', async route => {
  const req = route.request();
  if (req.url().includes('/rest/v1/rpc/')) return route.fallback();
  const table = new URL(req.url()).pathname.split('/rest/v1/')[1].split('?')[0];
  if (req.method() === 'GET') {
    const data = table === 'vb_statistiky' ? statRows() : (FIX[table] ?? []);
    getPozadavky.push({ table, range: req.headers()['range'] });
    // PostgREST vrací jen požadovaný rozsah a přebytek mlčky zahodí
    const m = /^(\d+)-(\d+)$/.exec(req.headers()['range'] || '');
    const od = m ? +m[1] : 0;
    const doIdx = m ? Math.min(+m[2] + 1, data.length) : Math.min(SERVER_MAX_ROWS, data.length);
    const cast = data.slice(od, m ? Math.min(doIdx, od + SERVER_MAX_ROWS) : doIdx);
    return route.fulfill({
      status: cast.length < data.length ? 206 : 200,
      contentType: 'application/json',
      headers: { 'content-range': `${od}-${od + cast.length - 1}/${data.length}` },
      body: JSON.stringify(cast),
    });
  }
  otherWrites.push({ table, method: req.method(), url: req.url(), body: req.postDataJSON?.() });
  if (req.method() === 'POST' && table === 'vb_tymy') {
    const t = { id: 99, ...req.postDataJSON() };
    FIX.vb_tymy.push(t);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([t]) });
  }
  if (req.method() === 'PATCH' && table === 'vb_hraci') {
    const m = /id=eq\.(\d+)/.exec(new URL(req.url()).search);
    const h = m && FIX.vb_hraci.find(x => x.id === +m[1]);
    if (h) Object.assign(h, req.postDataJSON());
  }
  if (req.method() === 'DELETE' && table === 'vb_hraci') {
    const m = /id=eq\.(\d+)/.exec(new URL(req.url()).search);
    if (m) FIX.vb_hraci = FIX.vb_hraci.filter(x => x.id !== +m[1]);
  }
  if (req.method() === 'DELETE') {
    const q = new URL(req.url()).search;
    const z = /zapas_id=eq\.(\d+)/.exec(q), h = /hrac_id=eq\.(\d+)/.exec(q);
    if (table === 'vb_statistiky' && z && h) {
      [...db.keys()].filter(k => k.startsWith(`${z[1]}_${h[1]}_`)).forEach(k => db.delete(k));
    }
  }
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
const JMENO = JMENO_S_HTML, TYM = TYM_S_XSS;
const klikSet = n => page.click(`#live-table-wrap .set-prepinac button:nth-of-type(${n})`);
const longPress = async sel => { await page.hover(sel); await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up(); };

// ── #24: bez přihlášení se nic nezapíše ────────────────────────────────────
await page.click('.nav-tab:nth-child(5)');
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

// ── #35: text z databáze se nesmí vyhodnotit jako HTML ─────────────────────
await page.selectOption('#season-select', '1');
await page.waitForTimeout(300);
for (const tab of [1, 2, 3, 5]) {          // Přehled, Zápasy, Tým, Statistiky
  await page.click(`.nav-tab:nth-child(${tab})`);
  await page.waitForTimeout(150);
}
await page.click('.nav-tab:nth-child(5)');
await page.waitForSelector('.live-player-name');
await page.waitForTimeout(200);

const xss = await page.evaluate(() => ({
  tym: typeof window.__xss_tym !== 'undefined',
  soutez: typeof window.__xss_soutez !== 'undefined',
  injektovaneImg: document.querySelectorAll('img[src="x"], img[src="y"]').length,
}));
pass &= ok('T13a podstrčené <img onerror> se nespustí (#35)', !xss.tym && !xss.soutez);
pass &= ok('T13b do stránky se nedostal žádný injektovaný <img> (#35)', xss.injektovaneImg === 0);

const jmena = await page.$$eval('.live-player-name', els => els.map(e => e.textContent));
const tucneVJmene = await page.$('.live-player-name b');
pass &= ok('T13c jméno s HTML se v Live vypíše doslova (#35)',
  jmena.includes(JMENO) && tucneVJmene === null);
await page.click('.nav-tab:nth-child(4)');                  // Týmy
await page.waitForTimeout(200);
const tymTitul = await page.textContent('.tym-card-title');
pass &= ok('T13d název týmu se v kartě vypíše doslova (#35)', tymTitul === TYM);
const clen = await page.textContent('.tym-member');
pass &= ok('T13e jméno člena týmu se vypíše doslova (#35)', clen === JMENO);

await page.click('.nav-tab:nth-child(7)');
await page.waitForTimeout(200);
const volby = await page.$$eval('#stats-hrac-sel option', els => els.map(e => e.textContent));
pass &= ok('T13f jméno ve filtru statistik se vypíše doslova (#35)', volby.includes(JMENO));

// ── #30: odebrání ze sestavy se ptá a nemlčí o statistikách ────────────────
await page.selectOption('#season-select', '1');
await page.waitForTimeout(200);
await page.click('.nav-tab:nth-child(5)');
await page.waitForSelector('#cnt-11-servis_plus');

// hráčka BEZ zaznamenaných akcí — prostý dotaz, bez nabídky mazat statistiky
db.delete('100_11_1');
await page.evaluate(() => {
  for (let set = 1; set <= SETU; set++) {
    delete dirtyStats[`100_11_${set}`];
    delete pendingDeltas[`100_11_${set}`];
  }
  state.statistiky = state.statistiky.filter(s => !(s.zapas_id === 100 && s.hrac_id === 11));
  renderLiveTable(100);
});
await page.waitForTimeout(150);
otherWrites = [];
await page.click('tr:has(#cnt-11-servis_plus) .live-card-remove');
await page.waitForTimeout(150);
pass &= ok('T16a odebrání se nejdřív zeptá, nemaže rovnou (#30)',
  await page.isVisible('#modal-odebrat') && otherWrites.length === 0);
pass &= ok('T16b bez akcí se nenabízí mazání statistik (#30)',
  !(await page.isVisible('#btn-odebrat-i-statistiky')));

await page.click('#modal-odebrat .btn-secondary');       // Zrušit
await page.waitForTimeout(150);
pass &= ok('T16c zrušení dialogu nic nesmaže (#30)',
  otherWrites.length === 0 && await page.isVisible('#cnt-11-servis_plus'));

// hráčka SE zaznamenanými akcemi — dialog to musí říct naplno
Object.assign(radek(100, 11), { servis_plus: 5, utok_plus: 2 });
await page.evaluate(() => { delete dirtyStats['100_11_1']; refreshLiveStats(); });
await page.waitForTimeout(300);
await page.click('tr:has(#cnt-11-servis_plus) .live-card-remove');
await page.waitForTimeout(150);
const text = await page.textContent('#odebrat-text');
pass &= ok('T16d dialog řekne kolik akcí hráčka má (#30)', /7 akcí/.test(text));
pass &= ok('T16e dialog upozorní, že akce zůstanou ve statistikách (#30)',
  /zůstanou ve Statistikách/.test(text));
pass &= ok('T16f s akcemi se nabídne i smazání statistik (#30)',
  await page.isVisible('#btn-odebrat-i-statistiky'));

// „jen odebrat" nechá statistiky být
otherWrites = [];
await page.click('#modal-odebrat .btn-primary');
await page.waitForTimeout(300);
pass &= ok('T16g „jen odebrat" smaže sestavu, ne statistiky (#30)',
  otherWrites.some(w => w.table === 'vb_zapas_hraci' && w.method === 'DELETE') &&
  !otherWrites.some(w => w.table === 'vb_statistiky') &&
  db.has('100_11_1'));

// a teď varianta i se statistikami
await page.evaluate(() => addDoSestava(100, 11));
await page.waitForTimeout(300);
await page.click('tr:has(#cnt-11-servis_plus) .live-card-remove');
await page.waitForTimeout(150);
otherWrites = [];
await page.click('#btn-odebrat-i-statistiky');
await page.waitForTimeout(300);
pass &= ok('T16h „i se statistikami" smaže obojí (#30)',
  otherWrites.some(w => w.table === 'vb_statistiky' && w.method === 'DELETE') &&
  otherWrites.some(w => w.table === 'vb_zapas_hraci' && w.method === 'DELETE') &&
  !db.has('100_11_1'));

// ── #39: karta hráčky vypadá stejně na všech třech místech ─────────────────
// Historicky se mapování pozice na CSS třídu opisovalo zvlášť v každé kopii,
// takže přidání Blokaře se muselo opravovat třikrát.
const kartaPozice = async (sel) => page.$$eval(sel, els => els.map(e => ({
  jmeno: e.querySelector('.player-name')?.textContent,
  pozice: e.querySelector('.player-pos')?.textContent,
  trida: e.querySelector('.player-pos')?.className,
  maCislo: !!e.querySelector('.player-num'),
})));

await page.click('.nav-tab:nth-child(3)');                  // Hráčky
await page.waitForSelector('#hraci-list .player-card');
const soupiska = await kartaPozice('#hraci-list .player-card');
const sBeta = soupiska.find(k => k.jmeno === 'Beta');
pass &= ok('T17a soupiska: blokař má svou barvu pozice (#39)',
  sBeta && sBeta.trida.includes('pos-blokar') && sBeta.pozice === 'blokař' && sBeta.maCislo);

await page.evaluate(() => openTymManage(5));                  // správa týmu
await page.waitForTimeout(150);
const sprava = await kartaPozice('#tym-manage-content .player-card');
const spBeta = sprava.find(k => k.jmeno === 'Beta');
pass &= ok('T17b správa týmu: stejná karta, stejná třída (#39)',
  spBeta && spBeta.trida === sBeta.trida && spBeta.pozice === sBeta.pozice);
await page.click('#modal-tym-manage .btn-secondary');

await page.click('.nav-tab:nth-child(5)');                    // Live → picker
await page.waitForTimeout(150);
await page.evaluate(() => openHracPicker(100));
await page.waitForTimeout(150);
const picker = await kartaPozice('#hrac-picker-list .player-card');
const pBeta = picker.find(k => k.jmeno === 'Beta');
pass &= ok('T17c výběr do sestavy: stejná karta, stejná třída (#39)',
  pBeta && pBeta.trida === sBeta.trida && pBeta.pozice === sBeta.pozice);

// každá pozice má vlastní třídu, žádná nepadá do výchozí
const vsechny = await page.evaluate(() =>
  ['smečař','blokař','nahrávač','libero','universál','nesmysl'].map(p => poziceTrida(p)));
pass &= ok('T17d každá pozice má vlastní třídu, neznámá spadne na smečaře (#39)',
  JSON.stringify(vsechny) === JSON.stringify(
    ['pos-smec','pos-blokar','pos-nahravac','pos-libero','pos-universal','pos-smec']));
await page.click('#modal-hrac-picker .btn-secondary');

// ── #34: export CSV ────────────────────────────────────────────────────────
// minimální CSV parser, ať se ověřuje význam a ne konkrétní tvar uvozovek
function parseCsv(text) {
  const radky = [];
  let pole = [], bunka = '', vUvoz = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (vUvoz) {
      if (c === '"' && text[i + 1] === '"') { bunka += '"'; i++; }
      else if (c === '"') vUvoz = false;
      else bunka += c;
    } else if (c === '"') vUvoz = true;
    else if (c === ';') { pole.push(bunka); bunka = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { pole.push(bunka); radky.push(pole); pole = []; bunka = ''; i++; }
    else bunka += c;
  }
  if (bunka !== '' || pole.length) { pole.push(bunka); radky.push(pole); }
  return radky;
}

Object.assign(radek(100, 13), { utok_plus: 6, utok_minus: 2, utok_neutral: 2, prijem_plus: 3, chyba_minus: 1 });
await page.selectOption('#season-select', '1');
await page.waitForTimeout(300);
await page.click('.nav-tab:nth-child(5)');               // Live drží zápas 100
await page.waitForTimeout(200);
await page.evaluate(() => refreshLiveStats());           // dotáhnout nová data
await page.waitForTimeout(300);
await page.click('.nav-tab:nth-child(7)');
await page.waitForTimeout(300);

pass &= ok('T14a tlačítko exportu je ve Statistikách (#34)', await page.isVisible('#btn-export-csv'));

const stazeni = page.waitForEvent('download');
await page.click('#btn-export-csv');
const soubor = await stazeni;
const syrove = await (await import('node:fs/promises')).readFile(await soubor.path(), 'utf8');

if (process.env.UKAZ_CSV) console.log('\n--- ukázka CSV ---\n' + syrove.replace(/^\uFEFF/, '') + '\n--- konec ---\n');
pass &= ok('T14b soubor začíná BOM, ať Excel zvládne diakritiku (#34)', syrove.charCodeAt(0) === 0xFEFF);
pass &= ok('T14c název souboru nese sezónu a datum (#34)',
  /^statistiky_.*_\d{4}-\d{2}-\d{2}\.csv$/.test(soubor.suggestedFilename()));

const csv = parseCsv(syrove.replace(/^﻿/, ''));
pass &= ok('T14d hlavička sedí a má 15 sloupců (#34)',
  csv[0].length === 15 && csv[0][0] === 'Poř.' && csv[0][1] === 'Hráčka' && csv[0][4] === 'Servis Es');

const csvDelta = csv.find(r => r[1] === JMENO_SE_STREDNIKEM);
pass &= ok('T14e jméno se středníkem a uvozovkami zůstane jedna buňka (#34)',
  !!csvDelta && csvDelta.length === 15);

const tab = await page.$$eval('.stats-table tbody tr', trs =>
  trs.map(tr => [...tr.children].map(td => td.textContent.trim())));
const tabDelta = tab.find(r => r[1].includes('Delta'));
pass &= ok('T14f čísla v CSV sedí na tabulku (#34)',
  csvDelta[4] === tabDelta[3] && csvDelta[9] === tabDelta[8] && csvDelta[14] === tabDelta[13]);
pass &= ok('T14g procenta jsou číslo bez %, ať se v Excelu počítá (#34)',
  csvDelta[11] === '60' && tabDelta[10] === '60%');

const csvSoucet = csv[csv.length - 1];
const tabSoucet = await page.$$eval('.stats-table tfoot td', tds => tds.map(td => td.textContent.trim()));
pass &= ok('T14h poslední řádek je součet a sedí na patičku tabulky (#34)',
  csvSoucet[1] === 'Σ Celkem' && csvSoucet[14] === tabSoucet[tabSoucet.length - 1]);

// ── #32: statistiky po setech ──────────────────────────────────────────────
await page.selectOption('#season-select', '1');
await page.waitForTimeout(200);
await page.click('.nav-tab:nth-child(5)');
await page.waitForSelector('#cnt-10-servis_plus');

pass &= ok('T20a Live má přepínač setů (#32)',
  (await page.$$eval('#live-table-wrap .set-btn', els => els.length)) === 5);
pass &= ok('T20b ve výchozím stavu je aktivní první set (#32)',
  (await page.textContent('#live-table-wrap .set-btn.aktivni')).trim() === '1');

// zápis do 1. setu
rpcCalls = [];
await page.click('#cnt-10-utok_plus');
await page.waitForTimeout(600);
pass &= ok('T20c zápis nese číslo setu (#32)', rpcCalls[0][0].set_cislo === 1);
const poPrvnim = await cnt('#cnt-10-utok_plus');

// přepnutí na 2. set
await klikSet(2);
await page.waitForTimeout(300);
pass &= ok('T20d přepnutí setu přepne aktivní tlačítko (#32)',
  (await page.textContent('.set-btn.aktivni')).trim() === '2');
pass &= ok('T20e druhý set začíná od nuly, nemíchá se s prvním (#32)',
  await cnt('#cnt-10-utok_plus') === 0);

rpcCalls = [];
await page.click('#cnt-10-utok_plus');
await page.click('#cnt-10-utok_plus');
await page.waitForTimeout(600);
pass &= ok('T20f zápis ve 2. setu jde do 2. setu (#32)',
  rpcCalls[0][0].set_cislo === 2 && rpcCalls[0][0].delta === 2);
pass &= ok('T20g sety jsou v databázi samostatné řádky (#32)',
  db.get('100_10_1').utok_plus === poPrvnim && db.get('100_10_2').utok_plus === 2);

// návrat do 1. setu ukáže původní čísla
await klikSet(1);
await page.waitForTimeout(300);
pass &= ok('T20h návrat do 1. setu ukáže jeho čísla (#32)',
  await cnt('#cnt-10-utok_plus') === poPrvnim);

// rozepsané se uloží do setu, ve kterém vznikly
rpcCalls = [];
await page.click('#cnt-10-blok_plus');
await klikSet(3);                                 // hned přepnout na 3. set
await page.waitForTimeout(400);
pass &= ok('T20i přepnutí setu nejdřív uloží rozepsané do starého setu (#32)',
  rpcCalls.length === 1 && rpcCalls[0][0].set_cislo === 1 && rpcCalls[0][0].pole === 'blok_plus');

// statistiky sčítají přes sety a počítají zápasy, ne řádky
await page.click('.nav-tab:nth-child(7)');
await page.waitForTimeout(300);
const radekAlfa = await page.$$eval('.stats-table tbody tr', trs => {
  const tr = trs.find(t => t.textContent.includes('Alfa'));
  return tr ? [...tr.children].map(td => td.textContent.trim()) : null;
});
pass &= ok('T20j součet přes sety v tabulce statistik (#32)',
  radekAlfa && Number(radekAlfa[8]) === poPrvnim + 2);
pass &= ok('T20k hráčka se třemi sety má pořád jeden zápas, ne tři (#32)',
  radekAlfa && radekAlfa[2] === '1');

// rozpad po setech
pass &= ok('T20l Statistiky mají filtr na set (#32)', await page.isVisible('#stats-set-sel'));
await page.selectOption('#stats-set-sel', '2');
await page.waitForTimeout(300);
const jenSet2 = await page.$$eval('.stats-table tbody tr', trs => {
  const tr = trs.find(t => t.textContent.includes('Alfa'));
  return tr ? [...tr.children].map(td => td.textContent.trim()) : null;
});
pass &= ok('T20m filtr na set ukáže jen ten set (#32)', jenSet2 && Number(jenSet2[8]) === 2);
await page.selectOption('#stats-set-sel', '');
await page.waitForTimeout(200);

// ── #56: souhrn týmu jako první řádek gridu ────────────────────────────────
// Měří se relativně (o kolik se číslo změnilo), ne proti čistému stavu —
// mazání stubu by shodilo fixtures, na kterých stojí pozdější testy.
await page.selectOption('#season-select', '1');
await page.waitForTimeout(200);
await page.click('.nav-tab:nth-child(5)');
await page.waitForSelector('.live-tym-row');

const tymCislo = pole => page.textContent(`#tym-${pole}`).then(t => Number(t.trim()));
const tymPopis = () => page.textContent('.live-tym-prepinac');

pass &= ok('T22a souhrn je první řádek tabulky, ne samostatný pruh (#56)',
  await page.evaluate(() => {
    const prvni = document.querySelector('.live-table tbody tr');
    return prvni?.classList.contains('live-tym-row');
  }));
pass &= ok('T22b čísla sedí pod sloupci akcí, stejný počet jako u hráčky (#56)',
  await page.evaluate(() => {
    const tym = document.querySelectorAll('.live-tym-row .live-tym-num').length;
    const hrac = document.querySelectorAll('.live-table tbody tr:nth-child(2) .live-act-btn').length;
    return tym === hrac && tym > 0;
  }));

const aktivniSet = await page.evaluate(() => state.liveSet);
pass &= ok('T22c ve výchozím stavu ukazuje zapisovaný set (#56)',
  (await tymPopis()).trim().startsWith(`${aktivniSet}. set`));

// součet za tým musí sedět na součet sloupce u hráček
const predUtok = await tymCislo('utok_plus');
await page.click('#cnt-10-utok_plus');
await page.waitForTimeout(100);
pass &= ok('T22d řádek naskočí hned po kliknutí, ne až po uložení (#56)',
  await tymCislo('utok_plus') === predUtok + 1);

pass &= ok('T22e součet týmu sedí na součet sloupce u hráček (#56)',
  await page.evaluate(() => {
    const tym = Number(document.getElementById('tym-utok_plus').textContent);
    let soucet = 0;
    document.querySelectorAll('.live-table tbody tr').forEach(tr => {
      if (tr.classList.contains('live-tym-row')) return;
      const el = tr.querySelector('.live-act-cnt[id$="-utok_plus"]');
      if (el) soucet += Number(el.textContent) || 0;
    });
    return tym === soucet;
  }));

// jiný set má vlastní čísla, přepnutí na zápas je sečte
const jinySet = aktivniSet === 5 ? 4 : aktivniSet + 1;
await klikSet(jinySet);
await page.waitForTimeout(300);
const vJinemSetu = await tymCislo('utok_plus');
pass &= ok('T22f řádek ukazuje čísla zvoleného setu, ne cizího (#56)',
  (await tymPopis()).trim().startsWith(`${jinySet}. set`) && vJinemSetu !== predUtok + 1);

await page.click('.live-tym-prepinac');
await page.waitForTimeout(300);
const ocekavano = await page.evaluate(() => {
  const lineup = state.zapasHraci.filter(z => z.zapas_id === 100).map(z => z.hrac_id);
  let n = 0;
  for (const h of lineup)
    for (let set = 1; set <= SETU; set++) n += getStatVal(100, h, 'utok_plus', set);
  return n;
});
pass &= ok('T22g přepnutí na zápas sečte všechny sety (#56)',
  (await tymPopis()).trim().startsWith('zápas') && await tymCislo('utok_plus') === ocekavano);
pass &= ok('T22h součet za zápas je víc než jeden set (#56)',
  await tymCislo('utok_plus') > vJinemSetu);

await page.click('.live-tym-prepinac');   // zpět na set, ať další testy vidí výchozí stav
await page.waitForTimeout(200);

// ── #36: profil hráčky ─────────────────────────────────────────────────────
// druhý zápas hráčce 13, ať je z čeho kreslit vývoj
FIX.vb_zapasy.push({ id: 101, sezona_id: 1, datum: '2026-09-17', soupet: 'Soupeř C', misto: 'venku', stav: 'dokonceny', sety_my: 3, sety_oni: 0 });
FIX.vb_zapas_hraci.push({ zapas_id: 101, hrac_id: 13 });
Object.assign(radek(101, 13), { utok_plus: 2, utok_minus: 6, utok_neutral: 2, prijem_plus: 1, prijem_minus: 3, servis_plus: 1 });
await page.reload();
await nactenoOK();
await page.click('.nav-tab:nth-child(7)');
await page.waitForTimeout(300);

await page.click(`.stats-table tbody tr:has-text("Delta") a`);
await page.waitForTimeout(300);
pass &= ok('T18a klik na jméno otevře profil (#36)', await page.isVisible('#modal-profil'));
pass &= ok('T18b hlavička nese jméno, číslo a pozici (#36)',
  /Delta.*#4.*smečař/s.test(await page.textContent('#profil-title')));

const grafy = await page.$$eval('#profil-obsah .graf', els => els.map(e => ({
  nadpis: e.querySelector('.graf-nadpis').textContent,
  cary: e.querySelectorAll('polyline').length,
  body: e.querySelectorAll('circle').length,
  barvy: [...e.querySelectorAll('polyline')].map(p => p.getAttribute('stroke')),
})));
pass &= ok('T18c tři samostatné grafy místo dvou os v jednom (#36)', grafy.length === 3);
pass &= ok('T18d každý graf má právě jednu sérii, identita nestojí na barvě (#36)',
  grafy.every(g => g.cary === 1 && g.barvy.length === 1) &&
  grafy.map(g => g.nadpis).join('|').includes('Útok'));
pass &= ok('T18e graf má bod za každý zápas (#36)', grafy.every(g => g.body === 2));

const popisky = await page.$$eval('#profil-obsah circle title', els => els.map(e => e.textContent));
pass &= ok('T18f body mají popisek se zápasem a hodnotou (#36)',
  popisky.some(t => /Soupeř C/.test(t) && /\d/.test(t)));

const radkyTab = await page.$$eval('.profil-tabulka tbody tr', trs =>
  trs.map(tr => [...tr.children].map(td => td.textContent.trim())));
pass &= ok('T18g tabulka má řádek na zápas, vzestupně podle data (#36)',
  radkyTab.length === 2 && radkyTab[0][0].includes('10.09') && radkyTab[1][0].includes('17.09'));
// buňka nese i úspěšnost (#37), procenta jsou první textový uzel
const procentaUtok = await page.$$eval('.profil-tabulka tbody tr',
  trs => trs.map(tr => tr.children[3].childNodes[0].textContent.trim()));
pass &= ok('T18h procenta v tabulce sedí na data (#36)',
  procentaUtok[0] === '60' && procentaUtok[1] === '20');

// ── #37: úspěšnost vedle procenta výborných ────────────────────────────────
// Zápas 100: útok 6 výb. / 2 chyby / 2 neutrál = 10 pokusů
//   % výborných 60, úspěšnost (6-2)/10 = +40
// Zápas 101: útok 2 / 6 / 2 = 10 pokusů
//   % výborných 20, úspěšnost (2-6)/10 = -40  ← stejné pokusy, opačný výkon
const vzorec = await page.evaluate(() => ({
  a: uspesnost(6, 2, 2), b: uspesnost(2, 6, 2),
  bezPokusu: uspesnost(0, 0, 0), same: uspesnost(3, 3, 4),
}));
pass &= ok('T19a úspěšnost = (výborné − chyby) / pokusy (#37)',
  vzorec.a === 40 && vzorec.b === -40 && vzorec.same === 0);
pass &= ok('T19b bez pokusu není nula, ale nic (#37)', vzorec.bezPokusu === null);

// modal je otevřený už z T18, znovu ho neotvíráme
const kostky = await page.$$eval('#profil-obsah .profil-kostka', els => els.map(e => ({
  lbl: e.querySelector('.profil-kostka-lbl').textContent,
  val: e.querySelector('.profil-kostka-val').textContent,
})));
pass &= ok('T19c souhrn ukazuje úspěšnost vedle % výborných (#37)',
  kostky.some(k => k.lbl === 'Útok % výb.') && kostky.some(k => k.lbl === 'Útok úsp.') &&
  kostky.some(k => k.lbl === 'Příjem úsp.'));

const uspTab = await page.$$eval('.profil-tabulka tbody tr', trs => trs.map(tr => ({
  utok: tr.children[3].childNodes[0].textContent.trim(),
  utokUsp: tr.children[3].querySelector('.profil-usp')?.textContent,
})));
pass &= ok('T19d dva zápasy se stejným % pokusů se už nepletou (#37)',
  uspTab[0].utok === '60' && uspTab[0].utokUsp === '+40' &&
  uspTab[1].utok === '20' && uspTab[1].utokUsp === '-40');
pass &= ok('T19e pod tabulkou je vysvětleno, co to druhé číslo je (#37)',
  /výborné − chyby/.test(await page.textContent('.profil-legenda')));

// profil respektuje filtr na zápas
await page.click('#modal-profil .btn-secondary');
await page.selectOption('#stats-zapas-sel', '101');
await page.waitForTimeout(300);
await page.click(`.stats-table tbody tr:has-text("Delta") a`);
await page.waitForTimeout(300);
const poFiltru = await page.$$eval('.profil-tabulka tbody tr', trs => trs.length);
pass &= ok('T18i profil kreslí jen zápasy podle aktivního filtru (#36)', poFiltru === 1);
await page.click('#modal-profil .btn-secondary');
await page.selectOption('#stats-zapas-sel', '');
await page.waitForTimeout(200);

// ── #41: mazání a archivace hráček ─────────────────────────────────────────
// hráčka bez jediné akce — tu jde smazat úplně
FIX.vb_hraci.push({ id: 20, jmeno: 'Překlep', cislo: 99, pozice: 'smečař', aktivni: true });
FIX.vb_hraci_sezony.push({ hrac_id: 20, sezona_id: 1 });
await page.reload();
await nactenoOK();
await page.click('.nav-tab:nth-child(3)');                  // Hráčky
await page.waitForSelector('#hraci-list .player-card');

await page.evaluate(() => editHrac(20));
await page.waitForTimeout(150);
pass &= ok('T21a hráčka bez akcí jde smazat (#41)',
  await page.isVisible('#btn-smazat-hrac') && !(await page.isVisible('#btn-archiv-hrac')));

page.once('dialog', d => d.accept());
otherWrites = [];
await page.click('#btn-smazat-hrac');
await page.waitForTimeout(400);
pass &= ok('T21b smazání se ptá a pak pošle DELETE (#41)',
  otherWrites.some(w => w.table === 'vb_hraci' && w.method === 'DELETE'));
pass &= ok('T21c smazaná hráčka zmizí ze soupisky (#41)',
  !(await page.textContent('#hraci-list')).includes('Překlep'));

// hráčka SE statistikami — mazání se nenabízí, protože by vzalo i její čísla
await page.evaluate(() => editHrac(10));
await page.waitForTimeout(150);
pass &= ok('T21d hráčka se statistikami jde jen archivovat (#41)',
  !(await page.isVisible('#btn-smazat-hrac')) && await page.isVisible('#btn-archiv-hrac'));
pass &= ok('T21e vysvětlí proč, ne jen zakáže (#41)',
  /smazalo by to i její statistiky/.test(await page.textContent('#hrac-nebezpecne-text')));

page.once('dialog', d => d.accept());
otherWrites = [];
await page.click('#btn-archiv-hrac');
await page.waitForTimeout(400);
const patch = otherWrites.find(w => w.table === 'vb_hraci' && w.method === 'PATCH');
pass &= ok('T21f archivace nastaví aktivni=false (#41)', !!patch);
pass &= ok('T21g archivovaná je v sekci Archiv, ne v soupisce (#41)',
  (await page.textContent('#hraci-list')).includes('Archiv'));

// archivovaná se nesmí nabízet do sestavy
await page.click('.nav-tab:nth-child(5)');
await page.waitForTimeout(200);
await page.evaluate(() => { state.zapasHraci = state.zapasHraci.filter(z => !(z.zapas_id === 100 && z.hrac_id === 10)); renderLiveTable(100); });
await page.evaluate(() => openHracPicker(100));
await page.waitForTimeout(200);
pass &= ok('T21h archivovaná se nenabízí do sestavy (#41)',
  !(await page.textContent('#hrac-picker-list')).includes('Alfa'));
await page.click('#modal-hrac-picker .btn-secondary');

// obnovení
await page.click('.nav-tab:nth-child(3)');                  // Hráčky
await page.waitForTimeout(200);
otherWrites = [];
await page.click('#hraci-list .btn-green');
await page.waitForTimeout(400);
pass &= ok('T21i obnovení vrátí hráčku zpět (#41)',
  otherWrites.some(w => w.table === 'vb_hraci' && w.method === 'PATCH') &&
  !(await page.textContent('#hraci-list')).includes('Archiv'));

// ── regrese: "+ Přidat hráčku" se nesmí useknout za rámečkem ───────────────
// Přepínač setu (#32) a řádek Tým (#56) přibyly do rámečku s pevnou výškou,
// zatímco tabulka měla height:100% — dohromady přerostly rámeček
// s overflow:hidden a spodní řádek zmizel. isVisible() to nechytí,
// protože useknutý prvek je pořád "viditelný"; musí se měřit geometrie.
const tlacitkoUseknuto = () => page.evaluate(() => {
  const wrap = document.getElementById('live-table-wrap');
  const btn = [...wrap.querySelectorAll('button')].find(b => b.textContent.includes('Přidat hráčku'));
  if (!btn) return 'tlačítko v DOM není';
  const w = wrap.getBoundingClientRect(), t = btn.getBoundingClientRect();
  return Math.round(t.bottom - w.bottom);
});

await page.setViewportSize({ width: 390, height: 844 });    // telefon
await page.click('.nav-tab:nth-child(5)');
await page.waitForSelector('.live-tym-row');
await page.waitForTimeout(200);
pass &= ok('T23a tlačítko „Přidat hráčku" se na telefonu nesekne (regrese)',
  (await tlacitkoUseknuto()) <= 0);

await page.setViewportSize({ width: 390, height: 600 });    // nízká obrazovka
await page.waitForTimeout(300);
pass &= ok('T23b ani na nízké obrazovce (regrese)', (await tlacitkoUseknuto()) <= 0);

await page.setViewportSize({ width: 1100, height: 800 });
await page.waitForTimeout(300);
pass &= ok('T23c ani na desktopu (regrese)', (await tlacitkoUseknuto()) <= 0);

// ── #62: tým platí jen ve své sezóně ───────────────────────────────────────
await page.selectOption('#season-select', '1');
await page.waitForTimeout(200);
await page.click('.nav-tab:nth-child(4)');                  // Týmy
await page.waitForTimeout(300);

const tymyVSeznamu = () => page.$$eval('#tymy-list .tym-card-title', els => els.map(e => e.textContent));
pass &= ok('T25a v sezóně vidím jen její týmy (#62)', await page.evaluate(() => {
  const nazvy = [...document.querySelectorAll('#tymy-list .tym-card-title')].map(e => e.textContent);
  return nazvy.length === 1 && !nazvy.includes('Loňský tým');
}));

await page.selectOption('#season-select', '2');
await page.waitForTimeout(300);
pass &= ok('T25b po přepnutí sezóny vidím tým té druhé (#62)',
  (await tymyVSeznamu()).includes('Loňský tým'));

// nový tým se zakládá do zvolené sezóny
otherWrites = [];
await page.click('#tab-tymy button:has-text("Nový tým")');
await page.fill('#in-tym-nazev', 'Nováček');
await page.click('#modal-tym .btn-primary');
await page.waitForTimeout(400);
const post = otherWrites.find(w => w.table === 'vb_tymy' && w.method === 'POST');
pass &= ok('T25c nový tým dostane sezónu, ve které vznikl (#62)',
  post && post.body.sezona_id === 2 && post.body.nazev === 'Nováček');

// výběr týmu u zápasu nabízí jen týmy sezóny
await page.click('.nav-tab:nth-child(2)');
await page.waitForTimeout(200);
await page.click('#tab-zapasy button:has-text("Nový zápas")');
await page.waitForTimeout(300);
const volbyTymu = await page.$$eval('#in-zapas-tym option', els => els.map(e => e.textContent));
pass &= ok('T25d výběr týmu u zápasu nabízí jen týmy té sezóny (#62)',
  volbyTymu.includes('Loňský tým') && !volbyTymu.some(v => v.includes('<img')));
await page.click('#modal-zapas .modal-footer .btn-secondary');

// správa týmu nabízí jen hráčky ze soupisky jeho sezóny
await page.selectOption('#season-select', '1');
await page.waitForTimeout(200);
await page.click('.nav-tab:nth-child(4)');                  // Týmy
await page.waitForTimeout(300);
await page.evaluate(() => openTymManage(5));
await page.waitForTimeout(300);
pass &= ok('T25e hlavička správy týmu nese sezónu (#62)',
  /2025\/26|2023|—/.test(await page.textContent('#tym-manage-title')) ||
  (await page.textContent('#tym-manage-title')).includes('·'));
pass &= ok('T25f správa nabízí jen hráčky ze soupisky té sezóny (#62)',
  await page.evaluate(() => {
    const vSoupisce = state.hraciSezony.filter(hs => hs.sezona_id === 1).map(hs => hs.hrac_id);
    const zive = state.hraci.filter(h => h.aktivni !== false && vSoupisce.includes(h.id));
    return document.querySelectorAll('#tym-manage-content .player-card').length === zive.length;
  }));
await page.click('#modal-tym-manage .btn-secondary');
// ── proklik z Přehledu do Live ─────────────────────────────────────────────
await page.setViewportSize({ width: 1100, height: 900 });
await page.selectOption('#season-select', '1');
await page.waitForTimeout(200);
await page.click('.nav-tab:nth-child(1)');                 // Přehled
await page.waitForSelector('#prehled-content .match-item');

const seznam = await page.$$eval('#prehled-content .match-item', els => els.map(e => ({
  text: e.textContent.replace(/\s+/g, ' ').trim(),
  klikaci: e.classList.contains('match-klik'),
})));
pass &= ok('T24a zápasy na Přehledu jsou proklikávací',
  seznam.length > 0 && seznam.every(z => z.klikaci));
pass &= ok('T24b seznam obsahuje i probíhající zápas, ne jen dokončené',
  seznam.some(z => /Probíhá/.test(z.text)));
pass &= ok('T24c a nejbližší plánovaný',
  seznam.some(z => /Soupeř D/.test(z.text)));

// proklik otevře Live s tím správným zápasem
const probihajici = await page.$('#prehled-content .match-item:has-text("Probíhá")');
await probihajici.click();
await page.waitForTimeout(400);
pass &= ok('T24d klik přepne na Live a vybere ten zápas',
  await page.evaluate(() => state.liveZapasId) === 100 &&
  await page.isVisible('#tab-live.active'));

// klávesnicí taky
await page.click('.nav-tab:nth-child(1)');
await page.waitForSelector('#prehled-content .match-item');
await page.evaluate(() => {
  const el = [...document.querySelectorAll('#prehled-content .match-item')]
    .find(e => e.textContent.includes('Soupeř D'));
  el.focus();
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
});
await page.waitForTimeout(400);
pass &= ok('T24e jde otevřít i klávesou Enter',
  await page.evaluate(() => state.liveZapasId) === 102);

// ── #64: mazání zápasu i s tím, co k němu patří ────────────────────────────
await page.click('.nav-tab:nth-child(2)');                 // Zápasy
await page.waitForSelector('#zapasy-list .match-item');

const kosU = st => page.evaluate(stav => {
  const z = state.zapasy.find(z => z.stav === stav && z.sezona_id === currentSeasonId());
  const el = [...document.querySelectorAll('#zapasy-list .match-item')]
    .find(e => e.innerHTML.includes(`deleteZapas(${z.id})`));
  return !!el;
}, st);
pass &= ok('T26a probíhající zápas jde smazat, ne jen ukončený (#64)', await kosU('probihajici'));
pass &= ok('T26b koš zůstal i u plánovaného (#64)', await kosU('planovany'));

// dialog u zápasu, ve kterém se něco zapsalo
const dialogPri = async (zapasId) => {
  let text = '';
  page.once('dialog', d => { text = d.message(); d.dismiss(); });
  await page.evaluate(id => deleteZapas(id), zapasId);
  await page.waitForTimeout(250);
  return text;
};
otherWrites = [];
const textPlny = await dialogPri(100);
pass &= ok('T26c dialog pojmenuje zápas, ne jen „opravdu?\" (#64)',
  /Soupeř A/.test(textPlny) && /10\.09\.2026|10\.9\.2026/.test(textPlny));
const ocekAkci = await page.evaluate(() => pocetAkciZapasu(100));
const ocekHracek = await page.evaluate(() => state.zapasHraci.filter(zh => zh.zapas_id === 100).length);
pass &= ok('T26d dialog řekne číslem, kolik akcí a hráček zmizí s ním (#64)',
  new RegExp(`${ocekAkci} (zapsan\\S+ )?akc`).test(textPlny) &&
  new RegExp(`${ocekHracek} hráč`).test(textPlny));
pass &= ok('T26e počty v dialogu sedí na data (#64)', await page.evaluate(() => {
  const rucne = state.statistiky.filter(s => s.zapas_id === 100).reduce((n, s) =>
    n + ACTIONS.reduce((m, a) => m + VARIANTS.reduce((k, v) => k + (s[`${a.key}_${v.suf}`] || 0), 0), 0), 0);
  return pocetAkciZapasu(100) === rucne && rucne > 0;
}));
pass &= ok('T26f dialog říká, že to nejde vzít zpět (#64)', /[Nn]ejde vzít zpět/.test(textPlny));
pass &= ok('T26g zamítnutý dialog nic nesmaže (#64)',
  !otherWrites.some(w => w.table === 'vb_zapasy' && w.method === 'DELETE') &&
  await page.evaluate(() => !!state.zapasy.find(z => z.id === 100)));

// zápas otevřený v Live na to upozorní zvlášť
await page.evaluate(() => { state.liveZapasId = 100; });
const textLive = await dialogPri(100);
pass &= ok('T26h u zápasu otevřeného v Live dialog upozorní (#64)', /Live/.test(textLive));

// prázdný zápas dialog nestraší čísly, která nejsou
const textPrazdny = await dialogPri(102);
pass &= ok('T26i u prázdného zápasu dialog řekne, že není co ztratit (#64)',
  /jedinou akci/.test(textPrazdny) && !/Smaže se i/.test(textPrazdny));

// a potvrzení ho opravdu smaže
otherWrites = [];
page.once('dialog', d => d.accept());
await page.evaluate(() => deleteZapas(102));
await page.waitForTimeout(400);
pass &= ok('T26j potvrzení pošle jediný DELETE na vb_zapasy (#64)',
  otherWrites.filter(w => w.method === 'DELETE').length === 1 &&
  otherWrites.some(w => w.table === 'vb_zapasy' && w.method === 'DELETE' &&
                        /id=eq\.102/.test(w.url)));
pass &= ok('T26k smazaný zápas zmizí ze seznamu i z výběru v Live (#64)',
  await page.evaluate(() => !state.zapasy.find(z => z.id === 102)) &&
  !(await page.$$eval('#live-zapas-select option', els => els.map(e => e.value))).includes('102'));
pass &= ok('T26l po smazání nezůstanou v paměti jeho řádky (#64)', await page.evaluate(() =>
  !state.statistiky.some(s => s.zapas_id === 102) &&
  !state.zapasHraci.some(zh => zh.zapas_id === 102) &&
  !Object.keys(pendingDeltas).some(k => k.startsWith('102_')) &&
  !Object.keys(dirtyStats).some(k => k.startsWith('102_'))));

// ── #66: zápas jde upravit, ne jen smazat a založit znovu ──────────────────
await page.click('.nav-tab:nth-child(2)');
await page.waitForSelector('#zapasy-list .match-item');
pass &= ok('T27a každý zápas má tlačítko na úpravu detailu (#66)', await page.evaluate(() => {
  const zapasy = state.zapasy.filter(z => z.sezona_id === currentSeasonId());
  return zapasy.length > 0 && zapasy.every(z =>
    document.querySelector('#zapasy-list').innerHTML.includes(`editZapas(${z.id})`));
}));

await page.evaluate(() => editZapas(100));
await page.waitForTimeout(250);
pass &= ok('T27b modal se otevře v režimu úpravy, ne zakládání (#66)',
  /Upravit/.test(await page.textContent('#zapas-modal-title')) &&
  /Uložit/.test(await page.textContent('#btn-save-zapas')));
pass &= ok('T27c pole jsou předvyplněná hodnotami zápasu (#66)', await page.evaluate(() => {
  const z = state.zapasy.find(z => z.id === 100);
  const v = id => document.getElementById(id).value;
  return v('in-zapas-id') === '100' && v('in-zapas-soupet') === z.soupet &&
         v('in-zapas-datum') === z.datum && v('in-zapas-misto') === z.misto &&
         v('in-zapas-soutez') === String(z.soutez_id);
}));

// změna soutěže se uloží PATCHem, ne novým zápasem
otherWrites = [];
await page.selectOption('#in-zapas-soutez', '');
await page.fill('#in-zapas-soupet', 'Soupeř A (opraveno)');
await page.click('#btn-save-zapas');
await page.waitForTimeout(400);
const patchZapas = otherWrites.find(w => w.table === 'vb_zapasy' && w.method === 'PATCH');
pass &= ok('T27d uložení pošle PATCH, ne nový zápas (#66)',
  !!patchZapas && /id=eq\.100/.test(patchZapas.url) &&
  !otherWrites.some(w => w.table === 'vb_zapasy' && w.method === 'POST'));
pass &= ok('T27e odebraná soutěž se opravdu odešle jako prázdná (#66)',
  patchZapas && patchZapas.body.soutez_id === null);
pass &= ok('T27f úprava nesahá na stav ani na skóre (#66)',
  patchZapas && !('stav' in patchZapas.body) && !('sety_my' in patchZapas.body) && !('sezona_id' in patchZapas.body));
pass &= ok('T27g změna je hned vidět v seznamu (#66)',
  await page.evaluate(() => state.zapasy.find(z => z.id === 100).soupet === 'Soupeř A (opraveno)') &&
  (await page.textContent('#zapasy-list')).includes('Soupeř A (opraveno)'));

// a založení nového zápasu režim úpravy nezdědí
await page.click('#tab-zapasy button:has-text("Nový zápas")');
await page.waitForTimeout(250);
pass &= ok('T27h „Nový zápas\" se neotevře s daty toho upravovaného (#66)', await page.evaluate(() => {
  const v = id => document.getElementById(id).value;
  return v('in-zapas-id') === '' && v('in-zapas-soupet') === '' &&
         v('in-zapas-soutez') === '' && v('in-zapas-tym') === '' &&
         document.getElementById('zapas-modal-title').textContent.includes('Nový');
}));
await page.click('#modal-zapas .modal-footer .btn-secondary');
await page.evaluate(() => { state.zapasy.find(z => z.id === 100).soupet = 'Soupeř A'; });

// ── #68: Přehled ukáže celý turnajový den, ne jen jeden plánovaný zápas ────
await page.evaluate(() => {
  state.zapasy = state.zapasy.filter(z => ![301, 302, 303].includes(z.id));
  state.zapasy.push(
    { id: 301, sezona_id: 1, datum: '2026-10-05', cas: '10:30:00', soupet: 'Turnaj ráno', misto: 'neutral', stav: 'planovany' },
    { id: 302, sezona_id: 1, datum: '2026-10-05', cas: '09:00:00', soupet: 'Turnaj dřív', misto: 'neutral', stav: 'planovany' },
    { id: 303, sezona_id: 1, datum: '2026-11-20', cas: '18:00:00', soupet: 'Až za měsíc', misto: 'doma', stav: 'planovany' });
  renderPrehled();
});
await page.waitForTimeout(250);
const prehled = () => page.$$eval('#prehled-content .match-item', els =>
  els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));

let radky = await prehled();
pass &= ok('T28a Přehled ukáže všechny plánované zápasy téhož dne (#68)',
  radky.some(t => /Turnaj ráno/.test(t)) && radky.some(t => /Turnaj dřív/.test(t)));
pass &= ok('T28b pozdější termín Přehled nezahltí (#68)',
  !radky.some(t => /Až za měsíc/.test(t)));
pass &= ok('T28c zápasy dne jdou po sobě podle času (#68)',
  radky.findIndex(t => /Turnaj dřív/.test(t)) < radky.findIndex(t => /Turnaj ráno/.test(t)));
pass &= ok('T28d probíhající zápas je pořád první (#68)', /Probíhá/.test(radky[0]));

// turnaj o mnoha zápasech se neodřízne stropem, jen ubere dokončené
await page.evaluate(() => {
  for (let i = 0; i < 8; i++) {
    state.zapasy.push({ id: 400 + i, sezona_id: 1, datum: '2026-10-05',
      cas: `1${i}:00:00`, soupet: `Turnajový ${i}`, misto: 'neutral', stav: 'planovany' });
  }
  renderPrehled();
});
await page.waitForTimeout(250);
radky = await prehled();
pass &= ok('T28e desetizápasový turnaj se vejde celý (#68)',
  [...Array(8).keys()].every(i => radky.some(t => new RegExp(`Turnajový ${i}\\b`).test(t))));
pass &= ok('T28f dokončené zápasy stropu ustoupí, ne naopak (#68)',
  !radky.some(t => /Dokončený/.test(t)));

await page.evaluate(() => {
  state.zapasy = state.zapasy.filter(z => z.id < 300);
  renderPrehled();
});
await page.waitForTimeout(200);
radky = await prehled();
pass &= ok('T28g bez turnaje zůstává Přehled krátký (#68)', radky.length <= 6);

// ── #72: tabulka statistik se dá řadit oběma směry ─────────────────────────
await page.click('.nav-tab:nth-child(7)');                 // Statistiky
await page.waitForSelector('.stats-table');
await page.evaluate(() => {
  ['stats-tym-sel', 'stats-soutez-sel', 'stats-zapas-sel', 'stats-hrac-sel', 'stats-set-sel']
    .forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
  renderStatistiky();
});
await page.waitForTimeout(250);

const sloupec = n => page.$$eval(`.stats-table tbody tr td:nth-child(${n})`,
  els => els.map(e => e.textContent.trim()));
const klikHlavicku = txt => page.evaluate(t => {
  const th = [...document.querySelectorAll('.stats-table th.sortable')]
    .find(e => e.textContent.trim().startsWith(t));
  th.click();
}, txt);
const cisla = a => a.map(v => parseInt(v)).filter(v => !Number.isNaN(v));
const klesa = a => a.every((v, i) => i === 0 || a[i - 1] >= v);
const roste = a => a.every((v, i) => i === 0 || a[i - 1] <= v);

pass &= ok('T29a výchozí pořadí je pořád nejlepší nahoře (#72)',
  klesa(cisla(await sloupec(14))) &&
  /▼/.test(await page.textContent('.stats-table th.sort-aktivni')));

await klikHlavicku('Celkem');
await page.waitForTimeout(200);
pass &= ok('T29b klik na aktivní sloupec otočí směr (#72)',
  roste(cisla(await sloupec(14))));
pass &= ok('T29c otočený směr pozná i šipka (#72)',
  /▲/.test(await page.textContent('.stats-table th.sort-aktivni')));

await klikHlavicku('Hráčka');
await page.waitForTimeout(200);
const jmenaRazeni = (await sloupec(2)).map(t => t.replace(/#\d+$/, '').trim());
pass &= ok('T29d jméno se řadí abecedně, a česky (#72)',
  jmenaRazeni.every((v, i) => i === 0 || jmenaRazeni[i - 1].localeCompare(v, 'cs') <= 0));
pass &= ok('T29e jen jeden sloupec je najednou aktivní (#72)',
  (await page.$$('.stats-table th.sort-aktivni')).length === 1);

// „—" u procent není nula, patří na konec v obou směrech. V datech žádná
// taková hráčka není, tak jednu na chvíli vyrobíme — jinak by test prošel
// naprázdno, protože pomlčku by nikde nenašel.
await page.evaluate(() => {
  state.statistiky.filter(s => s.hrac_id === 10).forEach(s => {
    s.prijem_plus = 0; s.prijem_minus = 0; s.prijem_neutral = 0;
  });
  renderStatistiky();
});
await page.waitForTimeout(200);
pass &= ok('T29f0 hráčka bez jediného pokusu má v procentech „—", ne 0 % (#72)',
  (await sloupec(8)).includes('—'));

await klikHlavicku('%');
await page.waitForTimeout(200);
const pctDesc = await sloupec(8);   // příjem %
await klikHlavicku('%');
await page.waitForTimeout(200);
const pctAsc = await sloupec(8);
const pomlckyNaKonci = a => {
  const i = a.findIndex(v => v === '—');
  return i === -1 || a.slice(i).every(v => v === '—');
};
pass &= ok('T29f procenta se řadí sestupně i vzestupně (#72)',
  klesa(cisla(pctDesc)) && roste(cisla(pctAsc)));
pass &= ok('T29g hráčky bez pokusu zůstávají dole v obou směrech (#72)',
  pomlckyNaKonci(pctDesc) && pomlckyNaKonci(pctAsc));
await page.evaluate(() => {
  state.statistiky.filter(s => s.hrac_id === 10).forEach(s => { s.prijem_plus = 1; });
  renderStatistiky();
});

// pořadové číslo je pořadí v tabulce, ne id — po přeřazení musí jít 1..n
pass &= ok('T29h sloupec # zůstává pořadím řádků (#72)',
  (await sloupec(1)).join(',') === (await sloupec(1)).map((_, i) => i + 1).join(','));

// CSV bere pořadí z tabulky, ne svoje vlastní
pass &= ok('T29i export stahuje tabulku v tom pořadí, jaké je vidět (#72)',
  await page.evaluate(() => {
    const d = spocitejStatistiky();
    const vTabulce = [...document.querySelectorAll('.stats-table tbody tr td:nth-child(2)')]
      .map(e => e.querySelector('strong').textContent);
    return d.rows.map(r => r.h.jmeno).join('|') === vTabulce.join('|');
  }));

// řazení přežije změnu filtru
await page.selectOption('#stats-set-sel', '1');
await page.waitForTimeout(250);
pass &= ok('T29j řazení se po změně filtru nezahodí (#72)',
  await page.evaluate(() => statsSort.sloupec === 'prijem_pct' && statsSort.smer === 'asc'));
await page.selectOption('#stats-set-sel', '');
await page.waitForTimeout(250);

// klávesnicí taky
await page.evaluate(() => {
  const th = [...document.querySelectorAll('.stats-table th.sortable')]
    .find(e => e.textContent.trim().startsWith('Záp.'));
  th.focus();
  th.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
});
await page.waitForTimeout(200);
pass &= ok('T29k seřadit jde i klávesou Enter (#72)',
  await page.evaluate(() => statsSort.sloupec === 'zapasy'));

// ── #75: Live řadí sestavu podle vložení, ne podle abecedy ─────────────────
await page.click('.nav-tab:nth-child(5)');                 // Live
await page.waitForSelector('.live-player-name');
const vLive = () => page.$$eval('.live-table .live-player-name', els => els.map(e => e.textContent));

// zápas 100 je z doby před #75 — nikdo u něj pořadí nezapsal
pass &= ok('T30a bez zapsaného pořadí drží Live pořadí soupisky (#75)',
  await page.evaluate(() => {
    const v = [...document.querySelectorAll('.live-table .live-player-name')].map(e => e.textContent);
    const vSestave = state.zapasHraci.filter(zh => zh.zapas_id === 100);
    // soupiska chodí ze serveru už seřazená (order=jmeno.asc), appka ji jen
    // nesmí přeházet — proto se měří proti state.hraci, ne proti localeCompare
    const podleSoupisky = state.hraci
      .filter(h => vSestave.some(zh => zh.hrac_id === h.id)).map(h => h.jmeno);
    return vSestave.every(zh => zh.poradi == null) && v.join('|') === podleSoupisky.join('|');
  }));

// přidání do sestavy pořadí zapíše
otherWrites = [];
const predPridanim = (await vLive()).length;
await page.evaluate(() => { state.zapasHraci = state.zapasHraci.filter(zh => !(zh.zapas_id === 100 && zh.hrac_id === 11)); renderLiveTable(100); });
await page.evaluate(() => addDoSestava(100, 11));
await page.waitForTimeout(400);
const zapisSestavy = otherWrites.find(w => w.table === 'vb_zapas_hraci' && w.method === 'POST');
pass &= ok('T30b přidání do sestavy pošle i pořadí (#75)',
  zapisSestavy && typeof zapisSestavy.body.poradi === 'number' && zapisSestavy.body.poradi > 0);
pass &= ok('T30c hráčka přidaná do staršího zápasu jde dospod, ne mezi ně (#75)',
  (await vLive()).at(-1) === 'Beta' && (await vLive()).length === predPridanim);

// zápas se zapsaným pořadím se řadí podle něj
await page.evaluate(() => {
  const opak = { 10: 4, 11: 3, 12: 2, 13: 1 };
  state.zapasHraci.filter(zh => zh.zapas_id === 100).forEach(zh => { zh.poradi = opak[zh.hrac_id]; });
  renderLiveTable(100);
});
await page.waitForTimeout(200);
pass &= ok('T30d se zapsaným pořadím se řadí podle něj, ne abecedně (#75)',
  await page.evaluate(() => {
    const v = [...document.querySelectorAll('.live-table .live-player-name')].map(e => e.textContent);
    const podlePoradi = state.zapasHraci.filter(zh => zh.zapas_id === 100)
      .sort((a, b) => a.poradi - b.poradi)
      .map(zh => state.hraci.find(h => h.id === zh.hrac_id).jmeno);
    return v.join('|') === podlePoradi.join('|') &&
           v.join('|') !== [...v].sort((a, b) => a.localeCompare(b, 'cs')).join('|');
  }));

// smíšený případ: kdo pořadí nemá, drží se nahoře a mezi sebou abecedně
await page.evaluate(() => {
  state.zapasHraci.filter(zh => zh.zapas_id === 100 && (zh.hrac_id === 12 || zh.hrac_id === 13))
    .forEach(zh => { zh.poradi = null; });
  renderLiveTable(100);
});
await page.waitForTimeout(200);
pass &= ok('T30e hráčky bez pořadí zůstávají nahoře a v pořadí soupisky (#75)',
  await page.evaluate(() => {
    const v = [...document.querySelectorAll('.live-table .live-player-name')].map(e => e.textContent);
    const bezPoradi = state.zapasHraci.filter(zh => zh.zapas_id === 100 && zh.poradi == null);
    const bez = state.hraci
      .filter(h => bezPoradi.some(zh => zh.hrac_id === h.id)).map(h => h.jmeno);
    return bez.length > 0 && v.slice(0, bez.length).join('|') === bez.join('|');
  }));

// díra po odebrané hráčce nesmí srazit pořadí té další
pass &= ok('T30f po odebrání hráčky nedostane další přidaná kolidující pořadí (#75)',
  await page.evaluate(() => {
    state.zapasHraci = state.zapasHraci.filter(zh => zh.zapas_id !== 900);
    state.zapasHraci.push({ zapas_id: 900, hrac_id: 10, poradi: 1 },
                          { zapas_id: 900, hrac_id: 11, poradi: 2 },
                          { zapas_id: 900, hrac_id: 12, poradi: 3 });
    state.zapasHraci = state.zapasHraci.filter(zh => !(zh.zapas_id === 900 && zh.hrac_id === 11));
    const dalsi = dalsiPoradi(900);
    const obsazena = state.zapasHraci.filter(zh => zh.zapas_id === 900).map(zh => zh.poradi);
    return !obsazena.includes(dalsi) && dalsi > Math.max(...obsazena);
  }));

await page.evaluate(() => {
  state.zapasHraci = state.zapasHraci.filter(zh => zh.zapas_id !== 900);
  state.zapasHraci.filter(zh => zh.zapas_id === 100).forEach(zh => { zh.poradi = null; });
  renderLiveTable(100);
});

// ── #76: lišta „vzít zpět" ─────────────────────────────────────────────────
await page.waitForSelector('#btn-undo');
const undoText = () => page.textContent('#live-table-wrap .undo-text');
const undoVypnuto = () => page.evaluate(() => document.getElementById('btn-undo').disabled);
// předchozí sada nechala zapisovaný set jinde — blok se ukotví na první,
// ať se tvrzení o setech nedrží na tom, co po sobě nechal někdo jiný
await klikSet(1);
await page.waitForTimeout(300);
await page.evaluate(() => { undoStack.length = 0; prekresliUndo(); });

pass &= ok('T31a bez zápisu lišta říká, že není co vracet (#76)',
  (await undoVypnuto()) && /[Nn]ení co vracet/.test(await undoText()));

const predZapisem = await cnt('#cnt-11-servis_plus');
await page.click('#cnt-11-servis_plus');
await page.waitForTimeout(250);
pass &= ok('T31b po zápisu lišta pojmenuje hráčku i akci (#76)',
  !(await undoVypnuto()) && /Beta/.test(await undoText()) && /Servis/.test(await undoText()));

// jedno klepnutí, žádné držení
await page.click('#btn-undo');
await page.waitForTimeout(250);
pass &= ok('T31c klepnutí na lištu vezme zápis zpět (#76)',
  await cnt('#cnt-11-servis_plus') === predZapisem);
pass &= ok('T31d po vyčerpání je lišta zase prázdná (#76)', await undoVypnuto());

// zásobník, ne jen poslední akce
await page.click('#cnt-11-servis_plus');
await page.waitForTimeout(150);
await page.click('#cnt-11-servis_plus');
await page.waitForTimeout(150);
await page.click('#btn-undo');
await page.waitForTimeout(150);
pass &= ok('T31e vrací se i druhý zápis zpátky, ne jen poslední (#76)',
  await cnt('#cnt-11-servis_plus') === predZapisem + 1 && !(await undoVypnuto()));
await page.click('#btn-undo');
await page.waitForTimeout(200);
pass &= ok('T31f po vrácení všeho lišta zhasne (#76)',
  await cnt('#cnt-11-servis_plus') === predZapisem && (await undoVypnuto()));

// ruční odečet je sám o sobě „zpět" — lišta nesmí nabízet vrátit ho podruhé
await page.click('#cnt-11-servis_plus');
await page.waitForTimeout(150);
await longPress('.live-act-cnt#cnt-11-servis_plus');
await page.waitForTimeout(250);
pass &= ok('T31g po ručním odečtu nezůstane v liště, co už je vráceno (#76)',
  await cnt('#cnt-11-servis_plus') === predZapisem && (await undoVypnuto()));

// „zpět" musí trefit set, ve kterém akce vznikla
await page.click('#cnt-11-servis_plus');
await page.waitForTimeout(150);
await klikSet(2);
await page.waitForTimeout(300);
pass &= ok('T31h po přepnutí setu lišta připomene, kterého setu se zpět týká (#76)',
  /1\. set/.test(await undoText()));
const vSetu2 = await cnt('#cnt-11-servis_plus');
await page.click('#btn-undo');
await page.waitForTimeout(400);
pass &= ok('T31i zpět odečte v setu, kde akce vznikla, ne v tom zobrazeném (#76)',
  await page.evaluate(() => getStatVal(100, 11, 'servis_plus', 1)) === predZapisem &&
  await cnt('#cnt-11-servis_plus') === vSetu2);
await klikSet(1);
await page.waitForTimeout(300);

// lišta nesmí ukousnout „+ Přidat hráčku" jako u #59
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const undoGeometrie = () => page.evaluate(() => {
  const wrap = document.getElementById('live-table-wrap');
  const scroll = wrap.querySelector('.live-table-scroll');
  const bar = wrap.querySelector('.undo-bar');
  const btn = [...scroll.querySelectorAll('button')].find(b => b.textContent.includes('Přidat hráčku'));
  const b = bar.getBoundingClientRect(), w = wrap.getBoundingClientRect();
  return {
    // proti scrollovací části, ne proti obalu — pod ní je teď lišta
    useknuto: btn ? Math.round(btn.getBoundingClientRect().bottom - scroll.getBoundingClientRect().bottom) : 'není',
    listaMimo: Math.round(b.bottom - w.bottom),
    vyskaTlacitka: Math.round(document.getElementById('btn-undo').getBoundingClientRect().height),
  };
});
let g = await undoGeometrie();
pass &= ok('T31j lišta neukousne „Přidat hráčku" na telefonu (#76)', g.useknuto <= 0);
pass &= ok('T31k lišta se vejde do obalu Live (#76)', g.listaMimo <= 0);
pass &= ok('T31l tlačítko zpět má aspoň 44px, jak se na palec sluší (#76)', g.vyskaTlacitka >= 44);

await page.setViewportSize({ width: 390, height: 600 });
await page.waitForTimeout(300);
g = await undoGeometrie();
pass &= ok('T31m ani na nízké obrazovce (#76)', g.useknuto <= 0 && g.listaMimo <= 0);
await page.setViewportSize({ width: 1100, height: 900 });
await page.waitForTimeout(300);

// ── #76 část 2: záložka Live V2 ────────────────────────────────────────────
await page.click('.nav-tab:nth-child(6)');                 // Live V2
await page.waitForSelector('#live2-wrap .v2-hrac');

const v2Jmena = () => page.$$eval('#live2-wrap .v2-jmeno', els => els.map(e => e.textContent));
const gridJmena = () => page.$$eval('#live-table-wrap .live-player-name', els => els.map(e => e.textContent));

pass &= ok('T32a V2 ukazuje stejnou sestavu a ve stejném pořadí jako mřížka (#76)',
  (await v2Jmena()).join('|') === (await gridJmena()).join('|'));
pass &= ok('T32b obě záložky drží týž zápas (#76)', await page.evaluate(() =>
  document.getElementById('live-zapas-select').value ===
  document.getElementById('live2-zapas-select').value));

// hráčka je cíl přes celou šířku, ne 24px sloupec — to je celý smysl V2
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const rozmery = await page.evaluate(() => {
  const h = document.querySelector('#live2-wrap .v2-hrac').getBoundingClientRect();
  return { sirka: Math.round(h.width), vyska: Math.round(h.height) };
});
pass &= ok('T32c řádek hráčky je přes celou šířku a aspoň 44px vysoký (#76)',
  rozmery.sirka >= 300 && rozmery.vyska >= 44);

// dvě klepnutí: hráčka → dlaždice
await page.click('#live2-wrap .v2-hrac');
await page.waitForSelector('#modal-v2-akce:not(.hidden)');
pass &= ok('T32d panel akcí pojmenuje hráčku i zapisovaný set (#76)',
  /Beta/.test(await page.textContent('#v2-akce-title')) &&
  /set/.test(await page.textContent('#v2-akce-title')));
const dlazdice = await page.evaluate(() => {
  const d = document.querySelector('#modal-v2-akce .v2-dlazdice').getBoundingClientRect();
  return { pocet: document.querySelectorAll('#modal-v2-akce .v2-dlazdice').length,
           sirka: Math.round(d.width), vyska: Math.round(d.height) };
});
pass &= ok('T32e dlaždice pokrývají všechny akce mřížky (#76)', dlazdice.pocet === 11);
pass &= ok('T32f dlaždice je násobně větší cíl než buňka v mřížce (#76)',
  dlazdice.sirka >= 44 && dlazdice.vyska >= 44);
// na nízké obrazovce se panel musí dát doscrollovat, ne uříznout
await page.setViewportSize({ width: 390, height: 600 });
await page.waitForTimeout(300);
pass &= ok('T32f2 panel akcí je na nízké obrazovce celý dosažitelný (#76)',
  await page.evaluate(() => {
    const m = document.querySelector('#modal-v2-akce .modal');
    const posledni = [...document.querySelectorAll('#modal-v2-akce .v2-dlazdice')].at(-1);
    const r = m.getBoundingClientRect();
    // buď se vejde, nebo modal scrolluje — uříznout se nesmí
    return r.bottom <= document.documentElement.clientHeight + 1 &&
           (m.scrollHeight <= m.clientHeight ||
            posledni.offsetTop + posledni.offsetHeight <= m.scrollHeight);
  }));
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);

// zápis z V2 jde stejnou cestou a je vidět i ve staré mřížce
rpcCalls = [];
const predV2 = await page.evaluate(() => getStatVal(100, 11, 'utok_plus', state.liveSet));
await page.click('#modal-v2-akce .v2-dlazdice[onclick*="utok_plus"]');
await page.waitForTimeout(600);
pass &= ok('T32g klepnutí na dlaždici zapíše a panel zavře (#76)',
  await page.isHidden('#modal-v2-akce') &&
  await page.evaluate(() => getStatVal(100, 11, 'utok_plus', state.liveSet)) === predV2 + 1);
pass &= ok('T32h zápis jde stejným RPC jako ze staré mřížky (#76)',
  rpcCalls.length === 1 && rpcCalls[0].some(z => z.pole === 'utok_plus' && z.delta === 1));
pass &= ok('T32i zápis z V2 je hned vidět i ve staré mřížce (#76)',
  await cnt('#cnt-11-utok_plus') === predV2 + 1);

// a obráceně
await page.click('.nav-tab:nth-child(5)');
await page.waitForTimeout(200);
await page.click('#cnt-11-utok_plus');
await page.waitForTimeout(400);
await page.click('.nav-tab:nth-child(6)');
await page.waitForTimeout(300);
pass &= ok('T32j zápis ze staré mřížky je hned vidět ve V2 (#76)',
  await page.evaluate(() => {
    const el = document.getElementById('v2plus-11');
    const ocekavano = V2_VYBORNE.reduce((n, f) => n + getStatVal(100, 11, f, state.liveSet), 0);
    return el.textContent === '+' + ocekavano;
  }));

// lišta zpět funguje i tady a je to jiný prvek než ta v mřížce
pass &= ok('T32k V2 má vlastní lištu zpět, ne duplicitní id (#76)',
  await page.evaluate(() => !!document.getElementById('btn-undo-v2') &&
    document.querySelectorAll('#btn-undo').length === 1));
const predZpet = await page.evaluate(() => getStatVal(100, 11, 'utok_plus', state.liveSet));
await page.click('#btn-undo-v2');
await page.waitForTimeout(400);
pass &= ok('T32l zpět ve V2 opravdu odečte (#76)',
  await page.evaluate(() => getStatVal(100, 11, 'utok_plus', state.liveSet)) === predZpet - 1);

// přepínač setů a týmový souhrn má V2 taky
pass &= ok('T32m V2 má vlastní přepínač setů (#76)',
  (await page.$$eval('#live2-wrap .set-btn', els => els.length)) === 5);
await page.click('#live2-wrap .set-prepinac button:nth-of-type(3)');
await page.waitForTimeout(300);
pass &= ok('T32n přepnutí setu ve V2 přepne i starou mřížku (#76)',
  await page.evaluate(() => state.liveSet) === 3 &&
  (await page.textContent('#live-table-wrap .set-btn.aktivni')).trim() === '3');
await page.click('#live2-wrap .set-prepinac button:nth-of-type(1)');
await page.waitForTimeout(300);
pass &= ok('T32o V2 ukazuje týmový souhrn (#76)',
  (await page.$$eval('#live2-wrap .v2-chip', els => els.length)) === 5);
// tři holá čísla vedle sebe neřeknou, které je které — barva to sama neunese
pass &= ok('T32o2 každé číslo v souhrnu si nese svůj symbol, ne jen barvu (#76)',
  await page.evaluate(() => {
    const cisla = [...document.querySelectorAll('#live2-wrap .v2-chip-num')];
    return cisla.length === 11 && cisla.every(el => {
      const sym = el.querySelector('.v2-chip-sym');
      return sym && ['+', '/', '−'].includes(sym.textContent.trim());
    });
  }));

// geometrie: nic se nesmí useknout, jako u #59
const v2Geometrie = () => page.evaluate(() => {
  const wrap = document.getElementById('live2-wrap');
  const seznam = wrap.querySelector('.v2-seznam');
  const bar = wrap.querySelector('.undo-bar');
  const pridat = wrap.querySelector('.v2-pridat');
  seznam.scrollTop = seznam.scrollHeight;
  return {
    // po sjetí dolů musí být „Přidat hráčku" vidět celé — jinak je useknuté
    pridatUseknuto: Math.round(pridat.getBoundingClientRect().bottom - seznam.getBoundingClientRect().bottom),
    listaMimo: Math.round(bar.getBoundingClientRect().bottom - wrap.getBoundingClientRect().bottom),
    chybyMimo: Math.round(wrap.querySelector('.v2-souper').getBoundingClientRect().bottom - wrap.getBoundingClientRect().bottom),
    prescahuje: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
  };
});
let vg = await v2Geometrie();
pass &= ok('T32p „Přidat hráčku" se ve V2 nesekne o lištu (#76)', vg.pridatUseknuto <= 0);
pass &= ok('T32q lišta se vejde do obalu V2 (#76)', vg.listaMimo <= 0);
pass &= ok('T32r V2 nepřetéká stránku do šířky (#76)', vg.prescahuje === 0);

await page.setViewportSize({ width: 390, height: 600 });
await page.waitForTimeout(300);
vg = await v2Geometrie();
pass &= ok('T32s ani na nízké obrazovce (#76)',
  vg.pridatUseknuto <= 0 && vg.listaMimo <= 0 && vg.chybyMimo <= 0);

// navigace se šesti položkami se musí na telefon vejít
const navMiry = () => page.evaluate(() => {
  const nav = document.querySelector('.nav-tabs');
  const tab = document.querySelector('.nav-tab').getBoundingClientRect();
  return { pocet: document.querySelectorAll('.nav-tab').length,
           prescah: Math.round(nav.scrollWidth - nav.clientWidth),
           strankaPrescah: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
           sirkaZalozky: Math.round(tab.width) };
});
let nm = await navMiry();
pass &= ok('T32t záložky se na 390px vejdou bez přetečení (#76, #70)',
  nm.pocet === 7 && nm.prescah <= 0 && nm.strankaPrescah <= 0);

// 360px je běžná šířka telefonu a sedmá záložka je přesně to, co ji přetáhne
await page.setViewportSize({ width: 360, height: 780 });
await page.waitForTimeout(300);
nm = await navMiry();
pass &= ok('T32u a vejdou se i na užší 360px telefon (#70)',
  nm.prescah <= 0 && nm.strankaPrescah <= 0);
pass &= ok('T32v záložka přitom zůstane rozumně velký cíl (#70)', nm.sirkaZalozky >= 40);

// ── #70: Hráčky a Týmy jsou dvě záložky ────────────────────────────────────
await page.setViewportSize({ width: 1100, height: 900 });
await page.waitForTimeout(300);
await page.selectOption('#season-select', '1');
await page.waitForTimeout(300);

await page.click('.nav-tab:nth-child(3)');                  // Hráčky
await page.waitForSelector('#hraci-list .player-card');
pass &= ok('T34a Hráčky ukazují soupisku, ne týmy (#70)',
  await page.isVisible('#hraci-list') && !(await page.isVisible('#tymy-list')));
pass &= ok('T34b hlavička nabízí jen přidání hráčky (#70)', await page.evaluate(() => {
  const t = document.getElementById('tab-hracky').textContent;
  return t.includes('Přidat hráčku') && !t.includes('Nový tým');
}));

await page.click('.nav-tab:nth-child(4)');                  // Týmy
await page.waitForSelector('#tymy-list');
pass &= ok('T34c Týmy ukazují týmy, ne soupisku (#70)',
  await page.isVisible('#tymy-list') && !(await page.isVisible('#hraci-list')));
pass &= ok('T34d hlavička nabízí jen nový tým (#70)', await page.evaluate(() => {
  const t = document.getElementById('tab-tymy').textContent;
  return t.includes('Nový tým') && !t.includes('Přidat hráčku');
}));
pass &= ok('T34e záložka Týmy připomene, že tým patří do sezóny (#70)',
  /sezón/i.test(await page.textContent('#tymy-season-note')));

// obě se musí překreslit i když je zrovna vidět ta druhá
await page.click('.nav-tab:nth-child(3)');
await page.waitForTimeout(200);
const predZalozenim = await page.evaluate(() => state.tymy.length);
await page.evaluate(() => { state.tymy.push({ id: 777, nazev: 'Přidaný jinde', sezona_id: 1 }); renderTym(); renderTymy(); });
await page.waitForTimeout(200);
await page.click('.nav-tab:nth-child(4)');
await page.waitForTimeout(200);
pass &= ok('T34f změna týmů se projeví, i když jsem byl zrovna na Hráčkách (#70)',
  (await page.textContent('#tymy-list')).includes('Přidaný jinde'));
await page.evaluate(() => { state.tymy = state.tymy.filter(t => t.id !== 777); renderTymy(); });
pass &= ok('T34g úklid fixture proběhl (#70)',
  await page.evaluate(() => state.tymy.length) === predZalozenim);

// stará jednotná záložka už neexistuje
pass &= ok('T34h po rozdělení nezůstala stará společná záložka (#70)',
  await page.evaluate(() => !document.getElementById('tab-tym')));

// přepnutí sezóny musí srovnat obě
await page.selectOption('#season-select', '2');
await page.waitForTimeout(300);
pass &= ok('T34i přepnutí sezóny překreslí týmy i soupisku (#70)',
  await page.evaluate(() => {
    const vidim = [...document.querySelectorAll('#tymy-list .tym-card-title')].map(e => e.textContent);
    const ocekavam = tymySezony(2).map(t => t.nazev);
    return vidim.length === ocekavam.length && vidim.every(v => ocekavam.includes(v));
  }));
await page.selectOption('#season-select', '1');
await page.waitForTimeout(300);

// ── #71 část 1: profil hráčky ──────────────────────────────────────────────
await page.click('.nav-tab:nth-child(3)');                  // Hráčky
await page.waitForSelector('#hraci-list .player-card');

pass &= ok('T35a z karty v soupisce vede proklik do profilu (#71)',
  await page.evaluate(() => {
    const karta = document.querySelector('#hraci-list .player-card');
    return karta.innerHTML.includes('otevriProfil(');
  }));

// ze soupisky = celá sezóna, bez ohledu na filtr ve Statistikách
await page.click('.nav-tab:nth-child(7)');                  // Statistiky
await page.waitForSelector('.stats-table');
await page.selectOption('#stats-set-sel', '1');
await page.waitForTimeout(300);
await page.click('.nav-tab:nth-child(3)');
await page.waitForTimeout(300);
await page.evaluate(() => otevriProfil(13, true));
await page.waitForSelector('#modal-profil:not(.hidden)');

const rozsahText = () => page.textContent('#profil-rozsah');
pass &= ok('T35b profil ze soupisky počítá celou sezónu, ne poslední filtr (#71)',
  /celá sezóna/i.test(await rozsahText()) && !/set/.test(await rozsahText()));
pass &= ok('T35c a je napsané, z čeho je počítaný (#71)',
  /Počítáno z:/.test(await rozsahText()));
const zapasuCelaSezona = await page.$$eval('#profil-obsah .profil-tabulka tbody tr', els => els.length);
await page.click('#modal-profil .btn-secondary');

// proklik z tabulky ve Statistikách filtr dál respektuje
await page.click('.nav-tab:nth-child(7)');          // až tady jsou filtry vidět
await page.waitForSelector('.stats-table');
await page.selectOption('#stats-set-sel', '');
await page.waitForTimeout(200);
const jedenZapas = await page.evaluate(() => {
  // zápas, ve kterém hráčka 13 hrála, ale není jediný v sezóně
  const p = profilHracky(13, true);
  return p.radky.length > 1 ? p.radky[0].z.id : null;
});
pass &= ok('T35d0 fixture má na co filtrovat (#71)', jedenZapas !== null);
await page.selectOption('#stats-zapas-sel', String(jedenZapas));
await page.waitForTimeout(300);
await page.evaluate(() => otevriProfil(13));
await page.waitForSelector('#modal-profil:not(.hidden)');
pass &= ok('T35d proklik ze Statistik filtr respektuje (#71)',
  await page.evaluate(id => {
    const z = state.zapasy.find(z => z.id === id);
    return document.getElementById('profil-rozsah').textContent.includes(z.soupet);
  }, jedenZapas));
const zapasuVeFiltru = await page.$$eval('#profil-obsah .profil-tabulka tbody tr', els => els.length);
pass &= ok('T35e a ta dvě čísla se opravdu liší, ne jen popisek (#71)',
  await page.evaluate(() => {
    const zaSezonu = profilHracky(13, true);
    const zaFiltr = profilHracky(13, false);
    const soucet = p => p.radky.reduce((n, r) => n + r.sp + r.pp + r.up + r.bp + r.cm, 0);
    return zaSezonu.radky.length !== zaFiltr.radky.length &&
           soucet(zaSezonu) !== soucet(zaFiltr);
  }));
await page.click('#modal-profil .btn-secondary');
await page.selectOption('#stats-zapas-sel', '');
await page.waitForTimeout(300);

// souhrnné kostky musí sedět na tabulku pod nimi
await page.evaluate(() => otevriProfil(13, true));
await page.waitForSelector('#modal-profil:not(.hidden)');
pass &= ok('T35f kostky sedí na řádky tabulky, i když je rozsah celá sezóna (#71)',
  await page.evaluate(() => {
    const p = profilHracky(13, true);
    const soucetRadku = p.radky.reduce((n, r) => n + r.total, 0);
    return p.souhrn && p.souhrn.total === soucetRadku && p.souhrn.zapasy === p.radky.length;
  }));
pass &= ok('T35g počet zápasů za sezónu není menší než ve filtru na jeden set (#71)',
  zapasuCelaSezona >= zapasuVeFiltru && zapasuCelaSezona > 0);

// u zápasu je vidět, jak dopadl
pass &= ok('T35h u dokončeného zápasu je v profilu výsledek, ne jen datum (#71)',
  await page.evaluate(() => {
    const znacky = [...document.querySelectorAll('#profil-obsah .profil-vysl')];
    const dokoncene = profilHracky(13, true).radky
      .filter(r => r.z.stav === 'dokonceny' && r.z.sety_my != null);
    return znacky.length === dokoncene.length && znacky.length > 0 &&
           znacky.every(e => /^[VP]?\s*\d+:\d+$/.test(e.textContent.trim()));
  }));
pass &= ok('T35i výhra a prohra se od sebe poznají i jinak než barvou (#71)',
  await page.evaluate(() => {
    const p = profilHracky(13, true);
    const vyhry = p.radky.filter(r => r.z.sety_my > r.z.sety_oni).length;
    const znacky = [...document.querySelectorAll('#profil-obsah .profil-vysl')]
      .map(e => e.textContent.trim());
    return znacky.filter(t => t.startsWith('V')).length === vyhry;
  }));
await page.click('#modal-profil .btn-secondary');

// ── #71 část 2: detail týmu ────────────────────────────────────────────────
await page.click('.nav-tab:nth-child(4)');                  // Týmy
await page.waitForSelector('#tymy-list .tym-card');
pass &= ok('T36a karta týmu vede na detail, nejen na správu členství (#71)',
  (await page.textContent('#tymy-list')).includes('Detail'));

// Ve fixtures nemá žádný tým přiřazený zápas, takže by všechna tvrzení
// o bilanci i statistikách prošla naprázdno. Přiřadíme je tady.
await page.evaluate(() => {
  state.zapasy.filter(z => z.sezona_id === currentSeasonId() &&
      state.statistiky.some(s => s.zapas_id === z.id))
    .forEach(z => { z.tym_id = 5; });
});
pass &= ok('T36b0 fixture má tým se zápasy i akcemi, jinak by se měřilo prázdno (#71)',
  await page.evaluate(() => {
    const p = detailTymu(5);
    return p.zapasy.length > 0 && p.rows.length > 0 && p.tot.total !== 0;
  }));

await page.evaluate(() => otevriTymDetail(5));
await page.waitForSelector('#modal-tym-detail:not(.hidden)');
pass &= ok('T36b hlavička detailu nese tým i sezónu (#71)', await page.evaluate(() => {
  const t = state.tymy.find(t => t.id === 5);
  const sez = state.sezony.find(s => s.id === t.sezona_id);
  const h = document.getElementById('tym-detail-title').textContent;
  return h.includes(t.nazev) && h.includes(sez.nazev);
}));

pass &= ok('T36c bilance sedí na zápasy toho týmu (#71)', await page.evaluate(() => {
  const p = detailTymu(5);
  const zapasyTymu = state.zapasy.filter(z => z.tym_id === 5);
  const done = zapasyTymu.filter(z => z.stav === 'dokonceny' && z.sety_my != null);
  return p.zapasy.length === zapasyTymu.length &&
         p.vyhry === done.filter(z => z.sety_my > z.sety_oni).length &&
         p.prohry === done.filter(z => z.sety_my < z.sety_oni).length;
}));

pass &= ok('T36d statistiky se počítají přes spocitejStatistiky, ne zvlášť (#71)',
  await page.evaluate(() => {
    const p = detailTymu(5);
    const ids = state.zapasy.filter(z => z.tym_id === 5).map(z => z.id);
    const d = spocitejStatistiky({ zapasIds: ids });
    return d.stav === 'ok' && p.tot.total === d.tot.total && p.tot.sp === d.tot.sp;
  }));

pass &= ok('T36e součet přes sety, ne jen první set (#71)', await page.evaluate(() => {
  const ids = state.zapasy.filter(z => z.tym_id === 5).map(z => z.id);
  const rucne = state.statistiky.filter(s => ids.includes(s.zapas_id))
    .reduce((n, s) => n + (s.utok_plus || 0), 0);
  return detailTymu(5).tot.up === rucne;
}));

pass &= ok('T36f do součtu patří i hráčka, co už v týmu není (#71)', await page.evaluate(() => {
  const ids = state.zapasy.filter(z => z.tym_id === 5).map(z => z.id);
  const vTymu = state.hraciTymy.filter(ht => ht.tym_id === 5).map(ht => ht.hrac_id);
  const hrajiciMimoTym = [...new Set(state.statistiky
    .filter(s => ids.includes(s.zapas_id)).map(s => s.hrac_id))]
    .filter(id => !vTymu.includes(id));
  const vRows = detailTymu(5).rows.map(r => r.h.id);
  // buď takové hráčky nejsou, nebo musí být v součtu — ne tiše vypadnout
  return hrajiciMimoTym.every(id => vRows.includes(id));
}));

pass &= ok('T36g detail ukazuje odehrané zápasy s proklikem do Live (#71)',
  await page.evaluate(() => {
    const zapasu = state.zapasy.filter(z => z.tym_id === 5).length;
    const v = document.querySelectorAll('#tym-detail-obsah .match-item');
    return v.length === zapasu && [...v].every(e => e.classList.contains('match-klik'));
  }));

pass &= ok('T36h chyby soupeře jsou v týmovém souhrnu taky (#71)',
  /Chyb soupeře/.test(await page.textContent('#tym-detail-obsah')));

pass &= ok('T36i procenta mají jednotku, ne holé číslo (#71)', await page.evaluate(() => {
  const popisky = [...document.querySelectorAll('#tym-detail-obsah .profil-kostka')]
    .filter(k => /% výb\./.test(k.querySelector('.profil-kostka-lbl').textContent));
  return popisky.length === 2 && popisky.every(k => {
    const v = k.querySelector('.profil-kostka-val').textContent.trim();
    return v === '—' || v.endsWith('%');
  });
}));

// nejlepší hráčky vedou do profilu
const topRadky = await page.$$('#tym-detail-obsah .tym-top-radek');
pass &= ok('T36j detail ukazuje nejlepší hráčky týmu (#71)', topRadky.length > 0);
pass &= ok('T36k jsou seřazené od nejlepší (#71)', await page.evaluate(() => {
  const c = [...document.querySelectorAll('#tym-detail-obsah .tym-top-total')]
    .map(e => parseInt(e.textContent));
  return c.length > 1 && c.every((v, i) => i === 0 || c[i - 1] >= v);
}));
// pořadí nesmí záviset na tom, co je zrovna naklikané v tabulce Statistik (#72)
pass &= ok('T36k2 pořadí nedědí řazení z tabulky Statistik (#71)',
  await page.evaluate(() => {
    const puvodni = { ...statsSort };
    statsSort.sloupec = 'cm'; statsSort.smer = 'asc';
    const a = detailTymu(5).rows.map(r => r.h.id);
    statsSort.sloupec = 'zapasy'; statsSort.smer = 'desc';
    const b = detailTymu(5).rows.map(r => r.h.id);
    Object.assign(statsSort, puvodni);
    return a.join('|') === b.join('|');
  }));
await topRadky[0].click();
await page.waitForSelector('#modal-profil:not(.hidden)');
pass &= ok('T36l proklik na hráčku otevře její profil za celou sezónu (#71)',
  /celá sezóna/i.test(await page.textContent('#profil-rozsah')) &&
  await page.isHidden('#modal-tym-detail'));
await page.click('#modal-profil .btn-secondary');

// tým bez zápasů nesmí spadnout ani lhát
await page.evaluate(() => { state.zapasy.forEach(z => { if (z.tym_id === 5) delete z.tym_id; }); });
pass &= ok('T36m tým bez zápasů detail zvládne a řekne to (#71)', await page.evaluate(() => {
  state.tymy.push({ id: 888, nazev: 'Prázdný tým', sezona_id: currentSeasonId() });
  otevriTymDetail(888);
  const t = document.getElementById('tym-detail-obsah').textContent;
  const ok = /žádný zápas/i.test(t) && detailTymu(888).zapasy.length === 0;
  closeModal('modal-tym-detail');
  state.tymy = state.tymy.filter(t => t.id !== 888);
  return ok;
}));


await page.setViewportSize({ width: 1100, height: 900 });
await page.waitForTimeout(300);

// ── #74: chyby soupeře ─────────────────────────────────────────────────────
await page.click('.nav-tab:nth-child(6)');                 // Live V2
await page.waitForSelector('#v2-souper-pocet');
await page.click('#live2-wrap .set-prepinac button:nth-of-type(1)');
await page.waitForTimeout(300);

const chybyCislo = () => page.textContent('#v2-souper-pocet').then(t => parseInt(t.trim()));
// stub drží data v Node, ne ve stránce — tohle je most pro „zapsal někdo druhý"
await page.exposeFunction('FIX_SET_CHYBY', (zapas, set, pole, hodnota) => {
  let r = FIX.vb_chyby_souperu.find(c => c.zapas_id === zapas && c.set_cislo === set);
  if (!r) { r = { zapas_id: zapas, set_cislo: set, pocet: 0, body: 0 }; FIX.vb_chyby_souperu.push(r); }
  r[pole] = hodnota;
});
pass &= ok('T33a chyby soupeře jsou tlačítko s hodnotou, ne sloupec (#74)',
  await page.evaluate(() => {
    const b = document.querySelector('.v2-souper-btn');
    const r = b.getBoundingClientRect();
    // v mřížce nemá co dělat — dohodnuto v #74. Hledá se ovládání, ne slovo
    // „chyba": mřížka má vlastní sloupec chyb NAŠICH hráček, to je něco jiného.
    return !!b && r.height >= 44 &&
           !document.querySelector('#live-table-wrap .v2-souper') &&
           !document.getElementById('live-table-wrap').innerHTML.includes('bumpSouper');
  }));
pass &= ok('T33b hodnota se načte z databáze (#74)', await chybyCislo() === 2);

chybyRpc = [];
const predChyby = await chybyCislo();
await page.click('.v2-souper-btn.plus');
await page.waitForTimeout(600);
pass &= ok('T33c klepnutí přičte a rovnou je to vidět (#74)',
  await chybyCislo() === predChyby + 1);
pass &= ok('T33d zapisuje se přírůstkem přes vlastní RPC, ne přepisem řádku (#74)',
  chybyRpc.length === 1 && chybyRpc[0].p_delta === 1 && chybyRpc[0].p_set === 1 && chybyRpc[0].p_pole === 'pocet');
pass &= ok('T33e nejde to přes vb_zapis_akce ani přímým zápisem do tabulky (#74)',
  !otherWrites.some(w => w.table === 'vb_chyby_souperu' && w.method !== 'GET'));

// zpět umí i tohle
pass &= ok('T33f lišta zpět nabídne vrátit chybu soupeře (#74)',
  /[Cc]hyba soupeře/.test(await page.textContent('#live2-wrap .undo-text')));
await page.click('#btn-undo-v2');
await page.waitForTimeout(600);
pass &= ok('T33g zpět chybu soupeře odečte (#74)', await chybyCislo() === predChyby);
pass &= ok('T33h odečet jde taky přírůstkem (#74)',
  chybyRpc.length === 2 && chybyRpc[1].p_delta === -1);

// počítá se po setech
await page.click('#live2-wrap .set-prepinac button:nth-of-type(2)');
await page.waitForTimeout(400);
pass &= ok('T33i druhý set má vlastní počítadlo (#74)', await chybyCislo() === 0);
chybyRpc = [];
await page.click('.v2-souper-btn.plus');
await page.waitForTimeout(600);
pass &= ok('T33j zápis jde do zobrazeného setu (#74)',
  chybyRpc.length === 1 && chybyRpc[0].p_set === 2);
pass &= ok('T33k první set tím zůstal nedotčený (#74)',
  await page.evaluate(() => souperHodnota(100, 1, 'pocet')) === predChyby);

// přepnutí souhrnu na celý zápas sečte sety
await page.click('#live2-wrap .v2-tym-prepinac');
await page.waitForTimeout(300);
// druhé zařízení: dorovnání musí chyby soupeře dotáhnout taky
await page.evaluate(() => {
  FIX_SET_CHYBY(100, 1, 'pocet', 42);          // „někdo druhý" zapsal
});
await page.evaluate(() => refreshLiveStats());
await page.waitForTimeout(400);
pass &= ok('T33l2 dorovnání dotáhne i zápis chyb z druhého zařízení (#74)',
  await page.evaluate(() => souperHodnota(100, 1, 'pocet')) === 42);

pass &= ok('T33l souhrn za celý zápas sečte sety (#74)',
  await chybyCislo() === await page.evaluate(() => souperZapas(100, 'pocet')));
await page.click('#live2-wrap .v2-tym-prepinac');
await page.waitForTimeout(300);

// číslo, které jde jen zapsat, by bylo k ničemu — musí být vidět i ve Statistikách
await page.click('.nav-tab:nth-child(7)');
await page.waitForSelector('.stats-chyby');
pass &= ok('T33m chyby soupeře jsou vidět i ve Statistikách (#74)',
  /Chyba soupeře/.test(await page.textContent('.stats-chyby')));
pass &= ok('T33n číslo ve Statistikách sedí na data (#74)', await page.evaluate(() => {
  const d = spocitejStatistiky();
  const ocekavano = d.zapasIds.reduce((n, z) => n + souperZapas(z, 'pocet'), 0);
  return parseInt(document.querySelector('.stats-chyby strong').textContent) === ocekavano;
}));
await page.selectOption('#stats-set-sel', '1');
await page.waitForTimeout(300);
pass &= ok('T33o filtr na set platí i pro ně (#74)', await page.evaluate(() => {
  const d = spocitejStatistiky();
  const ocekavano = d.zapasIds.reduce((n, z) => n + souperHodnota(z, 1, 'pocet'), 0);
  return parseInt(document.querySelector('.stats-chyby strong').textContent) === ocekavano &&
         /1\. set/.test(document.querySelector('.stats-chyby').textContent);
}));
await page.selectOption('#stats-set-sel', '');
await page.waitForTimeout(300);

// a mazání zápasu o nich musí říct
await page.click('.nav-tab:nth-child(2)');
await page.waitForSelector('#zapasy-list .match-item');
let textMazani = '';
page.once('dialog', d => { textMazani = d.message(); d.dismiss(); });
await page.evaluate(() => deleteZapas(100));
await page.waitForTimeout(300);
pass &= ok('T33p dialog mazání zápasu přizná i chyby soupeře (#74)',
  /akcí soupeře/.test(textMazani));

await page.click('.nav-tab:nth-child(5)');
await page.waitForTimeout(200);

// ── přihlášení přežije reload ──────────────────────────────────────────────
await page.reload();
await nactenoOK();
pass &= ok('T10d přihlášení přežije reload stránky (#24)', await page.evaluate(() => isLoggedIn()));

// ── #28: velká tabulka se načte celá, ne jen prvních 1000 řádků ────────────
const POCET = 2500;
for (let i = 0; i < POCET; i++) {
  db.set(`p${i}`, { zapas_id: 100, hrac_id: 10000 + i, servis_plus: 1 });
}
getPozadavky = [];
await page.reload();
await nactenoOK();
const nacteno = await page.evaluate(() => state.statistiky.length);
const dotazyNaStatistiky = getPozadavky.filter(g => g.table === 'vb_statistiky');
pass &= ok(`T15a tabulka nad 1000 řádků se načte celá (#28), čekáno ${db.size}`, nacteno === db.size);
pass &= ok('T15b načítá se po stránkách, ne jedním dotazem (#28)', dotazyNaStatistiky.length >= 3);
pass &= ok('T15c každá stránka si řekne o svůj rozsah (#28)',
  dotazyNaStatistiky.slice(0, 3).every((g, i) => g.range === `${i * 1000}-${i * 1000 + 999}`));
pass &= ok('T15d řazení je jednoznačné, ať se řádky nepřeskočí (#28)',
  await page.evaluate(() => {
    // po #32 je jeden řádek na set, takže klíč nese i set
    const ids = state.statistiky.map(s => `${s.zapas_id}_${s.hrac_id}_${s.set_cislo || 1}`);
    return new Set(ids).size === ids.length;
  }));

pass &= ok('žádná chyba v konzoli', errors.length === 0);
if (errors.length) console.log(errors);

// ── #84: bod soupeře jako druhé počítadlo vedle jeho chyby ─────────────────
await page.click('.nav-tab:nth-child(6)');                  // Live V2
await page.waitForSelector('#v2-souper-body');
await page.click('#live2-wrap .set-prepinac button:nth-of-type(1)');
await page.waitForTimeout(300);

const souperCislo = pole => page.textContent('#v2-souper-' + pole).then(t => parseInt(t.trim()));

pass &= ok('T37a soupeřova strana má dvě počítadla, ne jedno (#84)',
  (await page.$$eval('#live2-wrap .v2-souper-btn', els => els.length)) === 2);
pass &= ok('T37b obě jsou pojmenovaná, ne jen + a − (#84)',
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('#live2-wrap .v2-souper-nazev')].map(e => e.textContent);
    // dvě různé události, ne dvě kvality téže akce — samotné znaménko by se nedalo přečíst
    return t.some(x => /Chyba soupeře/.test(x)) && t.some(x => /Bod soupeře/.test(x));
  }));

chybyRpc = [];
const predBoduSoupere = await souperCislo('body');
const predChybSoupere = await souperCislo('pocet');
await page.click('#live2-wrap .v2-souper-btn.minus');
await page.waitForTimeout(600);
pass &= ok('T37c klepnutí na „bod soupeře" přičte jeho, ne chyby (#84)',
  await souperCislo('body') === predBoduSoupere + 1 && await souperCislo('pocet') === predChybSoupere);
pass &= ok('T37d zapisuje se do vlastního pole přes vb_zapis_souper (#84)',
  chybyRpc.length === 1 && chybyRpc[0].p_pole === 'body' && chybyRpc[0].p_delta === 1);

pass &= ok('T37e lišta zpět pozná, které z těch dvou vrací (#84)',
  /Bod soupeře/.test(await page.textContent('#live2-wrap .undo-text')));
await page.click('#btn-undo-v2');
await page.waitForTimeout(600);
pass &= ok('T37f zpět odečte bod soupeře a chyb se nedotkne (#84)',
  await souperCislo('body') === predBoduSoupere && await souperCislo('pocet') === predChybSoupere);

// obě pole musí přežít dorovnání z druhého zařízení
await page.evaluate(() => FIX_SET_CHYBY(100, 1, 'body', 7));
await page.evaluate(() => FIX_SET_CHYBY(100, 1, 'pocet', 5));
await page.evaluate(() => refreshLiveStats());
await page.waitForTimeout(500);
pass &= ok('T37g dorovnání dotáhne obě pole, ne jen jedno (#84)',
  await page.evaluate(() => souperHodnota(100, 1, 'body')) === 7 &&
  await page.evaluate(() => souperHodnota(100, 1, 'pocet')) === 5);

// a jsou vidět i mimo Live
await page.click('.nav-tab:nth-child(7)');
await page.waitForSelector('.stats-chyby');
pass &= ok('T37h ve Statistikách jsou vidět obě (#84)', await page.evaluate(() => {
  const t = document.querySelector('.stats-chyby').textContent;
  const d = spocitejStatistiky();
  const ocek = pole => d.zapasIds.reduce((n, z) => n + souperZapas(z, pole), 0);
  return /Chyba soupeře/.test(t) && /Bod soupeře/.test(t) &&
         t.includes(String(ocek('pocet'))) && t.includes(String(ocek('body')));
}));

// skóre setu z toho jde poskládat: každé minus je ztracený bod
pass &= ok('T37i z dat jde poskládat skóre setu (#84)', await page.evaluate(() => {
  const set = 1, zapas = 100;
  const sum = f => state.hraci.reduce((n, h) => n + getStatVal(zapas, h.id, f, set), 0);
  const nase = sum('servis_plus') + sum('utok_plus') + sum('blok_plus')
             + souperHodnota(zapas, set, 'pocet');
  const jejich = sum('servis_minus') + sum('prijem_minus') + sum('utok_minus')
               + sum('chyba_minus') + souperHodnota(zapas, set, 'body');
  // příjem: plus a neutral je kvalita, minus je ztracený bod
  return Number.isInteger(nase) && Number.isInteger(jejich) && nase >= 0 && jejich > 0;
}));


// ── #84 část 2: hřiště po zónách ───────────────────────────────────────────
await page.click('.nav-tab:nth-child(6)');                  // Live V2
await page.waitForSelector('#live2-wrap');
await page.click('#live2-wrap .set-prepinac button:nth-of-type(1)');
await page.waitForTimeout(300);
// hráčky do sestavy, ať je koho stavět
await page.evaluate(() => {
  [10, 11, 12, 13, 14].forEach((id, i) => {
    if (!state.zapasHraci.some(zh => zh.zapas_id === 100 && zh.hrac_id === id))
      state.zapasHraci.push({ zapas_id: 100, hrac_id: id, poradi: i + 1 });
  });
  // libero se nominuje do sestavy zápasu, neodvozuje z pozice hráčky
  state.zapasHraci.filter(zh => zh.zapas_id === 100).forEach(zh => { zh.libero = zh.hrac_id === 14; });
  state.postaveni = state.postaveni.filter(p => p.zapas_id !== 100);
  renderLive2(100);
});
await page.waitForTimeout(200);

pass &= ok('T38a V2 má přepínač seznam ⇄ hřiště, ne osmou záložku (#84)',
  (await page.$$eval('#live2-wrap .v2-zobrazeni-btn', els => els.length)) === 2 &&
  (await page.$$eval('.nav-tab', els => els.length)) === 7);

await page.click('#live2-wrap .v2-zobrazeni-btn:nth-child(2)');   // Hřiště
await page.waitForSelector('.hriste');
pass &= ok('T38b hřiště má šest zón a dva sloty pro libera (#84)',
  (await page.$$eval('.hriste .hriste-zona', els => els.length)) === 6 &&
  (await page.$$eval('.hriste-mimo .hriste-zona.libero', els => els.length)) === 2);
pass &= ok('T38c síť je vpravo, u ní 4-3-2, vzadu 5-6-1 (#84)',
  await page.evaluate(() => {
    const rady = [...document.querySelectorAll('.hriste-rada')]
      .map(r => [...r.querySelectorAll('.hriste-cislo-zony')].map(e => parseInt(e.textContent)));
    const sit = document.querySelector('.hriste-sit').getBoundingClientRect();
    const plocha = document.querySelector('.hriste').getBoundingClientRect();
    return JSON.stringify(rady) === JSON.stringify([[5, 4], [6, 3], [1, 2]]) &&
           sit.left >= plocha.right - 1;
  }));
pass &= ok('T38d prázdná šestka to řekne a nabídne obsazení (#84)',
  /Chybí/.test(await page.textContent('.hriste-napoveda')) &&
  (await page.$$eval('.hriste .hriste-zona.prazdna', els => els.length)) === 6);

// obsazení zóny
otherWrites = []; postaveniRpc = [];
await page.click('.hriste .hriste-zona:nth-child(1)');              // zóna 5 (vlevo nahoře)
await page.waitForSelector('#modal-v2-zona:not(.hidden)');
pass &= ok('T38e nominované libero se do zóny nenabízí (#84)',
  !(await page.textContent('#v2-zona-obsah')).includes('Libuše'));
pass &= ok('T38e2 hráčka s pozicí libero, která nominovaná není, se nabízí (#84)',
  await page.evaluate(() => {
    const h = state.hraci.find(h => (h.pozice || '').toLowerCase() === 'libero' && !jeLibero(100, h.id));
    return !!h && document.getElementById('v2-zona-obsah').textContent.includes(h.jmeno);
  }));
await page.click('#v2-zona-obsah .player-card');
await page.waitForTimeout(500);
pass &= ok('T38f obsazení zóny se uloží celé a v jedné transakci (#84)',
  postaveniRpc.length === 1 && postaveniRpc[0].p_zapas === 100 &&
  postaveniRpc[0].p_set === 1 && postaveniRpc[0].pocet === 1 &&
  // po řádcích to padalo na unikátním indexu, přímý zápis do tabulky už nesmí být
  !otherWrites.some(w => w.table === 'vb_postaveni'));
pass &= ok('T38g obsazená zóna ukazuje jméno a čísla hráčky (#84)',
  await page.evaluate(() => {
    const z = document.querySelector('.hriste .hriste-zona:not(.prazdna)');
    return !!z && !!z.querySelector('.hriste-jmeno') && !!z.querySelector('.hriste-skore');
  }));

// zóna 1 je odlišená, protože z ní se podává
pass &= ok('T38h zóna 1 je odlišená jako podávající, i když je prázdná (#84)',
  await page.evaluate(() => {
    const zony = [...document.querySelectorAll('.hriste .hriste-zona')]
      .map(z => ({ zona: parseInt(z.querySelector('.hriste-cislo-zony').textContent),
                   podava: z.classList.contains('podava') }));
    // přesně jedna, a je to jednička — z ní se čte rotace
    return zony.filter(c => c.podava).length === 1 &&
           zony.find(c => c.podava).zona === 1;
  }));

// libero je stranou a taky se na něj dá klikat
pass &= ok('T38i libero má svůj slot mimo hřiště, ne zónu (#84)',
  (await page.textContent('.hriste-mimo')).includes('Libuše') &&
  await page.evaluate(() => {
    const sloty = [...document.querySelectorAll('.hriste-mimo .hriste-zona.libero .hriste-cislo-zony')]
      .map(e => parseInt(e.textContent));
    return JSON.stringify(sloty) === JSON.stringify([7, 8]);
  }));
await page.click('.hriste-mimo .hriste-zona.libero:not(.prazdna)');
await page.waitForSelector('#modal-v2-akce:not(.hidden)');
pass &= ok('T38j u libera se nenabízí střídání, není v zóně (#84)',
  await page.isHidden('#btn-v2-stridat'));
await page.click('#modal-v2-akce .modal-footer .btn-secondary');

// klik na hráčku v zóně otevře akce a nabídne střídání
await page.click('.hriste .hriste-zona:not(.prazdna)');
await page.waitForSelector('#modal-v2-akce:not(.hidden)');
pass &= ok('T38k klik na zónu otevře akce a nabídne střídání (#84)',
  await page.isVisible('#btn-v2-stridat'));
const zonaStridani = await page.evaluate(() =>
  [...postaveniSetu(100, 1).keys()][0]);
const predStridanim = await page.evaluate(z => postaveniSetu(100, 1).get(z), zonaStridani);
await page.click('#btn-v2-stridat');
await page.waitForSelector('#modal-v2-zona:not(.hidden)');
pass &= ok('T38l střídání nabízí jen ty z lavičky, ne už stojící (#84)',
  await page.evaluate(() => {
    const naHristi = [...postaveniSetu(100, 1).values()];
    const nabidnute = [...document.querySelectorAll('#v2-zona-obsah .player-card .player-name')]
      .map(e => e.textContent);
    return nabidnute.length > 0 &&
      naHristi.every(id => !nabidnute.includes(state.hraci.find(h => h.id === id).jmeno));
  }));
await page.click('#v2-zona-obsah .player-card');
await page.waitForTimeout(500);
pass &= ok('T38m střídání zónu opravdu přeobsadí (#84)',
  await page.evaluate(z => postaveniSetu(100, 1).get(z), zonaStridani) !== predStridanim);

// jedna hráčka nemůže stát ve dvou zónách
pass &= ok('T38n přesun hráčky uvolní její původní zónu (#84)', await page.evaluate(() => {
  const zdroj = [...postaveniSetu(100, 1).keys()][0];
  const cil = [1, 2, 3, 4, 5, 6].find(z => !postaveniSetu(100, 1).has(z));
  const kdo = postaveniSetu(100, 1).get(zdroj);
  postavDoZony(100, 1, cil, kdo);
  const m = postaveniSetu(100, 1);
  return m.get(cil) === kdo && m.get(zdroj) !== kdo;
}));

// postavení je per set
await page.click('#live2-wrap .set-prepinac button:nth-of-type(2)');
await page.waitForTimeout(400);
pass &= ok('T38o druhý set začíná s vlastním postavením (#84)',
  await page.evaluate(() => postaveniSetu(100, 2).size) === 0 &&
  (await page.$$eval('.hriste .hriste-zona.prazdna', els => els.length)) === 6);
pass &= ok('T38p nabídne převzít postavení z předchozího setu (#84)',
  /Převzít z 1\. setu/.test(await page.textContent('.hriste-napoveda')));
await page.click('.hriste-napoveda button');
await page.waitForTimeout(900);
pass &= ok('T38q převzetí naklikané postavení zkopíruje (#84)',
  await page.evaluate(() => {
    const a = postaveniSetu(100, 1), b = postaveniSetu(100, 2);
    return b.size === a.size && b.size > 0 &&
           [...a.entries()].every(([z, id]) => b.get(z) === id);
  }));

// zápis akce z hřiště jde stejnou cestou jako odjinud
await page.click('#live2-wrap .set-prepinac button:nth-of-type(1)');
await page.waitForTimeout(400);
rpcCalls = [];
await page.click('.hriste .hriste-zona:not(.prazdna)');
await page.waitForSelector('#modal-v2-akce:not(.hidden)');
await page.click('#modal-v2-akce .v2-dlazdice[onclick*="utok_plus"]');
await page.waitForTimeout(600);
pass &= ok('T38r zápis z hřiště jde stejným RPC jako ze seznamu (#84)',
  rpcCalls.length === 1 && rpcCalls[0].some(z => z.pole === 'utok_plus' && z.delta === 1));

// geometrie na telefonu
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
pass &= ok('T38s hřiště se vejde na telefon bez přetečení (#84)', await page.evaluate(() => {
  const wrap = document.getElementById('live2-wrap');
  const seznam = wrap.querySelector('.v2-seznam');
  const zona = document.querySelector('.hriste .hriste-zona').getBoundingClientRect();
  return document.documentElement.scrollWidth - document.documentElement.clientWidth <= 0 &&
         seznam.scrollWidth - seznam.clientWidth <= 0 &&
         zona.width >= 44 && zona.height >= 44;
}));
await page.setViewportSize({ width: 1100, height: 900 });
await page.waitForTimeout(300);


// ── #84 část 3: rotace z podání ────────────────────────────────────────────
await page.click('.nav-tab:nth-child(6)');                  // Live V2
await page.waitForSelector('#live2-wrap');
await page.click('#live2-wrap .set-prepinac button:nth-of-type(1)');
await page.waitForTimeout(300);

// čistá šestka: zóna → hráčka
await page.evaluate(async () => {
  state.postaveni = state.postaveni.filter(p => p.zapas_id !== 100);
  const ids = [10, 11, 12, 13];
  [1, 2, 3, 4].forEach((z, i) => state.postaveni.push(
    { zapas_id: 100, set_cislo: 1, zona: z, hrac_id: ids[i] }));
  if (!v2Hriste) v2PrepniHriste(); else renderLive2(100);
});
await page.waitForSelector('.hriste-zona:not(.prazdna)');

const kdoKde = () => page.evaluate(() =>
  Object.fromEntries([...postaveniSetu(100, 1).entries()]));
// sestava nemá plnou šestku, takže po rotaci jsou obsazené jiné zóny —
// zóna se vybírá podle skutečného stavu, ne natvrdo
const obsazenaZona = (krome = 0) => page.evaluate(k =>
  [...postaveniSetu(100, 1).keys()].find(z => z !== k), krome);

pass &= ok('T39a výpočet rotace posouvá 2→1, 1→6 (#84)', await page.evaluate(() =>
  poRotaci(2, 1) === 1 && poRotaci(1, 1) === 6 && poRotaci(6, 1) === 5 &&
  poRotaci(3, 2) === 1 && poRotaci(1, 6) === 1));

// zapsaný servis hráčky ze zóny 3 ji musí posunout do jedničky
const predRotaci = await kdoKde();
otherWrites = [];
postaveniRpc = [];
const zonaA = await obsazenaZona(1);
await page.evaluate(z => v2OtevriAkce(100, postaveniSetu(100, 1).get(z), z), zonaA);
await page.waitForSelector('#modal-v2-akce:not(.hidden)');
await page.click('#modal-v2-akce .v2-dlazdice[onclick*="servis_plus"]');
await page.waitForTimeout(700);
const po = await kdoKde();
pass &= ok('T39b zapsaný servis postaví podávající do zóny 1 (#84)',
  po[1] === predRotaci[zonaA]);
pass &= ok('T39c ostatní se posunou o zónu, nikdo se neztratí ani nezdvojí (#84)',
  await page.evaluate(p => {
    const po = Object.fromEntries([...postaveniSetu(100, 1).entries()]);
    const bylo = Object.values(p).sort(), je = Object.values(po).sort();
    return JSON.stringify(bylo) === JSON.stringify(je) &&
           new Set(Object.values(po)).size === Object.values(po).length;
  }, predRotaci));
pass &= ok('T39d rotace se uloží jednou RPC, ne po řádcích (#84)',
  postaveniRpc.length === 1 && postaveniRpc[0].p_set === 1 &&
  !otherWrites.some(w => w.table === 'vb_postaveni'));

// servis hráčky, která už v jedničce stojí, nic neotáčí
const predOpak = await kdoKde();
await page.evaluate(() => v2OtevriAkce(100, postaveniSetu(100, 1).get(1), 1));
await page.waitForSelector('#modal-v2-akce:not(.hidden)');
await page.click('#modal-v2-akce .v2-dlazdice[onclick*="servis_neutral"]');
await page.waitForTimeout(700);
pass &= ok('T39e servis z jedničky postavením nehne (#84)',
  JSON.stringify(await kdoKde()) === JSON.stringify(predOpak));

// „zpět" musí vrátit i rotaci
const zonaB = await obsazenaZona(1);
await page.evaluate(z => v2OtevriAkce(100, postaveniSetu(100, 1).get(z), z), zonaB);
await page.waitForSelector('#modal-v2-akce:not(.hidden)');
const postaveniPredZpet = await kdoKde();
await page.click('#modal-v2-akce .v2-dlazdice[onclick*="servis_plus"]');
await page.waitForTimeout(700);
pass &= ok('T39f servis otočil šestku (#84)',
  JSON.stringify(await kdoKde()) !== JSON.stringify(postaveniPredZpet));
await page.click('#btn-undo-v2');
await page.waitForTimeout(700);
pass &= ok('T39g zpět vrátí i rotaci, nejen počítadlo (#84)',
  JSON.stringify(await kdoKde()) === JSON.stringify(postaveniPredZpet));

// akce, která není servis, rotací nehýbe
const predUtokem = await kdoKde();
const zonaC = await obsazenaZona(0);
await page.evaluate(z => v2OtevriAkce(100, postaveniSetu(100, 1).get(z), z), zonaC);
await page.waitForSelector('#modal-v2-akce:not(.hidden)');
await page.click('#modal-v2-akce .v2-dlazdice[onclick*="utok_plus"]');
await page.waitForTimeout(700);
pass &= ok('T39h útok ani blok postavením nehýbou (#84)',
  JSON.stringify(await kdoKde()) === JSON.stringify(predUtokem));

// ruční srovnání, když se servis nezapsal
const zonaD = await obsazenaZona(1);
await page.evaluate(z => v2OtevriAkce(100, postaveniSetu(100, 1).get(z), z), zonaD);
await page.waitForSelector('#modal-v2-akce:not(.hidden)');
pass &= ok('T39i u hráčky mimo jedničku je ruční srovnání (#84)',
  await page.isVisible('#btn-v2-podava'));
const ctyrka = await page.evaluate(z => postaveniSetu(100, 1).get(z), zonaD);
rpcCalls = [];
await page.click('#btn-v2-podava');
await page.waitForTimeout(700);
pass &= ok('T39j ruční srovnání postaví hráčku do jedničky (#84)',
  await page.evaluate(() => postaveniSetu(100, 1).get(1)) === ctyrka);
pass &= ok('T39k a nezapíše přitom žádnou akci (#84)', rpcCalls.length === 0);

await page.evaluate(() => v2OtevriAkce(100, postaveniSetu(100, 1).get(1), 1));
await page.waitForSelector('#modal-v2-akce:not(.hidden)');
pass &= ok('T39l u hráčky v jedničce se ruční srovnání nenabízí (#84)',
  await page.isHidden('#btn-v2-podava'));
await page.click('#modal-v2-akce .modal-footer .btn-secondary');

// servis hráčky mimo hřiště (libero) postavením nehne
const predLiberem = await kdoKde();
const mimoHriste = await page.evaluate(() => {
  const naHristi = [...postaveniSetu(100, 1).values()];
  const h = state.hraci.find(h => !naHristi.includes(h.id) &&
    state.zapasHraci.some(zh => zh.zapas_id === 100 && zh.hrac_id === h.id));
  return h ? h.id : null;
});
pass &= ok('T39m0 je koho zkusit mimo šestku (#84)', mimoHriste !== null);
await page.evaluate(id => v2OtevriAkce(100, id), mimoHriste);
await page.waitForSelector('#modal-v2-akce:not(.hidden)');
await page.click('#modal-v2-akce .v2-dlazdice[onclick*="servis_plus"]');
await page.waitForTimeout(700);
pass &= ok('T39m servis hráčky mimo šestku postavením nehne (#84)',
  JSON.stringify(await kdoKde()) === JSON.stringify(predLiberem));


// ── #84 část 4: stav setu ──────────────────────────────────────────────────
await page.click('.nav-tab:nth-child(6)');                  // Live V2
await page.waitForSelector('#live2-wrap');
await page.evaluate(() => { if (v2Hriste) v2PrepniHriste(); });
await page.waitForSelector('.skore');
await page.click('#live2-wrap .set-prepinac button:nth-of-type(1)');
await page.waitForTimeout(300);

const skore = () => page.evaluate(() => ({
  nase: parseInt(document.getElementById('skore-nase').textContent),
  jejich: parseInt(document.getElementById('skore-jejich').textContent),
}));

pass &= ok('T40a V2 ukazuje stav zapisovaného setu (#84)',
  await page.isVisible('.skore') &&
  /1\. set/.test(await page.textContent('.skore-popis')));

pass &= ok('T40b skóre sedí na dohodnutý model (#84)', await page.evaluate(() => {
  const s = skoreSetu(100, 1);
  const hraci = hraciVSezoně(currentSeasonId());
  const suma = pole => hraci.reduce((n, h) =>
    n + pole.reduce((m, f) => m + getStatVal(100, h.id, f, 1), 0), 0);
  return s.nase === suma(['servis_plus', 'utok_plus', 'blok_plus']) + souperHodnota(100, 1, 'pocet') &&
         s.jejich === suma(['servis_minus', 'prijem_minus', 'utok_minus', 'chyba_minus'])
                    + souperHodnota(100, 1, 'body');
}));

// bodované akce: plus nám, minus jim
const predSkore = await skore();
await page.evaluate(() => {
  const id = state.zapasHraci.find(zh => zh.zapas_id === 100).hrac_id;
  v2OtevriAkce(100, id);
});
await page.waitForSelector('#modal-v2-akce:not(.hidden)');
await page.click('#modal-v2-akce .v2-dlazdice[onclick*="utok_plus"]');
await page.waitForTimeout(600);
pass &= ok('T40c smeč přidá bod nám (#84)', await page.evaluate(p =>
  skoreSetu(100, 1).nase === p.nase + 1 && skoreSetu(100, 1).jejich === p.jejich, predSkore));

await page.evaluate(() => {
  const id = state.zapasHraci.find(zh => zh.zapas_id === 100).hrac_id;
  v2OtevriAkce(100, id);
});
await page.waitForSelector('#modal-v2-akce:not(.hidden)');
await page.click('#modal-v2-akce .v2-dlazdice[onclick*="prijem_minus"]');
await page.waitForTimeout(600);
pass &= ok('T40d zkažený příjem je bod jim, i když je příjem jinak kvalita (#84)',
  await page.evaluate(p => skoreSetu(100, 1).jejich === p.jejich + 1, predSkore));

// kvalita skóre nehýbe
const predKvalitou = await page.evaluate(() => skoreSetu(100, 1));
await page.evaluate(() => {
  const id = state.zapasHraci.find(zh => zh.zapas_id === 100).hrac_id;
  v2OtevriAkce(100, id);
});
await page.waitForSelector('#modal-v2-akce:not(.hidden)');
await page.click('#modal-v2-akce .v2-dlazdice[onclick*="prijem_plus"]');
await page.waitForTimeout(600);
pass &= ok('T40e dobrý příjem skóre nemění, je to kvalita (#84)',
  await page.evaluate(p => JSON.stringify(skoreSetu(100, 1)) === JSON.stringify(p), predKvalitou));

await page.evaluate(() => {
  const id = state.zapasHraci.find(zh => zh.zapas_id === 100).hrac_id;
  v2OtevriAkce(100, id);
});
await page.waitForSelector('#modal-v2-akce:not(.hidden)');
await page.click('#modal-v2-akce .v2-dlazdice[onclick*="utok_neutral"]');
await page.waitForTimeout(600);
pass &= ok('T40f útok, po kterém se pokračuje, skóre nemění (#84)',
  await page.evaluate(p => JSON.stringify(skoreSetu(100, 1)) === JSON.stringify(p), predKvalitou));

// soupeřova strana
const predSouperem = await page.evaluate(() => skoreSetu(100, 1));
await page.click('#live2-wrap .v2-souper-btn.plus');
await page.waitForTimeout(600);
pass &= ok('T40g chyba soupeře je bod nám (#84)',
  await page.evaluate(p => skoreSetu(100, 1).nase === p.nase + 1, predSouperem));
await page.click('#live2-wrap .v2-souper-btn.minus');
await page.waitForTimeout(600);
pass &= ok('T40h bod soupeře je bod jim (#84)',
  await page.evaluate(p => skoreSetu(100, 1).jejich === p.jejich + 1, predSouperem));

pass &= ok('T40i skóre na obrazovce sedí na výpočet (#84)', await page.evaluate(async () => {
  const s = skoreSetu(100, 1);
  return parseInt(document.getElementById('skore-nase').textContent) === s.nase &&
         parseInt(document.getElementById('skore-jejich').textContent) === s.jejich;
}));

// prázdný set se neukazuje jako 0:0 vedle rozehraného
// hráčka nesmí být na obrazovce dvakrát — šla by z ní zapsat akce ze dvou míst
pass &= ok('T40i2 kdo stojí v zóně, není zároveň v pruhu libera (#84)',
  await page.evaluate(() => {
    const vZonach = [...postaveniSetu(100, state.liveSet).values()];
    const vPruhu = [...document.querySelectorAll('.hriste-mimo .hriste-zona.libero:not(.prazdna)')]
      .map(e => e.querySelector('.hriste-jmeno').textContent);
    const jmena = id => (state.hraci.find(h => h.id === id) || {}).jmeno;
    return vZonach.every(id => !vPruhu.includes(jmena(id)));
  }));

pass &= ok('T40j řádek po setech ukazuje jen sety s daty a ten rozehraný (#84)',
  await page.evaluate(() => {
    const videt = [...document.querySelectorAll('.skore-set')]
      .map(e => parseInt(e.textContent));
    return videt.every(i => setMaData(100, i) || i === state.liveSet) &&
           videt.includes(state.liveSet);
  }));

// kontrola proti Výsledku
pass &= ok('T40k bez zapsaného výsledku není co kontrolovat (#84)',
  await page.evaluate(() => {
    const z = state.zapasy.find(z => z.id === 100);
    delete z.set1_my; delete z.set1_oni;
    return kontrolaSkore(100, 1) === null;
  }));
pass &= ok('T40l shodný zápis se nehlásí (#84)', await page.evaluate(() => {
  const z = state.zapasy.find(z => z.id === 100), s = skoreSetu(100, 1);
  z.set1_my = s.nase; z.set1_oni = s.jejich;
  renderLive2(100);
  return kontrolaSkore(100, 1).sedi && !document.querySelector('.skore-nesedi');
}));
pass &= ok('T40m rozdíl se ukáže i s oběma čísly (#84)', await page.evaluate(() => {
  const z = state.zapasy.find(z => z.id === 100), s = skoreSetu(100, 1);
  z.set1_my = s.nase + 3; z.set1_oni = s.jejich;
  renderLive2(100);
  const k = kontrolaSkore(100, 1), el = document.querySelector('.skore-nesedi');
  return !k.sedi && k.rozdilMy === -3 && !!el &&
         el.textContent.includes(String(s.nase + 3)) && el.textContent.includes(String(s.nase));
}));

// a totéž u políček ve Výsledku, kde skóre zadáváš
await page.evaluate(() => editVysledek(100));
await page.waitForSelector('#modal-vysledek:not(.hidden)');
pass &= ok('T40n u políček Výsledku je vidět, co vychází z akcí (#84)',
  await page.evaluate(() => {
    const el = document.getElementById('odv-set1');
    const s = skoreSetu(100, 1);
    return !!el && el.textContent.includes(`${s.nase}:${s.jejich}`);
  }));
await page.click('#modal-vysledek .modal-footer .btn-secondary');
await page.evaluate(() => {
  const z = state.zapasy.find(z => z.id === 100);
  delete z.set1_my; delete z.set1_oni;
});


// ── #84 část 5: co vyšlo najevo při ostrém použití ─────────────────────────
await page.click('.nav-tab:nth-child(6)');                  // Live V2
await page.waitForSelector('.skore');
await page.click('#live2-wrap .set-prepinac button:nth-of-type(1)');
await page.waitForTimeout(300);
await page.evaluate(() => {
  state.postaveni = state.postaveni.filter(p => p.zapas_id !== 100);
  [10, 11, 12, 13].forEach((id, i) => state.postaveni.push(
    { zapas_id: 100, set_cislo: 1, zona: i + 1, hrac_id: id }));
  if (!v2Hriste) v2PrepniHriste(); else renderLive2(100);
});
await page.waitForSelector('.hriste-zona:not(.prazdna)');

// 1. rotace padala na unikátním indexu (zápas, set, hráčka)
postaveniRpc = []; otherWrites = [];
const predRotaciOstra = await page.evaluate(() =>
  Object.fromEntries([...postaveniSetu(100, 1).entries()]));
await page.evaluate(() => {
  const id = postaveniSetu(100, 1).get(3);
  v2OtevriAkce(100, id, 3);
});
await page.waitForSelector('#modal-v2-akce:not(.hidden)');
await page.click('#modal-v2-akce .v2-dlazdice[onclick*="servis_plus"]');
await page.waitForTimeout(700);
pass &= ok('T41a rotace se uloží a nejde po řádcích (#84)',
  postaveniRpc.length === 1 && !otherWrites.some(w => w.table === 'vb_postaveni'));
pass &= ok('T41b posílá se celé postavení, ne jen změněné zóny (#84)',
  postaveniRpc[0].pocet === Object.keys(predRotaciOstra).length);
pass &= ok('T41c a hráčka v něm není dvakrát (#84)', await page.evaluate(() => {
  const ids = [...postaveniSetu(100, 1).values()];
  return new Set(ids).size === ids.length;
}));

// 2. stav utkání
pass &= ok('T41d sety mají v hřišti vlastní dlaždici (#84)',
  /Sety/.test(await page.textContent('.hriste-dlazdice.dl-sety')));
pass &= ok('T41e rozehraný set se nepočítá jako vyhraný (#84)', await page.evaluate(() => {
  const z = state.zapasy.find(z => z.id === 100);
  for (let i = 1; i <= 5; i++) { delete z[`set${i}_my`]; delete z[`set${i}_oni`]; }
  z.set1_my = 20; z.set1_oni = 18;          // ještě se hraje
  return setRozhodnuty(100, 1) === null && stavUtkani(100).my === 0;
}));
pass &= ok('T41f set o dva body přes 25 se počítá (#84)', await page.evaluate(() => {
  const z = state.zapasy.find(z => z.id === 100);
  z.set1_my = 25; z.set1_oni = 23;
  z.set2_my = 22; z.set2_oni = 25;
  renderLive2(100);
  const u = stavUtkani(100);
  return u.my === 1 && u.oni === 1 &&
         document.querySelector('.hriste-dlazdice.dl-sety').textContent.includes('1:1');
}));
pass &= ok('T41g v pátém setu se hraje do patnácti (#84)', await page.evaluate(() => {
  const z = state.zapasy.find(z => z.id === 100);
  z.set5_my = 15; z.set5_oni = 12;
  return setRozhodnuty(100, 5) === 'my';
}));
pass &= ok('T41h set 25:24 ještě rozhodnutý není (#84)', await page.evaluate(() => {
  const z = state.zapasy.find(z => z.id === 100);
  z.set3_my = 25; z.set3_oni = 24;
  return setRozhodnuty(100, 3) === null;
}));
await page.evaluate(() => {
  const z = state.zapasy.find(z => z.id === 100);
  for (let i = 1; i <= 5; i++) { delete z[`set${i}_my`]; delete z[`set${i}_oni`]; }
  renderLive2(100);
});

// 3. síť vpravo
pass &= ok('T41i síť je vpravo od hřiště, ne nad ním (#84)', await page.evaluate(() => {
  const sit = document.querySelector('.hriste-sit').getBoundingClientRect();
  const hriste = document.querySelector('.hriste').getBoundingClientRect();
  return sit.left >= hriste.right - 1 && sit.height > sit.width;
}));
pass &= ok('T41j zóny u sítě jsou v pravém sloupci (#84)', await page.evaluate(() => {
  const stred = z => {
    const el = [...document.querySelectorAll('.hriste .hriste-zona')]
      .find(e => parseInt(e.querySelector('.hriste-cislo-zony').textContent) === z);
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2;
  };
  // 4-3-2 jsou u sítě, 5-6-1 vzadu
  return Math.min(stred(4), stred(3), stred(2)) > Math.max(stred(5), stred(6), stred(1));
}));

// 4. libero podle nominace, ne podle pozice
pass &= ok('T41k libero se pozná z nominace v sestavě (#84)', await page.evaluate(() => {
  const nominovana = state.zapasHraci.filter(zh => zh.zapas_id === 100 && zh.libero)
    .map(zh => zh.hrac_id);
  const vPruhu = [...document.querySelectorAll('.hriste-mimo .hriste-zona.libero .hriste-jmeno')]
    .map(e => e.textContent);
  const jmeno = id => state.hraci.find(h => h.id === id).jmeno;
  return nominovana.length > 0 && nominovana.every(id => vPruhu.includes(jmeno(id)));
}));
pass &= ok('T41l pozice „libero" v kartě hráčky o tom nerozhoduje (#84)',
  await page.evaluate(() => {
    const h = state.hraci.find(h => (h.pozice || '').toLowerCase() === 'libero' &&
      state.zapasHraci.some(zh => zh.zapas_id === 100 && zh.hrac_id === h.id && !zh.libero));
    const vPruhu = [...document.querySelectorAll('.hriste-mimo .hriste-zona.libero .hriste-jmeno')]
      .map(e => e.textContent);
    return !!h && !vPruhu.includes(h.jmeno);
  }));

// nominace jde přepnout z panelu akcí
otherWrites = [];
const kdoNaNominaci = await page.evaluate(() => {
  const zh = state.zapasHraci.find(zh => zh.zapas_id === 100 && !zh.libero);
  return zh.hrac_id;
});
await page.evaluate(id => v2OtevriAkce(100, id), kdoNaNominaci);
await page.waitForSelector('#modal-v2-akce:not(.hidden)');
pass &= ok('T41m panel akcí nabízí nominaci libera (#84)',
  /Libero/.test(await page.textContent('#btn-v2-libero')));
await page.click('#btn-v2-libero');
await page.waitForTimeout(600);
pass &= ok('T41n nominace se uloží do sestavy zápasu (#84)',
  otherWrites.some(w => w.table === 'vb_zapas_hraci' && w.body && w.body.libero === true) &&
  await page.evaluate(id => jeLibero(100, id), kdoNaNominaci));
pass &= ok('T41n2 nominace neposílá poradi, aby nepřepsala řazení (#84)',
  !otherWrites.some(w => w.table === 'vb_zapas_hraci' && w.body && 'poradi' in w.body));

pass &= ok('T41o nominovaná už na hřišti nestojí (#84)',
  await page.evaluate(id => ![...postaveniSetu(100, 1).values()].includes(id), kdoNaNominaci));
await page.evaluate(id => v2OtevriAkce(100, id), kdoNaNominaci);
await page.waitForSelector('#modal-v2-akce:not(.hidden)');
pass &= ok('T41p u nominované nabídne zrušení (#84)',
  /Zrušit libero/.test(await page.textContent('#btn-v2-libero')));
await page.click('#btn-v2-libero');
await page.waitForTimeout(600);
pass &= ok('T41q zrušení nominace se taky uloží (#84)',
  await page.evaluate(id => !jeLibero(100, id), kdoNaNominaci));


// ── #84 část 6: hřiště jako jeden grid ─────────────────────────────────────
await page.click('.nav-tab:nth-child(6)');
await page.waitForSelector('#live2-wrap');
await page.evaluate(() => { if (!v2Hriste) v2PrepniHriste(); });
await page.waitForSelector('.hriste-mimo');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);

const vyskyBloku = () => page.evaluate(() => {
  const w = document.getElementById('live2-wrap');
  const v = sel => { const e = w.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().height) : 0; };
  return { obal: Math.round(w.getBoundingClientRect().height),
           skorePruh: v(':scope > .skore'), souperPruh: v('.v2-souper'),
           plocha: v('.v2-seznam') };
});
const m = await vyskyBloku();

pass &= ok('T42a v hřišti zmizely pruhy se skóre i soupeřem (#84)',
  m.skorePruh === 0 && m.souperPruh === 0);
pass &= ok('T42a2 dlaždice a pruh se skóre si nelezou do třídy (#84)',
  await page.evaluate(() =>
    document.querySelectorAll('#live2-wrap > .skore').length === 0 &&
    document.querySelectorAll('.hriste-dlazdice.skore').length === 0));
pass &= ok('T42b na hřiště tím zbylo přes polovinu obalu (#84)',
  m.plocha / m.obal > 0.55);

pass &= ok('T42c sety i skóre mají vlastní dlaždice v levém sloupci (#84)',
  await page.evaluate(() => {
    const mimo = document.querySelector('.hriste-mimo').getBoundingClientRect();
    const hriste = document.querySelector('.hriste').getBoundingClientRect();
    return !!document.querySelector('.hriste-dlazdice.dl-sety') &&
           !!document.querySelector('.hriste-dlazdice.dl-skore') &&
           mimo.right <= hriste.left + 1;      // mimo hřiště, vlevo od zón
  }));

pass &= ok('T42d sloty libera jsou 7 a 8 a taky mimo hřiště (#84)',
  await page.evaluate(() => {
    const sloty = [...document.querySelectorAll('.hriste-mimo .hriste-zona.libero .hriste-cislo-zony')]
      .map(e => parseInt(e.textContent));
    const vHristi = [...document.querySelectorAll('.hriste .hriste-cislo-zony')]
      .map(e => parseInt(e.textContent));
    return JSON.stringify(sloty) === JSON.stringify([7, 8]) &&
           !vHristi.some(z => z > 6);
  }));

pass &= ok('T42e sloty libera nejsou v databázi, plynou z nominace (#84)',
  await page.evaluate(() => {
    const vPostaveni = state.postaveni.filter(p => p.zapas_id === 100).map(p => p.zona);
    return !vPostaveni.some(z => z > 6);
  }));

// prázdný slot nominuje
await page.evaluate(() => {
  state.zapasHraci.filter(zh => zh.zapas_id === 100).forEach(zh => { zh.libero = false; });
  renderLive2(100);
});
await page.waitForTimeout(200);
pass &= ok('T42f bez nominace jsou oba sloty prázdné (#84)',
  (await page.$$eval('.hriste-mimo .hriste-zona.libero.prazdna', els => els.length)) === 2);
otherWrites = [];
await page.click('.hriste-mimo .hriste-zona.libero.prazdna');
await page.waitForSelector('#modal-v2-zona:not(.hidden)');
pass &= ok('T42g klik na prázdný slot nabídne nominaci, ne postavení do zóny (#84)',
  /libero/i.test(await page.textContent('#v2-zona-title')));
await page.click('#v2-zona-obsah .player-card');
await page.waitForTimeout(600);
pass &= ok('T42h nominace ze slotu se uloží do sestavy (#84)',
  otherWrites.some(w => w.table === 'vb_zapas_hraci' && w.body && w.body.libero === true) &&
  (await page.$$eval('.hriste-mimo .hriste-zona.libero:not(.prazdna)', els => els.length)) === 1);
pass &= ok('T42i a nezapsala se přitom do vb_postaveni (#84)',
  !otherWrites.some(w => w.table === 'vb_postaveni'));

// dlaždice se skóre upravuje skóre mimo statistiku hráček
const predUpravou = await page.evaluate(() => skoreSetu(100, state.liveSet));
await page.click('.hriste-dlazdice.dl-skore');
await page.waitForSelector('#modal-v2-skore:not(.hidden)');
pass &= ok('T42j dlaždice skóre otevře úpravu s pojmenovanými akcemi (#84)',
  await page.evaluate(() => {
    const t = document.getElementById('v2-skore-obsah').textContent;
    return /Chyba soupeře/.test(t) && /Bod soupeře/.test(t) &&
           /náš bod/.test(t) && /jejich bod/.test(t);
  }));
chybyRpc = [];
await page.click('#v2-skore-obsah .skore-uprava-radek:first-child .btn-primary');
await page.waitForTimeout(600);
pass &= ok('T42k přidání bodu jde přes chybu soupeře, ne mimo statistiku (#84)',
  chybyRpc.length === 1 && chybyRpc[0].p_pole === 'pocet' && chybyRpc[0].p_delta === 1 &&
  await page.evaluate(p => skoreSetu(100, state.liveSet).nase === p.nase + 1, predUpravou));
pass &= ok('T42l hodnota v panelu se rovnou srovná (#84)',
  await page.evaluate(() =>
    parseInt(document.getElementById('skore-uprava-pocet').textContent) ===
    souperHodnota(100, state.liveSet, 'pocet')));
await page.click('#v2-skore-obsah .skore-uprava-radek:first-child .btn-secondary');
await page.waitForTimeout(600);
pass &= ok('T42m a jde to zase ubrat (#84)',
  await page.evaluate(p => skoreSetu(100, state.liveSet).nase === p.nase, predUpravou));
await page.click('#modal-v2-skore .modal-footer .btn-secondary');
await page.waitForTimeout(300);
pass &= ok('T42n dlaždice po zavření ukazuje srovnané skóre (#84)',
  await page.evaluate(() => {
    const s = skoreSetu(100, state.liveSet);
    return document.querySelector('.hriste-dlazdice.dl-skore .dlazdice-hodnota')
      .textContent.replace(/\s/g, '') === `${s.nase}:${s.jejich}`;
  }));

pass &= ok('T42n2 oba sloupce gridu končí na stejné čáře (#84)', await page.evaluate(() => {
  const mimo = document.querySelector('.hriste-mimo').getBoundingClientRect();
  const hriste = document.querySelector('.hriste').getBoundingClientRect();
  return Math.abs(mimo.bottom - hriste.bottom) <= 1 && Math.abs(mimo.top - hriste.top) <= 1;
}));
pass &= ok('T42n3 hřiště si bere jen svoje a pod ním zbývá místo (#84)',
  await page.evaluate(() => {
    const seznam = document.querySelector('.v2-seznam').getBoundingClientRect();
    const plocha = document.querySelector('.hriste-plocha').getBoundingClientRect();
    const info = document.querySelector('.hriste-info').getBoundingClientRect();
    return plocha.height < seznam.height * 0.8 && info.top >= plocha.bottom - 1;
  }));

pass &= ok('T42o všechno se pořád vejde na telefon (#84)', await page.evaluate(() => {
  const w = document.getElementById('live2-wrap');
  const seznam = w.querySelector('.v2-seznam');
  const zona = document.querySelector('.hriste .hriste-zona').getBoundingClientRect();
  return document.documentElement.scrollWidth - document.documentElement.clientWidth <= 0 &&
         seznam.scrollWidth - seznam.clientWidth <= 0 &&
         zona.width >= 44 && zona.height >= 44 &&
         document.querySelector('.hriste-dlazdice.dl-skore').getBoundingClientRect().height >= 44;
}));
await page.setViewportSize({ width: 1100, height: 900 });
await page.waitForTimeout(300);


// ── #84 část 7: menší hřiště, víc informací o zápase ───────────────────────
await page.click('.nav-tab:nth-child(6)');
await page.waitForSelector('#live2-wrap');
await page.evaluate(() => { if (!v2Hriste) v2PrepniHriste(); });
await page.waitForSelector('.hriste-info');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);

pass &= ok('T43a dlaždice se sety je nižší než ta se skóre (#84)',
  await page.evaluate(() => {
    const sety = document.querySelector('.dl-sety').getBoundingClientRect();
    const skore = document.querySelector('.dl-skore').getBoundingClientRect();
    return sety.height < skore.height;
  }));
pass &= ok('T43b zóna zůstala použitelným cílem (#84)',
  await page.evaluate(() => {
    const z = document.querySelector('.hriste .hriste-zona').getBoundingClientRect();
    return z.height >= 60 && z.width >= 44;
  }));

// řádek po setech a hlídání proti Výsledku v hřišti vypadly — musí být zpátky
pass &= ok('T43c v hřišti je vidět průběh po setech (#84)',
  await page.evaluate(() => {
    const videt = [...document.querySelectorAll('.hriste-info .skore-set')]
      .map(e => parseInt(e.textContent));
    return videt.length > 0 && videt.includes(state.liveSet) &&
           videt.every(i => setMaData(100, i) || i === state.liveSet);
  }));
pass &= ok('T43d a hodnoty soupeřovy strany taky (#84)',
  await page.evaluate(() => {
    const t = document.querySelector('.hriste-info-souper').textContent;
    return t.includes(String(souperHodnota(100, state.liveSet, 'pocet'))) &&
           t.includes(String(souperHodnota(100, state.liveSet, 'body')));
  }));

pass &= ok('T43e shodné skóre se v hřišti nehlásí (#84)', await page.evaluate(() => {
  const z = state.zapasy.find(z => z.id === 100), s = skoreSetu(100, state.liveSet);
  z[`set${state.liveSet}_my`] = s.nase; z[`set${state.liveSet}_oni`] = s.jejich;
  renderLive2(100);
  return !document.querySelector('.hriste-info .skore-nesedi');
}));
pass &= ok('T43f rozdíl proti Výsledku je vidět i v hřišti (#84)', await page.evaluate(() => {
  const z = state.zapasy.find(z => z.id === 100), s = skoreSetu(100, state.liveSet);
  z[`set${state.liveSet}_my`] = s.nase + 4;
  renderLive2(100);
  const el = document.querySelector('.hriste-info .skore-nesedi');
  return !!el && el.textContent.includes(String(s.nase + 4)) &&
         el.textContent.includes(String(s.nase));
}));
await page.evaluate(() => {
  const z = state.zapasy.find(z => z.id === 100);
  for (let i = 1; i <= 5; i++) { delete z[`set${i}_my`]; delete z[`set${i}_oni`]; }
  renderLive2(100);
});

pass &= ok('T43h týmový souhrn je v hřišti dole u informací, ne dalším pruhem (#84)',
  await page.evaluate(() => {
    const w = document.getElementById('live2-wrap');
    const vInfo = document.querySelector('.hriste-info .v2-tym');
    const jakoPruh = [...w.children].some(e => e.classList.contains('v2-tym'));
    return !!vInfo && !jakoPruh &&
           vInfo.getBoundingClientRect().top > document.querySelector('.hriste').getBoundingClientRect().top;
  }));
pass &= ok('T43i v seznamu souhrn zůstává nahoře (#84)', await page.evaluate(() => {
  v2PrepniHriste();                                  // přepnout na seznam
  const w = document.getElementById('live2-wrap');
  const jakoPruh = [...w.children].some(e => e.classList.contains('v2-tym'));
  v2PrepniHriste();                                  // a zpátky
  return jakoPruh;
}));

pass &= ok('T43g nic z toho stránku nepřetéká (#84)', await page.evaluate(() => {
  const seznam = document.querySelector('.v2-seznam');
  return document.documentElement.scrollWidth - document.documentElement.clientWidth <= 0 &&
         seznam.scrollWidth - seznam.clientWidth <= 0;
}));
await page.setViewportSize({ width: 1100, height: 900 });
await page.waitForTimeout(300);

await b.close();
console.log(pass ? '\nVŠE PROŠLO' : '\nNĚCO SELHALO');
process.exit(pass ? 0 : 1);
