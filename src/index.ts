import { createMarketplaceService, listen } from './service.js';

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
export { createMarketplaceService, listen, type MarketplaceService, type ServiceOptions } from './service.js';
export * from './domain.js';

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  const service = createMarketplaceService();
  await listen(service);
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}; shutting down Marketplace fixture MCP.`);
    try {
      await service.close();
      process.exitCode = 0;
    } catch (error) {
      console.error('Marketplace fixture MCP shutdown failed:', error);
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
