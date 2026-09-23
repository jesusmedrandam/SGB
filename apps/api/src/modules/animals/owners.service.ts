import type { PoolClient } from 'pg';
import { conflict, forbidden, invalidRequest } from '../../core/errors.js';
import { pool } from '../../database/pool.js';
import { inTransaction } from '../../database/transaction.js';
import type { AuthState, PropertyContext, RequestMetadata } from '../auth/auth.types.js';
import { readAnimal } from './animals.service.js';

async function account(client: PoolClient, auth: AuthState, context: PropertyContext, permission: string) {
  const result = await client.query<{ account_id: string }>(
    `SELECT p.account_id FROM property p
     JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
     JOIN property_membership pm ON pm.property_id = p.id AND pm.user_id = $2 AND pm.status = 'ACTIVE'
     JOIN membership_role mr ON mr.membership_id = pm.id AND mr.property_id = p.id
     JOIN property_role pr ON pr.id = mr.role_id AND pr.property_id = p.id AND pr.active
     JOIN role_permission rp ON rp.role_id = pr.id AND rp.permission_code = $4
     WHERE p.id = $1 AND pr.id = $3 AND p.deleted_at IS NULL AND p.status = 'ACTIVE'
     FOR SHARE OF p, aa, pm, pr`,
    [context.propertyId, auth.userId, context.roleId, permission],
  );
  if (!result.rows[0]) throw forbidden('OWNER_MANAGE_DENIED', 'El rol activo no permite gestionar propietarios.');
  return result.rows[0].account_id;
}

async function audit(client: PoolClient, auth: AuthState, context: PropertyContext,
  metadata: RequestMetadata, action: string, type: string, id: string, before: unknown, after: unknown) {
  await client.query(`INSERT INTO audit_event(actor_user_id, property_id, active_role_id, action,
    entity_type, entity_id, before_data, after_data, ip_address, user_agent)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
  [auth.userId, context.propertyId, context.roleId, action, type, id,
    before === null ? null : JSON.stringify(before), JSON.stringify(after),
    metadata.ipAddress, metadata.userAgent]);
}

export async function listOwners(context: PropertyContext) {
  const result = await pool.query<{ id: string; display_name: string; kind: string; active: boolean }>(
    `SELECT id, display_name, kind, active FROM property_party
     WHERE account_id = (SELECT account_id FROM property WHERE id = $1)
       AND deleted_at IS NULL ORDER BY lower(display_name), id`, [context.propertyId]);
  return result.rows.map((row) => ({ id: row.id, name: row.display_name, kind: row.kind, active: row.active }));
}

export async function listAccountUsers(context: PropertyContext) {
  const result = await pool.query<{ id: string; display_name: string }>(
    `SELECT DISTINCT u.id, u.display_name FROM app_user u
     JOIN property_membership pm ON pm.user_id = u.id AND pm.status = 'ACTIVE'
     JOIN property p ON p.id = pm.property_id AND p.deleted_at IS NULL
     WHERE p.account_id = (SELECT account_id FROM property WHERE id = $1)
     ORDER BY u.display_name, u.id`, [context.propertyId]);
  return result.rows.map((row) => ({ id: row.id, name: row.display_name }));
}

export async function createOwner(auth: AuthState, context: PropertyContext,
  input: { kind: 'USER' | 'EXTERNAL_PERSON' | 'ORGANIZATION'; name?: string | undefined;
    userId?: string | undefined }, metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    const accountId = await account(client, auth, context, 'CATALOG_MANAGE');
    let name = input.name;
    if (input.kind === 'USER') {
      const user = await client.query<{ display_name: string }>(
        `SELECT u.display_name FROM app_user u JOIN property_membership pm ON pm.user_id = u.id
         JOIN property p ON p.id = pm.property_id
         WHERE u.id = $1 AND p.account_id = $2 AND pm.status = 'ACTIVE' LIMIT 1`,
        [input.userId, accountId]);
      if (!user.rows[0]) throw invalidRequest('OWNER_USER_UNAVAILABLE', 'El usuario no pertenece a esta cuenta.');
      name = user.rows[0].display_name;
      await client.query('SELECT id FROM administrative_account WHERE id = $1 FOR UPDATE', [accountId]);
      const existing = await client.query('SELECT 1 FROM property_party WHERE account_id = $1 AND linked_user_id = $2 AND deleted_at IS NULL',
        [accountId, input.userId]);
      if (existing.rowCount) throw conflict('OWNER_ALREADY_EXISTS', 'El usuario ya está registrado como propietario en la cuenta.');
    }
    const result = await client.query<{ id: string }>(
      `INSERT INTO property_party(account_id, property_id, kind, linked_user_id, display_name, created_by)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [accountId, context.propertyId, input.kind, input.userId ?? null, name, auth.userId]);
    const owner = { id: result.rows[0]!.id, kind: input.kind, name, active: true };
    await audit(client, auth, context, metadata, 'OWNER_CREATED', 'PROPERTY_PARTY', owner.id, null, owner);
    return owner;
  });
}

export async function setBrandOwners(auth: AuthState, context: PropertyContext,
  brandId: string, ownerIds: string[], metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    const accountId = await account(client, auth, context, 'CATALOG_MANAGE');
    const brand = await client.query('SELECT id FROM livestock_brand WHERE id = $1 AND account_id = $2 FOR UPDATE',
      [brandId, accountId]);
    if (!brand.rowCount) throw invalidRequest('BRAND_UNAVAILABLE', 'La marquilla no pertenece a esta cuenta.');
    const parties = await client.query<{ id: string }>(
      `SELECT id FROM property_party WHERE id = ANY($1::uuid[]) AND account_id = $2
       AND active AND deleted_at IS NULL FOR SHARE`, [ownerIds, accountId]);
    if (parties.rows.length !== ownerIds.length) throw invalidRequest('OWNER_UNAVAILABLE', 'Selecciona propietarios activos de esta cuenta.');
    const before = await client.query<{ party_id: string }>('SELECT party_id FROM livestock_brand_owner WHERE brand_id = $1', [brandId]);
    await client.query(`DELETE FROM livestock_brand_owner WHERE brand_id = $1 AND NOT (party_id = ANY($2::uuid[]))`,
      [brandId, ownerIds]);
    for (const partyId of ownerIds) await client.query(
      `INSERT INTO livestock_brand_owner(brand_id, party_id, account_id, created_by)
       VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [brandId, partyId, accountId, auth.userId]);
    await audit(client, auth, context, metadata, 'BRAND_OWNERS_UPDATED', 'LIVESTOCK_BRAND', brandId,
      before.rows.map((row) => row.party_id), ownerIds);
    return { ownerIds };
  });
}

export async function setAnimalOwners(auth: AuthState, context: PropertyContext, animalId: string,
  owners: Array<{ partyId: string; percent: number; isPrimary: boolean }>, expectedVersion: number,
  metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    const accountId = await account(client, auth, context, 'ANIMAL_UPDATE');
    const animal = await client.query<{ version: string }>(
      `SELECT version::text FROM animal WHERE id = $1 AND property_id = $2 AND record_status = 'CURRENT' FOR UPDATE`,
      [animalId, context.propertyId]);
    if (!animal.rows[0]) throw invalidRequest('ANIMAL_UNAVAILABLE', 'El animal no pertenece a esta propiedad.');
    if (Number(animal.rows[0].version) !== expectedVersion)
      throw conflict('ANIMAL_VERSION_CONFLICT', 'El animal cambió. Actualiza su ficha antes de guardar.');
    const parties = await client.query<{ id: string }>(
      `SELECT id FROM property_party WHERE id = ANY($1::uuid[]) AND account_id = $2
       AND active AND deleted_at IS NULL FOR SHARE`, [owners.map((owner) => owner.partyId), accountId]);
    if (parties.rows.length !== owners.length) throw invalidRequest('OWNER_UNAVAILABLE', 'Selecciona propietarios activos de esta cuenta.');
    const before = await readAnimal(client, context, animalId);
    await client.query(`UPDATE animal_ownership SET valid_until = current_date
      WHERE animal_id = $1 AND valid_until IS NULL`, [animalId]);
    for (const owner of owners) await client.query(
      `INSERT INTO animal_ownership(property_id, account_id, animal_id, party_id,
         ownership_percent, is_primary, created_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [context.propertyId, accountId, animalId, owner.partyId, owner.percent, owner.isPrimary, auth.userId]);
    await client.query('UPDATE animal SET updated_by = $2 WHERE id = $1', [animalId, auth.userId]);
    const after = await readAnimal(client, context, animalId);
    await audit(client, auth, context, metadata, 'ANIMAL_OWNERS_UPDATED', 'ANIMAL', animalId, before, after);
    return after;
  });
}
