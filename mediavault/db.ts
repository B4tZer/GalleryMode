import type { VaultItem } from "./types";

const DB_NAME = "GalleryModeVault";
const DB_VERSION = 1;
const STORE_ITEMS = "vault_items";

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = event => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(STORE_ITEMS)) {
                const store = db.createObjectStore(STORE_ITEMS, { keyPath: "id" });
                store.createIndex("channelId", "channelId", { unique: false });
                store.createIndex("savedAt", "savedAt", { unique: false });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function saveVaultItem(item: VaultItem): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_ITEMS, "readwrite");
        const store = transaction.objectStore(STORE_ITEMS);

        const request = store.put(item);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
        transaction.onerror = () => db.close();
        transaction.onabort = () => db.close();
    });
}

export async function getAllVaultItems(): Promise<VaultItem[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_ITEMS, "readonly");
        const store = transaction.objectStore(STORE_ITEMS);
        const index = store.index("savedAt");

        const request = index.openCursor(null, "prev");
        const items: VaultItem[] = [];

        request.onsuccess = event => {
            const cursor = (event.target as IDBRequest).result;
            if (cursor) {
                items.push(cursor.value);
                cursor.continue();
            } else {
                resolve(items);
            }
        };

        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
        transaction.onerror = () => db.close();
        transaction.onabort = () => db.close();
    });
}

export async function deleteVaultItem(id: string): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_ITEMS, "readwrite");
        const store = transaction.objectStore(STORE_ITEMS);

        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
        transaction.onerror = () => db.close();
        transaction.onabort = () => db.close();
    });
}
