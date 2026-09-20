# Zahabu Culture Garden

The original landing page is `index.html`. The crew tracker is `tracker.html`.

The tracker records one lead tech and at least two distinct support staff per date. Entries can be edited or deleted, and names from past entries are suggested. One entry is allowed per date. Records are stored in Cloudflare D1 when hosted through Sites; site access is private by default.

## Development

Run `npm install`, `npm run db:generate`, and `npm run build`. Run `node verify.mjs` to check persistence and validation. Run `node preview.mjs` for a local preview at `http://localhost:5173/tracker.html`. The preview uses a separate SQLite database in `/private/tmp`; it does not change hosted records.

Opening the HTML directly does not provide database access. Deploy the Worker and generated migrations through Sites for online use. The hosting configuration is `.openai/hosting.json`.
