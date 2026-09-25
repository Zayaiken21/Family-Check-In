create extension if not exists pgcrypto;

create table if not exists public.cases (
  id uuid primary key default gen_random_uuid(),
  case_code text unique not null,
  label text not null,
  visit_minutes integer not null default 120 check (visit_minutes between 15 and 1440),
  checkin_interval_minutes integer not null default 45 check (checkin_interval_minutes between 5 and 720),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.participants (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  role text not null check (role in ('parent','caseworker')),
  display_name text not null,
  pin_hash text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique(case_id,role,display_name)
);

create table if not exists public.visit_sessions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  started_by uuid not null references public.participants(id),
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  status text not null default 'active' check (status in ('active','compliant','non_compliant')),
  review_ready boolean not null default false,
  second_checkin_at timestamptz,
  completed_at timestamptz,
  reviewed_by uuid references public.participants(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now()
);

create table if not exists public.visit_attendees (
  visit_id uuid not null references public.visit_sessions(id) on delete cascade,
  parent_id uuid not null references public.participants(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key(visit_id,parent_id)
);

create table if not exists public.checkins (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  visit_id uuid not null references public.visit_sessions(id) on delete cascade,
  parent_id uuid not null references public.participants(id) on delete cascade,
  checkin_number integer not null,
  method text not null check (method in ('location','virtual','video')),
  latitude double precision,
  longitude double precision,
  accuracy_m double precision,
  note text,
  created_at timestamptz not null default now(),
  unique(visit_id,parent_id,checkin_number)
);

create table if not exists public.report_deliveries (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  visit_id uuid not null references public.visit_sessions(id) on delete cascade,
  recipient text,
  status text not null,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists checkins_case_created_idx on public.checkins(case_id,created_at desc);
create index if not exists checkins_visit_idx on public.checkins(visit_id,created_at);
create index if not exists visits_case_started_idx on public.visit_sessions(case_id,started_at desc);

-- Browser clients do not query these tables directly. Render uses the service-role key.
alter table public.cases enable row level security;
alter table public.participants enable row level security;
alter table public.visit_sessions enable row level security;
alter table public.visit_attendees enable row level security;
alter table public.checkins enable row level security;
alter table public.report_deliveries enable row level security;

-- No public/anon policies are intentionally created.
-- Create participants securely by generating bcrypt hashes outside SQL.
-- Example helper with Node: await bcrypt.hash('123456', 12)
