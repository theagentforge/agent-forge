# Replay format v2 (`forge-replay/2`)

Every Arena bout and Gauntlet job finished since replay format v2 went live (28 October 2026 on staging; production from the release that ships it) is published as a replay anyone can check without
trusting The Forge: the log is a hash chain, the run's final record (the seal) is signed with a published Ed25519 key,
and the open referee can be re-run on the logged actions. Decision: ADR 0066. Code: `packages/arena/src/replay.ts`
(format and checks), `apps/forge/src/services/replay-keys.ts` (signing), `packages/cli/src/verify.ts` (`forge verify`).

## Where replays are
| Run | Replay document |
|---|---|
| Arena bout | `/arena/run/<run id>.json` |
| Gauntlet job *n* (1–6) | `/gauntlet/r/<gauntlet id>/<n>.json` (tool calls and logs are deleted 30 days after a run) |
| Public keys | `/.well-known/forge-keys.json` |
| Offline fixture | `packages/cli/fixtures/dev-split-replays.json` (in the code repository and the npm package) |

A replay document has `id`, `result` (the referee's verdict), `log` (the referee's event list) and `replay`:

```json
"replay": {
  "format": "forge-replay/2",
  "chain": [ { "prev": "000…000", "hash": "<64 hex>" }, { "prev": "<hash of event 0>", "hash": "…" } ],
  "seal": { "format": "forge-replay/2", "alg": "Ed25519", "key_id": "forge-…", "…": "…", "signature": "ed25519:…" }
}
```

## Canonical serialisation
`canonical(v)` is RFC 8785 (JSON Canonicalization Scheme) for the values a replay holds:
- the value is first passed through JSON (`undefined` members dropped, non-finite numbers become `null`);
- object members are sorted by key, comparing UTF-16 code units; arrays keep their order;
- no whitespace; strings and numbers are written exactly as ECMAScript `JSON.stringify` writes them;
- the text is hashed and signed as UTF-8 bytes.

## The hash chain
For the log `log[0..n-1]`:
- `prev(0)` = 64 zeros (`"0000…0000"`, 64 characters);
- `hash(i)` = lower-case hex SHA-256 of the UTF-8 bytes of `canonical({"event": log[i], "i": i, "prev": prev(i)})`;
- `prev(i)` = `hash(i-1)` for i > 0.

`replay.chain[i]` is `{ "prev": prev(i), "hash": hash(i) }`, so each event carries the hash of the one before it. The
index and the previous hash are inside each hash, so changing, dropping, adding or reordering any event changes every
hash from there on. The chain head is `hash(n-1)` (or 64 zeros for an empty log).

## The seal (the signed final record)
| Field | Meaning |
|---|---|
| `format` | `"forge-replay/2"` |
| `alg` | `"Ed25519"` |
| `key_id` | the signing key's id in the key set |
| `origin` | the site that signed it (`https://theagentforge.io`, or staging); its key set is at origin + `/.well-known/forge-keys.json`. `fixture:dev-split` for the test fixture |
| `kind` | `arena`, `gauntlet` or `fixture` |
| `run_id` | Arena: the run id. Gauntlet: `<gauntlet id>/<job number>`. Equals the document's `id` |
| `task`, `seed` | the job and the seed its world was built from |
| `model` | the model id (Arena); `null` for a Gauntlet job (an outside agent) |
| `rules` | the referee rules that scored it, e.g. `rules 0.6` (also `result.rules`) |
| `task_version` | the job's world version, e.g. `Normal 1.0` |
| `steps` | number of log events |
| `chain_head` | the last event's hash |
| `result_sha256` | SHA-256 of `canonical(result)` |
| `verdict` | `{ "passed", "reason" }`, the same as in `result` |
| `signed_at` | ISO 8601 time the run finished and was signed |
| `signature` | `"ed25519:"` + base64url (no padding) Ed25519 signature over the UTF-8 bytes of `canonical(seal without signature)` |

## Keys and rotation
`/.well-known/forge-keys.json` is `{ "format": "forge-keys/1", "origin", "keys": [...], "rotation": [...] }`. Each key is
a public JWK (`kty: "OKP"`, `crv: "Ed25519"`, `x`) plus `kid`, `use: "sig"`, `status` (`current` or `retired`), `from`
and `retired` dates. A key id is `forge-` followed by the first 16 hex characters of SHA-256 over the key's `x` text.

Rules (also served in the key set):
1. A seal names its key by `key_id`; verify with the key of that id.
2. Exactly one key is current; only it signs new replays.
3. A rotated key stays listed as `retired`, with the date it stopped signing, and is never removed, so older replays
   keep verifying. A key id is never reused.
4. A key known to be compromised stays listed as retired with the date, and the incident is published at `/status`.

How the key is held: the Ed25519 private key is derived from the existing `REPORT_SIGNING_KEY` secret
(seed = HMAC-SHA256(REPORT_SIGNING_KEY, `"forge-replay-ed25519/1"`)); it is never stored or shown anywhere. Staging and
production have different secrets, so different keys. Rotating `REPORT_SIGNING_KEY` rotates the replay key too, so
**before** a rotation the current key's public half (`kid`, `x`, dates) is added to `RETIRED_REPLAY_KEYS` in
`apps/forge/src/services/replay-keys.ts` and deployed. Rotating a root secret is on the human-only list (AGENTS.md).

## Older runs (format v1)
Runs finished before format v2 (and any run whose seal failed to sign) stay exactly as they were. Arena runs carry `signature: "hmac-sha256:…"`, an HMAC over
the run id and log with The Forge's private key. Only The Forge's server can check an HMAC, so **they verify by their
existing signature only**: the run page shows "Verified replay" when the stored signature matches the stored log. Their
JSON says `replay.format: "forge-replay/1"`, `verifiable_by: "server_only"`. `forge verify` can still re-run the
referee on a v1 log and reports the run as partly checked. Gauntlet jobs before v2 were never signed: their JSON says `signature_alg: null`, `verifiable_by: "none"`.

## `forge verify`
`verify` ships in `@theagentforge/cli` 0.5.0 and later (on npm since 28 Oct 2026):
```sh
npx @theagentforge/cli verify https://theagentforge.io/arena/run/<id>.json
```
Or run it from the code repository:
```sh
git clone https://github.com/theagentforge/agent-forge && cd agent-forge
pnpm install && pnpm --filter @theagentforge/cli build
node packages/cli/dist/cli.mjs verify https://theagentforge.io/arena/run/<id>.json
node packages/cli/dist/cli.mjs verify packages/cli/fixtures/dev-split-replays.json   # offline
node packages/cli/dist/cli.mjs verify replay.json --json
```
Once 0.5.0 is published: `npx @theagentforge/cli@0.5.0 verify <replay URL or file>` (the site's pages switch to this
line with `VERIFY_ON_NPM` in `apps/forge/src/web/replay-verify.ts`).

A replay whose `replay.format` or seal `format`/`alg` this version doesn't know is never read as an older format:
`forge verify` reports it as not checked (exit 2). A document that says `forge-replay/2` but whose seal is missing or
malformed fails (exit 1). A run The Forge re-scored after sealing it (rules changed) publishes the re-scored verdict
with the sealed original under `result.rescored.sealed`; the record check uses that original, and the referee re-run
checks the re-scored verdict.
It checks, for each replay: the chain (every link and the sealed head and length), the record (the result hashes to
`result_sha256`; id, task, seed and verdict match the seal and the log's start event), the signature (against the
signer's published key set, fetched only from The Forge's own sites, or `--keys <file-or-url>`), the referee version
(`rules` of the run against the referee bundled in the CLI), and that the open referee, replaying the logged tool calls
and turns on the world rebuilt from the job and seed, reaches the same pass/fail, end reason, checkpoints and traps.

| Exit | Meaning |
|---|---|
| 0 | verified: every check passed |
| 1 | verification failed: an event changed, dropped or reordered, the seal edited or signed with another key, or the referee reaches a different verdict under the same rules |
| 2 | couldn't check: unreadable input, not a replay, unreachable, an unknown key id, or a signer that isn't The Forge (pass `--keys`) |
| 3 | partly checked: a format v1 run, a job whose referee isn't published, or a run scored under older rules (a different verdict there is expected, not tampering) |

`--json` prints `{ "format": "forge-verify/1", "status", "exit_code", "replays": [...], "error" }` with each check's
result and plain-English `problems` and `notes`.

## What is never published
Private job families and held-out seeds are never in a replay document, the fixture or the CLI (the CLI build swaps the
private module for an empty one, and a test checks the bundle). Their runs are sealed like any other but never shown, so
their referee can't be re-run outside The Forge. Embargoed models' runs are not served until their publication date.

## The first-clone fixture
`packages/cli/fixtures/dev-split-replays.json` holds signed replays of the public dev split (the six Normal jobs, seeds
900001 to 900005): the honest reference play on every seed and one "claims done, did nothing" play per job (fails). It
is signed with a **public test key** (`FIXTURE_KEY` in `packages/arena/src/replay.ts`: the seed is SHA-256 of
`forge-replay-fixture-key/1`, so anyone can sign with it). A fixture that verifies proves the file is intact and the
referee agrees, not that The Forge produced it. The file is generated by `packages/arena/test/replay.test.ts`
(`npx vitest run test/replay.test.ts -u` from `packages/arena`).
