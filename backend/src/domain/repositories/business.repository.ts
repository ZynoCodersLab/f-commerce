import { BusinessAuditActor } from '../business-audit.js';
import { Business } from '../entities/business.entity.js';

export interface IBusinessRepository {
  findById(id: string): Promise<Business | null>;
  updateProfile(
    id: string,
    data: {
      name?: string;
      currency?: string;
      timezone?: string;
      address?: Business['address'];
      logoUrl?: string;
    },
    audit: BusinessAuditActor,
  ): Promise<Business | null>;
  /**
   * Promote onboarding fields to the live profile, clear any remaining draft,
   * and record the onboarding completion audit entry in one transaction.
   *
   * Throws a `ConflictError` when onboarding is already complete so a retry
   * cannot overwrite a profile saved later or add a second completion row.
   */
  completeOnboarding(
    id: string,
    data: {
      name: string;
      currency: string;
      timezone: string;
      address: NonNullable<Business['address']>;
      logoUrl?: string;
    },
    audit: BusinessAuditActor,
  ): Promise<Business | null>;
  /**
   * Merge one field into the onboarding draft.
   *
   * Resolves true when the write landed, false when it was skipped because the
   * business had already finished onboarding (or the id was not a UUID).
   */
  saveDraft(businessId: string, field: string, value: unknown): Promise<boolean>;
}
