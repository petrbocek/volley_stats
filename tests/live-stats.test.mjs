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
              { id: 102, sezona_id: 1, datum: '2026-10-05', soupet: 'Soupeř D', misto: 'doma', stav: 'planovany' },
              { id: 200, sezona_id: 2, datum: '2025-03-01', soupet: 'Soupeř B', misto: 'venku', stav: 'dokonceny', sety_my: 3, sety_oni: 1 }],
  vb_tymy: [{ id: 5, nazev: TYM_S_XSS, sezona_id: 1 },
            { id: 6, nazev: 'Loňský tým', sezona_id: 2 }],
  vb_hraci_tymy: [{ hrac_id: 12, tym_id: 5 }, { hrac_id: 10, tym_id: 6 }],
  vb_souteze: [{ id: 7, sezona_id: 1, nazev: SOUTEZ_S_XSS }],
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
const klikSet = n => page.click(`.set-prepinac button:nth-of-type(${n})`);
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

// ── #32: statistiky po setech ──────────────────────────────────────────────
await page.selectOption('#season-select', '1');
await page.waitForTimeout(200);
await page.click('.nav-tab:nth-child(4)');
await page.waitForSelector('#cnt-10-servis_plus');

pass &= ok('T20a Live má přepínač setů (#32)',
  (await page.$$eval('.set-btn', els => els.length)) === 5);
pass &= ok('T20b ve výchozím stavu je aktivní první set (#32)',
  (await page.textContent('.set-btn.aktivni')).trim() === '1');

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
await page.click('.nav-tab:nth-child(5)');
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
await page.click('.nav-tab:nth-child(4)');
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

// ── #41: mazání a archivace hráček ─────────────────────────────────────────
// hráčka bez jediné akce — tu jde smazat úplně
FIX.vb_hraci.push({ id: 20, jmeno: 'Překlep', cislo: 99, pozice: 'smečař', aktivni: true });
FIX.vb_hraci_sezony.push({ hrac_id: 20, sezona_id: 1 });
await page.reload();
await nactenoOK();
await page.click('.nav-tab:nth-child(3)');
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
await page.click('.nav-tab:nth-child(4)');
await page.waitForTimeout(200);
await page.evaluate(() => { state.zapasHraci = state.zapasHraci.filter(z => !(z.zapas_id === 100 && z.hrac_id === 10)); renderLiveTable(100); });
await page.evaluate(() => openHracPicker(100));
await page.waitForTimeout(200);
pass &= ok('T21h archivovaná se nenabízí do sestavy (#41)',
  !(await page.textContent('#hrac-picker-list')).includes('Alfa'));
await page.click('#modal-hrac-picker .btn-secondary');

// obnovení
await page.click('.nav-tab:nth-child(3)');
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
await page.click('.nav-tab:nth-child(4)');
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
await page.click('.nav-tab:nth-child(3)');                  // Tým
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
await page.click('#tab-tym button:has-text("Nový tým")');
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
await page.click('.nav-tab:nth-child(3)');
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

await b.close();
console.log(pass ? '\nVŠE PROŠLO' : '\nNĚCO SELHALO');
process.exit(pass ? 0 : 1);
