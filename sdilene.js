const SB_URL='https://cqcjdslqygayijxfhzof.supabase.co';
const SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNxY2pkc2xxeWdheWlqeGZoem9mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyNDYxMTcsImV4cCI6MjA5MzgyMjExN30.8RxdnXDybGehH9pMKxNkJuXw5f_vIGjfSRE_-tJciK0';

/* ─── SDÍLENÁ PRAVIDLA ───
   Co je bod, jak jdou posty po zónách, jak se z logu skládají výměny. Tohle
   potřebuje zapisovatelská appka (app.js) i divácká stránka (divak.js), a
   smí to existovat jen jednou: kdyby si každá strana počítala skóre po svém,
   jednou se rozejdou a nikdo nepozná, která má pravdu (#102).

   Jsou to čisté funkce nad předanými daty — žádné sahání do stavu appky,
   žádné DOM. Kdo chce pracovat se `state`, obalí si je u sebe. */

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
  {key:'utok',label:'Útok',icon:'💥',color:'#f97316'},
  {key:'blok',label:'Blok',icon:'🛡️',varianty:['plus'],color:'#7950f2'},
  {key:'chyba',label:'Chyba',icon:'❌',varianty:['minus'],color:'#ff6b6b'},
  // Pole (dig) je vybraný balon. Zatím se vede jen počet, protože je to pokus,
  // ne bodovaná akce — proto neutrální varianta, ta znamená „výměna
  // pokračuje" a do skóre se nepropisuje (#84).
  {key:'pole',label:'Pole',icon:'🖐️',varianty:['neutral'],color:'#20c997'},
];
const VARIANTS=[
  {suf:'plus',sym:'+',cls:'plus'},
  {suf:'neutral',sym:'/',cls:'neutral'},
  {suf:'minus',sym:'−',cls:'minus'},
];

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
const SKORE_JEJICH=['servis_minus','prijem_minus','utok_minus','chyba_minus'];

// Komu výměna přinesla bod; null = neutrální akce, výměna pokračuje.
const POLE_BOD_MY=['servis_plus','utok_plus','blok_plus'];
const POLE_BOD_ONI=['servis_minus','prijem_minus','utok_minus','chyba_minus'];

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
  udalosti.forEach(u=>{
    const bod=komuBod(u.pole);
    if(!bod)return;                        // výměna pokračovala
    vymeny.push({podaval:podava,bod,zona1:u.zona1_hrac_id||null,pole:u.pole,hrac_id:u.hrac_id});
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
