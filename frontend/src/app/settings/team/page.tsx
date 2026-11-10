'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, RotateCw, Trash2, UserPlus, X } from 'lucide-react';
import type { TeamInvitation, TeamMember } from '@f-commerce/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormMessage,
  Input,
  RecordCard,
  Select,
  Skeleton,
  Spinner,
} from '@/components/ui/primitives';
import { AppShell } from '@/components/shell/shell';
import { useBusinessSettings } from '@/components/business/business-settings-provider';
import { clearAuth, getAuth, getUserIdFromToken } from '@/lib/auth-client';
import { useRequireAuth } from '@/lib/auth-guard';
import { formatDateTime } from '@/lib/catalog-format';
import {
  TeamApiError,
  cancelInvite,
  createInvite,
  fetchTeam,
  removeMember,
  resendInvite,
  updateMemberRole,
} from '@/lib/team-client';
import type { InviteSendResult } from '@/lib/team-client';

type LoadState = 'loading' | 'ready' | 'error';

/** A pending poll while any invitation is still queued for sending. */
const POLL_INTERVAL_MS = 5_000;
/** After the first minute, slow down so a stuck worker is cheap to watch. */
const SLOW_POLL_INTERVAL_MS = 30_000;
/** One minute of five second polls before backing off. */
const FAST_POLLS = 12;

const EMAIL_STATUS_LABEL: Record<TeamInvitation['emailStatus'], string> = {
  QUEUED: 'Sending',
  SENT: 'Email sent',
  FAILED: 'Email failed',
  SKIPPED: 'Not emailed',
};

const EMAIL_ERROR_LABEL: Record<string, string> = {
  QUEUE_UNAVAILABLE: 'The email service is not available right now.',
  INVITE_EXPIRED: 'The invitation expired before it could be sent.',
  PROVIDER_UNAUTHORIZED: 'The email provider rejected our credentials.',
  PROVIDER_REJECTED: 'The email provider rejected the address.',
  PROVIDER_RATE_LIMITED: 'The email provider is rate limiting us.',
  EMAIL_SEND_FAILED: 'The email could not be sent.',
};

function emailStatusPill(status: TeamInvitation['emailStatus']) {
  if (status === 'SENT') return 'success' as const;
  if (status === 'FAILED') return 'danger' as const;
  if (status === 'QUEUED') return 'warning' as const;
  return 'neutral' as const;
}

function inviteLinkNotice(result: InviteSendResult): string {
  if (result.emailStatus === 'SENT') {
    return 'Invitation sent. The link also works if you share it directly.';
  }
  if (result.emailStatus === 'QUEUED') {
    return 'Queued for sending. The link below works right now.';
  }
  if (result.emailStatus === 'SKIPPED') {
    return 'Email is not configured here, so no message was sent. Share the link below instead.';
  }
  return 'The email could not be sent. Share the link below instead.';
}

export default function TeamPage() {
  const ready = useRequireAuth();
  const router = useRouter();
  const { timezone, mounted } = useBusinessSettings();

  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invitations, setInvitations] = useState<TeamInvitation[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<InviteSendResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    { kind: 'cancel'; invitation: TeamInvitation } | { kind: 'remove'; member: TeamMember } | null
  >(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const handleAccessLost = useCallback(() => {
    clearAuth();
    router.replace('/login');
  }, [router]);

  // The signed in user's id comes from the access token, which only exists in
  // the browser, so it is read once when the page opens.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setCurrentUserId(getUserIdFromToken(getAuth()?.accessToken ?? null));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const load = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      try {
        const data = await fetchTeam();
        if (isCancelled()) return;
        setMembers(data.members);
        setInvitations(data.invitations);
        setState('ready');
        setError(null);
      } catch (caught) {
        if (isCancelled()) return;
        if (caught instanceof TeamApiError && caught.code === 'BUSINESS_ACCESS_DENIED') {
          handleAccessLost();
          return;
        }
        setError(caught instanceof Error ? caught.message : 'Could not load your team');
        setState('error');
      }
    },
    [handleAccessLost],
  );

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    // The state updates land after the fetch resolves, so this is not a render
    // time setState even though the helper is called from the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [ready, reloadKey, load]);

  const queued = invitations.some((invitation) => invitation.emailStatus === 'QUEUED');

  useEffect(() => {
    if (!queued || !ready) return;
    let cancelled = false;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout>;

    // A chained timeout instead of an interval so the delay can grow once the
    // send has been queued for a minute. The happy path still settles within
    // five seconds; a stuck worker costs one request every thirty seconds.
    const schedule = () => {
      const delay = polls < FAST_POLLS ? POLL_INTERVAL_MS : SLOW_POLL_INTERVAL_MS;
      timer = setTimeout(() => {
        if (cancelled) return;
        polls += 1;
        void load().finally(() => {
          if (!cancelled) schedule();
        });
      }, delay);
    };

    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [queued, ready, load]);

  const isOwner = useMemo(() => {
    const me = members.find((member) => member.userId === currentUserId);
    return me?.role === 'OWNER';
  }, [members, currentUserId]);

  async function handleInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailError(null);
    setSending(true);
    try {
      const result = await createInvite({ email, role: 'STAFF' });
      setSent(result);
      setEmail('');
      setReloadKey((key) => key + 1);
    } catch (caught) {
      if (caught instanceof TeamApiError) {
        if (caught.code === 'BUSINESS_ACCESS_DENIED') return handleAccessLost();
        if (caught.code === 'INVITE_ALREADY_PENDING') {
          setEmailError('This person already has a pending invitation. Resend or cancel it below.');
          setReloadKey((key) => key + 1);
          return;
        }
        if (caught.code === 'INVITE_ALREADY_MEMBER') {
          setEmailError('This person is already on your team.');
          return;
        }
        if (caught.fields.includes('email')) {
          setEmailError('Enter a valid email address.');
          return;
        }
        setEmailError(caught.message);
        return;
      }
      setEmailError('Could not send the invitation. Try again.');
    } finally {
      setSending(false);
    }
  }

  async function handleResend(invitation: TeamInvitation) {
    setBusyId(invitation.id);
    setNotice(null);
    try {
      const result = await resendInvite(invitation.id);
      setSent(result);
      setReloadKey((key) => key + 1);
    } catch (caught) {
      if (caught instanceof TeamApiError && caught.code === 'BUSINESS_ACCESS_DENIED') {
        return handleAccessLost();
      }
      setNotice(
        caught instanceof TeamApiError && caught.code === 'RATE_LIMITED'
          ? 'Too many invitations in the last hour. Try again later.'
          : caught instanceof TeamApiError && caught.code === 'INVITE_RESEND_CONFLICT'
            ? 'This invitation was just resent from somewhere else. The newest link is below.'
            : 'Could not resend the invitation. Try again.',
      );
      setReloadKey((key) => key + 1);
    } finally {
      setBusyId(null);
    }
  }

  async function handleRoleChange(member: TeamMember, role: 'OWNER' | 'STAFF') {
    setBusyId(member.id);
    setNotice(null);
    try {
      await updateMemberRole(member.id, { role });
      setNotice(
        role === 'OWNER'
          ? `${member.name} is now an owner.`
          : `${member.name} is now a staff member.`,
      );
      setReloadKey((key) => key + 1);
    } catch (caught) {
      if (caught instanceof TeamApiError && caught.code === 'BUSINESS_ACCESS_DENIED') {
        return handleAccessLost();
      }
      setNotice(
        caught instanceof TeamApiError && caught.code === 'LAST_OWNER'
          ? 'A team needs at least one owner, so the last owner keeps that role.'
          : 'Could not change that role. Try again.',
      );
    } finally {
      setBusyId(null);
    }
  }

  async function runConfirm() {
    if (!confirm) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      if (confirm.kind === 'cancel') {
        const cancelledId = confirm.invitation.id;
        await cancelInvite(cancelledId);
        // The one time link this panel shows is now dead, so drop it rather than
        // leave a link on screen that no longer works.
        setSent((current) => (current?.invitation.id === cancelledId ? null : current));
        setNotice('Invitation cancelled. The link no longer works.');
      } else {
        await removeMember(confirm.member.id);
        setNotice(`${confirm.member.name} was removed from the team.`);
      }
      setConfirm(null);
      setReloadKey((key) => key + 1);
    } catch (caught) {
      if (caught instanceof TeamApiError && caught.code === 'BUSINESS_ACCESS_DENIED') {
        setConfirm(null);
        return handleAccessLost();
      }
      // Keep the dialog open on a failure so the message is visible and the
      // action can be retried; closing it made a failed removal look done.
      setConfirmError('That did not work. Try again.');
    } finally {
      setConfirmBusy(false);
    }
  }

  if (!ready) {
    return (
      <AppShell>
        <div className="p-8">
          <Spinner label="Loading" />
        </div>
      </AppShell>
    );
  }

  const date = (value: string) => (mounted ? formatDateTime(value, timezone) : '');

  // A sent invitation shows when it went out. One still waiting shows the last
  // attempt, labelled Queued so the two are never confused (AC-5).
  const sentLabel = (invitation: TeamInvitation) => {
    if (invitation.sentAt) return date(invitation.sentAt);
    return mounted ? `Queued ${date(invitation.lastSentAt)}` : '';
  };

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-8">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Team</h1>
          <p className="mt-1 text-sm text-body">
            Invite staff with their email. Owners manage roles and invitations, staff can view the
            team.
          </p>
        </div>

        {notice && (
          <Alert variant="neutral">
            <div className="flex items-start justify-between gap-3">
              <p>{notice}</p>
              <Button onClick={() => setNotice(null)} variant="quiet">
                Dismiss
              </Button>
            </div>
          </Alert>
        )}

        {state === 'loading' && (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}

        {state === 'error' && (
          <ErrorState onRetry={() => setReloadKey((key) => key + 1)}>
            {error ?? 'Could not load your team'}
          </ErrorState>
        )}

        {state === 'ready' && (
          <>
            {isOwner && (
              <Card>
                <h2 className="text-lg font-semibold text-ink">Invite a staff member</h2>
                <p className="mt-1 text-sm text-body">
                  They receive a link that works once and expires in 7 days.
                </p>
                <form className="mt-5 grid gap-4" onSubmit={handleInvite} noValidate>
                  <Field
                    description="We send the invitation to this address."
                    error={emailError ?? undefined}
                    htmlFor="invite-email"
                    label="Email address"
                  >
                    <Input
                      autoComplete="email"
                      id="invite-email"
                      inputMode="email"
                      name="email"
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="name@example.com"
                      required
                      type="email"
                      value={email}
                    />
                  </Field>
                  <div>
                    <Button disabled={sending || email.trim().length === 0} type="submit">
                      <UserPlus aria-hidden={true} size={16} />
                      {sending ? 'Sending...' : 'Send invitation'}
                    </Button>
                  </div>
                </form>

                {sent && (
                  <div className="mt-5 grid gap-3 rounded-md border border-border bg-surface-muted p-4">
                    <p className="text-sm text-body">{inviteLinkNotice(sent)}</p>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <code
                        aria-label="Invitation link"
                        className="min-w-0 flex-1 break-all rounded-md bg-surface p-3 font-mono text-sm text-ink"
                      >
                        {sent.inviteUrl}
                      </code>
                      <div className="flex gap-2">
                        <Button
                          onClick={() => void copyLink(sent.inviteUrl, setNotice)}
                          variant="secondary"
                        >
                          <Copy aria-hidden={true} size={16} />
                          Copy link
                        </Button>
                        <Button onClick={() => setSent(null)} variant="quiet">
                          Done
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-muted">
                      This link is shown once. Resend the invitation if you lose it.
                    </p>
                  </div>
                )}
              </Card>
            )}

            <Card>
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-ink">Members</h2>
                <Badge>{members.length}</Badge>
              </div>
              {members.length === 0 ? (
                <div className="mt-4">
                  <EmptyState>No members yet.</EmptyState>
                </div>
              ) : (
                <>
                  <DataTable
                    columns={[
                      {
                        key: 'name',
                        label: 'Name',
                        render: (member) => (
                          <span className="font-semibold text-ink">{member.name}</span>
                        ),
                      },
                      { key: 'email', label: 'Email' },
                      {
                        key: 'role',
                        label: 'Role',
                        render: (member) => (
                          <span className="capitalize">{member.role.toLowerCase()}</span>
                        ),
                      },
                      {
                        key: 'joinedAt',
                        label: 'Joined',
                        render: (member) => <span>{date(member.joinedAt)}</span>,
                      },
                      {
                        key: 'id',
                        label: 'Actions',
                        render: (member) => (
                          <MemberActions
                            busy={busyId === member.id}
                            idPrefix="table"
                            isOwner={isOwner}
                            isSelf={member.userId === currentUserId}
                            member={member}
                            onRemove={() => {
                              setConfirmError(null);
                              setConfirm({ kind: 'remove', member });
                            }}
                            onRoleChange={(role) => void handleRoleChange(member, role)}
                          />
                        ),
                      },
                    ]}
                    rows={members}
                  />
                  <div className="grid gap-3 md:hidden">
                    {members.map((member) => (
                      <RecordCard key={member.id}>
                        <div>
                          <p className="font-semibold text-ink">{member.name}</p>
                          <p className="text-sm text-body">{member.email}</p>
                        </div>
                        <dl className="grid grid-cols-2 gap-2 text-sm">
                          <div>
                            <dt className="text-muted">Role</dt>
                            <dd className="capitalize text-ink">{member.role.toLowerCase()}</dd>
                          </div>
                          <div>
                            <dt className="text-muted">Joined</dt>
                            <dd className="text-ink">{date(member.joinedAt)}</dd>
                          </div>
                        </dl>
                        <MemberActions
                          busy={busyId === member.id}
                          idPrefix="card"
                          isOwner={isOwner}
                          isSelf={member.userId === currentUserId}
                          member={member}
                          onRemove={() => {
                            setConfirmError(null);
                            setConfirm({ kind: 'remove', member });
                          }}
                          onRoleChange={(role) => void handleRoleChange(member, role)}
                        />
                      </RecordCard>
                    ))}
                  </div>
                </>
              )}
            </Card>

            <Card>
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-ink">Invitations</h2>
                <Badge>{invitations.length}</Badge>
              </div>
              {invitations.length === 0 ? (
                <div className="mt-4">
                  <EmptyState>No open invitations.</EmptyState>
                </div>
              ) : (
                <>
                  <DataTable
                    columns={[
                      { key: 'email', label: 'Email' },
                      {
                        key: 'role',
                        label: 'Role',
                        render: (invitation) => (
                          <span className="capitalize">{invitation.role.toLowerCase()}</span>
                        ),
                      },
                      {
                        key: 'invitedByName',
                        label: 'Invited by',
                        render: (invitation) => <span>{invitation.invitedByName}</span>,
                      },
                      {
                        key: 'status',
                        label: 'Status',
                        render: (invitation) => <InviteStatus invitation={invitation} />,
                      },
                      {
                        key: 'sentAt',
                        label: 'Sent',
                        render: (invitation) => <span>{sentLabel(invitation)}</span>,
                      },
                      {
                        key: 'expiresAt',
                        label: 'Expires',
                        render: (invitation) => <span>{date(invitation.expiresAt)}</span>,
                      },
                      {
                        key: 'id',
                        label: 'Actions',
                        render: (invitation) => (
                          <InviteActions
                            busy={busyId === invitation.id}
                            isOwner={isOwner}
                            onCancel={() => {
                              setConfirmError(null);
                              setConfirm({ kind: 'cancel', invitation });
                            }}
                            onResend={() => void handleResend(invitation)}
                          />
                        ),
                      },
                    ]}
                    rows={invitations}
                  />
                  <div className="grid gap-3 md:hidden">
                    {invitations.map((invitation) => (
                      <RecordCard key={invitation.id}>
                        <div>
                          <p className="font-semibold text-ink">{invitation.email}</p>
                          <p className="text-sm text-body">Invited by {invitation.invitedByName}</p>
                        </div>
                        <InviteStatus invitation={invitation} />
                        <dl className="grid grid-cols-2 gap-2 text-sm">
                          <div>
                            <dt className="text-muted">Sent</dt>
                            <dd className="text-ink">{sentLabel(invitation)}</dd>
                          </div>
                          <div>
                            <dt className="text-muted">Expires</dt>
                            <dd className="text-ink">{date(invitation.expiresAt)}</dd>
                          </div>
                        </dl>
                        <InviteActions
                          busy={busyId === invitation.id}
                          isOwner={isOwner}
                          onCancel={() => {
                            setConfirmError(null);
                            setConfirm({ kind: 'cancel', invitation });
                          }}
                          onResend={() => void handleResend(invitation)}
                        />
                      </RecordCard>
                    ))}
                  </div>
                </>
              )}
            </Card>
          </>
        )}
      </div>

      <Dialog
        description={
          confirm?.kind === 'cancel'
            ? `The link sent to ${confirm.invitation.email} stops working immediately.`
            : confirm?.kind === 'remove'
              ? `${confirm.member.name} loses access to this business right away.`
              : undefined
        }
        onClose={() => {
          if (confirmBusy) return;
          setConfirm(null);
        }}
        open={confirm !== null}
        title={confirm?.kind === 'cancel' ? 'Cancel this invitation?' : 'Remove this member?'}
      >
        <div className="mt-6 flex justify-end gap-3">
          <Button disabled={confirmBusy} onClick={() => setConfirm(null)} variant="secondary">
            Keep it
          </Button>
          <Button disabled={confirmBusy} onClick={() => void runConfirm()} variant="danger">
            {confirmBusy
              ? 'Working...'
              : confirm?.kind === 'cancel'
                ? 'Cancel invitation'
                : 'Remove member'}
          </Button>
        </div>
        {confirmError && <FormMessage id="confirm-error">{confirmError}</FormMessage>}
      </Dialog>
    </AppShell>
  );
}

function MemberActions({
  member,
  idPrefix,
  isOwner,
  isSelf,
  busy,
  onRoleChange,
  onRemove,
}: {
  member: TeamMember;
  idPrefix: 'table' | 'card';
  isOwner: boolean;
  isSelf: boolean;
  busy: boolean;
  onRoleChange: (role: 'OWNER' | 'STAFF') => void;
  onRemove: () => void;
}) {
  if (!isOwner) {
    return <span className="text-sm text-muted">View only</span>;
  }

  // The table and the card grid stay mounted together, so the id includes the
  // layout to keep each label paired with exactly one control (AC-21).
  const roleId = `role-${idPrefix}-${member.id}`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={roleId}>
        Role for {member.name}
      </label>
      <Select
        className="max-w-32"
        disabled={busy || isSelf}
        id={roleId}
        onChange={(event) => onRoleChange(event.target.value === 'OWNER' ? 'OWNER' : 'STAFF')}
        value={member.role}
      >
        <option value="OWNER">Owner</option>
        <option value="STAFF">Staff</option>
      </Select>
      <Button
        disabled={busy || isSelf}
        onClick={onRemove}
        title={isSelf ? 'You cannot remove yourself' : undefined}
        variant="quiet"
      >
        <Trash2 aria-hidden={true} size={16} />
        Remove
      </Button>
    </div>
  );
}

function InviteStatus({ invitation }: { invitation: TeamInvitation }) {
  return (
    <div className="grid gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <Badge
          className={invitation.status === 'EXPIRED' ? 'bg-warning-soft text-warning' : undefined}
        >
          {invitation.status === 'EXPIRED' ? 'Expired' : 'Pending'}
        </Badge>
        <Badge className={statusClass(invitation.emailStatus)}>
          {EMAIL_STATUS_LABEL[invitation.emailStatus]}
        </Badge>
      </span>
      {invitation.emailError && (
        <span className="text-xs text-body">
          {EMAIL_ERROR_LABEL[invitation.emailError] ?? 'The email could not be sent.'}
        </span>
      )}
    </div>
  );
}

function statusClass(status: TeamInvitation['emailStatus']): string | undefined {
  switch (emailStatusPill(status)) {
    case 'success':
      return 'bg-success-soft text-success';
    case 'danger':
      return 'bg-danger-soft text-danger';
    case 'warning':
      return 'bg-warning-soft text-warning';
    default:
      return undefined;
  }
}

function InviteActions({
  isOwner,
  busy,
  onResend,
  onCancel,
}: {
  isOwner: boolean;
  busy: boolean;
  onResend: () => void;
  onCancel: () => void;
}) {
  if (!isOwner) {
    return <span className="text-sm text-muted">View only</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={busy} onClick={onResend} variant="secondary">
        {busy ? <Spinner label="Working" /> : <RotateCw aria-hidden={true} size={16} />}
        Resend
      </Button>
      <Button disabled={busy} onClick={onCancel} variant="quiet">
        <X aria-hidden={true} size={16} />
        Cancel
      </Button>
    </div>
  );
}

async function copyLink(url: string, onDone: (message: string) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    onDone('Invite link copied.');
  } catch {
    onDone('Copying is blocked here. Select the link and copy it by hand.');
  }
}
