import * as THREE from 'three';
import { ITEMS, getItemCategory } from './blocks.js';
import { RECIPES, matchCraftingGrid, canCraftRecipe, quickCraftRecipe, matchesItemTag, SMELTING_RECIPES, FUEL_VALUES } from './recipes.js';
import { MOD_LIST } from './mods.js';
import { VILLAGER_TRADES } from './mobs.js';
import { DEFAULT_KEYBINDS } from './storage.js';
import { createSteveModel, updateSteveArmor } from './player.js';

// Smooth 24-stop non-linear Render Distance scale (2..1024 chunks — easy touch precision on iPad!)
const RD_STOPS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16, 20, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024];
function rdFromIdx(idx) {
  return RD_STOPS[Math.max(0, Math.min(RD_STOPS.length - 1, idx | 0))];
}
function rdToIdx(chunks) {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < RD_STOPS.length; i++) {
    const d = Math.abs(RD_STOPS[i] - chunks);
    if (d < bestDiff) { bestDiff = d; best = i; }
  }
  return best;
}
function rdLabel(v) {
  return v >= 768 ? `${v} (Mega LOD)` : (v > 128 ? `${v} (Ultra LOD)` : (v > 10 ? `${v} (LOD)` : `${v}`));
}

const KEYBIND_ACTIONS = [
  { id: 'forward', label: 'Move Forward' },
  { id: 'backward', label: 'Move Backward' },
  { id: 'left', label: 'Strafe Left' },
  { id: 'right', label: 'Strafe Right' },
  { id: 'jump', label: 'Jump / Fly Up' },
  { id: 'sneak', label: 'Sneak / Fly Down' },
  { id: 'sprint', label: 'Sprint' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'chat', label: 'Chat / Commands' },
  { id: 'camera', label: 'Switch Camera' },
  { id: 'pause', label: 'Pause Menu' }
];

function formatKeyCode(code) {
  if (!code) return '---';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map = {
    Space: 'SPACE',
    ShiftLeft: 'L-SHIFT',
    ShiftRight: 'R-SHIFT',
    ControlLeft: 'L-CTRL',
    ControlRight: 'R-CTRL',
    AltLeft: 'L-ALT',
    AltRight: 'R-ALT',
    Escape: 'ESC',
    Tab: 'TAB',
    Enter: 'ENTER',
    Backspace: 'BKSP',
    ArrowUp: 'UP',
    ArrowDown: 'DOWN',
    ArrowLeft: 'LEFT',
    ArrowRight: 'RIGHT'
  };
  return map[code] || code.toUpperCase();
}

const SPLASH_TEXTS = [
  'Lots of truthiness!',
  '40x Better Villagers!',
  'Reforge Pixel-Art Food!',
  'BSL Shaders & Mirror Water!',
  'Wild Deer, Foxes & Songbirds!',
  'Alpine Mountains & Villages!',
  '100% WebGL Voxel Engine!'
];

export class UIManager {
  constructor(textures, sound) {
    this.textures = textures;
    this.sound = sound;
    this.activeModal = null;
    this.isCraftingTable = false;
    this.craftGrid = new Array(9).fill(null);
    this.pickedSource = null; // { type: 'inv'|'armor'|'craft', index: number }
    this.activeFurnacePos = null;
    this.activeChestPos = null;
    this.creativeCategory = 'all';
    this.creativeGiveStack = true; // true = x64 (or max stack), false = x1

    // App callbacks wired by main.js
    this.game = null;
    this._lastStatsKey = '';
    this._lastCoords = '';
    this._lastBiome = '';
    this._lastTime = '';
    this._lastFps = '';
    this._lastTooltip = '';
    this._lastPlaceMode = null;
    this._lastBreakMode = null;
    this._lastEffectsKey = '';
    this.listeningKeybind = null;
    this._dragState = null;
    this._suppressNextClick = false;
    this._mmBgCanvas = null;
    this._mmLastPx = 1e9;
    this._mmLastPz = 1e9;
    this._mmLastSeed = null;

    // Classic Minecraft Create New World state (synced with stone toggle buttons on both Main & More World Options!)
    this.cwState = {
      mode: 'survival',
      worldType: 'infinite',
      difficulty: 'normal',
      allowCheats: false,
      generateStructures: true,
      bonusChest: false,
      mobSpawnRate: 1.0,
      hungerRate: 1.0,
      farmSpeed: 1.0
    };

    // Cache hot HUD DOM nodes to eliminate per-frame getElementById lookups!
    this.dom = {
      coords: document.getElementById('hud-coords'),
      biome: document.getElementById('hud-biome'),
      time: document.getElementById('hud-time'),
      fps: document.getElementById('hud-fps'),
      tooltip: document.getElementById('target-tooltip'),
      breakRing: document.getElementById('break-ring'),
      breakFill: document.getElementById('break-ring-fill'),
      btnBreak: document.getElementById('btn-break'),
      btnBreakIcon: document.getElementById('btn-break-icon'),
      btnBreakLbl: document.getElementById('btn-break-lbl'),
      btnPlace: document.getElementById('btn-place'),
      btnPlaceIcon: document.getElementById('btn-place-icon'),
      btnPlaceLbl: document.getElementById('btn-place-lbl'),
      btnFly: document.getElementById('btn-fly'),
      btnJumpLbl: document.getElementById('btn-jump-lbl'),
      btnSneakLbl: document.getElementById('btn-sneak-lbl'),
      survBars: document.getElementById('survival-bars'),
      modeBadge: document.getElementById('hud-mode-badge'),
      healthBar: document.getElementById('health-bar'),
      hungerBar: document.getElementById('hunger-bar'),
      armorBar: document.getElementById('armor-bar'),
      airBar: document.getElementById('air-bar'),
      xpFill: document.getElementById('xp-bar-fill'),
      xpLevel: document.getElementById('xp-level'),
      mmCanvas: document.getElementById('minimap-canvas'),
      mmHint: document.getElementById('minimap-village-hint'),
      effectsHud: document.getElementById('effects-hud')
    };

    this.bindStaticEvents();
  }

  bind(game) {
    this.game = game;
    this.hydratePixelIcons();
    this.buildHotbarDOM();
    // Creative catalog renders lazily on first Creative tab click for instant startup!
    this._creativeRendered = false;
    this.renderModsUI();
    this.renderKeybindsUI(game.settings.keybinds);
    this.syncCheatUI(game.areCheatsAllowed());
    const splash = document.getElementById('title-splash');
    if (splash) splash.textContent = SPLASH_TEXTS[Math.floor(Math.random() * SPLASH_TEXTS.length)];
  }

  showLoadingScreen(show, progress = 0, status = 'Generating terrain...', worldName = '') {
    const el = document.getElementById('loading-screen');
    if (!el) return;
    el.classList.toggle('hidden', !show);
    if (show) {
      const fill = document.getElementById('loading-bar-fill');
      const st = document.getElementById('loading-status');
      const wn = document.getElementById('loading-world-name');
      if (fill) fill.style.width = `${Math.round(Math.max(5, Math.min(100, progress * 100)))}%`;
      if (st && status) st.textContent = status;
      if (wn && worldName) wn.textContent = `Loading "${worldName}"`;
    }
  }

  updateFlyUI(isCreative, isFlying) {
    if (this.dom.btnFly) {
      this.dom.btnFly.classList.toggle('hidden', !isCreative);
      this.dom.btnFly.classList.toggle('active', Boolean(isFlying));
    }
    if (this.dom.btnJumpLbl) {
      this.dom.btnJumpLbl.textContent = isFlying ? 'UP' : 'JUMP';
    }
    if (this.dom.btnSneakLbl) {
      this.dom.btnSneakLbl.textContent = isFlying ? 'DOWN' : 'SNEAK';
    }
  }

  showTitleView(viewName = 'home') {
    this.cancelKeybindListen();
    const views = ['home', 'singleplayer', 'create-world', 'multiplayer', 'mods', 'settings', 'guide'];
    for (const v of views) {
      const el = document.getElementById(`title-view-${v}`);
      if (el) el.classList.toggle('hidden', v !== viewName);
    }
    if (viewName === 'create-world') {
      document.getElementById('cw-page-main')?.classList.remove('hidden');
      document.getElementById('cw-page-more')?.classList.add('hidden');
      this.syncCreateWorldUI();
    }
    if (viewName === 'mods') this.renderModsUI();
    if (viewName === 'settings' && this.game) {
      this.syncSettingsUI(this.game.settings);
      this.syncCheatUI(this.game.areCheatsAllowed());
    }
  }

  syncCreateWorldUI() {
    const s = this.cwState;
    const setTxt = (id, txt) => {
      const el = document.getElementById(id);
      if (el) el.textContent = txt;
    };
    const nameEl = document.getElementById('new-world-name');
    setTxt('cw-save-hint', (nameEl?.value.trim() || 'My World'));

    // Game Mode
    const isCre = s.mode === 'creative';
    setTxt('cw-btn-mode', `Game Mode: ${isCre ? 'Creative' : 'Survival'}`);
    setTxt('cw-sub-mode', isCre
      ? 'Unlimited resources, free flying and destroy blocks instantly'
      : 'Search for resources, crafting, gain levels, health and hunger');

    // Difficulty
    const diffNames = { peaceful: 'Peaceful', easy: 'Easy', normal: 'Normal', hard: 'Hard' };
    const diffSubs = {
      peaceful: 'No hostile mobs; health & hunger regenerate automatically',
      easy: 'Gentle survival challenge with lower monster damage',
      normal: 'Standard survival challenge & hostile mobs',
      hard: 'Tougher monsters, higher damage & intense survival'
    };
    setTxt('cw-btn-difficulty', `Difficulty: ${diffNames[s.difficulty] || 'Normal'}`);
    setTxt('cw-sub-difficulty', diffSubs[s.difficulty] || diffSubs.normal);

    // World Type
    const isFlat = s.worldType === 'flat';
    const wtLbl = `World Type: ${isFlat ? 'Superflat' : 'Default'}`;
    const wtSub = isFlat ? 'Completely flat plains ideal for creative building' : 'Infinite Biomes, Oceans, Villages & Pyramids';
    setTxt('cw-btn-type', wtLbl);
    setTxt('cw-sub-type', wtSub);
    setTxt('cw-btn-type-2', wtLbl);
    setTxt('cw-sub-type-2', wtSub);

    // Allow Cheats
    const cheatLbl = `Allow Cheats: ${s.allowCheats ? 'ON' : 'OFF'}`;
    setTxt('cw-btn-cheats', cheatLbl);
    setTxt('cw-btn-cheats-2', cheatLbl);

    // Generate Structures & Bonus Chest
    setTxt('cw-btn-structures', `Generate Structures: ${s.generateStructures ? 'ON' : 'OFF'}`);
    setTxt('cw-btn-bonus', `Bonus Chest: ${s.bonusChest ? 'ON' : 'OFF'}`);

    // Mob Spawn Rate, Hunger Speed, Farm Speed
    const mobLabels = { 0: 'Off (0×)', 0.5: 'Low (0.5×)', 1: 'Normal (1.0×)', 1.8: 'High (1.8×)', 3: 'Swarm (3.0×)' };
    const hunLabels = { 0: 'Off (0×)', 0.5: 'Slow (0.5×)', 1: 'Normal (1.0×)', 1.8: 'Fast (1.8×)', 3: 'Extreme (3.0×)' };
    const farmLabels = { 0: 'Paused (0×)', 0.5: 'Slow (0.5×)', 1: 'Normal (1.0×)', 2: 'Fast (2.0×)', 4: 'Turbo (4.0×)', 10: 'Hyper (10×)' };
    setTxt('cw-btn-mob-rate', `Mob Spawn Rate: ${mobLabels[s.mobSpawnRate] || `${s.mobSpawnRate}×`}`);
    setTxt('cw-btn-hunger-rate', `Hunger Speed: ${hunLabels[s.hungerRate] || `${s.hungerRate}×`}`);
    setTxt('cw-btn-farm-speed', `Farm Speed: ${farmLabels[s.farmSpeed] || `${s.farmSpeed}×`}`);
  }

  hydratePixelIcons() {
    document.querySelectorAll('img[data-px-icon]').forEach((img) => {
      const key = img.dataset.pxIcon;
      const src = this.textures.getUiIcon(key);
      if (src) img.src = src;
    });
  }

  bindStaticEvents() {
    // Modal close buttons (including classic Inventory, Crafting, Chest & Furnace close buttons + backdrop tap!)
    document.querySelectorAll('.close-modal-btn, .mc-classic-close').forEach((btn) => {
      btn.addEventListener('click', () => this.closeModals());
    });
    for (const mid of ['inventory-modal', 'crafting-modal', 'chest-modal', 'furnace-modal']) {
      document.getElementById(mid)?.addEventListener('click', (e) => {
        if (e.target && e.target.id === mid) this.closeModals();
      });
    }
    document.getElementById('btn-furnace-book')?.addEventListener('click', () => {
      const panel = document.getElementById('furnace-book-panel');
      if (!panel) return;
      const willOpen = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !willOpen);
      document.getElementById('btn-furnace-book')?.classList.toggle('active', willOpen);
      if (willOpen) this.renderFurnaceRecipeBook();
      this.sound.playPop();
    });

    // Classic Inventory Green Recipe Book & Creative Drawer toggles
    this._invDrawerMode = null; // null | 'recipes' | 'creative'
    const setInvDrawer = (mode) => {
      const panel = document.getElementById('inv-book-panel');
      const recDiv = document.getElementById('inv-drawer-recipes');
      const creDiv = document.getElementById('inv-drawer-creative');
      const titleEl = document.getElementById('inv-drawer-title');
      if (!panel) return;
      const next = this._invDrawerMode === mode ? null : mode;
      this._invDrawerMode = next;
      panel.classList.toggle('hidden', !next);
      document.getElementById('btn-inv-book')?.classList.toggle('active', next === 'recipes');
      document.getElementById('btn-inv-creative')?.classList.toggle('active', next === 'creative');
      if (recDiv) recDiv.classList.toggle('hidden', next !== 'recipes');
      if (creDiv) creDiv.classList.toggle('hidden', next !== 'creative');
      if (titleEl) titleEl.textContent = next === 'creative' ? 'Creative Catalog' : 'Recipe Book';
      if (next === 'recipes') this.renderRecipeBook(false);
      if (next === 'creative') {
        this._creativeRendered = true;
        this.renderCreativeCatalog(document.getElementById('creative-search')?.value || '');
      }
      this.sound.playPop();
    };
    document.getElementById('btn-inv-book')?.addEventListener('click', () => setInvDrawer('recipes'));
    document.getElementById('btn-inv-creative')?.addEventListener('click', () => setInvDrawer('creative'));
    document.getElementById('btn-inv-drawer-close')?.addEventListener('click', () => setInvDrawer(null));

    // Classic 3x3 Crafting Table Green Recipe Book toggle
    document.getElementById('btn-craft-book')?.addEventListener('click', () => {
      const panel = document.getElementById('craft-book-panel');
      if (!panel) return;
      const willOpen = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !willOpen);
      document.getElementById('btn-craft-book')?.classList.toggle('active', willOpen);
      if (willOpen) this.renderRecipeBook(true);
      this.sound.playPop();
    });
    document.getElementById('btn-craft-drawer-close')?.addEventListener('click', () => {
      document.getElementById('craft-book-panel')?.classList.add('hidden');
      document.getElementById('btn-craft-book')?.classList.remove('active');
    });

    // Live smooth 3D Steve cursor tracking across the entire viewport while Player Inventory is open!
    this._steveTargetX = 0.22;
    this._steveTargetY = 0.04;
    this._steveLookX = 0.22;
    this._steveLookY = 0.04;
    this._stevePreviewRAF = null;
    this._inv3d = null;
    const onInvPointer = (e) => {
      if (this.activeModal !== 'inventory-modal') return;
      const box = document.getElementById('inv-player-preview');
      if (!box) return;
      const r = box.getBoundingClientRect();
      const cx = r.left + r.width * 0.5;
      const cy = r.top + r.height * 0.28;
      this._steveTargetX = Math.max(-1, Math.min(1, (e.clientX - cx) / 210));
      this._steveTargetY = Math.max(-1, Math.min(1, (e.clientY - cy) / 180));
    };
    window.addEventListener('pointermove', onInvPointer, { passive: true });
    window.addEventListener('pointerdown', onInvPointer, { passive: true });

    // Creative search, categories, stack mode & clear inventory
    document.getElementById('creative-search')?.addEventListener('input', (e) => {
      this._creativeRendered = true;
      this.renderCreativeCatalog(e.target.value);
    });
    document.querySelectorAll('#creative-cats .cat-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        this.creativeCategory = chip.dataset.cat || 'all';
        document.querySelectorAll('#creative-cats .cat-chip').forEach((c) => c.classList.toggle('active', c === chip));
        this._creativeRendered = true;
        this.renderCreativeCatalog(document.getElementById('creative-search')?.value || '');
      });
    });
    const stackBtn = document.getElementById('btn-creative-stack');
    if (stackBtn) {
      stackBtn.addEventListener('click', () => {
        this.creativeGiveStack = !this.creativeGiveStack;
        stackBtn.textContent = this.creativeGiveStack ? '×64' : '×1';
        this.sound.playPop();
      });
    }
    const clearInvBtn = document.getElementById('btn-creative-clear');
    if (clearInvBtn) {
      clearInvBtn.addEventListener('click', () => {
        if (!this.game) return;
        this.game.inventory.slots.fill(null);
        this.game.inventory.armor.fill(null);
        this.game.inventory.offhand = null;
        this.sound.playPop();
        this.renderInventoryModal();
        this.updateHotbar();
        this.toast('Inventory cleared');
      });
    }
    document.getElementById('recipe-search')?.addEventListener('input', () => {
      this.renderRecipeBook(false);
    });
    document.getElementById('craft-recipe-search')?.addEventListener('input', () => {
      this.renderRecipeBook(true);
    });

    // Minecraft Java Main Menu navigation buttons
    document.querySelectorAll('[data-title-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (this.sound && this.sound.playPop) this.sound.playPop();
        this.showTitleView(btn.dataset.titleView);
      });
    });

    // Quick Accessibility / Large UI Scale toggle button (Java bottom-right square button)
    const quickScaleBtn = document.getElementById('btn-quick-scale');
    if (quickScaleBtn) {
      quickScaleBtn.addEventListener('click', () => {
        if (!this.game) return;
        const next = !this.game.settings.largeUI;
        this.game.updateSetting('largeUI', next);
        this.syncSettingsUI(this.game.settings);
        this.toast(next ? 'Large UI Scale ON' : 'Compact UI Scale ON');
      });
    }

    // Title Options controls (synced with Pause settings!)
    const titleShaders = document.getElementById('title-set-shaders');
    if (titleShaders) {
      titleShaders.addEventListener('change', (e) => {
        if (this.game) {
          this.game.updateSetting('shaders', e.target.value);
          this.syncSettingsUI(this.game.settings);
        }
      });
    }
    const titleRD = document.getElementById('title-set-render-dist');
    if (titleRD) {
      titleRD.addEventListener('input', (e) => {
        const v = rdFromIdx(parseInt(e.target.value, 10));
        document.getElementById('title-val-render-dist').textContent = rdLabel(v);
        if (this.game) {
          this.game.updateSetting('renderDistance', v);
          this.syncSettingsUI(this.game.settings);
        }
      });
    }
    const titleFS = document.getElementById('title-set-flight-speed');
    if (titleFS) {
      titleFS.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        const lbl = document.getElementById('title-val-flight-speed');
        if (lbl) lbl.textContent = v.toFixed(1);
        if (this.game) {
          this.game.updateSetting('flightSpeed', v);
          this.syncSettingsUI(this.game.settings);
        }
      });
    }

    // Placeholder Multiplayer Server Browser interactions
    const mpList = document.getElementById('mp-server-list');
    const mpMsg = document.getElementById('mp-status-msg');
    if (mpList) {
      mpList.querySelectorAll('.mp-server-row').forEach((row) => {
        row.addEventListener('click', () => {
          mpList.querySelectorAll('.mp-server-row').forEach((r) => r.classList.remove('selected'));
          row.classList.add('selected');
          if (mpMsg) mpMsg.textContent = `Selected "${row.dataset.server}" — Multiplayer servers are a placeholder (coming soon!).`;
        });
      });
    }
    const setMpMsg = (txt) => {
      if (mpMsg) mpMsg.textContent = txt;
      this.toast(txt);
    };
    document.getElementById('btn-mp-join')?.addEventListener('click', () => {
      const sel = mpList?.querySelector('.mp-server-row.selected')?.dataset.server || 'Server';
      setMpMsg(`Cannot connect to ${sel} yet — Multiplayer is coming in a future update!`);
    });
    document.getElementById('btn-mp-direct')?.addEventListener('click', () => {
      setMpMsg('Direct Connection is a placeholder — online servers coming soon!');
    });
    document.getElementById('btn-mp-add')?.addEventListener('click', () => {
      setMpMsg('Add Server is a placeholder — custom servers coming soon!');
    });
    document.getElementById('btn-mp-refresh')?.addEventListener('click', () => {
      setMpMsg('Refreshed placeholder server list (0 online — coming soon!).');
    });

    // HUD buttons
    document.getElementById('btn-inventory').addEventListener('click', () => this.openInventory(false));
    document.getElementById('btn-bag-hud').addEventListener('click', () => this.openInventory(false));
    document.getElementById('btn-mods-hud').addEventListener('click', () => this.openModsModal());
    document.getElementById('btn-pause').addEventListener('click', () => this.openPause());
    document.getElementById('btn-chat').addEventListener('click', () => this.openChat());
    document.getElementById('btn-camera').addEventListener('click', () => {
      if (this.game) this.game.toggleCamera();
    });

    // Pause buttons
    document.getElementById('btn-resume').addEventListener('click', () => this.closeModals());
    document.getElementById('btn-save-now')?.addEventListener('click', () => {
      if (this.game) this.game.saveCurrentWorld(true);
    });
    document.getElementById('btn-toggle-mode').addEventListener('click', () => {
      if (this.game) {
        const next = this.game.player.mode === 'survival' ? 'creative' : 'survival';
        if (this.game.setGameMode(next)) this.closeModals();
      }
    });
    document.getElementById('btn-respawn-spawn').addEventListener('click', () => {
      if (this.game) {
        this.game.player.respawn();
        this.closeModals();
        this.toast('Teleported to spawn');
      }
    });
    document.getElementById('btn-save-quit')?.addEventListener('click', () => {
      if (this.game) this.game.quitToTitle();
    });

    // Inventory Drag-and-Drop + Delete / Trash Drop Zone
    this.bindInventoryDragAndTrash();

    // Settings inputs
    document.getElementById('set-render-dist').addEventListener('input', (e) => {
      const v = rdFromIdx(parseInt(e.target.value, 10));
      document.getElementById('val-render-dist').textContent = rdLabel(v);
      if (this.game) this.game.updateSetting('renderDistance', v);
    });
    document.getElementById('set-sensitivity').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      document.getElementById('val-sensitivity').textContent = v.toFixed(1);
      if (this.game) this.game.updateSetting('sensitivity', v);
    });
    document.getElementById('set-fov').addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.getElementById('val-fov').textContent = v;
      if (this.game) this.game.updateSetting('fov', v);
    });
    document.getElementById('set-flight-speed')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      const lbl = document.getElementById('val-flight-speed');
      if (lbl) lbl.textContent = v.toFixed(1);
      if (this.game) {
        this.game.updateSetting('flightSpeed', v);
        const tFS = document.getElementById('title-set-flight-speed');
        const tFSLbl = document.getElementById('title-val-flight-speed');
        if (tFS) tFS.value = v;
        if (tFSLbl) tFSLbl.textContent = v.toFixed(1);
      }
    });
    document.getElementById('set-shaders').addEventListener('change', (e) => {
      if (this.game) this.game.updateSetting('shaders', e.target.value);
    });
    document.getElementById('set-difficulty')?.addEventListener('change', (e) => {
      if (this.game) this.game.setDifficulty(e.target.value);
    });
    document.getElementById('set-mob-rate')?.addEventListener('change', (e) => {
      if (this.game) this.game.setMobSpawnRate(parseFloat(e.target.value));
    });
    document.getElementById('set-hunger-rate')?.addEventListener('change', (e) => {
      if (this.game) this.game.setHungerRate(parseFloat(e.target.value));
    });
    document.getElementById('set-farm-speed')?.addEventListener('change', (e) => {
      if (this.game) this.game.setFarmSpeed(parseFloat(e.target.value));
    });
    document.getElementById('title-set-farm-speed')?.addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      this.cwState.farmSpeed = v;
      if (this.game) {
        this.game.setFarmSpeed(v, true);
        this.syncSettingsUI(this.game.settings);
      }
    });
    document.getElementById('set-mc-ui').addEventListener('change', (e) => {
      if (this.game) this.game.updateSetting('minecraftUI', e.target.checked);
    });
    document.getElementById('set-large-ui').addEventListener('change', (e) => {
      if (this.game) this.game.updateSetting('largeUI', e.target.checked);
    });
    document.getElementById('set-biome-fx').addEventListener('change', (e) => {
      if (this.game) this.game.updateSetting('biomeEffects', e.target.checked);
    });
    document.getElementById('set-adaptive')?.addEventListener('change', (e) => {
      if (this.game) {
        this.game.updateSetting('adaptiveQuality', e.target.checked);
        this.syncSettingsUI(this.game.settings);
      }
    });
    document.getElementById('title-set-adaptive')?.addEventListener('change', (e) => {
      if (this.game) {
        this.game.updateSetting('adaptiveQuality', e.target.checked);
        this.syncSettingsUI(this.game.settings);
      }
    });
    document.getElementById('set-control-style').addEventListener('change', (e) => {
      if (this.game) this.game.updateSetting('controlStyle', e.target.value);
    });
    document.getElementById('set-show-touch').addEventListener('change', (e) => {
      if (this.game) this.game.updateSetting('showTouch', e.target.checked);
    });
    document.getElementById('set-sound').addEventListener('change', (e) => {
      if (this.game) this.game.updateSetting('sound', e.target.checked);
    });
    document.getElementById('set-allow-cheats').addEventListener('change', (e) => {
      if (this.game) this.game.setAllowCheats(e.target.checked);
    });
    document.getElementById('title-set-allow-cheats').addEventListener('change', (e) => {
      this.cwState.allowCheats = Boolean(e.target.checked);
      this.syncCreateWorldUI();
      if (this.game) this.game.setAllowCheats(e.target.checked);
    });
    document.getElementById('btn-reset-keybinds').addEventListener('click', () => {
      this.cancelKeybindListen();
      if (this.game) this.game.resetKeybinds();
    });
    document.getElementById('btn-title-reset-keybinds').addEventListener('click', () => {
      this.cancelKeybindListen();
      if (this.game) this.game.resetKeybinds();
    });

    // Global capture listener for live Keybind rebinding
    window.addEventListener('keydown', (e) => {
      if (!this.listeningKeybind) return;
      e.preventDefault();
      e.stopPropagation();
      const action = this.listeningKeybind;
      this.cancelKeybindListen();
      if (e.code === 'Escape') {
        if (this.game) this.renderKeybindsUI(this.game.settings.keybinds);
        return;
      }
      if (this.game) {
        this.game.updateKeybind(action, e.code);
        this.toast(`Bound to ${formatKeyCode(e.code)}`);
      }
    }, true);

    // Chat & Quick commands
    const sendChat = () => {
      const inp = document.getElementById('chat-input');
      const txt = inp.value.trim();
      if (txt && this.game) {
        this.game.handleChatCommand(txt);
        inp.value = '';
      }
      this.closeModals();
    };
    document.getElementById('btn-send-chat').addEventListener('click', sendChat);
    document.getElementById('chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChat();
    });
    document.querySelectorAll('.cmd-chip[data-cmd]').forEach((chip) => {
      chip.addEventListener('click', () => {
        if (this.game) this.game.handleChatCommand(chip.dataset.cmd);
        this.closeModals();
      });
    });

    // Quick Time-of-Day buttons inside Pause Menu
    document.querySelectorAll('.pause-time-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (this.game) {
          const ok = this.game.handleChatCommand(`/time set ${btn.dataset.time}`);
          if (ok) {
            this.closeModals();
            this.toast(`Time set to ${btn.dataset.time.toUpperCase()}`);
          }
        }
      });
    });

    // Death screen
    document.getElementById('btn-death-respawn').addEventListener('click', () => {
      document.getElementById('death-screen').classList.add('hidden');
      if (this.game) {
        this.game.player.respawn();
        this.game.controls.enabled = true;
      }
    });
    document.getElementById('btn-death-title').addEventListener('click', () => {
      document.getElementById('death-screen').classList.add('hidden');
      if (this.game) this.game.quitToTitle();
    });

    // Classic Minecraft Create New World screen stone cycle/toggle controls!
    const cycleVal = (arr, cur) => arr[(arr.indexOf(cur) + 1) % arr.length];
    document.getElementById('new-world-name')?.addEventListener('input', () => this.syncCreateWorldUI());
    document.getElementById('cw-btn-mode')?.addEventListener('click', () => {
      this.cwState.mode = this.cwState.mode === 'survival' ? 'creative' : 'survival';
      if (this.cwState.mode === 'creative') this.cwState.allowCheats = true;
      this.sound.playPop();
      this.syncCreateWorldUI();
    });
    document.getElementById('cw-btn-difficulty')?.addEventListener('click', () => {
      this.cwState.difficulty = cycleVal(['peaceful', 'easy', 'normal', 'hard'], this.cwState.difficulty);
      this.sound.playPop();
      this.syncCreateWorldUI();
    });
    const toggleWorldType = () => {
      this.cwState.worldType = this.cwState.worldType === 'infinite' ? 'flat' : 'infinite';
      this.sound.playPop();
      this.syncCreateWorldUI();
    };
    document.getElementById('cw-btn-type')?.addEventListener('click', toggleWorldType);
    document.getElementById('cw-btn-type-2')?.addEventListener('click', toggleWorldType);
    const toggleCheats = () => {
      this.cwState.allowCheats = !this.cwState.allowCheats;
      this.sound.playPop();
      this.syncCreateWorldUI();
    };
    document.getElementById('cw-btn-cheats')?.addEventListener('click', toggleCheats);
    document.getElementById('cw-btn-cheats-2')?.addEventListener('click', toggleCheats);
    document.getElementById('cw-btn-structures')?.addEventListener('click', () => {
      this.cwState.generateStructures = !this.cwState.generateStructures;
      this.sound.playPop();
      this.syncCreateWorldUI();
    });
    document.getElementById('cw-btn-bonus')?.addEventListener('click', () => {
      this.cwState.bonusChest = !this.cwState.bonusChest;
      this.sound.playPop();
      this.syncCreateWorldUI();
    });
    document.getElementById('cw-btn-mob-rate')?.addEventListener('click', () => {
      this.cwState.mobSpawnRate = cycleVal([0, 0.5, 1, 1.8, 3], this.cwState.mobSpawnRate);
      this.sound.playPop();
      this.syncCreateWorldUI();
    });
    document.getElementById('cw-btn-hunger-rate')?.addEventListener('click', () => {
      this.cwState.hungerRate = cycleVal([0, 0.5, 1, 1.8, 3], this.cwState.hungerRate);
      this.sound.playPop();
      this.syncCreateWorldUI();
    });
    document.getElementById('cw-btn-farm-speed')?.addEventListener('click', () => {
      this.cwState.farmSpeed = cycleVal([0, 0.5, 1, 2, 4, 10], this.cwState.farmSpeed);
      this.sound.playPop();
      this.syncCreateWorldUI();
    });
    document.getElementById('cw-btn-more')?.addEventListener('click', () => {
      this.sound.playPop();
      document.getElementById('cw-page-main')?.classList.add('hidden');
      document.getElementById('cw-page-more')?.classList.remove('hidden');
      this.syncCreateWorldUI();
    });
    document.getElementById('cw-btn-done')?.addEventListener('click', () => {
      this.sound.playPop();
      document.getElementById('cw-page-more')?.classList.add('hidden');
      document.getElementById('cw-page-main')?.classList.remove('hidden');
      this.syncCreateWorldUI();
    });

    // Create World button
    document.getElementById('btn-create-world').addEventListener('click', () => {
      const s = this.cwState;
      const name = document.getElementById('new-world-name')?.value.trim() || 'My World';
      const seed = document.getElementById('new-world-seed')?.value.trim() || String(Math.floor(Math.random() * 9999999));
      if (this.game) {
        this.game.startNewWorld({
          name,
          mode: s.mode,
          worldType: s.worldType,
          difficulty: s.difficulty,
          mobSpawnRate: Number.isFinite(s.mobSpawnRate) ? s.mobSpawnRate : 1.0,
          hungerRate: Number.isFinite(s.hungerRate) ? s.hungerRate : 1.0,
          farmSpeed: Number.isFinite(s.farmSpeed) ? s.farmSpeed : 1.0,
          generateStructures: s.generateStructures !== false,
          bonusChest: Boolean(s.bonusChest),
          seed,
          allowCheats: Boolean(s.allowCheats)
        });
      }
    });
  }

  syncWorldRulesUI(meta) {
    if (!meta) return;
    const diffSel = document.getElementById('set-difficulty');
    if (diffSel) diffSel.value = meta.difficulty || 'normal';
    const mobSel = document.getElementById('set-mob-rate');
    if (mobSel) {
      const mr = typeof meta.mobSpawnRate === 'number' ? meta.mobSpawnRate : 1.0;
      const opts = [0, 0.5, 1, 1.8, 3];
      const closest = opts.reduce((a, b) => (Math.abs(b - mr) < Math.abs(a - mr) ? b : a), 1);
      mobSel.value = String(closest);
    }
    const hunSel = document.getElementById('set-hunger-rate');
    if (hunSel) {
      const hr = typeof meta.hungerRate === 'number' ? meta.hungerRate : 1.0;
      const opts = [0, 0.5, 1, 1.8, 3];
      const closest = opts.reduce((a, b) => (Math.abs(b - hr) < Math.abs(a - hr) ? b : a), 1);
      hunSel.value = String(closest);
    }
    const farmSel = document.getElementById('set-farm-speed');
    if (farmSel) {
      const fr = typeof meta.farmSpeed === 'number' ? meta.farmSpeed : 1.0;
      const opts = [0, 0.5, 1, 2, 4, 10];
      const closest = opts.reduce((a, b) => (Math.abs(b - fr) < Math.abs(a - fr) ? b : a), 1);
      farmSel.value = String(closest);
    }
  }

  syncSettingsUI(settings) {
    const rdIdx = rdToIdx(settings.renderDistance);
    const rdText = rdLabel(settings.renderDistance);
    document.getElementById('set-render-dist').value = rdIdx;
    document.getElementById('val-render-dist').textContent = rdText;
    document.getElementById('set-sensitivity').value = settings.sensitivity;
    document.getElementById('val-sensitivity').textContent = settings.sensitivity.toFixed(1);
    document.getElementById('set-fov').value = settings.fov;
    document.getElementById('val-fov').textContent = settings.fov;
    const fsVal = typeof settings.flightSpeed === 'number' ? settings.flightSpeed : 1.0;
    const fsEl = document.getElementById('set-flight-speed');
    const fsLbl = document.getElementById('val-flight-speed');
    if (fsEl) fsEl.value = fsVal;
    if (fsLbl) fsLbl.textContent = fsVal.toFixed(1);
    const tFS = document.getElementById('title-set-flight-speed');
    const tFSLbl = document.getElementById('title-val-flight-speed');
    if (tFS) tFS.value = fsVal;
    if (tFSLbl) tFSLbl.textContent = fsVal.toFixed(1);
    document.getElementById('set-shaders').value = settings.shaders || 'ultra';
    document.getElementById('set-mc-ui').checked = settings.minecraftUI !== false;
    document.getElementById('set-large-ui').checked = settings.largeUI !== false;
    document.getElementById('set-biome-fx').checked = settings.biomeEffects !== false;
    const adpEl = document.getElementById('set-adaptive');
    if (adpEl) adpEl.checked = settings.adaptiveQuality !== false;
    const tAdpEl = document.getElementById('title-set-adaptive');
    if (tAdpEl) tAdpEl.checked = settings.adaptiveQuality !== false;
    document.getElementById('set-control-style').value = settings.controlStyle;
    document.getElementById('set-show-touch').checked = settings.showTouch;
    document.getElementById('set-sound').checked = settings.sound;
    const cheatCb = document.getElementById('set-allow-cheats');
    if (cheatCb) cheatCb.checked = Boolean(settings.allowCheats);
    const tCheatCb = document.getElementById('title-set-allow-cheats');
    if (tCheatCb) tCheatCb.checked = Boolean(settings.allowCheats);
    const farmVal = typeof settings.farmSpeed === 'number' ? settings.farmSpeed : 1.0;
    const farmOpts = [0, 0.5, 1, 2, 4, 10];
    const farmClosest = farmOpts.reduce((a, b) => (Math.abs(b - farmVal) < Math.abs(a - farmVal) ? b : a), 1);
    const setFarmEl = document.getElementById('set-farm-speed');
    if (setFarmEl) setFarmEl.value = String(farmClosest);
    const titleFarmEl = document.getElementById('title-set-farm-speed');
    if (titleFarmEl) titleFarmEl.value = String(farmClosest);
    this.cwState.allowCheats = Boolean(settings.allowCheats);
    if (settings.difficulty) this.cwState.difficulty = settings.difficulty;
    if (typeof settings.mobSpawnRate === 'number') this.cwState.mobSpawnRate = settings.mobSpawnRate;
    if (typeof settings.hungerRate === 'number') this.cwState.hungerRate = settings.hungerRate;
    this.cwState.farmSpeed = farmClosest;
    this.syncCreateWorldUI();
    const tShaders = document.getElementById('title-set-shaders');
    if (tShaders) tShaders.value = settings.shaders || 'ultra';
    const tRD = document.getElementById('title-set-render-dist');
    const tRDVal = document.getElementById('title-val-render-dist');
    if (tRD) tRD.value = rdIdx;
    if (tRDVal) tRDVal.textContent = rdText;
    this.renderKeybindsUI(settings.keybinds);
  }

  cancelKeybindListen() {
    this.listeningKeybind = null;
    if (this.game && this.game.controls) this.game.controls.rebinding = false;
  }

  renderKeybindsUI(keybinds) {
    const kb = { ...DEFAULT_KEYBINDS, ...(keybinds || {}) };
    for (const containerId of ['keybinds-list', 'title-keybinds-list']) {
      const list = document.getElementById(containerId);
      if (!list) continue;
      list.innerHTML = '';
      for (const act of KEYBIND_ACTIONS) {
        const row = document.createElement('div');
        row.className = 'keybind-row';
        const lbl = document.createElement('span');
        lbl.className = 'keybind-label';
        lbl.textContent = act.label;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'keybind-btn';
        const isListening = this.listeningKeybind === act.id;
        if (isListening) btn.classList.add('listening');
        btn.textContent = isListening ? 'Press key...' : formatKeyCode(kb[act.id]);
        btn.addEventListener('click', () => {
          if (this.listeningKeybind === act.id) {
            this.cancelKeybindListen();
            this.renderKeybindsUI(kb);
            return;
          }
          this.listeningKeybind = act.id;
          if (this.game && this.game.controls) this.game.controls.rebinding = true;
          this.renderKeybindsUI(kb);
        });
        row.append(lbl, btn);
        list.appendChild(row);
      }
    }
  }

  syncCheatUI(allowed) {
    const flag = Boolean(allowed);
    const cb = document.getElementById('set-allow-cheats');
    if (cb) cb.checked = flag;
    const tcb = document.getElementById('title-set-allow-cheats');
    if (tcb) tcb.checked = flag;
    const modeBtn = document.getElementById('btn-toggle-mode');
    if (modeBtn) modeBtn.classList.toggle('cheat-locked', !flag);
    const note = document.getElementById('pause-time-cheat-note');
    if (note) note.textContent = flag ? '(Cheats ON)' : '(Requires Cheats)';
    document.querySelectorAll('.pause-time-btn').forEach((b) => {
      b.classList.toggle('cheat-locked', !flag);
    });
    document.querySelectorAll('.cmd-chip[data-cheat="true"]').forEach((c) => {
      c.classList.toggle('cheat-locked', !flag);
    });
    const banner = document.getElementById('chat-cheats-banner');
    const txt = document.getElementById('chat-cheats-text');
    if (banner && txt) {
      banner.classList.toggle('cheats-on', flag);
      txt.textContent = flag
        ? 'Cheats Enabled — /give, /effect, /time & /gamemode unlocked'
        : 'Cheats Disabled — Enable "Allow Cheats" in Settings for /commands';
    }
  }

  renderSavedWorlds(worlds) {
    const list = document.getElementById('saved-worlds-list');
    list.innerHTML = '';
    if (!worlds || worlds.length === 0) {
      list.innerHTML = '<div class="empty-worlds">No saved worlds yet. Create one to begin!</div>';
      return;
    }
    for (const w of worlds) {
      const card = document.createElement('div');
      card.className = 'world-card';
      const dateStr = w.updatedAt ? new Date(w.updatedAt).toLocaleDateString() : '';
      const diffLbl = (w.difficulty || 'normal').toUpperCase();
      card.innerHTML = `
        <div class="world-card-info">
          <div class="world-card-name">${this.escapeHtml(w.name)}</div>
          <div class="world-card-meta">${w.mode.toUpperCase()} • ${diffLbl} • ${w.worldType || 'infinite'} • Seed: ${w.seed} • ${dateStr}</div>
        </div>
        <div class="world-card-actions">
          <button class="mc-btn primary sm play-btn">Play</button>
          <button class="mc-btn danger sm del-btn" title="Delete"><img class="px-ui-icon close-px" src="${this.textures.getUiIcon('close')}" alt="Delete" /></button>
        </div>
      `;
      card.querySelector('.play-btn').addEventListener('click', () => {
        if (this.game) this.game.loadSavedWorld(w.id);
      });
      card.querySelector('.del-btn').addEventListener('click', () => {
        if (this.game) this.game.deleteSavedWorld(w.id);
      });
      list.appendChild(card);
    }
  }

  escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  showTitleScreen(show) {
    document.getElementById('title-screen').classList.toggle('hidden', !show);
    document.getElementById('hud').classList.toggle('hidden', show);
    if (show) {
      this.showTitleView('home');
    }
  }

  // --- HUD ---
  buildHotbarDOM() {
    const container = document.getElementById('hotbar-slots');
    container.innerHTML = '';
    for (let i = 0; i < 9; i++) {
      const slot = document.createElement('div');
      slot.className = 'hotbar-slot';
      slot.dataset.idx = i;
      slot.addEventListener('click', () => {
        if (this.game) {
          this.game.inventory.selected = i;
          this.updateHotbar();
        }
      });
      container.appendChild(slot);
    }
  }

  renderSlotContent(el, item) {
    el.innerHTML = '';
    if (!item || !ITEMS[item.id]) return;
    const def = ITEMS[item.id];
    const img = document.createElement('img');
    img.className = 'slot-icon';
    img.src = this.textures.getIcon(item.id);
    img.alt = def.name;
    el.appendChild(img);

    if (item.count > 1) {
      const cnt = document.createElement('span');
      cnt.className = 'slot-count';
      cnt.textContent = item.count;
      el.appendChild(cnt);
    }

    if (item.durability !== undefined && def.durability) {
      const pct = Math.max(0, Math.min(100, (item.durability / def.durability) * 100));
      if (pct < 100) {
        const bar = document.createElement('div');
        bar.className = 'slot-durability';
        const fill = document.createElement('div');
        fill.className = 'slot-durability-fill';
        fill.style.width = `${pct}%`;
        fill.style.background = pct < 25 ? '#ff5252' : pct < 55 ? '#ffd54f' : '#52e052';
        bar.appendChild(fill);
        el.appendChild(bar);
      }
    }
  }

  updateHotbar() {
    if (!this.game) return;
    const inv = this.game.inventory;
    const slots = document.querySelectorAll('#hotbar-slots .hotbar-slot');
    slots.forEach((el, i) => {
      el.classList.toggle('selected', i === inv.selected);
      this.renderSlotContent(el, inv.slots[i]);
    });
    const held = inv.getHeldDef();
    document.getElementById('held-item-name').textContent = held ? held.name : '';
  }

  updateStats(force = false) {
    if (!this.game || !this.game.player) return;
    const p = this.game.player;
    const isSurvival = p.mode === 'survival';
    const def = this.game.inventory.getArmorDefense();
    const airState = (p.headInWater || p.air < p.maxAir) ? Math.round(p.air * 4) : -1;
    const key = `${p.mode}|${p.flying?1:0}|${Math.ceil(p.hp)}|${Math.ceil(p.hunger)}|${def}|${airState}|${p.xp}|${p.level}`;
    if (!force && key === this._lastStatsKey) return;
    this._lastStatsKey = key;

    this.dom.survBars.classList.toggle('hidden', !isSurvival);
    if (p.flying) {
      this.dom.modeBadge.innerHTML = `${p.mode.toUpperCase()} <img class="px-ui-icon inline-px" src="${this.textures.getUiIcon('wing')}" alt="" />`;
    } else {
      this.dom.modeBadge.textContent = p.mode.toUpperCase();
    }
    if (!isSurvival) return;

    const icons = this.textures.hudIcons || {};
    const makePxRow = (el, keys, lowAlert = false) => {
      el.innerHTML = '';
      el.classList.toggle('low-alert', lowAlert);
      for (const k of keys) {
        const img = document.createElement('img');
        img.className = 'hud-px-icon';
        img.src = icons[k] || '';
        img.alt = '';
        el.appendChild(img);
      }
    };

    // Pixel-Art Hearts (10 hearts for 20 HP)
    const hpKeys = [];
    for (let i = 0; i < 10; i++) {
      const v = p.hp - i * 2;
      hpKeys.push(v >= 2 ? 'heart_full' : v >= 1 ? 'heart_half' : 'heart_empty');
    }
    makePxRow(this.dom.healthBar, hpKeys, p.hp <= 4);

    // Pixel-Art Food / Hunger Drumsticks (right-to-left like Minecraft!)
    const foodKeys = [];
    for (let i = 9; i >= 0; i--) {
      const v = p.hunger - i * 2;
      foodKeys.push(v >= 2 ? 'food_full' : v >= 1 ? 'food_half' : 'food_empty');
    }
    makePxRow(this.dom.hungerBar, foodKeys, p.hunger <= 4);

    // Pixel-Art Armor Shields
    const armEl = this.dom.armorBar;
    if (def > 0) {
      const armKeys = [];
      for (let i = 0; i < 10; i++) {
        const v = def - i * 2;
        if (v >= 2) armKeys.push('armor_full');
        else if (v >= 1) armKeys.push('armor_half');
      }
      makePxRow(armEl, armKeys, false);
    } else {
      armEl.innerHTML = '';
    }

    // Pixel-Art Water / Air Bubbles when underwater
    const airEl = this.dom.airBar;
    if (airState >= 0) {
      airEl.classList.remove('hidden');
      const fullBubbles = Math.floor(p.air);
      const hasPop = (p.air - fullBubbles) > 0.05;
      const bubKeys = [];
      for (let i = 0; i < fullBubbles; i++) bubKeys.push('bubble_full');
      if (hasPop && bubKeys.length < 10) bubKeys.push('bubble_pop');
      makePxRow(airEl, bubKeys, p.air <= 2);
    } else {
      airEl.classList.add('hidden');
      airEl.innerHTML = '';
    }

    // Pixel-Art Segmented XP Level Bar
    const needed = 10 + p.level * 5;
    this.dom.xpFill.style.width = `${Math.min(100, (p.xp / needed) * 100)}%`;
    this.dom.xpLevel.textContent = p.level;
  }

  updateTopHUD(player, biomeName, sky, fps) {
    const x = Math.floor(player.pos.x);
    const y = Math.floor(player.pos.y);
    const z = Math.floor(player.pos.z);
    const coords = `${x}, ${y}, ${z}`;
    if (coords !== this._lastCoords) {
      this._lastCoords = coords;
      this.dom.coords.textContent = coords;
    }
    if (biomeName !== this._lastBiome) {
      this._lastBiome = biomeName;
      this.dom.biome.textContent = biomeName;
    }
    const timeStr = sky.getFormattedTime();
    if (timeStr !== this._lastTime) {
      this._lastTime = timeStr;
      this.dom.time.textContent = timeStr;
    }
    const fpsStr = `${fps} FPS`;
    if (fpsStr !== this._lastFps) {
      this._lastFps = fpsStr;
      this.dom.fps.textContent = fpsStr;
    }
  }

  // Dynamic context-aware buttons: PLACE <-> USE <-> EAT and MINE <-> DAMAGE!
  updateActionButtons(placeMode, damageMode) {
    const mode = typeof placeMode === 'boolean' ? (placeMode ? 'use' : 'place') : (placeMode || 'place');
    if (mode !== this._lastPlaceMode) {
      this._lastPlaceMode = mode;
      if (this.dom.btnPlace) {
        this.dom.btnPlace.classList.toggle('mode-use', mode === 'use');
        this.dom.btnPlace.classList.toggle('mode-eat', mode === 'eat');
        this.dom.btnPlace.classList.toggle('mode-pickup', mode === 'pickup');
        this.dom.btnPlace.classList.toggle('mode-till', mode === 'till' || mode === 'plant' || mode === 'path');
        const lblMap = { use: 'USE', eat: 'EAT', pickup: 'PICK UP', till: 'TILL', path: 'PATH', plant: 'PLANT', place: 'PLACE' };
        this.dom.btnPlaceLbl.textContent = lblMap[mode] || 'PLACE';
        const iconKey = mode === 'use' || mode === 'pickup' || mode === 'till' || mode === 'path' ? 'use' : (mode === 'eat' ? 'eat' : 'place');
        this.dom.btnPlaceIcon.src = this.textures.getUiIcon(iconKey);
      }
    }
    if (damageMode !== this._lastBreakMode) {
      this._lastBreakMode = damageMode;
      if (this.dom.btnBreak) {
        this.dom.btnBreak.classList.toggle('mode-damage', damageMode);
        this.dom.btnBreakLbl.textContent = damageMode ? 'DAMAGE' : 'MINE';
        this.dom.btnBreakIcon.src = this.textures.getUiIcon(damageMode ? 'damage' : 'mine');
      }
    }
  }

  updateMiningRing(progress, isEating = false) {
    const ring = this.dom.breakRing;
    const fill = this.dom.breakFill;
    if (progress > 0 && progress < 1) {
      ring.classList.remove('hidden');
      ring.classList.toggle('eating', Boolean(isEating));
      const circ = 113.1;
      fill.setAttribute('stroke-dashoffset', String(circ * (1 - progress)));
    } else {
      ring.classList.add('hidden');
      ring.classList.remove('eating');
    }
  }

  updateTargetTooltip(text) {
    if (text === this._lastTooltip) return;
    this._lastTooltip = text;
    const el = this.dom.tooltip;
    if (text) {
      el.textContent = text;
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  flashDamage() {
    const el = document.getElementById('damage-overlay');
    el.classList.remove('hidden');
    clearTimeout(this._dmgTimer);
    this._dmgTimer = setTimeout(() => el.classList.add('hidden'), 240);
  }

  setUnderwater(isUnder) {
    document.getElementById('underwater-overlay').classList.toggle('hidden', !isUnder);
  }

  setInLava(isLava) {
    const el = document.getElementById('lava-overlay');
    if (el) el.classList.toggle('hidden', !isLava);
  }

  setOnFire(isBurning) {
    const el = document.getElementById('fire-overlay');
    if (el) el.classList.toggle('hidden', !isBurning);
  }

  playSleepTransition() {
    const el = document.getElementById('sleep-overlay');
    if (!el) return;
    el.classList.remove('hidden', 'fade-out');
    clearTimeout(this._sleepT1);
    clearTimeout(this._sleepT2);
    this._sleepT1 = setTimeout(() => el.classList.add('fade-out'), 850);
    this._sleepT2 = setTimeout(() => {
      el.classList.add('hidden');
      el.classList.remove('fade-out');
    }, 1450);
  }

  updateEffectsHUD(statusEffects) {
    const el = this.dom.effectsHud;
    if (!el || !statusEffects) return;
    const names = { speed: 'Speed', jump: 'Jump Boost', regen: 'Regen', nightvision: 'Night Vision' };
    const active = [];
    for (const k of Object.keys(names)) {
      const s = Math.ceil(statusEffects[k] || 0);
      if (s > 0) active.push([k, names[k], s]);
    }
    const key = active.map((a) => `${a[0]}:${a[2]}`).join('|');
    if (key === this._lastEffectsKey) return;
    this._lastEffectsKey = key;

    if (active.length === 0) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    el.classList.remove('hidden');
    const potionSrc = this.textures.getUiIcon('potion');
    el.innerHTML = active
      .map(([, label, sec]) => `<div class="effect-pill"><img class="px-ui-icon inline-px" src="${potionSrc}" alt="" /><span>${label} ${sec}s</span></div>`)
      .join('');
  }

  showDeathScreen(reason) {
    document.getElementById('death-reason').textContent = reason;
    document.getElementById('death-screen').classList.remove('hidden');
  }

  toast(msg) {
    const area = document.getElementById('toast-area');
    const div = document.createElement('div');
    div.className = 'toast';
    div.textContent = msg;
    area.appendChild(div);
    setTimeout(() => div.remove(), 2400);
  }

  addChatMessage(msg) {
    const log = document.getElementById('chat-log');
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.textContent = msg;
    log.appendChild(div);
    while (log.children.length > 6) log.firstChild.remove();
    setTimeout(() => div.remove(), 9000);
  }

  // --- MODALS ---
  closeModals() {
    this.cancelKeybindListen();
    if (this.activeModal === 'inventory-modal' || this.activeModal === 'crafting-modal') {
      this.returnCraftGridToInventory();
      this.pickedSource = null;
    }
    document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.add('hidden'));
    this.activeModal = null;
    this.activeFurnacePos = null;
    this.activeChestPos = null;
    this.cancelInventoryDrag();
    if (this.game && !this.game.player.dead) {
      this.game.controls.enabled = true;
      this.updateHotbar();
      this.updateStats();
    }
  }

  returnCraftGridToInventory() {
    if (!this.game) return;
    for (let i = 0; i < 9; i++) {
      if (this.craftGrid[i]) {
        this.game.inventory.addItem(this.craftGrid[i].id, this.craftGrid[i].count);
        this.craftGrid[i] = null;
      }
    }
  }

  openModal(id) {
    this.closeModals();
    this.activeModal = id;
    document.getElementById(id).classList.remove('hidden');
    if (this.game) {
      this.game.controls.enabled = false;
      this.game.controls.resetInputs();
      if (document.pointerLockElement) {
        try { document.exitPointerLock(); } catch {}
      }
    }
  }

  openPause() {
    if (this.activeModal) {
      this.closeModals();
      return;
    }
    this.openModal('pause-modal');
    if (this.game) {
      this.syncCheatUI(this.game.areCheatsAllowed());
      this.renderKeybindsUI(this.game.settings.keybinds);
    }
  }

  openChat() {
    this.openModal('chat-modal');
    if (this.game) this.syncCheatUI(this.game.areCheatsAllowed());
    setTimeout(() => document.getElementById('chat-input').focus(), 40);
  }

  openInventory(isTable = false) {
    if (!isTable && this.activeModal === 'inventory-modal') {
      this.closeModals();
      return;
    }
    if (isTable && this.activeModal === 'crafting-modal') {
      this.closeModals();
      return;
    }
    this.isCraftingTable = isTable;
    this.pickedSource = null;

    if (isTable) {
      this.openModal('crafting-modal');
      document.getElementById('craft-book-panel')?.classList.add('hidden');
      document.getElementById('btn-craft-book')?.classList.remove('active');
      this.renderCraftingModal();
      return;
    }

    this.openModal('inventory-modal');
    const isCreative = this.game && this.game.player.mode === 'creative';
    const creBtn = document.getElementById('btn-inv-creative');
    if (creBtn) creBtn.classList.toggle('hidden', !isCreative);

    // Start with the authentic classic Inventory screen cleanly framed (drawer closed by default!)
    this._invDrawerMode = null;
    document.getElementById('inv-book-panel')?.classList.add('hidden');
    document.getElementById('btn-inv-book')?.classList.remove('active');
    document.getElementById('btn-inv-creative')?.classList.remove('active');
    this.renderInventoryModal();
  }

  refreshActiveContainerModal() {
    if (this.activeModal === 'inventory-modal') this.renderInventoryModal();
    else if (this.activeModal === 'crafting-modal') this.renderCraftingModal();
    else if (this.activeModal === 'chest-modal') this.renderChestModal();
    else if (this.activeModal === 'furnace-modal') this.renderFurnaceModal();
    this.updateHotbar();
    this.updateStats();
  }

  // Live 3D Articulated Minecraft Steve + Equipped 3D Armor Doll inside Inventory (100% identical to 3rd-person player!)
  _ensureInv3DPreview() {
    if (this._inv3d) return this._inv3d;
    const canvas = document.getElementById('inv-steve-canvas');
    if (!canvas) return null;
    try {
      const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'low-power' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(canvas.width, canvas.height, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.setClearColor(0x000000, 1);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(32, canvas.width / canvas.height, 0.1, 20);
      camera.position.set(0, 1.05, 3.65);
      camera.lookAt(0, 0.96, 0);

      const hemi = new THREE.HemisphereLight(0xffffff, 0x6b7280, 1.15);
      const key = new THREE.DirectionalLight(0xfff7e6, 1.05);
      key.position.set(2.4, 3.6, 3.4);
      const rim = new THREE.DirectionalLight(0xb8dcff, 0.42);
      rim.position.set(-2.5, 1.8, -2.0);
      scene.add(hemi, key, rim);

      const steve = createSteveModel(this.textures);
      steve.root.rotation.y = Math.PI; // face directly toward the inventory camera (+Z)
      scene.add(steve.root);

      this._inv3d = { renderer, scene, camera, steve };
      return this._inv3d;
    } catch {
      return null;
    }
  }

  _drawInv3DFrame() {
    if (this.activeModal !== 'inventory-modal' || !this.game) {
      this._stevePreviewRAF = null;
      return;
    }
    const ctx3d = this._ensureInv3DPreview();
    if (!ctx3d) {
      this._stevePreviewRAF = null;
      return;
    }

    // Smooth spring-like cursor following for Steve's head & gentle torso lean!
    this._steveLookX += (this._steveTargetX - this._steveLookX) * 0.20;
    this._steveLookY += (this._steveTargetY - this._steveLookY) * 0.20;

    const { renderer, scene, camera, steve } = ctx3d;
    updateSteveArmor(steve, this.game.inventory.armor);

    const t = performance.now() * 0.001;
    const lx = this._steveLookX;
    const ly = this._steveLookY;

    // Head looks cleanly toward the cursor; torso gently turns to follow just like Minecraft!
    steve.root.rotation.y = Math.PI + lx * 0.36;
    steve.bodyPivot.rotation.x = -ly * 0.07;
    steve.headPivot.rotation.y = lx * 0.62;
    steve.headPivot.rotation.x = -ly * 0.46;

    // Subtle living idle breath sway on arms & legs
    const breath = Math.sin(t * 2.2) * 0.025;
    steve.leftArm.rotation.z = 0.06 + breath;
    steve.rightArm.rotation.z = -0.06 - breath;
    steve.leftArm.rotation.x = Math.sin(t * 1.4) * 0.03;
    steve.rightArm.rotation.x = -Math.sin(t * 1.4) * 0.03;
    steve.leftLeg.rotation.x = 0.03;
    steve.rightLeg.rotation.x = -0.03;

    renderer.render(scene, camera);
    this._stevePreviewRAF = requestAnimationFrame(() => this._drawInv3DFrame());
  }

  renderPlayerPreview() {
    if (!this.game) return;
    const ctx3d = this._ensureInv3DPreview();
    if (!ctx3d) return;
    updateSteveArmor(ctx3d.steve, this.game.inventory.armor);
    if (!this._stevePreviewRAF && this.activeModal === 'inventory-modal') {
      this._drawInv3DFrame();
    } else if (this.activeModal === 'inventory-modal') {
      ctx3d.renderer.render(ctx3d.scene, ctx3d.camera);
    }
  }

  _bindCraftOutputSlot(outEl, size) {
    const inv = this.game.inventory;
    const matched = matchCraftingGrid(this.craftGrid.slice(0, size * size), size);
    this.renderSlotContent(outEl, matched ? { id: matched.out, count: matched.count } : null);
    outEl.classList.toggle('mc-craft-ready', !!matched);
    outEl.onclick = (e) => {
      if (!matched) return;
      const craftOnce = () => {
        const curMatch = matchCraftingGrid(this.craftGrid.slice(0, size * size), size);
        if (!curMatch || curMatch.out !== matched.out) return false;
        if (!inv.addItem(curMatch.out, curMatch.count)) {
          this.toast('Inventory full');
          return false;
        }
        for (let i = 0; i < size * size; i++) {
          if (this.craftGrid[i]) {
            this.craftGrid[i].count--;
            if (this.craftGrid[i].count <= 0) this.craftGrid[i] = null;
          }
        }
        return true;
      };
      if (e && e.shiftKey) {
        let crafted = 0;
        while (crafted < 64 && craftOnce()) crafted++;
        if (crafted > 0) this.sound.playCraft();
      } else {
        if (craftOnce()) this.sound.playCraft();
      }
      this.refreshActiveContainerModal();
      if (this._invDrawerMode === 'recipes') this.renderRecipeBook(false);
      if (!document.getElementById('craft-book-panel')?.classList.contains('hidden')) this.renderRecipeBook(true);
    };
  }

  renderInventoryModal() {
    if (!this.game) return;
    const inv = this.game.inventory;

    // Cursor info & Trash active state
    const curEl = document.getElementById('selected-cursor-info');
    const trashEl = document.getElementById('inv-trash-slot');
    if (this.pickedSource) {
      const it = this.getSlotByRef(this.pickedSource);
      if (curEl) curEl.textContent = it ? `Selected: ${ITEMS[it.id].name} — tap slot or Trash` : '';
      if (trashEl) trashEl.classList.toggle('ready-delete', !!it);
    } else {
      if (curEl) curEl.textContent = '';
      if (trashEl) trashEl.classList.remove('ready-delete');
    }

    // 4 Vertical Classic Armor Slots
    const armorGrid = document.getElementById('armor-slots');
    if (armorGrid) {
      armorGrid.innerHTML = '';
      const armorPlaceholders = ['slot_helmet', 'slot_chestplate', 'slot_leggings', 'slot_boots'];
      for (let i = 0; i < 4; i++) {
        const el = document.createElement('div');
        el.className = 'mc-classic-slot';
        if (this.pickedSource && this.pickedSource.type === 'armor' && this.pickedSource.index === i) el.classList.add('picked');
        if (inv.armor[i]) this.renderSlotContent(el, inv.armor[i]);
        else el.innerHTML = `<img class="slot-placeholder-px" src="${this.textures.getUiIcon(armorPlaceholders[i])}" alt="" />`;
        this.attachSlotInteractions(el, { type: 'armor', index: i });
        armorGrid.appendChild(el);
      }
    }

    // Live Pixel-Art Steve Character Preview
    this.renderPlayerPreview();

    // Classic Offhand / Shield Slot
    const offEl = document.getElementById('offhand-slot');
    if (offEl) {
      const newOff = offEl.cloneNode(false);
      offEl.parentNode.replaceChild(newOff, offEl);
      newOff.classList.toggle('picked', !!(this.pickedSource && this.pickedSource.type === 'offhand'));
      if (inv.offhand) {
        this.renderSlotContent(newOff, inv.offhand);
      } else {
        newOff.innerHTML = `<svg viewBox="0 0 16 16" shape-rendering="crispEdges" class="slot-placeholder-svg" aria-hidden="true"><path d="M3 2h10v6h-1v2h-1v2h-2v2H7v-2H5v-2H4V8H3V2zm1 1v5h1v2h1v2h2v1h0v-1h2v-2h1V8h1V3H4z" fill="#525252"/></svg>`;
      }
      this.attachSlotInteractions(newOff, { type: 'offhand', index: 0 });
    }

    // 2×2 Hand Crafting Grid
    const cg = document.getElementById('craft-grid-2x2');
    if (cg) {
      cg.innerHTML = '';
      for (let i = 0; i < 4; i++) {
        const el = document.createElement('div');
        el.className = 'mc-classic-slot';
        if (this.pickedSource && this.pickedSource.type === 'craft' && this.pickedSource.index === i) el.classList.add('picked');
        this.renderSlotContent(el, this.craftGrid[i]);
        this.attachSlotInteractions(el, { type: 'craft', index: i });
        cg.appendChild(el);
      }
    }

    // 2×2 Craft Output
    const outEl = document.getElementById('craft-output-2x2');
    if (outEl) this._bindCraftOutputSlot(outEl, 2);

    // Main Inventory (9..35)
    const mainGrid = document.getElementById('main-inv-grid');
    if (mainGrid) {
      mainGrid.innerHTML = '';
      for (let i = 9; i < 36; i++) {
        const el = document.createElement('div');
        el.className = 'mc-classic-slot';
        if (this.pickedSource && this.pickedSource.type === 'inv' && this.pickedSource.index === i) el.classList.add('picked');
        this.renderSlotContent(el, inv.slots[i]);
        this.attachSlotInteractions(el, { type: 'inv', index: i });
        mainGrid.appendChild(el);
      }
    }

    // Hotbar (0..8)
    const hbGrid = document.getElementById('modal-hotbar-grid');
    if (hbGrid) {
      hbGrid.innerHTML = '';
      for (let i = 0; i < 9; i++) {
        const el = document.createElement('div');
        el.className = 'mc-classic-slot';
        if (this.pickedSource && this.pickedSource.type === 'inv' && this.pickedSource.index === i) el.classList.add('picked');
        this.renderSlotContent(el, inv.slots[i]);
        this.attachSlotInteractions(el, { type: 'inv', index: i });
        hbGrid.appendChild(el);
      }
    }
  }

  renderCraftingModal() {
    if (!this.game) return;
    const inv = this.game.inventory;

    const curEl = document.getElementById('craft-cursor-info');
    if (curEl) {
      if (this.pickedSource) {
        const it = this.getSlotByRef(this.pickedSource);
        curEl.textContent = it ? `— Selected: ${ITEMS[it.id].name}` : '';
      } else {
        curEl.textContent = '';
      }
    }

    // 3×3 Crafting Grid
    const cg = document.getElementById('craft-grid-3x3');
    if (cg) {
      cg.innerHTML = '';
      for (let i = 0; i < 9; i++) {
        const el = document.createElement('div');
        el.className = 'mc-classic-slot';
        if (this.pickedSource && this.pickedSource.type === 'craft' && this.pickedSource.index === i) el.classList.add('picked');
        this.renderSlotContent(el, this.craftGrid[i]);
        this.attachSlotInteractions(el, { type: 'craft', index: i });
        cg.appendChild(el);
      }
    }

    // 3×3 Craft Output
    const outEl = document.getElementById('craft-output-3x3');
    if (outEl) this._bindCraftOutputSlot(outEl, 3);

    // Main Inventory (9..35)
    const mainGrid = document.getElementById('craft-player-inv');
    if (mainGrid) {
      mainGrid.innerHTML = '';
      for (let i = 9; i < 36; i++) {
        const el = document.createElement('div');
        el.className = 'mc-classic-slot';
        if (this.pickedSource && this.pickedSource.type === 'inv' && this.pickedSource.index === i) el.classList.add('picked');
        this.renderSlotContent(el, inv.slots[i]);
        this.attachSlotInteractions(el, { type: 'inv', index: i });
        mainGrid.appendChild(el);
      }
    }

    // Hotbar (0..8)
    const hbGrid = document.getElementById('craft-player-hotbar');
    if (hbGrid) {
      hbGrid.innerHTML = '';
      for (let i = 0; i < 9; i++) {
        const el = document.createElement('div');
        el.className = 'mc-classic-slot';
        if (this.pickedSource && this.pickedSource.type === 'inv' && this.pickedSource.index === i) el.classList.add('picked');
        this.renderSlotContent(el, inv.slots[i]);
        this.attachSlotInteractions(el, { type: 'inv', index: i });
        hbGrid.appendChild(el);
      }
    }
  }

  bindInventoryDragAndTrash() {
    const trashEl = document.getElementById('inv-trash-slot');
    if (trashEl) {
      trashEl.addEventListener('click', () => {
        if (this._suppressNextClick) return;
        if (this.pickedSource) {
          this.deleteSlotItem(this.pickedSource);
        } else {
          this.toast('Drag an item here or tap an item first to delete');
        }
      });
    }

    window.addEventListener('pointermove', (e) => {
      const st = this._dragState;
      if (!st || e.pointerId !== st.pointerId) return;

      if (!st.active) {
        const dist = Math.hypot(e.clientX - st.startX, e.clientY - st.startY);
        if (dist < 8) return;
        st.active = true;
        if (st.srcEl) st.srcEl.classList.add('dragging-src');
        const ghost = document.getElementById('drag-ghost');
        if (ghost) {
          this.renderSlotContent(ghost, st.item);
          ghost.classList.remove('hidden');
          ghost.style.left = `${e.clientX}px`;
          ghost.style.top = `${e.clientY}px`;
        }
        document.getElementById('inv-trash-slot')?.classList.add('drag-active');
      }

      if (st.active) {
        e.preventDefault();
        const ghost = document.getElementById('drag-ghost');
        if (ghost) {
          ghost.style.left = `${e.clientX}px`;
          ghost.style.top = `${e.clientY}px`;
        }
        const rawEl = document.elementFromPoint(e.clientX, e.clientY);
        const dropTarget = rawEl?.closest('[data-slot-type], #inv-trash-slot') || null;
        if (st.hoverEl !== dropTarget) {
          if (st.hoverEl) st.hoverEl.classList.remove('drag-over');
          st.hoverEl = dropTarget;
          if (st.hoverEl) st.hoverEl.classList.add('drag-over');
        }
      }
    }, { passive: false });

    const finishDrag = (e) => {
      const st = this._dragState;
      if (!st || e.pointerId !== st.pointerId) return;
      const wasActive = st.active;
      const srcRef = st.ref;
      this.cancelInventoryDrag();

      if (wasActive && e.type === 'pointerup') {
        this._suppressNextClick = true;
        setTimeout(() => { this._suppressNextClick = false; }, 90);

        const rawEl = document.elementFromPoint(e.clientX, e.clientY);
        const target = rawEl?.closest('[data-slot-type], #inv-trash-slot');
        if (!target) return;

        if (target.id === 'inv-trash-slot' || target.dataset.dropTrash === 'true') {
          this.deleteSlotItem(srcRef);
        } else if (target.dataset.slotType) {
          const dstRef = { type: target.dataset.slotType, index: Number(target.dataset.slotIndex) };
          if (dstRef.type !== srcRef.type || dstRef.index !== srcRef.index) {
            this.moveOrSwapSlot(srcRef, dstRef, false);
          }
        }
      }
    };

    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
  }

  cancelInventoryDrag() {
    const st = this._dragState;
    if (st) {
      if (st.srcEl) st.srcEl.classList.remove('dragging-src');
      if (st.hoverEl) st.hoverEl.classList.remove('drag-over');
    }
    this._dragState = null;
    document.getElementById('drag-ghost')?.classList.add('hidden');
    const trashEl = document.getElementById('inv-trash-slot');
    if (trashEl) trashEl.classList.remove('drag-active', 'drag-over');
  }

  attachSlotInteractions(el, ref, customClick = null) {
    el.dataset.slotType = ref.type;
    el.dataset.slotIndex = String(ref.index);
    el.addEventListener('pointerdown', (e) => {
      if (e.button && e.button !== 0) return;
      const item = this.getSlotByRef(ref);
      if (!item) return;
      this._dragState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        ref,
        item,
        srcEl: el,
        hoverEl: null,
        active: false
      };
    });
    // Authentic Minecraft right-click: place 1 item from selected slot into crafting/inventory slot!
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.pickedSource && (this.pickedSource.type !== ref.type || this.pickedSource.index !== ref.index)) {
        this.moveOrSwapSlot(this.pickedSource, ref, true, true);
      }
    });
    el.addEventListener('click', () => {
      if (this._suppressNextClick) return;
      if (customClick) customClick();
      else this.handleSlotClick(ref);
    });
  }

  deleteSlotItem(ref) {
    const item = this.getSlotByRef(ref);
    if (!item) return;
    const def = ITEMS[item.id];
    const label = def ? def.name : item.id;
    const qty = item.count > 1 ? `${item.count}× ` : '';
    this.setSlotByRef(ref, null);
    this.pickedSource = null;
    this.sound.playPop();
    this.toast(`Deleted ${qty}${label}`);
    this.refreshActiveContainerModal();
  }

  moveOrSwapSlot(srcRef, dstRef, singleCraft = true, forceSingle = false) {
    const src = this.getSlotByRef(srcRef);
    const dst = this.getSlotByRef(dstRef);
    if (!src) return;

    // Furnace output is take-only (authentic Minecraft!)
    if (dstRef.type === 'furnace_out') {
      this.toast('Cannot place items into furnace output');
      this.pickedSource = null;
      this.refreshActiveContainerModal();
      return;
    }

    // Armor slot validation
    if (dstRef.type === 'armor') {
      const def = ITEMS[src.id];
      if (!def || def.armorSlot !== dstRef.index) {
        this.toast('Cannot equip that here');
        this.pickedSource = null;
        this.refreshActiveContainerModal();
        return;
      }
    }

    // Furnace fuel validation when dragging/placing into fuel slot
    if (dstRef.type === 'furnace_fuel' && !FUEL_VALUES[src.id]) {
      this.toast('That item cannot be used as fuel');
      this.pickedSource = null;
      this.refreshActiveContainerModal();
      return;
    }

    // If tapping/right-clicking into craft grid (or forceSingle) and src has >1, place 1 item for authentic Minecraft pattern crafting!
    if ((forceSingle || (singleCraft && dstRef.type === 'craft')) && src.count > 1 && (!dst || dst.id === src.id)) {
      const max = (ITEMS[src.id] && ITEMS[src.id].stackSize) || 64;
      if (!dst || dst.count < max) {
        src.count -= 1;
        if (!dst) this.setSlotByRef(dstRef, { ...src, count: 1 });
        else dst.count += 1;
        if (src.count <= 0) this.setSlotByRef(srcRef, null);
      }
    } else if (dst && src.id === dst.id && (ITEMS[src.id].stackSize || 64) > 1) {
      // Merge stacks
      const max = ITEMS[src.id].stackSize || 64;
      const move = Math.min(max - dst.count, src.count);
      dst.count += move;
      src.count -= move;
      if (src.count <= 0) this.setSlotByRef(srcRef, null);
      this.pickedSource = null;
    } else {
      // Cannot swap an item into furnace_out even from reverse drag
      if (srcRef.type === 'furnace_out' && dst) {
        this.toast('Drop furnace output into an empty or matching slot');
        this.pickedSource = null;
        this.refreshActiveContainerModal();
        return;
      }
      // Swap
      this.setSlotByRef(dstRef, src);
      this.setSlotByRef(srcRef, dst);
      this.pickedSource = null;
    }

    this.sound.playPop();
    this.refreshActiveContainerModal();
  }

  getSlotByRef(ref) {
    if (!ref || !this.game) return null;
    if (ref.type === 'inv') return this.game.inventory.slots[ref.index];
    if (ref.type === 'armor') return this.game.inventory.armor[ref.index];
    if (ref.type === 'offhand') return this.game.inventory.offhand;
    if (ref.type === 'craft') return this.craftGrid[ref.index];
    if (ref.type === 'chest' && this.activeChestPos) {
      const chest = this.game.world.chests.get(this.activeChestPos);
      return chest ? chest[ref.index] : null;
    }
    if (this.activeFurnacePos) {
      const f = this.game.world.furnaces.get(this.activeFurnacePos);
      if (!f) return null;
      if (ref.type === 'furnace_in') return f.input;
      if (ref.type === 'furnace_fuel') return f.fuel;
      if (ref.type === 'furnace_out') return f.output;
    }
    return null;
  }

  setSlotByRef(ref, val) {
    if (!ref || !this.game) return;
    if (ref.type === 'inv') this.game.inventory.slots[ref.index] = val;
    else if (ref.type === 'armor') this.game.inventory.armor[ref.index] = val;
    else if (ref.type === 'offhand') this.game.inventory.offhand = val;
    else if (ref.type === 'craft') this.craftGrid[ref.index] = val;
    else if (ref.type === 'chest' && this.activeChestPos) {
      const chest = this.game.world.chests.get(this.activeChestPos);
      if (chest) chest[ref.index] = val;
    } else if (this.activeFurnacePos) {
      const f = this.game.world.furnaces.get(this.activeFurnacePos);
      if (!f) return;
      if (ref.type === 'furnace_in') f.input = val;
      else if (ref.type === 'furnace_fuel') f.fuel = val;
      else if (ref.type === 'furnace_out') f.output = val;
    }
  }

  handleSlotClick(ref) {
    if (!this.pickedSource) {
      const cur = this.getSlotByRef(ref);
      if (cur) this.pickedSource = ref;
      this.refreshActiveContainerModal();
    } else if (this.pickedSource.type === ref.type && this.pickedSource.index === ref.index) {
      this.pickedSource = null;
      this.refreshActiveContainerModal();
    } else {
      this.moveOrSwapSlot(this.pickedSource, ref, true);
    }
  }

  // Authentic Minecraft Recipe Book Auto-Fill: places the exact recipe pattern into the 2×2 or 3×3 grid!
  loadRecipeIntoGrid(recipe, isTable) {
    if (!this.game) return false;
    const size = isTable ? 3 : 2;
    if (recipe.table && !isTable) return false;

    const inv = this.game.inventory;
    // Return any current craft grid items first so all player items are available
    this.returnCraftGridToInventory();
    if (!canCraftRecipe(recipe, inv, isTable)) {
      this.refreshActiveContainerModal();
      return false;
    }

    const takeOneFromInv = (req) => {
      for (let i = 0; i < inv.slots.length; i++) {
        const s = inv.slots[i];
        if (s && matchesItemTag(s.id, req)) {
          const id = s.id;
          s.count -= 1;
          if (s.count <= 0) inv.slots[i] = null;
          return id;
        }
      }
      return null;
    };

    if (recipe.pattern) {
      for (let r = 0; r < recipe.pattern.length; r++) {
        for (let c = 0; c < recipe.pattern[r].length; c++) {
          const ch = recipe.pattern[r][c];
          if (ch === ' ') continue;
          const req = recipe.map[ch];
          const taken = takeOneFromInv(req);
          if (taken) {
            this.craftGrid[r * size + c] = { id: taken, count: 1 };
          }
        }
      }
    } else if (recipe.ingredients) {
      let slotIdx = 0;
      for (const [req, cnt] of Object.entries(recipe.ingredients)) {
        for (let k = 0; k < cnt && slotIdx < size * size; k++) {
          const taken = takeOneFromInv(req);
          if (taken) {
            this.craftGrid[slotIdx++] = { id: taken, count: 1 };
          }
        }
      }
    }

    this.pickedSource = null;
    this.sound.playPop();
    this.refreshActiveContainerModal();
    this.renderRecipeBook(isTable);
    return true;
  }

  renderRecipeBook(isTable = this.isCraftingTable) {
    if (!this.game) return;
    const listId = isTable ? 'craft-recipe-list' : 'recipe-list';
    const searchId = isTable ? 'craft-recipe-search' : 'recipe-search';
    const list = document.getElementById(listId);
    if (!list) return;
    list.innerHTML = '';
    const q = (document.getElementById(searchId)?.value || '').trim().toLowerCase();

    const sorted = [...RECIPES]
      .filter((r) => {
        if (r.table && !isTable) return false;
        if (!q) return true;
        const def = ITEMS[r.out];
        return def && (def.name.toLowerCase().includes(q) || def.id.includes(q));
      })
      .sort((a, b) => {
        const ca = canCraftRecipe(a, this.game.inventory, isTable) ? 0 : 1;
        const cb = canCraftRecipe(b, this.game.inventory, isTable) ? 0 : 1;
        return ca - cb;
      });

    for (const r of sorted) {
      const ok = canCraftRecipe(r, this.game.inventory, isTable);
      const outDef = ITEMS[r.out];
      if (!outDef) continue;

      const costStr = Object.entries(r.cost)
        .map(([k, n]) => `${n}× ${k === 'any_planks' ? 'Planks' : (k === 'any_wool' ? 'Wool' : (ITEMS[k]?.name || k))}`)
        .join(', ');

      const card = document.createElement('button');
      card.type = 'button';
      card.className = `mc-recipe-row ${ok ? 'craftable' : 'disabled'}`;
      card.innerHTML = `
        <img src="${this.textures.getIcon(r.out)}" alt="" />
        <div>
          <div class="mc-recipe-row-name">${outDef.name}${r.count > 1 ? ` ×${r.count}` : ''}</div>
          <div class="mc-recipe-row-cost">${costStr}</div>
        </div>
      `;
      card.addEventListener('click', () => {
        if (!this.loadRecipeIntoGrid(r, isTable)) {
          this.toast(`Need: ${costStr}`);
        }
      });
      list.appendChild(card);
    }
  }

  renderCreativeCatalog(query) {
    const cat = document.getElementById('creative-catalog');
    if (!cat) return;
    cat.innerHTML = '';
    const q = (query || '').trim().toLowerCase();
    const activeCat = this.creativeCategory || 'all';
    let shown = 0;

    for (const def of Object.values(ITEMS)) {
      if (def.hiddenFromCreative) continue;
      if (activeCat !== 'all' && getItemCategory(def) !== activeCat) continue;
      if (q && !def.name.toLowerCase().includes(q) && !def.id.includes(q)) continue;

      shown++;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'creative-tile';
      card.title = def.name;
      const img = document.createElement('img');
      img.className = 'creative-tile-icon';
      img.src = this.textures.getIcon(def.id);
      img.alt = def.name;
      const lbl = document.createElement('span');
      lbl.className = 'creative-tile-name';
      lbl.textContent = def.name;
      card.append(img, lbl);

      card.addEventListener('click', () => {
        if (this.game) {
          const amt = this.creativeGiveStack ? (def.stackSize || 64) : 1;
          const ok = this.game.inventory.addItem(def.id, amt);
          this.sound.playPop();
          this.renderInventoryModal();
          this.updateHotbar();
          this.toast(ok ? `Added ${amt > 1 ? `${amt}× ` : ''}${def.name}` : 'Inventory full — tap Clear to make room');
        }
      });
      cat.appendChild(card);
    }

    const cntLbl = document.getElementById('creative-count-label');
    if (cntLbl) {
      cntLbl.textContent = `${shown} item${shown === 1 ? '' : 's'} shown — tap any tile to add`;
    }
  }

  // --- FURNACE (Authentic Classic Minecraft Furnace GUI!) ---
  openFurnace(posKey) {
    this.openModal('furnace-modal');
    this.activeFurnacePos = posKey;
    const panel = document.getElementById('furnace-book-panel');
    if (panel) panel.classList.add('hidden');
    document.getElementById('btn-furnace-book')?.classList.remove('active');
    this.renderFurnaceModal();
  }

  renderFurnaceRecipeBook() {
    if (!this.game || !this.activeFurnacePos) return;
    const f = this.game.world.furnaces.get(this.activeFurnacePos);
    const list = document.getElementById('furnace-book-list');
    if (!f || !list) return;
    const inv = this.game.inventory;
    list.innerHTML = '';

    for (const [inId, outId] of Object.entries(SMELTING_RECIPES)) {
      const inDef = ITEMS[inId];
      const outDef = ITEMS[outId];
      if (!inDef || !outDef) continue;
      let have = 0;
      for (const s of inv.slots) {
        if (s && s.id === inId) have += s.count;
      }

      const row = document.createElement('button');
      row.type = 'button';
      row.className = `furnace-book-row ${have > 0 ? 'available' : 'missing'}`;
      row.innerHTML = `
        <img src="${this.textures.getIcon(inId)}" alt="${inDef.name}" />
        <span class="fb-arrow">→</span>
        <img src="${this.textures.getIcon(outId)}" alt="${outDef.name}" />
        <span class="fb-name">${outDef.name}</span>
      `;
      row.addEventListener('click', () => {
        if (have <= 0) {
          this.toast(`Need ${inDef.name} to smelt`);
          return;
        }
        // Auto-load matching input from inventory
        for (let i = 0; i < 36; i++) {
          const s = inv.slots[i];
          if (s && s.id === inId && (!f.input || f.input.id === inId)) {
            const max = inDef.stackSize || 64;
            const cur = f.input ? f.input.count : 0;
            const move = Math.min(max - cur, s.count);
            if (move > 0) {
              if (!f.input) f.input = { id: inId, count: move };
              else f.input.count += move;
              s.count -= move;
              if (s.count <= 0) inv.slots[i] = null;
            }
          }
        }
        // Also auto-load fuel if furnace has none yet
        if (!f.fuel) {
          for (let i = 0; i < 36; i++) {
            const s = inv.slots[i];
            if (s && FUEL_VALUES[s.id]) {
              f.fuel = { id: s.id, count: s.count };
              inv.slots[i] = null;
              break;
            }
          }
        }
        this.sound.playPop();
        this.renderFurnaceModal();
        this.renderFurnaceRecipeBook();
        this.updateHotbar();
      });
      list.appendChild(row);
    }
  }

  renderFurnaceModal() {
    if (!this.game || !this.activeFurnacePos) return;
    const f = this.game.world.furnaces.get(this.activeFurnacePos);
    if (!f) return;
    const inv = this.game.inventory;

    const flame = document.getElementById('furnace-flame');
    if (flame) flame.classList.toggle('lit', f.burnTime > 0);
    const burnPct = f.burnMax > 0 ? Math.max(0, Math.min(100, (f.burnTime / f.burnMax) * 100)) : 0;
    const cookPct = Math.max(0, Math.min(100, (f.cookTime / 5.0) * 100));
    const fuelBar = document.getElementById('furnace-fuel-bar');
    const cookBar = document.getElementById('furnace-cook-bar');
    if (fuelBar) fuelBar.style.height = `${burnPct}%`;
    if (cookBar) cookBar.style.width = `${cookPct}%`;

    // Never replace slot DOM nodes mid-drag during live smelting tick updates!
    if (this._dragState && this._dragState.active) return;

    const resetSlotNode = (id, ref, item, onTap) => {
      const oldEl = document.getElementById(id);
      if (!oldEl) return;
      const el = oldEl.cloneNode(false);
      oldEl.parentNode.replaceChild(el, oldEl);
      this.renderSlotContent(el, item);
      this.attachSlotInteractions(el, ref, onTap);
    };

    resetSlotNode('furnace-input', { type: 'furnace_in', index: 0 }, f.input, () => {
      if (f.input && inv.addItem(f.input.id, f.input.count)) {
        f.input = null;
        this.sound.playPop();
        this.renderFurnaceModal();
        this.updateHotbar();
      }
    });
    resetSlotNode('furnace-fuel', { type: 'furnace_fuel', index: 0 }, f.fuel, () => {
      if (f.fuel && inv.addItem(f.fuel.id, f.fuel.count)) {
        f.fuel = null;
        this.sound.playPop();
        this.renderFurnaceModal();
        this.updateHotbar();
      }
    });
    resetSlotNode('furnace-output', { type: 'furnace_out', index: 0 }, f.output, () => {
      if (f.output && inv.addItem(f.output.id, f.output.count)) {
        f.output = null;
        this.sound.playPop();
        this.renderFurnaceModal();
        this.updateHotbar();
      }
    });

    const bindFurnaceSlot = (i, parent) => {
      const el = document.createElement('div');
      el.className = 'mc-classic-slot';
      this.renderSlotContent(el, inv.slots[i]);
      this.attachSlotInteractions(el, { type: 'inv', index: i }, () => {
        const s = inv.slots[i];
        if (!s) return;
        const max = (ITEMS[s.id] && ITEMS[s.id].stackSize) || 64;
        if (SMELTING_RECIPES[s.id] && (!f.input || (f.input.id === s.id && f.input.count < max))) {
          const cur = f.input ? f.input.count : 0;
          const move = Math.min(max - cur, s.count);
          if (!f.input) f.input = { id: s.id, count: move };
          else f.input.count += move;
          s.count -= move;
          if (s.count <= 0) inv.slots[i] = null;
          this.sound.playPop();
        } else if (FUEL_VALUES[s.id] && (!f.fuel || (f.fuel.id === s.id && f.fuel.count < max))) {
          const cur = f.fuel ? f.fuel.count : 0;
          const move = Math.min(max - cur, s.count);
          if (!f.fuel) f.fuel = { id: s.id, count: move };
          else f.fuel.count += move;
          s.count -= move;
          if (s.count <= 0) inv.slots[i] = null;
          this.sound.playPop();
        } else {
          this.toast('Not smeltable or fuel');
        }
        this.renderFurnaceModal();
        this.updateHotbar();
      });
      parent.appendChild(el);
    };

    const invGrid = document.getElementById('furnace-player-inv');
    const hbGrid = document.getElementById('furnace-player-hotbar');
    if (invGrid) {
      invGrid.innerHTML = '';
      for (let i = 9; i < 36; i++) bindFurnaceSlot(i, invGrid);
    }
    if (hbGrid) {
      hbGrid.innerHTML = '';
      for (let i = 0; i < 9; i++) bindFurnaceSlot(i, hbGrid);
    }
  }

  // --- CHEST (Authentic Classic Minecraft Chest GUI with Full Drag-and-Drop!) ---
  openChest(posKey) {
    this.openModal('chest-modal');
    this.activeChestPos = posKey;
    this.renderChestModal();
  }

  renderChestModal() {
    if (!this.game || !this.activeChestPos) return;
    const chest = this.game.world.chests.get(this.activeChestPos);
    if (!chest) return;
    const inv = this.game.inventory;

    const cGrid = document.getElementById('chest-grid');
    cGrid.innerHTML = '';
    for (let i = 0; i < 27; i++) {
      const el = document.createElement('div');
      el.className = 'mc-classic-slot';
      this.renderSlotContent(el, chest[i]);
      this.attachSlotInteractions(el, { type: 'chest', index: i }, () => {
        if (chest[i] && inv.addItem(chest[i].id, chest[i].count)) {
          chest[i] = null;
          this.sound.playPop();
          this.renderChestModal();
          this.updateHotbar();
        }
      });
      cGrid.appendChild(el);
    }

    const bindChestPlayerSlot = (i, parent) => {
      const el = document.createElement('div');
      el.className = 'mc-classic-slot';
      this.renderSlotContent(el, inv.slots[i]);
      this.attachSlotInteractions(el, { type: 'inv', index: i }, () => {
        const s = inv.slots[i];
        if (!s) return;
        const max = (ITEMS[s.id] && ITEMS[s.id].stackSize) || 64;
        // 1. Merge into existing partial stacks inside the chest first
        if (max > 1) {
          for (let ci = 0; ci < 27 && s.count > 0; ci++) {
            const cs = chest[ci];
            if (cs && cs.id === s.id && cs.count < max) {
              const add = Math.min(max - cs.count, s.count);
              cs.count += add;
              s.count -= add;
            }
          }
        }
        // 2. Place remaining into first empty chest slot
        if (s.count > 0) {
          const emptyIdx = chest.findIndex((c) => !c);
          if (emptyIdx !== -1) {
            chest[emptyIdx] = { ...s };
            s.count = 0;
          } else {
            this.toast('Chest is full');
          }
        }
        if (s.count <= 0) inv.slots[i] = null;
        this.sound.playPop();
        this.renderChestModal();
        this.updateHotbar();
      });
      parent.appendChild(el);
    };

    const pGrid = document.getElementById('chest-player-inv');
    const hbGrid = document.getElementById('chest-player-hotbar');
    if (pGrid) {
      pGrid.innerHTML = '';
      for (let i = 9; i < 36; i++) bindChestPlayerSlot(i, pGrid);
    }
    if (hbGrid) {
      hbGrid.innerHTML = '';
      for (let i = 0; i < 9; i++) bindChestPlayerSlot(i, hbGrid);
    }
  }

  // --- MODS & ADD-ONS ---
  openModsModal() {
    this.openModal('mods-modal');
    this.renderModsUI();
  }

  renderModsUI() {
    if (!this.game || !this.game.mods) return;
    const mods = this.game.mods;
    const countEl = document.getElementById('title-mod-count');
    if (countEl) countEl.textContent = mods.getActiveCount();

    const minimapWrap = document.getElementById('minimap-wrap');
    if (minimapWrap) minimapWrap.classList.toggle('hidden', !mods.isEnabled('minimap'));

    for (const containerId of ['title-mods-list', 'ingame-mods-list']) {
      const wrap = document.getElementById(containerId);
      if (!wrap) continue;
      wrap.innerHTML = '';
      for (const m of MOD_LIST) {
        const isOn = mods.isEnabled(m.id);
        const card = document.createElement('button');
        card.className = `mod-card ${isOn ? 'enabled' : ''}`;
        card.innerHTML = `
          <div class="mod-card-left">
            <img class="px-ui-icon mod-px" src="${this.textures.getUiIcon(m.icon)}" alt="" />
            <div>
              <div class="mod-name">${m.name}</div>
              <div class="mod-desc">${m.desc}</div>
            </div>
          </div>
          <span class="mod-pill">${isOn ? 'ON' : 'OFF'}</span>
        `;
        card.addEventListener('click', () => {
          mods.setEnabled(m.id, !isOn);
          this.sound.playPop();
          this.renderModsUI();
          this.toast(`${m.name}: ${!isOn ? 'ON' : 'OFF'}`);
        });
        wrap.appendChild(card);
      }
    }
  }

  // --- VILLAGER TRADING ---
  openTradeModal(villager) {
    this.activeVillager = villager;
    this.openModal('trade-modal');
    const prof = villager.profession || 'Farmer';
    document.getElementById('trade-modal-title').textContent = `Villager Trade — ${prof}`;
    this.renderTradeModal(prof);
  }

  renderTradeModal(prof) {
    if (!this.game) return;
    const inv = this.game.inventory;
    const list = document.getElementById('trade-list');
    list.innerHTML = '';
    const trades = VILLAGER_TRADES[prof] || VILLAGER_TRADES.Farmer;

    for (const tr of trades) {
      let have = 0;
      for (const s of inv.slots) {
        if (s && s.id === tr.give) have += s.count;
      }
      const canTrade = have >= tr.giveCount;
      const giveDef = ITEMS[tr.give];
      const getDef = ITEMS[tr.get];
      if (!giveDef || !getDef) continue;

      const row = document.createElement('button');
      row.className = `trade-row ${canTrade ? 'available' : 'disabled'}`;
      row.innerHTML = `
        <div class="trade-side">
          <img src="${this.textures.getIcon(tr.give)}" alt="" />
          <span>${tr.giveCount}× ${giveDef.name}</span>
        </div>
        <img class="px-ui-icon arrow-px" src="${this.textures.getUiIcon('arrow_right_gold')}" alt="" />
        <div class="trade-side">
          <img src="${this.textures.getIcon(tr.get)}" alt="" />
          <span>${tr.getCount}× ${getDef.name}</span>
        </div>
      `;
      row.addEventListener('click', () => {
        if (!canTrade) {
          this.toast(`Need ${tr.giveCount}× ${giveDef.name}`);
          return;
        }
        let rem = tr.giveCount;
        for (let i = 0; i < inv.slots.length && rem > 0; i++) {
          const s = inv.slots[i];
          if (s && s.id === tr.give) {
            const take = Math.min(s.count, rem);
            s.count -= take;
            rem -= take;
            if (s.count <= 0) inv.slots[i] = null;
          }
        }
        inv.addItem(tr.get, tr.getCount);
        this.sound.playCraft();
        this.updateHotbar();
        this.renderTradeModal(prof);
        this.toast(`Traded for ${tr.getCount}× ${getDef.name}!`);
      });
      list.appendChild(row);
    }
  }

  // --- LIVE MINI-MAP RADAR (Offscreen-cached terrain for 98% less CPU!) ---
  renderMinimap(player, world, entities, biomeName = 'Plains') {
    const canvas = this.dom.mmCanvas;
    if (!canvas || !this.game?.mods?.isEnabled('minimap')) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const half = w / 2;
    const scale = 2;
    const step = 6;

    const px = Math.floor(player.pos.x);
    const pz = Math.floor(player.pos.z);

    if (!this._mmBgCanvas) {
      this._mmBgCanvas = document.createElement('canvas');
      this._mmBgCanvas.width = w;
      this._mmBgCanvas.height = h;
    }

    // Only recompute biome terrain grid when player moves >= 4 blocks or switches worlds!
    if (
      this._mmLastSeed !== world.seed ||
      Math.abs(px - this._mmLastPx) >= 4 ||
      Math.abs(pz - this._mmLastPz) >= 4
    ) {
      this._mmLastSeed = world.seed;
      this._mmLastPx = px;
      this._mmLastPz = pz;
      const bctx = this._mmBgCanvas.getContext('2d');
      const biomeColors = {
        Plains: '#5da135',
        Forest: '#387526',
        'Birch Forest': '#66a83c',
        Desert: '#dfd09c',
        'Snowy Taiga': '#e4f0fa',
        Mountains: '#8a919c',
        Savanna: '#a8ab46',
        Jungle: '#2b9c30',
        Badlands: '#c96836',
        Swamp: '#4f663a',
        'Cherry Grove': '#f2a2c2',
        Ocean: '#1e64b4',
        'Deep Ocean': '#134280'
      };
      for (let sy = 0; sy < h; sy += step) {
        for (let sx = 0; sx < w; sx += step) {
          const wx = px + (sx - half) * scale;
          const wz = pz + (sy - half) * scale;
          const b = world.getBiomeAt(wx, wz);
          bctx.fillStyle = biomeColors[b] || '#5da135';
          bctx.fillRect(sx, sy, step, step);
        }
      }
    }

    ctx.drawImage(this._mmBgCanvas, 0, 0);

    // Draw nearby villages as gold markers (and Underground Villages as bright cyan-teal diamonds!)
    let nearestVDist = Infinity;
    let nearestVLabel = 'Village';
    for (const v of world.villageChunks.values()) {
      const dx = (v.x - px) / scale;
      const dz = (v.z - pz) / scale;
      const dist = Math.hypot(v.x - px, v.z - pz);
      if (dist < nearestVDist) {
        nearestVDist = dist;
        nearestVLabel = v.isUnderground ? 'Underground Village' : 'Village';
      }
      const mx = half + dx;
      const my = half + dz;
      if (mx >= 4 && mx <= w - 4 && my >= 4 && my <= h - 4) {
        ctx.fillStyle = v.isUnderground ? '#22d3ee' : '#ffd54f';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        if (v.isUnderground) {
          ctx.beginPath();
          ctx.moveTo(mx, my - 4.5);
          ctx.lineTo(mx + 4.5, my);
          ctx.lineTo(mx, my + 4.5);
          ctx.lineTo(mx - 4.5, my);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillRect(mx - 3, my - 3, 6, 6);
          ctx.strokeRect(mx - 3, my - 3, 6, 6);
        }
      }
    }

    // Draw nearby Mega-Structures (Great Pyramid & Grand Citadel!) as bright gold/orange pyramid triangles!
    let nearestMegaDist = Infinity;
    let nearestMegaName = '';
    if (world.megaStructures) {
      for (const ms of world.megaStructures.values()) {
        const dx = (ms.x - px) / scale;
        const dz = (ms.z - pz) / scale;
        const dist = Math.hypot(ms.x - px, ms.z - pz);
        if (dist < nearestMegaDist) {
          nearestMegaDist = dist;
          nearestMegaName = ms.name || 'Mega Structure';
        }
        const mx = half + dx;
        const my = half + dz;
        if (mx >= 6 && mx <= w - 6 && my >= 6 && my <= h - 6) {
          ctx.fillStyle = ms.type === 'great_pyramid' ? '#ff9800' : '#a855f7';
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(mx, my - 5.5);
          ctx.lineTo(mx + 5.5, my + 4.5);
          ctx.lineTo(mx - 5.5, my + 4.5);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    const hintEl = this.dom.mmHint;
    if (hintEl) {
      let hintTxt = biomeName;
      if (nearestMegaDist < 260 && nearestMegaDist <= nearestVDist + 40) {
        hintTxt = `${nearestMegaName} ${Math.round(nearestMegaDist)}m`;
      } else if (nearestVDist < 240) {
        hintTxt = `${nearestVLabel} ${Math.round(nearestVDist)}m`;
      }
      if (hintEl.textContent !== hintTxt) hintEl.textContent = hintTxt;
    }

    // Draw nearby mobs & wildlife
    for (const m of entities.mobs) {
      const mx = half + (m.pos.x - px) / scale;
      const my = half + (m.pos.z - pz) / scale;
      if (mx < 2 || mx > w - 2 || my < 2 || my > h - 2) continue;
      ctx.fillStyle = m.def.hostile
        ? '#ff4444'
        : (m.def.villager ? '#ffe066' : ((m.def.flying || m.def.aquatic) ? '#6ee7ff' : '#a8ff8a'));
      ctx.fillRect(mx - 2, my - 2, 4, 4);
    }

    // Player directional triangle in center
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(-player.yaw);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.5, 5);
    ctx.lineTo(0, 2.5);
    ctx.lineTo(-4.5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
