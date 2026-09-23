import { ApiError, conflict, forbidden } from '../../core/errors.js';
import { inTransaction } from '../../database/transaction.js';
import type { AuthState, PropertyContext, RequestMetadata } from '../auth/auth.types.js';
import { readAnimal } from './animals.service.js';

export async function updateAnimalDescription(auth: AuthState, context: PropertyContext, id: string,
  input: { description: string | null; expectedVersion: number }, metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    const grant = await client.query(
      `SELECT 1 FROM property p
       JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
       JOIN property_membership pm ON pm.property_id = p.id AND pm.user_id = $2 AND pm.status = 'ACTIVE'
       JOIN membership_role mr ON mr.membership_id = pm.id AND mr.property_id = p.id
       JOIN property_role pr ON pr.id = mr.role_id AND pr.property_id = p.id AND pr.active
       JOIN role_permission rp ON rp.role_id = pr.id AND rp.permission_code = 'ANIMAL_UPDATE'
       WHERE p.id = $1 AND pr.id = $3 AND p.deleted_at IS NULL AND p.status = 'ACTIVE'
       FOR SHARE OF p, pm, pr`,
      [context.propertyId, auth.userId, context.roleId],
    );
    if (!grant.rowCount) throw forbidden('ANIMAL_UPDATE_DENIED', 'El rol activo no permite modificar este animal.');
    const locked = await client.query<{ version: string }>(
      `SELECT version::text AS version FROM animal WHERE property_id = $1 AND id = $2
       AND record_status = 'CURRENT' FOR UPDATE`, [context.propertyId, id],
    );
    if (!locked.rows[0]) throw new ApiError(404, 'ANIMAL_NOT_FOUND', 'El animal no está disponible en esta propiedad.');
    if (Number(locked.rows[0].version) !== input.expectedVersion) {
      throw conflict('ANIMAL_VERSION_CONFLICT', 'El animal cambió. Actualiza su ficha antes de guardar.');
    }
    const before = await readAnimal(client, context, id);
    const description = input.description || null;
    if (before.description === description) return before;
    await client.query(`UPDATE animal SET description = $2, updated_by = $3 WHERE id = $1`,
      [id, description, auth.userId]);
    const after = await readAnimal(client, context, id);
    await client.query(
      `INSERT INTO audit_event(actor_user_id, property_id, active_role_id, action, entity_type,
         entity_id, before_data, after_data, ip_address, user_agent)
       VALUES($1,$2,$3,'ANIMAL_DESCRIPTION_UPDATED','ANIMAL',$4,$5::jsonb,$6::jsonb,$7,$8)`,
      [auth.userId, context.propertyId, context.roleId, id, JSON.stringify(before),
        JSON.stringify(after), metadata.ipAddress, metadata.userAgent],
    );
    return after;
  });
}
