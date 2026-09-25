-- FAMILY CHECK-IN DATABASE
-- Run this once in Supabase > SQL Editor on a NEW project.
-- Uses Supabase Auth + PostgreSQL Row Level Security.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  email text,
  role text not null check (role in ('parent','caseworker')),
  created_at timestamptz not null default now()
);

create table if not exists public.relationships (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.profiles(id) on delete cascade,
  caseworker_id uuid not null references public.profiles(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique(parent_id, caseworker_id)
);

create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  caseworker_id uuid not null references public.profiles(id) on delete cascade,
  code text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.checkins (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.profiles(id) on delete cascade,
  mode text not null check (mode in ('location','virtual')),
  latitude double precision,
  longitude double precision,
  accuracy_m double precision,
  altitude_m double precision,
  speed_mps double precision,
  heading_deg double precision,
  note text check (char_length(note) <= 500),
  client_recorded_at timestamptz,
  captured_at timestamptz not null default now(),
  review_status text not null default 'submitted' check (review_status in ('submitted','pending','verified','rejected')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  on_time boolean
);

create index if not exists checkins_parent_time_idx on public.checkins(parent_id, captured_at desc);
create index if not exists relationships_caseworker_idx on public.relationships(caseworker_id, active);
create index if not exists relationships_parent_idx on public.relationships(parent_id, active);
create index if not exists invites_caseworker_idx on public.invites(caseworker_id, created_at desc);

-- Automatically create an application profile after Supabase Auth signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles(id, full_name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name',''),
    new.email,
    case when new.raw_user_meta_data->>'role' = 'caseworker' then 'caseworker' else 'parent' end
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

-- Calculate whether a location check-in was within the configured 45-minute cadence.
-- First check-in is considered on time. A 10-minute grace window is included.
create or replace function public.set_checkin_timing()
returns trigger
language plpgsql
as $$
declare prev_time timestamptz;
begin
  if new.mode = 'virtual' then
    new.on_time := null;
    return new;
  end if;
  select captured_at into prev_time from public.checkins
    where parent_id = new.parent_id
    order by captured_at desc limit 1;
  if prev_time is null then new.on_time := true;
  else new.on_time := (new.captured_at <= prev_time + interval '55 minutes');
  end if;
  return new;
end;
$$;

drop trigger if exists checkin_timing_before_insert on public.checkins;
create trigger checkin_timing_before_insert before insert on public.checkins for each row execute procedure public.set_checkin_timing();

-- Helper functions avoid recursive RLS checks.
create or replace function public.is_linked_caseworker(parent uuid, worker uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.relationships r where r.parent_id=parent and r.caseworker_id=worker and r.active=true)
$$;

create or replace function public.is_linked_parent(worker uuid, parent uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.relationships r where r.parent_id=parent and r.caseworker_id=worker and r.active=true)
$$;

-- Caseworker creates a short-lived code. SECURITY DEFINER keeps code generation server-side.
create or replace function public.create_parent_invite()
returns jsonb
language plpgsql
security definer set search_path=public
as $$
declare new_code text; expiry timestamptz; caller_role text;
begin
  select role into caller_role from public.profiles where id=auth.uid();
  if caller_role <> 'caseworker' then raise exception 'Only caseworker accounts can create invites'; end if;
  loop
    new_code := upper(substr(encode(gen_random_bytes(6),'hex'),1,6));
    exit when not exists(select 1 from public.invites where code=new_code);
  end loop;
  expiry := now() + interval '72 hours';
  insert into public.invites(caseworker_id,code,expires_at) values(auth.uid(),new_code,expiry);
  return jsonb_build_object('code',new_code,'expires_at',expiry);
end;
$$;

-- Parent redeems an exact invite code without being able to browse all invite codes.
create or replace function public.redeem_caseworker_invite(invite_code_input text)
returns jsonb
language plpgsql
security definer set search_path=public
as $$
declare inv public.invites%rowtype; caller_role text;
begin
  select role into caller_role from public.profiles where id=auth.uid();
  if caller_role <> 'parent' then return jsonb_build_object('ok',false,'message','Only parent accounts can redeem a parent invite.'); end if;
  select * into inv from public.invites where code=upper(trim(invite_code_input)) for update;
  if inv.id is null then return jsonb_build_object('ok',false,'message','Invite code not found.'); end if;
  if inv.used_at is not null then return jsonb_build_object('ok',false,'message','This invite has already been used.'); end if;
  if inv.expires_at < now() then return jsonb_build_object('ok',false,'message','This invite has expired.'); end if;
  insert into public.relationships(parent_id,caseworker_id,active,revoked_at)
  values(auth.uid(),inv.caseworker_id,true,null)
  on conflict(parent_id,caseworker_id) do update set active=true, revoked_at=null;
  update public.invites set used_at=now(), used_by=auth.uid() where id=inv.id;
  return jsonb_build_object('ok',true,'message','Caseworker linked.');
end;
$$;

grant execute on function public.create_parent_invite() to authenticated;
grant execute on function public.redeem_caseworker_invite(text) to authenticated;

alter table public.profiles enable row level security;
alter table public.relationships enable row level security;
alter table public.invites enable row level security;
alter table public.checkins enable row level security;

-- Profiles: self + actively linked counterpart.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (
  id=auth.uid()
  or public.is_linked_caseworker(id,auth.uid())
  or public.is_linked_parent(id,auth.uid())
);

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated using (id=auth.uid()) with check (id=auth.uid());

-- Relationships: either participant can read. Parent can revoke its own link.
drop policy if exists relationships_select on public.relationships;
create policy relationships_select on public.relationships for select to authenticated using (parent_id=auth.uid() or caseworker_id=auth.uid());

drop policy if exists relationships_parent_update on public.relationships;
create policy relationships_parent_update on public.relationships for update to authenticated using (parent_id=auth.uid()) with check (parent_id=auth.uid());

-- Invites: caseworker sees only own codes. Writes are via RPC.
drop policy if exists invites_select_own on public.invites;
create policy invites_select_own on public.invites for select to authenticated using (caseworker_id=auth.uid());

-- Check-ins: parent inserts/reads own; linked caseworkers read.
drop policy if exists checkins_select on public.checkins;
create policy checkins_select on public.checkins for select to authenticated using (
  parent_id=auth.uid() or public.is_linked_caseworker(parent_id,auth.uid())
);

drop policy if exists checkins_insert_parent on public.checkins;
create policy checkins_insert_parent on public.checkins for insert to authenticated with check (
  parent_id=auth.uid()
  and exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='parent')
);

-- Only linked caseworkers may update review fields. PostgreSQL RLS is row-level;
-- the app UI only exposes virtual-review actions. For production, add a restricted RPC
-- if you need column-level guarantees beyond this row-level rule.
drop policy if exists checkins_caseworker_update on public.checkins;
create policy checkins_caseworker_update on public.checkins for update to authenticated using (
  public.is_linked_caseworker(parent_id,auth.uid())
) with check (
  public.is_linked_caseworker(parent_id,auth.uid())
);

-- Do not grant DELETE policies: records are intentionally non-deletable from the client UI.
