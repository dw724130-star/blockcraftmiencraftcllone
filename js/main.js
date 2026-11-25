import * as THREE from 'three';
import { BLOCK, ITEMS, KEY_TO_BLOCK, getBlockDef, isBlockSolid, isBedBlock, getBedInfo, getBedPairForYaw, isWheatBlock, isFarmlandBlock } from './blocks.js';
import { TextureManager } from './textures.js';
import { SoundManager } from './audio.js';
import { World } from './world.js';
import { SkySystem } from './sky.js';
import { PostFXPipeline } from './postfx.js';
import { EffectsManager } from './effects.js';
import { ModManager } from './mods.js';
import { SMELTING_RECIPES, AUTO_SMELT_ORES } from './recipes.js';
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

    // Bind Main Menu UI, live 3D panorama & saved settings IMMEDIATELY so the title screen paints fully on Frame 0!
    this.controls = new ControlManager(this.renderer.domElement, this.sound);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, window.innerWidth / window.innerHeight, 0.1, 700);
    this.postfx = null;
    this._loadingWorld = false;

    this.applySettings();
    this.ui.syncSettingsUI(this.settings);
    this.ui.bind(this);
    this.titlePanorama = new TitlePanorama(this.textures);
    this.titlePanorama.render(this.renderer);

    // Defer PostFX shader targets & gameplay crack textures to the next frame so the menu is instant!
    requestAnimationFrame(() => {
      if (!this.postfx) {
        this.postfx = new PostFXPipeline(this.renderer, this.isTouch);
        this.postfx.setQuality(this.settings.shaders || 'ultra');
      }
      this.textures.ensureGameplayTextures();
    });

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
    this._eatChewTimer = 0;
    this._eatCooldown = 0;
    this._eatSlot = -1;
    this._lastFullToast = 0;
    this._eyeVec = new THREE.Vector3();
    this._dirVec = new THREE.Vector3();
    this._cachedBiome = 'Plains';
    this._cachedBiomeBx = 1e9;
    this._cachedBiomeBz = 1e9;
    this._emptyInput = {
      moveForward: 0, moveRight: 0, jump: false, sneak: false, sprint: false,
      breaking: false, using: false, lookDeltaX: 0, lookDeltaY: 0
    };

    this.bindControlActions();
    this._lastViewW = 0;
    this._lastViewH = 0;
    this._lastDpr = 0;
    this._resumeResizeTimers = [];
    const scheduleResumeResize = () => {
      this.onResize();
      for (const tid of this._resumeResizeTimers) clearTimeout(tid);
      this._resumeResizeTimers = [
        setTimeout(() => this.onResize(), 120),
        setTimeout(() => this.onResize(), 320),
        setTimeout(() => this.onResize(), 650)
      ];
    };
    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('orientationchange', scheduleResumeResize);
    window.addEventListener('pageshow', scheduleResumeResize);
    window.addEventListener('focus', scheduleResumeResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => this.onResize());
    }
    // Ensure settings & world changes are NEVER lost on reload or tab close, and fix iPad PWA resume aspect ratio!
    window.addEventListener('pagehide', () => {
      saveSettings(this.settings);
      if (this.running) this.saveCurrentWorld(false);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        saveSettings(this.settings);
        if (this.running) this.saveCurrentWorld(false);
      } else if (document.visibilityState === 'visible') {
        scheduleResumeResize();
      }
    });
    this.onResize();

    // Register Service Worker for iPad PWA
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    this.refreshWorldList();
    requestAnimationFrame((t) => this.loop(t));
  }

  onResize() {
    const vv = window.visualViewport;
    const w = Math.max(1, Math.round(
      (this.container && this.container.clientWidth) || (vv && vv.width) || window.innerWidth
    ));
    const h = Math.max(1, Math.round(
      (this.container && this.container.clientHeight) || (vv && vv.height) || window.innerHeight
    ));
    const rawDpr = window.devicePixelRatio || 1;
    const maxDpr = this.isTouch
      ? (this.settings.renderDistance > 256 ? 1.1 : 1.25)
      : 1.5;
    const dpr = Math.min(rawDpr, maxDpr);

    this._lastViewW = w;
    this._lastViewH = h;
    this._lastDpr = dpr;

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    if (this.renderer.domElement) {
      this.renderer.domElement.style.width = `${w}px`;
      this.renderer.domElement.style.height = `${h}px`;
    }
    if (this.postfx) {
      const db = new THREE.Vector2();
      this.renderer.getDrawingBufferSize(db);
      if (db.x > 0 && db.y > 0) this.postfx.resize(db.x, db.y);
    }
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

    // Camera FOV, near & far planes — supports up to 1024-chunk Distant Horizons LOD (16,384 blocks!)
    // Slightly raising near plane above 160/512 chunks preserves crisp 24-bit Z-buffer precision out to 16.4 km!
    this.camera.fov = this.settings.fov;
    this.camera.near = this.settings.renderDistance > 512 ? 0.24 : (this.settings.renderDistance > 160 ? 0.16 : 0.1);
    this.camera.far = Math.max(3400, this.settings.renderDistance * 20 + 2000);
    this.camera.updateProjectionMatrix();

    // Adaptive iPad / Touch DPR scaling at ultra-far 512-1024 chunk LODs so Apple GPU stays locked at 60 FPS!
    const rawDpr = window.devicePixelRatio || 1;
    const maxDpr = this.isTouch
      ? (this.settings.renderDistance > 256 ? 1.1 : 1.25)
      : 1.5;
    this.renderer.setPixelRatio(Math.min(rawDpr, maxDpr));
    if (this.player) {
      this.player.baseFov = this.settings.fov;
      this.player.flightSpeed = typeof this.settings.flightSpeed === 'number' ? this.settings.flightSpeed : 1.0;
    }

    // Shaders & Cinematic ACES Filmic Tone Mapping (20x BSL vibrancy!)
    const sh = this.settings.shaders || 'ultra';
    this.renderer.shadowMap.enabled = sh === 'ultra';
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.toneMapping = sh === 'off' ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = sh === 'ultra' ? 1.12 : (sh === 'enhanced' ? 1.08 : 1.0);
    if (this.postfx) this.postfx.setQuality(sh);

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
    if (this.running) this.saveCurrentWorld(false);
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

  async startNewWorld({ name, mode, worldType, seed, allowCheats = false, difficulty = 'normal', mobSpawnRate = 1.0, hungerRate = 1.0, farmSpeed = 1.0, generateStructures = true, bonusChest = false }) {
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
      hungerRate: typeof hungerRate === 'number' && Number.isFinite(hungerRate) ? hungerRate : 1.0,
      farmSpeed: typeof farmSpeed === 'number' && Number.isFinite(farmSpeed) ? farmSpeed : 1.0,
      generateStructures: generateStructures !== false,
      bonusChest: Boolean(bonusChest)
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
      hungerRate: typeof data.hungerRate === 'number' && Number.isFinite(data.hungerRate) ? data.hungerRate : 1.0,
      farmSpeed: typeof data.farmSpeed === 'number' && Number.isFinite(data.farmSpeed) ? data.farmSpeed : (typeof this.settings.farmSpeed === 'number' ? this.settings.farmSpeed : 1.0),
      generateStructures: data.generateStructures !== false,
      bonusChest: Boolean(data.bonusChest)
    };
    await this.initGameSession(this.worldMeta, data);
  }

  getGameRules() {
    return {
      difficulty: this.worldMeta?.difficulty || 'normal',
      mobSpawnRate: typeof this.worldMeta?.mobSpawnRate === 'number' ? this.worldMeta.mobSpawnRate : 1.0,
      hungerRate: typeof this.worldMeta?.hungerRate === 'number' ? this.worldMeta.hungerRate : 1.0,
      farmSpeed: typeof this.worldMeta?.farmSpeed === 'number' ? this.worldMeta.farmSpeed : (typeof this.settings?.farmSpeed === 'number' ? this.settings.farmSpeed : 1.0)
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
    this.settings.difficulty = next;
    saveSettings(this.settings);
    if (this.running) this.saveCurrentWorld(false);
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
    this.settings.mobSpawnRate = rate;
    saveSettings(this.settings);
    if (this.running) this.saveCurrentWorld(false);
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
    this.settings.hungerRate = rate;
    saveSettings(this.settings);
    if (this.running) this.saveCurrentWorld(false);
    if (this.ui) {
      this.ui.syncWorldRulesUI(this.worldMeta);
      if (!silent) {
        this.ui.addChatMessage(`Hunger drain speed set to ${rate}×`);
        this.ui.toast(`Hunger Speed: ${rate}×`);
      }
    }
    return true;
  }

  setFarmSpeed(val, silent = false) {
    let rate = typeof val === 'number' ? val : NaN;
    if (Number.isNaN(rate)) {
      const raw = String(val || '').toLowerCase().trim();
      const map = { off: 0, paused: 0, slow: 0.5, normal: 1.0, default: 1.0, fast: 2.0, turbo: 4.0, hyper: 8.0, instant: 10.0 };
      rate = raw in map ? map[raw] : parseFloat(raw);
    }
    if (!Number.isFinite(rate)) return false;
    rate = Math.max(0, Math.min(20, Math.round(rate * 100) / 100));
    if (!this.worldMeta) this.worldMeta = {};
    this.worldMeta.farmSpeed = rate;
    this.settings.farmSpeed = rate;
    saveSettings(this.settings);
    if (this.running) this.saveCurrentWorld(false);
    if (this.ui) {
      this.ui.syncWorldRulesUI(this.worldMeta);
      if (!silent) {
        this.ui.addChatMessage(`Farm growth speed set to ${rate}×`);
        this.ui.toast(`Farm Speed: ${rate}×`);
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
    this.textures.ensureGameplayTextures();
    if (!this.postfx) {
      this.postfx = new PostFXPipeline(this.renderer, this.isTouch);
      this.postfx.setQuality(this.settings.shaders || 'ultra');
    }
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
        maxDetailRadius: this.isTouch ? 5 : 10,
        shaders: shaderMode,
        generateStructures: meta.generateStructures !== false
      });

      // Wire fluid mixing (Obsidian/Cobblestone/Stone steam fizz) & Fire-to-TNT ignition!
      this.world.onFluidMix = (fx, fy, fz, resBlockId) => {
        if (this.sound && this.sound.playFizz) this.sound.playFizz();
        const def = getBlockDef(resBlockId);
        if (this.effects && def) this.effects.spawnBlockBreak(fx, fy, fz, def);
      };
      this.world.onFireIgniteTnt = (tx, ty, tz) => {
        this.igniteTnt(tx, ty, tz, 2.6);
      };

      // Wire natural leaf decay particles & authentic apple/stick drops!
      this.world.onLeafDecay = (lx, ly, lz, leafBlockId) => {
        const def = getBlockDef(leafBlockId);
        if (this.effects && def && this.player) {
          const d2 = (lx - this.player.pos.x) ** 2 + (ly - this.player.pos.y) ** 2 + (lz - this.player.pos.z) ** 2;
          if (d2 < 32 * 32) this.effects.spawnBlockBreak(lx, ly, lz, def);
        }
        if (this.entities) {
          const r = Math.random();
          if (leafBlockId === BLOCK.OAK_LEAVES && r < 0.06) {
            this.entities.spawnDrop('apple', 1, lx + 0.5, ly + 0.4, lz + 0.5);
          } else if (r < 0.13) {
            this.entities.spawnDrop('stick', 1, lx + 0.5, ly + 0.4, lz + 0.5);
          }
        }
      };

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
        if (Array.isArray(saved.doorStates)) {
          for (const [k, v] of saved.doorStates) this.world.doorStates.set(k, v);
        }
        if (Array.isArray(saved.gateStates)) {
          for (const [k, v] of saved.gateStates) this.world.gateStates.set(k, v);
        }
        if (Array.isArray(saved.ladderStates)) {
          for (const [k, v] of saved.ladderStates) this.world.ladderStates.set(k, v);
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
      this.player.flightSpeed = typeof this.settings.flightSpeed === 'number' ? this.settings.flightSpeed : 1.0;
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

        // Authentic Minecraft Bonus Chest right beside spawn (with 4 torches & starter supplies!)
        if (meta.bonusChest) {
          const cxB = Math.floor(startX) + 2;
          const czB = Math.floor(startZ);
          const cyB = this.world.getSurfaceY(cxB, czB) + 1;
          this.world.setBlock(cxB, cyB, czB, BLOCK.CHEST, true);
          const loot = new Array(27).fill(null);
          const starter = [
            { id: 'wooden_pickaxe', count: 1, durability: 60 },
            { id: 'wooden_axe', count: 1, durability: 60 },
            { id: 'wooden_shovel', count: 1, durability: 60 },
            { id: 'wooden_hoe', count: 1, durability: 60 },
            { id: 'oak_planks', count: 16 },
            { id: 'stick', count: 8 },
            { id: 'apple', count: 4 },
            { id: 'bread', count: 4 },
            { id: 'wheat_seeds', count: 8 },
            { id: 'torch', count: 12 }
          ];
          for (let i = 0; i < starter.length; i++) loot[i] = starter[i];
          this.world.chests.set(`${cxB},${cyB},${czB}`, loot);
          for (const [tdx, tdz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const ty = this.world.getSurfaceY(cxB + tdx, czB + tdz) + 1;
            if (Math.abs(ty - cyB) <= 2 && this.world.getBlock(cxB + tdx, ty, czB + tdz) === BLOCK.AIR) {
              this.world.setBlock(cxB + tdx, ty, czB + tdz, BLOCK.TORCH, true);
            }
          }
        }
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
      this.entities.onDiscoverMega = (ms) => {
        const msg = ms.type === 'great_pyramid'
          ? `Discovered ${ms.name}! (${ms.villagerCount} Villagers & 130+ Underground Secrets!)`
          : `Discovered ${ms.name}! (${ms.villagerCount} Villagers & Deep Dungeon Vaults!)`;
        this.ui.showToast(msg);
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
      farmSpeed: typeof this.worldMeta.farmSpeed === 'number' ? this.worldMeta.farmSpeed : 1.0,
      generateStructures: this.worldMeta.generateStructures !== false,
      bonusChest: Boolean(this.worldMeta.bonusChest),
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
      furnaces: Array.from(this.world.furnaces.entries()),
      doorStates: Array.from(this.world.doorStates.entries()),
      gateStates: Array.from(this.world.gateStates.entries()),
      ladderStates: Array.from(this.world.ladderStates.entries())
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
    if (this.running) this.saveCurrentWorld(false);
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
      const heldDef = this.inventory.getHeldDef();

      // 0. Check if tapping USE on a Villager to trade! (Never repeat-open on hold)
      if (!isRepeat && this.entities) {
        const eye = this.player.getEyePosition();
        const dir = this.player.getLookDirection();
        const mob = this.entities.raycastMob(eye, dir, 4.5);
        if (mob && mob.type === 'villager') {
          this.player.swingAnim = 1.0;
          this.ui.openTradeModal(mob);
          return;
        }
      }

      // 1. Check interactive block targeted (skip on hold-repeat)
      if (!isRepeat && this.currentTarget) {
        const { x, y, z, blockId } = this.currentTarget;
        const bdef = getBlockDef(blockId);
        if (bdef && bdef.interactive && !this.player.sneaking) {
          this.player.swingAnim = 1.0;
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
            if (heldDef && heldDef.id === 'flint_and_steel') {
              if (this.sound.playFlintSteel) this.sound.playFlintSteel();
              if (this.player.mode === 'survival') {
                this.inventory.damageSelectedTool(1);
                this.ui.updateHotbar();
              }
              this.igniteTnt(x, y, z, 2.6);
            } else {
              this.ui.toast('Use Flint and Steel to ignite TNT!');
            }
            return;
          }
          if (bdef.interactive === 'door') {
            const opened = this.world.toggleDoor(x, y, z);
            if (this.sound.playDoorToggle) this.sound.playDoorToggle(opened);
            return;
          }
          if (bdef.interactive === 'fence_gate') {
            const opened = this.world.toggleFenceGate(x, y, z, this.player.yaw);
            if (this.sound.playDoorToggle) this.sound.playDoorToggle(opened);
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

      // 2. Food items use hold-to-eat animation in updateEating() — never instant-consume!
      if (heldDef && heldDef.food) {
        if (!isRepeat && this.player.mode === 'survival' && this.player.hunger >= this.player.maxHunger && this.player.hp >= this.player.maxHp) {
          const now = performance.now();
          if (now - this._lastFullToast > 1800) {
            this._lastFullToast = now;
            this.ui.toast('Hunger & health are already full!');
          }
        }
        return;
      }

      // 2b. Flint and Steel places Fire on any solid surface (in addition to lighting TNT above!)
      if (!isRepeat && heldDef && heldDef.id === 'flint_and_steel' && this.currentTarget) {
        const fx = this.currentTarget.x + this.currentTarget.nx;
        const fy = this.currentTarget.y + this.currentTarget.ny;
        const fz = this.currentTarget.z + this.currentTarget.nz;
        const existing = this.world.getBlock(fx, fy, fz);
        if (existing === BLOCK.AIR || existing === BLOCK.TALL_GRASS || existing === BLOCK.FLOWER_RED || existing === BLOCK.FLOWER_YELLOW) {
          this.player.swingAnim = 1.0;
          this.world.setBlock(fx, fy, fz, BLOCK.FIRE, true);
          if (this.sound.playFlintSteel) this.sound.playFlintSteel();
          if (this.player.mode === 'survival') {
            this.inventory.damageSelectedTool(1);
            this.ui.updateHotbar();
          }
          return;
        }
      }

      // 2c. Water Bucket, Lava Bucket & Empty Bucket (Place & Scoop Flowing Fluids!)
      if (!isRepeat && heldDef && heldDef.bucketType && this.currentTarget) {
        this.player.swingAnim = 1.0;
        if (heldDef.bucketType === 'water' || heldDef.bucketType === 'lava') {
          const px = this.currentTarget.x + this.currentTarget.nx;
          const py = this.currentTarget.y + this.currentTarget.ny;
          const pz = this.currentTarget.z + this.currentTarget.nz;
          const fBlk = heldDef.bucketType === 'lava' ? BLOCK.LAVA : BLOCK.WATER;
          this.world.placeFluidSource(px, py, pz, fBlk);
          if (this.sound.playSplash) this.sound.playSplash();
          if (this.player.mode === 'survival') {
            this.inventory.slots[this.inventory.selected] = this.inventory.makeStack('bucket', 1);
            this.ui.updateHotbar();
          }
          return;
        } else if (heldDef.bucketType === 'empty') {
          const { x, y, z, blockId } = this.currentTarget;
          if ((blockId === BLOCK.WATER || blockId === BLOCK.LAVA) && this.world.getFluidLevel(x, y, z) === 0) {
            const scooped = this.world.pickupFluidSource(x, y, z);
            if (!scooped) return;
            if (this.sound.playSplash) this.sound.playSplash();
            const filledId = scooped === BLOCK.LAVA ? 'lava_bucket' : 'water_bucket';
            const selSlot = this.inventory.slots[this.inventory.selected];
            if (this.player.mode === 'survival') {
              if (selSlot && selSlot.count > 1) {
                selSlot.count--;
                this.inventory.addItem(filledId, 1);
              } else {
                this.inventory.slots[this.inventory.selected] = this.inventory.makeStack(filledId, 1);
              }
              this.ui.updateHotbar();
            } else {
              this.inventory.slots[this.inventory.selected] = this.inventory.makeStack(filledId, 1);
              this.ui.updateHotbar();
            }
            return;
          }
        }
      }

      // 2d. Hoe Tilling (Grass/Dirt -> Farmland), Shovel Dirt Paths (Grass/Dirt -> Dirt Path) & Wheat Seed Planting!
      if (!isRepeat && heldDef && heldDef.toolType === 'hoe' && this.currentTarget) {
        const { x, y, z } = this.currentTarget;
        if (this.world.tillBlock(x, y, z)) {
          this.player.swingAnim = 1.0;
          if (this.sound.playTill) this.sound.playTill();
          if (this.player.mode === 'survival') {
            this.inventory.damageSelectedTool(1);
            this.ui.updateHotbar();
          }
          return;
        }
      }
      if (!isRepeat && heldDef && heldDef.toolType === 'shovel' && this.currentTarget) {
        const { x, y, z } = this.currentTarget;
        if (this.world.makeDirtPath(x, y, z)) {
          this.player.swingAnim = 1.0;
          if (this.sound.playTill) this.sound.playTill();
          if (this.player.mode === 'survival') {
            this.inventory.damageSelectedTool(1);
            this.ui.updateHotbar();
          }
          return;
        }
      }
      if (!isRepeat && heldDef && heldDef.id === 'wheat_seeds' && this.currentTarget) {
        const { x, y, z, blockId } = this.currentTarget;
        if (isFarmlandBlock(blockId) && this.world.getBlock(x, y + 1, z) === BLOCK.AIR) {
          this.player.swingAnim = 1.0;
          this.world.setBlock(x, y + 1, z, BLOCK.WHEAT_0, true);
          if (this.sound.playPlant) this.sound.playPlant();
          if (blockId !== BLOCK.FARMLAND_WET && !this.world.isFarmlandHydrated(x, y, z) && !this._shownWaterFarmTip) {
            this._shownWaterFarmTip = true;
            this.ui.toast('Tip: Place water within 4 blocks so your wheat grows!');
          }
          if (this.player.mode === 'survival') {
            this.inventory.consumeSelected(1);
            this.ui.updateHotbar();
          }
          return;
        }
      }

      // 2e. Mob Spawn Eggs (spawn ANY mob in the game right where you aim!)
      if (!isRepeat && heldDef && heldDef.spawnMob && this.currentTarget && this.entities) {
        const px = this.currentTarget.x + this.currentTarget.nx + 0.5;
        const py = this.currentTarget.y + this.currentTarget.ny;
        const pz = this.currentTarget.z + this.currentTarget.nz + 0.5;
        const biome = this.world.getBiomeAt(Math.floor(px), Math.floor(pz));
        this.player.swingAnim = 1.0;
        const spawned = this.entities.spawnMob(heldDef.spawnMob, px, py, pz, null, biome);
        if (spawned) {
          this.sound.playPop();
          if (this.player.mode === 'survival') {
            this.inventory.consumeSelected(1);
            this.ui.updateHotbar();
          }
        } else {
          this.ui.toast('Not enough space to spawn here!');
        }
        return;
      }

      if (!isRepeat) this.player.swingAnim = 1.0;

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

        if (heldDef.isDoor) {
          if (isRepeat) return;
          const curBot = this.world.getBlock(px, py, pz);
          const curTop = this.world.getBlock(px, py + 1, pz);
          if (isBlockSolid(curBot) || isBlockSolid(curTop) || insidePlayer(px, py, pz) || insidePlayer(px, py + 1, pz)) {
            this.ui.toast('Need 2 vertical blocks of space to place a Door!');
            return;
          }
          // Face the player cleanly (0=North -Z, 1=East +X, 2=South +Z, 3=West -X)
          const fx = -Math.sin(this.player.yaw);
          const fz = -Math.cos(this.player.yaw);
          let facing = 0;
          if (Math.abs(fx) > Math.abs(fz)) facing = fx > 0 ? 3 : 1;
          else facing = fz > 0 ? 0 : 2;
          this.world.placeDoor(px, py, pz, heldDef.blockId, facing);
          this.sound.playBlock(heldDef.sound, true);
          if (this.player.mode === 'survival') {
            this.inventory.consumeSelected(1);
            this.ui.updateHotbar();
          }
          return;
        }

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

        if (heldDef.isFenceGate) {
          if (isRepeat) return;
          if (insidePlayer(px, py, pz)) return;
          const fx = -Math.sin(this.player.yaw);
          const fz = -Math.cos(this.player.yaw);
          let facing = 0;
          if (Math.abs(fx) > Math.abs(fz)) facing = fx > 0 ? 1 : 3;
          else facing = fz > 0 ? 2 : 0;
          this.world.placeFenceGate(px, py, pz, heldDef.blockId, facing);
          this.sound.playBlock(heldDef.sound, true);
          if (this.player.mode === 'survival') {
            this.inventory.consumeSelected(1);
            this.ui.updateHotbar();
          }
          return;
        }

        if (heldDef.blockId === BLOCK.LADDER) {
          if (isRepeat) return;
          this.world.placeLadder(px, py, pz, this.currentTarget.nx, this.currentTarget.ny, this.currentTarget.nz);
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
    if (cmd === 'farmspeed' || cmd === 'cropspeed' || cmd === 'farmrate') {
      if (!parts[1]) {
        const cur = this.worldMeta?.farmSpeed ?? 1.0;
        this.ui.addChatMessage(`Current farm growth speed: ${cur}× (Usage: /farmspeed off|slow|normal|fast|turbo|instant or 0..20)`);
        return true;
      }
      if (!this.setFarmSpeed(parts[1])) {
        this.ui.addChatMessage('Usage: /farmspeed off|slow|normal|fast|turbo|instant (or a number 0 to 20)');
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
      let item = parts[1].toLowerCase();
      if (!ITEMS[item] && item.startsWith('gold_')) {
        const alt = 'golden_' + item.slice(5);
        if (ITEMS[alt]) item = alt;
      }
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

    const LOG_IDS = [
      BLOCK.OAK_LOG, BLOCK.BIRCH_LOG, BLOCK.SPRUCE_LOG,
      BLOCK.ACACIA_LOG, BLOCK.JUNGLE_LOG, BLOCK.CHERRY_LOG
    ];
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
        if (blockId === BLOCK.WHEAT_7) {
          // Authentic Minecraft fully-grown Wheat harvest: 1 Wheat + 2 to 4 Wheat Seeds!
          const seedCnt = 2 + Math.floor(Math.random() * 3);
          this.entities.spawnDrop('wheat', 1, bx + 0.5, by + 0.4, bz + 0.5);
          this.entities.spawnDrop('wheat_seeds', seedCnt, bx + 0.5, by + 0.4, bz + 0.5);
        } else {
          const chance = def.dropChance !== undefined ? def.dropChance : 1.0;
          if (Math.random() <= chance) {
            let dropId = def.drop;
            if (blockId === BLOCK.GRAVEL && Math.random() < 0.35) dropId = 'flint';
            if (autoSmelt && AUTO_SMELT_ORES[dropId]) dropId = AUTO_SMELT_ORES[dropId];
            const cnt = def.dropCount || 1;
            if (autoSmelt) {
              this.inventory.addItem(dropId, cnt);
            } else {
              this.entities.spawnDrop(dropId, cnt, bx + 0.5, by + 0.4, bz + 0.5);
            }
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

  resetEating() {
    if (!this.player) return;
    if (this.player.isEating || this.player.eatProgress > 0) {
      this.player.isEating = false;
      this.player.eatProgress = 0;
      this.player.eatTime = 0;
      this._eatChewTimer = 0;
      this._eatSlot = -1;
      if (!this.player.miningTarget) this.ui.updateMiningRing(0, false);
    }
  }

  updateEating(dt, using, useMode, eye, dir) {
    if (this._eatCooldown > 0) this._eatCooldown = Math.max(0, this._eatCooldown - dt);

    const heldDef = this.inventory.getHeldDef();
    const canEatFood = !!(
      using &&
      !useMode &&
      this.controls.enabled &&
      !this.player.dead &&
      heldDef &&
      heldDef.food &&
      (this.player.mode === 'creative' || this.player.hunger < this.player.maxHunger || this.player.hp < this.player.maxHp)
    );

    if (!canEatFood || this._eatCooldown > 0) {
      this.resetEating();
      return;
    }

    // Cancel & restart cleanly if the player switched hotbar slots mid-bite
    if (this._eatSlot !== this.inventory.selected) {
      this.player.eatTime = 0;
      this.player.eatProgress = 0;
      this._eatChewTimer = 0.22; // Trigger an immediate crunch as soon as eating starts
      this._eatSlot = this.inventory.selected;
    }

    const EAT_DURATION = 1.5;
    this.player.isEating = true;
    this.player.eatTime += dt;
    this.player.eatProgress = Math.min(1, this.player.eatTime / EAT_DURATION);

    // Periodic chewing crunch & food crumb particles
    this._eatChewTimer += dt;
    if (this._eatChewTimer >= 0.26) {
      this._eatChewTimer = 0;
      this.sound.playEat();
      if (this.effects && this.effects.spawnEatCrumbs) {
        this.effects.spawnEatCrumbs(eye, dir, heldDef);
      }
    }

    if (!this.player.miningTarget) {
      this.ui.updateMiningRing(this.player.eatProgress, true);
    }

    if (this.player.eatTime >= EAT_DURATION) {
      if (this.player.mode === 'survival') {
        this.player.hunger = Math.min(this.player.maxHunger, this.player.hunger + heldDef.food);
        this.player.hp = Math.min(this.player.maxHp, this.player.hp + Math.ceil(heldDef.food * 0.5));
        this.inventory.consumeSelected(1);
      }
      if (this.sound.playEatFinish) this.sound.playEatFinish();
      else this.sound.playEat();
      this.player.isEating = false;
      this.player.eatTime = 0;
      this.player.eatProgress = 0;
      this._eatChewTimer = 0;
      this._eatSlot = -1;
      this._eatCooldown = 0.24;
      this.ui.updateMiningRing(0, false);
      this.ui.updateStats();
      this.ui.updateHotbar();
    }
  }

  updateMining(dt, breaking) {
    if (!breaking || !this.currentTarget || !this.controls.enabled) {
      this.player.miningTarget = null;
      this.player.miningProgress = 0;
      this.player.updateCrackOverlay(null, 0);
      if (!this.player.isEating) this.ui.updateMiningRing(0, false);
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
    // Self-healing iPad PWA / Safari orientation & app-resume aspect guard (impossible to stay stretched!)
    const curW = Math.max(1, Math.round((this.container && this.container.clientWidth) || window.innerWidth));
    const curH = Math.max(1, Math.round((this.container && this.container.clientHeight) || window.innerHeight));
    if (curW !== this._lastViewW || curH !== this._lastViewH) {
      this.onResize();
    }
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

      // Raycast targeted block & Villager / Wildlife (hit liquids when holding an empty Bucket!)
      const eye = this.player.getEyePosition(this._eyeVec);
      const dir = this.player.getLookDirection(this._dirVec);
      const lookMob = this.entities.raycastMob(eye, dir, 5.2);
      const heldForRay = this.inventory.getHeldDef();
      const rayHitLiquids = !!(heldForRay && heldForRay.bucketType === 'empty');
      this.currentTarget = this.world.raycast(eye, dir, 5.5, rayHitLiquids);

      const mobHit = !!(lookMob && (!this.currentTarget || (lookMob._hitDist ?? lookMob.pos.distanceTo(eye)) <= this.currentTarget.dist + 0.35));
      const targetDef = this.currentTarget ? getBlockDef(this.currentTarget.blockId) : null;

      // Dynamic context-aware buttons:
      // - PICK UP when holding Empty Bucket over a Water or Lava source!
      // - TILL when holding a Hoe over Grass/Dirt!
      // - PLANT when holding Wheat Seeds over Farmland!
      // - PLACE -> USE when hovering Villager or interactive block (Crafting Table, Furnace, Chest, Door, Bed, TNT)
      // - PLACE -> EAT when holding food (and not hovering an interactive block/villager)
      // - MINE -> DAMAGE when hovering over any animal/mob!
      const heldDef = this.inventory.getHeldDef();
      const isVillagerHover = !!(mobHit && lookMob.type === 'villager');
      const isPickupFluid = !!(
        !mobHit && this.currentTarget && heldDef && heldDef.bucketType === 'empty' &&
        (this.currentTarget.blockId === BLOCK.WATER || this.currentTarget.blockId === BLOCK.LAVA) &&
        this.world.getFluidLevel(this.currentTarget.x, this.currentTarget.y, this.currentTarget.z) === 0
      );
      const isTillHover = !!(
        !mobHit && this.currentTarget && heldDef && heldDef.toolType === 'hoe' &&
        (this.currentTarget.blockId === BLOCK.GRASS || this.currentTarget.blockId === BLOCK.DIRT ||
         this.currentTarget.blockId === BLOCK.DIRT_PATH ||
         this.currentTarget.blockId === BLOCK.SAVANNA_GRASS || this.currentTarget.blockId === BLOCK.JUNGLE_GRASS ||
         this.currentTarget.blockId === BLOCK.SWAMP_GRASS) &&
        this.world.getBlock(this.currentTarget.x, this.currentTarget.y + 1, this.currentTarget.z) === BLOCK.AIR
      );
      const isPathHover = !!(
        !mobHit && this.currentTarget && heldDef && heldDef.toolType === 'shovel' &&
        (this.currentTarget.blockId === BLOCK.GRASS || this.currentTarget.blockId === BLOCK.DIRT ||
         this.currentTarget.blockId === BLOCK.SAVANNA_GRASS || this.currentTarget.blockId === BLOCK.JUNGLE_GRASS ||
         this.currentTarget.blockId === BLOCK.SWAMP_GRASS) &&
        this.world.getBlock(this.currentTarget.x, this.currentTarget.y + 1, this.currentTarget.z) === BLOCK.AIR
      );
      const isPlantHover = !!(
        !mobHit && this.currentTarget && heldDef && heldDef.id === 'wheat_seeds' &&
        (this.currentTarget.blockId === BLOCK.FARMLAND || this.currentTarget.blockId === BLOCK.FARMLAND_WET) &&
        this.world.getBlock(this.currentTarget.x, this.currentTarget.y + 1, this.currentTarget.z) === BLOCK.AIR
      );
      const isInteractiveBlock = !!(
        targetDef && targetDef.interactive && !this.player.sneaking &&
        (targetDef.interactive !== 'tnt' || (heldDef && heldDef.id === 'flint_and_steel'))
      );
      const useMode = isVillagerHover || (!mobHit && isInteractiveBlock);
      const eatMode = !useMode && !isPickupFluid && !!(heldDef && heldDef.food);
      const placeActionMode = isPickupFluid ? 'pickup' : (isTillHover ? 'till' : (isPathHover ? 'path' : (isPlantHover ? 'plant' : (useMode ? 'use' : (eatMode ? 'eat' : 'place')))));
      const damageMode = mobHit;
      this.ui.updateActionButtons(placeActionMode, damageMode);

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
        const ttName = isPickupFluid
          ? `${this.currentTarget.blockId === BLOCK.LAVA ? 'Lava' : 'Water'} — Tap PICK UP`
          : (targetDef ? targetDef.name : '');
        this.ui.updateTargetTooltip(ttName);
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
      this.updateEating(dt, input.using && !input.breaking, useMode, eye, dir);
      const maxBuilds = this.isTouch ? 1 : (this.settings.renderDistance > 8 ? 3 : 2);
      const chunkBudgetMs = this.isTouch ? 3.5 : 4.2;
      this.world.updateChunksAround(this.player.pos.x, this.player.pos.z, maxBuilds, chunkBudgetMs, dir.x, dir.z);
      this.world.updateFurnaces(dt);
      this.world.updateLeafDecay(dt, this.player.pos);
      this.world.updateFluids(dt);
      this.world.updateCrops(dt, !this.sky.isNight(), gameRules.farmSpeed);
      this.world.updateFire(dt, this.sky.weather === 'rain');

      // Spawn rising hot orange embers & soft smoke wisps from nearby active fires!
      if (this.effects && this.world.activeFires.size > 0) {
        this._fireEmberTimer = (this._fireEmberTimer || 0) + dt;
        if (this._fireEmberTimer >= 0.14) {
          this._fireEmberTimer = 0;
          let spawned = 0;
          const px = this.player.pos.x, py = this.player.pos.y, pz = this.player.pos.z;
          for (const f of this.world.activeFires.values()) {
            const dx = f.x - px, dy = f.y - py, dz = f.z - pz;
            if (dx * dx + dy * dy + dz * dz < 900 && Math.random() < 0.38) {
              this.effects.spawnFireEmber(f.x, f.y, f.z);
              if (++spawned >= 4) break;
            }
          }
        }
      }

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
      this.entities.update(dt, this.player, this.sky, (ex, ey, ez, r) => this.triggerExplosion(ex, ey, ez, r), this.mods, gameRules, this.effects);

      // Brief tactile camera shake during nearby TNT / Creeper blasts!
      if (this._shakeTimer > 0) {
        this._shakeTimer = Math.max(0, this._shakeTimer - dt);
        const s = this._shakeIntensity * (this._shakeTimer / 0.36);
        this.camera.position.x += (Math.random() - 0.5) * s;
        this.camera.position.y += (Math.random() - 0.5) * s;
        this.camera.position.z += (Math.random() - 0.5) * s;
        if (this._shakeTimer <= 0) this._shakeIntensity = 0;
      }

      // Throttled HUD & Minimap updates (eliminates 60Hz DOM thrashing on iPad Safari!)
      this._hudTimer = (this._hudTimer || 0) + dt;
      if (this._hudTimer >= 0.10) {
        this._hudTimer = 0;
        this.ui.updateTopHUD(this.player, curBiome, this.sky, this.currentFps);
        this.ui.updateEffectsHUD(this.player.statusEffects);
      }
      this.minimapTimer += dt;
      const mmInterval = this.isTouch ? 0.24 : 0.16;
      if (this.minimapTimer >= mmInterval) {
        this.minimapTimer = 0;
        this.ui.renderMinimap(this.player, this.world, this.entities, curBiome);
      }
      const airBucket = Math.ceil(this.player.air);
      if ((this.player.headInWater || this.player.air < this.player.maxAir) && airBucket !== this._lastAirHud) {
        this._lastAirHud = airBucket;
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

      if (this.postfx && this.postfx.enabled) {
        this.postfx.render(this.scene, this.camera, this.sky, now * 0.001, this.player.headInWater);
      } else {
        this.renderer.render(this.scene, this.camera);
      }
    } else if (this.titlePanorama && !this._loadingWorld) {
      // Silky 60 FPS Live 3D Voxel Panorama on the Main Menu!
      this.titlePanorama.update(dt);
      this.titlePanorama.render(this.renderer);
    }
  }
}

window.blockcraft = new BlockCraftGame();
