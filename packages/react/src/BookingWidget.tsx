import type { Booking, ConfirmedBooking, OpenBookingClient, Slot } from '@openbooking-sh/client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { OpenBookingProvider } from './context';
import { formatClock, formatMoney, formatSlotTime, todayAt } from './format';
import { useAvailability, useBooking, useInfo } from './hooks';
import { WIDGET_CSS } from './styles';

export interface BookingWidgetProps {
  /** The booking API of one business: the booking page address plus `/book`. Or use a provider. */
  baseUrl?: string;
  /** A client you made yourself. Or use a provider. */
  client?: OpenBookingClient;
  /** Fix the service (a service id from the business); the picker is hidden. */
  service?: string;
  /** Fix the staff member; the picker is hidden. */
  staff?: string;
  /** First date shown, `YYYY-MM-DD` at the venue. Default: today. */
  date?: string;
  /** Number of guests. Default 1. */
  party?: number;
  /** For dates, times and prices, e.g. `nb-NO`. Default: the visitor's. */
  locale?: string;
  className?: string;
  /** Leave out the default styles and style the `ob-*` classes yourself. */
  unstyled?: boolean;
  /** Called once when a booking is confirmed. */
  onBooked?(booking: ConfirmedBooking): void;
}

/**
 * A drop-in booking form: pick a service and a day, choose a time (it is held for a few minutes),
 * read the price and cancellation terms, tick the box and confirm. Nothing is booked before the
 * customer ticks it. Times for which a deposit must be paid online are sent to the booking page,
 * which handles the payment.
 */
export function BookingWidget(props: BookingWidgetProps) {
  const { baseUrl, client, ...rest } = props;
  if (client || baseUrl) {
    return (
      <OpenBookingProvider {...(client ? { client } : {})} {...(baseUrl ? { baseUrl } : {})}>
        <Widget {...rest} />
      </OpenBookingProvider>
    );
  }
  return <Widget {...rest} />;
}

function Widget(props: Omit<BookingWidgetProps, 'baseUrl' | 'client'>) {
  const { locale, onBooked, party } = props;
  const id = useId();
  const info = useInfo();
  const flow = useBooking();

  const venue = info.data?.venue;
  const timeZone = venue?.timezone ?? 'UTC';

  const [serviceId, setServiceId] = useState(props.service);
  const [staffId, setStaffId] = useState(props.staff ?? '');
  const [date, setDate] = useState(props.date ?? '');
  const [chosen, setChosen] = useState<Slot>();
  const [needsOnlinePayment, setNeedsOnlinePayment] = useState(false);
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    notes: '',
    agreed: false,
  });

  const service = serviceId ?? info.data?.services[0]?.id;
  const day = date || (venue ? todayAt(timeZone) : '');
  const availability = useAvailability(
    info.data && service && day
      ? {
          date: day,
          service,
          ...(staffId ? { staff: staffId } : {}),
          ...(party ? { party } : {}),
        }
      : null,
  );

  const booked = flow.booking;
  useEffect(() => {
    if (booked) onBooked?.(booked);
  }, [booked?.booking_id]);

  const money = (m: Parameters<typeof formatMoney>[0]) => formatMoney(m, locale);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const pick = async (slot: Slot) => {
    setChosen(slot);
    setNeedsOnlinePayment(false);
    // The booking page takes deposits (it knows whether payments are on); the widget does not.
    if (slot.deposit?.due === 'at_confirmation') {
      setNeedsOnlinePayment(true);
      return;
    }
    if (flow.hold) await flow.release();
    await flow.holdSlot(slot.slot_id);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // The box is the customer's yes. Without it nothing is sent.
    if (!form.agreed) return;
    void flow.confirm({
      user_confirmed: true,
      customer: {
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        email: form.email.trim(),
        ...(form.phone.trim() ? { phone_number: form.phone.trim() } : {}),
      },
      ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    });
  };

  const rootProps = {
    className: ['ob-widget', props.className].filter(Boolean).join(' '),
    'data-ob-status': flow.status,
    'aria-label': venue ? `Book ${venue.name}` : 'Book',
  };
  const styles = props.unstyled ? null : <style data-openbooking="">{WIDGET_CSS}</style>;

  if (info.loading || !info.data) {
    return (
      <section {...rootProps}>
        {styles}
        {info.error ? <Problem error={info.error} /> : <p role="status">Loading…</p>}
      </section>
    );
  }

  if (flow.status === 'confirmed' && flow.booking) {
    const b = flow.booking;
    return (
      <section {...rootProps} data-booking-id={b.booking_id}>
        {styles}
        <h2>You are booked</h2>
        <p role="status">
          {b.offering.name}, {formatSlotTime(b.start, timeZone, locale)}
          {b.resource ? ` with ${b.resource}` : ''}.
        </p>
        {b.confirmation_code ? (
          <p>
            Confirmation code: <span className="ob-code">{b.confirmation_code}</span>
          </p>
        ) : null}
        {b.manage_url ? (
          <p>
            <a href={b.manage_url}>View or cancel this booking</a>. Keep this link private.
          </p>
        ) : null}
        <p>
          <button type="button" className="ob-link-button" onClick={() => flow.reset()}>
            Book another time
          </button>
        </p>
      </section>
    );
  }

  const holdView: Booking | undefined = flow.hold;
  const busy = flow.status === 'holding' || flow.status === 'confirming';

  return (
    <section {...rootProps}>
      {styles}
      <h2>{info.data.venue.name}</h2>
      {flow.error ? <Problem error={flow.error} /> : null}

      {holdView ? (
        <form onSubmit={submit} aria-busy={flow.status === 'confirming'}>
          <h3>Your time</h3>
          <div className="ob-terms" data-ob-part="terms">
            <p>
              <strong>{holdView.offering.name}</strong>
              {', '}
              {formatSlotTime(holdView.start, timeZone, locale)}
              {holdView.resource ? ` with ${holdView.resource}` : ''}
            </p>
            {holdView.price ? <p>Price: {money(holdView.price)}</p> : null}
            <p>{holdView.cancellation_policy.description}</p>
            {holdView.expires_at ? (
              <p className="ob-muted">
                Held for you until {formatClock(holdView.expires_at, timeZone, locale)}.
              </p>
            ) : null}
          </div>
          <label className="ob-field">
            <span>First name</span>
            <input
              name="first_name"
              autoComplete="given-name"
              required
              value={form.first_name}
              onChange={(e) => set('first_name', e.target.value)}
            />
          </label>
          <label className="ob-field">
            <span>Last name</span>
            <input
              name="last_name"
              autoComplete="family-name"
              required
              value={form.last_name}
              onChange={(e) => set('last_name', e.target.value)}
            />
          </label>
          <label className="ob-field">
            <span>Email</span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
            />
          </label>
          <label className="ob-field">
            <span>Phone (optional)</span>
            <input
              name="phone"
              type="tel"
              autoComplete="tel"
              value={form.phone}
              onChange={(e) => set('phone', e.target.value)}
            />
          </label>
          <label className="ob-field">
            <span>Notes (optional)</span>
            <textarea
              name="notes"
              rows={2}
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          </label>
          <label className="ob-consent">
            <input
              name="user_confirmed"
              type="checkbox"
              checked={form.agreed}
              onChange={(e) => set('agreed', e.target.checked)}
            />
            <span>I have read the time, price and cancellation terms above and want to book.</span>
          </label>
          <button type="submit" className="ob-button" disabled={!form.agreed || busy}>
            {flow.status === 'confirming' ? 'Booking…' : 'Confirm booking'}
          </button>{' '}
          <button
            type="button"
            className="ob-link-button"
            disabled={busy}
            onClick={() => {
              setChosen(undefined);
              void flow.release();
            }}
          >
            Choose another time
          </button>
        </form>
      ) : (
        <>
          {props.service ? null : (
            <label className="ob-field">
              <span>Service</span>
              <select
                name="service"
                value={service ?? ''}
                onChange={(e) => {
                  setServiceId(e.target.value);
                  setChosen(undefined);
                }}
              >
                {info.data.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.price ? ` (${money(s.price)})` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {props.staff || info.data.staff.length < 2 ? null : (
            <label className="ob-field">
              <span>With</span>
              <select name="staff" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                <option value="">Anyone</option>
                {info.data.staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="ob-field">
            <span>Day</span>
            <input
              name="date"
              type="date"
              value={day}
              onChange={(e) => {
                setDate(e.target.value);
                setChosen(undefined);
              }}
            />
          </label>

          <div aria-live="polite" id={`${id}-times`}>
            {availability.loading ? <p className="ob-muted">Looking for times…</p> : null}
            {availability.error ? <Problem error={availability.error} /> : null}
            {availability.data && availability.data.slots.length === 0 ? (
              <p>No free times on this day. Try another day.</p>
            ) : null}
            {availability.data && availability.data.slots.length > 0 ? (
              <ul className="ob-slots" aria-label="Free times">
                {availability.data.slots.map((slot) => (
                  <li key={slot.slot_id}>
                    <button
                      type="button"
                      className="ob-slot"
                      data-slot-id={slot.slot_id}
                      aria-pressed={chosen?.slot_id === slot.slot_id}
                      disabled={busy}
                      onClick={() => void pick(slot)}
                    >
                      {formatClock(slot.start, timeZone, locale)}
                      {slot.resource ? ` · ${slot.resource.label}` : ''}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {flow.status === 'holding' ? <p role="status">Holding this time for you…</p> : null}
            {needsOnlinePayment && chosen?.deposit ? (
              <p role="status" className="ob-terms">
                This time needs a deposit of {money(chosen.deposit.amount)}, paid online.{' '}
                <a href={info.data.booking_page}>Continue on the booking page</a> to book it.
              </p>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

function Problem({
  error,
}: {
  error: { message: string; suggestedNextAction?: string | undefined };
}) {
  return (
    <div role="alert" className="ob-error">
      <p>{error.message}</p>
      {error.suggestedNextAction ? <p>{error.suggestedNextAction}</p> : null}
    </div>
  );
}
