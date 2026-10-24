import ghsa from "./fixtures/osv/ghsa-lodash-4.17.20.json";
import mal from "./fixtures/osv/mal-litellm-1.107.0.json";
import none from "./fixtures/osv/none.json";

/**
 * A recorded OSV: litellm 1.107.0 has a malicious-package record, lodash 4.17.20 a vulnerability fixed in 4.17.21,
 * everything else nothing. Answers /query, /querybatch and /vulns/<id>, and records each URL it was asked.
 */
export function fakeOsv(calls: string[] = []) {
  const byId = new Map([...mal.vulns, ...ghsa.vulns].map((v) => [v.id, v]));
  const pick = (q: { package: { name: string }; version?: string }) =>
    q.package.name === "litellm" && (!q.version || q.version === "1.107.0") ? mal : q.package.name === "lodash" && (!q.version || q.version === "4.17.20") ? ghsa : none;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.endsWith("/query")) return Response.json(pick(body));
    if (url.endsWith("/querybatch"))
      return Response.json({ results: body.queries.map((q: never) => ({ vulns: ((pick(q) as { vulns?: { id: string; modified: string }[] }).vulns ?? []).map((v) => ({ id: v.id, modified: v.modified })) })) });
    const id = decodeURIComponent(url.split("/vulns/")[1] ?? "");
    return byId.has(id) ? Response.json(byId.get(id)) : new Response("not found", { status: 404 });
  }) as typeof fetch;
}
