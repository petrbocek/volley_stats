-- Šestka soupeře na place, jen čísla na dresech (#107, část S2).
--
-- Ukládá se ZAHAJOVACÍ postavení setu, ne aktuální. Soupeř rotuje přesně
-- tehdy, když získá podání — a to už v logu výměn je. Jedno zadání za set
-- tedy stačí a aktuální rotace se dopočítá bez jediného dalšího kliku; je to
-- stejná úvaha, na které stojí rotace naší šestky (#84).
--
-- Proč sloupec ve vb_set_info a ne vlastní tabulka: šestka soupeře je šest
-- čísel, která se vždycky zapisují i mění naráz, a patří k setu stejně jako
-- první podání nebo nahrávačka vedle. Jeden řádek na set znamená jeden
-- upsert místo „smaž a vlož" ve dvou požadavcích, žádnou RPC, a divácká
-- stránka si set_info načítá tak jako tak — tahle věc nestojí ani jeden
-- dotaz navíc.
--
-- Čísla, ne jména: na place je vidět jen číslo a cizí soupisku nemáme proč
-- vést. Pořadí je po zónách 1-6 jako u nás, NULL znamená „číslo se neopsalo".
-- Že se číslo neopakuje, hlídá zadávání v appce: v databázi by to bez
-- podzapytání v CHECK nešlo a překlep je na hřišti vidět na první pohled.
ALTER TABLE public.vb_set_info
  ADD COLUMN IF NOT EXISTS souper_sestava int[];

ALTER TABLE public.vb_set_info
  ADD CONSTRAINT vb_set_info_souper_sestava_sest
  CHECK (souper_sestava IS NULL OR array_length(souper_sestava, 1) = 6);

COMMENT ON COLUMN public.vb_set_info.souper_sestava IS
  'Zahajovací šestka soupeře v setu: šest čísel na dresech v pořadí zón 1-6, NULL kde se číslo neopsalo. Aktuální rotace se odvozuje z logu výměn, nezapisuje se.';

-- RLS ani granty se nepřidávají: vb_set_info je má z #84 (čtení veřejné,
-- zápis jen zapisovatel) a nový sloupec jede pod nimi.

-- Prázdná tabulka z prvního pokusu. Napřed to byla vlastní tabulka
-- (zapas_id, set_cislo, zona, cislo) s RPC, která celou šestku vyměňovala
-- v jedné transakci; sloupec ve vb_set_info dělá totéž jedním upsertem, tak
-- je zbytečná. Nikdy do ní nic nepřišlo a v produkci už je smazaná.
DROP TABLE IF EXISTS public.vb_souper_postaveni;
