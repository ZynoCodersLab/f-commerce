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

/** Render a date in UTC, e.g. "1 November 2026 at 14:05 UTC". */
export function formatExpiry(expiresAt: Date): string {
  return `${new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(expiresAt)} at ${new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(expiresAt)} UTC`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildInviteSubject(content: InviteEmailContent): string {
  return `${content.inviterName} invited you to ${content.businessName}`;
}

export function buildInviteText(content: InviteEmailContent): string {
  const roleLine =
    content.role === 'OWNER'
      ? `You have been invited as an owner of ${content.businessName}.`
      : `You have been invited to join the team at ${content.businessName} as staff.`;

  return [
    `Hello,`,
    ``,
    `${content.inviterName} invited you to ${content.businessName} on F Commerce.`,
    roleLine,
    ``,
    `Accept the invitation:`,
    content.inviteUrl,
    ``,
    `This link works once and expires on ${formatExpiry(content.expiresAt)}.`,
    `If you were not expecting this email you can ignore it.`,
    ``,
    `F Commerce Order desk`,
  ].join('\n');
}

export function buildInviteHtml(content: InviteEmailContent): string {
  const business = escapeHtml(content.businessName);
  const inviter = escapeHtml(content.inviterName);
  const roleLine =
    content.role === 'OWNER'
      ? `You have been invited as an owner of <strong>${business}</strong>.`
      : `You have been invited to join the team at <strong>${business}</strong> as staff.`;

  // Inline styles only: email clients drop stylesheets and most of flex layout.
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f4f5f7;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#1b1f24;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #d9dee5;border-radius:12px;">
      <tr>
        <td style="padding:28px;">
          <p style="margin:0 0 4px;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#3f6f8f;">F Commerce</p>
          <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;">Join ${business}</h1>
          <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">
            ${inviter} invited you to ${business} on F Commerce.
          </p>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.6;">${roleLine}</p>
          <p style="margin:0 0 24px;">
            <a href="${escapeHtml(content.inviteUrl)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#1b1f24;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">Accept invitation</a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#4b5563;">
            If the button does not work, open this link:
          </p>
          <p style="margin:0 0 20px;font-size:13px;line-height:1.6;word-break:break-all;">
            <a href="${escapeHtml(content.inviteUrl)}" style="color:#2b5f7d;">${escapeHtml(content.inviteUrl)}</a>
          </p>
          <p style="margin:0;font-size:13px;line-height:1.6;color:#4b5563;">
            This link works once and expires on ${escapeHtml(formatExpiry(content.expiresAt))}.
          </p>
        </td>
      </tr>
    </table>
    <p style="max-width:520px;margin:16px auto 0;font-size:12px;line-height:1.6;color:#6b7280;text-align:center;">
      If you were not expecting this email you can ignore it.
    </p>
  </body>
</html>`;
}
