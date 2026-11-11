'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { InvitePreview } from '@f-commerce/contracts';
import {
  Alert,
  Button,
  Card,
  Field,
  FormMessage,
  Input,
  Skeleton,
  Spinner,
} from '@/components/ui/primitives';
import { ThemeToggle } from '@/components/theme/theme';
import { useBusinessSettings } from '@/components/business/business-settings-provider';
import { apiFetch, clearAuth, getAuth, setAuth } from '@/lib/auth-client';
import { useRequireAuth } from '@/lib/auth-guard';
import { formatDateTime } from '@/lib/catalog-format';
import { TeamApiError, acceptInvite, fetchInvitePreview } from '@/lib/team-client';

type PageState = 'loading' | 'ready' | 'error';

type Problem = {
  title: string;
  body: string;
};

function problemFor(error: unknown): Problem {
  if (error instanceof TeamApiError) {
    switch (error.code) {
      case 'INVITE_NOT_FOUND':
        return {
          title: 'This invitation link is not valid',
          body: 'Ask the person who invited you to send a new one.',
        };
      case 'INVITE_EXPIRED':
        return {
          title: 'This invitation has expired',
          body: 'Invitations last 7 days. Ask for a fresh invitation to join.',
        };
      case 'INVITE_REVOKED':
        return {
          title: 'This invitation was cancelled',
          body: 'The person who invited you cancelled it. Ask them to invite you again.',
        };
      case 'INVITE_ALREADY_ACCEPTED':
        return {
          title: 'This invitation was already used',
          body: 'Sign in to open the business you joined.',
        };
      case 'RATE_LIMITED':
        return {
          title: 'Too many attempts',
          body: 'Try again later.',
        };
      default:
        return { title: 'This invitation cannot be used', body: error.message };
    }
  }
  return {
    title: 'Could not load this invitation',
    body: 'Check your connection and try again.',
  };
}

/** Decides the form an invited visitor sees from the preview. */
function formMode(preview: InvitePreview, signedInEmail: string | null) {
  if (preview.alreadyMember) return 'already-member' as const;
  const signedIn = signedInEmail !== null && signedInEmail === preview.email;
  // A session for someone else cannot accept this invitation (the API answers
  // EMAIL_MISMATCH), so ask them to sign out instead of offering a form that is
  // guaranteed to fail.
  if (signedInEmail !== null && !signedIn) return 'wrong-account' as const;
  if (preview.accountExists && preview.hasPassword) {
    return signedIn ? 'accept' : ('sign-in' as const);
  }
  return 'set-password' as const;
}

export default function InvitePage() {
  const params = useParams<{ token: string | string[] }>();
  const rawToken = params?.token;
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;

  // The invitation page serves signed in and signed out visitors alike. Read the
  // session so the right form is shown, but never send an authenticated visitor
  // away: the whole point of the link is to accept in place.
  const ready = useRequireAuth({ requireAuth: false, redirectAuthenticated: false });
  const router = useRouter();
  const { timezone, mounted } = useBusinessSettings();

  const nameId = useId();
  const passwordId = useId();
  const confirmPasswordId = useId();
  const [state, setState] = useState<PageState>('loading');
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [missingPassword, setMissingPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      if (!token) return;
      try {
        const data = await fetchInvitePreview(token);
        if (isCancelled()) return;
        setPreview(data);
        const email = await currentEmail();
        if (isCancelled()) return;
        setSignedInEmail(email);
        setState('ready');
      } catch (error) {
        if (isCancelled()) return;
        setProblem(problemFor(error));
        setState('error');
      }
    },
    [token],
  );

  useEffect(() => {
    let cancelled = false;
    // The state updates land after the fetch resolves, so this is not a render
    // time setState even though the helper is called from the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !preview) return;
    setFormError(null);
    setNeedsSignIn(false);
    setMissingPassword(false);

    const mode = formMode(preview, signedInEmail);
    // A signed in account accepts with its bearer token alone. Only a new
    // account, or an account that has no password yet, sets one here.
    const body: { name?: string; password?: string } = {};
    if (mode === 'set-password') {
      if (name.trim()) body.name = name.trim();
      body.password = password;
    }

    setSubmitting(true);
    try {
      const result = await acceptInvite(token, body);
      setAuth({ accessToken: result.accessToken, businessId: result.businessId });
      router.replace('/dashboard');
    } catch (error) {
      if (error instanceof TeamApiError) {
        if (error.code === 'SIGN_IN_REQUIRED') {
          setNeedsSignIn(true);
          setFormError('Sign in with this email address first, then come back to this link.');
          return;
        }
        if (error.code === 'EMAIL_MISMATCH') {
          setFormError('You are signed in with a different email address. Sign out and try again.');
          return;
        }
        if (error.code === 'INVITE_ALREADY_MEMBER') {
          setProblem({
            title: 'You are already on this team',
            body: 'Sign in to open the business.',
          });
          setState('error');
          return;
        }
        if (error.fields.includes('password')) {
          setMissingPassword(true);
          setFormError('Use a password of at least 8 characters.');
          return;
        }
        setProblem(problemFor(error));
        setState('error');
        return;
      }
      setFormError('Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  function signOut() {
    clearAuth();
    setSignedInEmail(null);
    setPassword('');
    setConfirmPassword('');
    if (token) void load();
  }

  if (!ready || state === 'loading') {
    return (
      <Shell>
        <div className="grid gap-4" aria-busy="true">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
        <span className="sr-only">
          <Spinner label="Loading invitation" />
        </span>
      </Shell>
    );
  }

  if (state === 'error' || !preview) {
    return (
      <Shell>
        <h1 className="text-2xl font-semibold text-ink">{problem?.title ?? 'Invitation'}</h1>
        <p className="mt-2 text-sm text-body">{problem?.body}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={() => void load()}>Try again</Button>
          <Button onClick={() => router.push('/login')} variant="secondary">
            Go to sign in
          </Button>
        </div>
      </Shell>
    );
  }

  const mode = formMode(preview, signedInEmail);
  const expires = mounted ? formatDateTime(preview.expiresAt, preview.timezone ?? timezone) : '';
  const passwordsMatch = password === confirmPassword;
  const showPasswordMismatch =
    mode === 'set-password' && confirmPassword.length > 0 && !passwordsMatch;

  return (
    <Shell>
      <p className="font-mono text-xs uppercase tracking-widest text-sky-strong">
        {preview.businessName}
      </p>
      <h1 className="mt-2 text-2xl font-semibold text-ink">Join {preview.businessName}</h1>
      <p className="mt-2 text-sm text-body">
        {preview.inviterName} invited you to join as{' '}
        <span className="font-semibold text-ink">{preview.role.toLowerCase()}</span> with{' '}
        <span className="font-semibold text-ink">{preview.email}</span>.
      </p>

      <dl className="mt-6 grid gap-3 rounded-md border border-border bg-surface-muted p-4 text-sm">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Email</dt>
          <dd className="break-all text-ink">{preview.email}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Role</dt>
          <dd className="capitalize text-ink">{preview.role.toLowerCase()}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Link expires</dt>
          <dd className="text-ink">{expires}</dd>
        </div>
      </dl>

      {mode === 'already-member' && (
        <div className="mt-6 grid gap-4">
          <Alert variant="neutral">
            This invitation is for <span className="font-semibold text-ink">{preview.email}</span>,
            who is already a member of {preview.businessName}. Sign in with that account to open the
            business.
          </Alert>
          <Button onClick={() => router.push('/login')}>Sign in</Button>
        </div>
      )}

      {mode === 'sign-in' && (
        <div className="mt-6 grid gap-4">
          <Alert variant="neutral">
            This email already has an account. Sign in with it, then open this link again.
          </Alert>
          <Button onClick={() => router.push('/login')}>Sign in</Button>
        </div>
      )}

      {mode === 'wrong-account' && (
        <div className="mt-6 grid gap-4">
          <Alert variant="neutral">
            You are signed in as <span className="font-semibold text-ink">{signedInEmail}</span>,
            but this invitation is for{' '}
            <span className="font-semibold text-ink">{preview.email}</span>. Sign out to accept it.
          </Alert>
          <Button onClick={signOut} variant="secondary">
            Sign out
          </Button>
        </div>
      )}

      {(mode === 'accept' || mode === 'set-password') && (
        <form className="mt-6 grid gap-5" noValidate onSubmit={handleSubmit}>
          {signedInEmail && signedInEmail === preview.email && (
            <p className="text-sm text-body">
              Signed in as <span className="font-semibold text-ink">{preview.email}</span>.{' '}
              <button
                className="min-h-11 text-sky-strong underline-offset-4 hover:underline"
                onClick={signOut}
                type="button"
              >
                Use a different account
              </button>
            </p>
          )}

          {mode === 'set-password' && (
            <Field
              description={
                preview.accountExists
                  ? 'Your account has no password yet. Add one to finish joining.'
                  : 'This creates your account for this business.'
              }
              htmlFor={nameId}
              label="Your name"
            >
              <Input
                autoComplete="name"
                id={nameId}
                maxLength={120}
                name="name"
                onChange={(event) => setName(event.target.value)}
                placeholder={preview.accountExists ? 'Optional' : 'Maya Rahman'}
                value={name}
              />
            </Field>
          )}

          {mode === 'set-password' && (
            <Field
              description="At least 8 characters."
              error={missingPassword ? 'Use a password of at least 8 characters.' : undefined}
              htmlFor={passwordId}
              label="Password"
            >
              <Input
                autoComplete="new-password"
                id={passwordId}
                minLength={8}
                name="password"
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </Field>
          )}

          {mode === 'set-password' && (
            <Field
              description="Type the same password again."
              error={showPasswordMismatch ? 'These passwords do not match.' : undefined}
              htmlFor={confirmPasswordId}
              label="Confirm password"
            >
              <Input
                autoComplete="new-password"
                id={confirmPasswordId}
                minLength={8}
                name="confirmPassword"
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
                type="password"
                value={confirmPassword}
              />
            </Field>
          )}

          {formError && <FormMessage id="invite-error">{formError}</FormMessage>}

          {needsSignIn && (
            <Button onClick={() => router.push('/login')} type="button" variant="secondary">
              Sign in first
            </Button>
          )}

          <Button
            disabled={
              submitting || (mode === 'set-password' && (password.length < 8 || !passwordsMatch))
            }
            type="submit"
          >
            {submitting ? 'Joining...' : `Join ${preview.businessName}`}
          </Button>
        </form>
      )}

      <p className="mt-8 text-sm text-body">
        Links work once and expire after 7 days. If this one stops working, ask{' '}
        {preview.inviterName} to send a new invitation.
      </p>
    </Shell>
  );
}

async function currentEmail(): Promise<string | null> {
  const auth = getAuth();
  if (!auth) return null;
  try {
    const response = await apiFetch('/api/auth/me');
    if (!response.ok) return null;
    const payload = (await response.json()) as { user?: { email?: unknown } };
    const email = payload.user?.email;
    return typeof email === 'string' ? email.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas px-4 py-10">
      <div className="mx-auto flex max-w-md items-center justify-between">
        <span className="font-mono text-xs uppercase tracking-widest text-sky-strong">
          F Commerce
        </span>
        <ThemeToggle />
      </div>
      <main className="mx-auto mt-8 max-w-md rounded-lg border border-border bg-surface p-6 shadow-card">
        <Card className="border-0 p-0 shadow-none">{children}</Card>
      </main>
    </div>
  );
}
