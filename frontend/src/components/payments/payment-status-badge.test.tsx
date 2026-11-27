import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PaymentStatusType } from '@f-commerce/contracts';
import { PaymentStatusBadge } from './payment-status-badge';

describe('PaymentStatusBadge', () => {
  // covers spec 0010 AC-10 and AC-20: displays readable status text rather than color alone
  it.each<[PaymentStatusType, string]>([
    ['UNPAID', 'Unpaid'],
    ['PARTIAL', 'Partial'],
    ['PAID', 'Paid'],
    ['REFUND_OWED', 'Refund owed'],
    ['NONE', 'No payments'],
  ])('renders %s with visible text label %s', (status, label) => {
    render(<PaymentStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeVisible();
  });
});
