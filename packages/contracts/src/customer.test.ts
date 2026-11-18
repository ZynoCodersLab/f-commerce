import { describe, expect, it } from 'vitest';
import {
  CustomerCreateSchema,
  CustomerOrderPageSchema,
  CustomerProfileSchema,
  CustomerSchema,
  CustomerUpdateSchema,
  DuplicatePhoneErrorSchema,
} from './index.js';

function baseCreate(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Anika Rahman',
    phone: '+8801712345678',
    ...overrides,
  };
}

describe('customer create contract', () => {
  // covers AC-1: optional text is trimmed before the 500 character limit
  it('accepts 500 characters of optional text after trimming', () => {
    const address = 'a'.repeat(500);
    const parsed = CustomerCreateSchema.parse(baseCreate({ address: `${address}   ` }));

    expect(parsed.address).toBe(address);
    expect(
      CustomerCreateSchema.safeParse(baseCreate({ address: `${'a'.repeat(501)}   ` })).success,
    ).toBe(false);
  });

  // covers AC-1: email is validated after trimming
  it('trims an email before validating it', () => {
    const parsed = CustomerCreateSchema.parse(baseCreate({ email: '  anika@example.com  ' }));

    expect(parsed.email).toBe('anika@example.com');
  });

  // covers AC-1: a blank email is absent, not invalid
  it('treats a blank email as absent', () => {
    const parsed = CustomerCreateSchema.parse(baseCreate({ email: '   ' }));

    expect(parsed.email).toBeUndefined();
  });

  // covers AC-1: the name is trimmed and must be 1 to 120 characters after trimming
  it('trims the name and enforces the 120 character limit', () => {
    expect(CustomerCreateSchema.parse(baseCreate({ name: '  Anika Rahman  ' })).name).toBe(
      'Anika Rahman',
    );
    expect(CustomerCreateSchema.safeParse(baseCreate({ name: '   ' })).success).toBe(false);
    expect(CustomerCreateSchema.safeParse(baseCreate({ name: 'a'.repeat(121) })).success).toBe(
      false,
    );
    expect(
      CustomerCreateSchema.safeParse(baseCreate({ name: `${'a'.repeat(120)}   ` })).success,
    ).toBe(true);
  });

  // covers AC-1: omitted, null, and blank optional text all mean absent
  it('treats omitted, null, and blank optional text as absent', () => {
    const parsed = CustomerCreateSchema.parse(baseCreate({ address: null, notes: '   ' }));

    expect(parsed.address).toBeUndefined();
    expect(parsed.notes).toBeUndefined();
    expect(CustomerCreateSchema.parse(baseCreate()).address).toBeUndefined();
  });

  // covers AC-1: a missing phone or an invalid email is rejected
  it('rejects a missing phone and an invalid email', () => {
    const missingPhone = CustomerCreateSchema.safeParse({ name: 'Anika Rahman' });
    expect(missingPhone.success).toBe(false);
    if (!missingPhone.success) {
      expect(missingPhone.error.issues.map((issue) => issue.path[0])).toContain('phone');
    }

    const invalidEmail = CustomerCreateSchema.safeParse(baseCreate({ email: 'not-an-email' }));
    expect(invalidEmail.success).toBe(false);
    if (!invalidEmail.success) {
      expect(invalidEmail.error.issues.map((issue) => issue.path[0])).toContain('email');
    }
  });
});

describe('customer edit contract', () => {
  // covers AC-4: edit text is trimmed before the 500 character limit
  it('accepts 500 characters of optional text after trimming on edit', () => {
    const notes = 'n'.repeat(500);
    const parsed = CustomerUpdateSchema.parse({ version: 2, notes: `${notes}   ` });

    expect(parsed.notes).toBe(notes);
    expect(
      CustomerUpdateSchema.safeParse({ version: 2, notes: `${'n'.repeat(501)}   ` }).success,
    ).toBe(false);
  });

  // covers AC-4: email is validated after trimming on edit
  it('trims an email before validating it on edit', () => {
    const parsed = CustomerUpdateSchema.parse({
      version: 2,
      email: '  anika@example.com  ',
    });

    expect(parsed.email).toBe('anika@example.com');
  });

  // covers AC-4: a blank email clears the field, while null stays a clear
  it('treats a blank email as a clear on edit', () => {
    expect(CustomerUpdateSchema.parse({ version: 2, email: '   ' }).email).toBeNull();
    expect(CustomerUpdateSchema.parse({ version: 2, email: null }).email).toBeNull();
  });

  // covers AC-4: an edit needs a positive integer version and omitted fields stay untouched
  it('requires a positive integer version and leaves omitted fields undefined', () => {
    expect(CustomerUpdateSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(CustomerUpdateSchema.safeParse({ version: 1.5 }).success).toBe(false);

    const parsed = CustomerUpdateSchema.parse({ version: 1 });
    expect(parsed).toEqual({
      version: 1,
      name: undefined,
      phone: undefined,
      email: undefined,
      address: undefined,
      notes: undefined,
    });
  });
});

describe('customer response contracts', () => {
  // covers AC-6 and AC-7: the profile carries the spend summary and a page of orders
  it('parses the profile summary and its order history', () => {
    const profile = CustomerProfileSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Anika Rahman',
      phone: '+8801712345678',
      email: null,
      address: null,
      notes: null,
      archivedAt: null,
      version: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      orderCount: 2,
      totalSpent: 800,
      totalDue: 100,
      currency: 'USD',
    });

    expect(profile).toMatchObject({
      orderCount: 2,
      totalSpent: 800,
      totalDue: 100,
      currency: 'USD',
    });

    const orders = CustomerOrderPageSchema.parse({
      items: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          orderNumber: 'ORD-0002',
          createdAt: '2026-03-01T00:00:00.000Z',
          status: 'CONFIRMED',
          total: 500,
          dueAmount: 0,
        },
      ],
      nextCursor: 'next-page',
    });

    expect(orders.items[0]).toMatchObject({
      orderNumber: 'ORD-0002',
      status: 'CONFIRMED',
      total: 500,
      dueAmount: 0,
    });
  });

  // covers the response contract: timestamps stay ISO strings, so reject a
  // stored value that would not survive JSON date serialization
  it('rejects customer timestamps that are not ISO 8601', () => {
    const customer = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Anika Rahman',
      phone: '+8801712345678',
      email: null,
      address: null,
      notes: null,
      archivedAt: null,
      version: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };

    expect(CustomerSchema.safeParse(customer).success).toBe(true);
    expect(CustomerSchema.safeParse({ ...customer, createdAt: '2026-01-01' }).success).toBe(false);
    expect(CustomerSchema.safeParse({ ...customer, updatedAt: 'not-a-date' }).success).toBe(false);
    expect(CustomerSchema.safeParse({ ...customer, archivedAt: '2026-01-01' }).success).toBe(false);
  });

  // covers AC-3: the archived flag tells the client to offer restore
  it('parses a duplicate phone error with the archived flag', () => {
    const parsed = DuplicatePhoneErrorSchema.parse({
      error: 'DUPLICATE_PHONE',
      message: 'A customer with this phone already exists',
      existingCustomerId: '11111111-1111-4111-8111-111111111111',
      archived: true,
    });

    expect(parsed.archived).toBe(true);
  });
});
