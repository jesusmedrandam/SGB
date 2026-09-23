import type { PoolClient } from 'pg';
import { ApiError, conflict, forbidden, invalidRequest } from '../../core/errors.js';
import { pool } from '../../database/pool.js';
import { inTransaction } from '../../database/transaction.js';
import type { AuthState, PropertyContext, RequestMetadata } from '../auth/auth.types.js';
import type { CreateAnimalInput } from './animals.schemas.js';

interface AnimalRow {
  id: string;
  name: string;
  ear_tag_code: string | null;
  sex: 'FEMALE' | 'MALE';
  species_code: string;
  birth_date: string | null;
  entry_date: string;
  initial_weight: string | null;
  initial_weight_unit_code: string | null;
  availability_status_code: string;
  version: string;
}

const animalFields = `id, name, ear_tag_code, sex, species_code,
  birth_date::text AS birth_date, entry_date::text AS entry_date,
  initial_weight::text AS initial_weight, initial_weight_unit_code,
  availability_status_code, version::text AS version`;

function animal(row: AnimalRow) {
  return { id: row.id, name: row.name, earTagCode: row.ear_tag_code, sex: row.sex,
    speciesCode: row.species_code, birthDate: row.birth_date, entryDate: row.entry_date,
    initialWeight: row.initial_weight === null ? null : Number(row.initial_weight),
    initialWeightUnitCode: row.initial_weight_unit_code,
    availabilityStatusCode: row.availability_status_code, version: Number(row.version) };
}

export async function listAnimals(context: PropertyContext, page: number, search: string) {
  const result = await pool.query<AnimalRow>(
    `SELECT ${animalFields} FROM animal
     WHERE property_id = $1 AND record_status = 'CURRENT'
       AND ($2 = '' OR strpos(lower(name), lower($2)) > 0
            OR strpos(lower(coalesce(ear_tag_code::text, '')), lower($2)) > 0)
     ORDER BY lower(name), id LIMIT 41 OFFSET $3`,
    [context.propertyId, search, (page - 1) * 40],
  );
  return { items: result.rows.slice(0, 40).map(animal), page, hasMore: result.rows.length > 40 };
}

export async function getAnimal(context: PropertyContext, id: string) {
  const result = await pool.query<AnimalRow>(
    `SELECT ${animalFields} FROM animal
     WHERE property_id = $1 AND id = $2 AND record_status = 'CURRENT'`,
    [context.propertyId, id],
  );
  if (!result.rows[0]) throw new ApiError(404, 'ANIMAL_NOT_FOUND', 'El animal no está disponible en esta propiedad.');
  return animal(result.rows[0]);
}

async function accessForCreate(client: PoolClient, auth: AuthState, context: PropertyContext) {
  const result = await client.query<{ account_id: string; today: string }>(
    `SELECT p.account_id, to_char((now() AT TIME ZONE p.timezone)::date, 'YYYY-MM-DD') AS today
     FROM property p
     JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
     JOIN property_membership pm ON pm.property_id = p.id AND pm.user_id = $2 AND pm.status = 'ACTIVE'
     JOIN membership_role mr ON mr.membership_id = pm.id AND mr.property_id = p.id
     JOIN property_role pr ON pr.id = mr.role_id AND pr.property_id = p.id AND pr.active
     JOIN role_permission rp ON rp.role_id = pr.id AND rp.permission_code = 'ANIMAL_CREATE'
     JOIN effective_property_species eps ON eps.property_id = p.id AND eps.species_code = 'BOVINE' AND eps.enabled
     WHERE p.id = $1 AND pr.id = $3 AND p.deleted_at IS NULL AND p.status = 'ACTIVE'
     FOR SHARE OF p, pm, pr`,
    [context.propertyId, auth.userId, context.roleId],
  );
  if (!result.rows[0]) throw forbidden('ANIMAL_CREATE_DENIED', 'No puedes registrar animales en esta propiedad con el rol activo.');
  return result.rows[0];
}

export async function createAnimal(auth: AuthState, context: PropertyContext,
  input: CreateAnimalInput, metadata: RequestMetadata) {
  try {
    return await inTransaction(async (client) => {
      const { account_id: accountId, today } = await accessForCreate(client, auth, context);
      const entryDate = input.entryDate ?? today;
      if (entryDate > today || (input.birthDate && (input.birthDate > today || input.birthDate > entryDate))) {
        throw invalidRequest('INVALID_ANIMAL_DATES', 'Nacimiento e ingreso deben ser fechas válidas hasta hoy en la zona de la finca.');
      }
      if (input.initialWeightUnitCode) {
        const unit = await client.query(
          `SELECT 1 FROM allowed_context_unit acu
           JOIN measurement_unit mu ON mu.code = acu.unit_code AND mu.active
           WHERE acu.context_code = 'ANIMAL_WEIGHT' AND acu.unit_code = $1`,
          [input.initialWeightUnitCode],
        );
        if (!unit.rowCount) throw invalidRequest('INVALID_WEIGHT_UNIT', 'La unidad no admite pesajes de animales.');
      }
      const result = await client.query<AnimalRow>(
        `INSERT INTO animal(account_id, property_id, species_code, name, sex, ear_tag_code,
           birth_date, entry_date, initial_weight, initial_weight_unit_code, created_by, updated_by)
         VALUES($1,$2,'BOVINE',$3,$4,$5,$6,$7,$8,$9,$10,$10)
         RETURNING ${animalFields}`,
        [accountId, context.propertyId, input.name, input.sex, input.earTagCode ?? null,
          input.birthDate ?? null, entryDate, input.initialWeight ?? null,
          input.initialWeightUnitCode ?? null, auth.userId],
      );
      const created = animal(result.rows[0]!);
      await client.query(
        `INSERT INTO audit_event(actor_user_id, property_id, active_role_id, action,
           entity_type, entity_id, after_data, ip_address, user_agent)
         VALUES($1,$2,$3,'ANIMAL_CREATED','ANIMAL',$4,$5::jsonb,$6,$7)`,
        [auth.userId, context.propertyId, context.roleId, created.id,
          JSON.stringify(created), metadata.ipAddress, metadata.userAgent],
      );
      return created;
    });
  } catch (error) {
    const databaseError = error as { code?: string; constraint?: string };
    if (databaseError.code === '23505' && databaseError.constraint === 'animal_tag_per_property_unique') {
      throw conflict('ANIMAL_TAG_TAKEN', 'Ya existe un animal con esa marquilla en la propiedad.');
    }
    if (databaseError.code === 'P0001') {
      throw conflict('ANIMAL_LIMIT_REACHED', 'Se alcanzó el límite de animales gestionados de la cuenta.');
    }
    throw error;
  }
}
