-- Migration: Initialize OS-Practice-Web Community Exam Platform
-- Tables: public.profiles, public.published_tests, public.user_attempts

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text,
  email text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint username_length check (char_length(trim(username)) >= 2 and char_length(trim(username)) <= 40)
);

create index if not exists idx_profiles_username on public.profiles (lower(username));

alter table public.profiles enable row level security;

drop policy if exists "Profiles are viewable by everyone" on public.profiles;
create policy "Profiles are viewable by everyone"
  on public.profiles for select
  to anon, authenticated
  using (true);

drop policy if exists "Users can insert their own profile" on public.profiles;
create policy "Users can insert their own profile"
  on public.profiles for insert
  to authenticated
  with check ((select auth.uid()) = id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);


-- Published Tests table (automatically published when a user imports/creates a test)
create table if not exists public.published_tests (
  id uuid primary key default gen_random_uuid(),
  test_id text not null,
  version integer not null default 1,
  title text not null,
  course_name text,
  section_name text,
  duration_seconds integer not null,
  total_marks numeric not null,
  question_count integer not null,
  public_payload jsonb not null,
  memo_payload jsonb not null,
  publisher_id uuid references public.profiles(id) on delete set null,
  publisher_username text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (test_id, version)
);

create index if not exists idx_published_tests_publisher_id on public.published_tests (publisher_id);
create index if not exists idx_published_tests_publisher_username on public.published_tests (lower(publisher_username));
create index if not exists idx_published_tests_test_id on public.published_tests (test_id, version);

alter table public.published_tests enable row level security;

drop policy if exists "Published tests are viewable by everyone" on public.published_tests;
create policy "Published tests are viewable by everyone"
  on public.published_tests for select
  to anon, authenticated
  using (true);

drop policy if exists "Anyone can publish valid tests" on public.published_tests;
create policy "Anyone can publish valid tests"
  on public.published_tests for insert
  to anon, authenticated
  with check (publisher_id is null or (select auth.uid()) = publisher_id);

drop policy if exists "Publishers can update their own tests" on public.published_tests;
create policy "Publishers can update their own tests"
  on public.published_tests for update
  to anon, authenticated
  using (publisher_id is null or (select auth.uid()) = publisher_id)
  with check (publisher_id is null or (select auth.uid()) = publisher_id);

drop policy if exists "Publishers can delete their own tests" on public.published_tests;
create policy "Publishers can delete their own tests"
  on public.published_tests for delete
  to authenticated
  using ((select auth.uid()) = publisher_id);


-- User Attempts table (saves in-progress answers, flags, submitted grades, and review snapshots per user)
create table if not exists public.user_attempts (
  attempt_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  test_id text not null,
  test_version integer not null,
  started_at bigint not null,
  deadline_at bigint not null,
  submitted_at bigint,
  status text not null check (status in ('in_progress', 'submitted', 'timed_out')),
  marks_awarded numeric,
  total_marks numeric not null,
  responses_json jsonb not null default '{}'::jsonb,
  flags_json jsonb not null default '{}'::jsonb,
  review_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_attempts_user_id on public.user_attempts (user_id);
create index if not exists idx_user_attempts_test on public.user_attempts (user_id, test_id, test_version);

alter table public.user_attempts enable row level security;

drop policy if exists "Users can view their own attempts" on public.user_attempts;
create policy "Users can view their own attempts"
  on public.user_attempts for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own attempts" on public.user_attempts;
create policy "Users can insert their own attempts"
  on public.user_attempts for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own attempts" on public.user_attempts;
create policy "Users can update their own attempts"
  on public.user_attempts for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
