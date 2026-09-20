# AGENTS.md

Conventions and context for any coding agent working in this repo.

## What this is

Two things sharing one Cloudflare Worker deployment:

- **Landing page** — `index.html`, a single self-contained file (inline CSS/JS) for Zahabu Culture Garden. Uses the Futura font, a fixed watercolor background photo with a white wash overlay, an animated canvas line-art effect, and a menu gallery (Food/Drinks/Brunch) rendered from PDFs with a click-to-enlarge lightbox.
- **Tech crew tracker** — `tracker.html`/`tracker.js`/`tracker.css`, an internal tool for logging who worked which event/date, backed by Cloudflare D1. `viewer.html`/`viewer.js` is the read-only counterpart served on `tracker-view.zahabu.co.ke`.

Both are served by one Worker (`worker.mjs`), which also exposes the `/api/work-dates` REST endpoint for the tracker.

## File map

- `index.html` — landing page (markup + styles + scripts inline)
- `tracker.html`, `tracker.js`, `tracker.css` — crew tracker UI (editable, same-origin only)
- `viewer.html`, `viewer.js` — read-only tracker view
- `worker.mjs` — Cloudflare Worker: serves static assets from an embedded `ASSETS` map and handles `/api/work-dates` (GET/PUT/DELETE) against D1
- `build.mjs` — bundles every file listed in its `paths` array as base64 into `dist/server/index.js` (prepended with `worker.mjs`'s source), plus copies `.openai/hosting.json` and `drizzle/` into `dist/.openai/`
- `db/schema.ts` — Drizzle ORM schema (single `work_dates` table)
- `drizzle.config.ts` / `drizzle/` — output of `drizzle-kit generate`; copied into the build for hosted deploys
- `migrations/` — the actual historical D1 migration sequence (`0001_initial.sql`, `0002_entry_details.sql`) already applied to the live database; separate from `drizzle/`, which just reflects the current schema snapshot
- `verify.mjs` — sanity checks for persistence/validation logic
- `preview.mjs` — local dev server (`http://localhost:5173`) using a throwaway SQLite DB in `/private/tmp`; never touches hosted records
- `wrangler.toml` — Cloudflare Worker + D1 binding config
- `assets/` — `garden-background.jpg` (site background), `menu-food.pdf`/`menu-drinks.pdf`/`menu-brunch.pdf` (source menus), `menu-pages/*.jpg` (each PDF page pre-rendered to an image for the on-page gallery)
- `images/logo.png` — transparent wordmark logo; `images/favicon.ico`
- `fonts/Futura-Regular.ttf` — the only font used site-wide

## Commands

```
npm install
npm run db:generate   # regenerates drizzle/ from db/schema.ts
npm run build         # runs build.mjs -> dist/server/index.js
node verify.mjs        # checks persistence + validation
node preview.mjs        # local preview server, http://localhost:5173
```

Opening any HTML file directly (`file://`) does not provide database access — the tracker needs the Worker. Deploy through the hosting config (`.openai/hosting.json`) for the real thing.

## Gotchas learned the hard way

- **`preview.mjs` caches the build in memory.** It does a top-level `import worker from './dist/server/index.js'` once at startup. Running `node build.mjs` again does *not* hot-reload it — you must kill and restart `node preview.mjs` after every rebuild, or you'll be testing stale code.
- **Every static asset must be registered in `build.mjs`.** Adding a file to `assets/` or `images/` on disk does nothing by itself — it has to be added to the `paths` array in `build.mjs` (and its extension added to the `types` MIME map if it's a new file type), or the Worker will 404 on it.
- **Don't mix `align-items:center` with unpredictable content height on a fixed-height flex container.** `.hero` used to do this; once content grew taller than the box, flexbox centered it and pushed roughly half the content above the viewport into an area that isn't reachable by scrolling. Prefer `align-items:flex-start` with `min-height` when content length can vary.
- **Background layering**: `.bg-photo` (the photo) and `.bg-overlay` (white wash) are both `position:fixed; inset:0`, `z-index:-2`/`-1`, so they always cover the full viewport regardless of scroll or page height — this is intentional and shouldn't need "fixing" for coverage; if it ever looks like it doesn't fit, check `background-size`/`background-position`, not the positioning scheme.
- **Menu PDFs are duplicated as images.** If a menu PDF (`assets/menu-*.pdf`) changes, regenerate its page images into `assets/menu-pages/` (rendered via `pypdfium2`, ~1400px wide JPEGs) and update the corresponding `<button class="menu-thumb">`/`<img>` pairs in `index.html` to match — the PDF and the on-page gallery are not linked automatically.
- **Editing access to the tracker API is locked to specific hosts** (`tracker.zahabu.co.ke`, `localhost`, `127.0.0.1`) with same-origin + `sec-fetch-site` checks in `worker.mjs`. `viewer.html` is served instead of `tracker.html`/`index.html` when the request hostname is `tracker-view.zahabu.co.ke`.
