export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const unauthorized = (message = 'La sesión no es válida o expiró.') =>
  new ApiError(401, 'UNAUTHORIZED', message);

export const forbidden = (code: string, message: string) =>
  new ApiError(403, code, message);

export const conflict = (code: string, message: string) =>
  new ApiError(409, code, message);

export const invalidRequest = (code: string, message: string) =>
  new ApiError(400, code, message);
