// Copies des pages scannées, gardées sur le téléphone (base IndexedDB du
// navigateur) pour pouvoir revérifier la feuille si une ligne a été mal lue.
// Elles ne quittent jamais le téléphone.

const DB_NAME = 'mes-interventions';
const STORE = 'pages';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000; // une semaine

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Lance une opération sur le magasin et renvoie son résultat une fois enregistrée.
async function withStore(mode, operation) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = operation(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export const savePage = (blob) => withStore('readwrite', (store) => store.add({ addedAt: Date.now(), blob }));
export const listPages = () => withStore('readonly', (store) => store.getAll());
export const countPages = () => withStore('readonly', (store) => store.count());
export const clearPages = () => withStore('readwrite', (store) => store.clear());

// Ménage : retire les pages de plus d'une semaine (liste jamais effacée).
export const removeOldPages = () =>
  withStore('readwrite', (store) => {
    store.openCursor().onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) return;
      if (Date.now() - cursor.value.addedAt > MAX_AGE) cursor.delete();
      cursor.continue();
    };
  });
