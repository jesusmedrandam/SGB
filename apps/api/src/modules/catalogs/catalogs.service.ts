import type { PoolClient } from 'pg';
import { conflict, forbidden, invalidRequest } from '../../core/errors.js';
import { pool } from '../../database/pool.js';
import { inTransaction } from '../../database/transaction.js';
import type { AuthState, PropertyContext, RequestMetadata } from '../auth/auth.types.js';
import type { EditableCatalogCode } from './catalogs.schemas.js';

interface CatalogItemRow {
  id: string;
  catalog_code: EditableCatalogCode;
  name: string;
  species_code: string | null;
  system_defined: boolean;
  active: boolean;
}

function item(row: CatalogItemRow) {
  return { id: row.id, catalogCode: row.catalog_code, name: row.name,
    speciesCode: row.species_code, systemDefined: row.system_defined, active: row.active };
}

export async function getCatalogReference(context: PropertyContext) {
  const [species, units] = await Promise.all([
    pool.query<{ code: string; name: string; ruleset_code: string; ruleset_version: number }>(
      `SELECT s.code, s.name, s.ruleset_code, s.ruleset_version
       FROM effective_property_species eps
       JOIN species_catalog s ON s.code = eps.species_code AND s.active
       WHERE eps.property_id = $1 AND eps.enabled ORDER BY s.name`, [context.propertyId]),
    pool.query<{ context_code: string; code: string; name: string; symbol: string; is_default: boolean }>(
      `SELECT acu.context_code, u.code, u.name, u.symbol, acu.is_default
       FROM allowed_context_unit acu
       JOIN measurement_unit u ON u.code = acu.unit_code AND u.active
       JOIN unit_usage_context uc ON uc.code = acu.context_code AND uc.active
       WHERE acu.context_code = ANY($1::varchar[])
       ORDER BY acu.context_code, acu.sort_order, u.name`,
      [['ANIMAL_WEIGHT', 'LAND_AREA']]),
  ]);
  return {
    species: species.rows.map((row) => ({ code: row.code, name: row.name,
      rulesetCode: row.ruleset_code, rulesetVersion: row.ruleset_version })),
    units: units.rows.map((row) => ({ contextCode: row.context_code, code: row.code,
      name: row.name, symbol: row.symbol, isDefault: row.is_default })),
  };
}

export async function listCatalogItems(context: PropertyContext, code: EditableCatalogCode) {
  const result = await pool.query<CatalogItemRow>(
    `SELECT ci.id, ci.catalog_code, ci.name, ci.species_code, ci.system_defined, ci.active
     FROM governed_catalog_item ci
     JOIN catalog_definition cd ON cd.code = ci.catalog_code AND cd.active
     WHERE ci.catalog_code = $2 AND ci.deleted_at IS NULL
       AND (ci.system_defined OR ci.account_id = (SELECT account_id FROM property WHERE id = $1))
       AND (ci.species_code IS NULL OR EXISTS (
         SELECT 1 FROM effective_property_species eps
         WHERE eps.property_id = $1 AND eps.species_code = ci.species_code AND eps.enabled))
     ORDER BY ci.system_defined DESC, lower(ci.name), ci.id`,
    [context.propertyId, code],
  );
  return result.rows.map(item);
}

async function ensureManageAccess(client: PoolClient, auth: AuthState, context: PropertyContext,
  code: EditableCatalogCode, speciesCode: string | null) {
  // Recheck inside the transaction: a stale browser or session must not retain write access.
  const access = await client.query<{ account_id: string }>(
    `SELECT p.account_id FROM property p
     JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
     JOIN property_membership pm ON pm.property_id = p.id AND pm.user_id = $2 AND pm.status = 'ACTIVE'
     JOIN membership_role mr ON mr.membership_id = pm.id AND mr.property_id = p.id
     JOIN property_role pr ON pr.id = mr.role_id AND pr.property_id = p.id AND pr.active
     JOIN role_permission rp ON rp.role_id = pr.id AND rp.permission_code = 'CATALOG_MANAGE'
     JOIN catalog_definition cd ON cd.code = $4 AND cd.active
       AND cd.scope = 'PROPERTY' AND cd.mutability = 'PROPERTY_EXTENSIBLE'
     WHERE p.id = $1 AND pr.id = $3 AND p.deleted_at IS NULL AND p.status = 'ACTIVE'
     FOR SHARE OF p, aa, pm, pr`,
    [context.propertyId, auth.userId, context.roleId, code],
  );
  if (!access.rows[0]) throw forbidden('CATALOG_MANAGE_DENIED', 'El rol activo no permite editar este catálogo.');
  if (speciesCode) {
    const species = await client.query(
      `SELECT 1 FROM effective_property_species
       WHERE property_id = $1 AND species_code = $2 AND enabled`,
      [context.propertyId, speciesCode],
    );
    if (!species.rowCount) throw invalidRequest('SPECIES_DISABLED', 'La especie no está habilitada para esta propiedad.');
  }
  return access.rows[0].account_id;
}

async function audit(client: PoolClient, auth: AuthState, context: PropertyContext,
  metadata: RequestMetadata, action: string, id: string, before: unknown, after: unknown) {
  await client.query(
    `INSERT INTO audit_event(actor_user_id, property_id, active_role_id, action, entity_type, entity_id,
       before_data, after_data, ip_address, user_agent)
     VALUES($1,$2,$3,$4,'CATALOG_ITEM',$5,$6::jsonb,$7::jsonb,$8,$9)`,
    [auth.userId, context.propertyId, context.roleId, action, id,
      before === null ? null : JSON.stringify(before), JSON.stringify(after),
      metadata.ipAddress, metadata.userAgent],
  );
}

export async function createCatalogItem(auth: AuthState, context: PropertyContext,
  code: EditableCatalogCode, input: { name: string; speciesCode?: 'BOVINE' | null | undefined }, metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    const speciesCode = input.speciesCode ?? null;
    const accountId = await ensureManageAccess(client, auth, context, code, speciesCode);
    await client.query('SELECT id FROM administrative_account WHERE id = $1 FOR UPDATE', [accountId]);
    const duplicate = await client.query(`SELECT 1 FROM governed_catalog_item
       WHERE catalog_code = $1 AND lower(name) = lower($2) AND deleted_at IS NULL
         AND (system_defined OR account_id = $3) LIMIT 1`, [code, input.name, accountId]);
    if (duplicate.rowCount) throw conflict('CATALOG_NAME_TAKEN', 'Esta opción ya existe para la cuenta.');
    const result = await client.query<CatalogItemRow>(
      `INSERT INTO governed_catalog_item(catalog_code, account_id, property_id, species_code,
         name, created_by)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING id, catalog_code, name, species_code, system_defined, active`,
      [code, accountId, context.propertyId, speciesCode, input.name, auth.userId],
    );
    const created = item(result.rows[0]!);
    await audit(client, auth, context, metadata, 'CATALOG_ITEM_CREATED', created.id, null, created);
    return created;
  });
}

export async function setCatalogItemActive(auth: AuthState, context: PropertyContext,
  code: EditableCatalogCode, id: string, active: boolean, metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    const accountId = await ensureManageAccess(client, auth, context, code, null);
    const current = await client.query<CatalogItemRow>(
      `SELECT id, catalog_code, name, species_code, system_defined, active
       FROM governed_catalog_item
       WHERE id = $1 AND catalog_code = $2 AND account_id = $3 AND NOT system_defined AND deleted_at IS NULL
       FOR UPDATE`,
      [id, code, accountId],
    );
    if (!current.rows[0]) throw invalidRequest('CATALOG_ITEM_UNAVAILABLE', 'La opción no pertenece a esta cuenta.');
    if (current.rows[0].active === active) return item(current.rows[0]);
    if (active && current.rows[0].species_code) {
      const species = await client.query(
        `SELECT 1 FROM effective_property_species
         WHERE property_id = $1 AND species_code = $2 AND enabled`,
        [context.propertyId, current.rows[0].species_code],
      );
      if (!species.rowCount) throw conflict('SPECIES_DISABLED', 'La especie de esta opción ya no está habilitada.');
    }
    const updated = await client.query<CatalogItemRow>(
      `UPDATE governed_catalog_item SET active = $2 WHERE id = $1
       RETURNING id, catalog_code, name, species_code, system_defined, active`, [id, active],
    );
    const after = item(updated.rows[0]!);
    await audit(client, auth, context, metadata, 'CATALOG_ITEM_STATE_CHANGED', id,
      item(current.rows[0]), after);
    return after;
  });
}
