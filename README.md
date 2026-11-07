# Ministering Visualizer

An in-browser editor for ministering assignment routes.

## Run locally

```powershell
npm install
npm start
```

Open `http://localhost:8080`.

The PDF and workbook are parsed locally in the browser. The PDF parser uses the report layout: minister cards on the left, household cards in the middle, household members on the right, and dotted separators between routes. The workbook importer looks for `Unassigned Ministers` and `Unassigned Households` tabs. Export creates an `Assignments` tab plus the two unassigned buckets.

## Geocoding and route maps

The local `.env` contains the copied Geocodio and MongoDB settings from `geo-units-app`. Route maps call the local `/api/geocode` endpoint on demand. That endpoint checks the shared `geo_units.geocode_cache` collection first, keeps an in-memory cache for the running process, and sends only cache misses to Geocodio. The route map uses green markers for ministers and amber markers for households.

Use `Save progress` to download a resumable workbook. It includes the editable state in a `Progress` tab, and importing that workbook restores routes, locks, readiness, high-needs flags, unassigned lists, and current view settings.
