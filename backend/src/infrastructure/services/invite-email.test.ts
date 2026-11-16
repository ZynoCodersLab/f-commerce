import { describe, expect, it } from 'vitest';
import {
  buildInviteHtml,
  buildInviteSubject,
  buildInviteText,
  formatExpiry,
} from './invite-email.js';
import { sanitiseEmailError } from './resend-email.service.js';

// Covers AC-3: the invitation email names the business, the inviter, the role,
// the accept link, and the expiry, and a provider error is sanitised.

const content = {
  to: 'sam@example.com',
  businessName: 'Maya Threads',
  inviterName: 'Maya Owner',
  role: 'STAFF' as const,
  inviteUrl: 'https://shop.example.com/invite/raw-token',
  expiresAt: new Date('2026-11-08T14:05:00.000Z'),
};

describe('invitation email', () => {
  it('names the inviter and the business in the subject', () => {
    expect(buildInviteSubject(content)).toBe('Maya Owner invited you to Maya Threads');
  });

  it('writes the link, the role, and the expiry in the plain text part', () => {
    const text = buildInviteText(content);

    expect(text).toContain('https://shop.example.com/invite/raw-token');
    expect(text).toContain('as staff');
    expect(text).toContain('8 November 2026 at 14:05 UTC');
    expect(text).toContain('works once');
  });

  it('says owner when the invitation is for an owner', () => {
    expect(buildInviteText({ ...content, role: 'OWNER' })).toContain('as an owner');
  });

  it('escapes the business and inviter names in the HTML part', () => {
    const html = buildInviteHtml({
      ...content,
      businessName: '<script>alert(1)</script> & Co',
      inviterName: 'Maya "M" O\'Neil',
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; Co');
    expect(html).toContain('Maya &quot;M&quot; O&#39;Neil');
    expect(html).toContain('href="https://shop.example.com/invite/raw-token"');
  });

  it('renders the expiry as a UTC date and time', () => {
    expect(formatExpiry(content.expiresAt)).toBe('8 November 2026 at 14:05 UTC');
  });
});

describe('email error sanitiser', () => {
  it.each([
    ['401 Unauthorized: missing API key', 'EMAIL_SEND_FAILED'],
    ['invalid api key', 'PROVIDER_UNAUTHORIZED'],
    ['missing_api_key', 'PROVIDER_UNAUTHORIZED'],
    ['422 validation_error: invalid to field', 'PROVIDER_REJECTED'],
    ['rate_limit_exceeded', 'PROVIDER_RATE_LIMITED'],
    ['socket hang up', 'EMAIL_SEND_FAILED'],
    [undefined, 'EMAIL_SEND_FAILED'],
  ])('maps %s to %s', (message, expected) => {
    expect(sanitiseEmailError(message)).toBe(expected);
  });

  it('never passes the provider text through, which may hold an address', () => {
    expect(sanitiseEmailError('422 invalid to: sam@example.com')).not.toContain('sam@example.com');
  });
});
