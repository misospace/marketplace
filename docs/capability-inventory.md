# Muse/Dots capability inventory (#39)

Parent: #38. Status: living decision record, not a build specification.

**Prominent evidence caveat:** The external product/announcement URLs in this record are future-dated (September–October 2026) relative to earlier research provenance; they describe marketed behavior or reported sources, not verified developer APIs for this operator's account. Treat every external capability as unverified until a scoped live proof exists. Product announcements establish marketing claims, not account entitlement or consumer API access.

**Research provenance:** Recovered from the September 29–30, 2026 Muse/Dots/OpenClaw comparison, October 1 architectural follow-up, repository implementation evidence, and an October 7, 2026 check of public announcements and documentation. Musebridge is neither a fork nor a clone of Meta Muse or OpenAI dots. It is a self-hosted MCP capability layer for provider actions that Miso/OpenClaw cannot otherwise perform cleanly.

## 1. Provenance and scope

This document preserves the broad capability research and its reasoning. It distinguishes four different claims: a product markets an action, a connector name is listed, a developer API exists, and this operator's consumer account can safely perform the action. Those claims are not interchangeable. References and evidence labels appear in the [source registry](#12-source-registry).

The companion records remain authoritative for their own scope: [provider-action-boundaries.md](provider-action-boundaries.md) for action risk classes and approval enforcement; [conversation-surface-research.md](conversation-surface-research.md) for the Messenger/Marketplace conversation surface and its live-DOM validation status; and [shopping-provider-research.md](shopping-provider-research.md) for the shopping vertical. This inventory does not replace their enforcement detail or implementation-specific findings.

## 2. Evidence legend

- **A / primary** = documented directly by Meta, OpenAI, or the relevant vendor. A product announcement confirms a marketed capability, **not** a public consumer API nor that we reproduced it.
- **B / externally reported** = reputable report, third-party partner statement, or a cited connector directory. Verify actual action-level access and rollout.
- **C / inferred or desired** = plausible reverse-engineering target, but *not demonstrated*. Needs research/prototype before implementation promise.
- **D / local verified** = personally exercised Musebridge/OpenClaw capability. Do not confuse green synthetic tests with a live provider test.

A/B/C/D tags attach to claims, not just whole sections. A connector name or marketing claim never establishes a specific consumer read/write capability.

## 3. Essential conclusion and architecture boundary

**What is worth reproducing is the consumer capability surface, not the agent framework.** Muse and dots bundle ongoing goals, contextual memory, independent computer/browser, connectors, persistent sessions, scheduling, smart delegation, action permissions, audit/history, and chat/voice/mobile interfaces (**A: [M1], [D1]–[D3]**). Miso + OpenClaw already cover substantial orchestration. The clearest gap was reliable, typed access to closed consumer account features such as Facebook Marketplace and personal messages (**D: local Marketplace search/fetch; C: other private account actions**).

| Responsibility | Owner | Why |
| --- | --- | --- |
| Searching/fetching/normalizing provider data | **Musebridge** | Stable, narrow typed MCP primitives; testable outside the LLM |
| Account session/login health, safe navigation, provider errors | **Musebridge provider service** | Provider-specific lifetime and blast radius |
| Message send / listing write / transaction prepare | **Musebridge**, subject to external authorization | Narrow side-effect capability, auditable parameters |
| Goals, reasoning, drafting, bargaining strategy, prioritization | **Miso / OpenClaw** | Avoid building a second agent |
| Watches, cron, state/dedupe, notifications, conversation continuity | **Miso / OpenClaw** | Already exists; keep a single owner |
| User approvals, delegation limits, risk policy | **OpenClaw / user authority**, enforced at action boundary | Provider text must not grant its own permission |
| Existing well-supported app integration | **Existing connector / API / Composio**, if suitable | Don't reverse-engineer functioning supported APIs |
| Browser/computer generic automation | **Existing OpenClaw tooling** | Don't turn each provider service into a desktop agent |

Preserve the live Marketplace connector, then prove another valuable consumer capability. Avoid both Marketplace-only scope and an abstract framework before a second provider exists.

## 4. Recovered Muse capability inventory

### A. Facebook Marketplace and consumer commerce

**A:** Meta markets Muse watching Marketplace, alerting on matches, making offers and negotiating, listing/selling items, product research, price watching, browser-assisted shopping, purchases, returns/refunds, merchant support, and ticket/flight price monitoring ([M1], [M2]). These are marketed product actions, not proven APIs for this operator.

Candidate actions, each **C** until scoped access is demonstrated: search listings by terms/location/price/category/radius; fetch one item and inspect seller/images/status; detect new listings, price changes, disappearance, or seller replies (orchestrated by Miso); read seller conversations and correlate listing/thread; prepare and send inquiry/offer text with retry safety; negotiate within explicit bounds; inspect/create/edit/take down own listings; compare retailer stock and landed prices; and read order/return state or prepare support communications. Checkout and return submission require separate authorization.

**D:** Marketplace search and fetch through a persistent Playwright browser, authenticated Facebook session, and ToolHive virtual MCP were exercised in production as of October 7. `marketplace_fetch` had a successful live call after #34 merged. The connector has caller-URL canonicalization, typed session/captcha/checkpoint errors, bounded fields, and conservative currency handling. This does not establish messaging, listing creation, or negotiation.

**D:** Miso owns AI-hardware and solar-panel Marketplace watches and per-watch 60-day ID dedupe. Improve relevance by rejecting wanted ads/placeholder prices/irrelevant bundles, handling fuzzy geography, and fetching promising results before alerts; do not move watch logic into Musebridge. Related work: #42 listing fidelity, #43 seller conversations, #44 negotiated offers, #48 multi-source shopping, #49 purchases.

### B. Meta account graph, social, and personal messaging

**A:** Meta references Facebook, Instagram, Threads, Messenger, and WhatsApp across Muse/Meta AI material; it describes a Muse control experience via WhatsApp, saved-Reel-to-grocery context, and business-account/analytics support ([M1], [M3], [M4]). These statements do not prove autonomous access to private consumer DMs. **B/C:** Third-party inventories list connector surfaces, but action scope and account access remain unverified ([C1]–[C3]).

Candidate capabilities (**C** unless otherwise proven):
- Facebook outside Marketplace: profile/pages, relevant feed/posts, notifications, comments, saved items; posting only after scope investigation.
- Messenger: list/search threads, read recent/unread messages and attachments, identify participants, draft and send approved replies, and retrieve seller context. Ordinary chats and Marketplace threads are distinct validation questions.
- Instagram: saved items, creator/account/post data, DMs/requests, replies, comments, sharing, and publishing. Separate consumer access from supported business/professional Graph API permissions; the saved-recipes story is **A as a marketed Muse example** ([M1]).
- Threads: read feed/posts/replies/mentions and publish/respond only where supported. Research auth separately from Instagram.
- WhatsApp: personal-account history, sending, media, and linked-device behavior are **C**. Business messaging APIs do not prove private-history access. Muse's WhatsApp control channel is distinct from an external connector.
- Android SMS: **B/C** in connector inventories; a local device bridge may be more appropriate than server browser emulation.

Risks include private messages, contact identity, cross-account leakage, E2EE limits, unsupported paths, anti-automation restrictions, and duplicate outbound sends (**C risk assessment**). Incoming messages are untrusted data and cannot change Miso permissions. Related work: #43, #45, #46, #47, #51.

### C. Email, productivity, files, and local computer

**A:** Meta markets email/calendar/docs and productivity integrations ([M1], [M3], [M4]). Its Small Business announcement names Asana, Box, Canva, Dropbox, Figma, Granola, HighLevel, QuickBooks, Klaviyo, Lovable, Notion, Shopify, Slack, Stripe, Zoom, and Facebook/Instagram business accounts ([M3]); other rollout claims include GitHub, Box, Notion, and Granola ([M4]). **B/C:** Third-party inventories list more granular Google/Microsoft products and actions ([C1]); action coverage must be checked.

The recovered candidate list includes Gmail, Outlook Mail/Calendar/Contacts, Google Calendar, Drive, Docs, Sheets, Slides, Forms, Tasks/Contacts, Notes, Slack, Asana, Box, Dropbox, Notion, Granola, Figma, Canva, Zoom, QuickBooks, Klaviyo, HighLevel, Lovable, and GitHub (**A for specifically announced names, B/C for the remainder and individual actions**). Possible actions include inbox search/summarize, draft/approved send, event read/create, contact lookup, document search/edit, notes/meeting context, local file discovery, application automation, reporting, and handoff (**C unless scoped and verified**).

**Recommendation:** usually compose existing OpenClaw, Gmail/Calendar/Drive/Slack/GitHub, MCP, or Composio integrations rather than add a duplicate Musebridge wrapper (**D: existing stack assessment**). Muse for Mac's permissioned local files, tabs, Messages, Mail, Calendar, Notes, and computer interaction are **A marketed features** ([M2], [M4]), but belong to local client/computer-use architecture, not the Facebook provider service.

### D. Finance, buying, travel, reservations, and entertainment

**A:** Meta describes Link/Stripe one-time-use card and eligible purchase protections, approval requirements, travel/negotiation and browser-based merchant actions ([M1], [M2]). Announced retail/payment expansion includes Walmart, Best Buy, American Eagle, DICK'S Sporting Goods, Fanatics, Gap, Michael Kors, Sephora, Ulta, Wayfair, PayPal/Shop Pay, Expedia (coming), and Instacart ([M4]); announcement, participation, rollout, and end-to-end checkout are distinct. **A:** Shopify documents eligible Meta/Muse storefront checkout and Shop Pay when available ([V1]).

The recovered candidate names include Plaid (connected financial data, not transfer permission), Stripe Link, Shopify catalog/Shop Pay, OpenTable, Ticketmaster, Duffel flights, and Spotify (**A/B/C varies by claim; no consumer API is inferred from a name**). Keep `product_search`/`product_fetch`/`compare_prices` separate from cart/checkout/order; availability/search separate from reservation/booking; order status/return eligibility separate from submission; and financial reads separate from account/payment changes (**C design recommendation**).

Prioritize cross-site shopping read (#48), investigate supported booking APIs/connectors (#50), and defer payments, deposits, and binding bookings behind distinct authorization work (#49). No implicit purchase from a watch.

### E. Health, fitness, home/device, and vehicles

**B/C:** Original research identified Apple Health, Function Health, HealthEx, Withings, Peloton, Philips Hue, Tessie, Tailscale, and phone/device access in vendor/community inventories ([C1]–[C3]); these lists do not guarantee actions, markets, or entitlements. **A:** Meta's pitch references training plans and health/fitness goals ([M1]). Possible reads include measurements, activity, sleep, workouts, lab records, vehicle telemetry, connected-home state, and devices; writes might include bookings, device control, vehicle climate, or configuration (**C**). Sensitivity varies substantially.

Prefer existing Health/Home Assistant/vehicle API/MCP integrations over reverse-engineered consumer sites (**D: local integration assessment**). Keep financial and health records in separate consent/security domains. Do not infer that Tessie/Tesla supports a Mustang Mach-E; scope any work to the actual vehicle and existing Home Assistant telemetry.

### F. Muse general agent/platform features (reference architecture, not Musebridge scope)

**A:** Meta describes a dedicated Muse Secure VM, persistent computer/browser, multi-step background work, forms/service calls, goals, plans, reminders, monitoring, memory, connectors/custom tools, messaging/voice/mobile continuity, protected credentials, Sentinel approvals/audit/revocation, and local Mac interaction ([M1], [M4]). Subagent topology/limits and rollout specifics need verification (**B/C** where not established by current public documentation). Confidential VM was discussed as a future enhancement, not an assumed launch capability ([M1]).

The lesson is to copy the division of trust, not the runtime. Miso already has an agent runtime and the homelab already has browser/Kubernetes infrastructure (**D: local architecture assessment**).

## 5. Dots comparison

**A:** OpenAI announced dots on September 29, 2026 ([D1]). It is a second design reference, not evidence of Meta-account access or parity.

| Dots feature | Evidence and boundary | Musebridge/OpenClaw implication |
| --- | --- | --- |
| Always-on goals and concurrent projects | **A:** cloud computer/browser and continuing work ([D1]) | OpenClaw agent/task/cron orchestration, not provider MCP |
| Connection to 4,000+ apps | **A:** marketing claim, not 4,000 validated action implementations ([D1]) | Compose existing ecosystem; bridge actual gaps |
| ChatGPT, Slack, Teams, voice; continuity | **A**, rollout varies ([D1]) | OpenClaw channels/Miso; do not reimplement |
| Proactive background research | **A:** connected-data reads; no sending/mutation/browser driving under this privilege ([D1], [D3]) | Separate autonomous reads from governed actions |
| Preferences, memories, feedback | **A** ([D1]) | OpenClaw/Miso and memory store |
| Custom Rules and action auto-review | **A**, subject to built-in safeguards ([D1], [D2]) | Explicit typed permissions and approval enforcement |
| Activity View and agent computer | **A** ([D1]) | Mission Control/OpenClaw activity and traceability |
| Protected passwords | **A** for supported login paths ([D2], [D3]) | SecretRefs/credential injection outside model context |
| Local computer/browser | **A**, explicit permission required ([D2]) | Existing OpenClaw computer/browser path |
| App/tool permissions and sensitive actions | **A**; changing passwords remains human-only and approvals may apply ([D2], [D3]) | External writes/purchases need enforceable controls |

Availability/plugins depend on plan, region, and rollout ([D1]–[D3]). Synthesis: Muse demonstrates the value of broad consumer reach; dots emphasizes approvals, read-only proactivity, protected login, and ongoing work (**A**). Musebridge addresses provider gaps and leaves orchestration with Miso.

## 6. Miso / OpenClaw capability-gap assessment

**D:** The assessed stack has typed plugins, MCP routing, ToolHive aggregation, browser backend, cron, approvals, model/tool routing, and SecretRefs/egress injection possibilities. Miso is live and schedules recurring work; the user's setup has services including GitHub/Home Assistant/Grafana/search and Composio as an option.

| Needed property | Existing reality | Gap / owner |
| --- | --- | --- |
| Agent reasoning, coordination, subagents | **D:** Miso/OpenClaw and coding agents | Do not implement in Musebridge |
| Persistent goals, follow-up, reminders | **D:** OpenClaw cron/workflows/Mission Control | Improve in OpenClaw if needed |
| Marketplace item access | **D:** `marketplace_search` and `marketplace_fetch` live via ToolHive | Reliability only on evidence (#42) |
| Offer and seller-message reads/writes | **D:** not implemented in Musebridge | Provider gap (#43) |
| Generic personal Messenger | **D:** no established capability | Feasibility (#45) |
| Multiple product sources | **D:** no unified typed read layer | eBay shopping shipped via #48; see shopping record |
| Supported app connectors | **D:** OpenClaw plugins/Composio/MCP partially cover | Compose before building |
| Events/webhooks/inbound changes | **D:** provider-dependent, no generic contract | Likely orchestration/tooling, not automatically a bridge scheduler |
| Cursor/pagination/change tokens/idempotency | **D:** ad hoc; Marketplace watch IDs in Miso | Define per provider as evidence demands |
| Connector-scoped secrets/revocation | **D:** 1Password/ExternalSecret available; provider implementation varies | Isolate providers; no secrets to model (#41) |
| Per-tool/account read/write authority | **D:** partial approvals, no clear universal policy | Cross-cutting boundary (#41 + OpenClaw authority) |
| Multi-step apps/browser | **D:** browser exists; Facebook login requires guarded session | Provider service only for stable primitives |
| Audit/activity | **D:** OpenClaw/Mission Control base | Record write intent/outcome, not sensitive content |
| Proactive observation | **D:** cron/watches run | Enforce read-only scope at tool boundary |

The current boundary is Miso-owned watch scheduling/dedupe/alerts → ToolHive → Musebridge Marketplace `marketplace_search` and `marketplace_fetch` → persistent Playwright and guarded Facebook session (**D**). Keep provider services independently deployable when session, permissions, or failures differ. Keep ToolHive identities and deployment aliases compatible during migration (#40). Packages stay empty until a second service demonstrates shared needs (**D: architecture decision**).

## 7. Integration route decision tree

For each target, choose before reverse engineering:
1. **Already available in OpenClaw/native tool/MCP?** Use it after checking actual actions, scopes, and approvals.
2. **Provider-supported API/OAuth or quality self-hosted connector?** Prefer it with tested scopes and maintenance.
3. **Composio/hosted connector?** Consider for replaceable low/moderate-sensitivity apps only when credential custody, telemetry, cost, network path, and permissions are acceptable. It is not proof of personal Marketplace/Messenger access.
4. **Musebridge browser-backed provider?** Only for a missing consumer surface with repeatable session/login, structured extraction, stable data contract, and classified failures.
5. **Generic browser/computer workaround?** Last resort for one-off interactions, not justification for a brittle autonomous write tool.
6. **No reliable/permitted route?** Record research/blocked; do not invent APIs, evade provider controls, or promise support.

**D:** Proving Facebook session/search/fetch does not prove other Meta apps share navigation or permissions.

## 8. Ranked feature matrix

Planning hypothesis, not an implementation claim. **R** = read; **W** = external write; **X** = sensitive/transactional; **D** = locally proven. **A/B/C/D** are evidence levels above. **P0–P3** are priority (maintain, near-term, research next, long-tail); owners are issue links.

| Capability / user-visible job | Product evidence | Likely access path | Actions | Priority / owner |
| --- | --- | --- | --- | --- |
| Marketplace search/fetch for GPUs, solar, used hardware | A [M2]; D locally | Existing Facebook Playwright session | R/D | **P0** [#42](https://github.com/misospace/musebridge/issues/42) |
| Seller thread read + approved inquiry | A Muse offers [M2]; D not implemented | Marketplace/Messenger session; feasibility needed | R/W | **P1** [#43](https://github.com/misospace/musebridge/issues/43) |
| Bounded Miso price negotiation | A product claim [M2]; C locally desired | Miso policy over narrow message/send tools | W/X | **P1/P2** [#44](https://github.com/misospace/musebridge/issues/44) |
| Ordinary Messenger personal chats | B connector roster; A Meta ecosystem [M1], C access | Research supported/private-account vs browser | R/W | **P1/P2** [#45](https://github.com/misospace/musebridge/issues/45) |
| Independent online product/stock comparisons | A [M2], [M4]; D eBay provider shipped via #48 | Official retailer APIs, existing plugins, then browser | R/D | **P1** [#48](https://github.com/misospace/musebridge/issues/48) |
| Instagram saved Reels/posts | A contextual Muse example [M1]; C account access | Consumer vs professional API/browser | R | **P2** [#46](https://github.com/misospace/musebridge/issues/46) |
| Instagram DMs | B/C access extent unverified | Provider/account research | R/W | **P2** [#46](https://github.com/misospace/musebridge/issues/46) |
| Threads feed/replies/posts | A Meta ecosystem; B/C exact Muse actions | Official API where supported | R/W | **P2** [#46](https://github.com/misospace/musebridge/issues/46) |
| WhatsApp personal conversations | A Muse control channel; C personal history | Research consumer/device vs Business API | R/W | **P2** [#47](https://github.com/misospace/musebridge/issues/47) |
| Own Marketplace listing creation/edit | A [M2]; C local feasibility | Browser-backed seller surface | W/X | **P2** [#43](https://github.com/misospace/musebridge/issues/43) or split |
| Product carts/checkout/refund requests | A [M1], [M2]; Shopify [V1] | Official checkout or supervised browser | R/W/X | **P3** [#49](https://github.com/misospace/musebridge/issues/49) |
| Restaurant/table reservations | A booking class [M1]; B OpenTable | Existing booking provider/connector | R/W/X | **P3** [#50](https://github.com/misospace/musebridge/issues/50) |
| Event tickets/travel booking | A generic booking [M1]; B vendors | Supported APIs first | R/W/X | **P3** [#50](https://github.com/misospace/musebridge/issues/50) |
| Gmail, Outlook, calendars, contacts, docs | A [M1], [M3]; B/C specific actions | Existing OpenClaw/plugins/MCP | R/W | **Integrate** [#51](https://github.com/misospace/musebridge/issues/51) |
| Slack/Teams/GitHub/Notion/Box/etc. | A [M3], [M4], [D1]; B/C action coverage | Existing plugins/APIs | R/W | **Integrate** [#51](https://github.com/misospace/musebridge/issues/51) |
| Financial/Plaid insights | B connector roster; A Muse finance goals | Existing trusted financial connector if needed | sensitive R/X | **Research only** [#51](https://github.com/misospace/musebridge/issues/51) |
| Health labs/sleep/workouts/Apple Health | B roster; A Muse health goals | Existing Health/HA/provider integrations | sensitive R/W | **Research only** [#51](https://github.com/misospace/musebridge/issues/51) |
| Spotify/media, smart home, car controls | B connector roster | Existing native device/media APIs | R/W | **Integrate** [#51](https://github.com/misospace/musebridge/issues/51) |
| Mac files, Messages, local app interactions | A [M2], [M4] | OpenClaw/local tools, not Facebook MCP | R/W/X | **Outside bridge** [#51](https://github.com/misospace/musebridge/issues/51) |
| Multi-project memory, proactivity, schedules, voice | A Muse/Dots [M1], [D1] | OpenClaw/Miso | coordination | **Outside bridge** |

**Decision now:** Track 1, investigate seller conversation reads (#43) and ordinary Messenger feasibility (#45), starting read-only and then approved sends. Track 2, deliver a non-Facebook shopping read provider (#48). Track 3, evidence-based Instagram/Threads/WhatsApp assessment (#39/#46/#47). Prerequisites: #41 scoped write permissions and #40 compatibility/module layout.

## 9. Risk policy and action classes

Muse Sentinel and dots read-only research/approval rules are architectural inspiration, not a reason to trust model compliance alone (**A: [M1], [D1], [D2]**). For enforceable action classes, approval behavior, session scopes, and limits, [provider-action-boundaries.md](provider-action-boundaries.md) is authoritative.

- **READ:** inspect listings, threads, items, orders. May run unattended only with authorized account access; respect rate limits, privacy, minimization, audit, and revocation.
- **PREPARE:** draft a reply/listing or collect shopping options/build a cart without external effect. A draft is not authorization to send.
- **EXTERNAL WRITE:** message, post, edit a listing, send email, or update an account. Requires bounded scope and enforceable authorization.
- **HIGH CONSEQUENCE:** accept offers, book, share address/contact information, purchase/pay, initiate refund/dispute, move money, or modify account security. Require approval for the concrete action and current terms. Negotiation is not blanket authority to commit or pay.

For message sends, bind authorization to exact account/thread/listing/action, recipient and rate bounds, and idempotency. Distinguish requested, submitted, confirmed, and unknown outcomes. A timeout may mean a send completed; do not blindly retry. Seller/merchant/page text is untrusted input, never instructions.

For consumer scraping, canonicalize IDs and allowed origins before navigation; avoid SSRF/open redirects; do not log credentials, cookies, raw messages, health records, or payment details. Use secret/environment reference names only. Separate browser profiles by provider/account unless reviewed. CAPTCHA, checkpoint, 2FA, and reauth are user-driven, never bypassed. Evaluate provider terms and access constraints; prefer supported APIs.

## 10. Specific validation questions

Unresolved questions, not a promise to build every feature:

**Meta/Messenger**
- Can this authenticated Facebook consumer account read a Marketplace seller conversation and an ordinary Messenger thread? Same UI/profile? Are IDs stable?
- Can a dry-run send distinguish confirmed delivery from unknown timeout/restart? Is there a message ID/ack?
- Are seller reply notifications/cursors durable, or must Miso poll? What is the lowest safe rate?
- What is the least invasive privacy-preserving way to inspect message page structure?

**Instagram/Threads/WhatsApp**
- Are saved items/private DMs available through supported consumer OAuth, or only guarded browser/device flows? Does a professional API cover this use case?
- Is WhatsApp merely Muse's chat control surface, or does any connector permit third-party personal history? What E2EE/device limits apply?
- Which Threads read/compose/reply permissions are available to this account?

**Shopping**
- Can a non-Facebook source provide canonical products, variants, inventory, shipping, taxes, and CAD? How often are browser agents blocked?
- Is there a stable price-history route, or should Miso own observed snapshots?
- Which provider supports returns/refunds versus recommendations only?

**Foundations**
- How does stable MCP service identity survive moving root into `services/marketplace`? Preserve deployment names and GHCR consumers through deliberate cutover.
- Which browser/session/cancellation helpers need sharing after a second provider exists?
- What is the smallest enforceable operation authorization (service policy plus Miso approval) for a seller message?

Each matrix row needs first-party vendor/API evidence where available, a scoped live proof without sensitive logs, and a stop/go decision. Synthetic fixtures alone do not prove a consumer connector is live-capable.

## 11. Initial recommendation / sequencing

**Already achieved (D; do not redo):** Marketplace auth/session, `marketplace_search`, `marketplace_fetch`, ToolHive integration, and first successful live fetch (#34). **Already achieved (D):** the eBay shopping provider shipped via #48; its separate access/validation details remain in [shopping-provider-research.md](shopping-provider-research.md).

Next: complete repo branding/structural compatibility (#40) and #41 policy outline while keeping tools/consumers stable. Scope seller conversation reads (#43) and ordinary Messenger feasibility (#45) independently. Continue with one useful non-Facebook shopping source (#48, achieved through eBay) and investigate #46/#47 only against evidence; record unsupported consumer access as blocked. Defer seller-side listings, checkout, tickets/reservations, refunds, finance/health/media unless existing connector coverage is demonstrably insufficient.

Prioritize by user benefit × feasible stable access × marginal value over existing OpenClaw/Composio coverage, divided by auth/maintenance/security cost. Do not optimize for checklist parity.

## 12. Source registry

Numbered sources are dated, attributable, and deliberately non-exhaustive.

**Primary: Meta**
- **[M1]** [Meta, *Introducing Muse*, Sep 8 (updated Sep 30), 2026](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/): Secure VM, Sentinel, credentials, approvals, browser work, WhatsApp entry, tools, memories, commerce, Link checkout, protected transactions. Product statement, not developer API documentation.
- **[M2]** [Meta, *Muse Shopping*](https://ai.meta.com/muse/shopping/): Marketplace watch/offers/negotiation/list/sell, compare products, track prices, returns/refunds, supervised checkout; Muse for Mac notes.
- **[M3]** [Meta, *Muse for Small Business*, Sep 29, 2026](https://about.fb.com/news/2026/09/introducing-muse-small-business/): Asana, Box, Canva, Dropbox, Figma, Granola, HighLevel, QuickBooks, Klaviyo, Lovable, Notion, Shopify, Slack, Stripe, Zoom; Facebook/Instagram business analytics; custom connectors and approvals.
- **[M4]** [Meta, *Connect 2026 recap*, Sep 24, 2026](https://about.fb.com/news/2026/09/the-biggest-news-from-connect-2026/): retailer catalogs/payments, travel/grocery/work connectors, Mac agent, glasses/voice/email roadmap. Rollout-dependent.
- **[M5]** [Meta, *Muse product overview*](https://ai.meta.com/muse/): goals, reminders, controls, long-running browsing, connected apps and self-generated tools.
- **[M6]** [Meta, *Facebook Marketplace AI seller tools*, Mar 12, 2026](https://about.fb.com/news/2026/03/facebook-marketplace-new-meta-ai-tools-make-selling-faster-and-easier/): seller-focused generation/response tooling; Marketplace features, not automatically Musebridge APIs.

**Primary: OpenAI dots**
- **[D1]** [OpenAI, *Introducing dots*, Sep 29, 2026](https://openai.com/index/introducing-dots/): 4,000+ plugins claim, isolated cloud computer, ongoing work, multi-channel reach, proactive reads, Custom Rules, auto-review, activity.
- **[D2]** [OpenAI Help, *Getting started with your dot*](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot): app permissions, schedules/proactivity, cloud/local computer, Custom Rules, availability/rollout.
- **[D3]** [OpenAI Help, *Dots privacy, security and safety FAQs*](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs): read-only proactivity, approvals, security checks, browser/password handling and limits; details may change.

**Vendor / third-party / corroborative**
- **[V1]** [Shopify Help, *Selling on Meta*](https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts/meta): eligible Meta/Muse storefront checkout, Catalog, and Shop Pay caveats.
- **[C1]** [Apps for Muse](https://appsformuse.com/): independent connector inventory with confirmed/reported annotations and citations; not authoritative for an individual's account.
- **[C2]** [Community connector directory](https://github.com/Anil-matcha/awesome-muse-connectors/blob/main/connectors/README.md): partner/feature leads including Apple Health/Android SMS; verify cited Meta/vendor sources before assigning primary evidence to a scope.
- **[C3]** [Additional independently maintained Muse connector inventory](https://www.sprites.ai/muse/connectors): candidate health, hardware, entertainment, and finance connectors; leads only, not proof of exposed APIs.

**Maintenance rule:** Current in-product connector picker, supported OAuth scopes, current docs, and actual user/account tests beat third-party lists. Update evidence level and checked date when something changes. Never convert a connector name into an unverified ability to read, send, buy, or control.

## 13. Definition of done

- [x] Recover the important original Muse/Dots/OpenClaw inventory and architecture judgments.
- [x] Add primary links for marketed behavior and clearly label reported/unverified integrations.
- [x] Distinguish Miso orchestration from Musebridge provider capabilities.
- [x] Capture the verified Marketplace baseline and meaningful capability gaps.
- [x] Link actionable umbrellas #40–#51 and propose priority order.
- [ ] Validate real action-level consumer Messenger/Instagram/WhatsApp support and document limitations.
- [ ] Choose/prove one non-Marketplace consumer/provider integration.
- [ ] Periodically revisit newly announced connectors and provider auth feasibility.

This issue remains a living inventory/decision record, not a perpetual blocker or permission to automate external account writes.
