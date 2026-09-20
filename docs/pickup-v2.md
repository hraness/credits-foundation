# Inactive pickup v2 wire support

`src/pickup-v2.ts` is a pure, product-neutral parser module. It does not contact the Credits service, create claims, generate or recover secrets, evaluate transactions, read or write state, invoke commands, or activate the source-disabled authority. Existing v1 behavior is unchanged. A valid parsed response is evidence of its wire shape and expected identity; it is not proof of authentication, durable storage, payment settlement, endpoint availability or permission to spend.

Every parser accepts an object or JSON text and returns a new, deeply frozen value, or `null` on failure. It never returns the rejected input or a service-supplied diagnostic. Callers must treat `null` as an invalid response, preserving their existing recovery state. Do not log the input. Transport remains responsible for the expected HTTP status, authenticated request, pinned authority, response byte streaming, redirects and recovery behavior. Both initial creation and creation replay use HTTP 200 in the reviewed wire.

## Parsers and expected identity

| Function | Required caller context | Result |
| --- | --- | --- |
| `parseCreditsClaimCreateV2` | None | Creation body without bearer material |
| `parseCreditsClaimCreatedV2` | Persisted creation ID, product ID, device ID and canonical service origin; claim ID once learned | Original creation binding, times and exact pay URL |
| `parseCreditsPickupRequestV2` | None | Exact status, credential, pickup or ACK body |
| `parseCreditsPickupResponseV2` | Expected operation, complete claim/product/device binding and persisted pickup ID | Payment and pickup state, with operation-specific usability |
| `parseCreditsBalanceV2` | Expected product ID | Public balance and packs |
| `parseCreditsErrorV2` | Received HTTP status | One fixed error code with its matching status |

Creation responses have no payment state or credential. Once the first response supplies the claim ID, include that ID when parsing every later creation replay. The pay URL must equal `${serviceOrigin}/t/${claimId}` exactly. The origin must be canonical HTTPS, or HTTP for the explicit loopback hosts `localhost`, `127.0.0.1` and `[::1]`. User information, path normalization, encoded claim aliases, extra path segments, queries, fragments and a different host/port are rejected. This check does not navigate to the URL.

Pass the persisted candidate's pickup ID even when a status request precedes registration. An unregistered status legitimately returns `pickupId:null`; any non-null response ID must match the saved candidate. A null expected pickup ID permits only unregistered status. Do not derive the expected operation or identity from the untrusted response itself.

Status always returns `usable:null`: it observes the claim, including revocation, and cannot establish that a credential works. Credential/pickup responses for a registered credential may say either `usable:false` or `usable:true`, according to the authority's frozen ACK policy. An acknowledged non-status response requires `usable:true`. An ACK response must be acknowledged. Non-status success cannot be unregistered or revoked; every registered, acknowledged or revoked state must be paid. The parser does not infer a token from these fields or authorize use before a future caller's durability and authentication requirements are met.

The balance response identifies only its product. It cannot prove a claim/device/pickup binding because those identities are absent from this wire. A future authenticated transport must bind the balance read to its intended credential. `lowBalance` remains an authority-owned boolean; this library does not reconstruct the policy threshold or infer it from held funds.

## Strict admission and v1 differences

Request bodies are bounded to 4,096 UTF-8 bytes; responses to 16,384. JSON-text limits include whitespace and escape spelling. Object limits apply to the fresh JSON representation, with early key/value character, node, depth and key-count bounds before serialization. Duplicate JSON keys (including escaped aliases), unknown keys, explicit `undefined`, sparse/adorned arrays, symbol keys, accessors, non-data properties, class prototypes, cycles, non-finite numbers and unpaired surrogates fail. Plain objects with the ordinary or null prototype are copied. Caller values are neither frozen nor retained by reference. Accessor descriptors are rejected without invoking getters; JavaScript Proxy traps are not an isolation boundary.

The module deliberately does not reuse v1 validators:

- Authority product and pack IDs are lowercase `[a-z0-9_-]`, 1–32 characters; a digit or underscore may begin one. Claim IDs allow ASCII letters, digits, underscores and hyphens, 1–128 characters.
- Creation IDs and creation device IDs follow the authority's lowercase RFC UUID validator, including versions 1–8 and the nil/max UUID values. Pickup requests/responses use its distinct lowercase `8-4-4-4-12` hex GUID contract. Neither is restricted to v4 by the client.
- Optional device labels permit 1–64 UTF-16 code units; email follows the authority's bounded 320-character wire pattern. Absent optional fields stay absent. No case folding, trimming, Unicode normalization or optional-field insertion occurs.
- Product names (64), pack labels (128) and device labels (64) additionally reject Unicode control, format, line-separator and paragraph-separator characters. This is deliberately stricter **client display admission** than the authority's plain length constraints, preserving the foundation's safe-public-text convention. It does not change the authority schema.
- Creation dates accept the authority's ISO calendar/time grammar, with timezone and finite parsed time, and require expiry strictly after creation. There is no current-clock check: an old paid claim can still be recovered after the unpaid-link expiry. Expiry is not a reason for this pure parser to clear local recovery data.
- v2 micro-USD values span signed safe integers; held micro-USD must be nonnegative. Public credits truncate toward zero, matching the authority. For example, `-12345` micro-USD projects to `-1` credit and `"-0.01"`; `-1` projects to `0` and `"-0.00"`. The existing v1 display helper floors negative credits and has different limits, so it is not reused.
- Public packs must have unique IDs, a present suggested pack, whole dollar amounts from 1 through 1,000, exact public base credits of `usd * 100`, and nonnegative safe-integer bonus credits. Bonus policy, costs, margins and pricing configuration remain opaque.

The module also rejects contradictory state combinations, altered money projections, secret-bearing extra fields and arbitrary error messages. It parses only the fixed public fields; it is not a general-purpose sanitizer for arbitrary service data or a terminal-output function.

## Recovery and compatibility boundary

The reviewed creation body carries a creation ID, product, device, and optional label/email/pack. Its claim secret is a separately persisted authorization bearer, never a body or response field. A pickup request carries the candidate's SHA-256, not its raw bearer. Creating IDs, generating either secret, persisting the original tuple, authenticating credential reads, promoting a credential and sending ACK all belong to future reviewed adapters. These parsers establish none of those effects or durability guarantees.

Minimal v2 creation is for a client without an existing credential. Returning authenticated credentials keep their wallet and token: the reviewed authority continues to use the existing v1 `POST /v1/claims` path with `subjectToken` and a device-authenticated v1 status read. Do not silently start a new v2 device/candidate for an authenticated top-up. Legacy pending/paid/consumed claims remain explicitly legacy; these helpers cannot recover an old once-only token that has already been lost.

## Source and test evidence

The implementation follows the frozen authority sources:

| Source | SHA-256 |
| --- | --- |
| `support/pickup-v2-contract.ts` | `508fbe4f33d70c1ea3b3208c972aedd45fc861943e458995e0d3cc3d74f1ee2e` |
| `support/pickup-v2-transport.ts` | `8755c98632677abeeaa8bdd553a84c408593a19fe6221e33ee451953fea4d26e` |
| `convex/claims.ts` fixed projections | `b6b0365a99c4c2c39d6c9ecfba05fd939b8222b170202925307c4ef24c4966de` |

The test file embeds 14 nonsecret synthetic responses independently captured from the enabled test HTTP router and actual Convex handlers using `convex-test@0.0.54`. The retained source fixture digest is `4764469e7b49d95dea72f4afe97c13385b5a73b504d34511e4d4258c771a15d1`. They cover creation and lost-response replays, pending/paid status, registration, credential reads before/after ACK, ACK replay, balance and paid recovery after expiry. No sibling source import or live request is required by the committed tests.

Additional tests cover cross-operation and cross-binding substitutions, URL attacks, malformed and secret-bearing responses, prototype/accessor input, UTF-8 byte limits, display controls, state contradictions, immutable output and 128 seeded authority-money projections. These are wire/parser tests. They do not qualify filesystem crash recovery, deployed transaction concurrency, transport, payments or live activation.
