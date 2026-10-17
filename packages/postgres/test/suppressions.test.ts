import { describe, expect, it } from 'vitest';
import { suppressionHash } from '@openbooking-sh/notifications';
import { describeSuppressionList } from '../../notifications/test/suppression-contract';
import { PostgresSuppressionList } from '../src';
import { freshDb, target } from './helpers';

describeSuppressionList(
  `postgres (${target})`,
  async () => new PostgresSuppressionList(await freshDb()),
);

describe(`PostgresSuppressionList (${target})`, () => {
  it('is shared by every instance and stores only the hash', async () => {
    const db = await freshDb();
    const hash = suppressionHash('salon', 'ada@example.com');
    await new PostgresSuppressionList(db).add('salon', hash);
    // Another server instance (a fresh object on the same database) sees it at once.
    expect(await new PostgresSuppressionList(db).has('salon', hash)).toBe(true);
    const { rows } = await db.query('select * from ob_email_suppressions');
    expect(JSON.stringify(rows)).not.toContain('ada');
    expect(rows).toHaveLength(1);
  });
});
