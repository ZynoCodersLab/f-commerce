# 0001. Define the seller console design system and UI foundation

**Date**: 2026-09-09
**Status**: Accepted

## Summary

This decision defines the shared visual language and accessible interface rules for the seller console. The foundation uses Tailwind CSS with CSS first theme variables, small custom React primitives, and Lucide icons. It starts with a mobile first application shell, then adapts to a desktop sidebar while keeping later product features responsible for their own workflows.

## Context

The frontend is a small Next.js workspace with a generated page, global CSS, one page module stylesheet, and no shared design source. The product is a mobile first order manager for sellers who repeatedly scan and update operational records from phones and larger screens.

Without a shared system, each feature can invent its own spacing, colors, typography, control states, navigation, and mobile behavior. That would make order and customer work harder to scan, weaken accessibility, and make later changes expensive. The foundation must be light enough for one developer to maintain and precise enough that feature work does not reopen the same visual decisions.

The first supported surface is the authenticated seller console. Authentication and role permissions are separate decisions. This foundation must provide the shell states and interaction rules they need without owning identity, business data, or API calls.

## Requirements

**User stories**:

- As a seller, I want the console to feel consistent on my phone and desktop so that repeated order work stays easy to scan.
- As a frontend developer, I want shared tokens and accessible primitives so that feature screens do not invent their own visual rules.

**Acceptance criteria**:

- **AC-1**: `frontend/design.md` and the frontend token layer define the quiet operational visual language, DM Sans, IBM Plex Mono, ink, sky, signal colors, a spacing scale, typography scale, radii, focus ring, borders, surfaces, shadows, and complete light and dark themes.
- **AC-2**: The application shell provides links to `/dashboard`, `/orders`, `/customers`, and `/products` through a desktop sidebar and mobile bottom navigation. A More button opens a focus managed sheet containing `/settings` and future destinations supplied by their feature specs. Active links work for nested paths.
- **AC-3**: The foundation provides Button, Link, IconButton, Input, Select, Textarea, Field, FormMessage, Card, Badge, StatusPill, Avatar, DataTable, RecordCard, Pagination, FilterBar, Dialog, Sheet, Toast, Tooltip, Alert, Spinner, Skeleton, EmptyState, and ErrorState primitives with semantic labels, visible focus, keyboard access, touch sized targets, and screen reader states.
- **AC-4**: On screens below the medium breakpoint, orders show order number, status, customer, and total in priority order, customers show name, phone, and order count, and products show name, SKU, price, and stock status. Wider screens use tables for these records. Shared loading, empty, error, retry, and reduced motion states remain available across the shell.
- **AC-5**: New frontend components use the shared token and primitive standard, and the generated page styling is removed so the frontend has one visual system. Primitive tests cover keyboard operation, focus, labels, overlay dismissal, live regions, theme switching, and reduced motion.

## Options considered

### Option 1: Tailwind CSS with custom accessible primitives

Tailwind CSS provides utility classes and CSS first theme variables. Small local React primitives own the product behavior and composition, while Lucide provides tree shakeable interface icons.

**Pros**:

- Fits responsive work and shared tokens in the existing Next.js workspace
- Keeps the product language under project control
- Avoids the behavioral and visual weight of a full component library
- Makes mobile first states and reduced motion rules explicit

**Cons**:

- The team must maintain primitive behavior and documentation
- Utility classes can become inconsistent without review and component boundaries
- Tailwind and Lucide add frontend dependencies

### Option 2: CSS Modules with global custom properties

The project would keep its current CSS Modules approach and add shared custom properties and local component styles without a utility framework.

**Pros**:

- Adds the fewest dependencies
- Matches the generated frontend structure
- Gives each component direct control over its CSS

**Cons**:

- Repeated responsive and state styles are easier to drift apart
- Shared conventions rely more heavily on manual review
- A large primitive set creates more stylesheet surface to maintain

### Option 3: Full third party component library

The project would adopt a library that supplies controls, layout patterns, and interaction behavior, then theme it for the seller console.

**Pros**:

- Provides broad component coverage quickly
- Can reduce the amount of interaction code maintained locally
- Often includes established keyboard and screen reader behavior

**Cons**:

- The library becomes a second product language to constrain or override
- The dependency and theme surface are larger than this foundation needs
- Mobile navigation, dense records, and seller specific states still need custom work

## Decision

**Chosen option**: Option 1: Tailwind CSS with custom accessible primitives

The frontend will use Tailwind CSS version 4 with CSS first theme variables, custom React primitives, and direct imports from `lucide-react`. The build adds `tailwindcss`, `@tailwindcss/postcss`, and `lucide-react`, and uses a PostCSS integration with no JavaScript Tailwind configuration. Utility classes are allowed in the shell and primitives. Feature screens consume the primitives and may use utilities for layout, but they must use the shared semantic tokens for visual values.

A light theme is the default for server rendering. A small client theme boundary reads the `f-commerce-theme` value from local storage, otherwise follows the operating system preference, and writes `data-theme="light"` or `data-theme="dark"` on the root HTML element. The boundary must avoid a visible theme flash and must keep the server default deterministic. Fonts use `next/font/google` with DM Sans weights 400, 500, 600, and 700, and IBM Plex Mono weights 400, 500, and 600, with local system fallbacks.

The visual direction is a quiet operational studio with comfortable spacing, DM Sans for display and interface text, and IBM Plex Mono for identifiers, amounts, and dense utility values. The color system uses ink, sky, and signal colors. Normal text meets a 4.5 to 1 contrast ratio, large text meets a 3 to 1 ratio, and signal colors never communicate meaning without a text or icon label.

**Implementation skills**: `tailwindcss` (`hairyf/skills`, `.agents/skills/tailwindcss/`) · `lucide-icons` (`aksuharun/skills`, `.agents/skills/lucide-icons/`)

## Rationale

The engineer chose Tailwind CSS, custom primitives, and a two family type system. That choice fits the small existing frontend and the need to support mobile first layouts without adopting a large component library. CSS first theme variables give the project one token source, while custom primitives keep keyboard behavior, touch sizing, and seller specific states explicit.

The current generated CSS demonstrates the opposite risk: global values and page local values are already split between `globals.css` and `page.module.css`, and the generated page uses Geist and rounded generic actions. Keeping that structure while features grow would make consistency depend on memory. A full component library would reduce some control work but would add a larger dependency and make the quiet operational direction harder to own.

## Standard definition

**Canonical pattern**:

The source of truth is `frontend/design.md`. Its tokens are implemented in `frontend/src/app/globals.css` with Tailwind CSS version 4 theme variables, and a token test checks that the executable names and required theme values remain aligned. Feature components use complete, readable utility class names and shared primitives. Dynamic class construction is not allowed when a complete class map can express the variants.

```css
@import 'tailwindcss';

:root {
  --ink-950: #111827;
  --ink-700: #374151;
  --ink-100: #e5e7eb;
  --surface-0: #ffffff;
  --surface-50: #f8fafc;
  --sky-600: #0284c7;
  --signal-success: #15803d;
  --signal-warning: #b45309;
  --signal-danger: #b91c1c;
}

.dark {
  --ink-950: #f8fafc;
  --ink-700: #cbd5e1;
  --ink-100: #334155;
  --surface-0: #0f172a;
  --surface-50: #111827;
  --sky-600: #38bdf8;
  --signal-success: #4ade80;
  --signal-warning: #fbbf24;
  --signal-danger: #f87171;
}

@theme inline {
  --color-ink-950: var(--ink-950);
  --color-ink-700: var(--ink-700);
  --color-ink-100: var(--ink-100);
  --color-surface-0: var(--surface-0);
  --color-surface-50: var(--surface-50);
  --color-sky-600: var(--sky-600);
  --color-signal-success: var(--signal-success);
  --color-signal-warning: var(--signal-warning);
  --color-signal-danger: var(--signal-danger);
  --font-sans: var(--font-dm-sans);
  --font-mono: var(--font-plex-mono);
}
```

```tsx
import Menu from 'lucide-react/icons/menu';

type NavButtonProps = {
  label: string;
  active?: boolean;
  onClick: () => void;
};

export function NavButton({ label, active = false, onClick }: NavButtonProps) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      className="flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-medium text-ink-700 hover:bg-surface-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
      onClick={onClick}
    >
      <Menu aria-hidden="true" size={18} />
      <span>{label}</span>
    </button>
  );
}
```

**Primitive inventory and behavior**:

- Form primitives associate labels, descriptions, and errors through `htmlFor`, `aria-describedby`, and `aria-invalid`.
- Buttons and links expose disabled and pending states without changing their dimensions. Every interactive target is at least 44 by 44 CSS pixels.
- Dialogs and sheets trap focus, close on Escape, restore focus to the trigger, lock page scrolling, and do not close on outside clicks when a destructive confirmation is active.
- Toasts and asynchronous errors use polite live regions. Destructive or urgent errors use assertive announcements only when user action is blocked.
- Tooltips supplement visible labels and never provide the only accessible name for a control.
- Data tables are the wide screen representation. Record cards are the small screen representation and use the field priorities defined in AC 4.
- Loading, empty, and error states preserve the main layout dimensions. Error states offer retry when the caller supplies a retry action.
- All transitions are removed or reduced to opacity changes when `prefers-reduced-motion: reduce` is active. Motion never carries information required to complete a task.

**Replaces**:

- Page local color and spacing variables that are not part of the shared token system
- Generated page styles that define one off control states or typography
- Generic text symbols and unlabelled SVGs used as interface icons
- Feature specific desktop only table layouts that cannot preserve priority fields on mobile

**Enforcement**:

Tailwind theme variables and the token names in `frontend/design.md` are the only shared visual values. Shared primitives live under `frontend/src/components/ui` and are imported by name. TypeScript, the frontend test runner, and accessibility assertions enforce primitive contracts. Each primitive must have tests for its keyboard and screen reader behavior where applicable. A later tooling task may add a class conflict rule after the first primitives establish the local pattern.

**Rollout**:

Use the standard immediately for new frontend code. Replace the generated home page during the foundation build. Existing generated styles are removed as part of that foundation work, so there is no parallel visual system left in the frontend.

**Exceptions**:

A feature may add a local visual token only when the value is specific to its domain, uses the `--feature-<name>-<role>` naming pattern, and is documented in its feature spec. Third party content may require an isolated style wrapper. No feature may bypass semantic HTML, keyboard access, visible focus, touch sizing, or reduced motion support.

## Consequences

**Positive**:

- Later screens share one visual language and predictable interaction states
- Mobile navigation and dense record presentation are decided before feature work
- Light and dark themes can evolve from semantic values instead of duplicated component styles
- The small custom primitive set keeps behavior close to the product and avoids a large UI dependency

**Negative / tradeoffs**:

- The team owns testing and maintenance for primitive behavior
- Tailwind utility composition can still drift if review does not enforce the token and primitive rules
- Adding both theme modes increases the first foundation workload
- DM Sans and IBM Plex Mono add font loading and fallback considerations

**Neutral**:

- The foundation does not define database entities, API endpoints, authentication, or role permissions
- Dashboard, orders, customers, and products own their detailed screens in later features
- Lucide icons remain decorative by default and need an accessible label when they carry meaning

## Follow-up

- [x] Create `frontend/design.md` as the human readable token and component language source
- [x] Add Tailwind CSS, its Next.js build integration, `lucide-react`, DM Sans, and IBM Plex Mono during implementation
- [x] Capture Tailwind and Lucide conventions in `frontend/AGENTS.md` before implementation begins. The conventions are in `frontend/AGENTS.md` under Conventions.
- [x] Define authentication loading and failure integration points when the authentication feature is designed. The lifecycle is in `frontend/AGENTS.md`, with refresh and replay in `frontend/src/lib/auth-client.ts` and the guard in `frontend/src/lib/auth-guard.ts`.
- [x] Recheck the backend scaffold smoke test timeout before the next foundation verification. `backend/src/server.test.ts` starts the server and waits with a bounded timeout.
