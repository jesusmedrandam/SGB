import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError, conflict, forbidden, invalidRequest } from '../../core/errors.js';
import { pool } from '../../database/pool.js';
import { inTransaction } from '../../database/transaction.js';
import type { AuthState, PropertyContext, RequestMetadata } from '../auth/auth.types.js';
import { readAnimal } from '../animals/animals.service.js';

type Kind = 'PASTURE' | 'CORRAL';
interface GroupRow {
  id: string; name: string; description: string | null; active: boolean; version: string;
  location_id: string | null; location_name: string | null; location_kind: Kind | null;
  animal_count: string;
}
interface LocationRow {
  id: string; kind: Kind; name: string; description: string | null; active: boolean;
  version: string; area_value: string | null; area_unit_code: string | null;
  pasture_use: string | null; capacity_estimate: number | null; water_available: boolean | null;
  last_rest_date: string | null; floor_material: string | null; covered: boolean | null;
  grasses: Array<{ name: string; percent: number | null; area: number | null;
    areaUnitCode: string | null; sowingDate: string | null; notes: string | null }>;
  group_id: string | null; group_name: string | null;
}

const groupFields = `lg.id, lg.name, lg.description, lg.active, lg.version::text,
  pl.id AS location_id, pl.name AS location_name, pl.kind AS location_kind,
  (SELECT count(*)::text FROM animal_group_assignment aga JOIN animal a ON a.id = aga.animal_id
    WHERE aga.group_id = lg.id AND aga.ended_at IS NULL AND a.record_status = 'CURRENT'
      AND a.availability_status_code IN ('ACTIVE','INACTIVE')) AS animal_count`;
const groupJoins = `FROM livestock_group lg
  LEFT JOIN group_location_assignment gla ON gla.group_id = lg.id AND gla.ended_at IS NULL
  LEFT JOIN physical_location pl ON pl.id = gla.location_id`;

const group = (row: GroupRow) => ({
  id: row.id, name: row.name, description: row.description, active: row.active,
  version: Number(row.version), animalCount: Number(row.animal_count),
  location: row.location_id ? { id: row.location_id, name: row.location_name!, kind: row.location_kind! } : null,
});
const location = (row: LocationRow) => ({
  id: row.id, name: row.name, kind: row.kind, description: row.description, active: row.active,
  version: Number(row.version), area: row.area_value === null ? null : Number(row.area_value),
  areaUnitCode: row.area_unit_code, pastureUse: row.pasture_use,
  capacityEstimate: row.capacity_estimate, waterAvailable: row.water_available,
  lastRestDate: row.last_rest_date, floorMaterial: row.floor_material, covered: row.covered,
  grasses: row.grasses,
  group: row.group_id ? { id: row.group_id, name: row.group_name! } : null,
});

async function getGroup(client: PoolClient, propertyId: string, id: string) {
  const result = await client.query<GroupRow>(
    `SELECT ${groupFields} ${groupJoins} WHERE lg.property_id = $1 AND lg.id = $2`,
    [propertyId, id],
  );
  if (!result.rows[0]) throw new ApiError(404, 'GROUP_NOT_FOUND', 'El grupo no está disponible en esta propiedad.');
  return group(result.rows[0]);
}

export async function listGroups(context: PropertyContext) {
  const result = await pool.query<GroupRow>(
    `SELECT ${groupFields} ${groupJoins} WHERE lg.property_id = $1
     ORDER BY lg.active DESC, lower(lg.name), lg.id`, [context.propertyId],
  );
  return result.rows.map(group);
}

const locationFields = `pl.id, pl.kind, pl.name, pl.description, pl.active, pl.version::text,
  pl.area_value::text, pl.area_unit_code, pl.pasture_use, pl.capacity_estimate,
  pl.water_available, pl.last_rest_date::text, pl.floor_material, pl.covered,
  lg.id AS group_id, lg.name AS group_name,
  COALESCE((SELECT json_agg(json_build_object('name', pg.name, 'percent', pg.estimated_percent,
    'area', pg.area_value, 'areaUnitCode', pg.area_unit_code, 'sowingDate', pg.sowing_date,
    'notes', pg.notes) ORDER BY pg.name) FROM pasture_grass pg WHERE pg.location_id = pl.id), '[]'::json) AS grasses`;
const locationJoins = `FROM physical_location pl
  LEFT JOIN group_location_assignment gla ON gla.location_id = pl.id AND gla.ended_at IS NULL
  LEFT JOIN livestock_group lg ON lg.id = gla.group_id`;

export async function listLocations(context: PropertyContext) {
  const result = await pool.query<LocationRow>(
    `SELECT ${locationFields} ${locationJoins}
     WHERE pl.property_id = $1 ORDER BY pl.active DESC, pl.kind, lower(pl.name), pl.id`,
    [context.propertyId],
  );
  return result.rows.map(location);
}

async function access(client: PoolClient, auth: AuthState, context: PropertyContext,
  permission: string) {
  const result = await client.query<{ account_id: string }>(
    `SELECT p.account_id FROM property p
     JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
     JOIN property_membership pm ON pm.property_id = p.id AND pm.user_id = $2 AND pm.status = 'ACTIVE'
     JOIN membership_role mr ON mr.membership_id = pm.id AND mr.property_id = p.id
     JOIN property_role pr ON pr.id = mr.role_id AND pr.property_id = p.id AND pr.active
     JOIN role_permission rp ON rp.role_id = pr.id AND rp.permission_code = $4
     WHERE p.id = $1 AND pr.id = $3 AND p.status = 'ACTIVE' AND p.deleted_at IS NULL
     FOR SHARE OF p, aa, pm, pr`,
    [context.propertyId, auth.userId, context.roleId, permission],
  );
  if (!result.rows[0]) throw forbidden('GROUP_ACCESS_DENIED', 'El rol activo no permite esta operación.');
  return result.rows[0].account_id;
}

async function requireModules(client: PoolClient, context: PropertyContext, codes: string[]) {
  const enabled = await client.query<{ module_code: string }>(
    `SELECT am.module_code FROM property p
     JOIN account_module am ON am.account_id = p.account_id AND am.enabled
     JOIN property_module pm ON pm.property_id = p.id AND pm.module_code = am.module_code AND pm.enabled
     WHERE p.id = $1 AND am.module_code = ANY($2::varchar[])
     FOR SHARE OF am, pm`,
    [context.propertyId, codes],
  );
  if (enabled.rows.length !== codes.length) {
    throw forbidden('LOCATION_MODULES_DISABLED',
      'Habilita los módulos necesarios en la cuenta y la propiedad para realizar esta operación.');
  }
}

async function audit(client: PoolClient, auth: AuthState, context: PropertyContext,
  metadata: RequestMetadata, action: string, type: string, id: string,
  before: unknown, after: unknown) {
  await client.query(
    `INSERT INTO audit_event(actor_user_id, property_id, active_role_id, action, entity_type,
       entity_id, before_data, after_data, ip_address, user_agent)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
    [auth.userId, context.propertyId, context.roleId, action, type, id,
      before === null ? null : JSON.stringify(before), JSON.stringify(after),
      metadata.ipAddress, metadata.userAgent],
  );
}

function translate(error: unknown): never {
  const databaseError = error as { code?: string; constraint?: string };
  if (databaseError.code === '23505' && databaseError.constraint === 'livestock_group_name_unique') {
    throw conflict('GROUP_NAME_TAKEN', 'Ya existe un grupo activo con ese nombre en esta propiedad.');
  }
  if (databaseError.code === '23505' && databaseError.constraint === 'physical_location_name_kind_unique') {
    throw conflict('LOCATION_NAME_TAKEN', 'Ya existe una ubicación activa con ese nombre y tipo en esta propiedad.');
  }
  if (databaseError.code === '23505' || databaseError.code === '23514') {
    throw conflict('GROUP_LOCATION_CONFLICT', 'El grupo o la ubicación cambiaron o ya están ocupados. Actualiza la pantalla.');
  }
  throw error;
}

async function lockLocation(client: PoolClient, propertyId: string, locationId: string) {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM physical_location WHERE id = $1 AND property_id = $2 AND active FOR UPDATE`,
    [locationId, propertyId],
  );
  if (!result.rows[0]) throw invalidRequest('LOCATION_UNAVAILABLE', 'El potrero o corral no está activo en esta propiedad.');
  return result.rows[0];
}

type LocationInput = {
  name: string; description?: string | null | undefined; kind: Kind;
  area?: number | null | undefined; areaUnitCode?: string | null | undefined;
  pastureUse?: string | null | undefined; capacityEstimate?: number | null | undefined;
  waterAvailable?: boolean | null | undefined; lastRestDate?: string | null | undefined;
  floorMaterial?: string | null | undefined; covered?: boolean | null | undefined;
  grasses?: Array<{ name: string; percent?: number | null | undefined;
    area?: number | null | undefined; areaUnitCode?: string | null | undefined;
    sowingDate?: string | null | undefined; notes?: string | null | undefined }> | undefined;
};
async function saveGrasses(client: PoolClient, locationId: string, input: LocationInput) {
  await client.query('DELETE FROM pasture_grass WHERE location_id = $1', [locationId]);
  for (const grass of input.grasses ?? []) await client.query(
    `INSERT INTO pasture_grass(location_id, name, estimated_percent, area_value, area_unit_code,
      sowing_date, notes) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [locationId, grass.name, grass.percent ?? null, grass.area ?? null,
      grass.areaUnitCode ?? null, grass.sowingDate ?? null, grass.notes ?? null]);
}
async function locationById(client: PoolClient, propertyId: string, id: string) {
  const result = await client.query<LocationRow>(
    `SELECT ${locationFields} ${locationJoins} WHERE pl.property_id = $1 AND pl.id = $2`,
    [propertyId, id]);
  if (!result.rows[0]) throw invalidRequest('LOCATION_UNAVAILABLE', 'La ubicación no pertenece a esta propiedad.');
  return location(result.rows[0]);
}
export async function createLocation(auth: AuthState, context: PropertyContext,
  input: LocationInput, metadata: RequestMetadata) {
  try {
    return await inTransaction(async (client) => {
      const accountId = await access(client, auth, context, 'LOCATION_MANAGE');
      await requireModules(client, context, [input.kind === 'PASTURE' ? 'PASTURES' : 'CORRALS']);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO physical_location(account_id, property_id, kind, name, description,
          area_value, area_unit_code, pasture_use, capacity_estimate, water_available,
          last_rest_date, floor_material, covered, created_by, updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING id`,
        [accountId, context.propertyId, input.kind, input.name, input.description || null,
          input.area ?? null, input.areaUnitCode ?? null, input.pastureUse ?? null,
          input.capacityEstimate ?? null, input.waterAvailable ?? null,
          input.lastRestDate ?? null, input.floorMaterial ?? null, input.covered ?? null, auth.userId]);
      await saveGrasses(client, inserted.rows[0]!.id, input);
      const response = await locationById(client, context.propertyId, inserted.rows[0]!.id);
      await audit(client, auth, context, metadata, 'LOCATION_CREATED', 'PHYSICAL_LOCATION',
        response.id, null, response);
      return response;
    });
  } catch (error) { return translate(error); }
}
export async function updateLocation(auth: AuthState, context: PropertyContext, id: string,
  input: LocationInput & { expectedVersion: number }, metadata: RequestMetadata) {
  try {
    return await inTransaction(async (client) => {
      await access(client, auth, context, 'LOCATION_MANAGE');
      await requireModules(client, context, [input.kind === 'PASTURE' ? 'PASTURES' : 'CORRALS']);
      const locked = await client.query<{ version: string; kind: Kind }>(
        `SELECT version::text, kind FROM physical_location WHERE id = $1 AND property_id = $2 FOR UPDATE`,
        [id, context.propertyId]);
      if (!locked.rows[0]) throw invalidRequest('LOCATION_UNAVAILABLE', 'La ubicación no pertenece a esta propiedad.');
      if (locked.rows[0].kind !== input.kind) throw invalidRequest('LOCATION_KIND_FIXED', 'El tipo de ubicación no puede cambiarse.');
      if (Number(locked.rows[0].version) !== input.expectedVersion)
        throw conflict('LOCATION_VERSION_CONFLICT', 'La ubicación cambió. Actualiza la pantalla.');
      const before = await locationById(client, context.propertyId, id);
      await client.query(`UPDATE physical_location SET name = $2, description = $3,
        area_value = $4, area_unit_code = $5, pasture_use = $6, capacity_estimate = $7,
        water_available = $8, last_rest_date = $9, floor_material = $10, covered = $11,
        updated_by = $12 WHERE id = $1`,
        [id, input.name, input.description ?? null, input.area ?? null, input.areaUnitCode ?? null,
          input.pastureUse ?? null, input.capacityEstimate ?? null, input.waterAvailable ?? null,
          input.lastRestDate ?? null, input.floorMaterial ?? null, input.covered ?? null, auth.userId]);
      await saveGrasses(client, id, input);
      const after = await locationById(client, context.propertyId, id);
      await audit(client, auth, context, metadata, 'LOCATION_UPDATED', 'PHYSICAL_LOCATION', id, before, after);
      return after;
    });
  } catch (error) { return translate(error); }
}

export async function createGroup(auth: AuthState, context: PropertyContext,
  input: { name: string; description?: string | null | undefined;
    locationId?: string | null | undefined },
  metadata: RequestMetadata) {
  try {
    return await inTransaction(async (client) => {
      const accountId = await access(client, auth, context, 'GROUP_MANAGE');
      if (input.locationId) {
        await access(client, auth, context, 'LOCATION_MANAGE');
        await requireModules(client, context, ['PASTURES', 'CORRALS', 'MOVEMENTS']);
        await lockLocation(client, context.propertyId, input.locationId);
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO livestock_group(account_id, property_id, name, description,
          created_by, updated_by) VALUES($1,$2,$3,$4,$5,$5) RETURNING id`,
        [accountId, context.propertyId, input.name, input.description || null, auth.userId],
      );
      const id = inserted.rows[0]!.id;
      if (input.locationId) await client.query(
        `INSERT INTO group_location_assignment(property_id, group_id, location_id,
           started_at, start_reason, created_by)
         VALUES($1,$2,$3,now(),'Ubicación inicial del grupo',$4)`,
        [context.propertyId, id, input.locationId, auth.userId],
      );
      const created = await getGroup(client, context.propertyId, id);
      await audit(client, auth, context, metadata, 'GROUP_CREATED', 'LIVESTOCK_GROUP', id, null, created);
      return created;
    });
  } catch (error) { return translate(error); }
}

export async function updateGroup(auth: AuthState, context: PropertyContext, id: string,
  input: { name: string; description?: string | null | undefined; expectedVersion: number },
  metadata: RequestMetadata) {
  try {
    return await inTransaction(async (client) => {
      await access(client, auth, context, 'GROUP_MANAGE');
      const current = await client.query<{ version: string }>(
        `SELECT version::text AS version FROM livestock_group
         WHERE id = $1 AND property_id = $2 AND active FOR UPDATE`,
        [id, context.propertyId],
      );
      if (!current.rows[0]) throw new ApiError(404, 'GROUP_NOT_FOUND', 'El grupo no está activo en esta propiedad.');
      if (Number(current.rows[0].version) !== input.expectedVersion) {
        throw conflict('GROUP_VERSION_CONFLICT', 'El grupo cambió. Actualiza la lista antes de guardar.');
      }
      const before = await getGroup(client, context.propertyId, id);
      const description = input.description === undefined ? before.description : input.description || null;
      if (before.name === input.name && before.description === description) return before;
      await client.query(`UPDATE livestock_group SET name = $2, description = $3, updated_by = $4 WHERE id = $1`,
        [id, input.name, description, auth.userId]);
      const after = await getGroup(client, context.propertyId, id);
      await audit(client, auth, context, metadata, 'GROUP_UPDATED', 'LIVESTOCK_GROUP', id, before, after);
      return after;
    });
  } catch (error) { return translate(error); }
}

export async function setGroupState(auth: AuthState, context: PropertyContext, id: string,
  input: { active: boolean; expectedVersion: number }, metadata: RequestMetadata) {
  try {
    return await inTransaction(async (client) => {
      await access(client, auth, context, 'GROUP_MANAGE');
      const locked = await client.query<{ version: string }>(
        `SELECT version::text AS version FROM livestock_group WHERE id = $1 AND property_id = $2 FOR UPDATE`,
        [id, context.propertyId],
      );
      if (!locked.rows[0]) throw new ApiError(404, 'GROUP_NOT_FOUND', 'El grupo no existe en esta propiedad.');
      if (Number(locked.rows[0].version) !== input.expectedVersion) {
        throw conflict('GROUP_VERSION_CONFLICT', 'El grupo cambió. Actualiza la lista antes de guardar.');
      }
      const before = await getGroup(client, context.propertyId, id);
      if (before.active === input.active) return before;
      if (!input.active) {
        const assigned = await client.query(
          `SELECT 1 FROM animal_group_assignment WHERE group_id = $1 AND ended_at IS NULL LIMIT 1`, [id],
        );
        if (assigned.rowCount) {
          throw conflict('GROUP_HAS_ANIMALS', 'Mueve los animales a otro grupo antes de archivarlo.');
        }
        await client.query(
          `UPDATE group_location_assignment SET ended_at = now(), end_reason = 'Grupo archivado'
           WHERE group_id = $1 AND ended_at IS NULL`, [id],
        );
      }
      await client.query(
        `UPDATE livestock_group SET active = $2, archived_at = CASE WHEN $2 THEN NULL ELSE now() END,
           archived_by = CASE WHEN $2 THEN NULL::uuid ELSE $3::uuid END,
           updated_by = $3 WHERE id = $1`,
        [id, input.active, auth.userId],
      );
      const after = await getGroup(client, context.propertyId, id);
      await audit(client, auth, context, metadata, 'GROUP_STATE_CHANGED', 'LIVESTOCK_GROUP', id, before, after);
      return after;
    });
  } catch (error) { return translate(error); }
}

export async function setGroupLocation(auth: AuthState, context: PropertyContext, id: string,
  input: { locationId: string | null; expectedVersion: number }, metadata: RequestMetadata) {
  try {
    return await inTransaction(async (client) => {
      await access(client, auth, context, 'GROUP_MANAGE');
      await access(client, auth, context, 'LOCATION_MANAGE');
      await access(client, auth, context, 'ANIMAL_UPDATE');
      const locked = await client.query<{ version: string }>(
        `SELECT version::text AS version FROM livestock_group
         WHERE id = $1 AND property_id = $2 AND active FOR UPDATE`,
        [id, context.propertyId],
      );
      if (!locked.rows[0]) throw new ApiError(404, 'GROUP_NOT_FOUND', 'El grupo no está activo en esta propiedad.');
      if (Number(locked.rows[0].version) !== input.expectedVersion) {
        throw conflict('GROUP_VERSION_CONFLICT', 'El grupo cambió. Actualiza la lista antes de guardar.');
      }
      const before = await getGroup(client, context.propertyId, id);
      if (before.location?.id === input.locationId || (!before.location && !input.locationId)) return before;
      if (input.locationId) {
        await requireModules(client, context, ['PASTURES', 'CORRALS', 'MOVEMENTS']);
        await lockLocation(client, context.propertyId, input.locationId);
      }
      const members = await client.query<{ id: string }>(
        `SELECT a.id FROM animal_group_assignment aga JOIN animal a ON a.id = aga.animal_id
         WHERE aga.group_id = $1 AND aga.ended_at IS NULL AND a.record_status = 'CURRENT'
         ORDER BY a.id FOR UPDATE OF a`, [id],
      );
      const memberIds = members.rows.map((row) => row.id);
      const positions = await client.query<{ animal_id: string; location_id: string }>(
        `SELECT ala.animal_id, ala.location_id FROM animal_location_assignment ala
         WHERE ala.animal_id = ANY($1::uuid[]) AND ala.ended_at IS NULL FOR UPDATE`, [memberIds],
      );
      if (positions.rows.length !== (before.location ? memberIds.length : 0)
        || positions.rows.some((row) => row.location_id !== before.location?.id)) {
        throw conflict('ANIMAL_LOCATION_INCONSISTENT', 'La ubicación de un animal no coincide con la del grupo.');
      }
      const instant = new Date();
      const batchId = randomUUID();
      if (before.location) {
        await client.query(
          `UPDATE animal_location_assignment SET ended_at = $2, end_reason = 'Cambio de ubicación del grupo'
           WHERE animal_id = ANY($1::uuid[]) AND ended_at IS NULL`, [memberIds, instant],
        );
        await client.query(
          `UPDATE group_location_assignment SET ended_at = $2, end_reason = 'Cambio de ubicación del grupo'
           WHERE group_id = $1 AND ended_at IS NULL`, [id, instant],
        );
      }
      if (input.locationId) {
        await client.query(
          `INSERT INTO group_location_assignment(property_id, group_id, location_id, started_at,
             start_reason, movement_batch_id, created_by)
           VALUES($1,$2,$3,$4,'Cambio de ubicación del grupo',$5,$6)`,
          [context.propertyId, id, input.locationId, instant, batchId, auth.userId],
        );
        for (const animalId of memberIds) await client.query(
          `INSERT INTO animal_location_assignment(property_id, animal_id, location_id, started_at,
             start_reason, movement_batch_id, created_by)
           VALUES($1,$2,$3,$4,'Cambio de ubicación del grupo',$5,$6)`,
          [context.propertyId, animalId, input.locationId, instant, batchId, auth.userId],
        );
      }
      if (memberIds.length) await client.query(
        `UPDATE animal SET updated_by = $2 WHERE id = ANY($1::uuid[])`, [memberIds, auth.userId],
      );
      await client.query(`UPDATE livestock_group SET updated_by = $2 WHERE id = $1`, [id, auth.userId]);
      const after = await getGroup(client, context.propertyId, id);
      await audit(client, auth, context, metadata, 'GROUP_LOCATION_CHANGED', 'LIVESTOCK_GROUP', id, before, after);
      return after;
    });
  } catch (error) { return translate(error); }
}

export async function assignAnimalToGroup(auth: AuthState, context: PropertyContext,
  groupId: string, input: { animalId: string; expectedAnimalVersion: number },
  metadata: RequestMetadata) {
  try {
    return await inTransaction(async (client) => {
      await access(client, auth, context, 'ANIMAL_UPDATE');
      const lockedGroup = await client.query(
        `SELECT 1 FROM livestock_group WHERE id = $1 AND property_id = $2 AND active FOR UPDATE`,
        [groupId, context.propertyId],
      );
      if (!lockedGroup.rowCount) throw new ApiError(404, 'GROUP_NOT_FOUND', 'El grupo no está activo en esta propiedad.');
      const result = await client.query<{ version: string }>(
        `SELECT version::text AS version FROM animal WHERE id = $1 AND property_id = $2
         AND record_status = 'CURRENT' AND availability_status_code IN ('ACTIVE','INACTIVE') FOR UPDATE`,
        [input.animalId, context.propertyId],
      );
      if (!result.rows[0]) throw new ApiError(404, 'ANIMAL_NOT_FOUND', 'El animal no está disponible en esta propiedad.');
      if (Number(result.rows[0].version) !== input.expectedAnimalVersion) {
        throw conflict('ANIMAL_VERSION_CONFLICT', 'El animal cambió. Actualiza su ficha antes de guardar.');
      }
      const before = await readAnimal(client, context, input.animalId);
      const current = await client.query<{ group_id: string }>(
        `SELECT group_id FROM animal_group_assignment
         WHERE animal_id = $1 AND ended_at IS NULL FOR UPDATE`, [input.animalId],
      );
      if (current.rows[0]?.group_id === groupId) return before;
      const destination = await getGroup(client, context.propertyId, groupId);
      if (current.rowCount || destination.location) await requireModules(client, context, ['MOVEMENTS']);
      if (destination.location) await requireModules(client, context, ['PASTURES', 'CORRALS']);
      const positions = await client.query<{ location_id: string }>(
        `SELECT location_id FROM animal_location_assignment
         WHERE animal_id = $1 AND ended_at IS NULL FOR UPDATE`, [input.animalId],
      );
      if (positions.rows[0] && !current.rowCount) {
        throw conflict('ANIMAL_LOCATION_INCONSISTENT', 'El animal tiene una ubicación sin grupo vigente.');
      }
      if (current.rows[0]) {
        const origin = await getGroup(client, context.propertyId, current.rows[0].group_id);
        if (positions.rows[0]?.location_id !== (origin.location?.id ?? undefined)) {
          throw conflict('ANIMAL_LOCATION_INCONSISTENT', 'La ubicación del animal no coincide con la de su grupo.');
        }
      }
      const instant = new Date();
      const batchId = randomUUID();
      if (positions.rowCount) await client.query(
        `UPDATE animal_location_assignment SET ended_at = $2, end_reason = 'Cambio de grupo'
         WHERE animal_id = $1 AND ended_at IS NULL`, [input.animalId, instant],
      );
      if (current.rowCount) await client.query(
        `UPDATE animal_group_assignment SET ended_at = $2, end_reason = 'Cambio de grupo'
         WHERE animal_id = $1 AND ended_at IS NULL`, [input.animalId, instant],
      );
      await client.query(
        `INSERT INTO animal_group_assignment(property_id, animal_id, group_id, started_at,
           start_reason, movement_batch_id, created_by)
         VALUES($1,$2,$3,$4,'Asignación de grupo',$5,$6)`,
        [context.propertyId, input.animalId, groupId, instant, batchId, auth.userId],
      );
      if (destination.location) await client.query(
        `INSERT INTO animal_location_assignment(property_id, animal_id, location_id, started_at,
           start_reason, movement_batch_id, created_by)
         VALUES($1,$2,$3,$4,'Ubicación heredada del grupo',$5,$6)`,
        [context.propertyId, input.animalId, destination.location.id, instant, batchId, auth.userId],
      );
      await client.query(`UPDATE animal SET updated_by = $2 WHERE id = $1`, [input.animalId, auth.userId]);
      const after = await readAnimal(client, context, input.animalId);
      await audit(client, auth, context, metadata, 'ANIMAL_GROUP_CHANGED', 'ANIMAL',
        input.animalId, before, after);
      return after;
    });
  } catch (error) { return translate(error); }
}
