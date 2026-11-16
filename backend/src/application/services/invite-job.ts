/**
 * The contract shared by the queue producer and the job handler.
 *
 * It lives in the application layer because the handler owns it. The BullMQ
 * producer in infrastructure imports it from here, so the dependency points
 * inward and the application never reaches back out to a framework module.
 */

/** What a job carries. The raw token lives here only while the job is pending. */
export interface InviteEmailJobData {
  invitationId: string;
  tokenHash: string;
  /** The plain token. Removed from Redis once the job settles (AC-20). */
  token: string;
}

/** The first attempt plus three retries, at 1, 2 and 4 minutes (AC-3). */
export const INVITE_JOB_ATTEMPTS = 4;
