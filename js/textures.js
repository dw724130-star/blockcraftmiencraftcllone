import * as THREE from 'three';
import { ITEMS } from './blocks.js';

const TILE_SIZE = 16;
const ATLAS_COLS = 16;
const ATLAS_ROWS = 16;

// Simple deterministic pixel hash
function pxHash(x, y, s = 1) {
  let n = Math.imul(x + 37, 374761393) + Math.imul(y + 17, 668265263) + Math.imul(s, 1442695041);
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function fillNoise(ctx, ox, oy, baseHex, variance = 18, seed = 1) {
  const r0 = parseInt(baseHex.slice(1, 3), 16);
  const g0 = parseInt(baseHex.slice(3, 5), 16);
  const b0 = parseInt(baseHex.slice(5, 7), 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const d = Math.floor((pxHash(x, y, seed) - 0.5) * 2 * variance);
      const r = Math.max(0, Math.min(255, r0 + d));
      const g = Math.max(0, Math.min(255, g0 + d));
      const b = Math.max(0, Math.min(255, b0 + d));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(ox + x, oy + y, 1, 1);
    }
  }
}

function px(ctx, ox, oy, x, y, color, w = 1, h = 1) {
  ctx.fillStyle = color;
  ctx.fillRect(ox + x, oy + y, w, h);
}

function keyIsSolidCubeIcon(key, def) {
  return Boolean(def && def.isBlock && key !== 'bed' && !def.isDoor && !def.isFence && !def.isFenceGate && !def.isStair);
}

export class TextureManager {
  constructor() {
    this.tileMap = {}; // name -> { col, row, u0, v0, u1, v1 }
    this.itemIcons = {}; // itemKey -> dataURL
    this.itemTextures = {}; // itemKey -> THREE.CanvasTexture (for 3D pixel-art drops!)
    this.extrudedGeoCache = {}; // itemKey -> 3D extruded pixel-art BufferGeometry
    this.blockDropGeoCache = {}; // "blockId:size" -> BufferGeometry
    this.mobCoatCache = {}; // key -> THREE.CanvasTexture
    this.villagerTexCache = {}; // profName -> { headFront, headSide, headTop, nose, robeFront, robeSide, robeBack, hatTop, hatSide, apron, boot }
    this.hudIcons = {}; // name -> dataURL
    this.uiIcons = {}; // name -> dataURL (every UI button pixel art!)
    this.crackTextures = []; // 10 stages (0..9) of pixel-art block breaking cracks
    this._iconScratch = document.createElement('canvas');
    this._iconScratch.width = 32;
    this._iconScratch.height = 32;
    this._iconCtx = this._iconScratch.getContext('2d');
    this._iconCtx.imageSmoothingEnabled = false;

    this.canvas = document.createElement('canvas');
    this.canvas.width = ATLAS_COLS * TILE_SIZE;
    this.canvas.height = ATLAS_ROWS * TILE_SIZE;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.nextTile = 0;

    this.buildAtlas();

    this.atlasTexture = new THREE.CanvasTexture(this.canvas);
    this.atlasTexture.magFilter = THREE.NearestFilter;
    this.atlasTexture.minFilter = THREE.NearestFilter;
    this.atlasTexture.colorSpace = THREE.SRGBColorSpace;
    this.atlasTexture.generateMipmaps = false;

    // Procedural LabPBR Companion Atlases (Normal Map + Roughness/Metalness/F0/Emission) preserving 100% of Minecraft pixel art!
    this.buildPBRAtlases();

    // Instant Main Menu startup: HUD & UI icons build immediately (<1ms); 10 crack WebGL textures warm lazily!
    this._gameplayTexReady = false;
    this.buildHudIcons();
    this.buildUiIcons();
  }

  ensureGameplayTextures() {
    if (this._gameplayTexReady) return;
    this._gameplayTexReady = true;
    this.buildCrackTextures();
  }

  addTile(name, drawFn) {
    const idx = this.nextTile++;
    const col = idx % ATLAS_COLS;
    const row = Math.floor(idx / ATLAS_COLS);
    const ox = col * TILE_SIZE;
    const oy = row * TILE_SIZE;
    this.ctx.clearRect(ox, oy, TILE_SIZE, TILE_SIZE);
    drawFn(this.ctx, ox, oy);

    // Slight inset avoids bleeding at tile borders
    const eps = 0.0005;
    const u0 = col / ATLAS_COLS + eps;
    const u1 = (col + 1) / ATLAS_COLS - eps;
    // Flip Y for WebGL UV space (row 0 is top of canvas = v=1)
    const v1 = 1 - row / ATLAS_ROWS - eps;
    const v0 = 1 - (row + 1) / ATLAS_ROWS + eps;

    this.tileMap[name] = { col, row, ox, oy, u0, v0, u1, v1 };
  }

  getUV(name) {
    return this.tileMap[name] || this.tileMap['stone'];
  }

  /**
   * Procedurally synthesizes synchronized 256x256 Tangent-Space Normal Atlas and PBR Material Atlas
   * (R=Roughness, G=Metalness, B=Reflectivity F0, A=Emission) directly from the existing 16x16 pixel-art tiles.
   */
  buildPBRAtlases() {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const src = this.ctx.getImageData(0, 0, W, H).data;

    this.normalCanvas = document.createElement('canvas');
    this.normalCanvas.width = W;
    this.normalCanvas.height = H;
    const nCtx = this.normalCanvas.getContext('2d');
    const nImg = nCtx.createImageData(W, H);
    const nData = nImg.data;

    this.pbrCanvas = document.createElement('canvas');
    this.pbrCanvas.width = W;
    this.pbrCanvas.height = H;
    const pCtx = this.pbrCanvas.getContext('2d');
    const pImg = pCtx.createImageData(W, H);
    const pData = pImg.data;

    // Default neutral normal (0.5, 0.5, 1.0) & matte rough dielectric (R=0.88, M=0, F0=0.04, E=0)
    for (let i = 0; i < W * H * 4; i += 4) {
      nData[i] = 128; nData[i + 1] = 128; nData[i + 2] = 255; nData[i + 3] = 255;
      pData[i] = 224; pData[i + 1] = 0;   pData[i + 2] = 10;  pData[i + 3] = 0;
    }

    const getMatProfile = (name) => {
      if (name === 'iron_block') return { rough: 0.22, metal: 0.94, f0: 0.88, bump: 0.85, emit: 0.0, ore: false };
      if (name === 'gold_block') return { rough: 0.20, metal: 0.96, f0: 0.92, bump: 0.85, emit: 0.05, ore: false };
      if (name === 'diamond_block') return { rough: 0.14, metal: 0.28, f0: 0.82, bump: 0.75, emit: 0.55, ore: false };
      if (name === 'obsidian') return { rough: 0.28, metal: 0.04, f0: 0.22, bump: 1.8, emit: 0.0, ore: false };
      if (name === 'glass') return { rough: 0.08, metal: 0.0, f0: 0.26, bump: 0.4, emit: 0.0, ore: false };
      if (name === 'ice' || name === 'packed_ice') return { rough: 0.14, metal: 0.0, f0: 0.22, bump: 0.8, emit: 0.08, ore: false };
      if (name === 'lava') return { rough: 0.42, metal: 0.0, f0: 0.08, bump: 1.5, emit: 1.0, ore: false };
      if (name === 'glowstone') return { rough: 0.34, metal: 0.0, f0: 0.16, bump: 2.0, emit: 1.0, ore: false };
      if (name === 'torch' || name === 'fire') return { rough: 0.75, metal: 0.0, f0: 0.04, bump: 1.0, emit: 0.85, ore: false };
      if (name === 'stone_bricks' || name === 'cobblestone' || name === 'mossy_cobblestone' || name === 'bricks') {
        return { rough: 0.64, metal: 0.0, f0: 0.09, bump: 2.85, emit: 0.0, ore: false };
      }
      if (name === 'iron_ore' || name === 'gold_ore' || name === 'diamond_ore' || name === 'coal_ore') {
        return { rough: 0.80, metal: 0.0, f0: 0.05, bump: 2.4, emit: name === 'diamond_ore' ? 0.18 : 0.0, ore: true };
      }
      if (name === 'stone' || name === 'bedrock' || name === 'furnace_top' || name === 'furnace_front' || name.startsWith('sandstone') ||
          name.startsWith('deepslate') || name === 'granite' || name === 'diorite' || name === 'andesite' || name === 'tuff' || name.startsWith('basalt')) {
        return { rough: name.startsWith('deepslate') || name.startsWith('basalt') ? 0.72 : 0.78, metal: 0.0, f0: 0.065, bump: 2.3, emit: name === 'furnace_front' ? 0.35 : 0.0, ore: false };
      }
      if (name.includes('planks') || name.includes('door') || name.includes('chest') || name.includes('craft') || name === 'bookshelf') {
        return { rough: 0.72, metal: 0.0, f0: 0.06, bump: 1.95, emit: 0.0, ore: false };
      }
      if (name.includes('log')) {
        return { rough: 0.86, metal: 0.0, f0: 0.04, bump: 2.6, emit: 0.0, ore: false };
      }
      if (name.includes('terracotta')) {
        return { rough: 0.76, metal: 0.0, f0: 0.06, bump: 1.35, emit: 0.0, ore: false };
      }
      if (name === 'snow') {
        return { rough: 0.68, metal: 0.0, f0: 0.10, bump: 0.9, emit: 0.0, ore: false };
      }
      if (name.includes('farmland_wet') || name === 'mud') {
        return { rough: 0.44, metal: 0.0, f0: 0.12, bump: 2.2, emit: 0.0, ore: false };
      }
      // Grass, dirt, sand, leaves, wool, crops: natural matte organic surfaces
      return { rough: 0.89, metal: 0.0, f0: 0.035, bump: 1.65, emit: 0.0, ore: false };
    };

    const hBuf = new Float32Array(16 * 16);
    for (const [name, tile] of Object.entries(this.tileMap)) {
      const prof = getMatProfile(name);
      const ox = tile.ox;
      const oy = tile.oy;

      // 1. Extract tile heightfield from pixel luminance
      for (let ly = 0; ly < 16; ly++) {
        for (let lx = 0; lx < 16; lx++) {
          const p = ((oy + ly) * W + (ox + lx)) * 4;
          const r = src[p] / 255, g = src[p + 1] / 255, b = src[p + 2] / 255;
          hBuf[ly * 16 + lx] = r * 0.299 + g * 0.587 + b * 0.114;
        }
      }

      // 2. Sobel micro-bevel normal + per-texel PBR roughness/metalness/emission modulation!
      for (let ly = 0; ly < 16; ly++) {
        const ym = (ly + 15) & 15;
        const yp = (ly + 1) & 15;
        for (let lx = 0; lx < 16; lx++) {
          const xm = (lx + 15) & 15;
          const xp = (lx + 1) & 15;

          const tl = hBuf[ym * 16 + xm], tc = hBuf[ym * 16 + lx], tr = hBuf[ym * 16 + xp];
          const ml = hBuf[ly * 16 + xm], mc = hBuf[ly * 16 + lx], mr = hBuf[ly * 16 + xp];
          const bl = hBuf[yp * 16 + xm], bc = hBuf[yp * 16 + lx], br = hBuf[yp * 16 + xp];

          const dx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
          const dy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
          let nx = -dx * prof.bump;
          let ny = dy * prof.bump;
          let nz = 1.0;
          const invLen = 1.0 / Math.hypot(nx, ny, nz);
          nx *= invLen; ny *= invLen; nz *= invLen;

          const p = ((oy + ly) * W + (ox + lx)) * 4;
          nData[p] = Math.max(0, Math.min(255, Math.round((nx * 0.5 + 0.5) * 255)));
          nData[p + 1] = Math.max(0, Math.min(255, Math.round((ny * 0.5 + 0.5) * 255)));
          nData[p + 2] = Math.max(0, Math.min(255, Math.round((nz * 0.5 + 0.5) * 255)));
          nData[p + 3] = 255;

          const r = src[p] / 255, g = src[p + 1] / 255, b = src[p + 2] / 255;
          const sat = Math.max(r, g, b) - Math.min(r, g, b);
          // Micro-variation: mortar crevices (darker mc) are rougher, raised bevels are subtly glossier!
          let rough = Math.max(0.06, Math.min(0.98, prof.rough + (0.5 - mc) * 0.24));
          let metal = prof.metal;
          let f0 = prof.f0;
          let emit = prof.emit;

          // Make ore crystal veins sparkle with metallic/gem reflectivity inside rough matte stone!
          if (prof.ore && (sat > 0.14 || (name === 'coal_ore' && mc < 0.22))) {
            rough = name === 'coal_ore' ? 0.42 : 0.18;
            metal = name === 'diamond_ore' ? 0.25 : (name === 'coal_ore' ? 0.08 : 0.85);
            f0 = name === 'coal_ore' ? 0.12 : 0.82;
            emit = name === 'diamond_ore' ? 0.35 : 0.0;
          }
          // Mask emission strictly onto hot glowing texels (lava magma, glowstone crystals, furnace embers, torch flame!)
          if (name === 'furnace_front') {
            emit = (r > 0.72 && r - b > 0.35) ? 0.95 : 0.0;
          } else if (name === 'torch') {
            emit = ly < 6 ? 1.0 : 0.0;
          } else if (name === 'lava') {
            emit = Math.min(1.0, 0.55 + mc * 0.65);
          } else if (name === 'glowstone') {
            emit = Math.min(1.0, 0.45 + mc * 0.72);
          }

          pData[p] = Math.round(rough * 255);
          pData[p + 1] = Math.round(metal * 255);
          pData[p + 2] = Math.round(f0 * 255);
          pData[p + 3] = Math.round(Math.max(0, Math.min(1, emit)) * 255);
        }
      }
    }

    nCtx.putImageData(nImg, 0, 0);
    pCtx.putImageData(pImg, 0, 0);

    this.normalTexture = new THREE.CanvasTexture(this.normalCanvas);
    this.normalTexture.magFilter = THREE.NearestFilter;
    this.normalTexture.minFilter = THREE.NearestFilter;
    this.normalTexture.colorSpace = THREE.NoColorSpace;
    this.normalTexture.generateMipmaps = false;

    this.pbrTexture = new THREE.CanvasTexture(this.pbrCanvas);
    this.pbrTexture.magFilter = THREE.NearestFilter;
    this.pbrTexture.minFilter = THREE.NearestFilter;
    this.pbrTexture.colorSpace = THREE.NoColorSpace;
    this.pbrTexture.generateMipmaps = false;
  }

  buildAtlas() {
    // Helper: Authentic Minecraft Jappa-style stratified stone base (reused by stone & ores!)
    const drawMinecraftStone = (c, x, y, seed = 7) => {
      const tones = ['#686868', '#747474', '#7f7f7f', '#898989', '#949494', '#606060'];
      for (let iy = 0; iy < 16; iy++) {
        // Horizontal sedimentary rock banding like real Minecraft stone
        const band = ((iy * 3 + Math.floor(pxHash(0, iy, seed) * 3)) % 4);
        for (let ix = 0; ix < 16; ix++) {
          const h = pxHash(ix >> 1, iy, seed + band * 7);
          const fine = pxHash(ix, iy, seed + 31);
          let idx = Math.floor(h * 4) + (fine > 0.72 ? 1 : (fine < 0.22 ? -1 : 0));
          idx = Math.max(0, Math.min(tones.length - 1, idx));
          px(c, x, y, ix, iy, tones[idx]);
        }
      }
      // Subtle horizontal strata highlights & crevices
      for (let i = 0; i < 8; i++) {
        const sx = Math.floor(pxHash(i, 1, seed + 9) * 12);
        const sy = Math.floor(pxHash(i, 2, seed + 9) * 16);
        px(c, x, y, sx, sy, i % 2 === 0 ? '#5c5c5c' : '#9c9c9c', 3, 1);
      }
    };

    // Helper: Authentic Minecraft warm clumpy dirt with tiny grey pebble flecks!
    const drawMinecraftDirt = (c, x, y, seed = 3) => {
      const browns = ['#593d29', '#6e4b32', '#7d563a', '#8c6244', '#9c6f4d'];
      for (let iy = 0; iy < 16; iy++) {
        for (let ix = 0; ix < 16; ix++) {
          const clump = pxHash(ix >> 1, iy >> 1, seed);
          const fine = pxHash(ix, iy, seed + 17);
          if (fine > 0.935) {
            px(c, x, y, ix, iy, '#8f8b85'); // authentic Minecraft little stone pebble in dirt!
          } else {
            const idx = Math.min(4, Math.max(0, Math.floor((clump * 0.6 + fine * 0.4) * 5)));
            px(c, x, y, ix, iy, browns[idx]);
          }
        }
      }
    };

    // Authentic Minecraft Lush Grass Top (rich mottled meadow green!)
    this.addTile('grass_top', (c, x, y) => {
      const greens = ['#4e802d', '#5b9235', '#68a43e', '#75b548', '#81c251'];
      for (let iy = 0; iy < 16; iy++) {
        for (let ix = 0; ix < 16; ix++) {
          const clump = pxHash(ix >> 1, iy >> 1, 1);
          const fine = pxHash(ix, iy, 2);
          const idx = Math.min(4, Math.max(0, Math.floor((clump * 0.55 + fine * 0.45) * 5)));
          px(c, x, y, ix, iy, greens[idx]);
        }
      }
    });

    this.addTile('dirt', (c, x, y) => drawMinecraftDirt(c, x, y, 3));

    // Authentic Minecraft Grass Side: hanging irregular grass overhang + dark edge shadow over dirt!
    this.addTile('grass_side', (c, x, y) => {
      drawMinecraftDirt(c, x, y, 5);
      const fringe = [4, 5, 3, 4, 6, 4, 3, 5, 4, 3, 5, 6, 4, 3, 4, 5];
      for (let ix = 0; ix < 16; ix++) {
        const drop = fringe[ix];
        for (let iy = 0; iy < drop; iy++) {
          const h = pxHash(ix, iy, 6);
          const col = iy === 0 ? (h > 0.5 ? '#75b548' : '#68a43e')
            : (iy === drop - 1 ? '#457326' : (h > 0.5 ? '#5b9235' : '#4e802d'));
          px(c, x, y, ix, iy, col);
        }
        // Subtle dark soil shadow tucked directly under the grass lip
        if (drop < 16) px(c, x, y, ix, drop, '#4f3522');
      }
    });

    this.addTile('stone', (c, x, y) => drawMinecraftStone(c, x, y, 7));

    // Authentic Minecraft Cobblestone (interlocking rounded masonry stones with bevel highlights & crevices!)
    this.addTile('cobblestone', (c, x, y) => {
      c.fillStyle = '#474747';
      c.fillRect(x, y, 16, 16);
      const stones = [
        [0, 0, 7, 4], [8, 0, 8, 5],
        [0, 5, 4, 4], [5, 5, 6, 5], [12, 6, 4, 4],
        [0, 10, 6, 5], [7, 11, 5, 4], [13, 11, 3, 4]
      ];
      stones.forEach(([sx, sy, sw, sh], i) => {
        const base = i % 3 === 0 ? '#7d7d7d' : (i % 3 === 1 ? '#8a8a8a' : '#707070');
        const hi = i % 2 === 0 ? '#9e9e9e' : '#a8a8a8';
        const lo = '#5c5c5c';
        px(c, x, y, sx, sy, base, sw, sh);
        px(c, x, y, sx, sy, hi, Math.max(1, sw - 1), 1);
        px(c, x, y, sx, sy, hi, 1, Math.max(1, sh - 1));
        px(c, x, y, sx, sy + sh - 1, lo, sw, 1);
        px(c, x, y, sx + sw - 1, sy + 1, lo, 1, Math.max(1, sh - 1));
      });
    });

    this.addTile('bedrock', (c, x, y) => {
      const cols = ['#1f1f23', '#2e2e33', '#42424a', '#575761', '#141417'];
      for (let iy = 0; iy < 16; iy++) {
        for (let ix = 0; ix < 16; ix++) {
          const h = pxHash(ix >> 1, iy, 11);
          const f = pxHash(ix, iy, 12);
          px(c, x, y, ix, iy, cols[Math.floor((h * 0.65 + f * 0.35) * 5)]);
        }
      }
    });

    // Authentic Minecraft Warm Wind-Rippled Sand!
    this.addTile('sand', (c, x, y) => {
      const sands = ['#d5c48c', '#dfd19c', '#e6daa8', '#ede3b4', '#c9b77d'];
      for (let iy = 0; iy < 16; iy++) {
        for (let ix = 0; ix < 16; ix++) {
          const wave = Math.sin((ix * 0.55 + iy * 0.9)) * 0.5 + 0.5;
          const h = pxHash(ix, iy, 12);
          const idx = Math.min(4, Math.max(0, Math.floor((wave * 0.5 + h * 0.5) * 5)));
          px(c, x, y, ix, iy, sands[idx]);
        }
      }
    });

    this.addTile('gravel', (c, x, y) => {
      const cols = ['#63605e', '#787472', '#8a8684', '#9e9a97', '#54514f'];
      for (let iy = 0; iy < 16; iy++) {
        for (let ix = 0; ix < 16; ix++) {
          px(c, x, y, ix, iy, cols[Math.floor(pxHash(ix, iy, 13) * 5)]);
        }
      }
    });

    this.addTile('sandstone_top', (c, x, y) => {
      fillNoise(c, x, y, '#dfd19c', 9, 14);
      px(c, x, y, 0, 0, '#c7b57c', 16, 1);
      px(c, x, y, 0, 15, '#c7b57c', 16, 1);
    });
    this.addTile('sandstone_side', (c, x, y) => {
      fillNoise(c, x, y, '#d9c88c', 9, 15);
      px(c, x, y, 0, 0, '#e8dca8', 16, 2);
      px(c, x, y, 0, 3, '#baa568', 16, 1);
      px(c, x, y, 0, 10, '#c2ad6f', 16, 1);
      px(c, x, y, 0, 14, '#b39d62', 16, 2);
    });

    this.addTile('water', (c, x, y) => {
      c.fillStyle = 'rgba(42, 118, 224, 0.72)';
      c.fillRect(x, y, 16, 16);
      for (let i = 0; i < 16; i++) {
        px(c, x, y, Math.floor(pxHash(i, 1, 16) * 14), Math.floor(pxHash(i, 2, 16) * 16), 'rgba(130, 195, 255, 0.45)', 3, 1);
      }
    });

    // Authentic Minecraft Logs (vertical grooved bark!), Ringed Log Tops, Detailed Wood Planks & Lush Leaves
    const drawLogSide = (c, x, y, base, dark, light, s) => {
      fillNoise(c, x, y, base, 9, s);
      for (let ix = 0; ix < 16; ix++) {
        if (ix % 4 === 0) {
          for (let iy = 0; iy < 16; iy++) {
            px(c, x, y, ix, iy, pxHash(ix, iy, s + 3) > 0.25 ? dark : base);
          }
        } else if (ix % 4 === 2) {
          for (let iy = 0; iy < 16; iy++) {
            if (pxHash(ix, iy, s + 5) > 0.45) px(c, x, y, ix, iy, light);
          }
        }
      }
    };
    const drawLogTop = (c, x, y, bark, mid, inner, s) => {
      fillNoise(c, x, y, bark, 8, s);
      px(c, x, y, 2, 2, inner, 12, 12);
      px(c, x, y, 3, 3, mid, 10, 10);
      px(c, x, y, 4, 4, inner, 8, 8);
      px(c, x, y, 6, 6, mid, 4, 4);
      px(c, x, y, 7, 7, bark, 2, 2);
    };
    const drawPlanks = (c, x, y, base, hi, lo, line, s) => {
      for (let iy = 0; iy < 16; iy++) {
        const isSeam = (iy % 4 === 0);
        const isTop = (iy % 4 === 1);
        const isBot = (iy % 4 === 3);
        for (let ix = 0; ix < 16; ix++) {
          if (isSeam) {
            px(c, x, y, ix, iy, line);
          } else {
            const h = pxHash(ix >> 1, iy, s);
            const col = isTop ? (h > 0.4 ? hi : base) : (isBot ? (h > 0.4 ? lo : base) : (h > 0.65 ? hi : (h < 0.25 ? lo : base)));
            px(c, x, y, ix, iy, col);
          }
        }
      }
      // Staggered plank vertical end-joints
      px(c, x, y, 7, 0, line, 1, 4); px(c, x, y, 8, 1, hi, 1, 2);
      px(c, x, y, 13, 4, line, 1, 4); px(c, x, y, 14, 5, hi, 1, 2);
      px(c, x, y, 4, 8, line, 1, 4); px(c, x, y, 5, 9, hi, 1, 2);
      px(c, x, y, 10, 12, line, 1, 4); px(c, x, y, 11, 13, hi, 1, 2);
    };
    const drawLeaves = (c, x, y, hi, mid, lo, s) => {
      for (let iy = 0; iy < 16; iy++) {
        for (let ix = 0; ix < 16; ix++) {
          const clump = pxHash(ix >> 1, iy >> 1, s);
          const fine = pxHash(ix, iy, s + 9);
          const v = clump * 0.5 + fine * 0.5;
          if (v > 0.22) {
            px(c, x, y, ix, iy, v > 0.72 ? hi : (v > 0.42 ? mid : lo));
          }
        }
      }
    };

    this.addTile('oak_log_side', (c, x, y) => drawLogSide(c, x, y, '#6b5134', '#4a351e', '#826543', 20));
    this.addTile('oak_log_top', (c, x, y) => drawLogTop(c, x, y, '#594228', '#99774d', '#ba9665', 21));
    this.addTile('oak_planks', (c, x, y) => drawPlanks(c, x, y, '#b58d59', '#c7a069', '#9e7747', '#6e502c', 22));
    this.addTile('oak_leaves', (c, x, y) => drawLeaves(c, x, y, '#5ca834', '#438525', '#2a5916', 23));

    this.addTile('birch_log_side', (c, x, y) => {
      fillNoise(c, x, y, '#e6e3db', 8, 24);
      const knots = [[1,2,4],[9,5,5],[3,8,3],[11,11,4],[2,13,5],[7,1,3],[12,7,3]];
      for (const [kx, ky, kw] of knots) {
        px(c, x, y, kx, ky, '#343638', kw, 1);
        px(c, x, y, kx + 1, ky + 1, '#6b6d70', Math.max(1, kw - 2), 1);
      }
    });
    this.addTile('birch_log_top', (c, x, y) => drawLogTop(c, x, y, '#d8d4ca', '#bfa77a', '#d6c194', 26));
    this.addTile('birch_planks', (c, x, y) => drawPlanks(c, x, y, '#d4c08d', '#e3d1a1', '#bfa977', '#8c7950', 27));
    this.addTile('birch_leaves', (c, x, y) => drawLeaves(c, x, y, '#79ba47', '#5c9933', '#3e6e20', 28));

    this.addTile('spruce_log_side', (c, x, y) => drawLogSide(c, x, y, '#473322', '#2b1d12', '#5c432d', 29));
    this.addTile('spruce_log_top', (c, x, y) => drawLogTop(c, x, y, '#3d2a1b', '#6e5033', '#8c6945', 30));
    this.addTile('spruce_planks', (c, x, y) => drawPlanks(c, x, y, '#785535', '#8c6642', '#634428', '#452e1a', 31));
    this.addTile('spruce_leaves', (c, x, y) => drawLeaves(c, x, y, '#3f784c', '#2c5937', '#1a3b23', 32));

    // Cactus, Snow, Ice
    this.addTile('cactus_side', (c, x, y) => {
      fillNoise(c, x, y, '#3f8a33', 10, 33);
      for (const cx of [3, 8, 13]) {
        px(c, x, y, cx, 0, '#296120', 1, 16);
        px(c, x, y, cx + 1, 0, '#54a644', 1, 16);
      }
      for (const [sx, sy] of [[2,3],[7,9],[12,5],[2,12],[12,13]]) px(c, x, y, sx, sy, '#193b14');
    });
    this.addTile('cactus_top', (c, x, y) => {
      fillNoise(c, x, y, '#4ca13d', 10, 34);
      px(c, x, y, 3, 3, '#2d6b23', 10, 10);
      px(c, x, y, 5, 5, '#5bb54a', 6, 6);
    });
    this.addTile('snow', (c, x, y) => {
      fillNoise(c, x, y, '#f0f7fc', 6, 35);
      for (let i = 0; i < 10; i++) {
        px(c, x, y, Math.floor(pxHash(i, 1, 36) * 14), Math.floor(pxHash(i, 2, 36) * 16), '#d9ebf7', 2, 1);
      }
    });
    this.addTile('ice', (c, x, y) => {
      c.fillStyle = 'rgba(135, 200, 250, 0.78)';
      c.fillRect(x, y, 16, 16);
      px(c, x, y, 2, 2, 'rgba(255,255,255,0.65)', 5, 1);
      px(c, x, y, 3, 3, 'rgba(255,255,255,0.45)', 3, 1);
      px(c, x, y, 9, 10, 'rgba(255,255,255,0.55)', 5, 1);
      px(c, x, y, 10, 11, 'rgba(255,255,255,0.35)', 3, 1);
    });

    // Authentic Minecraft Crystalline Ores Embedded in Stratified Stone!
    const drawOre = (c, x, y, dark, mid, hi, s) => {
      drawMinecraftStone(c, x, y, s);
      const clusters = [[2,3],[10,2],[6,7],[11,11],[3,11]];
      for (const [ox, oy] of clusters) {
        px(c, x, y, ox, oy + 1, '#525252', 3, 2); // stone recess shadow
        px(c, x, y, ox, oy, dark, 3, 2);
        px(c, x, y, ox, oy, mid, 2, 2);
        px(c, x, y, ox, oy, hi, 1, 1);
      }
    };
    this.addTile('coal_ore', (c, x, y) => drawOre(c, x, y, '#141518', '#25272e', '#454954', 40));
    this.addTile('iron_ore', (c, x, y) => drawOre(c, x, y, '#8f674b', '#d4a685', '#f2d5bc', 41));
    this.addTile('gold_ore', (c, x, y) => drawOre(c, x, y, '#b57b12', '#f5c731', '#fff59d', 42));
    this.addTile('diamond_ore', (c, x, y) => drawOre(c, x, y, '#149ba6', '#3ee6ed', '#d4feff', 43));

    // Utility blocks
    this.addTile('craft_top', (c, x, y) => {
      fillNoise(c, x, y, '#b58852', 9, 44);
      px(c, x, y, 0, 0, '#6e4d26', 16, 1); px(c, x, y, 0, 15, '#6e4d26', 16, 1);
      px(c, x, y, 0, 0, '#6e4d26', 1, 16); px(c, x, y, 15, 0, '#6e4d26', 1, 16);
      px(c, x, y, 5, 1, '#543819', 1, 14); px(c, x, y, 10, 1, '#543819', 1, 14);
      px(c, x, y, 1, 5, '#543819', 14, 1); px(c, x, y, 1, 10, '#543819', 14, 1);
      px(c, x, y, 2, 2, '#cfa36b', 2, 1); px(c, x, y, 7, 7, '#cfa36b', 2, 1);
    });
    this.addTile('craft_side', (c, x, y) => {
      drawPlanks(c, x, y, '#a87d4a', '#bd925c', '#8c6538', '#5e4120', 45);
      px(c, x, y, 0, 0, '#61411d', 16, 2);
      px(c, x, y, 3, 4, '#2b2e33', 3, 7); px(c, x, y, 4, 4, '#d8e0e8', 2, 6); // saw
      px(c, x, y, 10, 4, '#3b2410', 3, 7); px(c, x, y, 11, 5, '#784e26', 1, 5); px(c, x, y, 9, 4, '#b8c0cc', 4, 2); // hammer
    });
    this.addTile('furnace_top', (c, x, y) => {
      drawMinecraftStone(c, x, y, 46);
      px(c, x, y, 0, 0, '#4f5258', 16, 1); px(c, x, y, 0, 15, '#4f5258', 16, 1);
      px(c, x, y, 0, 0, '#4f5258', 1, 16); px(c, x, y, 15, 0, '#4f5258', 1, 16);
    });
    this.addTile('furnace_front', (c, x, y) => {
      drawMinecraftStone(c, x, y, 47);
      px(c, x, y, 2, 2, '#3d3f45', 12, 5); px(c, x, y, 3, 3, '#1a1a1e', 10, 3);
      px(c, x, y, 3, 9, '#3d3f45', 10, 5); px(c, x, y, 4, 10, '#1a1a1e', 8, 3);
      px(c, x, y, 5, 11, '#ff7b29', 6, 2); px(c, x, y, 6, 11, '#ffe066', 4, 1);
    });
    this.addTile('chest_top', (c, x, y) => {
      drawPlanks(c, x, y, '#a87838', '#bd8c4a', '#8c6129', '#4a3112', 48);
      px(c, x, y, 0, 0, '#4a3112', 16, 1); px(c, x, y, 0, 15, '#4a3112', 16, 1);
      px(c, x, y, 0, 0, '#4a3112', 1, 16); px(c, x, y, 15, 0, '#4a3112', 1, 16);
    });
    this.addTile('chest_front', (c, x, y) => {
      drawPlanks(c, x, y, '#a87838', '#bd8c4a', '#8c6129', '#4a3112', 49);
      px(c, x, y, 0, 0, '#4a3112', 16, 1); px(c, x, y, 0, 15, '#4a3112', 16, 1);
      px(c, x, y, 0, 6, '#36230c', 16, 1);
      px(c, x, y, 6, 4, '#2b2b2b', 4, 5);
      px(c, x, y, 7, 5, '#e8ecf0', 2, 3);
      px(c, x, y, 7, 7, '#8f96a0', 2, 1);
    });

    // Building & Decorative
    this.addTile('glass', (c, x, y) => {
      c.fillStyle = 'rgba(205, 238, 255, 0.24)';
      c.fillRect(x, y, 16, 16);
      px(c, x, y, 0, 0, '#b8e0f2', 16, 1); px(c, x, y, 0, 15, '#b8e0f2', 16, 1);
      px(c, x, y, 0, 0, '#b8e0f2', 1, 16); px(c, x, y, 15, 0, '#b8e0f2', 1, 16);
      px(c, x, y, 3, 2, 'rgba(255,255,255,0.8)', 2, 1);
      px(c, x, y, 2, 3, 'rgba(255,255,255,0.8)', 1, 2);
      px(c, x, y, 12, 12, 'rgba(255,255,255,0.65)', 2, 1);
    });
    this.addTile('bricks', (c, x, y) => {
      fillNoise(c, x, y, '#9c4a3b', 12, 50);
      for (let iy = 0; iy < 16; iy += 4) {
        px(c, x, y, 0, iy, '#c8c4bc', 16, 1);
        px(c, x, y, 0, iy + 1, '#b55c4a', 16, 1);
      }
      for (let iy = 0; iy < 16; iy += 4) {
        const off = (iy % 8 === 0) ? 0 : 4;
        for (let ix = off; ix < 16; ix += 8) px(c, x, y, ix, iy, '#c8c4bc', 1, 4);
      }
    });
    this.addTile('tnt_top', (c, x, y) => {
      fillNoise(c, x, y, '#b83227', 10, 51);
      for (let ix = 0; ix < 16; ix += 4) px(c, x, y, ix, 0, '#8c2219', 1, 16);
      px(c, x, y, 5, 5, '#2b2b2b', 6, 6);
      px(c, x, y, 7, 7, '#6b6b6b', 2, 2);
    });
    this.addTile('tnt_side', (c, x, y) => {
      fillNoise(c, x, y, '#c9382b', 10, 52);
      for (let ix = 0; ix < 16; ix += 4) px(c, x, y, ix, 0, '#94251c', 1, 16);
      px(c, x, y, 0, 5, '#f2eee6', 16, 6);
      px(c, x, y, 0, 10, '#d4cfc5', 16, 1);
      px(c, x, y, 2, 6, '#1a1a1a', 3, 1); px(c, x, y, 3, 7, '#1a1a1a', 1, 3);
      px(c, x, y, 6, 6, '#1a1a1a', 1, 4); px(c, x, y, 7, 7, '#1a1a1a', 1, 1); px(c, x, y, 8, 6, '#1a1a1a', 1, 4);
      px(c, x, y, 10, 6, '#1a1a1a', 3, 1); px(c, x, y, 11, 7, '#1a1a1a', 1, 3);
    });
    this.addTile('torch', (c, x, y) => {
      px(c, x, y, 7, 6, '#7a522d', 2, 10);
      px(c, x, y, 7, 6, '#9e6d3d', 1, 10);
      px(c, x, y, 6, 4, '#e65100', 4, 3);
      px(c, x, y, 6, 3, '#ff9800', 4, 3);
      px(c, x, y, 7, 2, '#fff59d', 2, 3);
      px(c, x, y, 7, 2, '#ffffff', 1, 1);
    });
    this.addTile('bookshelf', (c, x, y) => {
      drawPlanks(c, x, y, '#b08652', '#c49b66', '#8f6a3c', '#5e4221', 53);
      const colors = ['#c62828', '#1565c0', '#2e7d32', '#f9a825', '#6a1b9a', '#d84315', '#00838f'];
      for (const shelf of [2, 9]) {
        px(c, x, y, 1, shelf, '#261b12', 14, 5);
        for (let ix = 1; ix < 15; ix += 2) {
          const col = colors[(ix + shelf) % colors.length];
          px(c, x, y, ix, shelf + 1, col, 2, 4);
          px(c, x, y, ix, shelf + 2, '#f5ecd7', 2, 1); // gold/white spine stripe
        }
      }
    });

    this.addTile('wool_white', (c, x, y) => fillNoise(c, x, y, '#eceef0', 10, 60));
    this.addTile('wool_red', (c, x, y) => fillNoise(c, x, y, '#c73434', 12, 61));
    this.addTile('wool_blue', (c, x, y) => fillNoise(c, x, y, '#325cc7', 12, 62));
    this.addTile('wool_green', (c, x, y) => fillNoise(c, x, y, '#3c8f3c', 12, 63));
    this.addTile('wool_yellow', (c, x, y) => fillNoise(c, x, y, '#e6c832', 12, 64));

    this.addTile('obsidian', (c, x, y) => {
      fillNoise(c, x, y, '#1b1429', 14, 65);
      for (let i = 0; i < 12; i++) {
        px(c, x, y, Math.floor(pxHash(i, 1, 65) * 14), Math.floor(pxHash(i, 2, 65) * 14), '#3b245e', 2, 2);
      }
    });
    this.addTile('glowstone', (c, x, y) => {
      fillNoise(c, x, y, '#d4a33b', 22, 66);
      for (let i = 0; i < 18; i++) {
        px(c, x, y, Math.floor(pxHash(i, 1, 67) * 14), Math.floor(pxHash(i, 2, 67) * 14), i % 3 === 0 ? '#8c5e16' : '#fff5b5', 2, 2);
      }
    });

    // Authentic Minecraft Tall Grass, Poppy & Oxeye Daisy/Dandelion!
    this.addTile('tall_grass', (c, x, y) => {
      const blades = [[2,9],[4,11],[6,13],[8,10],[10,12],[12,8],[14,10]];
      for (const [bx, h] of blades) {
        px(c, x, y, bx, 16 - h, '#4c8f2f', 2, h);
        px(c, x, y, bx, 16 - h, '#78c449', 1, Math.min(5, h));
        px(c, x, y, bx + 1, 16 - Math.floor(h * 0.5), '#386e20', 1, Math.floor(h * 0.5));
      }
    });
    this.addTile('flower_red', (c, x, y) => {
      px(c, x, y, 7, 8, '#3a8224', 2, 8);
      px(c, x, y, 5, 11, '#58a836', 2, 2); px(c, x, y, 9, 10, '#58a836', 2, 2);
      px(c, x, y, 5, 3, '#b81d1d', 6, 6);
      px(c, x, y, 6, 4, '#ef3b3b', 4, 4);
      px(c, x, y, 5, 4, '#ff6b6b', 2, 2);
      px(c, x, y, 7, 5, '#261a1a', 2, 2);
    });
    this.addTile('flower_yellow', (c, x, y) => {
      // Crisp Minecraft Meadow Daisy / Dandelion cluster!
      px(c, x, y, 7, 8, '#3a8224', 2, 8);
      px(c, x, y, 5, 11, '#58a836', 2, 2); px(c, x, y, 9, 12, '#58a836', 2, 2);
      px(c, x, y, 5, 3, '#f5c71a', 6, 6);
      px(c, x, y, 6, 2, '#fff59d', 4, 8);
      px(c, x, y, 4, 4, '#fff59d', 8, 4);
      px(c, x, y, 7, 5, '#e68a00', 2, 2);
    });

    this.addTile('bed_top', (c, x, y) => {
      // Cozy quilted red blanket + crisp white pillow & folded sheet trim!
      fillNoise(c, x, y, '#c92e2e', 10, 76);
      // Shaded white pillow at head (y=0..4)
      px(c, x, y, 0, 0, '#7c5329', 16, 1);
      px(c, x, y, 1, 1, '#dce3eb', 14, 4);
      px(c, x, y, 2, 1, '#ffffff', 12, 3);
      px(c, x, y, 2, 4, '#b8c4d0', 12, 1);
      // Folded white sheet collar (y=5..6)
      px(c, x, y, 0, 5, '#edf2f7', 16, 2);
      px(c, x, y, 0, 6, '#c2ccd6', 16, 1);
      // Quilted crimson blanket shading & bottom wood rail
      px(c, x, y, 0, 7, '#e04242', 16, 1);
      for (let qy = 9; qy < 14; qy += 3) {
        px(c, x, y, 1, qy, '#a31e1e', 14, 1);
      }
      px(c, x, y, 0, 15, '#7c5329', 16, 1);
    });
    this.addTile('bed_side', (c, x, y) => {
      // Side trim: white sheet edge + red blanket drape + oak bedframe
      px(c, x, y, 0, 0, '#f2f5f8', 5, 6);
      px(c, x, y, 5, 0, '#c92e2e', 11, 7);
      px(c, x, y, 5, 5, '#9e1c1c', 11, 2);
      px(c, x, y, 0, 7, '#8f6032', 16, 5);
      px(c, x, y, 0, 7, '#a87442', 16, 1);
      px(c, x, y, 0, 11, '#5e3c1c', 16, 5);
    });

    this.addTile('stone_bricks', (c, x, y) => {
      fillNoise(c, x, y, '#848890', 12, 71);
      px(c, x, y, 0, 7, '#585b61', 16, 1);
      px(c, x, y, 0, 15, '#585b61', 16, 1);
      px(c, x, y, 7, 0, '#585b61', 1, 7);
      px(c, x, y, 15, 8, '#585b61', 1, 8);
    });
    this.addTile('iron_block', (c, x, y) => {
      fillNoise(c, x, y, '#d8dce0', 8, 72);
      px(c, x, y, 0, 0, '#aeb5bd', 16, 1);
      px(c, x, y, 0, 15, '#aeb5bd', 16, 1);
    });
    this.addTile('gold_block', (c, x, y) => {
      fillNoise(c, x, y, '#f7d147', 10, 73);
      px(c, x, y, 0, 0, '#c99f22', 16, 1);
      px(c, x, y, 0, 15, '#c99f22', 16, 1);
    });
    this.addTile('diamond_block', (c, x, y) => {
      fillNoise(c, x, y, '#5be8ed', 10, 74);
      px(c, x, y, 0, 0, '#36b5ba', 16, 1);
      px(c, x, y, 0, 15, '#36b5ba', 16, 1);
    });
    // Crisp shaded Minecraft Wooden Ladder (2 sturdy oak rails + 4 bevelled rungs matching Screenshot 1!)
    this.addTile('ladder', (c, x, y) => {
      // Left & right vertical rails with warm highlight & shadow edges
      px(c, x, y, 2, 0, '#6e4c26', 1, 16);
      px(c, x, y, 3, 0, '#a67b45', 1, 16);
      px(c, x, y, 12, 0, '#a67b45', 1, 16);
      px(c, x, y, 13, 0, '#6e4c26', 1, 16);
      // 4 horizontal wooden rungs with bright sunlit top & deep underside shadow!
      for (const iy of [1, 5, 9, 13]) {
        px(c, x, y, 1, iy, '#c99c5e', 14, 1);
        px(c, x, y, 1, iy + 1, '#8c6334', 14, 1);
        px(c, x, y, 2, iy + 2, '#4d3216', 12, 1);
        // Subtle wood-grain nail dots where rungs cross side rails
        px(c, x, y, 2, iy, '#7a5429', 1, 2);
        px(c, x, y, 13, iy, '#7a5429', 1, 2);
      }
    });
    // Clean, authentic Minecraft furrowed Farmland (no harsh grainy noise!)
    this.addTile('farmland_top', (c, x, y) => {
      const soil = ['#7c5534', '#724d2e', '#865d3a'];
      for (let iy = 0; iy < 16; iy++) {
        const isFurrow = iy % 4 === 1;
        const isRidge = iy % 4 === 2;
        for (let ix = 0; ix < 16; ix++) {
          const idx = Math.floor(pxHash(ix >> 1, iy, 75) * soil.length);
          px(c, x, y, ix, iy, isFurrow ? '#52351d' : (isRidge ? '#8c6340' : soil[idx]));
        }
      }
    });
    // Rich dark moist Hydrated Farmland (water within 4 blocks)
    this.addTile('farmland_wet_top', (c, x, y) => {
      const soil = ['#3e2512', '#351f0f', '#462a16'];
      for (let iy = 0; iy < 16; iy++) {
        const isFurrow = iy % 4 === 1;
        const isRidge = iy % 4 === 2;
        for (let ix = 0; ix < 16; ix++) {
          const idx = Math.floor(pxHash(ix >> 1, iy, 76) * soil.length);
          px(c, x, y, ix, iy, isFurrow ? '#221308' : (isRidge ? '#4d3019' : soil[idx]));
        }
      }
    });
    // Authentic Minecraft Shovel Dirt Path (warm golden-tan packed road top + path side rim!)
    this.addTile('dirt_path_top', (c, x, y) => {
      const tans = ['#947840', '#9f8248', '#a98c50', '#8b6f39', '#b59859'];
      for (let iy = 0; iy < 16; iy++) {
        for (let ix = 0; ix < 16; ix++) {
          const clump = pxHash(ix >> 1, iy >> 1, 141);
          const fine = pxHash(ix, iy, 142);
          if (fine > 0.91) {
            px(c, x, y, ix, iy, '#7a5f32'); // compacted dirt speck
          } else {
            const idx = Math.min(tans.length - 1, Math.floor((clump * 0.65 + fine * 0.35) * tans.length));
            px(c, x, y, ix, iy, tans[idx]);
          }
        }
      }
    });
    this.addTile('dirt_path_side', (c, x, y) => {
      drawMinecraftDirt(c, x, y, 143);
      for (let ix = 0; ix < 16; ix++) {
        const lipH = 2 + (pxHash(ix, 0, 144) > 0.45 ? 1 : 0);
        for (let iy = 0; iy < lipH; iy++) {
          px(c, x, y, ix, iy, iy === 0 ? '#b39557' : (iy === 1 ? '#9c7f45' : '#856936'));
        }
      }
    });
    // 8 Authentic Progressive Minecraft Wheat Growth Stages (0=tiny sprout .. 7=lush golden ripe wheat!)
    for (let st = 0; st <= 7; st++) {
      this.addTile(`wheat_stage_${st}`, (c, x, y) => {
        const stemCols = [2, 5, 8, 11, 13];
        const maxH = [3, 5, 7, 9, 11, 13, 14, 15][st];
        const ripe = st >= 5;
        const fullGold = st === 7;
        for (let si = 0; si < stemCols.length; si++) {
          const sx = stemCols[si];
          const jitter = ((si * 3 + st) % 3) - 1;
          const h = Math.max(2, Math.min(15, maxH + (st >= 2 ? jitter : 0)));
          const topY = 16 - h;
          for (let py = topY; py < 16; py++) {
            const frac = (py - topY) / Math.max(1, h);
            let col;
            if (fullGold) {
              col = frac < 0.42 ? ((py & 1) ? '#f0cf52' : '#d6a82d') : (frac < 0.72 ? '#b88c24' : '#7a6820');
            } else if (ripe) {
              col = frac < (st === 6 ? 0.55 : 0.30) ? '#e3bd42' : (frac < 0.7 ? '#729e2e' : '#4a7a1d');
            } else {
              col = frac < 0.35 ? '#72c938' : (frac < 0.7 ? '#4ea324' : '#357a16');
            }
            px(c, x, y, sx, py, col);
            // Fuller golden wheat heads & side blades on higher stages!
            if (st >= 3 && py > topY + 1 && py < 15 && ((py + si) & 1) === 0) {
              const sideX = sx + ((si & 1) ? 1 : -1);
              if (sideX >= 0 && sideX < 16) {
                px(c, x, y, sideX, py, fullGold ? (frac < 0.48 ? '#e3b739' : '#9c781d') : (ripe && frac < 0.35 ? '#d4ac35' : '#57a828'));
              }
            }
          }
          // Bright sunlit tip pixel on ripe wheat ears
          if (st >= 6 && topY >= 0 && topY < 16) {
            px(c, x, y, sx, topY, '#fff099');
          }
        }
      });
    }

    // --- NEW BIOME BLOCK TEXTURES ---
    // Acacia (warm grey bark + vibrant orange heartwood & dry savanna canopy)
    this.addTile('acacia_log_side', (c, x, y) => drawLogSide(c, x, y, '#6e685f', '#4d4841', '#8a8378', 81));
    this.addTile('acacia_log_top', (c, x, y) => drawLogTop(c, x, y, '#69625a', '#b86233', '#d47944', 82));
    this.addTile('acacia_planks', (c, x, y) => drawPlanks(c, x, y, '#bd6435', '#d47a46', '#9e4e24', '#6b3315', 83));
    this.addTile('acacia_leaves', (c, x, y) => drawLeaves(c, x, y, '#8ba836', '#6d8a25', '#4c6318', 84));

    // Jungle (moss-flecked warm brown bark + dense emerald canopy)
    this.addTile('jungle_log_side', (c, x, y) => {
      drawLogSide(c, x, y, '#5c4b2e', '#3d311c', '#735f3c', 85);
      for (let i = 0; i < 8; i++) {
        px(c, x, y, Math.floor(pxHash(i, 1, 86) * 14), Math.floor(pxHash(i, 2, 86) * 14), '#4d7a2b', 2, 1);
      }
    });
    this.addTile('jungle_log_top', (c, x, y) => drawLogTop(c, x, y, '#544428', '#9c714e', '#bd8e66', 87));
    this.addTile('jungle_planks', (c, x, y) => drawPlanks(c, x, y, '#a87852', '#bf8c63', '#8c603e', '#5e3d24', 88));
    this.addTile('jungle_leaves', (c, x, y) => drawLeaves(c, x, y, '#38a832', '#268522', '#175916', 89));

    // Cherry Blossom (deep plum-brown bark + pale sakura planks + lush pink petals!)
    this.addTile('cherry_log_side', (c, x, y) => drawLogSide(c, x, y, '#472a36', '#2e1821', '#633c4c', 90));
    this.addTile('cherry_log_top', (c, x, y) => drawLogTop(c, x, y, '#472a36', '#e3a8b8', '#f5c9d5', 91));
    this.addTile('cherry_planks', (c, x, y) => drawPlanks(c, x, y, '#ebb6c4', '#f7ccd8', '#d69cac', '#a66d7e', 92));
    this.addTile('cherry_leaves', (c, x, y) => drawLeaves(c, x, y, '#ffd9e8', '#f59ec0', '#d96c98', 93));

    // Badlands Red Sand & Stratified Terracotta
    this.addTile('red_sand', (c, x, y) => {
      const sands = ['#b85828', '#c96532', '#d6733e', '#e0814c', '#a34a1f'];
      for (let iy = 0; iy < 16; iy++) {
        for (let ix = 0; ix < 16; ix++) {
          const wave = Math.sin((ix * 0.55 + iy * 0.9)) * 0.5 + 0.5;
          const h = pxHash(ix, iy, 94);
          px(c, x, y, ix, iy, sands[Math.min(4, Math.max(0, Math.floor((wave * 0.5 + h * 0.5) * 5)))]);
        }
      }
    });
    const drawTerracotta = (c, x, y, base, hi, lo, s) => {
      fillNoise(c, x, y, base, 7, s);
      for (let iy = 0; iy < 16; iy += 4) {
        px(c, x, y, 0, iy, iy % 8 === 0 ? hi : lo, 16, 1);
      }
    };
    this.addTile('terracotta', (c, x, y) => drawTerracotta(c, x, y, '#9c6248', '#ad7256', '#855038', 95));
    this.addTile('terracotta_red', (c, x, y) => drawTerracotta(c, x, y, '#943c2e', '#ab4b3b', '#7a2e22', 96));
    this.addTile('terracotta_orange', (c, x, y) => drawTerracotta(c, x, y, '#b85c28', '#cf6e36', '#99491c', 97));
    this.addTile('terracotta_yellow', (c, x, y) => drawTerracotta(c, x, y, '#c48d29', '#d9a138', '#a3721c', 98));

    // Mossy Cobblestone (cobble laced with vivid forest moss!)
    this.addTile('mossy_cobblestone', (c, x, y) => {
      c.fillStyle = '#3c5426';
      c.fillRect(x, y, 16, 16);
      const stones = [
        [0, 0, 7, 4], [8, 0, 8, 5],
        [0, 5, 4, 4], [5, 5, 6, 5], [12, 6, 4, 4],
        [0, 10, 6, 5], [7, 11, 5, 4], [13, 11, 3, 4]
      ];
      stones.forEach(([sx, sy, sw, sh], i) => {
        const base = i % 3 === 0 ? '#787b75' : (i % 3 === 1 ? '#868a82' : '#6c706a');
        px(c, x, y, sx, sy, base, sw, sh);
        px(c, x, y, sx, sy, '#9ca198', Math.max(1, sw - 1), 1);
        px(c, x, y, sx, sy + sh - 1, '#4c6e2c', sw, 1);
      });
      for (let i = 0; i < 18; i++) {
        const mx = Math.floor(pxHash(i, 1, 99) * 15);
        const my = Math.floor(pxHash(i, 2, 99) * 15);
        px(c, x, y, mx, my, i % 2 === 0 ? '#4d822a' : '#66a339', 2, 1);
      }
    });

    // Swamp Mud & Packed Ice
    this.addTile('mud', (c, x, y) => {
      fillNoise(c, x, y, '#3d383c', 9, 100);
      for (let i = 0; i < 12; i++) {
        px(c, x, y, Math.floor(pxHash(i, 1, 101) * 14), Math.floor(pxHash(i, 2, 101) * 14), i % 2 === 0 ? '#2b272b' : '#524b52', 2, 1);
      }
    });
    this.addTile('packed_ice', (c, x, y) => {
      fillNoise(c, x, y, '#8bbbe8', 8, 102);
      px(c, x, y, 2, 2, '#c8e6ff', 5, 1);
      px(c, x, y, 3, 3, '#b0daff', 3, 1);
      px(c, x, y, 9, 10, '#c8e6ff', 5, 1);
      px(c, x, y, 1, 12, '#73a6d6', 6, 1);
    });

    // Biome-Tinted Grass Variants (Savanna dry olive-gold, Jungle lush emerald, Swamp murky moss!)
    const makeGrassTiles = (prefix, greens, seedBase) => {
      this.addTile(`${prefix}_top`, (c, x, y) => {
        for (let iy = 0; iy < 16; iy++) {
          for (let ix = 0; ix < 16; ix++) {
            const clump = pxHash(ix >> 1, iy >> 1, seedBase);
            const fine = pxHash(ix, iy, seedBase + 1);
            px(c, x, y, ix, iy, greens[Math.min(4, Math.max(0, Math.floor((clump * 0.55 + fine * 0.45) * 5)))]);
          }
        }
      });
      this.addTile(`${prefix}_side`, (c, x, y) => {
        drawMinecraftDirt(c, x, y, seedBase + 2);
        const fringe = [4, 5, 3, 4, 6, 4, 3, 5, 4, 3, 5, 6, 4, 3, 4, 5];
        for (let ix = 0; ix < 16; ix++) {
          const drop = fringe[ix];
          for (let iy = 0; iy < drop; iy++) {
            const h = pxHash(ix, iy, seedBase + 3);
            const col = iy === 0 ? (h > 0.5 ? greens[3] : greens[2])
              : (iy === drop - 1 ? greens[0] : (h > 0.5 ? greens[2] : greens[1]));
            px(c, x, y, ix, iy, col);
          }
          if (drop < 16) px(c, x, y, ix, drop, '#4f3522');
        }
      });
    };
    makeGrassTiles('savanna_grass', ['#787a2e', '#8c8f38', '#a1a343', '#b3b54e', '#c2c45c'], 110);
    makeGrassTiles('jungle_grass', ['#247a27', '#2f9132', '#3aa83d', '#48bd4b', '#5ad15d'], 120);
    makeGrassTiles('swamp_grass', ['#3a4d2b', '#475c34', '#546b3e', '#627a48', '#6f8754'], 130);

    // Molten Glowing Magma Lava Tile (vibrant crusted orange-red magma pools!)
    this.addTile('lava', (c, x, y) => {
      const cols = ['#b82208', '#d9410d', '#f56a14', '#ff9e1c', '#ffe252', '#fff7a8'];
      for (let iy = 0; iy < 16; iy++) {
        for (let ix = 0; ix < 16; ix++) {
          const clump = pxHash(ix >> 1, iy >> 1, 141);
          const fine = pxHash(ix, iy, 142);
          const v = clump * 0.65 + fine * 0.35;
          const idx = Math.min(5, Math.max(0, Math.floor(v * 6)));
          px(c, x, y, ix, iy, cols[idx]);
        }
      }
      // Bright incandescent magma veins
      px(c, x, y, 3, 4, '#fff7a8', 3, 1);
      px(c, x, y, 10, 9, '#fff7a8', 3, 1);
      px(c, x, y, 6, 13, '#ffe252', 4, 1);
    });

    // Blazing Flickering Multi-Tongue Pixel Fire Tile (transparent cutout cross!)
    this.addTile('fire', (c, x, y) => {
      const grid = [
        '................',
        '.......O........',
        '......OYO...O...',
        '...O..OYO..OYO..',
        '..OYO.OYYO.OYO..',
        '..OYO.OYYO.OYYO.',
        '.OYYOOYYWYOYYYO.',
        '.OYYYOYYWWYYYYO.',
        '.OYYYYYYWWYYYYO.',
        'OYYYYYWWWWWYYYYO',
        'OYYYYWWWWWWYYYYO',
        'OYYYWWWWWWRWYYYO',
        'OYYWWWWWWRRWWYYO',
        'OYYWWWWWWWWWYYYO',
        '.OYYYYWWWWYYYYO.',
        '..OOOOOOOOOOOO..'
      ];
      const pal = { O: '#d93208', R: '#ff5912', Y: '#ff9e1c', W: '#fff48f' };
      for (let iy = 0; iy < 16; iy++) {
        for (let ix = 0; ix < 16; ix++) {
          const col = pal[grid[iy][ix]];
          if (col) px(c, x, y, ix, iy, col);
        }
      }
    });

    // --- WOOD DOORS (All 6 Wood Types — Top Half with Signature Windows/Slats + Bottom Paneled Half!) ---
    const doorStyles = [
      { key: 'oak',    base: '#b8945f', dark: '#8d6c3d', light: '#cfa972', trim: '#6e512a', knob: '#4a4e57', win: 'oak' },
      { key: 'birch',  base: '#dfd2a8', dark: '#bdb084', light: '#efe5c2', trim: '#9c8f66', knob: '#3c4048', win: 'birch' },
      { key: 'spruce', base: '#6f4e2d', dark: '#50361d', light: '#856039', trim: '#382411', knob: '#7e8694', win: 'spruce' },
      { key: 'acacia', base: '#ba6337', dark: '#944a24', light: '#cf7546', trim: '#6e3417', knob: '#3a3e46', win: 'acacia' },
      { key: 'jungle', base: '#a87754', dark: '#82583a', light: '#be8c68', trim: '#5e3c24', knob: '#464a52', win: 'jungle' },
      { key: 'cherry', base: '#e5b3bd', dark: '#c78c99', light: '#f4cdd5', trim: '#9e6270', knob: '#e6c24a', win: 'cherry' }
    ];
    for (const ds of doorStyles) {
      this.addTile(`${ds.key}_door_bottom`, (c, x, y) => {
        // Outer wood frame + recessed bottom panels + iron/gold hinges
        px(c, x, y, 0, 0, ds.base, 16, 16);
        px(c, x, y, 0, 0, ds.dark, 16, 2);
        px(c, x, y, 0, 14, ds.trim, 16, 2);
        px(c, x, y, 0, 0, ds.trim, 2, 16);
        px(c, x, y, 14, 0, ds.trim, 2, 16);
        // Vertical plank grain lines
        for (let ix = 3; ix < 14; ix += 3) px(c, x, y, ix, 2, ds.dark, 1, 12);
        // Recessed twin panels
        px(c, x, y, 3, 3, ds.dark, 4, 10);
        px(c, x, y, 4, 4, ds.light, 2, 8);
        px(c, x, y, 9, 3, ds.dark, 4, 10);
        px(c, x, y, 10, 4, ds.light, 2, 8);
        // Hinge straps on left edge
        px(c, x, y, 0, 3, '#4c525e', 2, 2);
        px(c, x, y, 0, 11, '#4c525e', 2, 2);
        // Handle plate near top right (aligns with top half)
        px(c, x, y, 12, 0, ds.knob, 2, 2);
      });

      this.addTile(`${ds.key}_door_top`, (c, x, y) => {
        px(c, x, y, 0, 0, ds.base, 16, 16);
        px(c, x, y, 0, 0, ds.trim, 16, 2);
        px(c, x, y, 0, 14, ds.dark, 16, 2);
        px(c, x, y, 0, 0, ds.trim, 2, 16);
        px(c, x, y, 14, 0, ds.trim, 2, 16);
        // Cutout window / slatted top style unique to each Minecraft wood!
        if (ds.win === 'oak') {
          // Classic 4-pane see-through window
          c.clearRect(x + 3, y + 3, 4, 4);
          c.clearRect(x + 9, y + 3, 4, 4);
          c.clearRect(x + 3, y + 9, 4, 4);
          c.clearRect(x + 9, y + 9, 4, 4);
          px(c, x, y, 7, 2, ds.dark, 2, 12);
          px(c, x, y, 2, 7, ds.dark, 12, 2);
        } else if (ds.win === 'acacia') {
          // Horizontal open slatted bars
          c.clearRect(x + 3, y + 3, 10, 2);
          c.clearRect(x + 3, y + 7, 10, 2);
          c.clearRect(x + 3, y + 11, 10, 2);
        } else if (ds.win === 'jungle') {
          // Tropical arched twin windows
          c.clearRect(x + 3, y + 3, 4, 7);
          c.clearRect(x + 9, y + 3, 4, 7);
          px(c, x, y, 7, 2, ds.dark, 2, 11);
        } else if (ds.win === 'cherry') {
          // Shoji / pink lattice cutout window
          c.clearRect(x + 3, y + 3, 10, 9);
          px(c, x, y, 7, 3, ds.light, 2, 9);
          px(c, x, y, 3, 7, ds.light, 10, 2);
        } else if (ds.win === 'birch') {
          // Cream paneled birch door with subtle upper slats
          px(c, x, y, 3, 3, ds.light, 10, 10);
          for (let iy = 4; iy <= 11; iy += 2) px(c, x, y, 4, iy, ds.dark, 8, 1);
        } else {
          // Spruce solid fortified planks + iron brace & ring
          for (let ix = 4; ix <= 12; ix += 3) px(c, x, y, ix, 2, ds.dark, 1, 12);
          px(c, x, y, 2, 4, '#4c525e', 12, 2);
          px(c, x, y, 10, 9, ds.knob, 3, 3);
          px(c, x, y, 11, 10, ds.dark, 1, 1);
        }
        // Top hinge & door knob
        px(c, x, y, 0, 4, '#4c525e', 2, 2);
        px(c, x, y, 12, 13, ds.knob, 2, 2);
      });
    }

    // --- DEEPSLATE & 5 NEW STONE BLOCKS (Granite, Diorite, Andesite, Tuff, Basalt) ---
    // 1. Deepslate (dark charcoal-blue layered metamorphic rock!)
    this.addTile('deepslate_side', (c, x, y) => {
      const tones = ['#2c2e35', '#363942', '#424652', '#4e5260', '#5b606f', '#24262c'];
      for (let iy = 0; iy < 16; iy++) {
        const layer = (iy % 4 === 0) ? -1 : ((iy % 4 === 2) ? 1 : 0);
        for (let ix = 0; ix < 16; ix++) {
          const h = pxHash(ix >> 1, iy, 161);
          const f = pxHash(ix, iy, 162);
          let idx = Math.floor(h * 4) + layer + (f > 0.75 ? 1 : (f < 0.2 ? -1 : 0));
          idx = Math.max(0, Math.min(tones.length - 1, idx));
          px(c, x, y, ix, iy, tones[idx]);
        }
      }
      for (let i = 0; i < 10; i++) {
        const sx = Math.floor(pxHash(i, 1, 163) * 11);
        const sy = Math.floor(pxHash(i, 2, 163) * 16);
        px(c, x, y, sx, sy, i % 2 === 0 ? '#1f2127' : '#656a7a', 4, 1);
      }
    });
    this.addTile('deepslate_top', (c, x, y) => {
      const tones = ['#2e3138', '#393d47', '#464a56', '#545966', '#25282e'];
      for (let iy = 0; iy < 16; iy++) {
        for (let ix = 0; ix < 16; ix++) {
          const ring = Math.max(Math.abs(ix - 7.5), Math.abs(iy - 7.5));
          const h = pxHash(ix, iy, 164);
          const idx = Math.min(4, Math.max(0, Math.floor((h * 0.7 + ((ring % 3) / 3) * 0.3) * 5)));
          px(c, x, y, ix, iy, tones[idx]);
        }
      }
      px(c, x, y, 2, 5, '#202229', 5, 1);
      px(c, x, y, 9, 10, '#626775', 5, 1);
    });

    // 2. Granite (warm rosy terracotta-brown speckled igneous stone!)
    this.addTile('granite', (c, x, y) => {
      const tones = ['#7d5243', '#946352', '#a67461', '#b88570', '#694336', '#cfa493'];
      for (let iy = 0; iy < 16; iy++) {
        for (let ix = 0; ix < 16; ix++) {
          const clump = pxHash(ix >> 1, iy >> 1, 165);
          const fine = pxHash(ix, iy, 166);
          if (fine > 0.90) px(c, x, y, ix, iy, '#dec1b4');
          else if (fine < 0.12) px(c, x, y, ix, iy, '#57362b');
          else px(c, x, y, ix, iy, tones[Math.min(5, Math.floor((clump * 0.55 + fine * 0.45) * 5))]);
        }
      }
    });

    // 3. Diorite (bright speckled white-ivory & dark mineral quartz rock!)
    this.addTile('diorite', (c, x, y) => {
      const tones = ['#b5b5b8', '#c8c8cc', '#d9d9de', '#e8e8ed', '#94949a'];
      for (let iy = 0; iy < 16; iy++) {
        for (let ix = 0; ix < 16; ix++) {
          const clump = pxHash(ix >> 1, iy >> 1, 167);
          const fine = pxHash(ix, iy, 168);
          if (fine < 0.16) px(c, x, y, ix, iy, '#5e5f66');
          else if (fine > 0.88) px(c, x, y, ix, iy, '#f4f4f8');
          else px(c, x, y, ix, iy, tones[Math.min(4, Math.floor((clump * 0.6 + fine * 0.4) * 5))]);
        }
      }
    });

    // 4. Andesite (cool muted blue-grey mottled volcanic stone!)
    this.addTile('andesite', (c, x, y) => {
      const tones = ['#6c7073', '#7c8185', '#8b9094', '#9a9fa3', '#5c6063'];
      for (let iy = 0; iy < 16; iy++) {
        for (let ix = 0; ix < 16; ix++) {
          const clump = pxHash(ix >> 1, iy >> 1, 169);
          const fine = pxHash(ix, iy, 170);
          if (fine > 0.88) px(c, x, y, ix, iy, '#aeb3b8');
          else if (fine < 0.14) px(c, x, y, ix, iy, '#4e5255');
          else px(c, x, y, ix, iy, tones[Math.min(4, Math.floor((clump * 0.55 + fine * 0.45) * 5))]);
        }
      }
    });

    // 5. Tuff (earthy olive-ash layered cave volcanic rock!)
    this.addTile('tuff', (c, x, y) => {
      const tones = ['#575950', '#66695e', '#75786c', '#828578', '#4a4c44'];
      for (let iy = 0; iy < 16; iy++) {
        for (let ix = 0; ix < 16; ix++) {
          const clump = pxHash(ix >> 1, iy >> 1, 171);
          const fine = pxHash(ix, iy, 172);
          let idx = Math.min(4, Math.floor((clump * 0.6 + fine * 0.4) * 5));
          px(c, x, y, ix, iy, tones[idx]);
        }
      }
      for (let i = 0; i < 8; i++) {
        px(c, x, y, Math.floor(pxHash(i, 1, 173) * 13), Math.floor(pxHash(i, 2, 173) * 15), i % 2 === 0 ? '#42443c' : '#909485', 3, 1);
      }
    });

    // 6. Basalt (dark columnar volcanic basalt with vertical flutes & hexagonal top!)
    this.addTile('basalt_side', (c, x, y) => {
      const tones = ['#323238', '#3e3e45', '#4c4d57', '#5a5b66', '#25252a'];
      for (let ix = 0; ix < 16; ix++) {
        const groove = (ix % 4 === 0) ? -1 : ((ix % 4 === 2) ? 1 : 0);
        for (let iy = 0; iy < 16; iy++) {
          const h = pxHash(ix, iy >> 1, 174);
          const f = pxHash(ix, iy, 175);
          let idx = Math.floor(h * 4) + groove + (f > 0.76 ? 1 : (f < 0.2 ? -1 : 0));
          idx = Math.max(0, Math.min(4, idx));
          px(c, x, y, ix, iy, tones[idx]);
        }
      }
    });
    this.addTile('basalt_top', (c, x, y) => {
      fillNoise(c, x, y, '#484952', 11, 176);
      px(c, x, y, 0, 0, '#2c2d33', 16, 1);
      px(c, x, y, 0, 15, '#2c2d33', 16, 1);
      px(c, x, y, 0, 0, '#2c2d33', 1, 16);
      px(c, x, y, 15, 0, '#2c2d33', 1, 16);
      px(c, x, y, 3, 3, '#5d5f6b', 10, 10);
      px(c, x, y, 5, 5, '#3b3c44', 6, 6);
      px(c, x, y, 6, 6, '#696b78', 4, 4);
    });
  }

  // Lazy on-demand 16x16 (32x32) icon caching — cuts initial startup time dramatically!
  getIcon(itemKey) {
    if (this.itemIcons[itemKey]) return this.itemIcons[itemKey];
    const def = ITEMS[itemKey];
    if (!def) return '';
    const ctx = this._iconCtx;
    ctx.clearRect(0, 0, 32, 32);
    if (def.isBlock && keyIsSolidCubeIcon(itemKey, def)) {
      const faceName = def.faces.side || def.faces.all || def.faces.top;
      const tile = this.getUV(faceName);
      ctx.drawImage(this.canvas, tile.ox, tile.oy, TILE_SIZE, TILE_SIZE, 2, 2, 28, 28);
      ctx.strokeStyle = 'rgba(0,0,0,0.48)';
      ctx.lineWidth = 2;
      ctx.strokeRect(2, 2, 28, 28);
    } else {
      this.drawPixelItem(ctx, itemKey, def);
    }
    const url = this._iconScratch.toDataURL();
    this.itemIcons[itemKey] = url;
    return url;
  }

  // Hand-Crafted 16x16 Minecraft / Reforge-Grade Pixel-Art Matrix Sprites (scale 2x -> 32x32)!
  drawPixelItem(c, key, def) {
    const drawGrid = (rows, pal) => {
      for (let y = 0; y < 16; y++) {
        const row = rows[y];
        if (!row) continue;
        for (let x = 0; x < 16; x++) {
          const col = pal[row[x]];
          if (col) {
            c.fillStyle = col;
            c.fillRect(x * 2, y * 2, 2, 2);
          }
        }
      }
    };

    const tierPal = {
      wooden:  { O: '#2b1a0c', D: '#6b4720', M: '#9c6b36', L: '#c99757', H: '#e3b878', S: '#7d5225', s: '#a6743c', d: '#4f3215' },
      stone:   { O: '#1c1e22', D: '#575c63', M: '#878d96', L: '#b2b8c2', H: '#d8dee6', S: '#7d5225', s: '#a6743c', d: '#4f3215' },
      golden:  { O: '#362004', D: '#a36407', M: '#e8a617', L: '#ffde47', H: '#fff9b8', W: '#ffffff', R: '#e04231', S: '#7d5225', s: '#a6743c', d: '#4f3215' },
      gold:    { O: '#362004', D: '#a36407', M: '#e8a617', L: '#ffde47', H: '#fff9b8', W: '#ffffff', R: '#e04231', S: '#7d5225', s: '#a6743c', d: '#4f3215' },
      iron:    { O: '#1b1f26', D: '#7c8594', M: '#bac4d1', L: '#e3eaf2', H: '#ffffff', S: '#7d5225', s: '#a6743c', d: '#4f3215' },
      diamond: { O: '#092a36', D: '#128996', M: '#2ad1db', L: '#7ef3fa', H: '#e3ffff', S: '#7d5225', s: '#a6743c', d: '#4f3215' },
      leather: { O: '#291509', D: '#693a1a', M: '#9c5a2d', L: '#c47a45', H: '#de9864', S: '#7d5225', s: '#a6743c', d: '#4f3215' }
    };

    if (def && (def.isFence || def.isFenceGate) && def.fenceWood) {
      const woodPals = {
        oak:    { O: '#3d2a12', F: '#8d6c3d', B: '#b8945f', L: '#cfa972' },
        birch:  { O: '#574e36', F: '#bdb084', B: '#dfd2a8', L: '#f2e8c7' },
        spruce: { O: '#24160a', F: '#50361d', B: '#6f4e2d', L: '#87623b' },
        acacia: { O: '#4a210d', F: '#944a24', B: '#ba6337', L: '#d67b4b' },
        jungle: { O: '#3d2415', F: '#82583a', B: '#a87754', L: '#c4916c' },
        cherry: { O: '#633540', F: '#c78c99', B: '#e5b3bd', L: '#f7d5dc' }
      };
      const pal = woodPals[def.fenceWood] || woodPals.oak;
      if (def.isFence) {
        drawGrid([
          '................',
          '..OOOO....OOOO..',
          '..OLLO....OLLO..',
          '..OBBO....OBBO..',
          '.OOOOOOOOOOOOOO.',
          '.OLLLLLLLLLLLL0.'.replace('0', 'O'),
          '.OBBBBBBBBBBBBO.',
          '.OOOOOOOOOOOOOO.',
          '..OBBO....OBBO..',
          '.OOOOOOOOOOOOOO.',
          '.OLLLLLLLLLLLL0.'.replace('0', 'O'),
          '.OBBBBBBBBBBBBO.',
          '.OOOOOOOOOOOOOO.',
          '..OFFO....OFFO..',
          '..OOOO....OOOO..',
          '................'
        ], pal);
      } else {
        drawGrid([
          '................',
          '................',
          '.OOO........OOO.',
          '.OLO........OLO.',
          '.OBOOOOOOOOOOBO.',
          '.OBOLLLLLLLLOBO.',
          '.OBOBBBOOBBBOBO.',
          '.OBOBBBOOBBBOBO.',
          '.OBOLLLLLLLLOBO.',
          '.OBOBBBOOBBBOBO.',
          '.OBOOOOOOOOOOBO.',
          '.OFO........OFO.',
          '.OFO........OFO.',
          '.OOO........OOO.',
          '................',
          '................'
        ], pal);
      }
      return;
    }

    if (def && def.isStair) {
      // Crisp 2-step Stair silhouette rendered directly from the material's own atlas tile!
      const sideTile = this.getUV(def.faces.side || def.faces.all || def.faces.top);
      const topTile = this.getUV(def.faces.top || def.faces.all || def.faces.side);
      // Draw bottom full step (x: 2..30, y: 16..30)
      c.drawImage(this.canvas, sideTile.ox, sideTile.oy + 8, 16, 8, 2, 16, 28, 14);
      // Draw upper back step (x: 16..30, y: 2..16)
      c.drawImage(this.canvas, sideTile.ox + 8, sideTile.oy, 8, 8, 16, 2, 14, 14);
      // Top tread highlights (lower tread & upper tread)
      c.drawImage(this.canvas, topTile.ox, topTile.oy, 8, 3, 2, 16, 14, 3);
      c.drawImage(this.canvas, topTile.ox + 8, topTile.oy, 8, 3, 16, 2, 14, 3);
      // Crisp bevel shading & stepped outline
      c.fillStyle = 'rgba(255,255,255,0.22)';
      c.fillRect(2, 16, 14, 2);
      c.fillRect(16, 2, 14, 2);
      c.fillStyle = 'rgba(0,0,0,0.20)';
      c.fillRect(16, 16, 14, 14);
      c.strokeStyle = 'rgba(0,0,0,0.68)';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(2, 30);
      c.lineTo(2, 16);
      c.lineTo(16, 16);
      c.lineTo(16, 2);
      c.lineTo(30, 2);
      c.lineTo(30, 30);
      c.closePath();
      c.stroke();
      return;
    }

    if (def && def.isDoor && def.doorWood) {
      // Crisp 16x16 2D Wood Door item sprite (matching each wood type!)
      const doorPals = {
        oak:    { O: '#3d2a12', F: '#8d6c3d', B: '#b8945f', L: '#cfa972', K: '#505661', W: '#a8d6f0' },
        birch:  { O: '#574e36', F: '#bdb084', B: '#dfd2a8', L: '#f2e8c7', K: '#3d424a', W: '#cfc399' },
        spruce: { O: '#24160a', F: '#50361d', B: '#6f4e2d', L: '#87623b', K: '#929aa8', W: '#593d22' },
        acacia: { O: '#4a210d', F: '#944a24', B: '#ba6337', L: '#d67b4b', K: '#3f444d', W: '#a8d6f0' },
        jungle: { O: '#3d2415', F: '#82583a', B: '#a87754', L: '#c4916c', K: '#484d57', W: '#a8d6f0' },
        cherry: { O: '#633540', F: '#c78c99', B: '#e5b3bd', L: '#f7d5dc', K: '#f0cc52', W: '#d9f2ff' }
      };
      const pal = doorPals[def.doorWood] || doorPals.oak;
      drawGrid([
        '....OOOOOOOO....',
        '...OFFFFFFFFO...',
        '...OFWWFFWWFO...',
        '...OFWWFFWWFO...',
        '...OFFFFFFFFO...',
        '...OFWWFFWWFO...',
        '...OFWWFFWWFO...',
        '...OFFFFFFFFO...',
        '...OFBBBBBKFO...',
        '...OFBBLBBKFO...',
        '...OFBBLBBBFO...',
        '...OFBBLBBBFO...',
        '...OFBBBBBBFO...',
        '...OFBBLBBBFO...',
        '...OFFFFFFFFO...',
        '....OOOOOOOO....'
      ], pal);
      return;
    }

    if (def.spawnMob) {
      // Authentic Minecraft Two-Tone Spotted Mob Spawn Egg (16x16 pixel art!)
      const shadeHex = (hex, mul) => {
        const n = parseInt(hex.slice(1), 16);
        const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * mul)));
        const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * mul)));
        const b = Math.max(0, Math.min(255, Math.round((n & 255) * mul)));
        return `rgb(${r},${g},${b})`;
      };
      const base = def.eggBase || '#e0d8c8';
      const spot = def.eggSpot || '#555555';
      drawGrid([
        '................',
        '......OOOO......',
        '....OOHHHBOO....',
        '...OHHBBBBBSO...',
        '...OHBBSBBBBDO..',
        '..OHBBSSBBSBBDO.',
        '..OBBBBBBBSSBDO.',
        '..OBSSBGBBBBBDO.',
        '..OBSSBBBBBBDO..',
        '..OBBBBBSSBBDO..',
        '..OBBBSSSSBBDDO.',
        '...OBBBBBBBDDDO.',
        '...ODBBSSDDDDO..',
        '....ODDDDDDDO...',
        '.....OOOOOOO....',
        '................'
      ], {
        O: '#18181f',
        H: shadeHex(base, 1.28),
        B: base,
        G: shadeHex(base, 1.12),
        D: shadeHex(base, 0.70),
        S: spot
      });
      return;
    }

    if (def.toolType && def.toolType !== 'flint_and_steel' && def.toolType !== 'shears') {
      const matKey = key.split('_')[0];
      const pal = tierPal[matKey] || tierPal.iron;
      // Bespoke royal gilded pixel-art sprites for Golden Tools!
      if (matKey === 'golden' || matKey === 'gold') {
        if (def.toolType === 'sword') {
          drawGrid([
            '............OOO.',
            '...........OWHO.',
            '..........OWHLO.',
            '.........OWHLMO.',
            '........OHWLMDO.',
            '.......OHWLMDO..',
            '..OO..OHWLMDO...',
            '.OHLOOHWLMDO....',
            '..ODHLLMMDO.....',
            '...ODHLMDO......',
            '....ODHLO.......',
            '...OdSOHLO......',
            '..OdSO.ODO......',
            '.OdsO...O.......',
            '.ORO............',
            '..O.............'
          ], pal);
        } else if (def.toolType === 'pickaxe') {
          drawGrid([
            '................',
            '....OOOOOOO.....',
            '...OWWHLLLMO....',
            '..OHHLLLLMMLO...',
            '..OOD..OOHWMO...',
            '.......OLsLMO...',
            '......OsOOLMO...',
            '.....OsO..OMO...',
            '....OsO...OMO...',
            '...OsO....ODO...',
            '..OsO.....ODO...',
            '.OsO.......O....',
            '.ORO............',
            '..O.............',
            '................',
            '................'
          ], pal);
        } else if (def.toolType === 'axe') {
          drawGrid([
            '................',
            '......OOOOO.....',
            '.....OWWHLLOO...',
            '....OWHLLLMMO...',
            '....OHLLMDsMO...',
            '....OMMLDsMMO...',
            '.....OOOsODMO...',
            '......OsO.ODO...',
            '.....OsO...O....',
            '....OsO.........',
            '...OsO..........',
            '..OsO...........',
            '.OsO............',
            '.ORO............',
            '..O.............',
            '................'
          ], pal);
        } else if (def.toolType === 'hoe') {
          drawGrid([
            '................',
            '.....OOOOOOO....',
            '....OWWHLLLMO...',
            '....OHHLLMLMO...',
            '.....OO..OsO....',
            '........OsO.....',
            '.......OsO......',
            '......OsO.......',
            '.....OsO........',
            '....OsO.........',
            '...OsO..........',
            '..OsO...........',
            '.OsO............',
            '.ORO............',
            '..O.............',
            '................'
          ], pal);
        } else { // golden shovel
          drawGrid([
            '................',
            '..........OOOO..',
            '.........OWHLLO.',
            '........OWHLLMO.',
            '........OHLLMDO.',
            '.......OOHMMDO..',
            '.......OLsODO...',
            '......OsO.OO....',
            '.....OsO........',
            '....OsO.........',
            '...OsO..........',
            '..OsO...........',
            '.OsO............',
            '.ORO............',
            '..O.............',
            '................'
          ], pal);
        }
        return;
      }
      if (def.toolType === 'sword') {
        drawGrid([
          '............OOO.',
          '...........OHHO.',
          '..........OHLMO.',
          '.........OHLMDO.',
          '........OHLMDO..',
          '.......OHLMDO...',
          '......OHLMDO....',
          '..OO.OHLMDO.....',
          '..OHOOLMDO......',
          '...ODHMDO.......',
          '....ODHO........',
          '...OdSOHO.......',
          '..OdSO.OO.......',
          '.OdsO...........',
          '.ODO............',
          '..O.............'
        ], pal);
      } else if (def.toolType === 'pickaxe') {
        drawGrid([
          '................',
          '.....OOOOO......',
          '....OHHLLMO.....',
          '...OMMMLLHMO....',
          '...OO..OOHMO....',
          '........OsMO....',
          '.......OsOOMO...',
          '......OsO.OMO...',
          '.....OsO..OMO...',
          '....OsO...ODO...',
          '...OsO....ODO...',
          '..OsO......O....',
          '.OsO............',
          '.dO.............',
          '................',
          '................'
        ], pal);
      } else if (def.toolType === 'axe') {
        drawGrid([
          '................',
          '.......OOOO.....',
          '......OHHLLOO...',
          '.....OHLLMMMO...',
          '.....OMMMDsMO...',
          '......OODsMMO...',
          '.......OsODMO...',
          '......OsO.OO....',
          '.....OsO........',
          '....OsO.........',
          '...OsO..........',
          '..OsO...........',
          '.OsO............',
          '.dO.............',
          '................',
          '................'
        ], pal);
      } else if (def.toolType === 'hoe') {
        drawGrid([
          '................',
          '.....OOOOOOO....',
          '....OHHLLLMO....',
          '....OMMLLMMO....',
          '.....OO..OsO....',
          '........OsO.....',
          '.......OsO......',
          '......OsO.......',
          '.....OsO........',
          '....OsO.........',
          '...OsO..........',
          '..OsO...........',
          '.OsO............',
          '.dO.............',
          '................',
          '................'
        ], pal);
      } else { // shovel
        drawGrid([
          '................',
          '..........OOOO..',
          '.........OHLLMO.',
          '........OHLLMMO.',
          '........OLMMMDO.',
          '........OMMMDO..',
          '.......OsODDO...',
          '......OsO.OO....',
          '.....OsO........',
          '....OsO.........',
          '...OsO..........',
          '..OsO...........',
          '.OsO............',
          '.dO.............',
          '................',
          '................'
        ], pal);
      }
      return;
    }

    if (def.armorSlot !== undefined) {
      const matKey = key.split('_')[0];
      const pal = tierPal[matKey] || tierPal.iron;
      // Bespoke royal gilded pixel-art sprites for Golden Armor!
      if (matKey === 'golden' || matKey === 'gold') {
        if (def.armorSlot === 0) { // Royal Crested Golden Helmet
          drawGrid([
            '................',
            '......OOOO......',
            '....OOHWWLOO....',
            '...OHWLLLLMMO...',
            '..OHHLLRRMMDMO..',
            '..OHLLMMMMMDMO..',
            '..OLMOOOOOODMO..',
            '..OHMO....ODMO..',
            '..OLMO....ODMO..',
            '..OMMO....ODMO..',
            '..ODDO....ODDO..',
            '...OO......OO...',
            '................',
            '................',
            '................',
            '................'
          ], pal);
        } else if (def.armorSlot === 1) { // Ornate Gilded Chestplate
          drawGrid([
            '................',
            '..OOOO....OOOO..',
            '.OWHLLO..OMMLDO.',
            '.OHLLMO..OMMMDO.',
            '.OLMMMOOOOOMMDO.',
            '.OMMHHLRRLMMMDO.',
            '.ODOMHLLLLMODO..',
            '..O.OLMMMMMO.O..',
            '....OMHLLMMO....',
            '....OMMMMDDO....',
            '....ODHLLDDO....',
            '....ODDDDDDO....',
            '....OODDDDOO....',
            '......OOOO......',
            '................',
            '................'
          ], pal);
        } else if (def.armorSlot === 2) { // Ornate Golden Leggings
          drawGrid([
            '................',
            '...OOOOOOOOOO...',
            '..OHWLLRRLLMMO..',
            '..OLMMMMMMMMDO..',
            '..OMMMOOOOOMDO..',
            '..OHMO....OMDO..',
            '..OLMO....OMDO..',
            '..OWLO....OLMO..',
            '..OMMO....OMDO..',
            '..OMDO....ODDO..',
            '..OLDO....ODDO..',
            '..ODDO....ODDO..',
            '..ODDO....ODDO..',
            '...OO......OO...',
            '................',
            '................'
          ], pal);
        } else { // Gilded Golden Boots
          drawGrid([
            '................',
            '................',
            '................',
            '................',
            '..OOOO....OOOO..',
            '..OWHO....OHWO..',
            '..OHLO....OLHO..',
            '..OLMO....OMLO..',
            '..OMMO....OMMO..',
            '.OWHLO....OLHWO.',
            '.OLMMO....OMMLO.',
            '.ODDDDO..ODDDDO.',
            '.OOOOOO..OOOOOO.',
            '................',
            '................',
            '................'
          ], pal);
        }
        return;
      }
      if (def.armorSlot === 0) { // Helmet
        drawGrid([
          '................',
          '................',
          '....OOOOOOOO....',
          '...OHHLLLLMMO...',
          '..OHHLLMMMMDMO..',
          '..OHLLMMMMMDMO..',
          '..OLMOOOOOODMO..',
          '..OLMO....ODMO..',
          '..OMMO....ODMO..',
          '..ODMO....ODMO..',
          '..ODDO....ODDO..',
          '...OO......OO...',
          '................',
          '................',
          '................',
          '................'
        ], pal);
      } else if (def.armorSlot === 1) { // Chestplate
        drawGrid([
          '................',
          '..OOOO....OOOO..',
          '.OHLLMO..OMMMDO.',
          '.OHLLMO..OMMMDO.',
          '.OLMMMOOOOOMMDO.',
          '.OMMHHLLLLMMMDO.',
          '.ODOMHLLMMMMODO.',
          '..O.OLMMMMMO.O..',
          '....OMMMMMDO....',
          '....OMMMMDDO....',
          '....OMMMMDDO....',
          '....ODDDDDDO....',
          '....OODDDDOO....',
          '......OOOO......',
          '................',
          '................'
        ], pal);
      } else if (def.armorSlot === 2) { // Leggings
        drawGrid([
          '................',
          '...OOOOOOOOOO...',
          '..OHHLLLLMMMMO..',
          '..OLMMMMMMMMDO..',
          '..OMMMOOOOOMDO..',
          '..OMMO....OMDO..',
          '..OLMO....OMDO..',
          '..OMMO....OMDO..',
          '..OMMO....OMDO..',
          '..OMDO....ODDO..',
          '..OMDO....ODDO..',
          '..ODDO....ODDO..',
          '..ODDO....ODDO..',
          '...OO......OO...',
          '................',
          '................'
        ], pal);
      } else { // Boots
        drawGrid([
          '................',
          '................',
          '................',
          '................',
          '................',
          '..OOOO....OOOO..',
          '..OHLO....OHLO..',
          '..OLMO....OLMO..',
          '..OMMO....OMMO..',
          '.OHLMO....OMLHO.',
          '.OLMMO....OMMLO.',
          '.ODDDDO..ODDDDO.',
          '.OOOOOO..OOOOOO.',
          '................',
          '................',
          '................'
        ], pal);
      }
      return;
    }

    // Authentic Hand-Crafted 16x16 Pixel-Art Foods, Gems, Ingots, Materials & Bed!
    switch (key) {
      case 'apple':
        drawGrid([
          '........OO......',
          '.......ObO.OO...',
          '.......ObOGgGO..',
          '....OOOOboGGO...',
          '...OrrrrrOOrrO..',
          '..OrhWrrrrrrrRO.',
          '..OrWWrrrrrrrrO.',
          '..OrhrrrrrrrrRO.',
          '..OrrrrrrrrrrRO.',
          '..OrrrrrrrrrrDO.',
          '..ORrrrrrrrrrDO.',
          '...ORrrrrrrrDO..',
          '...ODRrrrrrDDO..',
          '....ODDRRRDDO...',
          '.....OOODDOO....',
          '........OO......'
        ], { O: '#300b0d', b: '#6e421f', o: '#4a2a11', G: '#2f8a28', g: '#6bd94a', W: '#ffd9d6', h: '#ff7a75', r: '#e32626', R: '#b81818', D: '#7d0f14' });
        break;

      case 'bread':
        drawGrid([
          '................',
          '................',
          '.........OOOOO..',
          '.......OOHHLLCO.',
          '......OHHLcCLcO.',
          '.....OHLccLLCDO.',
          '....OHLcLLcCCDO.',
          '...OHLccLLCCDO..',
          '..OHLcLLcCCDO...',
          '.OHLLcLLCCDO....',
          '.OLcLLLCCDO.....',
          '.OCCCCCDDO......',
          '.ODDDDDDO.......',
          '..OOOOOO........',
          '................',
          '................'
        ], { O: '#361e09', H: '#fae09e', L: '#e8b95b', C: '#c98a32', c: '#8f5519', D: '#784414' });
        break;

      case 'raw_porkchop':
        drawGrid([
          '................',
          '................',
          '.......OOOOOO...',
          '.....OOWWWFFFO..',
          '....OWWFFpppFMO.',
          '...OWFppMMppMDO.',
          '..OWFppMMMWpMDO.',
          '..OFppMMMMppMDO.',
          '.OWFppMMWWpMDO..',
          '.OFppMMMMppMDO..',
          '.OFpMMMMppMDO...',
          '..OFFFFFFDDO....',
          '...ODDDDDDO.....',
          '....OOOOOO......',
          '................',
          '................'
        ], { O: '#42151c', W: '#fff5f0', F: '#fad2d2', p: '#f2949d', M: '#db5c6c', D: '#ad3b4b' });
        break;

      case 'cooked_porkchop':
        drawGrid([
          '................',
          '................',
          '.......OOOOOO...',
          '.....OOHHLLLLO..',
          '....OHHLLmmLLMO.',
          '...OHLmMMGGMMDO.',
          '..OHLmMMLLmMMDO.',
          '..OLmMMGGMMmMDO.',
          '.OHLmMMLLmMMDO..',
          '.OLmMMGGMMmMDO..',
          '.OLmMMMMmmMDO...',
          '..OLLLLLLDDO....',
          '...ODDDDDDO.....',
          '....OOOOOO......',
          '................',
          '................'
        ], { O: '#2b1307', H: '#f5cc90', L: '#d99957', m: '#bd7539', M: '#9c5624', G: '#633110', D: '#54290c' });
        break;

      case 'raw_beef':
        drawGrid([
          '................',
          '........OOOOO...',
          '......OORRRRRO..',
          '.....ORhhWRRRRO.',
          '....ORhWWRRrRDO.',
          '...ORhRRRRWWrrO.',
          '..ORrRRWWrrrRDO.',
          '..ORrRRRRrrrRDO.',
          '.ORrRRRWWrrRDO..',
          '.ORrRRRRrrRDO...',
          '.ORrRRWrrRDO....',
          '.ORrrrrRRDO.....',
          '..ODDDDDDO......',
          '...OOOOOO.......',
          '................',
          '................'
        ], { O: '#33080d', W: '#fce8e8', h: '#f56c78', R: '#d42c38', r: '#b01c28', D: '#7a1019' });
        break;

      case 'steak':
        drawGrid([
          '................',
          '........OOOOO...',
          '......OOMMMMMO..',
          '.....OMHHLMGSMO.',
          '....OMHLMMGSmDO.',
          '...OMLMMGGmMMDO.',
          '..OMmMMGGLmmMDO.',
          '..OMmMMMMMmmMDO.',
          '.OMmMMGGLmmMDO..',
          '.OMmMMMMmmMDO...',
          '.OMmMMGmmMDO....',
          '.OMmmmmMMDO.....',
          '..ODDDDDDO......',
          '...OOOOOO.......',
          '................',
          '................'
        ], { O: '#1f0b05', H: '#c97e50', L: '#a85f36', M: '#824020', m: '#662e14', G: '#3d1909', S: '#9c522c', D: '#331507' });
        break;

      case 'raw_chicken':
        drawGrid([
          '................',
          '.......OOOOO....',
          '......OHHLLPO...',
          '.....OHHLLPPPO..',
          '.....OLLPPPPDO..',
          '.....OLPPPPPDO..',
          '.....OPPPPPDDO..',
          '.....OOPPPDDO...',
          '....OWbOODDO....',
          '...OWbO..OO.....',
          '..OWbO..........',
          '.OOWbO..........',
          '.OWWWO..........',
          '..OWWO..........',
          '...OO...........',
          '................'
        ], { O: '#3d1c1b', H: '#ffe6de', L: '#fac4b6', P: '#eb9f8f', D: '#c47466', W: '#fffaf2', b: '#d9cfc1' });
        break;

      case 'cooked_chicken':
        drawGrid([
          '................',
          '.......OOOOO....',
          '......OHHLLMO...',
          '.....OHHLLMMMO..',
          '.....OLLMMMMDO..',
          '.....OLMMMMMDO..',
          '.....OMMMMMDDO..',
          '.....OOMMMDDO...',
          '....OWbOODDO....',
          '...OWbO..OO.....',
          '..OWbO..........',
          '.OOWbO..........',
          '.OWWWO..........',
          '..OWWO..........',
          '...OO...........',
          '................'
        ], { O: '#2b1306', H: '#f7c873', L: '#de983c', M: '#bd6d22', D: '#854010', W: '#fffaf2', b: '#d9cfc1' });
        break;

      case 'raw_mutton':
        drawGrid([
          '................',
          '..........OOO...',
          '.........OWWBO..',
          '........OWBOOO..',
          '.......OWBO.....',
          '....OOOOObo.....',
          '...OFRRhhRRO....',
          '..OFWRhRRRRDO...',
          '..OFRRRRRRRDO...',
          '..ORRRWWRRRDO...',
          '..ORRRRRRRDDO...',
          '..ORRRWWWRDO....',
          '...ODDDDDDO.....',
          '....OOOOOO......',
          '................',
          '................'
        ], { O: '#360d14', W: '#fff8f2', B: '#d9cfc3', b: '#c2b6a8', o: '#360d14', F: '#fad6d9', h: '#f57c88', R: '#d93848', D: '#941c2a' });
        break;

      case 'cooked_mutton':
        drawGrid([
          '................',
          '..........OOO...',
          '.........OWWBO..',
          '........OWBOOO..',
          '.......OWBO.....',
          '....OOOOObo.....',
          '...OLMMHHMMO....',
          '..OLMHMMMMMDO...',
          '..OLMMGGMMMDO...',
          '..OMMMMMMMMDO...',
          '..OMMGGMMMDDO...',
          '..OMMMMMMMDO....',
          '...ODDDDDDO.....',
          '....OOOOOO......',
          '................',
          '................'
        ], { O: '#240f06', W: '#fff8f2', B: '#d9cfc3', b: '#c2b6a8', o: '#240f06', H: '#d48750', L: '#b06435', M: '#87421e', G: '#4d200c', D: '#57260f' });
        break;

      case 'raw_venison':
        drawGrid([
          '................',
          '................',
          '.....OOOOOOO....',
          '...OORhWWrrRO...',
          '..ORhhRRRRrrRO..',
          '..ORhRRRRWrrDO..',
          '.ORrRRRRWWrrDO..',
          '.ORrRRRRrrrrDO..',
          '.ORrRRWrrrrRDO..',
          '..ORrrrrrrrDO...',
          '..ODRrrrrrDDO...',
          '...ODDDDDDDO....',
          '.....OOOOO......',
          '................',
          '................',
          '................'
        ], { O: '#29070c', W: '#f5dede', h: '#e8586c', R: '#b81d32', r: '#941427', D: '#610a17' });
        break;

      case 'cooked_venison':
        drawGrid([
          '................',
          '................',
          '.....OOOOOOO....',
          '...OOMHLLmmMO...',
          '..OMHHMMGmmMMO..',
          '..OMHMMGGmggDO..',
          '.OMmMMggMMmmDO..',
          '.OMmMMMMmmmmDO..',
          '.OMmMMGGmmmMDO..',
          '..OMmmmmmmmDO...',
          '..ODmmmmmmDDO...',
          '...ODDDDDDDO....',
          '.....OOOOO......',
          '................',
          '................',
          '................'
        ], { O: '#1c0a05', H: '#c26f44', L: '#9c4f2b', M: '#783419', m: '#5c2410', G: '#3b1507', g: '#5ec947', D: '#381408' });
        break;

      case 'raw_rabbit':
        drawGrid([
          '................',
          '................',
          '......OOOOOO....',
          '.....OHHLLPPO...',
          '....OHLPPPPPDO..',
          '....OLPPPPPPDO..',
          '...OOPPPPPDDO...',
          '..OHLPPPPDDO....',
          '..OLPPPPDDO.....',
          '..OPPPDDWO......',
          '...ODDDWWO......',
          '....OOOWO.......',
          '................',
          '................',
          '................',
          '................'
        ], { O: '#381616', H: '#ffe4dc', L: '#fabbb0', P: '#e89387', D: '#bf6b60', W: '#f7f3eb' });
        break;

      case 'cooked_rabbit':
        drawGrid([
          '................',
          '................',
          '......OOOOOO....',
          '.....OHHLLMMO...',
          '....OHLMMMMMDO..',
          '....OLMMMMMMDO..',
          '...OOMMMMMDDO...',
          '..OHLMMMMDDO....',
          '..OLMMMMDDO.....',
          '..OMMMMDWO......',
          '...ODDDWWO......',
          '....OOOWO.......',
          '................',
          '................',
          '................',
          '................'
        ], { O: '#291207', H: '#f7c374', L: '#de8f40', M: '#b86524', D: '#7d3e11', W: '#f7f3eb' });
        break;

      case 'raw_salmon':
        drawGrid([
          '................',
          '...........OOO..',
          '..........OttiO.',
          '.........OttiO..',
          '......OOOttOO...',
          '....OOttHTtO....',
          '...OtlHTTtSO....',
          '..OtlHTTSSpO....',
          '..OWeTTSSppO....',
          '..OTTTSSppO.....',
          '...OSSSSpO......',
          '..OOSppOO.......',
          '..OStOO.........',
          '...OO...........',
          '................',
          '................'
        ], { O: '#13262b', T: '#3d706e', t: '#5a9491', H: '#8ec4c1', l: '#6ca3a0', i: '#2a4f4e', S: '#e36b5f', p: '#f79c92', W: '#ffffff', e: '#141418' });
        break;

      case 'cooked_salmon':
        drawGrid([
          '................',
          '...........OOO..',
          '..........ObbiO.',
          '.........ObbiO..',
          '......OOOddOO...',
          '....OOddHLdO....',
          '...OdmHLdSO.....',
          '..OdmHLSSpO.....',
          '..OdHSSppO......',
          '..OddSSppO......',
          '...OSSSSpO......',
          '..OOSppOO.......',
          '..OSdOO.........',
          '...OO...........',
          '................',
          '................'
        ], { O: '#291107', d: '#9c451f', b: '#783416', i: '#59230c', H: '#ffdba8', L: '#f2a45a', m: '#c4602b', S: '#e67e3e', p: '#f7b277' });
        break;

      case 'diamond':
        drawGrid([
          '................',
          '.....OOOOOO.....',
          '...OOHHLLLLOO...',
          '..OHWWLLCCCCLO..',
          '.OHWWLCCCCCCCMO.',
          '.OHLLCCCCCCCMDO.',
          '.OLLCCCCCCCCDDO.',
          '.OLCCCCCCCCDDDO.',
          '..OCCCCCCCCDDO..',
          '..OMCCCCCCDDDO..',
          '...OMCCCCDDDO...',
          '....OMCCDDDO....',
          '.....OMDDDO.....',
          '......OOOO......',
          '................',
          '................'
        ], { O: '#082c36', W: '#ffffff', H: '#d6feff', L: '#7ef3fa', C: '#32d8e0', M: '#1aa6b3', D: '#0e7482' });
        break;

      case 'emerald':
        drawGrid([
          '................',
          '.....OOOOOO.....',
          '....OHHLLGGO....',
          '...OHWLLGGGMO...',
          '..OHWLLGGGGDMO..',
          '..OHLLGGGGGDMO..',
          '..OLLGGGGGGDMO..',
          '..OLGGGGGGGDMO..',
          '..OGGGGGGGGDMO..',
          '..OGGGGGGGDDMO..',
          '..OMGGGGGGDDMO..',
          '...OMGGGGDDMO...',
          '....OMGGDDMO....',
          '.....OOOOOO.....',
          '................',
          '................'
        ], { O: '#092914', W: '#e0ffeb', H: '#94ffba', L: '#45eb7d', G: '#17bd53', M: '#0e8f3c', D: '#086328' });
        break;

      case 'iron_ingot':
        drawGrid([
          '................',
          '................',
          '................',
          '.......OOOOOO...',
          '.....OOHHLLLLOO.',
          '....OHHLLLLMMMO.',
          '...OHHLLLLMMMMO.',
          '..OHHLLLLMMMMDO.',
          '.OHLLLLMMMMMDDO.',
          '.OLMMMMMMMDDDDO.',
          '.OMMMMMDDDDDDO..',
          '.ODDDDDDDDDDO...',
          '..OOOOOOOOOO....',
          '................',
          '................',
          '................'
        ], { O: '#1d2129', H: '#ffffff', L: '#dde4ed', M: '#aeb8c7', D: '#76808f' });
        break;

      case 'gold_ingot':
        drawGrid([
          '................',
          '................',
          '................',
          '.......OOOOOO...',
          '.....OOHWWLLLOO.',
          '....OHWWLLLHMMO.',
          '...OHHLLLLHHMMO.',
          '..OHHLLLLHMMMDO.',
          '.OHLLLLHMMMMDDO.',
          '.OLMMMMMMMDDDDO.',
          '.OMMMMMDDDDDDO..',
          '.ODDDDDDDDDDO...',
          '..OOOOOOOOOO....',
          '................',
          '................',
          '................'
        ], { O: '#382104', W: '#ffffff', H: '#fff7a8', L: '#ffdb42', M: '#e39e14', D: '#9e5d06' });
        break;

      case 'coal':
        drawGrid([
          '................',
          '................',
          '.....OOOOOO.....',
          '...OOHHMMMMO....',
          '..OHHMMMMMMDO...',
          '..OMMMMMMMMDDO..',
          '.OMMHHMMMMMDDO..',
          '.OMMMMMMMMMDDO..',
          '.OMMMMMMMDDDDO..',
          '.ODMMMMMDDDDDO..',
          '..ODMMMDDDDDO...',
          '...ODDDDDDDO....',
          '....OOOOOOO.....',
          '................',
          '................',
          '................'
        ], { O: '#0d0e12', H: '#596070', M: '#2e323b', D: '#1b1d24' });
        break;

      case 'raw_iron':
        drawGrid([
          '................',
          '......OOOOO.....',
          '....OOHHHLLOO...',
          '...OHWLLMMSSLO..',
          '..OHLLMMSSSMMDO.',
          '..OLMMSSSMMMMDDO',
          '.OOHMMMSMMHHMMDO',
          '.OHLLMMMMHLLMMDO',
          '.OLMMMDDMMSSMDDO',
          '.OMMMDDMMMSSDDDO',
          '..OMDDDDMMMMDDO.',
          '..OODDDDDDDDDO..',
          '....OODDDDDDO...',
          '......OOOOOO....',
          '................',
          '................'
        ], { O: '#2b1c12', W: '#fff4eb', H: '#f2d3ba', L: '#d9aa84', M: '#b07b58', S: '#cfd8e3', D: '#704930' });
        break;

      case 'raw_gold':
        drawGrid([
          '................',
          '........OOOO....',
          '......OOHWLLOO..',
          '...OOOOOHLLMMO..',
          '..OHWLLOHLMMMDO.',
          '.OHLLMMOOMMMMDDO',
          '.OLMMHHLLMMMMDDO',
          '.OMMHWWLLMMDDDO.',
          '.ODMMLLLMMMDDDO.',
          '..ODMMHHLMDDDDO.',
          '..OOMMLLMMDDDDO.',
          '...ODMMMMDDDDO..',
          '....ODDDDDDDO...',
          '.....OOOOOOO....',
          '................',
          '................'
        ], { O: '#382004', W: '#ffffff', H: '#fff8a8', L: '#ffda3d', M: '#e39d14', D: '#a66207' });
        break;

      case 'bed':
        drawGrid([
          '................',
          '................',
          '................',
          '................',
          '..OOOO..........',
          '.OWWWWO.OOOOOO..',
          '.OWWPPWOhhhhhhO.',
          '.OWPPPWOrrrrrrO.',
          '.OWPPPWOrrrrrrO.',
          '.OWWWWWORRRRRRO.',
          '.ObbbbbbbbbbbbO.',
          '.OddddddddddddO.',
          '.OddO......OddO.',
          '.OddO......OddO.',
          '..OO........OO..',
          '................'
        ], { O: '#24140a', W: '#ffffff', P: '#d2dce6', h: '#ff6b6b', r: '#db2c2c', R: '#9e1919', b: '#a87542', d: '#6b4520' });
        break;

      case 'stick':
        drawGrid([
          '................',
          '................',
          '...........OO...',
          '..........OLMO..',
          '.........OLMDO..',
          '........OLMDO...',
          '.......OLMDO....',
          '......OLMDO.....',
          '.....OLMDO......',
          '....OLMDO.......',
          '...OLMDO........',
          '..OLMDO.........',
          '..OMDO..........',
          '...OO...........',
          '................',
          '................'
        ], { O: '#29180a', L: '#c28e53', M: '#966532', D: '#6b441d' });
        break;

      case 'wheat_seeds':
        drawGrid([
          '................',
          '................',
          '................',
          '......OOO.......',
          '.....OGgGO......',
          '.....OGDGO..OO..',
          '......OOO..OGgO.',
          '..OO......OGDGO.',
          '.OGgO......OOO..',
          '.OGDGO..OOO.....',
          '..OOO..OGgGO....',
          '......OGDDGO....',
          '.......OOOO.....',
          '................',
          '................',
          '................'
        ], { O: '#1f3b0c', g: '#9de052', G: '#5da828', D: '#396e14' });
        break;

      case 'wheat':
        drawGrid([
          '................',
          '...........OO...',
          '.........OOHLO..',
          '........OHLMO...',
          '.......OHLMO....',
          '......OHLMOO....',
          '.....OHLMHLO....',
          '....OHLMLMO.....',
          '...OOGGMO.......',
          '..OOGgGO........',
          '..OLMO..........',
          '.OLMDO..........',
          '.OMDO...........',
          '..OO............',
          '................',
          '................'
        ], { O: '#3d2d09', H: '#fff099', L: '#edc645', M: '#c49621', D: '#8c6612', G: '#4a8f29', g: '#74c445' });
        break;

      case 'bone':
        drawGrid([
          '................',
          '..........OOO...',
          '.........OWWWO..',
          '.........OWWWO..',
          '........OWWBOO..',
          '.......OWWBO....',
          '......OWWBO.....',
          '.....OWWBO......',
          '....OWWBO.......',
          '...OWWBO........',
          '..OOWBO.........',
          '.OWWWBO.........',
          '.OWWWBO.........',
          '..OOBO..........',
          '...OO...........',
          '................'
        ], { O: '#2b2824', W: '#ffffff', B: '#d9d3c5' });
        break;

      case 'feather':
        drawGrid([
          '................',
          '..........OOO...',
          '........OOWWWO..',
          '.......OWWWLLO..',
          '......OWWLLWWO..',
          '.....OWWLLLWWO..',
          '....OWWLLLWWOO..',
          '...OWWLLLWWO....',
          '...OWLLLWOO.....',
          '..OWLLWOO.......',
          '..OLLO..........',
          '.OSSO...........',
          '.OSO............',
          '..O.............',
          '................',
          '................'
        ], { O: '#2a313b', W: '#ffffff', L: '#d6dee8', S: '#7c8694' });
        break;

      case 'leather':
        drawGrid([
          '................',
          '................',
          '..OOOO....OOOO..',
          '.OHLLMO..OMMMDO.',
          '.OHLLLMOOMMMMDO.',
          '..OLMMMMMMMMDO..',
          '..OMMMMMMMMMDO..',
          '..OMMMMMMMMDDO..',
          '..OMMMMMMMMDDO..',
          '.OHMMMMMMMMMDDO.',
          '.OLMMMMMMMMMDDO.',
          '..OMMMDDDDDDDO..',
          '...OOO....OOO...',
          '................',
          '................',
          '................'
        ], { O: '#2e1608', H: '#d98f57', L: '#bd723d', M: '#995528', D: '#6b3817' });
        break;

      case 'gunpowder':
        drawGrid([
          '................',
          '................',
          '................',
          '.....OOOOOO.....',
          '...OOHHMMMMO....',
          '..OHHMMMMMMDO...',
          '..OMMHHMMMMDDO..',
          '.OMMMMMMMMMDDDO.',
          '.OMMMHHMMMDDDDO.',
          '.ODMMMMMMDDDDDO.',
          '..ODDDDDDDDDDO..',
          '...OOOOOOOOOO...',
          '................',
          '................',
          '................',
          '................'
        ], { O: '#181a1f', H: '#949ba8', M: '#5c616e', D: '#33363f' });
        break;

      case 'flint':
        drawGrid([
          '................',
          '................',
          '.......OOOO.....',
          '......OHLLMO....',
          '.....OHLMMMDO...',
          '....OHLMMMMDDO..',
          '...OHLMMMMMDDDO.',
          '...OLMMMMMMDDDO.',
          '..OLMMMMDDDDDDO.',
          '..OMMMMDDDDDDDO.',
          '..OMMMDDDDDDDO..',
          '...ODDDDDDDDO...',
          '....ODDDDDDO....',
          '.....OOOOOO.....',
          '................',
          '................'
        ], { O: '#0f1117', H: '#8c95a6', L: '#5c6370', M: '#3a3f4a', D: '#22252e' });
        break;

      case 'flint_and_steel':
        drawGrid([
          '................',
          '....OOOOOO......',
          '...OHHLLLLOO....',
          '..OHLMMMMMMLO...',
          '..OLMO....OMLO..',
          '..OLMO..OOOMDO..',
          '..OMMO.OYY.OO...',
          '..OMMO..YF..OO..',
          '...ODMO....OflO.',
          '...OODMO..OflfO.',
          '.....OO..OflffO.',
          '........OflffdO.',
          '........OffdddO.',
          '.........OdddO..',
          '..........OOO...',
          '................'
        ], { O: '#16181f', H: '#ffffff', L: '#d6dde6', M: '#9aa4b3', D: '#656e7d', f: '#3d424d', l: '#6e7687', d: '#23262e', Y: '#fff08a', F: '#ff8a24' });
        break;

      case 'shears':
        drawGrid([
          '................',
          '.........OOO....',
          '........OHHLO...',
          '.......OHHLMO...',
          '......OHHLMO....',
          '.....OHHLMO..OO.',
          '....OHHLMOOOHHLO',
          '....OHLMMOHHLMOO',
          '...OODMMMLMMDO..',
          '..ORRRODMDDDO...',
          '.OR..RROOOOO....',
          '.OR...RORRRO....',
          '..ORRROR...RO...',
          '...OOOOR...RO...',
          '........ORRO....',
          '.........OO.....'
        ], { O: '#16181f', H: '#ffffff', L: '#dde4ed', M: '#9ea8b8', D: '#5f6878', R: '#b83228' });
        break;

      case 'bucket':
        drawGrid([
          '................',
          '................',
          '....OOOOOOOO....',
          '..OOHHLLLLMMOO..',
          '.OHLDDDDDDDDMMO.',
          '.OLODDDDDDDDOMO.',
          '.OHLMMMMMMMMMDO.',
          '..OHLMMMMMMMDO..',
          '..OHLMMMMMMMDO..',
          '..OLMMMMMMMMDO..',
          '...OLMMMMMMDO...',
          '...OMMMMMMDDO...',
          '....OMMMMMDO....',
          '....ODDDDDDO....',
          '.....OOOOOO.....',
          '................'
        ], { O: '#1b1f26', H: '#ffffff', L: '#dde4ed', M: '#aeb8c7', D: '#677180' });
        break;

      case 'water_bucket':
        drawGrid([
          '................',
          '................',
          '....OOOOOOOO....',
          '..OOHHLLLLMMOO..',
          '.OHLWWWWWWWWMMO.',
          '.OLOWwwWWwwwOMO.',
          '.OHLMMMMMMMMMDO.',
          '..OHLMMMMMMMDO..',
          '..OHLMMMMMMMDO..',
          '..OLMMMMMMMMDO..',
          '...OLMMMMMMDO...',
          '...OMMMMMMDDO...',
          '....OMMMMMDO....',
          '....ODDDDDDO....',
          '.....OOOOOO.....',
          '................'
        ], { O: '#1b1f26', H: '#ffffff', L: '#dde4ed', M: '#aeb8c7', D: '#677180', W: '#2878e6', w: '#78c6ff' });
        break;

      case 'lava_bucket':
        drawGrid([
          '................',
          '................',
          '....OOOOOOOO....',
          '..OOHHLLLLMMOO..',
          '.OHLFFYYYYFFMMO.',
          '.OLOFYYWWYYFOMO.',
          '.OHLMMMMMMMMMDO.',
          '..OHLMMMMMMMDO..',
          '..OHLMMMMMMMDO..',
          '..OLMMMMMMMMDO..',
          '...OLMMMMMMDO...',
          '...OMMMMMMDDO...',
          '....OMMMMMDO....',
          '....ODDDDDDO....',
          '.....OOOOOO.....',
          '................'
        ], { O: '#1b1f26', H: '#ffffff', L: '#dde4ed', M: '#aeb8c7', D: '#677180', F: '#e03e0d', Y: '#ff9d1c', W: '#fff48f' });
        break;

      default:
        c.fillStyle = '#222'; c.fillRect(6, 6, 20, 20);
        c.fillStyle = '#999'; c.fillRect(8, 8, 16, 16);
    }
  }

  // Crisp 3D Three.js CanvasTexture for dropped pixel-art items & foods!
  getItemTexture(itemKey) {
    if (this.itemTextures[itemKey]) return this.itemTextures[itemKey];
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 32;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const def = ITEMS[itemKey];
    if (def && def.isBlock && def.cross) {
      const tile = this.getUV(def.faces.all);
      ctx.drawImage(this.canvas, tile.ox, tile.oy, TILE_SIZE, TILE_SIZE, 0, 0, 32, 32);
    } else if (def) {
      this.drawPixelItem(ctx, itemKey, def);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    this.itemTextures[itemKey] = tex;
    return tex;
  }

  // Shared cached Lambert material for 3D voxel-extruded held/dropped items (zero duplicate GPU materials!)
  getExtrudedItemMaterial(itemKey) {
    if (!this.itemMatCache) this.itemMatCache = {};
    if (this.itemMatCache[itemKey]) return this.itemMatCache[itemKey];
    const tex = this.getItemTexture(itemKey);
    const mat = new THREE.MeshLambertMaterial({
      map: tex,
      transparent: false,
      alphaTest: 0.45
    });
    this.itemMatCache[itemKey] = mat;
    return mat;
  }

  // Shared cached Lambert material for 3D held blocks/stairs/fences/beds/ladders
  getBlockAtlasMaterial() {
    if (!this._sharedBlockAtlasMat) {
      this._sharedBlockAtlasMat = new THREE.MeshLambertMaterial({
        map: this.atlasTexture,
        alphaTest: 0.35
      });
    }
    return this._sharedBlockAtlasMat;
  }

  // True 3D Voxel-Extruded Pixel-Art Geometry for Held & Dropped Items, Tools, Foods & Doors!
  createExtrudedItemGeometry(itemKey, size = 0.36) {
    const cacheKey = `${itemKey}:${size}`;
    if (this.extrudedGeoCache[cacheKey]) return this.extrudedGeoCache[cacheKey];

    const tex = this.getItemTexture(itemKey);
    const imgCanvas = tex.image;
    const ctx = imgCanvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, 32, 32).data;

    // Sample the 16x16 logical pixel grid (check all 4 sub-texels so crisp 1px details never drop)
    const solid = new Uint8Array(256);
    for (let py = 0; py < 16; py++) {
      for (let px0 = 0; px0 < 16; px0++) {
        const a0 = imgData[((py * 2) * 32 + (px0 * 2)) * 4 + 3];
        const a1 = imgData[((py * 2) * 32 + (px0 * 2 + 1)) * 4 + 3];
        const a2 = imgData[((py * 2 + 1) * 32 + (px0 * 2)) * 4 + 3];
        const a3 = imgData[((py * 2 + 1) * 32 + (px0 * 2 + 1)) * 4 + 3];
        if (Math.max(a0, a1, a2, a3) > 120) solid[py * 16 + px0] = 1;
      }
    }

    const pos = [], norm = [], uv = [], idx = [];
    const cell = size / 16;
    const half = size * 0.5;
    const halfD = cell * 0.72; // authentic chunky 3D Minecraft voxel item thickness!

    const pushQuad = (p0, p1, p2, p3, n, u0, v0, u1, v1) => {
      const base = pos.length / 3;
      pos.push(...p0, ...p1, ...p2, ...p3);
      norm.push(...n, ...n, ...n, ...n);
      uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    // Front (+Z) and Back (-Z) full textured quads
    pushQuad(
      [-half, -half, halfD], [half, -half, halfD], [half, half, halfD], [-half, half, halfD],
      [0, 0, 1], 0, 0, 1, 1
    );
    pushQuad(
      [half, -half, -halfD], [-half, -half, -halfD], [-half, half, -halfD], [half, half, -halfD],
      [0, 0, -1], 1, 0, 0, 1
    );

    // Extruded perimeter pixel side walls (only where a solid pixel borders transparency!)
    const isSolid = (x, y) => (x >= 0 && x < 16 && y >= 0 && y < 16) ? solid[y * 16 + x] === 1 : false;
    for (let py = 0; py < 16; py++) {
      for (let px0 = 0; px0 < 16; px0++) {
        if (!solid[py * 16 + px0]) continue;
        const x0 = -half + px0 * cell;
        const x1 = x0 + cell;
        const y1 = half - py * cell;
        const y0 = y1 - cell;
        const u = (px0 + 0.5) / 16;
        const v = 1 - (py + 0.5) / 16;

        if (!isSolid(px0 - 1, py)) {
          pushQuad([x0, y0, -halfD], [x0, y0, halfD], [x0, y1, halfD], [x0, y1, -halfD], [-1, 0, 0], u, v, u, v);
        }
        if (!isSolid(px0 + 1, py)) {
          pushQuad([x1, y0, halfD], [x1, y0, -halfD], [x1, y1, -halfD], [x1, y1, halfD], [1, 0, 0], u, v, u, v);
        }
        if (!isSolid(px0, py - 1)) {
          pushQuad([x0, y1, halfD], [x1, y1, halfD], [x1, y1, -halfD], [x0, y1, -halfD], [0, 1, 0], u, v, u, v);
        }
        if (!isSolid(px0, py + 1)) {
          pushQuad([x0, y0, -halfD], [x1, y0, -halfD], [x1, y0, halfD], [x0, y0, halfD], [0, -1, 0], u, v, u, v);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    this.extrudedGeoCache[cacheKey] = geo;
    return geo;
  }

  // Real 3D pixel-art mini-block geometry mapped to exact atlas top/side/front/bottom UVs (cubes, stairs, fences, gates, beds, ladders)!
  createBlockDropGeometry(blockDef, size = 0.28) {
    const cacheKey = `${blockDef.id}:${size}`;
    if (this.blockDropGeoCache[cacheKey]) return this.blockDropGeoCache[cacheKey];

    const h = size * 0.5;
    const faces = blockDef.faces || {};
    const topUV = this.getUV(faces.top || faces.all || faces.side || 'stone');
    const botUV = this.getUV(faces.bottom || faces.all || faces.side || 'stone');
    const sideUV = this.getUV(faces.side || faces.all || faces.top || 'stone');
    const frontUV = faces.front ? this.getUV(faces.front) : sideUV;

    const pos = [], norm = [], uv = [], idx = [];
    let base = 0;
    const pushBox = (x0, y0, z0, x1, y1, z1, tU = topUV, bU = botUV, sU = sideUV, fU = frontUV) => {
      const boxFaces = [
        { uv: tU, n: [0, 1, 0], v: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]] },
        { uv: bU, n: [0, -1, 0], v: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
        { uv: sU, n: [1, 0, 0], v: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]] },
        { uv: sU, n: [-1, 0, 0], v: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] },
        { uv: fU, n: [0, 0, 1], v: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
        { uv: sU, n: [0, 0, -1], v: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]] }
      ];
      for (const f of boxFaces) {
        const u = f.uv;
        for (const pt of f.v) {
          pos.push(pt[0], pt[1], pt[2]);
          norm.push(f.n[0], f.n[1], f.n[2]);
        }
        uv.push(u.u0, u.v0, u.u1, u.v0, u.u1, u.v1, u.u0, u.v1);
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        base += 4;
      }
    };

    if (blockDef.isStair) {
      // Authentic 3D stepped-L stair model for held item & dropped stair items!
      pushBox(-h, -h, -h, h, 0, h);
      pushBox(-h, 0, -h, h, h, 0);
    } else if (blockDef.isFence) {
      // Authentic 3D 2-post + double-rail Minecraft Fence model!
      const pw = size * 0.14;
      const pz = size * 0.14;
      const rw = size * 0.08;
      pushBox(-h * 0.68 - pw, -h, -pz, -h * 0.68 + pw, h, pz);
      pushBox(h * 0.68 - pw, -h, -pz, h * 0.68 + pw, h, pz);
      pushBox(-h * 0.96, h * 0.20, -rw, h * 0.96, h * 0.56, rw);
      pushBox(-h * 0.96, -h * 0.44, -rw, h * 0.96, -h * 0.08, rw);
    } else if (blockDef.isFenceGate) {
      // Authentic 3D double-slat Minecraft Fence Gate model!
      const pw = size * 0.11;
      const rw = size * 0.08;
      pushBox(-h * 0.92, -h * 0.72, -pw, -h * 0.64, h * 0.85, pw);
      pushBox(h * 0.64, -h * 0.72, -pw, h * 0.92, h * 0.85, pw);
      pushBox(-h * 0.64, h * 0.34, -rw, h * 0.64, h * 0.66, rw);
      pushBox(-h * 0.64, -h * 0.32, -rw, h * 0.64, 0.0, rw);
      pushBox(-h * 0.14, -h * 0.32, -rw, h * 0.14, h * 0.66, rw);
    } else if (blockDef.id === 'bed') {
      // Authentic 3D miniature Minecraft Bed (oak legs/frame + red blanket + white pillow!)
      const plankUV = this.getUV('oak_planks');
      const blanketUV = this.getUV('bed_top_foot');
      const pillowUV = this.getUV('bed_top_head');
      const sideBedUV = this.getUV('bed_side_foot');
      const bx0 = -h * 0.62, bx1 = h * 0.62;
      const bz0 = -h * 1.15, bz1 = h * 1.15;
      const leg = size * 0.13;
      // 4 Wooden corner legs
      pushBox(bx0, -h * 0.55, bz0, bx0 + leg, -h * 0.18, bz0 + leg, plankUV, plankUV, plankUV, plankUV);
      pushBox(bx1 - leg, -h * 0.55, bz0, bx1, -h * 0.18, bz0 + leg, plankUV, plankUV, plankUV, plankUV);
      pushBox(bx0, -h * 0.55, bz1 - leg, bx0 + leg, -h * 0.18, bz1, plankUV, plankUV, plankUV, plankUV);
      pushBox(bx1 - leg, -h * 0.55, bz1 - leg, bx1, -h * 0.18, bz1, plankUV, plankUV, plankUV, plankUV);
      // Mattress base (red blanket lower half + pillow head section)
      pushBox(bx0, -h * 0.22, bz0 + size * 0.35, bx1, h * 0.30, bz1, blanketUV, plankUV, sideBedUV, sideBedUV);
      pushBox(bx0, -h * 0.22, bz0, bx1, h * 0.34, bz0 + size * 0.36, pillowUV, plankUV, pillowUV, pillowUV);
    } else if (blockDef.id === 'ladder') {
      // Authentic 3D wooden Ladder (two vertical side rails + 4 horizontal rungs!)
      const plankUV = this.getUV('oak_planks');
      const railW = size * 0.11;
      const railD = size * 0.08;
      pushBox(-h * 0.78, -h, -railD, -h * 0.78 + railW * 2, h, railD, plankUV, plankUV, plankUV, plankUV);
      pushBox(h * 0.78 - railW * 2, -h, -railD, h * 0.78, h, railD, plankUV, plankUV, plankUV, plankUV);
      for (const ry of [-0.65, -0.22, 0.22, 0.65]) {
        pushBox(-h * 0.72, h * ry - railW * 0.65, -railD * 0.85, h * 0.72, h * ry + railW * 0.65, railD * 0.85, plankUV, plankUV, plankUV, plankUV);
      }
    } else {
      pushBox(-h, -h, -h, h, h, h);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    this.blockDropGeoCache[cacheKey] = geo;
    return geo;
  }

  // 10-Stage Minecraft-style Pixel-Art Block Breaking Crack Overlays!
  buildCrackTextures() {
    // Deterministic branching fracture pixel paths radiating from block center (7,7)
    const branches = [
      [[7,7],[8,7],[8,6],[9,5],[10,5],[11,4],[12,3],[13,3],[14,2],[15,1]],
      [[7,7],[6,8],[5,8],[4,9],[3,10],[2,11],[2,12],[1,13],[0,14]],
      [[7,7],[7,6],[6,5],[6,4],[5,3],[4,2],[3,1],[2,0]],
      [[8,8],[9,9],[10,9],[11,10],[12,11],[13,12],[14,13],[14,14],[15,15]],
      [[8,6],[9,7],[10,8],[11,8],[12,8],[13,7],[14,7],[15,7]],
      [[6,8],[5,7],[4,7],[3,6],[2,6],[1,5],[0,5]],
      [[7,9],[7,10],[8,11],[8,12],[9,13],[9,14],[10,15]],
      [[8,5],[8,4],[9,3],[9,2],[10,1],[11,0]],
      [[4,9],[4,10],[5,11],[5,12],[4,13],[3,14]],
      [[11,10],[11,11],[12,12],[12,13],[13,14]]
    ];

    for (let stage = 0; stage < 10; stage++) {
      const c = document.createElement('canvas');
      c.width = 16;
      c.height = 16;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, 16, 16);

      const numBranches = Math.min(branches.length, 2 + stage);
      const frac = (stage + 1) / 10;

      // Subtle dark fracture vignette at late stages
      if (stage >= 6) {
        ctx.fillStyle = `rgba(0,0,0,${(stage - 5) * 0.055})`;
        ctx.fillRect(0, 0, 16, 16);
      }

      for (let b = 0; b < numBranches; b++) {
        const pts = branches[b];
        const count = Math.max(1, Math.ceil(pts.length * frac));
        for (let i = 0; i < count; i++) {
          const [x, y] = pts[i];
          // Crisp dark fracture pixel + subtle pale edge highlight
          ctx.fillStyle = 'rgba(10, 10, 12, 0.88)';
          ctx.fillRect(x, y, 1, 1);
          if (stage >= 4 && i < count - 1) {
            ctx.fillStyle = 'rgba(20, 20, 24, 0.55)';
            ctx.fillRect(Math.min(15, x + 1), y, 1, 1);
          }
          if (stage >= 7 && (i % 2 === 0)) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
            ctx.fillRect(x, Math.min(15, y + 1), 1, 1);
          }
        }
      }

      const tex = new THREE.CanvasTexture(c);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      this.crackTextures.push(tex);
    }
  }

  // Procedural 16x16 Pixel-Art Animal Fur / Wool / Scale / Shell Coat Textures!
  makeMobCoatTexture(baseHex, darkHex, lightHex, pattern = 'fur', seed = 1) {
    const key = `${baseHex}_${darkHex}_${lightHex}_${pattern}_${seed}`;
    if (this.mobCoatCache[key]) return this.mobCoatCache[key];

    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    const ctx = c.getContext('2d');
    const hexStr = (n) => '#' + n.toString(16).padStart(6, '0');
    const baseStr = hexStr(baseHex);
    const darkStr = hexStr(darkHex);
    const lightStr = hexStr(lightHex);

    fillNoise(ctx, 0, 0, baseStr, 11, seed);

    if (pattern === 'fur') {
      for (let i = 0; i < 28; i++) {
        const x = Math.floor(pxHash(i, 1, seed + 5) * 16);
        const y = Math.floor(pxHash(i, 2, seed + 5) * 15);
        px(ctx, 0, 0, x, y, i % 2 === 0 ? darkStr : lightStr, 1, 2);
      }
    } else if (pattern === 'wool') {
      for (let y = 0; y < 16; y += 2) {
        for (let x = 0; x < 16; x += 2) {
          const h = pxHash(x, y, seed + 9);
          px(ctx, 0, 0, x, y, h > 0.65 ? lightStr : (h < 0.3 ? darkStr : baseStr), 2, 2);
        }
      }
    } else if (pattern === 'spots') {
      for (let i = 0; i < 8; i++) {
        const x = Math.floor(pxHash(i, 3, seed + 11) * 12);
        const y = Math.floor(pxHash(i, 4, seed + 11) * 12);
        const w = 2 + Math.floor(pxHash(i, 5, seed + 11) * 3);
        const h = 2 + Math.floor(pxHash(i, 6, seed + 11) * 3);
        px(ctx, 0, 0, x, y, i % 3 === 0 ? darkStr : lightStr, w, h);
      }
    } else if (pattern === 'dappled') {
      for (let i = 0; i < 12; i++) {
        const x = Math.floor(pxHash(i, 7, seed + 13) * 14);
        const y = Math.floor(pxHash(i, 8, seed + 13) * 14);
        px(ctx, 0, 0, x, y, lightStr, 2, 1);
      }
    } else if (pattern === 'shell') {
      ctx.fillStyle = darkStr;
      for (let y = 0; y < 16; y += 4) ctx.fillRect(0, y, 16, 1);
      for (let x = 0; x < 16; x += 4) ctx.fillRect(x, 0, 1, 16);
      for (let y = 1; y < 16; y += 4) {
        for (let x = 1; x < 16; x += 4) {
          px(ctx, 0, 0, x, y, lightStr, 2, 2);
        }
      }
    } else if (pattern === 'scales') {
      for (let y = 0; y < 16; y += 2) {
        for (let x = (y % 4 === 0 ? 0 : 1); x < 16; x += 2) {
          px(ctx, 0, 0, x, y, (x + y) % 3 === 0 ? lightStr : darkStr, 1, 1);
        }
      }
    } else if (pattern === 'stripes') {
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const band = (x + ((y >> 2) & 1)) % 4;
          px(ctx, 0, 0, x, y, band < 2 ? darkStr : (band === 2 ? lightStr : baseStr));
        }
      }
    }

    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    this.mobCoatCache[key] = tex;
    return tex;
  }

  // Ultra-Detailed 16x16 Pixel-Art Villager Face, Nose, Embroidered Robe & Hat Texture Suite!
  getVillagerTextures(profName = 'Farmer') {
    if (this.villagerTexCache[profName]) return this.villagerTexCache[profName];

    const makeTex16 = (drawFn) => {
      const c = document.createElement('canvas');
      c.width = 16;
      c.height = 16;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      drawFn(ctx, (x, y, col, w = 1, h = 1) => {
        ctx.fillStyle = col;
        ctx.fillRect(x, y, w, h);
      });
      const tex = new THREE.CanvasTexture(c);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false;
      return tex;
    };

    const skinPal = {
      hi: '#e6b793', base: '#d9a47c', mid: '#c9926b', lo: '#ad7955', brow: '#472d1b', browHi: '#613f26',
      mouth: '#8c5a3c', white: '#f5f7fa', eyeG: '#258a48', eyeHi: '#5be383', eyeDk: '#134d26'
    };

    // 1. Iconic Expressive Minecraft Villager Face (16x16!)
    const headFront = makeTex16((c, p) => {
      fillNoise(c, 0, 0, skinPal.base, 7, 201);
      // Forehead highlight & subtle wrinkle crease
      p(2, 1, skinPal.hi, 12, 3);
      p(4, 3, skinPal.mid, 8, 1);
      // Side temple shading for 3D facial contour
      p(0, 0, skinPal.mid, 1, 16); p(15, 0, skinPal.mid, 1, 16);
      p(0, 14, skinPal.lo, 16, 2);
      // Iconic thick expressive unibrow!
      p(2, 5, skinPal.brow, 12, 2);
      p(3, 5, skinPal.browHi, 10, 1);
      // Shadow directly under brow
      p(2, 7, skinPal.lo, 12, 1);
      // Left & Right Gleaming Emerald Eyes (sclera + green iris + dark pupil + white catchlight)
      p(2, 8, skinPal.white, 4, 2);
      p(4, 8, skinPal.eyeG, 2, 2); p(4, 8, skinPal.eyeHi, 1, 1); p(5, 9, skinPal.eyeDk, 1, 1);
      p(10, 8, skinPal.white, 4, 2);
      p(10, 8, skinPal.eyeG, 2, 2); p(10, 8, skinPal.eyeHi, 1, 1); p(11, 9, skinPal.eyeDk, 1, 1);
      // Subtle cheek blush & nose bridge shadow
      p(1, 10, '#cf8e72', 3, 2); p(12, 10, '#cf8e72', 3, 2);
      p(6, 9, skinPal.lo, 4, 4);
      // Gentle calm villager mouth crease
      p(5, 13, skinPal.mouth, 6, 1);
      p(6, 14, skinPal.mid, 4, 1);
    });

    const headSide = makeTex16((c, p) => {
      fillNoise(c, 0, 0, skinPal.base, 7, 202);
      p(0, 0, skinPal.mid, 16, 2);
      p(0, 14, skinPal.lo, 16, 2);
      // Subtle sculpted ear detail
      p(6, 7, skinPal.lo, 3, 4);
      p(7, 8, skinPal.hi, 1, 2);
      // Hairline tuft on back half
      p(10, 0, '#4f3522', 6, 7);
      p(12, 7, '#4f3522', 4, 4);
    });

    const headBack = makeTex16((c, p) => {
      fillNoise(c, 0, 0, skinPal.base, 7, 203);
      p(0, 0, '#4f3522', 16, 9);
      p(2, 9, '#3d2818', 12, 2);
      p(0, 14, skinPal.lo, 16, 2);
    });

    const headTop = makeTex16((c, p) => {
      fillNoise(c, 0, 0, skinPal.hi, 6, 204);
      p(0, 10, '#4f3522', 16, 6);
    });

    const nose = makeTex16((c, p) => {
      fillNoise(c, 0, 0, skinPal.base, 6, 205);
      p(2, 0, skinPal.hi, 12, 6);
      p(0, 12, skinPal.lo, 16, 4);
      p(3, 13, '#7d4f34', 3, 2); p(10, 13, '#7d4f34', 3, 2); // nostrils on bottom edge!
    });

    // Profession Color Palettes (authentic Minecraft Village & Pillage style!)
    const profStyles = {
      Farmer:     { robe: '#8c5e34', dark: '#5e3c1f', hi: '#ad7a49', trim: '#d9b54a', sash: '#4a3019', badge: '#34d159', seed: 210 },
      Blacksmith: { robe: '#4a4e57', dark: '#2a2d33', hi: '#6a707d', trim: '#9aa3b0', sash: '#241b16', badge: '#f5b324', seed: 211 },
      Librarian:  { robe: '#9e2828', dark: '#6b1616', hi: '#c24040', trim: '#f0c846', sash: '#f0e8d5', badge: '#38d9f5', seed: 212 },
      Cleric:     { robe: '#6b2c91', dark: '#461863', hi: '#8d4ab8', trim: '#f5cc42', sash: '#35124d', badge: '#ff52e8', seed: 213 }
    };
    const st = profStyles[profName] || profStyles.Farmer;

    // 2. Detailed Embroidered Profession Robe Front (with V-collar, center seam, belt, buckle & level gem!)
    const robeFront = makeTex16((c, p) => {
      fillNoise(c, 0, 0, st.robe, 9, st.seed);
      // Vertical cloth folds & shading
      p(0, 0, st.dark, 2, 16); p(14, 0, st.dark, 2, 16);
      p(3, 2, st.hi, 2, 12); p(11, 2, st.hi, 2, 12);
      // Center coat opening & embroidered gold/trim lapel
      p(7, 0, st.dark, 2, 16);
      p(6, 0, st.trim, 1, 15); p(9, 0, st.trim, 1, 15);
      // Collar V-neck
      p(4, 0, st.sash, 8, 2); p(6, 2, st.sash, 4, 2);
      // Stitched leather belt + metal buckle + profession Emerald/Gold Gem Badge!
      p(0, 9, st.sash, 16, 2);
      p(6, 9, '#f2cc4c', 4, 2);
      p(7, 9, '#5e4314', 2, 1);
      p(11, 9, '#241b12', 3, 3);
      p(12, 10, st.badge, 1, 1);
      // Embroidered bottom hem border
      p(0, 14, st.trim, 16, 1);
      p(0, 15, st.dark, 16, 1);
    });

    const robeSide = makeTex16((c, p) => {
      fillNoise(c, 0, 0, st.robe, 9, st.seed + 5);
      p(0, 0, st.dark, 1, 16); p(15, 0, st.dark, 1, 16);
      p(6, 0, st.hi, 4, 14);
      p(0, 9, st.sash, 16, 2);
      p(0, 14, st.trim, 16, 1);
      p(0, 15, st.dark, 16, 1);
    });

    const robeBack = makeTex16((c, p) => {
      fillNoise(c, 0, 0, st.robe, 9, st.seed + 9);
      p(0, 0, st.dark, 2, 16); p(14, 0, st.dark, 2, 16);
      p(2, 0, st.trim, 12, 3); // shoulder hood/cape drape
      p(3, 1, st.robe, 10, 2);
      p(0, 9, st.sash, 16, 2);
      p(0, 14, st.trim, 16, 1);
      p(0, 15, st.dark, 16, 1);
    });

    // Woven Straw Hat Texture (Farmer)
    const strawTex = makeTex16((c, p) => {
      fillNoise(c, 0, 0, '#e3c159', 10, 220);
      for (let y = 0; y < 16; y += 2) {
        for (let x = 0; x < 16; x += 2) {
          p(x, y, ((x + y) % 4 === 0) ? '#f5dd84' : '#bd9834', 2, 1);
        }
      }
      p(0, 0, '#a37e24', 16, 1); p(0, 15, '#a37e24', 16, 1);
    });

    // Blacksmith Riveted Leather Apron Texture
    const apronTex = makeTex16((c, p) => {
      fillNoise(c, 0, 0, '#2a2626', 8, 221);
      p(0, 0, '#171515', 16, 1); p(0, 15, '#171515', 16, 1);
      p(2, 2, '#9ca6b5', 2, 2); p(12, 2, '#9ca6b5', 2, 2); // iron rivets
      p(2, 10, '#453e3e', 12, 3); // front tool pocket
      p(4, 11, '#c9d2de', 2, 2); // pocket tongs
    });

    const set = { headFront, headSide, headBack, headTop, nose, robeFront, robeSide, robeBack, strawTex, apronTex, style: st };
    this.villagerTexCache[profName] = set;
    return set;
  }

  // Unified Coherent 16x16 Pixel-Art HUD Icons (Hearts, Food, Water Bubbles, Armor — exact same 16x16 density as all UI!)
  buildHudIcons() {
    const render16 = (rows, palette) => {
      const c = document.createElement('canvas');
      c.width = 32;
      c.height = 32;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      for (let y = 0; y < 16; y++) {
        const row = rows[y];
        for (let x = 0; x < 16; x++) {
          const col = palette[row[x]];
          if (col) {
            ctx.fillStyle = col;
            ctx.fillRect(x * 2, y * 2, 2, 2);
          }
        }
      }
      return c.toDataURL();
    };

    // 16x16 Crisp Minecraft Pixel Hearts (full / half / empty)
    const heartFull = [
      '................',
      '..OOOO....OOOO..',
      '.ORRRRO..ORRRRO.',
      'ORWWRRROORRRRRRO',
      'ORWWRRRRRRRRRRRO',
      'ORRRRRRRRRRRRRRO',
      'ORRRRRRRRRRRRRDO',
      'ORRRRRRRRRRRRDO.',
      '.ORRRRRRRRRRDO..',
      '..ORRRRRRRRDO...',
      '...ORRRRRRDO....',
      '....ORRRRDO.....',
      '.....ORRDO......',
      '......ODO.......',
      '.......O........',
      '................'
    ];
    const heartHalf = [
      '................',
      '..OOOO....OOOO..',
      '.ORRRRO..OBBBBO.',
      'ORWWRRROOBBBBBBO',
      'ORWWRRRRBBBBBBBO',
      'ORRRRRRRBBBBBBBO',
      'ORRRRRRRBBBBBBBO',
      'ORRRRRRRBBBBBBO.',
      '.ORRRRRRBBBBBO..',
      '..ORRRRRBBBBO...',
      '...ORRRRBBBO....',
      '....ORRRBBBO....',
      '.....ORRBBO.....',
      '......OBO.......',
      '.......O........',
      '................'
    ];
    const heartEmpty = [
      '................',
      '..OOOO....OOOO..',
      '.OBBBBO..OBBBBO.',
      'OBBBBBBOOBBBBBBO',
      'OBBBBBBBBBBBBBBO',
      'OBBBBBBBBBBBBBBO',
      'OBBBBBBBBBBBBBBO',
      'OBBBBBBBBBBBBBO.',
      '.OBBBBBBBBBBBBO.',
      '..OBBBBBBBBBBO..',
      '...OBBBBBBBBO...',
      '....OBBBBBBO....',
      '.....OBBBBO.....',
      '......OBBO......',
      '.......OO.......',
      '................'
    ];
    const heartPal = {
      O: '#140c0c',
      R: '#e32626',
      D: '#9c1111',
      W: '#ffc7c7',
      B: '#2b1b1b'
    };
    this.hudIcons.heart_full = render16(heartFull, heartPal);
    this.hudIcons.heart_half = render16(heartHalf, heartPal);
    this.hudIcons.heart_empty = render16(heartEmpty, heartPal);

    // 16x16 Crisp Pixel Roasted Meat Drumstick (Food / Hunger)
    const foodFull = [
      '................',
      '.......OOOOOO...',
      '.....OOLLLLLLO..',
      '....OLLMMMMMMLO.',
      '...OLMMMMMMMMDDO',
      '...OMMMMMMMMDDO.',
      '...OMMMMMMMMDDO.',
      '...OMMMMMMMDDDO.',
      '....OMMMDDDDDO..',
      '...OOBBDDDDDO...',
      '..OWWBOOODOO....',
      '.OWWWBO.........',
      '.OWWBO..........',
      '..OOO...........',
      '................',
      '................'
    ];
    const foodHalf = [
      '................',
      '.......OOOOOO...',
      '.....OOBBBBBBO..',
      '....OBBBBBBBBBO.',
      '...OBBBBBBBBBBO.',
      '...OBBBBBMMMDD0.',
      '...OBBBBMMMMDDO.',
      '...OBBBBMMMDDDO.',
      '....OBBBDDDDDO..',
      '...OOBBDDDDDO...',
      '..OWWBOOODOO....',
      '.OWWWBO.........',
      '.OWWBO..........',
      '..OOO...........',
      '................',
      '................'
    ].map((r) => r.replace('0', 'O'));
    const foodEmpty = [
      '................',
      '.......OOOOOO...',
      '.....OOBBBBBBO..',
      '....OBBBBBBBBBO.',
      '...OBBBBBBBBBBBO',
      '...OBBBBBBBBBBO.',
      '...OBBBBBBBBBBO.',
      '...OBBBBBBBBBBO.',
      '....OBBBBBBBBO..',
      '...OOBBBBBBBBO..',
      '..OBBBOOOOOOO...',
      '.OBBBBO.........',
      '.OBBBO..........',
      '..OOO...........',
      '................',
      '................'
    ];
    const foodPal = {
      O: '#1f1209',
      L: '#f0ac59',
      M: '#c46f2b',
      D: '#7d3c11',
      B: '#d9d0be',
      W: '#ffffff'
    };
    const foodEmptyPal = { O: '#1f1209', B: '#2b2019' };
    this.hudIcons.food_full = render16(foodFull, foodPal);
    this.hudIcons.food_half = render16(foodHalf, { ...foodPal, B: '#2b2019' });
    this.hudIcons.food_empty = render16(foodEmpty, foodEmptyPal);

    // 16x16 Glossy Pixel Water / Air Bubble
    const bubbleFull = [
      '................',
      '.....OOOOOO.....',
      '...OOBLLLLBOO...',
      '..OBLWWWWWLLBO..',
      '.OBLWWLLLLBBBBO.',
      '.OBLWLLBBBBBBBO.',
      'OBLLBBBBBBBBBBDO',
      'OBLBBBBBBBBBBBDO',
      'OBBBBBBBBBBBBBDO',
      'OBBBBBBBBBBBBDD0',
      '.OBBBBBBBBBBDD0.',
      '.OBBBBBBBBBDD0..',
      '..OBBBBBBBDD0...',
      '...OODDDDD0O....',
      '.....OOOOOO.....',
      '................'
    ].map((r) => r.replaceAll('0', 'O'));
    const bubblePop = [
      '................',
      '..O..........O..',
      '...O........O...',
      '.......LL.......',
      '....O.L..L.O....',
      '...L........L...',
      '..O..........O..',
      '.......WW.......',
      '..O..........O..',
      '...L........L...',
      '....O.L..L.O....',
      '.......LL.......',
      '...O........O...',
      '..O..........O..',
      '................',
      '................'
    ];
    const bubblePal = {
      O: '#0b355c',
      W: '#ffffff',
      L: '#bae6fd',
      B: '#38bdf8',
      D: '#1572b6'
    };
    this.hudIcons.bubble_full = render16(bubbleFull, bubblePal);
    this.hudIcons.bubble_pop = render16(bubblePop, bubblePal);

    // 16x16 Pixel Iron Armor Shield / Chestplate
    const armorFull = [
      '................',
      '..OOOO....OOOO..',
      '.OSSSSO..OSSSSO.',
      'OSSWWSSOOSSWWSSO',
      'OSSWWWWWWWWWWSSO',
      'OSSWWSSSSSSWWSSO',
      '.OSSSSSSSSSSSSO.',
      '.OSSSDDDDDDSSSO.',
      '.OSSSDDDDDDSSSO.',
      '..OSSDDDDDDSSO..',
      '..OSSDDDDDDSSO..',
      '...OSSDDDDSSO...',
      '....OSDDDDDO....',
      '.....ODDDDO.....',
      '......OOOO......',
      '................'
    ];
    const armorHalf = [
      '................',
      '..OOOO....OOOO..',
      '.OSSSSO..OBBBBO.',
      'OSSWWSSOOBBBBBBO',
      'OSSWWWWWWBBBBBBO',
      'OSSWWSSSSBBBBBBO',
      '.OSSSSSSSBBBBBO.',
      '.OSSSDDDDBBBBBO.',
      '.OSSSDDDDBBBBBO.',
      '..OSSDDDDBBBBO..',
      '..OSSDDDDBBBBO..',
      '...OSSDDDBBBO...',
      '....OSDDDBBO....',
      '.....ODDDBO.....',
      '......OOOO......',
      '................'
    ];
    const armorPal = {
      O: '#14171f',
      W: '#ffffff',
      S: '#cfd7e3',
      D: '#7d8899',
      B: '#262b36'
    };
    this.hudIcons.armor_full = render16(armorFull, armorPal);
    this.hudIcons.armor_half = render16(armorHalf, armorPal);
  }

  getUiIcon(name) {
    return this.uiIcons[name] || this.hudIcons[name] || this.itemIcons[name] || '';
  }

  // Crisp 16x16 Pixel Art for EVERY UI Button, Tab, Action Control & Command (ZERO EMOJIS!)
  buildUiIcons() {
    const make = (drawFn) => {
      const c = document.createElement('canvas');
      c.width = 32;
      c.height = 32;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      const p = (x, y, col, w = 1, h = 1) => {
        ctx.fillStyle = col;
        ctx.fillRect(x * 2, y * 2, w * 2, h * 2);
      };
      drawFn(p, ctx);
      return c.toDataURL();
    };

    // 1. PLACE — Isometric pixel grass/dirt block with bright green placement highlight!
    this.uiIcons.place = make((p) => {
      // Outline
      p(4, 2, '#141812', 8, 1);
      p(2, 3, '#141812', 12, 2);
      p(1, 5, '#141812', 14, 7);
      p(3, 12, '#141812', 10, 2);
      p(6, 14, '#141812', 4, 1);
      // Top bright grass diamond
      p(5, 3, '#72c944', 6, 1);
      p(3, 4, '#63b538', 10, 2);
      p(5, 6, '#529e2b', 6, 1);
      p(6, 4, '#a2f06c', 3, 1);
      // Left shaded dirt/grass face
      p(2, 6, '#488725', 6, 2);
      p(2, 8, '#8a5d36', 6, 4);
      p(4, 12, '#734b29', 4, 1);
      p(3, 9, '#694425', 2, 1);
      // Right darker dirt/grass face
      p(8, 6, '#396e1d', 6, 2);
      p(8, 8, '#6b4526', 6, 4);
      p(8, 12, '#57361d', 4, 1);
      p(10, 10, '#4d2e17', 2, 1);
      // Center seam highlight
      p(7, 7, '#a8794c', 1, 6);
    });

    // 2. USE — Glowing interact hand / golden-teal activation spark (Villagers, Crafting Table, Furnace, Chest, Bed)
    this.uiIcons.use = make((p) => {
      // Pixel open hand reaching forward + golden interact sparkle!
      p(5, 2, '#1f140d', 2, 6);
      p(8, 1, '#1f140d', 2, 7);
      p(11, 2, '#1f140d', 2, 6);
      p(2, 6, '#1f140d', 3, 5);
      p(4, 7, '#1f140d', 9, 7);
      // Skin fill
      p(6, 3, '#f0be96', 1, 5);
      p(9, 2, '#f0be96', 1, 6);
      p(12, 3, '#e3ad84', 1, 5);
      p(3, 7, '#f0be96', 2, 3);
      p(5, 8, '#e8b38a', 7, 5);
      p(6, 9, '#ffd7b5', 4, 2);
      p(5, 12, '#c48d66', 7, 1);
      // Golden interact glint above fingers
      p(2, 2, '#ffe066', 2, 1);
      p(3, 1, '#fff5b8', 1, 3);
      p(14, 1, '#5cf2f7', 1, 2);
    });

    // 2b. EAT — Crisp pixel-art juicy drumstick with warm appetite sparkle (when holding food!)
    this.uiIcons.eat = make((p) => {
      // Bone handle (bottom-left)
      p(1, 11, '#29150a', 4, 4);
      p(2, 12, '#fff8ed', 2, 2);
      p(4, 9, '#29150a', 3, 3);
      p(5, 10, '#e8dcc8', 1, 1);
      // Meaty roasted drumstick body (center to upper-right)
      p(6, 2, '#291206', 7, 2);
      p(5, 3, '#291206', 9, 6);
      p(6, 8, '#291206', 7, 2);
      p(7, 3, '#f7c873', 5, 2);
      p(6, 4, '#de9338', 7, 4);
      p(7, 8, '#a65416', 5, 1);
      p(8, 3, '#fff0b3', 2, 1);
      p(11, 5, '#b8621d', 2, 3);
      // Warm bite/crumb sparkle!
      p(2, 3, '#ffe066', 2, 1);
      p(3, 2, '#fff5b8', 1, 3);
      p(13, 10, '#ffb74d', 1, 1);
    });

    // 3. MINE — Crisp pixel iron/diamond pickaxe!
    this.uiIcons.mine = make((p) => {
      // Handle (diagonal)
      for (let i = 0; i < 9; i++) {
        p(2 + i, 13 - i, '#2b1b0e', 2, 2);
        p(2 + i, 13 - i, i % 2 === 0 ? '#9c6b36' : '#7d5225', 1, 1);
      }
      // Pickaxe steel/cyan head with dark outline
      p(4, 1, '#162026', 8, 3);
      p(10, 2, '#162026', 4, 4);
      p(12, 5, '#162026', 3, 6);
      p(5, 2, '#dce6f0', 6, 1);
      p(6, 3, '#9fb0c2', 5, 1);
      p(11, 3, '#ffffff', 2, 2);
      p(13, 5, '#b8c8d8', 1, 5);
      p(12, 4, '#5ce6ed', 1, 2);
    });

    // 4. DAMAGE — Gleaming crimson-edged pixel battle sword (when aiming at animals/mobs!)
    this.uiIcons.damage = make((p) => {
      // Pommel & hilt
      p(2, 12, '#24140c', 3, 3);
      p(3, 13, '#f5c731', 1, 1);
      p(4, 10, '#6e451e', 2, 2);
      // Crossguard
      p(3, 8, '#1f1610', 3, 2);
      p(6, 11, '#1f1610', 2, 3);
      p(4, 9, '#f5c731', 4, 2);
      p(5, 10, '#c7961a', 2, 2);
      // Diagonal razor blade
      for (let i = 0; i < 8; i++) {
        p(6 + i, 9 - i, '#1f1014', 3, 3);
      }
      for (let i = 0; i < 8; i++) {
        p(7 + i, 9 - i, '#e6eef5', 1, 2);
        p(7 + i, 8 - i, '#ffffff', 1, 1);
      }
      // Crimson attack slash sparks!
      p(2, 4, '#ff4d4d', 2, 1);
      p(4, 3, '#ff8a80', 3, 1);
      p(11, 11, '#ff4d4d', 2, 1);
    });

    // 5. JUMP — Crisp upward pixel boot/arrow
    this.uiIcons.jump = make((p) => {
      p(7, 2, '#0d1a26', 2, 12);
      p(5, 4, '#0d1a26', 6, 3);
      p(3, 6, '#0d1a26', 10, 3);
      p(7, 3, '#e8f6ff', 2, 10);
      p(6, 4, '#7dd3fc', 4, 2);
      p(4, 6, '#38bdf8', 8, 2);
      p(7, 4, '#ffffff', 2, 3);
      p(5, 13, '#38bdf8', 6, 1);
    });

    // 6. SNEAK — Crisp downward pixel arrow
    this.uiIcons.sneak = make((p) => {
      p(7, 2, '#14181f', 2, 11);
      p(3, 7, '#14181f', 10, 3);
      p(5, 10, '#14181f', 6, 3);
      p(7, 3, '#cbd5e1', 2, 9);
      p(4, 8, '#94a3b8', 8, 2);
      p(6, 10, '#e2e8f0', 4, 2);
      p(7, 12, '#ffffff', 2, 1);
    });

    // 7. SPRINT — Golden pixel lightning bolt
    this.uiIcons.sprint = make((p) => {
      p(8, 1, '#261a05', 5, 2);
      p(6, 3, '#261a05', 5, 3);
      p(4, 6, '#261a05', 9, 3);
      p(6, 9, '#261a05', 5, 3);
      p(4, 12, '#261a05', 5, 3);
      p(9, 2, '#fff08a', 3, 2);
      p(7, 4, '#ffd54f', 3, 2);
      p(5, 6, '#ffca28', 7, 2);
      p(7, 8, '#ffb300', 3, 3);
      p(5, 11, '#ff9800', 3, 3);
      p(6, 6, '#ffffff', 2, 1);
    });

    // 8. MENU (Pause) — Pixel 3-bar bevel lines
    this.uiIcons.menu = make((p) => {
      for (const y of [3, 7, 11]) {
        p(2, y, '#141414', 12, 3);
        p(3, y + 1, '#f0f4f8', 10, 1);
        p(3, y, '#ffffff', 10, 1);
      }
    });

    // 9. CHAT — Pixel speech bubble
    this.uiIcons.chat = make((p) => {
      p(2, 2, '#141414', 12, 9);
      p(4, 11, '#141414', 4, 3);
      p(3, 3, '#f0f4f8', 10, 7);
      p(5, 10, '#f0f4f8', 2, 3);
      p(5, 5, '#475569', 6, 1);
      p(5, 7, '#475569', 4, 1);
    });

    // 10. CAMERA (Perspective Eye) — Crisp pixel eye
    this.uiIcons.camera = make((p) => {
      p(4, 4, '#141414', 8, 8);
      p(2, 6, '#141414', 12, 4);
      p(3, 6, '#ffffff', 10, 4);
      p(5, 5, '#ffffff', 6, 6);
      p(6, 6, '#2563eb', 4, 4);
      p(7, 7, '#0f172a', 2, 2);
      p(6, 6, '#93c5fd', 1, 1);
    });

    // 11. MODS — Emerald pixel cog/addon block
    this.uiIcons.mods = make((p) => {
      p(6, 1, '#142614', 4, 14);
      p(1, 6, '#142614', 14, 4);
      p(3, 3, '#142614', 10, 10);
      p(7, 2, '#52e052', 2, 12);
      p(2, 7, '#52e052', 12, 2);
      p(4, 4, '#3ab53a', 8, 8);
      p(5, 5, '#8cff8c', 2, 2);
      p(6, 6, '#182b18', 4, 4);
    });

    // 12. BAG / INVENTORY — Pixel leather adventurer backpack/chest
    this.uiIcons.bag = make((p) => {
      p(5, 2, '#24160b', 6, 2);
      p(3, 4, '#24160b', 10, 10);
      p(4, 5, '#b87638', 8, 8);
      p(4, 5, '#d69652', 8, 3);
      p(3, 8, '#3b2410', 10, 1);
      p(7, 7, '#ffd54f', 2, 3);
      p(7, 8, '#fff2a6', 1, 1);
    });

    // 13. DOTS (Hotbar Inventory Grid)
    this.uiIcons.dots = make((p) => {
      for (const y of [3, 7, 11]) {
        for (const x of [3, 7, 11]) {
          p(x, y, '#141414', 3, 3);
          p(x, y, '#f0f4f8', 2, 2);
        }
      }
    });

    // 14. CLOSE (Pixel X)
    this.uiIcons.close = make((p) => {
      for (let i = 0; i < 8; i++) {
        p(3 + i, 3 + i, '#1a0a0a', 3, 3);
        p(10 - i, 3 + i, '#1a0a0a', 3, 3);
      }
      for (let i = 0; i < 8; i++) {
        p(4 + i, 4 + i, '#ffffff', 1, 1);
        p(11 - i, 4 + i, '#ffffff', 1, 1);
      }
    });

    // 15. PLAY (Green pixel triangle)
    this.uiIcons.play = make((p) => {
      for (let i = 0; i < 6; i++) {
        p(4 + i, 2 + i, '#142914', 2, 12 - i * 2);
      }
      for (let i = 0; i < 5; i++) {
        p(5 + i, 3 + i, '#8cff66', 1, 10 - i * 2);
      }
    });

    // 16. BOOK (Guide)
    this.uiIcons.book = make((p) => {
      p(2, 2, '#1f140a', 12, 12);
      p(3, 3, '#8f4a24', 10, 10);
      p(4, 3, '#f2ead8', 8, 8);
      p(7, 3, '#bfa98a', 2, 8);
      p(5, 5, '#64748b', 2, 1);
      p(9, 5, '#64748b', 2, 1);
      p(5, 7, '#64748b', 2, 1);
      p(9, 7, '#64748b', 2, 1);
    });

    // 17. ARROWS (1px outlined crisp 16x16 D-Pad + Crafting Arrow)
    this.uiIcons.arrow_up = make((p) => {
      for (let i = 0; i < 6; i++) p(6 - i, 2 + i, '#14171f', 4 + i * 2, 2);
      p(5, 8, '#14171f', 6, 6);
      for (let i = 0; i < 5; i++) p(7 - i, 3 + i, i < 2 ? '#ffffff' : '#dbeafe', 2 + i * 2, 1);
      p(6, 8, '#cbd5e1', 4, 5); p(7, 8, '#ffffff', 2, 4);
    });
    this.uiIcons.arrow_down = make((p) => {
      p(5, 2, '#14171f', 6, 6);
      for (let i = 0; i < 6; i++) p(1 + i, 7 + i, '#14171f', 14 - i * 2, 2);
      p(6, 3, '#cbd5e1', 4, 5); p(7, 3, '#ffffff', 2, 4);
      for (let i = 0; i < 5; i++) p(2 + i, 8 + i, i > 2 ? '#ffffff' : '#dbeafe', 12 - i * 2, 1);
    });
    this.uiIcons.arrow_left = make((p) => {
      for (let i = 0; i < 6; i++) p(2 + i, 6 - i, '#14171f', 2, 4 + i * 2);
      p(8, 5, '#14171f', 6, 6);
      for (let i = 0; i < 5; i++) p(3 + i, 7 - i, i < 2 ? '#ffffff' : '#dbeafe', 1, 2 + i * 2);
      p(8, 6, '#cbd5e1', 5, 4); p(8, 7, '#ffffff', 4, 2);
    });
    this.uiIcons.arrow_right = make((p) => {
      p(2, 5, '#14171f', 6, 6);
      for (let i = 0; i < 6; i++) p(7 + i, 1 + i, '#14171f', 2, 14 - i * 2);
      p(3, 6, '#cbd5e1', 5, 4); p(3, 7, '#ffffff', 4, 2);
      for (let i = 0; i < 5; i++) p(8 + i, 2 + i, i > 2 ? '#ffffff' : '#dbeafe', 1, 12 - i * 2);
    });
    this.uiIcons.arrow_right_gold = make((p) => {
      p(1, 5, '#2b1c04', 7, 6);
      for (let i = 0; i < 6; i++) p(7 + i, 2 + i, '#2b1c04', 2, 12 - i * 2);
      p(2, 6, '#f5b318', 6, 4); p(2, 6, '#ffe57f', 6, 1);
      for (let i = 0; i < 5; i++) p(8 + i, 3 + i, i < 2 ? '#ffe57f' : '#ffd54f', 1, 10 - i * 2);
    });

    // 18. FURNACE FLAME (outlined 16x16 fire)
    this.uiIcons.flame = make((p) => {
      p(6, 1, '#3b1206', 4, 3); p(4, 3, '#3b1206', 8, 5); p(2, 7, '#3b1206', 12, 8);
      p(7, 2, '#ff5722', 2, 2); p(5, 4, '#ff7043', 6, 4); p(3, 8, '#f4511e', 10, 6);
      p(5, 6, '#ffb300', 6, 7); p(6, 9, '#fff176', 4, 4); p(7, 11, '#ffffff', 2, 2);
    });

    // 19. TIME & WEATHER PIXEL ICONS (1px dark frame, crisp 16x16 scenes!)
    this.uiIcons.sunrise = make((p) => {
      p(1, 1, '#182033', 14, 14);
      p(2, 2, '#5c78b8', 12, 5); p(2, 7, '#ff9e5e', 12, 3);
      p(5, 6, '#ffd54f', 6, 4); p(6, 5, '#fff59d', 4, 3);
      p(2, 10, '#2e4a7d', 12, 4); p(5, 11, '#ffcf80', 6, 1); p(6, 12, '#ffa66b', 4, 1);
    });
    this.uiIcons.sun = make((p) => {
      p(4, 4, '#472a04', 8, 8); p(7, 1, '#472a04', 2, 3); p(7, 12, '#472a04', 2, 3);
      p(1, 7, '#472a04', 3, 2); p(12, 7, '#472a04', 3, 2);
      p(5, 5, '#ffb300', 6, 6); p(6, 6, '#fff176', 4, 4); p(6, 6, '#ffffff', 2, 2);
      p(7, 2, '#ffd54f', 2, 2); p(7, 12, '#ffd54f', 2, 2);
      p(2, 7, '#ffd54f', 2, 2); p(12, 7, '#ffd54f', 2, 2);
      p(3, 3, '#ffd54f', 1, 1); p(12, 3, '#ffd54f', 1, 1); p(3, 12, '#ffd54f', 1, 1); p(12, 12, '#ffd54f', 1, 1);
    });
    this.uiIcons.sunset = make((p) => {
      p(1, 1, '#1a1630', 14, 14);
      p(2, 2, '#4a3d8c', 12, 3); p(2, 5, '#d96b8a', 12, 3); p(2, 8, '#ff9b54', 12, 2);
      p(5, 7, '#ffe082', 6, 3); p(6, 7, '#ffffff', 4, 2);
      p(2, 10, '#3b4f85', 12, 4); p(4, 11, '#ffb574', 8, 1); p(6, 12, '#ffd299', 4, 1);
    });
    this.uiIcons.moon = make((p) => {
      p(3, 1, '#0f172a', 9, 14); p(2, 3, '#0f172a', 11, 10);
      p(4, 2, '#cbd5e1', 7, 12); p(3, 4, '#e2e8f0', 9, 8); p(4, 3, '#ffffff', 3, 4);
      p(7, 4, '#0f172a', 6, 8); p(8, 3, '#0f172a', 5, 10);
      p(12, 3, '#fff59d', 2, 2); p(13, 10, '#fff59d', 1, 1);
    });
    this.uiIcons.rain = make((p) => {
      p(3, 1, '#1e293b', 10, 7); p(1, 3, '#1e293b', 14, 6);
      p(4, 2, '#cbd5e1', 8, 5); p(2, 4, '#94a3b8', 12, 4); p(4, 3, '#ffffff', 6, 2);
      p(3, 10, '#0284c7', 2, 4); p(4, 10, '#7dd3fc', 1, 3);
      p(7, 11, '#0284c7', 2, 4); p(8, 11, '#7dd3fc', 1, 3);
      p(11, 10, '#0284c7', 2, 4); p(12, 10, '#7dd3fc', 1, 3);
    });

    // 20. COMMAND & MOD PIXEL ICONS (1px dark outline, crisp 16x16)
    this.uiIcons.star = make((p) => {
      p(6, 1, '#472d04', 4, 14); p(1, 6, '#472d04', 14, 4); p(3, 3, '#472d04', 10, 10);
      p(7, 2, '#ffd54f', 2, 12); p(2, 7, '#ffd54f', 12, 2);
      p(4, 4, '#ffe57f', 8, 8); p(6, 6, '#ffffff', 4, 4);
    });
    this.uiIcons.map = make((p) => {
      p(1, 1, '#241a0d', 14, 14);
      p(2, 2, '#e8d7a8', 12, 12); p(3, 3, '#5da135', 5, 5);
      p(8, 7, '#38bdf8', 5, 5); p(6, 6, '#e53935', 3, 3); p(7, 7, '#ffffff', 1, 1);
    });
    this.uiIcons.paw = make((p) => {
      p(4, 7, '#24140a', 8, 7); p(5, 8, '#b87642', 6, 5); p(6, 9, '#d99a62', 4, 2);
      p(2, 3, '#24140a', 4, 5); p(3, 4, '#b87642', 2, 3);
      p(6, 2, '#24140a', 4, 5); p(7, 3, '#b87642', 2, 3);
      p(10, 3, '#24140a', 4, 5); p(11, 4, '#b87642', 2, 3);
    });
    this.uiIcons.wing = make((p) => {
      p(1, 3, '#1e293b', 12, 5); p(3, 6, '#1e293b', 11, 5); p(5, 9, '#1e293b', 8, 4);
      p(2, 4, '#ffffff', 10, 3); p(4, 7, '#cbd5e1', 9, 3); p(6, 10, '#94a3b8', 6, 2);
    });
    this.uiIcons.axe = this.getIcon('iron_axe') || this.uiIcons.mine;
    this.uiIcons.pickaxe = this.getIcon('diamond_pickaxe') || this.uiIcons.mine;
    this.uiIcons.torch = this.getIcon('torch') || this.uiIcons.flame;
    this.uiIcons.tnt = this.getIcon('tnt') || this.uiIcons.place;
    this.uiIcons.heart = this.hudIcons.heart_full;

    // 21. ARMOR SLOT SILHOUETTE PLACEHOLDERS (Pixel Art, No Emojis!)
    this.uiIcons.slot_helmet = make((p) => {
      p(4, 4, '#6b7280', 8, 6);
      p(6, 7, '#1e222b', 4, 3);
    });
    this.uiIcons.slot_chestplate = make((p) => {
      p(3, 3, '#6b7280', 10, 10);
      p(6, 3, '#1e222b', 4, 2);
    });
    this.uiIcons.slot_leggings = make((p) => {
      p(4, 3, '#6b7280', 8, 4);
      p(4, 7, '#6b7280', 3, 6);
      p(9, 7, '#6b7280', 3, 6);
    });
    this.uiIcons.slot_boots = make((p) => {
      p(2, 6, '#1e222b', 5, 8); p(9, 6, '#1e222b', 5, 8);
      p(3, 7, '#6b7280', 3, 6); p(10, 7, '#6b7280', 3, 6);
    });

    // 22. NEW 16x16 SETTINGS, KEYBINDS, CHEATS, POTION EFFECTS, BED & JAVA MAIN MENU ICONS!
    this.uiIcons.keybind = make((p) => {
      p(1, 3, '#14171f', 14, 10);
      p(2, 4, '#64748b', 12, 8);
      p(2, 4, '#94a3b8', 12, 1);
      p(3, 6, '#f8fafc', 2, 2); p(6, 6, '#f8fafc', 2, 2); p(9, 6, '#f8fafc', 2, 2); p(12, 6, '#f8fafc', 1, 2);
      p(4, 9, '#e2e8f0', 8, 2);
    });
    this.uiIcons.cheat = make((p) => {
      p(2, 5, '#2b1b05', 12, 8);
      p(2, 3, '#2b1b05', 3, 4); p(6, 2, '#2b1b05', 4, 5); p(11, 3, '#2b1b05', 3, 4);
      p(3, 4, '#ffd54f', 1, 3); p(7, 3, '#fff176', 2, 4); p(12, 4, '#ffd54f', 1, 3);
      p(3, 6, '#f5b318', 10, 6); p(4, 7, '#ffe57f', 8, 2);
      p(5, 9, '#ef4444', 2, 2); p(9, 9, '#38bdf8', 2, 2);
    });
    this.uiIcons.potion = make((p) => {
      p(6, 1, '#1e1626', 4, 3); p(7, 2, '#b8864b', 2, 2);
      p(5, 4, '#1e1626', 6, 2); p(6, 4, '#e2e8f0', 4, 1);
      p(3, 6, '#1e1626', 10, 8); p(4, 14, '#1e1626', 8, 1);
      p(4, 7, '#a855f7', 8, 6); p(5, 8, '#d8b4fe', 3, 3);
      p(5, 8, '#ffffff', 1, 2); p(8, 11, '#7e22ce', 3, 2);
    });
    this.uiIcons.bed = this.getIcon('bed') || this.uiIcons.place;

    // Multiplayer / Server / Globe / Accessibility Person / Settings Gear (Java Main Menu!)
    this.uiIcons.multiplayer = make((p) => {
      // Two side-by-side voxel players
      p(2, 2, '#14171f', 5, 5); p(3, 3, '#e0ac84', 3, 3); p(3, 3, '#4f3522', 3, 1);
      p(1, 7, '#14171f', 7, 7); p(2, 8, '#28a7b8', 5, 5);
      p(9, 2, '#14171f', 5, 5); p(10, 3, '#f0c4a0', 3, 3); p(10, 3, '#a66d2e', 3, 1);
      p(8, 7, '#14171f', 7, 7); p(9, 8, '#54b848', 5, 5);
    });
    this.uiIcons.server = make((p) => {
      p(2, 2, '#14171f', 12, 5); p(3, 3, '#7b8494', 10, 3); p(4, 4, '#52e052', 2, 1); p(10, 4, '#cbd5e1', 2, 1);
      p(2, 9, '#14171f', 12, 5); p(3, 10, '#626a78', 10, 3); p(4, 11, '#ffd54f', 2, 1); p(10, 11, '#cbd5e1', 2, 1);
    });
    this.uiIcons.globe = make((p) => {
      p(4, 1, '#0f2036', 8, 14); p(2, 3, '#0f2036', 12, 10); p(1, 5, '#0f2036', 14, 6);
      p(5, 2, '#3b82f6', 6, 12); p(3, 4, '#2563eb', 10, 8); p(2, 6, '#38bdf8', 12, 4);
      p(4, 4, '#52c44d', 4, 4); p(9, 7, '#52c44d', 4, 4); p(6, 10, '#3a9c36', 3, 2);
      p(4, 3, '#bae6fd', 2, 1);
    });
    this.uiIcons.person = make((p) => {
      p(6, 1, '#14171f', 4, 4); p(7, 2, '#ffffff', 2, 2);
      p(2, 5, '#14171f', 12, 3); p(3, 6, '#ffffff', 10, 1);
      p(5, 7, '#14171f', 6, 4); p(6, 7, '#ffffff', 4, 3);
      p(5, 11, '#14171f', 3, 4); p(8, 11, '#14171f', 3, 4);
      p(6, 11, '#ffffff', 1, 3); p(9, 11, '#ffffff', 1, 3);
    });
    this.uiIcons.settings = make((p) => {
      p(6, 1, '#14171f', 4, 14); p(1, 6, '#14171f', 14, 4); p(3, 3, '#14171f', 10, 10);
      p(7, 2, '#cbd5e1', 2, 12); p(2, 7, '#cbd5e1', 12, 2); p(4, 4, '#94a3b8', 8, 8);
      p(6, 6, '#14171f', 4, 4); p(7, 7, '#475569', 2, 2);
    });
    this.uiIcons.signal_on = make((p) => {
      p(2, 10, '#142914', 3, 5); p(3, 11, '#52e052', 1, 3);
      p(6, 7, '#142914', 3, 8); p(7, 8, '#52e052', 1, 6);
      p(10, 3, '#142914', 3, 12); p(11, 4, '#52e052', 1, 10);
    });
    this.uiIcons.signal_off = make((p) => {
      p(2, 10, '#1f242d', 3, 5); p(3, 11, '#64748b', 1, 3);
      p(6, 7, '#1f242d', 3, 8); p(7, 8, '#475569', 1, 6);
      p(10, 3, '#1f242d', 3, 12); p(11, 4, '#334155', 1, 10);
      p(2, 2, '#ef4444', 2, 2); p(4, 4, '#ef4444', 2, 2); p(6, 6, '#ef4444', 2, 2);
      p(6, 2, '#ef4444', 2, 2); p(2, 6, '#ef4444', 2, 2);
    });
  }

  // Classic Pixel-Art Minecraft Steve 6-Face Texture Set (shared by 3rd-person Player & 3D Inventory Doll!)
  getSteveTextures() {
    if (this._steveTextures) return this._steveTextures;
    const makeTex = (w, h, fn) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      const p = (x, y, col, pw = 1, ph = 1) => { ctx.fillStyle = col; ctx.fillRect(x, y, pw, ph); };
      fn(p, ctx);
      const tex = new THREE.CanvasTexture(c);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false;
      return tex;
    };

    const skin = '#c6906c', skinD = '#b07b58', skinL = '#d4a07d', nose = '#9e6849';
    const hair = '#382213', hairD = '#29170b', hairL = '#4c301c';
    const shirt = '#14a6ad', shirtD = '#0d828a', shirtL = '#23bcc2', shirtSh = '#09636b';
    const jean = '#36308a', jeanD = '#262169', jeanL = '#463fa3';
    const shoe = '#4c4c4c', shoeD = '#303030', shoeL = '#666666';

    const headFront = makeTex(8, 8, (p) => {
      p(0, 0, skin, 8, 8);
      // Subtle cheek & forehead pixel shading
      p(0, 2, skinL, 8, 1); p(0, 7, skinD, 8, 1);
      // Classic Steve Hair Bangs & Sideburns
      p(0, 0, hair, 8, 2);
      p(1, 0, hairL, 2, 1); p(5, 0, hairD, 2, 1);
      p(0, 2, hair, 1, 1); p(7, 2, hair, 1, 1);
      // Crisp Steve White + Indigo-Blue Eyes
      p(1, 4, '#ffffff', 1, 1); p(2, 4, '#43348f', 1, 1);
      p(5, 4, '#43348f', 1, 1); p(6, 4, '#ffffff', 1, 1);
      // Nose
      p(3, 5, nose, 2, 1);
      // Iconic Steve Goatee & Smile!
      p(2, 6, '#5c3822', 1, 2); p(5, 6, '#5c3822', 1, 2);
      p(3, 7, '#5c3822', 2, 1);
      p(3, 6, '#a4694c', 2, 1);
    });

    const headSide = makeTex(8, 8, (p) => {
      p(0, 0, skin, 8, 8);
      p(0, 0, hair, 8, 2);
      p(0, 2, hair, 6, 2);
      p(0, 4, hairD, 4, 2);
      p(1, 1, hairL, 3, 1);
      p(5, 3, skinD, 1, 2);
      p(0, 7, skinD, 8, 1);
    });

    const headBack = makeTex(8, 8, (p) => {
      p(0, 0, hair, 8, 6);
      p(0, 6, skinD, 8, 2);
      p(1, 1, hairL, 2, 2); p(5, 2, hairD, 2, 3);
      p(2, 4, hairD, 3, 2);
    });

    const headTop = makeTex(8, 8, (p) => {
      p(0, 0, hair, 8, 8);
      p(1, 1, hairL, 3, 2); p(4, 3, hairD, 3, 3); p(2, 5, hairL, 2, 2);
    });

    const headBottom = makeTex(8, 8, (p) => {
      p(0, 0, skinD, 8, 8);
    });

    const torsoFront = makeTex(8, 12, (p) => {
      p(0, 0, shirt, 8, 12);
      // Classic Steve V-neck collar showing neck skin
      p(2, 0, skin, 4, 1); p(3, 1, skinD, 2, 1);
      // Shirt creases & tucked cyan hem shadow
      p(0, 0, shirtL, 1, 10); p(7, 0, shirtD, 1, 11);
      p(1, 3, shirtL, 2, 1); p(5, 5, shirtD, 2, 1);
      p(0, 10, shirtD, 8, 2);
      p(0, 11, shirtSh, 6, 1);
      p(6, 11, jean, 2, 1); // iconic untucked shirt-corner glimpse of jeans!
    });

    const torsoBack = makeTex(8, 12, (p) => {
      p(0, 0, shirt, 8, 12);
      p(0, 0, shirtD, 8, 1);
      p(1, 2, shirtL, 6, 2);
      p(2, 6, shirtD, 4, 2);
      p(0, 10, shirtSh, 8, 2);
    });

    const torsoSide = makeTex(4, 12, (p) => {
      p(0, 0, shirtD, 4, 12);
      p(1, 1, shirt, 2, 9);
      p(0, 10, shirtSh, 4, 2);
    });

    const armFront = makeTex(4, 12, (p) => {
      // Short teal sleeve (top 4 px) + warm tan forearm/hand (bottom 8 px)
      p(0, 0, shirt, 4, 4);
      p(0, 0, shirtL, 4, 1); p(0, 3, shirtD, 4, 1);
      p(0, 4, skin, 4, 8);
      p(0, 4, skinD, 4, 1);
      p(1, 6, skinL, 2, 3);
      p(0, 11, skinD, 4, 1);
    });

    const armSide = makeTex(4, 12, (p) => {
      p(0, 0, shirtD, 4, 4);
      p(1, 0, shirt, 2, 3);
      p(0, 4, skinD, 4, 8);
      p(1, 5, skin, 2, 6);
    });

    const legFront = makeTex(4, 12, (p) => {
      // Classic Steve Indigo Jeans + Gray Boots!
      p(0, 0, jean, 4, 10);
      p(0, 0, jeanD, 4, 1);
      p(1, 2, jeanL, 2, 5);
      p(3, 1, jeanD, 1, 9);
      p(0, 9, jeanD, 4, 1);
      // Boots at bottom 2 rows
      p(0, 10, shoe, 4, 2);
      p(0, 10, shoeL, 3, 1);
      p(0, 11, shoeD, 4, 1);
    });

    const legSide = makeTex(4, 12, (p) => {
      p(0, 0, jeanD, 4, 10);
      p(1, 1, jean, 2, 8);
      p(0, 10, shoeD, 4, 2);
      p(1, 10, shoe, 2, 1);
    });

    this._steveTextures = {
      headFront, headSide, headBack, headTop, headBottom,
      torsoFront, torsoBack, torsoSide,
      armFront, armSide, legFront, legSide,
      skinHex: 0xdba882,
      sleeveHex: 0x14a6ad,
      pantHex: 0x262169,
      shoeHex: 0x303030,
      slimArms: false
    };
    return this._steveTextures;
  }

  // Multi-Skin Pixel-Art Character Texture Generator (Steve, Alex, Knight, Explorer, Ender, Builder!)
  getPlayerSkinTextures(skinId = 'steve') {
    const id = skinId || 'steve';
    if (id === 'steve') return this.getSteveTextures();
    if (!this._skinTexCache) this._skinTexCache = {};
    if (this._skinTexCache[id]) return this._skinTexCache[id];

    const makeTex = (w, h, fn) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      const p = (x, y, col, pw = 1, ph = 1) => { ctx.fillStyle = col; ctx.fillRect(x, y, pw, ph); };
      fn(p, ctx);
      const tex = new THREE.CanvasTexture(c);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false;
      return tex;
    };

    const defs = {
      alex: {
        skin: '#f2c7a5', skinD: '#d4a37d', skinL: '#ffdcc0', nose: '#e0ad86',
        hair: '#d46a24', hairD: '#a64d14', hairL: '#f08b3e',
        eye: '#3e8c2e', mouth: '#c9886b',
        shirt: '#5f9e3d', shirtD: '#487d2c', shirtL: '#78ba52', shirtSh: '#396322',
        belt: '#52341b', buckle: '#e0b84c',
        pant: '#5e432e', pantD: '#453020', pantL: '#75563e',
        shoe: '#454240', shoeD: '#292726', shoeL: '#635f5c',
        skinHex: 0xf2c7a5, sleeveHex: 0x5f9e3d, pantHex: 0x453020, shoeHex: 0x292726,
        slimArms: true, longHair: true, sleeveLen: 5
      },
      knight: {
        skin: '#dfb08a', skinD: '#ba8964', skinL: '#f2c8a4', nose: '#c9966f',
        hair: '#8c99a8', hairD: '#5d6875', hairL: '#c7d2de',
        eye: '#2563eb', mouth: '#9c6b4e',
        shirt: '#9aa8b8', shirtD: '#6c7a8a', shirtL: '#cfd9e3', shirtSh: '#475261',
        tabard: '#2452a6', belt: '#4a2f18', buckle: '#f2c12e',
        pant: '#525b66', pantD: '#39404a', pantL: '#6f7985',
        shoe: '#7a8594', shoeD: '#4d5561', shoeL: '#b0bac7',
        skinHex: 0x9aa8b8, sleeveHex: 0x6c7a8a, pantHex: 0x39404a, shoeHex: 0x4d5561,
        slimArms: false, helmetHead: true, sleeveLen: 9
      },
      explorer: {
        skin: '#d9a47b', skinD: '#b58057', skinL: '#ebbd98', nose: '#bd875e',
        hair: '#3d281a', hairD: '#26170e', hairL: '#5c3e2b',
        eye: '#386e46', mouth: '#a66d4b',
        shirt: '#b8844c', shirtD: '#8f6335', shirtL: '#d49f66', shirtSh: '#6b4823',
        bandana: '#c9382b', belt: '#4f2f16', buckle: '#e8c456',
        pant: '#4e5e3b', pantD: '#38452a', pantL: '#64784d',
        shoe: '#57361e', shoeD: '#382111', shoeL: '#754b2c',
        skinHex: 0xd9a47b, sleeveHex: 0xb8844c, pantHex: 0x38452a, shoeHex: 0x382111,
        slimArms: false, bandanaHead: true, sleeveLen: 6
      },
      ender: {
        skin: '#221f2e', skinD: '#14121c', skinL: '#322e42', nose: '#191624',
        hair: '#13111c', hairD: '#09080d', hairL: '#272338',
        eye: '#c084fc', mouth: '#3b2e52',
        shirt: '#1d1a29', shirtD: '#12101a', shirtL: '#312b45', shirtSh: '#0c0a12',
        tabard: '#7c3aed', belt: '#5b21b6', buckle: '#e879f9',
        pant: '#171521', pantD: '#0d0c14', pantL: '#29253b',
        shoe: '#2c2540', shoeD: '#151221', shoeL: '#4c3f6e',
        skinHex: 0x221f2e, sleeveHex: 0x1d1a29, pantHex: 0x0d0c14, shoeHex: 0x151221,
        slimArms: false, glowEyes: true, sleeveLen: 8
      },
      sunny: {
        skin: '#e8b68e', skinD: '#c7936b', skinL: '#fad0ae', nose: '#d19b73',
        hair: '#e6be53', hairD: '#bd9431', hairL: '#fae087',
        eye: '#2d7a9c', mouth: '#b87654',
        shirt: '#d94c3d', shirtD: '#ad3528', shirtL: '#f26d5e', shirtSh: '#87241a',
        overalls: '#2e5894', belt: '#234473', buckle: '#f2cb49',
        pant: '#2e5894', pantD: '#203f6b', pantL: '#4373b5',
        shoe: '#52341d', shoeD: '#331f10', shoeL: '#6e4729',
        skinHex: 0xe8b68e, sleeveHex: 0xd94c3d, pantHex: 0x203f6b, shoeHex: 0x331f10,
        slimArms: false, longHair: false, sleeveLen: 4
      }
    };

    const d = defs[id] || defs.alex;

    const headFront = makeTex(8, 8, (p) => {
      p(0, 0, d.skin, 8, 8);
      p(0, 2, d.skinL, 8, 1); p(0, 7, d.skinD, 8, 1);
      if (d.helmetHead) {
        // Steel Knight Helm Frame + Open Visor showing eyes!
        p(0, 0, d.hair, 8, 3); p(0, 0, d.hairL, 8, 1); p(3, 0, '#f2c12e', 2, 2);
        p(0, 3, d.hair, 1, 5); p(7, 3, d.hair, 1, 5);
        p(0, 6, d.hairD, 8, 2); p(2, 6, d.hair, 4, 1);
        p(1, 4, '#ffffff', 1, 1); p(2, 4, d.eye, 1, 1);
        p(5, 4, d.eye, 1, 1); p(6, 4, '#ffffff', 1, 1);
        p(3, 5, d.nose, 2, 1);
      } else {
        p(0, 0, d.hair, 8, 2);
        p(1, 0, d.hairL, 2, 1); p(5, 0, d.hairD, 2, 1);
        if (d.longHair) {
          // Alex iconic side-swept bangs!
          p(0, 2, d.hair, 2, 2); p(7, 2, d.hair, 1, 3);
          p(2, 1, d.hairL, 2, 1);
        } else {
          p(0, 2, d.hair, 1, 1); p(7, 2, d.hair, 1, 1);
        }
        if (d.bandanaHead) {
          p(0, 2, d.bandana, 8, 1); p(2, 2, '#f06454', 3, 1);
        }
        if (d.glowEyes) {
          p(1, 4, '#f5d0fe', 1, 1); p(2, 4, d.eye, 1, 1);
          p(5, 4, d.eye, 1, 1); p(6, 4, '#f5d0fe', 1, 1);
        } else {
          p(1, 4, '#ffffff', 1, 1); p(2, 4, d.eye, 1, 1);
          p(5, 4, d.eye, 1, 1); p(6, 4, '#ffffff', 1, 1);
          p(3, 5, d.nose, 2, 1);
          p(3, 6, d.mouth, 2, 1);
        }
      }
    });

    const headSide = makeTex(8, 8, (p) => {
      p(0, 0, d.skin, 8, 8);
      p(0, 0, d.hair, 8, d.helmetHead ? 7 : (d.longHair ? 6 : 3));
      if (!d.helmetHead) {
        p(0, 2, d.hair, d.longHair ? 7 : 5, d.longHair ? 5 : 2);
        p(1, 1, d.hairL, 3, 1);
      } else {
        p(0, 0, d.hairL, 8, 1); p(0, 6, d.hairD, 8, 2);
      }
      if (d.bandanaHead) p(0, 2, d.bandana, 8, 1);
    });

    const headBack = makeTex(8, 8, (p) => {
      p(0, 0, d.hair, 8, d.longHair || d.helmetHead ? 8 : 6);
      if (!d.longHair && !d.helmetHead) p(0, 6, d.skinD, 8, 2);
      p(1, 1, d.hairL, 2, 2); p(4, 3, d.hairD, 3, 3);
      if (d.longHair) {
        // Alex side ponytail detail!
        p(5, 4, d.hairL, 2, 4); p(4, 5, d.hairD, 1, 3);
      }
      if (d.bandanaHead) { p(0, 2, d.bandana, 8, 1); p(3, 3, d.bandana, 2, 2); }
    });

    const headTop = makeTex(8, 8, (p) => {
      p(0, 0, d.hair, 8, 8);
      p(1, 1, d.hairL, 3, 2); p(4, 3, d.hairD, 3, 3);
      if (d.helmetHead) p(3, 0, '#f2c12e', 2, 8);
    });

    const headBottom = makeTex(8, 8, (p) => {
      p(0, 0, d.skinD, 8, 8);
    });

    const torsoFront = makeTex(8, 12, (p) => {
      p(0, 0, d.shirt, 8, 12);
      p(0, 0, d.shirtL, 1, 10); p(7, 0, d.shirtD, 1, 11);
      if (!d.helmetHead && !d.glowEyes) {
        p(2, 0, d.skin, 4, 1); p(3, 1, d.skinD, 2, 1);
      }
      if (d.tabard) {
        p(2, 1, d.tabard, 4, 10);
        p(3, 3, d.buckle || '#f2c12e', 2, 2);
      }
      if (d.overalls) {
        p(1, 0, d.overalls, 1, 7); p(6, 0, d.overalls, 1, 7);
        p(1, 5, d.overalls, 6, 7);
        p(1, 5, d.buckle, 1, 1); p(6, 5, d.buckle, 1, 1);
      }
      if (d.belt) {
        p(0, 9, d.belt, 8, 2);
        p(3, 9, d.buckle || '#e0b84c', 2, 2);
      }
      p(0, 11, d.shirtSh, 8, 1);
    });

    const torsoBack = makeTex(8, 12, (p) => {
      p(0, 0, d.shirt, 8, 12);
      p(1, 2, d.shirtL, 6, 2);
      if (d.tabard) p(2, 1, d.tabard, 4, 10);
      if (d.overalls) { p(1, 0, d.overalls, 1, 12); p(6, 0, d.overalls, 1, 12); p(1, 6, d.overalls, 6, 6); }
      if (d.belt) p(0, 9, d.belt, 8, 2);
      p(0, 11, d.shirtSh, 8, 1);
    });

    const torsoSide = makeTex(4, 12, (p) => {
      p(0, 0, d.shirtD, 4, 12);
      p(1, 1, d.shirt, 2, 8);
      if (d.belt) p(0, 9, d.belt, 4, 2);
      p(0, 11, d.shirtSh, 4, 1);
    });

    const sl = d.sleeveLen || 4;
    const armFront = makeTex(4, 12, (p) => {
      p(0, 0, d.shirt, 4, sl);
      p(0, 0, d.shirtL, 4, 1); p(0, Math.max(0, sl - 1), d.shirtD, 4, 1);
      p(0, sl, d.skin, 4, 12 - sl);
      p(1, sl + 1, d.skinL, 2, Math.max(1, 8 - sl));
      p(0, 11, d.skinD, 4, 1);
    });

    const armSide = makeTex(4, 12, (p) => {
      p(0, 0, d.shirtD, 4, sl);
      p(1, 0, d.shirt, 2, Math.max(1, sl - 1));
      p(0, sl, d.skinD, 4, 12 - sl);
      p(1, sl + 1, d.skin, 2, Math.max(1, 10 - sl));
    });

    const legFront = makeTex(4, 12, (p) => {
      p(0, 0, d.pant, 4, 10);
      p(0, 0, d.pantD, 4, 1);
      p(1, 2, d.pantL, 2, 5);
      p(3, 1, d.pantD, 1, 9);
      p(0, 10, d.shoe, 4, 2);
      p(0, 10, d.shoeL, 3, 1);
      p(0, 11, d.shoeD, 4, 1);
    });

    const legSide = makeTex(4, 12, (p) => {
      p(0, 0, d.pantD, 4, 10);
      p(1, 1, d.pant, 2, 8);
      p(0, 10, d.shoeD, 4, 2);
      p(1, 10, d.shoe, 2, 1);
    });

    const bundle = {
      headFront, headSide, headBack, headTop, headBottom,
      torsoFront, torsoBack, torsoSide,
      armFront, armSide, legFront, legSide,
      skinHex: d.skinHex,
      sleeveHex: d.sleeveHex,
      pantHex: d.pantHex,
      shoeHex: d.shoeHex,
      slimArms: Boolean(d.slimArms)
    };
    this._skinTexCache[id] = bundle;
    return bundle;
  }

  // Pixel-Art 3D Armor Textures (Leather, Iron, Gold, Diamond) with open Helmet Visor & Sculpted Crest!
  getArmorTextures(tier) {
    if (!this._armorTexCache) this._armorTexCache = {};
    if (this._armorTexCache[tier]) return this._armorTexCache[tier];

    const pals = {
      leather: { base: '#965c34', dark: '#63391c', light: '#bc7c4d', rim: '#d9a473', buckle: '#c8b282' },
      iron:    { base: '#cfd6de', dark: '#8c96a3', light: '#edf2f7', rim: '#ffffff', buckle: '#555d69' },
      golden:  { base: '#f2c12e', dark: '#b3740e', light: '#ffe36e', rim: '#fff9c4', buckle: '#d93829' },
      diamond: { base: '#38d9e0', dark: '#148d9c', light: '#8ef8fc', rim: '#e0ffff', buckle: '#1a4966' }
    };
    const pal = pals[tier] || pals.iron;

    const makeTex = (w, h, fn) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      const p = (x, y, col, pw = 1, ph = 1) => { ctx.fillStyle = col; ctx.fillRect(x, y, pw, ph); };
      fn(p, ctx);
      const tex = new THREE.CanvasTexture(c);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false;
      return tex;
    };

    // Helmet front with transparent open face cutout so Steve's eyes & face stay clearly visible!
    const helmFront = makeTex(8, 8, (p) => {
      p(0, 0, pal.base, 8, 3);
      p(0, 0, pal.light, 8, 1);
      p(1, 1, pal.rim, 6, 1);
      p(0, 2, pal.dark, 8, 1);
      // Noseguard bridge + cheek guards
      p(3, 2, pal.base, 2, 2);
      p(3, 3, pal.dark, 2, 1);
      p(0, 3, pal.base, 1, 3);
      p(7, 3, pal.base, 1, 3);
      p(0, 5, pal.dark, 1, 1);
      p(7, 5, pal.dark, 1, 1);
    });

    const helmSide = makeTex(8, 8, (p) => {
      p(0, 0, pal.base, 8, 6);
      p(0, 0, pal.light, 8, 1);
      p(0, 5, pal.dark, 8, 1);
      p(1, 2, pal.light, 4, 1);
      p(2, 4, pal.dark, 4, 1);
    });

    const helmTop = makeTex(8, 8, (p) => {
      p(0, 0, pal.base, 8, 8);
      p(1, 1, pal.light, 6, 6);
      p(3, 0, pal.rim, 2, 8);
      p(0, 0, pal.dark, 8, 1);
      p(0, 7, pal.dark, 8, 1);
    });

    const chestFront = makeTex(8, 12, (p) => {
      p(0, 0, pal.base, 8, 12);
      // Collar notch & shoulder armor trim
      p(2, 0, pal.dark, 4, 2);
      p(0, 0, pal.rim, 2, 1); p(6, 0, pal.rim, 2, 1);
      // Sculpted pectoral bevel & royal crest
      p(1, 2, pal.light, 6, 3);
      p(2, 3, pal.rim, 4, 1);
      p(1, 5, pal.dark, 6, 1);
      p(2, 6, pal.light, 4, 3);
      // Belt & buckle at waist
      p(0, 9, pal.dark, 8, 2);
      p(3, 9, pal.buckle, 2, 2);
      p(0, 11, pal.base, 8, 1);
    });

    const chestBack = makeTex(8, 12, (p) => {
      p(0, 0, pal.base, 8, 12);
      p(0, 0, pal.dark, 8, 1);
      p(1, 1, pal.light, 6, 4);
      p(3, 1, pal.dark, 2, 8);
      p(0, 9, pal.dark, 8, 2);
    });

    const pauldron = makeTex(4, 6, (p) => {
      p(0, 0, pal.base, 4, 6);
      p(0, 0, pal.rim, 4, 1);
      p(1, 1, pal.light, 2, 3);
      p(0, 4, pal.dark, 4, 2);
    });

    const legging = makeTex(4, 8, (p) => {
      p(0, 0, pal.base, 4, 8);
      p(0, 0, pal.dark, 4, 1);
      p(1, 1, pal.light, 2, 5);
      p(0, 6, pal.dark, 4, 1);
      p(1, 4, pal.rim, 2, 1); // knee cap highlight
    });

    const boot = makeTex(4, 4, (p) => {
      p(0, 0, pal.light, 4, 1);
      p(0, 1, pal.base, 4, 2);
      p(1, 1, pal.rim, 2, 1);
      p(0, 3, pal.dark, 4, 1);
    });

    const out = { helmFront, helmSide, helmTop, chestFront, chestBack, pauldron, legging, boot, pal };
    this._armorTexCache[tier] = out;
    return out;
  }
}
