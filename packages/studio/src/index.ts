export { createStudio, type Studio, type StudioOptions } from './router';
export {
  ActivityStore,
  creditsBooking,
  recordActivity,
  toActivityEntry,
  type ActivityEntry,
  type ActivityLog,
  type ActivityQuery,
  type ActivityRecorder,
} from './activity';
export { computeOverview, type Overview, type AgentRow } from './stats';
export { bookingsCsv, countBySource, sourceDetail, sourceLabel, type SourceCount } from './sources';
export { actorFromRequest, agentName, MCP_CLIENT_INFO_META_KEY } from './agents';
export {
  BusinessSettingsSchema,
  OpeningPeriodSchema,
  WEEKDAY_KEYS,
  type BusinessSettings,
  type BusinessSettingsInput,
  type GoogleIntegrationView,
  type SettingsView,
  type StudioSettingsAdapter,
  type WeekdayKey,
} from './settings';
export { CustomerMatchSchema, type CustomerRef, type DataRightsAdapter } from './data-rights';
export { STUDIO_HTML, studioHtml, type StudioLegal } from './ui';
export {
  GuestProfileInputSchema,
  buildPreshift,
  guestHistory,
  guestKey,
  guestKeys,
  hasProfileData,
  pruneGuestProfiles,
  type GuestHistory,
  type Preshift,
  type PreshiftEntry,
} from './guests';
