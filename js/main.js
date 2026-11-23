import * as THREE from 'three';
import { BLOCK, ITEMS, KEY_TO_BLOCK, getBlockDef, isBlockSolid, isBedBlock, getBedInfo, getBedPairForYaw } from './blocks.js';
import { TextureManager } from './textures.js';
import { SoundManager } from './audio.js';
import { World } from './world.js';
import { SkySystem } from './sky.js';
import { EffectsManager } from './effects.js';
import { ModManager } from './mods.js';
import { SMELTING_RECIPES } from './recipes.js';
import { Inventory } from './inventory.js';
import { Player } from './player.js';
import { EntityManager } from './mobs.js';
import { ControlManager } from './controls.js';
import { UIManager } from './ui.js';
import { TitlePanorama } from './panorama.js';
import { loadSettings, saveSettings, listWorlds, loadWorld, saveWorld, deleteWorld, DEFAULT_KEYBINDS, isTouchDevice } from './storage.js';

class BlockCraftGame {
  constructor() {
    this.isTouch = isTouchDevice();
    this.settings = loadSettings();
    this.mods = new ModManager();
    this.sound = new SoundManager();
    this.sound.enabled = this.settings.sound;
    this.textures = new TextureManager();
    this.ui = new UIManager(this.textures, this.sound);

    // Three.js Renderer (10x GPU-tuned: smart DPR, skip redundant MSAA on HiDPI, throttled shadow updates!)
    this.container = document.getElementById('game-container');
    const rawDpr = window.devicePixelRatio || 1;
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isTouch && rawDpr <= 1.25,
      powerPreference: 'high-performance',
      stencil: false
    });
    const maxDpr = this.isTouch ? 1.25 : 1.5;
    this.renderer.setPixelRatio(Math.min(rawDpr, maxDpr));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = (this.settings.shaders || 'enhanced') === 'ultra';
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    // Live 3D Voxel Panorama for the Main Menu!
    this.titlePanorama = new TitlePanorama(this.textures);
    this._loadingWorld = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, window.innerWidth / window.innerHeight, 0.1, 700);

    this.controls = new ControlManager(this.renderer.domElement, this.sound);
    this.applySettings();
    this.ui.syncSettingsUI(this.settings);
    this.ui.bind(this);

    this.world = null;
    this.sky = null;
    this.effects = null;
    this.inventory = null;
    this.player = null;
    this.entities = null;
    this.worldMeta = null;
    this.running = false;
    this.currentTarget = null;
    this.lastTime = performance.now();
    // True wall-clock rolling FPS ring buffer (never skewed by physics dt clamp!)
    this._fpsRing = new Float64Array(32);
    this._fpsHead = 0;
    this._fpsCount = 0;
    this._fpsLastReport = performance.now();
    this._shadowFrame = 0;
    this.currentFps = 60;
    this.autosaveTimer = 0;
    this.furnaceUiTimer = 0;
    this.minimapTimer = 0;
    this._shakeTimer = 0;
    this._shakeIntensity = 0;
    this._attackCooldown = 0;
    this._holdAttackTimer = 0;
    this._eyeVec = new THREE.Vector3();
    this._dirVec = new THREE.Vector3();
    this._cachedBiome = 'Plains';
    this._cachedBiomeBx = 1e9;
    this._cachedBiomeBz = 1e9;
    this._emptyInput = {
      moveForward: 0, moveRight: 0, jump: false, sneak: false, sprint: false,
      breaking: false, lookDeltaX: 0, lookDeltaY: 0
    };

    this.bindControlActions();
    window.addEventListener('resize', () => this.onResize());

    // Register Service Worker for iPad PWA
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    this.refreshWorldList();
    requestAnimationFrame((t) => this.loop(t));
  }

  onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (this.titlePanorama) this.titlePanorama.resize(w, h);
  }

  applySettings() {
    this.sound.enabled = this.settings.sound;
    this.controls.sensitivity = this.settings.sensitivity;
    this.controls.setKeybinds(this.settings.keybinds);
    this.controls.setControlStyle(this.settings.controlStyle);
    this.controls.setShowTouch(this.settings.showTouch);

    // Toggleable Minecraft Classic UI Vibe & Large iPad UI Scale
    document.body.classList.toggle('mc-theme', this.settings.minecraftUI !== false);
    document.body.classList.toggle('large-ui', this.settings.largeUI !== false);

    // Camera FOV, near & far planes — supports up to 512-chunk Distant Horizons LOD (8,192 blocks!)
    // Slightly raising near plane above 160 chunks boosts 24-bit Z-buffer precision by 60% at 8 km with zero close clipping!
    this.camera.fov = this.settings.fov;
    this.camera.near = this.settings.renderDistance > 160 ? 0.16 : 0.1;
    this.camera.far = Math.max(3400, this.settings.renderDistance * 20 + 1400);
    this.camera.updateProjectionMatrix();
    if (this.player) this.player.baseFov = this.settings.fov;

    // Shaders & Cinematic ACES Filmic Tone Mapping (20x BSL vibrancy!)
    const sh = this.settings.shaders || 'ultra';
    this.renderer.shadowMap.enabled = sh === 'ultra';
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.toneMapping = sh === 'off' ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = sh === 'ultra' ? 1.12 : (sh === 'enhanced' ? 1.08 : 1.0);

    if (this.world) {
      this.world.renderDistance = this.settings.renderDistance;
      this.world.setShaderMode(sh);
    }
    if (this.sky) {
      this.sky.setRenderDistance(this.settings.renderDistance);
      this.sky.setShaderMode(sh);
      this.sky.biomeEffects = this.settings.biomeEffects !== false;
    }
    if (this.effects) {
      this.effects.setEnabled(this.settings.biomeEffects !== false);
    }
    if (this.ui && this.ui.syncCheatUI) {
      this.ui.syncCheatUI(this.areCheatsAllowed());
    }
  }

  areCheatsAllowed() {
    if (this.worldMeta && typeof this.worldMeta.allowCheats === 'boolean') {
      return this.worldMeta.allowCheats;
    }
    return Boolean(this.settings.allowCheats);
  }

  setAllowCheats(allowed) {
    const flag = Boolean(allowed);
    this.settings.allowCheats = flag;
    if (this.worldMeta) this.worldMeta.allowCheats = flag;
    saveSettings(this.settings);
    if (this.ui) {
      this.ui.syncCheatUI(flag);
      this.ui.toast(flag ? 'Cheats Enabled' : 'Cheats Disabled');
    }
  }

  updateKeybind(action, code) {
    if (!this.settings.keybinds) this.settings.keybinds = { ...DEFAULT_KEYBINDS };
    this.settings.keybinds[action] = code;
    saveSettings(this.settings);
    this.controls.setKeybinds(this.settings.keybinds);
    if (this.ui) this.ui.renderKeybindsUI(this.settings.keybinds);
  }

  resetKeybinds() {
    this.settings.keybinds = { ...DEFAULT_KEYBINDS };
    saveSettings(this.settings);
    this.controls.setKeybinds(this.settings.keybinds);
    if (this.ui) {
      this.ui.renderKeybindsUI(this.settings.keybinds);
      this.ui.toast('Keybinds reset to defaults');
    }
  }

  updateSetting(key, val) {
    if (key === 'allowCheats') {
      this.setAllowCheats(val);
      return;
    }
    this.settings[key] = val;
    saveSettings(this.settings);
    this.applySettings();
  }

  async refreshWorldList() {
    const worlds = await listWorlds();
    this.ui.renderSavedWorlds(worlds);
  }

  cleanupScene() {
    if (this.player && this.player.detachFromScene) this.player.detachFromScene(this.scene);
    while (this.camera.children.length > 0) {
      this.camera.remove(this.camera.children[0]);
    }
    if (this.world) this.world.dispose();
    if (this.entities) this.entities.clearAll();
    if (this.effects) this.effects.clear();
    while (this.scene.children.length > 0) {
      this.scene.remove(this.scene.children[0]);
    }
    this.world = null;
    this.sky = null;
    this.effects = null;
    this.entities = null;
    this.player = null;
  }

  async startNewWorld({ name, mode, worldType, seed, allowCheats = false, difficulty = 'normal', mobSpawnRate = 1.0, hungerRate = 1.0 }) {
    if (this._loadingWorld) return;
    this.sound.unlock();
    const id = 'w_' + Date.now();
    this.worldMeta = {
      id,
      name,
      mode,
      worldType,
      seed,
      allowCheats: Boolean(allowCheats),
      difficulty: ['peaceful', 'easy', 'normal', 'hard'].includes(difficulty) ? difficulty : 'normal',
      mobSpawnRate: typeof mobSpawnRate === 'number' && Number.isFinite(mobSpawnRate) ? mobSpawnRate : 1.0,
      hungerRate: typeof hungerRate === 'number' && Number.isFinite(hungerRate) ? hungerRate : 1.0
    };
    await this.initGameSession(this.worldMeta, null);
    await this.saveCurrentWorld(false);
  }

  async loadSavedWorld(id) {
    if (this._loadingWorld) return;
    this.sound.unlock();
    const data = await loadWorld(id);
    if (!data) {
      this.ui.toast('World not found');
      return;
    }
    this.worldMeta = {
      id: data.id,
      name: data.name,
      mode: data.mode || 'survival',
      worldType: data.worldType || 'infinite',
      seed: data.seed,
      allowCheats: data.allowCheats !== undefined ? Boolean(data.allowCheats) : Boolean(this.settings.allowCheats),
      difficulty: ['peaceful', 'easy', 'normal', 'hard'].includes(data.difficulty) ? data.difficulty : 'normal',
      mobSpawnRate: typeof data.mobSpawnRate === 'number' && Number.isFinite(data.mobSpawnRate) ? data.mobSpawnRate : 1.0,
      hungerRate: typeof data.hungerRate === 'number' && Number.isFinite(data.hungerRate) ? data.hungerRate : 1.0
    };
    await this.initGameSession(this.worldMeta, data);
  }

  getGameRules() {
    return {
      difficulty: this.worldMeta?.difficulty || 'normal',
      mobSpawnRate: typeof this.worldMeta?.mobSpawnRate === 'number' ? this.worldMeta.mobSpawnRate : 1.0,
      hungerRate: typeof this.worldMeta?.hungerRate === 'number' ? this.worldMeta.hungerRate : 1.0
    };
  }

  setDifficulty(val, silent = false) {
    const raw = String(val || '').toLowerCase().trim();
    const map = {
      peaceful: 'peaceful', p: 'peaceful', '0': 'peaceful',
      easy: 'easy', e: 'easy', '1': 'easy',
      normal: 'normal', n: 'normal', '2': 'normal',
      hard: 'hard', h: 'hard', '3': 'hard'
    };
    const next = map[raw];
    if (!next) return false;
    if (!this.worldMeta) this.worldMeta = {};
    this.worldMeta.difficulty = next;
    if (next === 'peaceful' && this.entities) {
      this.entities.despawnHostiles();
    }
    if (this.ui) {
      this.ui.syncWorldRulesUI(this.worldMeta);
      if (!silent) {
        const lbl = next.charAt(0).toUpperCase() + next.slice(1);
        this.ui.addChatMessage(`Difficulty set to ${lbl}`);
        this.ui.toast(`Difficulty: ${lbl}`);
      }
    }
    return true;
  }

  setMobSpawnRate(val, silent = false) {
    let rate = typeof val === 'number' ? val : NaN;
    if (Number.isNaN(rate)) {
      const raw = String(val || '').toLowerCase().trim();
      const map = { off: 0, none: 0, low: 0.5, normal: 1.0, default: 1.0, high: 1.8, swarm: 3.0, horde: 3.0, extreme: 4.0 };
      rate = raw in map ? map[raw] : parseFloat(raw);
    }
    if (!Number.isFinite(rate)) return false;
    rate = Math.max(0, Math.min(5, Math.round(rate * 100) / 100));
    if (!this.worldMeta) this.worldMeta = {};
    this.worldMeta.mobSpawnRate = rate;
    if (this.ui) {
      this.ui.syncWorldRulesUI(this.worldMeta);
      if (!silent) {
        this.ui.addChatMessage(`Mob spawn rate set to ${rate}×`);
        this.ui.toast(`Mob Spawn Rate: ${rate}×`);
      }
    }
    return true;
  }

  setHungerRate(val, silent = false) {
    let rate = typeof val === 'number' ? val : NaN;
    if (Number.isNaN(rate)) {
      const raw = String(val || '').toLowerCase().trim();
      const map = { off: 0, none: 0, slow: 0.5, normal: 1.0, default: 1.0, fast: 1.8, extreme: 3.0 };
      rate = raw in map ? map[raw] : parseFloat(raw);
    }
    if (!Number.isFinite(rate)) return false;
    rate = Math.max(0, Math.min(5, Math.round(rate * 100) / 100));
    if (!this.worldMeta) this.worldMeta = {};
    this.worldMeta.hungerRate = rate;
    if (this.ui) {
      this.ui.syncWorldRulesUI(this.worldMeta);
      if (!silent) {
        this.ui.addChatMessage(`Hunger drain speed set to ${rate}×`);
        this.ui.toast(`Hunger Speed: ${rate}×`);
      }
    }
    return true;
  }

  async deleteSavedWorld(id) {
    await deleteWorld(id);
    await this.refreshWorldList();
    this.ui.toast('World deleted');
  }

  async initGameSession(meta, saved) {
    this._loadingWorld = true;
    const yieldFrame = () => new Promise((r) => requestAnimationFrame(r));

    try {
      this.ui.showLoadingScreen(true, 0.06, 'Initializing world...', meta.name);
      await yieldFrame();

      this.cleanupScene();

      const shaderMode = this.settings.shaders || (this.isTouch ? 'enhanced' : 'ultra');
      this.world = new World(this.scene, this.textures, {
        seed: meta.seed,
        worldType: meta.worldType,
        renderDistance: this.settings.renderDistance,
        maxDetailRadius: this.isTouch ? 6 : 10,
        shaders: shaderMode
      });

      // Restore modified blocks & tile entities before preloading spawn chunks
      if (saved) {
        if (Array.isArray(saved.modifiedBlocks)) {
          for (const [k, v] of saved.modifiedBlocks) {
            this.world.modifiedBlocks.set(k, v);
            const [mx, my, mz] = k.split(',').map(Number);
            this.world.indexModifiedBlock(mx, my, mz, v);
          }
        }
        if (Array.isArray(saved.chests)) {
          for (const [k, v] of saved.chests) this.world.chests.set(k, v);
        }
        if (Array.isArray(saved.furnaces)) {
          for (const [k, v] of saved.furnaces) this.world.furnaces.set(k, v);
        }
      }

      this.sky = new SkySystem(this.scene);
      this.sky.setRenderDistance(this.settings.renderDistance);
      this.sky.setShaderMode(shaderMode);
      this.sky.biomeEffects = this.settings.biomeEffects !== false;
      if (saved && typeof saved.time === 'number') {
        this.sky.time = saved.time;
        this.sky.dayCount = saved.dayCount || 1;
      }

      this.effects = new EffectsManager(this.scene, this.textures);
      this.effects.setEnabled(this.settings.biomeEffects !== false);

      this.inventory = new Inventory();
      if (saved && saved.inventory) {
        this.inventory.deserialize(saved.inventory);
      } else {
        this.inventory.giveStarterKit(meta.mode);
      }

      this.player = new Player(this.camera, this.world, this.inventory, this.sound, this.textures);
      this.player.mode = meta.mode;
      this.player.attachToScene(this.scene);

      // Find guaranteed dry-land spawn for new worlds (never spawn underwater!)
      let startX = saved?.player?.x ?? 0.5;
      let startZ = saved?.player?.z ?? 0.5;
      if (!saved) {
        this.ui.showLoadingScreen(true, 0.14, 'Finding scenic dry-land spawn...', meta.name);
        await yieldFrame();
        const safe = this.world.findSafeSpawn(0.5, 0.5);
        startX = safe.x;
        startZ = safe.z;
      }

      // Smooth frame-sliced preload of 5x5 terrain + 3x3 meshes (zero browser freeze!)
      await this.world.preloadSpawnAsync(startX, startZ, (p, msg) => {
        this.ui.showLoadingScreen(true, 0.18 + p * 0.64, msg, meta.name);
      });

      if (saved && saved.player) {
        this.player.pos.set(saved.player.x, saved.player.y, saved.player.z);
        this.player.spawnPos.set(
          saved.player.sx ?? startX,
          saved.player.sy ?? this.world.getSurfaceY(startX, startZ),
          saved.player.sz ?? startZ
        );
        this.player.yaw = saved.player.yaw || 0;
        this.player.pitch = saved.player.pitch || 0;
        this.player.hp = saved.player.hp ?? 20;
        this.player.hunger = saved.player.hunger ?? 20;
        this.player.xp = saved.player.xp ?? 0;
        this.player.level = saved.player.level ?? 0;
      } else {
        const sy = this.world.getSurfaceY(startX, startZ);
        this.player.pos.set(startX, sy + 0.25, startZ);
        this.player.spawnPos.set(startX, sy + 0.25, startZ);
      }

      this.player.onDamage = () => this.ui.flashDamage();
      this.player.onDeath = (reason) => {
        this.controls.enabled = false;
        this.controls.resetInputs();
        if (!this.mods.isEnabled('keep_inventory')) {
          this.inventory.slots.fill(null);
          this.inventory.armor.fill(null);
          this.player.xp = 0;
          this.player.level = 0;
          this.ui.updateHotbar();
        }
        if (document.pointerLockElement) {
          try { document.exitPointerLock(); } catch {}
        }
        this.ui.showDeathScreen(reason);
      };
      this.player.onHudDirty = () => {
        this.ui.updateStats();
        this.ui.updateHotbar();
      };

      this.ui.showLoadingScreen(true, 0.88, 'Spawning wildlife...', meta.name);
      await yieldFrame();
      this.entities = new EntityManager(this.scene, this.world, this.sound, this.textures);
      this.entities.onPickup = () => {
        // Immediately refresh hotbar & any open container UI when collecting dropped blocks/items!
        this.ui.updateHotbar();
        if (this.ui.activeModal === 'inventory-modal') this.ui.renderInventoryModal();
        else if (this.ui.activeModal === 'crafting-modal') this.ui.renderCraftingModal();
        else if (this.ui.activeModal === 'chest-modal') this.ui.renderChestModal();
        else if (this.ui.activeModal === 'furnace-modal') this.ui.renderFurnaceModal();
      };
      this.entities.populateInitialWildlife(this.player.pos);

      // Warm shaders & first sky frame BEFORE revealing world (eliminates first-frame GPU stall!)
      this.ui.showLoadingScreen(true, 0.96, 'Warming graphics shaders...', meta.name);
      await yieldFrame();
      const startBiome = this.world.getBiomeAt(Math.floor(this.player.pos.x), Math.floor(this.player.pos.z));
      this._cachedBiome = startBiome;
      this._cachedBiomeBx = Math.floor(this.player.pos.x) >> 2;
      this._cachedBiomeBz = Math.floor(this.player.pos.z) >> 2;
      this.sky.update(0.016, this.player.pos, startBiome);
      this.world.updateShaders(0.016, this.sky);
      this.player.update(0.001, this._emptyInput, this.mods, this.getGameRules());
      this.renderer.compile(this.scene, this.camera);

      this.running = true;
      this.controls.enabled = true;
      this.controls.setFlyingState(this.player.flying);
      this.settings.allowCheats = Boolean(meta.allowCheats);
      this.ui.syncSettingsUI(this.settings);
      this.ui.syncWorldRulesUI(this.worldMeta);
      this.ui.syncCheatUI(this.areCheatsAllowed());
      this.ui.showTitleScreen(false);
      this.ui.updateHotbar();
      this.ui.updateStats(true);
      this.ui.updateFlyUI(this.player.mode === 'creative', this.player.flying);
      this.ui.updateEffectsHUD(this.player.statusEffects);
      this.ui.updateActionButtons(false, false);
      this.ui.showLoadingScreen(false);
      const diffLbl = (this.worldMeta.difficulty || 'normal').toUpperCase();
      this.ui.addChatMessage(`Welcome to ${meta.name}! (${meta.mode.toUpperCase()} • ${diffLbl}${meta.allowCheats ? ' • Cheats ON' : ''})`);
    } finally {
      this._loadingWorld = false;
      this.ui.showLoadingScreen(false);
    }
  }

  async saveCurrentWorld(showToast = false) {
    if (!this.running || !this.worldMeta || !this.world || !this.player) return;
    const record = {
      id: this.worldMeta.id,
      name: this.worldMeta.name,
      mode: this.player.mode,
      worldType: this.worldMeta.worldType,
      seed: this.worldMeta.seed,
      allowCheats: Boolean(this.worldMeta.allowCheats),
      difficulty: this.worldMeta.difficulty || 'normal',
      mobSpawnRate: typeof this.worldMeta.mobSpawnRate === 'number' ? this.worldMeta.mobSpawnRate : 1.0,
      hungerRate: typeof this.worldMeta.hungerRate === 'number' ? this.worldMeta.hungerRate : 1.0,
      time: this.sky.time,
      dayCount: this.sky.dayCount,
      player: {
        x: this.player.pos.x,
        y: this.player.pos.y,
        z: this.player.pos.z,
        sx: this.player.spawnPos.x,
        sy: this.player.spawnPos.y,
        sz: this.player.spawnPos.z,
        yaw: this.player.yaw,
        pitch: this.player.pitch,
        hp: this.player.hp,
        hunger: this.player.hunger,
        xp: this.player.xp,
        level: this.player.level
      },
      inventory: this.inventory.serialize(),
      modifiedBlocks: Array.from(this.world.modifiedBlocks.entries()),
      chests: Array.from(this.world.chests.entries()),
      furnaces: Array.from(this.world.furnaces.entries())
    };
    await saveWorld(record);
    if (showToast) this.ui.toast('World Saved!');
  }

  async quitToTitle() {
    await this.saveCurrentWorld(false);
    this.running = false;
    this.controls.enabled = false;
    this.controls.resetInputs();
    this.ui.closeModals();
    this.cleanupScene();
    this.ui.showTitleScreen(true);
    await this.refreshWorldList();
  }

  setGameMode(mode, bypassCheatCheck = false) {
    if (!this.player) return;
    if (!bypassCheatCheck && !this.areCheatsAllowed()) {
      this.ui.toast('Cheats are disabled! Enable Allow Cheats in Settings.');
      return false;
    }
    this.player.mode = mode;
    if (mode === 'survival') this.player.flying = false;
    else {
      this.player.hp = this.player.maxHp;
      this.player.hunger = this.player.maxHunger;
    }
    this.controls.setFlyingState(this.player.flying);
    this.ui.updateFlyUI(this.player.mode === 'creative', this.player.flying);
    this.ui.updateStats();
    this.ui.toast(`Switched to ${mode.toUpperCase()} mode`);
    return true;
  }

  toggleCamera() {
    if (!this.player) return;
    this.player.cameraMode = (this.player.cameraMode + 1) % 3;
    const labels = ['1st Person View', '3rd Person (Back)', '3rd Person (Front)'];
    this.ui.toast(labels[this.player.cameraMode]);
  }

  bindControlActions() {
    this.controls.onToggleFly = () => {
      if (!this.player) return;
      if (this.player.mode === 'creative') {
        this.player.flying = !this.player.flying;
        this.player.vel.y = 0;
        this.controls.setFlyingState(this.player.flying);
        this.ui.updateFlyUI(true, this.player.flying);
        this.ui.updateStats();
        this.ui.toast(this.player.flying ? 'Flying ON' : 'Flying OFF');
      }
    };

    this.controls.onHotbarSelect = (sel) => {
      if (!this.inventory) return;
      if (sel === 'next') this.inventory.selected = (this.inventory.selected + 1) % 9;
      else if (sel === 'prev') this.inventory.selected = (this.inventory.selected + 8) % 9;
      else this.inventory.selected = sel;
      this.ui.updateHotbar();
    };

    this.controls.onOpenInventory = () => this.ui.openInventory(false);
    this.controls.onOpenPause = () => this.ui.openPause();
    this.controls.onOpenChat = () => this.ui.openChat();
    this.controls.onToggleCamera = () => this.toggleCamera();

    this.controls.onTapAttack = () => {
      if (!this.running || !this.player || !this.entities) return;
      this.player.swingAnim = 1.0;
      const eye = this.player.getEyePosition(this._eyeVec);
      const dir = this.player.getLookDirection(this._dirVec);
      const mob = this.entities.raycastMob(eye, dir, 5.2);
      const blk = this.world ? this.world.raycast(eye, dir, 5.5) : null;
      const mobCloser = !!(mob && (!blk || mob._hitDist <= blk.dist + 0.35));
      if (mobCloser) {
        // Lock out block-breaking briefly so attacking mobs NEVER breaks blocks behind them!
        this._attackCooldown = 0.38;
        this._holdAttackTimer = 0.42;
        const held = this.inventory.getHeldDef();
        const dmg = held?.damage || 2;
        const hit = this.entities.hitMob(mob, dmg, dir, this.player);
        if (hit && this.player.mode === 'survival') {
          this.inventory.damageSelectedTool(1);
          this.ui.updateHotbar();
        }
      }
    };

    this.controls.onPlaceOrUse = (isRepeat = false) => {
      if (!this.running || !this.player || !this.world) return;
      if (!isRepeat) this.player.swingAnim = 1.0;

      // 0. Check if tapping USE on a Villager to trade! (Never repeat-open on hold)
      if (!isRepeat && this.entities) {
        const eye = this.player.getEyePosition();
        const dir = this.player.getLookDirection();
        const mob = this.entities.raycastMob(eye, dir, 4.5);
        if (mob && mob.type === 'villager') {
          this.ui.openTradeModal(mob);
          return;
        }
      }

      // 1. Check interactive block targeted (skip on hold-repeat)
      if (!isRepeat && this.currentTarget) {
        const { x, y, z, blockId } = this.currentTarget;
        const bdef = getBlockDef(blockId);
        if (bdef && bdef.interactive && !this.player.sneaking) {
          if (bdef.interactive === 'crafting_table') {
            this.ui.openInventory(true);
            return;
          }
          if (bdef.interactive === 'furnace') {
            const key = `${x},${y},${z}`;
            if (!this.world.furnaces.has(key)) {
              this.world.furnaces.set(key, { input: null, fuel: null, output: null, burnTime: 0, burnMax: 0, cookTime: 0 });
            }
            this.ui.openFurnace(key);
            return;
          }
          if (bdef.interactive === 'chest') {
            const key = `${x},${y},${z}`;
            if (!this.world.chests.has(key)) {
              this.world.chests.set(key, new Array(27).fill(null));
            }
            this.ui.openChest(key);
            return;
          }
          if (bdef.interactive === 'tnt') {
            this.igniteTnt(x, y, z, 2.6);
            return;
          }
          if (bdef.interactive === 'bed') {
            this.player.spawnPos.set(x + 0.5, y + 1.15, z + 0.5);
            const isEveningOrNight = this.sky.isNight() || this.sky.time < 0.255 || this.sky.time > 0.72;
            if (isEveningOrNight) {
              this.sky.time = 0.275;
              this.sky.dayCount++;
              this.player.hp = this.player.maxHp;
              this.ui.updateStats();
              if (this.ui.playSleepTransition) this.ui.playSleepTransition();
              this.ui.toast('Slept until morning • Respawn set!');
            } else {
              this.ui.toast('Respawn point set! (Sleep at dusk or night)');
            }
            return;
          }
        }
      }

      // 2. Eat food if holding food
      const heldDef = this.inventory.getHeldDef();
      if (!isRepeat && heldDef && heldDef.food) {
        if (this.player.mode === 'survival' && (this.player.hunger < this.player.maxHunger || this.player.hp < this.player.maxHp)) {
          this.player.hunger = Math.min(this.player.maxHunger, this.player.hunger + heldDef.food);
          this.player.hp = Math.min(this.player.maxHp, this.player.hp + Math.ceil(heldDef.food * 0.5));
          this.player.eatAnim = 1.0;
          this.inventory.consumeSelected(1);
          this.sound.playEat();
          this.ui.updateStats();
          this.ui.updateHotbar();
          return;
        }
      }

      // 3. Place block (with true 2-block-long × 1-block-wide Bed placement!)
      if (this.currentTarget && heldDef && heldDef.isBlock) {
        const px = this.currentTarget.x + this.currentTarget.nx;
        const py = this.currentTarget.y + this.currentTarget.ny;
        const pz = this.currentTarget.z + this.currentTarget.nz;

        // Avoid placing solid block inside player's own body
        const insidePlayer = (tx, ty, tz) => {
          const dx = Math.abs((tx + 0.5) - this.player.pos.x);
          const dz = Math.abs((tz + 0.5) - this.player.pos.z);
          const insideY = ty >= Math.floor(this.player.pos.y) && ty <= Math.floor(this.player.pos.y + 1.65);
          return dx < 0.78 && dz < 0.78 && insideY;
        };

        if (heldDef.blockId === BLOCK.BED) {
          if (isRepeat) return;
          const pair = getBedPairForYaw(this.player.yaw);
          const hx = px + pair.dx;
          const hz = pz + pair.dz;
          const curFoot = this.world.getBlock(px, py, pz);
          const curHead = this.world.getBlock(hx, py, hz);
          if (isBlockSolid(curFoot) || isBlockSolid(curHead) || insidePlayer(px, py, pz) || insidePlayer(hx, py, hz)) {
            this.ui.toast('Need 2 clear blocks of space to place a Bed!');
            return;
          }
          this.world.setBlock(px, py, pz, pair.foot, true);
          this.world.setBlock(hx, py, hz, pair.head, true);
          this.sound.playBlock(heldDef.sound, true);
          if (this.player.mode === 'survival') {
            this.inventory.consumeSelected(1);
            this.ui.updateHotbar();
          }
          return;
        }

        if (heldDef.solid && insidePlayer(px, py, pz)) return;

        if (isRepeat) this.player.swingAnim = 1.0;
        this.world.setBlock(px, py, pz, heldDef.blockId, true);
        this.sound.playBlock(heldDef.sound, true);
        if (this.player.mode === 'survival') {
          this.inventory.consumeSelected(1);
          this.ui.updateHotbar();
        }
      }
    };
  }

  igniteTnt(x, y, z, fuse = 2.6, vx = null, vy = null, vz = null) {
    this.world.setBlock(x, y, z, BLOCK.AIR, true);
    if (this.sound.playFuse) this.sound.playFuse();
    if (this.effects && this.effects.spawnPrimedTnt) {
      this.effects.spawnPrimedTnt(x + 0.5, y + 0.5, z + 0.5, fuse, vx, vy, vz);
    } else {
      this.triggerExplosion(x + 0.5, y + 0.5, z + 0.5, 4.5);
    }
  }

  triggerExplosion(x, y, z, radius = 4.5) {
    this.sound.playExplosion();
    if (this.effects && this.effects.spawnExplosion) {
      this.effects.spawnExplosion(x, y, z, radius);
    }

    const res = this.world.explode(x, y, z, radius);
    const broken = res.broken || [];
    const chainTnt = res.chainTnt || [];

    // Launch nearby TNT blocks as flying chain-reaction Primed TNT!
    for (const ct of chainTnt) {
      const dx = ct.x - x;
      const dy = ct.y - y;
      const dz = ct.z - z;
      const d = Math.max(0.5, Math.hypot(dx, dy, dz));
      const launchSpd = 4.5 + Math.random() * 4.0;
      const chainFuse = 0.45 + Math.random() * 0.55;
      if (this.sound.playFuse) this.sound.playFuse();
      if (this.effects && this.effects.spawnPrimedTnt) {
        this.effects.spawnPrimedTnt(
          ct.x, ct.y, ct.z, chainFuse,
          (dx / d) * launchSpd,
          3.8 + Math.random() * 3.5,
          (dz / d) * launchSpd
        );
      }
    }

    // Spawn flying block debris & item drops from crater
    let debrisBudget = 16;
    for (const b of broken) {
      const def = getBlockDef(b.id);
      if (this.effects && debrisBudget > 0 && Math.random() < 0.28) {
        this.effects.spawnBlockBreak(b.x, b.y, b.z, def);
        debrisBudget--;
      }
      if (Math.random() < 0.25 && def && def.drop) {
        this.entities.spawnDrop(def.drop, 1, b.x + 0.5, b.y + 0.5, b.z + 0.5);
      }
    }

    // Real entity blast damage & dramatic launch knockback on nearby mobs!
    if (this.entities && this.entities.applyExplosion) {
      this.entities.applyExplosion(x, y, z, radius, this.player);
    }

    // Player blast damage, knockback & explosion camera shake!
    const dxp = this.player.pos.x - x;
    const dyp = (this.player.pos.y + 0.9) - y;
    const dzp = this.player.pos.z - z;
    const dist = Math.hypot(dxp, dyp, dzp);
    if (dist < radius + 14) {
      const shakePower = Math.max(0.04, (1 - dist / (radius + 14)) * 0.32);
      this._shakeTimer = Math.max(this._shakeTimer, 0.36);
      this._shakeIntensity = Math.max(this._shakeIntensity, shakePower);
    }
    if (dist < radius + 3.5 && dist > 0.001) {
      const falloff = 1 - dist / (radius + 3.5);
      this.player.vel.x += (dxp / dist) * falloff * 12;
      this.player.vel.z += (dzp / dist) * falloff * 12;
      this.player.vel.y = Math.max(this.player.vel.y, 4.5 + falloff * 7.5);
      const dmg = Math.floor(falloff * 16);
      if (dmg > 0) this.player.takeDamage(dmg, 'Blew up');
    }
  }

  handleChatCommand(text) {
    if (!text.startsWith('/')) {
      this.ui.addChatMessage(`Player: ${text}`);
      return true;
    }
    const parts = text.slice(1).trim().split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase();

    if (cmd === 'help') {
      const status = this.areCheatsAllowed() ? 'ON' : 'OFF (enable in Settings)';
      this.ui.addChatMessage(`Cheats: ${status} | /difficulty <peaceful|easy|normal|hard>, /mobrate <off|low|normal|high|swarm|0-5>, /hungerrate <off|slow|normal|fast|extreme|0-5>, /give <item> [n], /effect <speed|jump|regen|nightvision|clear> [sec], /time set <day|night>, /weather <clear|rain>, /gamemode <c|s>, /heal, /tp x y z`);
      return true;
    }

    if (cmd === 'difficulty' || cmd === 'diff') {
      if (!parts[1]) {
        const cur = (this.worldMeta?.difficulty || 'normal').toUpperCase();
        this.ui.addChatMessage(`Current difficulty: ${cur} (Usage: /difficulty peaceful|easy|normal|hard)`);
        return true;
      }
      if (!this.setDifficulty(parts[1])) {
        this.ui.addChatMessage('Usage: /difficulty peaceful|easy|normal|hard');
        return false;
      }
      return true;
    }
    if (cmd === 'mobrate' || cmd === 'spawnrate' || cmd === 'mobspawnrate') {
      if (!parts[1]) {
        const cur = this.worldMeta?.mobSpawnRate ?? 1.0;
        this.ui.addChatMessage(`Current mob spawn rate: ${cur}× (Usage: /mobrate off|low|normal|high|swarm or 0..5)`);
        return true;
      }
      if (!this.setMobSpawnRate(parts[1])) {
        this.ui.addChatMessage('Usage: /mobrate off|low|normal|high|swarm (or a number 0 to 5)');
        return false;
      }
      return true;
    }
    if (cmd === 'hungerrate' || cmd === 'hunger' || cmd === 'hungerspeed') {
      if (!parts[1]) {
        const cur = this.worldMeta?.hungerRate ?? 1.0;
        this.ui.addChatMessage(`Current hunger drain speed: ${cur}× (Usage: /hungerrate off|slow|normal|fast|extreme or 0..5)`);
        return true;
      }
      if (!this.setHungerRate(parts[1])) {
        this.ui.addChatMessage('Usage: /hungerrate off|slow|normal|fast|extreme (or a number 0 to 5)');
        return false;
      }
      return true;
    }

    const CHEAT_CMDS = new Set(['time', 'gamemode', 'gm', 'weather', 'heal', 'give', 'tp', 'effect']);
    if (CHEAT_CMDS.has(cmd) && !this.areCheatsAllowed()) {
      this.ui.addChatMessage('Cheats are disabled! Enable "Allow Cheats" in Settings to use commands.');
      this.ui.toast('Cheats disabled — enable in Settings');
      return false;
    }

    if (cmd === 'time' && parts[1] === 'set') {
      const v = parts[2]?.toLowerCase();
      if (v === 'day' || v === 'morning') this.sky.time = 0.31;
      else if (v === 'sunrise' || v === 'dawn') this.sky.time = 0.262;
      else if (v === 'noon') this.sky.time = 0.5;
      else if (v === 'sunset' || v === 'golden' || v === 'dusk') this.sky.time = 0.738;
      else if (v === 'night' || v === 'midnight') this.sky.time = 0.02;
      else if (v && !Number.isNaN(parseFloat(v))) {
        const num = parseFloat(v);
        this.sky.time = num > 1 ? ((num % 24000) / 24000) : Math.max(0, Math.min(0.999, num));
      } else {
        this.ui.addChatMessage('Usage: /time set sunrise|day|noon|sunset|night');
        return false;
      }
      this.ui.addChatMessage(`Set time to ${v}`);
      return true;
    } else if (cmd === 'gamemode' || cmd === 'gm') {
      const m = parts[1]?.toLowerCase();
      if (m === 'creative' || m === 'c' || m === '1') this.setGameMode('creative', true);
      else if (m === 'survival' || m === 's' || m === '0') this.setGameMode('survival', true);
      else this.ui.addChatMessage('Usage: /gamemode creative|survival');
      return true;
    } else if (cmd === 'weather') {
      const w = parts[1]?.toLowerCase();
      if (w === 'rain' || w === 'clear') {
        this.sky.weather = w;
        this.ui.addChatMessage(`Weather set to ${w}`);
      } else {
        this.ui.addChatMessage('Usage: /weather clear|rain');
      }
      return true;
    } else if (cmd === 'heal') {
      this.player.hp = this.player.maxHp;
      this.player.hunger = this.player.maxHunger;
      this.ui.updateStats();
      this.ui.addChatMessage('Healed to full health & hunger');
      return true;
    } else if (cmd === 'give' && parts[1]) {
      const item = parts[1].toLowerCase();
      const count = Math.max(1, Math.min(64, parseInt(parts[2] || '1', 10) || 1));
      if (ITEMS[item]) {
        this.inventory.addItem(item, count);
        this.ui.updateHotbar();
        this.ui.addChatMessage(`Gave ${count}× ${ITEMS[item].name}`);
      } else {
        this.ui.addChatMessage(`Unknown item: ${item}`);
      }
      return true;
    } else if (cmd === 'effect' && parts[1]) {
      const raw = parts[1].toLowerCase();
      const aliases = {
        speed: 'speed', swiftness: 'speed',
        jump: 'jump', jumpboost: 'jump', jump_boost: 'jump',
        regen: 'regen', regeneration: 'regen',
        nightvision: 'nightvision', night_vision: 'nightvision', nv: 'nightvision'
      };
      if (raw === 'clear') {
        this.player.clearEffects();
        this.ui.updateEffectsHUD(this.player.statusEffects);
        this.ui.addChatMessage('Cleared all active effects');
        return true;
      }
      const eff = aliases[raw];
      if (!eff) {
        this.ui.addChatMessage('Usage: /effect speed|jump|regen|nightvision|clear [seconds]');
        return false;
      }
      const sec = Math.max(5, Math.min(600, parseInt(parts[2] || '60', 10) || 60));
      this.player.applyEffect(eff, sec);
      this.ui.updateEffectsHUD(this.player.statusEffects);
      const labels = { speed: 'Speed', jump: 'Jump Boost', regen: 'Regeneration', nightvision: 'Night Vision' };
      this.ui.addChatMessage(`Applied ${labels[eff]} for ${sec}s`);
      this.ui.toast(`${labels[eff]} (${sec}s)`);
      return true;
    } else if (cmd === 'tp' && parts.length >= 4) {
      const x = parseFloat(parts[1]);
      const y = parseFloat(parts[2]);
      const z = parseFloat(parts[3]);
      if (!Number.isNaN(x) && !Number.isNaN(y) && !Number.isNaN(z)) {
        this.player.pos.set(x, y, z);
        this.player.vel.set(0, 0, 0);
        this.ui.addChatMessage(`Teleported to ${x}, ${y}, ${z}`);
      }
      return true;
    } else {
      this.ui.addChatMessage('Commands: /difficulty <peaceful|easy|normal|hard>, /mobrate <off|low|normal|high|swarm|0-5>, /hungerrate <off|slow|normal|fast|extreme|0-5>, /give <item> [n], /effect <speed|jump|regen|nightvision|clear> [sec], /time set day|night, /gamemode creative|survival, /weather rain|clear, /tp x y z, /heal');
      return false;
    }
  }

  breakBlockWithMods(x, y, z, blockId) {
    const def = getBlockDef(blockId);
    if (!def || (def.hardness < 0 && this.player.mode !== 'creative')) return;

    // If breaking either half of a 2-block-long bed, also clear its linked partner half!
    if (isBedBlock(blockId)) {
      const info = getBedInfo(blockId);
      if (info) {
        const px = x + info.dx;
        const pz = z + info.dz;
        if (this.world.getBlock(px, y, pz) === info.partner) {
          this.world.setBlock(px, y, pz, BLOCK.AIR, true);
        }
      }
    }

    const LOG_IDS = [BLOCK.OAK_LOG, BLOCK.BIRCH_LOG, BLOCK.SPRUCE_LOG];
    const ORE_IDS = [BLOCK.COAL_ORE, BLOCK.IRON_ORE, BLOCK.GOLD_ORE, BLOCK.DIAMOND_ORE];

    const toBreak = [[x, y, z]];
    const visited = new Set([`${x},${y},${z}`]);

    // TreeCapitator Mod: chain-chop connected logs above
    if (this.mods.isEnabled('treecapitator') && LOG_IDS.includes(blockId)) {
      const queue = [[x, y, z]];
      while (queue.length > 0 && toBreak.length < 24) {
        const [cx, cy, cz] = queue.shift();
        for (let dy = 0; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx, ny = cy + dy, nz = cz + dz;
              const k = `${nx},${ny},${nz}`;
              if (!visited.has(k) && this.world.getBlock(nx, ny, nz) === blockId) {
                visited.add(k);
                toBreak.push([nx, ny, nz]);
                queue.push([nx, ny, nz]);
              }
            }
          }
        }
      }
    }

    // VeinMiner Mod: chain-mine connected ore veins
    if (this.mods.isEnabled('veinminer') && ORE_IDS.includes(blockId)) {
      const queue = [[x, y, z]];
      while (queue.length > 0 && toBreak.length < 16) {
        const [cx, cy, cz] = queue.shift();
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx, ny = cy + dy, nz = cz + dz;
              const k = `${nx},${ny},${nz}`;
              if (!visited.has(k) && this.world.getBlock(nx, ny, nz) === blockId) {
                visited.add(k);
                toBreak.push([nx, ny, nz]);
                queue.push([nx, ny, nz]);
              }
            }
          }
        }
      }
    }

    const autoSmelt = this.mods.isEnabled('auto_smelt');
    for (const [bx, by, bz] of toBreak) {
      this.world.setBlock(bx, by, bz, BLOCK.AIR, true);
      if (this.effects && toBreak.length <= 6) {
        this.effects.spawnBlockBreak(bx, by, bz, def);
      }
      if (this.player.mode === 'survival' && this.player.canHarvest(def) && def.drop) {
        const chance = def.dropChance !== undefined ? def.dropChance : 1.0;
        if (Math.random() <= chance) {
          let dropId = def.drop;
          if (autoSmelt && SMELTING_RECIPES[dropId]) dropId = SMELTING_RECIPES[dropId];
          const cnt = def.dropCount || 1;
          if (autoSmelt) {
            this.inventory.addItem(dropId, cnt);
          } else {
            this.entities.spawnDrop(dropId, cnt, bx + 0.5, by + 0.4, bz + 0.5);
          }
        }
        if (def.xp) this.player.addXP(def.xp);
      }
    }
    this.sound.playBlock(def.sound, false);
    if (this.player.mode === 'survival') {
      this.inventory.damageSelectedTool(1);
      this.ui.updateHotbar();
    }
  }

  updateMining(dt, breaking) {
    if (!breaking || !this.currentTarget || !this.controls.enabled) {
      this.player.miningTarget = null;
      this.player.miningProgress = 0;
      this.player.updateCrackOverlay(null, 0);
      this.ui.updateMiningRing(0);
      return;
    }

    const { x, y, z, nx, ny, nz, blockId } = this.currentTarget;
    const key = `${x},${y},${z}`;
    const def = getBlockDef(blockId);
    if (!def || (def.hardness < 0 && this.player.mode !== 'creative')) {
      this.player.updateCrackOverlay(null, 0);
      this.ui.updateMiningRing(0);
      return;
    }

    if (this.player.miningTarget !== key) {
      this.player.miningTarget = key;
      this.player.miningProgress = 0;
      this._chipTimer = 0;
    }

    if (this.player.swingAnim <= 0.1) this.player.swingAnim = 1.0;

    const speed = this.player.getMiningSpeed(def);
    this.player.miningProgress += speed * dt;
    const prog = Math.min(1, this.player.miningProgress);
    this.player.updateCrackOverlay(this.currentTarget, prog);
    this.ui.updateMiningRing(prog);

    // Spray crisp pixel-art mining chips from the block face while cracking!
    this._chipTimer = (this._chipTimer || 0) + dt;
    if (this._chipTimer >= 0.13) {
      this._chipTimer = 0;
      if (this.effects) this.effects.spawnMiningChip(x, y, z, nx, ny, nz, def);
    }

    if (this.player.miningProgress >= 1.0) {
      this.player.miningProgress = 0;
      this.player.miningTarget = null;
      this.player.updateCrackOverlay(null, 0);
      this.ui.updateMiningRing(0);
      this.breakBlockWithMods(x, y, z, blockId);
    }
  }

  loop(now) {
    requestAnimationFrame((t) => this.loop(t));
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    // True wall-clock rolling FPS counter (accurate from 1 FPS to 240+ FPS, zero dt-clamp bias!)
    const ring = this._fpsRing;
    const ringLen = ring.length;
    ring[this._fpsHead] = now;
    this._fpsHead = (this._fpsHead + 1) % ringLen;
    if (this._fpsCount < ringLen) this._fpsCount++;
    if (now - this._fpsLastReport >= 200 && this._fpsCount >= 2) {
      const oldestIdx = this._fpsCount < ringLen ? 0 : this._fpsHead;
      const elapsedMs = now - ring[oldestIdx];
      if (elapsedMs > 0) {
        this.currentFps = Math.round(((this._fpsCount - 1) * 1000) / elapsedMs);
      }
      this._fpsLastReport = now;
    }

    if (this.running && this.world && this.player) {
      const input = this.controls.enabled ? this.controls.poll() : this._emptyInput;
      const gameRules = this.getGameRules();

      this.player.update(dt, input, this.mods, gameRules);
      this.ui.setUnderwater(this.player.headInWater);

      // Raycast targeted block & Villager / Wildlife (zero Vector3 allocations!)
      const eye = this.player.getEyePosition(this._eyeVec);
      const dir = this.player.getLookDirection(this._dirVec);
      const lookMob = this.entities.raycastMob(eye, dir, 5.2);
      this.currentTarget = this.world.raycast(eye, dir, 5.5);

      const mobHit = !!(lookMob && (!this.currentTarget || (lookMob._hitDist ?? lookMob.pos.distanceTo(eye)) <= this.currentTarget.dist + 0.35));
      const targetDef = this.currentTarget ? getBlockDef(this.currentTarget.blockId) : null;

      // Dynamic context-aware buttons:
      // - PLACE -> USE when hovering Villager or interactive block (Crafting Table, Furnace, Chest, Bed, TNT)
      // - MINE -> DAMAGE when hovering over any animal/mob!
      const isVillagerHover = !!(mobHit && lookMob.type === 'villager');
      const isInteractiveBlock = !!(targetDef && targetDef.interactive && !this.player.sneaking);
      const useMode = isVillagerHover || (!mobHit && isInteractiveBlock);
      const damageMode = mobHit;
      this.ui.updateActionButtons(useMode, damageMode);

      if (isVillagerHover) {
        this.player.highlightMesh.visible = false;
        this.ui.updateTargetTooltip(`${lookMob.profession || 'Villager'} — Tap USE to Trade`);
      } else if (mobHit) {
        this.player.highlightMesh.visible = false;
        this.ui.updateTargetTooltip(lookMob.label || lookMob.def.label || lookMob.type);
      } else if (this.currentTarget) {
        this.player.highlightMesh.visible = true;
        this.player.highlightMesh.position.set(
          this.currentTarget.x + 0.5,
          this.currentTarget.y + 0.5,
          this.currentTarget.z + 0.5
        );
        this.ui.updateTargetTooltip(targetDef ? targetDef.name : '');
      } else {
        this.player.highlightMesh.visible = false;
        this.ui.updateTargetTooltip('');
      }

      // Prevent attacking animals/mobs from EVER breaking blocks behind them (Creative & Survival!)
      if (this._attackCooldown > 0) this._attackCooldown = Math.max(0, this._attackCooldown - dt);
      if (this._holdAttackTimer > 0) this._holdAttackTimer = Math.max(0, this._holdAttackTimer - dt);

      if (mobHit) {
        // Never mine blocks while aiming at a mob; allow rhythmic attacks while holding DAMAGE
        this.updateMining(dt, false);
        if (input.breaking && this._holdAttackTimer <= 0) {
          this._holdAttackTimer = 0.42;
          this._attackCooldown = 0.38;
          this.player.swingAnim = 1.0;
          const held = this.inventory.getHeldDef();
          const dmg = held?.damage || 2;
          const didHit = this.entities.hitMob(lookMob, dmg, dir, this.player);
          if (didHit && this.player.mode === 'survival') {
            this.inventory.damageSelectedTool(1);
            this.ui.updateHotbar();
          }
        }
      } else {
        this.updateMining(dt, input.breaking && this._attackCooldown <= 0);
      }
      const maxBuilds = this.isTouch ? 1 : (this.settings.renderDistance > 8 ? 3 : 2);
      const chunkBudgetMs = this.isTouch ? 3.5 : 4.2;
      this.world.updateChunksAround(this.player.pos.x, this.player.pos.z, maxBuilds, chunkBudgetMs, dir.x, dir.z);
      this.world.updateFurnaces(dt);

      // Cache biome lookup per 4x4 block cell (eliminates 120x/sec Simplex noise!)
      const bx4 = Math.floor(this.player.pos.x) >> 2;
      const bz4 = Math.floor(this.player.pos.z) >> 2;
      if (bx4 !== this._cachedBiomeBx || bz4 !== this._cachedBiomeBz) {
        this._cachedBiomeBx = bx4;
        this._cachedBiomeBz = bz4;
        this._cachedBiome = this.world.getBiomeAt(bx4 << 2, bz4 << 2);
      }
      const curBiome = this._cachedBiome;

      this.sky.update(dt, this.player.pos, curBiome);
      // Night Vision potion/cheat effect brightens night & caves cleanly
      if (this.player.statusEffects.nightvision > 0) {
        this.sky.hemiLight.intensity = Math.max(this.sky.hemiLight.intensity, 1.38);
        this.sky.fillLight.intensity = Math.max(this.sky.fillLight.intensity, 0.52);
      }
      this.world.updateShaders(dt, this.sky);
      if (this.world.updateTorchLights) {
        this.world.updateTorchLights(dt, this.player.pos, this.sky);
      }
      if (this.effects) {
        this.effects.updatePrimedTnts(dt, this.world, (ex, ey, ez) => this.triggerExplosion(ex, ey, ez, 4.5));
        this.effects.update(dt, this.player.pos, curBiome, this.sky.isNight());
      }
      this.entities.update(dt, this.player, this.sky, (ex, ey, ez, r) => this.triggerExplosion(ex, ey, ez, r), this.mods, gameRules);

      // Brief tactile camera shake during nearby TNT / Creeper blasts!
      if (this._shakeTimer > 0) {
        this._shakeTimer = Math.max(0, this._shakeTimer - dt);
        const s = this._shakeIntensity * (this._shakeTimer / 0.36);
        this.camera.position.x += (Math.random() - 0.5) * s;
        this.camera.position.y += (Math.random() - 0.5) * s;
        this.camera.position.z += (Math.random() - 0.5) * s;
        if (this._shakeTimer <= 0) this._shakeIntensity = 0;
      }

      this.ui.updateTopHUD(this.player, curBiome, this.sky, this.currentFps);
      this.ui.updateEffectsHUD(this.player.statusEffects);
      this.minimapTimer += dt;
      if (this.minimapTimer >= 0.16) {
        this.minimapTimer = 0;
        this.ui.renderMinimap(this.player, this.world, this.entities, curBiome);
      }
      if (this.player.headInWater || this.player.air < this.player.maxAir) {
        this.ui.updateStats();
      }

      // Live-update furnace UI if open
      if (this.ui.activeModal === 'furnace-modal') {
        this.furnaceUiTimer += dt;
        if (this.furnaceUiTimer >= 0.15) {
          this.furnaceUiTimer = 0;
          this.ui.renderFurnaceModal();
        }
      }

      // Auto-save every 45 seconds
      this.autosaveTimer += dt;
      if (this.autosaveTimer >= 45) {
        this.autosaveTimer = 0;
        this.saveCurrentWorld(false);
      }

      // Throttled shadow map refresh (cuts shadow-pass GPU cost by 75% while keeping crisp moving shadows!)
      if (this.renderer.shadowMap.enabled) {
        this._shadowFrame++;
        if (this.world._shadowNeedsUpdate || (this._shadowFrame & 3) === 0) {
          this.renderer.shadowMap.needsUpdate = true;
          this.world._shadowNeedsUpdate = false;
        }
      }

      this.renderer.render(this.scene, this.camera);
    } else if (this.titlePanorama && !this._loadingWorld) {
      // Silky 60 FPS Live 3D Voxel Panorama on the Main Menu!
      this.titlePanorama.update(dt);
      this.titlePanorama.render(this.renderer);
    }
  }
}

window.blockcraft = new BlockCraftGame();
