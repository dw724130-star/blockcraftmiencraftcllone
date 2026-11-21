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

export class TextureManager {
  constructor() {
    this.tileMap = {}; // name -> { col, row, u0, v0, u1, v1 }
    this.itemIcons = {}; // itemKey -> dataURL
    this.itemTextures = {}; // itemKey -> THREE.CanvasTexture (for 3D pixel-art drops!)
    this.blockDropGeoCache = {}; // "blockId:size" -> BufferGeometry
    this.mobCoatCache = {}; // key -> THREE.CanvasTexture
    this.hudIcons = {}; // name -> dataURL
    this.uiIcons = {}; // name -> dataURL (every UI button pixel art!)
    this.crackTextures = []; // 10 stages (0..9) of pixel-art block breaking cracks

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

    this.buildItemIcons();
    this.buildCrackTextures();
    this.buildHudIcons();
    this.buildUiIcons();
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

  buildAtlas() {
    this.addTile('grass_top', (c, x, y) => {
      fillNoise(c, x, y, '#5da135', 18, 1);
      for (let i = 0; i < 24; i++) {
        px(c, x, y, Math.floor(pxHash(i, 1, 2) * 16), Math.floor(pxHash(i, 2, 2) * 16), '#4a8528');
      }
    });

    this.addTile('dirt', (c, x, y) => {
      fillNoise(c, x, y, '#865b36', 18, 3);
      for (let i = 0; i < 18; i++) {
        px(c, x, y, Math.floor(pxHash(i, 3, 4) * 16), Math.floor(pxHash(i, 4, 4) * 16), '#6b4728');
      }
    });

    this.addTile('grass_side', (c, x, y) => {
      fillNoise(c, x, y, '#865b36', 16, 5);
      for (let ix = 0; ix < 16; ix++) {
        const drop = 3 + Math.floor(pxHash(ix, 1, 6) * 4);
        for (let iy = 0; iy < drop; iy++) {
          px(c, x, y, ix, iy, iy < 2 ? '#5da135' : '#4d8a2b');
        }
      }
    });

    this.addTile('stone', (c, x, y) => {
      fillNoise(c, x, y, '#80848a', 16, 7);
      for (let i = 0; i < 14; i++) {
        px(c, x, y, Math.floor(pxHash(i, 5, 8) * 14), Math.floor(pxHash(i, 6, 8) * 16), '#686c73', 2, 1);
      }
    });

    this.addTile('cobblestone', (c, x, y) => {
      fillNoise(c, x, y, '#73777d', 22, 9);
      c.fillStyle = '#4e5157';
      for (let iy = 0; iy < 16; iy += 4) px(c, x, y, 0, iy, '#4e5157', 16, 1);
      for (let iy = 0; iy < 16; iy += 4) {
        const off = (iy % 8 === 0) ? 0 : 4;
        for (let ix = off; ix < 16; ix += 8) px(c, x, y, ix, iy, '#4e5157', 1, 4);
      }
    });

    this.addTile('bedrock', (c, x, y) => fillNoise(c, x, y, '#383a3f', 32, 11));
    this.addTile('sand', (c, x, y) => fillNoise(c, x, y, '#dfd09c', 14, 12));
    this.addTile('gravel', (c, x, y) => fillNoise(c, x, y, '#8a8583', 28, 13));

    this.addTile('sandstone_top', (c, x, y) => fillNoise(c, x, y, '#d8c78d', 10, 14));
    this.addTile('sandstone_side', (c, x, y) => {
      fillNoise(c, x, y, '#d4c184', 10, 15);
      px(c, x, y, 0, 3, '#b8a369', 16, 1);
      px(c, x, y, 0, 10, '#bfa96e', 16, 1);
    });

    this.addTile('water', (c, x, y) => {
      c.fillStyle = 'rgba(42, 118, 224, 0.72)';
      c.fillRect(x, y, 16, 16);
      for (let i = 0; i < 16; i++) {
        px(c, x, y, Math.floor(pxHash(i, 1, 16) * 14), Math.floor(pxHash(i, 2, 16) * 16), 'rgba(130, 195, 255, 0.45)', 3, 1);
      }
    });

    // Logs & Planks
    const drawLogSide = (c, x, y, base, bark, s) => {
      fillNoise(c, x, y, base, 12, s);
      for (let ix = 0; ix < 16; ix += 3) px(c, x, y, ix, 0, bark, 1, 16);
    };
    const drawLogTop = (c, x, y, bark, inner, s) => {
      fillNoise(c, x, y, bark, 10, s);
      px(c, x, y, 2, 2, inner, 12, 12);
      px(c, x, y, 4, 4, bark, 8, 8);
      px(c, x, y, 6, 6, inner, 4, 4);
    };
    const drawPlanks = (c, x, y, base, line, s) => {
      fillNoise(c, x, y, base, 10, s);
      for (let iy = 0; iy < 16; iy += 4) px(c, x, y, 0, iy, line, 16, 1);
      px(c, x, y, 7, 0, line, 1, 4);
      px(c, x, y, 13, 4, line, 1, 4);
      px(c, x, y, 4, 8, line, 1, 4);
      px(c, x, y, 10, 12, line, 1, 4);
    };
    const drawLeaves = (c, x, y, c1, c2, s) => {
      for (let iy = 0; iy < 16; iy++) {
        for (let ix = 0; ix < 16; ix++) {
          const r = pxHash(ix, iy, s);
          if (r > 0.22) {
            px(c, x, y, ix, iy, r > 0.62 ? c1 : c2);
          }
        }
      }
    };

    this.addTile('oak_log_side', (c, x, y) => drawLogSide(c, x, y, '#6b5134', '#4d3923', 20));
    this.addTile('oak_log_top', (c, x, y) => drawLogTop(c, x, y, '#634a2e', '#b59262', 21));
    this.addTile('oak_planks', (c, x, y) => drawPlanks(c, x, y, '#b58d59', '#8a693e', 22));
    this.addTile('oak_leaves', (c, x, y) => drawLeaves(c, x, y, '#478c2b', '#336b1d', 23));

    this.addTile('birch_log_side', (c, x, y) => {
      fillNoise(c, x, y, '#e0ddd5', 10, 24);
      for (let i = 0; i < 12; i++) {
        px(c, x, y, Math.floor(pxHash(i, 1, 25) * 13), Math.floor(pxHash(i, 2, 25) * 16), '#3a3a3a', 3, 1);
      }
    });
    this.addTile('birch_log_top', (c, x, y) => drawLogTop(c, x, y, '#dad6cc', '#cfb98c', 26));
    this.addTile('birch_planks', (c, x, y) => drawPlanks(c, x, y, '#d6c18f', '#ad996b', 27));
    this.addTile('birch_leaves', (c, x, y) => drawLeaves(c, x, y, '#64a33b', '#4d822a', 28));

    this.addTile('spruce_log_side', (c, x, y) => drawLogSide(c, x, y, '#473322', '#2e2014', 29));
    this.addTile('spruce_log_top', (c, x, y) => drawLogTop(c, x, y, '#422e1d', '#876542', 30));
    this.addTile('spruce_planks', (c, x, y) => drawPlanks(c, x, y, '#7a5837', '#593e24', 31));
    this.addTile('spruce_leaves', (c, x, y) => drawLeaves(c, x, y, '#2f613b', '#1e4228', 32));

    // Cactus, Snow, Ice
    this.addTile('cactus_side', (c, x, y) => {
      fillNoise(c, x, y, '#3f8a33', 12, 33);
      px(c, x, y, 3, 0, '#2a6321', 1, 16);
      px(c, x, y, 8, 0, '#2a6321', 1, 16);
      px(c, x, y, 13, 0, '#2a6321', 1, 16);
    });
    this.addTile('cactus_top', (c, x, y) => {
      fillNoise(c, x, y, '#4ca13d', 12, 34);
      px(c, x, y, 3, 3, '#2d6b23', 10, 10);
    });
    this.addTile('snow', (c, x, y) => fillNoise(c, x, y, '#eef5fa', 8, 35));
    this.addTile('ice', (c, x, y) => {
      c.fillStyle = 'rgba(135, 200, 250, 0.78)';
      c.fillRect(x, y, 16, 16);
      px(c, x, y, 2, 2, 'rgba(255,255,255,0.55)', 5, 1);
      px(c, x, y, 9, 10, 'rgba(255,255,255,0.45)', 5, 1);
    });

    // Ores
    const drawOre = (c, x, y, speck, s) => {
      fillNoise(c, x, y, '#7f838a', 15, s);
      const pts = [[3,3],[4,4],[10,2],[11,3],[6,8],[7,9],[12,11],[11,12],[3,12],[4,11]];
      for (const [ox, oy] of pts) px(c, x, y, ox, oy, speck, 2, 2);
    };
    this.addTile('coal_ore', (c, x, y) => drawOre(c, x, y, '#232428', 40));
    this.addTile('iron_ore', (c, x, y) => drawOre(c, x, y, '#d8b291', 41));
    this.addTile('gold_ore', (c, x, y) => drawOre(c, x, y, '#f5d033', 42));
    this.addTile('diamond_ore', (c, x, y) => drawOre(c, x, y, '#4de3e8', 43));

    // Utility blocks
    this.addTile('craft_top', (c, x, y) => {
      fillNoise(c, x, y, '#b58852', 10, 44);
      px(c, x, y, 0, 0, '#6e4d26', 16, 1);
      px(c, x, y, 0, 15, '#6e4d26', 16, 1);
      px(c, x, y, 0, 0, '#6e4d26', 1, 16);
      px(c, x, y, 15, 0, '#6e4d26', 1, 16);
      px(c, x, y, 5, 1, '#5c3f1e', 1, 14);
      px(c, x, y, 10, 1, '#5c3f1e', 1, 14);
      px(c, x, y, 1, 5, '#5c3f1e', 14, 1);
      px(c, x, y, 1, 10, '#5c3f1e', 14, 1);
    });
    this.addTile('craft_side', (c, x, y) => {
      drawPlanks(c, x, y, '#a87d4a', '#73532c', 45);
      px(c, x, y, 0, 0, '#6e4d26', 16, 2);
      px(c, x, y, 3, 4, '#cfd6df', 2, 6); // saw
      px(c, x, y, 10, 5, '#5c4122', 2, 6); // hammer
    });
    this.addTile('furnace_top', (c, x, y) => {
      fillNoise(c, x, y, '#7c8087', 14, 46);
      px(c, x, y, 0, 0, '#55585e', 16, 1);
      px(c, x, y, 0, 15, '#55585e', 16, 1);
    });
    this.addTile('furnace_front', (c, x, y) => {
      fillNoise(c, x, y, '#7c8087', 14, 47);
      px(c, x, y, 3, 3, '#222', 10, 4);
      px(c, x, y, 4, 10, '#222', 8, 4);
      px(c, x, y, 5, 11, '#ff7b29', 6, 2);
    });
    this.addTile('chest_top', (c, x, y) => {
      fillNoise(c, x, y, '#a67638', 12, 48);
      px(c, x, y, 0, 0, '#4f3718', 16, 1);
      px(c, x, y, 0, 15, '#4f3718', 16, 1);
      px(c, x, y, 0, 0, '#4f3718', 1, 16);
      px(c, x, y, 15, 0, '#4f3718', 1, 16);
    });
    this.addTile('chest_front', (c, x, y) => {
      fillNoise(c, x, y, '#a67638', 12, 49);
      px(c, x, y, 0, 6, '#3b2911', 16, 1);
      px(c, x, y, 6, 4, '#e6e6e6', 4, 4);
      px(c, x, y, 7, 5, '#8a8a8a', 2, 2);
    });

    // Building & Decorative
    this.addTile('glass', (c, x, y) => {
      c.fillStyle = 'rgba(205, 238, 255, 0.28)';
      c.fillRect(x, y, 16, 16);
      px(c, x, y, 0, 0, '#b5dced', 16, 1);
      px(c, x, y, 0, 15, '#b5dced', 16, 1);
      px(c, x, y, 0, 0, '#b5dced', 1, 16);
      px(c, x, y, 15, 0, '#b5dced', 1, 16);
      px(c, x, y, 3, 3, 'rgba(255,255,255,0.75)', 2, 1);
      px(c, x, y, 2, 4, 'rgba(255,255,255,0.75)', 1, 2);
    });
    this.addTile('bricks', (c, x, y) => {
      fillNoise(c, x, y, '#a14b3c', 16, 50);
      for (let iy = 0; iy < 16; iy += 4) px(c, x, y, 0, iy, '#c8c4bc', 16, 1);
      for (let iy = 0; iy < 16; iy += 4) {
        const off = (iy % 8 === 0) ? 0 : 4;
        for (let ix = off; ix < 16; ix += 8) px(c, x, y, ix, iy, '#c8c4bc', 1, 4);
      }
    });
    this.addTile('tnt_top', (c, x, y) => {
      fillNoise(c, x, y, '#b83227', 12, 51);
      px(c, x, y, 5, 5, '#2b2b2b', 6, 6);
    });
    this.addTile('tnt_side', (c, x, y) => {
      fillNoise(c, x, y, '#c9382b', 12, 52);
      px(c, x, y, 0, 5, '#f0ece4', 16, 6);
      px(c, x, y, 2, 6, '#1a1a1a', 3, 1); px(c, x, y, 3, 7, '#1a1a1a', 1, 3);
      px(c, x, y, 6, 6, '#1a1a1a', 1, 4); px(c, x, y, 7, 7, '#1a1a1a', 1, 1); px(c, x, y, 8, 6, '#1a1a1a', 1, 4);
      px(c, x, y, 10, 6, '#1a1a1a', 3, 1); px(c, x, y, 11, 7, '#1a1a1a', 1, 3);
    });
    this.addTile('torch', (c, x, y) => {
      px(c, x, y, 7, 6, '#875c34', 2, 10);
      px(c, x, y, 6, 3, '#ff9800', 4, 4);
      px(c, x, y, 7, 2, '#fff176', 2, 3);
    });
    this.addTile('bookshelf', (c, x, y) => {
      drawPlanks(c, x, y, '#a67e4d', '#755630', 53);
      const colors = ['#c62828', '#1565c0', '#2e7d32', '#f9a825', '#6a1b9a', '#d84315'];
      for (let shelf of [2, 9]) {
        px(c, x, y, 1, shelf, '#261b12', 14, 5);
        for (let ix = 1; ix < 15; ix += 2) {
          px(c, x, y, ix, shelf + 1, colors[(ix + shelf) % colors.length], 2, 4);
        }
      }
    });

    this.addTile('wool_white', (c, x, y) => fillNoise(c, x, y, '#eceef0', 12, 60));
    this.addTile('wool_red', (c, x, y) => fillNoise(c, x, y, '#c73434', 14, 61));
    this.addTile('wool_blue', (c, x, y) => fillNoise(c, x, y, '#325cc7', 14, 62));
    this.addTile('wool_green', (c, x, y) => fillNoise(c, x, y, '#3c8f3c', 14, 63));
    this.addTile('wool_yellow', (c, x, y) => fillNoise(c, x, y, '#e6c832', 14, 64));

    this.addTile('obsidian', (c, x, y) => fillNoise(c, x, y, '#231930', 18, 65));
    this.addTile('glowstone', (c, x, y) => {
      fillNoise(c, x, y, '#e0b84c', 28, 66);
      for (let i = 0; i < 16; i++) {
        px(c, x, y, Math.floor(pxHash(i, 1, 67) * 14), Math.floor(pxHash(i, 2, 67) * 14), '#fff5b5', 2, 2);
      }
    });

    this.addTile('tall_grass', (c, x, y) => {
      const blades = [2, 5, 7, 10, 13];
      for (const bx of blades) {
        const h = 6 + Math.floor(pxHash(bx, 1, 70) * 7);
        px(c, x, y, bx, 16 - h, '#4d9632', 2, h);
        px(c, x, y, bx, 16 - h, '#74bf47', 1, 3);
      }
    });
    this.addTile('flower_red', (c, x, y) => {
      px(c, x, y, 7, 8, '#3f8a29', 2, 8);
      px(c, x, y, 5, 4, '#e53935', 6, 5);
      px(c, x, y, 7, 5, '#2b2b2b', 2, 2);
    });
    this.addTile('flower_yellow', (c, x, y) => {
      px(c, x, y, 7, 8, '#3f8a29', 2, 8);
      px(c, x, y, 5, 4, '#fdd835', 6, 5);
      px(c, x, y, 7, 5, '#f57f17', 2, 2);
    });

    this.addTile('bed_top', (c, x, y) => {
      px(c, x, y, 0, 0, '#f0f0f0', 16, 5);
      px(c, x, y, 0, 5, '#c92e2e', 16, 11);
    });
    this.addTile('bed_side', (c, x, y) => {
      px(c, x, y, 0, 0, '#c92e2e', 16, 8);
      px(c, x, y, 0, 8, '#8a5d32', 16, 8);
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
    this.addTile('ladder', (c, x, y) => {
      px(c, x, y, 2, 0, '#966c3e', 2, 16);
      px(c, x, y, 12, 0, '#966c3e', 2, 16);
      for (let iy of [2, 6, 10, 14]) px(c, x, y, 2, iy, '#b58852', 12, 2);
    });
    this.addTile('farmland_top', (c, x, y) => {
      fillNoise(c, x, y, '#5e3e22', 12, 75);
      for (let iy = 1; iy < 16; iy += 3) px(c, x, y, 0, iy, '#402914', 16, 1);
    });
  }

  buildItemIcons() {
    const tmp = document.createElement('canvas');
    tmp.width = 32;
    tmp.height = 32;
    const ctx = tmp.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    for (const [key, def] of Object.entries(ITEMS)) {
      ctx.clearRect(0, 0, 32, 32);
      if (def.isBlock) {
        const faceName = def.faces.side || def.faces.all || def.faces.top;
        const tile = this.getUV(faceName);
        ctx.drawImage(this.canvas, tile.ox, tile.oy, TILE_SIZE, TILE_SIZE, 2, 2, 28, 28);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 2;
        ctx.strokeRect(2, 2, 28, 28);
      } else {
        this.drawPixelItem(ctx, key, def);
      }
      this.itemIcons[key] = tmp.toDataURL();
    }
  }

  drawPixelItem(c, key, def) {
    const p = (x, y, col, w = 2, h = 2) => {
      c.fillStyle = col;
      c.fillRect(x * 2, y * 2, w * 2, h * 2);
    };

    const tierColors = {
      wooden: '#b5844c',
      stone: '#9398a1',
      iron: '#e2e6eb',
      diamond: '#4de3e8',
      leather: '#965d32'
    };

    if (def.toolType) {
      const mat = key.split('_')[0];
      const col = tierColors[mat] || '#ccc';
      // Diagonal stick handle
      for (let i = 0; i < 9; i++) p(3 + i, 12 - i, '#7a5228', 1.2, 1.2);
      if (def.toolType === 'pickaxe') {
        p(6, 2, col, 7, 2);
        p(12, 3, col, 2, 6);
        p(11, 2, col, 2, 2);
      } else if (def.toolType === 'axe') {
        p(7, 2, col, 6, 4);
        p(9, 6, col, 4, 3);
      } else if (def.toolType === 'shovel') {
        p(10, 2, col, 4, 4);
      } else if (def.toolType === 'sword') {
        for (let i = 0; i < 8; i++) p(6 + i, 9 - i, col, 2, 2);
        p(4, 9, '#5e3d1e', 5, 1.5);
      }
      return;
    }

    if (def.armorSlot !== undefined) {
      const mat = key.split('_')[0];
      const col = tierColors[mat] || '#ccc';
      if (def.armorSlot === 0) { // helmet
        p(4, 4, col, 8, 6);
        p(6, 7, '#1a1e28', 4, 3);
      } else if (def.armorSlot === 1) { // chestplate
        p(3, 3, col, 10, 10);
        p(6, 3, '#1a1e28', 4, 2);
      } else if (def.armorSlot === 2) { // leggings
        p(4, 3, col, 8, 4);
        p(4, 7, col, 3, 6);
        p(9, 7, col, 3, 6);
      } else { // boots
        p(3, 8, col, 4, 5);
        p(9, 8, col, 4, 5);
      }
      return;
    }

    // Materials & food
    switch (key) {
      case 'stick':
        for (let i = 0; i < 10; i++) p(3 + i, 12 - i, '#8f6232', 1.4, 1.4);
        break;
      case 'coal':
        p(4, 4, '#24262b', 8, 8); p(6, 5, '#464a54', 3, 2);
        break;
      case 'raw_iron':
        p(4, 4, '#c79b77', 8, 8); p(5, 5, '#e8c4a5', 4, 3);
        break;
      case 'iron_ingot':
        p(3, 6, '#d9dfe6', 10, 5); p(4, 5, '#ffffff', 8, 2);
        break;
      case 'gold_ingot':
        p(3, 6, '#f5c731', 10, 5); p(4, 5, '#fff08a', 8, 2);
        break;
      case 'diamond':
        p(6, 2, '#5cf2f7', 4, 12); p(3, 5, '#3cd5db', 10, 6); p(5, 4, '#b8fcff', 4, 3);
        break;
      case 'emerald':
        p(5, 2, '#22d466', 6, 12); p(4, 4, '#17a84d', 8, 8); p(6, 4, '#8cffb3', 3, 4);
        break;
      case 'apple':
        p(7, 1, '#5e391f', 2, 3);
        p(9, 2, '#4ea632', 3, 2);
        p(4, 4, '#240b0b', 8, 10); p(3, 5, '#240b0b', 10, 8);
        p(4, 5, '#d92b2b', 8, 8); p(5, 4, '#e53935', 6, 10);
        p(5, 6, '#ff8a80', 2, 2); p(6, 5, '#ffcdd2', 1, 1);
        p(9, 10, '#a31b1b', 2, 2);
        break;
      case 'bread':
        p(2, 5, '#3b240c', 12, 7); p(3, 4, '#3b240c', 10, 9);
        p(3, 6, '#c98a38', 10, 5); p(4, 5, '#e8b563', 8, 3);
        p(5, 5, '#f5d28e', 2, 2); p(9, 5, '#f5d28e', 2, 2);
        p(7, 6, '#8f5a1e', 1, 3); p(10, 6, '#8f5a1e', 1, 3);
        break;
      case 'raw_porkchop':
        // Distinct pink porkchop with creamy fat trim & dark pixel outline
        p(3, 4, '#3d1518', 10, 8); p(2, 5, '#3d1518', 12, 6);
        p(3, 5, '#f7c8c8', 10, 6); p(4, 6, '#e67580', 8, 4);
        p(5, 7, '#d15664', 5, 2); p(6, 6, '#ffdada', 3, 1);
        p(10, 6, '#fff0e6', 2, 2);
        break;
      case 'cooked_porkchop':
        // Golden seared porkchop with grill marks
        p(3, 4, '#2b160a', 10, 8); p(2, 5, '#2b160a', 12, 6);
        p(3, 5, '#d49a6a', 10, 6); p(4, 6, '#a86432', 8, 4);
        p(5, 6, '#7a421c', 1, 4); p(8, 6, '#7a421c', 1, 4); p(11, 6, '#e6be8a', 1, 3);
        break;
      case 'raw_beef':
        // Deep ruby-red steak cut with white marbling
        p(2, 4, '#2e0a0a', 12, 8); p(4, 3, '#2e0a0a', 8, 10);
        p(3, 5, '#c92e36', 10, 6); p(5, 4, '#b3222b', 6, 8);
        p(4, 6, '#f5d5d5', 3, 1); p(8, 8, '#f5d5d5', 3, 1); p(6, 5, '#e85860', 3, 2);
        break;
      case 'steak':
        // Rich browned seared beefsteak with juicy center & char stripes
        p(2, 4, '#1f0e07', 12, 8); p(4, 3, '#1f0e07', 8, 10);
        p(3, 5, '#6b341c', 10, 6); p(5, 4, '#7d3e22', 6, 8);
        p(4, 6, '#9c5634', 4, 2); p(9, 7, '#4a2110', 2, 3); p(6, 8, '#b56d45', 3, 1);
        break;
      case 'raw_chicken':
        // Pale pink drumstick silhouette with white bone handle!
        p(2, 9, '#2e2520', 4, 4); p(3, 10, '#f7f3eb', 2, 2);
        p(5, 7, '#2e2520', 3, 3); p(5, 8, '#ebe3d5', 2, 2);
        p(6, 3, '#3b1d1d', 7, 7); p(7, 4, '#f2b8ad', 5, 5);
        p(8, 5, '#ffd4cb', 2, 2); p(10, 7, '#d98f82', 2, 2);
        break;
      case 'cooked_chicken':
        // Crispy golden-brown roasted drumstick!
        p(2, 9, '#2e2520', 4, 4); p(3, 10, '#f7f3eb', 2, 2);
        p(5, 7, '#2e2520', 3, 3); p(5, 8, '#ebe3d5', 2, 2);
        p(6, 3, '#2e1608', 7, 7); p(7, 4, '#c77a2e', 5, 5);
        p(8, 5, '#e8a854', 2, 2); p(10, 7, '#8f4c16', 2, 2);
        break;
      case 'raw_mutton':
        // Lamb chop with visible white rib bone on top-right
        p(3, 5, '#361115', 9, 8); p(4, 6, '#d94854', 7, 6);
        p(5, 7, '#f28b94', 4, 3); p(9, 3, '#2e2924', 4, 5);
        p(10, 4, '#f5f2eb', 2, 4); p(7, 9, '#fce8e8', 3, 1);
        break;
      case 'cooked_mutton':
        // Roasted lamb chop with bone
        p(3, 5, '#26120a', 9, 8); p(4, 6, '#874624', 7, 6);
        p(5, 7, '#ad6238', 4, 3); p(9, 3, '#2e2924', 4, 5);
        p(10, 4, '#f5f2eb', 2, 4); p(6, 9, '#5e2c14', 3, 1);
        break;
      case 'raw_venison':
        // Lean dark-crimson venison loin cut
        p(2, 5, '#26080c', 12, 7); p(4, 4, '#26080c', 8, 9);
        p(3, 6, '#9e1c2c', 10, 5); p(5, 5, '#b82538', 6, 7);
        p(5, 6, '#e05366', 4, 2); p(8, 9, '#f0d5d5', 3, 1);
        break;
      case 'cooked_venison':
        // Rich smoky mahogany roasted venison steak with herb flecks
        p(2, 5, '#1c0c06', 12, 7); p(4, 4, '#1c0c06', 8, 9);
        p(3, 6, '#5c2814', 10, 5); p(5, 5, '#73351d', 6, 7);
        p(5, 6, '#9e5332', 4, 2); p(6, 8, '#5ea844', 1, 1); p(9, 6, '#5ea844', 1, 1);
        break;
      case 'raw_rabbit':
        // Small tender pinkish-tan rabbit haunch
        p(4, 4, '#361b18', 8, 8); p(3, 7, '#361b18', 6, 5);
        p(5, 5, '#e8a296', 6, 6); p(4, 8, '#f5c2b8', 4, 3);
        p(9, 9, '#f7f3eb', 2, 2); p(6, 6, '#ffd6ce', 2, 2);
        break;
      case 'cooked_rabbit':
        // Golden roasted rabbit haunch
        p(4, 4, '#29150a', 8, 8); p(3, 7, '#29150a', 6, 5);
        p(5, 5, '#b86b2e', 6, 6); p(4, 8, '#d48a46', 4, 3);
        p(9, 9, '#f7f3eb', 2, 2); p(6, 6, '#e8aa64', 2, 2);
        break;
      case 'raw_salmon':
        // Whole pixel salmon with teal-silver back, coral belly, tail fin & eye!
        p(1, 5, '#17292e', 3, 6); p(2, 6, '#486b73', 2, 4); // tail fin
        p(3, 4, '#17292e', 11, 8);
        p(4, 5, '#4b7a78', 9, 3); // teal-silver back
        p(4, 8, '#e36f64', 9, 3); // salmon coral belly
        p(6, 6, '#75a6a3', 5, 1); // scale sheen
        p(11, 6, '#ffffff', 1, 1); p(12, 6, '#111111', 1, 1); // eye
        break;
      case 'cooked_salmon':
        // Golden-glazed grilled salmon fillet with flaky orange lines!
        p(1, 5, '#29140a', 3, 6); p(2, 6, '#7d4728', 2, 4);
        p(3, 4, '#29140a', 11, 8);
        p(4, 5, '#b85b30', 9, 3);
        p(4, 8, '#e88b4f', 9, 3);
        p(6, 6, '#ffd09c', 1, 4); p(9, 6, '#ffd09c', 1, 4);
        p(11, 6, '#fff2d6', 1, 1);
        break;
      case 'gunpowder':
        p(4, 5, '#2b2b2b', 8, 7); p(5, 6, '#555555', 6, 5); p(6, 6, '#8a8a8a', 3, 2);
        break;
      case 'bone':
        p(2, 10, '#363430', 4, 4); p(10, 2, '#363430', 4, 4);
        p(3, 11, '#f2efe9', 2, 2); p(11, 3, '#f2efe9', 2, 2);
        for (let i = 0; i < 7; i++) {
          p(4 + i, 10 - i, '#e6e2d8', 2, 2);
          p(5 + i, 10 - i, '#ffffff', 1, 1);
        }
        break;
      case 'leather':
        p(3, 3, '#331c0b', 10, 10); p(4, 4, '#9c5a2c', 8, 8);
        p(5, 5, '#bd7440', 5, 5); p(6, 6, '#d48b55', 2, 2);
        break;
      case 'feather':
        for (let i = 0; i < 10; i++) p(3 + i, 12 - i, '#dfe6ed', 2, 2);
        for (let i = 2; i < 9; i++) p(4 + i, 11 - i, '#ffffff', 2, 2);
        p(3, 12, '#7d8590', 2, 2);
        break;
      case 'wheat':
        for (let i = 0; i < 9; i++) {
          p(4 + i * 0.8, 12 - i, '#d9b13b', 2, 2);
          p(5 + i * 0.8, 11 - i, '#f5dc78', 1, 1);
        }
        break;
      default:
        p(4, 4, '#999', 8, 8);
    }
  }

  getIcon(itemKey) {
    return this.itemIcons[itemKey] || '';
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

  // Real 3D pixel-art mini-block geometry mapped to exact atlas top/side/bottom UVs!
  createBlockDropGeometry(blockDef, size = 0.28) {
    const cacheKey = `${blockDef.id}:${size}`;
    if (this.blockDropGeoCache[cacheKey]) return this.blockDropGeoCache[cacheKey];

    const h = size * 0.5;
    const topUV = this.getUV(blockDef.faces.top || blockDef.faces.all || blockDef.faces.side);
    const botUV = this.getUV(blockDef.faces.bottom || blockDef.faces.all || blockDef.faces.side);
    const sideUV = this.getUV(blockDef.faces.side || blockDef.faces.all || blockDef.faces.top);

    const faces = [
      { uv: topUV, n: [0, 1, 0], v: [[-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]] },
      { uv: botUV, n: [0, -1, 0], v: [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]] },
      { uv: sideUV, n: [1, 0, 0], v: [[h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]] },
      { uv: sideUV, n: [-1, 0, 0], v: [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]] },
      { uv: sideUV, n: [0, 0, 1], v: [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]] },
      { uv: sideUV, n: [0, 0, -1], v: [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]] }
    ];

    const pos = [], norm = [], uv = [], idx = [];
    let base = 0;
    for (const f of faces) {
      const u = f.uv;
      for (const pt of f.v) {
        pos.push(pt[0], pt[1], pt[2]);
        norm.push(f.n[0], f.n[1], f.n[2]);
      }
      uv.push(u.u0, u.v0, u.u1, u.v0, u.u1, u.v1, u.u0, u.v1);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      base += 4;
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
    }

    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    this.mobCoatCache[key] = tex;
    return tex;
  }

  // Crisp 16x16 Minecraft-Style Pixel-Art HUD Icons (Hearts, Food, Water Bubbles, Armor!)
  buildHudIcons() {
    const renderGrid = (rows, palette) => {
      const c = document.createElement('canvas');
      c.width = 18;
      c.height = 18;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      for (let y = 0; y < rows.length; y++) {
        const row = rows[y];
        for (let x = 0; x < row.length; x++) {
          const col = palette[row[x]];
          if (col) {
            ctx.fillStyle = col;
            ctx.fillRect(x * 2, y * 2, 2, 2);
          }
        }
      }
      return c.toDataURL();
    };

    // 9x9 Classic Pixel Heart (scaled 2x to 18x18)
    const heartFull = [
      '.OO...OO.',
      'ORRO.ORRO',
      'ORWROORRO',
      'ORRRRRRRO',
      'ORRRRRRRO',
      '.ORRRRDO.',
      '..ORRDO..',
      '...ODO...',
      '....O....'
    ];
    const heartHalf = [
      '.OO...OO.',
      'ORRO.O..O',
      'ORWROO..O',
      'ORRRR...O',
      'ORRRR...O',
      '.ORRR..O.',
      '..ORR.O..',
      '...OD.O..',
      '....O....'
    ];
    const heartEmpty = [
      '.OO...OO.',
      'O..O.O..O',
      'O...O...O',
      'O.......O',
      'O.......O',
      '.O.....O.',
      '..O...O..',
      '...O.O...',
      '....O....'
    ];
    const heartPal = {
      O: '#141414',
      R: '#e02424',
      D: '#9c1111',
      W: '#ffbaba',
      '.': null
    };
    const heartEmptyPal = {
      O: '#141414',
      '.': null
    };
    // Fill interior of empty/half heart with dark container shade
    const fillHeartBg = (rows, pal) => {
      const c = document.createElement('canvas');
      c.width = 18; c.height = 18;
      const ctx = c.getContext('2d');
      const mask = [
        '.OO...OO.',
        'OBBO.OBBO',
        'OBBBOBBBO',
        'OBBBBBBBO',
        'OBBBBBBBO',
        '.OBBBBBO.',
        '..OBBBO..',
        '...OBO...',
        '....O....'
      ];
      for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
          if (mask[y][x] === 'B') {
            ctx.fillStyle = '#2d1c1c';
            ctx.fillRect(x * 2, y * 2, 2, 2);
          }
          const col = pal[rows[y][x]];
          if (col) {
            ctx.fillStyle = col;
            ctx.fillRect(x * 2, y * 2, 2, 2);
          }
        }
      }
      return c.toDataURL();
    };
    this.hudIcons.heart_full = fillHeartBg(heartFull, heartPal);
    this.hudIcons.heart_half = fillHeartBg(heartHalf, heartPal);
    this.hudIcons.heart_empty = fillHeartBg(heartEmpty, heartEmptyPal);

    // 9x9 Classic Pixel Meat Drumstick (Food / Hunger)
    const foodFull = [
      '....OOOO.',
      '...OLLLOO',
      '..OLMMMLO',
      '..OMMMMDO',
      '..OMMMDDO',
      '.OOBBDDO.',
      'OWWBOOO..',
      'OWWO.....',
      '.OO......'
    ];
    const foodHalf = [
      '....OOOO.',
      '...O....O',
      '..O.....O',
      '..O..MMDO',
      '..O..MDDO',
      '.OOBBDDO.',
      'OWWBOOO..',
      'OWWO.....',
      '.OO......'
    ];
    const foodEmpty = [
      '....OOOO.',
      '...O....O',
      '..O.....O',
      '..O.....O',
      '..O.....O',
      '.OO....O.',
      'O..OOOO..',
      'O..O.....',
      '.OO......'
    ];
    const foodPal = {
      O: '#1e120a',
      L: '#e8a254',
      M: '#ba6c2c',
      D: '#7d3e14',
      B: '#d6ccb8',
      W: '#ffffff'
    };
    const fillFoodBg = (rows, pal) => {
      const c = document.createElement('canvas');
      c.width = 18; c.height = 18;
      const ctx = c.getContext('2d');
      const mask = [
        '....OOOO.',
        '...OBBBBO',
        '..OBBBBBO',
        '..OBBBBBO',
        '..OBBBBBO',
        '.OOBBBBO.',
        'OBBBOOO..',
        'OBBO.....',
        '.OO......'
      ];
      for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
          if (mask[y][x] === 'B') {
            ctx.fillStyle = '#2b2019';
            ctx.fillRect(x * 2, y * 2, 2, 2);
          }
          const col = pal[rows[y][x]];
          if (col) {
            ctx.fillStyle = col;
            ctx.fillRect(x * 2, y * 2, 2, 2);
          }
        }
      }
      return c.toDataURL();
    };
    this.hudIcons.food_full = fillFoodBg(foodFull, foodPal);
    this.hudIcons.food_half = fillFoodBg(foodHalf, foodPal);
    this.hudIcons.food_empty = fillFoodBg(foodEmpty, foodPal);

    // 9x9 Pixel Water / Air Bubble
    const bubbleFull = [
      '..OOOOO..',
      '.OBWWWBO.',
      'OBWLLLBBO',
      'OBLBBBBBO',
      'OBBBBBDBO',
      'OBBBBDDDO',
      'OBBBDDDDO',
      '.ODDDDDO.',
      '..OOOOO..'
    ];
    const bubblePop = [
      '.O.....O.',
      '..O...O..',
      '....L....',
      '.O.L.L.O.',
      '..L...L..',
      '.O.L.L.O.',
      '....L....',
      '..O...O..',
      '.O.....O.'
    ];
    const bubblePal = {
      O: '#0d3d66',
      W: '#ffffff',
      L: '#a6e4ff',
      B: '#38bdf8',
      D: '#1d7cb8'
    };
    this.hudIcons.bubble_full = renderGrid(bubbleFull, bubblePal);
    this.hudIcons.bubble_pop = renderGrid(bubblePop, bubblePal);

    // 9x9 Pixel Armor Chestplate / Shield
    const armorFull = [
      '.OO...OO.',
      'OSSO.OSSO',
      'OSWOOOWSO',
      'OSWWWWWSO',
      'OSWSSSWO.',
      'OSSDDDSSO',
      'OSDDDDDSO',
      '.ODDDDDO.',
      '..OOOOO..'
    ];
    const armorHalf = [
      '.OO...OO.',
      'OSSO.O..O',
      'OSWOO...O',
      'OSWW....O',
      'OSWS....O',
      'OSSD....O',
      'OSDD....O',
      '.ODD...O.',
      '..OOOOO..'
    ];
    const armorPal = {
      O: '#14171c',
      W: '#ffffff',
      S: '#c8d1db',
      D: '#7d8896'
    };
    this.hudIcons.armor_full = renderGrid(armorFull, armorPal);
    this.hudIcons.armor_half = renderGrid(armorHalf, armorPal);
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

    // 17. ARROWS (D-Pad + Crafting Arrow)
    this.uiIcons.arrow_up = make((p) => {
      for (let i = 0; i < 6; i++) p(7 - i, 3 + i, '#ffffff', 2 + i * 2, 1);
      p(6, 9, '#cbd5e1', 4, 4);
    });
    this.uiIcons.arrow_down = make((p) => {
      p(6, 3, '#cbd5e1', 4, 4);
      for (let i = 0; i < 6; i++) p(2 + i, 7 + i, '#ffffff', 12 - i * 2, 1);
    });
    this.uiIcons.arrow_left = make((p) => {
      for (let i = 0; i < 6; i++) p(3 + i, 7 - i, '#ffffff', 1, 2 + i * 2);
      p(9, 6, '#cbd5e1', 4, 4);
    });
    this.uiIcons.arrow_right = make((p) => {
      p(3, 6, '#cbd5e1', 4, 4);
      for (let i = 0; i < 6; i++) p(7 + i, 2 + i, '#ffffff', 1, 12 - i * 2);
    });
    this.uiIcons.arrow_right_gold = make((p) => {
      p(2, 5, '#2b1e05', 6, 6);
      for (let i = 0; i < 6; i++) p(7 + i, 2 + i, '#2b1e05', 2, 12 - i * 2);
      p(3, 6, '#ffd54f', 5, 4);
      for (let i = 0; i < 5; i++) p(8 + i, 3 + i, '#ffe57f', 1, 10 - i * 2);
    });

    // 18. FURNACE FLAME
    this.uiIcons.flame = make((p) => {
      p(6, 1, '#ff5722', 4, 3);
      p(4, 4, '#ff7043', 8, 5);
      p(3, 8, '#f4511e', 10, 6);
      p(5, 6, '#ffb300', 6, 7);
      p(6, 9, '#fff176', 4, 4);
      p(7, 11, '#ffffff', 2, 2);
    });

    // 19. TIME & WEATHER PIXEL ICONS
    this.uiIcons.sunrise = make((p) => {
      p(1, 10, '#2e4a7d', 14, 5);
      p(1, 9, '#ff9e5e', 14, 2);
      p(5, 5, '#ffd54f', 6, 5);
      p(6, 4, '#fff176', 4, 4);
      p(7, 2, '#ffe082', 2, 2);
      p(3, 6, '#ffe082', 2, 1);
      p(11, 6, '#ffe082', 2, 1);
    });
    this.uiIcons.sun = make((p) => {
      p(5, 5, '#ffb300', 6, 6);
      p(6, 6, '#fff176', 4, 4);
      p(7, 1, '#ffd54f', 2, 3); p(7, 12, '#ffd54f', 2, 3);
      p(1, 7, '#ffd54f', 3, 2); p(12, 7, '#ffd54f', 3, 2);
      p(3, 3, '#ffd54f', 2, 2); p(11, 3, '#ffd54f', 2, 2);
      p(3, 11, '#ffd54f', 2, 2); p(11, 11, '#ffd54f', 2, 2);
    });
    this.uiIcons.sunset = make((p) => {
      p(1, 2, '#4a3d8c', 14, 4);
      p(1, 6, '#d96b8a', 14, 3);
      p(1, 9, '#ff9b54', 14, 2);
      p(5, 7, '#ffe082', 6, 3);
      p(1, 11, '#3b4f85', 14, 4);
      p(4, 12, '#ffb574', 8, 1);
      p(6, 13, '#ffd299', 4, 1);
    });
    this.uiIcons.moon = make((p) => {
      p(4, 2, '#cbd5e1', 7, 12);
      p(3, 4, '#e2e8f0', 9, 8);
      p(7, 4, '#1e293b', 6, 8);
      p(8, 3, '#1e293b', 4, 10);
      p(12, 3, '#fff59d', 1, 1);
      p(13, 10, '#fff59d', 1, 1);
    });
    this.uiIcons.rain = make((p) => {
      p(4, 2, '#94a3b8', 8, 5);
      p(2, 4, '#cbd5e1', 12, 4);
      p(4, 9, '#38bdf8', 1, 3);
      p(7, 10, '#38bdf8', 1, 4);
      p(10, 9, '#38bdf8', 1, 3);
      p(12, 11, '#7dd3fc', 1, 3);
    });

    // 20. COMMAND & MOD PIXEL ICONS
    this.uiIcons.star = make((p) => {
      p(7, 1, '#ffd54f', 2, 14);
      p(1, 7, '#ffd54f', 14, 2);
      p(4, 4, '#ffe57f', 8, 8);
      p(6, 6, '#ffffff', 4, 4);
    });
    this.uiIcons.map = make((p) => {
      p(2, 2, '#241a0d', 12, 12);
      p(3, 3, '#e8d7a8', 10, 10);
      p(4, 4, '#5da135', 4, 4);
      p(8, 7, '#38bdf8', 4, 4);
      p(6, 6, '#e53935', 2, 2);
    });
    this.uiIcons.paw = make((p) => {
      p(5, 8, '#3d2414', 6, 5);
      p(6, 9, '#b87642', 4, 3);
      p(3, 4, '#b87642', 2, 3);
      p(6, 3, '#b87642', 2, 3);
      p(9, 3, '#b87642', 2, 3);
      p(11, 5, '#b87642', 2, 3);
    });
    this.uiIcons.wing = make((p) => {
      p(2, 4, '#e2e8f0', 10, 3);
      p(4, 7, '#cbd5e1', 9, 3);
      p(6, 10, '#94a3b8', 6, 2);
      p(3, 5, '#ffffff', 6, 1);
    });
    this.uiIcons.axe = this.itemIcons.iron_axe || this.uiIcons.mine;
    this.uiIcons.pickaxe = this.itemIcons.diamond_pickaxe || this.uiIcons.mine;
    this.uiIcons.torch = this.itemIcons.torch || this.uiIcons.flame;
    this.uiIcons.tnt = this.itemIcons.tnt || this.uiIcons.place;
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
      p(3, 8, '#6b7280', 4, 5);
      p(9, 8, '#6b7280', 4, 5);
    });
  }
}
