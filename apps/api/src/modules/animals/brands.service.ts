import type { PoolClient } from 'pg';
import { ApiError, conflict, forbidden } from '../../core/errors.js';
import { pool } from '../../database/pool.js';
import { inTransaction } from '../../database/transaction.js';
import type { AuthState, PropertyContext, RequestMetadata } from '../auth/auth.types.js';

interface BrandRow { id: string; name: string; active: boolean; owner_ids?: string[] }

export async function listBrands(context: PropertyContext) {
  const result = await pool.query<BrandRow>(
    `SELECT id, name, active, ARRAY(SELECT party_id FROM livestock_brand_owner
       WHERE brand_id = livestock_brand.id ORDER BY party_id) AS owner_ids
     FROM livestock_brand WHERE account_id = (SELECT account_id FROM property WHERE id = $1)
     ORDER BY lower(name), id`, [context.propertyId],
  );
  return result.rows;
}

async function access(client: PoolClient, auth: AuthState, context: PropertyContext) {
  const result = await client.query<{ account_id: string }>(
    `SELECT p.account_id FROM property p
     JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
     JOIN property_membership pm ON pm.property_id = p.id AND pm.user_id = $2 AND pm.status = 'ACTIVE'
     JOIN membership_role mr ON mr.membership_id = pm.id AND mr.property_id = p.id
     JOIN property_role pr ON pr.id = mr.role_id AND pr.property_id = p.id AND pr.active
     JOIN role_permission rp ON rp.role_id = pr.id AND rp.permission_code = 'CATALOG_MANAGE'
     WHERE p.id = $1 AND pr.id = $3 AND p.deleted_at IS NULL AND p.status = 'ACTIVE'
     FOR SHARE OF p, pm, pr`,
    [context.propertyId, auth.userId, context.roleId],
  );
  if (!result.rows[0]) throw forbidden('BRAND_MANAGE_DENIED', 'El rol activo no permite administrar marquillas.');
  return result.rows[0].account_id;
}

async function audit(client: PoolClient, auth: AuthState, context: PropertyContext,
  metadata: RequestMetadata, id: string, action: string, before: BrandRow | null, after: BrandRow) {
  await client.query(
    `INSERT INTO audit_event(actor_user_id, property_id, active_role_id, action,
       entity_type, entity_id, before_data, after_data, ip_address, user_agent)
     VALUES($1,$2,$3,$4,'LIVESTOCK_BRAND',$5,$6::jsonb,$7::jsonb,$8,$9)`,
    [auth.userId, context.propertyId, context.roleId, action, id,
      before && JSON.stringify(before), JSON.stringify(after), metadata.ipAddress, metadata.userAgent],
  );
}

export async function createBrand(auth: AuthState, context: PropertyContext,
  name: string, metadata: RequestMetadata, ownerIds: string[] = []) {
  try {
    return await inTransaction(async (client) => {
      const accountId = await access(client, auth, context);
      await client.query('SELECT id FROM administrative_account WHERE id = $1 FOR UPDATE', [accountId]);
      const duplicate = await client.query(`SELECT 1 FROM livestock_brand
        WHERE account_id = $1 AND lower(name) = lower($2) LIMIT 1`, [accountId, name]);
      if (duplicate.rowCount) throw conflict('BRAND_NAME_TAKEN', 'Ya existe una marquilla con ese nombre en la cuenta.');
      const created = await client.query<BrandRow>(
        `INSERT INTO livestock_brand(account_id, property_id, name, created_by)
         VALUES($1,$2,$3,$4) RETURNING id, name, active`,
        [accountId, context.propertyId, name, auth.userId],
      );
      if (ownerIds.length) {
        const parties = await client.query<{ id: string }>(
          `SELECT id FROM property_party WHERE id = ANY($1::uuid[]) AND account_id = $2
           AND active AND deleted_at IS NULL FOR SHARE`, [ownerIds, accountId]);
        if (parties.rows.length !== ownerIds.length)
          throw new ApiError(400, 'OWNER_UNAVAILABLE', 'Selecciona propietarios activos de esta cuenta.');
        for (const partyId of ownerIds) await client.query(
          `INSERT INTO livestock_brand_owner(brand_id, party_id, account_id, created_by)
           VALUES($1,$2,$3,$4)`, [created.rows[0]!.id, partyId, accountId, auth.userId]);
      }
      await audit(client, auth, context, metadata, created.rows[0]!.id,
        'LIVESTOCK_BRAND_CREATED', null, created.rows[0]!);
      return created.rows[0]!;
    });
  } catch (error) {
    const databaseError = error as { code?: string; constraint?: string };
    if (databaseError.code === '23505' && databaseError.constraint === 'livestock_brand_name_property_unique') {
      throw conflict('BRAND_NAME_TAKEN', 'Ya existe una marquilla con ese nombre en la propiedad.');
    }
    throw error;
  }
}

export async function setBrandActive(auth: AuthState, context: PropertyContext,
  id: string, active: boolean, metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    const accountId = await access(client, auth, context);
    const current = await client.query<BrandRow>(
      `SELECT id, name, active FROM livestock_brand WHERE id = $1 AND account_id = $2 FOR UPDATE`,
      [id, accountId],
    );
    if (!current.rows[0]) throw new ApiError(404, 'BRAND_NOT_FOUND', 'La marquilla no está disponible en esta cuenta.');
    if (current.rows[0].active === active) return current.rows[0];
    const updated = await client.query<BrandRow>(
      `UPDATE livestock_brand SET active = $2 WHERE id = $1 RETURNING id, name, active`, [id, active],
    );
    await audit(client, auth, context, metadata, id, 'LIVESTOCK_BRAND_STATE_CHANGED',
      current.rows[0], updated.rows[0]!);
    return updated.rows[0]!;
  });
}
