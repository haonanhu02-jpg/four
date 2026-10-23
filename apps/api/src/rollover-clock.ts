import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
@Injectable()
export class RolloverClock {
  now(): Date {
    return new Date();
  }
  async today(client: PoolClient, userId: string): Promise<string> {
    const result = await client.query(
      'SELECT ($2::timestamptz AT TIME ZONE timezone)::date AS today FROM users WHERE id=$1',
      [userId, this.now().toISOString()],
    );
    return result.rows[0].today as string;
  }
}
