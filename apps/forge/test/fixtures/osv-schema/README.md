# OSV schema (AQ-10, ADR 0097)

`schema-1.9.2.json` is the official OSV JSON Schema, unchanged:

- Source: https://raw.githubusercontent.com/ossf/osv-schema/main/validation/schema.json
- Fetched 28 Oct 2026, from ossf/osv-schema `main` at commit 6410c13304f9bde44b522350b244f1f51e1c18a6
  (spec `docs/schema.md`: "Version 1.9.2 (October 13, 2026)").
- SHA-256 of the file: ec09a74d4c4f7bafd57ee76781f2104f873fc1113b3eb82f047b5a09ab651afb

`test/osv-feed.test.ts` validates every feed record against it. To update, fetch the file again, keep the name in step
with the spec version, and change `OSV_SCHEMA_VERSION` in `src/services/osv-feed.ts`.
