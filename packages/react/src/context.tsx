import { createClient, type OpenBookingClient } from '@openbooking-sh/client';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

const ClientContext = createContext<OpenBookingClient | null>(null);

export interface OpenBookingProviderProps {
  /** A client you made yourself (custom `fetch`, headers). Wins over `baseUrl`. */
  client?: OpenBookingClient;
  /** The booking API of one business: the booking page address plus `/book`. */
  baseUrl?: string;
  children: ReactNode;
}

/** Gives the hooks and the widget below it one business to talk to. */
export function OpenBookingProvider({ client, baseUrl, children }: OpenBookingProviderProps) {
  const value = useMemo(() => {
    if (client) return client;
    if (baseUrl) return createClient({ baseUrl });
    throw new Error('OpenBookingProvider needs a `client` or a `baseUrl`.');
  }, [client, baseUrl]);
  return <ClientContext.Provider value={value}>{children}</ClientContext.Provider>;
}

/** The client of the nearest `OpenBookingProvider`. */
export function useOpenBookingClient(): OpenBookingClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error('Wrap this in <OpenBookingProvider baseUrl="…">.');
  return client;
}
