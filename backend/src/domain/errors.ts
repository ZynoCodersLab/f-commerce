export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * The provider result code for a missing email API key.
 *
 * The sender returns it, and the worker treats it as permanent, so both read
 * one constant instead of keeping two copies of the same string in step.
 */
export const EMAIL_NOT_CONFIGURED = 'EMAIL_NOT_CONFIGURED';

export class DuplicateEmailError extends DomainError {
  constructor(message: string = 'Email already exists') {
    super(message);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message: string = 'Invalid credentials') {
    super(message);
  }
}

export class InvalidTokenError extends DomainError {
  constructor(message: string = 'Invalid or expired token') {
    super(message);
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string = 'Resource not found') {
    super(message);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

export class BadRequestError extends DomainError {
  constructor(message: string = 'Invalid request') {
    super(message);
  }
}

/** Field level validation failure, reported as 400 `VALIDATION_ERROR`. */
export class ValidationError extends DomainError {
  constructor(
    public readonly fields: string[],
    message: string = 'Validation failed',
  ) {
    super(message);
  }
}

export class DuplicatePhoneError extends DomainError {
  constructor(
    public readonly existingCustomerId: string,
    public readonly archived: boolean,
    message: string = 'A customer with this phone number already exists',
  ) {
    super(message);
  }
}

export class CustomerChangedError extends DomainError {
  constructor(message: string = 'This customer was changed by someone else') {
    super(message);
  }
}

export class CustomerArchivedError extends DomainError {
  constructor(message: string = 'This customer is archived') {
    super(message);
  }
}

export class CustomerNotArchivedError extends DomainError {
  constructor(message: string = 'This customer is not archived') {
    super(message);
  }
}

export class PhoneInUseError extends DomainError {
  constructor(
    public readonly liveCustomerId: string,
    message: string = 'Another customer already uses this phone number',
  ) {
    super(message);
  }
}

// --- Product errors ---

export class ProductNotFoundError extends NotFoundError {
  constructor() {
    super('Product not found');
  }
}

export class ProductChangedError extends ConflictError {
  constructor() {
    super('This product was changed by someone else');
  }
}

export class ProductArchivedError extends ConflictError {
  constructor() {
    super('This product is archived');
  }
}

export class ProductNotArchivedError extends ConflictError {
  constructor() {
    super('This product is not archived');
  }
}

export class ProductInUseError extends ConflictError {
  constructor() {
    super('This product has been referenced by an order and cannot be deleted');
  }
}

export class DuplicateSkuError extends ConflictError {
  constructor(
    public readonly existingProductId: string,
    public readonly existingVariantId: string | null,
    public readonly archived: boolean,
    message: string = 'A product or variant with this SKU already exists in this business',
  ) {
    super(message);
  }
}

// --- Category errors ---

export class CategoryNotFoundError extends NotFoundError {
  constructor() {
    super('Category not found');
  }
}

export class CategoryChangedError extends ConflictError {
  constructor() {
    super('This category was changed by someone else');
  }
}

export class CategoryInUseError extends ConflictError {
  constructor(public readonly productCount: number) {
    super(`This category is referenced by ${productCount} products`);
  }
}

export class DuplicateCategoryError extends ConflictError {
  constructor(
    public readonly existingCategoryId: string,
    message: string = 'A category with this name already exists in this business',
  ) {
    super(message);
  }
}

// --- Order errors ---

export class OrderLockedError extends ConflictError {
  constructor(message: string = 'This order can no longer be edited') {
    super(message);
  }
}

export class OrderChangedError extends ConflictError {
  constructor(message: string = 'This order was changed by someone else') {
    super(message);
  }
}

export class InvalidStatusTransitionError extends ConflictError {
  constructor(
    public readonly fromStatus: string,
    public readonly toStatus: string,
  ) {
    super(`Cannot move an order from ${fromStatus} to ${toStatus}`);
  }
}

export interface DuplicateOrderSummary {
  id: string;
  orderNumber: string;
  status: string;
  total: number;
  createdAt: Date;
}

export class DuplicateOrderError extends ConflictError {
  constructor(
    public readonly existingOrder: DuplicateOrderSummary,
    message: string = 'A similar order was created in the last 24 hours',
  ) {
    super(message);
  }
}

// --- Team and invitation errors ---

export class InviteNotFoundError extends NotFoundError {
  constructor(message: string = 'This invitation could not be found') {
    super(message);
  }
}

export class InviteExpiredError extends DomainError {
  constructor(message: string = 'This invitation has expired') {
    super(message);
  }
}

export class InviteRevokedError extends DomainError {
  constructor(message: string = 'This invitation was cancelled') {
    super(message);
  }
}

export class InviteAlreadyAcceptedError extends ConflictError {
  constructor(message: string = 'This invitation was already accepted') {
    super(message);
  }
}

/**
 * A resend lost a race with another resend of the same invitation: the link this
 * call generated was never stored, so answering success would leak a dead link.
 */
export class InviteResendConflictError extends ConflictError {
  constructor(
    message: string = 'This invitation was just resent from somewhere else. Reload to see the newest link',
  ) {
    super(message);
  }
}

export class InviteAlreadyMemberError extends ConflictError {
  constructor(message: string = 'This person is already a member of this business') {
    super(message);
  }
}

export class InviteAlreadyPendingError extends ConflictError {
  constructor(
    /** Omitted when a concurrent invite won the index but cannot be re-read. */
    public readonly invitationId?: string,
    message: string = 'An invitation for this email is already waiting to be accepted',
  ) {
    super(message);
  }
}

export class SignInRequiredError extends DomainError {
  constructor(message: string = 'Sign in to the invited account to accept this invitation') {
    super(message);
  }
}

export class EmailMismatchError extends DomainError {
  constructor(message: string = 'This invitation belongs to a different email address') {
    super(message);
  }
}

export class LastOwnerError extends ConflictError {
  constructor(message: string = 'A business must keep at least one owner') {
    super(message);
  }
}

export class SelfChangeNotAllowedError extends ConflictError {
  constructor(message: string = 'You cannot change your own role or remove yourself') {
    super(message);
  }
}

export class TeamMemberNotFoundError extends NotFoundError {
  constructor(message: string = 'This team member could not be found') {
    super(message);
  }
}
