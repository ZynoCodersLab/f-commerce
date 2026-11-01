import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { invitationRouter, teamRouter } from './team.controller.js';
import { config } from '../../infrastructure/config.js';
import { getDb } from '../../infrastructure/database/drizzle/client.js';
import {
  startPg,
  stopPg,
  resetDatabase,
  seedMembership,
} from '../../test-support/pg-test-database.js';
import {
  auditLogs,
  businessMembers,
  invitations,
  users,
} from '../../infrastructure/database/drizzle/schema.js';
import { hashInviteToken } from '../../domain/invitation-token.js';
import { and, eq } from 'drizzle-orm';

const BIZ = '00000000-0000-0000-0000-0000000000c1';
const OTHER_BIZ = '00000000-0000-0000-0000-0000000000c2';
const OWNER = '00000000-0000-0000-0000-0000000000d1';
const STAFF = '00000000-0000-0000-0000-0000000000d2';
const OUTSIDER = '00000000-0000-0000-0000-0000000000d3';

const app = express();
app.use(express.json());
app.use(cookieParser());
// The rate limiters have their own test. Route tests exercise other behaviour,
// so turn them off the way a local run does.
beforeAll(async () => {
  config.RATE_LIMIT_DISABLED = true;
  await startPg();
});
app.use('/api/team', teamRouter);
app.use('/api/invitations', invitationRouter);

function signIn(userId: string): string {
  return jwt.sign(
    { userId, memberships: [{ businessId: BIZ, role: 'OWNER' }] },
    config.JWT_SECRET,
    {
      expiresIn: '15m',
    },
  );
}

function asOwner(path: string) {
  return request(app)
    .get(path)
    .set('Authorization', `Bearer ${signIn(OWNER)}`)
    .set('x-business-id', BIZ);
}

function later(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function pendingInvitation(email: string, token = `token-${email}`) {
  const rows = await getDb()
    .insert(invitations)
    .values({
      businessId: BIZ,
      email,
      role: 'STAFF',
      tokenHash: hashInviteToken(token),
      invitedByUserId: OWNER,
      expiresAt: later(7),
    })
    .returning({ id: invitations.id });
  return rows[0].id;
}

async function expiredInvitation(email: string, token = `expired-${email}`) {
  const rows = await getDb()
    .insert(invitations)
    .values({
      businessId: BIZ,
      email,
      role: 'STAFF',
      tokenHash: hashInviteToken(token),
      invitedByUserId: OWNER,
      expiresAt: new Date(Date.now() - 60_000),
    })
    .returning({ id: invitations.id });
  return rows[0].id;
}

beforeAll(async () => {
  await startPg();
});
afterAll(async () => {
  await stopPg();
});

beforeEach(async () => {
  await resetDatabase();
  await seedMembership(BIZ, OWNER, 'OWNER');
  await seedMembership(BIZ, STAFF, 'STAFF');
  await seedMembership(OTHER_BIZ, OUTSIDER, 'OWNER');
  await getDb()
    .update(users)
    .set({ name: 'Maya Owner', email: 'maya@example.com' })
    .where(eq(users.id, OWNER));
  await getDb()
    .update(users)
    .set({ name: 'Sam Staff', email: 'sam@example.com' })
    .where(eq(users.id, STAFF));
});

describe('GET /api/team', () => {
  it('returns active members and live invitations to an owner', async () => {
    await pendingInvitation('new@example.com');

    const response = await asOwner('/api/team');

    expect(response.status).toBe(200);
    expect(response.body.data.members.map((member: { name: string }) => member.name)).toEqual([
      'Maya Owner',
      'Sam Staff',
    ]);
    expect(response.body.data.invitations).toHaveLength(1);
    expect(response.body.data.invitations[0]).toMatchObject({
      email: 'new@example.com',
      role: 'STAFF',
      invitedByName: 'Maya Owner',
      status: 'PENDING',
      emailStatus: 'QUEUED',
    });
  });

  it('shows an expired invitation as EXPIRED', async () => {
    await expiredInvitation('late@example.com');

    const response = await asOwner('/api/team');

    expect(response.body.data.invitations[0].status).toBe('EXPIRED');
  });

  it('lets a staff member read the team', async () => {
    const response = await request(app)
      .get('/api/team')
      .set('Authorization', `Bearer ${signIn(STAFF)}`)
      .set('x-business-id', BIZ);

    expect(response.status).toBe(200);
  });

  it('answers 401 without a token and 403 for a session without the business', async () => {
    expect((await request(app).get('/api/team').set('x-business-id', BIZ)).status).toBe(401);

    const foreign = await request(app)
      .get('/api/team')
      .set('Authorization', `Bearer ${signIn(OUTSIDER)}`)
      .set('x-business-id', BIZ);

    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe('BUSINESS_ACCESS_DENIED');
  });

  it('refuses a removed member even with an old token', async () => {
    await getDb()
      .update(businessMembers)
      .set({ status: 'REMOVED' })
      .where(and(eq(businessMembers.businessId, BIZ), eq(businessMembers.userId, STAFF)));

    const response = await request(app)
      .get('/api/team')
      .set('Authorization', `Bearer ${signIn(STAFF)}`)
      .set('x-business-id', BIZ);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('BUSINESS_ACCESS_DENIED');
  });
});

describe('POST /api/team/invitations', () => {
  it('creates a pending invitation and returns the link once', async () => {
    const response = await request(app)
      .post('/api/team/invitations')
      .set('Authorization', `Bearer ${signIn(OWNER)}`)
      .set('x-business-id', BIZ)
      .send({ email: '  New.Hire@Example.com ' });

    expect(response.status).toBe(201);
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-robots-tag']).toBe('noindex');
    expect(response.body.data.invitation.email).toBe('new.hire@example.com');
    expect(response.body.data.invitation.role).toBe('STAFF');
    // No provider is configured in tests, so the email is skipped rather than queued.
    expect(response.body.data.emailStatus).toBe('SKIPPED');
    expect(response.body.data.inviteUrl).toMatch(
      new RegExp(`^${config.APP_ORIGIN.replace(/\/+$/, '')}/invite/[A-Za-z0-9_-]{43}$`),
    );

    const stored = await getDb().select().from(invitations);
    expect(stored).toHaveLength(1);
    const token = String(response.body.data.inviteUrl).split('/invite/')[1];
    expect(stored[0].tokenHash).toBe(hashInviteToken(token));
    expect(JSON.stringify(response.body.data.invitation)).not.toContain(token);
  });

  it('answers 400 for a malformed address', async () => {
    const response = await request(app)
      .post('/api/team/invitations')
      .set('Authorization', `Bearer ${signIn(OWNER)}`)
      .set('x-business-id', BIZ)
      .send({ email: 'not-an-email' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
    expect(response.body.fields).toContain('email');
  });

  it('answers 403 to a staff member', async () => {
    const response = await request(app)
      .post('/api/team/invitations')
      .set('Authorization', `Bearer ${signIn(STAFF)}`)
      .set('x-business-id', BIZ)
      .send({ email: 'someone@example.com' });

    expect(response.status).toBe(403);
  });

  it('answers 409 when the address already belongs to a member', async () => {
    const response = await request(app)
      .post('/api/team/invitations')
      .set('Authorization', `Bearer ${signIn(OWNER)}`)
      .set('x-business-id', BIZ)
      .send({ email: 'SAM@example.com' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('INVITE_ALREADY_MEMBER');
  });

  it('answers 409 with the invitation id when one is already pending', async () => {
    const id = await pendingInvitation('waiting@example.com');

    const response = await request(app)
      .post('/api/team/invitations')
      .set('Authorization', `Bearer ${signIn(OWNER)}`)
      .set('x-business-id', BIZ)
      .send({ email: 'waiting@example.com' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('INVITE_ALREADY_PENDING');
    expect(response.body.invitationId).toBe(id);
  });

  it('replaces an expired invitation with a new one', async () => {
    const oldId = await expiredInvitation('again@example.com');

    const response = await request(app)
      .post('/api/team/invitations')
      .set('Authorization', `Bearer ${signIn(OWNER)}`)
      .set('x-business-id', BIZ)
      .send({ email: 'again@example.com' });

    expect(response.status).toBe(201);
    expect(response.body.data.invitation.id).not.toBe(oldId);
    const old = await getDb().select().from(invitations).where(eq(invitations.id, oldId));
    expect(old[0].revokedAt).toBeInstanceOf(Date);
  });
});

describe('resend and cancel', () => {
  it('rotates the link on resend and audits it', async () => {
    const id = await pendingInvitation('rotate@example.com', 'first-token');

    const response = await request(app)
      .post(`/api/team/invitations/${id}/resend`)
      .set('Authorization', `Bearer ${signIn(OWNER)}`)
      .set('x-business-id', BIZ);

    expect(response.status).toBe(200);
    expect(response.body.data.inviteUrl).not.toContain('first-token');
    const audit = await getDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'TEAM_INVITE_RESENT'));
    expect(audit).toHaveLength(1);
    expect(audit[0].userId).toBe(OWNER);
  });

  it('answers 404 for an invitation of another business', async () => {
    const id = await pendingInvitation('mine@example.com');

    const response = await request(app)
      .post(`/api/team/invitations/${id}/resend`)
      .set('Authorization', `Bearer ${signIn(OUTSIDER)}`)
      .set('x-business-id', OTHER_BIZ);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('INVITE_NOT_FOUND');
  });

  it('cancels an invitation so its link stops working', async () => {
    const id = await pendingInvitation('cancel@example.com', 'cancel-token');

    const cancel = await request(app)
      .delete(`/api/team/invitations/${id}`)
      .set('Authorization', `Bearer ${signIn(OWNER)}`)
      .set('x-business-id', BIZ);

    expect(cancel.status).toBe(200);
    const preview = await request(app).get('/api/invitations/cancel-token');
    expect(preview.status).toBe(410);
    expect(preview.body.error).toBe('INVITE_REVOKED');
    expect(preview.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('member changes', () => {
  async function staffMembershipId(): Promise<string> {
    const rows = await getDb()
      .select({ id: businessMembers.id })
      .from(businessMembers)
      .where(and(eq(businessMembers.businessId, BIZ), eq(businessMembers.userId, STAFF)));
    return rows[0].id;
  }

  it('promotes a staff member and audits the change', async () => {
    const id = await staffMembershipId();

    const response = await request(app)
      .patch(`/api/team/members/${id}`)
      .set('Authorization', `Bearer ${signIn(OWNER)}`)
      .set('x-business-id', BIZ)
      .send({ role: 'OWNER' });

    expect(response.status).toBe(200);
    expect(response.body.data.role).toBe('OWNER');
    const audit = await getDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'TEAM_ROLE_CHANGED'));
    expect(audit).toHaveLength(1);
  });

  it('blocks a change to your own membership', async () => {
    const rows = await getDb()
      .select({ id: businessMembers.id })
      .from(businessMembers)
      .where(and(eq(businessMembers.businessId, BIZ), eq(businessMembers.userId, OWNER)));

    const response = await request(app)
      .patch(`/api/team/members/${rows[0].id}`)
      .set('Authorization', `Bearer ${signIn(OWNER)}`)
      .set('x-business-id', BIZ)
      .send({ role: 'STAFF' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('SELF_CHANGE_NOT_ALLOWED');
  });

  it('removes a member and cuts their access right away', async () => {
    const id = await staffMembershipId();

    const response = await request(app)
      .delete(`/api/team/members/${id}`)
      .set('Authorization', `Bearer ${signIn(OWNER)}`)
      .set('x-business-id', BIZ);

    expect(response.status).toBe(200);

    const after = await request(app)
      .get('/api/team')
      .set('Authorization', `Bearer ${signIn(STAFF)}`)
      .set('x-business-id', BIZ);
    expect(after.status).toBe(403);
    expect(after.body.error).toBe('BUSINESS_ACCESS_DENIED');
  });

  it('answers 404 for an unknown member', async () => {
    const response = await request(app)
      .delete('/api/team/members/00000000-0000-0000-0000-0000000000ff')
      .set('Authorization', `Bearer ${signIn(OWNER)}`)
      .set('x-business-id', BIZ);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('MEMBER_NOT_FOUND');
  });
});

describe('public invitation routes', () => {
  it('previews a pending invitation', async () => {
    await pendingInvitation('preview@example.com', 'preview-token');

    const response = await request(app).get('/api/invitations/preview-token');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.data).toMatchObject({
      businessName: expect.stringContaining(BIZ),
      inviterName: 'Maya Owner',
      email: 'preview@example.com',
      role: 'STAFF',
      accountExists: false,
      hasPassword: false,
      alreadyMember: false,
    });
    expect(response.body.data.expiresAt).toEqual(expect.any(String));
  });

  it('answers 404 for an unknown link and 410 for an expired one', async () => {
    expect((await request(app).get('/api/invitations/unknown-token')).status).toBe(404);

    await expiredInvitation('stale@example.com', 'stale-token');
    const expired = await request(app).get('/api/invitations/stale-token');
    expect(expired.status).toBe(410);
    expect(expired.body.error).toBe('INVITE_EXPIRED');
  });

  it('creates an account, signs the invitee in, and sets the refresh cookie', async () => {
    await pendingInvitation('joiner@example.com', 'joiner-token');

    const response = await request(app)
      .post('/api/invitations/joiner-token/accept')
      .send({ name: 'Joiner Person', password: 'correct horse' });

    expect(response.status).toBe(200);
    expect(response.body.data.businessId).toBe(BIZ);
    expect(response.body.data.accessToken).toEqual(expect.any(String));
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies.join(';')).toContain('refreshToken=');
    expect(cookies.join(';')).toContain('HttpOnly');

    const account = await getDb().select().from(users).where(eq(users.email, 'joiner@example.com'));
    expect(account[0].name).toBe('Joiner Person');
    expect(account[0].passwordHash).not.toBe('correct horse');

    const again = await request(app).get('/api/invitations/joiner-token');
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('INVITE_ALREADY_ACCEPTED');
  });

  it('asks an existing account with a password to sign in first', async () => {
    await pendingInvitation('sam@example.com', 'sam-token');
    // Sam already works here, so the invitation is stale; only the caller
    // checks matter for this test, and they run after that guard.
    await getDb()
      .update(businessMembers)
      .set({ status: 'REMOVED' })
      .where(and(eq(businessMembers.businessId, BIZ), eq(businessMembers.userId, STAFF)));
    await getDb().update(users).set({ passwordHash: 'hashed' }).where(eq(users.id, STAFF));

    const anonymous = await request(app).post('/api/invitations/sam-token/accept').send({});
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error).toBe('SIGN_IN_REQUIRED');

    const wrongPerson = await request(app)
      .post('/api/invitations/sam-token/accept')
      .set('Authorization', `Bearer ${signIn(OUTSIDER)}`)
      .send({});
    expect(wrongPerson.status).toBe(403);
    expect(wrongPerson.body.error).toBe('EMAIL_MISMATCH');

    const signedIn = await request(app)
      .post('/api/invitations/sam-token/accept')
      .set('Authorization', `Bearer ${signIn(STAFF)}`)
      .send({});
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.businessId).toBe(BIZ);

    const restore = await getDb()
      .select({ status: businessMembers.status })
      .from(businessMembers)
      .where(and(eq(businessMembers.businessId, BIZ), eq(businessMembers.userId, STAFF)));
    expect(restore[0].status).toBe('ACTIVE');
  });

  it('requires a password from a brand new invitee', async () => {
    await pendingInvitation('nopass@example.com', 'nopass-token');

    const response = await request(app)
      .post('/api/invitations/nopass-token/accept')
      .send({ name: 'No Pass' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });

  it('answers 409 when the invitee is already a member', async () => {
    await pendingInvitation('already@example.com', 'member-token');
    const joined = await getDb()
      .insert(users)
      .values({ email: 'already@example.com', name: 'Already Member', passwordHash: 'hashed' })
      .returning({ id: users.id });
    await seedMembership(BIZ, joined[0].id, 'STAFF');

    const preview = await request(app).get('/api/invitations/member-token');
    expect(preview.body.data.alreadyMember).toBe(true);

    const response = await request(app)
      .post('/api/invitations/member-token/accept')
      .set('Authorization', `Bearer ${signIn(joined[0].id)}`)
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('INVITE_ALREADY_MEMBER');
  });
});
