import { z } from 'zod';

/**
 * A timestamp as it travels over the API: an ISO 8601 string in UTC.
 *
 * JavaScript serializes a `Date` with `toISOString()`, so every timestamp the
 * API sends ends in `Z`. A timestamp with an offset such as `+06:00` is a valid
 * instant, but it is rejected until a data source emits that form. The value
 * stays a string, so reading a response never shifts the time into another zone.
 */
export const IsoDateTimeSchema = z.iso.datetime();

/**
 * A calendar date travels as `YYYY-MM-DD` and stays a plain string, so it is
 * never turned into a JavaScript Date and never shifts by timezone.
 * `z.iso.date()` rejects an impossible calendar day such as `2026-02-30`.
 */
export const IsoDateSchema = z.iso.date('Must be a real calendar date in YYYY-MM-DD');

/**
 * Create input for an optional calendar date. The blank rule runs before the
 * date check because `z.iso.date()` rejects an empty string, so an omitted,
 * null, or blank create value becomes null first.
 */
export const CreateOptionalDateSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === null || value === undefined) return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  })
  .pipe(IsoDateSchema.nullable());

/** Edit input for an optional calendar date: omitted stays unchanged, null or blank clears it. */
export const EditOptionalDateSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  })
  .pipe(IsoDateSchema.nullable().optional());
