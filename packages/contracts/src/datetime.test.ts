import { describe, expect, it } from 'vitest';
import { IsoDateTimeSchema } from './index.js';

describe('IsoDateTimeSchema', () => {
  it('keeps a UTC timestamp as the string the API sends', () => {
    const value = '2026-10-20T10:00:00.000Z';
    expect(IsoDateTimeSchema.parse(value)).toBe(value);
  });

  it('rejects a date only value and an offset timestamp', () => {
    expect(IsoDateTimeSchema.safeParse('2026-10-20').success).toBe(false);
    expect(IsoDateTimeSchema.safeParse('2026-10-20T16:00:00+06:00').success).toBe(false);
  });
});
