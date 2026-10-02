import { createMarketplaceService, installShutdownHandlers, listen } from './service.js';

export { FixtureBackend, ProviderError, type MarketplaceBackend } from './backend.js';
export {
  BROWSER_SESSION_STATUSES,
  BrowserSessionManager,
  BrowserUnavailableError,
  PROVIDER_SESSION_ASSESSMENTS,
  type BrowserSessionInfo,
  type BrowserSessionOptions,
  type BrowserSessionStatus,
  type ProviderSessionAssessment
} from './browser.js';
export {
  FACEBOOK_ORIGIN,
  FACEBOOK_MARKETPLACE_PATH,
  FACEBOOK_PROBE_OUTCOMES,
  FacebookSessionProbe,
  classifyFacebookSession,
  toProviderSessionAssessment,
  type FacebookProbeOutcome,
  type FacebookProbeCode,
  type FacebookSessionProbeResult,
  type FacebookSessionProbeOptions,
  type FacebookPageSnapshot
} from './facebook.js';
export { FIXTURE_LISTINGS } from './fixtures.js';
export { createMarketplaceService, installShutdownHandlers, listen, type MarketplaceService, type ServiceOptions } from './service.js';
export {
  ReauthManager,
  ProcessReauthRuntime,
  REAUTH_PHASES,
  REAUTH_LEASE_DEFAULT_MS,
  REAUTH_LEASE_MAX_MS,
  type ReauthPhase,
  type ReauthLease,
  type ReauthStatus,
  type ReauthProcessHandle,
  type ReauthRuntime,
  type ReauthManagerOptions
} from './reauth.js';
export { createReauthAdminServer, type ReauthAdminServer } from './admin.js';
export * from './domain.js';

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  const service = createMarketplaceService();
  await listen(service);
  installShutdownHandlers(service);
}
