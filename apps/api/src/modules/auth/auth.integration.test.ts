import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { pool } from '../../database/pool.js';
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
    await setCatalogItemActive(ownerAuth, ownerContext, 'BREEDS', breed.id, false, metadata);
    assert.equal((await listCatalogItems(ownerContext, 'BREEDS')).find((row) => row.id === breed.id)?.active, false);

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
    const platformAuth = {
      sessionId: randomUUID(),
      userId: superadmin.rows[0]!.id,
      email: superadmin.rows[0]!.email,
      displayName: superadmin.rows[0]!.display_name,
      isSuperadmin: true,
      activePropertyId: null,
      activeRoleId: null,
    };

    const platform = await getPlatformOverview(platformAuth, metadata);
    assert.ok(platform.accounts.some((account) => account.id === accountId));

    await updateAccount(platformAuth, accountId, { maxProperties: 3 }, metadata);
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
        'CATALOG_ITEM_CREATED',
        'CATALOG_ITEM_CREATED',
        'CATALOG_ITEM_STATE_CHANGED',
        'PROPERTY_INVITATION_CREATED',
        'PROPERTY_MEMBERSHIP_STATUS_CHANGED',
        'PROPERTY_MEMBERSHIP_STATUS_CHANGED',
        'PROPERTY_CREATED',
        'PROPERTY_MODULE_UPDATED',
        'PROPERTY_CREATED',
        'AUTH_LOGOUT',
      ],
    );
  } finally {
    await pool.end();
  }
});
