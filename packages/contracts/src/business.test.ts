import { describe, expect, it } from 'vitest';
import {
  BusinessAuditAction,
  BusinessAuditEntity,
  BusinessResponseSchema,
  OnboardingDraftSchema,
} from './index.js';

function baseResponse(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      name: 'Maya Traders',
      currency: 'BDT',
      timezone: 'Asia/Dhaka',
      logoUrl: null,
      address: { street: '1 Main Rd', city: 'Dhaka', country: 'Bangladesh' },
      onboardingComplete: false,
      ...overrides,
    },
    message: 'Business profile retrieved',
  };
}

describe('business response contract', () => {
  // covers AC-2 and AC-11: a corrupt stored value must still read, so the
  // response schema checks that timezone is present but does not validate it.
  it('requires timezone but accepts a corrupt stored value', () => {
    const withoutTimeZone: Record<string, unknown> = { ...baseResponse().data };
    delete withoutTimeZone.timezone;

    expect(
      BusinessResponseSchema.safeParse({ ...baseResponse(), data: withoutTimeZone }).success,
    ).toBe(false);

    const corrupt = BusinessResponseSchema.safeParse(baseResponse({ timezone: 'Mars/Olympus' }));
    expect(corrupt.success).toBe(true);
    if (corrupt.success) {
      expect(corrupt.data.data.timezone).toBe('Mars/Olympus');
    }
  });

  // The endpoints now send the draft, so the schema must declare it.
  it('accepts a partial onboarding draft on the response', () => {
    const parsed = BusinessResponseSchema.parse(
      baseResponse({ onboardingDraft: { timezone: 'America/New_York' } }),
    );

    expect(parsed.data.onboardingDraft).toEqual({ timezone: 'America/New_York' });
  });

  it('accepts a null draft once onboarding completes', () => {
    const parsed = BusinessResponseSchema.parse(
      baseResponse({ onboardingComplete: true, onboardingDraft: null }),
    );

    expect(parsed.data.onboardingDraft).toBeNull();
  });

  // Onboarding sends '' for "no logo". The API normalizes it to null before it
  // answers, so the read contract stays strict: a URL or null, never ''.
  it('accepts a null or URL logo and rejects the empty string the API normalizes away', () => {
    expect(BusinessResponseSchema.safeParse(baseResponse({ logoUrl: null })).success).toBe(true);
    expect(
      BusinessResponseSchema.safeParse(baseResponse({ logoUrl: 'https://cdn.example.com/a.png' }))
        .success,
    ).toBe(true);
    expect(BusinessResponseSchema.safeParse(baseResponse({ logoUrl: '' })).success).toBe(false);
  });

  it('accepts a response that omits the draft, as the write routes do', () => {
    const parsed = BusinessResponseSchema.parse(baseResponse());

    expect(parsed.data.onboardingDraft).toBeUndefined();
  });

  // A draft zone written before the rules changed, or edited outside the app,
  // must read like the stored zone does rather than fail the whole profile.
  it('accepts a draft carrying an unknown timezone, as it does for the stored zone', () => {
    const result = BusinessResponseSchema.safeParse(
      baseResponse({ onboardingDraft: { timezone: 'Mars/Olympus' } }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data.onboardingDraft).toEqual({ timezone: 'Mars/Olympus' });
    }
  });

  it('keeps every draft field optional because the wizard saves one at a time', () => {
    expect(OnboardingDraftSchema.parse({})).toEqual({});
      expect(
        OnboardingDraftSchema.parse({
          name: 'Draft Co',
          currency: 'EUR',
          timezone: 'Europe/Berlin',
          address: { street: '', city: '', country: 'Bangladesh' },
          logoUrl: 'https://example.com/logo.png',
        }),
      ).toMatchObject({ name: 'Draft Co', currency: 'EUR', timezone: 'Europe/Berlin' });
    });

    it('exports stable business audit action and entity constants', () => {
      expect(BusinessAuditAction).toEqual({
        ONBOARDING_COMPLETED: 'BUSINESS_ONBOARDING_COMPLETED',
        PROFILE_UPDATED: 'BUSINESS_PROFILE_UPDATED',
        LOGO_UPDATED: 'BUSINESS_LOGO_UPDATED',
        TIMEZONE_CHANGED: 'BUSINESS_TIMEZONE_CHANGED',
      });
      expect(BusinessAuditEntity).toEqual({
        BUSINESS: 'Business',
      });
    });
  });

  it('exports stable business audit action and entity constants', () => {
    expect(BusinessAuditAction).toEqual({
      ONBOARDING_COMPLETED: 'BUSINESS_ONBOARDING_COMPLETED',
      PROFILE_UPDATED: 'BUSINESS_PROFILE_UPDATED',
      LOGO_UPDATED: 'BUSINESS_LOGO_UPDATED',
      TIMEZONE_CHANGED: 'BUSINESS_TIMEZONE_CHANGED',
    });
    expect(BusinessAuditEntity).toEqual({
      BUSINESS: 'Business',
    });
  });
