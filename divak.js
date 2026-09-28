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

const d={zapas:null,hraci:[],sestava:[],statistiky:[],chyby:[],postaveni:[],
         setInfo:[],udalosti:[],oddechove:[],set:1,nacteno:null,chyba:null};
let obnovaTimer=null;

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function ziskej(dotaz){
  const r=await fetch(`${SB_URL}/rest/v1/${dotaz}`,{
    headers:{apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`}
  });
  if(!r.ok)throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

// Ukazuje se jedině rozehraný zápas — adresa je jedna pro celou halu a nikdo
// nemá co vybírat (#102). Turnajový den může mít rozehraných víc, bere se
// nejnovější; ptáme se na to při každé obnově, takže se stránka po ukončení
// zápasu sama přepne na další.
async function vyberZapas(){
  const probiha=await ziskej(`vb_zapasy?stav=eq.${STAV.PROBIHA}&order=datum.desc,id.desc&limit=1`);
  return probiha[0]||null;
}

async function nacti(){
  try{
    const zapas=await vyberZapas();
    if(!zapas){d.zapas=null;d.chyba=null;d.nacteno=new Date();vykresli();return;}
    d.zapas=zapas;
    const id=zapas.id;
    const [sestava,statistiky,chyby,postaveni,setInfo,udalosti,oddechove]=await Promise.all([
      ziskej(`vb_zapas_hraci?zapas_id=eq.${id}`),
      ziskej(`vb_statistiky?zapas_id=eq.${id}`),
      ziskej(`vb_chyby_souperu?zapas_id=eq.${id}`),
      ziskej(`vb_postaveni?zapas_id=eq.${id}`),
      ziskej(`vb_set_info?zapas_id=eq.${id}`),
      ziskej(`vb_udalosti?zapas_id=eq.${id}&order=id.asc`),
      ziskej(`vb_oddechove_casy?zapas_id=eq.${id}&order=id.asc`),
    ]);
    d.sestava=sestava;d.statistiky=statistiky;d.chyby=chyby;d.postaveni=postaveni;
    d.setInfo=setInfo;d.udalosti=udalosti;d.oddechove=oddechove;
    // hráčky dotahuju až podle sestavy, ne celou kartotéku
    const ids=[...new Set(sestava.map(s=>s.hrac_id))];
    d.hraci=ids.length?await ziskej(`vb_hraci?id=in.(${ids.join(',')})`):[];
    d.set=rozehranySet();
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
function setMaData(set){
  return d.statistiky.some(s=>(s.set_cislo||1)===set&&
           Object.keys(s).some(k=>k.includes('_')&&s[k]>0))||
         d.chyby.some(c=>(c.set_cislo||1)===set&&((c.pocet||0)+(c.body||0))>0)||
         d.udalosti.some(u=>(u.set_cislo||1)===set)||
         d.postaveni.some(p=>(p.set_cislo||1)===set);
}

function rozehranySet(){
  for(let s=SETU;s>=1;s--)if(setMaData(s))return s;
  return 1;
}

function skoreSetu(set){
  const radky=d.statistiky.filter(s=>(s.set_cislo||1)===set);
  const souper=d.chyby.find(c=>(c.set_cislo||1)===set);
  return skoreZRadku(radky,souper);
}

function viteznychSetu(){return d.zapas&&d.zapas.vitezne_sety===2?2:3;}
function setuVZapase(){return viteznychSetu()*2-1;}

function setRozhodnuty(set){
  const my=d.zapas?.[`set${set}_my`],oni=d.zapas?.[`set${set}_oni`];
  const s=(my!=null&&oni!=null)?{nase:my,jejich:oni}:skoreSetu(set);
  const cil=set===setuVZapase()?15:25;
  if(Math.max(s.nase,s.jejich)<cil||Math.abs(s.nase-s.jejich)<2)return null;
  return s.nase>s.jejich?'my':'oni';
}

function stavUtkani(){
  let my=0,oni=0;
  for(let set=1;set<=setuVZapase();set++){
    const v=setRozhodnuty(set);
    if(v==='my')my++;else if(v==='oni')oni++;
  }
  return {my,oni};
}

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

function hlavickaHtml(){
  const z=d.zapas;
  const u=stavUtkani();
  const stav=stavLabel(z.stav);
  const datum=z.datum?z.datum.split('-').reverse().join('. '):'';
  return `<div class="divak-hlavicka">
    <div class="divak-zapas">
      <div class="divak-soupet">${esc(z.soupet)}</div>
      <div class="divak-detail">${esc(datum)}${z.cas?` · ${esc(z.cas.slice(0,5))}`:''} · ${esc(stav)}</div>
    </div>
    <div class="divak-sety"><span class="divak-sety-popis">Sety</span>
      <span class="divak-sety-cislo">${u.my}:${u.oni}</span></div>
  </div>`;
}

function skoreHtml(){
  const s=skoreSetu(d.set);
  const sety=[];
  for(let i=1;i<=setuVZapase();i++)if(setMaData(i)||i===d.set){
    const ss=skoreSetu(i);
    sety.push(`<span class="skore-set${i===d.set?' aktivni':''}">${i}. ${ss.nase}:${ss.jejich}</span>`);
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

function prubehHtml(){
  const {vymeny,znamePrvni}=vymenySetu(d.set);
  const kroky=prubehZVymen(vymeny);
  if(!kroky.length)return '<div class="divak-prazdno">V tomhle setu zatím není zapsaná žádná výměna.</div>';
  const so=sideOutZVymen(vymeny,znamePrvni);
  const posledni=[...kroky].reverse().slice(0,VYMEN_V_SEZNAMU);
  return `<div class="divak-radek">
      <span class="divak-nazev" title="Sytě = zisk podání">Průběh</span>
      <span class="prubeh-pas">${kroky.map(k=>
        `<span class="prubeh-tik ${k.bod}${k.break?' break':''}"
          title="${k.my}:${k.oni}"></span>`).join('')}</span>
      ${so&&so.pct!=null?`<span class="divak-proc">Side-out ${so.pct}%</span>`:''}
    </div>
    <div class="prubeh-seznam">${posledni.map(k=>{
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
    ${kroky.length>VYMEN_V_SEZNAMU?`<div class="divak-vic">Zobrazeno posledních ${VYMEN_V_SEZNAMU} z ${kroky.length} výměn.</div>`:''}`;
}

function patickaHtml(){
  if(d.chyba)return `<div class="divak-paticka chyba">Spojení vázne — ukazuju poslední načtená data.</div>`;
  if(!d.nacteno)return '';
  const pred=Math.round((Date.now()-d.nacteno.getTime())/1000);
  return `<div class="divak-paticka">Aktualizováno před ${pred} s</div>`;
}

function vykresli(){
  const el=document.getElementById('divak');
  if(!d.zapas){
    el.innerHTML=`<div class="divak-nehraje">
      <div class="divak-nehraje-ikona">🏐</div>
      <div class="divak-nehraje-text">${d.chyba
        ?'Data se nepodařilo načíst.':'Teď se nehraje.'}</div>
      <div class="divak-nehraje-popis">${d.chyba
        ?'Zkusím to znovu za chvíli.':'Až zápas začne, objeví se tu sám.'}</div>
    </div>`+patickaHtml();
    document.title='Volejbal — živě';
    return;
  }
  el.innerHTML=hlavickaHtml()+skoreHtml()+
    `<div class="divak-blok" id="divak-hriste">${hristeHtml()}${podaniHtml()}</div>`+
    `<div class="divak-blok" id="divak-prubeh">${prubehHtml()}</div>`+patickaHtml();
  document.title=`${d.zapas.soupet} — živě`;
}

function naplanuj(){
  clearTimeout(obnovaTimer);
  const jak=d.zapas?OBNOVA_ZIVE_MS:OBNOVA_KLID_MS;   // co je na obrazovce, to se hraje
  obnovaTimer=setTimeout(tik,jak);
}

async function tik(){
  // schovaná záložka nepotřebuje data; šetří to baterku i přenos
  if(!document.hidden)await nacti();
  naplanuj();
}

document.addEventListener('visibilitychange',()=>{if(!document.hidden)tik();});
nacti().then(naplanuj);
