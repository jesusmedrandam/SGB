import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { pool } from '../../database/pool.js';
import { createAnimal, getAnimal } from '../animals/animals.service.js';
import { createOwner } from '../animals/owners.service.js';
import { getSessionOverview, login, register, resendEmailVerification, verifyEmail } from '../auth/auth.service.js';
import { createHeat, createPregnancy, getReproductionSettings, listReproduction,
  recordBirth, recordLoss, updateReproductionSettings } from './reproduction.service.js';

const metadata = { ipAddress: '127.0.0.1', userAgent: 'sgb-reproduction-test' };

test('la reproducción conserva propiedad, parentesco, espera y auditoría', async () => {
  const suffix = randomUUID();
  const email = `reproduction-${suffix}@example.test`;
  try {
    const registration = await register({ email, password: 'Clave-segura-2026',
      displayName: 'Reproducción', propertyName: `Finca reproductiva ${suffix}` }, metadata);
    await pool.query(`UPDATE email_verification_token SET created_at = now() - interval '2 minutes'
      WHERE user_id = $1`, [registration.userId]);
    const resend = await resendEmailVerification(email, metadata);
    await verifyEmail(resend.verificationToken!, metadata);
    const session = await login({ email, password: 'Clave-segura-2026',
      deviceId: `reproduction-${suffix}`, deviceName: 'GitHub Actions' }, metadata);
    const overview = await getSessionOverview({ sessionId: session.sessionId,
      userId: session.user.id, email: session.user.email,
      displayName: session.user.displayName, isSuperadmin: false,
      activePropertyId: session.activePropertyId, activeRoleId: session.activeRoleId });
    const property = overview.properties[0]!;
    const role = property.roles.find((entry) => entry.code === 'OWNER')!;
    assert.ok(role.permissions.includes('REPRODUCTION_MANAGE'));
    const auth = { sessionId: session.sessionId, userId: session.user.id,
      email: session.user.email, displayName: session.user.displayName,
      isSuperadmin: false, activePropertyId: property.id, activeRoleId: role.id };
    const context = { propertyId: property.id, propertyName: property.name,
      roleId: role.id, roleCode: role.code, roleName: role.name,
      permissions: new Set(role.permissions), enabledModules: new Set(property.enabledModules),
      enabledSpecies: new Set(property.enabledSpecies) };
    await pool.query(`INSERT INTO account_module(account_id, module_code, enabled, configured_by)
      VALUES($1,'REPRODUCTION',true,$2) ON CONFLICT(account_id,module_code)
      DO UPDATE SET enabled = true`, [registration.accountId, auth.userId]);
    await pool.query(`INSERT INTO property_module(property_id, module_code, enabled, configured_by)
      VALUES($1,'REPRODUCTION',true,$2) ON CONFLICT(property_id,module_code)
      DO UPDATE SET enabled = true`, [property.id, auth.userId]);

    const owner = await createOwner(auth, context, { kind: 'USER', userId: auth.userId }, metadata);
    const mother = await createAnimal(auth, context, { name: 'Madre de prueba', sex: 'FEMALE',
      speciesCode: 'BOVINE', birthDate: '2019-01-01', entryDate: '2022-01-01',
      owners: [{ partyId: owner.id, percent: 100, isPrimary: true }] }, metadata);
    const father = await createAnimal(auth, context, { name: 'Padre de prueba', sex: 'MALE',
      speciesCode: 'BOVINE', birthDate: '2018-01-01', entryDate: '2022-01-01',
      owners: [{ partyId: owner.id, percent: 100, isPrimary: true }] }, metadata);

    await assert.rejects(() => createHeat(auth, context, {
      cowId: father.id, startsOn: '2023-01-10', isFalse: false }, metadata),
    (error: { code?: string }) => error.code === 'REPRODUCTION_ANIMAL_UNAVAILABLE');
    const heat = await createHeat(auth, context, { cowId: mother.id, bullId: father.id,
      startsOn: '2023-01-10', isFalse: false }, metadata);
    const defaults = await getReproductionSettings(context);
    assert.equal(defaults.daysAfterBirthHeat, 30);
    await updateReproductionSettings(auth, context, { ...defaults, allowSecondHeat: false }, metadata);
    await assert.rejects(() => createHeat(auth, context,
      { cowId: mother.id, startsOn: '2023-01-20', isFalse: false }, metadata),
    (error: { code?: string }) => error.code === 'SECOND_HEAT_DISABLED');
    await updateReproductionSettings(auth, context, defaults, metadata);
    const pregnancy = await createPregnancy(auth, context, {
      cowId: mother.id, heatId: heat.id,
      conceptionMethod: 'NATURAL', confirmationMethod: 'PALPATION',
      confirmedOn: '2023-02-01' }, metadata);
    assert.equal(pregnancy.fatherId, father.id);
    assert.equal(pregnancy.gestationDays, 22);
    assert.equal(pregnancy.expectedBirthOn, '2023-10-20');
    await assert.rejects(() => createPregnancy(auth, context, {
      cowId: mother.id, conceptionMethod: 'NATURAL', confirmationMethod: 'PALPATION',
      confirmedOn: '2023-02-02' }, metadata),
    (error: { code?: string }) => error.code === 'PREGNANCY_CONFIRMED');
    await assert.rejects(() => createHeat(auth, context,
      { cowId: mother.id, startsOn: '2023-04-01', isFalse: false }, metadata),
    (error: { code?: string }) => error.code === 'PREGNANCY_CONFIRMED');
    await updateReproductionSettings(auth, context,
      { ...defaults, allowFalseHeatInPregnancy: false }, metadata);
    await assert.rejects(() => createHeat(auth, context,
      { cowId: mother.id, startsOn: '2023-04-01', isFalse: true }, metadata),
    (error: { code?: string }) => error.code === 'FALSE_HEAT_DISABLED');
    await updateReproductionSettings(auth, context, defaults, metadata);

    const birth = await recordBirth(auth, context, { pregnancyId: pregnancy.id,
      occurredOn: '2023-10-20', stillbornCount: 1,
      calves: [{ name: 'Cría de prueba', sex: 'FEMALE' }] }, metadata);
    assert.equal(birth.liveCount, 1);
    const calf = await getAnimal(context, birth.calves[0]!.id);
    assert.equal(calf.birthDate, '2023-10-20');
    assert.equal(calf.mother?.animalId, mother.id);
    assert.equal(calf.father?.animalId, father.id);
    assert.equal(calf.owners[0]?.id, owner.id);
    await assert.rejects(() => recordBirth(auth, context, { pregnancyId: pregnancy.id,
      occurredOn: '2023-10-20', stillbornCount: 1, calves: [] }, metadata),
    (error: { code?: string }) => error.code === 'PREGNANCY_FINISHED');
    await assert.rejects(() => createHeat(auth, context,
      { cowId: mother.id, startsOn: '2023-10-30', isFalse: false }, metadata),
    (error: { code?: string }) => error.code === 'REPRODUCTION_WAITING_PERIOD');

    await createHeat(auth, context, { cowId: mother.id,
      startsOn: '2023-12-01', isFalse: false }, metadata);
    const nextPregnancy = await createPregnancy(auth, context, { cowId: mother.id,
      conceptionMethod: 'NATURAL', confirmationMethod: 'ULTRASOUND',
      confirmedOn: '2024-01-15' }, metadata);
    assert.equal(nextPregnancy.gestationDays, 45);
    await recordLoss(auth, context, { pregnancyId: nextPregnancy.id,
      occurredOn: '2024-05-01', notes: 'Pérdida registrada' }, metadata);
    await assert.rejects(() => createHeat(auth, context,
      { cowId: mother.id, startsOn: '2024-05-05', isFalse: false }, metadata),
    (error: { code?: string }) => error.code === 'REPRODUCTION_WAITING_PERIOD');
    const history = await listReproduction(context);
    assert.equal(history.births.length, 1);
    assert.equal(history.losses.length, 1);
    assert.equal(history.pregnancies.length, 2);
    assert.equal(history.pregnancies.find((row) => row.id === pregnancy.id)?.status, 'BORN');
    const wrongProperty = { ...context, propertyId: randomUUID() };
    assert.equal((await listReproduction(wrongProperty)).births.length, 0);
    await assert.rejects(() => createHeat(auth, wrongProperty,
      { cowId: mother.id, startsOn: '2024-06-01', isFalse: false }, metadata),
    (error: { code?: string }) => error.code === 'REPRODUCTION_DENIED');
    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_event WHERE actor_user_id = $1 AND action LIKE 'REPRODUCTION_%'`,
      [auth.userId]);
    assert.ok(audit.rows.some((row) => row.action === 'REPRODUCTION_BIRTH_REGISTERED'));
    assert.ok(audit.rows.some((row) => row.action === 'REPRODUCTION_LOSS_REGISTERED'));
  } finally { await pool.end(); }
});
