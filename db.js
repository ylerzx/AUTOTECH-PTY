/**
 * db.js — Capa de persistencia asíncrona (IndexedDB)
 * No bloquea el Main Thread. Expone una API basada en Promesas.
 *
 * Estructura de un "vehicle":
 * {
 *   id: number (autoIncrement),
 *   brand: string,
 *   model: string,
 *   year: string,
 *   plate: string,
 *   currentKm: number,
 *   generalIntervalKm: number,      // intervalo general sugerido por ficha técnica
 *   generalLastServiceKm: number,
 *   generalLastServiceDate: string, // ISO date
 *   registrationMonth: number,      // 1-12, mes de inscripción (revisado/lata)
 *   maintenances: [
 *     {
 *       id: string (uuid),
 *       type: string,              // "Cambio de aceite", "Frenos", etc.
 *       intervalKm: number,
 *       intervalMonths: number,
 *       lastKm: number,
 *       lastDate: string           // ISO date
 *     }
 *   ],
 *   createdAt: string
 * }
 */

const DB_NAME = 'garageDB';
const DB_VERSION = 1;
const STORE = 'vehicles';

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('brand', 'brand', { unique: false });
      }
    };

    req.onsuccess = (event) => resolve(event.target.result);
    req.onerror = (event) => reject(event.target.error);
  });

  return _dbPromise;
}

async function withStore(mode, callback) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = callback(store);

    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const GarageDB = {
  /** Añade un vehículo nuevo. Devuelve el id generado. */
  async addVehicle(vehicle) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.add({
        ...vehicle,
        maintenances: vehicle.maintenances || [],
        createdAt: new Date().toISOString()
      });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  /** Actualiza un vehículo existente (objeto completo). */
  async updateVehicle(vehicle) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.put(vehicle);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  /** Elimina un vehículo por id. */
  async deleteVehicle(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  },

  /** Obtiene todos los vehículos. */
  async getAllVehicles() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  /** Obtiene un vehículo por id. */
  async getVehicle(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  /** Añade una tarea de mantenimiento específica a un vehículo. */
  async addMaintenance(vehicleId, maintenance) {
    const vehicle = await this.getVehicle(vehicleId);
    if (!vehicle) throw new Error('Vehículo no encontrado');
    const entry = {
      id: crypto.randomUUID(),
      ...maintenance
    };
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
  }
};
