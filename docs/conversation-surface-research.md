# Conversation surface research (#43 step 1)

Findings behind the read-only conversation capabilities (`messenger_threads_list`, `messenger_thread_read`). This document separates **verified** facts (public documentation, this repository's own behavior) from **assumed** contracts (written from research but not yet validated against the live Facebook surface), and states the validation plan. It complements `provider-action-boundaries.md`, which remains the normative enforcement contract.

## What Marketplace conversations are

Marketplace buyer↔seller chats are **Messenger conversations**, not a separate messaging system. Facebook's own help documentation states that Marketplace messages appear in the Marketplace **Inbox** (with *Buying* / *Selling* views, optionally grouped by listing) and that "you can also see your messages with buyers and sellers on Messenger" ([View your Facebook Marketplace messages](https://www.facebook.com/help/347147066002616)). There is one conversation store; the Marketplace inbox is a filtered view of it.

Consequences for session isolation:

- The conversation surfaces are served by `www.facebook.com` itself (`/marketplace/inbox/`, `/messages/t/...`); no separate `messenger.com` login is needed. A session authenticated on facebook.com can reach both.
- Isolation is nevertheless enforced at the **scope** level, not the cookie level: per `provider-action-boundaries.md`, the `messenger` surface gets its own session assessment, its own browser profile directory (`MESSENGER_PROFILE_DIR`, default `~/.marketplace/browser-profile-messenger`), and its own credential-login instance. A Marketplace session grants nothing on Messenger by declaration, and vice versa — even though both profiles would hold facebook.com cookies for the same identity.

## Access paths evaluated

| Path | Verdict | Basis |
|---|---|---|
| Graph API / Conversations API | **Not available** | The Messenger Platform Conversations API is business/Page-scoped: it requires `pages_messaging`, `pages_manage_metadata` etc. and addresses Page↔user (PSID) threads. There is no public API for personal Marketplace buyer↔seller chats. |
| `messenger.com` standalone | Rejected for now | Adds a second origin and login flow for no capability gain; the same threads are reachable on `www.facebook.com/messages`. Revisit only if the facebook.com surfaces prove unusable. |
| `www.facebook.com` browser session | **Selected** | Same approach as marketplace search/fetch: navigate a real persistent-profile session and extract from accessibility-contract signals. |

## Page structure (research findings)

- **Thread identification** happens on the Marketplace inbox page (`/marketplace/inbox/` — the *Buying* view is the buyer-side filter; the exact query parameter for the tab filter is **unverified**). Threads are links to Messenger threads; the anchor href shape `/{origin}/messages/t/{threadId}/` is the long-standing Messenger thread URL pattern (**assumed** — widely documented historically, not re-verified against the current site).
- **Message reading** happens on the thread page (`/messages/t/{threadId}/`). Message content is rendered in the modern www Messenger UI, which is heavily obfuscated and virtualized (**verified risk** — no public stable DOM map exists; community scrapers report frequent breakage).
- The inbox view may group or label threads by listing; whether item context is directly attached to thread anchors on the current site is **unverified**.

## The extraction contract and why it is shaped this way

Because the DOM contract cannot be validated from this repository (synthetic identities only; tests never touch real accounts), the extractors follow the strictest defensible rules:

1. **Accessibility-contract signals only** — anchors with `/messages/t/{id}` hrefs, `role="row"` message rows, `aria-label` orientation patterns (`You said: …` / `{Name} said: …`), `time[datetime]` timestamps. Never CSS classes, never obfuscated internals.
2. **Fail closed on the unknown** — an authenticated page that shows neither recognizable threads/messages nor a recognized empty state is a typed `UPSTREAM_ERROR` ("layout was not recognized"), never an empty success. A false "no conversations" is worse than an error.
3. **No fabricated fields** — participant names are *not* extracted by the Facebook backend this wave (attribution heuristics would be guesses); the fixture backend provides them synthetically. Message rows without a recognizable orientation marker are skipped, not attributed. Seller identity is established by following `item_id` through `marketplace_fetch`, and by Miso's own reasoning — Musebridge extracts, Miso interprets.
4. **Opaque thread ids** — `thread_id` is an opaque token matching `^[A-Za-z0-9][A-Za-z0-9._-]*$` parsed only from extracted hrefs. `messenger_thread_read` rebuilds the thread URL from the configured base origin; caller-supplied URLs are never navigated (same rule as `marketplace_fetch`).

## Verified vs assumed — validation plan

**Verified** (public documentation / this repo's tests):
- No public API for Marketplace buyer↔seller chats; Graph API is Page-scoped.
- Marketplace messages live in Messenger; the Marketplace Inbox offers Buying/Selling views.
- The session-isolation machinery: separate profile directories, per-surface probe classification, per-backend single-in-flight credential login — all covered by the test suite against synthetic servers.

**Assumed, pending operator validation against the live site** (one session, manual, read-only):
1. `/marketplace/inbox/` renders thread anchors with `/messages/t/{id}` hrefs when logged in.
2. Thread anchors expose usable preview text, and (sometimes) an attached `/marketplace/item/{id}` link.
3. Thread pages expose `role="row"` elements with the `You said:` / `{Name} said:` aria-label patterns.
4. The Buying/Selling tab filter (query parameter or click target) — currently the extractor reads whatever the inbox page renders, without selecting a tab.

**If validation fails:** the extractors fail closed with typed errors, so a wrong assumption degrades to a loud `UPSTREAM_ERROR`, not wrong data. Corrections then land as extractor/fixture updates with the same fail-closed discipline. Until validation passes, these tools should be treated as *contract-shaped but unproven against production* — suitable for Miso integration testing against the fixture backend.

## Untrusted content

Thread previews and message texts are seller-controlled content. They are returned verbatim (bounded) as tool output; Miso owns interpretation and must treat them as untrusted input — prompt-injection handling is a consumer-side responsibility for reads, and becomes a Musebridge-enforced concern at the send step (#43 step 3), where the approved payload digest binds exactly what will be sent.

## Deliberate gaps this wave

- **No interactive re-auth for the messenger scope.** The marketplace scope's loopback re-auth console owns its profile; wiring a second lease target is deferred to the send step, where the messenger surface first carries real write intent. Until then, a captcha/checkpoint on the messenger profile surfaces as `CAPTCHA_REQUIRED` / `SESSION_INVALID` and requires manual profile recovery.
- **No status surface for the messenger assessment.** There is no `messenger_status` tool; the messenger scope's session state is observable only through the conversation tools' typed failures (`LOGIN_REQUIRED`, `CAPTCHA_REQUIRED`, `SESSION_INVALID`, timeouts). A status tool can be added cheaply if operators need proactive visibility.
- **No Buying/Selling tab selection.** Threads are read from the inbox page as rendered.
- **No pagination/scrolling** — one page, bounded extraction, mirroring search.
