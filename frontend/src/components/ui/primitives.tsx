'use client';

import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { createContext, useContext, useEffect, useId, useRef } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-sky text-on-sky hover:bg-sky-strong',
  secondary: 'border border-border bg-surface text-ink hover:border-sky',
  quiet: 'text-body hover:bg-surface-muted',
  danger: 'bg-danger text-on-danger hover:bg-danger-strong',
};

const controlClassName =
  'min-h-11 rounded-md border border-border bg-surface px-3 text-base text-ink outline-none transition-colors placeholder:text-muted focus-visible:border-sky focus-visible:ring-2 focus-visible:ring-sky/30 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-muted';

export function Button({ className = '', variant = 'primary', ...props }: ButtonProps) {
  return (
    <button
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky disabled:cursor-not-allowed disabled:opacity-50 ${buttonVariants[variant]} ${className}`}
      {...props}
    />
  );
}

export function Link({ className = '', ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      className={`inline-flex min-h-11 items-center rounded-md text-sky underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky ${className}`}
      {...props}
    />
  );
}

export function IconButton({ label, className = '', ...props }: ButtonProps & { label: string }) {
  return <Button {...props} className={`min-w-11 px-2 ${className}`} aria-label={label} />;
}

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const field = useContext(FieldControlContext);
  return (
    <input
      className={`${controlClassName} w-full ${className}`}
      {...props}
      id={props.id ?? field?.id}
      aria-describedby={
        [field?.describedBy, props['aria-describedby']].filter(Boolean).join(' ') || undefined
      }
      aria-invalid={props['aria-invalid'] ?? (field?.invalid ? true : undefined)}
    />
  );
}

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const field = useContext(FieldControlContext);
  return (
    <select
      className={`${controlClassName} w-full ${className}`}
      {...props}
      id={props.id ?? field?.id}
      aria-describedby={
        [field?.describedBy, props['aria-describedby']].filter(Boolean).join(' ') || undefined
      }
      aria-invalid={props['aria-invalid'] ?? (field?.invalid ? true : undefined)}
    />
  );
}

export function Textarea({
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const field = useContext(FieldControlContext);
  return (
    <textarea
      className={`${controlClassName} min-h-28 w-full py-3 ${className}`}
      {...props}
      id={props.id ?? field?.id}
      aria-describedby={
        [field?.describedBy, props['aria-describedby']].filter(Boolean).join(' ') || undefined
      }
      aria-invalid={props['aria-invalid'] ?? (field?.invalid ? true : undefined)}
    />
  );
}

interface FieldControlContextValue {
  id: string;
  describedBy?: string;
  invalid: boolean;
}

const FieldControlContext = createContext<FieldControlContextValue | null>(null);

export function Field({
  children,
  description,
  error,
  label,
  htmlFor,
}: {
  children: ReactNode;
  description?: string;
  error?: string;
  label: string;
  htmlFor: string;
}) {
  const descriptionId = description ? `${htmlFor}-description` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="grid gap-2">
      <label className="text-sm font-semibold text-ink" htmlFor={htmlFor}>
        {label}
      </label>
      <FieldControlContext.Provider value={{ id: htmlFor, describedBy, invalid: Boolean(error) }}>
        {children}
      </FieldControlContext.Provider>
      {description && (
        <p className="text-sm text-muted" id={descriptionId}>
          {description}
        </p>
      )}
      {error && <FormMessage id={errorId}>{error}</FormMessage>}
    </div>
  );
}

export function FormMessage({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p className="text-sm text-danger" id={id} role="alert">
      {children}
    </p>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-border bg-surface p-5 shadow-card ${className}`}>
      {children}
    </section>
  );
}

export function Badge({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex min-h-7 items-center rounded-full bg-surface-muted px-2.5 text-xs font-semibold text-body ${className}`}
    >
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: 'success' | 'warning' | 'danger' | 'neutral' }) {
  const styles = {
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
    neutral: 'bg-surface-muted text-body',
  };

  return <Badge className={styles[status]}>{status}</Badge>;
}

export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <span
      aria-label={name}
      className="inline-flex size-10 items-center justify-center rounded-full bg-sky-soft font-mono text-sm font-semibold text-sky-strong"
    >
      {initials}
    </span>
  );
}

type DataTableColumn<Row> = {
  key: keyof Row;
  label: string;
  render?: (row: Row) => ReactNode;
};

export function DataTable<Row extends { id: string }>({
  columns,
  rows,
}: {
  columns: DataTableColumn<Row>[];
  rows: Row[];
}) {
  return (
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
          <tr>
            {columns.map((column) => (
              <th className="px-3 py-3 font-semibold" key={String(column.key)} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr className="text-body" key={row.id}>
              {columns.map((column) => (
                <td className="px-3 py-4" key={String(column.key)}>
                  {column.render ? column.render(row) : String(row[column.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RecordCard({ children }: { children: ReactNode }) {
  return (
    <article className="grid gap-4 rounded-lg border border-border bg-surface p-4 md:hidden">
      {children}
    </article>
  );
}

export function Pagination({ label = 'Pagination' }: { label?: string }) {
  return (
    <nav
      aria-label={label}
      className="flex items-center justify-between border-t border-border pt-4"
    >
      <Button disabled variant="secondary">
        Previous
      </Button>
      <span className="font-mono text-sm text-muted">1 of 1</span>
      <Button disabled variant="secondary">
        Next
      </Button>
    </nav>
  );
}

export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-3 rounded-lg border border-border bg-surface-muted p-4 md:flex md:items-end">
      {children}
    </div>
  );
}

function useOverlay(onClose: () => void, open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();

    const focusableSelector =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const root = ref.current;
      if (!root) return;
      const focusable = Array.from(root.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusable.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      // A backdrop click can leave focus on the body. Pull it back into the
      // dialog instead of letting the next Tab reach the page behind it.
      if (!active || !root.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (event.shiftKey) {
        if (active === first || active === root) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || active === root) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [open]);

  return ref;
}

export function Dialog({
  children,
  description,
  onClose,
  open,
  title,
}: {
  children: ReactNode;
  description?: string;
  onClose: () => void;
  open: boolean;
  title: string;
}) {
  const ref = useOverlay(onClose, open);
  const titleId = useId();
  const descriptionId = useId();
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4" role="presentation">
      <div
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className="w-full max-w-lg rounded-lg border border-border bg-surface p-6 shadow-panel"
        ref={ref}
        role="dialog"
        tabIndex={-1}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-ink" id={titleId}>
              {title}
            </h2>
            {description && (
              <p className="mt-1 text-sm text-body" id={descriptionId}>
                {description}
              </p>
            )}
          </div>
          <IconButton label="Close dialog" onClick={onClose} variant="quiet">
            Close
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Sheet({
  children,
  onClose,
  open,
  title,
}: {
  children: ReactNode;
  onClose: () => void;
  open: boolean;
  title: string;
}) {
  const ref = useOverlay(onClose, open);
  const titleId = useId();
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-ink/40" role="presentation">
      <aside
        aria-labelledby={titleId}
        aria-modal="true"
        className="ml-auto flex h-full w-full max-w-md flex-col border-l border-border bg-surface p-6 shadow-panel"
        ref={ref}
        role="dialog"
        tabIndex={-1}
      >
        <div className="mb-6 flex items-center justify-between gap-4">
          <h2 className="text-xl font-semibold text-ink" id={titleId}>
            {title}
          </h2>
          <IconButton label="Close sheet" onClick={onClose} variant="quiet">
            Close
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>
  );
}

export function Toast({ children }: { children: ReactNode }) {
  return (
    <div
      aria-live="polite"
      className="rounded-md border border-border bg-surface p-4 text-sm text-ink shadow-panel"
      role="status"
    >
      {children}
    </div>
  );
}

export function Tooltip({ children, label }: { children: ReactNode; label: string }) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-md bg-ink px-2 py-1 text-xs text-on-ink opacity-0 transition-opacity group-hover:opacity-100">
        {label}
      </span>
    </span>
  );
}

export function Alert({
  children,
  variant = 'neutral',
}: {
  children: ReactNode;
  variant?: 'neutral' | 'danger' | 'success';
}) {
  const styles = {
    neutral: 'border-border bg-surface-muted text-body',
    danger: 'border-danger/30 bg-danger-soft text-danger',
    success: 'border-success/30 bg-success-soft text-success',
  };
  return (
    <div
      aria-live={variant === 'danger' ? 'assertive' : 'polite'}
      className={`rounded-md border p-4 text-sm ${styles[variant]}`}
      role={variant === 'danger' ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span
      aria-label={label}
      className="inline-block size-5 animate-spin rounded-full border-2 border-sky/30 border-t-sky"
      role="status"
    />
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`animate-pulse rounded-md bg-surface-muted ${className}`} />
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-48 place-items-center rounded-lg border border-dashed border-border bg-surface-muted p-8 text-center text-body">
      {children}
    </div>
  );
}

export function ErrorState({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div
      className="grid gap-3 rounded-lg border border-danger/30 bg-danger-soft p-6 text-danger"
      role="alert"
    >
      <p>{children}</p>
      {onRetry && (
        <Button onClick={onRetry} variant="danger">
          Try again
        </Button>
      )}
    </div>
  );
}
