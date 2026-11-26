import { z } from 'zod';
import { TeamRoleEnum } from './team.js';

export const CurrencyEnum = z.enum(['BDT', 'USD', 'EUR', 'GBP']);

/** Action codes recorded when a business profile changes. */
export const BusinessAuditAction = {
  ONBOARDING_COMPLETED: 'BUSINESS_ONBOARDING_COMPLETED',
  PROFILE_UPDATED: 'BUSINESS_PROFILE_UPDATED',
  LOGO_UPDATED: 'BUSINESS_LOGO_UPDATED',
  TIMEZONE_CHANGED: 'BUSINESS_TIMEZONE_CHANGED',
} as const;

export type BusinessAuditActionType =
  (typeof BusinessAuditAction)[keyof typeof BusinessAuditAction];

/** Audit entity types written by the business feature. */
export const BusinessAuditEntity = {
  BUSINESS: 'Business',
} as const;

export type BusinessAuditEntityType =
  (typeof BusinessAuditEntity)[keyof typeof BusinessAuditEntity];

/**
 * A bare `UTC` or an `Area/Location` style IANA ID. This rejects fixed offsets
 * such as `+06:00` and abbreviations such as `BST`, both of which the runtime
 * would otherwise accept as legacy aliases.
 */
const IANA_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)+$/;

function isIanaTimeZoneId(value: string): boolean {
  return value === 'UTC' || IANA_ID_PATTERN.test(value);
}

/**
 * Resolve a value through the runtime's own IANA timezone data. Trims the
 * input, checks the accepted shape, and returns the canonical ID, or null when
 * the runtime does not recognize the value. A caller that only needs the
 * boolean check can compare the result with null.
 */
export function resolveTimeZone(value: string): string | null {
  const zone = value.trim();
  if (zone.length === 0 || zone.length > 64) return null;
  if (!isIanaTimeZoneId(zone)) return null;

  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * An IANA timezone ID accepted by the runtime, stored in canonical form.
 * Fixed offsets and abbreviations are rejected because they do not survive
 * daylight saving changes. The runtime formatter is constructed once per
 * parse: the cheap checks give the specific errors, and the transform does
 * the single resolution.
 */
export const TimezoneSchema = z
  .string()
  .trim()
  .min(1, 'Timezone is required')
  .max(64, 'Timezone must be 64 characters or fewer')
  .refine(isIanaTimeZoneId, 'Invalid timezone')
  .transform((value, ctx) => {
    const resolved = resolveTimeZone(value);
    if (resolved === null) {
      ctx.addIssue({ code: 'custom', message: 'Invalid timezone' });
      return z.NEVER;
    }
    return resolved;
  });

export const AddressSchema = z.object({
  street: z.string().min(1, 'Street is required'),
  city: z.string().min(1, 'City is required'),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().min(1, 'Country is required'),
});

export const BusinessProfileSchema = z.object({
  name: z.string().min(1, 'Business name is required'),
  currency: CurrencyEnum,
  timezone: TimezoneSchema,
  logoUrl: z.string().url('Invalid logo URL').optional().or(z.literal('')),
  address: AddressSchema,
  onboardingComplete: z.boolean().optional(),
});

/**
 * Partial update for PUT /me. Every field is optional and only the fields
 * present in the body are written back. No defaults, so an absent currency
 * does not silently reset the stored value.
 */
export const BusinessProfileUpdateSchema = z.object({
  name: z.string().min(1, 'Business name is required').optional(),
  currency: CurrencyEnum.optional(),
  timezone: TimezoneSchema.optional(),
  logoUrl: z.string().url('Invalid logo URL').optional().or(z.literal('')).optional(),
  address: AddressSchema.optional(),
});

const DraftAddressSchema = z.object({
  street: z.string(),
  city: z.string(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string(),
});

/**
 * Partial onboarding progress kept on the business row. Every field is
 * optional because the wizard saves one field at a time, and the whole draft is
 * null once onboarding completes.
 *
 * `timezone` checks presence only, like `data.timezone` on the business
 * response: a draft written before the zone rules changed, or edited outside
 * the app, must not fail the whole profile read. Writes are still validated
 * by `DraftSaveSchema`, so the app cannot store an unknown zone.
 */
export const OnboardingDraftSchema = z.object({
  name: z.string().optional(),
  currency: CurrencyEnum.optional(),
  timezone: z.string().optional(),
  address: DraftAddressSchema.optional(),
  logoUrl: z.string().optional(),
});

/**
 * Draft save. Drafts hold partial wizard progress, so the address may be
 * incomplete; completion still requires the full AddressSchema.
 */
export const DraftSaveSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('name'), value: z.string().min(1) }),
  z.object({ field: z.literal('currency'), value: CurrencyEnum }),
  z.object({ field: z.literal('timezone'), value: TimezoneSchema }),
  z.object({ field: z.literal('address'), value: DraftAddressSchema }),
  z.object({ field: z.literal('logoUrl'), value: z.string().url().or(z.literal('')) }),
]);

export const BusinessResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    name: z.string(),
    currency: CurrencyEnum,
    timezone: z.string(),
    logoUrl: z.string().url().nullable(),
    address: AddressSchema.nullable(),
    onboardingComplete: z.boolean(),
    /** Present on GET /me from the live database membership check. */
    role: TeamRoleEnum.optional(),
    /**
     * Present on GET /me and GET /onboarding. Absent from the payload shape of
     * the write routes, so it stays optional; null once onboarding completes.
     */
    onboardingDraft: OnboardingDraftSchema.nullable().optional(),
  }),
  message: z.string(),
});

export type Currency = z.infer<typeof CurrencyEnum>;
export type Timezone = z.infer<typeof TimezoneSchema>;
export type Address = z.infer<typeof AddressSchema>;
export type OnboardingDraft = z.infer<typeof OnboardingDraftSchema>;
export type BusinessProfile = z.infer<typeof BusinessProfileSchema>;
export type BusinessProfileUpdate = z.infer<typeof BusinessProfileUpdateSchema>;
export type DraftSaveRequest = z.infer<typeof DraftSaveSchema>;
export type BusinessResponse = z.infer<typeof BusinessResponseSchema>;
