import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Pool, PoolClient, types } from 'pg';
import { AppConfig } from './config';

// A business DATE is a calendar string, not a timestamp in the host's timezone.
types.setTypeParser(1082, (value) => value);

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly pool: Pool;

  constructor(@Inject(AppConfig) config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.poolMax,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 10_000,
    });
    this.pool.on('error', () => {
      console.error('PostgreSQL 空闲连接异常，连接池将重新建立连接');
    });
  }

  async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
