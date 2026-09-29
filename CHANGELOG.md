# Changelog

## 0.7.0 - unreleased

Menu bar companions are gone from Hraness products, so the menu rows are too.

- New: `creditsVerbs(product, profile)` in `@hraness/credits-foundation/node`
  returns the `credits` commands as desktop-foundation registry verbs
  (`credits protocol`, `status`, `estimate`, `topup`, `wait`, `email`,
  `signout`). Text output is `runCreditsCommand`'s; `--json` output is the
  desktop-foundation envelope, and exits follow its contract (2 `usage`, 1
  with a `<product>.credits-*` code). `runCreditsCommand` itself is unchanged.
- Removed: `creditsMenuItems` and its `CreditsMenuStatusRow`,
  `CreditsMenuAddRow` and `CreditsMenuOptions` types. Show the balance with
  `credits status` instead.
- The bundled audience rule now comes from desktop-foundation 0.9.0; it
  behaves the same.

## 0.6.1 - 2026-09-26

Many writes in a row to one stream now share a single `error`/`close`
listener pair, so a host that writes to `process.stdout` or `process.stderr`
many times in a row no longer sees Node's `MaxListenersExceededWarning`.
Output, JSON shapes and exit codes are unchanged.

## 0.6.0 - 2026-09-26

`credits` commands now print their result for people on stdout, like every
other Hraness command, so `peopleblade credits status | grep` works. Errors,
the `wait` progress line and the `Next:` hint stay on stderr. JSON shapes,
the protocol and exit codes are unchanged.

- Human results (`status`, `topup`, `wait`, `estimate`, `email`, `signout`)
  move from stderr to stdout.
- `email` and `signout` still print JSON to stdout when stdout is not a
  person's terminal; their sentence then goes to stderr, so stdout stays one
  JSON document.
- The audience rule is now `detectAudience` from desktop-foundation 0.8,
  bundled into `dist`. `HRANESS_AUDIENCE` also accepts any letter case and
  surrounding spaces.

- Two writes in a row to the same stream no longer drop the second one. A
  host that ran two `credits` commands back to back on `process.stdout`, or a
  result followed by a hint on one stream, could lose the second write.

For consumers: if a test or wrapper reads the human text of a `credits`
command from stderr, read stdout instead. Code that uses `--json`, a detected
agent, or `emitCreditsRequired` needs no change.
