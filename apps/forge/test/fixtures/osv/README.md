# OSV fixtures (C1)

Responses of `POST https://api.osv.dev/v1/query`, in OSV schema 1.6, used by `test/advisories.test.ts`.

- `ghsa-lodash-4.17.20.json`: a vulnerability with a fixed version (GHSA-35jh-r3h4-6jhm, CVE-2021-23337, fixed in 4.17.21).
- `none.json`: no match (OSV answers `{}`).
- `mal-litellm-1.107.0.json`: a malicious-package record for litellm 1.107.0, shaped after OSV's MAL- records
  because this build session can't reach api.osv.dev. Its id, **MAL-0000-0001, is made up on purpose**: the real
  OSV id for the 21 Oct 2026 release must come from OSV itself (MAL-2026-2144 is the March 2026 litellm record for
  1.82.7 and 1.82.8, per osv.dev). What staging returns for the real package is recorded in STATUS.

- `ghsa-event-stream.json`: GHSA-mh6f-8j2x-4483 (event-stream 3.3.6 and flatmap-stream, Nov 2018), verbatim from
  GitHub's advisory database (`advisories/github-reviewed/2018/11/GHSA-mh6f-8j2x-4483`, modified 2021-09-15), which is
  OSV's source for GHSA records; fetched 7 Nov 2026 (api.osv.dev isn't reachable from build sessions). No MAL- alias;
  `database_specific.cwe_ids` is `["CWE-506"]` (Embedded Malicious Code), and the details call flatmap-stream malicious.
- `ghsa-express.json`: GHSA-qw6h-vgh9-j6wx (CVE-2024-43796, fixed in 4.20.0) and GHSA-rv95-896h-c2vc (CVE-2024-29041,
  fixed in 4.19.2), verbatim from the same database, fetched 7 Nov 2026. A subset of express's advisories.

Each made-up fixture's `summary` and `details` hold free text, including an instruction-like line, so the tests can check
that free text never reaches a result.
