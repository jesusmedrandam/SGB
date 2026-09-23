const configuredApiUrl = import.meta.env.VITE_API_URL?.trim();

export const API_URL = (configuredApiUrl || 'http://localhost:3000').replace(/\/$/, '');

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  isSuperadmin: boolean;
}

export interface ActiveContext {
  propertyId: string;
  roleId: string;
}

export interface SessionPayload {
  accessToken: string;
  accessExpiresAt: string;
  user: SessionUser;
  activeContext: ActiveContext | null;
}

export interface PropertyAccess {
  id: string;
  name: string;
  timezone: string;
  isOwner: boolean;
  roles: Array<{ id: string; code: string; name: string }>;
  enabledModules: string[];
  enabledSpecies: string[];
}

export interface SessionOverview {
  user: SessionUser;
  activeContext: ActiveContext | null;
  properties: PropertyAccess[];
  enabledUserModules: string[];
}

export interface RegistrationResult {
  userId: string;
  accountId: string;
  propertyId: string;
  verificationRequired: true;
  verificationExpiresAt: string;
  verificationDelivery: 'SENT' | 'UNAVAILABLE' | 'FAILED';
  verificationToken?: string;
}

export interface AdministrativeAccountSummary {
  id: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
  maxProperties: number;
  createdAt: string;
  owner: { id: string; name: string; email: string };
  propertyCount: number;
  collaboratorCount: number;
}

export interface PlatformOverview {
  totals: { users: number; accounts: number; properties: number; managedAnimals: number };
  accounts: AdministrativeAccountSummary[];
}

export interface AccountDetails {
  account: AdministrativeAccountSummary;
  properties: Array<{
    id: string;
    name: string;
    status: string;
    timezone: string;
    createdAt: string;
    memberCount: number;
    animalCount: number;
  }>;
  quotas: Array<{
    code: string;
    name: string;
    description: string;
    unit: 'BYTES' | 'COUNT';
    limitValue: number | null;
    usedValue: number;
    warningPercent: number;
  }>;
  modules: Array<{
    code: string;
    name: string;
    description: string | null;
    isCore: boolean;
    enabled: boolean;
  }>;
}

interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
}

interface ApiErrorEnvelope {
  ok: false;
  error?: { code?: string; message?: string };
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiRequestError(
      'No fue posible conectar con el servidor. Revisa tu conexión e inténtalo nuevamente.',
      0,
      'NETWORK_ERROR',
    );
  }

  const text = await response.text();
  const body = text ? JSON.parse(text) as ApiEnvelope<T> | ApiErrorEnvelope : null;
  if (!response.ok) {
    const failure = body as ApiErrorEnvelope | null;
    throw new ApiRequestError(
      failure?.error?.message || 'No fue posible completar la solicitud.',
      response.status,
      failure?.error?.code || 'REQUEST_FAILED',
    );
  }

  if (response.status === 204) return undefined as T;
  return (body as ApiEnvelope<T>).data;
}

export function login(email: string, password: string, deviceId: string) {
  return request<SessionPayload>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password, deviceId, deviceName: 'Navegador web' }),
  });
}

export function register(input: {
  displayName: string;
  propertyName: string;
  email: string;
  password: string;
}) {
  return request<RegistrationResult>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function verifyEmail(token: string) {
  return request<{ verified: true }>('/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export function resendVerification(email: string) {
  return request<{ accepted: true; verificationToken?: string }>('/auth/resend-verification', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function refreshSession() {
  return request<SessionPayload>('/auth/refresh', { method: 'POST' });
}

export function getSessionOverview(accessToken: string) {
  return request<SessionOverview>('/auth/me', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

export function changeContext(accessToken: string, propertyId: string, roleId: string) {
  return request<{ propertyId: string; roleId: string }>('/auth/context', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ propertyId, roleId }),
  });
}

export async function logout(accessToken: string | null) {
  await request<never>('/auth/logout', {
    method: 'POST',
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
}

const bearer = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });

export function getPlatformOverview(accessToken: string) {
  return request<PlatformOverview>('/superadmin/overview', { headers: bearer(accessToken) });
}

export function getAdministrativeAccount(accessToken: string, accountId: string) {
  return request<AccountDetails>(`/superadmin/accounts/${accountId}`, { headers: bearer(accessToken) });
}

export function updateAdministrativeAccount(
  accessToken: string,
  accountId: string,
  input: { status?: AdministrativeAccountSummary['status']; maxProperties?: number },
) {
  return request<{ status: string; maxProperties: number }>(`/superadmin/accounts/${accountId}`, {
    method: 'PATCH',
    headers: bearer(accessToken),
    body: JSON.stringify(input),
  });
}

export function updateAdministrativeQuota(
  accessToken: string,
  accountId: string,
  quotaCode: string,
  limitValue: number | null,
) {
  return request(`/superadmin/accounts/${accountId}/quotas/${quotaCode}`, {
    method: 'PUT',
    headers: bearer(accessToken),
    body: JSON.stringify({ limitValue }),
  });
}

export function updateAdministrativeModule(
  accessToken: string,
  accountId: string,
  moduleCode: string,
  enabled: boolean,
) {
  return request(`/superadmin/accounts/${accountId}/modules/${moduleCode}`, {
    method: 'PUT',
    headers: bearer(accessToken),
    body: JSON.stringify({ enabled }),
  });
}
