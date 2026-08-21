begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions;

select plan(23);

select has_table('public', 'owner_items', 'owner_items exists');

select results_eq(
  $$ select relrowsecurity, relforcerowsecurity
     from pg_class where oid = 'public.owner_items'::regclass $$,
  $$ values (true, true) $$,
  'owner_items has RLS enabled and forced'
);

select has_index(
  'public',
  'owner_items',
  'owner_items_owner_id_idx',
  'owner_id is indexed for RLS and cascade operations'::text
);

select ok(
  not has_table_privilege(
    'anon',
    'public.owner_items',
    'select,insert,update,delete,truncate,references,trigger'
  ),
  'anon has no table grant'
);

select results_eq(
  $$ select privilege_type::text collate "C"
     from information_schema.role_table_grants
     where grantee in ('authenticated', 'PUBLIC')
       and table_schema = 'public'
       and table_name = 'owner_items'
     order by privilege_type::text collate "C" $$,
  $$ values ('DELETE'::text collate "C"), ('SELECT'::text collate "C") $$,
  'authenticated has only table-level select and delete grants'
);

select results_eq(
  $$ select column_name::text collate "C", privilege_type::text collate "C"
     from information_schema.column_privileges
     where grantee in ('authenticated', 'PUBLIC')
       and table_schema = 'public'
       and table_name = 'owner_items'
       and privilege_type in ('INSERT', 'UPDATE')
     order by column_name::text collate "C", privilege_type::text collate "C" $$,
  $$ values ('label'::text collate "C", 'INSERT'::text collate "C"),
            ('label'::text collate "C", 'UPDATE'::text collate "C") $$,
  'authenticated can only insert and update label'
);

select is(
  (
    select count(*)
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and (not relation.relrowsecurity or not relation.relforcerowsecurity)
  ),
  0::bigint,
  'every public table has RLS enabled and forced'
);

select is(
  (
    select count(*)
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and not exists (
        select 1 from pg_policy as policy where policy.polrelid = relation.oid
      )
  ),
  0::bigint,
  'every public table has at least one RLS policy'
);

select is(
  (
    select count(*)
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p', 'v', 'm', 'f')
      and (
        has_table_privilege(
          'anon',
          relation.oid,
          'select,insert,update,delete,truncate,references,trigger'
        )
        or has_any_column_privilege(
          'anon',
          relation.oid,
          'select,insert,update,references'
        )
      )
  ),
  0::bigint,
  'anon has no table or column privilege on any public relation'
);

select is(
  (
    select count(*)
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind in ('m', 'f')
  ),
  0::bigint,
  'public contains no materialized views or foreign tables'
);

select is(
  (
    select count(*)
    from pg_proc as function
    join pg_namespace as namespace on namespace.oid = function.pronamespace
    where namespace.nspname = 'public'
      and function.prosecdef
      and (
        has_function_privilege('anon', function.oid, 'execute')
        or has_function_privilege('authenticated', function.oid, 'execute')
      )
  ),
  0::bigint,
  'no public security-definer function is executable by API roles'
);

select is(
  (
    select count(*)
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind = 'v'
      and not coalesce(relation.reloptions, '{}'::text[]) @> array['security_invoker=true']
  ),
  0::bigint,
  'every public view uses security_invoker'
);

create table public.default_privilege_probe (id bigint primary key);

select ok(
  not has_table_privilege(
    'anon',
    'public.default_privilege_probe',
    'select,insert,update,delete,truncate,references,trigger'
  )
  and not has_table_privilege(
    'authenticated',
    'public.default_privilege_probe',
    'select,insert,update,delete,truncate,references,trigger'
  )
  and not has_any_column_privilege(
    'anon',
    'public.default_privilege_probe',
    'select,insert,update,references'
  )
  and not has_any_column_privilege(
    'authenticated',
    'public.default_privilege_probe',
    'select,insert,update,references'
  ),
  'new public tables start with no API-role privileges'
);

drop table public.default_privilege_probe;

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  email_change,
  email_change_token_new,
  recovery_token
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'owner-one@example.invalid',
    crypt('synthetic-password-one', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '22222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'owner-two@example.invalid',
    crypt('synthetic-password-two', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now(),
    '',
    '',
    '',
    ''
  );

set local role anon;
select throws_ok(
  $$ select id from public.owner_items $$,
  '42501',
  'permission denied for table owner_items',
  'anon cannot select the protected table'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select lives_ok(
  $$ insert into public.owner_items (label) values ('Owner one item') $$,
  'owner can insert an owned row'
);

set local role postgres;
grant insert (owner_id) on table public.owner_items to authenticated;
set local role authenticated;

select throws_ok(
  $$ insert into public.owner_items (owner_id, label)
     values ('22222222-2222-4222-8222-222222222222', 'Forbidden item') $$,
  '42501',
  'new row violates row-level security policy for table "owner_items"',
  'RLS with-check rejects an insert for another user'
);

set local role postgres;
revoke insert (owner_id) on table public.owner_items from authenticated;
set local role authenticated;

select results_eq(
  $$ select label from public.owner_items order by label $$,
  array['Owner one item'::text],
  'owner sees only the owned row'
);

select lives_ok(
  $$ update public.owner_items set label = 'Owner one updated' $$,
  'owner can update owned row content'
);

set local role postgres;
grant update (owner_id) on table public.owner_items to authenticated;
set local role authenticated;

select throws_ok(
  $$ update public.owner_items
     set owner_id = '22222222-2222-4222-8222-222222222222' $$,
  '42501',
  'new row violates row-level security policy for table "owner_items"',
  'RLS with-check rejects ownership reassignment'
);

set local role postgres;
revoke update (owner_id) on table public.owner_items from authenticated;
set local role authenticated;

select set_config(
  'request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}',
  true
);

select is(
  (select count(*) from public.owner_items),
  0::bigint,
  'another authenticated user cannot see the owner row'
);

select results_eq(
  $$ with updated as (
       update public.owner_items set label = 'Forbidden update' returning id
     ) select count(*) from updated $$,
  array[0::bigint],
  'another authenticated user cannot update the owner row'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',
  true
);

select lives_ok(
  $$ delete from public.owner_items $$,
  'owner can delete the owned row'
);

select is(
  (select count(*) from public.owner_items),
  0::bigint,
  'owner row is deleted'
);

select * from finish();
rollback;
