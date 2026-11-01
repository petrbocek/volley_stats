-- Číslo dresu patří k týmu, ne k hráčce: jedna hráčka hraje ve víc týmech
-- a ne všude má stejné číslo. Dřív bylo číslo jen na vb_hraci, takže si ho
-- hráčka nesla do všech týmů — a ve třech týmech tím vznikly dvojice se
-- stejným číslem (U16Z #5, U18Z #9, U20Z #13).
--
-- Na vb_hraci.cislo zůstává obvyklé číslo jako výchozí a tým ho jen přebíjí.
-- Vyplní se tak jen výjimky, ne všechny soupisky znovu (#130).
alter table vb_hraci_tymy add column if not exists cislo smallint;

comment on column vb_hraci_tymy.cislo is
  'Číslo dresu v tomto týmu. NULL = platí obvyklé číslo z vb_hraci.cislo.';
