# Messenger consumer conversations: read, draft, send (#45)

Parent: #38 (Musebridge capability map). Related: #43 (Marketplace seller conversations), #44 (delegated negotiation), #62 (`messenger_prepare` draft), #63 (`messenger_send`). Status: research complete — this document settles the access-path design and the operator risk decision for ordinary consumer Messenger; it builds nothing. It complements `provider-action-boundaries.md` (normative enforcement of risk classes and grants) and `conversation-surface-research.md` (authoritative for the Marketplace conversation surface's live-DOM validation).

## 1. Scope and relationship to #43 / what exists

Ordinary consumer Messenger (`www.facebook.com/messages/`) and Marketplace seller threads (`/marketplace/inbox/`) are **one conversation store with two inbox views** — not two messaging systems (`conversation-surface-research.md`). #43 scoped and built the Marketplace view. #45 explicitly says "Do not assume Marketplace seller threads cover ordinary Messenger usage," so the ordinary view is a separate access question even though both render on `www.facebook.com`.

What already exists (all `read`, scope `(facebook, default, messenger)`):

- `messenger_threads_list` reads the Marketplace inbox page (`MESSENGER_INBOX_PATH = '/marketplace/inbox/'`; the backend's `inboxPath` is configurable but the service wiring uses the Marketplace default).
- `messenger_thread_read` reads a thread at `/messages/t/{id}/`, rebuilding the URL from the configured origin with a redirect guard.
- Accessibility-contract extraction, fail-closed typed `UPSTREAM_ERROR`, per-surface browser profile (`MESSENGER_PROFILE_DIR`, default `~/.marketplace/browser-profile-messenger`, distinct from the marketplace profile), opt-in `MARKETPLACE_MESSENGER=1`, and a session probe at `/messages/`.

**Plainly: ordinary-Messenger inbox reads are NOT built.** The existing tools target the Marketplace inbox; nothing navigates the ordinary `/messages/` inbox or lists ordinary chats. This document settles the design and the operator risk decision for that extension.

The relationship to #43 is therefore one of **shared mechanism, separate surface question**. #43 answered "can the operator read Marketplace seller threads from a browser session?" #45 asks "can the operator read their *own ordinary* Messenger inbox the same way?" The first is answered yes-and-built; the second has the same technical shape but a different product boundary, because ordinary chats include private person-to-person conversations with no Marketplace `item_id` and no seller context. A design that reuses the existing extractor is plausible; a design that assumes Marketplace coverage implies ordinary coverage is not.

## 2. Access paths evaluated

| Path | What it actually reaches | Auth model | Verdict | Basis |
|---|---|---|---|---|
| **Graph API / Messenger Platform** | Page↔person threads only, not a personal inbox. | Page access token, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, PSID. | **Not applicable** | Platform requires a Page; "Conversations between a person and your account must be initiated by the person." ([overview, archived](https://web.archive.org/web/20250116120633/https://developers.facebook.com/docs/messenger-platform/overview)) |
| **Historical `read_mailbox`** | Personal Inbox (read only). | User token; restricted to non-web/desktop branded clients; Graph **v2.3 or older** only. | **Dead** — permission and doc URL now 404 | Archived permissions doc ([archived](https://web.archive.org/web/20161231234633/https://developers.facebook.com/docs/facebook-login/permissions)) |
| **Instagram Direct via Messenger Platform** | Professional (Business/Creator) inbox only. | `instagram_manage_messages` + Page/IG professional account. | **Not applicable** | Instagram messaging docs ([archived](https://web.archive.org/web/20241230042021/https://developers.facebook.com/docs/messenger-platform/instagram/)) |
| **`messenger.com`** | Separate origin, same Facebook account; same conversation store (**assumed**, unverified). | Same logged-in Facebook session. | **Rejected** — no capability gain over `www.facebook.com/messages` | [messenger.com](https://www.messenger.com/) ([archived](https://web.archive.org/web/20231231234937/https://www.messenger.com/)) |
| **Browser-backed `www.facebook.com/messages` session** | The operator's own consumer inbox; a logged-in browser decrypts E2EE locally. | Persistent-profile session cookies. **Unsanctioned** — Meta ToS §3.2(3): "You may not access or collect data from our Products using automated means (without our prior permission)…" | **Only technically-possible path; operator-risk-acknowledged** | [Meta Terms](https://www.facebook.com/legal/terms/plain_text_terms) ([archived](https://web.archive.org/web/20241225150617/https://www.facebook.com/legal/terms/plain_text_terms)); Developer Policies §8.2(a) bans person-to-person messaging/relays ([devpolicy](https://web.archive.org/web/20241225105741/https://developers.facebook.com/devpolicy/)) |
| **Official Download Your Information export** | Operator's own message archive, point-in-time. | Accounts Center, manual, operator-owned. | **Sanctioned read-only fallback; no send** | [Download your information](https://www.facebook.com/help/212802592074644) ([archived](https://web.archive.org/web/20250101021620/https://www.facebook.com/help/212802592074644)) |
| **Unofficial protocol libraries / scrapers** | Same personal session, reverse-engineered. | Stored session creds. | **Rejected** — ToS violation and ban risk | ToS §3.2(3) and Developer Policies §8.2(a) (above) |

**Load-bearing fact:** no sanctioned API can read or send a personal consumer Messenger inbox. The sanctioned Messenger APIs are business/Page-scoped, and default end-to-end encryption makes server-side content access impossible by design. Every "Messenger API" row above is really a *business inbox* API wearing a Messenger name: the Send API posts to `/{PAGE_ID}/messages` with a Page token and PSID ([Send API, archived](https://web.archive.org/web/20250104024922/https://developers.facebook.com/docs/messenger-platform/reference/send-api)), and the Conversations API returns conversations for "your Facebook Page or your Instagram Professional account" with only the 20 most recent messages ([Conversations API, archived](https://web.archive.org/web/20250120064228/https://developers.facebook.com/docs/messenger-platform/conversations/)). None of them addresses a personal account.

Two consequences follow. First, a browser-backed session is not merely the *cheapest* path — it is the **only** path that could reach ordinary consumer chats at all, because only a client holding the account's keys can decrypt them. Second, because that path is unsanctioned, it carries the operator's real account as the asset at risk; the sanctioned export is the only zero-risk read, and it cannot send.

## 3. Shared Meta account / session boundary

One Facebook account spans Facebook, Marketplace, Messenger, and Instagram through Accounts Center; Meta's terms require one account and prohibit password sharing and account transfer. The per-surface isolation this repo enforces (`marketplace` vs `messenger` scopes, profiles, and session assessments) is a **Musebridge discipline, not a Meta-enforced boundary** — the same identity and cookies can reach both.

This distinction matters for how the isolation is described. A separate `MESSENGER_PROFILE_DIR` and a separate session assessment give the messenger scope an independent *failure and reauth boundary* inside Musebridge: a challenge on the messenger profile does not take down Marketplace, and each scope can be disabled independently. It does **not** mean Meta sees two actors. To Meta, both scopes are one logged-in account, so a browser-backed messenger scope operates the operator's **own** identity: any send is the operator's own action, every read carries provider-visible side effects (the "Seen" receipt and presence), and the account-level risk of unsanctioned automation is borne by the same account Marketplace already uses. Isolation reduces blast radius within the repo; it does not create a separate identity or a separate permission.

## 4. End-to-end encryption

Personal Messenger is end-to-end encrypted by default ([Meta, Dec 2023](https://about.fb.com/news/2023/12/default-end-to-end-encryption-on-messenger/), [archived](https://web.archive.org/web/20241218002720/https://about.fb.com/news/2023/12/default-end-to-end-encryption-on-messenger/)). Meta cannot read message content, and no sanctioned API can reach it. A logged-in browser session decrypts locally, which is exactly why browser-backed reads can work while no API can. E2EE is the structural reason no sanctioned content API for a personal inbox exists — not a policy choice Meta could relax without changing the product.

Implications for each capability in this document:

- **Read:** only a client holding the account's keys can see content, so the browser session is the access method, and extraction must operate on rendered plaintext in that session. There is no server-side content endpoint to call.
- **Search:** search must be over extracted, bounded, in-session text (or the provider's own search UI), never a content index — Musebridge holds no index and must not build one, both because it cannot decrypt off-session and because persisting message text would be a privacy regression.
- **Draft:** drafting is local and carries no E2EE consequence; it is plain text until sent.
- **Send:** the browser session encrypts on the way out, so send confirmation cannot rely on reading a server ack; it is reconciled by re-reading the thread, which is itself E2EE-decrypted locally.

## 5. Capability contract definitions

These are the rules any ordinary-Messenger tool must satisfy, whether or not it is built. They are the same shape the existing Marketplace conversation tools already follow, restated so a future implementation cannot drift.

- **Thread identity:** an opaque id taken only from extracted `/messages/t/{id}/` hrefs, matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`, max 128 chars (`MAX_THREAD_ID_LENGTH`), never synthesized; the read URL is rebuilt from the configured origin and guarded against redirects (`UPSTREAM_ERROR` on mismatch). The caller never supplies a URL.
- **Participants:** the Facebook backend does **not** fabricate names; only `You said:` / `{Name} said:` orientation markers attribute a row. Seller identity is established by `item_id` → `marketplace_fetch` plus Miso reasoning. Ordinary-Messenger participant identity is an **open validation item**.
- **Unread / read state:** opening a thread marks it "Seen" — the named read-class exception already decided with the operator. There is no reliable unread count; `messenger_threads_list` opens no threads. Do not infer read state.
- **Bounded history:** one page, no scrolling or pagination, bounded counts (`maxMessages` 50 scanned from 120 rows today). Contrast the Conversations API, which returns only the 20 most recent messages. Bounds are a safety property: unbounded extraction would be both slow and a larger privacy exposure.
- **Attachments / media links:** out of scope — no download, decrypt, or persistence; at most link-level, and none extracted today. The reason is privacy: media is the highest-sensitivity content and the largest storage surface, with no sanctioned contract.
- **Delivery and send confirmation:** `TIMEOUT` means **unknown**, never resend. Reconcile by reading the thread and matching the embedded idempotency token; unconfirmed → `unknown`. There is no delivery ack to trust in the browser path.
- **Duplicate prevention:** single-use grant bound to the exact payload digest plus an embedded idempotency token, so a retry after an ambiguous timeout is a new approval decision, not an automatic resend.
- **Rate limits:** one page per call, no scrolling, per-scope serialized browser; a provider rate-limit or challenge becomes a typed error, never an empty success.
- **Reauth:** the messenger scope has **no interactive target yet**; captcha/checkpoint → typed error plus manual recovery; never automate 2FA or a challenge; credentials are environment-only. The loopback reauth console is wired only to the marketplace scope today.
- **Provider failure codes:** reuse the existing validated `ProviderError` set — `AUTH_EXPIRED`, `LOGIN_REQUIRED`, `CAPTCHA_REQUIRED`, `SESSION_INVALID`, `RATE_LIMITED`, `UPSTREAM_ERROR`, `TIMEOUT` (`services/marketplace/src/domain.ts`). `APPROVAL_REQUIRED` and `ACTION_FORBIDDEN` are policy codes, not provider errors.

## 6. Four-phase plan mapped to real work

- **Phase 1 — read-only list/read/search.** List/read exist for the **Marketplace** inbox. The ordinary-Messenger inbox extension is **unbuilt** (the backend `inboxPath` is configurable, but service wiring uses the Marketplace default). Search is **unbuilt**: define it bounded and fail-closed, with no fabricated results. Concretely, search would have to be either a bounded scan of extracted thread previews on one inbox page or the provider's own search surface driven in-session; it must never return a guessed match, and an unrecognized layout is a typed `UPSTREAM_ERROR`, never an empty result set.
- **Phase 2 — drafts/reply context.** Issue #62 (`messenger_prepare`, risk `prepare`, `subject_digest`, embedded idempotency token, explicit not-sent/not-authorized marker) — **pending, not landed**.
- **Phase 3 — narrow send.** Issue #63 (`messenger_send`, risk `send`, production authorizer, single-use grant, timeout reconciliation, messenger reauth) — **blocked on #43 shipping an issuance-authenticated verifier** (per `provider-action-boundaries.md`). When #63 registers `messenger_send`, the service's default `DenyAllAuthorizer` will make every send fail `APPROVAL_REQUIRED` until that verifier lands; **pending, not landed**.
- **Phase 4 — broader delegation.** Issue #44's delegated-negotiation contract (carried on the #44 branch; open PR #70, not merged into `main`) requires a deliberate `provider-action-boundaries.md` amendment and is **not authorized by #45**.

The phases are strictly ordered by capability risk, not by effort. Phase 1 adds no side effect beyond the already-declared read receipt. Phase 2 adds a draft artifact with no external effect. Phase 3 is the first write and is gated on infrastructure that does not exist yet: #43 must ship an issuance-authenticated verifier before any `send` can pass `authorizeAction`, so Phase 3 is blocked regardless of how ready the messenger surface is. Phase 4 changes the *authority* model (delegated negotiation), which is a boundary-contract change, not a connector change, and therefore cannot be smuggled in under a connector ticket. #45 authorizes none of Phases 2–4; it only characterizes them.

## 7. Safety, privacy, boundaries

Mapped to `provider-action-boundaries.md`:

- **Risk classes:** read/prepare are autonomous; send is never autonomous; high_consequence is refused. Any future ordinary-Messenger list/read is `read`; drafts are `prepare`; sends are `send`; none of the four phases reaches `high_consequence`.
- **Read side effect (named exception):** opening a thread marks it "Seen" and may surface presence; `messenger_threads_list` opens no threads and produces no receipt. This is the already-decided read-class exception, and it applies identically to ordinary chats.
- **Never log** page content, message text, media, cookies, storage, headers, or credentials — logs carry error names/codes and counts only.
- **Prompt injection:** inbound text is untrusted and cannot change Miso permissions; the send digest binds exactly what was drafted.
- **Scope isolation:** messenger keeps its own scope, profile, and session assessment; it shares no lease or cookies with Marketplace.
- **No challenge automation:** captcha/checkpoint/2FA surface as typed errors for manual recovery.
- **No content persistence:** extracted text is returned bounded and verbatim to Miso and not stored by Musebridge, mirroring the existing conversation tools.

## 8. Verified vs assumed + validation plan

**Verified** (public documentation / this repo's source and tests):

- The API/ToS/E2EE facts above (citations inline; captured from the cited pages or their archive copies at research time), including that the sanctioned Messenger APIs are Page/professional-scoped and that personal Messenger is E2EE by default.
- The existing read machinery: accessibility-contract extraction, fail-closed `UPSTREAM_ERROR`, redirect guard, per-surface profile (`MESSENGER_PROFILE_DIR`, default `~/.marketplace/browser-profile-messenger`), opt-in `MARKETPLACE_MESSENGER=1`, probe path `/messages/`, scope `(facebook, default, messenger)`, risk `read`.
- The exact `ProviderError` code set and the thread-id grammar/limits in `services/marketplace/src/domain.ts`.

**Assumed / unverified:**
1. The ordinary `/messages/` DOM contract is **not validated here** — thread anchors, previews, orientation markers, and empty-state text are inferred from the Marketplace extractor, not observed on `/messages/`.
2. `messenger.com` store equivalence is by inference, not a single explicit Meta sentence.
3. The DYI export's "Messages" category label was not captured in this environment.

**Validation plan:** one operator-run, read-only session against `/messages/` using the operator's own or a synthetic account, recording whether thread anchors, previews, orientation markers, empty state, and redirect behavior match the accessibility contract. Corrections land as extractor/fixture updates under the same fail-closed discipline. Until then these are contract-shaped, not production-proven.

The validation is deliberately narrow. It records **what the live page actually renders** — whether thread anchors carry `/messages/t/{id}` hrefs, whether previews are usable, whether `role="row"` rows expose `You said:` / `{Name} said:` labels, whether an empty inbox shows a recognized empty-state marker, and what a redirect does — against the existing extractor's expectations. It does **not** validate send, media, unread state, or participant identity, because those are either out of scope or already known to be unresolved. If any assumption fails, the extractor's fail-closed behavior degrades it to a loud `UPSTREAM_ERROR` rather than wrong data; the fixture backend remains the reference for Miso integration work.

## 9. Deliberate gaps / recommendation / cross-links

- **Recommendation:** no sanctioned personal-Messenger API exists. Treat ordinary-Messenger reads as a bounded, operator-risk-acknowledged, **read-only** extension of the existing browser mechanism — not yet built and not covered by the Marketplace tools. Drafts stay `prepare`-only; send stays deny-all until the #43 verifier and #63 land; delegation is deferred to #44.
- **Open questions left for a future ticket:** the ordinary `/messages/` DOM contract (Section 8); whether participant identity can be established without fabrication; whether the inbox extension can reuse the Marketplace extractor unchanged or needs a distinct one; and the exact operator risk acknowledgment text for unsanctioned consumer-inbox automation.
- **Deliberate gaps:** no ordinary-Messenger list/read tool; no search; no drafts; no send; no media; no unread/read inference; no `messenger.com` origin.
- **Reopen condition:** only if Meta publishes a sanctioned API for a personal consumer Messenger inbox (unlikely under default E2EE), or the operator accepts the account risk of the browser path for a concrete, bounded read-only need. Neither exists today.
- **Cross-links:** [`provider-action-boundaries.md`](provider-action-boundaries.md) (normative enforcement), [`conversation-surface-research.md`](conversation-surface-research.md) (Marketplace surface authority), [`instagram-threads-consumer-research.md`](instagram-threads-consumer-research.md), [`whatsapp-consumer-research.md`](whatsapp-consumer-research.md), [`capability-inventory.md`](capability-inventory.md), and [`services/marketplace/AGENTS.md`](../services/marketplace/AGENTS.md).
