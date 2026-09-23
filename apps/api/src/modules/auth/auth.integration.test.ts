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
    assert.ok(platform.accounts.some((account) => account.id === registration.accountId));

    await updateAccount(platformAuth, registration.accountId, { maxProperties: 3 }, metadata);
    await updateAccountQuota(platformAuth, registration.accountId, 'MANAGED_ANIMALS', 150, metadata);
    await updateAccountModule(platformAuth, registration.accountId, 'PRODUCTION', false, metadata);

    await updateAccount(platformAuth, registration.accountId, { status: 'SUSPENDED' }, metadata);
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
    await updateAccount(platformAuth, registration.accountId, { status: 'ACTIVE' }, metadata);

    const account = await getAccountDetails(platformAuth, registration.accountId, metadata);
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
        'AUTH_LOGOUT',
      ],
    );
  } finally {
    await pool.end();
  }
});
