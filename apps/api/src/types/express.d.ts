import type { AuthState, PropertyContext } from '../modules/auth/auth.types.js';

declare global {
  namespace Express {
    interface Request {
      id: string;
      auth?: AuthState;
      propertyContext?: PropertyContext;
    }
  }
}

export {};
