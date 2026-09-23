import type { PoolClient, QueryResultRow } from 'pg';
import { env } from '../../config.js';
import { ApiError, conflict, forbidden } from '../../core/errors.js';
import { pool } from '../../database/pool.js';
import { inTransaction } from '../../database/transaction.js';
import { hashToken, issueToken } from '../../security/tokens.js';
import { sendPropertyInvitationEmail } from '../../services/email.service.js';
import type { AuthState, PropertyContext, RequestMetadata } from '../auth/auth.types.js';
import type { CreateInvitationInput } from './collaboration.schemas.js';

interface InvitationRow extends QueryResultRow {
  id: string;
  email: string;
  expires_at: Date;
  job_title: string | null;
  pay_amount: string | null;
  pay_currency: string;
  pay_frequency: string | null;
  employment_notes: string | null;
  property_id: string;
  property_name: string;
  account_name: string;
  inviter_name: string;
  existing_user: boolean;
}

const notFound = (message: string) => new ApiError(404, 'NOT_FOUND', message);

async function audit(client: PoolClient, input: {
  auth: AuthState;
  context?: PropertyContext;
  propertyId?: string;
  roleId?: string;
  metadata: RequestMetadata;
  action: string;
  entityType: string;
  entityId: string;
  beforeData?: unknown;
  afterData?: unknown;
}) {
  await client.query(
    `INSERT INTO audit_event(
       actor_user_id, property_id, active_role_id, action, entity_type, entity_id,
       before_data, after_data, ip_address, user_agent
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.auth.userId,
      input.context?.propertyId ?? input.propertyId ?? null,
      input.context?.roleId ?? input.roleId ?? null,
      input.action,
      input.entityType,
      input.entityId,
      input.beforeData === undefined ? null : JSON.stringify(input.beforeData),
      input.afterData === undefined ? null : JSON.stringify(input.afterData),
      input.metadata.ipAddress,
      input.metadata.userAgent,
    ],
  );
}

async function invitationRoles(client: PoolClient, invitationId: string) {
  const result = await client.query<{ id: string; code: string; name: string }>(
    `SELECT pr.id, pr.code, pr.name
       FROM invitation_role ir
      JOIN property_role pr ON pr.id = ir.role_id AND pr.property_id = ir.property_id
      WHERE ir.invitation_id = $1 AND pr.active
      ORDER BY pr.name`,
    [invitationId],
  );
  return result.rows;
}

export async function getInvitationPreview(token: string) {
  return inTransaction(async (client) => {
    const result = await client.query<InvitationRow>(
      `SELECT pi.id, pi.email::text, pi.expires_at, pi.job_title,
              pi.pay_amount::text, pi.pay_currency, pi.pay_frequency, pi.employment_notes,
              p.id AS property_id, p.name AS property_name, aa.name AS account_name,
              inviter.display_name AS inviter_name,
              EXISTS(SELECT 1 FROM app_user u WHERE u.email = pi.email AND u.deleted_at IS NULL) AS existing_user
         FROM property_invitation pi
         JOIN property p ON p.id = pi.property_id AND p.deleted_at IS NULL AND p.status = 'ACTIVE'
         JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
         JOIN app_user inviter ON inviter.id = pi.invited_by
        WHERE pi.token_hash = $1 AND pi.status = 'PENDING'
        FOR UPDATE OF pi`,
      [hashToken(token)],
    );
    const invitation = result.rows[0];
    if (!invitation) throw notFound('La invitación no existe o ya fue utilizada.');
    if (invitation.expires_at.getTime() <= Date.now()) {
      throw new ApiError(410, 'INVITATION_EXPIRED', 'La invitación expiró. Solicita una nueva.');
    }
    return {
      id: invitation.id,
      email: invitation.email,
      expiresAt: invitation.expires_at.toISOString(),
      property: { id: invitation.property_id, name: invitation.property_name },
      accountName: invitation.account_name,
      invitedBy: invitation.inviter_name,
      existingUser: invitation.existing_user,
      roles: await invitationRoles(client, invitation.id),
      employment: invitation.job_title ? {
        jobTitle: invitation.job_title,
        payAmount: invitation.pay_amount === null ? null : Number(invitation.pay_amount),
        currency: invitation.pay_currency,
        frequency: invitation.pay_frequency,
        notes: invitation.employment_notes,
      } : null,
    };
  });
}

export async function getPropertyTeam(auth: AuthState, context: PropertyContext) {
  const canManage = context.permissions.has('MEMBERSHIP_MANAGE');
  const [members, invitations, roles, quota] = await Promise.all([
    pool.query<{
      id: string; user_id: string; display_name: string; email: string; status: string;
      job_title: string | null; joined_at: Date | null; is_owner: boolean; roles: unknown;
      pay_amount: string | null; pay_currency: string | null; pay_frequency: string | null;
    }>(
      `SELECT pm.id, u.id AS user_id, u.display_name, u.email::text, pm.status,
              pm.job_title, pm.joined_at, (p.owner_user_id = u.id) AS is_owner,
              coalesce(jsonb_agg(jsonb_build_object('id', pr.id, 'code', pr.code, 'name', pr.name)
                ORDER BY pr.name) FILTER (WHERE pr.id IS NOT NULL), '[]'::jsonb) AS roles,
              et.amount::text AS pay_amount, et.currency AS pay_currency, et.frequency AS pay_frequency
         FROM property_membership pm
         JOIN app_user u ON u.id = pm.user_id
         JOIN property p ON p.id = pm.property_id
         LEFT JOIN membership_role mr ON mr.membership_id = pm.id AND mr.property_id = pm.property_id
         LEFT JOIN property_role pr ON pr.id = mr.role_id AND pr.property_id = pm.property_id
         LEFT JOIN employment_term et ON et.membership_id = pm.id AND et.valid_until IS NULL
        WHERE pm.property_id = $1 AND pm.status <> 'ENDED'
        GROUP BY pm.id, u.id, p.owner_user_id, et.id
        ORDER BY is_owner DESC, u.display_name`,
      [context.propertyId],
    ),
    pool.query<{
      id: string; email: string; expires_at: Date; job_title: string | null; roles: unknown;
    }>(
      `SELECT pi.id, pi.email::text, pi.expires_at, pi.job_title,
              coalesce(jsonb_agg(jsonb_build_object('id', pr.id, 'code', pr.code, 'name', pr.name)
                ORDER BY pr.name), '[]'::jsonb) AS roles
         FROM property_invitation pi
         JOIN invitation_role ir ON ir.invitation_id = pi.id AND ir.property_id = pi.property_id
         JOIN property_role pr ON pr.id = ir.role_id AND pr.property_id = pi.property_id
        WHERE pi.property_id = $1 AND pi.status = 'PENDING' AND pi.expires_at > now()
        GROUP BY pi.id
        ORDER BY pi.created_at DESC`,
      [context.propertyId],
    ),
    pool.query<{ id: string; code: string; name: string; description: string | null }>(
      `SELECT id, code, name, description
         FROM property_role
        WHERE property_id = $1 AND active AND code <> 'OWNER'
          AND ($2::boolean OR code <> 'ADMINISTRATOR')
        ORDER BY name`,
      [context.propertyId, context.roleCode === 'OWNER'],
    ),
    pool.query<{ used_value: string; limit_value: string | null }>(
      `SELECT coalesce(u.used_value, 0)::text AS used_value, q.limit_value::text
         FROM property p
         JOIN effective_account_quota q ON q.account_id = p.account_id AND q.quota_code = 'COLLABORATOR_USERS'
         LEFT JOIN account_collaborator_usage u ON u.account_id = p.account_id
        WHERE p.id = $1`,
      [context.propertyId],
    ),
  ]);

  return {
    canManage,
    members: members.rows.map((member) => ({
      id: member.id,
      userId: member.user_id,
      displayName: member.display_name,
      email: member.email,
      status: member.status,
      jobTitle: member.job_title,
      joinedAt: member.joined_at?.toISOString() ?? null,
      isOwner: member.is_owner,
      isSelf: member.user_id === auth.userId,
      roles: member.roles,
      payment: !canManage || member.pay_amount === null ? null : {
        amount: Number(member.pay_amount), currency: member.pay_currency, frequency: member.pay_frequency,
      },
    })),
    invitations: canManage ? invitations.rows.map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      expiresAt: invitation.expires_at.toISOString(),
      jobTitle: invitation.job_title,
      roles: invitation.roles,
    })) : [],
    assignableRoles: canManage ? roles.rows : [],
    quota: {
      used: Number(quota.rows[0]?.used_value ?? 0),
      limit: quota.rows[0]?.limit_value === null ? null : Number(quota.rows[0]?.limit_value ?? 0),
    },
  };
}

export async function createPropertyInvitation(
  auth: AuthState,
  context: PropertyContext,
  input: CreateInvitationInput,
  metadata: RequestMetadata,
) {
  const invitationToken = issueToken('invite');
  const expiresAt = new Date(Date.now() + env.INVITATION_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  const created = await inTransaction(async (client) => {
    const propertyResult = await client.query<{
      account_id: string; property_name: string; owner_user_id: string;
    }>(
      `SELECT p.account_id, p.name AS property_name, p.owner_user_id
         FROM property p
         JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
        WHERE p.id = $1 AND p.status = 'ACTIVE' AND p.deleted_at IS NULL
        FOR UPDATE OF aa`,
      [context.propertyId],
    );
    const property = propertyResult.rows[0];
    if (!property) throw notFound('La propiedad activa no está disponible.');

    const selectedRoles = await client.query<{ id: string; code: string; name: string }>(
      `SELECT id, code, name FROM property_role
        WHERE property_id = $1 AND id = ANY($2::uuid[]) AND active`,
      [context.propertyId, input.roleIds],
    );
    if (selectedRoles.rowCount !== input.roleIds.length) {
      throw new ApiError(400, 'INVALID_ROLES', 'Uno o más roles no pertenecen a la propiedad.');
    }
    if (selectedRoles.rows.some((role) => role.code === 'OWNER')) {
      throw forbidden('OWNER_ROLE_PROTECTED', 'El rol de propietario no puede asignarse mediante invitación.');
    }
    if (selectedRoles.rows.some((role) => role.code === 'ADMINISTRATOR') && property.owner_user_id !== auth.userId) {
      throw forbidden('ADMIN_ROLE_OWNER_ONLY', 'Solo el propietario puede nombrar administradores.');
    }

    const currentMember = await client.query(
      `SELECT 1 FROM property_membership pm
        JOIN app_user u ON u.id = pm.user_id
       WHERE pm.property_id = $1 AND u.email = $2 AND pm.status <> 'ENDED'`,
      [context.propertyId, input.email],
    );
    if (currentMember.rowCount) throw conflict('ALREADY_A_MEMBER', 'La persona ya pertenece a esta propiedad.');

    await client.query(
      `UPDATE property_invitation SET status = 'EXPIRED'
        WHERE property_id = $1 AND email = $2 AND status = 'PENDING' AND expires_at <= now()`,
      [context.propertyId, input.email],
    );
    const pending = await client.query(
      `SELECT 1 FROM property_invitation
        WHERE property_id = $1 AND email = $2 AND status = 'PENDING'`,
      [context.propertyId, input.email],
    );
    if (pending.rowCount) throw conflict('INVITATION_ALREADY_PENDING', 'Ya existe una invitación pendiente para ese correo.');

    const alreadyCounted = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM property p
         JOIN property_membership pm ON pm.property_id = p.id AND pm.status IN ('INVITED','ACTIVE','SUSPENDED')
         JOIN app_user u ON u.id = pm.user_id
         WHERE p.account_id = $1 AND u.email = $2
         UNION ALL
         SELECT 1 FROM property p
         JOIN property_invitation pi ON pi.property_id = p.id
         WHERE p.account_id = $1 AND pi.email = $2
           AND pi.status = 'PENDING' AND pi.expires_at > now()
       ) AS exists`,
      [property.account_id, input.email],
    );
    if (!alreadyCounted.rows[0]?.exists) {
      const quota = await client.query<{ limit_value: string | null; used_value: string }>(
        `SELECT q.limit_value::text, coalesce(u.used_value, 0)::text AS used_value
           FROM effective_account_quota q
           LEFT JOIN account_collaborator_usage u ON u.account_id = q.account_id
          WHERE q.account_id = $1 AND q.quota_code = 'COLLABORATOR_USERS'`,
        [property.account_id],
      );
      const values = quota.rows[0];
      if (values && values.limit_value !== null && Number(values.used_value) >= Number(values.limit_value)) {
        throw forbidden('COLLABORATOR_QUOTA_REACHED', 'Se alcanzó el límite de colaboradores de la cuenta.');
      }
    }

    const knownUser = await client.query<{ display_name: string; status: string }>(
      `SELECT display_name, status::text
         FROM app_user
        WHERE email = $1 AND deleted_at IS NULL`,
      [input.email],
    );
    if (knownUser.rows[0] && ['SUSPENDED', 'DISABLED'].includes(knownUser.rows[0].status)) {
      throw conflict('USER_NOT_AVAILABLE', 'Ese usuario no está disponible para recibir invitaciones.');
    }
    const invitation = await client.query<{ id: string }>(
      `INSERT INTO property_invitation(
         property_id, email, token_hash, invited_by, expires_at, job_title,
         pay_amount, pay_currency, pay_frequency, employment_notes
       ) VALUES($1,$2,$3,$4,$5,$6,$7,'USD',$8,$9) RETURNING id`,
      [
        context.propertyId, input.email, invitationToken.hash, auth.userId, expiresAt,
        input.jobTitle ?? null, input.payAmount ?? null, input.payFrequency ?? null,
        input.employmentNotes ?? null,
      ],
    );
    const invitationId = invitation.rows[0]!.id;
    await client.query(
      `INSERT INTO invitation_role(invitation_id, role_id, property_id)
       SELECT $1, id, $2 FROM property_role WHERE id = ANY($3::uuid[]) AND property_id = $2`,
      [invitationId, context.propertyId, input.roleIds],
    );
    await audit(client, {
      auth, context, metadata, action: 'PROPERTY_INVITATION_CREATED',
      entityType: 'PROPERTY_INVITATION', entityId: invitationId,
      afterData: { email: input.email, roleIds: input.roleIds, jobTitle: input.jobTitle ?? null },
    });
    return {
      id: invitationId,
      propertyName: property.property_name,
      displayName: knownUser.rows[0]?.display_name ?? input.email.split('@')[0] ?? input.email,
      roleNames: selectedRoles.rows.map((role) => role.name),
    };
  });

  const delivery = await sendPropertyInvitationEmail({
    email: input.email,
    displayName: created.displayName,
    inviterName: auth.displayName,
    propertyName: created.propertyName,
    roleNames: created.roleNames,
    token: invitationToken.value,
    expiresAt,
  });
  return { id: created.id, expiresAt, delivery, invitationToken: invitationToken.value };
}

export async function revokePropertyInvitation(
  auth: AuthState,
  context: PropertyContext,
  invitationId: string,
  metadata: RequestMetadata,
) {
  return inTransaction(async (client) => {
    const result = await client.query<{ email: string }>(
      `UPDATE property_invitation SET status = 'REVOKED'
        WHERE id = $1 AND property_id = $2 AND status = 'PENDING'
        RETURNING email::text`,
      [invitationId, context.propertyId],
    );
    if (!result.rows[0]) throw notFound('La invitación pendiente no existe.');
    await audit(client, {
      auth, context, metadata, action: 'PROPERTY_INVITATION_REVOKED',
      entityType: 'PROPERTY_INVITATION', entityId: invitationId,
      beforeData: { email: result.rows[0].email, status: 'PENDING' }, afterData: { status: 'REVOKED' },
    });
    return { revoked: true as const };
  });
}

export async function updatePropertyMembershipStatus(
  auth: AuthState,
  context: PropertyContext,
  membershipId: string,
  status: 'ACTIVE' | 'SUSPENDED' | 'ENDED',
  metadata: RequestMetadata,
) {
  return inTransaction(async (client) => {
    const result = await client.query<{
      user_id: string; status: string; is_owner: boolean; is_administrator: boolean;
    }>(
      `SELECT pm.user_id, pm.status, (p.owner_user_id = pm.user_id) AS is_owner,
              EXISTS(SELECT 1 FROM membership_role mr JOIN property_role pr ON pr.id = mr.role_id
                WHERE mr.membership_id = pm.id AND pr.code = 'ADMINISTRATOR') AS is_administrator
         FROM property_membership pm
         JOIN property p ON p.id = pm.property_id
        WHERE pm.id = $1 AND pm.property_id = $2
        FOR UPDATE OF pm`,
      [membershipId, context.propertyId],
    );
    const member = result.rows[0];
    if (!member) throw notFound('El colaborador no existe.');
    if (member.is_owner) throw forbidden('OWNER_MEMBERSHIP_PROTECTED', 'El acceso del propietario no puede modificarse aquí.');
    if (member.user_id === auth.userId) {
      throw forbidden('SELF_MEMBERSHIP_PROTECTED', 'No puedes suspender ni finalizar tu propio acceso.');
    }
    if (member.is_administrator && context.roleCode !== 'OWNER') {
      throw forbidden('ADMIN_MEMBERSHIP_OWNER_ONLY', 'Solo el propietario puede modificar a un administrador.');
    }
    if (member.status === 'ENDED' && status !== 'ENDED') {
      throw conflict('MEMBERSHIP_ENDED', 'Una membresía finalizada debe crearse nuevamente mediante invitación.');
    }
    await client.query(
      `UPDATE property_membership
          SET status = $3,
              joined_at = CASE WHEN $3 = 'ACTIVE' THEN coalesce(joined_at, now()) ELSE joined_at END,
              ended_at = CASE WHEN $3 = 'ENDED' THEN now() ELSE NULL END
        WHERE id = $1 AND property_id = $2`,
      [membershipId, context.propertyId, status],
    );
    if (status !== 'ACTIVE') {
      await client.query(
        `UPDATE user_session SET active_property_id = NULL, active_role_id = NULL
          WHERE user_id = $1 AND active_property_id = $2 AND revoked_at IS NULL`,
        [member.user_id, context.propertyId],
      );
    }
    if (status === 'ENDED') {
      await client.query(
        `UPDATE employment_term SET valid_until = current_date
          WHERE membership_id = $1 AND valid_until IS NULL`,
        [membershipId],
      );
    }
    await audit(client, {
      auth, context, metadata, action: 'PROPERTY_MEMBERSHIP_STATUS_CHANGED',
      entityType: 'PROPERTY_MEMBERSHIP', entityId: membershipId,
      beforeData: { status: member.status }, afterData: { status },
    });
    return { status };
  });
}

export async function acceptPropertyInvitation(
  auth: AuthState,
  token: string,
  metadata: RequestMetadata,
) {
  return inTransaction(async (client) => {
    const result = await client.query<InvitationRow>(
      `SELECT pi.id, pi.email::text, pi.expires_at, pi.job_title,
              pi.pay_amount::text, pi.pay_currency, pi.pay_frequency, pi.employment_notes,
              p.id AS property_id, p.name AS property_name, aa.name AS account_name,
              inviter.display_name AS inviter_name, true AS existing_user
         FROM property_invitation pi
         JOIN property p ON p.id = pi.property_id AND p.deleted_at IS NULL AND p.status = 'ACTIVE'
         JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
         JOIN app_user inviter ON inviter.id = pi.invited_by
        WHERE pi.token_hash = $1 AND pi.status = 'PENDING'
        FOR UPDATE OF pi`,
      [hashToken(token)],
    );
    const invitation = result.rows[0];
    if (!invitation) throw notFound('La invitación no existe o ya fue utilizada.');
    if (invitation.expires_at.getTime() <= Date.now()) {
      throw new ApiError(410, 'INVITATION_EXPIRED', 'La invitación expiró. Solicita una nueva.');
    }
    if (invitation.email.toLowerCase() !== auth.email.toLowerCase()) {
      throw forbidden('INVITATION_EMAIL_MISMATCH', 'Esta invitación pertenece a otro correo electrónico.');
    }
    const roles = await invitationRoles(client, invitation.id);
    if (!roles.length) throw conflict('INVITATION_WITHOUT_ROLES', 'La invitación no tiene roles disponibles.');

    const existing = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM property_membership
        WHERE property_id = $1 AND user_id = $2 FOR UPDATE`,
      [invitation.property_id, auth.userId],
    );
    if (existing.rows[0]?.status === 'ACTIVE') {
      throw conflict('ALREADY_A_MEMBER', 'Ya perteneces a esta propiedad.');
    }
    const membership = existing.rows[0]
      ? await client.query<{ id: string }>(
        `UPDATE property_membership
            SET status = 'ACTIVE', job_title = $3, joined_at = now(), ended_at = NULL
          WHERE id = $1 AND property_id = $2 RETURNING id`,
        [existing.rows[0].id, invitation.property_id, invitation.job_title],
      )
      : await client.query<{ id: string }>(
        `INSERT INTO property_membership(property_id, user_id, status, job_title, joined_at, created_by)
         VALUES($1,$2,'ACTIVE',$3,now(),$4) RETURNING id`,
        [invitation.property_id, auth.userId, invitation.job_title, auth.userId],
      );
    const membershipId = membership.rows[0]!.id;
    await client.query(`DELETE FROM membership_role WHERE membership_id = $1`, [membershipId]);
    await client.query(
      `INSERT INTO membership_role(membership_id, role_id, property_id, assigned_by)
       SELECT $1, ir.role_id, ir.property_id, $2
         FROM invitation_role ir WHERE ir.invitation_id = $3`,
      [membershipId, auth.userId, invitation.id],
    );
    if (invitation.job_title) {
      await client.query(
        `UPDATE employment_term SET valid_until = current_date
          WHERE membership_id = $1 AND valid_until IS NULL`,
        [membershipId],
      );
      await client.query(
        `INSERT INTO employment_term(
           membership_id, job_title, amount, currency, frequency, valid_from, notes, created_by
         ) VALUES($1,$2,$3,$4,$5,current_date,$6,$7)`,
        [
          membershipId, invitation.job_title, invitation.pay_amount, invitation.pay_currency,
          invitation.pay_frequency, invitation.employment_notes, auth.userId,
        ],
      );
    }
    await client.query(
      `UPDATE property_invitation
          SET status = 'ACCEPTED', accepted_by = $2, accepted_at = now()
        WHERE id = $1`,
      [invitation.id, auth.userId],
    );
    await client.query(
      `UPDATE user_session
          SET active_property_id = $2, active_role_id = $3, last_seen_at = now()
        WHERE id = $1 AND revoked_at IS NULL`,
      [auth.sessionId, invitation.property_id, roles[0]!.id],
    );
    await audit(client, {
      auth, metadata, propertyId: invitation.property_id, roleId: roles[0]!.id,
      action: 'PROPERTY_INVITATION_ACCEPTED',
      entityType: 'PROPERTY_INVITATION', entityId: invitation.id,
      afterData: { propertyId: invitation.property_id, membershipId, roleIds: roles.map((role) => role.id) },
    });
    return {
      propertyId: invitation.property_id,
      propertyName: invitation.property_name,
      membershipId,
      roleId: roles[0]!.id,
      roles,
    };
  });
}
