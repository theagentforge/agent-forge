// Crawl hygiene (ADR 0060, Search Console 26 Oct). Links to action URLs (sign-in, the report form, claims, disputes,
// checks, the dashboard) are for people who mean to act, not for crawlers: they carry rel="nofollow", a hint that
// keeps Googlebot from spending crawl on thousands of form and sign-in URLs. The URLs themselves keep their robots.txt
// rule or their noindex as before; nofollow only changes how the link is counted and followed.

/**
 * Paths that are actions, not content. `/reports/...` (publications) and `/check` itself are content and stay followed.
 * Admin pages are left alone: only admins see their links, and robots.txt already keeps crawlers out.
 */
const ACTION_PATH = /^\/(?:report(?=$|[?#])|auth\/|claim(?=$|[?#/])|disputes(?=$|[?#/])|check\?|dashboard(?=$|[?#/])|authorize(?=$|[?#/])|oauth\/|callback(?=$|[?#/])|gauntlet\/claim(?=$|[?#/]))/;

/** True when an href (root-relative, or absolute on our origin) points at an action URL. */
export function isActionHref(href: string, origin: string): boolean {
  const h = href.replace(/&amp;/g, "&");
  const path = h.startsWith(origin) ? h.slice(origin.length) || "/" : h;
  return path.startsWith("/") && !path.startsWith("//") && ACTION_PATH.test(path);
}

/** Adds rel="nofollow" to every <a> in the page whose href is an action URL, keeping any rel it already has. */
export function nofollowActionLinks(page: string, origin: string): string {
  return page.replace(/<a\b[^>]*>/g, (tag) => {
    const href = /\shref="([^"]*)"/.exec(tag)?.[1];
    if (href === undefined || !isActionHref(href, origin)) return tag;
    const rel = /\srel="([^"]*)"/.exec(tag);
    if (!rel) return tag.replace(/^<a\b/, '<a rel="nofollow"');
    if (rel[1]!.split(/\s+/).includes("nofollow")) return tag;
    return tag.replace(rel[0], ` rel="${`${rel[1]} nofollow`.trim()}"`);
  });
}
