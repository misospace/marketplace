# WhatsApp consumer conversation feasibility (#47)

Parent: #38 (Musebridge capability map). Issue: #47. Status: research complete — verdict is **NO-GO** for an officially-sanctioned *personal* WhatsApp connector, with one tightly-scoped read-first milestone proposed (not built here). This document complements `provider-action-boundaries.md`, which remains the normative enforcement contract.

## What the WhatsApp vertical needs

The user outcome for #47 is to **read relevant WhatsApp chats, draft responses, and possibly send approved messages** — the same shape as the Messenger vertical (#43/#45) — without pretending that a business messaging API grants access to a person's own consumer chats.

The critical distinction for this vertical: **WhatsApp consumer (personal) messaging and the WhatsApp Business Platform are different products with different account models, and only the latter has a sanctioned API.**

- **Personal WhatsApp** is a consumer E2E-encrypted messenger tied to a phone number. It has WhatsApp Web and Desktop as *linked devices* of that account, but it exposes **no public API for a user's own chats**. There is no sanctioned way for software to read a personal account's conversation history.
- **WhatsApp Business Platform** (Cloud API, formerly On-Premises API) is a business↔customer messaging product. It reaches only threads between a *registered business phone number* and users who message that number — a business inbox, not a consumer's personal inbox.
- This differs from **Messenger/Marketplace** (#43, `conversation-surface-research.md`) in one decisive way: Messenger buyer↔seller chats are reachable through the same logged-in `www.facebook.com` session this repo already isolates per surface. Personal WhatsApp has no browser surface the operator may legitimately automate, and no API at all. It also differs from the **shopping** vertical (`shopping-provider-research.md`): there the answer was a plain HTTPS API with a self-serve key and no browser; here the sanctioned API is business-only and the only path to personal chats is an unsanctioned session.

No cart/write-style capability is proposed. Everything scoped here would be at most `read`.

## Access paths evaluated

Researched against public documentation, help-center pages, and project READMEs as of October 2026. Meta developer pages are not directly reachable from this environment (HTTP 400); their content was verified through Internet Archive captures of the same URLs, noted per row. "Reaches" states what the path can actually access, not what it is marketed for.

| Path | What it actually reaches | Auth model | Verdict | Basis |
|---|---|---|---|---|
| **Official WhatsApp Business Platform — Cloud API** | A registered **business phone number**'s threads with customers (WABA inbox). Cannot read a personal account's chats. | Meta Business portfolio + WhatsApp Business Account (WABA) + business phone number; System/Business-Integration/User access tokens; Graph API permissions `whatsapp_business_messaging`, `whatsapp_business_management`, `business_management`. | **Not applicable to personal chats** | Cloud API docs: "allows medium and large businesses to communicate with customers at scale" ([Cloud API Overview, archived](https://web.archive.org/web/20241217195645/https://developers.facebook.com/docs/whatsapp/cloud-api/overview)) |
| **On-Premises API** | Same business↔customer scope as Cloud API; self-hosted client. **Sunset.** | Business tokens, self-hosted. | **Dead** — final version (v2.63) expired **October 23, 2025**; can no longer send/receive | Meta sunset page ([archived](https://web.archive.org/web/20260927212527/https://developers.facebook.com/docs/whatsapp/on-premises/sunset)) |
| **Business Management API** | WABA metadata, templates, phone-number management, analytics. Not message content of a personal account. | Business tokens; `whatsapp_business_management` | **Not applicable** | Cloud API Overview resource descriptions (archived, above) |
| **WhatsApp Business App / linked-device companion mode** | The *Business app's own* conversations on a phone, via up to four linked devices. Not a general personal-account API. | QR linked-device pairing; primary phone required to register and link. | **Not a personal-chat API; not automatable** | Help Center ([Linked devices](https://faq.whatsapp.com/483137970953208), [How to link with QR](https://faq.whatsapp.com/887088088859510)) |
| **Click-to-Chat / deep links (`wa.me`, `api.whatsapp.com/send`)** | Opens a chat **from a human-driven device** to a given number with a prefilled message. Does not read history or read a personal inbox. | None; navigation only. | **No read capability; send only, user-driven** | Help Center ([How to use click to chat](https://faq.whatsapp.com/5913398998672934)) |
| **Third-party connectors / BSPs (e.g. Twilio, Meta BSPs)** | The same **business↔customer** scope as Cloud API, resold/wrapped. Cannot read personal chats. | BSP account + sender registration (WABA); BSP credentials. | **Not applicable to personal chats** | Twilio docs: WhatsApp Business Platform for support/notifications/promotions ([twilio.com/docs/whatsapp](https://www.twilio.com/docs/whatsapp)) |
| **Personal WhatsApp Web/Desktop session automation** (real browser, Playwright-style — the repo's Facebook approach) | A **linked-device session** on a personal account; could in principle read that account's chats by driving the web client. | QR linked-device pairing from the primary phone; session cookie/token in the browser profile. **Unsanctioned** — not a supported API. | **Only technically-possible read path; explicitly risky, not recommended** | Help Center linked-device model (above); repo's Facebook precedent in `conversation-surface-research.md` |
| **Unofficial protocol libraries (Baileys, whatsapp-web.js, others)** | Same personal WhatsApp Web protocol/session, without a managed browser (Baileys: direct WebSocket) or via Puppeteer (whatsapp-web.js). | QR linked-device pairing; library stores the session creds. **Unsanctioned; reverse-engineered.** | **Rejected** — violates ToS, actively evadable, ban-prone | [Baileys README](https://github.com/WhiskeySockets/Baileys) ("not affiliated, associated, authorized, endorsed by … WhatsApp"); [whatsapp-web.js README](https://github.com/wwebjs/whatsapp-web.js) (Puppeteer, "reduce the risk of being blocked") |

**The load-bearing fact:** Cloud API is a *business↔customer* API. It cannot read a personal account's chats, and no amount of configuration changes that. The Business Platform answers "can a business talk to its customers?"; #47 asks "can the operator read *their own* personal chats?" Those are different questions with different products, and only the first has a sanctioned API.

## Go / no-go

**NO-GO for an officially-sanctioned personal-WhatsApp connector today.** Rationale in one sentence: personal WhatsApp exposes no public API for a user's own chats, the Business APIs reach only a business number's customer threads, and every remaining path is either a human-driven deep link or an unsanctioned reverse-engineered/linked-device session that violates the WhatsApp terms and risks the operator's real account.

Consequences:

- **Do not build an invasive automated workaround for checkbox parity** (issue #47's explicit instruction). A protocol-level or hidden-browser scraper of a personal account is not an acceptable Musebridge connector, regardless of how reliably it may appear to work in a demo.
- **No `send` capability is in scope.** Any future write to a personal chat would be `send`-class under `provider-action-boundaries.md`, requiring issuance-authenticated single-use grants that **do not exist yet** (#43). Deny-all remains the production default.
- **The Messenger vertical is unaffected.** #47 does not block #45 or any other vertical.

**Tightly-qualified conditional:** a *read-only, operator-owned, throwaway-account* proof-of-concept may be defensible **only** as research to characterize the failure modes of a browser linked-device session — never as a product connector, and never against the operator's real personal account. That is the milestone below; it is proposed, not authorized, and not built in this issue.

## Read-first milestone (proposed, not built here)

**No implementation is part of #47.** This section describes the *smallest defensible* read-only proof-of-concept so a future ticket can be judged against a concrete bar. Such a ticket is separate and must clear `provider-action-boundaries.md` explicitly before any code lands.

Scope, at most:

1. **Dedicated throwaway identity only.** A separate phone number + WhatsApp account created solely for the experiment, explicitly never the operator's primary personal number or any account with real contacts. If it cannot be sacrificed, the experiment does not run.
2. **Explicit, recorded risk acknowledgment by the operator.** Written acknowledgment that automated use of WhatsApp Web violates the WhatsApp terms, that the linked device may be logged out or the account banned at any time, and that any such outcome is an accepted, first-class cost — not an unexpected bug.
3. **Read-only, fail-closed extraction.** List and read the throwaway account's own threads via accessibility-contract-style signals only (the discipline of `conversation-surface-research.md`), returning typed `UPSTREAM_ERROR` on an unrecognized layout rather than an empty success or fabricated field. No sends, no drafts delivered, no reactions, no status changes.
4. **Session-scope isolation.** A dedicated session scope per `provider-action-boundaries.md` — its own scope value (not `facebook`), its own browser profile directory, its own session assessment and reauth handling. The WhatsApp profile must never share cookies, storage, or a lease with the Facebook/Marketplace or Messenger scopes.
5. **No credential storage; no challenge automation.** The QR pairing flow is completed interactively by the operator on the phone. Credentials/keys are never persisted, logged, or returned; the resume token lives only in the scope's profile directory. 2FA and any security challenge are never automated — they surface as typed errors requiring manual recovery.
6. **No logging of content.** Per the repo invariants, never log page content, message text, media, cookies, storage, headers, or QR strings; logs carry only error names/codes and counts.
7. **Exit criteria that make it cheap to abandon.** The milestone's deliverable is a written characterization of reliability and breakage modes, explicitly *not* a production tool. If it cannot demonstrate stable, non-invasive reads, it is closed and the verdict stands as final.

Deliverables of a future implementation ticket would be: the throwaway-account operating note, the risk acknowledgment, a fixture-first reader against synthetic pages, and one operator-run live read — nothing more. A production connector is a separate, higher bar that #47 does not clear.

## Operational and semantic details

These are the facts that would govern any read path and explain why even the conditional milestone is fragile.

- **Account / device pairing.** WhatsApp Web/Desktop is a **linked device** of the primary phone, added by scanning a QR code shown by the web/desktop client with the primary phone ([How to link with QR](https://faq.whatsapp.com/887088088859510)). You can link **up to four devices** at a time, and **the primary phone is still required** to register the account and to link new devices ([Linked devices](https://faq.whatsapp.com/483137970953208)). There is no API pairing; linking is always an interactive, phone-in-hand operation.
- **Reauthorization / unlinking.** Linked devices continue to work while the phone is offline, **but are logged out if the phone is unused for more than 14 days** ([About linked devices on the WhatsApp Business app](https://faq.whatsapp.com/647349420360876)). The personal app uses the same linked-device mechanism, but the exact personal-page wording is **unverified** in this environment — see Assumed #1. A user can also unlink all devices from the phone, or log out from the linked device ([How to unlink a device](https://faq.whatsapp.com/834124628020911)). The service must treat an unlink as a state downgrade to `session_unknown` and never re-authorize automatically.
- **Attachment handling.** WhatsApp content is **end-to-end encrypted**, and on linking, the primary phone sends an E2E-encrypted copy of recent message history to the new device where it is stored locally ([About message history on linked devices](https://faq.whatsapp.com/653480766448040); [About end-to-end encryption](https://faq.whatsapp.com/820124435853543)). In practice a linked-device client receives already-decryptable content for that device, but media handling (download, decrypt, size/storage bounds, retention) is a large, privacy-sensitive surface with no sanctioned contract — a reason to keep any read PoC text-first and to never persist media.
- **Delivery receipts.** The client heightens sent → delivered → read via check marks; two blue checks mean read, a clock means not yet sent or delivered ([How to check read receipts](https://faq.whatsapp.com/665923838265756)). Read receipts are user-configurable, so absence of a read receipt is not evidence a message is unread. Anyone building on a browser session must not infer delivery state from the UI without the same caution Messenger reads already require.
- **Multi-device semantics.** Message sync is a phone→device encrypted history transfer at link time, stored locally and time-proportional to history size ([About message history on linked devices](https://faq.whatsapp.com/653480766448040)). A new linked device is not a full server-side archive; a fresh profile may lack older messages, and each device is an independent, revocable endpoint. Multi-device is designed for a human's own devices, not for a service connector, and the account owner can remove any device at will.
- **Privacy.** Messages are described by WhatsApp as end-to-end encrypted and the security page states no one can read a user's personal messages ([whatsapp.com/security](https://www.whatsapp.com/security)); the Business Platform, by contrast, is business messaging with its own separate business terms ([WhatsApp Business Terms](https://www.whatsapp.com/legal/business-terms), distinguishing the Business App from the Business Platform terms). Metadata exposure (timing, participation, device linkage) is not something a linked-device session can avoid, and linking a third-party device is itself a privacy-relevant act the counterpart may not expect.
- **Operational risk of a brittle browser session.** WhatsApp Web is an obfuscated, frequently changing client with no stable DOM/API contract for automation. Any browser session built on it can break silently on a WhatsApp update, produce wrong/empty data if extraction fails open, reach unrecoverable states (logged-out device, account banned, number flagged), and — worst case — is invisible to the counterpart except as the operator's own account behaving strangely. Combined with the 14-day unlinking rule and four-device cap, this is a high-maintenance, high-blast-radius surface with a real chance of costing the operator their account.

## Verified vs assumed

**Verified** (primary sources fetched or archived copies of the exact primary URL; links above):

- On-Premises API sunset: final client v2.63 expired **October 23, 2025**; business numbers could only be registered for Cloud API from **July 1, 2024**, and new features shipped Cloud-only from **January 9, 2024**.
- Cloud API is business↔customer messaging on a business portfolio/WABA/business phone number, with `whatsapp_business_messaging` etc. — it cannot read a personal account.
- Cloud API messages are protected by Signal-protocol encryption before leaving the device and delivered to the destination chosen by the business ([Cloud API Overview, archived](https://web.archive.org/web/20241217195645/https://developers.facebook.com/docs/whatsapp/cloud-api/overview)). This is transport encryption to the *business*, **not** consumer end-to-end encryption in which only the two user endpoints hold the keys — the business is an endpoint and can decrypt. Do not describe Cloud API as consumer-E2EE.
- WhatsApp Web/Desktop is a **linked device**; **up to four** linked devices stated on the Linked-devices help page (Business-app FAQ; personal-app wording not renderable here — see Assumed #2); primary phone required to register and link; QR pairing.
- **14-day** rule: linked devices log out if the phone is unused for over 14 days (verified on the Business-app FAQ).
- Message-history sync to a new linked device is an E2E-encrypted, locally stored copy sent by the primary phone.
- Read receipts/check-mark semantics.
- Click-to-Chat exists as a navigation-only feature.
- Baileys and whatsapp-web.js are **unofficial**, reverse-engineered, and not authorized by WhatsApp.

**Assumed / unverified** (do not treat as fact):

1. The **personal** app's exact 14-day wording — the mechanism is shared and stated for the Business app, but the personal help page content was not renderable here.
2. The current linked-device cap remaining exactly four on the **personal** app — read from a help-center search excerpt; the rendered personal page was not captured.
3. Reported **ban/flag rates** for Baileys/whatsapp-web.js — community reports only, no primary figure, and no way to quantify.
4. Exact `wa.me` / `api.whatsapp.com` deep-link options for a service — the click-to-chat feature is verified; its precise parameter contract is not.

**Validation plan if a read path is ever pursued:** operator-provisioned throwaway account; complete the workflow above under the boundary contract; record which facts in this list hold, which break, and whether extraction can fail closed; append results here before any tool is treated as reliable — same bar as `conversation-surface-research.md`.

## Safety, privacy, and boundaries

Mapped to `provider-action-boundaries.md`:

- **Risk class.** The best case for any WhatsApp read is `read`. Because a linked-device session receives messages and can mark them seen, opening a thread would create a provider-side receipt visible to the counterpart — the *same* named read-class exception already decided for Messenger, and it must be declared explicitly if such a tool ever ships. As with the Messenger precedent (`conversation-surface-research.md`), an active linked-device session also surfaces **presence/online** to the counterpart and cannot avoid it; the same accepted caveat applies.
- **Any send is `send`.** There is no sanctioned personal-WhatsApp send, and production `send` is deny-all until #43 ships an issuance-authenticated verifier. A fabricated matching grant currently passes structural checks only; no WhatsApp send path may be built on that.
- **Never store credentials; never log content.** No message text, media, QR strings, cookies, or storage in logs or tool output. QR pairing is completed interactively; resume tokens stay in the scope's profile directory only.
- **Never automate 2FA or a challenge.** Two-step verification and any checkpoint surface as typed errors and manual recovery, exactly as the Facebook flow does.
- **Account-ban risk is a first-class consequence.** The operator's *real* account is the asset at risk. That risk is the primary reason the verdict is NO-GO rather than "proceed carefully": there is no way to make an unsanctioned linked-device automation safe for the account it runs against.
- **Scope isolation.** If a read path is ever explored, it gets its own `(provider=whatsapp, account, surface)` scope, its own browser profile, its own session assessment, and no shared state with Facebook/Marketplace/Messenger.

## Deliberate gaps / recommendation

- **Recommendation:** close #47's research question with **NO-GO** for a sanctioned personal WhatsApp connector; record the read-first milestone as a *possible, separate, risk-acknowledged research ticket* that #47 itself does not authorize or build. Do not build an invasive workaround.
- **No Business API adoption for this outcome.** Cloud API/BSPs solve business↔customer messaging, not reading personal chats; adopting one would not satisfy #47 and is out of scope for this service.
- **#47 does not block anything.** It does not block #45 (Messenger) or any other vertical; those proceed independently under the existing boundary contract.
- **Cross-links:** `provider-action-boundaries.md` (normative enforcement), `conversation-surface-research.md` (the read-extraction discipline and the named read-receipt exception), `shopping-provider-research.md` (the contrast case: a sanctioned API with no browser), and `services/marketplace/AGENTS.md` — session-scope, credential, and privacy invariants this repo already enforces.
- **Reopen condition:** only if WhatsApp ever publishes a sanctioned API for a user's own consumer chats, or the operator decides the throwaway-account research is worth its explicit, acknowledged ban risk. Neither exists today.
