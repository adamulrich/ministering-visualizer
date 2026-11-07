import * as pdfjsLib from "/vendor/pdfjs-dist/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs-dist/build/pdf.worker.mjs";
const spreadsheetLib = window.XLSX;

const state = {
  districts: [],
  unassignedMinisters: [],
  unassignedHouseholds: [],
  bucketViews: { minister: "not-ready", household: "not-ready" },
  pdfLoaded: false,
  workbookLoaded: false,
  isDirty: false,
  filters: { search: "", district: "all", households: [], householdsAny: true, sort: "name", showEmpty: false },
  nextId: 1,
};
let activeDrag = null;

const $ = (id) => document.getElementById(id);
const els = {
  diagram: $("diagram"),
  emptyState: $("empty-state"),
  pdfInput: $("pdf-input"),
  xlsxInput: $("xlsx-input"),
  progressInput: $("progress-input"),
  pdfDropzone: $("pdf-dropzone"),
  xlsxDropzone: $("xlsx-dropzone"),
  pdfStatus: $("pdf-status"),
  xlsxStatus: $("xlsx-status"),
  search: $("search-input"),
  district: $("district-filter"),
  householdFilter: $("household-filter"),
  householdFilterMenu: $("household-filter-menu"),
  householdFilterButton: $("household-filter-button"),
  householdFilterPopover: $("household-filter-popover"),
  householdSort: $("household-sort"),
  showEmpty: $("show-empty-toggle"),
  unassignedMinisters: $("unassigned-ministers"),
  unassignedHouseholds: $("unassigned-households"),
  toast: $("toast"),
  modalBackdrop: $("modal-backdrop"),
  modalCopy: $("modal-copy"),
  modalConfirm: $("modal-confirm"),
  modalCancel: $("modal-cancel"),
  mapBackdrop: $("map-backdrop"),
  mapTitle: $("map-title"),
  mapStatus: $("map-status"),
  mapCounts: $("map-counts"),
  mapClose: $("map-close"),
  routeMap: $("route-map"),
  ministerSearch: $("minister-search"),
  householdSearch: $("household-search"),
};

const uid = (prefix) => `${prefix}-${state.nextId++}-${Math.random().toString(36).slice(2, 7)}`;
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const esc = (value) => clean(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
const initial = (value) => clean(value).split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
const normalize = (value) => clean(value).toLowerCase();
const matches = (value, search) => normalize(value).includes(normalize(search));
const memberDisplayName = (member) => clean(typeof member === "string" ? member : member?.name).replace(/\s+(Male|Female)\s+\d{1,2}\s+[A-Za-z]+$/i, "").trim();

function updateSaveStatus() {
  const status = $("save-status");
  if (!status) return;
  status.textContent = state.isDirty ? "Unsaved changes" : "Saved";
  status.classList.toggle("is-dirty", state.isDirty);
}

function markDirty() {
  state.isDirty = true;
  updateSaveStatus();
}

function toast(message, tone = "normal") {
  els.toast.textContent = message;
  els.toast.style.background = tone === "error" ? "#9c493e" : "#1e3832";
  els.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove("show"), 3200);
}

function routeCount() { return state.districts.reduce((sum, district) => sum + district.routes.length, 0); }
function allRoutes() { return state.districts.flatMap((district) => district.routes); }
function allAssignedMinisters() { return allRoutes().flatMap((route) => route.ministers); }
function allAssignedHouseholds() { return allRoutes().flatMap((route) => route.households); }
function findRoute(routeId) { return allRoutes().find((route) => route.id === routeId); }
function findDistrict(districtId) { return state.districts.find((district) => district.id === districtId); }
function routeDistrict(routeId) { return state.districts.find((district) => district.routes.some((route) => route.id === routeId)); }
function routeForItem(kind, itemId) {
  return allRoutes().find((route) => route[kind === "minister" ? "ministers" : "households"].some((item) => item.id === itemId));
}
function householdFilterValues(value) {
  if (Array.isArray(value)) return value.filter((item) => item && item !== "all").map(String);
  return value && value !== "all" ? [String(value)] : [];
}

function syncHouseholdFilterControl() {
  const selected = householdFilterValues(state.filters.households);
  const anyRoute = state.filters.householdsAny !== false;
  const controls = document.querySelectorAll("[data-household-filter]");
  controls.forEach((control) => {
    control.checked = control.dataset.householdFilter === "all" ? anyRoute : !anyRoute && selected.includes(control.dataset.householdFilter);
  });
  Array.from(els.householdFilter.options).forEach((option) => {
    option.selected = option.value === "all" ? anyRoute : !anyRoute && selected.includes(option.value);
  });
  els.householdFilterButton.textContent = anyRoute ? "Any route" : selected.length ? `${selected.length} selected` : "No routes";
}

function updateStats() {
  const routes = allRoutes();
  const ready = state.unassignedMinisters.filter((item) => item.ready).length + state.unassignedHouseholds.filter((item) => item.ready).length;
  $("stat-districts").textContent = state.districts.length;
  $("stat-routes").textContent = routes.length;
  $("stat-ministers").textContent = allAssignedMinisters().length;
  $("stat-households").textContent = allAssignedHouseholds().length;
  $("stat-ready").textContent = ready;
  $("unassigned-minister-count").textContent = state.unassignedMinisters.length;
  $("unassigned-household-count").textContent = state.unassignedHouseholds.length;
  $("minister-not-ready-count").textContent = state.unassignedMinisters.filter((item) => !item.ready).length;
  $("minister-ready-count").textContent = state.unassignedMinisters.filter((item) => item.ready).length;
  $("household-not-ready-count").textContent = state.unassignedHouseholds.filter((item) => !item.ready).length;
  $("household-ready-count").textContent = state.unassignedHouseholds.filter((item) => item.ready).length;
  const previous = state.filters.district || els.district.value;
  els.district.innerHTML = `<option value="all">All districts</option>${state.districts.map((district) => `<option value="${esc(district.id)}">${esc(district.name)}</option>`).join("")}`;
  els.district.value = state.districts.some((district) => district.id === previous) ? previous : "all";
  state.filters.district = els.district.value;
}

function visibleRoute(route, district) {
  const { search, district: districtFilter } = state.filters;
  const householdFilter = householdFilterValues(state.filters.households);
  if (districtFilter !== "all" && district.id !== districtFilter) return false;
  const count = route.households.length;
  if (state.filters.householdsAny === false && (!householdFilter.length || !householdFilter.includes(String(count)))) return false;
  if (!state.filters.showEmpty && count === 0 && !search) return false;
  if (!search) return true;
  return [route.name, district.name, ...route.ministers.map((item) => `${item.name} ${item.address || ""}`), ...route.households.flatMap((item) => [item.name, item.address, ...(item.members || []).map((member) => member.name)])].some((value) => matches(value, search));
}

function render() {
  state.districts.forEach((district) => district.routes.forEach(refreshRouteName));
  updateStats();
  const hasData = Boolean(state.districts.length || state.unassignedMinisters.length || state.unassignedHouseholds.length);
  els.emptyState.classList.toggle("hidden", hasData);
  els.diagram.classList.toggle("hidden", !state.districts.length);
  renderBuckets();
  renderDiagram();
}

function personHtml(person, kind, options = {}) {
  const isHousehold = kind === "household";
  const meta = isHousehold ? "" : [person.age ? `Age ${person.age}` : "", person.address || ""].filter(Boolean).join(" · ");
  const moveButton = options.showMove ? `<button class="button-icon" title="Move to unassigned" data-action="move-unassigned" data-kind="${kind}" data-id="${esc(person.id)}">↗</button>` : "";
  const needsButton = isHousehold ? `<button class="button-icon needs-button ${person.highNeeds ? "is-active" : ""}" title="${person.highNeeds ? "Remove high needs flag" : "Mark high needs"}" data-action="toggle-needs" data-id="${esc(person.id)}">H</button>` : "";
  const readinessButton = options.bucket ? `<button class="button-icon readiness-button ${person.ready ? "is-ready" : ""}" title="${person.ready ? "Move back to not ready" : "Mark ready for assignment"}" data-action="toggle-ready" data-kind="${kind}" data-id="${esc(person.id)}">${person.ready ? "↶" : "✓"}</button>` : "";
  return `<div class="${isHousehold ? "household-row" : "person-row"} ${options.route ? "route-row" : ""}" draggable="true" data-drag-kind="${kind}" data-drag-id="${esc(person.id)}">
    <div class="avatar ${isHousehold ? "warm" : ""}">${initial(person.name)}</div>
    <div class="row-copy"><div class="row-name">${esc(person.name)}</div>${meta ? `<div class="row-meta">${esc(meta)}</div>` : ""}${isHousehold && person.members?.length ? `<div class="household-members">${esc(person.members.map(memberDisplayName).filter(Boolean).join(" · "))}</div>` : ""}</div>
    <div class="household-flags">${needsButton}${readinessButton}${moveButton}</div>
  </div>`;
}

function renderBuckets() {
  const ministerView = state.bucketViews.minister;
  const householdView = state.bucketViews.household;
  const ministerQuery = normalize(els.ministerSearch.value);
  const householdQuery = normalize(els.householdSearch.value);
  const ministers = state.unassignedMinisters.filter((person) => (ministerView === "ready" ? person.ready : !person.ready) && (!ministerQuery || [person.name, person.address, person.email].some((value) => matches(value, ministerQuery))));
  const households = state.unassignedHouseholds.filter((household) => (householdView === "ready" ? household.ready : !household.ready) && (!householdQuery || [household.name, household.address, ...(household.members || []).map((member) => member.name)].some((value) => matches(value, householdQuery))));
  els.unassignedMinisters.innerHTML = ministers.length ? ministers.map((person) => personHtml(person, "minister", { bucket: true })).join("") : `<div class="bucket-empty">${ministerView === "ready" ? "No ministers are ready yet." : "No ministers are waiting for review."}</div>`;
  els.unassignedHouseholds.innerHTML = households.length ? households.map((household) => personHtml(household, "household", { bucket: true })).join("") : `<div class="bucket-empty">${householdView === "ready" ? "No households are ready yet." : "No households are waiting for review."}</div>`;
  document.querySelectorAll("[data-bucket-tab]").forEach((button) => {
    const isActive = state.bucketViews[button.dataset.bucketTab] === button.dataset.bucketView;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
    button.onclick = () => { state.bucketViews[button.dataset.bucketTab] = button.dataset.bucketView; renderBuckets(); };
  });
  document.querySelectorAll("#unassigned-ministers [data-action], #unassigned-households [data-action]").forEach((button) => {
    if (button.dataset.actionBound === "true") return;
    button.dataset.actionBound = "true";
    button.addEventListener("click", handleAction);
  });
  for (const zone of [els.unassignedMinisters, els.unassignedHouseholds]) bindDropZone(zone, zone.dataset.dropKind);
  bindBucketPanel($("unassigned-ministers-panel"), "minister");
  bindBucketPanel($("unassigned-households-panel"), "household");
}

function renderDiagram() {
  const districts = state.districts.filter((district) => district.routes.some((route) => visibleRoute(route, district)) || state.filters.showEmpty || state.filters.district === district.id);
  const districtDropbar = `<div class="route-district-dropbar" aria-label="Move route to district">${state.districts.map((district) => `<div class="district-drop-target" data-district-drop="${esc(district.id)}" role="button" tabindex="0">Drop in ${esc(district.name)}</div>`).join("")}</div>`;
  els.diagram.innerHTML = districtDropbar + districts.map((district) => {
    const routes = district.routes.filter((route) => visibleRoute(route, district) || state.filters.showEmpty);
    return `<section class="district-column" data-district-id="${esc(district.id)}">
      <div class="district-header"><div class="district-title"><h3>${esc(district.name)}</h3><span>${district.routes.length} routes</span></div><span class="district-drop-hint">Drop route here</span></div>
      <div class="route-stack" data-district-drop="${esc(district.id)}">${routes.length ? routes.map((route) => routeHtml(route)).join("") : `<div class="empty-route">No routes match the current filters.</div>`}</div>
    </section>`;
  }).join("");
  if (!districts.length && state.districts.length) els.diagram.innerHTML = `<div class="empty-state"><div class="empty-orb">⌕</div><h2>No routes match those filters</h2><p>Try clearing the search or widening the district and household filters.</p></div>`;
  bindDiagramEvents();
}

function routeHtml(route) {
  const sortedHouseholds = [...route.households].sort((a, b) => state.filters.sort === "needs" ? Number(b.highNeeds) - Number(a.highNeeds) || normalize(a.name).localeCompare(normalize(b.name)) : normalize(a.name).localeCompare(normalize(b.name)));
  const locked = route.locked;
  return `<article class="route-card ${locked ? "is-locked" : ""}" draggable="${locked ? "false" : "true"}" data-route-id="${esc(route.id)}">
    <div class="route-head"><div class="route-label"><span class="route-grip">⋮⋮</span><div><div class="route-name">${esc(route.name)}</div><div class="route-sub">${route.ministers.length} ministers · ${route.households.length} households</div></div></div><div class="route-actions"><button class="button-icon" title="View route map" data-action="route-map" data-route-id="${esc(route.id)}">🗺️</button><button class="button-icon lock-button ${locked ? "is-locked" : ""}" title="${locked ? "Unlock route" : "Lock route"}" data-action="toggle-lock" data-route-id="${esc(route.id)}"><span class="lock-glyph" aria-hidden="true"></span></button><button class="button-icon" title="Dissolve route" data-action="dissolve" data-route-id="${esc(route.id)}">⊗</button></div></div>
    <div class="route-body"><div class="route-section-label"><span>Ministers</span><span>${locked ? "locked" : "drag to move"}</span></div><div class="route-drop" data-route-drop="${esc(route.id)}" data-drop-kind="minister">${route.ministers.map((person) => personHtml(person, "minister", { route: true, showMove: true })).join("")}</div><div class="route-section-label"><span>Households</span><span>${route.households.length} assigned</span></div><div class="route-drop" data-route-drop="${esc(route.id)}" data-drop-kind="household">${sortedHouseholds.map((household) => personHtml(household, "household", { route: true, showMove: true })).join("")}</div></div>
  </article>`;
}

function bindDiagramEvents() {
  document.querySelectorAll(".diagram [data-action]").forEach((button) => button.addEventListener("click", handleAction));
  document.querySelectorAll("[data-drag-kind]").forEach((element) => element.addEventListener("dragstart", handleDragStart));
  document.querySelectorAll(".route-card[data-route-id]").forEach((element) => {
    element.addEventListener("dragstart", (event) => {
      if (event.target.closest("[data-drag-kind], button")) return;
      activeDrag = { kind: "route", id: element.dataset.routeId };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", JSON.stringify(activeDrag));
      element.classList.add("is-dragging");
      els.diagram.classList.add("is-route-dragging");
    });
    element.addEventListener("dragend", () => {
      activeDrag = null;
      element.classList.remove("is-dragging");
      els.diagram.classList.remove("is-route-dragging");
      document.querySelectorAll(".district-drop-target, .district-column").forEach((target) => target.classList.remove("is-dragover"));
    });
  });
  document.querySelectorAll("[data-route-drop]").forEach((zone) => bindDropZone(zone, zone.dataset.dropKind));
  document.querySelectorAll("[data-district-drop]").forEach((zone) => {
    const visualTarget = zone.classList.contains("district-drop-target") ? zone : zone.closest(".district-column");
    const acceptRouteDrag = (event) => {
      const data = parseDrag(event);
      if (data.kind !== "route") return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      visualTarget?.classList.add("is-dragover");
    };
    zone.addEventListener("dragenter", acceptRouteDrag);
    zone.addEventListener("dragover", acceptRouteDrag);
    zone.addEventListener("dragleave", () => visualTarget?.classList.remove("is-dragover"));
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      visualTarget?.classList.remove("is-dragover");
      moveDroppedItem(parseDrag(event), zone.dataset.districtDrop);
    });
  });
}

function bindDropZone(zone, acceptedKind) {
  if (zone.dataset.dropBound === "true") return;
  zone.dataset.dropBound = "true";
  const dropTarget = zone.dataset.routeDrop || "unassigned";
  zone.addEventListener("dragover", (event) => { const data = parseDrag(event); if (data.kind === acceptedKind) { event.preventDefault(); zone.classList.add("is-dragover"); } });
  zone.addEventListener("dragleave", () => zone.classList.remove("is-dragover"));
  zone.addEventListener("drop", (event) => { event.preventDefault(); zone.classList.remove("is-dragover"); const data = parseDrag(event); if (data.kind === acceptedKind) moveDroppedItem(data, dropTarget, dropTarget === "unassigned" ? state.bucketViews[acceptedKind] === "ready" : null); });
}

function bindBucketPanel(panel, acceptedKind) {
  if (!panel || panel.dataset.dropBound === "true") return;
  panel.dataset.dropBound = "true";
  panel.addEventListener("dragover", (event) => {
    if (event.target.closest(".bucket-dropzone")) return;
    const data = parseDrag(event);
    if (data.kind === acceptedKind) { event.preventDefault(); panel.classList.add("is-dragover"); }
  });
  panel.addEventListener("dragleave", (event) => { if (!panel.contains(event.relatedTarget)) panel.classList.remove("is-dragover"); });
  panel.addEventListener("drop", (event) => {
    if (event.target.closest(".bucket-dropzone")) return;
    event.preventDefault();
    panel.classList.remove("is-dragover");
    const data = parseDrag(event);
    if (data.kind === acceptedKind) moveDroppedItem(data, "unassigned", state.bucketViews[acceptedKind] === "ready");
  });
}

function parseDrag(event) {
  try {
    const parsed = JSON.parse(event.dataTransfer.getData("text/plain"));
    if (parsed?.kind && parsed?.id) return parsed;
  } catch {}
  return activeDrag || {};
}
function handleDragStart(event) {
  const element = event.currentTarget;
  activeDrag = { kind: element.dataset.dragKind, id: element.dataset.dragId };
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", JSON.stringify(activeDrag));
}

function removeItemFromRoute(kind, id) {
  const key = kind === "minister" ? "ministers" : "households";
  const route = routeForItem(kind, id);
  if (!route) return null;
  const index = route[key].findIndex((item) => item.id === id);
  if (index < 0) return null;
  return { route, item: route[key].splice(index, 1)[0] };
}

function moveDroppedItem(data, target, targetReady = null) {
  if (!data.id || !data.kind) return;
  if (data.kind === "route") {
    activeDrag = null;
    els.diagram.classList.remove("is-route-dragging");
    const sourceDistrict = state.districts.find((district) => district.routes.some((route) => route.id === data.id));
    const destination = findDistrict(target);
    if (!sourceDistrict || !destination || sourceDistrict.id === destination.id) return;
    const index = sourceDistrict.routes.findIndex((route) => route.id === data.id);
    const [route] = sourceDistrict.routes.splice(index, 1);
    destination.routes.push(route);
    markDirty();
    toast(`${route.name} moved to ${destination.name}.`);
    render();
    return;
  }
  const destinationRoute = target === "unassigned" ? null : findRoute(target);
  if (target !== "unassigned" && !destinationRoute) {
    toast("That route is no longer available. Refresh the board and try again.", "error");
    return;
  }
  if (destinationRoute?.locked) { toast("That route is locked. Unlock it before moving people.", "error"); return; }
  const key = data.kind === "minister" ? "ministers" : "households";
  let item;
  const sourceRoute = routeForItem(data.kind, data.id);
  if (sourceRoute?.locked) { toast("That route is locked. Unlock it before moving people.", "error"); return; }
  if (sourceRoute) {
    const index = sourceRoute[key].findIndex((candidate) => candidate.id === data.id);
    item = sourceRoute[key].splice(index, 1)[0];
  } else {
    const bucket = data.kind === "minister" ? state.unassignedMinisters : state.unassignedHouseholds;
    const index = bucket.findIndex((candidate) => candidate.id === data.id);
    if (index < 0) return;
    item = bucket.splice(index, 1)[0];
    if (target !== "unassigned" && !item.ready) { bucket.splice(index, 0, item); toast("Mark this person ready before placing them on a route.", "error"); return; }
  }
  if (target === "unassigned") {
    if (targetReady !== null) item.ready = targetReady;
    (data.kind === "minister" ? state.unassignedMinisters : state.unassignedHouseholds).push(item);
  }
  else destinationRoute[key].push(item);
  if (data.kind === "minister") {
    refreshRouteName(sourceRoute);
    refreshRouteName(destinationRoute);
  }
  markDirty();
  toast(target === "unassigned" ? `${item.name} moved to ${item.ready ? "ready" : "not ready"}.` : `${item.name} added to ${destinationRoute.name}.`);
  render();
}

function handleAction(event) {
  event.stopPropagation();
  const action = event.currentTarget.dataset.action;
  if (action === "move-unassigned") moveDroppedItem({ kind: event.currentTarget.dataset.kind, id: event.currentTarget.dataset.id }, "unassigned");
  if (action === "toggle-needs") {
    const household = allAssignedHouseholds().find((item) => item.id === event.currentTarget.dataset.id) || state.unassignedHouseholds.find((item) => item.id === event.currentTarget.dataset.id);
    if (household) { household.highNeeds = !household.highNeeds; markDirty(); render(); }
  }
  if (action === "toggle-ready") {
    const bucket = event.currentTarget.dataset.kind === "minister" ? state.unassignedMinisters : state.unassignedHouseholds;
    const item = bucket.find((candidate) => candidate.id === event.currentTarget.dataset.id);
    if (item) { item.ready = !item.ready; markDirty(); toast(item.ready ? `${item.name} marked ready for assignment.` : `${item.name} moved back to not ready.`); render(); }
  }
  if (action === "toggle-lock") {
    const route = findRoute(event.currentTarget.dataset.routeId);
    if (route) { route.locked = !route.locked; markDirty(); toast(route.locked ? `${route.name} locked.` : `${route.name} unlocked.`); render(); }
  }
  if (action === "dissolve") openDissolve(findRoute(event.currentTarget.dataset.routeId));
  if (action === "route-map") openRouteMap(findRoute(event.currentTarget.dataset.routeId));
}

function openDissolve(route) {
  if (!route) return;
  if (route.locked) { toast("That route is locked. Unlock it before dissolving it.", "error"); return; }
  els.modalCopy.textContent = `This will move ${route.ministers.length} minister${route.ministers.length === 1 ? "" : "s"} and ${route.households.length} household${route.households.length === 1 ? "" : "s"} into the ready-to-assign buckets.`;
  els.modalBackdrop.classList.remove("hidden");
  const confirm = () => { route.ministers.forEach((item) => { item.ready = true; }); route.households.forEach((item) => { item.ready = true; }); state.unassignedMinisters.push(...route.ministers); state.unassignedHouseholds.push(...route.households); const district = routeDistrict(route.id); district.routes = district.routes.filter((candidate) => candidate.id !== route.id); markDirty(); closeModal(); toast(`${route.name} dissolved.`); render(); };
  els.modalConfirm.onclick = confirm;
}
function closeModal() { els.modalBackdrop.classList.add("hidden"); els.modalConfirm.onclick = null; }

async function togglePanelFullscreen(panelId) {
  const panel = $(panelId);
  if (!panel || !document.fullscreenEnabled) {
    toast("Full screen is not available in this browser.", "error");
    return;
  }
  try {
    if (document.fullscreenElement === panel) await document.exitFullscreen();
    else {
      if (document.fullscreenElement) await document.exitFullscreen();
      await panel.requestFullscreen();
    }
  } catch (error) {
    toast(error.message || "Could not enter full screen.", "error");
  }
}

function updatePanelFullscreenButtons() {
  document.querySelectorAll(".bucket-panel").forEach((panel) => panel.classList.toggle("is-panel-fullscreen", document.fullscreenElement === panel));
  document.querySelectorAll("[data-panel-fullscreen]").forEach((button) => {
    const active = document.fullscreenElement?.id === button.dataset.panelFullscreen;
    button.textContent = active ? "×" : "⛶";
    button.title = active ? "Exit full screen" : `Full screen ${button.dataset.panelFullscreen.includes("households") ? "households" : "ministers"}`;
    button.setAttribute("aria-label", button.title);
  });
}

function closeMap() {
  els.mapBackdrop.classList.add("hidden");
  if (els.routeMap._leafletMap) {
    els.routeMap._leafletMap.remove();
    els.routeMap._leafletMap = null;
  }
}

async function geocodeRoute(route) {
  const addressItems = [
    ...route.ministers.map((person) => ({ kind: "minister", item: person })),
    ...route.households.map((household) => ({ kind: "household", item: household })),
  ].filter((entry) => entry.item.address);
  const addresses = [...new Set(addressItems.map((entry) => entry.item.address))];
  if (!addresses.length) return { total: 0, located: 0 };
  const response = await fetch("/api/geocode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addresses }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Geocoding failed.");
  const byAddress = new Map((payload.results || []).map((result) => [result.key || geocodeKeyClient(result.address), result]));
  for (const entry of addressItems) {
    const result = byAddress.get(geocodeKeyClient(entry.item.address));
    if (result) {
      entry.item.lat = result.lat;
      entry.item.lon = result.lon;
      entry.item.geocodeSource = result.source;
    }
  }
  return { total: addressItems.length, located: addressItems.filter((entry) => Number.isFinite(entry.item.lat) && Number.isFinite(entry.item.lon)).length, cached: payload.cached || 0, geocoded: payload.geocoded || 0 };
}

function geocodeKeyClient(address) {
  return clean(address).replace(/,?\s*(Apt\.?|Unit|Ste\.?|Suite|Trlr|Trailer|Rm\.?|#)\s*\S+/ig, "").replace(/(\d{5})-\d{4}\b/g, "$1").replace(/,/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function popupHtml(kind, item) {
  const label = kind === "minister" ? "Minister" : (item.highNeeds ? "High needs household" : "Household");
  return `<div class="popup-kicker">${esc(label)}</div><div class="popup-name">${esc(item.name)}</div><div class="popup-address">${esc(item.address || "Address unavailable")}</div>`;
}

function renderRouteMap(route) {
  if (!window.L) throw new Error("Map library did not load.");
  if (els.routeMap._leafletMap) els.routeMap._leafletMap.remove();
  const map = window.L.map(els.routeMap, { zoomControl: true, attributionControl: true });
  els.routeMap._leafletMap = map;
  window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
  const points = [];
  for (const minister of route.ministers) {
    if (!Number.isFinite(minister.lat) || !Number.isFinite(minister.lon)) continue;
    const point = [minister.lat, minister.lon]; points.push(point);
    window.L.circleMarker(point, { radius: 9, color: "#1d5148", weight: 3, fillColor: "#2c7465", fillOpacity: .9 }).addTo(map).bindPopup(popupHtml("minister", minister));
  }
  for (const household of route.households) {
    if (!Number.isFinite(household.lat) || !Number.isFinite(household.lon)) continue;
    const point = [household.lat, household.lon]; points.push(point);
    window.L.circleMarker(point, { radius: 8, color: "#a65b20", weight: 2, fillColor: household.highNeeds ? "#d15f31" : "#d58b42", fillOpacity: .92 }).addTo(map).bindPopup(popupHtml("household", household));
  }
  if (points.length === 1) map.setView(points[0], 15);
  else if (points.length > 1) map.fitBounds(points, { padding: [35, 35] });
  else map.setView([47.38, -122.2], 11);
  setTimeout(() => map.invalidateSize(), 80);
}

async function openRouteMap(route) {
  if (!route) return;
  els.mapTitle.textContent = `${route.name} · ${routeDistrict(route.id)?.name || "District"}`;
  els.mapStatus.textContent = "Checking the shared address cache...";
  els.mapCounts.textContent = "";
  els.mapBackdrop.classList.remove("hidden");
  try {
    const summary = await geocodeRoute(route);
    renderRouteMap(route);
    els.mapStatus.textContent = summary.total ? `${summary.located} of ${summary.total} addresses located. Cached results are reused automatically.` : "No addresses were available for this route.";
    els.mapCounts.textContent = `${route.ministers.length} ministers · ${route.households.length} households`;
  } catch (error) {
    els.mapStatus.textContent = error.message || "Could not build the route map.";
    els.mapCounts.textContent = "";
    toast(error.message || "Could not build the route map.", "error");
  }
}

function parsePhone(value) { return /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/.test(clean(value)); }
function parseAddress(lines) { return lines.filter((line) => !/@/.test(line) && !parsePhone(line)).join(", "); }
function ministerLastName(value) {
  const name = clean(value);
  if (!name) return "";
  return name.includes(",") ? clean(name.split(",")[0]) : name.split(/\s+/).pop();
}
function routeNameFromMinisters(ministers, fallback = "Open route") {
  const names = (ministers || []).map((minister) => ministerLastName(minister.name)).filter(Boolean);
  return names.length ? names.join(" & ") : fallback;
}
function refreshRouteName(route) {
  if (route) route.name = routeNameFromMinisters(route.ministers, route.name || "Open route");
}
function likelyCardName(value) {
  const text = clean(value);
  return Boolean(text) && !parsePhone(text) && !/@/.test(text) && !/\d/.test(text) && !/^(?:apt\.?|unit|#)\b/i.test(text);
}
function groupCards(lines, minX, maxX) {
  const selected = lines.filter((line) => line.x >= minX && line.x < maxX).sort((a, b) => a.y - b.y);
  const groups = [];
  for (const line of selected) {
    const last = groups[groups.length - 1];
    const likelyName = likelyCardName(line.text);
    const lastText = last?.[last.length - 1]?.text || "";
    if (!last || /@/.test(lastText) || (likelyName && last.length >= 2)) groups.push([line]); else last.push(line);
  }
  return groups;
}
function parseMinisterCard(group) {
  const lines = group.map((line) => line.text).filter(Boolean);
  const email = lines.find((line) => /@/.test(line)) || "";
  const phone = lines.find(parsePhone) || "";
  return { id: uid("minister"), name: lines[0] || "Unnamed minister", phone, email, address: parseAddress(lines.slice(1)), ready: true, source: "pdf" };
}
function parseHouseholdCard(group) {
  const lines = group.map((line) => line.text).filter(Boolean);
  const email = lines.find((line) => /@/.test(line)) || "";
  const phone = lines.find(parsePhone) || "";
  return { id: uid("household"), name: lines[0] || "Unnamed household", phone, email, address: parseAddress(lines.slice(1)), members: [], highNeeds: false, ready: true, source: "pdf" };
}
function parseMemberLines(lines, householdCards) {
  const members = [];
  const selected = lines.filter((line) => line.x >= 285).sort((a, b) => a.y - b.y);
  for (let index = 0; index < selected.length;) {
    const current = selected[index];
    const combined = clean(current.text).match(/^(.+?)\s+(Male|Female)\s+(\d{1,2}\s+[A-Za-z]+)$/i);
    const name = memberDisplayName(combined ? combined[1] : current.text);
    if (!name || /^(Male|Female)$/i.test(name) || /^\d{1,2} \w+$/i.test(name)) { index += 1; continue; }
    const gender = combined ? combined[2] : selected[index + 1]?.text || "";
    const birthday = combined ? combined[3] : selected[index + 2]?.text || "";
    const member = { name, gender, birthday };
    let household = householdCards.slice().reverse().find((card) => card._top <= current.y + 4);
    if (!household) household = householdCards[0];
    household?.members.push(member);
    members.push(member);
    index += combined ? 1 : 3;
  }
  return members;
}

async function extractPageLines(page) {
  const content = await page.getTextContent();
  const height = page.view[3] || page.getViewport({ scale: 1 }).height;
  const raw = content.items.map((item) => {
    const x = item.transform[4];
    return { text: clean(item.str), x, y: height - item.transform[5], column: x < 140 ? 0 : x < 285 ? 1 : 2 };
  }).filter((item) => item.text);
  const lineGroups = [];
  for (const item of raw.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lineGroups.find((candidate) => candidate.column === item.column && Math.abs(candidate.y - item.y) < 2.5);
    if (line) { line.parts.push(item); line.x = Math.min(line.x, item.x); }
    else lineGroups.push({ y: item.y, x: item.x, column: item.column, parts: [item] });
  }
  return lineGroups.map((line) => ({ y: line.y, x: line.x, text: line.parts.sort((a, b) => a.x - b.x).map((part) => part.text).join(" ") }));
}

async function parsePdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const document = await pdfjsLib.getDocument({ data: bytes }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) pages.push(await extractPageLines(await document.getPage(pageNumber)));
  let currentDistrict = "District 1";
  const parsedDistricts = new Map();
  for (const lines of pages) {
    const districtHeader = lines.find((line) => /^District \d+$/i.test(line.text));
    if (districtHeader) currentDistrict = districtHeader.text;
    if (!parsedDistricts.has(currentDistrict)) parsedDistricts.set(currentDistrict, []);
    const district = parsedDistricts.get(currentDistrict);
    const separators = lines.filter((line) => /^\.+$/.test(line.text.replace(/\s+/g, "")) && line.x < 60).map((line) => line.y);
    const boundaries = [55, ...separators, 735].sort((a, b) => a - b);
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const start = boundaries[index]; const end = boundaries[index + 1];
      const segment = lines.filter((line) => line.y > start + 8 && line.y < end - 7 && !/^\.+$/.test(line.text.replace(/\s+/g, "")) && !/^(Ministering Assignments|Pine Tree Ward|Kent Washington Stake|\d+ Nov \d{4}|For Church Use Only|District \d+|Presidency Member:)/i.test(line.text) && !/^\+?[\d\s().-]+\s*\|\s*\S+@/i.test(line.text));
      const ministerGroups = groupCards(segment, 0, 140);
      const householdGroups = groupCards(segment, 140, 285);
      if (!ministerGroups.length || !householdGroups.length) continue;
      const ministers = ministerGroups.map(parseMinisterCard);
      const households = householdGroups.map((group) => { const household = parseHouseholdCard(group); household._top = group[0].y; return household; });
      parseMemberLines(segment, households);
      households.forEach((household) => delete household._top);
      district.push({ id: uid("route"), name: routeNameFromMinisters(ministers), locked: false, ministers, households, sourcePage: pages.indexOf(lines) + 1 });
    }
  }
  return [...parsedDistricts.entries()].map(([name, routes]) => ({ id: uid("district"), name, routes }));
}

function rowValue(row, names) { const key = Object.keys(row).find((candidate) => names.includes(normalize(candidate))); return key ? row[key] : ""; }
function parseWorkbook(file) {
  return file.arrayBuffer().then((buffer) => {
    const workbook = spreadsheetLib.read(buffer, { type: "array" });
    const progressSheet = workbook.Sheets[workbook.SheetNames.find((name) => normalize(name) === "progress") || ""];
    if (progressSheet) {
      const progressRows = spreadsheetLib.utils.sheet_to_json(progressSheet, { header: 1, defval: "" });
      const serialized = progressRows[1]?.[0] || progressRows[0]?.[0] || "";
      try {
        const savedState = JSON.parse(serialized);
        if (savedState && Array.isArray(savedState.districts) && Array.isArray(savedState.unassignedMinisters) && Array.isArray(savedState.unassignedHouseholds)) {
          return { savedState, sheetNames: workbook.SheetNames };
        }
      } catch (error) {
        console.warn("Saved Progress sheet could not be read; importing the unassigned tabs instead.", error);
      }
    }
    const sheetName = (names) => workbook.SheetNames.find((name) => names.some((part) => normalize(name).includes(part)));
    const ministersSheet = sheetName(["unassigned ministers", "minister"]);
    const householdsSheet = sheetName(["unassigned households", "household"]);
    const assignmentsSheet = sheetName(["assignments"]);
    if (assignmentsSheet) {
      const assignmentRows = spreadsheetLib.utils.sheet_to_json(workbook.Sheets[assignmentsSheet], { defval: "" });
      const restored = restoreFromAssignmentsSheet(assignmentRows);
      if (restored) {
        restored.unassignedMinisters = ministersSheet ? spreadsheetLib.utils.sheet_to_json(workbook.Sheets[ministersSheet], { defval: "" }).map((row) => ({ id: uid("minister"), name: clean(rowValue(row, ["name", "minister"])), age: clean(rowValue(row, ["age"])), address: clean(rowValue(row, ["address"])), ready: parseReady(rowValue(row, ["ready", "is ready"])), source: "saved-workbook" })).filter((item) => item.name) : [];
        restored.unassignedHouseholds = householdsSheet ? spreadsheetLib.utils.sheet_to_json(workbook.Sheets[householdsSheet], { defval: "" }).map((row) => ({ id: uid("household"), name: clean(rowValue(row, ["name", "household"])), address: clean(rowValue(row, ["address"])), members: [], highNeeds: parseReady(rowValue(row, ["highneeds", "high needs"])), ready: parseReady(rowValue(row, ["ready", "is ready"])), source: "saved-workbook" })).filter((item) => item.name) : [];
        return { savedState: restored, sheetNames: workbook.SheetNames };
      }
    }
    if (!ministersSheet && !householdsSheet) throw new Error("Workbook needs Unassigned Ministers and/or Unassigned Households tabs.");
    const ministers = ministersSheet ? spreadsheetLib.utils.sheet_to_json(workbook.Sheets[ministersSheet], { defval: "" }).map((row) => ({ id: uid("minister"), name: clean(rowValue(row, ["name", "minister"])), age: clean(rowValue(row, ["age"])), address: clean(rowValue(row, ["address"])), ready: parseReady(rowValue(row, ["ready", "is ready"])), source: "workbook" })).filter((item) => item.name) : [];
    const households = householdsSheet ? spreadsheetLib.utils.sheet_to_json(workbook.Sheets[householdsSheet], { defval: "" }).map((row) => ({ id: uid("household"), name: clean(rowValue(row, ["name", "household"])), address: clean(rowValue(row, ["address"])), members: [], highNeeds: parseReady(rowValue(row, ["highneeds", "high needs"])), ready: parseReady(rowValue(row, ["ready", "is ready"])), source: "workbook" })).filter((item) => item.name) : [];
    return { ministers, households, sheetNames: workbook.SheetNames };
  });
}

function parseReady(value) {
  const normalized = normalize(value);
  return ["yes", "true", "1", "ready"].includes(normalized);
}

function restoreFromAssignmentsSheet(rows) {
  if (!Array.isArray(rows) || !rows.length || !Object.keys(rows[0]).some((key) => normalize(key) === "district")) return null;
  const districts = [];
  const districtMap = new Map();
  const routeMap = new Map();
  for (const row of rows) {
    const districtName = clean(rowValue(row, ["district"])) || "Unassigned district";
    const routeName = clean(rowValue(row, ["route"])) || "Imported route";
    if (!districtMap.has(districtName)) {
      const district = { id: uid("district"), name: districtName, routes: [] };
      districtMap.set(districtName, district);
      districts.push(district);
    }
    const district = districtMap.get(districtName);
    const routeKey = `${districtName}::${routeName}`;
    if (!routeMap.has(routeKey)) {
      const route = { id: uid("route"), name: routeName, locked: parseReady(rowValue(row, ["locked"])), ministers: [], households: [] };
      routeMap.set(routeKey, route);
      district.routes.push(route);
    }
    const route = routeMap.get(routeKey);
    const ministerNames = clean(rowValue(row, ["ministers"])).split(/\s+&\s+/).map(clean).filter(Boolean);
    for (const name of ministerNames) {
      if (!route.ministers.some((minister) => normalize(minister.name) === normalize(name))) route.ministers.push({ id: uid("minister"), name, address: "", ready: true, source: "saved-workbook" });
    }
    const householdName = clean(rowValue(row, ["household"]));
    if (householdName) route.households.push({ id: uid("household"), name: householdName, address: clean(rowValue(row, ["address"])), highNeeds: parseReady(rowValue(row, ["highneeds", "high needs"])), ready: true, members: clean(rowValue(row, ["householdmembers", "household members"])).split(" | ").map((name) => ({ name, gender: "", birthday: "" })).filter((member) => member.name), source: "saved-workbook" });
  }
  districts.forEach((district) => district.routes.forEach(refreshRouteName));
  return { version: 1, districts, unassignedMinisters: [], unassignedHouseholds: [], bucketViews: { minister: "not-ready", household: "not-ready" }, filters: { search: "", district: "all", households: [], householdsAny: true, sort: "name", showEmpty: false } };
}

function restoreSavedState(savedState) {
  state.districts = savedState.districts || [];
  state.districts.forEach((district) => district.routes.forEach(refreshRouteName));
  state.unassignedMinisters = savedState.unassignedMinisters || [];
  state.unassignedHouseholds = savedState.unassignedHouseholds || [];
  state.bucketViews = { minister: "not-ready", household: "not-ready", ...(savedState.bucketViews || {}) };
  const savedFilters = savedState.filters || {};
  state.filters = { search: "", district: "all", households: [], householdsAny: true, sort: "name", showEmpty: false, ...savedFilters };
  state.filters.households = householdFilterValues(state.filters.households);
  if (!("householdsAny" in savedFilters)) state.filters.householdsAny = !state.filters.households.length;
  els.search.value = state.filters.search;
  syncHouseholdFilterControl();
  els.householdSort.value = state.filters.sort;
  els.showEmpty.checked = state.filters.showEmpty;
  state.pdfLoaded = state.districts.length > 0;
  state.isDirty = false;
  updateSaveStatus();
}

function mergeBuckets(items, existing) {
  const seen = new Set(existing.map((item) => normalize(item.name)));
  return existing.concat(items.filter((item) => { const key = normalize(item.name); if (!key || seen.has(key)) return false; seen.add(key); return true; }));
}

async function handlePdf(file) {
  els.pdfStatus.textContent = "Parsing PDF...";
  try { state.districts = await parsePdf(file); state.pdfLoaded = true; markDirty(); els.pdfStatus.textContent = `${file.name} · ${routeCount()} routes`; els.pdfStatus.classList.add("loaded"); toast(`Parsed ${routeCount()} routes from the PDF.`); render(); }
  catch (error) { console.error(error); els.pdfStatus.textContent = "Could not parse this PDF"; toast(error.message || "PDF parsing failed.", "error"); }
}
async function handleWorkbook(file) {
  els.xlsxStatus.textContent = "Reading workbook...";
  try { const parsed = await parseWorkbook(file); if (parsed.savedState) { restoreSavedState(parsed.savedState); state.workbookLoaded = true; els.xlsxStatus.textContent = `${file.name} · saved progress restored`; els.xlsxStatus.classList.add("loaded"); toast("Saved progress restored."); } else { state.unassignedMinisters = mergeBuckets(parsed.ministers, state.unassignedMinisters); state.unassignedHouseholds = mergeBuckets(parsed.households, state.unassignedHouseholds); state.workbookLoaded = true; markDirty(); els.xlsxStatus.textContent = `${file.name} · ${parsed.sheetNames.length} tabs`; els.xlsxStatus.classList.add("loaded"); toast(`Imported ${parsed.ministers.length} ministers and ${parsed.households.length} households.`); } render(); }
  catch (error) { console.error(error); els.xlsxStatus.textContent = "Could not read this workbook"; toast(error.message || "Workbook import failed.", "error"); }
}

function downloadWorkbook() {
  if (!state.districts.length && !state.unassignedMinisters.length && !state.unassignedHouseholds.length) { toast("Load data before exporting.", "error"); return; }
  const assignmentRows = allRoutes().flatMap((route) => {
    const district = routeDistrict(route.id)?.name || "";
    const households = route.households.length ? route.households : [{ name: "", address: "", highNeeds: false, members: [] }];
    return households.map((household) => ({ District: district, Route: route.name, Locked: route.locked ? "Yes" : "No", Ministers: route.ministers.map((minister) => minister.name).join(" & "), Household: household.name, Address: household.address || "", HighNeeds: household.highNeeds ? "Yes" : "No", HouseholdMembers: (household.members || []).map((member) => member.name).join(" | ") }));
  });
  const ministerRows = state.unassignedMinisters.map((minister) => ({ Name: minister.name, Age: minister.age || "", Address: minister.address || "", Ready: minister.ready ? "Yes" : "No" }));
  const householdRows = state.unassignedHouseholds.map((household) => ({ Name: household.name, Address: household.address || "", HighNeeds: household.highNeeds ? "Yes" : "No", Ready: household.ready ? "Yes" : "No" }));
  const workbook = spreadsheetLib.utils.book_new();
  spreadsheetLib.utils.book_append_sheet(workbook, spreadsheetLib.utils.json_to_sheet(assignmentRows), "Assignments");
  spreadsheetLib.utils.book_append_sheet(workbook, spreadsheetLib.utils.json_to_sheet(ministerRows), "Unassigned Ministers");
  spreadsheetLib.utils.book_append_sheet(workbook, spreadsheetLib.utils.json_to_sheet(householdRows), "Unassigned Households");
  const savedState = {
    version: 1,
    districts: state.districts,
    unassignedMinisters: state.unassignedMinisters,
    unassignedHouseholds: state.unassignedHouseholds,
    bucketViews: state.bucketViews,
    filters: state.filters,
  };
  spreadsheetLib.utils.book_append_sheet(workbook, spreadsheetLib.utils.json_to_sheet([{ State: JSON.stringify(savedState) }]), "Progress");
  spreadsheetLib.writeFile(workbook, "ministering-progress.xlsx");
  state.isDirty = false;
  updateSaveStatus();
  toast("Progress saved to workbook.");
}

function resetWorkspace() { const hadData = state.districts.length || state.unassignedMinisters.length || state.unassignedHouseholds.length; state.districts = []; state.unassignedMinisters = []; state.unassignedHouseholds = []; state.pdfLoaded = false; state.workbookLoaded = false; if (hadData) markDirty(); else { state.isDirty = false; updateSaveStatus(); } els.pdfStatus.textContent = "No PDF loaded"; els.xlsxStatus.textContent = "No workbook loaded"; els.pdfStatus.classList.remove("loaded"); els.xlsxStatus.classList.remove("loaded"); render(); toast("Workspace cleared."); }

function bindFileDrop(dropzone, input, handler) { dropzone.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("is-dragover"); }); dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-dragover")); dropzone.addEventListener("drop", (event) => { event.preventDefault(); dropzone.classList.remove("is-dragover"); const file = event.dataTransfer.files[0]; if (file) handler(file); }); input.addEventListener("change", () => { if (input.files[0]) handler(input.files[0]); }); }

document.querySelectorAll("[data-file-target]").forEach((button) => button.addEventListener("click", () => $(button.dataset.fileTarget).click()));
bindFileDrop(els.pdfDropzone, els.pdfInput, handlePdf);
bindFileDrop(els.xlsxDropzone, els.xlsxInput, handleWorkbook);
$("load-progress-button").addEventListener("click", () => els.progressInput.click());
els.progressInput.addEventListener("change", () => { if (els.progressInput.files[0]) handleWorkbook(els.progressInput.files[0]); });
$("export-button").addEventListener("click", downloadWorkbook);
$("reset-button").addEventListener("click", resetWorkspace);
els.search.addEventListener("input", () => { state.filters.search = els.search.value; renderDiagram(); });
els.district.addEventListener("change", () => { state.filters.district = els.district.value; renderDiagram(); });
els.householdFilterButton.addEventListener("click", () => {
  const isOpen = !els.householdFilterPopover.classList.contains("hidden");
  els.householdFilterPopover.classList.toggle("hidden", isOpen);
  els.householdFilterButton.setAttribute("aria-expanded", String(!isOpen));
});
document.querySelectorAll("[data-household-filter]").forEach((control) => control.addEventListener("change", () => {
  const value = control.dataset.householdFilter;
  const selected = householdFilterValues(state.filters.households);
  if (value === "all") {
    state.filters.householdsAny = control.checked;
    if (control.checked) state.filters.households = [];
  } else {
    state.filters.householdsAny = false;
    state.filters.households = control.checked ? [...new Set([...selected, value])] : selected.filter((item) => item !== value);
  }
  syncHouseholdFilterControl();
  renderDiagram();
}));
document.addEventListener("click", (event) => {
  if (!els.householdFilterMenu.contains(event.target)) {
    els.householdFilterPopover.classList.add("hidden");
    els.householdFilterButton.setAttribute("aria-expanded", "false");
  }
});
els.householdSort.addEventListener("change", () => { state.filters.sort = els.householdSort.value; renderDiagram(); });
els.showEmpty.addEventListener("change", () => { state.filters.showEmpty = els.showEmpty.checked; renderDiagram(); });
els.modalCancel.addEventListener("click", closeModal);
els.modalBackdrop.addEventListener("click", (event) => { if (event.target === els.modalBackdrop) closeModal(); });
els.mapClose.addEventListener("click", closeMap);
els.mapBackdrop.addEventListener("click", (event) => { if (event.target === els.mapBackdrop) closeMap(); });
els.ministerSearch.addEventListener("input", renderBuckets);
els.householdSearch.addEventListener("input", renderBuckets);
document.querySelectorAll("[data-panel-fullscreen]").forEach((button) => button.addEventListener("click", () => togglePanelFullscreen(button.dataset.panelFullscreen)));
document.addEventListener("fullscreenchange", updatePanelFullscreenButtons);
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && document.fullscreenElement) document.exitFullscreen().catch(() => {}); });
window.addEventListener("beforeunload", (event) => { if (!state.isDirty) return; event.preventDefault(); event.returnValue = ""; });

render();
syncHouseholdFilterControl();
updateSaveStatus();
