import { describe, it, expect } from 'vitest';
import { normaliseEmail } from './email.js';

describe('normaliseEmail', () => {
  it('trims the ends and lower cases the address', () => {
    expect(normaliseEmail('  Owner@Example.COM ')).toBe('owner@example.com');
  });

  it('leaves an already canonical address unchanged', () => {
    expect(normaliseEmail('staff@example.com')).toBe('staff@example.com');
  });
});
