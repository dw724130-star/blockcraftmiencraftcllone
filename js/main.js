import * as THREE from 'three';
import { BLOCK, ITEMS, KEY_TO_BLOCK, getBlockDef } from './blocks.js';
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
import { loadSettings, saveSettings, listWorlds, loadWorld, saveWorld, deleteWorld } from './storage.js';

class BlockCraftGame {
  constructor() {
    this.settings = loadSettings();
    this.mods = new ModManager();
    this.sound = new SoundManager();
    this.sound.enabled = this.settings.sound;
    this.textures = new TextureManager();
    this.ui = new UIManager(this.textures, this.sound);

    // Three.js Renderer
    this.container = document.getElementById('game-container');
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = (this.settings.shaders || 'ultra') === 'ultra';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

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
    this.fpsFrames = 0;
    this.fpsAccum = 0;
    this.currentFps = 60;
    this.autosaveTimer = 0;
    this.furnaceUiTimer = 0;
    this.minimapTimer = 0;

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
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  applySettings() {
    this.sound.enabled = this.settings.sound;
    this.controls.sensitivity = this.settings.sensitivity;
    this.controls.setControlStyle(this.settings.controlStyle);
    this.controls.setShowTouch(this.settings.showTouch);

    // Toggleable Minecraft Classic UI Vibe & Large iPad UI Scale
    document.body.classList.toggle('mc-theme', this.settings.minecraftUI !== false);
    document.body.classList.toggle('large-ui', this.settings.largeUI !== false);

    // Camera FOV & far plane — always strictly larger than SkyDome (420) so sky NEVER clips!
    this.camera.fov = this.settings.fov;
    this.camera.far = Math.max(700, this.settings.renderDistance * 24 + 260);
    this.camera.updateProjectionMatrix();
    if (this.player) this.player.baseFov = this.settings.fov;

    // Shaders & Cinematic ACES Filmic Tone Mapping
    const sh = this.settings.shaders || 'ultra';
    this.renderer.shadowMap.enabled = sh === 'ultra';
    this.renderer.toneMapping = sh === 'off' ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = sh === 'ultra' ? 1.08 : (sh === 'enhanced' ? 1.05 : 1.0);

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
  }

  updateSetting(key, val) {
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

  async startNewWorld({ name, mode, worldType, seed }) {
    this.sound.unlock();
    const id = 'w_' + Date.now();
    this.worldMeta = { id, name, mode, worldType, seed };
    this.initGameSession(this.worldMeta, null);
    await this.saveCurrentWorld(false);
  }

  async loadSavedWorld(id) {
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
      seed: data.seed
    };
    this.initGameSession(this.worldMeta, data);
  }

  async deleteSavedWorld(id) {
    await deleteWorld(id);
    await this.refreshWorldList();
    this.ui.toast('World deleted');
  }

  initGameSession(meta, saved) {
    this.cleanupScene();

    this.world = new World(this.scene, this.textures, {
      seed: meta.seed,
      worldType: meta.worldType,
      renderDistance: this.settings.renderDistance,
      shaders: this.settings.shaders || 'ultra'
    });

    // Restore modified blocks & tile entities before preloading spawn chunks
    if (saved) {
      if (Array.isArray(saved.modifiedBlocks)) {
        for (const [k, v] of saved.modifiedBlocks) this.world.modifiedBlocks.set(k, v);
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
    this.sky.setShaderMode(this.settings.shaders || 'ultra');
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

    const startX = saved?.player?.x ?? 0.5;
    const startZ = saved?.player?.z ?? 0.5;
    this.world.preloadSpawn(startX, startZ);

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
      this.player.pos.set(startX, sy + 0.2, startZ);
      this.player.spawnPos.set(startX, sy + 0.2, startZ);
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

    this.entities = new EntityManager(this.scene, this.world, this.sound, this.textures);
    this.entities.populateInitialWildlife(this.player.pos);

    this.running = true;
    this.controls.enabled = true;
    this.ui.showTitleScreen(false);
    this.ui.updateHotbar();
    this.ui.updateStats();
    this.ui.addChatMessage(`Welcome to ${meta.name}! (${meta.mode.toUpperCase()})`);
  }

  async saveCurrentWorld(showToast = false) {
    if (!this.running || !this.worldMeta || !this.world || !this.player) return;
    const record = {
      id: this.worldMeta.id,
      name: this.worldMeta.name,
      mode: this.player.mode,
      worldType: this.worldMeta.worldType,
      seed: this.worldMeta.seed,
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

  setGameMode(mode) {
    if (!this.player) return;
    this.player.mode = mode;
    if (mode === 'survival') this.player.flying = false;
    else {
      this.player.hp = this.player.maxHp;
      this.player.hunger = this.player.maxHunger;
    }
    this.ui.updateStats();
    this.ui.toast(`Switched to ${mode.toUpperCase()} mode`);
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
      const eye = this.player.getEyePosition();
      const dir = this.player.getLookDirection();
      const mob = this.entities.raycastMob(eye, dir, 4.2);
      if (mob) {
        const held = this.inventory.getHeldDef();
        const dmg = held?.damage || 2;
        this.entities.hitMob(mob, dmg, dir, this.player);
        if (this.player.mode === 'survival') {
          this.inventory.damageSelectedTool(1);
          this.ui.updateHotbar();
        }
      }
    };

    this.controls.onPlaceOrUse = () => {
      if (!this.running || !this.player || !this.world) return;
      this.player.swingAnim = 1.0;

      // 0. Check if tapping USE on a Villager to trade!
      if (this.entities) {
        const eye = this.player.getEyePosition();
        const dir = this.player.getLookDirection();
        const mob = this.entities.raycastMob(eye, dir, 4.5);
        if (mob && mob.type === 'villager') {
          this.ui.openTradeModal(mob);
          return;
        }
      }

      // 1. Check interactive block targeted
      if (this.currentTarget) {
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
            this.triggerExplosion(x + 0.5, y + 0.5, z + 0.5, 3.6);
            return;
          }
          if (bdef.interactive === 'bed') {
            this.player.spawnPos.set(x + 0.5, y + 1.2, z + 0.5);
            if (this.sky.isNight()) {
              this.sky.time = 0.28;
              this.sky.dayCount++;
              this.ui.toast('Slept until morning • Respawn set!');
            } else {
              this.ui.toast('Respawn point set!');
            }
            return;
          }
        }
      }

      // 2. Eat food if holding food
      const heldDef = this.inventory.getHeldDef();
      if (heldDef && heldDef.food) {
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

      // 3. Place block
      if (this.currentTarget && heldDef && heldDef.isBlock) {
        const px = this.currentTarget.x + this.currentTarget.nx;
        const py = this.currentTarget.y + this.currentTarget.ny;
        const pz = this.currentTarget.z + this.currentTarget.nz;

        // Avoid placing solid block inside player's own body
        const dx = Math.abs((px + 0.5) - this.player.pos.x);
        const dz = Math.abs((pz + 0.5) - this.player.pos.z);
        const insideY = py >= Math.floor(this.player.pos.y) && py <= Math.floor(this.player.pos.y + 1.65);
        if (heldDef.solid && dx < 0.78 && dz < 0.78 && insideY) return;

        this.world.setBlock(px, py, pz, heldDef.blockId, true);
        this.sound.playBlock(heldDef.sound, true);
        if (this.player.mode === 'survival') {
          this.inventory.consumeSelected(1);
          this.ui.updateHotbar();
        }
      }
    };
  }

  triggerExplosion(x, y, z, radius = 3.4) {
    this.sound.playExplosion();
    const broken = this.world.explode(x, y, z, radius);
    for (const b of broken) {
      if (Math.random() < 0.35) {
        const def = getBlockDef(b.id);
        if (def && def.drop) this.entities.spawnDrop(def.drop, 1, b.x + 0.5, b.y + 0.5, b.z + 0.5);
      }
    }
    const dist = this.player.pos.distanceTo(new THREE.Vector3(x, y, z));
    if (dist < radius + 2.5) {
      const dmg = Math.floor((1 - dist / (radius + 2.5)) * 14);
      if (dmg > 0) this.player.takeDamage(dmg, 'Blew up');
    }
  }

  handleChatCommand(text) {
    if (!text.startsWith('/')) {
      this.ui.addChatMessage(`Player: ${text}`);
      return;
    }
    const parts = text.slice(1).trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === 'time' && parts[1] === 'set') {
      const v = parts[2]?.toLowerCase();
      if (v === 'day' || v === 'morning') this.sky.time = 0.31;
      else if (v === 'sunrise' || v === 'dawn') this.sky.time = 0.262;
      else if (v === 'noon') this.sky.time = 0.5;
      else if (v === 'sunset' || v === 'golden' || v === 'dusk') this.sky.time = 0.738;
      else if (v === 'night' || v === 'midnight') this.sky.time = 0.02;
      this.ui.addChatMessage(`Set time to ${v}`);
    } else if (cmd === 'gamemode' || cmd === 'gm') {
      const m = parts[1]?.toLowerCase();
      if (m === 'creative' || m === 'c' || m === '1') this.setGameMode('creative');
      else if (m === 'survival' || m === 's' || m === '0') this.setGameMode('survival');
    } else if (cmd === 'weather') {
      const w = parts[1]?.toLowerCase();
      if (w === 'rain' || w === 'clear') {
        this.sky.weather = w;
        this.ui.addChatMessage(`Weather set to ${w}`);
      }
    } else if (cmd === 'heal') {
      this.player.hp = this.player.maxHp;
      this.player.hunger = this.player.maxHunger;
      this.ui.updateStats();
      this.ui.addChatMessage('Healed to full health & hunger');
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
    } else if (cmd === 'tp' && parts.length >= 4) {
      const x = parseFloat(parts[1]);
      const y = parseFloat(parts[2]);
      const z = parseFloat(parts[3]);
      if (!Number.isNaN(x) && !Number.isNaN(y) && !Number.isNaN(z)) {
        this.player.pos.set(x, y, z);
        this.player.vel.set(0, 0, 0);
        this.ui.addChatMessage(`Teleported to ${x}, ${y}, ${z}`);
      }
    } else {
      this.ui.addChatMessage('Commands: /time set day|night, /gamemode creative|survival, /weather rain|clear, /give <item> <n>, /tp x y z, /heal');
    }
  }

  breakBlockWithMods(x, y, z, blockId) {
    const def = getBlockDef(blockId);
    if (!def || def.hardness < 0) return;

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
    if (!def || def.hardness < 0) {
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

    // FPS counter
    this.fpsFrames++;
    this.fpsAccum += dt;
    if (this.fpsAccum >= 0.5) {
      this.currentFps = Math.round(this.fpsFrames / this.fpsAccum);
      this.fpsFrames = 0;
      this.fpsAccum = 0;
    }

    if (this.running && this.world && this.player) {
      const input = this.controls.enabled ? this.controls.poll() : {
        moveForward: 0, moveRight: 0, jump: false, sneak: false, sprint: false,
        breaking: false, lookDeltaX: 0, lookDeltaY: 0
      };

      this.player.update(dt, input, this.mods);
      this.ui.setUnderwater(this.player.headInWater);

      // Raycast targeted block & Villager / Wildlife tooltip
      const eye = this.player.getEyePosition();
      const dir = this.player.getLookDirection();
      const lookMob = this.entities.raycastMob(eye, dir, 5.2);
      this.currentTarget = this.world.raycast(eye, dir, 5.5);
      if (lookMob && lookMob.type === 'villager') {
        this.player.highlightMesh.visible = false;
        this.ui.updateTargetTooltip(`${lookMob.profession || 'Villager'} — Tap USE to Trade`);
      } else if (lookMob && (!this.currentTarget || lookMob.pos.distanceTo(eye) < this.currentTarget.dist)) {
        this.player.highlightMesh.visible = false;
        this.ui.updateTargetTooltip(lookMob.label || lookMob.def.label || lookMob.type);
      } else if (this.currentTarget) {
        this.player.highlightMesh.visible = true;
        this.player.highlightMesh.position.set(
          this.currentTarget.x + 0.5,
          this.currentTarget.y + 0.5,
          this.currentTarget.z + 0.5
        );
        const def = getBlockDef(this.currentTarget.blockId);
        this.ui.updateTargetTooltip(def ? def.name : '');
      } else {
        this.player.highlightMesh.visible = false;
        this.ui.updateTargetTooltip('');
      }

      this.updateMining(dt, input.breaking);
      const maxBuilds = this.settings.renderDistance > 8 ? 4 : 2;
      this.world.updateChunksAround(this.player.pos.x, this.player.pos.z, maxBuilds);
      this.world.updateFurnaces(dt);
      const curBiome = this.world.getBiomeAt(Math.floor(this.player.pos.x), Math.floor(this.player.pos.z));
      this.sky.update(dt, this.player.pos, curBiome);
      this.world.updateShaders(dt, this.sky);
      if (this.effects) {
        this.effects.update(dt, this.player.pos, curBiome, this.sky.isNight());
      }
      this.entities.update(dt, this.player, this.sky, (ex, ey, ez, r) => this.triggerExplosion(ex, ey, ez, r), this.mods);

      this.ui.updateTopHUD(this.player, this.world, this.sky, this.currentFps);
      this.minimapTimer += dt;
      if (this.minimapTimer >= 0.14) {
        this.minimapTimer = 0;
        this.ui.renderMinimap(this.player, this.world, this.entities);
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

      // Auto-save every 25 seconds
      this.autosaveTimer += dt;
      if (this.autosaveTimer >= 25) {
        this.autosaveTimer = 0;
        this.saveCurrentWorld(false);
      }

      this.renderer.render(this.scene, this.camera);
    }
  }
}

window.blockcraft = new BlockCraftGame();
