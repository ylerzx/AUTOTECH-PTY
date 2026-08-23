/**
 * app.js — Lógica principal (Vanilla JS, sin dependencias).
 * - Consumo de API NHTSA con Cache API + debounce.
 * - Persistencia vía db.js (IndexedDB).
 * - Cálculos con funciones puras.
 * - Render vía DocumentFragment (evita layout thrashing).
 */

import { GarageDB } from './db.js';

/* ============================================================
   1. CONSTANTES Y HELPERS DE FECHA/CÁLCULO (funciones puras)
   ============================================================ */

const MS_PER_DAY = 86400000;
const NHTSA_BASE = 'https://vpic.nhtsa.dot.gov/api/vehicles';
const API_CACHE_NAME = 'nhtsa-api-cache-v1';

/** Días entre dos fechas (b - a), redondeado hacia abajo. Pura. */
function daysBetween(dateA, dateB) {
  return Math.floor((dateB.getTime() - dateA.getTime()) / MS_PER_DAY);
}

/**
 * Calcula el estado de un mantenimiento por kilometraje.
 * Pura: mismos inputs -> mismo output.
 * @returns {{kmRemaining:number, status:'ok'|'warn'|'danger'}}
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
 * @returns {{daysRemaining:number, status:'ok'|'warn'|'danger'}}
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

/**
 * Combina estado por km y por tiempo: el más urgente gana.
 * Pura.
 */
function combineStatus(kmResult, timeResult) {
  const rank = { danger: 2, warn: 1, ok: 0 };
  const worst = rank[kmResult.status] >= rank[timeResult.status] ? kmResult.status : timeResult.status;
  return {
    kmRemaining: kmResult.kmRemaining,
    daysRemaining: timeResult.daysRemaining,
    status: worst
  };
}

/**
 * Calcula fecha de renovación del revisado/lata dado el mes de inscripción.
 * Devuelve meses y días restantes hasta el próximo aniversario anual.
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

/** Calcula el estado combinado de una tarea de mantenimiento específica. */
function evaluateMaintenance(vehicle, maintenance) {
  const kmResult = calcKmStatus(vehicle.currentKm, Number(maintenance.lastKm) || 0, Number(maintenance.intervalKm) || 0);
  const timeResult = calcTimeStatus(maintenance.lastDate, Number(maintenance.intervalMonths) || 0);
  return combineStatus(kmResult, timeResult);
}

/** Calcula el estado del mantenimiento general de un vehículo. */
function evaluateGeneral(vehicle) {
  return calcKmStatus(vehicle.currentKm, vehicle.generalLastServiceKm, vehicle.generalIntervalKm);
}

/* ============================================================
   2. CAPA DE RED: API NHTSA + Cache API + Debounce
   ============================================================ */

/** Debounce genérico. */
function debounce(fn, wait = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/**
 * Fetch con Cache API: intenta caché primero (network-falling-back),
 * y guarda la respuesta de red para futuras consultas offline.
 */
async function cachedFetch(url) {
  if ('caches' in window) {
    const cache = await caches.open(API_CACHE_NAME);
    const cached = await cache.match(url);
    if (cached) {
      // Revalida en segundo plano sin bloquear la respuesta (stale-while-revalidate)
      fetch(url).then((res) => { if (res.ok) cache.put(url, res.clone()); }).catch(() => {});
      return cached.json();
    }
    try {
      const res = await fetch(url);
      if (res.ok) await cache.put(url, res.clone());
      return res.json();
    } catch (err) {
      throw err;
    }
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
  vehicleCount: document.getElementById('vehicleCount'),
  btnAddVehicle: document.getElementById('btnAddVehicle'),
  btnCloseModal: document.getElementById('btnCloseModal'),
  modalBackdrop: document.getElementById('modalBackdrop'),
  vehicleForm: document.getElementById('vehicleForm'),
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
};

const selectedMaintTypes = new Map(); // type -> detailElement

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

  // --- Estado general + trámites ---
  const generalResult = evaluateGeneral(vehicle);
  const renewal = calcRenewal(vehicle.registrationMonth);

  const statusGrid = node.querySelector('.general-status');
  statusGrid.appendChild(buildStatusItem('Mantenimiento general', formatKmDays(generalResult.kmRemaining, null)));
  statusGrid.appendChild(buildStatusItem('Revisado y lata', renewal.totalDays > 0 ? `${renewal.months}m ${renewal.days}d` : 'Vencido'));

  const worstGlobal = [generalResult.status, renewal.status].includes('danger') ? 'danger'
    : [generalResult.status, renewal.status].includes('warn') ? 'warn' : 'ok';
  statusGrid.appendChild(buildStatusItem('Estado global', STATUS_LABEL[worstGlobal]));

  // --- Mantenimientos específicos (expandible) ---
  const maintList = node.querySelector('.maint-list');
  const toggle = node.querySelector('.maint-toggle');
  const maintenances = vehicle.maintenances || [];

  if (maintenances.length === 0) {
    toggle.querySelector('.maint-toggle-label').textContent = 'Sin mantenimientos específicos';
  } else {
    toggle.querySelector('.maint-toggle-label').textContent = `Mantenimientos específicos (${maintenances.length})`;
  }

  const maintFragment = document.createDocumentFragment();
  maintenances.forEach((m) => {
    const result = evaluateMaintenance(vehicle, m);
    const row = els.maintRowTemplate.content.cloneNode(true);
    row.querySelector('.maint-type').textContent = m.type;
    row.querySelector('.maint-sub').textContent = formatKmDays(result.kmRemaining, result.daysRemaining);
    const badge = row.querySelector('.badge');
    badge.textContent = STATUS_LABEL[result.status];
    badge.classList.add(`badge-${result.status}`);
    maintFragment.appendChild(row);
  });
  maintList.appendChild(maintFragment);

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    maintList.classList.toggle('expanded', !expanded);
  });

  node.querySelector('.btn-delete-vehicle').addEventListener('click', async () => {
    if (!confirm(`¿Eliminar ${vehicle.brand} ${vehicle.model}?`)) return;
    await GarageDB.deleteVehicle(vehicle.id);
    showToast('Vehículo eliminado');
    loadAndRenderVehicles();
  });

  return node;
}

async function loadAndRenderVehicles() {
  const vehicles = await GarageDB.getAllVehicles();

  els.vehicleCount.textContent = vehicles.length === 0
    ? 'Sin vehículos registrados'
    : `${vehicles.length} vehículo${vehicles.length > 1 ? 's' : ''} en tu garaje`;

  els.emptyState.classList.toggle('hidden', vehicles.length > 0);

  // Render en un solo DocumentFragment: 1 sola reflow/repaint
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
    const node = els.maintDetailTemplate.content.cloneNode(true);
    const detail = node.querySelector('.maint-detail');
    detail.dataset.type = type;
    detail.classList.add('active');

    const label = document.createElement('p');
    label.className = 'vehicle-meta';
    label.textContent = `${type}: intervalo y última vez`;
    detail.prepend(label);

    els.maintDetailsContainer.appendChild(detail);
    selectedMaintTypes.set(type, detail);
  }
});

/* ============================================================
   7. MODAL: abrir/cerrar y submit
   ============================================================ */

function openModal() {
  els.modalBackdrop.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  els.modalBackdrop.hidden = true;
  document.body.style.overflow = '';
  els.vehicleForm.reset();
  els.inputModel.disabled = true;
  els.maintChipGrid.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
  els.maintDetailsContainer.replaceChildren();
  selectedMaintTypes.clear();
}

els.btnAddVehicle.addEventListener('click', openModal);
els.btnCloseModal.addEventListener('click', closeModal);
els.modalBackdrop.addEventListener('click', (e) => {
  if (e.target === els.modalBackdrop) closeModal();
});

els.vehicleForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const maintenances = [];
  selectedMaintTypes.forEach((detail, type) => {
    maintenances.push({
      id: crypto.randomUUID(),
      type,
      intervalKm: Number(detail.querySelector('.maint-interval-km').value) || 0,
      intervalMonths: Number(detail.querySelector('.maint-interval-months').value) || 0,
      lastKm: Number(detail.querySelector('.maint-last-km').value) || 0,
      lastDate: detail.querySelector('.maint-last-date').value || null,
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

  await GarageDB.addVehicle(vehicle);
  showToast('Vehículo guardado ✅');
  closeModal();
  loadAndRenderVehicles();
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

/**
 * Revisa todos los vehículos y envía al Service Worker las alertas
 * urgentes/próximas, incluyendo el tipo exacto de mantenimiento.
 */
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
   10. SERVICE WORKER
   ============================================================ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      console.warn('No se pudo registrar el Service Worker');
    });
  });
}

/* ============================================================
   11. INIT
   ============================================================ */

loadAndRenderVehicles();

// Exportar funciones puras para tests/depuración manual desde consola.
window.__garageCalc = { calcKmStatus, calcTimeStatus, calcRenewal, combineStatus };
