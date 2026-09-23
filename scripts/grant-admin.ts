/**
 * Give a user access to the admin board (/admin/v1), or take it away.
 *   bun run admin:grant you@example.com
 *   bun run admin:grant you@example.com --revoke
 * Uses DATABASE_URL, so it acts on whichever database .env points at.
 */
import { databaseEnvSchema, loadEnv } from '@overhead/core';
import { createSql } from '@overhead/database';

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith('--'));
const revoke = args.includes('--revoke');
if (!email) {
  console.error('usage: bun run admin:grant <email> [--revoke]');
  process.exit(1);
}

const env = loadEnv(databaseEnvSchema);
const sql = createSql(env.DATABASE_URL, { max: 1 });
try {
  const users =
    (await sql`select id from auth.users where lower(email) = lower(${email})`) as Array<{
      id: string;
    }>;
  const user = users[0];
  if (!user) {
    console.error(`no user with email ${email}`);
    process.exitCode = 1;
  } else if (revoke) {
    await sql`delete from private.admins where user_id = ${user.id}`;
    console.log(`${email} is no longer an admin`);
  } else {
    await sql`insert into private.admins (user_id) values (${user.id}) on conflict do nothing`;
    console.log(`${email} is now an admin`);
  }
} finally {
  await sql.close();
}
