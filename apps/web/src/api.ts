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
