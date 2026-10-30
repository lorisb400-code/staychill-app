-- =====================================================================
-- StayChill - MODERAZIONE (da eseguire DOPO schema.sql)
-- Supabase > SQL Editor > New query > incolla tutto > Run.
-- Si può rieseguire senza danni.
--
-- Cosa aggiunge:
--  * amministratori: possono eliminare qualsiasi luogo/spot/foto e bloccare utenti
--  * utenti bloccati: non possono più pubblicare, votare o segnalare
--  * "Segnala" anche sui luoghi della General map (3 segnalazioni = nascosto)
--  * parole vietate controllate dal database (tabella banned_words, modificabile
--    da Supabase > Table Editor > banned_words)
-- =====================================================================

-- ---------- Chiusura di un buco: nessuno modifica più il proprio profilo da app
drop policy if exists "profiles update own" on public.profiles;

alter table public.profiles add column if not exists banned boolean not null default false;

-- ---------- Amministratori
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.admins enable row level security;
drop policy if exists "admins read self" on public.admins;
create policy "admins read self" on public.admins for select to authenticated using (user_id = auth.uid());

-- Il PRIMO account registrato (il tuo) diventa amministratore.
insert into public.admins (user_id)
select id from auth.users order by created_at asc limit 1
on conflict do nothing;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

create or replace function public.is_banned() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select banned from public.profiles where id = auth.uid()), false)
$$;

-- Bloccare / sbloccare un utente (solo admin)
create or replace function public.set_banned(target uuid, value boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Solo gli amministratori possono farlo'; end if;
  if target = auth.uid() then raise exception 'Non puoi bloccare te stesso'; end if;
  update public.profiles set banned = value where id = target;
end $$;

-- ---------- Parole vietate
create table if not exists public.banned_words (
  word text primary key,
  -- 'parola' = vietata come parola intera o come inizio di parola (es. "stronz" blocca stronzo/stronza)
  -- 'esatta' = vietata solo come parola intera (per evitare falsi allarmi, es. "negro" ma non "negroni")
  -- 'frase'  = vietata ovunque compaia, anche senza spazi (es. "porcodio", "porco dio", "p.o.r.c.o d.i.o")
  mode text not null default 'parola' check (mode in ('parola', 'esatta', 'frase')),
  category text
);
alter table public.banned_words enable row level security;
-- nessuna policy: dall'app nessuno la legge o la modifica; la gestisci da Supabase

-- Normalizza un testo: minuscole, senza accenti, numeri-lettere (c4zz0 -> cazzo),
-- lettere ripetute ridotte (cazzzzo -> cazo). Le parole vietate passano dalla stessa trafila.
create or replace function public.mod_normalize(t text) returns text
language plpgsql immutable as $$
declare s text;
begin
  s := lower(coalesce(t, ''));
  s := translate(s, 'àáâäãåèéêëìíîïòóôöõùúûüñç', 'aaaaaaeeeeiiiiooooouuuunc');
  s := translate(s, '4@3€1!|0$5+7', 'aaeeiiiosstt');
  s := regexp_replace(s, '[^a-z ]+', ' ', 'g');   -- tutto ciò che non è lettera diventa spazio
  s := regexp_replace(s, '([a-z])\1+', '\1', 'g'); -- lettere ripetute -> una sola
  s := regexp_replace(s, '\s+', ' ', 'g');
  return trim(s);
end $$;

-- Restituisce la prima parola vietata trovata nel testo, oppure null
create or replace function public.find_banned(t text) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  norm text := public.mod_normalize(t);
  spaced text := ' ' || norm || ' ';
  -- anche le lettere separate da punti/spazi: "c a z z o" -> "cazzo"
  joined_singles text := regexp_replace(regexp_replace(norm, '\m([a-z]) (?=[a-z]\M)', '\1', 'g'), '([a-z])\1+', '\1', 'g');
  w record;
  nw text;
begin
  if norm = '' then return null; end if;
  for w in select word, mode from public.banned_words loop
    nw := public.mod_normalize(w.word);
    if nw = '' then continue; end if;
    if w.mode = 'frase' then
      -- la frase come sequenza di parole, oppure scritta tutta attaccata (porcodio, p0rc0d10, p.o.r.c.o.d.i.o)
      if position(' ' || nw in spaced) > 0
         or position(' ' || replace(nw, ' ', '') in spaced) > 0
         or position(' ' || replace(nw, ' ', '') in ' ' || joined_singles || ' ') > 0 then return w.word; end if;
    elsif w.mode = 'esatta' then
      if position(' ' || nw || ' ' in spaced) > 0
         or position(' ' || nw || ' ' in ' ' || joined_singles || ' ') > 0 then return w.word; end if;
    else
      if position(' ' || nw in spaced) > 0
         or position(' ' || nw in ' ' || joined_singles || ' ') > 0 then return w.word; end if;
    end if;
  end loop;
  return null;
end $$;

-- Trigger: blocca l'inserimento/modifica di testi con parole vietate
create or replace function public.check_banned_words() returns trigger
language plpgsql security definer set search_path = public as $$
declare txt text; hit text;
begin
  if tg_table_name = 'places' then txt := new.name;
  elsif tg_table_name = 'spots' then txt := concat_ws(' ', new.title, new.description);
  elsif tg_table_name = 'profiles' then txt := new.username;
  end if;
  hit := public.find_banned(txt);
  if hit is not null then
    raise exception 'CONTENUTO_VIETATO' using errcode = 'P0001', hint = 'Il testo contiene parole non consentite';
  end if;
  return new;
end $$;

drop trigger if exists mod_places on public.places;
create trigger mod_places before insert or update of name on public.places
  for each row execute function public.check_banned_words();
drop trigger if exists mod_spots on public.spots;
create trigger mod_spots before insert or update of title, description on public.spots
  for each row execute function public.check_banned_words();
drop trigger if exists mod_profiles on public.profiles;
create trigger mod_profiles before insert or update of username on public.profiles
  for each row execute function public.check_banned_words();

-- Se un nome utente scelto alla registrazione è vietato, invece di bloccare la
-- registrazione gli diamo un nome neutro (utenteXXXX)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  base text := coalesce(nullif(trim(new.raw_user_meta_data->>'username'), ''), split_part(new.email, '@', 1));
  candidate text;
  n int := 0;
begin
  if public.find_banned(base) is not null then base := 'utente'; end if;
  candidate := left(base, 20);
  if char_length(candidate) < 3 then candidate := candidate || 'user'; end if;
  while exists (select 1 from public.profiles where username = candidate) loop
    n := n + 1;
    candidate := left(base, 20) || n::text;
  end loop;
  insert into public.profiles (id, username) values (new.id, candidate);
  return new;
end $$;

-- ---------- Luoghi: nascondibili e segnalabili
alter table public.places add column if not exists hidden boolean not null default false;

create table if not exists public.place_reports (
  id bigint generated always as identity primary key,
  place_id bigint not null references public.places(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (place_id, user_id)
);
alter table public.place_reports enable row level security;

create or replace function public.hide_reported_place()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.place_reports where place_id = new.place_id) >= 3 then
    update public.places set hidden = true where id = new.place_id;
  end if;
  return new;
end $$;
drop trigger if exists on_place_report_created on public.place_reports;
create trigger on_place_report_created after insert on public.place_reports
  for each row execute function public.hide_reported_place();

-- La vista dei luoghi ora include "hidden" e il numero di segnalazioni (visibile solo agli admin)
drop view if exists public.place_summary;
create view public.place_summary with (security_invoker = true) as
select
  p.id, p.name, p.lat, p.lng, p.created_by, p.created_at, p.hidden,
  count(v.*) filter (where v.emoji = 1)::int as c1,
  count(v.*) filter (where v.emoji = 2)::int as c2,
  count(v.*) filter (where v.emoji = 3)::int as c3,
  count(v.*) filter (where v.emoji = 4)::int as c4,
  count(v.*)::int as total,
  (
    select v2.emoji from public.votes v2
    where v2.place_id = p.id
    group by v2.emoji
    order by count(*) desc, v2.emoji asc
    limit 1
  ) as winner,
  (select count(*) from public.place_reports r where r.place_id = p.id)::int as reports
from public.places p
left join public.votes v on v.place_id = p.id
group by p.id;

drop view if exists public.spot_feed;
create view public.spot_feed with (security_invoker = true) as
select s.*, pr.username,
  (select count(*) from public.reports r where r.spot_id = s.id)::int as reports
from public.spots s
left join public.profiles pr on pr.id = s.user_id;

-- ---------- Regole aggiornate (admin + utenti bloccati)
drop policy if exists "places read" on public.places;
create policy "places read" on public.places for select to authenticated
  using (hidden = false or created_by = auth.uid() or public.is_admin());
drop policy if exists "places insert" on public.places;
create policy "places insert" on public.places for insert to authenticated
  with check (created_by = auth.uid() and not public.is_banned());
drop policy if exists "places delete own" on public.places;
create policy "places delete own" on public.places for delete to authenticated
  using (created_by = auth.uid() or public.is_admin());
drop policy if exists "places admin update" on public.places;
create policy "places admin update" on public.places for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "votes insert own" on public.votes;
create policy "votes insert own" on public.votes for insert to authenticated
  with check (user_id = auth.uid() and not public.is_banned());
drop policy if exists "votes update own" on public.votes;
create policy "votes update own" on public.votes for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and not public.is_banned());

drop policy if exists "spots read" on public.spots;
create policy "spots read" on public.spots for select to authenticated
  using (hidden = false or user_id = auth.uid() or public.is_admin());
drop policy if exists "spots insert own" on public.spots;
create policy "spots insert own" on public.spots for insert to authenticated
  with check (user_id = auth.uid() and not public.is_banned());
drop policy if exists "spots delete own" on public.spots;
create policy "spots delete own" on public.spots for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());
drop policy if exists "spots admin update" on public.spots;
create policy "spots admin update" on public.spots for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "reports insert own" on public.reports;
create policy "reports insert own" on public.reports for insert to authenticated
  with check (user_id = auth.uid() and not public.is_banned());
drop policy if exists "reports read own" on public.reports;
create policy "reports read own" on public.reports for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
drop policy if exists "reports admin delete" on public.reports;
create policy "reports admin delete" on public.reports for delete to authenticated using (public.is_admin());

drop policy if exists "place_reports insert own" on public.place_reports;
create policy "place_reports insert own" on public.place_reports for insert to authenticated
  with check (user_id = auth.uid() and not public.is_banned());
drop policy if exists "place_reports read" on public.place_reports;
create policy "place_reports read" on public.place_reports for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
drop policy if exists "place_reports admin delete" on public.place_reports;
create policy "place_reports admin delete" on public.place_reports for delete to authenticated using (public.is_admin());

drop policy if exists "spot photos upload" on storage.objects;
create policy "spot photos upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'spots' and (storage.foldername(name))[1] = auth.uid()::text and not public.is_banned());
drop policy if exists "spot photos delete own" on storage.objects;
create policy "spot photos delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'spots' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- ---------- Lista iniziale di parole vietate
-- Puoi aggiungerne altre da Supabase > Table Editor > banned_words > Insert row.
insert into public.banned_words (word, mode, category) values
  -- bestemmie
  ('porco dio','frase','bestemmia'), ('porcodio','frase','bestemmia'), ('dio porco','frase','bestemmia'),
  ('dio cane','frase','bestemmia'), ('diocane','frase','bestemmia'), ('dio bestia','frase','bestemmia'),
  ('dio maiale','frase','bestemmia'), ('dio boia','frase','bestemmia'), ('dio merda','frase','bestemmia'),
  ('dio stronzo','frase','bestemmia'), ('dio infame','frase','bestemmia'), ('dio ladro','frase','bestemmia'),
  ('dio serpente','frase','bestemmia'), ('dio porcone','frase','bestemmia'),
  ('porca madonna','frase','bestemmia'), ('madonna puttana','frase','bestemmia'), ('madonna troia','frase','bestemmia'),
  ('madonna maiala','frase','bestemmia'), ('porco gesu','frase','bestemmia'), ('gesu cristo porco','frase','bestemmia'),
  ('cristo porco','frase','bestemmia'), ('porco cristo','frase','bestemmia'),
  ('porcamadonna','frase','bestemmia'), ('porco giuda','frase','bestemmia'), ('dioporco','frase','bestemmia'),
  -- droghe
  ('cannabis','parola','droga'), ('marijuana','parola','droga'), ('marjuana','parola','droga'), ('mariuana','parola','droga'),
  ('hashish','parola','droga'), ('hascisc','parola','droga'), ('hash','esatta','droga'), ('ganja','parola','droga'),
  ('weed','esatta','droga'), ('skunk','esatta','droga'), ('spinello','parola','droga'), ('spinelli','parola','droga'),
  ('canne','esatta','droga'), ('cannetta','parola','droga'), ('joint','esatta','droga'), ('blunt','esatta','droga'),
  ('thc','esatta','droga'), ('cocaina','parola','droga'), ('cocaine','parola','droga'), ('eroina','esatta','droga'),
  ('heroin','parola','droga'), ('ketamina','parola','droga'), ('ketamine','parola','droga'), ('keta','esatta','droga'),
  ('mdma','esatta','droga'), ('ecstasy','parola','droga'), ('lsd','esatta','droga'), ('anfetamin','parola','droga'),
  ('metanfetamin','parola','droga'), ('crystal meth','frase','droga'), ('crack','esatta','droga'), ('oppio','parola','droga'),
  ('oppiacei','parola','droga'), ('fentanil','parola','droga'), ('fentanyl','parola','droga'), ('spaccio','parola','droga'),
  ('spacciare','parola','droga'), ('spacciatore','parola','droga'), ('pusher','esatta','droga'), ('dealer','esatta','droga'),
  ('funghetti','parola','droga'), ('psilocibin','parola','droga'), ('droga','parola','droga'), ('drogarsi','parola','droga'),
  ('sballo','parola','droga'), ('sballarsi','parola','droga'), ('fattone','parola','droga'), ('canapa','parola','droga'),
  -- pedofilia e abusi su minori
  ('pedofil','parola','minori'), ('pedopornograf','parola','minori'), ('pedo','esatta','minori'),
  ('child porn','frase','minori'), ('porno minorenn','frase','minori'), ('minorenni nud','frase','minori'),
  ('abusi su minori','frase','minori'),
  -- insulti, volgarità e contenuti sessuali
  ('cazzo','parola','volgarita'), ('cazzi','parola','volgarita'), ('minchia','parola','volgarita'), ('stronz','parola','volgarita'),
  ('vaffanculo','parola','volgarita'), ('fanculo','parola','volgarita'), ('affanculo','parola','volgarita'),
  ('puttan','parola','volgarita'), ('troia','esatta','volgarita'), ('troie','esatta','volgarita'), ('zoccola','parola','volgarita'),
  ('mignotta','parola','volgarita'), ('bagascia','parola','volgarita'), ('coglion','parola','volgarita'),
  ('figa','esatta','volgarita'), ('fica','esatta','volgarita'), ('pompino','parola','volgarita'), ('scopare','parola','volgarita'),
  ('scopata','parola','volgarita'), ('porno','parola','volgarita'), ('inculare','parola','volgarita'), ('culattone','parola','volgarita'),
  ('merda','parola','volgarita'), ('bastardo','parola','volgarita'), ('fottiti','parola','volgarita'), ('fottuto','parola','volgarita'),
  ('sborra','parola','volgarita'), ('segaiolo','parola','volgarita'), ('stupro','parola','violenza'), ('stuprare','parola','violenza'),
  ('ammazzati','parola','violenza'), ('suicidati','parola','violenza'),
  -- discriminazione
  ('negro','esatta','discriminazione'), ('negri','esatta','discriminazione'), ('negra','esatta','discriminazione'),
  ('negre','esatta','discriminazione'), ('frocio','parola','discriminazione'), ('froci','esatta','discriminazione'),
  ('ricchione','parola','discriminazione'), ('terrone','parola','discriminazione'),
  ('zingaro','parola','discriminazione'), ('mongoloide','parola','discriminazione'), ('ritardato','parola','discriminazione'),
  ('handicappato','parola','discriminazione'), ('nigger','parola','discriminazione'), ('faggot','parola','discriminazione'),
  ('fuck','parola','volgarita'), ('shit','esatta','volgarita'), ('bitch','parola','volgarita'), ('cunt','esatta','volgarita'),
  ('nazista','parola','discriminazione'), ('heil hitler','frase','discriminazione'), ('sieg heil','frase','discriminazione')
on conflict (word) do nothing;
