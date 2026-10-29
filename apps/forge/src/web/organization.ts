// AQ-09 (ADR 0097): who we are, for search engines, as schema.org Organization data on the home page and /about. It
// tells The Agent Forge (theagentforge.io) apart from other products called "Agent Forge". sameAs lists only public
// profiles we own and that exist (checked 28 Oct 2026: GitHub organisation, npm organisation, X account). No legal
// name or founder: there is no registered company yet, and the founder isn't named on the site.

export const ORG_NAME = "The Agent Forge";
export const ORG_SAME_AS = [
  "https://github.com/theagentforge",
  "https://www.npmjs.com/org/theagentforge",
  "https://x.com/theagentforgeio",
] as const;
export const ORG_LOGO_PATH = "/brand/forge-logo-512.png";

export const orgId = (origin: string) => `${origin}/#organization`;

export function organization(origin: string, description: string) {
  return {
    "@type": "Organization",
    "@id": orgId(origin),
    name: ORG_NAME,
    alternateName: "theagentforge.io",
    url: `${origin}/`,
    logo: { "@type": "ImageObject", url: `${origin}${ORG_LOGO_PATH}`, contentUrl: `${origin}${ORG_LOGO_PATH}` },
    description,
    email: "hello@theagentforge.io",
    sameAs: [...ORG_SAME_AS],
    contactPoint: [
      { "@type": "ContactPoint", contactType: "investor relations", email: "partners@theagentforge.io" },
      { "@type": "ContactPoint", contactType: "partnerships", email: "partners@theagentforge.io" },
      { "@type": "ContactPoint", contactType: "press", email: "press@theagentforge.io" },
    ],
  };
}
