import bcrypt from 'bcryptjs';
import { migrate, pool } from '../db/pool';
import { createStaff } from '../db/repo';

/** Usage: pnpm create-staff <email> <password> [name] */
async function main(): Promise<void> {
  const [email, password, ...rest] = process.argv.slice(2);
  const name = rest.join(' ') || null;
  if (!email || !password) {
    console.error('Uso: pnpm create-staff <email> <password> [nombre]');
    process.exit(1);
  }
  await migrate();
  const hash = await bcrypt.hash(password, 10);
  const staff = await createStaff(email, hash, name);
  console.log(`✓ Staff creado/actualizado: ${staff.email} (${staff.id})`);
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
