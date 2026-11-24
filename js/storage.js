// IndexedDB World Persistence + LocalStorage User Settings

const DB_NAME = 'BlockCraftDB';
const DB_VERSION = 1;
const STORE_WORLDS = 'worlds';
const SETTINGS_KEY = 'blockcraft_settings_v2';

export const DEFAULT_KEYBINDS = {
  forward: 'KeyW',
  backward: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  sneak: 'ShiftLeft',
  sprint: 'ControlLeft',
  inventory: 'KeyE',
  chat: 'KeyT',
  camera: 'KeyV',
  pause: 'Escape'
};

export function isTouchDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod|Android/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua));
}

const TOUCH_DEFAULT = isTouchDevice();

export const DEFAULT_SETTINGS = {
  renderDistance: TOUCH_DEFAULT ? 5 : 6,
  sensitivity: 1.0,
  fov: 72,
  flightSpeed: 1.0,    // Creative Flight Speed multiplier (1.0x .. 10.0x)
  difficulty: 'normal',
  mobSpawnRate: 1.0,
  hungerRate: 1.0,
  farmSpeed: 1.0,      // Crop / Wheat growth speed multiplier (0.5x .. 10x)
  generateStructures: true,
  bonusChest: false,
  controlStyle: 'joystick', // 'joystick' | 'dpad'
  showTouch: true,
  sound: true,
  minecraftUI: true,   // Classic Minecraft pixel bevel UI theme (revertable)
  largeUI: true,       // Larger iPad-friendly UI scale (revertable)
  shaders: TOUCH_DEFAULT ? 'enhanced' : 'ultra',    // 'off' | 'enhanced' | 'ultra'
  biomeEffects: true,  // Biome ambient particles & atmosphere
  allowCheats: false,  // Enable / disable cheat commands & creative shortcuts
  keybinds: { ...DEFAULT_KEYBINDS }
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, keybinds: { ...DEFAULT_KEYBINDS } };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      keybinds: { ...DEFAULT_KEYBINDS, ...(parsed.keybinds || {}) }
    };
  } catch {
    return { ...DEFAULT_SETTINGS, keybinds: { ...DEFAULT_KEYBINDS } };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_WORLDS)) {
        db.createObjectStore(STORE_WORLDS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listWorlds() {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_WORLDS, 'readonly');
      const req = tx.objectStore(STORE_WORLDS).getAll();
      req.onsuccess = () => {
        const list = (req.result || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        resolve(list);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function loadWorld(id) {
  const db = await openDB();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_WORLDS, 'readonly');
    const req = tx.objectStore(STORE_WORLDS).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveWorld(worldRecord) {
  const db = await openDB();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_WORLDS, 'readwrite');
    tx.objectStore(STORE_WORLDS).put({ ...worldRecord, updatedAt: Date.now() });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteWorld(id) {
  const db = await openDB();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_WORLDS, 'readwrite');
    tx.objectStore(STORE_WORLDS).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}
