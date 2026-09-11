-- Run inside the transaction opened by test-local.sh, after schema.sql.
insert into dmpresearch_private.workspaces values
  ('11111111-1111-4111-8111-111111111111', 'Tenant A'),
  ('22222222-2222-4222-8222-222222222222', 'Tenant B');
insert into dmpresearch_private.memberships values
  ('11111111-1111-4111-8111-111111111111', 'user_a'),
  ('11111111-1111-4111-8111-111111111111', 'user_a_other'),
  ('22222222-2222-4222-8222-222222222222', 'user_b');
insert into public.dmpresearch_submissions (workspace_id,created_by,name,email,message)
values ('22222222-2222-4222-8222-222222222222','user_b','Bob','bob@example.test','Private B submission');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"user_a","role":"authenticated"}', true);
select set_config('request.headers', '{"x-tenant-id":"11111111-1111-4111-8111-111111111111"}', true);
insert into public.dmpresearch_submissions (workspace_id,name,email,message)
values ('11111111-1111-4111-8111-111111111111','Alice','alice@example.test','Appointment please');
do $$ begin
  if (select count(*) from public.dmpresearch_submissions) <> 1 then
    raise exception 'Own submission must be visible';
  end if;
  begin
    insert into public.dmpresearch_submissions (workspace_id,name,email,message)
    values ('22222222-2222-4222-8222-222222222222','Alice','alice@example.test','Wrong tenant');
    raise exception 'Cross-tenant insert unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.dmpresearch_submissions (workspace_id,name,email,message,created_by)
    values ('11111111-1111-4111-8111-111111111111','Alice','alice@example.test','Forged author','user_b');
    raise exception 'Author override unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
  begin
    insert into dmpresearch_private.memberships (workspace_id, subject)
    values ('22222222-2222-4222-8222-222222222222','user_a');
    raise exception 'Self-granted membership unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
  begin
    update public.dmpresearch_submissions set message = 'Tampered';
    raise exception 'Update unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.dmpresearch_submissions;
    raise exception 'Delete unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.dmpresearch_submissions (workspace_id,name,email,message)
    values ('11111111-1111-4111-8111-111111111111','Alice','alice@example.test',repeat('x',4001));
    raise exception 'Oversized message unexpectedly succeeded';
  exception when check_violation then null; end;
end $$;

-- Changing BOTH header and payload cannot manufacture tenant membership.
select set_config('request.headers', '{"x-tenant-id":"22222222-2222-4222-8222-222222222222"}', true);
do $$ begin
  if exists (select from public.dmpresearch_submissions) then
    raise exception 'Forged context exposed another tenant';
  end if;
  begin
    insert into public.dmpresearch_submissions (workspace_id,name,email,message)
    values ('22222222-2222-4222-8222-222222222222','Alice','alice@example.test','Forged context');
    raise exception 'Forged tenant membership unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.headers', '{}', true);
do $$ begin
  if exists (select from public.dmpresearch_submissions) then
    raise exception 'Missing tenant context exposed data';
  end if;
end $$;

-- A different member of the same tenant does not see another client's PII.
select set_config('request.headers', '{"x-tenant-id":"11111111-1111-4111-8111-111111111111"}', true);
select set_config('request.jwt.claims', '{"sub":"user_a_other","role":"authenticated"}', true);
do $$ begin
  if exists (select from public.dmpresearch_submissions) then
    raise exception 'Other member exposed submission';
  end if;
end $$;

-- Revocation takes effect without waiting for JWT expiry.
reset role;
delete from dmpresearch_private.memberships where subject = 'user_a';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"user_a","role":"authenticated","user_metadata":{"workspace_id":"11111111-1111-4111-8111-111111111111"}}', true);
do $$ begin
  if exists (select from public.dmpresearch_submissions) then
    raise exception 'Revoked member exposed submission';
  end if;
  begin
    insert into public.dmpresearch_submissions (workspace_id,name,email,message)
    values ('11111111-1111-4111-8111-111111111111','Alice','alice@example.test','Revoked');
    raise exception 'Revoked member or forged metadata authorized insert';
  exception when insufficient_privilege then null; end;
end $$;

set local role anon;
do $$ begin
  begin
    select count(*) from public.dmpresearch_submissions;
    raise exception 'Anon read unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.dmpresearch_submissions (workspace_id,name,email,message)
    values ('11111111-1111-4111-8111-111111111111','Visitor','visitor@example.test','Anonymous');
    raise exception 'Anon insert unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'PASS: membership, routing, author isolation, revocation, grants, validation' as result;
