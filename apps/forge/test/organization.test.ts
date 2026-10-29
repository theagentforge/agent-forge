import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import vocab from "./fixtures/schemaorg-30.1-subset.json";
import { ORG_LOGO_PATH, ORG_SAME_AS } from "../src/web/organization";
import { fetchWorker } from "./helpers";
import "../src/index";

// AQ-09 (ADR 0097): Organization structured data on / and /about, checked against the schema.org 30.1 vocabulary
// (fixtures/schemaorg-30.1-subset.README.md): every type is known, every property is allowed on its type, and every
// value fits the property's range.

type Cls = { ancestors: string[]; properties: string[] };
const classes = vocab.classes as Record<string, Cls>;
const ranges = vocab.ranges as Record<string, string[]>;
const DATA_TYPES = new Set(["Text", "URL", "Date", "DateTime", "Number", "Integer", "Boolean"]);

function errorsOf(node: Record<string, unknown>, path: string, ids: Map<string, string>): string[] {
  const type = node["@type"] as string | undefined;
  if (!type) return "@id" in node && Object.keys(node).length === 1 ? [] : [`${path}: no @type`];
  const cls = classes[type];
  if (!cls) return [`${path}: unknown type ${type}`];
  const out: string[] = [];
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("@")) continue;
    // SearchAction's "query-input" is Google's documented annotation of `query`, not a vocabulary property.
    if (type === "SearchAction" && k === "query-input") continue;
    if (!cls.properties.includes(k)) {
      out.push(`${path}.${k}: not a property of ${type}`);
      continue;
    }
    const range = ranges[k] ?? [];
    for (const [i, item] of (Array.isArray(v) ? v : [v]).entries()) {
      const at = `${path}.${k}[${i}]`;
      if (typeof item === "string") {
        if (range.includes("URL") && /^https:\/\//.test(item)) continue;
        if (range.includes("Text") || range.includes("EntryPoint")) continue;
        out.push(`${at}: text not in range ${range.join("|")}`);
      } else if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        const ref = o["@id"] as string | undefined;
        const t = (o["@type"] as string | undefined) ?? (ref ? ids.get(ref) : undefined);
        if (!t) out.push(`${at}: object without a type`);
        else if (![t, ...(classes[t]?.ancestors ?? [])].some((x) => range.includes(x) || (range.includes("Thing") && !DATA_TYPES.has(x)))) out.push(`${at}: ${t} not in range ${range.join("|")}`);
        if (o["@type"]) out.push(...errorsOf(o, at, ids));
      } else out.push(`${at}: unexpected value`);
    }
  }
  return out;
}

async function ldOf(path: string) {
  const html = await (await fetchWorker(path)).text();
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  expect(m, `${path} has JSON-LD`).toBeTruthy();
  return JSON.parse(m![1]!) as { "@context": string; "@graph": Record<string, unknown>[] };
}

describe("Organization structured data", () => {
  for (const path of ["/", "/about"]) {
    it(`${path}: a valid schema.org Organization with our name, url, logo and real profiles`, async () => {
      const ld = await ldOf(path);
      expect(ld["@context"]).toBe("https://schema.org");
      const ids = new Map(ld["@graph"].map((n) => [n["@id"] as string, n["@type"] as string]));
      for (const node of ld["@graph"]) expect(errorsOf(node, String(node["@type"]), ids)).toEqual([]);
      const org = ld["@graph"].find((n) => n["@type"] === "Organization")!;
      expect(org.name).toBe("The Agent Forge");
      expect(org.url).toMatch(/^https:\/\/[^/]+\/$/);
      expect((org.logo as { url: string }).url).toMatch(new RegExp(`${ORG_LOGO_PATH}$`));
      expect(org.sameAs).toEqual([...ORG_SAME_AS]);
      expect(org).not.toHaveProperty("legalName");
      expect(org).not.toHaveProperty("founder");
      // The other node points at it.
      const other = ld["@graph"].find((n) => n["@type"] !== "Organization")!;
      expect(JSON.stringify(other)).toContain(`"@id":"${org["@id"]}"`);
    });
  }

  it("the validator catches what it should, and the logo file is served", async () => {
    const ids = new Map<string, string>();
    expect(errorsOf({ "@type": "Organization", nmae: "x" }, "o", ids)).toEqual(["o.nmae: not a property of Organization"]);
    expect(errorsOf({ "@type": "Organization", sameAs: "not a url" }, "o", ids)).toHaveLength(1);
    expect(errorsOf({ "@type": "Organization", logo: { "@type": "ContactPoint" } }, "o", ids)).toHaveLength(1);
    expect(errorsOf({ "@type": "Organisation" }, "o", ids)).toEqual(["o: unknown type Organisation"]);
    const logo = await env.ASSETS.fetch(new Request(`https://assets.local${ORG_LOGO_PATH}`));
    expect(logo.status).toBe(200);
    expect(logo.headers.get("Content-Type")).toContain("image/png");
  });
});
