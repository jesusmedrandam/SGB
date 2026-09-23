import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { pool } from '../../database/pool.js';
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

    await updatePropertyMembershipStatus(ownerAuth, ownerContext, collaboratorMembership.id, 'SUSPENDED', metadata);
    assert.equal((await getSessionOverview(activeCollaboratorAuth)).properties.length, 0);
    assert.equal((await getPropertyTeam(ownerAuth, ownerContext)).quota.used, 1);
    await updatePropertyMembershipStatus(ownerAuth, ownerContext, collaboratorMembership.id, 'ACTIVE', metadata);
    assert.equal((await getSessionOverview(activeCollaboratorAuth)).properties.length, 1);
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
        'PROPERTY_INVITATION_CREATED',
        'PROPERTY_MEMBERSHIP_STATUS_CHANGED',
        'PROPERTY_MEMBERSHIP_STATUS_CHANGED',
        'AUTH_LOGOUT',
      ],
    );
  } finally {
    await pool.end();
  }
});
