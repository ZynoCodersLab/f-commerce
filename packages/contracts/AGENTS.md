# Contracts

## Overview

The contracts package contains shared TypeScript DTOs, Zod schemas, enums, and API error types. It is the boundary shared by the frontend and backend and must not import application, domain, infrastructure, or presentation code.

## Key files

| File                  | Owns                                                                                |
| --------------------- | ----------------------------------------------------------------------------------- |
| `src/index.ts`        | Shared response schemas and inferred types                                          |
| `src/business.ts`     | Business profile schemas, `TimezoneSchema`, and `resolveTimeZone`                   |
| `src/team.ts`         | Team member, invitation, accept, and role schemas shared by the API and UI          |
| `src/index.test.ts`   | Contract validation tests                                                           |
| `tsconfig.build.json` | Production build program; excludes `src/**/*.test.ts` so `dist/` ships no test code |
| `package.json`        | Package exports and scripts                                                         |

## Commands

Run from the repository root with npm workspaces:

```bash
npm run build --workspace @f-commerce/contracts
npm run lint --workspace @f-commerce/contracts
npm run typecheck --workspace @f-commerce/contracts
npm run test --workspace @f-commerce/contracts
```

## Conventions

- Keep runtime validation in Zod schemas and derive TypeScript types from those schemas where practical.
- Export only DTOs, schemas, enums, and API error types.
- Keep this package independent from backend internals and frontend components.
- Use native ESM, strict TypeScript, and named exports.
- Validate timezones through `TimezoneSchema`, never a bare string. It trims, bounds to 64 characters, rejects fixed offsets and abbreviations, and stores the runtime's canonical ID from `resolveTimeZone`. A response schema that must read a legacy or corrupt value checks presence only, so a bad stored value cannot fail a read.
- Consumers resolve types from `src/index.ts` but runtime values from `dist/index.js` (the `package.json` exports map), so this workspace must be built before an application build or start. The applications' `prebuild` and `pretest` scripts do that automatically, and the frontend also keeps a `predev`. The backend dev server instead runs with `--conditions=tsx-dev`, and the exports map serves `src/index.ts` under that condition, so backend dev runs without a contracts build.

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite._
