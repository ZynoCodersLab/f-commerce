import type { PaymentStatusType } from '@f-commerce/contracts';
import { Badge } from '@/components/ui/primitives';
import { PAYMENT_STATUS_LABEL, PAYMENT_STATUS_TONE } from '@/lib/payment-format';

export function PaymentStatusBadge({ status }: { status: PaymentStatusType }) {
  return <Badge className={PAYMENT_STATUS_TONE[status]}>{PAYMENT_STATUS_LABEL[status]}</Badge>;
}
