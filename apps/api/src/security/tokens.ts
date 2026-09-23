import { createHash, randomBytes } from 'node:crypto';

type TokenKind = 'access' | 'refresh' | 'verify' | 'reset' | 'invite';

const prefixes: Record<TokenKind, string> = {
  access: 'sgb_at_',
  refresh: 'sgb_rt_',
  verify: 'sgb_ev_',
  reset: 'sgb_pr_',
  invite: 'sgb_pi_',
};

export interface IssuedToken {
  value: string;
  hash: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function issueToken(kind: TokenKind): IssuedToken {
  const value = `${prefixes[kind]}${randomBytes(32).toString('base64url')}`;
  return { value, hash: hashToken(value) };
}
