'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import { Button, Dialog, Field, FormMessage, Input, Select } from '@/components/ui/primitives';
import { AppShell } from '@/components/shell/shell';
import { apiFetch } from '@/lib/auth-client';
import { useRequireAuth } from '@/lib/auth-guard';
import { useBusinessSettings } from '@/components/business/business-settings-provider';
import { CountrySelect } from '@/components/business/country-select';
import { TimezoneSelect } from '@/components/business/timezone-select';
import { DEFAULT_COUNTRY, countryForTimeZone } from '@/lib/countries';
import { DEFAULT_TIME_ZONE } from '@/lib/timezone';
import { TimezoneSchema, type BusinessProfile } from '@f-commerce/contracts';

type Address = {
  street: string;
  city: string;
  region?: string;
  postalCode?: string;
  country: string;
};

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export default function SettingsPage() {
  // Gate behind authentication. All hooks below are called unconditionally
  // so hook order is stable across the ready/not-ready renders.
  const ready = useRequireAuth();
  const { businessId, updateSettings } = useBusinessSettings();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [baselineTimeZone, setBaselineTimeZone] = useState(DEFAULT_TIME_ZONE);
  const [pendingTimeZone, setPendingTimeZone] = useState<string | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);

  const [form, setForm] = useState({
    name: '',
    currency: 'BDT' as BusinessProfile['currency'],
    timezone: DEFAULT_TIME_ZONE,
    address: {
      street: '',
      city: '',
      region: '',
      postalCode: '',
      country: DEFAULT_COUNTRY,
    } as Address,
  });

  useEffect(() => {
    let cancelled = false;

    apiFetch('/api/business/me')
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.message || data.error || 'Failed to load business');
        }
        return res.json();
      })
      .then((data) => {
        if (!cancelled) {
          const b = data.data;
          const parsedTimeZone = TimezoneSchema.safeParse(b.timezone);
          const timezone = parsedTimeZone.success ? parsedTimeZone.data : DEFAULT_TIME_ZONE;

          setBaselineTimeZone(timezone);
          setLogoPreview(b.logoUrl ?? null);
          setForm({
            name: b.name,
            currency: (b.currency || 'BDT') as BusinessProfile['currency'],
            timezone,
            address: b.address
              ? {
                  street: b.address.street,
                  city: b.address.city,
                  region: b.address.region || '',
                  postalCode: b.address.postalCode || '',
                  country: b.address.country,
                }
              : {
                  street: '',
                  city: '',
                  region: '',
                  postalCode: '',
                  country: countryForTimeZone(timezone) ?? DEFAULT_COUNTRY,
                },
          });
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <AppShell>
        <div className="p-8">Loading...</div>
      </AppShell>
    );
  }

  const handleLogoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so choosing the same file again still fires a change event.
    e.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setError('Only image files are allowed');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setError('File must be under 2MB');
      return;
    }

    // Capture the owner before the request so a switch in flight drops the upload.
    const targetBusinessId = businessId;
    const previousPreview = logoPreview;
    setLogoPreview(URL.createObjectURL(file));
    setLogoUploading(true);
    setError(null);
    setSuccess(null);

    try {
      const formData = new FormData();
      formData.append('image', file);

      const res = await apiFetch('/api/business/logo', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Upload failed');
      }

      const logoUrl: unknown = data.data?.logoUrl;
      if (typeof logoUrl !== 'string' || logoUrl === '') {
        throw new Error('Upload failed');
      }

      setLogoPreview(logoUrl);
      updateSettings(
        { currency: form.currency, timezone: form.timezone, logoUrl },
        targetBusinessId,
      );
      setSuccess('Logo updated');
    } catch (err) {
      setLogoPreview(previousPreview);
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setLogoUploading(false);
    }
  };

  const submitProfile = async (timeZone: string) => {
    // Capture the owner before the request so a switch in flight drops the save.
    const targetBusinessId = businessId;
    setIsSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await apiFetch('/api/business/me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, timezone: timeZone }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || data.error || 'Failed to save profile');
      }

      const data = await res.json();
      const saved = data.data as {
        currency?: unknown;
        timezone?: unknown;
        name?: unknown;
        logoUrl?: unknown;
      };
      const savedTimeZone = TimezoneSchema.safeParse(saved.timezone);
      const nextTimeZone = savedTimeZone.success ? savedTimeZone.data : timeZone;

      // The response is untrusted; the provider keeps the last valid value
      // for each field, so the timezone still lands when currency is missing.
      updateSettings(
        {
          currency: saved.currency,
          timezone: nextTimeZone,
          name: saved.name,
          logoUrl: saved.logoUrl,
        },
        targetBusinessId,
      );

      setBaselineTimeZone(nextTimeZone);
      setForm((prev) => ({ ...prev, timezone: nextTimeZone }));
      setPendingTimeZone(null);
      setSuccess('Profile updated');
    } catch (err) {
      // Close the confirmation so the page error is visible and announced.
      setPendingTimeZone(null);
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsSaving(false);
    }
  };

  const saveProfile = () => {
    setSuccess(null);
    const parsedTimeZone = TimezoneSchema.safeParse(form.timezone);
    if (!parsedTimeZone.success) {
      setError('Choose a valid timezone.');
      return;
    }

    if (parsedTimeZone.data !== baselineTimeZone) {
      setPendingTimeZone(parsedTimeZone.data);
      return;
    }

    void submitProfile(parsedTimeZone.data);
  };

  const cancelTimeZoneChange = () => {
    // A confirmed save is already in flight. Keep the chosen value visible
    // until it resolves, so a failure can still satisfy AC-6.
    if (isSaving) return;
    setPendingTimeZone(null);
    setForm((prev) => ({ ...prev, timezone: baselineTimeZone }));
  };

  if (isLoading) {
    return (
      <AppShell>
        <div className="p-8">Loading...</div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="max-w-2xl mx-auto space-y-8">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Business profile</h1>
          <p className="mt-1 text-sm text-body">
            Your business information, billing address, and currency.
          </p>
        </div>

        <Field
          label="Business logo"
          htmlFor="settings-logo-upload"
          description="JPEG, PNG, or WebP. Max 2MB."
        >
          <div className="flex items-center gap-4">
            <label
              className="flex size-24 cursor-pointer items-center justify-center overflow-hidden rounded-lg border-2 border-dashed border-border bg-surface-muted text-center text-sm text-muted hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky"
              htmlFor="settings-logo-upload"
            >
              {logoPreview ? (
                // A local blob preview (or the stored Cloudinary URL) cannot be
                // fetched by the optimizer, so serve the src as-is.
                <Image
                  alt="Business logo"
                  className="h-20 w-20 rounded object-contain"
                  height={80}
                  src={logoPreview}
                  unoptimized
                  width={80}
                />
              ) : (
                <span>{logoUploading ? 'Uploading...' : 'Upload a logo'}</span>
              )}
              <input
                accept="image/*"
                className="sr-only"
                disabled={logoUploading}
                id="settings-logo-upload"
                onChange={handleLogoChange}
                type="file"
              />
            </label>
            <p className="text-xs text-muted">
              {logoUploading ? 'Uploading...' : 'Choose an image to replace the current logo.'}
            </p>
          </div>
        </Field>

        {error && <FormMessage id="settings-error">{error}</FormMessage>}
        {success && (
          <p
            aria-live="polite"
            className="fixed inset-x-4 bottom-4 z-40 mx-auto max-w-md rounded-md border border-success bg-success-soft px-4 py-3 text-sm font-semibold text-success shadow-lg lg:inset-x-auto lg:left-64 lg:right-4"
            role="status"
          >
            {success}
          </p>
        )}

        <div className="space-y-6">
          <Field label="Business name" htmlFor="business-name">
            <Input
              id="business-name"
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Maya Traders"
            />
          </Field>

          <Field label="Currency" htmlFor="currency">
            <Select
              id="currency"
              value={form.currency}
              onChange={(e) =>
                setForm({ ...form, currency: e.target.value as BusinessProfile['currency'] })
              }
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
            description="Used for delivery dates and timestamps."
          >
            <TimezoneSelect
              disabled={isSaving}
              id="timezone"
              value={form.timezone}
              onChange={(timezone) => setForm({ ...form, timezone })}
            />
          </Field>

          <Field label="Street" htmlFor="street">
            <Input
              id="street"
              type="text"
              value={form.address.street}
              onChange={(e) =>
                setForm({ ...form, address: { ...form.address, street: e.target.value } })
              }
              placeholder="123 Main Street"
            />
          </Field>

          <Field label="City" htmlFor="city">
            <Input
              id="city"
              type="text"
              value={form.address.city}
              onChange={(e) =>
                setForm({ ...form, address: { ...form.address, city: e.target.value } })
              }
              placeholder="Dhaka"
            />
          </Field>

          <Field label="Region / State" htmlFor="region" description="Optional">
            <Input
              id="region"
              type="text"
              value={form.address.region || ''}
              onChange={(e) =>
                setForm({ ...form, address: { ...form.address, region: e.target.value } })
              }
              placeholder="Dhaka Division"
            />
          </Field>

          <Field label="Postal code" htmlFor="postal-code" description="Optional">
            <Input
              id="postal-code"
              type="text"
              value={form.address.postalCode || ''}
              onChange={(e) =>
                setForm({ ...form, address: { ...form.address, postalCode: e.target.value } })
              }
              placeholder="1000"
            />
          </Field>

          <Field label="Country" htmlFor="country">
            <CountrySelect
              id="country"
              value={form.address.country}
              onChange={(country) => setForm({ ...form, address: { ...form.address, country } })}
            />
          </Field>

          <Button onClick={saveProfile} disabled={isSaving}>
            {isSaving ? 'Saving...' : 'Save changes'}
          </Button>
        </div>

        <Dialog
          open={pendingTimeZone !== null}
          onClose={cancelTimeZoneChange}
          title="Change the business timezone?"
          description={pendingTimeZone ? `New timezone: ${pendingTimeZone}` : undefined}
        >
          <p className="text-sm text-body">
            Existing order dates do not change, but which orders show as overdue may change.
          </p>
          <div className="mt-6 flex justify-end gap-3">
            <Button variant="secondary" onClick={cancelTimeZoneChange} disabled={isSaving}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (pendingTimeZone) void submitProfile(pendingTimeZone);
              }}
              disabled={isSaving}
            >
              {isSaving ? 'Saving...' : 'Change timezone'}
            </Button>
          </div>
        </Dialog>
      </div>
    </AppShell>
  );
}
