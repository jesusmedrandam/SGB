import type { PoolClient } from 'pg';
import { ApiError, conflict, forbidden, invalidRequest } from '../../core/errors.js';
import { pool } from '../../database/pool.js';
import { inTransaction } from '../../database/transaction.js';
import type { AuthState, PropertyContext, RequestMetadata } from '../auth/auth.types.js';
import type { BirthInput, HeatInput, LossInput, PregnancyInput, ReproductionSettingInput } from './reproduction.schemas.js';

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
  COALESCE(s.allow_false_heat_in_pregnancy, true) AS "allowFalseHeatInPregnancy",
  COALESCE(s.use_last_valid_heat, true) AS "useLastValidHeat"`;

async function settings(client: PoolClient, propertyId: string): Promise<ReproductionSettingInput> {
  const result = await client.query<ReproductionSettingInput>(
    `SELECT ${settingFields} FROM property p LEFT JOIN reproduction_setting s ON s.property_id = p.id
     WHERE p.id = $1`, [propertyId]);
  return result.rows[0]!;
}

export async function getReproductionSettings(context: PropertyContext) {
  const client = await pool.connect();
  try { return await settings(client, context.propertyId); }
  finally { client.release(); }
}

export async function updateReproductionSettings(auth: AuthState, context: PropertyContext,
  input: ReproductionSettingInput, metadata: RequestMetadata) {
  return inTransaction(async (client) => {
    await access(client, auth, context, 'REPRODUCTION_MANAGE');
    const before = await settings(client, context.propertyId);
    await client.query(`INSERT INTO reproduction_setting(property_id, days_after_birth_heat,
      days_after_birth_pregnancy, days_after_loss_heat, days_after_loss_pregnancy,
      minimum_cow_months, minimum_bull_months, allow_second_heat,
      allow_false_heat_in_pregnancy, use_last_valid_heat, updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(property_id) DO UPDATE SET
        days_after_birth_heat = EXCLUDED.days_after_birth_heat,
        days_after_birth_pregnancy = EXCLUDED.days_after_birth_pregnancy,
        days_after_loss_heat = EXCLUDED.days_after_loss_heat,
        days_after_loss_pregnancy = EXCLUDED.days_after_loss_pregnancy,
        minimum_cow_months = EXCLUDED.minimum_cow_months,
        minimum_bull_months = EXCLUDED.minimum_bull_months,
        allow_second_heat = EXCLUDED.allow_second_heat,
        allow_false_heat_in_pregnancy = EXCLUDED.allow_false_heat_in_pregnancy,
        use_last_valid_heat = EXCLUDED.use_last_valid_heat,
        updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [context.propertyId, input.daysAfterBirthHeat, input.daysAfterBirthPregnancy,
      input.daysAfterLossHeat, input.daysAfterLossPregnancy, input.minimumCowMonths,
      input.minimumBullMonths, input.allowSecondHeat, input.allowFalseHeatInPregnancy,
      input.useLastValidHeat, auth.userId]);
    await audit(client, auth, context, metadata, 'REPRODUCTION_SETTINGS_UPDATED',
      'REPRODUCTION_SETTING', context.propertyId, before, input);
    return input;
  });
}

async function access(client: PoolClient, auth: AuthState, context: PropertyContext, permission: string) {
  const result = await client.query<{ account_id: string; today: string }>(
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
  if (action === 'HEAT' && isFalse && !config.allowFalseHeatInPregnancy)
    throw conflict('FALSE_HEAT_DISABLED', 'Esta propiedad no permite registrar celos falsos.');
  if (action === 'PREGNANCY' && activePregnancy.rowCount)
    throw conflict('PREGNANCY_CONFIRMED', 'La vaca ya tiene una preñez confirmada.');
  const birth = lastBirth.rows[0]?.occurred_on;
  const loss = lastLoss.rows[0]?.occurred_on;
  if (action === 'HEAT' && !config.allowSecondHeat) {
    const boundary = birth && loss ? (birth > loss ? birth : loss) : birth ?? loss ?? '0001-01-01';
    const recentHeat = await client.query(
      `SELECT 1 FROM reproduction_heat WHERE cow_id = $1 AND cancelled_at IS NULL
       AND starts_on > $2::date AND starts_on <= $3::date LIMIT 1`,
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
  const [heats, pregnancies, births, losses] = await Promise.all([
    pool.query(`SELECT h.id, h.cow_id AS "cowId", a.name AS "cowName",
      h.bull_id AS "bullId", h.starts_on::text AS "startsOn", h.ends_on::text AS "endsOn",
      h.is_false AS "isFalse", h.notes, h.cancelled_at IS NOT NULL AS cancelled
      FROM reproduction_heat h JOIN animal a ON a.id = h.cow_id
      WHERE h.property_id = $1 ORDER BY h.starts_on DESC, h.created_at DESC LIMIT 300`, [context.propertyId]),
    pool.query(`SELECT p.id, p.cow_id AS "cowId", a.name AS "cowName", p.heat_id AS "heatId",
      p.father_id AS "fatherId", p.external_father AS "externalFather",
      p.conception_method AS "conceptionMethod", p.confirmation_method AS "confirmationMethod",
      p.confirmed_on::text AS "confirmedOn", p.expected_birth_on::text AS "expectedBirthOn",
      p.gestation_days AS "gestationDays", p.status, p.notes
      FROM reproduction_pregnancy p JOIN animal a ON a.id = p.cow_id
      WHERE p.property_id = $1 ORDER BY p.confirmed_on DESC, p.created_at DESC LIMIT 300`, [context.propertyId]),
    pool.query(`SELECT b.id, b.pregnancy_id AS "pregnancyId", b.mother_id AS "motherId",
      a.name AS "motherName", b.occurred_on::text AS "occurredOn",
      b.live_count AS "liveCount", b.stillborn_count AS "stillbornCount", b.notes,
      COALESCE((SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'sex', c.sex)
        ORDER BY c.name) FROM reproduction_birth_calf bc JOIN animal c ON c.id = bc.animal_id
        WHERE bc.birth_id = b.id), '[]'::json) AS calves
      FROM reproduction_birth b JOIN animal a ON a.id = b.mother_id
      WHERE b.property_id = $1 ORDER BY b.occurred_on DESC, b.created_at DESC LIMIT 300`, [context.propertyId]),
    pool.query(`SELECT l.id, l.pregnancy_id AS "pregnancyId", l.cow_id AS "cowId",
      a.name AS "cowName", l.occurred_on::text AS "occurredOn", l.notes
      FROM reproduction_loss l JOIN animal a ON a.id = l.cow_id
      WHERE l.property_id = $1 ORDER BY l.occurred_on DESC, l.created_at DESC LIMIT 300`, [context.propertyId]),
  ]);
  return { heats: heats.rows, pregnancies: pregnancies.rows, births: births.rows, losses: losses.rows };
}

export async function listReproductionCandidates(context: PropertyContext) {
  const result = await pool.query<{ id: string; name: string; sex: CowRow['sex'] }>(
    `SELECT id, name, sex FROM animal WHERE property_id = $1 AND species_code = 'BOVINE'
      AND record_status = 'CURRENT' AND availability_status_code = 'ACTIVE'
      ORDER BY lower(name), id LIMIT 2000`, [context.propertyId]);
  return result.rows;
}

export async function createHeat(auth: AuthState, context: PropertyContext,
  input: HeatInput, metadata: RequestMetadata) {
  try {
    return await inTransaction(async (client) => {
      const { account_id: accountId, today } = await access(client, auth, context, 'REPRODUCTION_MANAGE');
      const config = await settings(client, context.propertyId);
      if (input.startsOn > today || (input.endsOn && input.endsOn > today))
        throw invalidRequest('FUTURE_REPRODUCTION_DATE', 'Las fechas del celo no pueden ser futuras.');
      await eligibleAnimal(client, context, input.cowId, 'FEMALE', accountId, input.startsOn, true,
        config.minimumCowMonths);
      if (input.bullId) await eligibleAnimal(client, context, input.bullId, 'MALE', accountId,
        input.startsOn, false, config.minimumBullMonths);
      await femalePolicy(client, input.cowId, input.startsOn, 'HEAT', config, input.isFalse);
      const result = await client.query<{ id: string }>(
        `INSERT INTO reproduction_heat(account_id, property_id, cow_id, bull_id,
         starts_on, ends_on, is_false, notes, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [accountId, context.propertyId, input.cowId, input.bullId ?? null, input.startsOn,
          input.endsOn ?? null, input.isFalse, input.notes ?? null, auth.userId]);
      const created = { id: result.rows[0]!.id, ...input };
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
      const config = await settings(client, context.propertyId);
      if (input.confirmedOn > today) throw invalidRequest('FUTURE_REPRODUCTION_DATE',
        'La confirmación no puede ser futura.');
      await eligibleAnimal(client, context, input.cowId, 'FEMALE', accountId, input.confirmedOn, true,
        config.minimumCowMonths);
      await femalePolicy(client, input.cowId, input.confirmedOn, 'PREGNANCY', config);
      let conceptionOn: string | null = null;
      let gestationDays = input.gestationDays ?? null;
      let heatId = input.heatId ?? null;
      if (!heatId && config.useLastValidHeat) {
        const latest = await client.query<{ id: string }>(
          `SELECT id FROM reproduction_heat WHERE cow_id = $1 AND property_id = $2
           AND cancelled_at IS NULL AND NOT is_false AND starts_on <= $3::date
           AND starts_on > GREATEST(
             COALESCE((SELECT max(occurred_on) FROM reproduction_birth
               WHERE mother_id = $1 AND occurred_on <= $3::date), '-infinity'::date),
             COALESCE((SELECT max(occurred_on) FROM reproduction_loss
               WHERE cow_id = $1 AND occurred_on <= $3::date), '-infinity'::date))
           ORDER BY starts_on DESC, created_at DESC LIMIT 1`,
          [input.cowId, context.propertyId, input.confirmedOn]);
        heatId = latest.rows[0]?.id ?? null;
      }
      let fatherId = input.fatherId ?? null;
      if (heatId) {
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
      } else if (gestationDays !== null) {
        conceptionOn = addDays(input.confirmedOn, -gestationDays);
      }
      if (fatherId) await eligibleAnimal(client, context, fatherId, 'MALE', accountId,
        input.confirmedOn, false, config.minimumBullMonths);
      const expectedBirthOn = conceptionOn ? addDays(conceptionOn, GESTATION_DAYS) : null;
      const result = await client.query<{ id: string }>(
        `INSERT INTO reproduction_pregnancy(account_id, property_id, cow_id, heat_id,
          father_id, external_father, conception_method, confirmation_method, confirmed_on,
          gestation_days, conception_on, expected_birth_on, notes, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [accountId, context.propertyId, input.cowId, heatId,
          fatherId, input.externalFather ?? null, input.conceptionMethod,
          input.confirmationMethod, input.confirmedOn, gestationDays, conceptionOn,
          expectedBirthOn, input.notes ?? null, auth.userId]);
      const created = { id: result.rows[0]!.id, ...input, heatId, fatherId, gestationDays,
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
          occurred_on, live_count, stillborn_count, notes, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [accountId, context.propertyId, pregnancy.id, pregnancy.cow_id, input.occurredOn,
          input.calves.length, input.stillbornCount, input.notes ?? null, auth.userId]);
      const ownership = await client.query<{ party_id: string; ownership_percent: string; is_primary: boolean }>(
        `SELECT party_id, ownership_percent::text, is_primary FROM animal_ownership
         WHERE animal_id = $1 AND valid_until IS NULL`, [pregnancy.cow_id]);
      if (!ownership.rows.length) throw invalidRequest('MOTHER_OWNERS_REQUIRED',
        'Asigna propietarios a la madre antes de registrar sus crías.');
      const calves: Array<{ id: string; name: string; sex: 'FEMALE' | 'MALE' }> = [];
      for (const calf of input.calves) {
        const created = await client.query<{ id: string }>(
          `INSERT INTO animal(account_id, property_id, species_code, name, sex, ear_tag_code,
            birth_date, entry_date, created_by, updated_by)
           VALUES($1,$2,'BOVINE',$3,$4,$5,$6,$6,$7,$7) RETURNING id`,
          [accountId, context.propertyId, calf.name, calf.sex, calf.earTagCode ?? null,
            input.occurredOn, auth.userId]);
        const calfId = created.rows[0]!.id;
        await client.query(`INSERT INTO reproduction_birth_calf(birth_id, animal_id) VALUES($1,$2)`,
          [birth.rows[0]!.id, calfId]);
        for (const owner of ownership.rows) await client.query(
          `INSERT INTO animal_ownership(account_id, property_id, animal_id, party_id,
            ownership_percent, is_primary, created_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [accountId, context.propertyId, calfId, owner.party_id,
            owner.ownership_percent, owner.is_primary, auth.userId]);
        await client.query(`INSERT INTO animal_parentage(property_id, child_animal_id,
          role, parent_animal_id, created_by) VALUES($1,$2,'MOTHER',$3,$4)`,
        [context.propertyId, calfId, pregnancy.cow_id, auth.userId]);
        if (pregnancy.father_id) await client.query(
          `INSERT INTO animal_parentage(property_id, child_animal_id, role, parent_animal_id, created_by)
           VALUES($1,$2,'FATHER',$3,$4)`,
          [context.propertyId, calfId, pregnancy.father_id, auth.userId]);
        else if (pregnancy.external_father) await client.query(
          `INSERT INTO animal_parentage(property_id, child_animal_id, role, reported_parent_name, created_by)
           VALUES($1,$2,'FATHER',$3,$4)`,
          [context.propertyId, calfId, pregnancy.external_father, auth.userId]);
        calves.push({ id: calfId, name: calf.name, sex: calf.sex });
      }
      await client.query(`UPDATE reproduction_pregnancy SET status = 'BORN',
        resolved_at = now(), resolved_by = $2 WHERE id = $1`, [pregnancy.id, auth.userId]);
      const response = { id: birth.rows[0]!.id, pregnancyId: pregnancy.id,
        motherId: pregnancy.cow_id, occurredOn: input.occurredOn, calves,
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
    await access(client, auth, context, 'REPRODUCTION_MANAGE');
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
