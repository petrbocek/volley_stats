const SB_URL='https://cqcjdslqygayijxfhzof.supabase.co';
const SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNxY2pkc2xxeWdheWlqeGZoem9mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyNDYxMTcsImV4cCI6MjA5MzgyMjExN30.8RxdnXDybGehH9pMKxNkJuXw5f_vIGjfSRE_-tJciK0';

/* ─── SDÍLENÁ PRAVIDLA ───
   Co je bod, jak jdou posty po zónách, jak se z logu skládají výměny. Tohle
   potřebuje zapisovatelská appka (app.js) i divácká stránka (divak.js), a
   smí to existovat jen jednou: kdyby si každá strana počítala skóre po svém,
   jednou se rozejdou a nikdo nepozná, která má pravdu (#102).

   Jsou to čisté funkce nad předanými daty — žádné sahání do stavu appky,
   žádné DOM. Kdo chce pracovat se `state`, obalí si je u sebe. Jedinou
   výjimkou je animace rotace na konci souboru: kreslí hřiště obou stránek
   a dvě kopie by se časem rozešly. */

/* Slovník stavů zápasu. Psát si ho po paměti znamená přehlédnout, že
   „probíhající" je v datech `probihajici` — divácká stránka se přesně na tom
   utkala a testy to nechytily, protože měly v fixture tutéž vymyšlenou
   hodnotu (#102). */
const STAV={PLANOVANY:'planovany',PROBIHA:'probihajici',DOKONCENY:'dokonceny'};

function stavLabel(s){
  return s===STAV.PLANOVANY?'Plánovaný':s===STAV.PROBIHA?'Probíhá':'Dokončený';
}

const SETU=5;                    // strop: víc setů se neodehraje ani na tři vítězné
const ODDECHOVE_NA_SET=2;
const STRIDANI_NA_SET=8;         // nové pravidlo, dřív šest

const ACTIONS=[
  {key:'servis',label:'Servis',icon:'🎯',color:'#4dabf7'},
  {key:'prijem',label:'Příjem',icon:'🤲',color:'#51cf66'},
  // Volný míč (freeball) se zapisuje u útoku, protože tam při zápisu sahá
  // ruka — ale útočný pokus to není, viz komentář u VARIANTS (#122).
  {key:'utok',label:'Útok',icon:'💥',varianty:['plus','neutral','minus','free'],color:'#f97316'},
  {key:'blok',label:'Blok',icon:'🛡️',varianty:['plus'],color:'#7950f2'},
  {key:'chyba',label:'Chyba',icon:'❌',varianty:['minus'],color:'#ff6b6b'},
  // Pole (dig) je vybraný balon. Zatím se vede jen počet, protože je to pokus,
  // ne bodovaná akce — proto neutrální varianta, ta znamená „výměna
  // pokračuje" a do skóre se nepropisuje (#84).
  /* Pole drží tři věci, které se klepají na stejném místě, ale znamenají
     každá něco jiného: `/` vybraný balon po útoku (obrana), `−` balon, který
     spadl (ztracený bod jako každé jiné minus) a `~` zvednutý volný míč od
     soupeře. Bez toho rozdělení byla obrana smíchaná s volnými míči a číslo
     za obranu vycházelo líp, než jaká obrana opravdu byla (#124). */
  {key:'pole',label:'Pole',icon:'🖐️',varianty:['neutral','minus','free'],color:'#20c997'},
];
/* Tři základní varianty má každá akce, pokud si neřekne jinak. Čtvrtá,
   `free`, je volný míč přehozený soupeři — má ji jen útok a nesmí se sama
   přidávat ostatním, jinak by servisu i příjmu přibyl sloupec, který pro ně
   nic neznamená.

   Útočný pokus je pokus ukončit výměnu; volný míč je přiznání, že se
   zakončit nedá. Proto je stranou útočného procenta i pokusů — stejně jako
   to mají profi nástroje (Data Volley ho kóduje jako `F`). Znak `~` čte
   „jen to přehodila" a nepotká se s `+`, `/` ani `−` (#122). */
const ZAKLADNI_VARIANTY=['plus','neutral','minus'];
const VARIANTS=[
  {suf:'plus',sym:'+',cls:'plus'},
  {suf:'neutral',sym:'/',cls:'neutral'},
  {suf:'minus',sym:'−',cls:'minus'},
  {suf:'free',sym:'~',cls:'free'},
];

// Varianty jedné akce. Jediné místo, kde se rozhoduje, co se komu nabídne.
function variantyAkce(a){
  return VARIANTS.filter(v=>(a.varianty||ZAKLADNI_VARIANTY).includes(v.suf));
}

// Všechna pole statistik, která akce drží — pro součty a nulování řádků.
function polaAkci(){
  return ACTIONS.flatMap(a=>variantyAkce(a).map(v=>`${a.key}_${v.suf}`));
}

function popisAkce(field){
  const [klic,suf]=field.split('_');
  const a=ACTIONS.find(x=>x.key===klic);
  const v=VARIANTS.find(x=>x.suf===suf);
  return `${a?a.label:klic} ${v?v.sym:suf}`;
}

/* Platí dohoda z #84: podání, smeč a blok jsou bodované, každé minus je
   ztracený bod, plus a neutral u příjmu je kvalita. Chyby a body soupeře
   doplňují to, co se na naší straně nezapíše. */
const SKORE_NASE=['servis_plus','utok_plus','blok_plus'];
const SKORE_JEJICH=['servis_minus','prijem_minus','utok_minus','chyba_minus','pole_minus'];

// Komu výměna přinesla bod; null = neutrální akce, výměna pokračuje.
const POLE_BOD_MY=['servis_plus','utok_plus','blok_plus'];
const POLE_BOD_ONI=['servis_minus','prijem_minus','utok_minus','chyba_minus','pole_minus'];

function komuBod(pole){
  if(pole==='souper_chyba')return 'my';
  if(pole==='souper_bod')return 'oni';
  if(POLE_BOD_MY.includes(pole))return 'my';
  if(POLE_BOD_ONI.includes(pole))return 'oni';
  return null;
}

// Skóre z hotových řádků statistik. Zapisovatelská appka má vlastní cestu
// přes rozepsané kliky (getStatVal), divák čte jen to, co došlo na server.
function skoreZRadku(radky,souper){
  const soucet=pole=>radky.reduce((n,r)=>n+pole.reduce((m,f)=>m+(r[f]||0),0),0);
  return {
    nase:soucet(SKORE_NASE)+((souper&&souper.pocet)||0),
    jejich:soucet(SKORE_JEJICH)+((souper&&souper.body)||0),
  };
}

/* ─── HŘIŠTĚ ───
   Síť vpravo: standardní schéma otočené o 90°. Pravý sloupec je u sítě
   (4-3-2 shora dolů), levý zadní řada (5-6-1), takže zóna 1 je vlevo dole.
   Zóny 7 a 8 jsou sloty pro libera mimo hřiště. */
const ZONY_ROZLOZENI=[[5,4],[6,3],[1,2]];
const ZONY_LIBERO=[7,8];

// Hráčky se posouvají 2→1→6→5→4→3→2, tedy o zónu zpět, a z jedničky na šestku.
function poRotaci(zona,kroku){
  return ((zona-1-kroku)%6+6)%6+1;
}

/* Posty se nedají brát z nastavení hráčky — jedna holka hraje podle potřeby
   smečařku i univerzálku. Postavení je ale dané: po zónách jde proti směru
   hodin N-S-B-U-S-B od nahrávačky (#84). */
const POSTY_ZON=['nahrávač','smečař','blokař','universál','smečař','blokař'];
const POST_ZKRATKA={'nahrávač':'N','smečař':'S','blokař':'B','universál':'U','libero':'L'};

function postZony(zona,zonaNahravacky){
  if(!zonaNahravacky||zona<1||zona>6)return null;
  return POSTY_ZON[(zona-zonaNahravacky+6)%6];
}

/* ─── VÝMĚNY Z LOGU ───
   Podání přechází, když bod získá ten, kdo nepodával. Z toho a z prvního
   podání plyne u každé výměny, kdo podával — a tedy co byl side-out.

   `udalosti` musí přijít seřazené podle id (pořadí zápisu). */
function vymenyZLogu(udalosti,prvniPodani){
  let podava=prvniPodani||null;
  let serie={kdo:null,delka:0},nejdelsi={my:0,oni:0};
  const vymeny=[];
  let obrany=[],volne=[];                  // kdo v rozehrané výměně vybral balon
  udalosti.forEach(u=>{                    // a kdo zvedl volný míč
    const bod=komuBod(u.pole);
    if(!bod){                              // výměna pokračovala
      if(u.pole==='pole_neutral'&&u.hrac_id)obrany.push(u.hrac_id);
      if(u.pole==='pole_free'&&u.hrac_id)volne.push(u.hrac_id);
      return;
    }
    vymeny.push({podaval:podava,bod,zona1:u.zona1_hrac_id||null,pole:u.pole,
                 hrac_id:u.hrac_id,obrany,volne});
    obrany=[];volne=[];
    if(serie.kdo===bod)serie.delka++;else serie={kdo:bod,delka:1};
    if(serie.delka>nejdelsi[bod])nejdelsi[bod]=serie.delka;
    if(podava&&bod!==podava)podava=bod;    // ztráta podání
    else if(!podava)podava=bod;            // bez prvního podání se aspoň chytneme
  });
  return {vymeny,serie,nejdelsi,podavaTed:podava,znamePrvni:!!prvniPodani};
}

// Průběh stavu: co výměna, to stav po ní. Break = bod získaný při podání toho
// druhého; bez známého prvního podání se to nepozná, tak se nic nehádá.
function prubehZVymen(vymeny){
  let my=0,oni=0;
  return vymeny.map((v,i)=>{
    if(v.bod==='my')my++;else oni++;
    return {poradi:i+1,bod:v.bod,my,oni,break:!!v.podaval&&v.podaval!==v.bod,
            podaval:v.podaval||null,pole:v.pole,hrac_id:v.hrac_id||null};
  });
}

// Jak často uhrajeme výměnu, když podává soupeř. Podle prohlížených appek je
// to hlavní živá metrika; dobrá hodnota startuje kolem 60 %.
function sideOutZVymen(vymeny,znamePrvni){
  if(!znamePrvni)return null;
  const prijem=vymeny.filter(v=>v.podaval==='oni');
  if(!prijem.length)return {pct:null,uhrano:0,celkem:0};
  const uhrano=prijem.filter(v=>v.bod==='my').length;
  return {pct:Math.round(uhrano/prijem.length*100),uhrano,celkem:prijem.length};
}

/* ─── ŠESTKA SOUPEŘE ───
   Zapisuje se jen zahajovací postavení setu — šest čísel z dresů v pořadí
   zón. Soupeř rotuje přesně tehdy, když získá podání, a to v logu výměn
   už je, takže aktuální rotace se dopočítá a nestojí ani klik navíc. Je to
   stejná úvaha, na které stojí rotace naší šestky (#84, #107). */

/* Síť je vlevo a strana je překlopená v obou osách: u sítě jejich 2-3-4
   (shora dolů), vzadu 1-6-5. Jejich dvojka tak stojí proti naší čtyřce —
   tedy proti sobě ti, kdo se přes síť opravdu vidí. */
const ZONY_ROZLOZENI_SOUPER=[[2,1],[3,6],[4,5]];

// O kolik zón soupeř od začátku setu zrotoval. Bez prvního podání se nepozná,
// kdo kterou výměnu podával — pak se nic nehádá a vrací se null.
function souperRotaci(vymeny,znamePrvni){
  if(!znamePrvni)return null;
  return (vymeny||[]).filter(v=>v.bod===STRANY.ONI&&v.podaval===STRANY.MY).length;
}

// Čísla po zónách tak, jak soupeř stojí teď. `sestava` je pole šesti čísel
// v pořadí zón 1-6, prázdná zóna je null.
function souperPostaveni(sestava,kroku){
  const m=new Map();
  if(!Array.isArray(sestava)||sestava.length!==6)return m;
  sestava.forEach((cislo,i)=>m.set(poRotaci(i+1,kroku||0),cislo??null));
  return m;
}

/* Opačný směr: z toho, jak stojí teď, zpátky na zahajovací šestku. Tím se
   rozešlá rotace (po jejich střídání) srovná jedním zadáním a dopočet
   zůstane jediným pravidlem — nevznikne druhá pravda o tom, kde kdo stojí. */
function souperSestavaZeTed(m,kroku){
  const out=[];
  for(let z=1;z<=6;z++)out.push(m.get(poRotaci(z,kroku||0))??null);
  return out;
}

/* ─── KONVERZE Z OBRANY ───
   Počet vybraných balonů sám o sobě měří hlavně to, kolikrát do nás soupeř
   útočil. Co se dá číst, je kolik rozeher s obranou skončilo naším bodem —
   kvůli tomu se vybírá. Stejnou cestou jdou profi nástroje, jen tam se
   obrana navíc známkuje; tohle se spočítá z logu bez jediného kliku (#120).

   Není to zásluha jedné hráčky: po obraně ještě někdo nahrává a zakončuje,
   takže je to vlastnost výměny. S hráčkou se počítají výměny, ve kterých
   vybírala ona — a když vybírala dvakrát, pořád je to jedna výměna. */
function konverzeZVymen(vymeny,klic,hracId){
  const s=(vymeny||[]).filter(v=>v[klic]&&v[klic].length&&
    (hracId==null||v[klic].includes(hracId)));
  if(!s.length)return null;
  const nase=s.filter(v=>v.bod===STRANY.MY).length;
  return {pct:Math.round(nase/s.length*100),nase,celkem:s.length};
}

// Obrana po útoku a zvednutý volný míč jsou dvě různé věci: volný míč se
// uhrává líp, tak ať se jeho procento nevydává za obranu (#124).
function konverzeZObrany(vymeny,hracId){return konverzeZVymen(vymeny,'obrany',hracId);}
function konverzeZVolneho(vymeny,hracId){return konverzeZVymen(vymeny,'volne',hracId);}

/* ─── PŘERUŠENÍ ───
   Time-out a střídání nemají v logu výměn pořadí — vedou se zvlášť, každé se
   stavem, ve kterém padlo. Do průběhu se proto vkládají podle skóre: za
   výměnu, která na ten stav dovedla. Přesnější pořadí by znamenalo ukládat
   i pozici ve výměnách; na zorientování stav stačí a nestojí to klik navíc.

   Strana rozlišuje naše přerušení od soupeřových (#107). Řádky zapsané před
   tím sloupec nemají — všechno, co je v datech starší, je naše. */
const STRANY={MY:'my',ONI:'oni'};

function prerusenaZRadku(oddechove,stridani){
  const prerusy=[];
  (oddechove||[]).forEach(o=>prerusy.push({typ:'timeout',strana:o.strana||STRANY.MY,
    my:o.skore_my,oni:o.skore_oni,id:o.id}));
  (stridani||[]).forEach(x=>prerusy.push({typ:'stridani',strana:x.strana||STRANY.MY,
    my:x.skore_my,oni:x.skore_oni,id:x.id,
    hrac_ven:x.hrac_ven||null,hrac_dovnitr:x.hrac_dovnitr||null,
    cislo_ven:x.cislo_ven??null,cislo_dovnitr:x.cislo_dovnitr??null}));
  return prerusy;
}

// Výměny a přerušení do jednoho seznamu, seřazené podle stavu.
function prubehSPrerusenimi(kroky,prerusy){
  const vymeny=(kroky||[]).map(k=>({...k,typ:'vymena'}));
  // index poslední výměny, po které stav sedí; před první výměnou → na začátek
  const kam=p=>{let i=-1;vymeny.forEach((k,j)=>{if(k.my<=p.my&&k.oni<=p.oni)i=j;});return i;};
  const umisteni=(prerusy||[]).map(p=>({...p,po:kam(p)}));
  const vysledek=[];
  vymeny.forEach((k,i)=>{
    vysledek.push(k);
    umisteni.filter(r=>r.po===i).forEach(r=>vysledek.push(r));
  });
  return [...umisteni.filter(r=>r.po===-1),...vysledek];
}

/* ─── ANIMACE ROTACE ───
   Jediné místo v tomhle souboru, které sahá na DOM. Je tu proto, že hřiště
   kreslí appka i divácká stránka a rotace má vypadat stejně v obou — dvě
   kopie téhle funkce by se časem rozešly (#107).

   Karty se překreslují celé, takže se poloha musí změřit před překreslením
   a po něm a rozdíl dojet transformem. Nehlídá se, jestli se opravdu
   rotovalo: co se nehnulo, má nulový rozdíl a nic se nekreslí. */
const ROTACE_MS=360;

/* Animuje se i soupeřova strana, když je zadaná (#107) — klíčem je tam číslo
   na dresu s předponou, aby se nepotkalo s id našich hráček. */
const ZONY_K_ANIMACI='.hriste .hriste-zona[data-hrac],.hriste-souper .hriste-zona[data-hrac]';

function zmerZony(){
  const m=new Map();
  document.querySelectorAll(ZONY_K_ANIMACI)
    .forEach(el=>m.set(el.dataset.hrac,el.getBoundingClientRect()));
  return m;
}

function dojedZony(pred){
  if(!pred||!pred.size)return;
  // kdo si vypnul animace v systému, ten je tu mít nemá
  if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  document.querySelectorAll(ZONY_K_ANIMACI).forEach(el=>{
    const r=pred.get(el.dataset.hrac);
    if(!r)return;
    const n=el.getBoundingClientRect();
    const dx=Math.round(r.left-n.left),dy=Math.round(r.top-n.top);
    if(!dx&&!dy)return;
    el.style.transition='none';
    el.style.transform=`translate(${dx}px,${dy}px)`;
    el.classList.add('rotuje');
    // dvakrát: první snímek usadí výchozí pozici, teprve druhý se animuje
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      el.style.transition=`transform ${ROTACE_MS}ms cubic-bezier(.2,.7,.3,1)`;
      el.style.transform='';
      setTimeout(()=>{
        el.style.transition='';el.style.transform='';el.classList.remove('rotuje');
      },ROTACE_MS);
    }));
  });
}
