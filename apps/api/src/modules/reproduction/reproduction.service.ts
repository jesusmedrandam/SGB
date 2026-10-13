import {cycleTrueHeats,requireRulesAdministrator} from './reproduction.rules.js';
import {insertAnimalInTransaction} from '../animals/animals.service.js';
import {superadminPropertyAccess} from '../auth/superadmin-access.js';
import type { PoolClient } from 'pg';
import { ApiError, conflict, forbidden, invalidRequest } from '../../core/errors.js';
import { pool } from '../../database/pool.js';
import { inTransaction } from '../../database/transaction.js';
import type { AuthState, PropertyContext, RequestMetadata } from '../auth/auth.types.js';
import type { BirthInput, HeatInput, LossInput, PregnancyInput, ReproductionSettingInput,
  ServiceInput } from './reproduction.schemas.js';

// Ported from lafortuna/src/services/reproduction-policy.ts. The old queries
// are mapped to the new account/property scoped tables.
const GESTATION_DAYS = 283;
function addDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

interface CowRow {
  id: string; account_id: string; property_id: string; sex: 'FEMALE' | 'MALE';
  birth_date: string | null; name: string;
}

const settingFields = `
  COALESCE(s.days_after_birth_heat, 30) AS "daysAfterBirthHeat",
  COALESCE(s.days_after_birth_pregnancy, 45) AS "daysAfterBirthPregnancy",
  COALESCE(s.days_after_loss_heat, 21) AS "daysAfterLossHeat",
  COALESCE(s.days_after_loss_pregnancy, 30) AS "daysAfterLossPregnancy",
  COALESCE(s.minimum_cow_months, 12) AS "minimumCowMonths",
  COALESCE(s.minimum_bull_months, 12) AS "minimumBullMonths",
  COALESCE(s.allow_second_heat, true) AS "allowSecondHeat",
  true AS "allowFalseHeatInPregnancy",
  COALESCE(s.use_last_valid_heat, true) AS "useLastValidHeat",
  COALESCE(s.max_milking_days, 305) AS "maxMilkingDays"`;

async function settings(client: PoolClient, propertyId: string): Promise<ReproductionSettingInput&{accountId:string}> {
  const result = await client.query<ReproductionSettingInput&{accountId:string}>(
    `SELECT p.account_id AS "accountId",${settingFields} FROM property p LEFT JOIN account_reproduction_setting s ON s.account_id = p.account_id
     WHERE p.id = $1`, [propertyId]);
  return result.rows[0]!;
}

export async function getReproductionSettings(context: PropertyContext,auth?:AuthState) {
  const client = await pool.connect();
  try {
    let canManageRules=false;if(auth){try{await requireRulesAdministrator(client,auth,context);canManageRules=true;}catch(error){if((error as {code?:string}).code!=='RULES_ADMINISTRATOR_REQUIRED')throw error;}}
    const sections=await client.query<{module_code:string}>(`SELECT module_code FROM effective_property_module
      WHERE property_id=$1 AND enabled AND module_code LIKE 'REPRODUCTION_%' ORDER BY module_code`,[context.propertyId]);
    return {...await settings(client, context.propertyId),canManageRules,enabledSections:sections.rows.map(row=>row.module_code)};
  }
  finally { client.release(); }
}

export async function updateReproductionSettings(auth: AuthState, context: PropertyContext,
  input: ReproductionSettingInput, metadata: RequestMetadata) {
  input={...input,allowFalseHeatInPregnancy:true};
  return inTransaction(async (client) => {
    const {account_id:accountId}=await access(client, auth, context, 'REPRODUCTION_MANAGE');
    await requireRulesAdministrator(client,auth,context);
    await client.query('SELECT id FROM administrative_account WHERE id=$1 FOR UPDATE',[accountId]);
    const before = await settings(client, context.propertyId);
    await client.query(`INSERT INTO account_reproduction_setting(account_id, days_after_birth_heat,
      days_after_birth_pregnancy, days_after_loss_heat, days_after_loss_pregnancy,
      minimum_cow_months, minimum_bull_months, allow_second_heat,
      allow_false_heat_in_pregnancy, use_last_valid_heat, max_milking_days, updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT(account_id) DO UPDATE SET
        days_after_birth_heat = EXCLUDED.days_after_birth_heat,
        days_after_birth_pregnancy = EXCLUDED.days_after_birth_pregnancy,
        days_after_loss_heat = EXCLUDED.days_after_loss_heat,
        days_after_loss_pregnancy = EXCLUDED.days_after_loss_pregnancy,
        minimum_cow_months = EXCLUDED.minimum_cow_months,
        minimum_bull_months = EXCLUDED.minimum_bull_months,
        allow_second_heat = EXCLUDED.allow_second_heat,
        allow_false_heat_in_pregnancy = EXCLUDED.allow_false_heat_in_pregnancy,
        use_last_valid_heat = EXCLUDED.use_last_valid_heat,
        max_milking_days = EXCLUDED.max_milking_days,
        updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [accountId, input.daysAfterBirthHeat, input.daysAfterBirthPregnancy,
      input.daysAfterLossHeat, input.daysAfterLossPregnancy, input.minimumCowMonths,
      input.minimumBullMonths, input.allowSecondHeat, input.allowFalseHeatInPregnancy,
      input.useLastValidHeat, input.maxMilkingDays, auth.userId]);
    await audit(client, auth, context, metadata, 'REPRODUCTION_SETTINGS_UPDATED',
      'ACCOUNT', accountId, before, input);
    const sections=await client.query<{module_code:string}>(`SELECT module_code FROM effective_property_module
      WHERE property_id=$1 AND enabled AND module_code LIKE 'REPRODUCTION_%' ORDER BY module_code`,[context.propertyId]);
    return {...input,accountId,canManageRules:true,enabledSections:sections.rows.map(row=>row.module_code)};
  });
}

async function access(client: PoolClient, auth: AuthState, context: PropertyContext, permission: string) {
  const supportResult=await superadminPropertyAccess(client,auth,context);
    const result=supportResult?{rows:[supportResult],rowCount:1}:await client.query<{ account_id: string; today: string }>(
    `SELECT p.account_id, to_char((now() AT TIME ZONE p.timezone)::date, 'YYYY-MM-DD') AS today
     FROM property p
     JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
     JOIN property_membership pm ON pm.property_id = p.id AND pm.user_id = $2 AND pm.status = 'ACTIVE'
     JOIN membership_role mr ON mr.membership_id = pm.id AND mr.property_id = p.id
     JOIN property_role pr ON pr.id = mr.role_id AND pr.property_id = p.id AND pr.active
     JOIN role_permission rp ON rp.role_id = pr.id AND rp.permission_code = $4
     JOIN effective_property_module epm ON epm.property_id = p.id
       AND epm.module_code = 'REPRODUCTION' AND epm.enabled
     WHERE p.id = $1 AND pr.id = $3 AND p.status = 'ACTIVE' AND p.deleted_at IS NULL
     FOR SHARE OF p, pm, pr`,
    [context.propertyId, auth.userId, context.roleId, permission],
  );
  if (!result.rows[0]) throw forbidden('REPRODUCTION_DENIED',
    'La reproducción no está habilitada o el rol activo no tiene acceso.');
  return result.rows[0];
}

async function eligibleAnimal(client: PoolClient, context: PropertyContext, id: string,
  sex: CowRow['sex'], accountId: string, eventOn: string, propertyRequired: boolean, minimumMonths: number) {
  const result = await client.query<CowRow>(
    `SELECT id, account_id, property_id, sex, birth_date::text, name FROM animal
     WHERE id = $1 AND account_id = $2 AND record_status = 'CURRENT'
       AND availability_status_code = 'ACTIVE' FOR UPDATE`,
    [id, accountId],
  );
  const animal = result.rows[0];
  if (!animal || animal.sex !== sex || (propertyRequired && animal.property_id !== context.propertyId)) {
    throw invalidRequest('REPRODUCTION_ANIMAL_UNAVAILABLE',
      'Selecciona un animal activo del sexo y propiedad correspondientes.');
  }
  if (animal.birth_date && minimumMonths > 0) {
    const age = await client.query<{ old_enough: boolean }>(
      `SELECT ($1::date + $3::int * interval '1 month')::date <= $2::date AS old_enough`,
      [animal.birth_date, eventOn, minimumMonths]);
    if (!age.rows[0]?.old_enough) throw invalidRequest('REPRODUCTION_MINIMUM_AGE',
      `El animal debe tener al menos ${minimumMonths} meses en la fecha del evento.`);
  }
  return animal;
}

async function femalePolicy(client: PoolClient, cowId: string, eventOn: string,
  action: 'HEAT' | 'PREGNANCY', config: ReproductionSettingInput, isFalse = false) {
  const lastBirth = await client.query<{ occurred_on: string }>(
    `SELECT occurred_on::text FROM reproduction_birth WHERE mother_id = $1
     AND occurred_on <= $2::date ORDER BY occurred_on DESC LIMIT 1`, [cowId, eventOn]);
  const lastLoss = await client.query<{ occurred_on: string }>(
    `SELECT occurred_on::text FROM reproduction_loss WHERE cow_id = $1
     AND occurred_on <= $2::date ORDER BY occurred_on DESC LIMIT 1`, [cowId, eventOn]);
  const activePregnancy = await client.query(
    `SELECT 1 FROM reproduction_pregnancy WHERE cow_id = $1 AND status = 'CONFIRMED' LIMIT 1`, [cowId]);
  if (action === 'HEAT' && activePregnancy.rowCount && !isFalse)
    throw conflict('PREGNANCY_CONFIRMED', 'La vaca tiene una preñez confirmada; marca falso el celo aparente.');
  if (action === 'PREGNANCY' && activePregnancy.rowCount)
    throw conflict('PREGNANCY_CONFIRMED', 'La vaca ya tiene una preñez confirmada.');
  const birth = lastBirth.rows[0]?.occurred_on;
  const loss = lastLoss.rows[0]?.occurred_on;
  if (action === 'HEAT' && !config.allowSecondHeat && !activePregnancy.rowCount) {
    const boundary = birth && loss ? (birth > loss ? birth : loss) : birth ?? loss ?? '0001-01-01';
    const recentHeat = await client.query(
      `SELECT 1 FROM reproduction_heat WHERE cow_id = $1 AND cancelled_at IS NULL
       AND starts_on >= $2::date AND starts_on <= $3::date LIMIT 1`,
      [cowId, boundary, eventOn]);
    if (recentHeat.rowCount) throw conflict('SECOND_HEAT_DISABLED',
      'Esta propiedad no permite otro celo en el mismo ciclo.');
  }
  for (const [previous, minimum, event] of [
    [birth, action === 'HEAT' ? config.daysAfterBirthHeat : config.daysAfterBirthPregnancy, 'parto'],
    [loss, action === 'HEAT' ? config.daysAfterLossHeat : config.daysAfterLossPregnancy, 'pérdida'],
  ] as const) {
    if (!previous || eventOn >= addDays(previous, minimum)) continue;
    throw invalidRequest('REPRODUCTION_WAITING_PERIOD',
      `Deben transcurrir ${minimum} días después del ${event}.`);
  }
}

async function audit(client: PoolClient, auth: AuthState, context: PropertyContext,
  metadata: RequestMetadata, action: string, entityType: string, id: string,
  before: unknown, after: unknown) {
  await client.query(
    `INSERT INTO audit_event(actor_user_id, property_id, active_role_id, action, entity_type,
      entity_id, before_data, after_data, ip_address, user_agent)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
    [auth.userId, context.propertyId, context.roleId, action, entityType, id,
      before === null ? null : JSON.stringify(before), JSON.stringify(after),
      metadata.ipAddress, metadata.userAgent],
  );
}

function translate(error: unknown): never {
  const database = error as { code?: string };
  if (database.code === '23505') throw conflict('REPRODUCTION_DUPLICATE',
    'Ya existe un evento para esa fecha o una preñez confirmada.');
  if (database.code === '23514' || database.code === '23503')
    throw invalidRequest('REPRODUCTION_INVALID_REFERENCE',
      'La información del evento ya no corresponde a los animales y la propiedad.');
  if (database.code === 'P0001') throw conflict('ANIMAL_LIMIT_REACHED',
    'Se alcanzó el límite de animales gestionados de la cuenta.');
  throw error;
}

export async function listReproduction(context: PropertyContext) {
  const [heats, pregnancies, births, losses, services] = await Promise.all([
    pool.query(`SELECT h.id, h.cow_id AS "cowId", a.name AS "cowName",
      h.bull_id AS "bullId", h.starts_on::text AS "startsOn", h.ends_on::text AS "endsOn",
      h.is_false AS "isFalse", h.notes, h.cancelled_at IS NOT NULL AS cancelled
      FROM reproduction_heat h JOIN animal a ON a.id = h.cow_id
      WHERE h.property_id = $1 ORDER BY h.starts_on DESC, h.created_at DESC LIMIT 300`, [context.propertyId]),
    pool.query(`SELECT p.id, p.cow_id AS "cowId", a.name AS "cowName", p.heat_id AS "heatId",
      p.father_id AS "fatherId", p.external_father AS "externalFather", p.service_id AS "serviceId",
      p.conception_method AS "conceptionMethod", p.confirmation_method AS "confirmationMethod",
      p.confirmed_on::text AS "confirmedOn", p.expected_birth_on::text AS "expectedBirthOn",
      p.gestation_days AS "gestationDays", p.status, p.notes
      FROM reproduction_pregnancy p JOIN animal a ON a.id = p.cow_id
      WHERE p.property_id = $1 ORDER BY p.confirmed_on DESC, p.created_at DESC LIMIT 300`, [context.propertyId]),
    pool.query(`SELECT b.id, b.pregnancy_id AS "pregnancyId", b.mother_id AS "motherId",
      a.name AS "motherName", b.occurred_on::text AS "occurredOn",
      b.live_count AS "liveCount", b.stillborn_count AS "stillbornCount", b.notes,b.kind,
      COALESCE((SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'sex', c.sex,
          'earTagCode',c.ear_tag_code,'birthCondition',bc.birth_condition,
          'initialWeight',c.initial_weight::float8,'initialWeightUnitCode',c.initial_weight_unit_code)
        ORDER BY c.name) FROM reproduction_birth_calf bc JOIN animal c ON c.id = bc.animal_id
        WHERE bc.birth_id = b.id), '[]'::json) AS calves
      FROM reproduction_birth b JOIN animal a ON a.id = b.mother_id
      WHERE b.property_id = $1 ORDER BY b.occurred_on DESC, b.created_at DESC LIMIT 300`, [context.propertyId]),
    pool.query(`SELECT l.id, l.pregnancy_id AS "pregnancyId", l.cow_id AS "cowId",
      a.name AS "cowName", l.occurred_on::text AS "occurredOn", l.notes
      FROM reproduction_loss l JOIN animal a ON a.id = l.cow_id
      WHERE l.property_id = $1 ORDER BY l.occurred_on DESC, l.created_at DESC LIMIT 300`, [context.propertyId]),
    pool.query(`SELECT s.id, s.cow_id AS "cowId", a.name AS "cowName", s.heat_id AS "heatId",
      s.father_id AS "fatherId", s.external_father AS "externalFather",
      s.donor_id AS "donorId", s.external_donor AS "externalDonor", s.kind,
      s.occurred_on::text AS "occurredOn", s.material_code AS "materialCode", s.quality,
      s.technician, s.supplier, s.notes, s.cancelled_at IS NOT NULL AS cancelled,
      EXISTS(SELECT 1 FROM reproduction_pregnancy p WHERE p.service_id=s.id
        AND p.status<>'CANCELLED') AS "hasPregnancy"
      FROM reproduction_service s JOIN animal a ON a.id=s.cow_id
      WHERE s.property_id=$1 ORDER BY s.occurred_on DESC,s.created_at DESC LIMIT 300`, [context.propertyId]),
  ]);
  return { heats: heats.rows, pregnancies: pregnancies.rows, births: births.rows,
    losses: losses.rows, services: services.rows };
}

export async function createService(auth: AuthState, context: PropertyContext,
  input: ServiceInput, metadata: RequestMetadata) {
  try {
    return await inTransaction(async (client) => {
      const { account_id: accountId, today } = await access(client, auth, context, 'REPRODUCTION_MANAGE');
      await requireSection(client,context,input.kind==='INSEMINATION'?'REPRODUCTION_INSEMINATION':'REPRODUCTION_EMBRYO_TRANSFER');
      if (input.occurredOn > today) throw invalidRequest('FUTURE_REPRODUCTION_DATE',
        'La fecha del servicio no puede ser futura.');
      const config = await settings(client, context.propertyId);
      await eligibleAnimal(client, context, input.cowId, 'FEMALE', accountId,
        input.occurredOn, true, config.minimumCowMonths);
      await femalePolicy(client, input.cowId, input.occurredOn, 'PREGNANCY', config);
      let fatherId = input.fatherId ?? null;
      if (input.heatId) {
        if(!(await cycleTrueHeats(client,input.cowId,input.occurredOn)).some(heat=>heat.id===input.heatId))
          throw invalidRequest('HEAT_UNAVAILABLE','Selecciona un celo verdadero del ciclo actual.');
        const heat = await client.query<{ bull_id: string | null }>(
          `SELECT bull_id FROM reproduction_heat WHERE id=$1 AND property_id=$2
           AND cow_id=$3 AND cancelled_at IS NULL AND NOT is_false
           AND starts_on<=$4::date FOR SHARE`,
          [input.heatId, context.propertyId, input.cowId, input.occurredOn]);
        if (!heat.rows[0]) throw invalidRequest('HEAT_UNAVAILABLE', 'El celo no corresponde al servicio.');
        if (!fatherId && !input.externalFather) fatherId = heat.rows[0].bull_id;
      }
      if (fatherId) await eligibleAnimal(client, context, fatherId, 'MALE', accountId,
        input.occurredOn, false, config.minimumBullMonths);
      if (input.donorId) await eligibleAnimal(client, context, input.donorId, 'FEMALE', accountId,
        input.occurredOn, false, config.minimumCowMonths);
      const result = await client.query<{ id: string }>(
        `INSERT INTO reproduction_service(account_id, property_id, cow_id, heat_id,
          father_id, external_father, donor_id, external_donor, kind, occurred_on,
          material_code, quality, technician, supplier, notes, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [accountId, context.propertyId, input.cowId, input.heatId ?? null, fatherId,
          input.externalFather ?? null, input.donorId ?? null, input.externalDonor ?? null,
          input.kind, input.occurredOn, input.materialCode ?? null, input.quality ?? null,
          input.technician ?? null, input.supplier ?? null, input.notes ?? null, auth.userId]);
      const created = { id: result.rows[0]!.id, ...input, fatherId, cancelled: false };
      await audit(client, auth, context, metadata, 'REPRODUCTION_SERVICE_CREATED',
        'REPRODUCTION_SERVICE', created.id, null, created);
      return created;
    });
  } catch (error) { return translate(error); }
}

export async function cancelService(auth: AuthState, context: PropertyContext,
  id: string, metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    await access(client, auth, context, 'REPRODUCTION_MANAGE');
    const service = await client.query(`SELECT id,kind FROM reproduction_service WHERE id=$1
      AND property_id=$2 AND cancelled_at IS NULL FOR UPDATE`, [id, context.propertyId]);
    if (!service.rows[0]) throw new ApiError(404, 'SERVICE_NOT_FOUND', 'El servicio no está disponible.');
    await requireSection(client,context,service.rows[0].kind==='INSEMINATION'?'REPRODUCTION_INSEMINATION':'REPRODUCTION_EMBRYO_TRANSFER');
    const linked = await client.query(`SELECT 1 FROM reproduction_pregnancy
      WHERE service_id=$1 AND status<>'CANCELLED' LIMIT 1`, [id]);
    if (linked.rowCount) throw conflict('SERVICE_HAS_PREGNANCY',
      'Este servicio tiene una preñez relacionada y debe conservarse.');
    await client.query(`UPDATE reproduction_service SET cancelled_at=now(),cancelled_by=$2
      WHERE id=$1`, [id, auth.userId]);
    await audit(client, auth, context, metadata, 'REPRODUCTION_SERVICE_CANCELLED',
      'REPRODUCTION_SERVICE', id, { id, cancelled: false }, { id, cancelled: true });
    return { id, cancelled: true };
  });
}

export async function listReproductionCandidates(context: PropertyContext) {
  const result = await pool.query<{ id: string; name: string; sex: CowRow['sex'] }>(
    `SELECT id, name, sex,birth_date::text AS "birthDate" FROM animal WHERE property_id = $1 AND species_code = 'BOVINE'
      AND record_status = 'CURRENT' AND availability_status_code = 'ACTIVE'
      ORDER BY lower(name), id LIMIT 2000`, [context.propertyId]);
  return result.rows;
}

export async function createHeat(auth: AuthState, context: PropertyContext,
  input: HeatInput, metadata: RequestMetadata) {
  try {
    return await inTransaction(async (client) => {
      const { account_id: accountId, today } = await access(client, auth, context, 'REPRODUCTION_MANAGE');
      await requireSection(client,context,'REPRODUCTION_HEATS');
      const config = await settings(client, context.propertyId);
      if (input.startsOn > today || (input.endsOn && input.endsOn > today))
        throw invalidRequest('FUTURE_REPRODUCTION_DATE', 'Las fechas del celo no pueden ser futuras.');
      await eligibleAnimal(client, context, input.cowId, 'FEMALE', accountId, input.startsOn, true,
        config.minimumCowMonths);
      if (input.bullId) await eligibleAnimal(client, context, input.bullId, 'MALE', accountId,
        input.startsOn, false, config.minimumBullMonths);
      const confirmed=await client.query(`SELECT 1 FROM reproduction_pregnancy WHERE cow_id=$1 AND status='CONFIRMED' LIMIT 1`,[input.cowId]);
      if(confirmed.rowCount){input={...input,isFalse:true};delete input.trueHeatId;}
      await femalePolicy(client, input.cowId, input.startsOn, 'HEAT', config, input.isFalse);
      const previous=await cycleTrueHeats(client,input.cowId,input.startsOn);
      let isFalse=input.isFalse;
      if(!isFalse&&previous.length){
        if(!input.trueHeatId)throw conflict('TRUE_HEAT_SELECTION_REQUIRED',
          'Ya hay un celo verdadero en este ciclo. Elige cuál conservar como verdadero.');
        if(input.trueHeatId!=='NEW'&&!previous.some(heat=>heat.id===input.trueHeatId))
          throw conflict('TRUE_HEAT_CHANGED','El celo verdadero cambió. Actualiza el registro y vuelve a elegir.');
        isFalse=input.trueHeatId!=='NEW';
        for(const heat of previous.filter(heat=>heat.id!==input.trueHeatId)){
          await client.query('UPDATE reproduction_heat SET is_false=true WHERE id=$1',[heat.id]);
          await audit(client,auth,context,metadata,'REPRODUCTION_HEAT_MARKED_FALSE','REPRODUCTION_HEAT',heat.id,
            {id:heat.id,isFalse:false},{id:heat.id,isFalse:true});
        }
      }else if(input.trueHeatId)throw conflict('TRUE_HEAT_CHANGED',
        'El celo verdadero cambió. Actualiza el registro y vuelve a elegir.');
      const result = await client.query<{ id: string }>(
        `INSERT INTO reproduction_heat(account_id, property_id, cow_id, bull_id,
         starts_on, ends_on, is_false, notes, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [accountId, context.propertyId, input.cowId, input.bullId ?? null, input.startsOn,
          input.endsOn ?? null, isFalse, input.notes ?? null, auth.userId]);
      const created = { id: result.rows[0]!.id, ...input,isFalse };
      await audit(client, auth, context, metadata, 'REPRODUCTION_HEAT_CREATED',
        'REPRODUCTION_HEAT', created.id, null, created);
      return created;
    });
  } catch (error) { return translate(error); }
}

export async function createPregnancy(auth: AuthState, context: PropertyContext,
  input: PregnancyInput, metadata: RequestMetadata) {
  try {
    return await inTransaction(async (client) => {
      const { account_id: accountId, today } = await access(client, auth, context, 'REPRODUCTION_MANAGE');
      await requireSection(client,context,'REPRODUCTION_PREGNANCIES');
      if(input.conceptionMethod==='INSEMINATION'||input.conceptionMethod==='EMBRYO_TRANSFER')await requireSection(client,context,
        input.conceptionMethod==='INSEMINATION'?'REPRODUCTION_INSEMINATION':'REPRODUCTION_EMBRYO_TRANSFER');
      const config = await settings(client, context.propertyId);
      if (input.confirmedOn > today) throw invalidRequest('FUTURE_REPRODUCTION_DATE',
        'La confirmación no puede ser futura.');
      await eligibleAnimal(client, context, input.cowId, 'FEMALE', accountId, input.confirmedOn, true,
        config.minimumCowMonths);
      await femalePolicy(client, input.cowId, input.confirmedOn, 'PREGNANCY', config);
      let conceptionOn: string | null = null;
      let gestationDays = input.gestationDays ?? null;
      let heatId = input.heatId ?? null;
      let fatherId = input.fatherId ?? null;
      let externalFather = input.externalFather ?? null;
      if (input.serviceId) {
        const service = await client.query<{ occurred_on: string; heat_id: string | null;
          father_id: string | null; external_father: string | null; kind: string }>(
          `SELECT occurred_on::text,heat_id,father_id,external_father,kind
           FROM reproduction_service WHERE id=$1 AND property_id=$2 AND cow_id=$3
             AND account_id=$4 AND cancelled_at IS NULL
             AND occurred_on>=GREATEST(
               COALESCE((SELECT max(occurred_on) FROM reproduction_birth WHERE mother_id=$3 AND occurred_on<=$5::date),'-infinity'::date),
               COALESCE((SELECT max(occurred_on) FROM reproduction_loss WHERE cow_id=$3 AND occurred_on<=$5::date),'-infinity'::date)) FOR SHARE`,
          [input.serviceId, context.propertyId, input.cowId, accountId,input.confirmedOn]);
        const selected = service.rows[0];
        if (!selected || selected.kind !== input.conceptionMethod || selected.occurred_on > input.confirmedOn
          || (heatId && heatId !== selected.heat_id)
          || (fatherId && fatherId !== selected.father_id)
          || (externalFather && externalFather !== selected.external_father))
          throw invalidRequest('SERVICE_UNAVAILABLE', 'El servicio no corresponde a esta preñez.');
        heatId = selected.heat_id;
        if(heatId&&!(await cycleTrueHeats(client,input.cowId,input.confirmedOn)).some(heat=>heat.id===heatId))
          throw invalidRequest('SERVICE_UNAVAILABLE','El servicio está relacionado con un celo falso o de un ciclo anterior.');
        fatherId = selected.father_id;
        externalFather = selected.external_father;
        conceptionOn = selected.occurred_on;
        gestationDays = (await client.query<{ days: number }>(
          `SELECT ($1::date-$2::date)::int AS days`, [input.confirmedOn, conceptionOn])).rows[0]!.days;
        if (gestationDays > 400) throw invalidRequest('PREGNANCY_DATES_CONFLICT',
          'La confirmación supera los 400 días desde el servicio.');
      }
      if (!input.serviceId && !heatId && config.useLastValidHeat) {
        const latest = await client.query<{ id: string }>(
          `SELECT id FROM reproduction_heat WHERE cow_id = $1 AND property_id = $2
           AND cancelled_at IS NULL AND NOT is_false AND starts_on <= $3::date
           AND starts_on >= GREATEST(
             COALESCE((SELECT max(occurred_on) FROM reproduction_birth
               WHERE mother_id = $1 AND occurred_on <= $3::date), '-infinity'::date),
             COALESCE((SELECT max(occurred_on) FROM reproduction_loss
               WHERE cow_id = $1 AND occurred_on <= $3::date), '-infinity'::date))
           ORDER BY starts_on DESC, created_at DESC LIMIT 1`,
          [input.cowId, context.propertyId, input.confirmedOn]);
        heatId = latest.rows[0]?.id ?? null;
      }
      if (!input.serviceId && heatId) {
        if(!(await cycleTrueHeats(client,input.cowId,input.confirmedOn)).some(heat=>heat.id===heatId))
          throw invalidRequest('HEAT_UNAVAILABLE','Selecciona un celo verdadero del ciclo actual.');
        const heat = await client.query<{ starts_on: string; ends_on: string | null; bull_id: string | null }>(
          `SELECT starts_on::text, ends_on::text, bull_id FROM reproduction_heat WHERE id = $1 AND cow_id = $2
           AND property_id = $3 AND cancelled_at IS NULL AND NOT is_false FOR SHARE`,
          [heatId, input.cowId, context.propertyId]);
        if (!heat.rows[0] || heat.rows[0].starts_on > input.confirmedOn)
          throw invalidRequest('HEAT_UNAVAILABLE', 'El celo no corresponde a esta vaca o fecha.');
        if (!fatherId && !input.externalFather) fatherId = heat.rows[0].bull_id;
        conceptionOn = config.useLastValidHeat
          ? heat.rows[0].ends_on ?? heat.rows[0].starts_on : heat.rows[0].starts_on;
        if (conceptionOn > input.confirmedOn) throw invalidRequest('PREGNANCY_DATES_CONFLICT',
          'La confirmación no puede ser anterior al fin del celo.');
        const elapsed = await client.query<{ days: number }>(
          `SELECT ($1::date - $2::date)::int AS days`, [input.confirmedOn, conceptionOn]);
        gestationDays = elapsed.rows[0]!.days;
        if (gestationDays > 400)
          throw invalidRequest('PREGNANCY_DATES_CONFLICT',
            'La confirmación supera los 400 días desde el celo seleccionado.');
      } else if (!input.serviceId && gestationDays !== null) {
        conceptionOn = addDays(input.confirmedOn, -gestationDays);
      }
      if (fatherId) await eligibleAnimal(client, context, fatherId, 'MALE', accountId,
        conceptionOn??input.confirmedOn, false, config.minimumBullMonths);
      if(conceptionOn)await eligibleAnimal(client,context,input.cowId,'FEMALE',accountId,conceptionOn,true,config.minimumCowMonths);
      const expectedBirthOn = conceptionOn ? addDays(conceptionOn, GESTATION_DAYS) : null;
      const result = await client.query<{ id: string }>(
        `INSERT INTO reproduction_pregnancy(account_id, property_id, cow_id, heat_id, service_id,
          father_id, external_father, conception_method, confirmation_method, confirmed_on,
          gestation_days, conception_on, expected_birth_on, notes, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [accountId, context.propertyId, input.cowId, heatId, input.serviceId ?? null,
          fatherId, externalFather, input.conceptionMethod,
          input.confirmationMethod, input.confirmedOn, gestationDays, conceptionOn,
          expectedBirthOn, input.notes ?? null, auth.userId]);
      const created = { id: result.rows[0]!.id, ...input, heatId, fatherId, externalFather, gestationDays,
        expectedBirthOn, status: 'CONFIRMED' };
      await audit(client, auth, context, metadata, 'REPRODUCTION_PREGNANCY_CREATED',
        'REPRODUCTION_PREGNANCY', created.id, null, created);
      return created;
    });
  } catch (error) { return translate(error); }
}

async function lockPregnancy(client: PoolClient, context: PropertyContext, id: string) {
  const target = await client.query<{ cow_id: string }>(
    `SELECT cow_id FROM reproduction_pregnancy WHERE id = $1 AND property_id = $2`,
    [id, context.propertyId]);
  if (!target.rows[0]) throw new ApiError(404, 'PREGNANCY_NOT_FOUND',
    'La preñez no está disponible en esta propiedad.');
  // Every reproductive transition locks the cow before the pregnancy, matching
  // heat and pregnancy creation and avoiding opposite lock orders at birth.
  await client.query(`SELECT id FROM animal WHERE id = $1 FOR UPDATE`, [target.rows[0].cow_id]);
  const result = await client.query<{ id: string; account_id: string; cow_id: string;
    father_id: string | null; external_father: string | null; confirmed_on: string; status: string }>(
    `SELECT id, account_id, cow_id, father_id, external_father,
      confirmed_on::text, status FROM reproduction_pregnancy
     WHERE id = $1 AND property_id = $2 FOR UPDATE`, [id, context.propertyId]);
  const pregnancy = result.rows[0];
  if (!pregnancy) throw new ApiError(404, 'PREGNANCY_NOT_FOUND', 'La preñez no está disponible en esta propiedad.');
  if (pregnancy.status !== 'CONFIRMED') throw conflict('PREGNANCY_FINISHED', 'Esta preñez ya fue finalizada.');
  return pregnancy;
}

export async function recordBirth(auth: AuthState, context: PropertyContext,
  input: BirthInput, metadata: RequestMetadata) {
  try {
    return await inTransaction(async (client) => {
      const { account_id: accountId, today } = await access(client, auth, context, 'REPRODUCTION_MANAGE');
      await requireSection(client,context,'REPRODUCTION_BIRTHS');
      if (input.occurredOn > today) throw invalidRequest('FUTURE_REPRODUCTION_DATE',
        'La fecha del parto no puede ser futura.');
      const pregnancy = await lockPregnancy(client, context, input.pregnancyId);
      if (pregnancy.account_id !== accountId || input.occurredOn < pregnancy.confirmed_on)
        throw invalidRequest('BIRTH_DATE_INVALID', 'El parto no puede preceder a la confirmación.');
      const mother = await client.query<CowRow>(
        `SELECT id, account_id, property_id, sex, birth_date::text, name FROM animal
         WHERE id = $1 AND property_id = $2 AND record_status = 'CURRENT' FOR UPDATE`,
        [pregnancy.cow_id, context.propertyId]);
      if (!mother.rows[0]) throw invalidRequest('MOTHER_UNAVAILABLE', 'La madre no está disponible.');
      const birth = await client.query<{ id: string }>(
        `INSERT INTO reproduction_birth(account_id, property_id, pregnancy_id, mother_id,
          occurred_on, live_count, stillborn_count, notes, created_by,kind)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [accountId, context.propertyId, pregnancy.id, pregnancy.cow_id, input.occurredOn,
          input.calves.length, input.stillbornCount, input.notes ?? null, auth.userId,input.kind??'NORMAL']);
      const ownership = await client.query<{ party_id: string; ownership_percent: string; is_primary: boolean }>(
        `SELECT party_id, ownership_percent::text, is_primary FROM animal_ownership
         WHERE animal_id = $1 AND valid_until IS NULL`, [pregnancy.cow_id]);
      if (input.calves.some(calf=>!calf.owners?.length)&&!ownership.rows.length) throw invalidRequest('MOTHER_OWNERS_REQUIRED',
        'Asigna propietarios a la madre antes de registrar sus crías.');
      const calves: Array<Awaited<ReturnType<typeof insertAnimalInTransaction>> & {birthCondition:string}> = [];
      for (const calf of input.calves) {
        const owners=calf.owners??ownership.rows.map(owner=>({partyId:owner.party_id,
          percent:Number(owner.ownership_percent),isPrimary:owner.is_primary}));
        const created=await insertAnimalInTransaction(client,auth,context,{
          ...calf,speciesCode:'BOVINE',birthDate:input.occurredOn,entryDate:input.occurredOn,
          owners,mother:{animalId:pregnancy.cow_id},
          father:pregnancy.father_id?{animalId:pregnancy.father_id}:pregnancy.external_father?
            {reportedName:pregnancy.external_father}:null,
        },metadata,accountId,today,true);
        const calfId=created.id;
        await client.query(`INSERT INTO reproduction_birth_calf(birth_id,animal_id,birth_condition)
          VALUES($1,$2,$3)`,[birth.rows[0]!.id,calfId,calf.birthCondition??'ALIVE']);
        calves.push({ ...created, birthCondition:calf.birthCondition??'ALIVE' });
      }
      await client.query(`UPDATE reproduction_pregnancy SET status = 'BORN',
        resolved_at = now(), resolved_by = $2 WHERE id = $1`, [pregnancy.id, auth.userId]);
      const response = { id: birth.rows[0]!.id, pregnancyId: pregnancy.id,
        motherId: pregnancy.cow_id, motherName:mother.rows[0].name,
        kind:input.kind??'NORMAL',notes:input.notes??null,occurredOn: input.occurredOn, calves,
        liveCount: calves.length, stillbornCount: input.stillbornCount };
      await audit(client, auth, context, metadata, 'REPRODUCTION_BIRTH_REGISTERED',
        'REPRODUCTION_BIRTH', response.id, null, response);
      return response;
    });
  } catch (error) { return translate(error); }
}

export async function recordLoss(auth: AuthState, context: PropertyContext,
  input: LossInput, metadata: RequestMetadata) {
  try {
    return await inTransaction(async (client) => {
      const { account_id: accountId, today } = await access(client, auth, context, 'REPRODUCTION_MANAGE');
      await requireSection(client,context,'REPRODUCTION_LOSSES');
      if (input.occurredOn > today) throw invalidRequest('FUTURE_REPRODUCTION_DATE',
        'La fecha de la pérdida no puede ser futura.');
      const pregnancy = await lockPregnancy(client, context, input.pregnancyId);
      if (pregnancy.account_id !== accountId || input.occurredOn < pregnancy.confirmed_on)
        throw invalidRequest('LOSS_DATE_INVALID', 'La pérdida no puede preceder a la confirmación.');
      const result = await client.query<{ id: string }>(
        `INSERT INTO reproduction_loss(account_id, property_id, pregnancy_id, cow_id,
         occurred_on, notes, created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [accountId, context.propertyId, pregnancy.id, pregnancy.cow_id,
          input.occurredOn, input.notes, auth.userId]);
      await client.query(`UPDATE reproduction_pregnancy SET status = 'LOST',
        resolved_at = now(), resolved_by = $2 WHERE id = $1`, [pregnancy.id, auth.userId]);
      const response = { id: result.rows[0]!.id, pregnancyId: pregnancy.id,
        cowId: pregnancy.cow_id, occurredOn: input.occurredOn, notes: input.notes };
      await audit(client, auth, context, metadata, 'REPRODUCTION_LOSS_REGISTERED',
        'REPRODUCTION_LOSS', response.id, null, response);
      return response;
    });
  } catch (error) { return translate(error); }
}

export async function cancelPregnancy(auth: AuthState, context: PropertyContext,
  id: string, metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    const {account_id:accountId}=await access(client, auth, context, 'REPRODUCTION_MANAGE');
      await requireSection(client,context,'REPRODUCTION_PREGNANCIES');
    await requireRulesAdministrator(client,auth,context);
    await client.query('SELECT id FROM administrative_account WHERE id=$1 FOR UPDATE',[accountId]);
    const before = await lockPregnancy(client, context, id);
    await client.query(`UPDATE reproduction_pregnancy SET status = 'CANCELLED',
      resolved_at = now(), resolved_by = $2 WHERE id = $1`, [id, auth.userId]);
    await audit(client, auth, context, metadata, 'REPRODUCTION_PREGNANCY_CANCELLED',
      'REPRODUCTION_PREGNANCY', id, before, { ...before, status: 'CANCELLED' });
    return { id, status: 'CANCELLED' };
  });
}

export async function cancelHeat(auth: AuthState, context: PropertyContext,
  id: string, metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    await access(client, auth, context, 'REPRODUCTION_MANAGE');
      await requireSection(client,context,'REPRODUCTION_HEATS');
    const heat = await client.query(`SELECT id FROM reproduction_heat WHERE id = $1 AND property_id = $2
      AND cancelled_at IS NULL FOR UPDATE`, [id, context.propertyId]);
    if (!heat.rows[0]) throw new ApiError(404, 'HEAT_NOT_FOUND', 'El celo no está disponible.');
    const related = await client.query(`SELECT 1 FROM reproduction_pregnancy
      WHERE heat_id = $1 AND status <> 'CANCELLED' LIMIT 1`, [id]);
    if (related.rowCount) throw conflict('HEAT_HAS_PREGNANCY',
      'El celo forma parte de una preñez y debe conservarse.');
    await client.query(`UPDATE reproduction_heat SET cancelled_at = now(), cancelled_by = $2
      WHERE id = $1`, [id, auth.userId]);
    await audit(client, auth, context, metadata, 'REPRODUCTION_HEAT_CANCELLED',
      'REPRODUCTION_HEAT', id, { id, cancelled: false }, { id, cancelled: true });
    return { id, cancelled: true };
  });
}


async function requireSection(client:PoolClient,context:PropertyContext,code:string){
  const enabled=await client.query(`SELECT 1 FROM effective_property_module WHERE property_id=$1 AND module_code=$2 AND enabled`,[context.propertyId,code]);
  if(!enabled.rowCount)throw forbidden('REPRODUCTION_SECTION_DISABLED','Esta sección de reproducción está deshabilitada en las políticas de operación.');
}

export async function finishHeat(auth:AuthState,context:PropertyContext,id:string,endsOn:string,metadata:RequestMetadata){
  return inTransaction(async client=>{
    const {today}=await access(client,auth,context,'REPRODUCTION_MANAGE');
    await requireSection(client,context,'REPRODUCTION_HEATS');
    const target=await client.query<{cow_id:string}>(`SELECT cow_id FROM reproduction_heat WHERE id=$1 AND property_id=$2`,[id,context.propertyId]);
    if(!target.rows[0])throw new ApiError(404,'HEAT_NOT_FOUND','El celo no está disponible en esta propiedad.');
    await client.query('SELECT id FROM animal WHERE id=$1 FOR UPDATE',[target.rows[0].cow_id]);
    const heat=(await client.query<{starts_on:string;ends_on:string|null;cancelled_at:string|null}>(`SELECT starts_on::text,ends_on::text,cancelled_at FROM reproduction_heat WHERE id=$1 AND property_id=$2 FOR UPDATE`,[id,context.propertyId])).rows[0]!;
    if(heat.cancelled_at||heat.ends_on)throw conflict('HEAT_FINISHED','Este celo ya fue finalizado o cancelado.');
    if(endsOn<heat.starts_on||endsOn>today)throw invalidRequest('HEAT_END_INVALID','La fecha de fin debe estar entre el inicio del celo y hoy.');
    await client.query('UPDATE reproduction_heat SET ends_on=$2 WHERE id=$1',[id,endsOn]);
    await audit(client,auth,context,metadata,'REPRODUCTION_HEAT_FINISHED','REPRODUCTION_HEAT',id,
      {id,endsOn:null},{id,endsOn});
    return {id,endsOn};
  });
}
