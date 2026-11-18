import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  businessSettingsCacheKey,
  pruneBusinessSettingsCache,
  readBusinessSettingsCache,
  removeBusinessSettingsCache,
  writeBusinessSettingsCache,
} from './business-settings-cache';

const BUSINESS_ID = 'biz-1';

describe('business settings cache', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keys each business separately', () => {
    expect(businessSettingsCacheKey('abc')).toBe('f-commerce:business-settings:v1:abc');
  });

  it('round-trips currency and timezone', () => {
    writeBusinessSettingsCache(BUSINESS_ID, { currency: 'USD', timezone: 'Europe/Berlin' });

    expect(readBusinessSettingsCache(BUSINESS_ID)).toEqual({
      currency: 'USD',
      timezone: 'Europe/Berlin',
    });
    expect(readBusinessSettingsCache('biz-2')).toBeNull();
  });

  it('round-trips the business name and logo', () => {
    writeBusinessSettingsCache(BUSINESS_ID, {
      currency: 'USD',
      timezone: 'Europe/Berlin',
      name: 'Maya Traders',
      logoUrl: 'https://res.cloudinary.com/demo/logo.png',
    });

    expect(readBusinessSettingsCache(BUSINESS_ID)).toEqual({
      currency: 'USD',
      timezone: 'Europe/Berlin',
      name: 'Maya Traders',
      logoUrl: 'https://res.cloudinary.com/demo/logo.png',
    });
  });

  it('drops a stored logo URL that is not http or https', () => {
    writeBusinessSettingsCache(BUSINESS_ID, {
      currency: 'USD',
      timezone: 'Europe/Berlin',
      name: 'Maya Traders',
      logoUrl: 'javascript:alert(1)',
    });

    expect(readBusinessSettingsCache(BUSINESS_ID)).toEqual({
      currency: 'USD',
      timezone: 'Europe/Berlin',
      name: 'Maya Traders',
      logoUrl: null,
    });
  });

  it('parses an unchanged entry once', () => {
    writeBusinessSettingsCache(BUSINESS_ID, { currency: 'USD', timezone: 'Europe/Berlin' });
    const RealDateTimeFormat = Intl.DateTimeFormat;
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
      locale?: string | string[],
      options?: Intl.DateTimeFormatOptions,
    ) {
      return new RealDateTimeFormat(locale, options);
    } as typeof Intl.DateTimeFormat);

    expect(readBusinessSettingsCache(BUSINESS_ID)).toEqual({
      currency: 'USD',
      timezone: 'Europe/Berlin',
    });
    expect(readBusinessSettingsCache(BUSINESS_ID)).toEqual({
      currency: 'USD',
      timezone: 'Europe/Berlin',
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('stores only the two known fields', () => {
    window.localStorage.setItem(
      businessSettingsCacheKey(BUSINESS_ID),
      JSON.stringify({ currency: 'BDT', timezone: 'Asia/Dhaka', extra: 'ignored' }),
    );

    expect(readBusinessSettingsCache(BUSINESS_ID)).toEqual({
      currency: 'BDT',
      timezone: 'Asia/Dhaka',
    });
  });

  it('ignores a malformed entry without writing during the read', () => {
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');

    for (const raw of [
      'not json',
      'null',
      '[]',
      JSON.stringify({ currency: 'JPY', timezone: 'Asia/Dhaka' }),
      JSON.stringify({ currency: 'BDT', timezone: 'Mars/Olympus' }),
    ]) {
      window.localStorage.setItem(businessSettingsCacheKey(BUSINESS_ID), raw);
      removeItem.mockClear();

      expect(readBusinessSettingsCache(BUSINESS_ID)).toBeNull();
      expect(window.localStorage.getItem(businessSettingsCacheKey(BUSINESS_ID))).toBe(raw);
      expect(removeItem).not.toHaveBeenCalled();
    }

    removeItem.mockRestore();
  });

  it('prunes a malformed entry after the read', () => {
    for (const raw of [
      'not json',
      'null',
      '[]',
      JSON.stringify({ currency: 'JPY', timezone: 'Asia/Dhaka' }),
      JSON.stringify({ currency: 'BDT', timezone: 'Mars/Olympus' }),
    ]) {
      window.localStorage.setItem(businessSettingsCacheKey(BUSINESS_ID), raw);

      expect(readBusinessSettingsCache(BUSINESS_ID)).toBeNull();
      pruneBusinessSettingsCache(BUSINESS_ID);

      expect(window.localStorage.getItem(businessSettingsCacheKey(BUSINESS_ID))).toBeNull();
    }
  });

  it('keeps a valid entry when pruning', () => {
    writeBusinessSettingsCache(BUSINESS_ID, { currency: 'USD', timezone: 'Europe/Berlin' });

    pruneBusinessSettingsCache(BUSINESS_ID);

    expect(readBusinessSettingsCache(BUSINESS_ID)).toEqual({
      currency: 'USD',
      timezone: 'Europe/Berlin',
    });
  });

  it('removes an entry on request', () => {
    writeBusinessSettingsCache(BUSINESS_ID, { currency: 'BDT', timezone: 'Asia/Dhaka' });
    removeBusinessSettingsCache(BUSINESS_ID);

    expect(window.localStorage.getItem(businessSettingsCacheKey(BUSINESS_ID))).toBeNull();
  });

  it('re-reads after a write replaces the entry', () => {
    const businessId = 'biz-rewrite';
    writeBusinessSettingsCache(businessId, { currency: 'USD', timezone: 'Europe/Berlin' });
    expect(readBusinessSettingsCache(businessId)).toEqual({
      currency: 'USD',
      timezone: 'Europe/Berlin',
    });

    writeBusinessSettingsCache(businessId, { currency: 'GBP', timezone: 'Europe/London' });

    expect(readBusinessSettingsCache(businessId)).toEqual({
      currency: 'GBP',
      timezone: 'Europe/London',
    });
  });

  it('re-reads when another tab changes the raw entry', () => {
    const businessId = 'biz-other-tab';
    writeBusinessSettingsCache(businessId, { currency: 'USD', timezone: 'Europe/Berlin' });
    expect(readBusinessSettingsCache(businessId)).toEqual({
      currency: 'USD',
      timezone: 'Europe/Berlin',
    });

    window.localStorage.setItem(
      businessSettingsCacheKey(businessId),
      JSON.stringify({ currency: 'EUR', timezone: 'Europe/Paris' }),
    );

    expect(readBusinessSettingsCache(businessId)).toEqual({
      currency: 'EUR',
      timezone: 'Europe/Paris',
    });
  });

  it('does not return a removed entry from memory', () => {
    const businessId = 'biz-remove-read';
    writeBusinessSettingsCache(businessId, { currency: 'USD', timezone: 'Europe/Berlin' });
    expect(readBusinessSettingsCache(businessId)).not.toBeNull();

    removeBusinessSettingsCache(businessId);

    expect(readBusinessSettingsCache(businessId)).toBeNull();
  });

  it('does not throw when storage is unavailable', () => {
    const businessId = 'biz-storage-blocked';

    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    expect(readBusinessSettingsCache(businessId)).toBeNull();
    getItem.mockRestore();

    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    expect(() =>
      writeBusinessSettingsCache(businessId, { currency: 'USD', timezone: 'UTC' }),
    ).not.toThrow();
    setItem.mockRestore();

    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    expect(() => removeBusinessSettingsCache(businessId)).not.toThrow();
    removeItem.mockRestore();
  });
});
