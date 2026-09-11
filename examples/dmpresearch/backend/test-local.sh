#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Fixed local container only. Never accepts a remote connection string.
# All DDL/data are rolled back, including if psql exits on an assertion failure.
{
  printf 'begin;\n'
  cat schema.sql isolation.sql
  printf '\nrollback;\n'
} | docker exec -i supabase_db_flowstarter psql -X -U postgres -d postgres -v ON_ERROR_STOP=1
