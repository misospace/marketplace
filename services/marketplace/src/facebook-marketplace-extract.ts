export const MARKETPLACE_EXTRACT_LIMITS = {
  maxCards: 60,
  maxCardTextLength: 600,
  maxImages: 8,
  maxHrefs: 12,
  maxAriaLabels: 8,
  maxAncestorLevels: 8
} as const;

export interface ExtractedListingCard {
  itemHref: string;
  hrefs: string[];
  text: string;
  ariaLabels: string[];
  imageUrls: string[];
  headingText: string | null;
  timeDateTime: string | null;
  timeText: string | null;
  profileHref: string | null;
}

export interface ExtractedMarketplaceSignals {
  hasLoginForm: boolean;
  hasCheckpoint: boolean;
  hasCaptcha: boolean;
  hasRateLimitNotice: boolean;
  hasNoResultsNotice: boolean;
}

export interface ExtractedMarketplacePage {
  url: string;
  signals: ExtractedMarketplaceSignals;
  cards: ExtractedListingCard[];
}

export interface ExtractMarketplaceOptions {
  itemPath: string;
  limits: Omit<typeof MARKETPLACE_EXTRACT_LIMITS, 'maxCards'> & { maxCards: number };
}

export function extractMarketplacePage(options: ExtractMarketplaceOptions): ExtractedMarketplacePage {
  const itemPath = options.itemPath;
  const limits = options.limits;
  const boundedLimit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const maxCards = boundedLimit(limits.maxCards);
  const maxCardTextLength = boundedLimit(limits.maxCardTextLength);
  const maxImages = boundedLimit(limits.maxImages);
  const maxHrefs = boundedLimit(limits.maxHrefs);
  const maxAriaLabels = boundedLimit(limits.maxAriaLabels);
  const maxAncestorLevels = boundedLimit(limits.maxAncestorLevels);
  const boundedHref = (value: string): string => value.slice(0, 2048);
  const escapedItemPath = itemPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const itemIdPattern = new RegExp(`${escapedItemPath}(\\d{5,20})(?=\\/|$)`);
  const normalisedLines = (element: Element): string => {
    const innerText = (element as HTMLElement).innerText;
    const raw = typeof innerText === 'string' && innerText.length > 0 ? innerText : (element.textContent ?? '');
    return raw.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  };
  const itemIdFromHref = (href: string): string | null => {
    let pathname: string;
    try {
      const baseUrl = /^https?:\/\//i.test(location.href) ? location.href : 'https://www.facebook.com/';
      pathname = new URL(href, baseUrl).pathname;
    } catch {
      return null;
    }
    const match = pathname.match(itemIdPattern);
    return match?.[1] ?? null;
  };
  const itemIdCounts = new WeakMap<Element, number>();
  const distinctItemIds = (element: Element): number => {
    const cached = itemIdCounts.get(element);
    if (cached !== undefined) return cached;

    const ids = new Set<string>();
    if (element.matches('a[href]')) {
      const ownId = itemIdFromHref((element as HTMLAnchorElement).href);
      if (ownId) ids.add(ownId);
    }
    for (const anchor of element.querySelectorAll('a[href]')) {
      const id = itemIdFromHref((anchor as HTMLAnchorElement).href);
      if (id) ids.add(id);
    }
    itemIdCounts.set(element, ids.size);
    return ids.size;
  };

  // Card policy: take the highest bounded ancestor containing one distinct item id, then deduplicate roots in document order.
  const cardRoots: Element[] = [];
  const seenRoots = new Set<Element>();
  const anchors = document.querySelectorAll('a[href]');
  for (const anchor of anchors) {
    if (!itemIdFromHref((anchor as HTMLAnchorElement).href)) continue;
    let current: Element | null = anchor;
    let selected: Element = anchor;
    let belongsToKnownRoot = false;
    for (let level = 0; level < maxAncestorLevels && current; level += 1) {
      if (seenRoots.has(current)) {
        belongsToKnownRoot = true;
        break;
      }
      if (current.matches('main, body, html')) break;
      if (distinctItemIds(current) === 1) selected = current;
      current = current.parentElement;
    }
    if (belongsToKnownRoot || seenRoots.has(selected)) continue;
    seenRoots.add(selected);
    cardRoots.push(selected);
  }

  const cards: ExtractedListingCard[] = cardRoots.slice(0, maxCards).map((root) => {
    const anchors: HTMLAnchorElement[] = [];
    if (root.matches('a[href]')) anchors.push(root as HTMLAnchorElement);
    anchors.push(...Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[]);
    const itemAnchors = anchors.filter((anchor) => itemIdFromHref(anchor.href) !== null);
    let itemAnchor = itemAnchors[0];
    for (const anchor of itemAnchors.slice(1)) {
      if ((anchor.textContent ?? '').length > (itemAnchor?.textContent ?? '').length) itemAnchor = anchor;
    }

    const hrefs = maxHrefs > 0 ? anchors.slice(0, maxHrefs).map((anchor) => boundedHref(anchor.href)) : [];
    const text = normalisedLines(root).slice(0, maxCardTextLength);
    const ariaLabels: string[] = [];
    const seenLabels = new Set<string>();
    const ariaElements: Element[] = [root, ...root.querySelectorAll('[aria-label]')];
    for (const element of ariaElements) {
      const label = element.getAttribute('aria-label')?.trim();
      if (maxAriaLabels > 0 && label && !seenLabels.has(label)) {
        seenLabels.add(label);
        ariaLabels.push(label.slice(0, maxCardTextLength));
        if (ariaLabels.length >= maxAriaLabels) break;
      }
    }

    const imageUrls: string[] = [];
    const seenImages = new Set<string>();
    for (const image of root.querySelectorAll('img[src]')) {
      if (maxImages <= 0) break;
      const src = (image as HTMLImageElement).src;
      if (!src || src.toLowerCase().startsWith('data:') || seenImages.has(src)) continue;
      seenImages.add(src);
      imageUrls.push(boundedHref(src));
      if (imageUrls.length >= maxImages) break;
    }

    const heading = root.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
    const headingText = heading ? normalisedLines(heading).slice(0, maxCardTextLength) || null : null;
    const time = root.querySelector('time');
    const dateTime = time?.getAttribute('datetime')?.trim().slice(0, maxCardTextLength) ?? '';
    const timeTextValue = time ? normalisedLines(time).slice(0, maxCardTextLength) : '';
    let profileHref: string | null = null;
    for (const anchor of anchors) {
      try {
        if (anchor.pathname.includes('/marketplace/profile/') || anchor.pathname.includes('/profile.php')) {
          profileHref = boundedHref(anchor.href);
          break;
        }
      } catch {
        // Ignore malformed hrefs; the browser normally resolves anchor.href before it reaches this point.
      }
    }

    return {
      itemHref: boundedHref(itemAnchor?.href ?? ''),
      hrefs,
      text,
      ariaLabels,
      imageUrls,
      headingText,
      timeDateTime: dateTime || null,
      timeText: timeTextValue || null,
      profileHref
    };
  });

  const cardRootSet = new Set(cardRoots);
  // If the results grid is itself main/body/html, only that boundary can contain each item link, so card prose remains in signal text.
  const pageTextParts: string[] = [];
  const textWalker = document.createTreeWalker(document.body ?? document.documentElement, 4);
  let textNode: Node | null = textWalker.nextNode();
  while (textNode) {
    let ancestor = textNode.parentElement;
    let insideCard = false;
    while (ancestor) {
      if (cardRootSet.has(ancestor)) {
        insideCard = true;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (!insideCard && textNode.textContent) pageTextParts.push(textNode.textContent);
    textNode = textWalker.nextNode();
  }
  const bodyText = pageTextParts.join(' ').replace(/\s+/g, ' ').slice(0, 20000);
  // Auth/interstitial selectors intentionally mirror the session probe in src/facebook.ts; duplication is deliberate because an in-page function cannot reference module scope.
  const signals: ExtractedMarketplaceSignals = {
    hasLoginForm: document.querySelector('input[type="password"], form[action*="/login"], input[name="pass"]') !== null,
    hasCheckpoint: document.querySelector('form[action*="checkpoint"], [data-testid*="checkpoint"]') !== null
      || /security check|confirm your identity|unusual activity/i.test(bodyText),
    hasCaptcha: document.querySelector('iframe[src*="captcha" i], [id*="captcha" i], [data-testid*="captcha" i]') !== null
      || /captcha|i'?m not a robot|verify you are a human/i.test(bodyText),
    // Rate-limit detection is deliberately conservative and text-based.
    hasRateLimitNotice: /you'?re temporarily blocked|temporarily blocked|we limit how often|too many requests|try again later|please try again later/i.test(bodyText),
    hasNoResultsNotice: /no results|no listings|no items found|nothing found|try a different search|no marketplace listings/i.test(bodyText)
  };

  return { url: location.href.slice(0, 2048), signals, cards };
}

export const MARKETPLACE_ITEM_EXTRACT_LIMITS = {
  maxImages: 6,
  maxTextLength: 600,
  maxBodyTextLength: 20000
} as const;

export interface ExtractedMarketplaceItem {
  url: string;
  signals: ExtractedMarketplaceSignals;
  hasUnavailableNotice: boolean;
  title: string | null;
  priceText: string | null;
  locationText: string | null;
  descriptionText: string | null;
  stateText: string | null;
  bodyText: string;
  imageUrls: string[];
  sellerHref: string | null;
  sellerName: string | null;
  timeDateTime: string | null;
}

export interface ExtractMarketplaceItemOptions {
  limits: { maxImages: number; maxTextLength: number; maxBodyTextLength: number };
}

export function extractMarketplaceItem(options: ExtractMarketplaceItemOptions): ExtractedMarketplaceItem {
  const limits = options.limits;
  const boundedLimit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const maxImages = boundedLimit(limits.maxImages);
  const maxTextLength = boundedLimit(limits.maxTextLength);
  const maxBodyTextLength = boundedLimit(limits.maxBodyTextLength);
  const text = (element: Element | null, maximum = maxTextLength): string | null => {
    if (!element) return null;
    const innerText = (element as HTMLElement).innerText;
    const raw = typeof innerText === 'string' && innerText.length > 0 ? innerText : (element.textContent ?? '');
    const normalized = raw.replace(/\s+/g, ' ').trim().slice(0, maximum);
    return normalized || null;
  };
  const lastH1s = document.querySelectorAll('h1');
  const heading = lastH1s.length > 0 ? lastH1s[lastH1s.length - 1] ?? null : null;
  let priceElement = heading?.nextElementSibling ?? null;
  if (!priceElement) priceElement = document.querySelector('h1 + *');
  const title = text(heading);
  const priceText = text(priceElement);
  const bodyRoot = document.body ?? document.documentElement;
  const bodyInnerText = (bodyRoot as HTMLElement).innerText;
  const rawBodyText = typeof bodyInnerText === 'string' && bodyInnerText.length > 0 ? bodyInnerText : (bodyRoot.textContent ?? '');
  const bodyText = rawBodyText.replace(/\s+/g, ' ').trim().slice(0, maxBodyTextLength);
  const bodyLines = rawBodyText.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);

  let locationText: string | null = null;
  const locationPhrase = /location is approximate/ig;
  for (const span of document.querySelectorAll('span')) {
    if (!/location is approximate/i.test(span.textContent ?? '')) continue;
    let current: Element | null = span;
    for (let level = 0; level < 10 && current; level += 1) {
      const candidate = (current.textContent ?? '').replace(locationPhrase, '').replace(/·/g, ' ').replace(/\s+/g, ' ').trim();
      if (candidate) {
        locationText = candidate.slice(0, maxTextLength);
        break;
      }
      current = current.parentElement;
    }
    if (locationText) break;
  }
  if (!locationText) {
    const locationPattern = /^[A-Za-z .'-]+,\s*[A-Z]{2}$/;
    locationText = bodyLines.find((line) => locationPattern.test(line))?.slice(0, maxTextLength) ?? null;
  }

  let descriptionText: string | null = null;
  const conditionLabel = Array.from(document.querySelectorAll('span'))
    .find((span) => (span.textContent ?? '').trim() === 'Condition');
  if (conditionLabel) {
    const siblingTexts: string[] = [];
    let current: Element | null = conditionLabel;
    for (let level = 0; level < 16 && current && siblingTexts.length < 2; level += 1) {
      let sibling = current.nextElementSibling;
      while (sibling && siblingTexts.length < 2) {
        const siblingText = text(sibling);
        if (siblingText) siblingTexts.push(siblingText);
        sibling = sibling.nextElementSibling;
      }
      current = current.parentElement;
    }
    descriptionText = siblingTexts[1] ?? null;
    if (!descriptionText) {
      let ancestor: Element | null = conditionLabel;
      for (let level = 0; level < 16 && ancestor && !descriptionText; level += 1) {
        if (ancestor.tagName.toLowerCase() === 'ul' && ancestor.nextElementSibling) {
          descriptionText = text(ancestor.nextElementSibling);
        }
        ancestor = ancestor.parentElement;
      }
    }
  }

  const sellerAnchors = Array.from(document.querySelectorAll('a[href*="/marketplace/profile"]'));
  const fallbackSellerAnchors = sellerAnchors.length > 0 ? [] : Array.from(document.querySelectorAll('a[href*="/profile"]'));
  const seller = (sellerAnchors.length > 0 ? sellerAnchors : fallbackSellerAnchors).at(-1) ?? null;
  const sellerHref = seller?.getAttribute('href')?.slice(0, 2048) ?? null;
  const sellerName = text(seller);
  const imageRoot = document.querySelector('main') ?? document;
  const imageUrls: string[] = [];
  const seenImages = new Set<string>();
  for (const image of imageRoot.querySelectorAll('img[src]')) {
    if (maxImages <= 0) break;
    const src = (image as HTMLImageElement).src.trim();
    if (!src || /^data:/i.test(src) || seenImages.has(src)) continue;
    seenImages.add(src);
    imageUrls.push(src.slice(0, 2048));
    if (imageUrls.length >= maxImages) break;
  }
  const timeDateTime = document.querySelector('time[datetime]')?.getAttribute('datetime')?.trim().slice(0, maxTextLength) ?? null;
  const stateElement = heading?.parentElement ?? null;
  const stateInnerText = stateElement ? (stateElement as HTMLElement).innerText : null;
  const stateRawText = typeof stateInnerText === 'string' && stateInnerText.length > 0
    ? stateInnerText
    : (stateElement?.textContent ?? '');
  const stateText = stateRawText.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, maxTextLength) || null;
  // Keep these selectors aligned with the search/session probe; this page function cannot use module scope.
  const signals: ExtractedMarketplaceSignals = {
    hasLoginForm: document.querySelector('input[type="password"], form[action*="/login"], input[name="pass"]') !== null,
    hasCheckpoint: document.querySelector('form[action*="checkpoint"], [data-testid*="checkpoint"]') !== null
      || /security check|confirm your identity|unusual activity/i.test(bodyText),
    hasCaptcha: document.querySelector('iframe[src*="captcha" i], [id*="captcha" i], [data-testid*="captcha" i]') !== null
      || /captcha|i'?m not a robot|verify you are a human/i.test(bodyText),
    // Rate-limit detection is deliberately conservative and text-based.
    hasRateLimitNotice: /you'?re temporarily blocked|temporarily blocked|we limit how often|too many requests|try again later|please try again later/i.test(bodyText),
    hasNoResultsNotice: /no results|no listings|no items found|nothing found|try a different search|no marketplace listings/i.test(bodyText)
  };

  return {
    url: location.href.slice(0, 2048),
    signals,
    hasUnavailableNotice: /no longer available|isn't available|is not available|content not found|listing was removed|listing (?:has )?expired/i.test(bodyText),
    title,
    priceText,
    locationText,
    descriptionText,
    stateText,
    bodyText,
    imageUrls,
    sellerHref,
    sellerName,
    timeDateTime
  };
}
