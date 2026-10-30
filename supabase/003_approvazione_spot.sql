-- =====================================================================
-- StayChill - APPROVAZIONE DEGLI SPOT (da eseguire DOPO 002_moderazione.sql)
-- Supabase > SQL Editor > New query > incolla tutto > Run.
-- Si può rieseguire senza danni.
--
-- Da ora ogni nuovo spot resta invisibile agli altri finché un
-- amministratore non lo approva. Gli spot già pubblicati restano visibili.
-- =====================================================================

alter table public.spots add column if not exists approved boolean not null default false;

-- Gli spot esistenti prima di questo script restano visibili (eseguito una sola volta)
create table if not exists public.app_migrations (name text primary key, done_at timestamptz default now());
alter table public.app_migrations enable row level security;
do $$
begin
  if not exists (select 1 from public.app_migrations where name = '003_approvazione_spot') then
    update public.spots set approved = true;
    insert into public.app_migrations (name) values ('003_approvazione_spot');
  end if;
end $$;

-- Gli spot pubblicati da un amministratore sono approvati in automatico;
-- quelli degli altri partono sempre "in attesa", qualunque cosa mandi l'app.
create or replace function public.set_spot_approval() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.approved := public.is_admin();
  return new;
end $$;
drop trigger if exists spot_approval on public.spots;
create trigger spot_approval before insert on public.spots
  for each row execute function public.set_spot_approval();

-- Visibilità: tutti vedono solo spot approvati e non nascosti;
-- l'autore vede sempre i propri; l'amministratore vede tutto.
drop policy if exists "spots read" on public.spots;
create policy "spots read" on public.spots for select to authenticated
  using ((approved and not hidden) or user_id = auth.uid() or public.is_admin());

-- La vista va ricreata per includere la nuova colonna
drop view if exists public.spot_feed;
create view public.spot_feed with (security_invoker = true) as
select s.*, pr.username,
  (select count(*) from public.reports r where r.spot_id = s.id)::int as reports
from public.spots s
left join public.profiles pr on pr.id = s.user_id;
