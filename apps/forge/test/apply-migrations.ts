import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// No test reaches OSV: checks read recorded responses instead (crisis-wave plan C1).
import { osvTransport } from "../src/services/advisories";
import { fakeOsv } from "./osv-fake";
osvTransport.fetch = fakeOsv();

// Nor CISA: the KEV download is answered "unavailable" unless a test passes its own feed (crisis-wave plan C3).
import { kevTransport } from "../src/services/kev";
kevTransport.fetch = (async () => new Response("offline in tests", { status: 503 })) as unknown as typeof fetch;

// Nor the npm and PyPI registries: fingerprint look-ups (ADR 0056) answer "unavailable" unless a test records its own.
import { registryTransport } from "../src/services/registry";
registryTransport.fetch = (async () => new Response("offline in tests", { status: 503 })) as unknown as typeof fetch;
