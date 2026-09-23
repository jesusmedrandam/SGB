import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { pool } from '../../database/pool.js';
import { createAnimal, getAnimal, listAnimals, updateAnimalBrands, updateAnimalCatalogs } from '../animals/animals.service.js';
import { createBrand, listBrands, setBrandActive } from '../animals/brands.service.js';
import {
  createCatalogItem, getCatalogReference, listCatalogItems, setCatalogItemActive,
} from '../catalogs/catalogs.service.js';
import {
  getAccountDetails,
  getPlatformOverview,
  updateAccount,
  updateAccountModule,
  updateAccountQuota,
} from '../superadmin/superadmin.service.js';
import {
  acceptPropertyInvitation,
  createPropertyInvitation,
  getInvitationPreview,
  getPropertyTeam,
  updatePropertyMembershipStatus,
} from '../collaboration/collaboration.service.js';
import {
  createAccountProperty,
  createOwnAccount,
  getPropertySettings,
  updatePropertyModule,
} from '../properties/properties.service.js';
import {
  getSessionOverview,
  login,
  logout,
  register,
  resendEmailVerification,
  verifyEmail,
} from './auth.service.js';

const metadata = { ipAddress: '127.0.0.1', userAgent: 'sgb-integration-test' };

test('registro, verificación, sesión y auditoría funcionan contra PostgreSQL', async () => {
  const suffix = randomUUID();
  const email = `integration-${suffix}@example.test`;
  const password = 'Clave-segura-2026';

  try {
    const registration = await register({
      email,
      password,
      displayName: 'Prueba de integración',
      propertyName: `Finca ${suffix}`,
    }, metadata);

    assert.match(registration.userId, /^[0-9a-f-]{36}$/);
    assert.ok(registration.accountId);
    assert.ok(registration.propertyId);
    const accountId = registration.accountId;
    await pool.query(
      `UPDATE email_verification_token
          SET created_at = now() - interval '2 minutes'
        WHERE user_id = $1`,
      [registration.userId],
    );
    const resent = await resendEmailVerification(email, metadata);
    assert.ok(resent.verificationToken);
    await verifyEmail(resent.verificationToken, metadata);

    const session = await login({
      email,
      password,
      deviceId: `integration-${suffix}`,
      deviceName: 'GitHub Actions',
    }, metadata);

    assert.equal(session.user.email, email);
    assert.equal(session.user.isSuperadmin, false);
    assert.equal(session.activePropertyId, registration.propertyId);
    assert.ok(session.activeRoleId);

    const overview = await getSessionOverview({
      sessionId: session.sessionId,
      userId: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      isSuperadmin: session.user.isSuperadmin,
      activePropertyId: session.activePropertyId,
      activeRoleId: session.activeRoleId,
    });

    assert.equal(overview.properties.length, 1);
    assert.equal(overview.properties[0]?.id, registration.propertyId);
    assert.ok(overview.properties[0]?.roles.some((role) => role.code === 'OWNER'));

    const ownerProperty = overview.properties[0]!;
    const ownerRole = ownerProperty.roles.find((role) => role.code === 'OWNER')!;
    const ownerAuth = {
      sessionId: session.sessionId,
      userId: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      isSuperadmin: false,
      activePropertyId: ownerProperty.id,
      activeRoleId: ownerRole.id,
    };
    const ownerContext = {
      propertyId: ownerProperty.id,
      propertyName: ownerProperty.name,
      roleId: ownerRole.id,
      roleCode: ownerRole.code,
      roleName: ownerRole.name,
      permissions: new Set(ownerRole.permissions),
      enabledModules: new Set(ownerProperty.enabledModules),
      enabledSpecies: new Set(ownerProperty.enabledSpecies),
    };

    const brand = await createBrand(ownerAuth, ownerContext, `M7L-${suffix}`, metadata);
    assert.equal((await listBrands(ownerContext))[0]?.id, brand.id);
    await assert.rejects(
      () => createBrand(ownerAuth, ownerContext, `m7l-${suffix}`, metadata),
      (error: { code?: string }) => error.code === 'BRAND_NAME_TAKEN',
    );
    const animal = await createAnimal(ownerAuth, ownerContext, {
      name: 'Primera vaca', sex: 'FEMALE', speciesCode: 'BOVINE',
      earTagCode: `TAG-${suffix}`, birthDate: '2020-01-02', entryDate: '2021-01-03',
      initialWeight: 150.5, initialWeightUnitCode: 'KILOGRAM',
      brandIds: [brand.id],
    }, metadata);
    assert.equal(animal.birthDate, '2020-01-02');
    assert.equal(animal.entryDate, '2021-01-03');
    assert.equal(animal.initialWeight, 150.5);
    assert.deepEqual(animal.brands.map((entry) => entry.id), [brand.id]);
    assert.equal((await getAnimal(ownerContext, animal.id)).id, animal.id);
    assert.equal((await listAnimals(ownerContext, 1, 'tag-')).items[0]?.id, animal.id);
    assert.equal((await listAnimals(ownerContext, 1, 'm7l-')).items[0]?.id, animal.id);
    const anotherBrand = await createBrand(ownerAuth, ownerContext, `ABC-${suffix}`, metadata);
    const withBrands = await updateAnimalBrands(ownerAuth, ownerContext, animal.id,
      [brand.id, anotherBrand.id], animal.version, metadata);
    assert.equal(withBrands.brands.length, 2);
    await assert.rejects(
      () => updateAnimalBrands(ownerAuth, ownerContext, animal.id,
        [brand.id], animal.version, metadata),
      (error: { code?: string }) => error.code === 'ANIMAL_VERSION_CONFLICT',
    );
    await setBrandActive(ownerAuth, ownerContext, brand.id, false, metadata);
    assert.equal((await getAnimal(ownerContext, animal.id)).brands.length, 2);
    await assert.rejects(
      () => createAnimal(ownerAuth, ownerContext, {
        name: 'Otra vaca', sex: 'FEMALE', speciesCode: 'BOVINE', brandIds: [brand.id],
      }, metadata),
      (error: { code?: string }) => error.code === 'INVALID_ANIMAL_BRANDS',
    );
    await assert.rejects(
      () => createAnimal(ownerAuth, ownerContext, {
        name: 'Marquilla inexistente', sex: 'FEMALE', speciesCode: 'BOVINE', brandIds: [randomUUID()],
      }, metadata),
      (error: { code?: string }) => error.code === 'INVALID_ANIMAL_BRANDS',
    );
    const fewerBrands = await updateAnimalBrands(ownerAuth, ownerContext, animal.id,
      [anotherBrand.id], withBrands.version, metadata);
    assert.deepEqual(fewerBrands.brands.map((entry) => entry.id), [anotherBrand.id]);
    const brandHistory = await pool.query<{ ended_at: Date | null }>(
      `SELECT ended_at FROM animal_brand_assignment WHERE animal_id = $1 AND brand_id = $2`,
      [animal.id, brand.id],
    );
    assert.ok(brandHistory.rows[0]?.ended_at);
    await assert.rejects(
      () => createAnimal(ownerAuth, ownerContext, {
        name: 'Duplicada', sex: 'FEMALE', speciesCode: 'BOVINE', earTagCode: `tag-${suffix}`,
      }, metadata),
      (error: { code?: string }) => error.code === 'ANIMAL_TAG_TAKEN',
    );
    await assert.rejects(
      () => createAnimal(ownerAuth, ownerContext, {
        name: 'Fecha inválida', sex: 'MALE', speciesCode: 'BOVINE',
        birthDate: '2024-01-02', entryDate: '2023-01-01',
      }, metadata),
      (error: { code?: string }) => error.code === 'INVALID_ANIMAL_DATES',
    );
    await assert.rejects(
      () => createAnimal(ownerAuth, ownerContext, {
        name: 'Peso inválido', sex: 'MALE', speciesCode: 'BOVINE',
        initialWeight: 10, initialWeightUnitCode: 'HECTARE',
      }, metadata),
      (error: { code?: string }) => error.code === 'INVALID_WEIGHT_UNIT',
    );
    const viewer = await pool.query<{ id: string }>(
      `SELECT id FROM property_role WHERE property_id = $1 AND code = 'VIEWER'`,
      [ownerContext.propertyId],
    );
    await assert.rejects(
      () => createAnimal({ ...ownerAuth, activeRoleId: viewer.rows[0]!.id },
        { ...ownerContext, roleId: viewer.rows[0]!.id },
        { name: 'Sin permiso', sex: 'MALE', speciesCode: 'BOVINE' }, metadata),
      (error: { code?: string }) => error.code === 'ANIMAL_CREATE_DENIED',
    );

    const reference = await getCatalogReference(ownerContext);
    assert.ok(reference.species.some((species) => species.code === 'BOVINE'));
    assert.ok(reference.units.some((unit) => unit.contextCode === 'ANIMAL_WEIGHT' && unit.code === 'KILOGRAM'));
    assert.ok(reference.units.every((unit) => unit.contextCode !== 'ANIMAL_WEIGHT' || unit.code !== 'HECTARE'));
    const breed = await createCatalogItem(ownerAuth, ownerContext, 'BREEDS',
      { name: `Raza ${suffix}`, speciesCode: 'BOVINE' }, metadata);
    const color = await createCatalogItem(ownerAuth, ownerContext, 'COLORS',
      { name: `Color ${suffix}`, speciesCode: 'BOVINE' }, metadata);
    assert.equal((await listCatalogItems(ownerContext, 'BREEDS')).find((row) => row.id === breed.id)?.active, true);
    await assert.rejects(
      () => createCatalogItem(ownerAuth, ownerContext, 'BREEDS', { name: `Raza ${suffix}` }, metadata),
      (error: { code?: string }) => error.code === '23505',
    );
    const decorated = await createAnimal(ownerAuth, ownerContext, {
      name: 'Vaca con colores', sex: 'FEMALE', speciesCode: 'BOVINE',
      breedId: breed.id, colorIds: [color.id],
    }, metadata);
    assert.equal(decorated.breed?.id, breed.id);
    assert.deepEqual(decorated.colors.map((entry) => entry.id), [color.id]);
    await assert.rejects(
      () => createAnimal(ownerAuth, ownerContext, {
        name: 'Color como raza', sex: 'FEMALE', speciesCode: 'BOVINE', breedId: color.id,
      }, metadata),
      (error: { code?: string }) => error.code === 'INVALID_ANIMAL_CATALOG_SELECTION',
    );
    await setCatalogItemActive(ownerAuth, ownerContext, 'BREEDS', breed.id, false, metadata);
    assert.equal((await listCatalogItems(ownerContext, 'BREEDS')).find((row) => row.id === breed.id)?.active, false);
    assert.equal((await getAnimal(ownerContext, decorated.id)).breed?.id, breed.id);
    const changed = await updateAnimalCatalogs(ownerAuth, ownerContext, decorated.id,
      { breedId: breed.id, colorIds: [] }, decorated.version, metadata);
    assert.equal(changed.breed?.id, breed.id);
    assert.deepEqual(changed.colors, []);
    assert.equal(changed.version, decorated.version + 1);
    await assert.rejects(
      () => updateAnimalCatalogs(ownerAuth, ownerContext, decorated.id,
        { breedId: breed.id, colorIds: [color.id] }, decorated.version, metadata),
      (error: { code?: string }) => error.code === 'ANIMAL_VERSION_CONFLICT',
    );
    const history = await pool.query<{ ended_at: Date | null }>(
      `SELECT ended_at FROM animal_catalog_assignment
       WHERE animal_id = $1 AND catalog_item_id = $2`, [decorated.id, color.id],
    );
    assert.ok(history.rows[0]?.ended_at);
    await assert.rejects(
      () => pool.query(`DELETE FROM animal_catalog_assignment WHERE animal_id = $1`, [decorated.id]),
      (error: { code?: string }) => error.code === '23514',
    );

    const initialTeam = await getPropertyTeam(ownerAuth, ownerContext);
    const operatorRole = initialTeam.assignableRoles.find((role) => role.code === 'OPERATOR');
    assert.ok(operatorRole);
    const collaboratorEmail = `collaborator-${suffix}@example.test`;
    const invitation = await createPropertyInvitation(ownerAuth, ownerContext, {
      email: collaboratorEmail,
      roleIds: [operatorRole.id],
      jobTitle: 'Encargado de campo',
      payAmount: 520,
      payFrequency: 'MONTHLY',
      employmentNotes: 'Prueba de ciclo completo',
    }, metadata);
    const invitationPreview = await getInvitationPreview(invitation.invitationToken);
    assert.equal(invitationPreview.email, collaboratorEmail);
    assert.equal(invitationPreview.existingUser, false);
    assert.equal(invitationPreview.roles[0]?.code, 'OPERATOR');

    const collaboratorRegistration = await register({
      email: collaboratorEmail,
      password,
      displayName: 'Colaborador de integración',
      invitationToken: invitation.invitationToken,
    }, metadata);
    assert.equal(collaboratorRegistration.accountId, null);
    assert.equal(collaboratorRegistration.propertyId, null);
    assert.equal(collaboratorRegistration.invitationId, invitation.id);
    await verifyEmail(collaboratorRegistration.verificationToken, metadata);
    const collaboratorSession = await login({
      email: collaboratorEmail,
      password,
      deviceId: `collaborator-${suffix}`,
      deviceName: 'GitHub Actions',
    }, metadata);
    assert.equal(collaboratorSession.activePropertyId, null);

    const collaboratorAuth = {
      sessionId: collaboratorSession.sessionId,
      userId: collaboratorSession.user.id,
      email: collaboratorSession.user.email,
      displayName: collaboratorSession.user.displayName,
      isSuperadmin: false,
      activePropertyId: collaboratorSession.activePropertyId,
      activeRoleId: collaboratorSession.activeRoleId,
    };
    const accepted = await acceptPropertyInvitation(collaboratorAuth, invitation.invitationToken, metadata);
    assert.equal(accepted.propertyId, ownerProperty.id);
    assert.equal(accepted.roles[0]?.code, 'OPERATOR');

    const activeCollaboratorAuth = {
      ...collaboratorAuth,
      activePropertyId: accepted.propertyId,
      activeRoleId: accepted.roleId,
    };
    const collaboratorOverview = await getSessionOverview(activeCollaboratorAuth);
    assert.equal(collaboratorOverview.properties.length, 1);
    assert.equal(collaboratorOverview.properties[0]?.roles[0]?.code, 'OPERATOR');
    const collaboratorProperty = collaboratorOverview.properties[0]!;
    const collaboratorRole = collaboratorProperty.roles[0]!;
    const operatorContext = {
      propertyId: collaboratorProperty.id,
      propertyName: collaboratorProperty.name,
      roleId: collaboratorRole.id,
      roleCode: collaboratorRole.code,
      roleName: collaboratorRole.name,
      permissions: new Set(collaboratorRole.permissions),
      enabledModules: new Set(collaboratorProperty.enabledModules),
      enabledSpecies: new Set(collaboratorProperty.enabledSpecies),
    };
    assert.ok((await listCatalogItems(operatorContext, 'COLORS')).some((row) => row.id === color.id));
    await assert.rejects(
      () => createCatalogItem(activeCollaboratorAuth, operatorContext, 'COLORS',
        { name: `Sin permiso ${suffix}` }, metadata),
      (error: { code?: string }) => error.code === 'CATALOG_MANAGE_DENIED',
    );
    const collaboratorTeam = await getPropertyTeam(activeCollaboratorAuth, {
      propertyId: collaboratorProperty.id,
      propertyName: collaboratorProperty.name,
      roleId: collaboratorRole.id,
      roleCode: collaboratorRole.code,
      roleName: collaboratorRole.name,
      permissions: new Set(collaboratorRole.permissions),
      enabledModules: new Set(collaboratorProperty.enabledModules),
      enabledSpecies: new Set(collaboratorProperty.enabledSpecies),
    });
    assert.equal(collaboratorTeam.canManage, false);
    assert.ok(collaboratorTeam.members.every((member) => member.payment === null));
    const acceptedTeam = await getPropertyTeam(ownerAuth, ownerContext);
    const collaboratorMembership = acceptedTeam.members.find((member) => member.userId === collaboratorSession.user.id);
    assert.ok(collaboratorMembership);
    assert.equal(collaboratorMembership.payment?.amount, 520);
    assert.equal(acceptedTeam.quota.used, 1);

    const collaboratorOwned = await createOwnAccount(activeCollaboratorAuth, `Mi finca ${suffix}`, metadata);
    assert.ok(collaboratorOwned.accountId);
    assert.notEqual(collaboratorOwned.accountId, accountId);
    const collaboratorOwnOverview = await getSessionOverview({
      ...activeCollaboratorAuth,
      activePropertyId: collaboratorOwned.propertyId,
      activeRoleId: collaboratorOwned.roleId,
    });
    assert.equal(collaboratorOwnOverview.properties.length, 2);
    assert.equal(collaboratorOwnOverview.ownedAccount?.id, collaboratorOwned.accountId);
    assert.equal(collaboratorOwnOverview.properties.find((item) => item.id === collaboratorOwned.propertyId)?.isOwner, true);
    await assert.rejects(
      () => createOwnAccount(activeCollaboratorAuth, `Duplicada ${suffix}`, metadata),
      (error: { code?: string }) => error.code === 'ACCOUNT_ALREADY_EXISTS',
    );

    await updatePropertyMembershipStatus(ownerAuth, ownerContext, collaboratorMembership.id, 'SUSPENDED', metadata);
    const suspendedCollaborator = await getSessionOverview(activeCollaboratorAuth);
    assert.deepEqual(suspendedCollaborator.properties.map((item) => item.id), [collaboratorOwned.propertyId]);
    assert.equal((await getPropertyTeam(ownerAuth, ownerContext)).quota.used, 1);
    await updatePropertyMembershipStatus(ownerAuth, ownerContext, collaboratorMembership.id, 'ACTIVE', metadata);
    assert.equal((await getSessionOverview(activeCollaboratorAuth)).properties.length, 2);
    await logout(collaboratorSession.accessToken, collaboratorSession.refreshToken, metadata);

    const superadmin = await pool.query<{
      id: string; email: string; display_name: string;
    }>(
      `SELECT id, email::text, display_name
         FROM app_user
         WHERE is_superadmin AND deleted_at IS NULL`,
    );
    const superadminSession = await pool.query<{ id: string }>(
      `INSERT INTO user_session(
         user_id, refresh_token_hash, access_token_hash, device_id,
         access_expires_at, expires_at
       ) VALUES($1,$2,$3,$4,now() + interval '15 minutes',now() + interval '1 day')
       RETURNING id`,
      [superadmin.rows[0]!.id, `test-refresh-${suffix}`, `test-access-${suffix}`, `superadmin-${suffix}`],
    );
    const platformAuth = {
      sessionId: superadminSession.rows[0]!.id,
      userId: superadmin.rows[0]!.id,
      email: superadmin.rows[0]!.email,
      displayName: superadmin.rows[0]!.display_name,
      isSuperadmin: true,
      activePropertyId: null,
      activeRoleId: null,
    };

    const platform = await getPlatformOverview(platformAuth, metadata);
    assert.ok(platform.accounts.some((account) => account.id === accountId));

    const superadminProperty = await createOwnAccount(platformAuth, `Finca admin ${suffix}`, metadata);
    assert.notEqual(superadminProperty.accountId, accountId);
    const superadminSessionContext = await pool.query<{
      active_property_id: string; active_role_id: string;
    }>(
      `SELECT active_property_id, active_role_id FROM user_session WHERE id = $1`,
      [platformAuth.sessionId],
    );
    assert.equal(superadminSessionContext.rows[0]?.active_property_id, superadminProperty.propertyId);
    assert.equal(superadminSessionContext.rows[0]?.active_role_id, superadminProperty.roleId);
    const superadminPropertyAuth = {
      ...platformAuth,
      activePropertyId: superadminProperty.propertyId,
      activeRoleId: superadminProperty.roleId,
    };
    const superadminOverview = await getSessionOverview(superadminPropertyAuth);
    assert.equal(superadminOverview.user.isSuperadmin, true);
    assert.equal(superadminOverview.ownedAccount?.id, superadminProperty.accountId);
    assert.equal(superadminOverview.properties[0]?.roles[0]?.code, 'OWNER');
    assert.ok(superadminOverview.enabledUserModules.includes('PERSONAL_FINANCE'));
    assert.ok((await getPlatformOverview(superadminPropertyAuth, metadata)).accounts.some(
      (item) => item.id === accountId,
    ));
    await assert.rejects(
      () => createOwnAccount(superadminPropertyAuth, `Otra cuenta ${suffix}`, metadata),
      (error: { code?: string }) => error.code === 'ACCOUNT_ALREADY_EXISTS',
    );
    await updateAccount(superadminPropertyAuth, superadminProperty.accountId,
      { maxProperties: 2 }, metadata);
    const superadminRole = superadminOverview.properties[0]!.roles[0]!;
    const secondSuperadminProperty = await createAccountProperty(superadminPropertyAuth, {
      propertyId: superadminProperty.propertyId,
      propertyName: `Finca admin ${suffix}`,
      roleId: superadminRole.id,
      roleCode: superadminRole.code,
      roleName: superadminRole.name,
      permissions: new Set(superadminRole.permissions),
      enabledModules: new Set(superadminOverview.properties[0]!.enabledModules),
      enabledSpecies: new Set(superadminOverview.properties[0]!.enabledSpecies),
    }, `Segunda finca admin ${suffix}`, metadata);
    assert.equal(secondSuperadminProperty.accountId, superadminProperty.accountId);
    assert.equal((await getSessionOverview({ ...superadminPropertyAuth,
      activePropertyId: secondSuperadminProperty.propertyId,
      activeRoleId: secondSuperadminProperty.roleId,
    })).properties.length, 2);

    await updateAccount(platformAuth, accountId, { maxProperties: 3 }, metadata);
    await updateAccountQuota(platformAuth, accountId, 'MANAGED_ANIMALS', 1, metadata);
    await assert.rejects(
      () => createAnimal(ownerAuth, ownerContext,
        { name: 'Fuera de cupo', sex: 'MALE', speciesCode: 'BOVINE' }, metadata),
      (error: { code?: string }) => error.code === 'ANIMAL_LIMIT_REACHED',
    );
    await updateAccountQuota(platformAuth, accountId, 'MANAGED_ANIMALS', 150, metadata);
    await updateAccountModule(platformAuth, accountId, 'PRODUCTION', false, metadata);

    const sourceSettings = await getPropertySettings(ownerContext);
    assert.equal(sourceSettings.account.usedProperties, 1);
    assert.equal(sourceSettings.modules.find((item) => item.code === 'PRODUCTION')?.accountEnabled, false);
    await assert.rejects(
      () => updatePropertyModule(ownerAuth, ownerContext, 'PRODUCTION', true, metadata),
      (error: { code?: string }) => error.code === 'ACCOUNT_MODULE_DISABLED',
    );
    const nextProperty = await createAccountProperty(ownerAuth, ownerContext, `Segunda ${suffix}`, metadata);
    assert.equal(nextProperty.accountId, accountId);
    const secondContext = { ...ownerContext, propertyId: nextProperty.propertyId, roleId: nextProperty.roleId };
    await assert.rejects(
      () => createAnimal(ownerAuth, secondContext, {
        name: 'Color ajeno', sex: 'MALE', speciesCode: 'BOVINE', colorIds: [color.id],
      }, metadata),
      (error: { code?: string }) => error.code === 'INVALID_ANIMAL_CATALOG_SELECTION',
    );
    await assert.rejects(
      () => getAnimal(secondContext, animal.id),
      (error: { code?: string }) => error.code === 'ANIMAL_NOT_FOUND',
    );
    const secondAnimal = await createAnimal(ownerAuth, secondContext,
      { name: 'Vaca de la segunda finca', sex: 'FEMALE', speciesCode: 'BOVINE' }, metadata);
    const localToday = await pool.query<{ today: string }>(
      `SELECT to_char((now() AT TIME ZONE timezone)::date, 'YYYY-MM-DD') AS today
       FROM property WHERE id = $1`, [nextProperty.propertyId],
    );
    assert.equal(secondAnimal.entryDate, localToday.rows[0]?.today);
    assert.equal((await listAnimals(ownerContext, 1, '')).items.some((row) => row.id === secondAnimal.id), false);
    assert.equal((await listCatalogItems(secondContext, 'BREEDS')).some((row) => row.id === breed.id), false);
    await assert.rejects(
      () => setCatalogItemActive(ownerAuth, secondContext, 'COLORS', color.id, false, metadata),
      (error: { code?: string }) => error.code === 'CATALOG_ITEM_UNAVAILABLE',
    );
    await updatePropertyModule(ownerAuth, secondContext, 'WEIGHING', false, metadata);
    const secondSettings = await getPropertySettings(secondContext);
    assert.equal(secondSettings.modules.find((item) => item.code === 'WEIGHING')?.enabled, false);
    assert.equal((await getPropertySettings(ownerContext)).modules.find((item) => item.code === 'WEIGHING')?.enabled, true);
    const thirdProperty = await createAccountProperty(ownerAuth, ownerContext, `Tercera ${suffix}`, metadata);
    assert.ok(thirdProperty.propertyId);
    await assert.rejects(
      () => createAccountProperty(ownerAuth, ownerContext, `Cuarta ${suffix}`, metadata),
      (error: { code?: string }) => error.code === 'PROPERTY_LIMIT_REACHED',
    );

    await updateAccount(platformAuth, accountId, { status: 'SUSPENDED' }, metadata);
    const suspendedOverview = await getSessionOverview({
      sessionId: session.sessionId,
      userId: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      isSuperadmin: false,
      activePropertyId: session.activePropertyId,
      activeRoleId: session.activeRoleId,
    });
    assert.equal(suspendedOverview.properties.length, 0);
    await updateAccount(platformAuth, accountId, { status: 'ACTIVE' }, metadata);

    const account = await getAccountDetails(platformAuth, accountId, metadata);
    assert.equal(account.account.maxProperties, 3);
    assert.equal(account.quotas.find((quota) => quota.code === 'MANAGED_ANIMALS')?.limitValue, 150);
    assert.equal(account.modules.find((module) => module.code === 'PRODUCTION')?.enabled, false);

    await logout(session.accessToken, session.refreshToken, metadata);

    const audit = await pool.query<{ action: string }>(
      `SELECT action
         FROM audit_event
        WHERE actor_user_id = $1
        ORDER BY id`,
      [registration.userId],
    );
    assert.deepEqual(
      audit.rows.map((row) => row.action),
      [
        'ACCOUNT_REGISTERED',
        'EMAIL_VERIFICATION_REQUESTED',
        'EMAIL_VERIFIED',
        'AUTH_LOGIN',
        'ANIMAL_CREATED',
        'CATALOG_ITEM_CREATED',
        'CATALOG_ITEM_CREATED',
        'ANIMAL_CREATED',
        'CATALOG_ITEM_STATE_CHANGED',
        'ANIMAL_CATALOGS_UPDATED',
        'PROPERTY_INVITATION_CREATED',
        'PROPERTY_MEMBERSHIP_STATUS_CHANGED',
        'PROPERTY_MEMBERSHIP_STATUS_CHANGED',
        'PROPERTY_CREATED',
        'ANIMAL_CREATED',
        'PROPERTY_MODULE_UPDATED',
        'PROPERTY_CREATED',
        'AUTH_LOGOUT',
      ],
    );
  } finally {
    await pool.end();
  }
});
