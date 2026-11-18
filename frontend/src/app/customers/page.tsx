'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Search, Users } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  Input,
  RecordCard,
  Sheet,
  Skeleton,
  Textarea,
} from '@/components/ui/primitives';
import { AppShell } from '@/components/shell/shell';
import { apiFetch } from '@/lib/auth-client';
import { useRequireAuth } from '@/lib/auth-guard';
import type { CustomerDto } from '@f-commerce/contracts';

const PAGE_SIZE = 20;

interface CustomerPage {
  items: CustomerDto[];
  nextCursor: string | null;
}

interface DuplicatePhone {
  message: string;
  existingCustomerId: string;
  archived: boolean;
}

interface CustomerForm {
  name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
}

const emptyForm: CustomerForm = { name: '', phone: '', email: '', address: '', notes: '' };

/** Read one page of customers. Throws on a failed request. */
async function fetchCustomerPage(searchText: string, cursor: string | null): Promise<CustomerPage> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (searchText !== '') params.set('q', searchText);
  if (cursor !== null) params.set('cursor', cursor);

  const res = await apiFetch(`/api/customers?${params.toString()}`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || 'Failed to load customers');
  }
  return { items: data.data.items, nextCursor: data.data.nextCursor };
}

export default function CustomersPage() {
  const ready = useRequireAuth();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [page, setPage] = useState<CustomerPage>({ items: [], nextCursor: null });
  const [pageStack, setPageStack] = useState<CustomerPage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<CustomerForm>(emptyForm);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicatePhone | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  // Load the first page whenever the trimmed search text settles. State is set
  // from the promise callbacks so no render is queued synchronously here.
  useEffect(() => {
    let cancelled = false;

    fetchCustomerPage(debouncedQuery, null)
      .then((next) => {
        if (cancelled) return;
        setPage(next);
        setPageStack([next]);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Something went wrong');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  /** Load a page from an event handler, where a loading flag is safe to set. */
  const loadFrom = useCallback(
    async (cursor: string | null, append: boolean) => {
      setError(null);
      try {
        const next = await fetchCustomerPage(debouncedQuery, cursor);
        setPage(next);
        setPageStack((previous) => (append ? [...previous, next] : [next]));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong');
      } finally {
        setIsLoading(false);
      }
    },
    [debouncedQuery],
  );

  const goToNext = () => {
    if (!page.nextCursor || isLoading) return;
    setIsLoading(true);
    void loadFrom(page.nextCursor, true);
  };

  const goToPrevious = () => {
    if (pageStack.length <= 1 || isLoading) return;
    const stack = pageStack.slice(0, -1);
    setPageStack(stack);
    setPage(stack[stack.length - 1]);
  };

  const rows = page.items;
  const pageNumber = Math.max(pageStack.length, 1);

  const openForm = () => {
    setForm(emptyForm);
    setFieldErrors([]);
    setFormError(null);
    setDuplicate(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setForm(emptyForm);
    setFieldErrors([]);
    setFormError(null);
    setDuplicate(null);
  };

  const submitForm = async () => {
    setIsSaving(true);
    setFieldErrors([]);
    setFormError(null);
    setDuplicate(null);

    try {
      const payload: Record<string, string> = { name: form.name, phone: form.phone };
      if (form.email.trim() !== '') payload.email = form.email;
      if (form.address.trim() !== '') payload.address = form.address;
      if (form.notes.trim() !== '') payload.notes = form.notes;

      const res = await apiFetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (res.status === 409 && data.error === 'DUPLICATE_PHONE') {
        // Keep the typed values and point the seller at the existing record.
        setDuplicate({
          message: data.message,
          existingCustomerId: data.existingCustomerId,
          archived: Boolean(data.archived),
        });
        return;
      }

      if (res.status === 400) {
        setFieldErrors(Array.isArray(data.fields) ? data.fields : []);
        setFormError(data.message || 'Please check the highlighted fields');
        return;
      }

      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to save customer');
      }

      const createdName: string = data.data.name;
      closeForm();
      setNotice(`${createdName} was added`);
      await loadFrom(null, false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsSaving(false);
    }
  };

  const columns = [
    {
      key: 'name' as const,
      label: 'Customer',
      render: (row: CustomerDto) => (
        <Link
          className="font-semibold text-ink hover:text-sky-strong"
          href={`/customers/${row.id}`}
        >
          {row.name}
        </Link>
      ),
    },
    {
      key: 'phone' as const,
      label: 'Phone',
      render: (row: CustomerDto) => <span className="font-mono text-body">{row.phone}</span>,
    },
    {
      key: 'email' as const,
      label: 'Email',
      render: (row: CustomerDto) => (
        <span className="text-body">{row.email ?? 'Not provided'}</span>
      ),
    },
  ];

  if (!ready) {
    return (
      <AppShell>
        <Skeleton className="h-64 w-full" />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="grid gap-8">
        <header className="grid gap-4 sm:flex sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-sky-strong">
              Buyer records
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink">Customers</h1>
            <p className="mt-2 max-w-xl text-base leading-7 text-body">
              Find a buyer by name or phone, then open their record to see orders and what they owe.
            </p>
          </div>
          <Button className="w-full sm:w-auto" onClick={openForm}>
            <Plus aria-hidden="true" size={18} />
            Add customer
          </Button>
        </header>

        {notice && (
          <Alert variant="success">
            <div className="flex items-center justify-between gap-4">
              <span>{notice}</span>
              <Button onClick={() => setNotice(null)} variant="quiet">
                Dismiss
              </Button>
            </div>
          </Alert>
        )}

        <section aria-labelledby="search-title" className="grid gap-4">
          <h2 className="sr-only" id="search-title">
            Search customers
          </h2>
          <Field htmlFor="customer-search" label="Search by name or phone">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
                size={18}
              />
              <Input
                autoComplete="off"
                className="pl-10"
                id="customer-search"
                onChange={(event) => {
                  setIsLoading(true);
                  setQuery(event.target.value);
                }}
                placeholder="e.g. Nusrat or +88017"
                type="search"
                value={query}
              />
            </div>
          </Field>
        </section>

        {isLoading && rows.length === 0 && (
          <div className="grid gap-3" role="status">
            <span className="sr-only">Loading customers…</span>
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}

        {error && (
          <ErrorState
            onRetry={() => {
              setIsLoading(true);
              void loadFrom(null, false);
            }}
          >
            {error}
          </ErrorState>
        )}

        {!isLoading && !error && rows.length === 0 && (
          <div role="status">
            <EmptyState>
              <div>
                <Users aria-hidden="true" className="mx-auto mb-3 text-muted" size={28} />
                <p className="font-semibold text-ink">
                  {debouncedQuery === ''
                    ? 'No customers yet'
                    : `No customers match “${debouncedQuery}”`}
                </p>
                <p className="mt-1 text-sm text-body">
                  {debouncedQuery === ''
                    ? 'Add your first buyer to start tracking their orders.'
                    : 'Try a shorter name, or search by the phone number.'}
                </p>
              </div>
            </EmptyState>
          </div>
        )}

        {rows.length > 0 && (
          <Card className="overflow-hidden p-0">
            <DataTable columns={columns} rows={rows} />
            <div className="grid gap-3 p-4 md:hidden">
              {rows.map((row) => (
                <RecordCard key={row.id}>
                  <div>
                    <Link
                      className="text-lg font-semibold text-ink hover:text-sky-strong"
                      href={`/customers/${row.id}`}
                    >
                      {row.name}
                    </Link>
                    <p className="mt-1 font-mono text-sm text-sky-strong">{row.phone}</p>
                  </div>
                  <div className="border-t border-border pt-3 text-sm text-body">
                    {row.email ?? 'No email on file'}
                  </div>
                </RecordCard>
              ))}
            </div>
          </Card>
        )}

        {rows.length > 0 && (
          <nav
            aria-label="Customer pages"
            className="flex items-center justify-between border-t border-border pt-4"
          >
            <Button
              disabled={pageStack.length <= 1 || isLoading}
              onClick={goToPrevious}
              type="button"
              variant="secondary"
            >
              Previous
            </Button>
            <span className="font-mono text-sm text-muted">Page {pageNumber}</span>
            <Button
              disabled={!page.nextCursor || isLoading}
              onClick={goToNext}
              type="button"
              variant="secondary"
            >
              Next
            </Button>
          </nav>
        )}
      </div>

      <Sheet onClose={closeForm} open={formOpen} title="Add customer">
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submitForm();
          }}
        >
          {formError && <Alert variant="danger">{formError}</Alert>}

          {duplicate && (
            <Alert variant="danger">
              <div className="grid gap-3">
                <p className="font-semibold text-ink">
                  {duplicate.archived
                    ? 'This phone belongs to an archived customer'
                    : 'This phone already belongs to a customer'}
                </p>
                <p>{duplicate.message}</p>
                <Link
                  className="inline-flex min-h-11 items-center font-semibold text-sky-strong underline underline-offset-4"
                  href={`/customers/${duplicate.existingCustomerId}`}
                >
                  Open the existing customer
                </Link>
                {duplicate.archived && (
                  <p className="text-sm">
                    Open their record to restore them, then make any changes there.
                  </p>
                )}
              </div>
            </Alert>
          )}

          <Field
            error={fieldErrors.includes('name') ? 'Enter the customer’s name' : undefined}
            htmlFor="new-name"
            label="Name"
          >
            <Input
              id="new-name"
              maxLength={120}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              required
              value={form.name}
            />
          </Field>

          <Field
            description="Include the country code, for example +8801712345678."
            error={fieldErrors.includes('phone') ? 'Enter a valid phone number' : undefined}
            htmlFor="new-phone"
            label="Phone"
          >
            <Input
              id="new-phone"
              inputMode="tel"
              onChange={(event) => setForm({ ...form, phone: event.target.value })}
              required
              type="tel"
              value={form.phone}
            />
          </Field>

          <Field
            error={fieldErrors.includes('email') ? 'Enter a valid email address' : undefined}
            htmlFor="new-email"
            label="Email (optional)"
          >
            <Input
              id="new-email"
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              type="email"
              value={form.email}
            />
          </Field>

          <Field htmlFor="new-address" label="Address (optional)">
            <Textarea
              id="new-address"
              maxLength={500}
              onChange={(event) => setForm({ ...form, address: event.target.value })}
              value={form.address}
            />
          </Field>

          <Field htmlFor="new-notes" label="Notes (optional)">
            <Textarea
              id="new-notes"
              maxLength={500}
              onChange={(event) => setForm({ ...form, notes: event.target.value })}
              value={form.notes}
            />
          </Field>

          <div className="flex flex-wrap gap-3">
            <Button disabled={isSaving} type="submit">
              {isSaving ? 'Saving…' : 'Save customer'}
            </Button>
            <Button onClick={closeForm} type="button" variant="secondary">
              Cancel
            </Button>
          </div>
        </form>
      </Sheet>
    </AppShell>
  );
}
