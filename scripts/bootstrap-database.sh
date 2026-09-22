#!/usr/bin/env bash
set -euo pipefail

# Migration history in this repository starts after the original production baseline. For a brand
# new database, materialize the current Prisma schema, then record every bundled incremental
# migration as already represented by that schema. Future `prisma migrate deploy` runs normally.
npx prisma db push --skip-generate

for migration_path in prisma/migrations/*; do
  if [[ -d "$migration_path" ]]; then
    npx prisma migrate resolve --applied "$(basename "$migration_path")"
  fi
done

npx prisma generate
