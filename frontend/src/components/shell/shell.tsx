'use client';

import type { ComponentType, ReactNode } from 'react';
import { useState } from 'react';
import {
  Boxes,
  ChevronRight,
  LayoutDashboard,
  Menu,
  MoreHorizontal,
  Package,
  Settings,
  ShoppingBag,
  Users,
  UsersRound,
} from 'lucide-react';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  RecordCard,
  Sheet,
  StatusPill,
} from '@/components/ui/primitives';
import { ThemeToggle } from '@/components/theme/theme';
import { useBusinessSettings } from '@/components/business/business-settings-provider';
import { formatBusinessDayLabel, todayInTimeZone } from '@/lib/timezone';

type RouteItem = {
  href: string;
  label: string;
  icon: ComponentType<{ 'aria-hidden'?: boolean; size?: number }>;
};

const routes: RouteItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/orders', label: 'Orders', icon: ShoppingBag },
  { href: '/customers', label: 'Customers', icon: Users },
  { href: '/products', label: 'Products', icon: Package },
];

const secondaryRoutes: RouteItem[] = [
  { href: '/settings', label: 'Settings', icon: Settings },
  { href: '/settings/team', label: 'Team', icon: UsersRound },
];

function isRouteActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function RouteLink({
  item,
  mobile = false,
  pathname,
}: {
  item: RouteItem;
  mobile?: boolean;
  pathname: string;
}) {
  const active = isRouteActive(pathname, item.href);

  return (
    <NextLink
      aria-current={active ? 'page' : undefined}
      className={`flex min-h-11 items-center rounded-md px-3 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky ${mobile ? 'min-w-0 flex-col justify-center gap-1 px-1 text-[0.65rem] whitespace-nowrap' : 'gap-3'} ${active ? 'bg-sky-soft text-sky-strong' : 'text-body hover:bg-surface-muted hover:text-ink'}`}
      href={item.href}
    >
      <item.icon aria-hidden={true} size={18} />
      <span>{item.label}</span>
    </NextLink>
  );
}

function MoreMenu({ pathname, onClose }: { pathname: string; onClose: () => void }) {
  return (
    <div className="grid gap-2">
      <p className="text-sm text-body">
        Utilities and secondary areas live here as they are added.
      </p>
      <nav aria-label="Secondary navigation" className="grid gap-1">
        {secondaryRoutes.map((item) => (
          <div key={item.href} onClick={onClose}>
            <RouteLink item={item} pathname={pathname} />
          </div>
        ))}
      </nav>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const { currency, timezone, mounted } = useBusinessSettings();
  const businessDay = mounted ? todayInTimeZone(timezone) : null;
  const businessDayLabel = mounted ? formatBusinessDayLabel(timezone) : null;
  const badgeLabel = currency ? `${timezone} · ${currency}` : timezone;

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <aside
        aria-label="Sidebar"
        className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-border bg-surface px-5 py-6 lg:flex"
      >
        <div className="mb-10 flex items-center gap-3 px-3">
          <span className="grid size-10 place-items-center rounded-md bg-ink text-on-ink">
            <Boxes aria-hidden="true" size={20} />
          </span>
          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-sky-strong">
              F Commerce
            </p>
            <p className="text-sm font-semibold text-ink">Order desk</p>
          </div>
        </div>
        <nav aria-label="Primary navigation" className="grid gap-1">
          {routes.map((item) => (
            <RouteLink item={item} key={item.href} pathname={pathname} />
          ))}
          <button
            className="flex min-h-11 items-center gap-3 rounded-md px-3 text-left text-sm font-semibold text-body transition-colors hover:bg-surface-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky"
            onClick={() => setMoreOpen(true)}
            type="button"
          >
            <MoreHorizontal aria-hidden="true" size={18} />
            <span>More</span>
          </button>
        </nav>
        <div className="mt-auto grid gap-4 rounded-lg border border-border bg-surface-muted p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-ink">Maya Traders</p>
              <p className="text-xs text-muted">Owner workspace</p>
            </div>
            <ThemeToggle />
          </div>
          <Badge>{badgeLabel}</Badge>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 border-b border-border bg-canvas/95 backdrop-blur">
          <div className="px-3 py-3 sm:px-6 lg:px-10 lg:py-0">
            <div className="lg:flex lg:min-h-16 lg:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="grid size-9 shrink-0 place-items-center rounded-md bg-ink text-on-ink lg:hidden">
                    <Boxes aria-hidden="true" size={18} />
                  </span>
                  <p className="min-h-4 min-w-0 whitespace-nowrap font-mono text-[0.65rem] uppercase tracking-wide text-sky-strong">
                    {businessDay && businessDayLabel ? (
                      <time dateTime={businessDay}>{businessDayLabel}</time>
                    ) : null}
                  </p>
                  <div className="ml-auto flex shrink-0 items-center gap-2 lg:hidden">
                    <ThemeToggle />
                    <button
                      aria-label="Open navigation"
                      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border bg-surface text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky"
                      onClick={() => setMoreOpen(true)}
                      type="button"
                    >
                      <Menu aria-hidden="true" size={18} />
                    </button>
                  </div>
                </div>

                <div className="mt-2 pl-11 lg:mt-0 lg:pl-0">
                  <Badge className="whitespace-nowrap lg:hidden">{badgeLabel}</Badge>
                  <h1 className="mt-2 text-lg font-semibold text-ink lg:mt-1">
                    Good morning, Maya
                  </h1>
                </div>
              </div>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-4 pb-28 pt-8 sm:px-6 lg:px-10 lg:pb-10">
          {children}
        </main>

        <nav
          aria-label="Mobile navigation"
          className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-surface/95 px-2 pb-[env(safe-area-inset-bottom)] pt-2 backdrop-blur lg:hidden"
        >
          {routes.map((item) => (
            <RouteLink item={item} key={item.href} mobile pathname={pathname} />
          ))}
          <button
            className="flex min-h-11 flex-col items-center justify-center gap-1 rounded-md text-xs font-semibold text-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky"
            onClick={() => setMoreOpen(true)}
            type="button"
          >
            <MoreHorizontal aria-hidden="true" size={18} />
            <span>More</span>
          </button>
        </nav>
      </div>

      <Sheet onClose={() => setMoreOpen(false)} open={moreOpen} title="More">
        <MoreMenu onClose={() => setMoreOpen(false)} pathname={pathname} />
      </Sheet>
    </div>
  );
}

type Order = {
  customer: string;
  id: string;
  status: 'success' | 'warning' | 'danger' | 'neutral';
  total: string;
};

const orders: Order[] = [
  { id: '#1048', customer: 'Nusrat Jahan', status: 'success', total: '৳ 4,850' },
  { id: '#1047', customer: 'Tanvir Ahmed', status: 'warning', total: '৳ 2,240' },
  { id: '#1046', customer: 'Sadia Karim', status: 'neutral', total: '৳ 1,680' },
];

export function DashboardSurface() {
  const columns = [
    { key: 'id' as const, label: 'Order' },
    { key: 'customer' as const, label: 'Customer' },
    {
      key: 'status' as const,
      label: 'Status',
      render: (row: Order) => <StatusPill status={row.status} />,
    },
    {
      key: 'total' as const,
      label: 'Total',
      render: (row: Order) => <span className="font-mono text-ink">{row.total}</span>,
    },
  ];

  return (
    <div className="grid gap-8">
      <section className="grid gap-6 rounded-xl border border-border bg-surface p-6 shadow-card sm:p-8 lg:grid-cols-[1fr_auto] lg:items-end">
        <div className="max-w-2xl">
          <p className="mb-3 font-mono text-xs uppercase tracking-[0.18em] text-sky-strong">
            Your daily order desk
          </p>
          <h2 className="max-w-xl text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            Keep today moving, one clear handoff at a time.
          </h2>
          <p className="mt-4 max-w-xl text-base leading-7 text-body">
            You have a healthy start to the week. Confirm the orders that are ready, then check the
            stock notes before the afternoon rush.
          </p>
        </div>
        <Button className="w-full sm:w-auto">
          <ShoppingBag aria-hidden="true" size={18} />
          Create order
        </Button>
      </section>

      <section aria-labelledby="overview-title" className="grid gap-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-muted">At a glance</p>
            <h2 className="mt-1 text-2xl font-semibold text-ink" id="overview-title">
              Today&apos;s pulse
            </h2>
          </div>
          <NextLink
            className="hidden min-h-11 items-center gap-1 text-sm font-semibold text-sky-strong hover:underline sm:inline-flex"
            href="/reports"
          >
            View reports <ChevronRight aria-hidden="true" size={16} />
          </NextLink>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Revenue"
            value="৳ 28,640"
            note="+12.4% from yesterday"
            tone="positive"
          />
          <MetricCard label="Orders" value="18" note="6 need confirmation" tone="attention" />
          <MetricCard label="Items to ship" value="11" note="3 due before 4 pm" tone="neutral" />
          <MetricCard label="Low stock" value="4" note="Review before restock" tone="warning" />
        </div>
      </section>

      <section aria-labelledby="orders-title" className="grid gap-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-muted">Live queue</p>
            <h2 className="mt-1 text-2xl font-semibold text-ink" id="orders-title">
              Recent orders
            </h2>
          </div>
          <NextLink
            className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-sky-strong hover:underline"
            href="/orders"
          >
            Open orders <ChevronRight aria-hidden="true" size={16} />
          </NextLink>
        </div>
        <Card className="overflow-hidden p-0">
          <DataTable columns={columns} rows={orders} />
          <div className="grid gap-3 p-4 md:hidden">
            {orders.map((order) => (
              <RecordCard key={order.id}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-sm text-sky-strong">{order.id}</p>
                    <h3 className="mt-1 font-semibold text-ink">{order.customer}</h3>
                  </div>
                  <StatusPill status={order.status} />
                </div>
                <div className="flex items-center justify-between border-t border-border pt-3">
                  <span className="text-sm text-muted">Order total</span>
                  <span className="font-mono font-semibold text-ink">{order.total}</span>
                </div>
              </RecordCard>
            ))}
          </div>
        </Card>
      </section>

      <section aria-labelledby="next-title" className="grid gap-4 lg:grid-cols-2">
        <Card>
          <p className="font-mono text-xs uppercase tracking-widest text-muted">Next best action</p>
          <h2 className="mt-2 text-xl font-semibold text-ink" id="next-title">
            Four products are close to their stock floor.
          </h2>
          <p className="mt-2 text-sm leading-6 text-body">
            A quick review now keeps tomorrow&apos;s order confirmations from turning into
            backorders.
          </p>
          <NextLink
            className="mt-5 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-sky-strong hover:underline"
            href="/products"
          >
            Review stock <ChevronRight aria-hidden="true" size={16} />
          </NextLink>
        </Card>
        <EmptyState>
          <div>
            <p className="font-semibold text-ink">No unresolved delivery alerts</p>
            <p className="mt-1 text-sm text-body">Your courier follow ups are clear for now.</p>
          </div>
        </EmptyState>
      </section>
    </div>
  );
}

function MetricCard({
  label,
  note,
  tone,
  value,
}: {
  label: string;
  note: string;
  tone: 'positive' | 'attention' | 'neutral' | 'warning';
  value: string;
}) {
  const accents = {
    positive: 'bg-success-soft text-success',
    attention: 'bg-sky-soft text-sky-strong',
    neutral: 'bg-surface-muted text-body',
    warning: 'bg-warning-soft text-warning',
  };

  return (
    <Card className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-body">{label}</p>
        <span className={`size-2 rounded-full ${accents[tone]}`} />
      </div>
      <p className="font-mono text-2xl font-semibold text-ink">{value}</p>
      <p className="text-sm text-muted">{note}</p>
    </Card>
  );
}
