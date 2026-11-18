import { CurrencyEnum, TimezoneSchema } from '@f-commerce/contracts';

export interface CachedBusinessSettings {
  currency: string;
  timezone: string;
  /** Optional because entries written before the sidebar showed identity have no name. */
  name?: string;
  logoUrl?: string | null;
}

const CACHE_PREFIX = 'f-commerce:business-settings:v1:';

/** Accept only the absolute http(s) URLs a business logo can safely use. */
export function normalizeLogoUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const candidate = value.trim();
  if (candidate === '') return null;

  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * The last parsed entry. The provider reads this on every render, so an
 * unchanged raw value must not be parsed or validated again. The raw string is
 * part of the key, so a write in this tab or another one still invalidates it.
 */
let lastRead: { key: string; value: CachedBusinessSettings | null } | null = null;

export function businessSettingsCacheKey(businessId: string): string {
  return `${CACHE_PREFIX}${businessId}`;
}

function parseBusinessSettingsCache(raw: string | null): CachedBusinessSettings | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const record = parsed as Record<string, unknown>;
  const currency = CurrencyEnum.safeParse(record.currency);
  const timezone = TimezoneSchema.safeParse(record.timezone);

  if (!currency.success || !timezone.success) return null;

  const name =
    typeof record.name === 'string' && record.name.trim() !== '' ? record.name.trim() : undefined;

  return {
    currency: currency.data,
    timezone: timezone.data,
    ...(name ? { name } : {}),
    ...(record.logoUrl === null || typeof record.logoUrl === 'string'
      ? { logoUrl: normalizeLogoUrl(record.logoUrl) }
      : {}),
  };
}

/**
 * Read and validate one business's cached settings without touching storage.
 * The provider calls this during render, so a malformed entry is ignored here
 * and pruned later by {@link pruneBusinessSettingsCache}.
 */
export function readBusinessSettingsCache(businessId: string): CachedBusinessSettings | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(businessSettingsCacheKey(businessId));
    const key = `${businessId}|${raw ?? ''}`;
    if (lastRead?.key === key) return lastRead.value;

    const value = parseBusinessSettingsCache(raw);
    lastRead = { key, value };
    return value;
  } catch {
    return null;
  }
}

/** Remove an unreadable cache entry after render, never during it. */
export function pruneBusinessSettingsCache(businessId: string): void {
  if (typeof window === 'undefined') return;

  try {
    const raw = window.localStorage.getItem(businessSettingsCacheKey(businessId));
    if (raw !== null && parseBusinessSettingsCache(raw) === null) {
      removeBusinessSettingsCache(businessId);
    }
  } catch {
    // Storage can be unavailable; there is nothing to prune then.
  }
}

/** Write the fields the console needs, under a versioned key. */
export function writeBusinessSettingsCache(
  businessId: string,
  settings: CachedBusinessSettings,
): void {
  lastRead = null;
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(
      businessSettingsCacheKey(businessId),
      JSON.stringify({
        currency: settings.currency,
        timezone: settings.timezone,
        ...(settings.name !== undefined ? { name: settings.name } : {}),
        ...(settings.logoUrl !== undefined ? { logoUrl: settings.logoUrl } : {}),
      }),
    );
  } catch {
    // Storage can be unavailable or full; the profile fetch still works.
  }
}

export function removeBusinessSettingsCache(businessId: string): void {
  lastRead = null;
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.removeItem(businessSettingsCacheKey(businessId));
  } catch {
    // Nothing to do when storage is unavailable.
  }
}
