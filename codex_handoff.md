# Ministering Visualizer — Codex Handoff

## Current status

This is a vanilla browser-based ministering assignment editor. The working branch is `main`, the GitHub remote is `https://github.com/adamulrich/ministering-visualizer.git`, and the latest known commit is `ef6c151`.

The app is deployed as a Render Node web service using `render.yaml`. The Render free plan can cold-start, so the normal **How it works** link opens an inline client-side view at `#how-to` instead of navigating to another server request. `/how-to.html` remains as a standalone fallback.

## Run and validate locally

```powershell
npm install
npm start
```

Open `http://localhost:8081` (the README still says 8080; `server.js` uses 8081 by default). Render supplies `PORT` in production.

Useful checks:

```powershell
node --experimental-default-type=module --check static/app.js
git diff --check
```

Do not commit `.env`; it is ignored and contains MongoDB/Geocodio settings.

## Important files

- `server.js` — static file server and `/api/geocode` endpoint.
- `static/index.html` — editor shell, upload controls, modal dialogs, inline help view.
- `static/app.js` — all state, parsing, rendering, drag/drop, imports, exports, route merging, geocoding, and help-view behavior.
- `static/styles.css` — editor layout, fullscreen readiness panels, route styling, inline help page, and image lightbox.
- `static/how-to.html` — standalone copy of the workflow guide. Keep it synchronized with the inline help content in `index.html` when changing workflow instructions.
- `static/images/` — workflow screenshots.
- `static/content/unassigned - ministering - blank.xlsx` — blank workbook template.
- `render.yaml` — Render deployment configuration.

## State model

The central `state` object in `static/app.js` contains:

- `districts[]`
  - `id`, `name`, `routes[]`
  - routes have stable `id`, display `name`, `notes`, `locked`, `ministers[]`, `households[]`, and source metadata.
- `unassignedMinisters[]`
- `unassignedHouseholds[]`
- `bucketViews`, `bucketPanels`, `bucketFilters`
- diagram filters and dirty/save state.

Minister records preserve `id`, name, age, address, readiness, geocoding fields, and source data. Household records additionally preserve members, `assign` (`Must`, `Should`, `Nice`, or `No`), `highNeeds`, readiness, geocoding, and `keepUnassigned`.

Never use route display names as identity keys. Route names change when ministers change. Use stable route IDs and `findRoute()`/`routeDistrict()`.

## Import and preservation rules

### PDF imports

`handlePdf()` calls `parsePdf()`.

- If there is no existing diagram, the parsed PDF becomes the initial diagram.
- If a diagram/progress file already exists, `mergePdfIntoWorkspace()` treats the new PDF as authoritative for district/route membership.
- New PDF routes replace the old route structure while matching existing routes where possible.
- Existing minister/household objects are reused so metadata survives: readiness, household assignment preference, high-needs state, geocoding, IDs, route notes, and locks on matched routes.
- People/households no longer present in the latest PDF are moved to the appropriate unassigned bucket instead of being deleted.
- Route matching uses minister identity sets, route names, and household overlap. Household matching uses members, head name, address, and normalized name.

This is intentionally non-destructive: the PDF controls the current route relationships, while the existing records provide the editable metadata.

### Unassigned workbook imports

`handleWorkbook(file, restoreProgress)` has two modes:

- The normal **Import** control reconciles the unassigned tabs by normalized name. Matched records retain current readiness, assignment, high-needs, member, geocoding, and retention state.
- Records absent from the new workbook are removed unless `keepUnassigned` is true. The import toast reports removals and retained records.
- A workbook missing one category tab leaves that category unchanged. An explicitly present empty tab clears that category, except for retained records.
- The **Load progress** control passes `restoreProgress = true` and restores the complete `Progress` snapshot, including diagram structure and current view settings.

`keepUnassigned` protects in-flight work. It is set automatically when a record is moved from a route into an unassigned bucket, when readiness/assignment/high-needs is edited there, when a route is dissolved, or when a PDF refresh moves a record out of a route. The 📌 control toggles it manually. It is included in saved progress and unassigned workbook exports.

## Editor behavior

- Drag/drop uses stable item IDs and route IDs.
- Sidebar drops always go to the ready unassigned bucket and ignore the visible ready/not-ready tab.
- Locked routes reject person/household moves and dissolving.
- Empty routes remain visible.
- Routes can move between districts, be created with `+ Route`, and show newest routes at the top.
- Route names are generated from minister last names; route labels are not identity keys.
- Household rows have assignment dropdowns, high-needs `H`, keep-through-refresh 📌, readiness, and move controls as applicable.
- Route tools include 🗺️ map, 📝 notes, padlock, and dissolve.
- Household and minister readiness panels support search, expand/collapse, and fullscreen. Escape exits fullscreen.
- The diagram supports search, district filtering, multi-select household-count filtering from 0–6, and household sorting by name/high-needs.
- Browser navigation away from dirty work prompts beforeunload protection.

## Export format

`downloadWorkbook()` creates a formatted workbook with:

- `Assignments` — current district/route relationships, route notes, lock state, household assignment, high-needs, members, and hidden stable `RouteId`.
- `Unassigned Ministers` — includes readiness and `Keep`.
- `Unassigned Households` — includes assignment, high-needs, readiness, and `Keep`.
- `Progress` — chunked JSON state used for complete restore.

Downloads are named `ministering-progress-MM-DD-YY-HHMM.xlsx` using the browser’s local time.

## Geocoding and maps

Route maps call `POST /api/geocode` only when opened. `server.js` checks the MongoDB `geo_units.geocode_cache` collection first, keeps an in-memory cache, and sends misses to Geocodio. Ministers use green markers; households use amber markers.

Render must have `MONGO_URI` and `GEOCODIO_API_KEY` configured as environment variables. Do not expose these values in source or documentation.

## Known caveats

- PDF parsing depends on the LCR report’s current column layout: ministers on the left, household cards in the middle, members on the right, dotted route separators.
- Household matching is strongest when member names or addresses are present. Duplicate surnames without those fields are inherently ambiguous.
- The inline guide and standalone `how-to.html` intentionally duplicate content; update both when changing the workflow instructions.
- Browser-based visual QA may not be available in every agent session. Always run syntax and diff checks, then verify the local HTTP responses for `/`, `/how-to.html`, images, and the workbook template.
- Render’s free service may sleep. Avoid adding separate page navigations for frequently used static UI when an inline/client-side view is practical.

## Safe next-work checklist

1. Read this file and inspect `git status` before changing behavior.
2. Preserve stable IDs and metadata when touching import/merge logic.
3. Test both a raw two-tab workbook and a saved progress workbook.
4. Test PDF refresh over a progress state with moved people, route notes, locks, readiness, assignment preferences, high-needs flags, and retained unassigned records.
5. Run `node --experimental-default-type=module --check static/app.js` and `git diff --check`.
6. Keep `.env` out of commits and verify Render environment variables separately.
