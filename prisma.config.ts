import { defineConfig } from 'prisma/config';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

// Explicit environment variables (CI, staging, one-off test databases) must win over
// the developer's local .env file. Node's loadEnvFile overwrites existing values, so
// restore the process environment afterwards and never mix a supplied DATABASE_URL
// with a DIRECT_URL from another environment.
const suppliedEnvironment = { ...process.env };
if (existsSync('.env')) loadEnvFile('.env');
Object.assign(process.env, suppliedEnvironment);
if (suppliedEnvironment.DATABASE_URL && !suppliedEnvironment.DIRECT_URL) {
  process.env.DIRECT_URL = suppliedEnvironment.DATABASE_URL;
} else if (!process.env.DIRECT_URL && process.env.DATABASE_URL) {
  process.env.DIRECT_URL = process.env.DATABASE_URL;
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node --compiler-options {"module":"CommonJS"} prisma/seed.ts',
  },
});
