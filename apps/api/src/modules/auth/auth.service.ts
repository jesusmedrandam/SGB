import type { PoolClient, QueryResultRow } from 'pg';
import { env } from '../../config.js';
import { ApiError, conflict, forbidden, unauthorized } from '../../core/errors.js';
import { pool } from '../../database/pool.js';
import { inTransaction } from '../../database/transaction.js';
import { hashPassword, verifyPassword } from '../../security/password.js';
import { hashToken, issueToken, type IssuedToken } from '../../security/tokens.js';
import { sendVerificationEmail,sendPasswordResetEmail } from '../../services/email.service.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';
import type { AuthState, RequestMetadata } from './auth.types.js';

interface UserRow extends QueryResultRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
  is_superadmin: boolean;
  failed_login_count: number;
  locked_until: Date | null;
}

interface ContextRow extends QueryResultRow {
  property_id: string;
  role_id: string;
}

interface SessionRow extends QueryResultRow {
  id: string;
  user_id: string;
  active_property_id: string | null;
  active_role_id: string | null;
  expires_at: Date;
  status: UserRow['status'];
  email: string;
  display_name: string;
  is_superadmin: boolean;
}

interface SessionTokens {
  access: IssuedToken;
  refresh: IssuedToken;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

const addMilliseconds = (milliseconds: number) => new Date(Date.now() + milliseconds);

function createSessionTokens(): SessionTokens {
  return {
    access: issueToken('access'),
    refresh: issueToken('refresh'),
    accessExpiresAt: addMilliseconds(env.ACCESS_TOKEN_TTL_MINUTES * 60 * 1000),
    refreshExpiresAt: addMilliseconds(env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
  };
}

async function initialContext(client: PoolClient, userId: string): Promise<ContextRow | null> {
  const result = await client.query<ContextRow>(
    `SELECT pm.property_id, pr.id AS role_id
       FROM property_membership pm
       JOIN property p ON p.id = pm.property_id AND p.deleted_at IS NULL
       JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
       JOIN membership_role mr ON mr.membership_id = pm.id AND mr.property_id = pm.property_id
       JOIN property_role pr ON pr.id = mr.role_id AND pr.property_id = pm.property_id AND pr.active
      WHERE pm.user_id = $1 AND pm.status = 'ACTIVE'
      ORDER BY
        (p.owner_user_id = $1) DESC,
        CASE pr.code WHEN 'OWNER' THEN 1 WHEN 'ADMINISTRATOR' THEN 2 WHEN 'OPERATOR' THEN 3 WHEN 'VIEWER' THEN 4 ELSE 10 END,
        p.name,
        pr.name
      LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

async function contextIsValid(
  client: PoolClient,
  userId: string,
  propertyId: string | null,
  roleId: string | null,
): Promise<boolean> {
  if (!propertyId && !roleId) return true;
  if (!propertyId || !roleId) return false;
  const result = await client.query(
    `SELECT 1
       FROM property_membership pm
       JOIN membership_role mr ON mr.membership_id = pm.id AND mr.property_id = pm.property_id
       JOIN property_role pr ON pr.id = mr.role_id AND pr.property_id = pm.property_id
       JOIN property p ON p.id = pm.property_id
       JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
      WHERE pm.user_id = $1
        AND pm.property_id = $2
        AND pm.status = 'ACTIVE'
        AND pr.id = $3
        AND pr.active
        AND p.deleted_at IS NULL
        AND p.status = 'ACTIVE'`,
    [userId, propertyId, roleId],
  );
  return Boolean(result.rowCount);
}

async function createSession(
  client: PoolClient,
  user: Pick<UserRow, 'id' | 'email' | 'display_name' | 'is_superadmin'>,
  deviceId: string,
  deviceName: string | undefined,
  metadata: RequestMetadata,
) {
  const context = await initialContext(client, user.id);
  const tokens = createSessionTokens();

  await client.query(
    `UPDATE user_session
        SET revoked_at = now()
      WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
    [user.id, deviceId],
  );

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO user_session(
       user_id, refresh_token_hash, access_token_hash, device_id, device_name,
       active_property_id, active_role_id, ip_address, user_agent,
       access_expires_at, expires_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      user.id,
      tokens.refresh.hash,
      tokens.access.hash,
      deviceId,
      deviceName ?? null,
      context?.property_id ?? null,
      context?.role_id ?? null,
      metadata.ipAddress,
      metadata.userAgent,
      tokens.accessExpiresAt,
      tokens.refreshExpiresAt,
    ],
  );

  const sessionId = inserted.rows[0]!.id;
  await client.query(
    `INSERT INTO audit_event(
       actor_user_id, property_id, active_role_id, action, entity_type, entity_id,
       after_data, ip_address, user_agent
     ) VALUES($1,$2,$3,'AUTH_LOGIN','USER_SESSION',$4,$5,$6,$7)`,
    [
      user.id,
      context?.property_id ?? null,
      context?.role_id ?? null,
      sessionId,
      JSON.stringify({ deviceId, deviceName: deviceName ?? null }),
      metadata.ipAddress,
      metadata.userAgent,
    ],
  );

  return {
    sessionId,
    accessToken: tokens.access.value,
    refreshToken: tokens.refresh.value,
    accessExpiresAt: tokens.accessExpiresAt,
    activePropertyId: context?.property_id ?? null,
    activeRoleId: context?.role_id ?? null,
  };
}

export async function register(input: RegisterInput, metadata: RequestMetadata) {
  const passwordHash = await hashPassword(input.password);
  const verification = issueToken('verify');
  const verificationExpiresAt = addMilliseconds(env.EMAIL_TOKEN_TTL_HOURS * 60 * 60 * 1000);

  try {
    const result = await inTransaction(async (client) => {
      let invitationId: string | null = null;
      if (input.invitationToken) {
        const invitation = await client.query<{ id: string }>(
          `SELECT id
             FROM property_invitation
            WHERE token_hash = $1
              AND email = $2
              AND status = 'PENDING'
              AND expires_at > now()
            FOR UPDATE`,
          [hashToken(input.invitationToken), input.email],
        );
        invitationId = invitation.rows[0]?.id ?? null;
        if (!invitationId) {
          throw new ApiError(400, 'INVALID_INVITATION', 'La invitación no es válida para este correo o ya expiró.');
        }
      }

      const userResult = await client.query<{ id: string }>(
        `INSERT INTO app_user(email, password_hash, display_name, status)
         VALUES($1,$2,$3,'PENDING') RETURNING id`,
        [input.email, passwordHash, input.displayName],
      );
      const userId = userResult.rows[0]!.id;

      await client.query(
        `INSERT INTO user_module(user_id, module_code, enabled, configured_by)
         SELECT $1, code, true, $1 FROM module_catalog WHERE scope = 'USER'`,
        [userId],
      );

      let accountId: string | null = null;
      let propertyId: string | null = null;
      let ownerRoleId: string | null = null;

      if (!invitationId) {
        const propertyName = input.propertyName!;
        const accountResult = await client.query<{ id: string }>(
          `INSERT INTO administrative_account(owner_user_id, name)
           VALUES($1,$2) RETURNING id`,
          [userId, propertyName],
        );
        accountId = accountResult.rows[0]!.id;

        await client.query(
          `INSERT INTO account_module(account_id, module_code, enabled, configured_by)
           SELECT $1, code, true, $2 FROM module_catalog WHERE scope = 'ACCOUNT_PROPERTY'`,
          [accountId, userId],
        );
        const propertyResult = await client.query<{ id: string }>(
          `INSERT INTO property(account_id, owner_user_id, name, created_by)
           VALUES($1,$2,$3,$2) RETURNING id`,
          [accountId, userId, propertyName],
        );
        propertyId = propertyResult.rows[0]!.id;
        await client.query(
          `INSERT INTO property_module(property_id, module_code, enabled, configured_by)
           SELECT $1, module_code, true, $2
             FROM account_module
            WHERE account_id = $3 AND enabled`,
          [propertyId, userId, accountId],
        );
        await client.query(
          `INSERT INTO property_role(property_id, code, name, description, is_system, created_by)
           SELECT $1, code, name, description, true, $2
             FROM role_template WHERE active`,
          [propertyId, userId],
        );
        await client.query(
          `INSERT INTO role_permission(role_id, permission_code)
           SELECT pr.id, rtp.permission_code
             FROM property_role pr
             JOIN role_template_permission rtp ON rtp.role_code = pr.code
            WHERE pr.property_id = $1`,
          [propertyId],
        );
        const membershipResult = await client.query<{ id: string }>(
          `INSERT INTO property_membership(
             property_id, user_id, status, job_title, joined_at, created_by
           ) VALUES($1,$2,'ACTIVE','Propietario',now(),$2) RETURNING id`,
          [propertyId, userId],
        );
        const ownerRoleResult = await client.query<{ id: string }>(
          `SELECT id FROM property_role WHERE property_id = $1 AND code = 'OWNER'`,
          [propertyId],
        );
        ownerRoleId = ownerRoleResult.rows[0]!.id;
        await client.query(
          `INSERT INTO membership_role(membership_id, role_id, property_id, assigned_by)
           VALUES($1,$2,$3,$4)`,
          [membershipResult.rows[0]!.id, ownerRoleId, propertyId, userId],
        );
      }

      await client.query(
        `INSERT INTO email_verification_token(user_id, token_hash, expires_at)
         VALUES($1,$2,$3)`,
        [userId, verification.hash, verificationExpiresAt],
      );
      await client.query(
        `INSERT INTO audit_event(
           actor_user_id, property_id, active_role_id, action, entity_type, entity_id,
           after_data, ip_address, user_agent
         ) VALUES($1,$2,$3,'ACCOUNT_REGISTERED','APP_USER',$4,$5,$6,$7)`,
        [
          userId,
          propertyId,
          ownerRoleId,
          userId,
          JSON.stringify({ accountId, propertyId, invitationId, email: input.email }),
          metadata.ipAddress,
          metadata.userAgent,
        ],
      );

      return {
        userId,
        accountId,
        propertyId,
        invitationId,
        verificationToken: verification.value,
        verificationExpiresAt,
      };
    });
    const verificationDelivery = await sendVerificationEmail({
      email: input.email,
      displayName: input.displayName,
      token: result.verificationToken,
      expiresAt: result.verificationExpiresAt,
      ...(input.invitationToken ? { invitationToken: input.invitationToken } : {}),
    });
    return { ...result, verificationDelivery };
  } catch (error) {
    const databaseError = error as { code?: string; constraint?: string };
    if (databaseError.code === '23505' && databaseError.constraint?.includes('email')) {
      throw conflict('EMAIL_ALREADY_REGISTERED', 'Ya existe una cuenta con ese correo electrónico.');
    }
    throw error;
  }
}

export async function resendEmailVerification(email: string, metadata: RequestMetadata) {
  const verification = issueToken('verify');
  const expiresAt = addMilliseconds(env.EMAIL_TOKEN_TTL_HOURS * 60 * 60 * 1000);
  const pending = await inTransaction(async (client) => {
    const result = await client.query<{ id: string; email: string; display_name: string }>(
      `SELECT id, email::text, display_name
         FROM app_user
        WHERE email = $1 AND status = 'PENDING' AND deleted_at IS NULL
        FOR UPDATE`,
      [email],
    );
    const user = result.rows[0];
    if (!user) return null;

    const recent = await client.query<{ too_soon: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM email_verification_token
          WHERE user_id = $1
            AND created_at > now() - ($2::integer * interval '1 second')
       ) AS too_soon`,
      [user.id, env.EMAIL_VERIFICATION_RESEND_SECONDS],
    );
    if (recent.rows[0]?.too_soon) return null;

    await client.query(
      `UPDATE email_verification_token
          SET consumed_at = coalesce(consumed_at, now())
        WHERE user_id = $1 AND consumed_at IS NULL`,
      [user.id],
    );
    await client.query(
      `INSERT INTO email_verification_token(user_id, token_hash, expires_at)
       VALUES($1,$2,$3)`,
      [user.id, verification.hash, expiresAt],
    );
    await client.query(
      `INSERT INTO audit_event(
         actor_user_id, action, entity_type, entity_id, after_data, ip_address, user_agent
       ) VALUES($1,'EMAIL_VERIFICATION_REQUESTED','APP_USER',$2,$3,$4,$5)`,
      [
        user.id,
        user.id,
        JSON.stringify({ email: user.email }),
        metadata.ipAddress,
        metadata.userAgent,
      ],
    );
    return user;
  });

  if (!pending) return { accepted: true as const, verificationToken: null, delivery: null };
  const delivery = await sendVerificationEmail({
    email: pending.email,
    displayName: pending.display_name,
    token: verification.value,
    expiresAt,
  });
  return { accepted: true as const, verificationToken: verification.value, delivery };
}

export async function verifyEmail(token: string, metadata: RequestMetadata): Promise<void> {
  const tokenHash = hashToken(token);
  await inTransaction(async (client) => {
    const result = await client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id
         FROM email_verification_token
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [tokenHash],
    );
    const verification = result.rows[0];
    if (!verification) throw unauthorized('El enlace de verificación no es válido o expiró.');

    await client.query(
      `UPDATE email_verification_token SET consumed_at = now() WHERE id = $1`,
      [verification.id],
    );
    await client.query(
      `UPDATE app_user
          SET status = 'ACTIVE', email_verified_at = coalesce(email_verified_at, now())
        WHERE id = $1 AND status = 'PENDING'`,
      [verification.user_id],
    );
    await client.query(
      `UPDATE email_verification_token
          SET consumed_at = coalesce(consumed_at, now())
        WHERE user_id = $1 AND consumed_at IS NULL`,
      [verification.user_id],
    );
    await client.query(
      `INSERT INTO audit_event(
         actor_user_id, action, entity_type, entity_id, ip_address, user_agent
       ) VALUES($1,'EMAIL_VERIFIED','APP_USER',$2,$3,$4)`,
      [verification.user_id, verification.user_id, metadata.ipAddress, metadata.userAgent],
    );
  });
}

export async function requestPasswordReset(email:string,metadata:RequestMetadata){
  const token=issueToken('reset');
  const expiresAt=addMilliseconds(30*60*1000);
  const pending=await inTransaction(async client=>{
    const user=(await client.query<{id:string;email:string;display_name:string}>(
      `SELECT id,email::text,display_name FROM app_user
       WHERE email=$1 AND status='ACTIVE' AND deleted_at IS NULL FOR UPDATE`,[email])).rows[0];
    if(!user)return null;
    const recent=await client.query(`SELECT 1 FROM password_reset_token
      WHERE user_id=$1 AND created_at>now()-interval '60 seconds' LIMIT 1`,[user.id]);
    if(recent.rowCount)return null;
    await client.query(`UPDATE password_reset_token SET consumed_at=now()
      WHERE user_id=$1 AND consumed_at IS NULL`,[user.id]);
    await client.query(`INSERT INTO password_reset_token(user_id,token_hash,expires_at)
      VALUES($1,$2,$3)`,[user.id,token.hash,expiresAt]);
    await client.query(`INSERT INTO audit_event(actor_user_id,action,entity_type,entity_id,
      ip_address,user_agent) VALUES($1,'PASSWORD_RESET_REQUESTED','APP_USER',$1,$2,$3)`,
      [user.id,metadata.ipAddress,metadata.userAgent]);
    return user;
  });
  if(!pending)return;
  await sendPasswordResetEmail({email:pending.email,displayName:pending.display_name,
    token:token.value,expiresAt});
}

export async function resetPassword(token:string,password:string,metadata:RequestMetadata){
  const passwordHash=await hashPassword(password);
  await inTransaction(async client=>{
    const current=(await client.query<{id:string;user_id:string}>(
      `SELECT prt.id,prt.user_id FROM password_reset_token prt
       JOIN app_user u ON u.id=prt.user_id
       WHERE prt.token_hash=$1 AND prt.consumed_at IS NULL AND prt.expires_at>now()
         AND u.status='ACTIVE' AND u.deleted_at IS NULL FOR UPDATE OF prt,u`,
      [hashToken(token)])).rows[0];
    if(!current)throw unauthorized('El enlace de recuperación no es válido o expiró.');
    await client.query(`UPDATE app_user SET password_hash=$2,failed_login_count=0,
      locked_until=NULL WHERE id=$1`,[current.user_id,passwordHash]);
    await client.query(`UPDATE password_reset_token SET consumed_at=now()
      WHERE user_id=$1 AND consumed_at IS NULL`,[current.user_id]);
    await client.query(`UPDATE user_session SET revoked_at=now()
      WHERE user_id=$1 AND revoked_at IS NULL`,[current.user_id]);
    await client.query(`INSERT INTO audit_event(actor_user_id,action,entity_type,entity_id,
      ip_address,user_agent) VALUES($1,'PASSWORD_RESET_COMPLETED','APP_USER',$1,$2,$3)`,
      [current.user_id,metadata.ipAddress,metadata.userAgent]);
  });
}

export async function login(input: LoginInput, metadata: RequestMetadata) {
  const preliminaryResult = await pool.query<UserRow>(
    `SELECT id, email, password_hash, display_name, status, is_superadmin,
            failed_login_count, locked_until
       FROM app_user
      WHERE email = $1 AND deleted_at IS NULL`,
    [input.email],
  );
  const preliminaryUser = preliminaryResult.rows[0];
  if (!preliminaryUser) {
    await hashPassword(input.password);
    throw unauthorized('Correo o contraseña incorrectos.');
  }
  if (preliminaryUser.locked_until && preliminaryUser.locked_until.getTime() > Date.now()) {
    throw new ApiError(
      429,
      'ACCOUNT_TEMPORARILY_LOCKED',
      'La cuenta está bloqueada temporalmente. Intenta nuevamente más tarde.',
    );
  }
  const preliminaryPasswordValid = await verifyPassword(input.password, preliminaryUser.password_hash);

  const outcome = await inTransaction(async (client) => {
    const result = await client.query<UserRow>(
      `SELECT id, email, password_hash, display_name, status, is_superadmin,
              failed_login_count, locked_until
         FROM app_user
        WHERE email = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [input.email],
    );
    const user = result.rows[0];

    if (!user) return { kind: 'invalid' as const };

    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      return { kind: 'locked' as const };
    }

    const validPassword = user.password_hash === preliminaryUser.password_hash
      ? preliminaryPasswordValid
      : await verifyPassword(input.password, user.password_hash);
    if (!validPassword) {
      const failures = user.failed_login_count + 1;
      const lock = failures >= 5;
      await client.query(
        `UPDATE app_user
            SET failed_login_count = $2,
                locked_until = CASE WHEN $3 THEN now() + interval '15 minutes' ELSE NULL END
          WHERE id = $1`,
        [user.id, lock ? 0 : failures, lock],
      );
      return { kind: 'invalid' as const };
    }

    if (user.status === 'PENDING') {
      return { kind: 'pending' as const };
    }
    if (user.status !== 'ACTIVE') {
      return { kind: 'unavailable' as const };
    }

    await client.query(
      `UPDATE app_user SET failed_login_count = 0, locked_until = NULL WHERE id = $1`,
      [user.id],
    );
    const session = await createSession(client, user, input.deviceId, input.deviceName, metadata);
    return {
      kind: 'success' as const,
      ...session,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        isSuperadmin: user.is_superadmin,
      },
    };
  });

  if (outcome.kind === 'invalid') throw unauthorized('Correo o contraseña incorrectos.');
  if (outcome.kind === 'locked') {
    throw new ApiError(
      429,
      'ACCOUNT_TEMPORARILY_LOCKED',
      'La cuenta está bloqueada temporalmente. Intenta nuevamente más tarde.',
    );
  }
  if (outcome.kind === 'pending') {
    throw forbidden('EMAIL_VERIFICATION_REQUIRED', 'Verifica tu correo electrónico antes de ingresar.');
  }
  if (outcome.kind === 'unavailable') {
    throw forbidden('ACCOUNT_UNAVAILABLE', 'La cuenta no está habilitada.');
  }
  return outcome;
}

export async function refreshSession(refreshToken: string, metadata: RequestMetadata) {
  const refreshHash = hashToken(refreshToken);
  const outcome = await inTransaction(async (client) => {
    const result = await client.query<SessionRow>(
      `SELECT s.id, s.user_id, s.active_property_id, s.active_role_id, s.expires_at,
              u.status, u.email, u.display_name, u.is_superadmin
         FROM user_session s
         JOIN app_user u ON u.id = s.user_id AND u.deleted_at IS NULL
        WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL
        FOR UPDATE OF s`,
      [refreshHash],
    );
    const session = result.rows[0];
    if (!session) return { kind: 'invalid' as const };
    if (session.expires_at.getTime() <= Date.now()) {
      await client.query(`UPDATE user_session SET revoked_at = now() WHERE id = $1`, [session.id]);
      return { kind: 'invalid' as const };
    }
    if (session.status !== 'ACTIVE') {
      await client.query(`UPDATE user_session SET revoked_at = now() WHERE id = $1`, [session.id]);
      return { kind: 'unavailable' as const };
    }

    const validContext = await contextIsValid(
      client,
      session.user_id,
      session.active_property_id,
      session.active_role_id,
    );
    const tokens = createSessionTokens();
    const activePropertyId = validContext ? session.active_property_id : null;
    const activeRoleId = validContext ? session.active_role_id : null;

    await client.query(
      `UPDATE user_session
          SET refresh_token_hash = $2,
              access_token_hash = $3,
              access_expires_at = $4,
              expires_at = $5,
              active_property_id = $6,
              active_role_id = $7,
              ip_address = $8,
              user_agent = $9,
              last_seen_at = now()
        WHERE id = $1`,
      [
        session.id,
        tokens.refresh.hash,
        tokens.access.hash,
        tokens.accessExpiresAt,
        tokens.refreshExpiresAt,
        activePropertyId,
        activeRoleId,
        metadata.ipAddress,
        metadata.userAgent,
      ],
    );

    return {
      kind: 'success' as const,
      sessionId: session.id,
      accessToken: tokens.access.value,
      refreshToken: tokens.refresh.value,
      accessExpiresAt: tokens.accessExpiresAt,
      activePropertyId,
      activeRoleId,
      user: {
        id: session.user_id,
        email: session.email,
        displayName: session.display_name,
        isSuperadmin: session.is_superadmin,
      },
    };
  });

  if (outcome.kind === 'invalid') throw unauthorized();
  if (outcome.kind === 'unavailable') {
    throw forbidden('ACCOUNT_UNAVAILABLE', 'La cuenta no está habilitada.');
  }
  return outcome;
}

export async function logout(accessToken: string | null, refreshToken: string | null, metadata: RequestMetadata) {
  if (!accessToken && !refreshToken) return;
  const accessHash = accessToken ? hashToken(accessToken) : null;
  const refreshHash = refreshToken ? hashToken(refreshToken) : null;

  await inTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      user_id: string;
      active_property_id: string | null;
      active_role_id: string | null;
    }>(
      `UPDATE user_session
          SET revoked_at = coalesce(revoked_at, now())
        WHERE (($1::text IS NOT NULL AND access_token_hash = $1)
           OR ($2::text IS NOT NULL AND refresh_token_hash = $2))
        RETURNING id, user_id, active_property_id, active_role_id`,
      [accessHash, refreshHash],
    );
    const session = result.rows[0];
    if (!session) return;
    await client.query(
      `INSERT INTO audit_event(
         actor_user_id, property_id, active_role_id, action, entity_type, entity_id,
         ip_address, user_agent
       ) VALUES($1,$2,$3,'AUTH_LOGOUT','USER_SESSION',$4,$5,$6)`,
      [
        session.user_id,
        session.active_property_id,
        session.active_role_id,
        session.id,
        metadata.ipAddress,
        metadata.userAgent,
      ],
    );
  });
}

export async function changeContext(
  auth: AuthState,
  propertyId: string,
  roleId: string,
  metadata: RequestMetadata,
) {
  return inTransaction(async (client) => {
    const result = await client.query<{ property_name: string; role_code: string; role_name: string }>(
      `SELECT p.name AS property_name, pr.code AS role_code, pr.name AS role_name
         FROM property_membership pm
         JOIN property p ON p.id = pm.property_id AND p.deleted_at IS NULL AND p.status = 'ACTIVE'
         JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
         JOIN membership_role mr ON mr.membership_id = pm.id AND mr.property_id = pm.property_id
         JOIN property_role pr ON pr.id = mr.role_id AND pr.property_id = pm.property_id AND pr.active
        WHERE pm.user_id = $1 AND pm.property_id = $2 AND pm.status = 'ACTIVE' AND pr.id = $3`,
      [auth.userId, propertyId, roleId],
    );
    const context = result.rows[0];
    if (!context) throw forbidden('CONTEXT_NOT_ALLOWED', 'No tienes acceso a esa propiedad con el rol indicado.');

    await client.query(
      `UPDATE user_session
          SET active_property_id = $2, active_role_id = $3, last_seen_at = now()
        WHERE id = $1 AND revoked_at IS NULL`,
      [auth.sessionId, propertyId, roleId],
    );
    await client.query(
      `INSERT INTO audit_event(
         actor_user_id, property_id, active_role_id, action, entity_type, entity_id,
         after_data, ip_address, user_agent
       ) VALUES($1,$2,$3,'SESSION_CONTEXT_CHANGED','USER_SESSION',$4,$5,$6,$7)`,
      [
        auth.userId,
        propertyId,
        roleId,
        auth.sessionId,
        JSON.stringify({ propertyId, roleId }),
        metadata.ipAddress,
        metadata.userAgent,
      ],
    );

    return {
      propertyId,
      propertyName: context.property_name,
      roleId,
      roleCode: context.role_code,
      roleName: context.role_name,
    };
  });
}

export async function getSessionOverview(auth: AuthState) {
  const membershipResult = await pool.query<{
    property_id: string;
    property_name: string;
    timezone: string;
    is_owner: boolean;
    role_id: string;
    role_code: string;
    role_name: string;
    permissions: string[];
  }>(
    `SELECT p.id AS property_id, p.name AS property_name, p.timezone,
            (p.owner_user_id = $1) AS is_owner,
            pr.id AS role_id, pr.code AS role_code, pr.name AS role_name,
            ARRAY(SELECT rp.permission_code FROM role_permission rp
                   WHERE rp.role_id = pr.id ORDER BY rp.permission_code) AS permissions
       FROM property_membership pm
       JOIN property p ON p.id = pm.property_id AND p.deleted_at IS NULL AND p.status = 'ACTIVE'
       JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
       JOIN membership_role mr ON mr.membership_id = pm.id AND mr.property_id = pm.property_id
       JOIN property_role pr ON pr.id = mr.role_id AND pr.property_id = pm.property_id AND pr.active
      WHERE pm.user_id = $1 AND pm.status = 'ACTIVE'
      ORDER BY is_owner DESC, p.name, pr.name`,
    [auth.userId],
  );

  const properties = new Map<string, {
    id: string;
    name: string;
    timezone: string;
    isOwner: boolean;
    roles: Array<{ id: string; code: string; name: string; permissions: string[] }>;
    enabledModules: string[];
    enabledSpecies: string[];
  }>();
  for (const row of membershipResult.rows) {
    let property = properties.get(row.property_id);
    if (!property) {
      property = {
        id: row.property_id,
        name: row.property_name,
        timezone: row.timezone,
        isOwner: row.is_owner,
        roles: [],
        enabledModules: [],
        enabledSpecies: [],
      };
      properties.set(row.property_id, property);
    }
    property.roles.push({
      id: row.role_id,
      code: row.role_code,
      name: row.role_name,
      permissions: row.permissions,
    });
  }

  const propertyIds = [...properties.keys()];
  if (propertyIds.length) {
    const modules = await pool.query<{ property_id: string; module_code: string }>(
      `SELECT property_id, module_code
         FROM effective_property_module
        WHERE property_id = ANY($1::uuid[]) AND enabled
        ORDER BY module_code`,
      [propertyIds],
    );
    for (const row of modules.rows) properties.get(row.property_id)?.enabledModules.push(row.module_code);

    const species = await pool.query<{ property_id: string; species_code: string }>(
      `SELECT property_id, species_code
         FROM effective_property_species
        WHERE property_id = ANY($1::uuid[]) AND enabled
        ORDER BY species_code`,
      [propertyIds],
    );
    for (const row of species.rows) properties.get(row.property_id)?.enabledSpecies.push(row.species_code);
  }

  const userModules = await pool.query<{ module_code: string }>(
    `SELECT module_code FROM effective_user_module WHERE user_id = $1 AND enabled ORDER BY module_code`,
    [auth.userId],
  );

  const ownedAccount = await pool.query<{ id: string; name: string; status: string; max_properties: number; used: string }>(
    `SELECT aa.id, aa.name, aa.status, aa.max_properties,
            (SELECT count(*)::text FROM property p
              WHERE p.account_id = aa.id AND p.deleted_at IS NULL AND p.status <> 'ARCHIVED') AS used
       FROM administrative_account aa WHERE aa.owner_user_id = $1`,
    [auth.userId],
  );
  const owned = ownedAccount.rows[0];

  return {
    user: {
      id: auth.userId,
      email: auth.email,
      displayName: auth.displayName,
      isSuperadmin: auth.isSuperadmin,
    },
    activeContext: auth.activePropertyId && auth.activeRoleId
      ? { propertyId: auth.activePropertyId, roleId: auth.activeRoleId }
      : null,
    properties: [...properties.values()],
    enabledUserModules: userModules.rows.map((row) => row.module_code),
    ownedAccount: owned ? {
      id: owned.id, name: owned.name, status: owned.status,
      maxProperties: owned.max_properties, usedProperties: Number(owned.used),
    } : null,
  };
}
