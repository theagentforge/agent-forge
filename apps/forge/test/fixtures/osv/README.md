# OSV fixtures (C1)

Responses of `POST https://api.osv.dev/v1/query`, in OSV schema 1.6, used by `test/advisories.test.ts`.

- `ghsa-lodash-4.17.20.json`: a vulnerability with a fixed version (GHSA-35jh-r3h4-6jhm, CVE-2021-23337, fixed in 4.17.21).
- `none.json`: no match (OSV answers `{}`).
- `mal-litellm-1.107.0.json`: a malicious-package record for litellm 1.107.0, shaped after OSV's MAL- records
  because this build session can't reach api.osv.dev. Its id, **MAL-0000-0001, is made up on purpose**: the real
  OSV id for the 21 Oct 2026 release must come from OSV itself (MAL-2026-2144 is the March 2026 litellm record for
  1.82.7 and 1.82.8, per osv.dev). What staging returns for the real package is recorded in STATUS.

Each fixture's `summary` and `details` hold free text, including an instruction-like line, so the tests can check
that free text never reaches a result.
