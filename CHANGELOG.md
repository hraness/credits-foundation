# Changelog

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
- Many writes in a row to one stream share a single `error`/`close` listener
  pair, so Node no longer prints `MaxListenersExceededWarning` after about ten
  back-to-back writes.

For consumers: if a test or wrapper reads the human text of a `credits`
command from stderr, read stdout instead. Code that uses `--json`, a detected
agent, or `emitCreditsRequired` needs no change.
