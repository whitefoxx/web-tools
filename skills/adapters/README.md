# Reaching a site — build your own, we keep the base sharp

This project does **not** ship or maintain per-site extractors. Sites change
constantly; a catalog of site skills is a maintenance nightmare and the wrong
place to spend effort. What is maintained is the **base**: the generic browser
tools plus `eval_js` and the recon primitives (`find_structured_data` /
`get_a11y_tree` / `find_in_dom`), kept sharp enough that an agent works out any
site's specifics **live** — and a small number of hints for the couple of sites
where the obvious route actively fails.

So "a way to reach site X" is not something you install from here. It is
something your agent **builds once with the ladder below and you save into your
own skills directory** — data you own, portable across shells (both WebCLI and
localmd Connect expose the same `eval_js`). When the site changes, your agent
re-derives it from the same ladder. No shipped extension code, no upstream
catalog to fall out of date.

## Build one — the robustness ladder

Most sites need no pre-written recipe: with `eval_js` and the ladder below an
agent one-shots the extraction live. Stop at the first rung that works:

1. **The site's own JSON API** — `fetch(api, {credentials:'include'})` from
   inside the page. Zero selectors, most durable.
2. **Embedded page state** — `__NEXT_DATA__` / `__NUXT__` / a
   `<script type="application/json">` blob (use `find_structured_data`).
3. **The site's OWN UI as the data source**, when a private API is locked behind
   a token / signature / pot — drive the panel or list a person clicks and read
   the DOM. (A YouTube transcript comes from its "Show transcript" panel, not the
   pot-locked caption API.)
4. **Last resort: scrape the DOM** with STABLE selectors (`data-testid` / `aria` /
   semantic tags / `href`), never random build-hash classes. `get_a11y_tree` and
   `find_in_dom` help pick anchors.

Rules of thumb: **reduce to rows inside the page** — `eval_js` returns the data
you need, not the whole payload. A read that must POST (GraphQL / InnerTube)
needs `allow_write:true`. When it works, **save it as a skill in your own skills
directory** so next time is one call, not a rebuild — and so you, not an
upstream maintainer, own keeping it current.

## Keeping the base honest

The project runs a curated set of these tasks against common sites periodically —
not to ship the recipes, but to check the base is still good enough to derive
them. A probe breaking because a site changed is expected and not a bug; a probe
breaking because a base primitive can no longer express the route is a gap worth
fixing in the base.
