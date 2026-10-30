-- =====================================================================
-- StayChill - schema del database Supabase
-- Da incollare UNA VOLTA in Supabase > SQL Editor > New query > Run.
-- Si può rieseguire senza danni (usa "if not exists" / "or replace").
-- =====================================================================

-- ---------- Profili (nome utente visibile agli altri) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null check (char_length(username) between 3 and 24),
  created_at timestamptz not null default now()
);

-- Crea il profilo in automatico quando qualcuno si registra
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  base text := coalesce(nullif(trim(new.raw_user_meta_data->>'username'), ''), split_part(new.email, '@', 1));
  candidate text := left(base, 20);
  n int := 0;
begin
  if char_length(candidate) < 3 then candidate := candidate || 'user'; end if;
  while exists (select 1 from public.profiles where username = candidate) loop
    n := n + 1;
    candidate := left(base, 20) || n::text;
  end loop;
  insert into public.profiles (id, username) values (new.id, candidate);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 1. GENERAL MAP: luoghi condivisi + voti ----------
create table if not exists public.places (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 60),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- emoji: 1 = teschio (Assolutamente no), 2 = pericolo (Meglio di no),
--        3 = occhi (Sì, ma attenzione), 4 = bandiera verde (Vai chill)
create table if not exists public.votes (
  place_id bigint not null references public.places(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  emoji smallint not null check (emoji between 1 and 4),
  updated_at timestamptz not null default now(),
  primary key (place_id, user_id)          -- un solo voto per persona per luogo
);

-- Riepilogo per luogo: conteggi + emoji vincente.
-- In caso di pareggio vince la più prudente (numero più basso).
create or replace view public.place_summary with (security_invoker = true) as
select
  p.id, p.name, p.lat, p.lng, p.created_by, p.created_at,
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
  ) as winner
from public.places p
left join public.votes v on v.place_id = p.id
group by p.id;

-- ---------- 2. MY MAP: segni privati ----------
create table if not exists public.my_marks (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  emoji smallint not null check (emoji between 1 and 4),
  note text check (char_length(note) <= 200),
  created_at timestamptz not null default now()
);

-- ---------- 3. SPOT: foto condivise ----------
create table if not exists public.spots (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  title text not null check (char_length(title) between 1 and 60),
  description text check (char_length(description) <= 300),
  photo_path text not null,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.reports (
  id bigint generated always as identity primary key,
  spot_id bigint not null references public.spots(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (spot_id, user_id)
);

-- Con 3 segnalazioni da persone diverse la foto viene nascosta in automatico
create or replace function public.hide_reported_spot()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.reports where spot_id = new.spot_id) >= 3 then
    update public.spots set hidden = true where id = new.spot_id;
  end if;
  return new;
end $$;

drop trigger if exists on_report_created on public.reports;
create trigger on_report_created
  after insert on public.reports
  for each row execute function public.hide_reported_spot();

-- Vista con il nome dell'autore
create or replace view public.spot_feed with (security_invoker = true) as
select s.*, pr.username
from public.spots s
left join public.profiles pr on pr.id = s.user_id;

-- ---------- Regole di sicurezza (Row Level Security) ----------
alter table public.profiles enable row level security;
alter table public.places   enable row level security;
alter table public.votes    enable row level security;
alter table public.my_marks enable row level security;
alter table public.spots    enable row level security;
alter table public.reports  enable row level security;

drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles for select to authenticated using (true);
drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles for update to authenticated using (id = auth.uid());

drop policy if exists "places read" on public.places;
create policy "places read" on public.places for select to authenticated using (true);
drop policy if exists "places insert" on public.places;
create policy "places insert" on public.places for insert to authenticated with check (created_by = auth.uid());
drop policy if exists "places delete own" on public.places;
create policy "places delete own" on public.places for delete to authenticated using (created_by = auth.uid());

drop policy if exists "votes read" on public.votes;
create policy "votes read" on public.votes for select to authenticated using (true);
drop policy if exists "votes insert own" on public.votes;
create policy "votes insert own" on public.votes for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "votes update own" on public.votes;
create policy "votes update own" on public.votes for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "votes delete own" on public.votes;
create policy "votes delete own" on public.votes for delete to authenticated using (user_id = auth.uid());

-- My map: ognuno vede e modifica SOLO i propri segni
drop policy if exists "my_marks own" on public.my_marks;
create policy "my_marks own" on public.my_marks for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "spots read" on public.spots;
create policy "spots read" on public.spots for select to authenticated using (hidden = false or user_id = auth.uid());
drop policy if exists "spots insert own" on public.spots;
create policy "spots insert own" on public.spots for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "spots delete own" on public.spots;
create policy "spots delete own" on public.spots for delete to authenticated using (user_id = auth.uid());

drop policy if exists "reports insert own" on public.reports;
create policy "reports insert own" on public.reports for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "reports read own" on public.reports;
create policy "reports read own" on public.reports for select to authenticated using (user_id = auth.uid());

-- ---------- Archivio foto ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('spots', 'spots', true, 3145728, array['image/jpeg'])
on conflict (id) do nothing;

-- Ognuno carica solo nella propria cartella (nome cartella = id utente)
drop policy if exists "spot photos upload" on storage.objects;
create policy "spot photos upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'spots' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "spot photos delete own" on storage.objects;
create policy "spot photos delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'spots' and (storage.foldername(name))[1] = auth.uid()::text);
