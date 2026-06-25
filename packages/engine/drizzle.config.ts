import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema/*.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://munin:munin@localhost:5432/munin',
  },
  strict: true,
  verbose: true,
} satisfies Config;
