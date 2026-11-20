// Built-in Mods & Add-Ons System

const MODS_KEY = 'blockcraft_mods_v1';

export const MOD_LIST = [
  {
    id: 'treecapitator',
    name: 'Timber / TreeCapitator',
    icon: '🪓',
    desc: 'Breaking a tree log automatically chops connected logs above it.',
    defaultOn: false
  },
  {
    id: 'veinminer',
    name: 'VeinMiner',
    icon: '⛏️',
    desc: 'Mining an ore block chain-mines adjacent ores of the same type.',
    defaultOn: false
  },
  {
    id: 'minimap',
    name: 'Live Mini-Map Radar',
    icon: '🗺️',
    desc: 'Adds a live terrain & mob radar to the top-right HUD.',
    defaultOn: true
  },
  {
    id: 'keep_inventory',
    name: 'Keep Inventory',
    icon: '🎒',
    desc: 'Keep all items and XP when respawning after death.',
    defaultOn: true
  },
  {
    id: 'auto_smelt',
    name: 'Auto-Smelt & Magnet',
    icon: '🔥',
    desc: 'Mined blocks go directly to inventory and ores auto-smelt into ingots.',
    defaultOn: false
  },
  {
    id: 'super_mobility',
    name: 'Parkour & Speed Boost',
    icon: '⚡',
    desc: 'Higher jumps, faster sprint speed, and halved fall damage.',
    defaultOn: false
  },
  {
    id: 'moon_gravity',
    name: 'Moon Gravity',
    icon: '🌙',
    desc: 'Low-gravity physics for massive leaps across mountains.',
    defaultOn: false
  },
  {
    id: 'more_mobs',
    name: 'Wilderness Plus',
    icon: '🐺',
    desc: 'Increases wildlife & village guard Iron Golems across the world.',
    defaultOn: false
  }
];

export class ModManager {
  constructor() {
    this.enabled = {};
    for (const m of MOD_LIST) {
      this.enabled[m.id] = !!m.defaultOn;
    }
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(MODS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const m of MOD_LIST) {
          if (typeof parsed[m.id] === 'boolean') {
            this.enabled[m.id] = parsed[m.id];
          }
        }
      }
    } catch {}
  }

  save() {
    try {
      localStorage.setItem(MODS_KEY, JSON.stringify(this.enabled));
    } catch {}
  }

  isEnabled(id) {
    return !!this.enabled[id];
  }

  setEnabled(id, val) {
    this.enabled[id] = !!val;
    this.save();
  }

  getActiveCount() {
    return Object.values(this.enabled).filter(Boolean).length;
  }
}
