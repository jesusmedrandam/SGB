import type { PoolClient, QueryResultRow } from 'pg';
import { ApiError, forbidden } from '../../core/errors.js';
import { inTransaction } from '../../database/transaction.js';
import type { AuthState, RequestMetadata } from '../auth/auth.types.js';
import type { AccountUpdateInput } from './superadmin.schemas.js';

interface AccountRow extends QueryResultRow {
  id: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
  max_properties: number;
  created_at: Date;
  owner_id: string;
  owner_name: string;
  owner_email: string;
  property_count: string;
  collaborator_count: string;
}

const notFound = (message: string) => new ApiError(404, 'NOT_FOUND', message);
const numeric = (value: string | number | null) => value === null ? null : Number(value);

async function audit(
  client: PoolClient,
  auth: AuthState,
  metadata: RequestMetadata,
  action: string,
  entityType: string,
  entityId: string | null,
  beforeData: unknown = null,
  afterData: unknown = null,
) {
  await client.query(
    `INSERT INTO audit_event(
       actor_user_id, action, entity_type, entity_id, before_data, after_data,
       superadmin_access, ip_address, user_agent
     ) VALUES($1,$2,$3,$4,$5,$6,true,$7,$8)`,
    [
      auth.userId,
      action,
      entityType,
      entityId,
      beforeData === null ? null : JSON.stringify(beforeData),
      afterData === null ? null : JSON.stringify(afterData),
      metadata.ipAddress,
      metadata.userAgent,
    ],
  );
}

function accountData(row: AccountRow) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    maxProperties: row.max_properties,
    createdAt: row.created_at.toISOString(),
    owner: { id: row.owner_id, name: row.owner_name, email: row.owner_email },
    propertyCount: Number(row.property_count),
    collaboratorCount: Number(row.collaborator_count),
  };
}

export async function getPlatformOverview(auth: AuthState, metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    const totals = await client.query<{
      users: string;
      accounts: string;
      properties: string;
      managed_animals: string;
    }>(
      `SELECT
         (SELECT count(*) FROM app_user WHERE deleted_at IS NULL) AS users,
         (SELECT count(*) FROM administrative_account) AS accounts,
         (SELECT count(*) FROM property WHERE deleted_at IS NULL AND status <> 'ARCHIVED') AS properties,
         (SELECT coalesce(sum(used_value), 0) FROM account_managed_animal_usage) AS managed_animals`,
    );
    const accounts = await client.query<AccountRow>(
      `SELECT aa.id, aa.name, aa.status, aa.max_properties, aa.created_at,
              u.id AS owner_id, u.display_name AS owner_name, u.email::text AS owner_email,
              (SELECT count(*) FROM property p
                WHERE p.account_id = aa.id AND p.deleted_at IS NULL AND p.status <> 'ARCHIVED') AS property_count,
              coalesce(cu.used_value, 0)::text AS collaborator_count
         FROM administrative_account aa
         JOIN app_user u ON u.id = aa.owner_user_id
         LEFT JOIN account_collaborator_usage cu ON cu.account_id = aa.id
        ORDER BY aa.created_at DESC
        LIMIT 100`,
    );
    await audit(client, auth, metadata, 'SUPERADMIN_DASHBOARD_VIEWED', 'PLATFORM', null, null, {
      returnedAccounts: accounts.rowCount,
    });
    const row = totals.rows[0]!;
    return {
      totals: {
        users: Number(row.users),
        accounts: Number(row.accounts),
        properties: Number(row.properties),
        managedAnimals: Number(row.managed_animals),
      },
      accounts: accounts.rows.map(accountData),
    };
  });
}

export async function getAccountDetails(
  auth: AuthState,
  accountId: string,
  metadata: RequestMetadata,
) {
  return inTransaction(async (client) => {
    const account = await client.query<AccountRow>(
      `SELECT aa.id, aa.name, aa.status, aa.max_properties, aa.created_at,
              u.id AS owner_id, u.display_name AS owner_name, u.email::text AS owner_email,
              (SELECT count(*) FROM property p
                WHERE p.account_id = aa.id AND p.deleted_at IS NULL AND p.status <> 'ARCHIVED') AS property_count,
              coalesce(cu.used_value, 0)::text AS collaborator_count
         FROM administrative_account aa
         JOIN app_user u ON u.id = aa.owner_user_id
         LEFT JOIN account_collaborator_usage cu ON cu.account_id = aa.id
        WHERE aa.id = $1`,
      [accountId],
    );
    const row = account.rows[0];
    if (!row) throw notFound('La cuenta administrativa no existe.');

    const [properties, quotas, modules] = await Promise.all([
      client.query<{
        id: string; name: string; status: string; timezone: string; created_at: Date;
        member_count: string; animal_count: string;
      }>(
        `SELECT p.id, p.name, p.status, p.timezone, p.created_at,
                (SELECT count(*) FROM property_membership pm
                  WHERE pm.property_id = p.id AND pm.status = 'ACTIVE') AS member_count,
                (SELECT count(*) FROM animal a
                  WHERE a.property_id = p.id AND a.record_status = 'CURRENT') AS animal_count
           FROM property p
          WHERE p.account_id = $1 AND p.deleted_at IS NULL
          ORDER BY p.name`,
        [accountId],
      ),
      client.query<{
        code: string; name: string; description: string; unit: 'BYTES' | 'COUNT';
        limit_value: string | null; warning_percent: number; used_value: string;
      }>(
        `SELECT q.quota_code AS code, q.name, qc.description, q.unit,
                q.limit_value::text, q.warning_percent,
                CASE q.quota_code
                  WHEN 'MEDIA_STORAGE_BYTES' THEN coalesce(mu.used_value, 0)
                  WHEN 'MANAGED_ANIMALS' THEN coalesce(au.used_value, 0)
                  WHEN 'COLLABORATOR_USERS' THEN coalesce(cu.used_value, 0)
                  ELSE 0
                END::text AS used_value
           FROM effective_account_quota q
           JOIN quota_catalog qc ON qc.code = q.quota_code
           LEFT JOIN account_media_storage_usage mu ON mu.account_id = q.account_id
           LEFT JOIN account_managed_animal_usage au ON au.account_id = q.account_id
           LEFT JOIN account_collaborator_usage cu ON cu.account_id = q.account_id
          WHERE q.account_id = $1
          ORDER BY q.name`,
        [accountId],
      ),
      client.query<{
        code: string; name: string; description: string | null; is_core: boolean; enabled: boolean;
      }>(
        `SELECT m.code, m.name, m.description, m.is_core,
                CASE WHEN m.is_core THEN true ELSE coalesce(am.enabled, false) END AS enabled
           FROM module_catalog m
           LEFT JOIN account_module am ON am.account_id = $1 AND am.module_code = m.code
          WHERE m.scope = 'ACCOUNT_PROPERTY'
          ORDER BY m.is_core DESC, m.name`,
        [accountId],
      ),
    ]);

    await audit(client, auth, metadata, 'SUPERADMIN_ACCOUNT_VIEWED', 'ADMINISTRATIVE_ACCOUNT', accountId);
    return {
      account: accountData(row),
      properties: properties.rows.map((property) => ({
        id: property.id,
        name: property.name,
        status: property.status,
        timezone: property.timezone,
        createdAt: property.created_at.toISOString(),
        memberCount: Number(property.member_count),
        animalCount: Number(property.animal_count),
      })),
      quotas: quotas.rows.map((quota) => ({
        code: quota.code,
        name: quota.name,
        description: quota.description,
        unit: quota.unit,
        limitValue: numeric(quota.limit_value),
        usedValue: Number(quota.used_value),
        warningPercent: quota.warning_percent,
      })),
      modules: modules.rows.map((module) => ({
        code: module.code,
        name: module.name,
        description: module.description,
        isCore: module.is_core,
        enabled: module.enabled,
      })),
    };
  });
}

export async function updateAccount(
  auth: AuthState,
  accountId: string,
  input: AccountUpdateInput,
  metadata: RequestMetadata,
) {
  return inTransaction(async (client) => {
    const before = await client.query<{ status: string; max_properties: number }>(
      `SELECT status, max_properties FROM administrative_account WHERE id = $1 FOR UPDATE`,
      [accountId],
    );
    if (!before.rows[0]) throw notFound('La cuenta administrativa no existe.');
    const updated = await client.query<{ status: string; max_properties: number }>(
      `UPDATE administrative_account
          SET status = coalesce($2::account_status, status),
              max_properties = coalesce($3::integer, max_properties)
        WHERE id = $1
        RETURNING status, max_properties`,
      [accountId, input.status ?? null, input.maxProperties ?? null],
    );
    const after = { status: updated.rows[0]!.status, maxProperties: updated.rows[0]!.max_properties };
    await audit(client, auth, metadata, 'SUPERADMIN_ACCOUNT_UPDATED', 'ADMINISTRATIVE_ACCOUNT', accountId,
      { status: before.rows[0].status, maxProperties: before.rows[0].max_properties }, after);
    return after;
  });
}

export async function updateAccountQuota(
  auth: AuthState,
  accountId: string,
  quotaCode: string,
  limitValue: number | null,
  metadata: RequestMetadata,
) {
  return inTransaction(async (client) => {
    const account = await client.query(`SELECT 1 FROM administrative_account WHERE id = $1 FOR UPDATE`, [accountId]);
    if (!account.rowCount) throw notFound('La cuenta administrativa no existe.');
    const quota = await client.query<{ name: string; unit: string }>(
      `SELECT name, unit FROM quota_catalog WHERE code = $1 AND active`, [quotaCode],
    );
    if (!quota.rows[0]) throw notFound('El límite solicitado no existe.');
    const before = await client.query<{ limit_value: string | null }>(
      `SELECT limit_value::text FROM account_quota WHERE account_id = $1 AND quota_code = $2`,
      [accountId, quotaCode],
    );
    await client.query(
      `INSERT INTO account_quota(account_id, quota_code, limit_value, configured_by, configured_at)
       VALUES($1,$2,$3,$4,now())
       ON CONFLICT (account_id, quota_code) DO UPDATE
         SET limit_value = excluded.limit_value,
             configured_by = excluded.configured_by,
             configured_at = now()`,
      [accountId, quotaCode, limitValue, auth.userId],
    );
    await audit(client, auth, metadata, 'SUPERADMIN_QUOTA_UPDATED', 'ACCOUNT_QUOTA', `${accountId}:${quotaCode}`,
      { limitValue: numeric(before.rows[0]?.limit_value ?? null) }, { limitValue });
    return { code: quotaCode, name: quota.rows[0].name, unit: quota.rows[0].unit, limitValue };
  });
}

export async function updateAccountModule(
  auth: AuthState,
  accountId: string,
  moduleCode: string,
  enabled: boolean,
  metadata: RequestMetadata,
) {
  return inTransaction(async (client) => {
    const account = await client.query(`SELECT 1 FROM administrative_account WHERE id = $1 FOR UPDATE`, [accountId]);
    if (!account.rowCount) throw notFound('La cuenta administrativa no existe.');
    const module = await client.query<{ name: string; is_core: boolean }>(
      `SELECT name, is_core FROM module_catalog
        WHERE code = $1 AND scope = 'ACCOUNT_PROPERTY'`,
      [moduleCode],
    );
    const catalog = module.rows[0];
    if (!catalog) throw notFound('El módulo solicitado no existe.');
    if (catalog.is_core && !enabled) {
      throw forbidden('CORE_MODULE_REQUIRED', 'El núcleo ganadero no puede deshabilitarse.');
    }
    const before = await client.query<{ enabled: boolean }>(
      `SELECT enabled FROM account_module WHERE account_id = $1 AND module_code = $2`,
      [accountId, moduleCode],
    );
    await client.query(
      `INSERT INTO account_module(account_id, module_code, enabled, configured_by, configured_at)
       VALUES($1,$2,$3,$4,now())
       ON CONFLICT (account_id, module_code) DO UPDATE
         SET enabled = excluded.enabled,
             configured_by = excluded.configured_by,
             configured_at = now()`,
      [accountId, moduleCode, catalog.is_core || enabled, auth.userId],
    );
    const actualEnabled = catalog.is_core || enabled;
    await audit(client, auth, metadata, 'SUPERADMIN_MODULE_UPDATED', 'ACCOUNT_MODULE', `${accountId}:${moduleCode}`,
      { enabled: before.rows[0]?.enabled ?? false }, { enabled: actualEnabled });
    return { code: moduleCode, name: catalog.name, isCore: catalog.is_core, enabled: actualEnabled };
  });
}
