/**
 * The email port the invitation worker depends on.
 *
 * It lives in the application layer so the handler owns its contract and the
 * infrastructure adapters implement an inward facing port, never the reverse.
 */

/** Everything the invitation email needs. The token is already in the link. */
export interface InviteEmailContent {
  to: string;
  businessName: string;
  inviterName: string;
  role: 'OWNER' | 'STAFF';
  inviteUrl: string;
  expiresAt: Date;
  replyTo?: string;
}

/** The outcome of one provider send attempt. */
export interface SendResult {
  ok: boolean;
  /**
   * A short, safe reason for the team screen. Provider messages are trimmed of
   * anything that looks like a key, URL or stack.
   */
  errorCode?: string;
}
