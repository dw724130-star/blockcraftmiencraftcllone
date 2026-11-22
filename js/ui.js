import { ITEMS, getItemCategory } from './blocks.js';
import { RECIPES, matchCraftingGrid, canCraftRecipe, quickCraftRecipe, SMELTING_RECIPES, FUEL_VALUES } from './recipes.js';
import { MOD_LIST } from './mods.js';
import { VILLAGER_TRADES } from './mobs.js';
import { DEFAULT_KEYBINDS } from './storage.js';

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
    const views = ['home', 'singleplayer', 'multiplayer', 'mods', 'settings', 'guide'];
    for (const v of views) {
      const el = document.getElementById(`title-view-${v}`);
      if (el) el.classList.toggle('hidden', v !== viewName);
    }
    if (viewName === 'mods') this.renderModsUI();
    if (viewName === 'settings' && this.game) {
      this.syncSettingsUI(this.game.settings);
      this.syncCheatUI(this.game.areCheatsAllowed());
    }
  }

  hydratePixelIcons() {
    document.querySelectorAll('img[data-px-icon]').forEach((img) => {
      const key = img.dataset.pxIcon;
      const src = this.textures.getUiIcon(key);
      if (src) img.src = src;
    });
  }

  bindStaticEvents() {
    // Modal close buttons (including classic Chest & Furnace close buttons + backdrop tap!)
    document.querySelectorAll('.close-modal-btn, .mc-classic-close').forEach((btn) => {
      btn.addEventListener('click', () => this.closeModals());
    });
    for (const mid of ['chest-modal', 'furnace-modal']) {
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

    // Inventory tabs
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.inv-tab-panel').forEach((p) => p.classList.add('hidden'));
        document.getElementById(`inv-tab-${tab}`).classList.remove('hidden');
        if (tab === 'recipes') this.renderRecipeBook();
        if (tab === 'creative' && !this._creativeRendered) {
          this._creativeRendered = true;
          this.renderCreativeCatalog(document.getElementById('creative-search')?.value || '');
        }
      });
    });

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
        stackBtn.textContent = this.creativeGiveStack ? 'Give ×64' : 'Give ×1';
        this.sound.playPop();
      });
    }
    const clearInvBtn = document.getElementById('btn-creative-clear');
    if (clearInvBtn) {
      clearInvBtn.addEventListener('click', () => {
        if (!this.game) return;
        this.game.inventory.slots.fill(null);
        this.game.inventory.armor.fill(null);
        this.sound.playPop();
        this.renderInventoryModal();
        this.updateHotbar();
        this.toast('Inventory cleared');
      });
    }
    document.getElementById('recipe-search')?.addEventListener('input', () => {
      this.renderRecipeBook();
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
        const v = parseInt(e.target.value, 10);
        document.getElementById('title-val-render-dist').textContent = v;
        if (this.game) {
          this.game.updateSetting('renderDistance', v);
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
      const v = parseInt(e.target.value, 10);
      document.getElementById('val-render-dist').textContent = v;
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
    document.getElementById('set-shaders').addEventListener('change', (e) => {
      if (this.game) this.game.updateSetting('shaders', e.target.value);
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
      const nw = document.getElementById('new-world-cheats');
      if (nw) nw.checked = e.target.checked;
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

    // Create World button
    document.getElementById('btn-create-world').addEventListener('click', () => {
      const name = document.getElementById('new-world-name').value.trim() || 'My World';
      const mode = document.getElementById('new-world-mode').value;
      const worldType = document.getElementById('new-world-type').value;
      const seed = document.getElementById('new-world-seed').value.trim() || String(Math.floor(Math.random() * 9999999));
      const allowCheats = Boolean(document.getElementById('new-world-cheats')?.checked);
      if (this.game) this.game.startNewWorld({ name, mode, worldType, seed, allowCheats });
    });
  }

  syncSettingsUI(settings) {
    document.getElementById('set-render-dist').value = settings.renderDistance;
    document.getElementById('val-render-dist').textContent = settings.renderDistance;
    document.getElementById('set-sensitivity').value = settings.sensitivity;
    document.getElementById('val-sensitivity').textContent = settings.sensitivity.toFixed(1);
    document.getElementById('set-fov').value = settings.fov;
    document.getElementById('val-fov').textContent = settings.fov;
    document.getElementById('set-shaders').value = settings.shaders || 'ultra';
    document.getElementById('set-mc-ui').checked = settings.minecraftUI !== false;
    document.getElementById('set-large-ui').checked = settings.largeUI !== false;
    document.getElementById('set-biome-fx').checked = settings.biomeEffects !== false;
    document.getElementById('set-control-style').value = settings.controlStyle;
    document.getElementById('set-show-touch').checked = settings.showTouch;
    document.getElementById('set-sound').checked = settings.sound;
    const cheatCb = document.getElementById('set-allow-cheats');
    if (cheatCb) cheatCb.checked = Boolean(settings.allowCheats);
    const tShaders = document.getElementById('title-set-shaders');
    if (tShaders) tShaders.value = settings.shaders || 'ultra';
    const tRD = document.getElementById('title-set-render-dist');
    const tRDVal = document.getElementById('title-val-render-dist');
    if (tRD) tRD.value = settings.renderDistance;
    if (tRDVal) tRDVal.textContent = settings.renderDistance;
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
      card.innerHTML = `
        <div class="world-card-info">
          <div class="world-card-name">${this.escapeHtml(w.name)}</div>
          <div class="world-card-meta">${w.mode.toUpperCase()} • ${w.worldType || 'infinite'} • Seed: ${w.seed} • ${dateStr}</div>
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

  // Dynamic context-aware buttons: PLACE <-> USE and MINE <-> DAMAGE!
  updateActionButtons(useMode, damageMode) {
    if (useMode !== this._lastPlaceMode) {
      this._lastPlaceMode = useMode;
      if (this.dom.btnPlace) {
        this.dom.btnPlace.classList.toggle('mode-use', useMode);
        this.dom.btnPlaceLbl.textContent = useMode ? 'USE' : 'PLACE';
        this.dom.btnPlaceIcon.src = this.textures.getUiIcon(useMode ? 'use' : 'place');
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

  updateMiningRing(progress) {
    const ring = this.dom.breakRing;
    const fill = this.dom.breakFill;
    if (progress > 0 && progress < 1) {
      ring.classList.remove('hidden');
      const circ = 113.1;
      fill.setAttribute('stroke-dashoffset', String(circ * (1 - progress)));
    } else {
      ring.classList.add('hidden');
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
    if (this.activeModal === 'inventory-modal') {
      // Return items left in crafting grid to inventory
      for (let i = 0; i < 9; i++) {
        if (this.craftGrid[i] && this.game) {
          this.game.inventory.addItem(this.craftGrid[i].id, this.craftGrid[i].count);
          this.craftGrid[i] = null;
        }
      }
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
    if (this.activeModal === 'inventory-modal' && !isTable) {
      this.closeModals();
      return;
    }
    this.isCraftingTable = isTable;
    this.pickedSource = null;
    this.openModal('inventory-modal');

    document.getElementById('inv-modal-title').textContent = isTable ? 'Crafting Table (3×3)' : 'Inventory & Crafting';
    document.getElementById('craft-grid-label').textContent = isTable ? 'Crafting (3×3)' : 'Crafting (2×2)';
    document.getElementById('recipe-station-badge').textContent = isTable ? '3×3 Crafting Table' : '2×2 Hand Crafting';

    const isCreative = this.game.player.mode === 'creative';
    const tabCreative = document.getElementById('tab-btn-creative');
    tabCreative.classList.toggle('hidden', !isCreative);

    // Default to Creative catalog in Creative mode, Recipes on Crafting Table, or Craft tab in Survival
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.inv-tab-panel').forEach((p) => p.classList.add('hidden'));
    const startTab = isTable ? 'recipes' : (isCreative ? 'creative' : 'craft');
    document.querySelector(`.tab-btn[data-tab="${startTab}"]`).classList.add('active');
    document.getElementById(`inv-tab-${startTab}`).classList.remove('hidden');

    this.renderInventoryModal();
    if (startTab === 'recipes') this.renderRecipeBook();
    if (startTab === 'creative') {
      this._creativeRendered = true;
      this.renderCreativeCatalog(document.getElementById('creative-search')?.value || '');
    }
  }

  renderInventoryModal() {
    if (!this.game) return;
    const inv = this.game.inventory;

    // Cursor info & Delete button active state
    const curEl = document.getElementById('selected-cursor-info');
    const trashEl = document.getElementById('inv-trash-slot');
    if (this.pickedSource) {
      const it = this.getSlotByRef(this.pickedSource);
      curEl.textContent = it ? `Selected: ${ITEMS[it.id].name} (tap destination or Delete)` : '';
      if (trashEl) trashEl.classList.toggle('ready-delete', !!it);
    } else {
      curEl.textContent = 'Drag blocks to move or drop on Delete';
      if (trashEl) trashEl.classList.remove('ready-delete');
    }

    // Armor Slots (pixel-art silhouettes, no emojis!)
    const armorGrid = document.getElementById('armor-slots');
    armorGrid.innerHTML = '';
    const armorPlaceholders = ['slot_helmet', 'slot_chestplate', 'slot_leggings', 'slot_boots'];
    for (let i = 0; i < 4; i++) {
      const el = document.createElement('div');
      el.className = 'inv-slot';
      if (this.pickedSource && this.pickedSource.type === 'armor' && this.pickedSource.index === i) el.classList.add('picked');
      if (inv.armor[i]) this.renderSlotContent(el, inv.armor[i]);
      else el.innerHTML = `<img class="px-ui-icon slot-placeholder-px" src="${this.textures.getUiIcon(armorPlaceholders[i])}" alt="" />`;
      this.attachSlotInteractions(el, { type: 'armor', index: i });
      armorGrid.appendChild(el);
    }

    // Craft Grid
    const size = this.isCraftingTable ? 3 : 2;
    const cg = document.getElementById('craft-grid');
    cg.className = `craft-grid ${size === 3 ? 'grid-3x3' : 'grid-2x2'}`;
    cg.innerHTML = '';
    for (let i = 0; i < size * size; i++) {
      const el = document.createElement('div');
      el.className = 'inv-slot';
      if (this.pickedSource && this.pickedSource.type === 'craft' && this.pickedSource.index === i) el.classList.add('picked');
      this.renderSlotContent(el, this.craftGrid[i]);
      this.attachSlotInteractions(el, { type: 'craft', index: i });
      cg.appendChild(el);
    }

    // Craft Output
    const outEl = document.getElementById('craft-output');
    const matched = matchCraftingGrid(this.craftGrid.slice(0, size * size), size);
    this.renderSlotContent(outEl, matched ? { id: matched.out, count: matched.count } : null);
    outEl.onclick = () => {
      if (!matched) return;
      for (let i = 0; i < size * size; i++) {
        if (this.craftGrid[i]) {
          this.craftGrid[i].count--;
          if (this.craftGrid[i].count <= 0) this.craftGrid[i] = null;
        }
      }
      inv.addItem(matched.out, matched.count);
      this.sound.playCraft();
      this.renderInventoryModal();
      this.updateHotbar();
    };

    // Main Inventory (9..35)
    const mainGrid = document.getElementById('main-inv-grid');
    mainGrid.innerHTML = '';
    for (let i = 9; i < 36; i++) {
      const el = document.createElement('div');
      el.className = 'inv-slot';
      if (this.pickedSource && this.pickedSource.type === 'inv' && this.pickedSource.index === i) el.classList.add('picked');
      this.renderSlotContent(el, inv.slots[i]);
      this.attachSlotInteractions(el, { type: 'inv', index: i });
      mainGrid.appendChild(el);
    }

    // Hotbar (0..8)
    const hbGrid = document.getElementById('modal-hotbar-grid');
    hbGrid.innerHTML = '';
    for (let i = 0; i < 9; i++) {
      const el = document.createElement('div');
      el.className = 'inv-slot';
      if (this.pickedSource && this.pickedSource.type === 'inv' && this.pickedSource.index === i) el.classList.add('picked');
      this.renderSlotContent(el, inv.slots[i]);
      this.attachSlotInteractions(el, { type: 'inv', index: i });
      hbGrid.appendChild(el);
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

  attachSlotInteractions(el, ref) {
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
    el.addEventListener('click', () => {
      if (this._suppressNextClick) return;
      this.handleSlotClick(ref);
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
    this.renderInventoryModal();
    this.updateHotbar();
  }

  moveOrSwapSlot(srcRef, dstRef, singleCraft = true) {
    const src = this.getSlotByRef(srcRef);
    const dst = this.getSlotByRef(dstRef);
    if (!src) return;

    // Armor slot validation
    if (dstRef.type === 'armor') {
      const def = ITEMS[src.id];
      if (!def || def.armorSlot !== dstRef.index) {
        this.toast('Cannot equip that here');
        this.pickedSource = null;
        this.renderInventoryModal();
        return;
      }
    }

    // If tapping into craft grid and src has >1, place 1 item for easy crafting; dragging moves full stack/merges!
    if (singleCraft && dstRef.type === 'craft' && src.count > 1 && (!dst || dst.id === src.id)) {
      src.count -= 1;
      if (!dst) this.setSlotByRef(dstRef, { id: src.id, count: 1 });
      else dst.count += 1;
      if (src.count <= 0) this.setSlotByRef(srcRef, null);
    } else if (dst && src.id === dst.id && (ITEMS[src.id].stackSize || 64) > 1) {
      // Merge stacks
      const max = ITEMS[src.id].stackSize || 64;
      const move = Math.min(max - dst.count, src.count);
      dst.count += move;
      src.count -= move;
      if (src.count <= 0) this.setSlotByRef(srcRef, null);
      this.pickedSource = null;
    } else {
      // Swap
      this.setSlotByRef(dstRef, src);
      this.setSlotByRef(srcRef, dst);
      this.pickedSource = null;
    }

    this.sound.playPop();
    this.renderInventoryModal();
    this.updateHotbar();
  }

  getSlotByRef(ref) {
    if (ref.type === 'inv') return this.game.inventory.slots[ref.index];
    if (ref.type === 'armor') return this.game.inventory.armor[ref.index];
    if (ref.type === 'craft') return this.craftGrid[ref.index];
    return null;
  }

  setSlotByRef(ref, val) {
    if (ref.type === 'inv') this.game.inventory.slots[ref.index] = val;
    else if (ref.type === 'armor') this.game.inventory.armor[ref.index] = val;
    else if (ref.type === 'craft') this.craftGrid[ref.index] = val;
  }

  handleSlotClick(ref) {
    if (!this.pickedSource) {
      const cur = this.getSlotByRef(ref);
      if (cur) this.pickedSource = ref;
      this.renderInventoryModal();
      this.updateHotbar();
    } else if (this.pickedSource.type === ref.type && this.pickedSource.index === ref.index) {
      this.pickedSource = null;
      this.renderInventoryModal();
      this.updateHotbar();
    } else {
      this.moveOrSwapSlot(this.pickedSource, ref, true);
    }
  }

  renderRecipeBook() {
    if (!this.game) return;
    const list = document.getElementById('recipe-list');
    list.innerHTML = '';
    const q = (document.getElementById('recipe-search')?.value || '').trim().toLowerCase();

    const sorted = [...RECIPES]
      .filter((r) => {
        if (r.table && !this.isCraftingTable) return false;
        if (!q) return true;
        const def = ITEMS[r.out];
        return def && (def.name.toLowerCase().includes(q) || def.id.includes(q));
      })
      .sort((a, b) => {
        const ca = canCraftRecipe(a, this.game.inventory, this.isCraftingTable) ? 0 : 1;
        const cb = canCraftRecipe(b, this.game.inventory, this.isCraftingTable) ? 0 : 1;
        return ca - cb;
      });

    for (const r of sorted) {
      const ok = canCraftRecipe(r, this.game.inventory, this.isCraftingTable);
      const outDef = ITEMS[r.out];
      if (!outDef) continue;

      const costStr = Object.entries(r.cost)
        .map(([k, n]) => `${n}× ${k === 'any_planks' ? 'Planks' : (k === 'any_wool' ? 'Wool' : (ITEMS[k]?.name || k))}`)
        .join(', ');

      const card = document.createElement('button');
      card.className = `recipe-card ${ok ? 'craftable' : 'disabled'}`;
      card.innerHTML = `
        <img src="${this.textures.getIcon(r.out)}" alt="" />
        <div>
          <div class="recipe-card-name">${outDef.name}${r.count > 1 ? ` ×${r.count}` : ''}</div>
          <div class="recipe-card-cost">${costStr}</div>
        </div>
      `;
      card.addEventListener('click', () => {
        if (quickCraftRecipe(r, this.game.inventory, this.isCraftingTable)) {
          this.sound.playCraft();
          this.renderRecipeBook();
          this.renderInventoryModal();
          this.updateHotbar();
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

    const inEl = document.getElementById('furnace-input');
    const fuelEl = document.getElementById('furnace-fuel');
    const outEl = document.getElementById('furnace-output');
    this.renderSlotContent(inEl, f.input);
    this.renderSlotContent(fuelEl, f.fuel);
    this.renderSlotContent(outEl, f.output);

    const flame = document.getElementById('furnace-flame');
    if (flame) flame.classList.toggle('lit', f.burnTime > 0);
    const burnPct = f.burnMax > 0 ? Math.max(0, Math.min(100, (f.burnTime / f.burnMax) * 100)) : 0;
    const cookPct = Math.max(0, Math.min(100, (f.cookTime / 5.0) * 100));
    const fuelBar = document.getElementById('furnace-fuel-bar');
    const cookBar = document.getElementById('furnace-cook-bar');
    if (fuelBar) fuelBar.style.height = `${burnPct}%`;
    if (cookBar) cookBar.style.width = `${cookPct}%`;

    inEl.onclick = () => {
      if (f.input && inv.addItem(f.input.id, f.input.count)) {
        f.input = null;
        this.sound.playPop();
        this.renderFurnaceModal();
        this.updateHotbar();
      }
    };
    fuelEl.onclick = () => {
      if (f.fuel && inv.addItem(f.fuel.id, f.fuel.count)) {
        f.fuel = null;
        this.sound.playPop();
        this.renderFurnaceModal();
        this.updateHotbar();
      }
    };
    outEl.onclick = () => {
      if (f.output && inv.addItem(f.output.id, f.output.count)) {
        f.output = null;
        this.sound.playPop();
        this.renderFurnaceModal();
        this.updateHotbar();
      }
    };

    const bindFurnaceSlot = (i, parent) => {
      const el = document.createElement('div');
      el.className = 'mc-classic-slot';
      this.renderSlotContent(el, inv.slots[i]);
      el.addEventListener('click', () => {
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

  // --- CHEST (Authentic Classic Minecraft Chest GUI!) ---
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
      el.addEventListener('click', () => {
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
      el.addEventListener('click', () => {
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
        Mountains: '#8a919c'
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

    // Draw nearby villages as gold markers
    let nearestVDist = Infinity;
    for (const v of world.villageChunks.values()) {
      const dx = (v.x - px) / scale;
      const dz = (v.z - pz) / scale;
      const dist = Math.hypot(v.x - px, v.z - pz);
      if (dist < nearestVDist) nearestVDist = dist;
      const mx = half + dx;
      const my = half + dz;
      if (mx >= 4 && mx <= w - 4 && my >= 4 && my <= h - 4) {
        ctx.fillStyle = '#ffd54f';
        ctx.fillRect(mx - 3, my - 3, 6, 6);
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.strokeRect(mx - 3, my - 3, 6, 6);
      }
    }

    const hintEl = this.dom.mmHint;
    if (hintEl) {
      const hintTxt = nearestVDist < 200 ? `Village ${Math.round(nearestVDist)}m` : biomeName;
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
