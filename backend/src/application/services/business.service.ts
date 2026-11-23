import { IBusinessRepository } from '../../domain/repositories/business.repository.js';
import { Business } from '../../domain/entities/business.entity.js';
import { CloudinaryService } from '../../infrastructure/services/cloudinary.service.js';
import { BadRequestError } from '../../domain/errors.js';

export interface AddressData {
  street: string;
  city: string;
  region?: string;
  postalCode?: string;
  country: string;
}

import { Currency } from '../../domain/entities/business.entity.js';

export interface BusinessUpdateData {
  name?: string;
  currency?: Currency;
  timezone?: string;
  logoUrl?: string;
  address?: AddressData;
}

export class BusinessService {
  constructor(
    private readonly businessRepository: IBusinessRepository,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  async getBusiness(businessId: string): Promise<Business | null> {
    return this.businessRepository.findById(businessId);
  }

  async updateBusiness(
    businessId: string,
    data: BusinessUpdateData,
    actorUserId: string,
  ): Promise<Business | null> {
    return this.businessRepository.updateProfile(businessId, data, { userId: actorUserId });
  }

  /**
   * Save one onboarding draft field.
   *
   * @returns true when the draft was written, false when onboarding had
   *   already completed so there was no draft left to write.
   */
  async saveDraft(businessId: string, field: string, value: unknown): Promise<boolean> {
    return this.businessRepository.saveDraft(businessId, field, value);
  }

  async completeOnboarding(
    businessId: string,
    data: {
      name: string;
      currency: Currency;
      timezone: string;
      address: AddressData;
      logoUrl?: string;
    },
    actorUserId: string,
  ): Promise<Business | null> {
    if (!data.name || !data.currency || !data.timezone || !data.address) {
      throw new BadRequestError(
        'Name, currency, timezone, and address are required to complete onboarding',
      );
    }
    return this.businessRepository.completeOnboarding(
      businessId,
      {
        name: data.name,
        currency: data.currency,
        timezone: data.timezone,
        address: data.address,
        logoUrl: data.logoUrl,
      },
      { userId: actorUserId },
    );
  }

  async uploadLogo(businessId: string, imageBuffer: Buffer): Promise<{ logoUrl: string }> {
    const result = await this.cloudinaryService.uploadImage(imageBuffer, businessId);
    return { logoUrl: result.secure_url };
  }
}
