# schema.org 30.1 subset (AQ-09, ADR 0097)

`schemaorg-30.1-subset.json` is generated from the official vocabulary file
https://raw.githubusercontent.com/schemaorg/schemaorg/main/data/releases/30.1/schemaorg-current-https.jsonld
(schema.org 30.1, released 16 Sep 2026; fetched 28 Oct 2026). For Organization, ContactPoint, ImageObject, WebSite,
AboutPage, WebPage, SearchAction, EntryPoint and PropertyValueSpecification it lists every property allowed on the class
(its own and inherited, by `schema:domainIncludes`) and each property's `schema:rangeIncludes`. `test/organization.test.ts`
checks the home page's and /about's JSON-LD against it. Regenerate from the vocabulary file; don't hand-edit.
