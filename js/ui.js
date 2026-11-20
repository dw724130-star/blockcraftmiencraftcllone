import { ITEMS } from './blocks.js';
import { RECIPES, matchCraftingGrid, canCraftRecipe, quickCraftRecipe, SMELTING_RECIPES, FUEL_VALUES } from './recipes.js';
import { MOD_LIST } from './mods.js';
import { VILLAGER_TRADES } from './mobs.js';

const SPLASH_TEXTS = [
  'Villages, Shaders & Mods!',
  'Built for iPad Touch!',
  'Punch Trees First!',
  'Trade with Villagers!',
  '100% WebGL Voxel Engine!',
  'Now with Ridged Mountains!'
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

    // App callbacks wired by main.js
    this.game = null;
    this.bindStaticEvents();
  }

  bind(game) {
    this.game = game;
    this.buildHotbarDOM();
    this.renderCreativeCatalog('');
    this.renderModsUI();
    const splash = document.getElementById('title-splash');
    if (splash) splash.textContent = SPLASH_TEXTS[Math.floor(Math.random() * SPLASH_TEXTS.length)];
  }

  bindStaticEvents() {
    // Modal close buttons
    document.querySelectorAll('.close-modal-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.closeModals());
    });

    // Inventory tabs
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.inv-tab-panel').forEach((p) => p.classList.add('hidden'));
        document.getElementById(`inv-tab-${tab}`).classList.remove('hidden');
        if (tab === 'recipes') this.renderRecipeBook();
      });
    });

    // Creative search
    document.getElementById('creative-search').addEventListener('input', (e) => {
      this.renderCreativeCatalog(e.target.value);
    });

    // Title screen tabs
    document.querySelectorAll('.title-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.titleTab;
        document.querySelectorAll('.title-tab').forEach((b) => {
          b.classList.toggle('active', b === btn);
          b.classList.toggle('primary', b === btn);
        });
        document.querySelectorAll('.title-tab-view').forEach((v) => v.classList.add('hidden'));
        const el = document.getElementById(`title-tab-${tab}`);
        if (el) el.classList.remove('hidden');
        if (tab === 'mods') this.renderModsUI();
      });
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
    document.getElementById('btn-save-now').addEventListener('click', () => {
      if (this.game) this.game.saveCurrentWorld(true);
    });
    document.getElementById('btn-toggle-mode').addEventListener('click', () => {
      if (this.game) {
        const next = this.game.player.mode === 'survival' ? 'creative' : 'survival';
        this.game.setGameMode(next);
        this.closeModals();
      }
    });
    document.getElementById('btn-respawn-spawn').addEventListener('click', () => {
      if (this.game) {
        this.game.player.respawn();
        this.closeModals();
        this.toast('Teleported to spawn');
      }
    });
    document.getElementById('btn-save-quit').addEventListener('click', () => {
      if (this.game) this.game.quitToTitle();
    });

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
    document.querySelectorAll('.cmd-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        if (this.game) this.game.handleChatCommand(chip.dataset.cmd);
        this.closeModals();
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
      if (this.game) this.game.startNewWorld({ name, mode, worldType, seed });
    });
  }

  syncSettingsUI(settings) {
    document.getElementById('set-render-dist').value = settings.renderDistance;
    document.getElementById('val-render-dist').textContent = settings.renderDistance;
    document.getElementById('set-sensitivity').value = settings.sensitivity;
    document.getElementById('val-sensitivity').textContent = settings.sensitivity.toFixed(1);
    document.getElementById('set-fov').value = settings.fov;
    document.getElementById('val-fov').textContent = settings.fov;
    document.getElementById('set-shaders').value = settings.shaders || 'enhanced';
    document.getElementById('set-mc-ui').checked = settings.minecraftUI !== false;
    document.getElementById('set-large-ui').checked = settings.largeUI !== false;
    document.getElementById('set-biome-fx').checked = settings.biomeEffects !== false;
    document.getElementById('set-control-style').value = settings.controlStyle;
    document.getElementById('set-show-touch').checked = settings.showTouch;
    document.getElementById('set-sound').checked = settings.sound;
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
          <button class="mc-btn danger sm del-btn">✕</button>
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

  updateStats() {
    if (!this.game) return;
    const p = this.game.player;
    const isSurvival = p.mode === 'survival';
    document.getElementById('survival-bars').classList.toggle('hidden', !isSurvival);
    document.getElementById('hud-mode-badge').textContent = p.mode.toUpperCase() + (p.flying ? ' ✈' : '');
    if (!isSurvival) return;

    // Hearts (10 icons for 20 HP)
    const hpEl = document.getElementById('health-bar');
    let hpHtml = '';
    for (let i = 0; i < 10; i++) {
      const v = p.hp - i * 2;
      hpHtml += v >= 2 ? '❤️' : v >= 1 ? '💔' : '🖤';
    }
    hpEl.textContent = hpHtml;

    // Hunger (10 icons for 20 hunger)
    const hungEl = document.getElementById('hunger-bar');
    let hungHtml = '';
    for (let i = 0; i < 10; i++) {
      const v = p.hunger - i * 2;
      hungHtml += v >= 1 ? '🍗' : '🦴';
    }
    hungEl.textContent = hungHtml;

    // Armor
    const def = this.game.inventory.getArmorDefense();
    const armEl = document.getElementById('armor-bar');
    armEl.textContent = def > 0 ? '🛡️'.repeat(Math.min(10, Math.ceil(def / 2))) : '';

    // Air bubbles when underwater
    const airEl = document.getElementById('air-bar');
    if (p.headInWater || p.air < p.maxAir) {
      airEl.classList.remove('hidden');
      airEl.textContent = '🫧'.repeat(Math.ceil(p.air));
    } else {
      airEl.classList.add('hidden');
    }

    // XP
    const needed = 10 + p.level * 5;
    document.getElementById('xp-bar-fill').style.width = `${Math.min(100, (p.xp / needed) * 100)}%`;
    document.getElementById('xp-level').textContent = p.level;
  }

  updateTopHUD(player, world, sky, fps) {
    const x = Math.floor(player.pos.x);
    const y = Math.floor(player.pos.y);
    const z = Math.floor(player.pos.z);
    document.getElementById('hud-coords').textContent = `${x}, ${y}, ${z}`;
    document.getElementById('hud-biome').textContent = world.getBiomeAt(x, z);
    document.getElementById('hud-time').textContent = sky.getFormattedTime();
    document.getElementById('hud-fps').textContent = `${fps} FPS`;
  }

  updateMiningRing(progress) {
    const ring = document.getElementById('break-ring');
    const fill = document.getElementById('break-ring-fill');
    if (progress > 0 && progress < 1) {
      ring.classList.remove('hidden');
      const circ = 113.1;
      fill.setAttribute('stroke-dashoffset', String(circ * (1 - progress)));
    } else {
      ring.classList.add('hidden');
    }
  }

  updateTargetTooltip(text) {
    const el = document.getElementById('target-tooltip');
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
  }

  openChat() {
    this.openModal('chat-modal');
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

    const tabCreative = document.getElementById('tab-btn-creative');
    tabCreative.classList.toggle('hidden', this.game.player.mode !== 'creative');

    // Default to Recipes tab on Crafting Table for fast iPad UX, or Craft tab
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.inv-tab-panel').forEach((p) => p.classList.add('hidden'));
    const startTab = isTable ? 'recipes' : 'craft';
    document.querySelector(`.tab-btn[data-tab="${startTab}"]`).classList.add('active');
    document.getElementById(`inv-tab-${startTab}`).classList.remove('hidden');

    this.renderInventoryModal();
    if (startTab === 'recipes') this.renderRecipeBook();
  }

  renderInventoryModal() {
    if (!this.game) return;
    const inv = this.game.inventory;

    // Cursor info
    const curEl = document.getElementById('selected-cursor-info');
    if (this.pickedSource) {
      const it = this.getSlotByRef(this.pickedSource);
      curEl.textContent = it ? `Selected: ${ITEMS[it.id].name} (tap destination)` : '';
    } else {
      curEl.textContent = '';
    }

    // Armor Slots
    const armorGrid = document.getElementById('armor-slots');
    armorGrid.innerHTML = '';
    const armorPlaceholders = ['🪖', '🦺', '👖', '🥾'];
    for (let i = 0; i < 4; i++) {
      const el = document.createElement('div');
      el.className = 'inv-slot';
      if (this.pickedSource && this.pickedSource.type === 'armor' && this.pickedSource.index === i) el.classList.add('picked');
      if (inv.armor[i]) this.renderSlotContent(el, inv.armor[i]);
      else el.innerHTML = `<span style="opacity:0.3;font-size:20px">${armorPlaceholders[i]}</span>`;
      el.addEventListener('click', () => this.handleSlotClick({ type: 'armor', index: i }));
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
      el.addEventListener('click', () => this.handleSlotClick({ type: 'craft', index: i }));
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
      el.addEventListener('click', () => this.handleSlotClick({ type: 'inv', index: i }));
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
      el.addEventListener('click', () => this.handleSlotClick({ type: 'inv', index: i }));
      hbGrid.appendChild(el);
    }
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
    } else if (this.pickedSource.type === ref.type && this.pickedSource.index === ref.index) {
      this.pickedSource = null;
    } else {
      const src = this.getSlotByRef(this.pickedSource);
      const dst = this.getSlotByRef(ref);

      // Armor slot validation
      if (ref.type === 'armor' && src) {
        const def = ITEMS[src.id];
        if (!def || def.armorSlot !== ref.index) {
          this.toast('Cannot equip that here');
          this.pickedSource = null;
          this.renderInventoryModal();
          return;
        }
      }

      // If moving into craft grid and src has >1, place 1 item for easy crafting!
      if (ref.type === 'craft' && src && src.count > 1 && (!dst || dst.id === src.id)) {
        src.count -= 1;
        if (!dst) this.setSlotByRef(ref, { id: src.id, count: 1 });
        else dst.count += 1;
        if (src.count <= 0) this.setSlotByRef(this.pickedSource, null);
      } else if (src && dst && src.id === dst.id && (ITEMS[src.id].stackSize || 64) > 1) {
        // Merge stacks
        const max = ITEMS[src.id].stackSize || 64;
        const move = Math.min(max - dst.count, src.count);
        dst.count += move;
        src.count -= move;
        if (src.count <= 0) this.setSlotByRef(this.pickedSource, null);
        this.pickedSource = null;
      } else {
        // Swap
        this.setSlotByRef(ref, src);
        this.setSlotByRef(this.pickedSource, dst);
        this.pickedSource = null;
      }
    }
    this.renderInventoryModal();
    this.updateHotbar();
  }

  renderRecipeBook() {
    if (!this.game) return;
    const list = document.getElementById('recipe-list');
    list.innerHTML = '';

    const sorted = [...RECIPES]
      .filter((r) => !r.table || this.isCraftingTable)
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
        .map(([k, n]) => `${n}× ${k === 'any_planks' ? 'Planks' : (ITEMS[k]?.name || k)}`)
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
    cat.innerHTML = '';
    const q = query.trim().toLowerCase();
    for (const def of Object.values(ITEMS)) {
      if (q && !def.name.toLowerCase().includes(q) && !def.id.includes(q)) continue;
      const el = document.createElement('div');
      el.className = 'inv-slot';
      el.title = def.name;
      this.renderSlotContent(el, { id: def.id, count: 1 });
      el.addEventListener('click', () => {
        if (this.game) {
          this.game.inventory.addItem(def.id, def.stackSize || 64);
          this.sound.playPop();
          this.renderInventoryModal();
          this.updateHotbar();
          this.toast(`Added ${def.name}`);
        }
      });
      cat.appendChild(el);
    }
  }

  // --- FURNACE ---
  openFurnace(posKey) {
    this.activeFurnacePos = posKey;
    this.openModal('furnace-modal');
    this.renderFurnaceModal();
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
    flame.classList.toggle('lit', f.burnTime > 0);
    document.getElementById('furnace-fuel-bar').style.width = f.burnMax > 0 ? `${(f.burnTime / f.burnMax) * 100}%` : '0%';
    document.getElementById('furnace-cook-bar').style.width = `${(f.cookTime / 5.0) * 100}%`;

    inEl.onclick = () => {
      if (f.input && inv.addItem(f.input.id, f.input.count)) {
        f.input = null;
        this.renderFurnaceModal();
      }
    };
    fuelEl.onclick = () => {
      if (f.fuel && inv.addItem(f.fuel.id, f.fuel.count)) {
        f.fuel = null;
        this.renderFurnaceModal();
      }
    };
    outEl.onclick = () => {
      if (f.output && inv.addItem(f.output.id, f.output.count)) {
        f.output = null;
        this.sound.playPop();
        this.renderFurnaceModal();
      }
    };

    const grid = document.getElementById('furnace-player-inv');
    grid.innerHTML = '';
    for (let i = 0; i < 36; i++) {
      const el = document.createElement('div');
      el.className = 'inv-slot';
      this.renderSlotContent(el, inv.slots[i]);
      el.addEventListener('click', () => {
        const s = inv.slots[i];
        if (!s) return;
        if (SMELTING_RECIPES[s.id] && (!f.input || f.input.id === s.id)) {
          if (!f.input) f.input = { id: s.id, count: s.count };
          else f.input.count += s.count;
          inv.slots[i] = null;
        } else if (FUEL_VALUES[s.id] && (!f.fuel || f.fuel.id === s.id)) {
          if (!f.fuel) f.fuel = { id: s.id, count: s.count };
          else f.fuel.count += s.count;
          inv.slots[i] = null;
        } else {
          this.toast('Not smeltable or fuel');
        }
        this.renderFurnaceModal();
        this.updateHotbar();
      });
      grid.appendChild(el);
    }
  }

  // --- CHEST ---
  openChest(posKey) {
    this.activeChestPos = posKey;
    this.openModal('chest-modal');
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
      el.className = 'inv-slot';
      this.renderSlotContent(el, chest[i]);
      el.addEventListener('click', () => {
        if (chest[i] && inv.addItem(chest[i].id, chest[i].count)) {
          chest[i] = null;
          this.renderChestModal();
          this.updateHotbar();
        }
      });
      cGrid.appendChild(el);
    }

    const pGrid = document.getElementById('chest-player-inv');
    pGrid.innerHTML = '';
    for (let i = 0; i < 36; i++) {
      const el = document.createElement('div');
      el.className = 'inv-slot';
      this.renderSlotContent(el, inv.slots[i]);
      el.addEventListener('click', () => {
        const s = inv.slots[i];
        if (!s) return;
        const emptyIdx = chest.findIndex((c) => !c);
        if (emptyIdx !== -1) {
          chest[emptyIdx] = { ...s };
          inv.slots[i] = null;
          this.renderChestModal();
          this.updateHotbar();
        } else {
          this.toast('Chest is full');
        }
      });
      pGrid.appendChild(el);
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
            <span class="mod-icon">${m.icon}</span>
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
        <span style="color:#ffd54f;font-weight:900">➔</span>
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

  // --- LIVE MINI-MAP RADAR ---
  renderMinimap(player, world, entities) {
    const canvas = document.getElementById('minimap-canvas');
    if (!canvas || !this.game?.mods?.isEnabled('minimap')) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const half = w / 2;
    const scale = 2; // 1 cell = 2 world blocks (covers ~108 blocks across)
    const step = 4;  // draw 4x4 px blocks for ultra-fast iPad performance

    const biomeColors = {
      Plains: '#5da135',
      Forest: '#387526',
      'Birch Forest': '#66a83c',
      Desert: '#dfd09c',
      'Snowy Taiga': '#e4f0fa',
      Mountains: '#8a919c'
    };

    const px = Math.floor(player.pos.x);
    const pz = Math.floor(player.pos.z);

    for (let sy = 0; sy < h; sy += step) {
      for (let sx = 0; sx < w; sx += step) {
        const wx = px + (sx - half) * scale;
        const wz = pz + (sy - half) * scale;
        const b = world.getBiomeAt(wx, wz);
        ctx.fillStyle = biomeColors[b] || '#5da135';
        ctx.fillRect(sx, sy, step, step);
      }
    }

    // Draw nearby villages as gold stars ★
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

    const hintEl = document.getElementById('minimap-village-hint');
    if (hintEl) {
      hintEl.textContent = nearestVDist < 200 ? `Village ${Math.round(nearestVDist)}m` : world.getBiomeAt(px, pz);
    }

    // Draw nearby mobs
    for (const m of entities.mobs) {
      const mx = half + (m.pos.x - px) / scale;
      const my = half + (m.pos.z - pz) / scale;
      if (mx < 2 || mx > w - 2 || my < 2 || my > h - 2) continue;
      ctx.fillStyle = m.def.hostile ? '#ff4444' : (m.def.villager ? '#ffe066' : '#a8ff8a');
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
