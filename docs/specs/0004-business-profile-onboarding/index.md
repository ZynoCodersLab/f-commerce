# 0004. Business profile and onboarding

**Date**: 2026-09-22
**Status**: Accepted

> **Note (2026-10-18)**: The store is PostgreSQL 18 with Drizzle ORM. The `currency`, `logoUrl`, `address` and `onboardingComplete` fields live on the `businesses` table in `backend/src/infrastructure/database/drizzle/schema.ts`, and the onboarding draft is a nullable `onboarding_draft` jsonb column that `saveDraft` merges one field at a time. Steps and references below that name a Mongoose model or `BaseSchema.ts` are historical; the `business.repository.integration.test.ts` suite covers the same behaviour against Postgres. The onboarding gate still reads the business through the repository and is covered by `business.controller.route.test.ts`.

## Summary

This design adds a business onboarding step that runs after registration so the seller can complete their business profile, upload a logo, and choose a currency before entering the app. The existing Business entity gets new fields for currency, logo, structured address, and an onboarding completion flag. The app gate redirects incomplete businesses to the onboarding wizard.

## Context

Registration (spec 0003) creates a minimal Business with a name only. The domain entity `Business` already declares `currency`, `logoUrl`, and `address` as fields, but nothing collects them yet. Sellers need to complete this profile before managing orders, because currency drives all pricing and profit calculations, and a business name is required before any order can be created.

A new seller sees the order desk shell and notices it says "Maya Traders" with no way to change it, which is confusing. The onboarding wizard fixes that by completing the business setup.

This feature assumes the existing auth and tenant model from spec 0003: JWT bearer tokens, AsyncLocalStorage-based tenant context, `requireAuth` and `requireBusinessRole` middleware, and the Business/BusinessMember/User collections.

**Constraints**: Bangladesh market (BDT primary), multilingual UI not in scope for this slice, WCAG AA accessibility baseline.

## Requirements

**User stories**:

- As a new business owner, I want to complete my business profile (logo, currency, address) right after registering so that I can start using the app immediately.
- As a business owner, I want to view and edit my business profile later so that my information stays current.
- As a staff member, I want to view the business profile but not edit it so that I can see billing and contact details in context.

**Acceptance criteria**:

- **AC-1**: After registration, a new business owner is redirected to a three-step onboarding wizard (business details, currency, review) that collects name, logo, currency, and a structured address.
- **AC-2**: The onboarding wizard validates all fields using shared Zod schemas and shows inline errors for missing or invalid inputs.
- **AC-3**: The logo upload endpoint accepts a multipart image, proxies it to Cloudinary, and stores the returned secure URL on the Business document.
- **AC-4**: Completing the wizard sets `onboardingComplete` to true and redirects the seller to the main dashboard; incomplete businesses are blocked from the dashboard and redirected to onboarding.
- **AC-5**: An authenticated OWNER can edit the business profile from Settings, and a STAFF member can view but not edit it.

## Options considered

### Option 1: Two-step registration then onboarding wizard (chosen)

Registration creates the business with just a name, then a mandatory onboarding wizard collects the rest before the seller enters the app.

**Pros**:

- Keeps registration friction low; sellers get in the door fast.
- Separates identity creation from business setup, which scales if business types expand later.
- The wizard feels guided and complete rather than a long registration form.

**Cons**:

- Adds a post-login redirect step and gating logic.
- The business starts in an incomplete state that queries must tolerate.

### Option 2: Single progressive registration form

All fields (email, password, business name, currency, address, logo) collected in one registration form.

**Pros**:

- No post-login onboarding gate needed.
- Everything is settled at account creation.

**Cons**:

- A long form at registration increases drop off.
- Logo upload is awkward inline during registration.
- Harder to split into mobile-friendly steps.

### Option 3: Profile completion in Settings only

Registration creates a minimal business. The seller can optionally fill the profile later from Settings with no hard gate.

**Pros**:

- Minimal friction; no redirect.
- Simplest to build.

**Cons**:

- Sellers may never complete the profile, leading to missing currency for orders.
- The app shell shows a placeholder business name with no nudge to fix it.

## Decision

**Chosen option**: Option 1: Two-step registration then onboarding wizard.

The onboarding wizard runs after registration and before the main dashboard. The Business entity gains `currency`, `logoUrl`, `address` (structured), and `onboardingComplete` fields. A backend middleware gate redirects incomplete businesses to `/onboarding`. The logo upload proxies through the Express backend to Cloudinary using the official `cloudinary` npm package.

**Implementation skills**: `vercel-react-best-practices` (`vercel-labs/agent-skills`, `.agents/skills/vercel-react-best-practices/`) · `web-design-guidelines` (`vercel-labs/agent-skills`, `.agents/skills/web-design-guidelines/`) · `lucide-icons` (`aksuharun/skills`, `.agents/skills/lucide-icons/`)

## Rationale

A two-step flow keeps registration fast while ensuring profile completion is mandatory before the seller can use the order desk. The onboarding gate is enforced at the backend middleware layer so it cannot be bypassed by frontend routing logic. Cloudinary is already the project's chosen storage provider (spec 0001), so the backend upload proxy reuses that decision rather than introducing direct frontend uploads. The official `cloudinary` npm package is the standard server-side integration path and is already referenced in the env file.

## Feature design

**Data model sketch**:

- **Business** (existing, extended): `_id`, `name` (string, required), `currency` (string, enum: BDT, USD, EUR, GBP, default BDT), `logoUrl` (string, optional, Cloudinary secure URL), `address` (structured subdocument: `street` string, `city` string, `region` string optional, `postalCode` string optional, `country` string), `onboardingComplete` (boolean, default false), `onboardingDraft` (optional sub-document mirroring `name`, `currency`, `address`, `logoUrl` for wizard resume), `createdAt`, `updatedAt`
- **BusinessMember** (unchanged): `businessId` (FK to Business), `userId` (FK to User), `role` (OWNER, STAFF), `status` (ACTIVE, INVITED)

**State transitions**:

Onboarding is not a lifecycle state machine, but the Business document moves through a profile completion state: `incomplete` (`onboardingComplete = false`) on registration, then `complete` (`onboardingComplete = true`) when the wizard finishes. The middleware gate enforces this transition at the request layer.

**Wizard draft state**: The Business document carries an `onboardingDraft` sub-document mirroring the wizard fields (`name`, `currency`, `address`, `logoUrl`). Each wizard step persists its values into the draft on save, so closing or refreshing the tab mid-wizard preserves progress. On successful completion, the draft fields are promoted to the live Business fields and `onboardingComplete` is set to `true`; the `onboardingDraft` is then cleared.

**Redirect-loop guard**: The middleware gate redirects to `/onboarding` only when `onboardingComplete` is `false`. A completed business that navigates to `/onboarding` is redirected back to `/dashboard`.

**Business name**: The name is editable post-onboarding from Settings (per AC-5 and the "view and edit" user story). The wizard's name step pre-fills from the existing Business name if a draft or prior name exists, so a returned seller lands on familiar data.

**Logo upload failure**: Logo upload is the final wizard step. If the Cloudinary upload returns an error (502, 400, etc.), the wizard shows an inline error on that step with a retry button; the step does not auto-advance and `onboardingComplete` is not set. Completion requires an explicit confirmation, so a failed upload never leaves the business half-complete.

**API surface**:

| Endpoint             | Method | Key inputs                       | Key outputs                                          | Auth                | Key errors         |
| -------------------- | ------ | -------------------------------- | ---------------------------------------------------- | ------------------- | ------------------ |
| `/api/business/me`   | GET    | none                             | name, currency, logoUrl, address, onboardingComplete | bearer              | 401, 404           |
| `/api/business/me`   | PUT    | name, currency, logoUrl, address | updated Business fields                              | bearer (OWNER only) | 401, 403, 400, 404 |
| `/api/business/logo` | POST   | image (multipart form data)      | logoUrl                                              | bearer (OWNER only) | 401, 403, 400, 502 |

**Value sourcing**:

| Action                    | Value produced / displayed                             | Source                                                                                  |
| ------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `register`                | Business with `name`, `onboardingComplete=false`       | Backend generated; name from registration input                                         |
| `GET /api/business/me`    | `currency`, `logoUrl`, `address`, `onboardingComplete` | Business document DB columns (currency/address optional until onboarding)               |
| `PUT /api/business/me`    | Updated fields + `onboardingComplete=true`             | PUT request body validated by shared Zod schema                                         |
| `POST /api/business/logo` | `logoUrl` (Cloudinary secure URL)                      | Cloudinary upload API response `secure_url` field                                       |
| `middleware gate`         | Redirect to `/onboarding`                              | `onboardingComplete` field from Business document (spec 0003 AsyncLocalStorage context) |

**Key invariants**:

- `Business.onboardingComplete` is only set to true when `name`, `currency`, and `address` are all populated.
- The tenant isolation plugin from spec 0003 automatically scopes all Business queries to the requesting business context.
- A STAFF member cannot set or update `onboardingComplete` or `logoUrl`; only the OWNER role can edit the profile.

**Security model**:

- `GET /api/business/me` requires a valid bearer token (any business member can view).
- `PUT /api/business/me` and `POST /api/business/logo` require the OWNER role (STAFF gets 403).
- The tenant isolation plugin ensures no business can read or modify another business's profile.
- Image uploads are validated: content type must be an image, max file size 5MB, and the Cloudinary response URL is stored as a plain string (no HTML or executable content).
- Rate limiting applies to the logo upload endpoint to prevent abuse.

**Configuration required**:

- `CLOUDINARY_CLOUD_NAME`: Cloudinary cloud name (already in .env.example)
- `CLOUDINARY_API_KEY`: Cloudinary API key (already in .env.example)
- `CLOUDINARY_API_SECRET`: Cloudinary API secret (already in .env.example)

**Critical test scenarios**:

- Happy path: owner completes onboarding wizard, profile saved, redirect to dashboard, verifies AC-1, AC-2, AC-4
- Failure case: logo upload returns 502 from Cloudinary failure, profile saves without logo and user can retry later, verifies AC-3
- Auth/permission: STAFF member attempts PUT to /api/business/me, receives 403, verifies AC-5
- Edge case: incomplete business navigates to /dashboard, backend middleware redirects to /onboarding, verifies AC-4

## Build plan

Tracer Bullet ordering: data model migration first, then API surface, then the gateway middleware, then the frontend wizard, then Settings edit page.

1. Add `currency`, `logoUrl`, `address`, and `onboardingComplete` fields to the Business Mongoose model; add Zod schemas for Business profile and address to `packages/contracts/src/business.ts`, satisfies AC-1, AC-2
2. Implement `BusinessService` in the application layer with `getBusiness`, `updateBusiness`, and `uploadLogo` methods, satisfying AC-3, AC-5
3. Add `GET /api/business/me`, `PUT /api/business/me`, and `POST /api/business/logo` endpoints to a `business.controller.ts`, satisfying AC-3, AC-5
4. Add onboarding gate middleware that checks `onboardingComplete` on the Business and redirects to `/onboarding` when false, satisfying AC-4
5. Build the frontend onboarding wizard (`/onboarding` route) with three steps (details, currency, address, review) using shared Zod schemas, satisfying AC-1, AC-2
6. Build the logo upload UI integration with the `/api/business/logo` endpoint, satisfying AC-3
7. Add the business profile section to `/settings` for OWNER editing and read-only STAFF view, satisfying AC-5

## Consequences

**Positive**:

- Sellers complete their profile before using the app, ensuring currency and address are set early.
- The profile data is editable from Settings, supporting ongoing business changes.
- Logo uploads go through the backend, keeping Cloudinary credentials secure.

**Negative / tradeoffs**:

- The onboarding gate adds complexity to the routing layer and must be maintained as the UI grows.
- Cloudinary upload proxy introduces a new dependency and a failure mode on the upload endpoint.
- The Business model schema change requires a migration for existing businesses (none exist yet, so this is a no-op for the current dataset).

**Neutral**:

- The `onboardingComplete` flag is an explicit state rather than a derived check (derived from required field presence), which is simpler to query but must be kept in sync.
- Currency is stored as a string enum rather than a separate collection; adding new currencies later requires a code deploy, not a data migration.

## Follow-up

- [x] Add image MIME type and size validation before the Cloudinary upload reaches the service. Implemented with a magic byte check in `backend/src/presentation/controllers/business.controller.ts`, verified 2026-10-01.
- Consider Cloudinary unsigned upload presets to reduce backend upload load (requires verifying the security model for untrusted uploads)
- [x] Add an audit log entry for business profile changes (onboarding complete, profile updates). Done 2026-11-20 via `BusinessAuditAction` rows written atomically in `DrizzleBusinessRepository`.

## References

**Project sources**:

- `docs/specs/0001-stack-and-architecture.md`: Cloudinary chosen as file storage provider, env vars in .env.example
- `docs/specs/0003-authentication-tenant-isolation/index.md`: Business/BusinessMember data model, AsyncLocalStorage tenant context, auth middleware patterns
- `backend/src/domain/entities/business.entity.ts`: Business entity already declares `currency`, `logoUrl`, `address`
- `backend/src/infrastructure/database/mongoose/models/BaseSchema.ts`: tenant isolation plugin pattern
- `packages/contracts/src/auth.ts`: Zod schema pattern for shared validation
