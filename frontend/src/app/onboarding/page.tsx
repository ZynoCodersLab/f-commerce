'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Button, Field, FormMessage, Input, Select } from '@/components/ui/primitives';
import { apiFetch } from '@/lib/auth-client';
import { useRequireAuth } from '@/lib/auth-guard';
import { useBusinessSettings } from '@/components/business/business-settings-provider';
import { CountrySelect } from '@/components/business/country-select';
import { TimezoneSelect } from '@/components/business/timezone-select';
import { DEFAULT_COUNTRY, browserCountry, countryForTimeZone } from '@/lib/countries';
import { DEFAULT_TIME_ZONE, browserTimeZone } from '@/lib/timezone';
import { TimezoneSchema, type BusinessProfile, type OnboardingDraft } from '@f-commerce/contracts';

type Step = 1 | 2 | 3 | 4;

type Address = {
  street: string;
  city: string;
  region?: string;
  postalCode?: string;
  country: string;
};

type OnboardingForm = {
  name: string;
  currency: BusinessProfile['currency'];
  timezone: string;
  address: Address;
  logoUrl: string;
};

type DraftField = 'currency' | 'timezone' | 'address';

// Cache to track saved draft values and avoid redundant API calls
const savedDraftCache: Record<DraftField, string> = {
  currency: '',
  timezone: '',
  address: '',
};

// Keep one pending value per field: timezone and currency sit on the same step,
// so a second change inside the debounce window must not drop the first draft.
const pendingSaves = new Map<DraftField, unknown>();
let draftDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function cancelDraftSave() {
  if (draftDebounceTimer) {
    clearTimeout(draftDebounceTimer);
    draftDebounceTimer = null;
  }
  pendingSaves.clear();
}

function resetDraftState() {
  cancelDraftSave();
  savedDraftCache.currency = '';
  savedDraftCache.timezone = '';
  savedDraftCache.address = '';
}

function scheduleDraftSave(field: DraftField, value: unknown) {
  const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);

  // Skip if value hasn't changed
  if (savedDraftCache[field] === serialized) return;
  savedDraftCache[field] = serialized;

  // Keep every field changed inside the window, so the next timer flush sends them all.
  pendingSaves.set(field, value);

  // Reset debounce timer
  if (draftDebounceTimer) clearTimeout(draftDebounceTimer);

  draftDebounceTimer = setTimeout(async () => {
    draftDebounceTimer = null;
    const batch = [...pendingSaves.entries()];
    pendingSaves.clear();

    // One request per field, isolated so one failure cannot drop the others.
    await Promise.all(
      batch.map(async ([pendingField, pendingValue]) => {
        try {
          await apiFetch('/api/business/onboarding/draft', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              field: pendingField,
              value: pendingValue,
            }),
          });
        } catch {
          // Silently fail - draft is for convenience, not critical
        }
      }),
    );
  }, 500); // 500ms debounce
}

type BusinessData = {
  name: string;
  currency: string;
  timezone: string;
  logoUrl: string | null;
  address: Address | null;
  onboardingComplete: boolean;
  /**
   * Partial wizard progress, so every field is optional: a draft saved after
   * step one has no address yet.
   */
  onboardingDraft?: OnboardingDraft | null;
};

export default function OnboardingPage() {
  const router = useRouter();
  const { businessId, updateSettings } = useBusinessSettings();

  // Gate the whole flow behind authentication before any API call.
  // All hooks below are called unconditionally so hook order is stable
  // across the ready/not-ready renders.
  const ready = useRequireAuth();
  const [step, setStep] = useState<Step>(1);
  const [submitting, setSubmitting] = useState(false);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [business, setBusiness] = useState<BusinessData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [form, setForm] = useState<OnboardingForm>({
    name: '',
    currency: 'BDT',
    timezone: DEFAULT_TIME_ZONE,
    address: {
      street: '',
      city: '',
      region: '',
      postalCode: '',
      country: DEFAULT_COUNTRY,
    },
    logoUrl: '',
  });

  useEffect(() => {
    let cancelled = false;

    // Drop any draft state from a previous business or mount.
    resetDraftState();

    apiFetch('/api/business/me', {
      method: 'GET',
    })
      .then(async (res) => {
        if (res.status === 403 && res.headers.get('content-type')?.includes('json')) {
          return res.json().then(async (data) => {
            if (data.error === 'Onboarding required') {
              const onboardingRes = await apiFetch('/api/business/onboarding', { method: 'GET' });
              if (!onboardingRes.ok) throw new Error('Failed to load onboarding');
              return onboardingRes.json();
            }
            throw new Error('Access denied');
          });
        }
        if (!res.ok) throw new Error('Failed to load business');
        return res.json();
      })
      .then(async (data) => {
        if (!cancelled && data) {
          setBusiness(data.data);
          if (data.data.onboardingComplete) {
            router.replace('/dashboard');
          }

          // Always pre-fill the business name from the DB record
          // (it was already provided at registration)
          const businessName = data.data.name || '';

          if (data.data.onboardingDraft) {
            const draft = data.data.onboardingDraft;
            const currency = (draft.currency ||
              data.data.currency ||
              'BDT') as BusinessProfile['currency'];
            const draftTimeZone = TimezoneSchema.safeParse(draft.timezone);
            const timezone = draftTimeZone.success ? draftTimeZone.data : browserTimeZone();
            const savedAddress = draft.address || data.data.address;
            // A draft saved before the address step has no country yet. Follow
            // the timezone the seller would see, not the default country.
            const address: Address = savedAddress
              ? {
                  ...savedAddress,
                  country:
                    savedAddress.country || (countryForTimeZone(timezone) ?? DEFAULT_COUNTRY),
                }
              : {
                  ...form.address,
                  country: countryForTimeZone(timezone) ?? DEFAULT_COUNTRY,
                };
            const logoUrl = draft.logoUrl || data.data.logoUrl || '';

            setForm({
              name: businessName,
              currency,
              timezone,
              address,
              logoUrl,
            });

            // Update draft cache with loaded values
            savedDraftCache.currency = currency;
            savedDraftCache.timezone = timezone;
            savedDraftCache.address = JSON.stringify(address);

            if (draft.logoUrl || data.data.logoUrl) {
              setLogoPreview(draft.logoUrl || data.data.logoUrl || null);
            }
          } else {
            // No draft yet — pre-fill the name, the device's country, and zone.
            setForm((prev) => ({
              ...prev,
              name: businessName,
              timezone: browserTimeZone(),
              address: {
                ...prev.address,
                country: data.data.address?.country || browserCountry(),
              },
            }));
          }
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
      // Drop the pending save and the cache on unmount.
      resetDraftState();
    };
    // Load once per mount: this reads the saved profile and seeds the form, so a
    // re-run on every render of the router or the draft helpers would overwrite
    // what the seller has typed.
  }, [router]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready) return <div className="p-8">Loading your profile...</div>;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setError('Only image files are allowed');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('File must be under 2MB');
      return;
    }

    setLogoPreview(URL.createObjectURL(file));
    setLogoUploading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('image', file);

      const res = await apiFetch('/api/business/logo', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'Upload failed');
      }

      const result = await res.json();
      setForm({ ...form, logoUrl: result.data.logoUrl });
      updateSettings(
        {
          currency: form.currency,
          timezone: form.timezone,
          name: form.name,
          logoUrl: result.data.logoUrl,
        },
        businessId,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setLogoUploading(false);
    }
  };

  const completeOnboarding = async () => {
    const parsedTimeZone = TimezoneSchema.safeParse(form.timezone);
    if (!parsedTimeZone.success) {
      setError('Choose a valid timezone before finishing.');
      return;
    }

    // Stop a pending draft write from landing after completion clears the draft.
    cancelDraftSave();
    // Capture the owner before the request so a switch in flight drops the save.
    const targetBusinessId = businessId;
    setSubmitting(true);
    setError(null);

    try {
      const res = await apiFetch('/api/business/onboarding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          currency: form.currency,
          timezone: parsedTimeZone.data,
          address: form.address,
          logoUrl: form.logoUrl,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'Failed to complete onboarding');
      }

      const data = await res.json();
      const saved = data.data as {
        currency?: unknown;
        timezone?: unknown;
        name?: unknown;
        logoUrl?: unknown;
      };
      const savedTimeZone = TimezoneSchema.safeParse(saved.timezone);
      // Every field goes to the provider, which validates each one. If the
      // response omits the zone, keep the zone this request just saved.
      updateSettings(
        {
          currency: saved.currency,
          timezone: savedTimeZone.success ? savedTimeZone.data : parsedTimeZone.data,
          name: saved.name,
          logoUrl: saved.logoUrl,
        },
        targetBusinessId,
      );

      resetDraftState();
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  if (isLoading) {
    return <div className="p-8">Loading your profile...</div>;
  }

  if (business?.onboardingComplete) {
    return null;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div className="w-full max-w-lg">
        <StepIndicator step={step} />

        {error && <FormMessage id="onboarding-error">{error}</FormMessage>}

        {step === 1 && <StepOne form={form} onNext={() => setStep(2)} />}
        {step === 2 && (
          <StepTwo
            form={form}
            setForm={setForm}
            onNext={() => setStep(3)}
            onBack={() => setStep(1)}
          />
        )}
        {step === 3 && (
          <StepThree
            form={form}
            setForm={setForm}
            onNext={() => setStep(4)}
            onBack={() => setStep(2)}
            logoPreview={logoPreview}
            logoUploading={logoUploading}
            onFileChange={handleFileChange}
          />
        )}
        {step === 4 && (
          <StepFour
            form={form}
            onBack={() => setStep(3)}
            onSubmit={completeOnboarding}
            submitting={submitting}
          />
        )}
      </div>
    </div>
  );
}

function StepIndicator({ step }: { step: Step }) {
  return (
    <div className="mb-8">
      <div className="flex items-center justify-between">
        {[1, 2, 3, 4].map((s) => (
          <div key={s} className="flex items-center">
            <div
              aria-hidden="true"
              className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold ${
                s <= step ? 'bg-sky text-on-sky' : 'bg-surface-muted text-body'
              }`}
            >
              {s}
            </div>
            {s < 4 && (
              <div className={`ml-2 h-1 w-8 ${s < step ? 'bg-sky' : 'bg-surface-muted'}`} />
            )}
          </div>
        ))}
      </div>
      <p className="mt-2 text-sm text-muted">Step {step} of 4</p>
    </div>
  );
}

function StepOne({ form, onNext }: { form: OnboardingForm; onNext: () => void }) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-ink">
        Welcome{form.name ? `, ${form.name}` : ''}!
      </h1>
      <p className="text-sm text-body">Let&apos;s finish setting up your business.</p>

      <Button onClick={onNext}>Get started</Button>
    </div>
  );
}

function StepTwo({
  form,
  setForm,
  onNext,
  onBack,
}: {
  form: OnboardingForm;
  setForm: React.Dispatch<React.SetStateAction<OnboardingForm>>;
  onNext: () => void;
  onBack: () => void;
}) {
  // Save draft when address changes
  const handleAddressChange = (field: keyof Address, value: string) => {
    const newAddress = { ...form.address, [field]: value };
    setForm({ ...form, address: newAddress });
    scheduleDraftSave('address', newAddress);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-ink">Billing address</h1>
      <p className="text-sm text-body">Where should we send invoices and receipts?</p>

      <Field label="Street" htmlFor="street">
        <Input
          id="street"
          type="text"
          value={form.address.street}
          onChange={(e) => handleAddressChange('street', e.target.value)}
          placeholder="123 Main Street"
        />
      </Field>

      <Field label="City" htmlFor="city">
        <Input
          id="city"
          type="text"
          value={form.address.city}
          onChange={(e) => handleAddressChange('city', e.target.value)}
          placeholder="Dhaka"
        />
      </Field>

      <Field label="Region / State" htmlFor="region" description="Optional">
        <Input
          id="region"
          type="text"
          value={form.address.region || ''}
          onChange={(e) => handleAddressChange('region', e.target.value)}
          placeholder="Dhaka Division"
        />
      </Field>

      <Field label="Postal code" htmlFor="postal-code" description="Optional">
        <Input
          id="postal-code"
          type="text"
          value={form.address.postalCode || ''}
          onChange={(e) => handleAddressChange('postalCode', e.target.value)}
          placeholder="1000"
        />
      </Field>

      <Field label="Country" htmlFor="country">
        <CountrySelect
          id="country"
          value={form.address.country}
          onChange={(country) => handleAddressChange('country', country)}
        />
      </Field>

      <div className="flex gap-3">
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext}>Continue</Button>
      </div>
    </div>
  );
}

function StepThree({
  form,
  setForm,
  onNext,
  onBack,
  logoPreview,
  logoUploading,
  onFileChange,
}: {
  form: OnboardingForm;
  setForm: React.Dispatch<React.SetStateAction<OnboardingForm>>;
  onNext: () => void;
  onBack: () => void;
  logoPreview: string | null;
  logoUploading: boolean;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  // Save draft when currency changes
  const handleCurrencyChange = (value: BusinessProfile['currency']) => {
    setForm({ ...form, currency: value });
    scheduleDraftSave('currency', value);
  };

  const [timeZoneError, setTimeZoneError] = useState<string | null>(null);

  const handleTimeZoneChange = (value: string) => {
    setForm({ ...form, timezone: value });
    scheduleDraftSave('timezone', value);
    setTimeZoneError(null);
  };

  const continueWithTimeZone = () => {
    const parsed = TimezoneSchema.safeParse(form.timezone);
    if (!parsed.success) {
      setTimeZoneError('Choose a valid timezone.');
      return;
    }
    onNext();
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-ink">Your currency, timezone, and logo</h1>
      <p className="text-sm text-body">
        This is how your customers will see prices and identify your business.
      </p>

      <Field label="Currency" htmlFor="currency">
        <Select
          id="currency"
          value={form.currency}
          onChange={(e) => handleCurrencyChange(e.target.value as BusinessProfile['currency'])}
        >
          <option value="BDT">BDT - Bangladeshi Taka</option>
          <option value="USD">USD - US Dollar</option>
          <option value="EUR">EUR - Euro</option>
          <option value="GBP">GBP - British Pound</option>
        </Select>
      </Field>

      <Field
        label="Timezone"
        htmlFor="timezone"
        description="Used for delivery deadlines and timestamps."
        error={timeZoneError ?? undefined}
      >
        <TimezoneSelect id="timezone" value={form.timezone} onChange={handleTimeZoneChange} />
      </Field>

      <Field label="Business logo" htmlFor="logo-upload" description="JPEG, PNG, or WebP. Max 5MB.">
        <label
          className="flex h-24 cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-border bg-surface-muted text-center hover:bg-surface"
          htmlFor="logo-upload"
        >
          {logoPreview ? (
            // A local blob object URL (or the stored Cloudinary URL on resume)
            // cannot be fetched by the optimizer, so serve the src as-is.
            <Image
              alt="Logo preview"
              className="h-20 w-20 rounded object-contain"
              height={80}
              src={logoPreview}
              unoptimized
              width={80}
            />
          ) : (
            <span className="text-sm text-muted">
              {logoUploading ? 'Uploading...' : 'Click to upload a logo'}
            </span>
          )}
          <input
            accept="image/*"
            className="sr-only"
            id="logo-upload"
            onChange={onFileChange}
            type="file"
          />
        </label>
        {logoUploading && <p className="text-xs text-muted">Uploading...</p>}
      </Field>

      <div className="flex gap-3">
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button onClick={continueWithTimeZone}>Continue</Button>
      </div>
    </div>
  );
}

function StepFour({
  form,
  onBack,
  onSubmit,
  submitting,
}: {
  form: OnboardingForm;
  onBack: () => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-ink">Review and finish</h1>
      <p className="text-sm text-body">Check your details before entering the order desk.</p>

      <div className="space-y-4 rounded-lg border border-border bg-surface p-4">
        <div className="flex items-center gap-4">
          {form.logoUrl ? (
            // Cloudinary already serves the stored asset from its CDN; keep the
            // URL as-is instead of proxying it through the image optimizer.
            <Image
              alt="Logo"
              className="h-12 w-12 rounded object-contain"
              height={48}
              src={form.logoUrl}
              unoptimized
              width={48}
            />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded bg-sky-soft text-sky-strong font-mono">
              {form.name.slice(0, 2).toUpperCase() || 'BT'}
            </div>
          )}
          <div>
            <p className="font-semibold text-ink">{form.name || 'Unnamed business'}</p>
            <p className="text-sm text-muted">
              {form.currency} · {form.timezone}
            </p>
          </div>
        </div>

        {form.address.street && (
          <div className="grid gap-1 text-sm">
            <p className="text-body">{form.address.street}</p>
            <p className="text-body">
              {form.address.city}
              {form.address.region && `, ${form.address.region}`}
              {form.address.postalCode && ` ${form.address.postalCode}`}
            </p>
            <p className="text-body">{form.address.country}</p>
          </div>
        )}
      </div>

      <div className="flex gap-3">
        <Button variant="secondary" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <Button onClick={onSubmit} disabled={submitting}>
          {submitting ? 'Finishing...' : 'Enter order desk'}
        </Button>
      </div>
    </div>
  );
}
