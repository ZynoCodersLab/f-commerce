import {
  OrderCreateRequest,
  OrderDto,
  ORDER_SOURCES,
  OrderItemInput,
  OrderItemUpdateInput,
  OrderPageDto,
  OrderSourceType,
  OrderStatusChangeRequest,
  OrderSummaryDto,
  OrderUpdateRequest,
} from '@f-commerce/contracts';
import {
  EDITABLE_ORDER_STATUSES,
  getStockMovement,
  ORDER_TRANSITIONS,
  OrderDetail,
  OrderItem,
  OrderStatus,
} from '../../domain/entities/order.entity.js';
import {
  IOrderRepository,
  OrderCatalogProduct,
  OrderCatalogVariant,
  OrderUpdateData,
  OrderWriteItem,
} from '../../domain/repositories/order.repository.js';
import {
  decodeOrderListCursor,
  encodeOrderListCursor,
  ORDER_DEFAULT_PAGE_SIZE,
  ORDER_MAX_PAGE_SIZE,
  orderStatusKey,
} from '../../domain/order-cursor.js';
import { isUniqueViolation } from './database-errors.js';
import {
  CustomerArchivedError,
  DuplicateOrderError,
  InvalidStatusTransitionError,
  NotFoundError,
  OrderChangedError,
  OrderLockedError,
  ValidationError,
} from '../../domain/errors.js';

export interface OrderActor {
  businessId: string;
  userId: string;
}

interface CatalogMaps {
  productById: Map<string, OrderCatalogProduct>;
  variantById: Map<string, OrderCatalogVariant>;
}

interface ResolvedLine {
  id?: string;
  productId: string;
  variantId: string | null;
  productNameSnapshot: string;
  variantLabelSnapshot: string | null;
  priceSnapshot: number;
  costSnapshot: number;
  quantity: number;
}

const MAX_MONEY_TOTAL = 2_000_000_000;
const MAX_SEARCH_LENGTH = 100;

/** The label a seller sees for a variant, in the product's option order. */
function variantLabel(
  product: OrderCatalogProduct,
  variant: OrderCatalogVariant | undefined,
): string | null {
  if (!variant) return null;
  const ordered = product.options
    .map((option) => variant.combination[option.name])
    .filter((value): value is string => typeof value === 'string' && value !== '');
  if (ordered.length > 0) return ordered.join(' / ');
  const fallback = Object.values(variant.combination).filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  return fallback.length > 0 ? fallback.join(' / ') : null;
}

function toSource(value: string | undefined): OrderSourceType | null {
  return value !== undefined && (ORDER_SOURCES as readonly string[]).includes(value)
    ? (value as OrderSourceType)
    : null;
}

function toItemDto(item: OrderItem) {
  return {
    id: item.id,
    productId: item.productId,
    variantId: item.variantId ?? null,
    productName: item.productNameSnapshot,
    variantLabel: item.variantLabelSnapshot ?? null,
    price: item.priceSnapshot,
    cost: item.costSnapshot,
    quantity: item.quantity,
    subtotal: item.subtotal,
    position: item.position,
  };
}

function toOrderDto(detail: OrderDetail): OrderDto {
  const order = detail.order;
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    source: toSource(order.source),
    customerId: order.customerId,
    customerName: order.customerNameSnapshot,
    customerPhone: order.customerPhoneSnapshot,
    shippingAddress: order.shippingAddress ?? null,
    notes: order.notes ?? null,
    deliveryDeadline: order.deliveryDeadline ?? null,
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    discount: order.discount,
    total: order.total,
    paidAmount: order.paidAmount,
    dueAmount: order.dueAmount,
    version: order.version,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    items: detail.items.map(toItemDto),
    history: detail.history.map((row) => ({
      id: row.id,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      note: row.note ?? null,
      changedByName: row.changedByName,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

function toSummaryDto(summary: {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  customerNameSnapshot: string;
  total: number;
  dueAmount: number;
  source?: string;
  deliveryDeadline?: string;
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;
}): OrderSummaryDto {
  return {
    id: summary.id,
    orderNumber: summary.orderNumber,
    status: summary.status,
    customerName: summary.customerNameSnapshot,
    total: summary.total,
    dueAmount: summary.dueAmount,
    source: toSource(summary.source),
    deliveryDeadline: summary.deliveryDeadline ?? null,
    itemCount: summary.itemCount,
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
  };
}

/** Merge lines that share a product and variant, keeping first occurrence order. */
function mergeLines(entries: ResolvedLine[]): OrderWriteItem[] {
  const merged = new Map<string, ResolvedLine>();
  const order: string[] = [];

  for (const entry of entries) {
    const key = `${entry.productId}:${entry.variantId ?? ''}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...entry });
      order.push(key);
      continue;
    }

    if (existing.priceSnapshot !== entry.priceSnapshot) {
      throw new ValidationError(['items'], 'Lines for the same item must share one unit price');
    }
    existing.quantity += entry.quantity;
    if (existing.quantity > 1000) {
      throw new ValidationError(['items'], 'A merged quantity must stay between 1 and 1000');
    }
    // Keep line identity when any occurrence of the pair names an existing line.
    if (existing.id === undefined && entry.id !== undefined) {
      existing.id = entry.id;
    }
  }

  if (merged.size > 50) {
    throw new ValidationError(['items'], 'An order may have at most 50 lines');
  }

  return order.map((key, index) => {
    const line = merged.get(key)!;
    return {
      ...line,
      subtotal: line.priceSnapshot * line.quantity,
      position: index,
    };
  });
}

export class OrderService {
  constructor(private readonly repository: IOrderRepository) {}

  /** Look up an existing create by its Idempotency-Key, before any body work. */
  async findIdempotent(key: string): Promise<OrderDto | null> {
    const existing = await this.repository.findDetailByIdempotencyKey(key);
    return existing ? toOrderDto(existing) : null;
  }

  async create(
    input: OrderCreateRequest,
    actor: OrderActor,
    idempotencyKey: string | null,
  ): Promise<{ order: OrderDto; replayed: boolean }> {
    const customer = await this.requireCustomer(input.customerId);
    const items = await this.resolveCreateLines(input.items);
    const totals = this.computeTotals(items, input.deliveryFee, input.discount);

    if (!input.confirmDuplicate) {
      const duplicate = await this.repository.findDuplicate(
        customer.id,
        items.map((item) => ({ productId: item.productId, variantId: item.variantId })),
      );
      if (duplicate) {
        throw new DuplicateOrderError({
          id: duplicate.id,
          orderNumber: duplicate.orderNumber,
          status: duplicate.status,
          total: duplicate.total,
          createdAt: duplicate.createdAt,
        });
      }
    }

    const actorName = await this.actorName(actor.userId);

    try {
      const detail = await this.repository.create(
        {
          customerId: customer.id,
          customerNameSnapshot: customer.name,
          customerPhoneSnapshot: customer.phone,
          source: input.source,
          deliveryFee: input.deliveryFee,
          discount: input.discount,
          subtotal: totals.subtotal,
          total: totals.total,
          dueAmount: totals.total,
          shippingAddress: input.shippingAddress,
          notes: input.notes,
          deliveryDeadline: input.deliveryDeadline,
          idempotencyKey,
        },
        items,
        {
          changedByUserId: actor.userId,
          changedByName: actorName,
          note: null,
          fromStatus: null,
        },
        {
          businessId: actor.businessId,
          userId: actor.userId,
          action: 'ORDER_CREATED',
        },
      );
      return { order: toOrderDto(detail), replayed: false };
    } catch (error) {
      // Two creates raced on one key: the winner exists, so return it.
      if (idempotencyKey !== null && isUniqueViolation(error)) {
        const existing = await this.repository.findDetailByIdempotencyKey(idempotencyKey);
        if (existing) return { order: toOrderDto(existing), replayed: true };
      }
      throw error;
    }
  }

  async get(id: string): Promise<OrderDto> {
    const detail = await this.repository.findDetailById(id);
    if (!detail) throw new NotFoundError('Order not found');
    return toOrderDto(detail);
  }

  async list(
    rawStatus: string | undefined,
    rawQ: string | undefined,
    rawLimit: string | undefined,
    rawCursor: string | undefined,
  ): Promise<OrderPageDto> {
    const statuses = this.parseStatuses(rawStatus);
    const q = (rawQ ?? '').trim();
    if (q.length > MAX_SEARCH_LENGTH) {
      throw new ValidationError(['q']);
    }
    const limit = this.parseLimit(rawLimit);
    const statusKey = orderStatusKey(statuses);

    let anchor: { createdAt: Date; id: string } | undefined;
    if (rawCursor !== undefined && rawCursor !== '') {
      const decoded = decodeOrderListCursor(rawCursor, statusKey, q, limit);
      if (!decoded) throw new ValidationError(['cursor']);
      anchor = { createdAt: decoded.createdAt, id: decoded.id };
    }

    const result = await this.repository.list({
      statuses,
      q,
      phoneDigits: q.replace(/[^0-9]/g, ''),
      limit,
      createdAt: anchor?.createdAt,
      id: anchor?.id,
    });

    const last = result.items[result.items.length - 1];
    const nextCursor =
      result.hasMore && last
        ? encodeOrderListCursor({
            createdAt: last.createdAt,
            id: last.id,
            statuses: statusKey,
            q,
            limit,
          })
        : null;

    return { items: result.items.map(toSummaryDto), nextCursor };
  }

  async update(id: string, input: OrderUpdateRequest, actor: OrderActor): Promise<OrderDto> {
    const detail = await this.repository.findDetailById(id);
    if (!detail) throw new NotFoundError('Order not found');
    const order = detail.order;

    // The status lock runs before the version check.
    if (!EDITABLE_ORDER_STATUSES.includes(order.status)) {
      throw new OrderLockedError();
    }

    if (input.version !== order.version) {
      throw new OrderChangedError();
    }

    const changes: OrderUpdateData = {};
    const changedFields: string[] = [];

    if (input.customerId !== undefined && input.customerId !== order.customerId) {
      const customer = await this.requireCustomer(input.customerId);
      changes.customerId = customer.id;
      changes.customerNameSnapshot = customer.name;
      changes.customerPhoneSnapshot = customer.phone;
      changedFields.push('customerId');
    }

    let nextItems: OrderWriteItem[] | null = null;
    if (input.items !== undefined) {
      const resolved = await this.resolveEditLines(detail.items, input.items);
      if (this.itemsChanged(detail.items, resolved)) {
        nextItems = resolved;
        changedFields.push('items');
      }
    }

    const deliveryFee = input.deliveryFee ?? order.deliveryFee;
    const discount = input.discount ?? order.discount;

    if (input.deliveryFee !== undefined && input.deliveryFee !== order.deliveryFee) {
      changes.deliveryFee = input.deliveryFee;
      changedFields.push('deliveryFee');
    }
    if (input.discount !== undefined && input.discount !== order.discount) {
      changes.discount = input.discount;
      changedFields.push('discount');
    }
    if (input.source !== undefined && input.source !== order.source) {
      changes.source = input.source;
      changedFields.push('source');
    }
    if (
      input.shippingAddress !== undefined &&
      input.shippingAddress !== (order.shippingAddress ?? null)
    ) {
      changes.shippingAddress = input.shippingAddress;
      changedFields.push('shippingAddress');
    }
    if (input.notes !== undefined && input.notes !== (order.notes ?? null)) {
      changes.notes = input.notes;
      changedFields.push('notes');
    }
    if (
      input.deliveryDeadline !== undefined &&
      input.deliveryDeadline !== (order.deliveryDeadline ?? null)
    ) {
      changes.deliveryDeadline = input.deliveryDeadline;
      changedFields.push('deliveryDeadline');
    }

    if (changedFields.length === 0) {
      return toOrderDto(detail);
    }

    const effectiveLines =
      nextItems ??
      detail.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        variantId: item.variantId ?? null,
        productNameSnapshot: item.productNameSnapshot,
        variantLabelSnapshot: item.variantLabelSnapshot ?? null,
        priceSnapshot: item.priceSnapshot,
        costSnapshot: item.costSnapshot,
        quantity: item.quantity,
      }));
    const totals = this.computeTotals(
      effectiveLines.map((line, index) => ({ ...line, position: index })),
      deliveryFee,
      discount,
    );
    changes.subtotal = totals.subtotal;
    changes.total = totals.total;
    changes.dueAmount = totals.total - order.paidAmount;

    const updated = await this.repository.update(order.id, order.version, changes, nextItems, {
      businessId: actor.businessId,
      userId: actor.userId,
      action: 'ORDER_UPDATED',
      metadata: JSON.stringify({
        changedFields,
        previousTotal: order.total,
        newTotal: totals.total,
      }),
    });

    if (!updated) throw new OrderChangedError();
    return toOrderDto(updated);
  }

  async changeStatus(
    id: string,
    input: OrderStatusChangeRequest,
    actor: OrderActor,
  ): Promise<OrderDto> {
    const detail = await this.repository.findDetailById(id);
    if (!detail) throw new NotFoundError('Order not found');
    const order = detail.order;
    const nextStatus = input.status as OrderStatus;

    // Checks run in order: existence, transition validity, then version.
    if (!ORDER_TRANSITIONS[order.status].includes(nextStatus)) {
      throw new InvalidStatusTransitionError(order.status, input.status);
    }
    if (input.version !== order.version) {
      throw new OrderChangedError();
    }

    const actorName = await this.actorName(actor.userId);
    const stockMovement = getStockMovement(order.status, nextStatus);
    const updated = await this.repository.changeStatus(
      order.id,
      order.version,
      nextStatus,
      {
        changedByUserId: actor.userId,
        changedByName: actorName,
        note: input.note,
        fromStatus: order.status,
      },
      stockMovement
        ? detail.items.map((item) => ({
            kind: stockMovement,
            productId: item.productId,
            variantId: item.variantId ?? null,
            quantity: item.quantity,
          }))
        : [],
    );

    if (!updated) throw new OrderChangedError();
    return toOrderDto(updated);
  }

  private async requireCustomer(customerId: string) {
    const customer = await this.repository.findCustomer(customerId);
    if (!customer) throw new ValidationError(['customerId']);
    if (customer.archivedAt !== undefined) throw new CustomerArchivedError();
    return customer;
  }

  private async loadCatalog(
    items: { productId: string; variantId?: string | null }[],
  ): Promise<CatalogMaps> {
    const productIds = [...new Set(items.map((item) => item.productId))];
    const variantIds = [
      ...new Set(
        items.map((item) => item.variantId ?? null).filter((id): id is string => id !== null),
      ),
    ];
    const [productRows, variantRows] = await Promise.all([
      this.repository.findCatalogProducts(productIds),
      this.repository.findCatalogVariants(variantIds),
    ]);
    return {
      productById: new Map(productRows.map((row) => [row.id, row])),
      variantById: new Map(variantRows.map((row) => [row.id, row])),
    };
  }

  /** Resolve a catalog line, rejecting an unknown or archived reference. */
  private resolveCatalogLine(
    productId: string,
    variantId: string | null,
    quantity: number,
    unitPrice: number | undefined,
    catalog: CatalogMaps,
  ): ResolvedLine {
    const product = catalog.productById.get(productId);
    if (!product || product.isArchived) throw new ValidationError(['items']);

    const variant = variantId === null ? undefined : catalog.variantById.get(variantId);
    if (variantId !== null && (!variant || variant.productId !== product.id)) {
      throw new ValidationError(['items']);
    }

    return {
      productId: product.id,
      variantId,
      productNameSnapshot: product.name,
      variantLabelSnapshot: variantLabel(product, variant),
      priceSnapshot: unitPrice ?? variant?.price ?? product.price,
      costSnapshot: variant?.cost ?? product.cost ?? 0,
      quantity,
    };
  }

  private async resolveCreateLines(items: OrderItemInput[]): Promise<OrderWriteItem[]> {
    const catalog = await this.loadCatalog(items);
    return mergeLines(
      items.map((item) =>
        this.resolveCatalogLine(
          item.productId,
          item.variantId ?? null,
          item.quantity,
          item.unitPrice,
          catalog,
        ),
      ),
    );
  }

  private async resolveEditLines(
    current: OrderItem[],
    inputs: OrderItemUpdateInput[],
  ): Promise<OrderWriteItem[]> {
    const currentById = new Map(current.map((item) => [item.id, item]));
    const seenLineIds = new Set<string>();
    const newLineInputs = inputs.filter((input) => input.lineId === undefined);
    const catalog = await this.loadCatalog(newLineInputs);
    const entries: ResolvedLine[] = [];

    for (const input of inputs) {
      if (input.lineId === undefined) {
        entries.push(
          this.resolveCatalogLine(
            input.productId,
            input.variantId ?? null,
            input.quantity,
            input.unitPrice,
            catalog,
          ),
        );
        continue;
      }

      if (seenLineIds.has(input.lineId)) throw new ValidationError(['items']);
      seenLineIds.add(input.lineId);

      const stored = currentById.get(input.lineId);
      if (!stored) throw new ValidationError(['items']);
      if (
        input.productId !== stored.productId ||
        (input.variantId ?? null) !== (stored.variantId ?? null)
      ) {
        throw new ValidationError(['items']);
      }

      entries.push({
        id: stored.id,
        productId: stored.productId,
        variantId: stored.variantId ?? null,
        productNameSnapshot: stored.productNameSnapshot,
        variantLabelSnapshot: stored.variantLabelSnapshot ?? null,
        priceSnapshot: input.unitPrice ?? stored.priceSnapshot,
        costSnapshot: stored.costSnapshot,
        quantity: input.quantity,
      });
    }

    return mergeLines(entries);
  }

  private itemsChanged(current: OrderItem[], next: OrderWriteItem[]): boolean {
    if (current.length !== next.length) return true;
    for (let index = 0; index < next.length; index += 1) {
      const stored = current[index];
      const incoming = next[index];
      if (incoming.id === undefined || incoming.id !== stored.id) return true;
      if (incoming.productId !== stored.productId) return true;
      if (incoming.variantId !== (stored.variantId ?? null)) return true;
      if (incoming.quantity !== stored.quantity) return true;
      if (incoming.priceSnapshot !== stored.priceSnapshot) return true;
      if (incoming.position !== stored.position) return true;
    }
    return false;
  }

  private computeTotals(
    lines: { priceSnapshot: number; quantity: number }[],
    deliveryFee: number,
    discount: number,
  ): { subtotal: number; total: number } {
    const subtotal = lines.reduce((sum, line) => sum + line.priceSnapshot * line.quantity, 0);
    if (subtotal > MAX_MONEY_TOTAL) {
      throw new ValidationError(['items'], 'The order subtotal is above the allowed limit');
    }
    if (discount > subtotal + deliveryFee) {
      throw new ValidationError(['discount'], 'The discount cannot exceed the subtotal');
    }
    const total = subtotal + deliveryFee - discount;
    if (total > MAX_MONEY_TOTAL) {
      throw new ValidationError(['total'], 'The order total is above the allowed limit');
    }
    return { subtotal, total };
  }

  private parseStatuses(raw: string | undefined): OrderStatus[] {
    if (raw === undefined || raw.trim() === '') return [];
    const statuses: OrderStatus[] = [];
    for (const part of raw.split(',')) {
      const value = part.trim();
      if (value === '') continue;
      if (!(Object.values(OrderStatus) as string[]).includes(value)) {
        throw new ValidationError(['status']);
      }
      const status = value as OrderStatus;
      if (!statuses.includes(status)) statuses.push(status);
    }
    return statuses;
  }

  private parseLimit(raw: string | undefined): number {
    if (raw === undefined || raw === '') return ORDER_DEFAULT_PAGE_SIZE;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > ORDER_MAX_PAGE_SIZE) {
      throw new ValidationError(['limit']);
    }
    return value;
  }

  private async actorName(userId: string): Promise<string> {
    const name = await this.repository.findActorName(userId);
    return name ?? 'Unknown user';
  }
}
