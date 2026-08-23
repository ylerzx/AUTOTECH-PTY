/**
 * app.js — Lógica principal (Vanilla JS, sin dependencias).
 * - Consumo de API NHTSA con Cache API + debounce.
 * - Persistencia vía db.js (IndexedDB).
 * - Cálculos con funciones puras.
 * - Render vía DocumentFragment (evita layout thrashing).
 * - Crear/editar vehículo, marcar mantenimientos como hechos,
 *   exportar/importar respaldo JSON, validación inline, foco atrapado,
 *   orden por urgencia y skeleton loading.
 */

import { GarageDB } from './db.js';

/* ============================================================
   1. CONSTANTES Y HELPERS DE FECHA/CÁLCULO (funciones puras)
   ============================================================ */

const MS_PER_DAY = 86400000;
const NHTSA_BASE = 'https://vpic.nhtsa.dot.gov/api/vehicles';
const API_CACHE_NAME = 'nhtsa-api-cache-v1';
const STATUS_RANK = { ok: 0, warn: 1, danger: 2 };

/** Días entre dos fechas (b - a), redondeado hacia abajo. Pura. */
function daysBetween(dateA, dateB) {
  return Math.floor((dateB.getTime() - dateA.getTime()) / MS_PER_DAY);
}

/**
 * Calcula el estado de un mantenimiento por kilometraje.
 * Pura: mismos inputs -> mismo output.
 * @returns {{kmRemaining:number|null, status:'ok'|'warn'|'danger'}}
 */
function calcKmStatus(currentKm, lastServiceKm, intervalKm) {
  if (!intervalKm || intervalKm <= 0) return { kmRemaining: null, status: 'ok' };
  const nextDueKm = lastServiceKm + intervalKm;
  const kmRemaining = nextDueKm - currentKm;
  let status = 'ok';
  if (kmRemaining <= 0) status = 'danger';
  else if (kmRemaining <= intervalKm * 0.1) status = 'warn';
  return { kmRemaining, status };
}

/**
 * Calcula el estado de un mantenimiento por tiempo.
 * Pura respecto a `now` inyectado (facilita testing).
 * @returns {{daysRemaining:number|null, status:'ok'|'warn'|'danger'}}
 */
function calcTimeStatus(lastServiceDateISO, intervalMonths, now = new Date()) {
  if (!intervalMonths || intervalMonths <= 0 || !lastServiceDateISO) {
    return { daysRemaining: null, status: 'ok' };
  }
  const lastDate = new Date(lastServiceDateISO);
  const dueDate = new Date(lastDate);
  dueDate.setMonth(dueDate.getMonth() + Number(intervalMonths));
  const daysRemaining = daysBetween(now, dueDate);
  let status = 'ok';
  if (daysRemaining <= 0) status = 'danger';
  else if (daysRemaining <= 15) status = 'warn';
  return { daysRemaining, status };
}

/** Combina estado por km y por tiempo: el más urgente gana. Pura. */
function combineStatus(kmResult, timeResult) {
  const worst = STATUS_RANK[kmResult.status] >= STATUS_RANK[timeResult.status] ? kmResult.status : timeResult.status;
  return {
    kmRemaining: kmResult.kmRemaining,
    daysRemaining: timeResult.daysRemaining,
    status: worst
  };
}

/**
 * Calcula fecha de renovación del revisado/lata dado el mes de inscripción.
 * Pura respecto a `now` inyectado.
 */
function calcRenewal(registrationMonth, now = new Date()) {
  const year = now.getFullYear();
  let renewalDate = new Date(year, registrationMonth - 1, 1);
  if (renewalDate.getTime() < now.getTime()) {
    renewalDate = new Date(year + 1, registrationMonth - 1, 1);
  }
  const totalDays = daysBetween(now, renewalDate);
  const months = Math.floor(totalDays / 30);
  const days = totalDays % 30;
  let status = 'ok';
  if (totalDays <= 15) status = 'danger';
  else if (totalDays <= 45) status = 'warn';
  return { months, days, totalDays, status };
}

/** Calcula el estado combinado de una tarea de mantenimiento específica. Pura. */
function evaluateMaintenance(vehicle, maintenance) {
  const kmResult = calcKmStatus(vehicle.currentKm, Number(maintenance.lastKm) || 0, Number(maintenance.intervalKm) || 0);
  const timeResult = calcTimeStatus(maintenance.lastDate, Number(maintenance.intervalMonths) || 0);
  return combineStatus(kmResult, timeResult);
}

/** Calcula el estado del mantenimiento general de un vehículo. Pura. */
function evaluateGeneral(vehicle) {
  return calcKmStatus(vehicle.currentKm, vehicle.generalLastServiceKm, vehicle.generalIntervalKm);
}

/** Determina el peor estado global de un vehículo (general + trámite + específicos). Pura. */
function evaluateVehicleWorstStatus(vehicle) {
  const general = evaluateGeneral(vehicle);
  const renewal = calcRenewal(vehicle.registrationMonth);
  let worst = STATUS_RANK[general.status] >= STATUS_RANK[renewal.status] ? general.status : renewal.status;
  (vehicle.maintenances || []).forEach((m) => {
    const r = evaluateMaintenance(vehicle, m);
    if (STATUS_RANK[r.status] > STATUS_RANK[worst]) worst = r.status;
  });
  return worst;
}

/* ============================================================
   2. CAPA DE RED: API NHTSA + Cache API + Debounce
   ============================================================ */

function debounce(fn, wait = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

async function cachedFetch(url) {
  if ('caches' in window) {
    const cache = await caches.open(API_CACHE_NAME);
    const cached = await cache.match(url);
    if (cached) {
      fetch(url).then((res) => { if (res.ok) cache.put(url, res.clone()); }).catch(() => {});
      return cached.json();
    }
    const res = await fetch(url);
    if (res.ok) await cache.put(url, res.clone());
    return res.json();
  }
  const res = await fetch(url);
  return res.json();
}

async function fetchBrands(query) {
  const url = `${NHTSA_BASE}/GetMakesForVehicleType/car?format=json`;
  const data = await cachedFetch(url);
  const results = data?.Results || [];
  const q = query.trim().toLowerCase();
  return results
    .map(r => r.MakeName)
    .filter(name => name && name.toLowerCase().includes(q))
    .slice(0, 8);
}

async function fetchModels(brand) {
  const url = `${NHTSA_BASE}/GetModelsForMake/${encodeURIComponent(brand)}?format=json`;
  const data = await cachedFetch(url);
  const results = data?.Results || [];
  return [...new Set(results.map(r => r.Model_Name))].slice(0, 30);
}

/* ============================================================
   3. ESTADO DE UI Y REFERENCIAS DOM
   ============================================================ */

const els = {
  vehicleList: document.getElementById('vehicleList'),
  emptyState: document.getElementById('emptyState'),
  skeletonList: document.getElementById('skeletonList'),
  vehicleCount: document.getElementById('vehicleCount'),
  btnAddVehicle: document.getElementById('btnAddVehicle'),
  btnCloseModal: document.getElementById('btnCloseModal'),
  modalBackdrop: document.getElementById('modalBackdrop'),
  modalTitle: document.getElementById('modalTitle'),
  vehicleForm: document.getElementById('vehicleForm'),
  inputVehicleId: document.getElementById('inputVehicleId'),
  formError: document.getElementById('formError'),
  btnSubmitVehicle: document.getElementById('btnSubmitVehicle'),
  inputBrand: document.getElementById('inputBrand'),
  inputModel: document.getElementById('inputModel'),
  brandList: document.getElementById('brandList'),
  modelList: document.getElementById('modelList'),
  maintChipGrid: document.getElementById('maintChipGrid'),
  maintDetailsContainer: document.getElementById('maintDetailsContainer'),
  toast: document.getElementById('toast'),
  btnNotifPermission: document.getElementById('btnNotifPermission'),
  vehicleCardTemplate: document.getElementById('vehicleCardTemplate'),
  maintRowTemplate: document.getElementById('maintRowTemplate'),
  maintDetailTemplate: document.getElementById('maintDetailTemplate'),
  btnExport: document.getElementById('btnExport'),
  btnImport: document.getElementById('btnImport'),
  importFileInput: document.getElementById('importFileInput'),
  importModalBackdrop: document.getElementById('importModalBackdrop'),
  btnCloseImportModal: document.getElementById('btnCloseImportModal'),
  importSummary: document.getElementById('importSummary'),
  btnImportMerge: document.getElementById('btnImportMerge'),
  btnImportReplace: document.getElementById('btnImportReplace'),
};

const selectedMaintTypes = new Map(); // type -> detailElement
let pendingImportData = null;
let lastFocusedBeforeModal = null;

/* ============================================================
   4. RENDER (DocumentFragment — sin layout thrashing)
   ============================================================ */

const STATUS_LABEL = { ok: 'Al día', warn: 'Pronto', danger: 'Urgente' };

function formatKmDays(kmRemaining, daysRemaining) {
  const parts = [];
  if (kmRemaining !== null && kmRemaining !== undefined) {
    parts.push(kmRemaining > 0 ? `${kmRemaining.toLocaleString()} km restantes` : `Vencido por ${Math.abs(kmRemaining).toLocaleString()} km`);
  }
  if (daysRemaining !== null && daysRemaining !== undefined) {
    parts.push(daysRemaining > 0 ? `${daysRemaining} días` : `Vencido por ${Math.abs(daysRemaining)} días`);
  }
  return parts.join(' · ') || 'Sin datos';
}

function buildStatusItem(label, value) {
  const item = document.createElement('div');
  item.className = 'status-item';
  const l = document.createElement('div');
  l.className = 'label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'value';
  v.textContent = value;
  item.append(l, v);
  return item;
}

function renderVehicleCard(vehicle) {
  const node = els.vehicleCardTemplate.content.cloneNode(true);
  const card = node.querySelector('.vehicle-card');
  card.dataset.id = vehicle.id;

  node.querySelector('.vehicle-name').textContent = `${vehicle.brand} ${vehicle.model}`;
  node.querySelector('.vehicle-meta').textContent = `${vehicle.year} · ${vehicle.plate} · ${vehicle.currentKm.toLocaleString()} km`;

  const generalResult = evaluateGeneral(vehicle);
  const renewal = calcRenewal(vehicle.registrationMonth);

  const statusGrid = node.querySelector('.general-status');
  statusGrid.appendChild(buildStatusItem('Mantenimiento general', formatKmDays(generalResult.kmRemaining, null)));
  statusGrid.appendChild(buildStatusItem('Revisado y lata', renewal.totalDays > 0 ? `${renewal.months}m ${renewal.days}d` : 'Vencido'));

  const worstGlobal = evaluateVehicleWorstStatus(vehicle);
  statusGrid.appendChild(buildStatusItem('Estado global', STATUS_LABEL[worstGlobal]));

  // --- Botón: marcar mantenimiento general como hecho ---
  node.querySelector('.btn-general-done').addEventListener('click', async () => {
    const kmInput = prompt('¿A qué kilometraje se hizo el servicio general?', vehicle.currentKm);
    if (kmInput === null) return;
    try {
      await GarageDB.markGeneralServiceDone(vehicle.id, { km: Number(kmInput) });
      showToast('Mantenimiento general actualizado ✅');
      loadAndRenderVehicles();
    } catch (err) {
      showToast(err.message);
    }
  });

  // --- Mantenimientos específicos (expandible) ---
  const maintList = node.querySelector('.maint-list');
  const toggle = node.querySelector('.maint-toggle');
  const maintenances = vehicle.maintenances || [];

  toggle.querySelector('.maint-toggle-label').textContent = maintenances.length === 0
    ? 'Sin mantenimientos específicos'
    : `Mantenimientos específicos (${maintenances.length})`;

  const maintFragment = document.createDocumentFragment();
  maintenances.forEach((m) => {
    const result = evaluateMaintenance(vehicle, m);
    const row = els.maintRowTemplate.content.cloneNode(true);
    row.querySelector('.maint-type').textContent = m.type;
    row.querySelector('.maint-sub').textContent = formatKmDays(result.kmRemaining, result.daysRemaining);
    const badge = row.querySelector('.badge');
    badge.textContent = STATUS_LABEL[result.status];
    badge.classList.add(`badge-${result.status}`);

    row.querySelector('.btn-maint-done').addEventListener('click', async () => {
      const kmInput = prompt(`¿A qué kilometraje se hizo "${m.type}"?`, vehicle.currentKm);
      if (kmInput === null) return;
      try {
        await GarageDB.markMaintenanceDone(vehicle.id, m.id, { km: Number(kmInput) });
        showToast(`${m.type} actualizado ✅`);
        loadAndRenderVehicles();
      } catch (err) {
        showToast(err.message);
      }
    });

    maintFragment.appendChild(row);
  });
  maintList.appendChild(maintFragment);

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    maintList.classList.toggle('expanded', !expanded);
  });

  // --- Editar vehículo ---
  node.querySelector('.btn-edit-vehicle').addEventListener('click', () => openModal(vehicle));

  // --- Eliminar vehículo ---
  node.querySelector('.btn-delete-vehicle').addEventListener('click', async () => {
    if (!confirm(`¿Eliminar ${vehicle.brand} ${vehicle.model}? Esta acción no se puede deshacer.`)) return;
    await GarageDB.deleteVehicle(vehicle.id);
    showToast('Vehículo eliminado');
    loadAndRenderVehicles();
  });

  return node;
}

async function loadAndRenderVehicles() {
  els.skeletonList.classList.remove('hidden');

  let vehicles = await GarageDB.getAllVehicles();
  els.skeletonList.classList.add('hidden');

  // Orden por urgencia: danger primero, luego warn, luego ok.
  vehicles = vehicles.slice().sort((a, b) => {
    const rankA = STATUS_RANK[evaluateVehicleWorstStatus(a)];
    const rankB = STATUS_RANK[evaluateVehicleWorstStatus(b)];
    return rankB - rankA;
  });

  els.vehicleCount.textContent = vehicles.length === 0
    ? 'Sin vehículos registrados'
    : `${vehicles.length} vehículo${vehicles.length > 1 ? 's' : ''} en tu garaje`;

  els.emptyState.classList.toggle('hidden', vehicles.length > 0);

  const fragment = document.createDocumentFragment();
  vehicles.forEach(v => fragment.appendChild(renderVehicleCard(v)));
  els.vehicleList.replaceChildren(fragment);

  scheduleNotificationCheck(vehicles);
}

/* ============================================================
   5. AUTOCOMPLETE (API NHTSA + debounce + Cache API)
   ============================================================ */

function renderAutocomplete(listEl, items, onPick) {
  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item;
    li.addEventListener('click', () => onPick(item));
    fragment.appendChild(li);
  });
  listEl.replaceChildren(fragment);
  listEl.classList.toggle('show', items.length > 0);
}

const handleBrandInput = debounce(async (value) => {
  if (value.trim().length < 2) {
    els.brandList.classList.remove('show');
    return;
  }
  try {
    const brands = await fetchBrands(value);
    renderAutocomplete(els.brandList, brands, (brand) => {
      els.inputBrand.value = brand;
      els.brandList.classList.remove('show');
      els.inputModel.disabled = false;
      els.inputModel.value = '';
      els.inputModel.placeholder = 'Cargando modelos…';
      loadModelsFor(brand);
    });
  } catch {
    showToast('Sin conexión: no se pudieron cargar marcas');
  }
}, 350);

async function loadModelsFor(brand) {
  try {
    const models = await fetchModels(brand);
    els.inputModel.placeholder = 'Escribe o selecciona un modelo';
    els.modelList._models = models;
  } catch {
    els.inputModel.placeholder = 'Escribe el modelo manualmente';
  }
}

const handleModelInput = debounce((value) => {
  const models = els.modelList._models || [];
  const q = value.trim().toLowerCase();
  const filtered = q ? models.filter(m => m.toLowerCase().includes(q)) : models.slice(0, 8);
  renderAutocomplete(els.modelList, filtered, (model) => {
    els.inputModel.value = model;
    els.modelList.classList.remove('show');
  });
}, 250);

els.inputBrand.addEventListener('input', (e) => handleBrandInput(e.target.value));
els.inputModel.addEventListener('input', (e) => handleModelInput(e.target.value));
document.addEventListener('click', (e) => {
  if (!els.inputBrand.contains(e.target)) els.brandList.classList.remove('show');
  if (!els.inputModel.contains(e.target)) els.modelList.classList.remove('show');
});

/* ============================================================
   6. MODAL: chips de mantenimiento específico
   ============================================================ */

function addMaintDetail(type, prefill = {}) {
  const node = els.maintDetailTemplate.content.cloneNode(true);
  const detail = node.querySelector('.maint-detail');
  detail.dataset.type = type;
  detail.classList.add('active');

  const label = document.createElement('p');
  label.className = 'vehicle-meta';
  label.textContent = `${type}: intervalo y última vez`;
  detail.prepend(label);

  if (prefill.intervalKm) detail.querySelector('.maint-interval-km').value = prefill.intervalKm;
  if (prefill.intervalMonths) detail.querySelector('.maint-interval-months').value = prefill.intervalMonths;
  if (prefill.lastKm) detail.querySelector('.maint-last-km').value = prefill.lastKm;
  if (prefill.lastDate) detail.querySelector('.maint-last-date').value = prefill.lastDate;
  if (prefill.id) detail.dataset.maintId = prefill.id;
  if (prefill.history) detail.dataset.history = JSON.stringify(prefill.history);

  els.maintDetailsContainer.appendChild(detail);
  selectedMaintTypes.set(type, detail);
  return detail;
}

els.maintChipGrid.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const type = chip.dataset.type;
  const pressed = chip.getAttribute('aria-pressed') === 'true';

  if (pressed) {
    chip.setAttribute('aria-pressed', 'false');
    const detail = selectedMaintTypes.get(type);
    detail?.remove();
    selectedMaintTypes.delete(type);
  } else {
    chip.setAttribute('aria-pressed', 'true');
    addMaintDetail(type);
  }
});

/* ============================================================
   7. MODAL: abrir/cerrar (crear o editar), foco atrapado, submit
   ============================================================ */

function getFocusableElements(container) {
  return Array.from(container.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
  ));
}

function trapFocus(e) {
  if (e.key !== 'Tab') return;
  const modal = els.modalBackdrop.hidden ? null : els.modalBackdrop.querySelector('.modal-sheet');
  if (!modal) return;
  const focusable = getFocusableElements(modal);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function showFormError(message) {
  els.formError.textContent = message;
  els.formError.classList.remove('hidden');
}

function clearFormError() {
  els.formError.classList.add('hidden');
  els.formError.textContent = '';
}

/** @param {object|null} vehicle - si se pasa, el modal entra en modo edición. */
function openModal(vehicle = null) {
  clearFormError();
  lastFocusedBeforeModal = document.activeElement;

  if (vehicle) {
    els.modalTitle.textContent = 'Editar vehículo';
    els.btnSubmitVehicle.textContent = 'Guardar cambios';
    els.inputVehicleId.value = vehicle.id;

    els.inputBrand.value = vehicle.brand;
    els.inputModel.value = vehicle.model;
    els.inputModel.disabled = false;
    document.getElementById('inputYear').value = vehicle.year;
    document.getElementById('inputPlate').value = vehicle.plate;
    document.getElementById('inputCurrentKm').value = vehicle.currentKm;
    document.getElementById('inputGeneralInterval').value = vehicle.generalIntervalKm;
    document.getElementById('inputGeneralLastKm').value = vehicle.generalLastServiceKm;
    document.getElementById('inputGeneralLastDate').value = vehicle.generalLastServiceDate;
    document.getElementById('inputRegMonth').value = vehicle.registrationMonth;

    (vehicle.maintenances || []).forEach((m) => {
      const chip = els.maintChipGrid.querySelector(`.chip[data-type="${CSS.escape(m.type)}"]`);
      if (chip) chip.setAttribute('aria-pressed', 'true');
      addMaintDetail(m.type, m);
    });
  } else {
    els.modalTitle.textContent = 'Nuevo vehículo';
    els.btnSubmitVehicle.textContent = 'Guardar vehículo';
    els.inputVehicleId.value = '';
  }

  els.modalBackdrop.hidden = false;
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', trapFocus);
  document.addEventListener('keydown', handleEscKey);
  els.inputBrand.focus();
}

function handleEscKey(e) {
  if (e.key === 'Escape') closeModal();
}

function closeModal() {
  els.modalBackdrop.hidden = true;
  document.body.style.overflow = '';
  els.vehicleForm.reset();
  els.inputModel.disabled = true;
  els.maintChipGrid.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
  els.maintDetailsContainer.replaceChildren();
  selectedMaintTypes.clear();
  clearFormError();
  document.removeEventListener('keydown', trapFocus);
  document.removeEventListener('keydown', handleEscKey);
  lastFocusedBeforeModal?.focus();
}

els.btnAddVehicle.addEventListener('click', () => openModal());
els.btnCloseModal.addEventListener('click', closeModal);
els.modalBackdrop.addEventListener('click', (e) => {
  if (e.target === els.modalBackdrop) closeModal();
});

/** Validación de negocio antes de guardar. Devuelve string de error o null. */
function validateVehicle(vehicle) {
  if (!vehicle.brand) return 'La marca es obligatoria.';
  if (!vehicle.model) return 'El modelo es obligatorio.';
  if (!vehicle.plate) return 'La placa es obligatoria.';
  if (!vehicle.year || vehicle.year < 1970) return 'Ingresa un año válido.';
  if (vehicle.currentKm < 0) return 'El kilometraje actual no puede ser negativo.';
  if (vehicle.generalLastServiceKm > vehicle.currentKm) {
    return 'El km del último servicio general no puede ser mayor al kilometraje actual.';
  }
  if (!vehicle.generalLastServiceDate) return 'Ingresa la fecha del último servicio general.';
  if (new Date(vehicle.generalLastServiceDate) > new Date()) {
    return 'La fecha del último servicio general no puede ser futura.';
  }
  if (!vehicle.registrationMonth) return 'Selecciona el mes de inscripción del vehículo.';

  for (const m of vehicle.maintenances) {
    if (m.lastKm && m.lastKm > vehicle.currentKm) {
      return `"${m.type}": el km registrado no puede ser mayor al kilometraje actual.`;
    }
  }
  return null;
}

els.vehicleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearFormError();

  const maintenances = [];
  selectedMaintTypes.forEach((detail, type) => {
    const history = detail.dataset.history ? JSON.parse(detail.dataset.history) : [];
    maintenances.push({
      id: detail.dataset.maintId || crypto.randomUUID(),
      type,
      intervalKm: Number(detail.querySelector('.maint-interval-km').value) || 0,
      intervalMonths: Number(detail.querySelector('.maint-interval-months').value) || 0,
      lastKm: Number(detail.querySelector('.maint-last-km').value) || 0,
      lastDate: detail.querySelector('.maint-last-date').value || null,
      history,
    });
  });

  const vehicle = {
    brand: document.getElementById('inputBrand').value.trim(),
    model: document.getElementById('inputModel').value.trim(),
    year: document.getElementById('inputYear').value,
    plate: document.getElementById('inputPlate').value.trim().toUpperCase(),
    currentKm: Number(document.getElementById('inputCurrentKm').value) || 0,
    generalIntervalKm: Number(document.getElementById('inputGeneralInterval').value) || 0,
    generalLastServiceKm: Number(document.getElementById('inputGeneralLastKm').value) || 0,
    generalLastServiceDate: document.getElementById('inputGeneralLastDate').value,
    registrationMonth: Number(document.getElementById('inputRegMonth').value),
    maintenances,
  };

  const error = validateVehicle(vehicle);
  if (error) {
    showFormError(error);
    return;
  }

  const editingId = els.inputVehicleId.value;

  try {
    if (editingId) {
      const existing = await GarageDB.getVehicle(Number(editingId));
      await GarageDB.updateVehicle({
        ...existing,
        ...vehicle,
        id: Number(editingId),
        generalHistory: existing.generalHistory || [],
      });
      showToast('Vehículo actualizado ✅');
    } else {
      await GarageDB.addVehicle(vehicle);
      showToast('Vehículo guardado ✅');
    }
    closeModal();
    loadAndRenderVehicles();
  } catch (err) {
    showFormError(err.message);
  }
});

/* ============================================================
   8. TOAST
   ============================================================ */

let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add('show');
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

/* ============================================================
   9. NOTIFICACIONES LOCALES INTELIGENTES
   ============================================================ */

els.btnNotifPermission.addEventListener('click', async () => {
  if (!('Notification' in window)) {
    showToast('Este navegador no soporta notificaciones');
    return;
  }
  const permission = await Notification.requestPermission();
  showToast(permission === 'granted' ? 'Notificaciones activadas 🔔' : 'Notificaciones denegadas');
});

async function scheduleNotificationCheck(vehicles) {
  if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return;

  const registration = await navigator.serviceWorker.ready;
  const alerts = [];

  vehicles.forEach((vehicle) => {
    const label = `${vehicle.brand} ${vehicle.model}`;

    const general = evaluateGeneral(vehicle);
    if (general.status !== 'ok') {
      alerts.push(`Te faltan ${Math.max(general.kmRemaining, 0).toLocaleString()} km para el mantenimiento general de tu ${label}`);
    }

    const renewal = calcRenewal(vehicle.registrationMonth);
    if (renewal.status !== 'ok') {
      alerts.push(`Te faltan ${renewal.totalDays} días para renovar el revisado y la lata de tu ${label}`);
    }

    (vehicle.maintenances || []).forEach((m) => {
      const result = evaluateMaintenance(vehicle, m);
      if (result.status !== 'ok') {
        const kmPart = result.kmRemaining !== null && result.kmRemaining > 0
          ? `${result.kmRemaining.toLocaleString()} km`
          : null;
        alerts.push(`Te faltan ${kmPart || `${result.daysRemaining} días`} para: ${m.type} de tu ${label}`);
      }
    });
  });

  if (alerts.length > 0 && registration.active) {
    registration.active.postMessage({ type: 'SHOW_MAINTENANCE_ALERTS', alerts });
  }
}

/* ============================================================
   10. EXPORTAR / IMPORTAR RESPALDO JSON
   ============================================================ */

els.btnExport.addEventListener('click', async () => {
  try {
    const backup = await GarageDB.exportAll();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `mi-garaje-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Copia de seguridad descargada ⬇️');
  } catch (err) {
    showToast('No se pudo exportar: ' + err.message);
  }
});

els.btnImport.addEventListener('click', () => els.importFileInput.click());

els.importFileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data.vehicles)) throw new Error('El archivo no tiene el formato esperado.');
    pendingImportData = data;
    els.importSummary.textContent = `Se encontraron ${data.vehicles.length} vehículo(s) en el archivo. ¿Cómo quieres importarlos?`;
    els.importModalBackdrop.hidden = false;
  } catch (err) {
    showToast('Archivo inválido: ' + err.message);
  } finally {
    els.importFileInput.value = '';
  }
});

els.btnCloseImportModal.addEventListener('click', () => {
  els.importModalBackdrop.hidden = true;
  pendingImportData = null;
});

async function runImport(mode) {
  if (!pendingImportData) return;
  try {
    const count = await GarageDB.importAll(pendingImportData, mode);
    showToast(`${count} vehículo(s) importado(s) ✅`);
    els.importModalBackdrop.hidden = true;
    pendingImportData = null;
    loadAndRenderVehicles();
  } catch (err) {
    showToast('Error al importar: ' + err.message);
  }
}

els.btnImportMerge.addEventListener('click', () => runImport('merge'));
els.btnImportReplace.addEventListener('click', () => {
  if (!confirm('Esto borrará todos los vehículos actuales antes de importar. ¿Continuar?')) return;
  runImport('replace');
});

/* ============================================================
   11. SERVICE WORKER
   ============================================================ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      console.warn('No se pudo registrar el Service Worker');
    });
  });
}

/* ============================================================
   12. INIT
   ============================================================ */

loadAndRenderVehicles();

// Exportar funciones puras para tests/depuración manual desde consola.
window.__garageCalc = { calcKmStatus, calcTimeStatus, calcRenewal, combineStatus, evaluateVehicleWorstStatus };
