/**
 * db.js — Capa de persistencia asíncrona (IndexedDB)
 * No bloquea el Main Thread. Expone una API basada en Promesas.
 *
 * Estructura de un "vehicle" (esquema v2):
 * {
 *   id: number (autoIncrement),
 *   brand: string,
 *   model: string,
 *   year: string,
 *   plate: string,
 *   currentKm: number,
 *   generalIntervalKm: number,
 *   generalLastServiceKm: number,
 *   generalLastServiceDate: string,
 *   generalHistory: [{ km:number, date:string }],   // NUEVO en v2
 *   registrationMonth: number,
 *   maintenances: [
 *     {
 *       id: string (uuid),
 *       type: string,
 *       intervalKm: number,
 *       intervalMonths: number,
 *       lastKm: number,
 *       lastDate: string,
 *       history: [{ km:number, date:string }]        // NUEVO en v2
 *     }
 *   ],
 *   createdAt: string,
 *   updatedAt: string                                 // NUEVO en v2
 * }
 *
 * MIGRACIÓN DE ESQUEMA:
 * Si en el futuro cambias la forma de "vehicle" otra vez, sube DB_VERSION
 * y añade un bloque `if (oldVersion < N)` dentro de onupgradeneeded que
 * recorra los registros existentes con un cursor y los normalice.
 */

const DB_NAME = 'garageDB';
const DB_VERSION = 2;
const STORE = 'vehicles';

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      const tx = event.target.transaction;
      const oldVersion = event.oldVersion;

      let store;
      if (!db.objectStoreNames.contains(STORE)) {
        store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('brand', 'brand', { unique: false });
      } else {
        store = tx.objectStore(STORE);
      }

      // Migración v1 -> v2: añade generalHistory/history/updatedAt a registros viejos.
      if (oldVersion > 0 && oldVersion < 2) {
        store.openCursor().onsuccess = (cursorEvent) => {
          const cursor = cursorEvent.target.result;
          if (!cursor) return;
          const vehicle = cursor.value;
          vehicle.generalHistory = vehicle.generalHistory || [];
          vehicle.updatedAt = vehicle.updatedAt || new Date().toISOString();
          vehicle.maintenances = (vehicle.maintenances || []).map(m => ({
            ...m,
            history: m.history || []
          }));
          cursor.update(vehicle);
          cursor.continue();
        };
      }
    };

    req.onsuccess = (event) => resolve(event.target.result);
    req.onerror = (event) => reject(event.target.error);
  });

  return _dbPromise;
}

/** Envuelve errores de IndexedDB en mensajes legibles (cuota llena, bloqueado, etc). */
function friendlyError(err) {
  const name = err?.name || '';
  if (name === 'QuotaExceededError') {
    return new Error('No hay espacio de almacenamiento disponible en este dispositivo.');
  }
  if (name === 'InvalidStateError' || name === 'UnknownError') {
    return new Error('El almacenamiento local no está disponible (¿modo incógnito?).');
  }
  return new Error(err?.message || 'Error de almacenamiento local.');
}

export const GarageDB = {
  /** Añade un vehículo nuevo. Devuelve el id generado. */
  async addVehicle(vehicle) {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const now = new Date().toISOString();
        const req = store.add({
          ...vehicle,
          maintenances: (vehicle.maintenances || []).map(m => ({ ...m, history: m.history || [] })),
          generalHistory: vehicle.generalHistory || [],
          createdAt: now,
          updatedAt: now
        });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      throw friendlyError(err);
    }
  },

  /** Actualiza un vehículo existente (objeto completo). */
  async updateVehicle(vehicle) {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const req = store.put({ ...vehicle, updatedAt: new Date().toISOString() });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      throw friendlyError(err);
    }
  },

  /** Elimina un vehículo por id. */
  async deleteVehicle(id) {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const req = store.delete(id);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      throw friendlyError(err);
    }
  },

  /** Obtiene todos los vehículos. */
  async getAllVehicles() {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      throw friendlyError(err);
    }
  },

  /** Obtiene un vehículo por id. */
  async getVehicle(id) {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      throw friendlyError(err);
    }
  },

  /** Añade una tarea de mantenimiento específica a un vehículo. */
  async addMaintenance(vehicleId, maintenance) {
    const vehicle = await this.getVehicle(vehicleId);
    if (!vehicle) throw new Error('Vehículo no encontrado');
    const entry = { id: crypto.randomUUID(), history: [], ...maintenance };
    vehicle.maintenances = [...(vehicle.maintenances || []), entry];
    await this.updateVehicle(vehicle);
    return entry;
  },

  /** Elimina una tarea de mantenimiento específica de un vehículo. */
  async removeMaintenance(vehicleId, maintenanceId) {
    const vehicle = await this.getVehicle(vehicleId);
    if (!vehicle) throw new Error('Vehículo no encontrado');
    vehicle.maintenances = (vehicle.maintenances || []).filter(m => m.id !== maintenanceId);
    await this.updateVehicle(vehicle);
    return vehicle;
  },

  /**
   * Marca el mantenimiento GENERAL como realizado hoy (o en la fecha dada):
   * guarda el punto anterior en generalHistory y actualiza los campos "last*".
   */
  async markGeneralServiceDone(vehicleId, { km, date } = {}) {
    const vehicle = await this.getVehicle(vehicleId);
    if (!vehicle) throw new Error('Vehículo no encontrado');
    const doneDate = date || new Date().toISOString().slice(0, 10);
    const doneKm = Number(km) || vehicle.currentKm;

    vehicle.generalHistory = [
      ...(vehicle.generalHistory || []),
      { km: vehicle.generalLastServiceKm, date: vehicle.generalLastServiceDate }
    ].filter(h => h.date);

    vehicle.generalLastServiceKm = doneKm;
    vehicle.generalLastServiceDate = doneDate;
    if (doneKm > vehicle.currentKm) vehicle.currentKm = doneKm;

    await this.updateVehicle(vehicle);
    return vehicle;
  },

  /**
   * Marca un mantenimiento ESPECÍFICO como realizado hoy (o en la fecha dada):
   * guarda el punto anterior en su history[] y actualiza lastKm/lastDate.
   */
  async markMaintenanceDone(vehicleId, maintenanceId, { km, date } = {}) {
    const vehicle = await this.getVehicle(vehicleId);
    if (!vehicle) throw new Error('Vehículo no encontrado');
    const doneDate = date || new Date().toISOString().slice(0, 10);
    const doneKm = Number(km) || vehicle.currentKm;

    vehicle.maintenances = (vehicle.maintenances || []).map(m => {
      if (m.id !== maintenanceId) return m;
      const history = [...(m.history || [])];
      if (m.lastDate) history.push({ km: m.lastKm, date: m.lastDate });
      return { ...m, lastKm: doneKm, lastDate: doneDate, history };
    });

    if (doneKm > vehicle.currentKm) vehicle.currentKm = doneKm;
    await this.updateVehicle(vehicle);
    return vehicle;
  },

  /** Exporta todo el garaje como objeto plano serializable a JSON. */
  async exportAll() {
    const vehicles = await this.getAllVehicles();
    return {
      schema: 'garage-export-v1',
      exportedAt: new Date().toISOString(),
      vehicles
    };
  },

  /**
   * Importa un backup exportado con exportAll(). Modo 'merge' (agrega sin
   * borrar lo existente, generando ids nuevos) o 'replace' (borra todo primero).
   */
  async importAll(data, mode = 'merge') {
    if (!data || !Array.isArray(data.vehicles)) {
      throw new Error('Archivo de respaldo inválido.');
    }
    const db = await openDB();

    if (mode === 'replace') {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    let imported = 0;
    for (const vehicle of data.vehicles) {
      const { id, ...rest } = vehicle; // ids nuevos siempre, evita colisiones
      await this.addVehicle(rest);
      imported++;
    }
    return imported;
  }
};
