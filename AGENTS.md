# AGENTS.md

Conventions and context for any coding agent working in this repo.

## What this is

Two things that share source files but are **not** deployed the same way — see "Deployment reality" below before assuming anything runs through the Worker:

- **Landing page** — `index.html`, a single self-contained file (inline CSS/JS) for Zahabu Culture Garden. Uses the Futura font, a fixed watercolor background photo with a white wash overlay (kept light — the photo should stay prominent, not washed out), and a rotating coverflow-style menu carousel (All/Food/Drinks/Brunch tabs, autoplay, swipe, click-to-enlarge lightbox with prev/next) rendered from the menu PDFs. Layout: full-screen hero → centered About + disciplines marquee → Weekly Programming → Menus carousel → Community photos (hidden while `COMMUNITY_ENABLED` is false) → Visit card → footer. The fixed nav bar stays fully transparent on scroll (no background/blur, by request); its small logo fades in once you scroll past the hero. On phones the nav logo is hidden and links are centered, and "About" drops out below 440px so the links fit. There is no canvas/animation on this page — it was removed by request; don't reintroduce decorative canvas effects without asking.
- **Tech crew tracker** — `tracker.html`/`tracker.js`/`tracker.css`, an internal tool for logging who worked which event/date, backed by Cloudflare D1. `viewer.html`/`viewer.js` is the read-only counterpart served on `tracker-view.zahabu.co.ke`.

- **Community photos** — visitors submit photos from `index.html`'s "Moments at Zahabu" section; staff approve them at `photos.zahabu.co.ke/admin`; approved photos show in that section. Backend is `photos-worker.mjs`, a **separate** Worker (`zahabu-photos`, config `wrangler.photos.toml`) that shares the tracker's D1 database and stores images in R2. See "Community photos" below.

`worker.mjs` serves both (static assets from an embedded `ASSETS` map, plus the `/api/work-dates` REST endpoint for the tracker) **when deployed as a Cloudflare Worker**. In practice the public landing page is currently hosted on **GitHub Pages** instead (see below), which serves the raw files directly and never runs `worker.mjs` at all.

## Deployment reality

- **`zahabu.co.ke` is served by GitHub Pages** (repo: `Kimina-Santuri/zahabu-landing-page`), not the Cloudflare Worker. GitHub Pages just serves the raw repo files as static content — it never runs `build.mjs` or `worker.mjs`. This means `index.html`'s relative paths (`assets/...`, `images/...`, `fonts/...`) must resolve directly against files physically present in the repo root; nothing gets bundled/embedded for this path.
- The Cloudflare Worker + D1 path (`wrangler.toml`, `build.mjs` → `dist/server/index.js`) is a **separate, not-currently-live** deployment target for the tracker's database-backed features. `dist/` is gitignored, so it plays no part in the GitHub Pages site.
- A `CNAME` file at the repo root (containing `zahabu.co.ke`) is what points the custom domain at GitHub Pages — don't delete it.
- **Push through git, not GitHub's web upload UI.** This repo and the GitHub remote once had completely unrelated commit histories because files were being dragged/pasted into GitHub directly instead of pushed from here — that caused the `assets/` folder to go missing from production (never committed locally, so never pushed) and needed a `--allow-unrelated-histories` merge to fix. Always commit and `git push origin main` from this working copy.
- **After a push, give GitHub Pages' CDN a minute or two.** Right after a deploy, some edge nodes may briefly serve stale/incomplete responses for changed assets; a hard refresh (or waiting ~a minute) clears it. Don't assume a broken image right after pushing means the deploy failed — verify with `curl -sI <url>` and check headers/byte size before concluding something's wrong.

## Weekly Programming

- Section `#programming` in `index.html` (heading "Weekly programming", nav: "Programming"), between About and Menus. Transparent over the watercolor (no panel): one single-bordered row per recurring weekly night with day, night name, and that night's logo on the right. No artist names and no "Tonight" highlight, both by request.
- Night logos are in `images/events/` (`textures`, `interlude`, `jirani`, `rnb-live`, `sundowner`). They were cut out of the weekly poster: white logo pixels keyed to alpha and recoloured to ink `#141814` (PIL, per-logo thresholds, since each sat on a different photo background). For a new or changed night, ask for the logo as a PNG/SVG rather than re-keying from a poster; the poster versions are only ~180px wide.
- Tuesday alternates between Textures and Interlude: that row uses `.week-logos` (two logos with a divider; stacked on mobile) and a muted `.week-alt` second name. `interlude.png` was colour-keyed (green text on pink) from its own poster at ~720px, so it's sharper than the others.
- **Updating:** add/remove/reorder `<li class="week-night">` rows. New logo files must also be added to `build.mjs`'s `paths`.

## Community photos

- **Flow:** browser resizes/re-encodes each photo to JPEG (1800px full + 640px thumb) via canvas, which drops EXIF/GPS → `POST https://photos.zahabu.co.ke/api/photos` (multipart: `full_N`/`thumb_N`, `credit`, `consent=yes`, `cf-turnstile-response`) → Worker verifies Turnstile, origin, sizes, per-IP hourly limit, re-strips JPEG metadata server-side (`sanitizeJpeg`) and reads true dimensions from the SOF header → R2 (`full/<id>.jpg`, `thumb/<id>.jpg`) + D1 row with `status='pending'`.
- **Nothing is public until approved.** `/api/photos` and `/media/...` only return `approved` rows; pending images are only reachable under `/admin/media/...`.
- **Staff area is everything under `/admin`** (page, `/admin/api/...`, `/admin/media/...`) so a single Cloudflare Access application on path `admin` covers it. The Worker also verifies the `Cf-Access-Jwt-Assertion` JWT itself (signature against the team's certs, `aud`, `iss`, `exp`) and **fails closed** when `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` aren't set. `LOCAL_DEV` (set only by `preview.mjs`) bypasses this.
- **`COMMUNITY_ENABLED` in `index.html` must be `true` for the section to show at all.** It was shipped `false` because `TURNSTILE_SECRET` wasn't set on the Worker yet (uploads would fail the spam check). Set the secret with `npx wrangler secret put TURNSTILE_SECRET -c wrangler.photos.toml`, then flip the flag.
- **The landing page section stays hidden until `GET /api/photos` succeeds**, so `index.html` can be pushed to GitHub Pages before the Worker is live without showing a broken feature. The Community nav link is unhidden at the same time.
- **Config in `index.html`:** `PHOTO_API` and `TURNSTILE_SITE_KEY` constants near the community script. The production site key is the "Zahabu community photos" widget (hostname `zahabu.co.ke`, covers subdomains); locally it uses Cloudflare's always-pass test key.
- **Deploying:** `npm run build`, then `npx wrangler deploy -c wrangler.photos.toml`. Never deploy the photos code via `wrangler.toml` — that's the live tracker Worker (`zahabu-tech-tracker`) with real crew data, and it has its own routes.
- **One-time setup** (done in this order): enable R2 in the dashboard → `npx wrangler r2 bucket create zahabu-community-photos` → `npx wrangler d1 migrations apply zahabu-tracker --remote` (adds `community_photos` via `migrations/0003_community_photos.sql`; the live DB tracks applied migrations in `d1_migrations`) → create a Turnstile widget for `zahabu.co.ke` + `www.zahabu.co.ke`, put the site key in `index.html` and the secret in `npx wrangler secret put TURNSTILE_SECRET -c wrangler.photos.toml` → `npx wrangler secret put IP_SALT -c wrangler.photos.toml` (any long random string) → create a Zero Trust Access self-hosted app for `photos.zahabu.co.ke/admin` with a staff-email policy, copy its team domain and AUD tag into `wrangler.photos.toml` `[vars]` → deploy.

## File map

- `index.html` — landing page (markup + styles + scripts inline)
- `tracker.html`, `tracker.js`, `tracker.css` — crew tracker UI (editable, same-origin only)
- `viewer.html`, `viewer.js` — read-only tracker view
- `photos-worker.mjs` — community photos Worker (public submit/list/media API + Access-gated `/admin`); built into `dist/photos/index.js` with `PHOTO_ASSETS` (admin page files) prepended
- `admin.html`, `admin.js` — staff photo review page, served at `photos.zahabu.co.ke/admin`
- `wrangler.photos.toml` — config for the `zahabu-photos` Worker (custom domain, D1, R2 bucket, Access vars; secrets listed in comments)
- `local-bindings.mjs` — local stand-ins for D1 (`node:sqlite`) and R2 (files in `/private/tmp/zahabu-photos-preview`) used by `preview.mjs`/`verify.mjs`
- `worker.mjs` — Cloudflare Worker: serves static assets from an embedded `ASSETS` map and handles `/api/work-dates` (GET/PUT/DELETE) against D1
- `build.mjs` — bundles every file listed in its `paths` array as base64 into `dist/server/index.js` (prepended with `worker.mjs`'s source), plus copies `.openai/hosting.json` and `drizzle/` into `dist/.openai/`
- `db/schema.ts` — Drizzle ORM schema (single `work_dates` table)
- `drizzle.config.ts` / `drizzle/` — output of `drizzle-kit generate`; copied into the build for hosted deploys
- `migrations/` — the actual historical D1 migration sequence (`0001_initial.sql`, `0002_entry_details.sql` applied to the live database; `0003_community_photos.sql` adds the photos table); separate from `drizzle/`, which just reflects the current schema snapshot
- `verify.mjs` — sanity checks for persistence/validation logic
- `preview.mjs` — local dev server (`http://localhost:5173`) using a throwaway SQLite DB in `/private/tmp`; never touches hosted records
- `wrangler.toml` — Cloudflare Worker + D1 binding config
- `assets/` — `garden-background.jpg` (site background), `menu-food.pdf`/`menu-drinks.pdf`/`menu-brunch.pdf` (source menus), `menu-pages/*.jpg` (each PDF page pre-rendered to an image for the on-page gallery)
- `images/events/*.png` — transparent ink-coloured logos for each weekly night (Weekly Programming section)
- `images/logo-wordmark.png` — high-res (721×140) transparent ZAHABU wordmark used by `index.html`, tightly cropped (no padding). Extracted from the soft-masked logo image embedded in `assets/menu-food.pdf` page 2; if a sharper logo is ever needed, get an SVG from the designer rather than upscaling.
- `images/logo.png` — older low-res (180×180, padded) logo, still used by `tracker.html`/`viewer.html`; `images/favicon.ico`
- `fonts/Futura-Regular.ttf` — the only font used site-wide
- `CNAME` — GitHub Pages custom domain config (`zahabu.co.ke`); required for the domain to keep resolving, don't delete

## Commands

```
npm install
npm run db:generate   # regenerates drizzle/ from db/schema.ts
npm run build         # runs build.mjs -> dist/server/index.js
node verify.mjs        # checks persistence + validation
node preview.mjs        # local preview server, http://localhost:5173 (site, /tracker.html, /admin photo review)
```

Opening any HTML file directly (`file://`) does not provide database access — the tracker needs the Worker. Deploy through the hosting config (`.openai/hosting.json`) for the real thing.

## Gotchas learned the hard way

- **`preview.mjs` caches the build in memory.** It does a top-level `import worker from './dist/server/index.js'` once at startup. Running `node build.mjs` again does *not* hot-reload it — you must kill and restart `node preview.mjs` after every rebuild, or you'll be testing stale code.
- **`drizzle/` is stale and not regenerated.** Its snapshot only has the original 4-column `work_dates`; running `npm run db:generate` would emit a migration re-adding columns that already exist live. Treat `migrations/` as the source of truth; `db/schema.ts` is kept in sync by hand for reference.
- **Every static asset must be registered in `build.mjs`.** Adding a file to `assets/` or `images/` on disk does nothing by itself — it has to be added to the `paths` array in `build.mjs` (and its extension added to the `types` MIME map if it's a new file type), or the Worker will 404 on it.
- **Don't mix `align-items:center` with unpredictable content height on a fixed-height flex container.** `.hero` used to do this; once content grew taller than the box, flexbox centered it and pushed roughly half the content above the viewport into an area that isn't reachable by scrolling. Prefer `align-items:flex-start` with `min-height` when content length can vary.
- **Background layering**: `.bg-photo` (the photo) and `.bg-overlay` (white wash, currently kept fairly light — ~0.22 to 0.6 opacity top-to-bottom — so the photo stays prominent) are both `position:fixed; inset:0`, `z-index:-2`/`-1`, so they always cover the full viewport regardless of scroll or page height — this is intentional and shouldn't need "fixing" for coverage; if it ever looks like it doesn't fit, check `background-size`/`background-position`, not the positioning scheme. If asked to make the background "more prominent," lower the overlay's opacity values rather than touching the positioning.
- **Menu PDFs are duplicated as images.** If a menu PDF (`assets/menu-*.pdf`) changes, regenerate its page images into `assets/menu-pages/` (rendered via `pypdfium2`, ~1400px wide JPEGs) and update the corresponding `<button class="slide">` entries in `index.html`'s `#carousel` to match (each has `data-menu`/`data-page`/`data-pages`/`data-pdf`, and its `<img>` needs `style="--ar:<width/height>"` — the carousel sizes slides from that aspect ratio, e.g. `1.414` landscape A4, `.71` portrait) — the PDF and the on-page gallery are not linked automatically.
- **Editing access to the tracker API is locked to specific hosts** (`tracker.zahabu.co.ke`, `localhost`, `127.0.0.1`) with same-origin + `sec-fetch-site` checks in `worker.mjs`. `viewer.html` is served instead of `tracker.html`/`index.html` when the request hostname is `tracker-view.zahabu.co.ke`.
