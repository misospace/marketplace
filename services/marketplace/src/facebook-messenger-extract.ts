export const MESSENGER_EXTRACT_LIMITS = {
  maxThreads: 20,
  maxThreadsScan: 60,
  maxMessages: 50,
  maxMessagesScan: 120,
  maxTextLength: 2000,
  maxPreviewLength: 280,
  maxHrefsPerAnchor: 12
} as const;

export interface ExtractedMessengerSignals {
  hasPasswordInput: boolean;
  hasLoginForm: boolean;
  hasCheckpointForm: boolean;
  hasCaptchaFrame: boolean;
  hasMainLandmark: boolean;
  hasAuthenticatedMarker: boolean;
  hasLoginPrompt: boolean;
  mentionsCheckpoint: boolean;
  mentionsCaptcha: boolean;
}

export interface ExtractedInboxThread {
  threadId: string;
  preview?: string;
  itemId?: string;
}

export interface ExtractedInboxPage {
  url: string;
  signals: ExtractedMessengerSignals;
  hasEmptyStateMarker: boolean;
  threads: ExtractedInboxThread[];
}

export interface ExtractedMessage {
  sender?: 'you' | 'other';
  senderName?: string;
  text: string;
  sentAt?: string;
}

export interface ExtractedThreadPage {
  url: string;
  signals: ExtractedMessengerSignals;
  messages: ExtractedMessage[];
}

export interface MessengerExtractionLimits {
  maxThreads: number;
  maxThreadsScan: number;
  maxMessages: number;
  maxMessagesScan: number;
  maxTextLength: number;
  maxPreviewLength: number;
  maxHrefsPerAnchor: number;
}

export interface ExtractMessengerInboxOptions {
  threadPath: string;
  limits: MessengerExtractionLimits;
}

export interface ExtractMessengerThreadOptions {
  limits: MessengerExtractionLimits;
}

export function extractMessengerInboxPage(options: ExtractMessengerInboxOptions): ExtractedInboxPage {
  const threadPath = options.threadPath;
  const threadIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const limits = options.limits;
  const boundedLimit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const maxThreads = boundedLimit(limits.maxThreads);
  const maxThreadsScan = boundedLimit(limits.maxThreadsScan);
  const maxPreviewLength = boundedLimit(limits.maxPreviewLength);
  const maxHrefsPerAnchor = boundedLimit(limits.maxHrefsPerAnchor);
  const normalizeText = (value: string, maximum: number): string => value.replace(/\s+/g, ' ').trim().slice(0, maximum);
  const baseHref = location.href.startsWith('http://') || location.href.startsWith('https://')
    ? location.href
    : 'https://www.facebook.com/';
  const pageOrigin = location.origin === 'null' ? new URL(baseHref).origin : location.origin;
  const body = document.body ?? document.documentElement;
  const pageText = (body.textContent ?? '').slice(0, 20_000);
  const url = location.href.slice(0, 2048);
  // These checks mirror readFacebookPage in src/facebook.ts; an in-page function cannot close over it.
  const signals: ExtractedMessengerSignals = {
    hasPasswordInput: document.querySelector('input[type="password"]') !== null,
    hasLoginForm: document.querySelector('form[action*="/login"], input[name="pass"]') !== null,
    hasCheckpointForm: document.querySelector('form[action*="checkpoint"], [data-testid*="checkpoint"]') !== null,
    hasCaptchaFrame: document.querySelector('iframe[src*="captcha" i], [id*="captcha" i], [data-testid*="captcha" i]') !== null,
    hasMainLandmark: document.querySelector('main, [role="main"]') !== null,
    hasAuthenticatedMarker: document.querySelector('a[href*="logout" i], [aria-label*="your account" i], [aria-label*="your profile" i]') !== null
      || Array.from(document.querySelectorAll('a')).some((anchor) => /^\s*log ?out\s*$/i.test(anchor.textContent ?? '')),
    hasLoginPrompt: Array.from(document.querySelectorAll('a, [role="link"], button, [role="button"]')).some((element) => {
      const label = element.getAttribute('aria-label') ?? element.textContent ?? '';
      return /^\s*log ?in( to facebook)?\s*$/i.test(label);
    }),
    mentionsCheckpoint: /security check|confirm your identity|unusual activity/i.test(pageText),
    mentionsCaptcha: /captcha|i'?m not a robot|verify you are a human/i.test(pageText)
  };
  const hasEmptyStateMarker = /no conversations|no messages yet|nothing here yet/i.test(pageText);
  const threadIds = new Set<string>();
  const threads: ExtractedInboxThread[] = [];
  const itemPattern = /^\/marketplace\/item\/(\d{5,20})(?=\/|$)/;
  const anchors = document.querySelectorAll('a[href]');
  const scanLength = Math.min(anchors.length, maxThreadsScan);
  for (let index = 0; index < scanLength && threads.length < maxThreads; index += 1) {
    const anchor = anchors[index];
    if (!anchor) continue;
    let threadUrl: URL;
    try {
      threadUrl = new URL(anchor.getAttribute('href') ?? '', baseHref);
    } catch {
      continue;
    }
    if (threadUrl.origin !== pageOrigin || !threadUrl.pathname.startsWith(threadPath)) continue;
    const threadId = threadUrl.pathname.slice(threadPath.length).split('/')[0] ?? '';
    if (threadId.length > 128 || !threadIdPattern.test(threadId) || threadIds.has(threadId)) continue;
    threadIds.add(threadId);
    const preview = normalizeText(anchor.textContent ?? '', maxPreviewLength);
    const thread: ExtractedInboxThread = { threadId, ...(preview ? { preview } : {}) };

    const hrefs: string[] = [];
    if (maxHrefsPerAnchor > 0 && anchor.matches('a[href]')) hrefs.push(anchor.getAttribute('href') ?? '');
    for (const nested of anchor.querySelectorAll('a[href]')) {
      if (hrefs.length >= maxHrefsPerAnchor) break;
      hrefs.push(nested.getAttribute('href') ?? '');
    }
    const itemIds = new Set<string>();
    for (const href of hrefs) {
      try {
        const itemUrl = new URL(href, baseHref);
        if (itemUrl.origin !== pageOrigin) continue;
        const itemId = itemUrl.pathname.match(itemPattern)?.[1];
        if (itemId) itemIds.add(itemId);
      } catch {
        // Ignore malformed links; item_id is optional and never inferred from text.
      }
    }
    if (itemIds.size === 1) thread.itemId = itemIds.values().next().value;
    threads.push(thread);
  }
  return { url, signals, hasEmptyStateMarker, threads };
}

export function extractMessengerThreadPage(options: ExtractMessengerThreadOptions): ExtractedThreadPage {
  const limits = options.limits;
  const boundedLimit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const maxMessages = boundedLimit(limits.maxMessages);
  const maxMessagesScan = boundedLimit(limits.maxMessagesScan);
  const maxTextLength = boundedLimit(limits.maxTextLength);
  const body = document.body ?? document.documentElement;
  const pageText = (body.textContent ?? '').slice(0, 20_000);
  const url = location.href.slice(0, 2048);
  // Keep the probe selectors in lockstep with readFacebookPage in src/facebook.ts.
  const signals: ExtractedMessengerSignals = {
    hasPasswordInput: document.querySelector('input[type="password"]') !== null,
    hasLoginForm: document.querySelector('form[action*="/login"], input[name="pass"]') !== null,
    hasCheckpointForm: document.querySelector('form[action*="checkpoint"], [data-testid*="checkpoint"]') !== null,
    hasCaptchaFrame: document.querySelector('iframe[src*="captcha" i], [id*="captcha" i], [data-testid*="captcha" i]') !== null,
    hasMainLandmark: document.querySelector('main, [role="main"]') !== null,
    hasAuthenticatedMarker: document.querySelector('a[href*="logout" i], [aria-label*="your account" i], [aria-label*="your profile" i]') !== null
      || Array.from(document.querySelectorAll('a')).some((anchor) => /^\s*log ?out\s*$/i.test(anchor.textContent ?? '')),
    hasLoginPrompt: Array.from(document.querySelectorAll('a, [role="link"], button, [role="button"]')).some((element) => {
      const label = element.getAttribute('aria-label') ?? element.textContent ?? '';
      return /^\s*log ?in( to facebook)?\s*$/i.test(label);
    }),
    mentionsCheckpoint: /security check|confirm your identity|unusual activity/i.test(pageText),
    mentionsCaptcha: /captcha|i'?m not a robot|verify you are a human/i.test(pageText)
  };
  const messages: ExtractedMessage[] = [];
  const rows = document.querySelectorAll('[role="row"]');
  const scanLength = Math.min(rows.length, maxMessagesScan);
  for (let index = 0; index < scanLength && messages.length < maxMessages; index += 1) {
    const row = rows[index];
    if (!row) continue;
    const label = row.getAttribute('aria-label') ?? '';
    let sender: 'you' | 'other' | undefined;
    let senderName: string | undefined;
    if (/^you (?:said|sent|replied)/i.test(label)) {
      sender = 'you';
    } else {
      const otherMatch = label.match(/^([^\r\n]{1,128}?) said:/i);
      if (otherMatch) {
        sender = 'other';
        senderName = otherMatch[1]?.trim() || undefined;
      }
    }
    // Attribution is required; unknown rows are not represented as messages.
    if (!sender) continue;
    const text = (row.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, maxTextLength);
    if (!text) continue;
    const message: ExtractedMessage = { sender, text, ...(senderName ? { senderName } : {}) };
    const rawDate = row.querySelector('time[datetime]')?.getAttribute('datetime')?.trim();
    if (rawDate) {
      let date: Date;
      if (/^\d{12,16}$/.test(rawDate)) date = new Date(Number(rawDate));
      else date = new Date(rawDate);
      const year = date.getUTCFullYear();
      if (Number.isFinite(date.getTime()) && year >= 2000 && year <= 2100) message.sentAt = date.toISOString();
    }
    messages.push(message);
  }
  return { url, signals, messages };
}
