import type {
  InviteAcceptRequest,
  InviteCreateRequest,
  InvitePreview,
  MemberRoleUpdateRequest,
  TeamInvitation,
  TeamListResponse,
  TeamMember,
} from '@f-commerce/contracts';
import { apiFetch } from './auth-client';

export interface TeamErrorBody {
  error?: string;
  message?: string;
  fields?: string[];
  invitationId?: string;
}

/** A failed team request with the server's machine readable details. */
export class TeamApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | undefined,
    public readonly fields: string[],
    public readonly body: TeamErrorBody,
  ) {
    super(message);
    this.name = 'TeamApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function parseResponse<T>(response: Response): Promise<T> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const record = isRecord(payload) ? payload : {};
    const code = typeof record.error === 'string' ? record.error : undefined;
    const message =
      (typeof record.message === 'string' && record.message) || code || 'The request failed';
    const fields = Array.isArray(record.fields)
      ? record.fields.filter((field): field is string => typeof field === 'string')
      : [];

    throw new TeamApiError(message, response.status, code, fields, record as TeamErrorBody);
  }

  if (response.status === 204) return undefined as T;
  if (isRecord(payload) && 'data' in payload) return payload.data as T;
  return payload as T;
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

/** The team screen's members and open invitations. */
export async function fetchTeam(): Promise<TeamListResponse['data']> {
  const response = await apiFetch('/api/team');
  return parseResponse<TeamListResponse['data']>(response);
}

export interface InviteSendResult {
  invitation: TeamInvitation;
  inviteUrl: string;
  emailStatus: TeamInvitation['emailStatus'];
  emailError: string | null;
}

export async function createInvite(input: InviteCreateRequest): Promise<InviteSendResult> {
  const response = await apiFetch('/api/team/invitations', jsonInit('POST', input));
  return parseResponse<InviteSendResult>(response);
}

export async function resendInvite(id: string): Promise<InviteSendResult> {
  const response = await apiFetch(
    `/api/team/invitations/${encodeURIComponent(id)}/resend`,
    jsonInit('POST'),
  );
  return parseResponse<InviteSendResult>(response);
}

export async function cancelInvite(id: string): Promise<void> {
  const response = await apiFetch(
    `/api/team/invitations/${encodeURIComponent(id)}`,
    jsonInit('DELETE'),
  );
  await parseResponse<unknown>(response);
}

export async function updateMemberRole(
  id: string,
  input: MemberRoleUpdateRequest,
): Promise<TeamMember> {
  const response = await apiFetch(
    `/api/team/members/${encodeURIComponent(id)}`,
    jsonInit('PATCH', input),
  );
  return parseResponse<TeamMember>(response);
}

export async function removeMember(id: string): Promise<void> {
  const response = await apiFetch(
    `/api/team/members/${encodeURIComponent(id)}`,
    jsonInit('DELETE'),
  );
  await parseResponse<unknown>(response);
}

/** Public preview for the invite page. No session is required or sent. */
export async function fetchInvitePreview(token: string): Promise<InvitePreview> {
  const response = await fetch(`/api/invitations/${encodeURIComponent(token)}`, {
    headers: { Accept: 'application/json' },
    credentials: 'include',
  });
  return parseResponse<InvitePreview>(response);
}

/** Accepts an invitation and returns the caller's new session tokens. */
export async function acceptInvite(
  token: string,
  input: InviteAcceptRequest,
): Promise<{ accessToken: string; businessId: string }> {
  const response = await apiFetch(`/api/invitations/${encodeURIComponent(token)}/accept`, {
    ...jsonInit('POST', input),
    credentials: 'include',
  });
  return parseResponse<{ accessToken: string; businessId: string }>(response);
}
