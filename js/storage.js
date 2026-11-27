// IndexedDB World Persistence + LocalStorage User Settings

const DB_NAME = 'BlockCraftDB';
const DB_VERSION = 1;
const STORE_WORLDS = 'worlds';
const SETTINGS_KEY = 'blockcraft_settings_v2';
const PLAYER_NAME_KEY = 'blockcraft_mp_name_v1';
const PLAYER_SKIN_KEY = 'blockcraft_player_skin_v1';

export const PLAYER_SKINS = [
  { id: 'steve',    name: 'Steve',    swatch: '#14a6ad', hair: '#3b2414' },
  { id: 'alex',     name: 'Alex',     swatch: '#5f9e3d', hair: '#d46a24' },
  { id: 'knight',   name: 'Knight',   swatch: '#9aa8b8', hair: '#304878' },
  { id: 'explorer', name: 'Explorer', swatch: '#b8844c', hair: '#3b281c' },
  { id: 'ender',    name: 'Ender',    swatch: '#8b5cf6', hair: '#16141f' },
  { id: 'sunny',    name: 'Builder',  swatch: '#e05246', hair: '#e8c15a' }
];

export function getSavedPlayerName() {
  try {
    const s = localStorage.getItem(PLAYER_NAME_KEY);
    if (s && s.trim()) return s.trim().slice(0, 16);
  } catch {}
  return `Player${Math.floor(100 + Math.random() * 899)}`;
}

export function savePlayerName(name) {
  const clean = String(name || '').trim().slice(0, 16) || 'Player';
  try { localStorage.setItem(PLAYER_NAME_KEY, clean); } catch {}
  return clean;
}

export function getSavedPlayerSkin() {
  try {
    const s = localStorage.getItem(PLAYER_SKIN_KEY);
    if (s && PLAYER_SKINS.some((sk) => sk.id === s)) return s;
  } catch {}
  return 'steve';
}

export function savePlayerSkin(skinId) {
  const valid = PLAYER_SKINS.some((sk) => sk.id === skinId) ? skinId : 'steve';
  try { localStorage.setItem(PLAYER_SKIN_KEY, valid); } catch {}
  return valid;
}

export const DEFAULT_KEYBINDS = {
  forward: 'KeyW',
  backward: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  sneak: 'ShiftLeft',
  sprint: 'ControlLeft',
  drop: 'KeyQ',
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
  shaders: TOUCH_DEFAULT ? 'medium' : 'ultra',    // 'low' | 'medium' | 'high' | 'ultra'
  adaptiveQuality: true, // Dynamic resolution scaling for Apple Silicon iPad smoothness
  biomeEffects: true,  // Biome ambient particles & atmosphere
  allowCheats: false,  // Enable / disable cheat commands & creative shortcuts
  keybinds: { ...DEFAULT_KEYBINDS }
};

export function normalizeShaderPreset(val) {
  if (val === 'low' || val === 'medium' || val === 'high' || val === 'ultra') return val;
  if (val === 'off') return 'low';
  if (val === 'enhanced') return 'medium';
  return TOUCH_DEFAULT ? 'medium' : 'ultra';
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, keybinds: { ...DEFAULT_KEYBINDS } };
    const parsed = JSON.parse(raw);
    const merged = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      keybinds: { ...DEFAULT_KEYBINDS, ...(parsed.keybinds || {}) }
    };
    merged.shaders = normalizeShaderPreset(merged.shaders);
    return merged;
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
