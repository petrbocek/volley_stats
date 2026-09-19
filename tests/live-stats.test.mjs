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
             { id: 13, jmeno: JMENO_SE_STREDNIKEM, cislo: 4, pozice: 'smečař', aktivni: true }],
  vb_hraci_sezony: [{ hrac_id: 10, sezona_id: 1 }, { hrac_id: 11, sezona_id: 1 },
                    { hrac_id: 12, sezona_id: 1 }, { hrac_id: 13, sezona_id: 1 },
                    { hrac_id: 10, sezona_id: 2 }],
  vb_zapasy: [{ id: 100, sezona_id: 1, soutez_id: 7, datum: '2026-09-10', soupet: 'Soupeř A', misto: 'doma', stav: 'probihajici' },
              { id: 200, sezona_id: 2, datum: '2025-03-01', soupet: 'Soupeř B', misto: 'venku', stav: 'dokonceny', sety_my: 3, sety_oni: 1 }],
  vb_tymy: [{ id: 5, nazev: TYM_S_XSS }],
  vb_hraci_tymy: [{ hrac_id: 12, tym_id: 5 }],
  vb_souteze: [{ id: 7, sezona_id: 1, nazev: SOUTEZ_S_XSS }],
  vb_zapas_hraci: [{ zapas_id: 100, hrac_id: 10 }, { zapas_id: 100, hrac_id: 11 },
                   { zapas_id: 100, hrac_id: 12 }, { zapas_id: 100, hrac_id: 13 },
                   { zapas_id: 200, hrac_id: 10 }],
};

// stav "databáze" statistik, na který RPC aplikuje delty
const db = new Map();                       // "zapas_hrac" -> { pole: hodnota }
const radek = (z, h) => {
  const k = `${z}_${h}`;
  if (!db.has(k)) db.set(k, { zapas_id: z, hrac_id: h });
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
  otherWrites.push({ table, method: req.method(), url: req.url() });
  if (req.method() === 'DELETE') {
    const q = new URL(req.url()).search;
    const z = /zapas_id=eq\.(\d+)/.exec(q), h = /hrac_id=eq\.(\d+)/.exec(q);
    if (table === 'vb_statistiky' && z && h) db.delete(`${z[1]}_${h[1]}`);
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

// ── #35: text z databáze se nesmí vyhodnotit jako HTML ─────────────────────
await page.selectOption('#season-select', '1');
await page.waitForTimeout(300);
for (const tab of [1, 2, 3, 5]) {          // Přehled, Zápasy, Tým, Statistiky
  await page.click(`.nav-tab:nth-child(${tab})`);
  await page.waitForTimeout(150);
}
await page.click('.nav-tab:nth-child(4)');
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
await page.click('.nav-tab:nth-child(3)');
await page.waitForTimeout(200);
const tymTitul = await page.textContent('.tym-card-title');
pass &= ok('T13d název týmu se v kartě vypíše doslova (#35)', tymTitul === TYM);
const clen = await page.textContent('.tym-member');
pass &= ok('T13e jméno člena týmu se vypíše doslova (#35)', clen === JMENO);

await page.click('.nav-tab:nth-child(5)');
await page.waitForTimeout(200);
const volby = await page.$$eval('#stats-hrac-sel option', els => els.map(e => e.textContent));
pass &= ok('T13f jméno ve filtru statistik se vypíše doslova (#35)', volby.includes(JMENO));

// ── #30: odebrání ze sestavy se ptá a nemlčí o statistikách ────────────────
await page.selectOption('#season-select', '1');
await page.waitForTimeout(200);
await page.click('.nav-tab:nth-child(4)');
await page.waitForSelector('#cnt-11-servis_plus');

// hráčka BEZ zaznamenaných akcí — prostý dotaz, bez nabídky mazat statistiky
db.delete('100_11');
await page.evaluate(() => {
  delete dirtyStats['100_11'];
  delete pendingDeltas['100_11'];
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
await page.evaluate(() => { delete dirtyStats['100_11']; refreshLiveStats(); });
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
  db.has('100_11'));

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
  !db.has('100_11'));

// ── #39: karta hráčky vypadá stejně na všech třech místech ─────────────────
// Historicky se mapování pozice na CSS třídu opisovalo zvlášť v každé kopii,
// takže přidání Blokaře se muselo opravovat třikrát.
const kartaPozice = async (sel) => page.$$eval(sel, els => els.map(e => ({
  jmeno: e.querySelector('.player-name')?.textContent,
  pozice: e.querySelector('.player-pos')?.textContent,
  trida: e.querySelector('.player-pos')?.className,
  maCislo: !!e.querySelector('.player-num'),
})));

await page.click('.nav-tab:nth-child(3)');                    // Tým
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

await page.click('.nav-tab:nth-child(4)');                    // Live → picker
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
await page.click('.nav-tab:nth-child(4)');               // Live drží zápas 100
await page.waitForTimeout(200);
await page.evaluate(() => refreshLiveStats());           // dotáhnout nová data
await page.waitForTimeout(300);
await page.click('.nav-tab:nth-child(5)');
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

// ── #36: profil hráčky ─────────────────────────────────────────────────────
// druhý zápas hráčce 13, ať je z čeho kreslit vývoj
FIX.vb_zapasy.push({ id: 101, sezona_id: 1, datum: '2026-09-17', soupet: 'Soupeř C', misto: 'venku', stav: 'dokonceny', sety_my: 3, sety_oni: 0 });
FIX.vb_zapas_hraci.push({ zapas_id: 101, hrac_id: 13 });
Object.assign(radek(101, 13), { utok_plus: 2, utok_minus: 6, utok_neutral: 2, prijem_plus: 1, prijem_minus: 3, servis_plus: 1 });
await page.reload();
await nactenoOK();
await page.click('.nav-tab:nth-child(5)');
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
    const ids = state.statistiky.map(s => `${s.zapas_id}_${s.hrac_id}`);
    return new Set(ids).size === ids.length;
  }));

pass &= ok('žádná chyba v konzoli', errors.length === 0);
if (errors.length) console.log(errors);

await b.close();
console.log(pass ? '\nVŠE PROŠLO' : '\nNĚCO SELHALO');
process.exit(pass ? 0 : 1);
