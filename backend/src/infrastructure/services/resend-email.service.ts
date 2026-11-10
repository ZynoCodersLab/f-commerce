import { Resend } from 'resend';
import { config } from '../config.js';
import {
  InviteEmailContent,
  buildInviteHtml,
  buildInviteSubject,
  buildInviteText,
} from './invite-email.js';

/** The sandbox sender a development machine uses when EMAIL_FROM is unset. */
const DEFAULT_INVITE_FROM = 'F Commerce <onboarding@resend.dev>';

/** One client for the process; the key is fixed at startup by the config gate. */
let resendClient: Resend | null = null;

function getResendClient(apiKey: string): Resend {
  return (resendClient ??= new Resend(apiKey));
}

/** The provider is configured (or not) in one place, so the worker can skip cleanly. */
export function isEmailConfigured(): boolean {
  return typeof config.RESEND_API_KEY === 'string' && config.RESEND_API_KEY.trim() !== '';
}

export interface SendResult {
  ok: boolean;
  /**
   * A short, safe reason for the team screen. Provider messages are trimmed of
   * anything that looks like a key, URL or stack.
   */
  errorCode?: string;
}

/**
 * Turn whatever the provider said into a short code the screen may show. The
 * raw text often echoes addresses or request ids, so it is reduced to a code
 * and never stored verbatim (AC-3).
 */
export function sanitiseEmailError(message: string | undefined): string {
  if (!message) return 'EMAIL_SEND_FAILED';
  const known: Record<string, string> = {
    'invalid api key': 'PROVIDER_UNAUTHORIZED',
    restricted_api_key: 'PROVIDER_UNAUTHORIZED',
    validation_error: 'PROVIDER_REJECTED',
    missing_api_key: 'PROVIDER_UNAUTHORIZED',
    rate_limit_exceeded: 'PROVIDER_RATE_LIMITED',
  };
  const lower = message.toLowerCase();
  for (const [needle, code] of Object.entries(known)) {
    if (lower.includes(needle)) return code;
  }
  return 'EMAIL_SEND_FAILED';
}

/**
 * Send one invitation through Resend.
 *
 * The SDK reports failure in the result rather than by throwing, so the result
 * is checked every time. The idempotency key ties one attempt to one token, so
 * a retry after a response was lost never sends a second email for the same
 * link.
 */
export async function sendInviteEmail(
  content: InviteEmailContent,
  idempotencyKey: string,
): Promise<SendResult> {
  const apiKey = config.RESEND_API_KEY;
  if (!apiKey) return { ok: false, errorCode: 'EMAIL_NOT_CONFIGURED' };

  const resend = getResendClient(apiKey);

  try {
    const { error } = await resend.emails.send(
      {
        from: config.EMAIL_FROM ?? DEFAULT_INVITE_FROM,
        to: content.to,
        subject: buildInviteSubject(content),
        html: buildInviteHtml(content),
        text: buildInviteText(content),
        replyTo: content.replyTo ?? config.EMAIL_REPLY_TO ?? undefined,
      },
      { idempotencyKey },
    );

    if (error) {
      return { ok: false, errorCode: sanitiseEmailError(error.message) };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, errorCode: sanitiseEmailError((error as Error).message) };
  }
}
