-- Run this once in Supabase: SQL Editor -> New query -> Run

create table if not exists public.devices (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name              text not null check (char_length(name) between 1 and 60),
  lat               double precision,
  lng               double precision,
  accuracy          real,
  battery           real,
  last_seen         timestamptz,
  ring_requested_at timestamptz,
  lost_mode         boolean not null default false,
  lost_message      text check (char_length(lost_message) <= 200),
  created_at        timestamptz not null default now()
);

create table if not exists public.device_locations (
  id         bigint generated always as identity primary key,
  device_id  uuid not null references public.devices(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lat        double precision not null,
  lng        double precision not null,
  accuracy   real,
  created_at timestamptz not null default now()
);
create index if not exists device_locations_device_time
  on public.device_locations (device_id, created_at desc);

-- Row Level Security: every user can only see / change their own rows.
alter table public.devices          enable row level security;
alter table public.device_locations enable row level security;

drop policy if exists "own devices" on public.devices;
create policy "own devices" on public.devices
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "own locations" on public.device_locations;
create policy "own locations" on public.device_locations
  for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.devices d where d.id = device_id and d.user_id = auth.uid())
  );

-- Realtime so the map / "play sound" commands update instantly.
do $$ begin
  alter publication supabase_realtime add table public.devices;
exception when duplicate_object then null; end $$;

-- Optional: keep only 30 days of history (run on a schedule with pg_cron if you want).
-- delete from public.device_locations where created_at < now() - interval '30 days';
