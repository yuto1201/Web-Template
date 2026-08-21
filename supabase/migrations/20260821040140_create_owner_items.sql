alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated;

alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

create table public.owner_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 120),
  created_at timestamptz not null default now()
);

comment on table public.owner_items is
  'Minimal owner-scoped example for template RLS and grant verification.';

alter table public.owner_items enable row level security;
alter table public.owner_items force row level security;

create index owner_items_owner_id_idx on public.owner_items (owner_id);

revoke all on table public.owner_items from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select, delete on table public.owner_items to authenticated;
grant insert (label) on table public.owner_items to authenticated;
grant update (label) on table public.owner_items to authenticated;

create policy "owner_items_select_own"
on public.owner_items
for select
to authenticated
using ((select auth.uid()) = owner_id);

create policy "owner_items_insert_own"
on public.owner_items
for insert
to authenticated
with check ((select auth.uid()) = owner_id);

create policy "owner_items_update_own"
on public.owner_items
for update
to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

create policy "owner_items_delete_own"
on public.owner_items
for delete
to authenticated
using ((select auth.uid()) = owner_id);
