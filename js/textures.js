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
        p(7, 2, '#6b4226', 2, 3); p(4, 5, '#e53935', 8, 8); p(5, 6, '#ff7961', 2, 2);
        break;
      case 'bread':
        p(2, 6, '#c98e3e', 12, 5); p(4, 5, '#e6b160', 8, 2);
        break;
      case 'raw_porkchop':
      case 'raw_beef':
        p(3, 5, '#e07a7a', 10, 6); p(5, 6, '#f5b5b5', 5, 3);
        break;
      case 'cooked_porkchop':
      case 'steak':
        p(3, 5, '#7a4024', 10, 6); p(5, 6, '#a65d38', 5, 3);
        break;
      case 'gunpowder':
        p(4, 5, '#555', 8, 7); p(6, 6, '#888', 3, 3);
        break;
      case 'bone':
        p(3, 10, '#f0eee9', 3, 3); p(10, 3, '#f0eee9', 3, 3);
        for (let i = 0; i < 6; i++) p(5 + i, 10 - i, '#f0eee9', 2, 2);
        break;
      case 'leather':
        p(3, 4, '#9c5a2c', 10, 9); p(5, 6, '#bd7440', 5, 4);
        break;
      case 'feather':
        for (let i = 0; i < 9; i++) p(3 + i, 12 - i, '#f2f5f7', 2, 2);
        break;
      case 'wheat':
        for (let i = 0; i < 9; i++) p(4 + i * 0.8, 12 - i, '#e6c24c', 2, 2);
        break;
      default:
        p(4, 4, '#999', 8, 8);
    }
  }

  getIcon(itemKey) {
    return this.itemIcons[itemKey] || '';
  }
}
