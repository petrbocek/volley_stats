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

async function api(method,path,body){
  const r=await fetch(SB_URL+'/rest/v1/'+path,{
    method,
    headers:{'apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY,'Content-Type':'application/json','Prefer':method==='POST'?'return=representation':'return=representation'},
    body:body?JSON.stringify(body):undefined
  });
  if(!r.ok){const e=await r.text();throw new Error(e);}
  const t=r.status===204?null:await r.json();
  return t;
}
async function apiUpsert(table,body,conflict){
  const r=await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${conflict}`,{
    method:'POST',
    headers:{'apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY,'Content-Type':'application/json','Prefer':'resolution=merge-duplicates,return=representation'},
    body:JSON.stringify(body)
  });
  if(!r.ok){const e=await r.text();throw new Error(e);}
  return r.status===204?null:await r.json();
}
async function apiPatch(table,id,body){
  const r=await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${id}`,{
    method:'PATCH',
    headers:{'apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY,'Content-Type':'application/json','Prefer':'return=representation'},
    body:JSON.stringify(body)
  });
  if(!r.ok){const e=await r.text();throw new Error(e);}
  return r.status===204?null:await r.json();
}

async function init(){
  try{
    const [sez,hr,hs,zap,stat,tym,ht,sout,zh]=await Promise.all([
      api('GET','vb_sezony?order=id.desc'),
      api('GET','vb_hraci?order=jmeno.asc'),
      api('GET','vb_hraci_sezony'),
      api('GET','vb_zapasy?order=datum.desc'),
      api('GET','vb_statistiky'),
      api('GET','vb_tymy?order=nazev.asc'),
      api('GET','vb_hraci_tymy'),
      api('GET','vb_souteze?order=nazev.asc'),
      api('GET','vb_zapas_hraci'),
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
  const id=currentSeasonId();
  state.activeSeason=state.sezony.find(s=>s.id===id)||null;
  renderAll();
}

function renderAll(){
  renderPrehled();
  renderZapasy();
  renderTym();
  renderLiveSelect();
  renderStatistiky();
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
      <div style="font-family:'Oswald',sans-serif;font-size:22px;font-weight:700;color:var(--accent)">${sezNazev}</div>
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
    <div style="flex:1;min-width:120px"><div class="match-vs">${z.soupet}</div><div class="match-misto">${misto}${tym?` · <span style="color:var(--purple)">${tym.nazev}</span>`:''}${soutez?` · <span style="color:var(--accent2)">${soutez.nazev}</span>`:''}</div></div>
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

function playerCardHtml(h,sid,inSeason){
  const posClass=`pos-${h.pozice==='nahrávač'?'nahravac':h.pozice==='libero'?'libero':h.pozice==='universál'?'universal':h.pozice==='blokař'?'blokar':'smec'}`;
  const numEl=h.cislo?`<div class="player-num">${h.cislo}</div>`:`<div class="player-num no-num">?</div>`;
  const toggle=sid?`<button class="btn btn-sm ${inSeason?'btn-red':'btn-green'}" style="flex-shrink:0" onclick="toggleHracSezona(${h.id},${sid},${inSeason})">${inSeason?'Odebrat':'+ Přidat'}</button>`:'';
  return `<div class="player-card ${sid&&!inSeason?'inactive':''}" id="pc-${h.id}">
    ${numEl}
    <div class="player-info">
      <div class="player-name">${h.jmeno}</div>
      <div class="player-pos ${posClass}">${h.pozice||'—'}</div>
    </div>
    <button class="btn btn-sm btn-secondary" style="flex-shrink:0" onclick="editHrac(${h.id})">✏️</button>
    ${toggle}
  </div>`;
}

async function toggleHracSezona(hracId,sezonaId,inSeason){
  try{
    if(inSeason){
      await fetch(`${SB_URL}/rest/v1/vb_hraci_sezony?hrac_id=eq.${hracId}&sezona_id=eq.${sezonaId}`,{
        method:'DELETE',headers:{'apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY}
      });
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
  }
}

function onLiveZapasChange(){
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
      <span class="live-player-name">${h.jmeno}</span>
      <span class="live-player-num">${h.cislo?'#'+h.cislo:''}</span>
    </td>`;
    ACTIONS.forEach(a=>{
      const variants=a.varianty?VARIANTS.filter(v=>a.varianty.includes(v.suf)):VARIANTS;
      variants.forEach((v,vi)=>{
        const field=`${a.key}_${v.suf}`;
        const val=getStatVal(zapasId,h.id,field);
        const border=vi===0?`border-left:3px solid ${a.color};`:'';
        cells+=`<td style="padding:0;${border}"><button class="live-act-btn ${v.cls}" onclick="bump(${h.id},${zapasId},'${field}')"><span class="live-act-sym ${v.cls}">${v.sym}</span><span class="live-act-cnt" id="cnt-${h.id}-${field}">${val}</span></button></td>`;
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
    el.innerHTML=available.map(h=>{
      const posClass=`pos-${h.pozice==='nahrávač'?'nahravac':h.pozice==='libero'?'libero':h.pozice==='universál'?'universal':h.pozice==='blokař'?'blokar':'smec'}`;
      const numEl=h.cislo?`<div class="player-num">${h.cislo}</div>`:`<div class="player-num no-num">?</div>`;
      return `<div class="player-card" style="cursor:pointer" onclick="addDoSestava(${zapasId},${h.id})">
        ${numEl}
        <div class="player-info"><div class="player-name">${h.jmeno}</div><div class="player-pos ${posClass}">${h.pozice||'—'}</div></div>
        <span style="color:var(--green);font-size:20px;font-weight:700">+</span>
      </div>`;
    }).join('');
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

async function removeZeSestava(zapasId,hracId){
  try{
    await fetch(`${SB_URL}/rest/v1/vb_zapas_hraci?zapas_id=eq.${zapasId}&hrac_id=eq.${hracId}`,{method:'DELETE',headers:{'apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY}});
    state.zapasHraci=state.zapasHraci.filter(zh=>!(zh.zapas_id===zapasId&&zh.hrac_id===hracId));
    renderLiveTable(zapasId);
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

function bump(hracId,zapasId,field){
  ensureStat(zapasId,hracId);
  const key=`${zapasId}_${hracId}`;
  dirtyStats[key][field]=(dirtyStats[key][field]||0)+1;
  const el=document.getElementById(`cnt-${hracId}-${field}`);
  if(el)el.textContent=dirtyStats[key][field];
  clearTimeout(debounceMap[key]);
  debounceMap[key]=setTimeout(()=>flushStat(key),800);
}

async function flushStat(key){
  const data=dirtyStats[key];if(!data)return;
  try{
    const res=await apiUpsert('vb_statistiky',data,'zapas_id,hrac_id');
    if(res&&res[0]){
      const idx=state.statistiky.findIndex(s=>s.zapas_id===data.zapas_id&&s.hrac_id===data.hrac_id);
      if(idx>=0)state.statistiky[idx]=res[0];else state.statistiky.push(res[0]);
    }
  }catch(e){toast('Chyba uložení: '+e.message,'error');}
}

/* ─── STATISTIKY ─── */
function renderStatistiky(){
  const sid=currentSeasonId();
  const el=document.getElementById('stats-content');
  if(!sid){el.innerHTML='<div class="empty"><span class="empty-icon">📈</span><div class="empty-text">Vyberte sezónu</div></div>';return;}
  const vsechnyHraci=hraciVSezoně(sid);
  if(!vsechnyHraci.length){el.innerHTML='<div class="empty"><span class="empty-icon">📈</span><div class="empty-text">Prázdná soupiska</div></div>';return;}
  const vsechnyZapasy=state.zapasy.filter(z=>z.sezona_id===sid&&(z.stav==='dokonceny'||z.stav==='probihajici'));
  if(!vsechnyZapasy.length){el.innerHTML='<div class="empty"><span class="empty-icon">📈</span><div class="empty-text">Žádné zápasy se statistikami</div></div>';return;}

  const selTym=parseInt(document.getElementById('stats-tym-sel')?.value)||0;
  const selSoutez=parseInt(document.getElementById('stats-soutez-sel')?.value)||0;
  const selZapas=parseInt(document.getElementById('stats-zapas-sel')?.value)||0;
  const selHrac=parseInt(document.getElementById('stats-hrac-sel')?.value)||0;

  // filter players
  let hraci=vsechnyHraci;
  if(selTym){const ids=state.hraciTymy.filter(ht=>ht.tym_id===selTym).map(ht=>ht.hrac_id);hraci=hraci.filter(h=>ids.includes(h.id));}
  if(selHrac)hraci=hraci.filter(h=>h.id===selHrac);

  // filter matches (competition → specific match)
  const zapasyPoCsoutezi=selSoutez?vsechnyZapasy.filter(z=>z.soutez_id===selSoutez):vsechnyZapasy;
  const zapasIds=(selZapas?zapasyPoCsoutezi.filter(z=>z.id===selZapas):zapasyPoCsoutezi).map(z=>z.id);

  const seasonSouteze=state.souteze.filter(s=>!s.sezona_id||s.sezona_id===sid);

  let html=`<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
    <select id="stats-tym-sel" class="form-input" style="min-width:130px;flex:1" onchange="renderStatistiky()">
      <option value="">— všechny týmy —</option>
      ${state.tymy.map(t=>`<option value="${t.id}"${t.id===selTym?' selected':''}>${t.nazev}</option>`).join('')}
    </select>
    <select id="stats-soutez-sel" class="form-input" style="min-width:130px;flex:1" onchange="renderStatistiky()">
      <option value="">— všechny soutěže —</option>
      ${seasonSouteze.map(s=>`<option value="${s.id}"${s.id===selSoutez?' selected':''}>${s.nazev}</option>`).join('')}
    </select>
    <select id="stats-zapas-sel" class="form-input" style="min-width:160px;flex:1" onchange="renderStatistiky()">
      <option value="">— celá sezóna —</option>
      ${zapasyPoCsoutezi.map(z=>`<option value="${z.id}"${z.id===selZapas?' selected':''}>${fmtDate(z.datum)} — ${z.soupet}</option>`).join('')}
    </select>
    <select id="stats-hrac-sel" class="form-input" style="min-width:130px;flex:1" onchange="renderStatistiky()">
      <option value="">— všechny hráčky —</option>
      ${vsechnyHraci.map(h=>`<option value="${h.id}"${h.id===selHrac?' selected':''}>${h.jmeno}</option>`).join('')}
    </select>
  </div>`;

  if(!hraci.length){
    el.innerHTML=html+'<div class="empty" style="padding:32px"><span class="empty-icon">📈</span><div class="empty-text">Žádné výsledky pro zvolené filtry</div></div>';
    return;
  }

  const pct=(plus,minus,neutral)=>{const t=plus+minus+neutral;return t>0?Math.round(plus/t*100)+'%':'—';};

  const rows=hraci.map(h=>{
    const stats=state.statistiky.filter(s=>s.hrac_id===h.id&&zapasIds.includes(s.zapas_id));
    const sum=(f)=>stats.reduce((acc,s)=>acc+(s[f]||0),0);
    const sp=sum('servis_plus'),sm=sum('servis_minus');
    const pp=sum('prijem_plus'),pm=sum('prijem_minus'),pn=sum('prijem_neutral');
    const up=sum('utok_plus'),um=sum('utok_minus'),un=sum('utok_neutral');
    const bp=sum('blok_plus');
    const cm=sum('chyba_minus');
    const zapasy=stats.length;
    return {h,sp,sm,pp,pm,pn,up,um,un,bp,cm,total:sp+up+bp-sm-pm-um-cm,zapasy};
  }).filter(r=>r.zapasy>0).sort((a,b)=>b.total-a.total);

  const g='color:var(--green);font-weight:600';
  const r='color:var(--red);font-weight:600';
  const b='color:var(--accent2);font-weight:600';
  const a='color:var(--accent);font-family:\'Oswald\',sans-serif;font-size:16px;font-weight:700';

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
        <td><strong>${row.h.jmeno}</strong>${row.h.cislo?` <span style="color:var(--muted);font-size:11px">#${row.h.cislo}</span>`:''}</td>
        <td style="color:var(--muted);font-weight:600;text-align:center">${row.zapasy}</td>
        <td style="${g}">${row.sp}</td><td style="${r}">${row.sm}</td>
        <td style="${g}">${row.pp}</td><td style="${r}">${row.pm}</td><td style="${b}">${pct(row.pp,row.pm,row.pn)}</td>
        <td style="${g}">${row.up}</td><td style="${r}">${row.um}</td><td style="${b}">${pct(row.up,row.um,row.un)}</td>
        <td style="${g}">${row.bp}</td>
        <td style="${r}">${row.cm}</td>
        <td style="${a}">${row.total}</td>
      </tr>`).join('')}
    </tbody>
  </table></div>`;
  el.innerHTML=html;
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
      return h?`<span class="tym-member">${h.jmeno}</span>`:'';
    }).join('');
    return `<div class="tym-card">
      <div class="tym-card-header">
        <div class="tym-card-title">${t.nazev}</div>
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
    const posClass=`pos-${h.pozice==='nahrávač'?'nahravac':h.pozice==='libero'?'libero':h.pozice==='universál'?'universal':h.pozice==='blokař'?'blokar':'smec'}`;
    const numEl=h.cislo?`<div class="player-num">${h.cislo}</div>`:`<div class="player-num no-num">?</div>`;
    return `<div class="player-card ${isIn?'':'inactive'}">
      ${numEl}
      <div class="player-info"><div class="player-name">${h.jmeno}</div><div class="player-pos ${posClass}">${h.pozice||'—'}</div></div>
      <button class="btn btn-sm ${isIn?'btn-red':'btn-green'}" style="flex-shrink:0" onclick="toggleHracTym(${h.id},${tymId},${isIn})">${isIn?'Odebrat':'+ Přidat'}</button>
    </div>`;
  }).join('');
}

async function toggleHracTym(hracId,tymId,inTym){
  try{
    if(inTym){
      await fetch(`${SB_URL}/rest/v1/vb_hraci_tymy?hrac_id=eq.${hracId}&tym_id=eq.${tymId}`,{method:'DELETE',headers:{'apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY}});
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
    await fetch(`${SB_URL}/rest/v1/vb_tymy?id=eq.${tymId}`,{method:'DELETE',headers:{'apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY}});
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
    await fetch(`${SB_URL}/rest/v1/vb_zapasy?id=eq.${id}`,{method:'DELETE',headers:{'apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY}});
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

init();
