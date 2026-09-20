/**
 * Adaptateur de stockage.
 * IndexedDB par défaut (standalone PWA).
 * Pour BnB Cleaner : implémenter SupabaseStorageAdapter
 * avec la même interface.
 */

export class StorageAdapter {
  async getAddresses() { throw new Error('Not implemented'); }
  async addAddress(addr) { throw new Error('Not implemented'); }
  async updateAddress(addr) { throw new Error('Not implemented'); }
  async deleteAddress(id) { throw new Error('Not implemented'); }
  async getTours() { throw new Error('Not implemented'); }
  async addTour(tour) { throw new Error('Not implemented'); }
  async updateTour(tour) { throw new Error('Not implemented'); }
  async deleteTour(id) { throw new Error('Not implemented'); }
  async getSetting(key) { throw new Error('Not implemented'); }
  async setSetting(key, value) { throw new Error('Not implemented'); }
  async getModel() { throw new Error('Not implemented'); }
  async saveModel(model) { throw new Error('Not implemented'); }
}

export class IndexedDBAdapter extends StorageAdapter {
  constructor(dbName = 'route-tracker', version = 2) {
    super();
    this.dbName = dbName;
    this.version = version;
    this._db = null;
  }

  async _open() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.version);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('addresses')) {
          db.createObjectStore('addresses', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('tours')) {
          const store = db.createObjectStore('tours', { keyPath: 'id', autoIncrement: true });
          store.createIndex('date', 'date', { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('model')) {
          db.createObjectStore('model', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => {
        this._db = req.result;
        resolve(this._db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async _tx(storeName, mode, fn) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const result = fn(store);
      if (result && result.onsuccess !== undefined) {
        result.onsuccess = () => resolve(result.result);
        result.onerror = () => reject(result.error);
      } else {
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
      }
    });
  }

  async getAddresses() {
    return this._tx('addresses', 'readonly', s => s.getAll());
  }
  async addAddress(addr) {
    return this._tx('addresses', 'readwrite', s => s.add(addr));
  }
  async updateAddress(addr) {
    return this._tx('addresses', 'readwrite', s => s.put(addr));
  }
  async deleteAddress(id) {
    return this._tx('addresses', 'readwrite', s => s.delete(id));
  }
  async getTours() {
    return this._tx('tours', 'readonly', s => s.getAll());
  }
  async addTour(tour) {
    return this._tx('tours', 'readwrite', s => s.add(tour));
  }
  async updateTour(tour) {
    return this._tx('tours', 'readwrite', s => s.put(tour));
  }
  async deleteTour(id) {
    return this._tx('tours', 'readwrite', s => s.delete(id));
  }
  async getSetting(key) {
    const result = await this._tx('settings', 'readonly', s => s.get(key));
    return result ? result.value : null;
  }
  async setSetting(key, value) {
    return this._tx('settings', 'readwrite', s => s.put({ key, value }));
  }
  async getModel() {
    const result = await this._tx('model', 'readonly', s => s.get('learned'));
    return result ? result.value : null;
  }
  async saveModel(model) {
    return this._tx('model', 'readwrite', s => s.put({ key: 'learned', value: model }));
  }
}

/**
 * TEMPLATE pour BnB Cleaner — à implémenter avec Supabase :
 *
 * export class SupabaseStorageAdapter extends StorageAdapter {
 *   constructor(supabaseClient) {
 *     super();
 *     this.db = supabaseClient;
 *   }
 *   async getAddresses() {
 *     const { data } = await this.db.from('logements').select('*');
 *     return data.map(r => ({ id: r.id, name: r.nom, lat: r.latitude, lon: r.longitude, address: r.adresse }));
 *   }
 *   async getTours() {
 *     const { data } = await this.db.from('tournees').select('*, arrets(*)');
 *     return data;
 *   }
 *   async addTour(tour) {
 *     const { data } = await this.db.from('tournees').insert(tour).select().single();
 *     return data.id;
 *   }
 *   // ... etc
 * }
 */
