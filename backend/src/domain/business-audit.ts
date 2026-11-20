import {
  BusinessAuditAction,
  BusinessAuditActionType,
  BusinessAuditEntity,
  BusinessAuditEntityType,
} from '@f-commerce/contracts';
import { Business } from './entities/business.entity.js';

export interface BusinessAuditActor {
  userId: string;
}

export interface BusinessAuditRecord {
  businessId: string;
  userId: string;
  action: BusinessAuditActionType;
  entityType: BusinessAuditEntityType;
  entityId: string;
  previousValue: string;
  newValue: string;
}

interface NormalizedAddress {
  street: string;
  city: string;
  region?: string;
  postalCode?: string;
  country: string;
}

function normalizeLogoUrl(logoUrl: string | null | undefined): string | null {
  return logoUrl && logoUrl.length > 0 ? logoUrl : null;
}

function normalizeAddress(
  address: Business['address'] | null | undefined,
): NormalizedAddress | null {
  if (!address) return null;
  const normalized: NormalizedAddress = {
    street: address.street,
    city: address.city,
    country: address.country,
  };
  if (address.region) normalized.region = address.region;
  if (address.postalCode) normalized.postalCode = address.postalCode;
  return normalized;
}

function addressesEqual(
  left: Business['address'] | null | undefined,
  right: Business['address'] | null | undefined,
): boolean {
  const a = normalizeAddress(left);
  const b = normalizeAddress(right);
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return (
    a.street === b.street &&
    a.city === b.city &&
    a.region === b.region &&
    a.postalCode === b.postalCode &&
    a.country === b.country
  );
}

function profileSnapshot(business: Business) {
  return {
    name: business.name,
    currency: business.currency,
    timezone: business.timezone,
    logoUrl: normalizeLogoUrl(business.logoUrl),
    address: normalizeAddress(business.address),
    onboardingComplete: business.onboardingComplete,
  };
}

/**
 * Build the audit entry recorded when a business completes onboarding.
 */
export function buildOnboardingCompletedAuditEntry(
  previous: Business,
  next: Business,
  actor: BusinessAuditActor,
): BusinessAuditRecord {
  return {
    businessId: next.id,
    userId: actor.userId,
    action: BusinessAuditAction.ONBOARDING_COMPLETED,
    entityType: BusinessAuditEntity.BUSINESS,
    entityId: next.id,
    previousValue: JSON.stringify(profileSnapshot(previous)),
    newValue: JSON.stringify(profileSnapshot(next)),
  };
}

/**
 * Diff two business profile snapshots and return the audit entries for every
 * changed area: general profile fields (`name`, `currency`, `address`),
 * timezone changes, and logo changes. Returns an empty array when nothing
 * changed so repeated saves never write noisy rows.
 */
export function buildBusinessProfileAuditEntries(
  previous: Business,
  next: Business,
  actor: BusinessAuditActor,
): BusinessAuditRecord[] {
  const entries: BusinessAuditRecord[] = [];

  const profilePrevious: Record<string, unknown> = {};
  const profileNext: Record<string, unknown> = {};

  if (previous.name !== next.name) {
    profilePrevious.name = previous.name;
    profileNext.name = next.name;
  }
  if (previous.currency !== next.currency) {
    profilePrevious.currency = previous.currency;
    profileNext.currency = next.currency;
  }
  if (!addressesEqual(previous.address, next.address)) {
    profilePrevious.address = normalizeAddress(previous.address);
    profileNext.address = normalizeAddress(next.address);
  }

  if (Object.keys(profileNext).length > 0) {
    entries.push({
      businessId: next.id,
      userId: actor.userId,
      action: BusinessAuditAction.PROFILE_UPDATED,
      entityType: BusinessAuditEntity.BUSINESS,
      entityId: next.id,
      previousValue: JSON.stringify(profilePrevious),
      newValue: JSON.stringify(profileNext),
    });
  }

  if (previous.timezone !== next.timezone) {
    entries.push({
      businessId: next.id,
      userId: actor.userId,
      action: BusinessAuditAction.TIMEZONE_CHANGED,
      entityType: BusinessAuditEntity.BUSINESS,
      entityId: next.id,
      previousValue: JSON.stringify({ timezone: previous.timezone }),
      newValue: JSON.stringify({ timezone: next.timezone }),
    });
  }

  const prevLogo = normalizeLogoUrl(previous.logoUrl);
  const nextLogo = normalizeLogoUrl(next.logoUrl);
  if (prevLogo !== nextLogo) {
    entries.push({
      businessId: next.id,
      userId: actor.userId,
      action: BusinessAuditAction.LOGO_UPDATED,
      entityType: BusinessAuditEntity.BUSINESS,
      entityId: next.id,
      previousValue: JSON.stringify({ logoUrl: prevLogo }),
      newValue: JSON.stringify({ logoUrl: nextLogo }),
    });
  }

  return entries;
}
