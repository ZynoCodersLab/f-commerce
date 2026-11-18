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
