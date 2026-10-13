/**
 * Taking a deposit. The engine never talks to a payment company itself: it asks a
 * {@link PaymentProvider}, and it never trusts a payment token an agent hands it. A token only
 * counts once the provider says it was paid, for this booking, for the deposit amount.
 *
 * The flow, for a slot whose deposit is due at confirmation:
 *
 * 1. `confirm_booking` without a token → `payment_required`, whose details carry a `payment_url`
 *    and the `payment_token` that goes with it. The agent gives the user the link.
 * 2. The user pays on the provider's page.
 * 3. `confirm_booking` again with that `payment_token` → verified, then the booking is confirmed
 *    and records the payment reference.
 * 4. Cancelling later refunds what the cancellation terms say, through the same provider.
 */
import type { Booking, Money } from './schemas';

export interface CheckoutRequest {
  booking: Booking;
  amount: Money;
  /** What the customer sees on the payment page, e.g. "Deposit: Haircut, 12 Oct 18:00". */
  description: string;
  /** The same for every attempt on this booking, so retries reuse one payment page. */
  idempotency_key: string;
}

export interface Checkout {
  /** Where the customer pays. */
  url: string;
  /** What the agent passes back as `payment_token` once the customer has paid. */
  token: string;
}

export interface PaymentVerification {
  paid: boolean;
  /** What was actually charged. */
  amount: Money;
  /** Which booking the customer paid for; `null` if the provider can't tell. */
  booking_id: string | null;
  /** The provider's id for the payment, kept on the booking and used for refunds. */
  reference: string;
}

export interface RefundRequest {
  /** `reference` from {@link PaymentVerification}. */
  reference: string;
  amount: Money;
  /** The same for every attempt, so a retried cancellation never refunds twice. */
  idempotency_key: string;
}

export interface PaymentProvider {
  createCheckout(req: CheckoutRequest): Promise<Checkout>;
  verify(token: string): Promise<PaymentVerification>;
  refund(req: RefundRequest): Promise<void>;
}
