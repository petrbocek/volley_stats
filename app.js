const SB_URL='https://cqcjdslqygayijxfhzof.supabase.co';
const SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNxY2pkc2xxeWdheWlqeGZoem9mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyNDYxMTcsImV4cCI6MjA5MzgyMjExN30.8RxdnXDybGehH9pMKxNkJuXw5f_vIGjfSRE_-tJciK0';

const ACTIONS=[
  {key:'servis',label:'Servis',icon:'🎯',color:'#4dabf7'},
  {key:'prijem',label:'Příjem',icon:'🤲',color:'#51cf66'},
  {key:'utok',label:'Útok',icon:'💥',color:'#f97316'},
  {key:'blok',label:'Blok',icon:'🛡️',varianty:['plus'],color:'#7950f2'},
  {key:'chyba',label:'Chyba',icon:'❌',varianty:['minus'],color:'#ff6b6b'},
];
const VARIANTS=[
  {suf:'plus',sym:'+',cls:'plus'},
  {suf:'neutral',sym:'/',cls:'neutral'},
  {suf:'minus',sym:'−',cls:'minus'},
];

const state={sezony:[],activeSeason:null,hraci:[],hraciSezony:[],zapasy:[],statistiky:[],tymy:[],hraciTymy:[],souteze:[],zapasHraci:[],liveZapasId:null};
const debounceMap={};
const dirtyStats={};
// dirtyStats drží zobrazenou hodnotu řádku pro každou vykreslenou hráčku (viz
// ensureStat), i tu bez jediného kliku. pendingDeltas proto drží zvlášť jen to,
// co se ještě neodeslalo — jinak by flush založil nulové řádky celé sestavě.
//
// Posílají se změny (±1), ne absolutní hodnoty: při dvou zapisovatelích
// u jednoho zápasu by upsert celého řádku přebil kliky toho druhého (#27).
const pendingDeltas={};          // `${zapasId}_${hracId}` -> { pole: delta }
const STAT_FLUSH_MS=300;
const LIVE_REFRESH_MS=10000;     // dorovnání s druhým zařízením
let liveRefreshTimer=null;

function hasPending(key){
  const d=pendingDeltas[key];
  return !!d&&Object.keys(d).length>0;
}
function pendingKeys(){
  return Object.keys(pendingDeltas).filter(hasPending);
}

/* ─── PŘIHLÁŠENÍ ───
   Čtení je veřejné, zápis smí jen přihlášený zapisovatel (viz supabase/README.md).
   Token držíme sami, bez supabase-js — appka jinak nemá žádné závislosti. */
const AUTH={token:null,refresh:null,expires:0,email:null};

function authLoad(){
  try{const r=JSON.parse(localStorage.getItem('vb_auth')||'null');if(r)Object.assign(AUTH,r);}catch(e){}
}
function authSave(){
  try{localStorage.setItem('vb_auth',JSON.stringify(AUTH));}catch(e){}
}
function authClear(){
  AUTH.token=null;AUTH.refresh=null;AUTH.expires=0;AUTH.email=null;
  try{localStorage.removeItem('vb_auth');}catch(e){}
}
function isLoggedIn(){return !!AUTH.token;}

async function authLogin(email,password){
  const r=await fetch(`${SB_URL}/auth/v1/token?grant_type=password`,{
    method:'POST',
    headers:{'apikey':SB_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({email,password})
  });
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error_description||d.msg||d.message||'Přihlášení se nepovedlo');
  AUTH.token=d.access_token;AUTH.refresh=d.refresh_token;
  AUTH.expires=Date.now()+((d.expires_in||3600)*1000);
  AUTH.email=(d.user&&d.user.email)||email;
  authSave();
}

async function authRefresh(){
  if(!AUTH.refresh)return false;
  try{
    const r=await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`,{
      method:'POST',
      headers:{'apikey':SB_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({refresh_token:AUTH.refresh})
    });
    if(!r.ok){authClear();return false;}
    const d=await r.json();
    AUTH.token=d.access_token;AUTH.refresh=d.refresh_token||AUTH.refresh;
    AUTH.expires=Date.now()+((d.expires_in||3600)*1000);
    authSave();
    return true;
  }catch(e){return false;}
}

// Token obnovujeme minutu předem, ať uprostřed zápisu nevyprší.
async function bearer(){
  if(!AUTH.token)return 'Bearer '+SB_KEY;
  if(Date.now()>AUTH.expires-60000&&!await authRefresh())return 'Bearer '+SB_KEY;
  return 'Bearer '+AUTH.token;
}

function requireLogin(method){
  if(method!=='GET'&&!isLoggedIn()){
    throw new Error('Na změny se musíš přihlásit (tlačítko 🔒 nahoře).');
  }
}

async function authHeaders(method,extra){
  requireLogin(method);
  return Object.assign({'apikey':SB_KEY,'Authorization':await bearer()},extra||{});
}

async function api(method,path,body){
  const r=await fetch(SB_URL+'/rest/v1/'+path,{
    method,
    headers:await authHeaders(method,{'Content-Type':'application/json','Prefer':'return=representation'}),
    body:body?JSON.stringify(body):undefined
  });
  if(!r.ok){const e=await r.text();throw new Error(e);}
  const t=r.status===204?null:await r.json();
  return t;
}
async function apiUpsert(table,body,conflict,opts={}){
  const r=await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${conflict}`,{
    method:'POST',
    headers:await authHeaders('POST',{'Content-Type':'application/json','Prefer':'resolution=merge-duplicates,return=representation'}),
    body:JSON.stringify(body),
    keepalive:!!opts.keepalive
  });
  if(!r.ok){const e=await r.text();throw new Error(e);}
  return r.status===204?null:await r.json();
}
// PostgREST vrací nejvýš max-rows (u Supabase 1000) a přebytek zahodí BEZ chyby,
// takže by appka tiše počítala statistiky z neúplných dat. Čteme proto po
// stránkách přes hlavičku Range, dokud nepřijde neúplná stránka.
const STRANKA=1000;
const MAX_STRANEK=100;       // pojistka proti nekonečné smyčce

async function apiAll(path){
  const [table,query]=path.split('?');
  let od=0,vse=[];
  for(let i=0;i<MAX_STRANEK;i++){
    const url=`${SB_URL}/rest/v1/${table}${query?'?'+query:''}`;
    const r=await fetch(url,{
      headers:Object.assign(await authHeaders('GET'),
        {'Range-Unit':'items','Range':`${od}-${od+STRANKA-1}`})
    });
    if(!r.ok){const e=await r.text();throw new Error(e);}
    const cast=r.status===204?[]:await r.json();
    vse=vse.concat(cast);
    if(cast.length<STRANKA)return vse;
    od+=STRANKA;
  }
  toast(`Tabulka ${table} je větší než ${MAX_STRANEK*STRANKA} řádků, načetla se jen část`,'error');
  return vse;
}

async function apiRpc(fn,args,opts={}){
  const r=await fetch(`${SB_URL}/rest/v1/rpc/${fn}`,{
    method:'POST',
    headers:await authHeaders('POST',{'Content-Type':'application/json'}),
    body:JSON.stringify(args),
    keepalive:!!opts.keepalive
  });
  if(!r.ok){const e=await r.text();throw new Error(e);}
  return r.status===204?null:await r.json();
}
async function apiDelete(table,query){
  const r=await fetch(`${SB_URL}/rest/v1/${table}?${query}`,{
    method:'DELETE',
    headers:await authHeaders('DELETE')
  });
  if(!r.ok){const e=await r.text();throw new Error(e);}
}
async function apiPatch(table,id,body){
  const r=await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${id}`,{
    method:'PATCH',
    headers:await authHeaders('PATCH',{'Content-Type':'application/json','Prefer':'return=representation'}),
    body:JSON.stringify(body)
  });
  if(!r.ok){const e=await r.text();throw new Error(e);}
  return r.status===204?null:await r.json();
}

async function init(){
  try{
    const [sez,hr,hs,zap,stat,tym,ht,sout,zh]=await Promise.all([
      // Řazení musí být jednoznačné, jinak může stránkování řádky přeskočit
      // nebo zopakovat — proto všude rozhodující sloupec navíc.
      apiAll('vb_sezony?order=id.desc'),
      apiAll('vb_hraci?order=jmeno.asc,id.asc'),
      apiAll('vb_hraci_sezony?order=hrac_id.asc,sezona_id.asc'),
      apiAll('vb_zapasy?order=datum.desc,id.asc'),
      apiAll('vb_statistiky?order=id.asc'),
      apiAll('vb_tymy?order=nazev.asc,id.asc'),
      apiAll('vb_hraci_tymy?order=hrac_id.asc,tym_id.asc'),
      apiAll('vb_souteze?order=nazev.asc,id.asc'),
      apiAll('vb_zapas_hraci?order=zapas_id.asc,hrac_id.asc'),
    ]);
    state.sezony=sez||[];
    state.hraci=hr||[];
    state.hraciSezony=hs||[];
    state.zapasy=zap||[];
    state.statistiky=stat||[];
    state.tymy=tym||[];
    state.hraciTymy=ht||[];
    state.souteze=sout||[];
    state.zapasHraci=zh||[];
    state.activeSeason=(sez||[]).find(s=>s.aktivni)||null;
    renderSeasonSelect();
    renderAll();
  }catch(e){toast('Chyba načítání: '+e.message,'error');}
  finally{document.getElementById('loading').classList.add('hidden');}
}

function renderSeasonSelect(){
  const sel=document.getElementById('season-select');
  sel.innerHTML='<option value="">— žádná sezóna —</option>';
  state.sezony.forEach(s=>{
    const o=document.createElement('option');
    o.value=s.id;
    o.textContent=s.nazev+(s.aktivni?' ★':'');
    if(state.activeSeason&&s.id===state.activeSeason.id)o.selected=true;
    sel.appendChild(o);
  });
}

function currentSeasonId(){
  const v=document.getElementById('season-select').value;
  return v?parseInt(v):null;
}

function onSeasonChange(){
  flushAllStats();
  const id=currentSeasonId();
  state.activeSeason=state.sezony.find(s=>s.id===id)||null;
  // bez resetu by renderLiveSelect() sáhl po zápasu z předchozí sezóny
  state.liveZapasId=null;
  const liveSel=document.getElementById('live-zapas-select');
  if(liveSel)liveSel.value='';
  renderAll();
}

function renderAll(){
  renderPrehled();
  renderZapasy();
  renderTym();
  renderLiveSelect();
  renderStatistiky();
}

/* Text z databáze jde do innerHTML, takže se musí escapovat: jméno s '&'
   nebo '<' by jinak rozbilo zobrazení řádku, a protože do tabulek zapisuje
   víc lidí, je to i cesta, jak do appky dostat cizí skript.
   Čísla a ID interpolovaná do onclick projdou přes parseInt, ta jsou v pořádku. */
const ESC={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
function esc(v){
  if(v===null||v===undefined)return '';
  return String(v).replace(/[&<>"']/g,c=>ESC[c]);
}

/* ─── PŘEHLED ─── */
function renderPrehled(){
  const sid=currentSeasonId();
  const el=document.getElementById('prehled-content');
  if(!sid){el.innerHTML='<div class="empty"><span class="empty-icon">📊</span><div class="empty-text">Vyberte sezónu nahoře</div></div>';return;}
  const zapasy=state.zapasy.filter(z=>z.sezona_id===sid);
  const done=zapasy.filter(z=>z.stav==='dokonceny');
  const wins=done.filter(z=>z.sety_my>z.sety_oni).length;
  const losses=done.filter(z=>z.sety_my<z.sety_oni).length;
  const sezNazev=state.sezony.find(s=>s.id===sid)?.nazev||'—';

  el.innerHTML=`
    <div class="card" style="border-color:var(--accent);margin-bottom:16px">
      <div style="font-family:'Oswald',sans-serif;font-size:22px;font-weight:700;color:var(--accent)">${esc(sezNazev)}</div>
      <div style="color:var(--muted);font-size:13px;margin-top:4px">${hraciVSezoně(sid).length} hráček v soupisce</div>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-icon">🏐</div><div class="stat-val">${zapasy.length}</div><div class="stat-label">Zápasy</div></div>
      <div class="stat-card"><div class="stat-icon">✅</div><div class="stat-val" style="color:var(--green)">${wins}</div><div class="stat-label">Výhry</div></div>
      <div class="stat-card"><div class="stat-icon">❌</div><div class="stat-val" style="color:var(--red)">${losses}</div><div class="stat-label">Porážky</div></div>
      <div class="stat-card"><div class="stat-icon">📊</div><div class="stat-val">${done.length?Math.round(wins/done.length*100)+'%':'—'}</div><div class="stat-label">Úspěšnost</div></div>
    </div>
    <div class="section-title">Poslední zápasy</div>
    ${done.slice(0,5).map(z=>matchHtml(z)).join('')||'<div class="empty" style="padding:20px"><span class="empty-icon" style="font-size:24px">—</span><div>Zatím žádné dokončené zápasy</div></div>'}
  `;
}

/* ─── ZÁPASY ─── */
function renderZapasy(){
  const sid=currentSeasonId();
  const el=document.getElementById('zapasy-list');
  const list=sid?state.zapasy.filter(z=>z.sezona_id===sid):state.zapasy;
  if(!list.length){el.innerHTML='<div class="empty"><span class="empty-icon">🏆</span><div class="empty-text">Žádné zápasy</div><div>Přidej první zápas</div></div>';return;}
  el.innerHTML=list.map(z=>matchHtml(z,true)).join('');
}

function matchHtml(z,withActions=false){
  const win=z.stav==='dokonceny'&&z.sety_my>z.sety_oni;
  const lose=z.stav==='dokonceny'&&z.sety_my<z.sety_oni;
  const score=z.stav==='dokonceny'&&z.sety_my!=null?`<span class="match-score ${win?'win':lose?'lose':''}">${z.sety_my}:${z.sety_oni}</span>`:'<span class="match-score" style="color:var(--muted)">—:—</span>';
  const badge=`<span class="match-badge badge-${z.stav==='probihajici'?'probiha':z.stav==='dokonceny'?'dokonceny':'planovany'}">${stavLabel(z.stav)}</span>`;
  const misto=z.misto==='doma'?'🏠 Doma':z.misto==='venku'?'✈️ Venku':'⚖️ Neutrál';
  const soutez=state.souteze.find(s=>s.id===z.soutez_id);
  const tym=state.tymy.find(t=>t.id===z.tym_id);
  let actions='';
  if(withActions){
    if(z.stav==='planovany')actions=`<button class="btn btn-sm btn-primary" onclick="goLive(${z.id})">⚡ Live</button><button class="btn btn-sm btn-secondary" onclick="editVysledek(${z.id})">📝 Výsledek</button><button class="btn btn-sm btn-red" onclick="deleteZapas(${z.id})">🗑️</button>`;
    else if(z.stav==='probihajici')actions=`<button class="btn btn-sm btn-primary" onclick="goLive(${z.id})">⚡ Live</button><button class="btn btn-sm btn-green" onclick="editVysledek(${z.id})">✓ Ukončit</button>`;
    else actions=`<button class="btn btn-sm btn-secondary" onclick="editVysledek(${z.id})">✏️ Upravit</button><button class="btn btn-sm btn-red" onclick="deleteZapas(${z.id})">🗑️</button>`;
  }
  return `<div class="match-item">
    <div class="match-date">${fmtDate(z.datum)}${z.cas?'<br><span style="font-size:11px">'+z.cas.slice(0,5)+'</span>':''}</div>
    ${score}
    <div style="flex:1;min-width:120px"><div class="match-vs">${esc(z.soupet)}</div><div class="match-misto">${misto}${tym?` · <span style="color:var(--purple)">${esc(tym.nazev)}</span>`:''}${soutez?` · <span style="color:var(--accent2)">${esc(soutez.nazev)}</span>`:''}</div></div>
    ${badge}
    ${withActions?`<div class="match-actions">${actions}</div>`:''}
  </div>`;
}

function stavLabel(s){return s==='planovany'?'Plánovaný':s==='probihajici'?'Probíhá':'Dokončený';}
function fmtDate(d){if(!d)return'—';const p=d.split('-');return`${p[2]}.${p[1]}.${p[0]}`;}

/* ─── TÝM ─── */
function hraciVSezoně(sid){
  if(!sid)return state.hraci;
  const ids=state.hraciSezony.filter(hs=>hs.sezona_id===sid).map(hs=>hs.hrac_id);
  return state.hraci.filter(h=>ids.includes(h.id));
}
function isHracInSezona(hracId,sid){
  return state.hraciSezony.some(hs=>hs.hrac_id===hracId&&hs.sezona_id===sid);
}

function renderTym(){
  const sid=currentSeasonId();
  const el=document.getElementById('hraci-list');
  const note=document.getElementById('tym-season-note');
  if(sid){note.textContent='Přepínačem aktivujete/deaktivujete hráčku pro vybranou sezónu.';}
  else{note.textContent='Zobrazeni všichni hráči. Vyberte sezónu pro správu soupisky.';}
  if(!state.hraci.length){el.innerHTML='<div class="empty"><span class="empty-icon">👥</span><div class="empty-text">Žádné hráčky</div></div>';return;}
  const active=sid?hraciVSezoně(sid):state.hraci;
  const inactive=sid?state.hraci.filter(h=>!active.includes(h)):[];
  let html='';
  if(sid){html+='<div class="section-title">V soupisce ('+active.length+')</div>';}
  html+=active.map(h=>playerCardHtml(h,sid,true)).join('');
  if(sid&&inactive.length){
    html+='<div class="section-title" style="margin-top:20px">Mimo soupisku</div>';
    html+=inactive.map(h=>playerCardHtml(h,sid,false)).join('');
  }
  el.innerHTML=html||'<div class="empty"><span class="empty-icon">👥</span><div class="empty-text">Žádné hráčky</div></div>';
  renderTymy();
}

// Karta hráčky se kreslí na třech místech (soupiska, výběr do sestavy, správa
// týmu) a lišila se jen obalem a tlačítky vpravo. Mapování pozice na CSS třídu
// bylo v každé kopii opsané znovu, takže přidání Blokaře se muselo opravovat
// třikrát.
const POZICE_TRIDA={'nahrávač':'nahravac','libero':'libero','universál':'universal',
                    'blokař':'blokar','smečař':'smec'};
function poziceTrida(pozice){return 'pos-'+(POZICE_TRIDA[pozice]||'smec');}

function playerCard(h,{tridy='',atributy='',ovladani=''}={}){
  const cislo=h.cislo
    ?`<div class="player-num">${h.cislo}</div>`
    :`<div class="player-num no-num">?</div>`;
  return `<div class="player-card ${tridy}" ${atributy}>
    ${cislo}
    <div class="player-info">
      <div class="player-name">${esc(h.jmeno)}</div>
      <div class="player-pos ${poziceTrida(h.pozice)}">${esc(h.pozice)||'—'}</div>
    </div>
    ${ovladani}
  </div>`;
}

function playerCardHtml(h,sid,inSeason){
  const toggle=sid?`<button class="btn btn-sm ${inSeason?'btn-red':'btn-green'}" style="flex-shrink:0" onclick="toggleHracSezona(${h.id},${sid},${inSeason})">${inSeason?'Odebrat':'+ Přidat'}</button>`:'';
  return playerCard(h,{
    tridy:sid&&!inSeason?'inactive':'',
    atributy:`id="pc-${h.id}"`,
    ovladani:`<button class="btn btn-sm btn-secondary" style="flex-shrink:0" onclick="editHrac(${h.id})">✏️</button>${toggle}`
  });
}

async function toggleHracSezona(hracId,sezonaId,inSeason){
  try{
    if(inSeason){
      await apiDelete('vb_hraci_sezony',`hrac_id=eq.${hracId}&sezona_id=eq.${sezonaId}`);
      state.hraciSezony=state.hraciSezony.filter(hs=>!(hs.hrac_id===hracId&&hs.sezona_id===sezonaId));
    }else{
      await apiUpsert('vb_hraci_sezony',{hrac_id:hracId,sezona_id:sezonaId},'hrac_id,sezona_id');
      if(!state.hraciSezony.some(hs=>hs.hrac_id===hracId&&hs.sezona_id===sezonaId)){
        state.hraciSezony.push({hrac_id:hracId,sezona_id:sezonaId});
      }
    }
    renderTym();renderPrehled();renderLiveSelect();
  }catch(e){toast('Chyba: '+e.message,'error');}
}

/* ─── LIVE ─── */
function renderLiveSelect(){
  const sid=currentSeasonId();
  const sel=document.getElementById('live-zapas-select');
  const zapasy=sid?state.zapasy.filter(z=>z.sezona_id===sid):state.zapasy;
  const prev=parseInt(sel.value)||state.liveZapasId||0;
  sel.innerHTML='<option value="">— vyberte zápas —</option>';
  zapasy.forEach(z=>{
    const o=document.createElement('option');
    o.value=z.id;
    o.textContent=`${fmtDate(z.datum)} — ${z.soupet} [${stavLabel(z.stav)}]`;
    if(prev===z.id)o.selected=true;
    sel.appendChild(o);
  });
  // Auto-select: probíhající → plánovaný → první
  if(!sel.value&&zapasy.length){
    const best=zapasy.find(z=>z.stav==='probihajici')||zapasy.find(z=>z.stav==='planovany')||zapasy[0];
    if(best)sel.value=best.id;
  }
  if(sel.value){
    const id=parseInt(sel.value);
    state.liveZapasId=id;
    const z=state.zapasy.find(z=>z.id===id);
    document.getElementById('btn-start-zapas').style.display=z?.stav==='planovany'?'':'none';
    document.getElementById('btn-end-zapas').style.display=z?.stav==='probihajici'?'':'none';
    renderLiveTable(id);
  }else{
    // Sezóna bez zápasů: bez téhle větve by na obrazovce zůstala tabulka
    // předchozího zápasu a liveZapasId by ukazoval do cizí sezóny.
    state.liveZapasId=null;
    document.getElementById('btn-start-zapas').style.display='none';
    document.getElementById('btn-end-zapas').style.display='none';
    document.getElementById('live-table-wrap').innerHTML='<div class="empty"><span class="empty-icon">⚡</span><div class="empty-text">V této sezóně nejsou žádné zápasy</div></div>';
  }
}

function onLiveZapasChange(){
  flushAllStats();
  const v=document.getElementById('live-zapas-select').value;
  if(!v){
    state.liveZapasId=null;
    document.getElementById('live-table-wrap').innerHTML='<div class="empty"><span class="empty-icon">⚡</span><div class="empty-text">Vyberte zápas</div></div>';
    document.getElementById('btn-start-zapas').style.display='none';
    document.getElementById('btn-end-zapas').style.display='none';
    return;
  }
  const id=parseInt(v);
  state.liveZapasId=id;
  const z=state.zapasy.find(z=>z.id===id);
  document.getElementById('btn-start-zapas').style.display=z?.stav==='planovany'?'':'none';
  document.getElementById('btn-end-zapas').style.display=z?.stav==='probihajici'?'':'none';
  renderLiveTable(id);
}

async function startZapas(){
  const id=state.liveZapasId;if(!id)return;
  try{
    await apiPatch('vb_zapasy',id,{stav:'probihajici'});
    const z=state.zapasy.find(z=>z.id===id);if(z)z.stav='probihajici';
    document.getElementById('btn-start-zapas').style.display='none';
    document.getElementById('btn-end-zapas').style.display='';
    renderZapasy();renderLiveSelect();
    toast('Zápas zahájen','success');
  }catch(e){toast('Chyba: '+e.message,'error');}
}

function goLive(zapasId){
  showTab('live');
  const sel=document.getElementById('live-zapas-select');
  sel.value=zapasId;
  onLiveZapasChange();
}

function openFinishModal(){
  if(state.liveZapasId)editVysledek(state.liveZapasId,true);
}

// Dlouhý stisk je jinak funkce, o které se nikdo nedozví; tooltip na mobilu
// nefunguje. Ukážeme ji jednou a pak už ne.
function napovedaZpet(){
  if(!isLoggedIn())return;
  try{
    if(localStorage.getItem('vb_napoveda_zpet'))return;
    localStorage.setItem('vb_napoveda_zpet','1');
  }catch(e){return;}
  setTimeout(()=>toast('Tip: překlik vezmeš zpět dlouhým stiskem počítadla','success'),800);
}

function renderLiveTable(zapasId){
  const sid=currentSeasonId();
  const sezona_id=sid||state.zapasy.find(z=>z.id===zapasId)?.sezona_id||0;
  const vsichniHraci=hraciVSezoně(sezona_id);
  const el=document.getElementById('live-table-wrap');

  const lineup=state.zapasHraci.filter(zh=>zh.zapas_id===zapasId).map(zh=>zh.hrac_id);
  const hraci=vsichniHraci.filter(h=>lineup.includes(h.id));
  hraci.forEach(h=>ensureStat(zapasId,h.id));

  // header
  let thead=`<tr><th class="live-col-hrac"></th>`;
  ACTIONS.forEach(a=>{
    const variants=a.varianty?VARIANTS.filter(v=>a.varianty.includes(v.suf)):VARIANTS;
    thead+=`<th colspan="${variants.length}" class="col-action" style="border-left:3px solid ${a.color};color:${a.color}">${a.icon} ${a.label}</th>`;
  });
  thead+=`</tr>`;

  // player rows
  const rows=hraci.map(h=>{
    let cells=`<td class="live-col-hrac live-player-cell">
      <button class="live-card-remove" onclick="removeZeSestava(${zapasId},${h.id})">×</button>
      <span class="live-player-name">${esc(h.jmeno)}</span>
      <span class="live-player-num">${h.cislo?'#'+h.cislo:''}</span>
    </td>`;
    ACTIONS.forEach(a=>{
      const variants=a.varianty?VARIANTS.filter(v=>a.varianty.includes(v.suf)):VARIANTS;
      variants.forEach((v,vi)=>{
        const field=`${a.key}_${v.suf}`;
        const val=getStatVal(zapasId,h.id,field);
        const border=vi===0?`border-left:3px solid ${a.color};`:'';
        cells+=`<td style="padding:0;${border}"><button class="live-act-btn ${v.cls}" title="Klepnutím přidáš, dlouhým stiskem nebo pravým tlačítkem vezmeš zpět" onpointerdown="pressStart(event,${h.id},${zapasId},'${field}')" onpointerup="pressEnd(event,${h.id},${zapasId},'${field}')" onpointerleave="clearTimeout(this._pressTimer)" oncontextmenu="event.preventDefault();clearTimeout(this._pressTimer);this.dataset.dlouhy='0';bumpDown(${h.id},${zapasId},'${field}');return false"><span class="live-act-sym ${v.cls}">${v.sym}</span><span class="live-act-cnt" id="cnt-${h.id}-${field}">${val}</span></button></td>`;
      });
    });
    return `<tr>${cells}</tr>`;
  }).join('');

  // add-player row spanning all columns
  const totalCols=1+ACTIONS.reduce((s,a)=>s+(a.varianty?a.varianty.length:VARIANTS.length),0);
  const addRow=`<tr><td colspan="${totalCols}" style="padding:0;height:44px">
    <button onclick="openHracPicker(${zapasId})" style="width:100%;height:100%;background:none;border:none;color:var(--muted);cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;gap:6px;transition:color .15s" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--muted)'">
      <span style="font-size:20px;font-weight:700">+</span> Přidat hráčku
    </button>
  </td></tr>`;

  el.innerHTML=`<table class="live-table"><thead>${thead}</thead><tbody>${rows}${addRow}</tbody></table>`;
  if(hraci.length)napovedaZpet();
}

function openHracPicker(zapasId){
  document.getElementById('picker-zapas-id').value=zapasId;
  const z=state.zapasy.find(z=>z.id===zapasId);
  const sid=currentSeasonId()||z?.sezona_id||0;
  let vsichni=hraciVSezoně(sid);
  // filtrovat podle týmu zápasu
  if(z?.tym_id){
    const tymIds=state.hraciTymy.filter(ht=>ht.tym_id===z.tym_id).map(ht=>ht.hrac_id);
    vsichni=vsichni.filter(h=>tymIds.includes(h.id));
  }
  const lineup=state.zapasHraci.filter(zh=>zh.zapas_id===zapasId).map(zh=>zh.hrac_id);
  const available=vsichni.filter(h=>!lineup.includes(h.id));
  const el=document.getElementById('hrac-picker-list');
  if(!available.length){
    el.innerHTML='<div class="empty"><span class="empty-icon">👥</span><div class="empty-text">Všechny hráčky jsou v sestavě</div></div>';
  }else{
    el.innerHTML=available.map(h=>playerCard(h,{
      atributy:`style="cursor:pointer" onclick="addDoSestava(${zapasId},${h.id})"`,
      ovladani:'<span style="color:var(--green);font-size:20px;font-weight:700">+</span>'
    })).join('');
  }
  openModal('modal-hrac-picker');
}

async function addDoSestava(zapasId,hracId){
  try{
    await apiUpsert('vb_zapas_hraci',{zapas_id:zapasId,hrac_id:hracId},'zapas_id,hrac_id');
    if(!state.zapasHraci.some(zh=>zh.zapas_id===zapasId&&zh.hrac_id===hracId))state.zapasHraci.push({zapas_id:zapasId,hrac_id:hracId});
    closeModal('modal-hrac-picker');
    renderLiveTable(zapasId);
  }catch(e){toast('Chyba: '+e.message,'error');}
}

// Kolik akcí má hráčka v zápase zaznamenaných. Bereme i to, co ještě čeká
// na odeslání, jinak by dialog tvrdil nulu hned po kliknutí.
function pocetAkci(zapasId,hracId){
  const key=`${zapasId}_${hracId}`;
  const zdroj=dirtyStats[key]||state.statistiky.find(s=>s.zapas_id===zapasId&&s.hrac_id===hracId);
  if(!zdroj)return 0;
  let n=0;
  ACTIONS.forEach(a=>VARIANTS.forEach(v=>{n+=zdroj[`${a.key}_${v.suf}`]||0;}));
  return n;
}

// Křížek je hned vedle počítadel, po kterých se během zápasu rychle klepe,
// a mazal bez ptaní — na rozdíl od zápasu i týmu, které se ptají.
function removeZeSestava(zapasId,hracId){
  if(!isLoggedIn()){toast('Na změny se přihlas (🔒 nahoře)','error');return;}
  const h=state.hraci.find(h=>h.id===hracId);
  const jmeno=h?h.jmeno:'hráčku';
  const akci=pocetAkci(zapasId,hracId);
  document.getElementById('odebrat-zapas-id').value=zapasId;
  document.getElementById('odebrat-hrac-id').value=hracId;
  document.getElementById('btn-odebrat-i-statistiky').style.display=akci?'':'none';
  document.getElementById('odebrat-text').innerHTML=akci
    ? `<strong>${esc(jmeno)}</strong> má v tomto zápase zaznamenaných <strong>${akci}</strong> akcí.<br><br>
       Když ji jen odebereš ze sestavy, z tabulky zmizí, ale akce zůstanou ve Statistikách
       a dál se počítají do sloupce „Záp.“ — přes appku se k nim už nedostaneš.`
    : `Odebrat <strong>${esc(jmeno)}</strong> ze sestavy tohoto zápasu?`;
  openModal('modal-odebrat');
}

async function potvrdOdebrani(iStatistiky){
  const zapasId=parseInt(document.getElementById('odebrat-zapas-id').value);
  const hracId=parseInt(document.getElementById('odebrat-hrac-id').value);
  const key=`${zapasId}_${hracId}`;
  try{
    if(iStatistiky){
      // nejdřív zahodit rozepsané, ať je flush znovu nezaloží
      delete pendingDeltas[key];
      clearTimeout(debounceMap[key]);
      await apiDelete('vb_statistiky',`zapas_id=eq.${zapasId}&hrac_id=eq.${hracId}`);
      state.statistiky=state.statistiky.filter(s=>!(s.zapas_id===zapasId&&s.hrac_id===hracId));
      delete dirtyStats[key];
    }
    await apiDelete('vb_zapas_hraci',`zapas_id=eq.${zapasId}&hrac_id=eq.${hracId}`);
    state.zapasHraci=state.zapasHraci.filter(zh=>!(zh.zapas_id===zapasId&&zh.hrac_id===hracId));
    closeModal('modal-odebrat');
    renderLiveTable(zapasId);
    renderStatistiky();
    toast(iStatistiky?'Odebráno i se statistikami':'Odebráno ze sestavy','success');
  }catch(e){toast('Chyba: '+e.message,'error');}
}

function ensureStat(zapasId,hracId){
  const key=`${zapasId}_${hracId}`;
  if(!dirtyStats[key]){
    const existing=state.statistiky.find(s=>s.zapas_id===zapasId&&s.hrac_id===hracId);
    dirtyStats[key]=existing?{...existing}:makeEmptyStat(zapasId,hracId);
  }
}

function makeEmptyStat(zapasId,hracId){
  const o={zapas_id:zapasId,hrac_id:hracId};
  ACTIONS.forEach(a=>VARIANTS.forEach(v=>{o[`${a.key}_${v.suf}`]=0;}));
  return o;
}

function getStatVal(zapasId,hracId,field){
  const key=`${zapasId}_${hracId}`;
  if(dirtyStats[key])return dirtyStats[key][field]||0;
  const s=state.statistiky.find(s=>s.zapas_id===zapasId&&s.hrac_id===hracId);
  return s?s[field]||0:0;
}

function bump(hracId,zapasId,field,delta=1){
  // bez tohohle by počítadlo naskočilo a teprve pak přišla chyba ze serveru
  if(!isLoggedIn()){toast('Na zapisování se přihlas (🔒 nahoře)','error');return;}
  ensureStat(zapasId,hracId);
  const key=`${zapasId}_${hracId}`;
  const puvodni=dirtyStats[key][field]||0;
  const nova=Math.max(0,puvodni+delta);
  if(nova===puvodni)return;                    // odečítat pod nulu nedává smysl
  dirtyStats[key][field]=nova;
  const el=document.getElementById(`cnt-${hracId}-${field}`);
  if(el)el.textContent=nova;
  pendingDeltas[key]=pendingDeltas[key]||{};
  pendingDeltas[key][field]=(pendingDeltas[key][field]||0)+(nova-puvodni);
  if(pendingDeltas[key][field]===0)delete pendingDeltas[key][field];
  clearTimeout(debounceMap[key]);
  debounceMap[key]=setTimeout(()=>flushStat(key),STAT_FLUSH_MS);
}

// Vzetí zpět (#29): dlouhý stisk nebo pravé tlačítko na počítadle.
function bumpDown(hracId,zapasId,field){
  const el=document.getElementById(`cnt-${hracId}-${field}`);
  const pred=el?parseInt(el.textContent)||0:0;
  bump(hracId,zapasId,field,-1);
  const po=el?parseInt(el.textContent)||0:0;
  if(po<pred)toast('Vzato zpět','success');
}

// Dlouhý stisk se musí rozlišit od běžného klepnutí, jinak by každý zápis
// akce skončil odečtením.
function pressStart(ev,hracId,zapasId,field){
  if(ev.button!==0)return;                 // pravé tlačítko řeší oncontextmenu
  const btn=ev.currentTarget;
  btn.dataset.dlouhy='0';
  clearTimeout(btn._pressTimer);
  btn._pressTimer=setTimeout(()=>{
    btn.dataset.dlouhy='1';
    bumpDown(hracId,zapasId,field);
  },500);
}
function pressEnd(ev,hracId,zapasId,field){
  if(ev.button!==0)return;                 // jinak by pointerup po pravém kliku
  const btn=ev.currentTarget;              // hned přičetl to, co contextmenu odečetl
  clearTimeout(btn._pressTimer);
  if(btn.dataset.dlouhy==='1'){btn.dataset.dlouhy='0';return;}   // odečet už proběhl
  bump(hracId,zapasId,field,1);
}

async function flushStat(key,opts={}){
  if(!hasPending(key))return;
  clearTimeout(debounceMap[key]);
  delete debounceMap[key];
  const [zapasId,hracId]=key.split('_').map(Number);
  const odeslane=pendingDeltas[key];
  pendingDeltas[key]={};
  const zmeny=Object.entries(odeslane).map(([pole,delta])=>({zapas_id:zapasId,hrac_id:hracId,pole,delta}));
  if(!zmeny.length)return;
  try{
    const res=await apiRpc('vb_zapis_akce',{p_zmeny:zmeny},opts);
    // server vrací výslednou hodnotu po přičtení, včetně toho, co mezitím
    // zapsalo druhé zařízení — bereme ji jako pravdu
    if(Array.isArray(res))res.forEach(r=>prijmiHodnotu(r.zapas_id,r.hrac_id,r.pole,r.hodnota));
  }catch(e){
    // vrátit zpět do fronty, ať se to neztratí
    Object.entries(odeslane).forEach(([pole,delta])=>{
      pendingDeltas[key][pole]=(pendingDeltas[key][pole]||0)+delta;
    });
    toast('Chyba uložení: '+e.message,'error');
  }
}

function prijmiHodnotu(zapasId,hracId,pole,hodnota){
  const key=`${zapasId}_${hracId}`;
  ensureStat(zapasId,hracId);
  dirtyStats[key][pole]=hodnota;
  let s=state.statistiky.find(s=>s.zapas_id===zapasId&&s.hrac_id===hracId);
  if(!s){s={zapas_id:zapasId,hrac_id:hracId};state.statistiky.push(s);}
  s[pole]=hodnota;
  const el=document.getElementById(`cnt-${hracId}-${pole}`);
  if(el)el.textContent=hodnota;
}

function flushAllStats(opts={}){
  return Promise.all(pendingKeys().map(k=>flushStat(k,opts)));
}

// Dorovnání s druhým zařízením (#27). Realtime by byl elegantnější, ale
// znamenal by websocket a další závislost; na jeden otevřený zápas stačí
// občasné dotažení. Rozepsané hodnoty se nepřepisují.
async function refreshLiveStats(){
  const zapasId=state.liveZapasId;
  if(!zapasId||document.hidden)return;
  try{
    const rows=await api('GET',`vb_statistiky?zapas_id=eq.${zapasId}`);
    (rows||[]).forEach(row=>{
      const key=`${row.zapas_id}_${row.hrac_id}`;
      const ceka=pendingDeltas[key]||{};
      const idx=state.statistiky.findIndex(s=>s.zapas_id===row.zapas_id&&s.hrac_id===row.hrac_id);
      if(idx>=0)state.statistiky[idx]=row;else state.statistiky.push(row);
      if(!dirtyStats[key])return;
      Object.keys(row).forEach(pole=>{
        if(pole in ceka)return;                      // tohle si drží uživatel
        if(typeof row[pole]!=='number')return;
        if(dirtyStats[key][pole]===row[pole])return;
        dirtyStats[key][pole]=row[pole];
        const el=document.getElementById(`cnt-${row.hrac_id}-${pole}`);
        if(el)el.textContent=row[pole];
      });
    });
  }catch(e){/* dorovnání je best effort, chybu netlačíme uživateli do obličeje */}
}

function startLiveRefresh(){
  clearInterval(liveRefreshTimer);
  liveRefreshTimer=setInterval(refreshLiveStats,LIVE_REFRESH_MS);
}

// Zamčený telefon, přepnutá záložka nebo zavřené okno jinak timeout nikdy
// nespustí a kliky se ztratí. keepalive drží request naživu i po unloadu;
// sendBeacon použít nejde, neumí poslat hlavičky s apikey.
document.addEventListener('visibilitychange',()=>{
  if(document.hidden)flushAllStats({keepalive:true});
});
window.addEventListener('pagehide',()=>flushAllStats({keepalive:true}));

/* ─── STATISTIKY ─── */

// Tabulka i export CSV čerpají z tohohle jednoho výpočtu. Kdyby si každý
// počítal po svém, export by časem začal tiše ukazovat něco jiného než obrazovka.
function spocitejStatistiky(){
  const sid=currentSeasonId();
  if(!sid)return{stav:'bez-sezony'};
  const vsechnyHraci=hraciVSezoně(sid);
  if(!vsechnyHraci.length)return{stav:'prazdna-soupiska'};
  const vsechnyZapasy=state.zapasy.filter(z=>z.sezona_id===sid&&(z.stav==='dokonceny'||z.stav==='probihajici'));
  if(!vsechnyZapasy.length)return{stav:'zadne-zapasy'};

  const selTym=parseInt(document.getElementById('stats-tym-sel')?.value)||0;
  const selSoutez=parseInt(document.getElementById('stats-soutez-sel')?.value)||0;
  const selZapas=parseInt(document.getElementById('stats-zapas-sel')?.value)||0;
  const selHrac=parseInt(document.getElementById('stats-hrac-sel')?.value)||0;

  let hraci=vsechnyHraci;
  if(selTym){const ids=state.hraciTymy.filter(ht=>ht.tym_id===selTym).map(ht=>ht.hrac_id);hraci=hraci.filter(h=>ids.includes(h.id));}
  if(selHrac)hraci=hraci.filter(h=>h.id===selHrac);

  const zapasyPoCsoutezi=selSoutez?vsechnyZapasy.filter(z=>z.soutez_id===selSoutez):vsechnyZapasy;
  const zapasIds=(selZapas?zapasyPoCsoutezi.filter(z=>z.id===selZapas):zapasyPoCsoutezi).map(z=>z.id);
  const seasonSouteze=state.souteze.filter(s=>!s.sezona_id||s.sezona_id===sid);

  const rows=hraci.map(h=>{
    const stats=state.statistiky.filter(s=>s.hrac_id===h.id&&zapasIds.includes(s.zapas_id));
    const sum=(f)=>stats.reduce((acc,s)=>acc+(s[f]||0),0);
    const sp=sum('servis_plus'),sm=sum('servis_minus');
    const pp=sum('prijem_plus'),pm=sum('prijem_minus'),pn=sum('prijem_neutral');
    const up=sum('utok_plus'),um=sum('utok_minus'),un=sum('utok_neutral');
    const bp=sum('blok_plus');
    const cm=sum('chyba_minus');
    return {h,sp,sm,pp,pm,pn,up,um,un,bp,cm,total:sp+up+bp-sm-pm-um-cm,zapasy:stats.length};
  }).filter(r=>r.zapasy>0).sort((a,b)=>b.total-a.total);

  const tot=rows.reduce((acc,r)=>({
    zapasy:acc.zapasy+r.zapasy,sp:acc.sp+r.sp,sm:acc.sm+r.sm,
    pp:acc.pp+r.pp,pm:acc.pm+r.pm,pn:acc.pn+r.pn,
    up:acc.up+r.up,um:acc.um+r.um,un:acc.un+r.un,
    bp:acc.bp+r.bp,cm:acc.cm+r.cm,total:acc.total+r.total
  }),{zapasy:0,sp:0,sm:0,pp:0,pm:0,pn:0,up:0,um:0,un:0,bp:0,cm:0,total:0});

  return {stav:'ok',sid,vsechnyHraci,zapasyPoCsoutezi,seasonSouteze,rows,tot,zapasIds,
          selTym,selSoutez,selZapas,selHrac};
}

// podíl výborných ze všech pokusů; null = nebyl žádný pokus
function pctCislo(plus,minus,neutral){
  const t=plus+minus+neutral;
  return t>0?Math.round(plus/t*100):null;
}

// Úspěšnost (výborné − chyby) / pokusy, jak se běžně vykazuje ve volejbalové
// statistice. Samotné % výborných je jen půlka obrázku: 30 % výborných s 5 %
// chyb a 30 % s 25 % chyb vypadají stejně, a přitom to je úplně jiný výkon.
function uspesnost(plus,minus,neutral){
  const t=plus+minus+neutral;
  return t>0?Math.round((plus-minus)/t*100):null;
}
function sZnamenkem(v){
  if(v===null||v===undefined)return '—';
  return v>0?'+'+v:String(v);
}

/* ─── EXPORT CSV ─── */
const CSV_HLAVICKA=['Poř.','Hráčka','Číslo','Záp.','Servis Es','Servis chyby',
  'Příjem výb.','Příjem chyby','Příjem % výb.','Útok výb.','Útok chyby','Útok % výb.',
  'Bloky','Chyby','Celkem'];

function csvBunka(v){
  const t=(v===null||v===undefined)?'':String(v);
  return /[";\n\r]/.test(t)?'"'+t.replace(/"/g,'""')+'"':t;
}
function csvRadek(pole){return pole.map(csvBunka).join(';');}

function statsCsv(d){
  const radky=[csvRadek(CSV_HLAVICKA)];
  d.rows.forEach((r,i)=>radky.push(csvRadek([
    i+1,r.h.jmeno,r.h.cislo??'',r.zapasy,r.sp,r.sm,
    r.pp,r.pm,pctCislo(r.pp,r.pm,r.pn),
    r.up,r.um,pctCislo(r.up,r.um,r.un),
    r.bp,r.cm,r.total])));
  radky.push(csvRadek(['','Σ Celkem','',d.tot.zapasy,d.tot.sp,d.tot.sm,
    d.tot.pp,d.tot.pm,pctCislo(d.tot.pp,d.tot.pm,d.tot.pn),
    d.tot.up,d.tot.um,pctCislo(d.tot.up,d.tot.um,d.tot.un),
    d.tot.bp,d.tot.cm,d.tot.total]));
  return radky.join('\r\n');                 // CRLF kvůli Excelu
}

// Kontext filtrů dávám do názvu souboru, ne do prvních řádků CSV — jinak
// by se soubor nedal načíst jako tabulka bez ručního přeskakování hlavičky.
function csvNazev(d){
  const cast=t=>String(t).normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-|-$/g,'').toLowerCase();
  const kusy=['statistiky',cast(state.sezony.find(s=>s.id===d.sid)?.nazev||'sezona')];
  if(d.selTym)kusy.push(cast(state.tymy.find(t=>t.id===d.selTym)?.nazev||'tym'));
  if(d.selSoutez)kusy.push(cast(state.souteze.find(s=>s.id===d.selSoutez)?.nazev||'soutez'));
  if(d.selZapas){
    const z=state.zapasy.find(z=>z.id===d.selZapas);
    if(z)kusy.push(cast(z.datum+'-'+z.soupet));
  }
  if(d.selHrac)kusy.push(cast(state.hraci.find(h=>h.id===d.selHrac)?.jmeno||'hracka'));
  kusy.push(new Date().toISOString().slice(0,10));
  return kusy.filter(Boolean).join('_')+'.csv';
}

function exportStatsCsv(){
  const d=spocitejStatistiky();
  if(d.stav!=='ok'||!d.rows.length){toast('Není co exportovat','error');return;}
  // BOM, jinak český Excel přečte diakritiku jako zmatek
  const blob=new Blob(['\uFEFF'+statsCsv(d)],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=csvNazev(d);
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast(`Exportováno ${d.rows.length} hráček`,'success');
}

function renderStatistiky(){
  const el=document.getElementById('stats-content');
  const d=spocitejStatistiky();
  const prazdne=t=>{el.innerHTML=`<div class="empty"><span class="empty-icon">📈</span><div class="empty-text">${t}</div></div>`;};
  if(d.stav==='bez-sezony')return prazdne('Vyberte sezónu');
  if(d.stav==='prazdna-soupiska')return prazdne('Prázdná soupiska');
  if(d.stav==='zadne-zapasy')return prazdne('Žádné zápasy se statistikami');

  const {vsechnyHraci,zapasyPoCsoutezi,seasonSouteze,rows,tot,
         selTym,selSoutez,selZapas,selHrac}=d;

  let html=`<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
    <select id="stats-tym-sel" class="form-input" style="min-width:130px;flex:1" onchange="renderStatistiky()">
      <option value="">— všechny týmy —</option>
      ${state.tymy.map(t=>`<option value="${t.id}"${t.id===selTym?' selected':''}>${esc(t.nazev)}</option>`).join('')}
    </select>
    <select id="stats-soutez-sel" class="form-input" style="min-width:130px;flex:1" onchange="renderStatistiky()">
      <option value="">— všechny soutěže —</option>
      ${seasonSouteze.map(s=>`<option value="${s.id}"${s.id===selSoutez?' selected':''}>${esc(s.nazev)}</option>`).join('')}
    </select>
    <select id="stats-zapas-sel" class="form-input" style="min-width:160px;flex:1" onchange="renderStatistiky()">
      <option value="">— celá sezóna —</option>
      ${zapasyPoCsoutezi.map(z=>`<option value="${z.id}"${z.id===selZapas?' selected':''}>${fmtDate(z.datum)} — ${esc(z.soupet)}</option>`).join('')}
    </select>
    <select id="stats-hrac-sel" class="form-input" style="min-width:130px;flex:1" onchange="renderStatistiky()">
      <option value="">— všechny hráčky —</option>
      ${vsechnyHraci.map(h=>`<option value="${h.id}"${h.id===selHrac?' selected':''}>${esc(h.jmeno)}</option>`).join('')}
    </select>
    <button class="btn btn-secondary" id="btn-export-csv" onclick="exportStatsCsv()"
            title="Stáhne to, co je právě podle filtrů v tabulce">⬇️ Export CSV</button>
  </div>`;

  if(!rows.length){
    el.innerHTML=html+'<div class="empty" style="padding:32px"><span class="empty-icon">📈</span><div class="empty-text">Žádné výsledky pro zvolené filtry</div></div>';
    return;
  }

  const pct=(plus,minus,neutral)=>{const p=pctCislo(plus,minus,neutral);return p===null?'—':p+'%';};

  const g='color:var(--green);font-weight:600';
  const r='color:var(--red);font-weight:600';
  const b='color:var(--accent2);font-weight:600';
  const a='color:var(--accent);font-family:\'Oswald\',sans-serif;font-size:16px;font-weight:700';
  const muted='color:var(--muted);font-weight:600;text-align:center';

  html+=`<div style="overflow-x:auto"><table class="stats-table">
    <thead>
      <tr>
        <th rowspan="2">#</th><th rowspan="2">Hráčka</th><th rowspan="2">Záp.</th>
        <th colspan="2">🎯 Servis</th>
        <th colspan="3">🤲 Příjem</th>
        <th colspan="3">💥 Útok</th>
        <th rowspan="2">🛡️ Blok</th>
        <th rowspan="2">❌ Chyba</th>
        <th rowspan="2">Celkem</th>
      </tr>
      <tr>
        <th>Es</th><th>Chyby</th>
        <th>Výb.</th><th>Chyby</th><th>%</th>
        <th>Výb.</th><th>Chyby</th><th>%</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((row,i)=>`<tr>
        <td style="color:var(--muted);font-weight:700">${i+1}</td>
        <td><a href="#" onclick="event.preventDefault();otevriProfil(${row.h.id})" style="color:var(--text);text-decoration:underline;text-decoration-color:var(--border);text-underline-offset:3px"><strong>${esc(row.h.jmeno)}</strong></a>${row.h.cislo?` <span style="color:var(--muted);font-size:11px">#${row.h.cislo}</span>`:''}</td>
        <td style="${muted}">${row.zapasy}</td>
        <td style="${g}">${row.sp}</td><td style="${r}">${row.sm}</td>
        <td style="${g}">${row.pp}</td><td style="${r}">${row.pm}</td><td style="${b}">${pct(row.pp,row.pm,row.pn)}</td>
        <td style="${g}">${row.up}</td><td style="${r}">${row.um}</td><td style="${b}">${pct(row.up,row.um,row.un)}</td>
        <td style="${g}">${row.bp}</td>
        <td style="${r}">${row.cm}</td>
        <td style="${a}">${row.total}</td>
      </tr>`).join('')}
    </tbody>
    <tfoot>
      <tr style="background:var(--surface2);border-top:2px solid var(--border)">
        <td colspan="2" style="padding:10px 12px;font-family:'Oswald',sans-serif;font-size:13px;font-weight:700;color:var(--text);letter-spacing:.3px">Σ Celkem</td>
        <td style="${muted}">${tot.zapasy}</td>
        <td style="${g}">${tot.sp}</td><td style="${r}">${tot.sm}</td>
        <td style="${g}">${tot.pp}</td><td style="${r}">${tot.pm}</td><td style="${b}">${pct(tot.pp,tot.pm,tot.pn)}</td>
        <td style="${g}">${tot.up}</td><td style="${r}">${tot.um}</td><td style="${b}">${pct(tot.up,tot.um,tot.un)}</td>
        <td style="${g}">${tot.bp}</td>
        <td style="${r}">${tot.cm}</td>
        <td style="${a}">${tot.total}</td>
      </tr>
    </tfoot>
  </table></div>`;
  el.innerHTML=html;
}


/* ─── PROFIL HRÁČKY ─── */

// Zápas po zápase, ve stejném filtru jaký je zrovna ve Statistikách.
function profilHracky(hracId){
  const d=spocitejStatistiky();
  if(d.stav!=='ok')return null;
  const h=state.hraci.find(h=>h.id===hracId);
  if(!h)return null;
  const zapasy=state.zapasy
    .filter(z=>d.zapasIds.includes(z.id))
    .filter(z=>state.statistiky.some(s=>s.zapas_id===z.id&&s.hrac_id===hracId))
    .sort((a,b)=>(a.datum||'').localeCompare(b.datum||'')||a.id-b.id);
  const radky=zapasy.map(z=>{
    const s=state.statistiky.find(s=>s.zapas_id===z.id&&s.hrac_id===hracId)||{};
    const v=f=>s[f]||0;
    return {z,
      sp:v('servis_plus'),sm:v('servis_minus'),
      pp:v('prijem_plus'),pm:v('prijem_minus'),pn:v('prijem_neutral'),
      up:v('utok_plus'),um:v('utok_minus'),un:v('utok_neutral'),
      bp:v('blok_plus'),cm:v('chyba_minus'),
      total:v('servis_plus')+v('utok_plus')+v('blok_plus')
            -v('servis_minus')-v('prijem_minus')-v('utok_minus')-v('chyba_minus')};
  });
  return {h,radky,souhrn:d.rows.find(r=>r.h.id===hracId)};
}

// Malý spojnicový graf, jedna série. Tři veličiny jsou schválně tři grafy:
// procenta a bodový součet mají jinou stupnici a do jednoho grafu se dvěma
// osami nepatří. Jedna série na graf navíc znamená, že identita nestojí na
// barvě — název je v nadpisu.
function sparkline(body,{barva,popisky,jednotka=''}){
  // Poměr stran musí zůstat zachovaný, jinak se z bodů stanou elipsy.
  // Šířka 400 je kompromis: na desktopu se graf roztáhne, na mobilu
  // nezploští na proužek.
  const S={w:400,h:60,l:6,r:6,t:6,b:6};
  const platne=body.filter(b=>b.y!==null);
  if(platne.length<1)return '<div class="profil-prazdno">Zatím není z čeho kreslit vývoj.</div>';
  let min=Math.min(...platne.map(b=>b.y)),max=Math.max(...platne.map(b=>b.y));
  if(min===max){min-=1;max+=1;}
  if(min>0&&jednotka==='%')min=0;
  if(max<0)max=0;
  const rozpeti=max-min;
  const px=i=>S.l+(body.length===1?(S.w-S.l-S.r)/2:i*(S.w-S.l-S.r)/(body.length-1));
  const py=v=>S.t+(1-(v-min)/rozpeti)*(S.h-S.t-S.b);

  const usek=[];let akt=[];
  body.forEach((b,i)=>{
    if(b.y===null){if(akt.length)usek.push(akt);akt=[];return;}
    akt.push(`${px(i)},${py(b.y)}`);
  });
  if(akt.length)usek.push(akt);

  const nula=(min<0&&max>0)
    ?`<line class="graf-mrizka" x1="${S.l}" y1="${py(0)}" x2="${S.w-S.r}" y2="${py(0)}"/>`:'';
  const popisekOsy=v=>`${Math.round(v)}${jednotka}`;
  const cary=usek.filter(u=>u.length>1)
    .map(u=>`<polyline points="${u.join(' ')}" fill="none" stroke="${barva}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
  const body_=body.map((b,i)=>b.y===null?'':
    `<circle cx="${px(i)}" cy="${py(b.y)}" r="4" fill="${barva}" stroke="var(--surface)" stroke-width="2">
       <title>${esc(b.popis)}: ${b.y}${jednotka}</title></circle>`).join('');
  // popisek jen u prvního a posledního zápasu — číslo u každého bodu je šum
  const kraje=body.length>1
    ?`<span>${esc(popisky[0])}</span><span>${esc(popisky[popisky.length-1])}</span>`
    :`<span>${esc(popisky[0])}</span>`;
  return `<div class="graf-plocha">
    <div class="graf-osa-y"><span>${popisekOsy(max)}</span><span>${popisekOsy(min)}</span></div>
    <svg viewBox="0 0 ${S.w} ${S.h}" role="img">${nula}${cary}${body_}</svg>
  </div>
  <div class="graf-osa-x">${kraje}</div>`;
}

function otevriProfil(hracId){
  const p=profilHracky(hracId);
  if(!p){toast('Profil se nepodařilo sestavit','error');return;}
  const {h,radky,souhrn}=p;
  document.getElementById('profil-title').textContent=
    `${h.jmeno}${h.cislo?' · #'+h.cislo:''}${h.pozice?' · '+h.pozice:''}`;

  const kostka=(val,lbl,barva)=>`<div class="profil-kostka">
    <div class="profil-kostka-val"${barva?` style="color:${barva}"`:''}>${val}</div>
    <div class="profil-kostka-lbl">${lbl}</div></div>`;
  const souhrnHtml=souhrn?`<div class="profil-souhrn">
    ${kostka(souhrn.zapasy,'Zápasů')}
    ${kostka(souhrn.total,'Celkem','var(--accent)')}
    ${kostka(souhrn.sp,'Esa','var(--green)')}
    ${kostka(pctCislo(souhrn.up,souhrn.um,souhrn.un)??'—','Útok % výb.')}
    ${kostka(sZnamenkem(uspesnost(souhrn.up,souhrn.um,souhrn.un)),'Útok úsp.')}
    ${kostka(pctCislo(souhrn.pp,souhrn.pm,souhrn.pn)??'—','Příjem % výb.')}
    ${kostka(sZnamenkem(uspesnost(souhrn.pp,souhrn.pm,souhrn.pn)),'Příjem úsp.')}
    ${kostka(souhrn.cm,'Chyb','var(--red)')}
  </div>`:'';

  const popisky=radky.map(r=>fmtDate(r.z.datum).slice(0,5));
  const graf=(nadpis,podnadpis,data,barva,jednotka)=>`<div class="graf">
    <div class="graf-nadpis">${nadpis}</div>
    <div class="graf-podnadpis">${podnadpis}</div>
    ${sparkline(data,{barva,popisky,jednotka})}</div>`;

  const bod=(r,y)=>({y,popis:`${fmtDate(r.z.datum)} — ${r.z.soupet}`});
  const grafy=radky.length?`
    ${graf('Útok — % výborných','podíl výborných ze všech pokusů',
      radky.map(r=>bod(r,pctCislo(r.up,r.um,r.un))),'var(--accent)','%')}
    ${graf('Příjem — % výborných','podíl výborných ze všech pokusů',
      radky.map(r=>bod(r,pctCislo(r.pp,r.pm,r.pn))),'var(--green)','%')}
    ${graf('Celkem','body mínus chyby v zápase',
      radky.map(r=>bod(r,r.total)),'var(--accent)','')}`
    :'<div class="profil-prazdno">V tomhle filtru nemá hráčka žádný zápas se záznamem.</div>';

  const tabulka=radky.length?`<div style="overflow-x:auto"><table class="profil-tabulka">
    <thead><tr><th>Zápas</th><th>Es</th><th>Příj&nbsp;%</th><th>Útok&nbsp;%</th><th>Blok</th><th>Chyb</th><th>Celk.</th></tr></thead>
    <tbody>${radky.map(r=>`<tr>
      <td><div class="profil-zapas-datum">${fmtDate(r.z.datum).slice(0,6)}</div><div class="profil-zapas-soupet">${esc(r.z.soupet)}</div></td>
      <td>${r.sp}</td>
      <td>${pctCislo(r.pp,r.pm,r.pn)??'—'}<div class="profil-usp">${sZnamenkem(uspesnost(r.pp,r.pm,r.pn))}</div></td>
      <td>${pctCislo(r.up,r.um,r.un)??'—'}<div class="profil-usp">${sZnamenkem(uspesnost(r.up,r.um,r.un))}</div></td>
      <td>${r.bp}</td>
      <td>${r.cm}</td>
      <td style="color:var(--accent);font-weight:700">${r.total}</td>
    </tr>`).join('')}</tbody></table>
    <div class="profil-legenda">Druhé číslo je úspěšnost: (výborné − chyby) / pokusy.</div>
    </div>`:'';

  document.getElementById('profil-obsah').innerHTML=souhrnHtml+grafy+tabulka;
  openModal('modal-profil');
}

/* ─── TÝMY ─── */
function renderTymy(){
  const el=document.getElementById('tymy-list');
  if(!state.tymy.length){
    el.innerHTML='<div class="empty" style="padding:24px"><span class="empty-icon" style="font-size:28px">🏐</span><div class="empty-text" style="font-size:14px">Žádné týmy</div></div>';
    return;
  }
  el.innerHTML=`<div class="tymy-grid">${state.tymy.map(t=>{
    const members=state.hraciTymy.filter(ht=>ht.tym_id===t.id);
    const playerChips=members.map(ht=>{
      const h=state.hraci.find(h=>h.id===ht.hrac_id);
      return h?`<span class="tym-member">${esc(h.jmeno)}</span>`:'';
    }).join('');
    return `<div class="tym-card">
      <div class="tym-card-header">
        <div class="tym-card-title">${esc(t.nazev)}</div>
        <button class="btn btn-sm btn-secondary" onclick="openTymManage(${t.id})">✏️ Spravovat</button>
      </div>
      <div class="tym-members">${playerChips||'<span style="color:var(--muted)">Prázdný tým</span>'}</div>
    </div>`;
  }).join('')}</div>`;
}

function openTymManage(tymId){
  const tym=state.tymy.find(t=>t.id===tymId);if(!tym)return;
  document.getElementById('tym-manage-id').value=tymId;
  document.getElementById('tym-manage-title').textContent=`👥 ${tym.nazev}`;
  renderTymManage(tymId);
  openModal('modal-tym-manage');
}

function renderTymManage(tymId){
  const inTym=state.hraciTymy.filter(ht=>ht.tym_id===tymId).map(ht=>ht.hrac_id);
  const el=document.getElementById('tym-manage-content');
  if(!state.hraci.length){el.innerHTML='<div class="empty"><span class="empty-icon">👥</span><div class="empty-text">Žádné hráčky</div></div>';return;}
  el.innerHTML=state.hraci.map(h=>{
    const isIn=inTym.includes(h.id);
    return playerCard(h,{
      tridy:isIn?'':'inactive',
      ovladani:`<button class="btn btn-sm ${isIn?'btn-red':'btn-green'}" style="flex-shrink:0" onclick="toggleHracTym(${h.id},${tymId},${isIn})">${isIn?'Odebrat':'+ Přidat'}</button>`
    });
  }).join('');
}

async function toggleHracTym(hracId,tymId,inTym){
  try{
    if(inTym){
      await apiDelete('vb_hraci_tymy',`hrac_id=eq.${hracId}&tym_id=eq.${tymId}`);
      state.hraciTymy=state.hraciTymy.filter(ht=>!(ht.hrac_id===hracId&&ht.tym_id===tymId));
    }else{
      await apiUpsert('vb_hraci_tymy',{hrac_id:hracId,tym_id:tymId},'hrac_id,tym_id');
      if(!state.hraciTymy.some(ht=>ht.hrac_id===hracId&&ht.tym_id===tymId))state.hraciTymy.push({hrac_id:hracId,tym_id:tymId});
    }
    const tid=parseInt(document.getElementById('tym-manage-id').value);
    renderTymManage(tid);
    renderTymy();
  }catch(e){toast('Chyba: '+e.message,'error');}
}

async function saveTym(){
  const nazev=document.getElementById('in-tym-nazev').value.trim();
  if(!nazev){toast('Zadej název týmu','error');return;}
  try{
    const res=await api('POST','vb_tymy',{nazev});
    state.tymy.push(res[0]);
    state.tymy.sort((a,b)=>a.nazev.localeCompare(b.nazev));
    closeModal('modal-tym');
    document.getElementById('in-tym-nazev').value='';
    renderTymy();
    toast('Tým vytvořen','success');
  }catch(e){toast('Chyba: '+e.message,'error');}
}

async function deleteTym(){
  const tymId=parseInt(document.getElementById('tym-manage-id').value);
  if(!confirm('Opravdu smazat tým?'))return;
  try{
    await apiDelete('vb_tymy',`id=eq.${tymId}`);
    state.tymy=state.tymy.filter(t=>t.id!==tymId);
    state.hraciTymy=state.hraciTymy.filter(ht=>ht.tym_id!==tymId);
    closeModal('modal-tym-manage');
    renderTymy();
    toast('Tým smazán','success');
  }catch(e){toast('Chyba: '+e.message,'error');}
}

/* ─── SOUTĚŽE ─── */
function openZapasModal(){
  document.getElementById('nova-soutez-inline').style.display='none';
  document.getElementById('in-nova-soutez-nazev').value='';
  refreshSoutezSelect();
  refreshTymZapasSelect();
  openModal('modal-zapas');
}

function refreshTymZapasSelect(){
  const sel=document.getElementById('in-zapas-tym');
  sel.innerHTML='<option value="">— žádný tým —</option>';
  state.tymy.forEach(t=>{
    const o=document.createElement('option');
    o.value=t.id;o.textContent=t.nazev;
    sel.appendChild(o);
  });
}

function toggleNovaSoutezForm(){
  const el=document.getElementById('nova-soutez-inline');
  const visible=el.style.display!=='none';
  el.style.display=visible?'none':'block';
  if(!visible)document.getElementById('in-nova-soutez-nazev').focus();
}

async function saveNovaSoutezInline(){
  const nazev=document.getElementById('in-nova-soutez-nazev').value.trim();
  if(!nazev){toast('Zadej název soutěže','error');return;}
  const sid=currentSeasonId();
  const body={nazev};if(sid)body.sezona_id=sid;
  try{
    const res=await api('POST','vb_souteze',body);
    state.souteze.push(res[0]);
    state.souteze.sort((a,b)=>a.nazev.localeCompare(b.nazev));
    document.getElementById('in-nova-soutez-nazev').value='';
    toggleNovaSoutezForm();
    refreshSoutezSelect();
    document.getElementById('in-zapas-soutez').value=res[0].id;
    toast('Soutěž přidána','success');
  }catch(e){toast('Chyba: '+e.message,'error');}
}

function refreshSoutezSelect(){
  const sid=currentSeasonId();
  const sel=document.getElementById('in-zapas-soutez');
  const list=sid?state.souteze.filter(s=>s.sezona_id===sid||!s.sezona_id):state.souteze;
  sel.innerHTML='<option value="">— žádná soutěž —</option>';
  list.forEach(s=>{
    const o=document.createElement('option');
    o.value=s.id;o.textContent=s.nazev;
    sel.appendChild(o);
  });
}

async function saveSoutez(){
  const nazev=document.getElementById('in-soutez-nazev').value.trim();
  if(!nazev){toast('Zadej název soutěže','error');return;}
  const sid=currentSeasonId();
  const body={nazev};if(sid)body.sezona_id=sid;
  try{
    const res=await api('POST','vb_souteze',body);
    state.souteze.push(res[0]);
    state.souteze.sort((a,b)=>a.nazev.localeCompare(b.nazev));
    closeModal('modal-soutez');
    document.getElementById('in-soutez-nazev').value='';
    refreshSoutezSelect();
    document.getElementById('in-zapas-soutez').value=res[0].id;
    toast('Soutěž přidána','success');
  }catch(e){toast('Chyba: '+e.message,'error');}
}

/* ─── SAVE SEASON ─── */
async function saveSezona(){
  const nazev=document.getElementById('in-sezona-nazev').value.trim();
  if(!nazev){toast('Zadej název sezóny','error');return;}
  const aktivni=document.getElementById('in-sezona-aktivni').checked;
  try{
    if(aktivni){
      // deactivate others
      for(const s of state.sezony.filter(s=>s.aktivni)){
        await apiPatch('vb_sezony',s.id,{aktivni:false});
        s.aktivni=false;
      }
    }
    const res=await api('POST','vb_sezony',{nazev,aktivni});
    const ns=res[0];
    state.sezony.unshift(ns);
    if(aktivni)state.activeSeason=ns;
    renderSeasonSelect();
    if(aktivni){document.getElementById('season-select').value=ns.id;onSeasonChange();}
    closeModal('modal-sezona');
    document.getElementById('in-sezona-nazev').value='';
    document.getElementById('in-sezona-aktivni').checked=false;
    toast('Sezóna vytvořena','success');
  }catch(e){toast('Chyba: '+e.message,'error');}
}

/* ─── SAVE ZÁPAS ─── */
async function saveZapas(){
  const datum=document.getElementById('in-zapas-datum').value;
  const soupet=document.getElementById('in-zapas-soupet').value.trim();
  if(!datum||!soupet){toast('Zadej datum a soupeře','error');return;}
  const sid=currentSeasonId();
  const soutezId=parseInt(document.getElementById('in-zapas-soutez').value)||null;
  const tymId=parseInt(document.getElementById('in-zapas-tym').value)||null;
  const body={datum,soupet,cas:document.getElementById('in-zapas-cas').value||null,misto:document.getElementById('in-zapas-misto').value,stav:'planovany'};
  if(sid)body.sezona_id=sid;
  if(soutezId)body.soutez_id=soutezId;
  if(tymId)body.tym_id=tymId;
  try{
    const res=await api('POST','vb_zapasy',body);
    state.zapasy.unshift(res[0]);
    closeModal('modal-zapas');
    document.getElementById('in-zapas-datum').value='';
    document.getElementById('in-zapas-soupet').value='';
    renderZapasy();renderPrehled();renderLiveSelect();
    toast('Zápas přidán','success');
  }catch(e){toast('Chyba: '+e.message,'error');}
}

/* ─── DELETE ZÁPAS ─── */
async function deleteZapas(id){
  if(!confirm('Opravdu smazat zápas?'))return;
  try{
    await apiDelete('vb_zapasy',`id=eq.${id}`);
    state.zapasy=state.zapasy.filter(z=>z.id!==id);
    state.statistiky=state.statistiky.filter(s=>s.zapas_id!==id);
    renderZapasy();renderPrehled();renderLiveSelect();
    toast('Zápas smazán','success');
  }catch(e){toast('Chyba: '+e.message,'error');}
}

/* ─── HRÁČKY ─── */
function openAddHracModal(){
  document.getElementById('in-hrac-id').value='';
  document.getElementById('in-hrac-jmeno').value='';
  document.getElementById('in-hrac-cislo').value='';
  document.getElementById('in-hrac-pozice').value='smečař';
  document.getElementById('hrac-modal-title').textContent='👤 Přidat hráčku';
  document.getElementById('btn-save-hrac').textContent='Přidat';
  openModal('modal-hrac');
}

function editHrac(id){
  const h=state.hraci.find(h=>h.id===id);if(!h)return;
  document.getElementById('in-hrac-id').value=id;
  document.getElementById('in-hrac-jmeno').value=h.jmeno;
  document.getElementById('in-hrac-cislo').value=h.cislo||'';
  document.getElementById('in-hrac-pozice').value=h.pozice||'smečař';
  document.getElementById('hrac-modal-title').textContent='✏️ Upravit hráčku';
  document.getElementById('btn-save-hrac').textContent='Uložit';
  openModal('modal-hrac');
}

async function saveHrac(){
  const id=parseInt(document.getElementById('in-hrac-id').value)||null;
  const jmeno=document.getElementById('in-hrac-jmeno').value.trim();
  if(!jmeno){toast('Zadej jméno','error');return;}
  const cislo=document.getElementById('in-hrac-cislo').value;
  const pozice=document.getElementById('in-hrac-pozice').value;
  try{
    if(id){
      const res=await apiPatch('vb_hraci',id,{jmeno,cislo:cislo?parseInt(cislo):null,pozice});
      const idx=state.hraci.findIndex(h=>h.id===id);
      if(idx>=0)state.hraci[idx]={...state.hraci[idx],...(res&&res[0]?res[0]:{jmeno,cislo:cislo?parseInt(cislo):null,pozice})};
      state.hraci.sort((a,b)=>a.jmeno.localeCompare(b.jmeno));
      closeModal('modal-hrac');
      renderTym();renderPrehled();renderLiveSelect();renderStatistiky();
      toast('Hráčka upravena','success');
    }else{
      const res=await api('POST','vb_hraci',{jmeno,cislo:cislo?parseInt(cislo):null,pozice,aktivni:true});
      const nh=res[0];
      state.hraci.push(nh);
      state.hraci.sort((a,b)=>a.jmeno.localeCompare(b.jmeno));
      const sid=currentSeasonId();
      if(sid){
        await apiUpsert('vb_hraci_sezony',{hrac_id:nh.id,sezona_id:sid},'hrac_id,sezona_id');
        state.hraciSezony.push({hrac_id:nh.id,sezona_id:sid});
      }
      closeModal('modal-hrac');
      renderTym();renderPrehled();renderLiveSelect();
      toast('Hráčka přidána','success');
    }
    document.getElementById('in-hrac-jmeno').value='';
    document.getElementById('in-hrac-cislo').value='';
  }catch(e){toast('Chyba: '+e.message,'error');}
}

/* ─── VÝSLEDEK ─── */
function editVysledek(zapasId,finish=false){
  const z=state.zapasy.find(z=>z.id===zapasId);if(!z)return;
  document.getElementById('vysledek-zapas-id').value=zapasId;
  document.getElementById('modal-vysledek').querySelector('.modal-title').textContent=finish?'✅ Ukončit zápas':'📝 Výsledek zápasu';
  document.getElementById('in-sety-my').value=z.sety_my??'';
  document.getElementById('in-sety-oni').value=z.sety_oni??'';
  document.getElementById('in-vysledek-poznamka').value=z.poznamka||'';
  // sets detail
  let html='';
  for(let i=1;i<=5;i++){
    html+=`<div class="form-row" style="margin-bottom:8px">
      <div class="form-group"><label class="form-label">${i}. set — MY</label><input type="number" class="form-input" id="in-set${i}-my" value="${z[`set${i}_my`]??''}" placeholder="—" min="0" /></div>
      <div class="form-group"><label class="form-label">${i}. set — ONI</label><input type="number" class="form-input" id="in-set${i}-oni" value="${z[`set${i}_oni`]??''}" placeholder="—" min="0" /></div>
    </div>`;
  }
  document.getElementById('sets-detail-form').innerHTML=html;
  openModal('modal-vysledek');
}

async function saveVysledek(){
  const id=parseInt(document.getElementById('vysledek-zapas-id').value);
  const setyMy=document.getElementById('in-sety-my').value;
  const setyOni=document.getElementById('in-sety-oni').value;
  const body={stav:'dokonceny',sety_my:setyMy!==''?parseInt(setyMy):null,sety_oni:setyOni!==''?parseInt(setyOni):null,poznamka:document.getElementById('in-vysledek-poznamka').value||null};
  for(let i=1;i<=5;i++){
    const my=document.getElementById(`in-set${i}-my`).value;
    const oni=document.getElementById(`in-set${i}-oni`).value;
    body[`set${i}_my`]=my!==''?parseInt(my):null;
    body[`set${i}_oni`]=oni!==''?parseInt(oni):null;
  }
  try{
    const res=await apiPatch('vb_zapasy',id,body);
    const idx=state.zapasy.findIndex(z=>z.id===id);
    if(idx>=0)state.zapasy[idx]={...state.zapasy[idx],...(res&&res[0]?res[0]:body)};
    closeModal('modal-vysledek');
    renderZapasy();renderPrehled();renderLiveSelect();renderStatistiky();
    if(state.liveZapasId===id){
      document.getElementById('btn-end-zapas').style.display='none';
      document.getElementById('btn-start-zapas').style.display='none';
    }
    toast('Výsledek uložen','success');
  }catch(e){toast('Chyba: '+e.message,'error');}
}

/* ─── UI PŘIHLÁŠENÍ ─── */
function renderAuthUI(){
  const btn=document.getElementById('btn-auth');
  const bar=document.getElementById('readonly-bar');
  if(btn){
    btn.textContent=isLoggedIn()?`🔓 ${AUTH.email||'přihlášen'}`:'🔒 Přihlásit';
    btn.title=isLoggedIn()?'Kliknutím se odhlásíš':'Přihlásit se k zapisování';
  }
  if(bar)bar.classList.toggle('show',!isLoggedIn());
}

function onAuthButton(){
  if(isLoggedIn()){
    if(!confirm('Odhlásit se? Zapisovat pak půjde až po dalším přihlášení.'))return;
    authClear();
    renderAuthUI();
    toast('Odhlášeno','success');
    return;
  }
  document.getElementById('in-login-heslo').value='';
  openModal('modal-login');
  document.getElementById('in-login-email').focus();
}

async function doLogin(){
  const email=document.getElementById('in-login-email').value.trim();
  const heslo=document.getElementById('in-login-heslo').value;
  if(!email||!heslo){toast('Vyplň e-mail a heslo','error');return;}
  const btn=document.getElementById('btn-do-login');
  btn.disabled=true;btn.textContent='Přihlašuji…';
  try{
    await authLogin(email,heslo);
    closeModal('modal-login');
    document.getElementById('in-login-heslo').value='';
    renderAuthUI();
    toast('Přihlášeno','success');
  }catch(e){
    toast(e.message,'error');
  }finally{
    btn.disabled=false;btn.textContent='Přihlásit';
  }
}

/* ─── UI HELPERS ─── */
function showTab(name){
  document.querySelectorAll('.tab-content').forEach(el=>el.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(el=>el.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  const tabs={prehled:0,zapasy:1,tym:2,live:3,statistiky:4};
  document.querySelectorAll('.nav-tab')[tabs[name]]?.classList.add('active');
  if(name==='live')renderLiveSelect();
  if(name==='statistiky')renderStatistiky();
}

function openModal(id){document.getElementById(id).classList.remove('hidden');}
function closeModal(id){document.getElementById(id).classList.add('hidden');}

document.querySelectorAll('.modal-overlay').forEach(el=>{
  el.addEventListener('click',function(e){if(e.target===this)this.classList.add('hidden');});
});

let toastTimer;
function toast(msg,type='success'){
  const el=document.getElementById('toast');
  el.textContent=msg;
  el.className='toast show '+(type==='error'?'error':'success');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>{el.classList.remove('show');},2800);
}

// set today as default for new match
document.getElementById('in-zapas-datum').valueAsDate=new Date();

authLoad();
renderAuthUI();
init();
startLiveRefresh();
