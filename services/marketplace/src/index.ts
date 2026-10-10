import { facebookMarketsFilePath, loadFacebookMarkets } from './market-config.js';
import { createMarketplaceService, installShutdownHandlers, listen } from './service.js';

export { FixtureBackend, ProviderError, type ConversationBackend, type MarketplaceBackend } from './backend.js';
export { FacebookMarketplaceBackend, type FacebookMarketplaceBackendOptions } from './facebook-marketplace-backend.js';
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
  FACEBOOK_MESSENGER_PATH,
  FACEBOOK_MESSENGER_INBOX_PATH,
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
export { FIXTURE_CONVERSATIONS, FIXTURE_LISTINGS } from './fixtures.js';
export {
  DEFAULT_FACEBOOK_MARKETS,
  MARKETPLACE_ITEM_PATH,
  buildMarketplaceItemUrl,
  buildMarketplaceSearchUrl,
  normalizeLocationKey,
  parseMarketplaceItemId,
  resolveFacebookMarket,
  validateFacebookMarkets,
  validateMarket,
  type FacebookMarket,
  type FacebookMarketResolution
} from './facebook-marketplace-url.js';
export { facebookMarketsFilePath, loadFacebookMarkets } from './market-config.js';
export {
  extractMarketplacePage,
  MARKETPLACE_EXTRACT_LIMITS,
  type ExtractedListingCard,
  type ExtractedMarketplacePage,
  type ExtractedMarketplaceSignals,
  type ExtractMarketplaceOptions
} from './facebook-marketplace-extract.js';
export {
  classifyMarketplacePage,
  interpretMarketplacePage,
  parseMarketplacePage,
  parseMarketplacePrice,
  CURRENCY_SYMBOLS,
  MARKETPLACE_PAGE_KINDS,
  PRICE_PARSE_STATUSES,
  type MarketplacePageKind,
  type MarketplaceParseResult,
  type MarketplaceParseStats,
  type MarketplaceSearchOutcome,
  type ParseMarketplaceInput
} from './facebook-marketplace-parse.js';
export { createMarketplaceService, installShutdownHandlers, listen, parseBackendKind, parseMessengerEnabled, type MarketplaceService, type ServiceOptions } from './service.js';
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
export {
  ACTION_RISK_CLASSES,
  approvalGrantSchema,
  canonicalActionInput,
  subjectDigest,
  authorizeAction,
  DenyAllAuthorizer,
  type ActionRiskClass,
  type ActionScope,
  type ActionDefinition,
  type ApprovalGrant,
  type ActionRequest,
  type AuthorizationDecision,
  type AuthorizationFailureCode,
  type ActionAuthorizer
} from './authorization.js';
export { assertWritableToolsHaveAuthorizer, registerMarketplaceTools, TOOL_DEFINITIONS, type MarketplaceToolOptions } from './tools.js';
export * from './domain.js';

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  const facebookMarkets = loadFacebookMarkets(facebookMarketsFilePath());
  const service = createMarketplaceService({ ...(facebookMarkets !== undefined ? { facebookMarkets } : {}) });
  await listen(service);
  installShutdownHandlers(service);
}
