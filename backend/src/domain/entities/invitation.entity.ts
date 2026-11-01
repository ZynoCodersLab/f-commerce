import { TenantEntity } from './base.entity.js';

export type InvitationRole = 'OWNER' | 'STAFF';

/**
 * Delivery state of an invitation email. `QUEUED` means the worker has not
 * settled it yet, `SKIPPED` means no provider is configured (development), and
 * `FAILED` carries a sanitized reason the team screen may show.
 */
export type InvitationEmailStatus = 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED';

/**
 * A pending invitation into a business. The raw token is never stored: only
 * its SHA256 hash is kept, and the plain link exists once in the response that
 * created or resent it.
 */
export interface Invitation extends TenantEntity {
  email: string;
  role: InvitationRole;
  tokenHash: string;
  invitedByUserId: string;
  acceptedByUserId?: string;
  expiresAt: Date;
  acceptedAt?: Date;
  revokedAt?: Date;
  lastSentAt: Date;
  emailStatus: InvitationEmailStatus;
  emailAttempts: number;
  lastEmailError?: string;
  sentAt?: Date;
}
