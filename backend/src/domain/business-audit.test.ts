import { describe, expect, it } from 'vitest';
import { BusinessAuditAction, BusinessAuditEntity } from '@f-commerce/contracts';
import {
  buildBusinessProfileAuditEntries,
  buildOnboardingCompletedAuditEntry,
} from './business-audit.js';
import { Business } from './entities/business.entity.js';

const NOW = new Date('2026-11-20T00:00:00Z');
const ACTOR = { userId: '00000000-0000-0000-0000-0000000000aa' };

function makeBusiness(overrides: Partial<Business> = {}): Business {
  return {
    id: '00000000-0000-0000-0000-000000000011',
    name: 'Maya Traders',
    currency: 'BDT',
    timezone: 'Asia/Dhaka',
    logoUrl: undefined,
    address: {
      street: '1 Main Rd',
      city: 'Dhaka',
      region: 'Dhaka',
      postalCode: '1000',
      country: 'Bangladesh',
    },
    onboardingComplete: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('business profile audit builders', () => {
  describe('buildOnboardingCompletedAuditEntry', () => {
    it('records the full before and after profile snapshot on onboarding completion', () => {
      const previous = makeBusiness({
        name: 'Draft Co',
        currency: 'BDT',
        timezone: 'Asia/Dhaka',
        logoUrl: undefined,
        address: undefined,
        onboardingComplete: false,
      });
      const next = makeBusiness({
        name: 'Maya Traders',
        currency: 'USD',
        timezone: 'America/New_York',
        logoUrl: 'https://res.cloudinary.com/demo/logo.png',
        onboardingComplete: true,
      });

      const entry = buildOnboardingCompletedAuditEntry(previous, next, ACTOR);

      expect(entry).toMatchObject({
        businessId: next.id,
        userId: ACTOR.userId,
        action: BusinessAuditAction.ONBOARDING_COMPLETED,
        entityType: BusinessAuditEntity.BUSINESS,
        entityId: next.id,
      });
      expect(JSON.parse(entry.previousValue)).toEqual({
        name: 'Draft Co',
        currency: 'BDT',
        timezone: 'Asia/Dhaka',
        logoUrl: null,
        address: null,
        onboardingComplete: false,
      });
      expect(JSON.parse(entry.newValue)).toEqual({
        name: 'Maya Traders',
        currency: 'USD',
        timezone: 'America/New_York',
        logoUrl: 'https://res.cloudinary.com/demo/logo.png',
        address: next.address,
        onboardingComplete: true,
      });
    });
  });

  describe('buildBusinessProfileAuditEntries', () => {
    it('returns no entries when nothing changed', () => {
      const previous = makeBusiness({
        address: { street: '1 Main Rd', city: 'Dhaka', country: 'Bangladesh' },
      });
      const next = makeBusiness({
        logoUrl: '',
        address: {
          street: '1 Main Rd',
          city: 'Dhaka',
          region: '',
          postalCode: '',
          country: 'Bangladesh',
        },
      });

      expect(buildBusinessProfileAuditEntries(previous, next, ACTOR)).toEqual([]);
    });

    it('records only changed profile fields under BUSINESS_PROFILE_UPDATED', () => {
      const previous = makeBusiness();
      const next = makeBusiness({ name: 'Maya Goods', currency: 'USD' });

      const entries = buildBusinessProfileAuditEntries(previous, next, ACTOR);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        businessId: next.id,
        userId: ACTOR.userId,
        action: BusinessAuditAction.PROFILE_UPDATED,
        entityType: BusinessAuditEntity.BUSINESS,
        entityId: next.id,
      });
      expect(JSON.parse(entries[0].previousValue)).toEqual({
        name: 'Maya Traders',
        currency: 'BDT',
      });
      expect(JSON.parse(entries[0].newValue)).toEqual({
        name: 'Maya Goods',
        currency: 'USD',
      });
    });

    it('records a standalone timezone change under BUSINESS_TIMEZONE_CHANGED', () => {
      const previous = makeBusiness({ timezone: 'Asia/Dhaka' });
      const next = makeBusiness({ timezone: 'Europe/London' });

      const entries = buildBusinessProfileAuditEntries(previous, next, ACTOR);

      expect(entries).toHaveLength(1);
      expect(entries[0]?.action).toBe(BusinessAuditAction.TIMEZONE_CHANGED);
      expect(JSON.parse(entries[0]!.previousValue)).toEqual({ timezone: 'Asia/Dhaka' });
      expect(JSON.parse(entries[0]!.newValue)).toEqual({ timezone: 'Europe/London' });
    });

    it('records logo uploads and removals under BUSINESS_LOGO_UPDATED', () => {
      const previous = makeBusiness({ logoUrl: undefined });
      const uploaded = makeBusiness({ logoUrl: 'https://res.cloudinary.com/demo/v1.png' });
      const cleared = makeBusiness({ logoUrl: undefined });

      const uploadEntries = buildBusinessProfileAuditEntries(previous, uploaded, ACTOR);
      expect(uploadEntries).toHaveLength(1);
      expect(uploadEntries[0]?.action).toBe(BusinessAuditAction.LOGO_UPDATED);
      expect(JSON.parse(uploadEntries[0]!.previousValue)).toEqual({ logoUrl: null });
      expect(JSON.parse(uploadEntries[0]!.newValue)).toEqual({
        logoUrl: 'https://res.cloudinary.com/demo/v1.png',
      });

      const clearEntries = buildBusinessProfileAuditEntries(uploaded, cleared, ACTOR);
      expect(clearEntries).toHaveLength(1);
      expect(clearEntries[0]?.action).toBe(BusinessAuditAction.LOGO_UPDATED);
      expect(JSON.parse(clearEntries[0]!.previousValue)).toEqual({
        logoUrl: 'https://res.cloudinary.com/demo/v1.png',
      });
      expect(JSON.parse(clearEntries[0]!.newValue)).toEqual({ logoUrl: null });
    });

    it('emits separate entries when profile fields, timezone, and logo all change together', () => {
      const previous = makeBusiness({
        name: 'Old Name',
        timezone: 'Asia/Dhaka',
        logoUrl: 'https://res.cloudinary.com/demo/old.png',
      });
      const next = makeBusiness({
        name: 'New Name',
        timezone: 'America/New_York',
        logoUrl: 'https://res.cloudinary.com/demo/new.png',
      });

      const entries = buildBusinessProfileAuditEntries(previous, next, ACTOR);

      expect(entries.map((entry) => entry.action)).toEqual([
        BusinessAuditAction.PROFILE_UPDATED,
        BusinessAuditAction.TIMEZONE_CHANGED,
        BusinessAuditAction.LOGO_UPDATED,
      ]);
      expect(JSON.parse(entries[0]!.previousValue)).toEqual({ name: 'Old Name' });
      expect(JSON.parse(entries[0]!.newValue)).toEqual({ name: 'New Name' });
      expect(JSON.parse(entries[1]!.previousValue)).toEqual({ timezone: 'Asia/Dhaka' });
      expect(JSON.parse(entries[1]!.newValue)).toEqual({ timezone: 'America/New_York' });
      expect(JSON.parse(entries[2]!.previousValue)).toEqual({
        logoUrl: 'https://res.cloudinary.com/demo/old.png',
      });
      expect(JSON.parse(entries[2]!.newValue)).toEqual({
        logoUrl: 'https://res.cloudinary.com/demo/new.png',
      });
    });

    it('records address additions and field updates under BUSINESS_PROFILE_UPDATED', () => {
      const withoutAddress = makeBusiness({ address: undefined });
      const addedAddress = makeBusiness({
        address: {
          street: '42 Lake Rd',
          city: 'Dhaka',
          region: 'Dhaka Division',
          postalCode: '1212',
          country: 'Bangladesh',
        },
      });
      const updatedAddress = makeBusiness({
        address: {
          street: '42 Lake Rd',
          city: 'Dhaka',
          region: '',
          postalCode: '1213',
          country: 'Bangladesh',
        },
      });

      const addEntries = buildBusinessProfileAuditEntries(withoutAddress, addedAddress, ACTOR);
      expect(addEntries).toHaveLength(1);
      expect(addEntries[0]?.action).toBe(BusinessAuditAction.PROFILE_UPDATED);
      expect(JSON.parse(addEntries[0]!.previousValue)).toEqual({ address: null });
      expect(JSON.parse(addEntries[0]!.newValue)).toEqual({ address: addedAddress.address });

      const editEntries = buildBusinessProfileAuditEntries(addedAddress, updatedAddress, ACTOR);
      expect(editEntries).toHaveLength(1);
      expect(editEntries[0]?.action).toBe(BusinessAuditAction.PROFILE_UPDATED);
      expect(JSON.parse(editEntries[0]!.previousValue)).toEqual({ address: addedAddress.address });
      expect(JSON.parse(editEntries[0]!.newValue)).toEqual({
        address: {
          street: '42 Lake Rd',
          city: 'Dhaka',
          postalCode: '1213',
          country: 'Bangladesh',
        },
      });
    });
  });
});
