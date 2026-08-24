/** Postgres connection pool. Construction only, no queries. */
import pg from 'pg';

export const createPool = (databaseUrl: string): pg.Pool =>
  new pg.Pool({ connectionString: databaseUrl, max: 10 });
