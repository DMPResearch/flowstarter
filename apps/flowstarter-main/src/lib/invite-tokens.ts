import 'server-only';
/**
 * Invite Token Management
 *
 * Creates and validates signed invitation tokens for team members.
 * Tokens are self-contained JWTs - no database required.
 */

import { SignJWT, jwtVerify } from 'jose';
import { publicAppOrigin } from '@flowstarter/platform-config';

const SECRET_KEY = new TextEncoder().encode(
  process.env.INVITE_TOKEN_SECRET ||
    process.env.CLERK_SECRET_KEY ||
    'fallback-secret-change-me'
);

const ISSUER = 'flowstarter';
const AUDIENCE = 'team-invite';

export interface InvitePayload {
  email: string;
  role: 'team' | 'admin';
  invitedBy: string;
  invitedByEmail: string;
}

export interface InviteToken extends InvitePayload {
  exp: number;
  iat: number;
}

/**
 * Create a signed invitation token
 */
export async function createInviteToken(
  payload: InvitePayload,
  expiresInDays: number = 7
): Promise<string> {
  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${expiresInDays}d`)
    .sign(SECRET_KEY);

  return token;
}

/**
 * Validate and decode an invitation token
 */
export async function validateInviteToken(
  token: string
): Promise<
  { valid: true; payload: InviteToken } | { valid: false; error: string }
> {
  try {
    const { payload } = await jwtVerify(token, SECRET_KEY, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    return {
      valid: true,
      payload: payload as unknown as InviteToken,
    };
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('expired')) {
        return { valid: false, error: 'This invitation has expired' };
      }
      if (error.message.includes('signature')) {
        return { valid: false, error: 'Invalid invitation link' };
      }
    }
    return { valid: false, error: 'Invalid invitation' };
  }
}

/**
 * Generate the full invitation URL
 */
export function getInviteUrl(token: string): string {
  return `${publicAppOrigin()}/admin/join?token=${encodeURIComponent(token)}`;
}
