/**
 * The one canonical form for every email the app stores or matches: trimmed
 * and lower cased. An address that skips this can look like a second person,
 * which would defeat the per business email uniqueness the invite flow relies
 * on.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
