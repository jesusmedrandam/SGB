import {superadminPropertyAccess} from '../auth/superadmin-access.js';
import type { PoolClient } from 'pg';
import {v2 as cloudinary} from 'cloudinary';
import {env} from '../../config.js';
import { ApiError, conflict, forbidden, invalidRequest } from '../../core/errors.js';
import { pool } from '../../database/pool.js';
import { inTransaction } from '../../database/transaction.js';
import type { AuthState, PropertyContext, RequestMetadata } from '../auth/auth.types.js';
import type { AnimalCatalogSelection, CreateAnimalInput } from './animals.schemas.js';
import { animalListSchema } from './animals.schemas.js';
import type { z } from 'zod';
import {insertInitialParents} from './parents.service.js';

interface AnimalRow {
  castrated_on:string|null;
  separation_reason?:string|null;counts_for_occupancy?:boolean|null;
  external_stay?:{place:string;contact:string|null}|null;
  id: string;
  name: string;
  description: string | null;
  ear_tag_code: string | null;
  sex: 'FEMALE' | 'MALE';
  species_code: string;
  birth_date: string | null;
  entry_date: string;
  initial_weight: string | null;
  initial_weight_unit_code: string | null;
  availability_status_code: string;
  version: string;
  classification: {code:string;name:string}|null;
  brands: Array<{ id: string; name: string }>;
  group_id?: string | null; group_name?: string | null;
  location_id?: string | null; location_name?: string | null;
  location_kind?: 'PASTURE' | 'CORRAL' | null;
  active_pregnancy_id?:string|null;
  has_reproductive_history?:boolean;
  registered_birth_date?:string|null;
  transferred_out_at?:string|null;last_birth_on?:string|null;last_loss_on?:string|null;
  profile_photo_asset:string|null;
  primary_owner_name?:string|null;
  total_count?:number;
}

const animalFields = `CASE WHEN NOT EXISTS(SELECT 1 FROM animal_group_assignment aga WHERE aga.animal_id=animal.id AND aga.ended_at IS NULL) THEN
 (SELECT m.reason FROM livestock_movement m JOIN livestock_movement_animal ma ON ma.movement_id=m.id WHERE ma.animal_id=animal.id AND m.kind='SEPARACION' AND m.status='COMPLETADO' ORDER BY m.applied_at DESC LIMIT 1) END AS separation_reason, id, name, description, ear_tag_code, sex, species_code,
  birth_date::text AS birth_date, entry_date::text AS entry_date,castrated_on::text AS castrated_on,
  initial_weight::text AS initial_weight, initial_weight_unit_code,
  availability_status_code, version::text AS version,transferred_out_at,
  (SELECT json_build_object('place',g.external_place,'contact',g.external_contact)
    FROM animal_group_assignment aga JOIN livestock_group g ON g.id=aga.group_id
    WHERE aga.animal_id=animal.id AND aga.ended_at IS NULL AND g.kind='EXTERNAL') AS external_stay,
  animal_latest_birth_on(animal.id)::text AS last_birth_on,animal_latest_loss_on(animal.id)::text AS last_loss_on,
  (SELECT id FROM reproduction_pregnancy WHERE cow_id=animal.id AND status='CONFIRMED' AND animal.transferred_out_at IS NULL LIMIT 1) AS active_pregnancy_id,
  EXISTS(SELECT 1 FROM animal_parentage WHERE parent_animal_id=animal.id AND removed_at IS NULL)
    OR EXISTS(SELECT 1 FROM reproduction_heat WHERE cow_id=animal.id OR bull_id=animal.id)
    OR EXISTS(SELECT 1 FROM reproduction_service WHERE cow_id=animal.id OR father_id=animal.id OR donor_id=animal.id)
    OR EXISTS(SELECT 1 FROM reproduction_pregnancy WHERE cow_id=animal.id OR father_id=animal.id)
    OR EXISTS(SELECT 1 FROM animal_received_history WHERE animal_id=animal.id AND (snapshot->'profile'->>'hasReproductiveHistory')::boolean) AS has_reproductive_history,
  COALESCE((SELECT birth.occurred_on::text FROM reproduction_birth_calf calf JOIN reproduction_birth birth ON birth.id=calf.birth_id
    WHERE calf.animal_id=animal.id LIMIT 1),(SELECT snapshot->'profile'->>'registeredBirthDate' FROM animal_received_history WHERE animal_id=animal.id)) AS registered_birth_date,
  (SELECT so.provider_asset_id FROM media_attachment ma
     JOIN storage_object so ON so.id=ma.storage_object_id AND so.status='AVAILABLE'
     WHERE ma.entity_type='ANIMAL' AND ma.entity_id=animal.id AND ma.deleted_at IS NULL
       AND ma.relation_code='PROFILE' AND so.kind='IMAGE'
     ORDER BY ma.created_at DESC LIMIT 1) AS profile_photo_asset,
  (SELECT json_build_object('code',catalog.code,'name',COALESCE(custom.name,catalog.name))
    FROM animal_classification_catalog catalog
    LEFT JOIN account_animal_classification_name custom
      ON custom.account_id=animal.account_id AND custom.code=catalog.code
    WHERE catalog.code=classify_animal(animal.id,
      (now() AT TIME ZONE (SELECT timezone FROM property WHERE id=animal.property_id))::date))
    AS classification,
  COALESCE((SELECT json_agg(json_build_object('id', b.id, 'name', b.name)
       ORDER BY lower(b.name), b.id)
     FROM animal_brand_assignment aba JOIN livestock_brand b ON b.id = aba.brand_id
     WHERE aba.animal_id = animal.id AND aba.ended_at IS NULL), '[]'::json) AS brands`;

function animal(row: AnimalRow) {
  return { id: row.id, name: row.name, description: row.description,
    earTagCode: row.ear_tag_code, sex: row.sex,
    speciesCode: row.species_code, birthDate: row.birth_date, entryDate: row.entry_date,castratedOn:row.castrated_on??null,
    initialWeight: row.initial_weight === null ? null : Number(row.initial_weight),
    initialWeightUnitCode: row.initial_weight_unit_code,
    availabilityStatusCode: row.availability_status_code, version: Number(row.version),
    classification:row.classification, brands: row.brands, activePregnancyId:row.active_pregnancy_id??null,
    separatedFromGroup:Boolean(row.separation_reason),separationReason:row.separation_reason??null,countsForOccupancy:row.counts_for_occupancy??true,
    externalStay:row.external_stay??null,transferredOutAt:row.transferred_out_at??null,lastBirthOn:row.last_birth_on??null,lastLossOn:row.last_loss_on??null,
    hasReproductiveHistory:row.has_reproductive_history??false,registeredBirthDate:row.registered_birth_date??null,
    profilePhotoUrl:animalProfilePhotoUrl(row.profile_photo_asset),
    group:row.group_id ? {id:row.group_id,name:row.group_name!}:null,
    location:row.location_id ? {id:row.location_id,name:row.location_name!,kind:row.location_kind!}:null };
}

interface SelectionRow { catalog_code: 'BREEDS' | 'COLORS'; id: string; name: string }

export async function readAnimal(client: PoolClient, context: PropertyContext, id: string) {
  const result = await client.query<AnimalRow>(
    `SELECT ${animalFields} FROM animal
     WHERE property_id = $1 AND id = $2 AND record_status = 'CURRENT'`,
    [context.propertyId, id],
  );
  if (!result.rows[0]) throw new ApiError(404, 'ANIMAL_NOT_FOUND', 'El animal no está disponible en esta propiedad.');
  const choices = await client.query<SelectionRow>(
    `SELECT aca.catalog_code, ci.id, ci.name
       FROM animal_catalog_assignment aca
       JOIN governed_catalog_item ci ON ci.id = aca.catalog_item_id
      WHERE aca.animal_id = $1 AND aca.property_id = $2 AND aca.ended_at IS NULL
      ORDER BY aca.catalog_code, lower(ci.name), ci.id`,
    [id, context.propertyId],
  );
  const breeds = choices.rows.filter((choice) => choice.catalog_code === 'BREEDS')
    .map((choice) => ({ id: choice.id, name: choice.name }));
  const parents = await client.query<{
    role: 'MOTHER' | 'FATHER'; parent_animal_id: string | null;
    reported_parent_name: string | null; name: string | null;
  }>(
    `SELECT ap.role, ap.parent_animal_id, ap.reported_parent_name, p.name
       FROM animal_parentage ap LEFT JOIN animal p ON p.id = ap.parent_animal_id
      WHERE ap.child_animal_id = $1 AND ap.property_id = $2 AND ap.removed_at IS NULL`,
    [id, context.propertyId],
  );
  const parent = (role: 'MOTHER' | 'FATHER') => {
    const row = parents.rows.find((entry) => entry.role === role);
    return row ? { animalId: row.parent_animal_id, name: row.name ?? row.reported_parent_name! } : null;
  };
  const position = await client.query<{
    counts_for_occupancy:boolean|null;group_id: string | null; group_name: string | null;
    location_id: string | null; location_name: string | null; location_kind: 'PASTURE' | 'CORRAL' | null;
  }>(
    `SELECT counts_for_occupancy,group_id, group_name, location_id, location_name, location_kind
     FROM animal_current_position WHERE animal_id = $1 AND property_id = $2`,
    [id, context.propertyId],
  );
  const place = position.rows[0];
  return { ...animal({...result.rows[0]!,counts_for_occupancy:place?.counts_for_occupancy??null}),
    mother: parent('MOTHER'), father: parent('FATHER'),
    group: place?.group_id ? { id: place.group_id, name: place.group_name! } : null,
    location: place?.location_id ? { id: place.location_id,
      name: place.location_name!, kind: place.location_kind! } : null,
    breed: breeds[0] ?? null, breeds,
    owners: (await client.query<{ id: string; name: string; percent: string; is_primary: boolean }>(
      `SELECT pp.id, pp.display_name AS name, ao.ownership_percent::text AS percent, ao.is_primary
       FROM animal_ownership ao JOIN property_party pp ON pp.id = ao.party_id
       WHERE ao.animal_id = $1 AND ao.valid_until IS NULL ORDER BY ao.is_primary DESC, lower(pp.display_name)`,
      [id])).rows.map((owner) => ({ id: owner.id, name: owner.name,
      percent: Number(owner.percent), isPrimary: owner.is_primary })),
    colors: choices.rows.filter((choice) => choice.catalog_code === 'COLORS')
      .map((choice) => ({ id: choice.id, name: choice.name })) };
}

export async function listAnimals(context: PropertyContext, filters: z.infer<typeof animalListSchema>) {
  const {page,search,classification,sex,status,groupId,locationId,ownerId,breedId,colorId,
    brandId,birthFrom,birthTo}=filters;
  const result = await pool.query<AnimalRow>(
    `SELECT ${animalFields}, pos.group_id, pos.group_name, pos.location_id, pos.location_name,
       pos.location_kind,pos.counts_for_occupancy, count(*) OVER()::int AS total_count,
       (SELECT pp.display_name FROM animal_ownership ao
         JOIN property_party pp ON pp.id=ao.party_id
         WHERE ao.animal_id=animal.id AND ao.valid_until IS NULL
         ORDER BY ao.is_primary DESC, lower(pp.display_name) LIMIT 1) AS primary_owner_name
     FROM latest_property_animal animal
     LEFT JOIN animal_current_position pos ON pos.animal_id=animal.id AND pos.property_id=animal.property_id
     WHERE animal.property_id = $1 AND animal.record_status = 'CURRENT'
       AND ($4::varchar IS NULL OR classify_animal(animal.id,
         (now() AT TIME ZONE (SELECT timezone FROM property WHERE id=animal.property_id))::date)=$4)
       AND ($5::varchar IS NULL OR animal.sex::text=$5)
       AND ($6::varchar IS NULL OR animal.availability_status_code=$6)
       AND ($7::uuid IS NULL OR pos.group_id=$7)
       AND ($8::uuid IS NULL OR pos.location_id=$8 OR EXISTS(SELECT 1 FROM group_location_use use WHERE use.group_id=pos.group_id AND use.ended_at IS NULL AND use.location_id=$8))
       AND ($9::uuid IS NULL OR EXISTS(SELECT 1 FROM animal_ownership ao
         WHERE ao.animal_id=animal.id AND ao.party_id=$9 AND ao.valid_until IS NULL))
       AND ($10::uuid IS NULL OR EXISTS(SELECT 1 FROM animal_catalog_assignment aca
         WHERE aca.animal_id=animal.id AND aca.catalog_code='BREEDS'
           AND aca.catalog_item_id=$10 AND aca.ended_at IS NULL))
       AND ($11::uuid IS NULL OR EXISTS(SELECT 1 FROM animal_catalog_assignment aca
         WHERE aca.animal_id=animal.id AND aca.catalog_code='COLORS'
           AND aca.catalog_item_id=$11 AND aca.ended_at IS NULL))
       AND ($12::uuid IS NULL OR EXISTS(SELECT 1 FROM animal_brand_assignment aba
         WHERE aba.animal_id=animal.id AND aba.brand_id=$12 AND aba.ended_at IS NULL))
       AND ($13::date IS NULL OR animal.birth_date >= $13)
       AND ($14::date IS NULL OR animal.birth_date <= $14)
       AND ($2 = '' OR strpos(lower(animal.name), lower($2)) > 0
            OR strpos(lower(coalesce(animal.ear_tag_code::text, '')), lower($2)) > 0
            OR EXISTS (SELECT 1 FROM animal_brand_assignment aba
                 JOIN livestock_brand b ON b.id = aba.brand_id
                 WHERE aba.animal_id = animal.id AND aba.ended_at IS NULL
                   AND strpos(lower(b.name), lower($2)) > 0))
     ORDER BY lower(animal.name), animal.id LIMIT 41 OFFSET $3`,
    [context.propertyId, search, (page - 1) * 40,classification??null,sex??null,status??null,
      groupId??null,locationId??null,ownerId??null,breedId??null,colorId??null,brandId??null,
      birthFrom??null,birthTo??null],
  );
  return { items: result.rows.slice(0, 40).map(row=>({...animal(row),
    primaryOwnerName:row.primary_owner_name??null})),
    page, hasMore: result.rows.length > 40,total:result.rows[0]?.total_count??0 };
}

export async function getAnimal(context: PropertyContext, id: string) {
  return inTransaction(async client=>{
    const latest=(await client.query(`SELECT latest.id FROM animal original JOIN latest_property_animal latest
      ON latest.property_id=original.property_id AND latest.identity_id=original.identity_id
      WHERE original.id=$1 AND original.property_id=$2 AND original.record_status='CURRENT'`,[id,context.propertyId])).rows[0];
    return readAnimal(client,context,latest?.id??id);
  });
}

async function validateSelections(client: PoolClient, context: PropertyContext, speciesCode: string,
  selection: AnimalCatalogSelection, existing: ReadonlyMap<string, 'BREEDS' | 'COLORS'> = new Map()) {
  const requested = [
    ...(selection.breedIds ?? (selection.breedId ? [selection.breedId] : []))
      .map((id) => ({ id, code: 'BREEDS' })),
    ...selection.colorIds.map((id) => ({ id, code: 'COLORS' })),
  ];
  if (requested.some(({ id, code }) => existing.has(id) && existing.get(id) !== code)) {
    throw invalidRequest('INVALID_ANIMAL_CATALOG_SELECTION', 'La raza y los colores deben conservar su tipo.');
  }
  const ids = requested.filter(({ id }) => !existing.has(id)).map(({ id }) => id);
  if (!ids.length) return;
  const result = await client.query<{ id: string; catalog_code: string }>(
    `SELECT ci.id, ci.catalog_code FROM governed_catalog_item ci
     WHERE ci.id = ANY($1::uuid[]) AND ci.active AND ci.deleted_at IS NULL
       AND (ci.system_defined OR ci.account_id = (SELECT account_id FROM property WHERE id = $2))
       AND (ci.species_code IS NULL OR ci.species_code = $3)
     FOR SHARE OF ci`,
    [ids, context.propertyId, speciesCode],
  );
  const byId = new Map(result.rows.map((row) => [row.id, row.catalog_code]));
  if (byId.size !== ids.length
    || requested.some(({ id, code }) => !existing.has(id) && byId.get(id) !== code)) {
    throw invalidRequest('INVALID_ANIMAL_CATALOG_SELECTION',
      'Selecciona razas y colores activos de esta cuenta y especie del animal.');
  }
}

async function insertSelections(client: PoolClient, auth: AuthState, context: PropertyContext,
  animalId: string, selection: AnimalCatalogSelection, existing: ReadonlySet<string> = new Set()) {
  const choices = [
    ...(selection.breedIds ?? (selection.breedId ? [selection.breedId] : []))
      .map((id) => ({ code: 'BREEDS', id })),
    ...selection.colorIds.map((id) => ({ code: 'COLORS', id })),
  ].filter(({ id }) => !existing.has(id));
  for (const choice of choices) {
    await client.query(
      `INSERT INTO animal_catalog_assignment(
         animal_id, property_id, catalog_code, catalog_item_id, assigned_by
       ) VALUES($1,$2,$3,$4,$5)`,
      [animalId, context.propertyId, choice.code, choice.id, auth.userId],
    );
  }
}

async function validateBrands(client: PoolClient, context: PropertyContext, ids: string[]) {
  if (!ids.length) return;
  const result = await client.query<{ id: string }>(
    `SELECT id FROM livestock_brand WHERE id = ANY($1::uuid[]) AND account_id = (SELECT account_id FROM property WHERE id = $2) AND active
     FOR SHARE`, [ids, context.propertyId],
  );
  if (result.rows.length !== ids.length) {
    throw invalidRequest('INVALID_ANIMAL_BRANDS', 'Elige marquillas activas de esta cuenta.');
  }
}

async function insertBrands(client: PoolClient, auth: AuthState, context: PropertyContext,
  animalId: string, ids: string[]) {
  for (const brandId of ids) {
    await client.query(
      `INSERT INTO animal_brand_assignment(animal_id, property_id, brand_id, assigned_by)
       VALUES($1,$2,$3,$4)`,
      [animalId, context.propertyId, brandId, auth.userId],
    );
  }
}

async function accessForCreate(client: PoolClient, auth: AuthState, context: PropertyContext) {
  const supportResult=await superadminPropertyAccess(client,auth,context);
    const result=supportResult?{rows:[supportResult],rowCount:1}:await client.query<{ account_id: string; today: string }>(
    `SELECT p.account_id, to_char((now() AT TIME ZONE p.timezone)::date, 'YYYY-MM-DD') AS today
     FROM property p
     JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
     JOIN property_membership pm ON pm.property_id = p.id AND pm.user_id = $2 AND membership_access_valid(pm)
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
      return insertAnimalInTransaction(client,auth,context,input,metadata,accountId,today);
    });
  } catch (error) {
    const databaseError = error as { code?: string; constraint?: string };
    if (databaseError.code === '23505' && databaseError.constraint === 'animal_tag_per_property_unique') {
      throw conflict('ANIMAL_TAG_TAKEN', 'Ya existe un animal con ese arete individual en la propiedad.');
    }
    if (databaseError.code === 'P0001') {
      throw conflict('ANIMAL_LIMIT_REACHED', 'Se alcanzó el límite de animales gestionados de la cuenta.');
    }
    throw error;
  }
}

export async function updateAnimalBrands(auth: AuthState, context: PropertyContext,
  id: string, brandIds: string[], expectedVersion: number, metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    const supportGrant=await superadminPropertyAccess(client,auth,context);
    const grant=supportGrant?{rows:[supportGrant],rowCount:1}:await client.query(
      `SELECT 1 FROM property p
       JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
       JOIN property_membership pm ON pm.property_id = p.id AND pm.user_id = $2 AND membership_access_valid(pm)
       JOIN membership_role mr ON mr.membership_id = pm.id AND mr.property_id = p.id
       JOIN property_role pr ON pr.id = mr.role_id AND pr.property_id = p.id AND pr.active
       JOIN role_permission rp ON rp.role_id = pr.id AND rp.permission_code = 'ANIMAL_UPDATE'
       WHERE p.id = $1 AND pr.id = $3 AND p.deleted_at IS NULL AND p.status = 'ACTIVE'
       FOR SHARE OF p, pm, pr`,
      [context.propertyId, auth.userId, context.roleId],
    );
    if (!grant.rowCount) throw forbidden('ANIMAL_UPDATE_DENIED', 'El rol activo no permite modificar este animal.');
    const locked = await client.query<{ version: string }>(
      `SELECT version::text AS version FROM animal
       WHERE id = $1 AND property_id = $2 AND record_status = 'CURRENT' FOR UPDATE`,
      [id, context.propertyId],
    );
    if (!locked.rows[0]) throw new ApiError(404, 'ANIMAL_NOT_FOUND', 'El animal no está disponible en esta propiedad.');
    if (Number(locked.rows[0].version) !== expectedVersion) {
      throw conflict('ANIMAL_VERSION_CONFLICT', 'El animal cambió. Actualiza su ficha antes de guardar.');
    }
    const before = await readAnimal(client, context, id);
    const old = new Set(before.brands.map((brand) => brand.id));
    const desired = new Set(brandIds);
    if (old.size === desired.size && [...desired].every((brand) => old.has(brand))) return before;
    await validateBrands(client, context, brandIds.filter((brand) => !old.has(brand)));
    await client.query(
      `UPDATE animal_brand_assignment SET ended_at = now(), ended_by = $3
       WHERE animal_id = $1 AND property_id = $2 AND ended_at IS NULL
         AND NOT (brand_id = ANY($4::uuid[]))`,
      [id, context.propertyId, auth.userId, brandIds],
    );
    await insertBrands(client, auth, context, id, brandIds.filter((brand) => !old.has(brand)));
    await client.query(`UPDATE animal SET updated_by = $2 WHERE id = $1`, [id, auth.userId]);
    const after = await readAnimal(client, context, id);
    await client.query(
      `INSERT INTO audit_event(actor_user_id, property_id, active_role_id, action, entity_type,
         entity_id, before_data, after_data, ip_address, user_agent)
       VALUES($1,$2,$3,'ANIMAL_BRANDS_UPDATED','ANIMAL',$4,$5::jsonb,$6::jsonb,$7,$8)`,
      [auth.userId, context.propertyId, context.roleId, id, JSON.stringify(before),
        JSON.stringify(after), metadata.ipAddress, metadata.userAgent],
    );
    return after;
  });
}

export async function updateAnimalCatalogs(auth: AuthState, context: PropertyContext,
  id: string, selection: AnimalCatalogSelection, expectedVersion: number, metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    const supportGrant=await superadminPropertyAccess(client,auth,context);
    const grant=supportGrant?{rows:[supportGrant],rowCount:1}:await client.query(
      `SELECT 1 FROM property p
       JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
       JOIN property_membership pm ON pm.property_id = p.id AND pm.user_id = $2 AND membership_access_valid(pm)
       JOIN membership_role mr ON mr.membership_id = pm.id AND mr.property_id = p.id
       JOIN property_role pr ON pr.id = mr.role_id AND pr.property_id = p.id AND pr.active
       JOIN role_permission rp ON rp.role_id = pr.id AND rp.permission_code = 'ANIMAL_UPDATE'
       WHERE p.id = $1 AND pr.id = $3 AND p.deleted_at IS NULL AND p.status = 'ACTIVE'
       FOR SHARE OF p, pm, pr`,
      [context.propertyId, auth.userId, context.roleId],
    );
    if (!grant.rowCount) throw forbidden('ANIMAL_UPDATE_DENIED', 'El rol activo no permite modificar este animal.');
    const locked = await client.query<{ version: string; species_code: string }>(
      `SELECT version::text AS version, species_code FROM animal
       WHERE id = $1 AND property_id = $2 AND record_status = 'CURRENT' FOR UPDATE`,
      [id, context.propertyId],
    );
    if (!locked.rows[0]) throw new ApiError(404, 'ANIMAL_NOT_FOUND', 'El animal no está disponible en esta propiedad.');
    if (Number(locked.rows[0].version) !== expectedVersion) {
      throw conflict('ANIMAL_VERSION_CONFLICT', 'El animal cambió. Actualiza su ficha antes de guardar.');
    }
    const before = await readAnimal(client, context, id);
    const currentChoices = new Map<string, 'BREEDS' | 'COLORS'>([
      ...before.breeds.map((breed) => [breed.id, 'BREEDS' as const] as const),
      ...before.colors.map((color) => [color.id, 'COLORS' as const] as const),
    ]);
    const currentIds = new Set(currentChoices.keys());
    const desiredIds = new Set([
      ...(selection.breedIds ?? (selection.breedId ? [selection.breedId] : [])), ...selection.colorIds,
    ]);
    await validateSelections(client, context, locked.rows[0].species_code, selection, currentChoices);
    if (currentIds.size === desiredIds.size && [...desiredIds].every((choice) => currentIds.has(choice))) {
      return before;
    }
    await client.query(
      `UPDATE animal_catalog_assignment SET ended_at = now(), ended_by = $3
       WHERE animal_id = $1 AND property_id = $2 AND ended_at IS NULL
         AND NOT (catalog_item_id = ANY($4::uuid[]))`,
      [id, context.propertyId, auth.userId, [...desiredIds]],
    );
    await insertSelections(client, auth, context, id, selection, currentIds);
    await client.query(`UPDATE animal SET updated_by = $2 WHERE id = $1`, [id, auth.userId]);
    const after = await readAnimal(client, context, id);
    await client.query(
      `INSERT INTO audit_event(actor_user_id, property_id, active_role_id, action, entity_type,
         entity_id, before_data, after_data, ip_address, user_agent)
       VALUES($1,$2,$3,'ANIMAL_CATALOGS_UPDATED','ANIMAL',$4,$5::jsonb,$6::jsonb,$7,$8)`,
      [auth.userId, context.propertyId, context.roleId, id, JSON.stringify(before),
        JSON.stringify(after), metadata.ipAddress, metadata.userAgent],
    );
    return after;
  });
}

export async function insertAnimalInTransaction(client:PoolClient,auth:AuthState,context:PropertyContext,
  input:CreateAnimalInput,metadata:RequestMetadata,accountId:string,today:string,allowAccountParents=false){
      if(!input.groupId)throw invalidRequest('GROUP_REQUIRED','Selecciona un grupo para el animal.');
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
        `INSERT INTO animal(account_id, property_id, species_code, name, description, sex, ear_tag_code,
           birth_date, entry_date, initial_weight, initial_weight_unit_code, created_by, updated_by)
         VALUES($1,$2,'BOVINE',$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
         RETURNING id`,
        [accountId, context.propertyId, input.name, input.description || null,
          input.sex, input.earTagCode ?? null,
          input.birthDate ?? null, entryDate, input.initialWeight ?? null,
          input.initialWeightUnitCode ?? null, auth.userId],
      );
      if(input.groupId){
        const destination=await client.query<{location_id:string|null}>(`
          SELECT gla.location_id FROM livestock_group g
          LEFT JOIN group_location_assignment gla ON gla.group_id=g.id AND gla.ended_at IS NULL
          LEFT JOIN physical_location pl ON pl.id=gla.location_id AND pl.active AND pl.property_id=g.property_id
          WHERE g.id=$1 AND g.property_id=$2 AND g.active AND (g.kind='EXTERNAL' OR pl.id IS NOT NULL) FOR SHARE OF g`,
          [input.groupId,context.propertyId]);
        if(!destination.rows[0])throw invalidRequest('GROUP_UNAVAILABLE','Selecciona un grupo activo de esta propiedad con potrero o corral.');
        await client.query(`INSERT INTO animal_group_assignment(property_id,animal_id,group_id,
          started_at,start_reason,created_by) VALUES($1,$2,$3,now(),'Registro del animal',$4)`,
          [context.propertyId,result.rows[0]!.id,input.groupId,auth.userId]);
        if(destination.rows[0].location_id){
          await client.query(`INSERT INTO animal_location_assignment(
            property_id,animal_id,location_id,started_at,start_reason,created_by)
            VALUES($1,$2,$3,now(),'Ubicación del grupo',$4)`,
            [context.propertyId,result.rows[0]!.id,destination.rows[0].location_id,auth.userId]);
        }
      }
      await insertInitialParents(client,context,result.rows[0]!.id,input.birthDate??null,
        input.mother??null,input.father??null,auth.userId,allowAccountParents);
      const selection = { breedId: input.breedId ?? null, breedIds: input.breedIds, colorIds: input.colorIds ?? [] };
      await validateSelections(client, context, 'BOVINE', selection);
      await insertSelections(client, auth, context, result.rows[0]!.id, selection);
      await validateBrands(client, context, input.brandIds ?? []);
      await insertBrands(client, auth, context, result.rows[0]!.id, input.brandIds ?? []);
      if (input.owners?.length) {
        const validOwners = await client.query<{ id: string }>(
          `SELECT id FROM property_party WHERE id = ANY($1::uuid[]) AND account_id = $2
           AND active AND deleted_at IS NULL FOR SHARE`,
          [input.owners.map((owner) => owner.partyId), accountId]);
        if (validOwners.rows.length !== input.owners.length)
          throw invalidRequest('OWNER_UNAVAILABLE', 'Selecciona propietarios activos de esta cuenta.');
        for (const owner of input.owners) await client.query(
          `INSERT INTO animal_ownership(property_id, account_id, animal_id, party_id,
            ownership_percent, is_primary, created_by, valid_from) VALUES($1,$2,$3,$4,$5,$6,$7,$8::date)`,
          [context.propertyId, accountId, result.rows[0]!.id, owner.partyId,
            owner.percent, owner.isPrimary, auth.userId,today]);
      }
      const created = await readAnimal(client, context, result.rows[0]!.id);
      await client.query(
        `INSERT INTO audit_event(actor_user_id, property_id, active_role_id, action,
           entity_type, entity_id, after_data, ip_address, user_agent)
         VALUES($1,$2,$3,'ANIMAL_CREATED','ANIMAL',$4,$5::jsonb,$6,$7)`,
        [auth.userId, context.propertyId, context.roleId, created.id,
          JSON.stringify(created), metadata.ipAddress, metadata.userAgent],
      );
      return created;
}

export const animalProfilePhotoUrl=(asset:string|null)=>asset&&env.CLOUDINARY_CLOUD_NAME
  ?cloudinary.url(asset,{secure:true,cloud_name:env.CLOUDINARY_CLOUD_NAME,width:120,height:120,crop:'fill',quality:'auto',fetch_format:'auto'}):null;
