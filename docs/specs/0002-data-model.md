# 0002. Design the data model

**Date**: 2026-09-08
**Status**: Accepted

> **Note (2026-10-18)**: Implemented in PostgreSQL with Drizzle ORM. Collections became tables, `ObjectId` references became `uuid` foreign keys, tenant filters are explicit in each repository, and product variants are a normalized `product_variants` table instead of an embedded array. `backend/src/infrastructure/database/drizzle/schema.ts` is the current source of truth; the collection sketches below are kept for history.

## Summary

The data model uses separate MongoDB collections with strict business (tenant) isolation and historical pricing snapshots. It supports the full order lifecycle from creation through delivery and profit calculation. Each business owns its data, and queries automatically filter by `businessId`.

## Context

The F-commerce SaaS serves small businesses selling through Facebook, WhatsApp, Instagram and similar channels. Each business manages customers, products, orders, inventory, payments and profit independently. Key forces: multi-tenant isolation (no cross-business data access), historical pricing requirements (snapshots at time of sale), order status workflow (Pending to Confirmed to Processing to Shipped to Delivered), and inventory management (reservation, deduction, restoration).

The consequence of poor data modeling includes data leakage between businesses (security failure), inaccurate profit reporting (business intelligence failure), inventory inconsistencies (stockouts or overstocking), and order fulfillment issues (wrong product or price at time of delivery).

## Options considered

### Option 1: Embedded documents in orders

Order schema includes an `items` array with embedded product references and pricing snapshots.

**Pros**:

- Single document for each order
- Simpler reads for order history
- Native MongoDB structure

**Cons**:

- Cannot query items independently
- Harder to evolve schema
- Potential document size limits

### Option 2: Separate collections with references (chosen)

Separate collections: `Orders`, `OrderItems`, `Products`, `Customers`, `InventoryTransactions`, `Payments`, `Expenses`, `Categories`, `Couriers`, `AuditLogs`.

**Pros**:

- Flexible querying and indexing
- Easier schema evolution
- Standard document model
- Better tenant isolation enforcement

**Cons**:

- More complex queries
- Need to manage relationships
- Higher operational overhead

### Option 3: Hybrid with denormalized views

Main collections for writes, denormalized collections for fast reads.

**Pros**:

- Optimized query performance
- Built-in audit trails
- Caching friendly

**Cons**:

- Write amplification
- Consistency complexity
- Operational overhead

### Option 4: Microservice-separated

Separate services for different domains.

**Pros**:

- Clear boundaries
- Scalable
- Team autonomy

**Cons**:

- Overkill for MVP
- Distributed systems complexity
- Requires more infrastructure

## Decision

**Chosen option**: Option 2: Separate collections with references.

The F-commerce domain requires flexible querying for reporting (best sellers, inventory status, customer history) and schema evolution (new fields, relationships). Embedded documents restrict this flexibility. The separate collections approach aligns with CRUD principles and expert opinions for moderate complexity domains.

**Implementation skills**: none needed at this stage (the data model will be implemented via `/develop data model` later).

## Rationale

The separate collections approach best addresses the core requirements:

1. **Tenant isolation**: Each collection enforces `{businessId: "..."}` indexes. A tenant middleware layer intercepts every query and adds `where businessId = current.context.businessId`, ensuring cross-tenant leakage is impossible. Combined with MongoDB collection-specific roles, this guarantees complete isolation.

2. **Historical pricing**: Order items need independent snapshots for accurate reporting and pricing history. Embedded snapshots are locked in the parent order, making price history queries difficult.

3. **Query flexibility**: The business needs complex reports like "products with most returns," "customers with highest lifetime value," and "inventory turnover by category." Separate collections make these queries manageable.

4. **Schema evolution**: The product list will grow (new fields like barcode, brand, etc.). Evolving a single embedded structure is more disruptive than adding fields to separate collections.

5. **Consistency enforcement**: Mongoose schemas enforce invariants across collections (e.g., "order total must equal sum of order items"). MongoDB transactions guarantee atomic commits across Order, OrderItems, InventoryTransaction, and Payment collections.

6. **Team autonomy**: While the MVP is solo, the separate collections design makes it easier to partition work later (one developer works on products while another works on inventory logic).

The tradeoff is operational complexity - more collections to manage and query coordination. For the 2-3 month MVP timeline, this complexity is justified by the flexibility and correctness it provides.

**Fixes applied for cross-check gaps:** Added tenant middleware, order status transition rules with audit per transition, inventory version control, price snapshot fields, AuditLogs specification with retention, MongoDB transactions, defined relationships (including Categories/Couriers scope), Payments/Expenses schemas, and idempotency keys for order creation.

## Proposed stack

| Layer           | Choice                       | Reason                                                                                                             |
| --------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Primary DB      | PostgreSQL 18 + Drizzle ORM  | Chosen by stack spec; relational integrity with foreign keys, partial unique indexes, and explicit tenant filters. |
| Auth            | JWT with custom endpoints    | Chosen by stack spec; provides fine-grained control for multi-tenant access.                                       |
| Background jobs | BullMQ + Redis               | Chosen by stack spec; handles async operations like order processing and email.                                    |
| File storage    | Cloudinary                   | Chosen by stack spec; provides scalable image storage for products and business logos.                             |
| Hosting         | Any Node.js 24 platform      | Chosen by stack spec; the host is a deployment detail, and both services run on any Node.js 24 platform.           |
| Observability   | Winston + structured logging | Chosen by stack spec; provides structured logs for debugging.                                                      |

## Consequences

**Positive**:

- Flexible schema evolution for product catalog growth
- Accurate financial reporting with price snapshots
- Strong tenant isolation enforcement
- Independent querying for complex business reports
- Clear separation of concerns for future feature teams

**Negative / tradeoffs**:

- More complex query patterns for multi-collection operations
- Higher operational overhead (multiple collections to manage)
- Slower bulk operations compared to embedded documents
- Need for more careful index strategy

**Neutral**:

- Mongoose validation adds development time but prevents runtime bugs
- Cloudinary abstracts away file storage complexity
- JWT auth adds token management overhead
- Winston logging provides structured data at development cost

## Follow-up

- [x] ~~Confirm Mongoose schema design with `/architect data model` to generate acceptance criteria and build tasks~~ Superseded by PostgreSQL and Drizzle; see the 2026-10-18 note above.
- [x] ~~Set up MongoDB indexing strategy for tenant isolation and common queries~~ Superseded by the PostgreSQL indexes in the Drizzle schema.
- [x] ~~Document the query patterns needed for each feature (reports, dashboards, customer history)~~ Each shipped feature documents its query patterns in its own spec and Drizzle repository (specs 0005 through 0009). Reports and dashboards will document theirs when built.
- [x] ~~Plan for data migration if existing pilot data needs to be imported into new structure~~ Not applicable: the PostgreSQL database started empty and there is no pilot export. Reopen only if a real export appears.
