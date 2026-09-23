import type { PoolClient } from 'pg';
import { conflict, forbidden, invalidRequest } from '../../core/errors.js';
import { pool } from '../../database/pool.js';
import { inTransaction } from '../../database/transaction.js';
import type { AuthState, PropertyContext, RequestMetadata } from '../auth/auth.types.js';

async function record(client: PoolClient, auth: AuthState, metadata: RequestMetadata,
  action: string, entityType: string, entityId: string, propertyId: string,
  roleId: string, before: unknown, after: unknown) {
  await client.query(
    `INSERT INTO audit_event(actor_user_id, property_id, active_role_id, action, entity_type, entity_id,
       before_data, after_data, ip_address, user_agent)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
    [auth.userId, propertyId, roleId, action, entityType, entityId,
      before === null ? null : JSON.stringify(before), JSON.stringify(after),
      metadata.ipAddress, metadata.userAgent],
  );
}

// This is shared by an owner's first property and a later property in an existing account.
async function seedProperty(client: PoolClient, input: {
  accountId: string; ownerId: string; creatorId: string; name: string;
}) {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO property(account_id, owner_user_id, name, created_by)
     VALUES($1,$2,$3,$4) RETURNING id`,
    [input.accountId, input.ownerId, input.name, input.creatorId],
  );
  const propertyId = inserted.rows[0]!.id;
  await client.query(
    `INSERT INTO property_module(property_id, module_code, enabled, configured_by)
     SELECT $1, module_code, enabled, $2 FROM account_module WHERE account_id = $3`,
    [propertyId, input.creatorId, input.accountId],
  );
  await client.query(
    `INSERT INTO property_role(property_id, code, name, description, is_system, created_by)
     SELECT $1, code, name, description, true, $2 FROM role_template WHERE active`,
    [propertyId, input.creatorId],
  );
  await client.query(
    `INSERT INTO role_permission(role_id, permission_code)
     SELECT pr.id, rtp.permission_code FROM property_role pr
     JOIN role_template_permission rtp ON rtp.role_code = pr.code
     WHERE pr.property_id = $1`,
    [propertyId],
  );
  const roles = await client.query<{ id: string; code: string }>(
    `SELECT id, code FROM property_role WHERE property_id = $1 AND code IN ('OWNER','ADMINISTRATOR')`,
    [propertyId],
  );
  const ownerRoleId = roles.rows.find((role) => role.code === 'OWNER')!.id;
  const administratorRoleId = roles.rows.find((role) => role.code === 'ADMINISTRATOR')!.id;
  const ownerMembership = await client.query<{ id: string }>(
    `INSERT INTO property_membership(property_id, user_id, status, job_title, joined_at, created_by)
     VALUES($1,$2,'ACTIVE','Propietario',now(),$3) RETURNING id`,
    [propertyId, input.ownerId, input.creatorId],
  );
  await client.query(
    `INSERT INTO membership_role(membership_id, role_id, property_id, assigned_by)
     VALUES($1,$2,$3,$4)`,
    [ownerMembership.rows[0]!.id, ownerRoleId, propertyId, input.creatorId],
  );
  if (input.creatorId !== input.ownerId) {
    const adminMembership = await client.query<{ id: string }>(
      `INSERT INTO property_membership(property_id, user_id, status, job_title, joined_at, created_by)
       VALUES($1,$2,'ACTIVE','Administrador',now(),$2) RETURNING id`,
      [propertyId, input.creatorId],
    );
    await client.query(
      `INSERT INTO membership_role(membership_id, role_id, property_id, assigned_by)
       VALUES($1,$2,$3,$4)`,
      [adminMembership.rows[0]!.id, administratorRoleId, propertyId, input.creatorId],
    );
  }
  return { propertyId, roleId: input.creatorId === input.ownerId ? ownerRoleId : administratorRoleId };
}

async function activateSession(client: PoolClient, auth: AuthState, propertyId: string, roleId: string) {
  await client.query(
    `UPDATE user_session SET active_property_id = $2, active_role_id = $3, last_seen_at = now()
     WHERE id = $1 AND user_id = $4 AND revoked_at IS NULL`,
    [auth.sessionId, propertyId, roleId, auth.userId],
  );
}

export async function createOwnAccount(auth: AuthState, name: string, metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    const user = await client.query(
      `SELECT id FROM app_user WHERE id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL FOR UPDATE`,
      [auth.userId],
    );
    if (!user.rowCount) throw forbidden('USER_UNAVAILABLE', 'El usuario no está disponible.');
    const existing = await client.query(
      `SELECT id FROM administrative_account WHERE owner_user_id = $1`, [auth.userId],
    );
    if (existing.rowCount) throw conflict('ACCOUNT_ALREADY_EXISTS', 'Ya tienes una cuenta administrativa.');
    // Accounts created through bootstrap have not gone through public registration.
    // Seed their personal modules without changing settings already chosen by other users.
    await client.query(
      `INSERT INTO user_module(user_id, module_code, enabled, configured_by)
       SELECT $1, code, true, $1 FROM module_catalog WHERE scope = 'USER'
       ON CONFLICT (user_id, module_code) DO NOTHING`,
      [auth.userId],
    );
    const account = await client.query<{ id: string }>(
      `INSERT INTO administrative_account(owner_user_id, name) VALUES($1,$2) RETURNING id`,
      [auth.userId, name],
    );
    const accountId = account.rows[0]!.id;
    await client.query(
      `INSERT INTO account_module(account_id, module_code, enabled, configured_by)
       SELECT $1, code, true, $2 FROM module_catalog WHERE scope = 'ACCOUNT_PROPERTY'`,
      [accountId, auth.userId],
    );
    const created = await seedProperty(client, {
      accountId, ownerId: auth.userId, creatorId: auth.userId, name,
    });
    await activateSession(client, auth, created.propertyId, created.roleId);
    await record(client, auth, metadata, 'ACCOUNT_CREATED', 'ADMINISTRATIVE_ACCOUNT', accountId,
      created.propertyId, created.roleId, null, { name, propertyId: created.propertyId });
    return { accountId, ...created };
  });
}

export async function getPropertySettings(context: PropertyContext) {
  const [account, modules] = await Promise.all([
    pool.query<{ id: string; name: string; max_properties: number; used: string; owner_user_id: string }>(
      `SELECT aa.id, aa.name, aa.max_properties, aa.owner_user_id,
              (SELECT count(*) FROM property other WHERE other.account_id = aa.id
                AND other.deleted_at IS NULL AND other.status <> 'ARCHIVED')::text AS used
       FROM property p JOIN administrative_account aa ON aa.id = p.account_id
       WHERE p.id = $1 AND p.status = 'ACTIVE' AND p.deleted_at IS NULL AND aa.status = 'ACTIVE'`,
      [context.propertyId],
    ),
    pool.query<{ code: string; name: string; is_core: boolean; account_enabled: boolean; property_enabled: boolean }>(
      `SELECT m.code, m.name, m.is_core,
              CASE WHEN m.is_core THEN true ELSE coalesce(am.enabled, false) END AS account_enabled,
              CASE WHEN m.is_core THEN true ELSE coalesce(pm.enabled, false) END AS property_enabled
       FROM property p JOIN module_catalog m ON m.scope = 'ACCOUNT_PROPERTY'
       LEFT JOIN account_module am ON am.account_id = p.account_id AND am.module_code = m.code
       LEFT JOIN property_module pm ON pm.property_id = p.id AND pm.module_code = m.code
       WHERE p.id = $1 ORDER BY m.is_core DESC, m.name`,
      [context.propertyId],
    ),
  ]);
  const row = account.rows[0];
  if (!row) throw forbidden('PROPERTY_UNAVAILABLE', 'Esta propiedad ya no está disponible.');
  return {
    account: { id: row.id, name: row.name, maxProperties: row.max_properties,
      usedProperties: Number(row.used) },
    canCreate: context.permissions.has('PROPERTY_CREATE'),
    canManageModules: context.permissions.has('MODULE_MANAGE'),
    modules: modules.rows.map((module) => ({
      code: module.code, name: module.name, isCore: module.is_core,
      accountEnabled: module.account_enabled, propertyEnabled: module.property_enabled,
      enabled: module.is_core || (module.account_enabled && module.property_enabled),
    })),
  };
}

export async function createAccountProperty(auth: AuthState, context: PropertyContext,
  name: string, metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    // Serialize account creation and superadmin quota changes on this account row.
    const account = await client.query<{ id: string; owner_user_id: string; max_properties: number }>(
      `SELECT aa.id, aa.owner_user_id, aa.max_properties
       FROM administrative_account aa
       JOIN property p ON p.account_id = aa.id
       WHERE p.id = $1 AND aa.status = 'ACTIVE' FOR UPDATE OF aa`,
      [context.propertyId],
    );
    const row = account.rows[0];
    if (!row) throw forbidden('ACCOUNT_UNAVAILABLE', 'La cuenta administrativa no está disponible.');
    const grant = await client.query(
      `SELECT 1 FROM property_membership pm
       JOIN property p ON p.id = pm.property_id AND p.status = 'ACTIVE' AND p.deleted_at IS NULL
       JOIN membership_role mr ON mr.membership_id = pm.id AND mr.property_id = pm.property_id
       JOIN property_role pr ON pr.id = mr.role_id AND pr.active
       JOIN role_permission rp ON rp.role_id = pr.id AND rp.permission_code = 'PROPERTY_CREATE'
       WHERE pm.property_id = $1 AND pm.user_id = $2 AND pm.status = 'ACTIVE' AND pr.id = $3
         AND pr.code IN ('OWNER','ADMINISTRATOR') AND p.account_id = $4`,
      [context.propertyId, auth.userId, context.roleId, row.id],
    );
    if (!grant.rowCount) throw forbidden('PROPERTY_CREATE_DENIED', 'El rol activo no permite crear propiedades.');
    const usage = await client.query<{ used: string }>(
      `SELECT count(*)::text AS used FROM property
       WHERE account_id = $1 AND deleted_at IS NULL AND status <> 'ARCHIVED'`,
      [row.id],
    );
    if (Number(usage.rows[0]?.used ?? 0) >= row.max_properties) {
      throw conflict('PROPERTY_LIMIT_REACHED', 'Se alcanzó el límite de propiedades de esta cuenta.');
    }
    const duplicate = await client.query(
      `SELECT 1 FROM property WHERE account_id = $1 AND lower(name) = lower($2)
       AND deleted_at IS NULL`,
      [row.id, name],
    );
    if (duplicate.rowCount) throw conflict('PROPERTY_NAME_TAKEN', 'Ya existe una propiedad con ese nombre en esta cuenta.');
    const created = await seedProperty(client, {
      accountId: row.id, ownerId: row.owner_user_id, creatorId: auth.userId, name,
    });
    await activateSession(client, auth, created.propertyId, created.roleId);
    await record(client, auth, metadata, 'PROPERTY_CREATED', 'PROPERTY', created.propertyId,
      created.propertyId, created.roleId, null, { name, accountId: row.id, ownerId: row.owner_user_id });
    return { accountId: row.id, ...created };
  });
}

export async function updatePropertyModule(auth: AuthState, context: PropertyContext,
  moduleCode: string, enabled: boolean, metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    const account = await client.query<{ id: string }>(
      `SELECT aa.id FROM administrative_account aa
       JOIN property p ON p.account_id = aa.id
       WHERE p.id = $1 AND aa.status = 'ACTIVE' FOR UPDATE OF aa`,
      [context.propertyId],
    );
    if (!account.rows[0]) throw forbidden('ACCOUNT_UNAVAILABLE', 'La cuenta administrativa no está disponible.');
    const grant = await client.query(
      `SELECT 1 FROM property_membership pm
       JOIN property p ON p.id = pm.property_id AND p.status = 'ACTIVE' AND p.deleted_at IS NULL
       JOIN membership_role mr ON mr.membership_id = pm.id AND mr.property_id = pm.property_id
       JOIN property_role pr ON pr.id = mr.role_id AND pr.active
       JOIN role_permission rp ON rp.role_id = pr.id AND rp.permission_code = 'MODULE_MANAGE'
       WHERE pm.property_id = $1 AND pm.user_id = $2 AND pm.status = 'ACTIVE' AND pr.id = $3`,
      [context.propertyId, auth.userId, context.roleId],
    );
    if (!grant.rowCount) throw forbidden('MODULE_MANAGE_DENIED', 'El rol activo no permite configurar módulos.');
    const module = await client.query<{ name: string; is_core: boolean; account_enabled: boolean; property_enabled: boolean }>(
      `SELECT m.name, m.is_core,
         CASE WHEN m.is_core THEN true ELSE coalesce(am.enabled, false) END AS account_enabled,
         CASE WHEN m.is_core THEN true ELSE coalesce(pm.enabled, false) END AS property_enabled
       FROM property p JOIN module_catalog m ON m.code = $2 AND m.scope = 'ACCOUNT_PROPERTY'
       LEFT JOIN account_module am ON am.account_id = p.account_id AND am.module_code = m.code
       LEFT JOIN property_module pm ON pm.property_id = p.id AND pm.module_code = m.code
       WHERE p.id = $1`,
      [context.propertyId, moduleCode],
    );
    const current = module.rows[0];
    if (!current) throw invalidRequest('UNKNOWN_MODULE', 'El módulo solicitado no existe.');
    if (current.is_core && !enabled) throw forbidden('CORE_MODULE_REQUIRED', 'El núcleo ganadero debe permanecer activo.');
    if (enabled && !current.account_enabled) {
      throw forbidden('ACCOUNT_MODULE_DISABLED', 'El superadministrador deshabilitó este módulo para la cuenta.');
    }
    await client.query(
      `INSERT INTO property_module(property_id, module_code, enabled, configured_by, configured_at)
       VALUES($1,$2,$3,$4,now())
       ON CONFLICT (property_id, module_code) DO UPDATE
         SET enabled = excluded.enabled, configured_by = excluded.configured_by, configured_at = now()`,
      [context.propertyId, moduleCode, current.is_core || enabled, auth.userId],
    );
    await record(client, auth, metadata, 'PROPERTY_MODULE_UPDATED', 'PROPERTY_MODULE',
      `${context.propertyId}:${moduleCode}`, context.propertyId, context.roleId,
      { enabled: current.property_enabled }, { enabled: current.is_core || enabled });
    return { code: moduleCode, enabled: current.is_core || (current.account_enabled && enabled) };
  });
}
