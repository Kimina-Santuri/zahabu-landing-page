# AGENTS.md

Conventions and context for any coding agent working in this repo.

## What this is

Four things that share source files but are **not** deployed the same way. Read "Deployment reality" below before assuming anything runs through a Worker:

- **Landing page** — `index.html`, a single self-contained file (inline CSS/JS) for Zahabu Culture Garden. Uses the Futura font, a fixed watercolor background photo with a white wash overlay (kept light — the photo should stay prominent, not washed out), and a rotating coverflow-style menu carousel (All/Food/Drinks/Brunch tabs, autoplay, swipe, click-to-enlarge lightbox with prev/next) rendered from the menu PDFs. Layout: full-screen hero → centered About + disciplines marquee → Weekly Programming → Menus carousel → Code of conduct (two posters, click-to-enlarge in the shared lightbox) → Community photos (hidden while `COMMUNITY_ENABLED` is false) → Visit card → footer. The fixed nav bar stays fully transparent on scroll (no background/blur, by request); its small logo fades in once you scroll past the hero. On phones the nav logo is hidden and links are centered, and "About" drops out below 440px so the links fit. There is no canvas/animation on this page — it was removed by request; don't reintroduce decorative canvas effects without asking.
- **Tech crew tracker** — `tracker.html`/`tracker.js`/`tracker.css`, an internal tool for logging who worked which event/date, backed by Cloudflare D1 and served by `worker.mjs` (Worker `zahabu-tech-tracker`, config `wrangler.toml`) at `tracker.zahabu.co.ke`. `viewer.html`/`viewer.js` is the read-only counterpart on `tracker-view.zahabu.co.ke`. See "Tech crew tracker" below.

- **Community photos** — visitors submit photos from `index.html`'s "Moments at Zahabu" section; staff approve them at `photos.zahabu.co.ke/admin`; approved photos show in that section. Backend is `photos-worker.mjs`, a **separate** Worker (`zahabu-photos`, config `wrangler.photos.toml`) that shares the tracker's D1 database and stores images in R2. See "Community photos" below.

- **Equipment inventory**: `inventory.html`/`inventory.js` + `inventory-worker.mjs`, a **separate** Worker (`zahabu-inventory`, config `wrangler.inventory.toml`) at `inventory.zahabu.co.ke`. It tracks gear with photos, condition, last tested/maintained dates and a per-item history. It shares the tracker's D1 database and keeps photos in its own R2 bucket. See "Equipment inventory" below.

`worker.mjs` serves static assets from an embedded `ASSETS` map (including a copy of the landing page) plus the `/api/work-dates` REST endpoint. The public landing page itself is hosted on **GitHub Pages** (see below), which serves the raw files directly and never runs `worker.mjs`.

## Deployment reality

- **`zahabu.co.ke` is served by GitHub Pages** (repo: `Kimina-Santuri/zahabu-landing-page`), not the Cloudflare Worker. GitHub Pages just serves the raw repo files as static content — it never runs `build.mjs` or `worker.mjs`. This means `index.html`'s relative paths (`assets/...`, `images/...`, `fonts/...`) must resolve directly against files physically present in the repo root; nothing gets bundled/embedded for this path.
- **Three Cloudflare Workers are live**, each deployed with wrangler from this working copy (never through GitHub): `zahabu-tech-tracker` (`wrangler.toml`: tracker, viewer), `zahabu-photos` (`wrangler.photos.toml`) and `zahabu-inventory` (`wrangler.inventory.toml`). All share the `zahabu-tracker` D1 database. Always `npm run build` first; `dist/` is gitignored and plays no part in the GitHub Pages site.
- **Deploying the tracker Worker ships every file in `build.mjs`'s `paths`**, not just the tracker files. Before deploying, check that the live files match what you expect. `tracker-view.zahabu.co.ke` is public, so `curl -s https://tracker-view.zahabu.co.ke/<file> | shasum` can be compared against the local file.
- **Pushing to GitHub doesn't deploy the Workers, and deploying a Worker doesn't need a push.** Commit either way so the repo matches what's live.
- A `CNAME` file at the repo root (containing `zahabu.co.ke`) is what points the custom domain at GitHub Pages — don't delete it.
- **Push through git, not GitHub's web upload UI.** This repo and the GitHub remote once had completely unrelated commit histories because files were being dragged/pasted into GitHub directly instead of pushed from here — that caused the `assets/` folder to go missing from production (never committed locally, so never pushed) and needed a `--allow-unrelated-histories` merge to fix. Always commit and `git push origin main` from this working copy.
- **After a push, give GitHub Pages' CDN a minute or two.** Right after a deploy, some edge nodes may briefly serve stale/incomplete responses for changed assets; a hard refresh (or waiting ~a minute) clears it. Don't assume a broken image right after pushing means the deploy failed — verify with `curl -sI <url>` and check headers/byte size before concluding something's wrong.

## Weekly Programming

- Section `#programming` in `index.html` (heading "Weekly programming", nav: "Programming"), between About and Menus. Transparent over the watercolor (no panel): one single-bordered row per recurring weekly night with day, night name, and that night's logo on the right. No artist names and no "Tonight" highlight, both by request.
- Night logos are in `images/events/` (`textures`, `interlude`, `jirani`, `rnb-live`, `sundowner`). They were cut out of the weekly poster: white logo pixels keyed to alpha and recoloured to ink `#141814` (PIL, per-logo thresholds, since each sat on a different photo background). For a new or changed night, ask for the logo as a PNG/SVG rather than re-keying from a poster; the poster versions are only ~180px wide.
- Tuesday alternates between Textures and Interlude: that row uses `.week-logos` (two logos with a divider; stacked on mobile) and a muted `.week-alt` second name. `interlude.png` was colour-keyed (green text on pink) from its own poster at ~720px, so it's sharper than the others.
- **Updating:** add/remove/reorder `<li class="week-night">` rows. New logo files must also be added to `build.mjs`'s `paths`.

## Code of conduct

- **Landing page:** section `#conduct` in `index.html` (between Menus and Community), with the English and Kiswahili posters side by side. Clicking a poster opens it in the shared lightbox (`posterLightbox` provider), and the arrows switch languages. A button and a footer link go to `code-of-conduct.html`. There's deliberately no nav link: on phones the nav already hides "About" to fit.
- **Full page:** `code-of-conduct.html` is self-contained and duplicates `index.html`'s font, colour tokens and background layers, so restyle both together. Its text comes from the staff `CoC.pdf`, with the "INTERNAL USE ONLY" banner and "Last update" date removed by request. Two layout choices differ from the PDF: the 1519 hotline line is a highlighted box, and the two non-"tolerate" items from that bullet list are plain paragraphs.
- **Updating:** if the wording changes, edit `code-of-conduct.html` by hand. If the posters change, replace `images/conduct/poster-en.jpg`/`poster-sw.jpg` (re-encode around quality 80, ~1131×1600) and keep the `width`/`height` attributes in `index.html` in sync.
- **Known issue:** the English poster image has typos ("communitities", "facilitites", and a missing comma in "transphobia or the like classism"). The fix needs a corrected image from the designer; don't try to patch the JPEG.
- The source `code-of-conduct/` folder (PDF + WhatsApp originals) is deliberately left uncommitted because the PDF is marked internal. Don't `git add` it.

## Tech crew tracker

- **Crew rule:** a work date needs at least one person (a lead tech, supports, or both). Each person may appear only once, and the form drops blank support fields. `worker.mjs` enforces the same rule. One entry per date.
- **List / Calendar:** work history has a toggle, remembered per browser in `localStorage`. The month grid lives in `tracker-calendar.js`, shared by the tracker and the viewer. On the tracker, clicking an entry opens it for editing and clicking an empty day starts a new entry for that date; on the viewer it jumps to the entry in the list. The calendar sizes itself with container queries on the history panel, because that panel is narrow beside the form on desktop; on phones it shows dots plus a list of the month's entries.
- **Look:** `tracker.css` (shared with the viewer) mirrors `index.html`: same colour tokens, watercolor `.bg-photo`/`.bg-overlay` layers and glass panels, so restyle them together.
- **Access:** `tracker.zahabu.co.ke` sits behind Cloudflare Access with Zoho sign-in for any `@zahabu.co.ke` address (see "Staff sign-in"). Everyone who gets in can add, edit and delete; there is no view-only role on the tracker itself.
- **Public read-only copies:** `tracker-view.zahabu.co.ke` and the Worker's `zahabu-tech-tracker.kimina-11d.workers.dev` address have no Access app, so anyone can read work dates and crew names there (never edit: writes are host-locked in `worker.mjs`). Putting the viewer behind Access and setting `workers_dev = false` has been offered but not done.
- **Deploying:** `npm run build && npx wrangler deploy` (uses `wrangler.toml`). This Worker holds the real crew data, so never point it at other code.

## Community photos

- **Flow:** browser resizes/re-encodes each photo to JPEG (1800px full + 640px thumb) via canvas, which drops EXIF/GPS → `POST https://photos.zahabu.co.ke/api/photos` (multipart: `full_N`/`thumb_N`, `credit`, `consent=yes`, `cf-turnstile-response`) → Worker verifies Turnstile, origin, sizes, per-IP hourly limit, re-strips JPEG metadata server-side (`sanitizeJpeg`) and reads true dimensions from the SOF header → R2 (`full/<id>.jpg`, `thumb/<id>.jpg`) + D1 row with `status='pending'`.
- **Nothing is public until approved.** `/api/photos` and `/media/...` only return `approved` rows; pending images are only reachable under `/admin/media/...`.
- **Staff area is everything under `/admin`** (page, `/admin/api/...`, `/admin/media/...`) so a single Cloudflare Access application on path `admin` covers it. The Worker also verifies the `Cf-Access-Jwt-Assertion` JWT itself (signature against the team's certs, `aud`, `iss`, `exp`) and **fails closed** when `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` aren't set. `LOCAL_DEV` (set only by `preview.mjs`) bypasses this.
- **`COMMUNITY_ENABLED` in `index.html` must be `true` for the section to show at all.** It was shipped `false` because `TURNSTILE_SECRET` wasn't set on the Worker yet (uploads would fail the spam check). Set the secret with `npx wrangler secret put TURNSTILE_SECRET -c wrangler.photos.toml`, then flip the flag.
- **The landing page section stays hidden until `GET /api/photos` succeeds**, so `index.html` can be pushed to GitHub Pages before the Worker is live without showing a broken feature. The Community nav link is unhidden at the same time.
- **Config in `index.html`:** `PHOTO_API` and `TURNSTILE_SITE_KEY` constants near the community script. The production site key is the "Zahabu community photos" widget (hostname `zahabu.co.ke`, covers subdomains); locally it uses Cloudflare's always-pass test key.
- **Deploying:** `npm run build`, then `npx wrangler deploy -c wrangler.photos.toml`. Never deploy the photos code via `wrangler.toml` — that's the live tracker Worker (`zahabu-tech-tracker`) with real crew data, and it has its own routes.
- **One-time setup** (done in this order): enable R2 in the dashboard → `npx wrangler r2 bucket create zahabu-community-photos` → `npx wrangler d1 migrations apply zahabu-tracker --remote` (adds `community_photos` via `migrations/0003_community_photos.sql`; the live DB tracks applied migrations in `d1_migrations`) → create a Turnstile widget for `zahabu.co.ke` + `www.zahabu.co.ke`, put the site key in `index.html` and the secret in `npx wrangler secret put TURNSTILE_SECRET -c wrangler.photos.toml` → `npx wrangler secret put IP_SALT -c wrangler.photos.toml` (any long random string) → create a Zero Trust Access self-hosted app for `photos.zahabu.co.ke/admin` with a staff-email policy, copy its team domain and AUD tag into `wrangler.photos.toml` `[vars]` → deploy.

## Equipment inventory

- **Access model:** one Cloudflare Access app covers the whole `inventory.zahabu.co.ke` host, and its policy should let in everyone who may *view*. The Worker re-verifies the JWT (it reuses `accessEmail` exported from `photos-worker.mjs`) and fails closed without `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD`. Editing is allowed only for emails in the `EDITOR_EMAILS` **secret** (comma-separated; `@domain` entries allow a whole domain). It's a secret rather than a `[vars]` entry because this repo is public. Writes also need same-origin.
- **Data:** `inventory_items` (one row per item; `quantity` covers identical units like 6× SM58), `inventory_photos` (R2 `full/<id>.jpg` + `thumb/<id>.jpg`, re-encoded in the browser and metadata-stripped server-side with `sanitizeJpeg`, same as community photos), and `inventory_log`. Logging a test/maintenance/repair moves `last_tested`/`last_maintained` forward (never back) and can change the condition, which writes its own `condition` log row. Removing a log entry doesn't roll those dates back; editors fix them in the item form.
- **"Check due":** computed in the browser. An item is due when `check_every_days` is set and the newer of its last tested/maintained dates is older than that interval. Retired items are never due.
- **Build:** `build.mjs` writes the page files to `dist/inventory-assets.js`, which `inventory-worker.mjs` imports. Wrangler's `main` is `inventory-worker.mjs` itself (unlike the other two Workers), so always `npm run build` before deploying.
- **Preview:** `node preview.mjs` also serves the inventory on `http://localhost:5174/` as an editor; `INVENTORY_ROLE=viewer node preview.mjs` previews the read-only view.
- **Live setup (done 2026-10-12):** Access app `inventory` uses the reusable "Zahabu staff (@zahabu.co.ke)" policy, and `EDITOR_EMAILS` is `@zahabu.co.ke`, so every staff address can view *and* edit. To make someone view-only later, replace the secret with an explicit list of editor emails.
- **One-time setup** (already done; kept for reference): `npx wrangler r2 bucket create zahabu-inventory` → `npx wrangler d1 migrations apply zahabu-tracker --remote` (adds `migrations/0004_inventory.sql`) → create a Zero Trust Access self-hosted app for `inventory.zahabu.co.ke` with a policy for crew + viewers, then put its AUD tag in `wrangler.inventory.toml` → `npx wrangler secret put EDITOR_EMAILS -c wrangler.inventory.toml` → `npm run build && npx wrangler deploy -c wrangler.inventory.toml`.

## Staff sign-in (Cloudflare Access)

- **Team domain:** `muddy-fire-042e.cloudflareaccess.com`. Apps: `tracker` (`tracker.zahabu.co.ke`), `inventory` (`inventory.zahabu.co.ke`), `photos` (`photos.zahabu.co.ke/admin`). All three use the reusable policy "Zahabu staff (@zahabu.co.ke)". The older "Zahabu crew" policy (only `kimina@santuri.org`) is no longer attached to anything.
- **Tracker and inventory use "Sign in with Zoho" only, with instant authentication** (switched 2026-10-12). `zahabu.co.ke` mail is on Zoho, which held back Cloudflare's one-time-PIN emails, so the first code often never arrived. The login method "Zoho" is a generic OpenID Connect provider: Zoho API Console client "Zahabu Staff Login", owned by kimina@zahabu.co.ke, `.com` data-centre endpoints (`accounts.zoho.com/oauth/v2/auth`, `/token`, `/keys`), PKCE on, scopes `openid email profile`. Its client secret lives only in Cloudflare and Zoho, never in this repo.
- **The photos admin still accepts all login methods** (Zoho or one-time PIN). Switching it means editing the app's Login methods to Zoho only.
- **Access sees each person's primary Zoho address**, which may differ from the alias they think of as theirs: kimina@zahabu.co.ke signs in as `superadmin@zahabu.co.ke`. That primary address is what shows in the inventory's history and "Updated by".
- Each Worker re-verifies the Access JWT itself and fails closed if `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` are missing (photos and inventory; the tracker relies on Access in front of it plus its host lock).

## File map

- `index.html` — landing page (markup + styles + scripts inline)
- `code-of-conduct.html` — standalone page with the full Code of Conduct text (transcribed from the staff `CoC.pdf`; edit the HTML directly when the wording changes). Linked from the landing page's conduct section and footer.
- `images/conduct/poster-en.jpg`, `poster-sw.jpg` — English/Kiswahili "Respect. Consent. Care." posters shown on the landing page (re-encoded from the designer's WhatsApp JPEGs). The source `code-of-conduct/` folder is not committed — the PDF is marked internal.
- `tracker.html`, `tracker.js`, `tracker.css` — crew tracker UI (editable, same-origin only)
- `tracker-calendar.js`: List/Calendar toggle and month grid, used by both `tracker.html` and `viewer.html`
- `viewer.html`, `viewer.js` — read-only tracker view
- `photos-worker.mjs` — community photos Worker (public submit/list/media API + Access-gated `/admin`); built into `dist/photos/index.js` with `PHOTO_ASSETS` (admin page files) prepended
- `admin.html`, `admin.js` — staff photo review page, served at `photos.zahabu.co.ke/admin`
- `inventory.html`, `inventory.js`: equipment inventory page (list, filters, detail, edit/log/photo forms, CSV export)
- `inventory-worker.mjs`: equipment inventory Worker (Access-gated API + media + page); `wrangler.inventory.toml` is its config
- `wrangler.photos.toml` — config for the `zahabu-photos` Worker (custom domain, D1, R2 bucket, Access vars; secrets listed in comments)
- `local-bindings.mjs` — local stand-ins for D1 (`node:sqlite`) and R2 (files in `/private/tmp/zahabu-photos-preview` and `/private/tmp/zahabu-inventory-preview`) used by `preview.mjs`/`verify.mjs`
- `worker.mjs` — Cloudflare Worker: serves static assets from an embedded `ASSETS` map and handles `/api/work-dates` (GET/PUT/DELETE) against D1
- `build.mjs` — bundles every file listed in its `paths` array as base64 into `dist/server/index.js` (prepended with `worker.mjs`'s source), plus copies `.openai/hosting.json` and `drizzle/` into `dist/.openai/`
- `db/schema.ts` — Drizzle ORM schema (single `work_dates` table)
- `drizzle.config.ts` / `drizzle/` — output of `drizzle-kit generate`; copied into the build for hosted deploys
- `migrations/`: the actual D1 migration sequence, all applied to the live database (`0001_initial.sql`, `0002_entry_details.sql`, `0003_community_photos.sql`, `0004_inventory.sql`). Separate from `drizzle/`, which is a stale snapshot
- `verify.mjs` — sanity checks for persistence/validation logic
- `preview.mjs` — local dev servers (`http://localhost:5173` for site/tracker/photos admin, `:5174` for the inventory) using a throwaway SQLite DB in `/private/tmp/zahabu-tracker-preview.sqlite` (delete it for a fresh start); applies `drizzle/` then the `migrations/` files it needs; never touches hosted records
- `wrangler.toml` — config for the live `zahabu-tech-tracker` Worker (tracker + viewer) and its D1 binding
- `assets/` — `garden-background.jpg` (site background), `menu-food.pdf`/`menu-drinks.pdf`/`menu-brunch.pdf` (source menus), `menu-pages/*.jpg` (each PDF page pre-rendered to an image for the on-page gallery)
- `images/events/*.png` — transparent ink-coloured logos for each weekly night (Weekly Programming section)
- `images/logo-wordmark.png` — high-res (721×140) transparent ZAHABU wordmark used by `index.html`, the tracker, viewer, inventory and photos admin, tightly cropped (no padding). Extracted from the soft-masked logo image embedded in `assets/menu-food.pdf` page 2; if a sharper logo is ever needed, get an SVG from the designer rather than upscaling.
- `images/logo.png` — older low-res (180×180, padded) logo, no longer used by any page but still bundled by `build.mjs`; `images/favicon.ico`
- `fonts/Futura-Regular.ttf` — the only font used site-wide
- `CNAME` — GitHub Pages custom domain config (`zahabu.co.ke`); required for the domain to keep resolving, don't delete

## Commands

```
npm install
npm run db:generate   # regenerates drizzle/ from db/schema.ts
npm run build         # runs build.mjs -> dist/server/index.js
node verify.mjs        # checks tracker, photos and inventory logic (run after npm run build)
node preview.mjs        # local preview server, http://localhost:5173 (site, /tracker.html, /admin photo review) + :5174 (inventory)
```

Opening any HTML file directly (`file://`) does not provide database access — the tracker needs the Worker. Deploy commands are in each Worker's section above.

## Gotchas learned the hard way

- **Headless Chrome screenshots of `index.html` come out blank on this Mac.** The fixed background layers don't render, and the full-viewport hero fills any tall window. To check visuals, use a real browser (Claude in Chrome against `python3 -m http.server`, which serves files exactly as GitHub Pages does). `code-of-conduct.html` screenshots fine headless.
- **`preview.mjs` caches the build in memory.** It imports `dist/server/index.js`, `dist/photos/index.js` and (via `inventory-worker.mjs`) `dist/inventory-assets.js` once at startup. Running `node build.mjs` again does *not* hot-reload it — you must kill and restart `node preview.mjs` after every rebuild, or you'll be testing stale code.
- **`drizzle/` is stale and not regenerated.** Its snapshot only has the original 4-column `work_dates`; running `npm run db:generate` would emit a migration re-adding columns that already exist live. Treat `migrations/` as the source of truth; `db/schema.ts` is kept in sync by hand for reference.
- **Every static asset must be registered in `build.mjs`.** Adding a file to `assets/` or `images/` on disk does nothing by itself — it has to be added to the `paths` array in `build.mjs` (and its extension added to the `types` MIME map if it's a new file type), or the Worker will 404 on it.
- **Don't mix `align-items:center` with unpredictable content height on a fixed-height flex container.** `.hero` used to do this; once content grew taller than the box, flexbox centered it and pushed roughly half the content above the viewport into an area that isn't reachable by scrolling. Prefer `align-items:flex-start` with `min-height` when content length can vary.
- **Background layering**: `.bg-photo` (the photo) and `.bg-overlay` (white wash, currently kept fairly light — ~0.22 to 0.6 opacity top-to-bottom — so the photo stays prominent) are both `position:fixed; inset:0`, `z-index:-2`/`-1`, so they always cover the full viewport regardless of scroll or page height — this is intentional and shouldn't need "fixing" for coverage; if it ever looks like it doesn't fit, check `background-size`/`background-position`, not the positioning scheme. If asked to make the background "more prominent," lower the overlay's opacity values rather than touching the positioning.
- **Menu PDFs are duplicated as images.** If a menu PDF (`assets/menu-*.pdf`) changes, regenerate its page images into `assets/menu-pages/` (rendered via `pypdfium2`, ~1400px wide JPEGs) and update the corresponding `<button class="slide">` entries in `index.html`'s `#carousel` to match (each has `data-menu`/`data-page`/`data-pages`/`data-pdf`, and its `<img>` needs `style="--ar:<width/height>"` — the carousel sizes slides from that aspect ratio, e.g. `1.414` landscape A4, `.71` portrait) — the PDF and the on-page gallery are not linked automatically.
- **Editing access to the tracker API is locked to specific hosts** (`tracker.zahabu.co.ke`, `localhost`, `127.0.0.1`) with same-origin + `sec-fetch-site` checks in `worker.mjs`. `viewer.html` is served instead of `index.html` at `/` when the request hostname is `tracker-view.zahabu.co.ke`; on `tracker.zahabu.co.ke` the tracker is at `/tracker.html` (`/` serves the Worker's copy of the landing page).
