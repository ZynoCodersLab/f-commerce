# 0008. Business timezone for delivery dates and timestamps

**Date**: 2026-10-25
**Status**: Accepted

## Summary

Every business now stores a timezone (a named region such as Asia/Dhaka that decides its calendar day) instead of each viewer's browser deciding it. Timestamps, the delivery date warning, and the Overdue badge all use that zone, so two people in different places see the same day. The promised delivery date itself stays a plain calendar day with no zone attached. Existing businesses start on Asia/Dhaka, onboarding asks for the zone, and settings lets the owner change it.

## Requirements

**User stories**:

- As a seller, I want the console's dates and the Overdue badge to follow my business timezone so that my team and I agree on which promise is late.
- As an owner, I want to set the business timezone during onboarding and change it in settings so that the console matches where the business works.
- As an owner or staff member, I want timestamps shown in the business timezone so that order history reads the same on every device.
- As an owner, I want a clear warning before a timezone change so that I understand which promises may show as overdue.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):

- **AC-1**: The `businesses` table gains `timezone`, a `text` column that is not null and defaults to `Asia/Dhaka`. One generated migration adds the column and fills every existing business with `Asia/Dhaka`. No order column is added, and `orders.delivery_deadline` stays a nullable PostgreSQL `date` in string mode with no timezone. The Drizzle schema, the `Business` entity, and the onboarding draft type expose the field, and the business repository maps it on read and write.
- **AC-2**: The contracts package exposes a `TimezoneSchema` that trims the input, requires 1 to 64 characters, and accepts only a value the runtime recognizes as an IANA timezone ID (verified by constructing `Intl.DateTimeFormat` with that `timeZone` inside a try and catch). It returns the canonical ID from `resolvedOptions().timeZone`, so `asia/dhaka` is stored as `Asia/Dhaka` and an alias is stored in the runtime's canonical form. It accepts `Asia/Dhaka`, `UTC`, and any other Area/Location ID the runtime knows. It rejects a blank value, whitespace only, a fixed offset such as `+06:00`, a bare abbreviation or legacy name such as `Japan`, `GMT`, `CET`, or `BST`, an unknown value such as `Mars/Olympus`, and a value over 64 characters. `BusinessProfileSchema` requires `timezone`. `BusinessProfileUpdateSchema` accepts it as an optional field. `DraftSaveSchema` gains a `timezone` branch that reuses `TimezoneSchema`. `OnboardingDraftSchema` accepts a draft `timezone` as an optional plain string, checking presence only, so a draft written before these rules or edited outside the app still reads. `BusinessResponseSchema` requires the field to be present but does not validate it, so a corrupt stored value still reads. An invalid or missing required value returns 400 and writes nothing. No schema default fills the field silently.
- **AC-3**: `GET /api/business/me` returns `timezone` in `data` to an OWNER or STAFF member behind the existing onboarding gate. `PUT /api/business/me` accepts an optional `timezone`, is OWNER only, writes it with the other supplied profile fields, and returns the updated profile including `timezone`. Saving the same value is allowed. `GET /api/business/onboarding` returns the stored `timezone` and the draft `timezone` when present. `PUT /api/business/onboarding` requires `timezone`, rejects a missing or invalid value with 400, saves it with the rest of the profile, and then clears the draft. `PUT /api/business/onboarding/draft` accepts `field` `timezone`. No new endpoint, permission, error code, or audit row is added, except the `409 ONBOARDING_COMPLETE` the draft route returns for a skipped write (see the Update 2026-10-29). Tenant filtering and role checks do not change.
- **AC-4**: Every existing business receives `Asia/Dhaka` from the migration. A business created at registration before onboarding receives `Asia/Dhaka` from the database default. Completing onboarding requires an explicit timezone in the request and stores it, so the stored choice replaces the default. No business row is ever null on `timezone`. A missing or invalid stored value never blocks a read; the UI and the server helper fall back to `Asia/Dhaka` as described in AC-11.
- **AC-5**: Onboarding step 3 shows a `Timezone` field beside currency. The control is one native select grouped by region, built from `Intl.supportedValuesOf('timeZone')`. Each option value is the full IANA ID. Each label is the remainder after the first segment with underscores replaced by spaces, so `America/Argentina/Buenos_Aires` reads `Argentina/Buenos Aires`; an ID with no slash keeps the whole ID with underscores replaced. The group heading is the first segment, with `Etc` and an ID without a slash grouped under `Other`. Groups and options sort alphabetically. The current value is always present as an option even when the runtime list omits it. When `Intl.supportedValuesOf` is unavailable, a short built in list (`Asia/Dhaka`, `Asia/Kolkata`, `Asia/Dubai`, `Europe/London`, `Europe/Berlin`, `America/New_York`, `America/Los_Angeles`, `Australia/Sydney`, `UTC`) is shown and the current value is still present. A fresh wizard prefills the browser zone from `Intl.DateTimeFormat().resolvedOptions().timeZone` when it is valid, otherwise `Asia/Dhaka`. A resumed draft whose timezone passes `TimezoneSchema` wins over the browser zone; an invalid or missing draft value counts as absent and keeps the browser prefill. The field is required, a missing or invalid value blocks completion with an inline message, and changing the field saves the draft through the existing debounce. The review step shows the timezone. The completion request includes it, and the shared settings are updated from the `PUT /api/business/onboarding` response `data` before the wizard routes to the dashboard. The prefill runs on the client only.
- **AC-6**: The settings screen shows a `Timezone` field with the same grouped select, loaded from `GET /api/business/me`. The description says it is used for delivery dates and timestamps. The baseline is the loaded `data.timezone` after canonicalization. An invalid or missing stored value shows `Asia/Dhaka` and uses it as the baseline, so saving without choosing another zone persists the fallback and opens no dialog. Saving includes the timezone. When the selected canonical value equals the baseline, the normal save runs. When it differs, a confirmation dialog opens before the request with the new zone, a note that existing order dates do not change but which orders show as overdue may change, and a cancel action and a confirm action. Cancel closes the dialog, reverts the select to the baseline, and saves nothing. Confirm sends the normal `PUT /api/business/me`. On success the page shows `Profile updated`, updates the shared settings from the response `data`, and sets the baseline to the saved `data.timezone`. On failure the existing error message shows and the form keeps the chosen value. The dialog and select are keyboard and screen reader accessible.
- **AC-7**: One client `BusinessSettingsProvider` (for example `frontend/src/components/business/business-settings-provider.tsx`) wraps the app in the root layout. It holds `currency` and `timezone`. It loads `GET /api/business/me` once per app load and again whenever the active token or business id changes. The auth client exposes a subscription that `setAuth` and `clearAuth` notify, so a login that calls `setAuth` and then navigates without remounting the layout still loads the profile, and a sign out clears it. The provider reads a versioned cache at `f-commerce:business-settings:v1:<businessId>` holding `{ currency, timezone }` before the profile request resolves. It validates the entry per field (`timezone` through `TimezoneSchema`, `currency` against `CurrencyEnum`), ignores and removes a malformed entry, and never reads another business's cache. It uses a client snapshot mechanism such as `useSyncExternalStore` that keeps the server and hydration render on the fallback so no hydration warning appears. Without a cache it uses an empty currency and `Asia/Dhaka`. It fetches only when `getAuth()` has a token and a business id. A failed, 401, or 403 response leaves the cache or fallback in place and does not redirect or crash. It writes the cache after a successful profile fetch or setter. It exposes the settings, a setter for a successful onboarding or settings save, the timezone, and a mounted flag. It does not memoize a day: consumers call the frontend `todayInTimeZone` with the provider timezone at render, so the day is correct on the next render after midnight, and the warning and badge render nothing until the mounted flag is true. `clearAuth` removes the active business's cache and notifies the provider, which clears to the fallback and fetches nothing. The orders, new order, order detail, products list, and product detail screens stop calling `getBusinessCurrency` and read currency from the provider. The settings screen may still fetch the full profile for name and address; its currency and timezone come from that response and are pushed into the provider on save. The shell badge shows the active timezone and currency, for example `Asia/Dhaka · BDT`, and omits the separator when the currency is empty. The shell header date shows the business's current day as a `<time>` element with text such as `Sunday, 25 October` from `en-GB` and `formatToParts` or an equivalent fixed locale formatter, is filled on the client after mount, and leaves the business name and greeting placeholders unchanged.
- **AC-8**: The shared `formatDateTime(value, timeZone)` in `frontend/src/lib/catalog-format.ts` renders a timestamp with `Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone })`. It renders every console timestamp in the business zone: the orders list and phone cards, the order detail placed time and status history, the order duplicate warning, the product detail updated time, the customer detail created and archived times and its order history rows (replacing that page's local copy), and the shell header date uses its own weekday formatter with the same zone. An invalid timestamp returns the raw value. An invalid or missing timezone falls back to `Asia/Dhaka` and never throws. The stored delivery date keeps using `formatDateOnly` unchanged and never shifts. No timestamp repeats the zone label, because the shell badge is the one visible zone marker.
- **AC-9**: The frontend `todayInTimeZone` in `frontend/src/lib/timezone.ts` returns the business's calendar day as `YYYY-MM-DD`. The create and edit delivery date warning compares the chosen `YYYY-MM-DD` value with the business's today, not the browser's today. While the client day is unknown (before mount), the warning and the Overdue badge render nothing rather than guessing. The `Overdue` badge appears only when the deadline is set, is strictly before the business's today, and the status is `PENDING`, `CONFIRMED`, `PROCESSING`, or `SHIPPED`. A deadline equal to today is not overdue. `DELIVERED`, `CANCELLED`, and `RETURNED` never show the badge. The badge is derived at render, is never stored, and never changes status, totals, history, or the API. It updates on the next render or navigation, not on a timer. Two viewers in different browser zones see the same badge for the same business, because only the business zone decides the day.
- **AC-10**: The backend exposes `DEFAULT_TIME_ZONE` (`Asia/Dhaka`), `isValidTimeZone(value)`, and `todayInTimeZone(timeZone, now = new Date())` in `backend/src/domain/timezone.ts`. `isValidTimeZone` returns true only for a value the runtime accepts as an IANA timezone ID, and false for an empty value or one that is not a string. `todayInTimeZone` builds `YYYY-MM-DD` from `Intl.DateTimeFormat` `formatToParts` with a fixed locale, never by slicing a localized string, so it stays stable across runtimes and daylight saving changes. An empty or invalid zone falls back to `Asia/Dhaka`. No current endpoint uses the helper, and this feature adds no server side overdue flag or day filter. The helper is the required source for future reports, dashboards, and any server day boundary. Unit tests cover a date on each side of a daylight saving change, two zones that are on different days at the same instant, a leap day, and the invalid fallback.
- **AC-11**: A missing or invalid stored timezone is returned by the API as stored, while the UI and the helper fall back to `Asia/Dhaka`. The response schema checks presence only, and the frontend never validates a whole API response with Zod, so a corrupt stored value cannot fail the profile fetch. Saving settings without another change persists the fallback as described in AC-6. A failed profile request uses the cache or the fallback and leaves the existing page error behavior unchanged. A malformed cache entry is ignored and removed. A missing `Intl.supportedValuesOf` uses the short list. An `Intl.DateTimeFormat` call that throws for a bad zone is caught and uses `Asia/Dhaka`. No page crashes, blanks, or shows an unhandled error because of a bad zone.
- **AC-12**: The timezone field has a programmatic label and description on both screens. The select and the confirmation dialog are keyboard operable, the dialog traps and restores focus, and Escape cancels. A screen reader announces the selected zone and the confirmation. Order contracts, order DTOs, totals, status rules, deadline storage, duplicate logic, search, and filters do not change. No new dependency, environment variable, permission, background job, or order column is added. The existing backend, frontend, and contracts suites pass after fixtures and assertions are updated for the new field. The screens meet WCAG AA.

## Decision

**Chosen option**: Option 1, one business timezone field with an IANA ID, no order snapshot, and one shared client provider.

The business row owns the timezone. It is an IANA timezone ID, not a fixed offset, because offsets break when daylight saving changes. The promised delivery date stays a `YYYY-MM-DD` calendar day with no zone attached; only the comparison to today uses the zone. The console reads the profile once per app load and per auth change through a provider, caches it per business, and uses it for currency, timestamps, and the day boundary. The server gets the same day rule as a tested helper for future reports. Old orders follow the business's current zone, and a timezone change is not audited in this slice.

**Implementation skills**: `web-design-guidelines` (`vercel-labs/agent-skills`, `.agents/skills/web-design-guidelines/`) · `vercel-react-best-practices` (`vercel-labs/agent-skills`, `.agents/skills/vercel-react-best-practices/`)

## Feature design

**Data model sketch**:

Existing `businesses` gains:

- `timezone` text not null default `Asia/Dhaka`. It stores an IANA timezone ID of at most 64 characters. No index is added because no query filters or sorts by it. The default backfills existing rows and covers a business created at registration before onboarding.
- `onboarding_draft` (existing JSONB) may hold a `timezone` string. The draft is partial, so the field is optional there.

No other table changes. `orders.delivery_deadline` remains a nullable `date` in string mode. No order stores a timezone snapshot, and no new table is added.

**API surface**:

| Endpoint                         | Method | Key inputs                                                     | Key outputs                      | Auth                   | Key errors         |
| -------------------------------- | ------ | -------------------------------------------------------------- | -------------------------------- | ---------------------- | ------------------ |
| `/api/business/me`               | GET    | none                                                           | profile including `timezone`     | bearer, OWNER or STAFF | 401, 403, 404      |
| `/api/business/me`               | PUT    | name, currency, logoUrl, address, timezone (all optional)      | profile including `timezone`     | bearer, OWNER          | 400, 401, 403, 404 |
| `/api/business/onboarding`       | GET    | none                                                           | profile and draft incl. timezone | bearer, OWNER          | 401, 403, 404      |
| `/api/business/onboarding`       | PUT    | name, currency, address, logoUrl, timezone (timezone required) | profile including `timezone`     | bearer, OWNER          | 400, 401, 403, 404 |
| `/api/business/onboarding/draft` | PUT    | field (including `timezone`), value                            | success message                  | bearer, OWNER          | 400, 401, 403, 409 |

Validation errors keep the existing business controller body (`error`, `message`, `details`). No new error code is introduced, except `ONBOARDING_COMPLETE` (409) on the draft route once onboarding is complete (see the Update 2026-10-29). All other endpoints keep their current DTOs.

**Value sourcing**:

| Action                        | Value produced or displayed      | Source                                                                                                                                                            |
| ----------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration                     | Timezone for existing businesses | The migration default `Asia/Dhaka`                                                                                                                                |
| Registration                  | Timezone before onboarding       | The `businesses.timezone` database default `Asia/Dhaka`                                                                                                           |
| Onboarding step 3             | Timezone prefill                 | The draft `timezone` when it passes `TimezoneSchema`, else the browser zone from `Intl.DateTimeFormat().resolvedOptions().timeZone` when valid, else `Asia/Dhaka` |
| Onboarding step 3             | Timezone options                 | `Intl.supportedValuesOf('timeZone')`, with the current value always added and a short built in list when the API is unavailable                                   |
| Onboarding step 3             | Draft save                       | The client select value through the existing draft endpoint                                                                                                       |
| Onboarding completion         | Stored timezone                  | The request `timezone`, validated by `TimezoneSchema` and written to `businesses.timezone`                                                                        |
| Onboarding completion         | Shared settings update           | The `PUT /api/business/onboarding` response `data.timezone` and `data.currency`                                                                                   |
| Settings load                 | Timezone shown                   | `GET /api/business/me` `data.timezone`, canonicalized, else `Asia/Dhaka`                                                                                          |
| Settings load                 | Timezone baseline                | The loaded `data.timezone` after canonicalization; `Asia/Dhaka` when the stored value is invalid                                                                  |
| Settings save                 | Stored timezone                  | The request `timezone` after the change confirmation, through `PUT /api/business/me`                                                                              |
| Shared provider               | Active auth snapshot             | The auth client subscription notified by `setAuth` and `clearAuth`                                                                                                |
| Shared provider               | Cached settings                  | `localStorage` key `f-commerce:business-settings:v1:<businessId>` holding `{ currency, timezone }`, validated before use                                          |
| Shared provider               | Fresh settings                   | `GET /api/business/me` once per app load and again on an auth change, when a token and business id are present                                                    |
| Shared provider               | Day shown at render              | The client clock and the provider timezone through the frontend `todayInTimeZone`, after the mounted flag is true                                                 |
| Logout                        | Cached settings removal          | `clearAuth` removes the active business key and notifies the provider                                                                                             |
| Shell badge                   | Timezone and currency text       | The provider `timezone` and `currency`                                                                                                                            |
| Shell header date             | Weekday, day, month              | The client clock and the provider timezone through `Intl.DateTimeFormat`                                                                                          |
| Every timestamp surface       | Displayed date and time          | The stored ISO timestamp and the provider timezone through `formatDateTime`                                                                                       |
| Delivery date warning         | Business today                   | `todayInTimeZone(provider timezone, client now)`                                                                                                                  |
| Overdue badge                 | Business today and active status | The stored `YYYY-MM-DD` deadline, `todayInTimeZone(provider timezone, client now)`, and the existing `ORDER_ACTIVE_STATUSES`                                      |
| Future reports and dashboards | Server day boundary              | `todayInTimeZone(business timezone, server now)` from `backend/src/domain/timezone.ts` (no current caller)                                                        |
| Any missing or bad zone       | Fallback zone                    | The constant `Asia/Dhaka`                                                                                                                                         |

**Key invariants**:

- Every business has exactly one timezone that is not null, and every new row defaults to `Asia/Dhaka`.
- A timezone written through the API is the canonical IANA ID; an invalid stored value is read as `Asia/Dhaka`.
- The delivery deadline stays a plain calendar day and is never converted between zones.
- The Overdue comparison uses the business zone only; the browser zone never decides it.
- `todayInTimeZone` is the only server day rule. No code builds a day by slicing a localized string.
- No order stores a timezone snapshot, and a timezone change never rewrites a stored deadline.
- A timezone change is not audited in this slice.
- The provider loads one profile per app load and on each auth change, and never reads another business's cache.
- The provider never memoizes the day; consumers compute it at render from the business zone.

**Security model**:

- The timezone is ordinary business profile data. An OWNER or STAFF member may read it; only an OWNER may change it. Every request is tenant scoped by the existing `x-business-id` check and repository filter.
- No new regulated data class is introduced. The browser zone is used only as an onboarding prefill and is not stored until the seller completes onboarding, where it becomes business data.
- The cache is keyed by the active business id and is removed by `clearAuth`, so a shared device does not show another business's settings.

**Configuration required**: none. No new environment variable, credential, dependency, or background process.

**Critical test scenarios**:

- Happy path: complete onboarding with a browser zone, load the shell, create an order with a deadline, and read the list and detail; the badge, header date, and timestamps all use the chosen zone, verifies **AC-3**, **AC-5**, **AC-7**, **AC-8**, **AC-9**.
- Settings change: save a different zone, cancel once and confirm once; cancel saves nothing and reverts, confirm updates the badge and timestamps, verifies **AC-6**, **AC-7**.
- Two zones: set the business to two zones that are on different calendar days at the same instant and compare the same stored deadline; the badge agrees for both browser zones and follows the business zone, verifies **AC-9**, **AC-10**.
- Daylight saving: check a day before and after a daylight saving transition and a leap day; the helper returns the correct day with no shift, verifies **AC-10**.
- Invalid data: send a blank, an offset, an abbreviation, and an unknown zone to the API; all return 400 and write nothing. Corrupt the stored value and reload; the UI falls back to `Asia/Dhaka` without a crash, verifies **AC-2**, **AC-3**, **AC-11**.
- Cache and auth: load with a cached zone, then with a failed profile request, then with a different business id; the cache is applied only to its business and the fallback holds on failure, verifies **AC-7**, **AC-11**.
- Onboarding resume: refresh after choosing a zone; the draft zone returns. Start a fresh wizard; the browser zone prefills, verifies **AC-5**.
- Regression: read an order through the existing API and confirm the DTO and totals are unchanged, and run the existing suites, verifies **AC-12**.

## Build plan

Tracer Bullet: stand up the column, the profile field, the provider, and one screen path first, then thicken the formatters, the deadline rule, and the onboarding and settings screens.

1. Add the `businesses.timezone` column, the entity and draft type, the `TimezoneSchema` and contract changes, and the generated migration with the `Asia/Dhaka` default. Update the shared fixtures that build a `Business`. Satisfies **AC-1**, **AC-2**, **AC-4**.
2. Build the profile API path: map `timezone` in the repository, include it in the read responses, accept it on update and onboarding completion, accept the draft field, and cover missing and invalid values with 400. Satisfies **AC-2**, **AC-3**, **AC-4**.
3. Add the client `BusinessSettingsProvider`, its per business cache, the auth change subscription in `auth-client.ts`, the fallback, the profile fetch, and the shell badge and header date. Replace the `getBusinessCurrency` calls in the orders and products screens. Satisfies **AC-7**, **AC-11**.
4. Build the onboarding field and the settings field: the grouped native select, browser prefill, draft resume with validation, required validation, the change confirmation dialog with its baseline and corrupt value rule, and the provider update after save from the response. Satisfies **AC-5**, **AC-6**, **AC-12**.
5. Switch the timestamp surfaces to `formatDateTime(value, timeZone)` and move the deadline warning and the Overdue badge to the frontend `todayInTimeZone` at render, after the mounted flag. Keep `formatDateOnly` unchanged for the stored promise. Satisfies **AC-8**, **AC-9**, **AC-11**.
6. Add the backend timezone helper and its unit tests: `DEFAULT_TIME_ZONE`, `isValidTimeZone`, and `todayInTimeZone` with the fixed locale and `formatToParts` rule. Satisfies **AC-10**.
7. Harden and verify: the two zone and daylight saving cases, invalid and fallback cases, onboarding resume, settings cancel and confirm, keyboard and screen reader checks, the order DTO regression, and the full backend, frontend, and contracts suites. Satisfies **AC-1** to **AC-12**.

## Consequences

**Positive**:

- Every viewer sees the same business day, so two people no longer disagree about an overdue promise near midnight.
- The promise stays a plain calendar day, so changing the business zone never rewrites a stored date.
- One profile fetch per app load and per auth change replaces repeated currency calls on several screens.
- Onboarding captures the zone while the seller is already setting up the business.
- A tested server day rule is ready before reports and the dashboard need it.

**Negative / tradeoffs**:

- Changing the zone moves the Overdue badge for historical orders, because old orders follow the current business zone.
- A required onboarding field adds one step, and a seller can choose the wrong zone.
- A timezone change is not audited, so there is no history of the day boundary moving.
- The shell date and badges update on the next render or navigation, not exactly at midnight.
- A tab left open while another tab changes the zone keeps the old value until its next render, because there is no cross tab listener or timer.
- A corrupted stored zone silently falls back to Dhaka instead of surfacing the problem.
- The backend and frontend each carry a copy of the day helper, so they can drift if a future change touches only one.
- The browser zone prefill is a hint about the device, not proof of where the business works.

**Neutral**:

- Adds one business column and one generated migration, with no order schema change.
- Changes the business profile contract shape only; order DTOs and endpoints stay as they are.
- Adds one client provider and one cache entry per business.
- Uses `Intl.supportedValuesOf` where available and a short built in list where it is not.
- The fallback zone is `Asia/Dhaka` in the database, the backend helper, and the frontend provider.

## Follow-up

- [x] Add a business profile audit row if timezone changes later need a trail. Done 2026-11-20 (`BUSINESS_TIMEZONE_CHANGED` written atomically in `DrizzleBusinessRepository`).
- [ ] Add an overdue filter or sort that uses the business day once the orders list needs it.
- [ ] Use `todayInTimeZone` in reports and the dashboard when feature 14 lands.
- [ ] Consider a per order timezone snapshot only if a future requirement needs historical day boundaries.
- [ ] Add a server side overdue flag only if a client other than the console needs it.
- [x] Update the orders follow-up that says the business has no timezone field; this spec closes it.
- [ ] Collapse the duplicate profile fetch that fires on every auth change while already signed in, when the business switcher lands.

## Rationale

Reasoning, options, and context: see [rationale.md](rationale.md).

### Update 2026-10-29: the draft route reports a skipped write

Recorded after the 2026-10-29 review. This section refines AC-2 and AC-3; nothing else moves.

- `PUT /api/business/onboarding/draft` answers `409 { error: 'ONBOARDING_COMPLETE', message }` when the repository skips the write because onboarding is already complete. Before this, the route answered `200` for a write that never happened.
- `saveDraft` reports whether the row was updated instead of returning `void`, and the route answers from that. The completion check itself is unchanged.
- This is the one error code this spec adds, so AC-3's "no new error code" sentence and the endpoint table both name it. No other route, permission, or audit row changes.
- The frontend's silent draft flush keeps ignoring the 409, so the wizard never shows an error after completion.
- Covered at the repository, service, and route layers, including both skip directions against a real PostgreSQL database.
