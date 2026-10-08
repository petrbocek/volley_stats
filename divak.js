/* ─── DIVÁCKÁ STRÁNKA ───
   Jen koukání: stav, postavení a průběh akcí (#102). Žádné přihlášení, žádný
   zápis — stránka umí jedinou HTTP metodu, GET.

   Pravidla (co je bod, posty po zónách, výměny z logu) jsou v sdilene.js,
   společná se zapisovatelskou appkou. Vykreslování hřiště je tu vlastní,
   protože to v app.js jsou tlačítka s onclick — sdílet se vyplatí pravidla,
   ne HTML s ovládáním, které divák nesmí mít.

   Čte se rolí anon, které RLS pouští jen to, co je veřejné už dnes. */

const OBNOVA_ZIVE_MS=5000;        // rozehraný zápas
const OBNOVA_KLID_MS=30000;       // nikdo zrovna nehraje
const VYMEN_V_SEZNAMU=12;         // co se vejde na telefon bez scrollování
const ZAPASU_V_SEZNAMU=60;        // sezona jich má kolem dvaceti, tohle je strop

/* Sloupce, které nesou zápis akce. Pouhé „má to v sobě číslo" by za data
   vydávalo i id a číslo setu, a prázdný řádek by pak vypadal jako rozehraný
   set (#107). */
const META_SLOUPCE=['id','zapas_id','hrac_id','set_cislo','created_at'];
const maZapis=r=>Object.keys(r).some(k=>!META_SLOUPCE.includes(k)&&
                                        typeof r[k]==='number'&&r[k]>0);

const d={zapasy:[],seznamStat:[],seznamChyby:[],
         zapas:null,hraci:[],sestava:[],statistiky:[],chyby:[],postaveni:[],
         setInfo:[],udalosti:[],oddechove:[],stridani:[],set:1,nacteno:null,chyba:null};
let obnovaTimer=null;

/* Adresa je jediné, co stránku přepíná: `?zapas=30` je detail, bez ní seznam.
   Žádný router, žádný stav v paměti — odkaz jde poslat i uložit.

   Do dotazu se pustí jen celé kladné číslo. Co přijde v adrese, je cizí text
   a v PostgREST filtru nemá co dělat. */
function cisloZAdresy(klic){
  const n=parseInt(new URLSearchParams(location.search).get(klic),10);
  return Number.isInteger(n)&&n>0?n:null;
}
const zapasZAdresy=()=>cisloZAdresy('zapas');
const setZAdresy=()=>cisloZAdresy('set');

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function ziskej(dotaz){
  const r=await fetch(`${SB_URL}/rest/v1/${dotaz}`,{
    headers:{apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`}
  });
  if(!r.ok)throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

/* Seznam: rozehraný zápas nahoře, pod ním odehrané od nejnovějšího. Plánované
   se nenabízejí — na zápase, který ještě nezačal, není co koukat.

   Ptáme se na to při každé obnově, takže se seznam po ukončení zápasu sám
   srovná, aniž by kdokoli sahal na adresu. */
async function nactiSeznam(){
  const zapasy=await ziskej(`vb_zapasy?stav=in.(${STAV.PROBIHA},${STAV.DOKONCENY})`+
    `&order=datum.desc,id.desc&limit=${ZAPASU_V_SEZNAMU}`);
  const zive=zapasy.filter(z=>z.stav===STAV.PROBIHA);
  d.zapasy=[...zive,...zapasy.filter(z=>z.stav!==STAV.PROBIHA)];
  // Odehraný zápas má výsledek zapsaný v sobě, rozehraný ještě ne — tomu se
  // stav musí dopočítat z akcí, jinak by u něj v seznamu nebylo žádné číslo.
  if(zive.length){
    const ids=zive.map(z=>z.id).join(',');
    const [st,ch]=await Promise.all([
      ziskej(`vb_statistiky?zapas_id=in.(${ids})`),
      ziskej(`vb_chyby_souperu?zapas_id=in.(${ids})`),
    ]);
    d.seznamStat=st;d.seznamChyby=ch;
  }else{d.seznamStat=[];d.seznamChyby=[];}
}

async function nactiDetail(id){
  const zapas=(await ziskej(`vb_zapasy?id=eq.${id}&limit=1`))[0]||null;
  d.zapas=zapas;
  if(!zapas)return;
  const [sestava,statistiky,chyby,postaveni,setInfo,udalosti,oddechove,stridani]=await Promise.all([
    ziskej(`vb_zapas_hraci?zapas_id=eq.${id}`),
    ziskej(`vb_statistiky?zapas_id=eq.${id}`),
    ziskej(`vb_chyby_souperu?zapas_id=eq.${id}`),
    ziskej(`vb_postaveni?zapas_id=eq.${id}`),
    ziskej(`vb_set_info?zapas_id=eq.${id}`),
    ziskej(`vb_udalosti?zapas_id=eq.${id}&order=id.asc`),
    ziskej(`vb_oddechove_casy?zapas_id=eq.${id}&order=id.asc`),
    ziskej(`vb_stridani?zapas_id=eq.${id}&order=id.asc`),
  ]);
  d.sestava=sestava;d.statistiky=statistiky;d.chyby=chyby;d.postaveni=postaveni;
  d.setInfo=setInfo;d.udalosti=udalosti;d.oddechove=oddechove;d.stridani=stridani;
  // hráčky dotahuju až podle sestavy, ne celou kartotéku
  const ids=[...new Set([...sestava.map(s=>s.hrac_id),
    ...statistiky.map(x=>x.hrac_id),
    ...stridani.flatMap(x=>[x.hrac_ven,x.hrac_dovnitr])].filter(Boolean))];
  d.hraci=ids.length?await ziskej(`vb_hraci?id=in.(${ids.join(',')})`):[];
  // Set z adresy platí, jen když v něm něco je — jinak by odkaz na pátý set
  // u třísetového zápasu ukázal prázdno.
  const zAdresy=setZAdresy();
  d.set=(zAdresy&&zAdresy<=setuVZapase(zapas)&&setMaData(zAdresy))?zAdresy:rozehranySet();
}

async function nacti(){
  try{
    const id=zapasZAdresy();
    if(id)await nactiDetail(id);else await nactiSeznam();
    d.nacteno=new Date();
    d.chyba=null;
  }catch(e){
    // zamrzlé číslo bez varování je horší než přiznaná pauza
    d.chyba=e.message;
  }
  vykresli();
}

/* ─── ODVOZENÍ ───
   Zapisovatel má rozehraný set v paměti prohlížeče, divák ne — pozná se
   podle toho, kde jsou poslední data. */
/* Zapsaný výsledek setu je ten oficiální — dokud set běží, žádný není a platí
   součet akcí. U dohraného zápasu je to jediné, co o starších setech víme,
   když se statistiky nevedly. */
function skoreZapsane(set){
  const my=d.zapas?.[`set${set}_my`],oni=d.zapas?.[`set${set}_oni`];
  return (my!=null&&oni!=null)?{nase:my,jejich:oni}:null;
}
const skoreKZobrazeni=set=>skoreZapsane(set)||skoreSetu(set);

function setMaData(set){
  return skoreZapsane(set)!=null||
         d.statistiky.some(s=>(s.set_cislo||1)===set&&maZapis(s))||
         d.chyby.some(c=>(c.set_cislo||1)===set&&((c.pocet||0)+(c.body||0))>0)||
         d.udalosti.some(u=>(u.set_cislo||1)===set)||
         d.oddechove.some(o=>(o.set_cislo||1)===set)||
         d.stridani.some(x=>(x.set_cislo||1)===set)||
         d.postaveni.some(p=>(p.set_cislo||1)===set);
}

function rozehranySet(){
  for(let s=SETU;s>=1;s--)if(setMaData(s))return s;
  return 1;
}

/* Skóre a stav utkání počítá i seznam, kde žádné `d.statistiky` nejsou —
   proto to jsou funkce nad předanými daty a detail si je jen obaluje. */
function skoreZDat(statistiky,chyby,set){
  const radky=statistiky.filter(s=>(s.set_cislo||1)===set);
  const souper=chyby.find(c=>(c.set_cislo||1)===set);
  return skoreZRadku(radky,souper);
}

function setuVZapase(zapas){return (zapas&&zapas.vitezne_sety===2?2:3)*2-1;}

function setRozhodnutyZ(zapas,statistiky,chyby,set){
  const my=zapas?.[`set${set}_my`],oni=zapas?.[`set${set}_oni`];
  const s=(my!=null&&oni!=null)?{nase:my,jejich:oni}:skoreZDat(statistiky,chyby,set);
  const cil=set===setuVZapase(zapas)?15:25;
  if(Math.max(s.nase,s.jejich)<cil||Math.abs(s.nase-s.jejich)<2)return null;
  return s.nase>s.jejich?'my':'oni';
}

function stavUtkaniZ(zapas,statistiky,chyby){
  let my=0,oni=0;
  for(let set=1;set<=setuVZapase(zapas);set++){
    const v=setRozhodnutyZ(zapas,statistiky,chyby,set);
    if(v==='my')my++;else if(v==='oni')oni++;
  }
  return {my,oni};
}

// Poslední set, ve kterém něco je. Seznam zná jen statistiky a soupeřovu
// stranu, takže zrovna rozehraný set po prvním bodu.
function posledniSetSDaty(statistiky,chyby){
  for(let s=SETU;s>=1;s--){
    if(statistiky.some(x=>(x.set_cislo||1)===s&&maZapis(x))||
       chyby.some(c=>(c.set_cislo||1)===s&&((c.pocet||0)+(c.body||0))>0))return s;
  }
  return 1;
}

const skoreSetu=set=>skoreZDat(d.statistiky,d.chyby,set);
const setRozhodnuty=set=>setRozhodnutyZ(d.zapas,d.statistiky,d.chyby,set);
const stavUtkani=()=>stavUtkaniZ(d.zapas,d.statistiky,d.chyby);

function setInfoSetu(set){
  return d.setInfo.find(x=>(x.set_cislo||1)===set)||{oddechove_casy:0,stridani:0};
}

function postaveniSetu(set){
  const m=new Map();
  d.postaveni.filter(p=>(p.set_cislo||1)===set).forEach(p=>m.set(p.zona,p.hrac_id));
  return m;
}

function hracka(id){return d.hraci.find(h=>h.id===id)||null;}
function jeLibero(id){return !!d.sestava.find(z=>z.hrac_id===id)?.libero;}

function vymenySetu(set){
  return vymenyZLogu(d.udalosti.filter(u=>(u.set_cislo||1)===set),
                     setInfoSetu(set).prvni_podani||null);
}

/* ─── VYKRESLENÍ ─── */
function jmenoSCislem(h){return h?esc(h.jmeno)+(h.cislo?` <span class="divak-dres">#${h.cislo}</span>`:''):'—';}

/* ─── SEZNAM ZÁPASŮ ───
   Úvodní stránka: nahoře, co se zrovna hraje, pod tím odehrané od nejnovějšího.
   Přepíná se odkazy, ne tlačítky — stránka tím zůstane hloupá, odkaz na zápas
   jde poslat a zpátky funguje tlačítko v prohlížeči (#107). */
function datumHtml(z){
  if(!z.datum)return '';
  const [r,m,den]=z.datum.split('-');
  return `${+den}. ${+m}. ${r}`;
}

function polozkaHtml(z){
  const zive=z.stav===STAV.PROBIHA;
  const stat=zive?d.seznamStat.filter(x=>x.zapas_id===z.id):[];
  const chyb=zive?d.seznamChyby.filter(x=>x.zapas_id===z.id):[];
  const u=stavUtkaniZ(z,stat,chyb);
  // U rozehraného je zajímavý stav právě běžícího setu, u odehraného sety.
  const set=zive?posledniSetSDaty(stat,chyb):null;
  const s=set?skoreZDat(stat,chyb,set):null;
  const sety=[];
  for(let i=1;i<=setuVZapase(z);i++){
    const my=z[`set${i}_my`],oni=z[`set${i}_oni`];
    if(my!=null&&oni!=null)sety.push(`${my}:${oni}`);
  }
  const vysledek=u.my>u.oni?'vyhra':u.oni>u.my?'prohra':'';
  // Dohraný zápas bez zapsaného výsledku není 0:0 — o tom prostě nic nevíme.
  const setySkore=(zive||sety.length||u.my||u.oni)?`${u.my}:${u.oni}`:'—';
  return `<a class="divak-polozka${zive?' zive':''}" href="?zapas=${z.id}">
    <span class="divak-polozka-hlava">
      ${zive?'<span class="divak-zive">● Živě</span>':''}
      <span class="divak-polozka-datum">${esc(datumHtml(z))}${
        z.cas&&zive?` · ${esc(z.cas.slice(0,5))}`:''}</span>
    </span>
    <span class="divak-polozka-soupet">${esc(z.soupet)}</span>
    <span class="divak-polozka-cisla">
      <span class="divak-polozka-sety ${vysledek}">${setySkore}</span>
      ${zive&&s?`<span class="divak-polozka-set">${set}. set ${s.nase}:${s.jejich}</span>`
               :sety.length?`<span class="divak-polozka-detail">${sety.join(' · ')}</span>`:''}
    </span>
  </a>`;
}

function seznamHtml(){
  if(!d.zapasy.length)return `<div class="divak-nehraje">
    <div class="divak-nehraje-ikona">🏐</div>
    <div class="divak-nehraje-text">${d.chyba
      ?'Data se nepodařilo načíst.':'Zatím tu není žádný zápas.'}</div>
    <div class="divak-nehraje-popis">${d.chyba
      ?'Zkusím to znovu za chvíli.':'Až se začne hrát, objeví se tu sám.'}</div>
  </div>`;
  const zive=d.zapasy.filter(z=>z.stav===STAV.PROBIHA);
  const odehrane=d.zapasy.filter(z=>z.stav!==STAV.PROBIHA);
  return (zive.length?`<div class="divak-skupina">Právě se hraje</div>
    <div class="divak-seznam">${zive.map(polozkaHtml).join('')}</div>`:'')+
    (odehrane.length?`<div class="divak-skupina">Odehrané</div>
    <div class="divak-seznam">${odehrane.map(polozkaHtml).join('')}</div>`:'');
}

function hlavickaHtml(){
  const z=d.zapas;
  const u=stavUtkani();
  const stav=stavLabel(z.stav);
  const datum=datumHtml(z);
  return `<a class="divak-zpet" href="divak.html">← Zápasy</a>
  <div class="divak-hlavicka">
    <div class="divak-zapas">
      <div class="divak-soupet">${esc(z.soupet)}</div>
      <div class="divak-detail">${esc(datum)}${z.cas?` · ${esc(z.cas.slice(0,5))}`:''} · ${esc(stav)}</div>
    </div>
    <div class="divak-sety"><span class="divak-sety-popis">Sety</span>
      <span class="divak-sety-cislo">${u.my}:${u.oni}</span></div>
  </div>`;
}

function skoreHtml(){
  const s=skoreKZobrazeni(d.set);
  const sety=[];
  for(let i=1;i<=setuVZapase(d.zapas);i++)if(setMaData(i)||i===d.set){
    const ss=skoreKZobrazeni(i);
    // odkaz, ne tlačítko: u dohraného zápasu se dá prolistovat celý průběh
    sety.push(`<a class="skore-set${i===d.set?' aktivni':''}" href="?zapas=${d.zapas.id}&set=${i}">${i}. ${ss.nase}:${ss.jejich}</a>`);
  }
  return `<div class="divak-skore">
    <div class="divak-skore-popis">${d.set}. set</div>
    <div class="divak-skore-cisla"><span class="plus">${s.nase}</span><span class="divak-dvojtecka">:</span><span class="minus">${s.jejich}</span></div>
    <div class="skore-sety">${sety.join('')}</div>
  </div>`;
}

// Hřiště bez ovládání: stejné třídy jako v appce, ale žádné onclick.
function hristeHtml(){
  const m=postaveniSetu(d.set);
  if(!m.size)return '<div class="divak-prazdno">Sestava na hřišti se zatím nezapsala.</div>';
  const nid=setInfoSetu(d.set).nahravacka_hrac_id||null;
  const zonaN=nid?[...m.entries()].find(([,id])=>id===nid)?.[0]:null;
  const karta=zona=>{
    const h=hracka(m.get(zona));
    if(!h)return `<div class="hriste-zona prazdna"><span class="hriste-cislo-zony">${zona}</span></div>`;
    const post=postZony(zona,zonaN);
    return `<div class="hriste-zona${zona===1?' podava':''}">
      <span class="hriste-cislo-zony">${zona}${zona===1?' • podání':''}${
        post?` <span class="hriste-post">${POST_ZKRATKA[post]}</span>`:''}</span>
      <span class="hriste-jmeno">${esc(h.jmeno)}</span>
      <span class="hriste-dres">${h.cislo?'#'+h.cislo:''}</span>
    </div>`;
  };
  const libera=d.sestava.filter(z=>z.libero).map(z=>hracka(z.hrac_id)).filter(Boolean);
  return `<div class="divak-plocha">
    <div class="hriste">${ZONY_ROZLOZENI.map(rada=>
      `<div class="hriste-rada">${rada.map(karta).join('')}</div>`).join('')}</div>
    <div class="hriste-sit"><span>síť</span></div>
    ${libera.length?`<div class="divak-libera">${libera.map(h=>
      `<div class="hriste-zona libero"><span class="hriste-cislo-zony">Libero</span>
        <span class="hriste-jmeno">${esc(h.jmeno)}</span>
        <span class="hriste-dres">${h.cislo?'#'+h.cislo:''}</span></div>`).join('')}</div>`:''}
  </div>`;
}

function podaniHtml(){
  const m=postaveniSetu(d.set);
  const ted=hracka(m.get(1)),pristi=hracka(m.get(2));
  if(!ted)return '';
  return `<div class="divak-radek">
    <span class="divak-nazev">Podává</span>
    <span class="divak-hodnota">${jmenoSCislem(ted)}</span>
    ${pristi?`<span class="divak-pristi">→ ${jmenoSCislem(pristi)}</span>`:''}
  </div>`;
}

/* Přerušení (naše i soupeřova) se do průběhu vkládají podle stavu — jak se
   to dělá, je v sdilene.js, společné se zapisovatelskou appkou (#102, #107). */
function prerusenaSetu(set){
  return prerusenaZRadku(d.oddechove.filter(o=>(o.set_cislo||1)===set),
                         d.stridani.filter(x=>(x.set_cislo||1)===set));
}

// Soupeřovy řádky nesou čísla na dresech, naše hráčky ze soupisky.
function popisStridani(p){
  if(p.strana===STRANY.ONI){
    const c=n=>n==null?'—':`#${n}`;
    return `${c(p.cislo_dovnitr)} za ${c(p.cislo_ven)}`;
  }
  const jmeno=id=>{const h=hracka(id);return h?esc(h.jmeno)+(h.cislo?` #${h.cislo}`:''):'—';};
  return `${jmeno(p.hrac_dovnitr)} za ${jmeno(p.hrac_ven)}`;
}

function radekPrerusení(p){
  const oni=p.strana===STRANY.ONI;
  const popis=(p.typ==='timeout'?'Time-out':'Střídání')+(oni?' soupeře':'');
  return `<div class="prubeh-radek prerus${oni?' oni':''}">
    <span class="prubeh-poradi">${p.typ==='timeout'?'⏸':'⇅'}</span>
    <span class="prubeh-skore">${p.my}:${p.oni}</span>
    <span class="prubeh-akce">${popis}</span>
    <span class="prubeh-kdo">${p.typ==='stridani'?popisStridani(p):''}</span>
    <span class="prubeh-break prazdny"></span>
  </div>`;
}

function prubehHtml(){
  const {vymeny,znamePrvni}=vymenySetu(d.set);
  const kroky=prubehZVymen(vymeny);
  const vse=prubehSPrerusenimi(kroky,prerusenaSetu(d.set));
  if(!vse.length)return '<div class="divak-prazdno">V tomhle setu zatím není zapsaná žádná výměna.</div>';
  const so=sideOutZVymen(vymeny,znamePrvni);
  const posledni=[...vse].reverse().slice(0,VYMEN_V_SEZNAMU);
  return `<div class="divak-radek">
      <span class="divak-nazev" title="Sytě = zisk podání">Průběh</span>
      <span class="prubeh-pas">${kroky.map(k=>
        `<span class="prubeh-tik ${k.bod}${k.break?' break':''}"
          title="${k.my}:${k.oni}"></span>`).join('')}</span>
      ${so&&so.pct!=null?`<span class="divak-proc">Side-out ${so.pct}%</span>`:''}
    </div>
    <div class="prubeh-seznam">${posledni.map(k=>{
      if(k.typ!=='vymena')return radekPrerusení(k);
      const h=hracka(k.hrac_id);
      const souper=k.pole==='souper_chyba'?'Chyba soupeře':k.pole==='souper_bod'?'Bod soupeře':null;
      return `<div class="prubeh-radek ${k.bod}">
        <span class="prubeh-poradi">${k.poradi}.</span>
        <span class="prubeh-skore"><b class="${k.bod==='my'?'plus':'minus'}">${k.my}</b>:<b class="${k.bod==='my'?'minus':'plus'}">${k.oni}</b></span>
        <span class="prubeh-akce">${esc(souper||popisAkce(k.pole))}</span>
        <span class="prubeh-kdo">${souper?'Soupeř':esc(h?h.jmeno:'—')}</span>
        ${k.break?'<span class="prubeh-break" title="Zisk podání">⇄</span>':'<span class="prubeh-break prazdny"></span>'}
      </div>`;
    }).join('')}</div>
    ${vse.length>VYMEN_V_SEZNAMU?`<div class="divak-vic">Zobrazeno posledních ${VYMEN_V_SEZNAMU} z ${vse.length} záznamů.</div>`:''}`;
}

/* ─── ŽEBŘÍČKY ───
   Kdo zápasu vtiskl tvář. Počítá se za celý zápas, ne za vybraný set — divák
   chce vědět, kdo ho rozhodl, ne kdo byl nejlepší v pátém setu (#107).

   Co je bod, se nevymýšlí znovu: bere se SKORE_NASE ze sdilene.js, tedy
   totéž, z čeho se skládá skóre. */
const TOP_N=5;
const ZEBRICKY=[
  {nadpis:'Body',   popis:'útok, servis a blok dohromady',
   hodnota:a=>SKORE_NASE.reduce((n,f)=>n+(a[f]||0),0)},
  {nadpis:'Útok',   popis:'ukončené útoky',  hodnota:a=>a.utok_plus||0},
  {nadpis:'Servis', popis:'esa',             hodnota:a=>a.servis_plus||0},
  {nadpis:'Pole',   popis:'vybrané balony',  hodnota:a=>a.pole_neutral||0},
];

// Součet přes všechny sety zápasu, po hráčkách.
function soucty(){
  const m=new Map();
  d.statistiky.forEach(s=>{
    if(!s.hrac_id)return;
    const a=m.get(s.hrac_id)||{};
    Object.keys(s).forEach(k=>{
      if(typeof s[k]==='number'&&!META_SLOUPCE.includes(k))a[k]=(a[k]||0)+s[k];
    });
    m.set(s.hrac_id,a);
  });
  return m;
}

/* Pořadí se dělí: dvě hráčky s osmi body jsou obě druhé. Když se o pátou
   příčku dělí víc hráček, vejdou se tam všechny — uříznout někoho se stejným
   číslem by byla lež o tom, kdo je lepší. */
function zebricek(soucty,hodnota){
  const vse=[...soucty.entries()]
    .map(([id,a])=>({hrac:hracka(id),hodnota:hodnota(a)}))
    .filter(x=>x.hrac&&x.hodnota>0)
    .sort((a,b)=>b.hodnota-a.hodnota||a.hrac.jmeno.localeCompare(b.hrac.jmeno,'cs'));
  if(!vse.length)return [];
  const mez=vse.length>TOP_N?vse[TOP_N-1].hodnota:0;
  const vybrane=vse.filter(x=>x.hodnota>=mez);
  let poradi=0,predchozi=null;
  return vybrane.map((x,i)=>{
    if(x.hodnota!==predchozi){poradi=i+1;predchozi=x.hodnota;}
    return {...x,poradi};
  });
}

function zebrickyHtml(){
  const m=soucty();
  const bloky=ZEBRICKY.map(z=>({...z,radky:zebricek(m,z.hodnota)}))
                      .filter(z=>z.radky.length);
  if(!bloky.length)return '';
  return `<div class="divak-blok" id="divak-zebricky">
    <div class="divak-radek"><span class="divak-nazev">Nejlepší v zápase</span></div>
    <div class="divak-zebricky">${bloky.map(z=>`<div class="divak-zebricek">
      <div class="zebricek-nadpis">${esc(z.nadpis)}<span class="zebricek-popis">${esc(z.popis)}</span></div>
      ${z.radky.map(r=>`<div class="zebricek-radek">
        <span class="zebricek-poradi">${r.poradi}.</span>
        <span class="zebricek-jmeno">${jmenoSCislem(r.hrac)}</span>
        <span class="zebricek-hodnota">${r.hodnota}</span>
      </div>`).join('')}
    </div>`).join('')}</div>
  </div>`;
}

function patickaHtml(){
  if(d.chyba)return `<div class="divak-paticka chyba">Spojení vázne — ukazuju poslední načtená data.</div>`;
  if(!d.nacteno)return '';
  const pred=Math.round((Date.now()-d.nacteno.getTime())/1000);
  return `<div class="divak-paticka">Aktualizováno před ${pred} s</div>`;
}

function vykresli(){
  const el=document.getElementById('divak');
  if(!zapasZAdresy()){
    el.innerHTML=seznamHtml()+patickaHtml();
    document.title='Volejbal — zápasy';
    return;
  }
  if(!d.zapas){
    el.innerHTML=`<a class="divak-zpet" href="divak.html">← Zápasy</a>
    <div class="divak-nehraje">
      <div class="divak-nehraje-ikona">🏐</div>
      <div class="divak-nehraje-text">${d.chyba
        ?'Data se nepodařilo načíst.':'Tenhle zápas tu není.'}</div>
      <div class="divak-nehraje-popis">${d.chyba
        ?'Zkusím to znovu za chvíli.':'Nejspíš ho někdo smazal — vyber si ze seznamu.'}</div>
    </div>`+patickaHtml();
    document.title='Volejbal — zápasy';
    return;
  }
  el.innerHTML=hlavickaHtml()+skoreHtml()+
    `<div class="divak-blok" id="divak-hriste">${hristeHtml()}${podaniHtml()}</div>`+
    `<div class="divak-blok" id="divak-prubeh">${prubehHtml()}</div>`+
    zebrickyHtml()+patickaHtml();
  document.title=`${d.zapas.soupet} — živě`;
}

// Rychle jen tam, kde se čísla opravdu mění: dohraný zápas ani seznam bez
// rozehraného se za pět vteřin nezmění a tahat kvůli tomu data je plýtvání.
function naplanuj(){
  clearTimeout(obnovaTimer);
  const zive=zapasZAdresy()
    ?d.zapas&&d.zapas.stav===STAV.PROBIHA
    :d.zapasy.some(z=>z.stav===STAV.PROBIHA);
  obnovaTimer=setTimeout(tik,zive?OBNOVA_ZIVE_MS:OBNOVA_KLID_MS);
}

async function tik(){
  // schovaná záložka nepotřebuje data; šetří to baterku i přenos
  if(!document.hidden)await nacti();
  naplanuj();
}

document.addEventListener('visibilitychange',()=>{if(!document.hidden)tik();});
nacti().then(naplanuj);
