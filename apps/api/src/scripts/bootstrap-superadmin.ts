import { z } from 'zod';
import { pool } from '../database/pool.js';
import { inTransaction } from '../database/transaction.js';
import { hashPassword } from '../security/password.js';

const input = z.object({
  BOOTSTRAP_SUPERADMIN_EMAIL: z.email().transform((value) => value.trim().toLowerCase()),
  BOOTSTRAP_SUPERADMIN_PASSWORD: z.string().min(16).max(128),
  BOOTSTRAP_SUPERADMIN_NAME: z.string().trim().min(2).max(160),
}).parse(process.env);

try {
  const passwordHash = await hashPassword(input.BOOTSTRAP_SUPERADMIN_PASSWORD);
  const result = await inTransaction(async (client) => {
    await client.query('LOCK TABLE app_user IN SHARE ROW EXCLUSIVE MODE');
    const existing = await client.query<{ id: string; email: string }>(
      `SELECT id, email FROM app_user WHERE is_superadmin AND deleted_at IS NULL LIMIT 1`,
    );
    if (existing.rows[0]) {
      return { created: false as const, email: existing.rows[0].email };
    }

    const emailOwner = await client.query<{ id: string }>(
      `SELECT id FROM app_user WHERE email = $1 AND deleted_at IS NULL`,
      [input.BOOTSTRAP_SUPERADMIN_EMAIL],
    );
    if (emailOwner.rows[0]) {
      throw new Error('El correo ya pertenece a un usuario y no se promoverá automáticamente.');
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO app_user(
         email, password_hash, display_name, status, is_superadmin, email_verified_at
       ) VALUES($1,$2,$3,'ACTIVE',true,now()) RETURNING id`,
      [input.BOOTSTRAP_SUPERADMIN_EMAIL, passwordHash, input.BOOTSTRAP_SUPERADMIN_NAME],
    );
    await client.query(
      `INSERT INTO audit_event(
         actor_user_id, action, entity_type, entity_id, superadmin_access, after_data
       ) VALUES($1,'SUPERADMIN_BOOTSTRAPPED','APP_USER',$1,true,$2)`,
      [inserted.rows[0]!.id, JSON.stringify({ email: input.BOOTSTRAP_SUPERADMIN_EMAIL })],
    );
    return { created: true as const, email: input.BOOTSTRAP_SUPERADMIN_EMAIL };
  });

  console.log(result.created
    ? `Superadministrador creado: ${result.email}. Elimina las variables BOOTSTRAP del servicio.`
    : `Ya existe un superadministrador: ${result.email}. No se realizaron cambios.`);
} finally {
  await pool.end();
}
