import type { RequestHandler } from 'express';
import { forbidden, unauthorized } from '../../core/errors.js';
import { pool } from '../../database/pool.js';
import { hashToken } from '../../security/tokens.js';

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token, extra] = header.trim().split(/\s+/);
  if (extra || scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

export const authenticate: RequestHandler = async (request, _response, next) => {
  try {
    const token = bearerToken(request.header('authorization'));
    if (!token) throw unauthorized();

    const result = await pool.query<{
      session_id: string;
      user_id: string;
      email: string;
      display_name: string;
      is_superadmin: boolean;
      active_property_id: string | null;
      active_role_id: string | null;
    }>(
      `SELECT s.id AS session_id, u.id AS user_id, u.email, u.display_name,
              u.is_superadmin, s.active_property_id, s.active_role_id
         FROM user_session s
         JOIN app_user u ON u.id = s.user_id
        WHERE s.access_token_hash = $1
          AND s.revoked_at IS NULL
          AND s.access_expires_at > now()
          AND s.expires_at > now()
          AND u.deleted_at IS NULL
          AND u.status = 'ACTIVE'`,
      [hashToken(token)],
    );
    const row = result.rows[0];
    if (!row) throw unauthorized();

    request.auth = {
      sessionId: row.session_id,
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      isSuperadmin: row.is_superadmin,
      activePropertyId: row.active_property_id,
      activeRoleId: row.active_role_id,
    };
    next();
  } catch (error) {
    next(error);
  }
};

export const requireSuperadmin: RequestHandler = (request, _response, next) => {
  if (!request.auth) return next(unauthorized());
  if (!request.auth.isSuperadmin) {
    return next(forbidden('SUPERADMIN_REQUIRED', 'Esta operación requiere acceso de superadministrador.'));
  }
  next();
};

export const requirePropertyContext: RequestHandler = async (request, _response, next) => {
  try {
    const auth = request.auth;
    if (!auth) throw unauthorized();
    if (!auth.activePropertyId || !auth.activeRoleId) {
      throw forbidden('PROPERTY_CONTEXT_REQUIRED', 'Selecciona una propiedad y un rol para continuar.');
    }

    const contextResult = await pool.query<{
      property_name: string;
      role_code: string;
      role_name: string;
      permission_code: string | null;
    }>(
      `SELECT p.name AS property_name, pr.code AS role_code, pr.name AS role_name,
              rp.permission_code
         FROM property_membership pm
         JOIN property p ON p.id = pm.property_id AND p.deleted_at IS NULL AND p.status = 'ACTIVE'
         JOIN administrative_account aa ON aa.id = p.account_id AND aa.status = 'ACTIVE'
         JOIN membership_role mr ON mr.membership_id = pm.id AND mr.property_id = pm.property_id
         JOIN property_role pr ON pr.id = mr.role_id AND pr.property_id = pm.property_id AND pr.active
         LEFT JOIN role_permission rp ON rp.role_id = pr.id
        WHERE pm.user_id = $1
          AND pm.property_id = $2
          AND pm.status = 'ACTIVE'
          AND pr.id = $3`,
      [auth.userId, auth.activePropertyId, auth.activeRoleId],
    );
    const first = contextResult.rows[0];
    if (!first) throw forbidden('PROPERTY_CONTEXT_REVOKED', 'El acceso a esta propiedad o rol ya no está disponible.');

    const moduleResult = await pool.query<{ module_code: string }>(
      `SELECT module_code
         FROM effective_property_module
        WHERE property_id = $1 AND enabled`,
      [auth.activePropertyId],
    );
    const speciesResult = await pool.query<{ species_code: string }>(
      `SELECT species_code
         FROM effective_property_species
        WHERE property_id = $1 AND enabled`,
      [auth.activePropertyId],
    );

    request.propertyContext = {
      propertyId: auth.activePropertyId,
      propertyName: first.property_name,
      roleId: auth.activeRoleId,
      roleCode: first.role_code,
      roleName: first.role_name,
      permissions: new Set(contextResult.rows.flatMap((row) => row.permission_code ? [row.permission_code] : [])),
      enabledModules: new Set(moduleResult.rows.map((row) => row.module_code)),
      enabledSpecies: new Set(speciesResult.rows.map((row) => row.species_code)),
    };
    next();
  } catch (error) {
    next(error);
  }
};

export function requirePermission(permission: string): RequestHandler {
  return (request, _response, next) => {
    const context = request.propertyContext;
    if (!context) return next(forbidden('PROPERTY_CONTEXT_REQUIRED', 'Selecciona una propiedad y un rol para continuar.'));
    if (!context.permissions.has(permission)) {
      return next(forbidden('PERMISSION_DENIED', 'El rol activo no permite realizar esta acción.'));
    }
    next();
  };
}

export function requireModule(moduleCode: string): RequestHandler {
  return (request, _response, next) => {
    const context = request.propertyContext;
    if (!context) return next(forbidden('PROPERTY_CONTEXT_REQUIRED', 'Selecciona una propiedad y un rol para continuar.'));
    if (!context.enabledModules.has(moduleCode)) {
      return next(forbidden('MODULE_DISABLED', 'Este módulo no está habilitado para la propiedad activa.'));
    }
    next();
  };
}
