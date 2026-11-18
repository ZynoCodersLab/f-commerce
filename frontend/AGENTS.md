<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Overview

The Next.js UI runs on port 3000 and uses server components by default. It imports only from `@f-commerce/contracts`.

## Commands

```bash
npm run dev        # start dev server (frontend on 3000, backend on 4000)
npm run build      # next build
npm run lint       # ESLint over the whole workspace
npm run test       # Vitest unit tests
npm run e2e        # Playwright end to end tests
```

## Conventions

- Keep components pure; avoid imperative DOM calls.
- Use named exports only; no `any` types.
- Prefer server components for data fetching; stream data to the client.
- Design system: build all UI to `design.md` (art direction and the maximalist product bar); token values live in CSS.
- Browser code calls the API through relative `/api/...` paths only. Never hardcode a backend host in client code; the Next.js server proxies `/api/*` to `API_ORIGIN`, and `API_ORIGIN` comes from the environment.
- Read business settings (currency, timezone) from `BusinessSettingsProvider` in `src/components/business/business-settings-provider.tsx`, the one client provider mounted in the root layout. Do not fetch `GET /api/business/me` from a screen just to format money or dates. When the provider gains settings, extend its per-business cache and its auth subscription rather than adding a second request.

## Authentication lifecycle

- `useRequireAuth` returns `ready`. Render nothing until it is true; the server render and hydration both report not ready, so this also prevents a signed out flash.
- `apiFetch` attaches the stored access token and business id. On a `401` it calls `/api/auth/refresh` once, stores the new access token, and replays the original request once. Auth routes (`/api/auth/...`) are never refreshed.
- A `400` or `401` from the refresh clears the session, and the guard sends the user to `/login`. An unreachable refresh keeps the session, so a later request can try again.
- A `403` with `BUSINESS_ACCESS_DENIED` clears the session. `logout` clears the local session even when the API is unreachable.

## Gotchas

- The dev server defaults to port 3000 for Next and port 4000 for the Express backend.
- Do not edit `package-lock.json` directly; run `npm ci` to sync the monorepo lockfile.
- Run the e2e suite from the frontend workspace after installing Playwright browsers.
- Dates and times have one owner: the business timezone. Render every timestamp with `formatDateTime(value, timeZone)` from `src/lib/catalog-format.ts`, and compare a stored `YYYY-MM-DD` date with `todayInTimeZone(timeZone)` from `src/lib/timezone.ts`. Never use the browser's local day, `toLocaleDateString()`, or `new Date()` day math for the Overdue badge or the delivery date warning. Render nothing for those until the provider's mounted flag is true, so the server and hydration render match.
- The stored `deliveryDeadline` is a plain calendar day. Format it with `formatDateOnly` and never pass it through a timestamp, or the day shifts across zones.
- The invite page at `src/app/invite/[token]/page.tsx` is public and carries a secret in the URL. It sits outside the auth guard, and `next.config.ts` gives those routes `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and `X-Robots-Tag: noindex`; never log or persist the token. When the API answers `BUSINESS_ACCESS_DENIED`, the client clears the active business and returns the browser to sign in (`src/lib/auth-client.ts` and `src/lib/auth-guard.ts`).
