// Songs added from this device (phone, tablet or computer). They are stored inside
// the browser (IndexedDB), so they stay for next time and work offline. Nothing is uploaded.
const DB_NAME = 'cfm-files', STORE = 'files';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const tx = async (mode, fn) => {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(out?.result); };
    t.onerror = t.onabort = () => { db.close(); reject(t.error); };
  });
};

/** "Artist - Title.mp3" or just "Title.mp3" → { title, artist }. */
export function parseName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  const i = base.indexOf(' - ');
  return i > 0 ? { artist: base.slice(0, i).trim(), title: base.slice(i + 3).trim() } : { artist: '', title: base };
}

export async function listFiles() {
  try {
    const all = await tx('readonly', s => s.getAll());
    return (all || []).map(({ id, name, size, added }) => ({ id, name, size, added, ...parseName(name) })).sort((a, b) => b.added - a.added);
  } catch { return []; }
}

export async function addFile(file) {
  const id = `${file.name}|${file.size}|${file.lastModified || 0}`;
  await tx('readwrite', s => s.put({ id, name: file.name, size: file.size, type: file.type, added: Date.now(), blob: file }));
  return id;
}

export async function getFile(id) {
  const rec = await tx('readonly', s => s.get(id));
  if (!rec) throw new Error('That song is no longer stored on this device. Add it again.');
  return new File([rec.blob], rec.name, { type: rec.type });
}

export const removeFile = id => tx('readwrite', s => s.delete(id));

/** Ask the browser to keep these songs even when the device is low on space. */
export const keepStored = () => navigator.storage?.persist?.().catch(() => false);
