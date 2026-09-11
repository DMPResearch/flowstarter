import assert from 'node:assert/strict';
import test from 'node:test';
import { businessSchema } from '../src/lib/business-schema.mjs';
import { readPublicConfig } from '../src/lib/public-config.mjs';

const business = {
  name: 'A local business',
  description: 'Repairs',
  city: 'Bucharest',
  email: 'hello@example.test',
  design: { palette: 'sand', density: 'compact' },
};
const config = {
  PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_local_test',
  PUBLIC_TENANT_ID: '11111111-1111-4111-8111-111111111111',
};
test('business schema rejects unknown metadata, unsafe text and arbitrary CSS', () => {
  assert.equal(businessSchema.safeParse(business).success, true);
  for (const candidate of [
    { ...business, script: 'alert(1)' },
    { ...business, name: '<script>alert(1)</script>' },
    { ...business, description: 'x'.repeat(301) },
    { ...business, email: 'javascript:alert(1)' },
    { ...business, design: { ...business.design, css: 'url(evil)' } },
    {
      ...business,
      design: { ...business.design, palette: 'red; background:url(evil)' },
    },
  ])
    assert.equal(businessSchema.safeParse(candidate).success, false);
});
test('public configuration fails closed without disclosing credentials', () => {
  assert.deepEqual(readPublicConfig(config), config);
  for (const candidate of [
    { ...config, PUBLIC_TENANT_ID: 'another-tenant' },
    { ...config, PUBLIC_SUPABASE_URL: 'http://insecure.example.test' },
    { ...config, PUBLIC_SUPABASE_URL: 'https://user:password@example.test' },
    {
      ...config,
      PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_do_not_print_this',
    },
    { ...config, PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'eyJservice-role-token' },
  ]) {
    assert.throws(
      () => readPublicConfig(candidate),
      (error) =>
        error.message.startsWith('Invalid public build configuration:') &&
        !error.message.includes('do_not_print_this') &&
        !error.message.includes('password'),
    );
  }
});

test('legacy local anon keys accepted, service-role keys rejected', () => {
  const jwt = (role) =>
    [
      'e30',
      Buffer.from(JSON.stringify({ role })).toString('base64url'),
      'test',
    ].join('.');
  assert.equal(
    readPublicConfig({
      ...config,
      PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt('anon'),
    }).PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    jwt('anon'),
  );
  assert.throws(() =>
    readPublicConfig({
      ...config,
      PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt('service_role'),
    }),
  );
});

test('tenant UUIDs are canonicalized for PostgreSQL header comparison', () => {
  const tenant = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
  assert.equal(
    readPublicConfig({ ...config, PUBLIC_TENANT_ID: tenant }).PUBLIC_TENANT_ID,
    tenant.toLowerCase(),
  );
});

test('business schema requires every field and accepts values exactly at the length boundary', () => {
  assert.equal(
    businessSchema.safeParse({ ...business, name: 'a'.repeat(100) }).success,
    true,
  );
  assert.equal(
    businessSchema.safeParse({ ...business, description: 'a'.repeat(300) })
      .success,
    true,
  );
  assert.equal(
    businessSchema.safeParse({
      ...business,
      email: 'a'.repeat(249) + '@x.tt',
    }).success,
    true,
  );
  for (const field of ['name', 'description', 'city', 'email', 'design']) {
    const { [field]: _drop, ...rest } = business;
    assert.equal(businessSchema.safeParse(rest).success, false, field);
  }
  for (const candidate of [
    { ...business, name: '   ' },
    { ...business, name: 'a'.repeat(101) },
    { ...business, description: 'a'.repeat(301) },
    { ...business, name: 'line one\nline two' },
    { ...business, city: 'a tab\tin the middle' },
    { ...business, name: 42 },
    { ...business, email: 'a'.repeat(250) + '@x.tt' },
    { ...business, design: { palette: 'sand' } },
    { ...business, design: { density: 'compact' } },
    { ...business, design: { palette: 'blue', density: 'compact' } },
    { ...business, design: { palette: 'sand', density: 'cozy' } },
  ])
    assert.equal(businessSchema.safeParse(candidate).success, false);
});

test('public configuration rejects a missing or empty environment', () => {
  for (const candidate of [{}, undefined, null]) {
    assert.throws(
      () => readPublicConfig(candidate),
      (error) =>
        error.message.startsWith('Invalid public build configuration:'),
    );
  }
  for (const key of Object.keys(config)) {
    const { [key]: _drop, ...rest } = config;
    assert.throws(
      () => readPublicConfig(rest),
      (error) => error.message.includes(key),
    );
  }
});

test('public configuration rejects disallowed URL schemes, queries and fragments', () => {
  for (const url of [
    'ftp://example.test',
    'javascript:alert(1)',
    'not-a-url',
    'https://example.test/?tenant=1',
    'https://example.test/#fragment',
  ])
    assert.throws(() =>
      readPublicConfig({ ...config, PUBLIC_SUPABASE_URL: url }),
    );
});

test('public configuration rejects malformed publishable keys', () => {
  for (const key of [
    '',
    'sb_publishable_',
    'e30.e30',
    'e30.bm90anNvbg.test',
    ['e30', Buffer.from(JSON.stringify({})).toString('base64url'), 'test'].join(
      '.',
    ),
  ])
    assert.throws(() =>
      readPublicConfig({ ...config, PUBLIC_SUPABASE_PUBLISHABLE_KEY: key }),
    );
});

test('public configuration rejects malformed tenant identifiers', () => {
  for (const tenant of [
    '',
    'not-a-uuid',
    '11111111-1111-1111-1111-111111111111',
  ])
    assert.throws(() =>
      readPublicConfig({ ...config, PUBLIC_TENANT_ID: tenant }),
    );
});
