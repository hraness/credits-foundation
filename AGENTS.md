# Credits foundation

- Keep this package presentation-and-protocol only and independent from
  provider SDKs, product code, and service credentials. The credits service is
  authoritative for balances, prices, packs and checkout; this package parses
  and presents its answers.
- Preserve root portability: no filesystem, network, or Git in `src/index.ts`.
  Network happens only inside the explicit `credits` commands and a product's
  own metered request path, never in incidental hooks; the server entry uses
  `fetch` only.
- Never enter card details, open a browser, or send email from this package.
  `email` asks the service to send the link; payment happens in the person's
  browser.
- Keep pricing opaque: the package never exposes take rates, provider costs or
  margins in output, documentation, or protocol text. Public unit prices and
  packs are the only prices it shows.
- Never print device tokens or claim secrets except the documented `wait`
  rescue path. Parse every foreign payload and state file from `unknown` with
  exact keys, bounded lengths and integer micro-USD. Ordinary product outputs
  and exit codes must remain unaffected by output failures.
- Cover money, pricing, envelope, state and command invariants with meaningful
  tests. No test may use real user state or the network; point
  `XDG_STATE_HOME` at a temporary directory and inject `fetch`.
- Run `bun run check` before delivery. Build `dist` through the script and
  retain it for immutable Git installs. Consumers pin reviewed tags or full
  commits; never use sibling source paths in their committed manifests.
- Keep agents on disjoint files and preserve others' edits. One integrator owns
  manifests, lockfiles, generated artifacts and the final gate.
- Deliver subsequent changes through a current-head PR with passing Required
  checks and resolved reviews. Never force-push or bypass provider controls.
