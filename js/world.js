import * as THREE from 'three';
import { BLOCK, getBlockDef, isBlockTransparent, isBlockCross, isBlockLiquid, isBlockSolid, isBedBlock, getBedInfo, isDoorBlock, isDoorTop, isDoorBottom, isFenceBlock, isFenceGateBlock, isFenceOrGate, isWheatBlock, isFarmlandBlock } from './blocks.js';
import { Noise, hashString } from './noise.js';
import { SMELTING_RECIPES, FUEL_VALUES } from './recipes.js';
import { LodWorkerPool } from './lod-mesher.js';
import { VoxelGIVolume } from './voxel-gi.js';

export const CHUNK_SIZE = 16;
export const CHUNK_HEIGHT = 512;
export const SEA_LEVEL = 64;

// Face definitions: dir, corners (CCW when looking at face from outside), shade
const FACES = [
  { // +Y Top
    dir: [0, 1, 0],
    faceType: 'top',
    shade: 1.0,
    corners: [
      [0, 1, 1, 0, 0],
      [1, 1, 1, 1, 0],
      [1, 1, 0, 1, 1],
      [0, 1, 0, 0, 1]
    ]
  },
  { // -Y Bottom
    dir: [0, -1, 0],
    faceType: 'bottom',
    shade: 0.66,
    corners: [
      [0, 0, 0, 0, 0],
      [1, 0, 0, 1, 0],
      [1, 0, 1, 1, 1],
      [0, 0, 1, 0, 1]
    ]
  },
  { // +X East
    dir: [1, 0, 0],
    faceType: 'side',
    shade: 0.90,
    corners: [
      [1, 0, 1, 0, 0],
      [1, 0, 0, 1, 0],
      [1, 1, 0, 1, 1],
      [1, 1, 1, 0, 1]
    ]
  },
  { // -X West
    dir: [-1, 0, 0],
    faceType: 'side',
    shade: 0.90,
    corners: [
      [0, 0, 0, 0, 0],
      [0, 0, 1, 1, 0],
      [0, 1, 1, 1, 1],
      [0, 1, 0, 0, 1]
    ]
  },
  { // +Z South
    dir: [0, 0, 1],
    faceType: 'side',
    shade: 0.84,
    corners: [
      [0, 0, 1, 0, 0],
      [1, 0, 1, 1, 0],
      [1, 1, 1, 1, 1],
      [0, 1, 1, 0, 1]
    ]
  },
  { // -Z North
    dir: [0, 0, -1],
    faceType: 'side',
    shade: 0.84,
    corners: [
      [1, 0, 0, 0, 0],
      [0, 0, 0, 1, 0],
      [0, 1, 0, 1, 1],
      [1, 1, 0, 0, 1]
    ]
  }
];

function coordHash(x, z, seed) {
  let h = Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 1442695041);
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Reusable zero-GC TypedArray scratch buffer for chunk meshing (Greedy Atlas Tiling + 3D Voxel GI RGB Channels!)
class MeshBucket {
  constructor(initialVerts = 16384, tiled = false, withGI = false) {
    this.cap = initialVerts;
    this.tiled = tiled;
    this.withGI = withGI;
    this.pos = new Float32Array(initialVerts * 3);
    this.norm = new Float32Array(initialVerts * 3);
    this.uv = new Float32Array(initialVerts * 2);
    this.col = new Float32Array(initialVerts * 3);
    this.tile = tiled ? new Float32Array(initialVerts * 4) : null;
    this.blk = withGI ? new Float32Array(initialVerts * 3) : null;
    this.bnc = withGI ? new Float32Array(initialVerts * 3) : null;
    this.idx = new Uint32Array((initialVerts / 4) * 6);
    this.vCount = 0;
    this.iCount = 0;
    this._sky = 1.0;
    this._br = 0.0; this._bg = 0.0; this._bb = 0.0;
    this._gr = 0.0; this._gg = 0.0; this._gb = 0.0;
    this._emit = 0.0;
  }

  reset() {
    this.vCount = 0;
    this.iCount = 0;
    this._sky = 1.0;
    this._br = 0.0; this._bg = 0.0; this._bb = 0.0;
    this._gr = 0.0; this._gg = 0.0; this._gb = 0.0;
    this._emit = 0.0;
  }

  setGI(sky, br, bg, bb, gr, gg, gb, emit = 0.0) {
    this._sky = sky;
    this._br = br; this._bg = bg; this._bb = bb;
    this._gr = gr; this._gg = gg; this._gb = gb;
    this._emit = emit;
  }

  ensure(addVerts) {
    if (this.vCount + addVerts <= this.cap) return;
    let newCap = this.cap * 2;
    while (newCap < this.vCount + addVerts) newCap *= 2;
    const growF = (old, stride) => {
      const next = new Float32Array(newCap * stride);
      next.set(old);
      return next;
    };
    this.pos = growF(this.pos, 3);
    this.norm = growF(this.norm, 3);
    this.uv = growF(this.uv, 2);
    this.col = growF(this.col, 3);
    if (this.tiled) this.tile = growF(this.tile, 4);
    if (this.withGI) {
      this.blk = growF(this.blk, 3);
      this.bnc = growF(this.bnc, 3);
    }
    const nextIdx = new Uint32Array((newCap / 4) * 6);
    nextIdx.set(this.idx);
    this.idx = nextIdx;
    this.cap = newCap;
  }

  pushQuad(
    x0, y0, z0, u0, v0, c0,
    x1, y1, z1, u1, v1, c1,
    x2, y2, z2, u2, v2, c2,
    x3, y3, z3, u3, v3, c3,
    nx, ny, nz
  ) {
    this.ensure(4);
    const base = this.vCount;
    const p = base * 3;
    const u = base * 2;
    const pos = this.pos, norm = this.norm, uv = this.uv, col = this.col;

    pos[p] = x0; pos[p + 1] = y0; pos[p + 2] = z0;
    pos[p + 3] = x1; pos[p + 4] = y1; pos[p + 5] = z1;
    pos[p + 6] = x2; pos[p + 7] = y2; pos[p + 8] = z2;
    pos[p + 9] = x3; pos[p + 10] = y3; pos[p + 11] = z3;

    norm[p] = nx; norm[p + 1] = ny; norm[p + 2] = nz;
    norm[p + 3] = nx; norm[p + 4] = ny; norm[p + 5] = nz;
    norm[p + 6] = nx; norm[p + 7] = ny; norm[p + 8] = nz;
    norm[p + 9] = nx; norm[p + 10] = ny; norm[p + 11] = nz;

    uv[u] = u0; uv[u + 1] = v0;
    uv[u + 2] = u1; uv[u + 3] = v1;
    uv[u + 4] = u2; uv[u + 5] = v2;
    uv[u + 6] = u3; uv[u + 7] = v3;

    if (this.withGI) {
      const sky = this._sky, em = this._emit;
      col[p] = c0; col[p + 1] = sky; col[p + 2] = em;
      col[p + 3] = c1; col[p + 4] = sky; col[p + 5] = em;
      col[p + 6] = c2; col[p + 7] = sky; col[p + 8] = em;
      col[p + 9] = c3; col[p + 10] = sky; col[p + 11] = em;
      const blk = this.blk, bnc = this.bnc;
      const br = this._br, bg = this._bg, bb = this._bb;
      const gr = this._gr, gg = this._gg, gb = this._gb;
      blk[p] = br; blk[p + 1] = bg; blk[p + 2] = bb;
      blk[p + 3] = br; blk[p + 4] = bg; blk[p + 5] = bb;
      blk[p + 6] = br; blk[p + 7] = bg; blk[p + 8] = bb;
      blk[p + 9] = br; blk[p + 10] = bg; blk[p + 11] = bb;
      bnc[p] = gr; bnc[p + 1] = gg; bnc[p + 2] = gb;
      bnc[p + 3] = gr; bnc[p + 4] = gg; bnc[p + 5] = gb;
      bnc[p + 6] = gr; bnc[p + 7] = gg; bnc[p + 8] = gb;
      bnc[p + 9] = gr; bnc[p + 10] = gg; bnc[p + 11] = gb;
    } else {
      col[p] = c0; col[p + 1] = c0; col[p + 2] = c0;
      col[p + 3] = c1; col[p + 4] = c1; col[p + 5] = c1;
      col[p + 6] = c2; col[p + 7] = c2; col[p + 8] = c2;
      col[p + 9] = c3; col[p + 10] = c3; col[p + 11] = c3;
    }

    if (this.tiled) {
      const t = base * 4;
      const tl = this.tile;
      tl[t] = 0; tl[t + 1] = 0; tl[t + 2] = 1; tl[t + 3] = 1;
      tl[t + 4] = 0; tl[t + 5] = 0; tl[t + 6] = 1; tl[t + 7] = 1;
      tl[t + 8] = 0; tl[t + 9] = 0; tl[t + 10] = 1; tl[t + 11] = 1;
      tl[t + 12] = 0; tl[t + 13] = 0; tl[t + 14] = 1; tl[t + 15] = 1;
    }

    const ii = this.iCount;
    const idx = this.idx;
    if (c0 + c2 < c1 + c3) {
      idx[ii] = base + 1; idx[ii + 1] = base + 2; idx[ii + 2] = base + 3;
      idx[ii + 3] = base + 1; idx[ii + 4] = base + 3; idx[ii + 5] = base;
    } else {
      idx[ii] = base; idx[ii + 1] = base + 1; idx[ii + 2] = base + 2;
      idx[ii + 3] = base; idx[ii + 4] = base + 2; idx[ii + 5] = base + 3;
    }

    this.vCount = base + 4;
    this.iCount = ii + 6;
  }

  pushTiledQuad(
    x0, y0, z0, u0, v0, c0,
    x1, y1, z1, u1, v1, c1,
    x2, y2, z2, u2, v2, c2,
    x3, y3, z3, u3, v3, c3,
    nx, ny, nz,
    tu, tv, tdu, tdv
  ) {
    this.ensure(4);
    const base = this.vCount;
    const p = base * 3;
    const u = base * 2;
    const pos = this.pos, norm = this.norm, uv = this.uv, col = this.col;

    pos[p] = x0; pos[p + 1] = y0; pos[p + 2] = z0;
    pos[p + 3] = x1; pos[p + 4] = y1; pos[p + 5] = z1;
    pos[p + 6] = x2; pos[p + 7] = y2; pos[p + 8] = z2;
    pos[p + 9] = x3; pos[p + 10] = y3; pos[p + 11] = z3;

    norm[p] = nx; norm[p + 1] = ny; norm[p + 2] = nz;
    norm[p + 3] = nx; norm[p + 4] = ny; norm[p + 5] = nz;
    norm[p + 6] = nx; norm[p + 7] = ny; norm[p + 8] = nz;
    norm[p + 9] = nx; norm[p + 10] = ny; norm[p + 11] = nz;

    uv[u] = u0; uv[u + 1] = v0;
    uv[u + 2] = u1; uv[u + 3] = v1;
    uv[u + 4] = u2; uv[u + 5] = v2;
    uv[u + 6] = u3; uv[u + 7] = v3;

    if (this.withGI) {
      const sky = this._sky, em = this._emit;
      col[p] = c0; col[p + 1] = sky; col[p + 2] = em;
      col[p + 3] = c1; col[p + 4] = sky; col[p + 5] = em;
      col[p + 6] = c2; col[p + 7] = sky; col[p + 8] = em;
      col[p + 9] = c3; col[p + 10] = sky; col[p + 11] = em;
      const blk = this.blk, bnc = this.bnc;
      const br = this._br, bg = this._bg, bb = this._bb;
      const gr = this._gr, gg = this._gg, gb = this._gb;
      blk[p] = br; blk[p + 1] = bg; blk[p + 2] = bb;
      blk[p + 3] = br; blk[p + 4] = bg; blk[p + 5] = bb;
      blk[p + 6] = br; blk[p + 7] = bg; blk[p + 8] = bb;
      blk[p + 9] = br; blk[p + 10] = bg; blk[p + 11] = bb;
      bnc[p] = gr; bnc[p + 1] = gg; bnc[p + 2] = gb;
      bnc[p + 3] = gr; bnc[p + 4] = gg; bnc[p + 5] = gb;
      bnc[p + 6] = gr; bnc[p + 7] = gg; bnc[p + 8] = gb;
      bnc[p + 9] = gr; bnc[p + 10] = gg; bnc[p + 11] = gb;
    } else {
      col[p] = c0; col[p + 1] = c0; col[p + 2] = c0;
      col[p + 3] = c1; col[p + 4] = c1; col[p + 5] = c1;
      col[p + 6] = c2; col[p + 7] = c2; col[p + 8] = c2;
      col[p + 9] = c3; col[p + 10] = c3; col[p + 11] = c3;
    }

    const t = base * 4;
    const tl = this.tile;
    tl[t] = tu; tl[t + 1] = tv; tl[t + 2] = tdu; tl[t + 3] = tdv;
    tl[t + 4] = tu; tl[t + 5] = tv; tl[t + 6] = tdu; tl[t + 7] = tdv;
    tl[t + 8] = tu; tl[t + 9] = tv; tl[t + 10] = tdu; tl[t + 11] = tdv;
    tl[t + 12] = tu; tl[t + 13] = tv; tl[t + 14] = tdu; tl[t + 15] = tdv;

    const ii = this.iCount;
    const idx = this.idx;
    if (c0 + c2 < c1 + c3) {
      idx[ii] = base + 1; idx[ii + 1] = base + 2; idx[ii + 2] = base + 3;
      idx[ii + 3] = base + 1; idx[ii + 4] = base + 3; idx[ii + 5] = base;
    } else {
      idx[ii] = base; idx[ii + 1] = base + 1; idx[ii + 2] = base + 2;
      idx[ii + 3] = base; idx[ii + 4] = base + 2; idx[ii + 5] = base + 3;
    }

    this.vCount = base + 4;
    this.iCount = ii + 6;
  }

  toGeometry() {
    if (this.vCount === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, this.vCount * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.norm.slice(0, this.vCount * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, this.vCount * 2), 2));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, this.vCount * 3), 3));
    if (this.tiled) {
      geo.setAttribute('aTile', new THREE.BufferAttribute(this.tile.slice(0, this.vCount * 4), 4));
    }
    if (this.withGI) {
      geo.setAttribute('aBlockLight', new THREE.BufferAttribute(this.blk.slice(0, this.vCount * 3), 3));
      geo.setAttribute('aBounceLight', new THREE.BufferAttribute(this.bnc.slice(0, this.vCount * 3), 3));
    }
    const idxSlice = this.vCount < 65536
      ? new Uint16Array(this.idx.subarray(0, this.iCount))
      : this.idx.slice(0, this.iCount);
    geo.setIndex(new THREE.BufferAttribute(idxSlice, 1));
    return geo;
  }
}

const SCRATCH_BUCKETS = {
  opaque: new MeshBucket(16384, true, true),
  cutout: new MeshBucket(8192, false, true),
  staticCutout: new MeshBucket(4096, false, true),
  water: new MeshBucket(4096, false, false),
  fire: new MeshBucket(2048, false, false)
};
const VOXEL_GI = new VoxelGIVolume();
const GI_EMIT_TMP = new Float32Array(3);
// Dual coarse 4x4x4 trilinear cave grids (Minecraft 1.18 Spaghetti + Cheese Caverns, up to Y=252!)
const CAVE_GRID = new Float32Array(5 * 64 * 5);
const CAVE_GRID_B = new Float32Array(5 * 64 * 5);
// Zero-GC Greedy Meshing slice masks & 16-bit column sky-light cache (supports 512-block world height!)
const GREEDY_MASK = new Int32Array(16 * CHUNK_HEIGHT);
const GREEDY_GI = new Int32Array(16 * CHUNK_HEIGHT);
const GREEDY_SHADE = new Float32Array(16 * CHUNK_HEIGHT);
const GREEDY_WATER_MASK = new Uint8Array(256);
const SKY_TOP = new Uint16Array(256);

const LOG_BLOCK_SET = new Set([
  BLOCK.OAK_LOG, BLOCK.BIRCH_LOG, BLOCK.SPRUCE_LOG,
  BLOCK.ACACIA_LOG, BLOCK.JUNGLE_LOG, BLOCK.CHERRY_LOG
]);
const LEAF_BLOCK_SET = new Set([
  BLOCK.OAK_LEAVES, BLOCK.BIRCH_LEAVES, BLOCK.SPRUCE_LEAVES,
  BLOCK.ACACIA_LEAVES, BLOCK.JUNGLE_LEAVES, BLOCK.CHERRY_LEAVES
]);
const FLAMMABLE_SET = new Set([
  BLOCK.OAK_LOG, BLOCK.BIRCH_LOG, BLOCK.SPRUCE_LOG, BLOCK.ACACIA_LOG, BLOCK.JUNGLE_LOG, BLOCK.CHERRY_LOG,
  BLOCK.OAK_LEAVES, BLOCK.BIRCH_LEAVES, BLOCK.SPRUCE_LEAVES, BLOCK.ACACIA_LEAVES, BLOCK.JUNGLE_LEAVES, BLOCK.CHERRY_LEAVES,
  BLOCK.OAK_PLANKS, BLOCK.BIRCH_PLANKS, BLOCK.SPRUCE_PLANKS, BLOCK.ACACIA_PLANKS, BLOCK.JUNGLE_PLANKS, BLOCK.CHERRY_PLANKS,
  BLOCK.CRAFTING_TABLE, BLOCK.BOOKSHELF, BLOCK.LADDER, BLOCK.TALL_GRASS, BLOCK.FLOWER_RED, BLOCK.FLOWER_YELLOW,
  BLOCK.WOOL_WHITE, BLOCK.WOOL_RED, BLOCK.WOOL_BLUE, BLOCK.WOOL_GREEN, BLOCK.WOOL_YELLOW,
  BLOCK.BED, BLOCK.BED_HEAD_N, BLOCK.BED_FOOT_S, BLOCK.BED_HEAD_S, BLOCK.BED_FOOT_E, BLOCK.BED_HEAD_E, BLOCK.BED_FOOT_W, BLOCK.BED_HEAD_W,
  BLOCK.OAK_DOOR_B, BLOCK.OAK_DOOR_T, BLOCK.BIRCH_DOOR_B, BLOCK.BIRCH_DOOR_T,
  BLOCK.SPRUCE_DOOR_B, BLOCK.SPRUCE_DOOR_T, BLOCK.ACACIA_DOOR_B, BLOCK.ACACIA_DOOR_T,
  BLOCK.JUNGLE_DOOR_B, BLOCK.JUNGLE_DOOR_T, BLOCK.CHERRY_DOOR_B, BLOCK.CHERRY_DOOR_T,
  BLOCK.OAK_FENCE, BLOCK.BIRCH_FENCE, BLOCK.SPRUCE_FENCE, BLOCK.ACACIA_FENCE, BLOCK.JUNGLE_FENCE, BLOCK.CHERRY_FENCE,
  BLOCK.OAK_FENCE_GATE, BLOCK.BIRCH_FENCE_GATE, BLOCK.SPRUCE_FENCE_GATE, BLOCK.ACACIA_FENCE_GATE, BLOCK.JUNGLE_FENCE_GATE, BLOCK.CHERRY_FENCE_GATE
]);
const FAST_BURN_SET = new Set([
  BLOCK.OAK_LEAVES, BLOCK.BIRCH_LEAVES, BLOCK.SPRUCE_LEAVES, BLOCK.ACACIA_LEAVES, BLOCK.JUNGLE_LEAVES, BLOCK.CHERRY_LEAVES,
  BLOCK.TALL_GRASS, BLOCK.FLOWER_RED, BLOCK.FLOWER_YELLOW,
  BLOCK.WOOL_WHITE, BLOCK.WOOL_RED, BLOCK.WOOL_BLUE, BLOCK.WOOL_GREEN, BLOCK.WOOL_YELLOW
]);
const LEAF_MAX_WOOD_DIST = 6;
const LEAF_DIRS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1]
];

export class World {
  constructor(scene, textures, options = {}) {
    this.scene = scene;
    this.textures = textures;
    this.seedStr = String(options.seed || Math.floor(Math.random() * 999999));
    this.seed = hashString(this.seedStr);
    this.worldType = options.worldType || 'infinite';
    this.generateStructures = options.generateStructures !== false;

    this.heightNoise = new Noise(this.seed);
    this.biomeNoise = new Noise(this.seed + 101);
    this.moistureNoise = new Noise(this.seed + 202);
    this.caveNoise = new Noise(this.seed + 303);
    this.oreNoise = new Noise(this.seed + 404);

    this.chunks = new Map(); // numeric chunkKey -> { cx, cz, key, data: Uint8Array, maxY, meshes: [], dirty: bool }
    this.modifiedBlocks = new Map(); // "x,y,z" -> blockId (for save serialization)
    this.modsByChunk = new Map(); // numeric chunkKey -> Array<[lx, y, lz, blockId]>
    this.chests = new Map(); // "x,y,z" -> Array(27)
    this.furnaces = new Map(); // "x,y,z" -> { input, fuel, output, burnTime, burnMax, cookTime }
    this.doorStates = new Map(); // "x,y,z" (bottom block) -> { facing: 0..3, open: boolean }
    this.gateStates = new Map(); // "x,y,z" -> { facing: 0..3, open: boolean }
    this.ladderStates = new Map(); // "x,y,z" -> facing (0=-Z wall, 1=+X wall, 2=+Z wall, 3=-X wall)
    this.villageChunks = new Map(); // numeric chunkKey -> { x, y, z, biome, spawned: bool }
    this.persistentLeaves = new Set(); // "x,y,z" of player-placed leaves that should not decay
    this.leafDecayQueue = new Map(); // "x,y,z" -> { x, y, z, timer }
    this._leafAmbientTimer = 0;
    this.onLeafDecay = null;

    // Live Fire spread & Minecraft-accurate Water/Lava fluid simulation!
    this.activeFires = new Map(); // "x,y,z" -> { x, y, z, age, timer }
    this.fluidLevels = new Map(); // "x,y,z" -> level (0=source, 1..7 water, 1..3 lava)
    this.fluidQueue = new Map();  // "x,y,z" -> { x, y, z, type, timer }
    this.activeCrops = new Map(); // "x,y,z" -> { x, y, z, timer }
    this.activeFarmlands = new Map(); // "x,y,z" -> { x, y, z, timer, dryAge }
    this.onFluidMix = null;       // optional callback (x, y, z, newBlockId)
    this.onFireIgniteTnt = null;  // optional callback (x, y, z)
    this.megaStructures = new Map(); // numeric key -> { type, x, y, z, radius, villagersSpawned }
    this._roadRegionCache = new Map(); // "rgx,rgz" -> Array<{ ax, az, bx, bz, bend, minX, maxX, minZ, maxZ }>
    this._megaChunkCache = new Map();  // chunkKey -> mega info | null (eliminates repeated noise lookups!)
    this._villageChunkCache = new Map(); // chunkKey -> village info | null
    this._lastChunkPcx = 1e9;
    this._lastChunkPcz = 1e9;
    this._lastChunkRD = -1;
    this._chunksAllLoaded = false;
    this.renderDistance = options.renderDistance || 6;
    const rawMode = options.shaders || 'ultra';
    this.shaderMode = rawMode === 'off' ? 'low' : (rawMode === 'enhanced' ? 'medium' : rawMode);

    // 1x1 white fallback texture for shadow samplers before first shadow render
    const dummyShadowData = new Uint8Array([255, 255, 255, 255]);
    this._dummyShadowTex = new THREE.DataTexture(dummyShadowData, 1, 1, THREE.RGBAFormat);
    this._dummyShadowTex.needsUpdate = true;

    this._dynLightPos = Array.from({ length: 8 }, () => new THREE.Vector4(0, -9999, 0, 1));
    this._dynLightCol = Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 0));

    this.shaderUniforms = {
      uAtlas: { value: this.textures.atlasTexture },
      uNormalAtlas: { value: this.textures.normalTexture || this.textures.atlasTexture },
      uPbrAtlas: { value: this.textures.pbrTexture || this.textures.atlasTexture },
      uPbrOn: { value: this.shaderMode === 'low' ? 0.0 : 1.0 },
      uWetness: { value: 0.0 },
      uTime: { value: 0 },
      uCloudTime: { value: 0 },
      uWaveStrength: { value: this.shaderMode === 'low' ? 0.0 : (this.shaderMode === 'ultra' ? 1.15 : 0.9) },
      uShaderOn: { value: this.shaderMode === 'low' ? 0.0 : 1.0 },
      uSunDir: { value: new THREE.Vector3(0.6, 0.5, -0.25).normalize() },
      uMoonDir: { value: new THREE.Vector3(-0.6, -0.5, 0.25).normalize() },
      uShadowDir: { value: new THREE.Vector3(0.6, 0.5, -0.25).normalize() },
      uTopColor: { value: new THREE.Color(0x245ec2) },
      uMidColor: { value: new THREE.Color(0x63a8ed) },
      uHorizonColor: { value: new THREE.Color(0xd4e8fa) },
      uSunsetColor: { value: new THREE.Color(0xff9b54) },
      uSunColor: { value: new THREE.Color(0xfff6dc) },
      uSunLightColor: { value: new THREE.Color(0xfff4dc) },
      uSunLightIntensity: { value: 1.35 },
      uHemiSkyColor: { value: new THREE.Color(0xcbe8ff) },
      uHemiGroundColor: { value: new THREE.Color(0x88997e) },
      uHemiIntensity: { value: 0.95 },
      uFillColor: { value: new THREE.Color(0x88b4ff) },
      uFillIntensity: { value: 0.26 },
      uCloudLitColor: { value: new THREE.Color(0xfffcf5) },
      uCloudShadowColor: { value: new THREE.Color(0x88a4c7) },
      uDayFactor: { value: 1.0 },
      uSunsetFactor: { value: 0.0 },
      uRainFactor: { value: 0.0 },
      uFogNear: { value: 45.0 },
      uFogFar: { value: 110.0 },
      uShadowMap0: { value: this._dummyShadowTex },
      uShadowMap1: { value: this._dummyShadowTex },
      uShadowMatrix0: { value: new THREE.Matrix4() },
      uShadowMatrix1: { value: new THREE.Matrix4() },
      uShadowTexel0: { value: 1 / 2048 },
      uShadowTexel1: { value: 1 / 1024 },
      uShadowsOn: { value: this.shaderMode === 'low' ? 0.0 : 1.0 },
      uHasFarCascade: { value: (this.shaderMode === 'high' || this.shaderMode === 'ultra') ? 1.0 : 0.0 },
      uShadowSoftness: { value: this.shaderMode === 'ultra' ? 1.55 : (this.shaderMode === 'high' ? 1.3 : 1.05) },
      uDynLightPos: { value: this._dynLightPos },
      uDynLightCol: { value: this._dynLightCol },
      uLodInnerCenter: { value: new THREE.Vector2(0, 0) },
      uLodInnerRadiusSq: { value: 0.0 },
      uLodBlendInner: { value: 0.0 },
      uLodBlendOuter: { value: 14.0 }
    };

    // Shared Alpha-Tested Depth Material so tree canopies, leaves, fences, doors & glass frames cast authentic shadows!
    this.cutoutDepthMat = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: this.textures.atlasTexture,
      alphaTest: 0.35,
      side: THREE.DoubleSide
    });

    // Shared RTX-Quality 2-Cascade CSM Soft Shadow + Natural Sky/Sun Lighting GLSL Chunk
    const CSM_LIGHTING_GLSL = `
      #include <packing>
      uniform sampler2D uAtlas;
      uniform sampler2D uNormalAtlas;
      uniform sampler2D uPbrAtlas;
      uniform float uPbrOn;
      uniform float uWetness;
      uniform sampler2D uShadowMap0;
      uniform sampler2D uShadowMap1;
      uniform mat4 uShadowMatrix0;
      uniform mat4 uShadowMatrix1;
      uniform float uShadowTexel0;
      uniform float uShadowTexel1;
      uniform float uShadowsOn;
      uniform float uHasFarCascade;
      uniform float uShadowSoftness;
      uniform float uTime;
      uniform float uShaderOn;
      uniform vec3 uSunDir;
      uniform vec3 uMoonDir;
      uniform vec3 uShadowDir;
      uniform vec3 uSunColor;
      uniform vec3 uSunLightColor;
      uniform float uSunLightIntensity;
      uniform vec3 uHemiSkyColor;
      uniform vec3 uHemiGroundColor;
      uniform float uHemiIntensity;
      uniform vec3 uFillColor;
      uniform float uFillIntensity;
      uniform vec3 uTopColor;
      uniform vec3 uMidColor;
      uniform vec3 uHorizonColor;
      uniform vec3 uSunsetColor;
      uniform float uDayFactor;
      uniform float uSunsetFactor;
      uniform float uFogNear;
      uniform float uFogFar;
      uniform vec4 uDynLightPos[8];
      uniform vec4 uDynLightCol[8];

      // Cook-Torrance GGX PBR Microfacet BRDF (Metallic Iron/Gold, Crystalline Diamond/Ores, Bevelled Stone Bricks!)
      float D_GGX(float NoH, float rough) {
        float a = rough * rough;
        float a2 = a * a;
        float d = (NoH * NoH) * (a2 - 1.0) + 1.0;
        return a2 / max(3.14159265 * d * d, 0.0005);
      }
      float G_SchlickGGX(float NoV, float NoL, float rough) {
        float k = (rough + 1.0);
        k = (k * k) * 0.125;
        float gv = NoV / (NoV * (1.0 - k) + k);
        float gl = NoL / (NoL * (1.0 - k) + k);
        return gv * gl;
      }
      vec3 F_Schlick(float HoV, vec3 F0) {
        float om = clamp(1.0 - HoV, 0.0, 1.0);
        float om2 = om * om;
        return F0 + (1.0 - F0) * (om2 * om2 * om);
      }

      // Compute analytic tangent-space normal perturbation from LabPBR normalAtlas (ZERO extra vertex attributes!)
      vec3 perturbVoxelNormal(vec3 geomN, vec2 atlasUv, float dist) {
        float normalFade = 1.0 - smoothstep(26.0, 68.0, dist);
        if (uPbrOn < 0.5 || normalFade < 0.01) return geomN;
        vec3 mapN = texture2D(uNormalAtlas, atlasUv).xyz * 2.0 - 1.0;
        mapN.xy *= normalFade * 0.92;
        vec3 T = abs(geomN.y) > 0.5
          ? vec3(1.0, 0.0, 0.0)
          : (abs(geomN.x) > 0.5 ? vec3(0.0, 0.0, -sign(geomN.x)) : vec3(sign(geomN.z), 0.0, 0.0));
        vec3 B = normalize(cross(geomN, T));
        return normalize(T * mapN.x + B * mapN.y + geomN * max(0.2, mapN.z));
      }

      // Procedural Sky-Dome Environment Reflection for Metals, Glass, Ice, Wet Stone & Glossed Bricks!
      vec3 sampleEnvIBL(vec3 R, float rough, float skyVis) {
        float rY = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 skyEnv = mix(uHemiGroundColor * 0.75, uHorizonColor, smoothstep(0.32, 0.54, rY));
        skyEnv = mix(skyEnv, uMidColor, smoothstep(0.54, 0.78, rY));
        skyEnv = mix(skyEnv, uTopColor, smoothstep(0.76, 1.0, rY));
        // Roughness-blur approximation mixes toward hemisphere average
        vec3 diffEnv = mix(uHemiGroundColor, uHemiSkyColor, rY) * uHemiIntensity * 0.65;
        vec3 env = mix(skyEnv, diffEnv, rough * rough);
        return env * (skyVis * skyVis * 0.92 + 0.06);
      }

      float csmIgn(vec2 p) {
        return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
      }

      float samplePoissonShadow(sampler2D sMap, vec3 sc, float texelSize, float spread, float bias) {
        if (sc.z >= 1.0 || sc.z <= 0.0) return 1.0;
        float ang = csmIgn(gl_FragCoord.xy) * 6.2831853;
        float ca = cos(ang), sa = sin(ang);
        mat2 rot = mat2(ca, -sa, sa, ca);
        float r = texelSize * spread;
        float cmpZ = sc.z - bias;
        float lit = 0.0;
        // 8-tap rotated Poisson disk (velvety soft penumbra, zero grid banding!)
        lit += step(cmpZ, unpackRGBAToDepth(texture2D(sMap, sc.xy + (rot * vec2(-0.613,  0.617)) * r)));
        lit += step(cmpZ, unpackRGBAToDepth(texture2D(sMap, sc.xy + (rot * vec2( 0.170, -0.040)) * r)));
        lit += step(cmpZ, unpackRGBAToDepth(texture2D(sMap, sc.xy + (rot * vec2(-0.299, -0.791)) * r)));
        lit += step(cmpZ, unpackRGBAToDepth(texture2D(sMap, sc.xy + (rot * vec2( 0.645,  0.532)) * r)));
        lit += step(cmpZ, unpackRGBAToDepth(texture2D(sMap, sc.xy + (rot * vec2(-0.921, -0.152)) * r)));
        lit += step(cmpZ, unpackRGBAToDepth(texture2D(sMap, sc.xy + (rot * vec2( 0.892, -0.341)) * r)));
        lit += step(cmpZ, unpackRGBAToDepth(texture2D(sMap, sc.xy + (rot * vec2(-0.118,  0.945)) * r)));
        lit += step(cmpZ, unpackRGBAToDepth(texture2D(sMap, sc.xy + (rot * vec2( 0.356, -0.822)) * r)));
        return lit * 0.125;
      }

      float computeCSMShadow(vec3 worldPos, vec3 N, bool isFoliage) {
        if (uShadowsOn < 0.5) return 1.0;
        vec3 Ls = normalize(uShadowDir);
        float ndl = dot(N, Ls);
        float slope = clamp(1.0 - max(0.0, ndl), 0.0, 1.0);
        // Slope-scaled world-normal offset eliminates shadow acne & Peter-Panning on voxel edges!
        vec3 offNear = isFoliage ? (Ls * 0.07) : (N * (0.042 + 0.088 * slope) + Ls * 0.022);
        vec4 p0 = uShadowMatrix0 * vec4(worldPos + offNear, 1.0);
        vec3 sc0 = p0.xyz / p0.w;
        float edge0 = max(abs(sc0.x - 0.5), abs(sc0.y - 0.5));
        bool inNear = edge0 < 0.495 && sc0.z > 0.0 && sc0.z < 1.0;

        float sNear = inNear
          ? samplePoissonShadow(uShadowMap0, sc0, uShadowTexel0, uShadowSoftness * 1.35, 0.00055 + 0.0008 * slope)
          : 1.0;

        if (uHasFarCascade < 0.5) {
          float fadeOut = smoothstep(0.40, 0.495, edge0);
          return mix(sNear, 1.0, fadeOut);
        }

        // Smooth feather blend between Cascade 0 (Near ±26m) and Cascade 1 (Far ±92m)
        float blendFar = smoothstep(0.37, 0.49, edge0);
        if (blendFar < 0.005) return sNear;

        vec3 offFar = isFoliage ? (Ls * 0.14) : (N * (0.12 + 0.20 * slope) + Ls * 0.05);
        vec4 p1 = uShadowMatrix1 * vec4(worldPos + offFar, 1.0);
        vec3 sc1 = p1.xyz / p1.w;
        float edge1 = max(abs(sc1.x - 0.5), abs(sc1.y - 0.5));
        float sFar = (edge1 < 0.495 && sc1.z > 0.0 && sc1.z < 1.0)
          ? samplePoissonShadow(uShadowMap1, sc1, uShadowTexel1, uShadowSoftness * 1.15, 0.0011 + 0.0014 * slope)
          : 1.0;
        sFar = mix(sFar, 1.0, smoothstep(0.42, 0.495, edge1));
        return mix(sNear, sFar, blendFar);
      }

      vec3 computeDynamicPointLights(vec3 worldPos, vec3 N) {
        // Lightweight 3-light hero flicker accent (Voxel GI handles wall-occluded colored radiance for ALL lights!)
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 3; i++) {
          float inten = uDynLightCol[i].w;
          if (inten <= 0.001) continue;
          vec3 toL = uDynLightPos[i].xyz - worldPos;
          float d2 = dot(toL, toL);
          float maxR = uDynLightPos[i].w;
          if (d2 >= maxR * maxR) continue;
          float d = sqrt(d2);
          float fall = clamp(1.0 - d / maxR, 0.0, 1.0);
          float atten = (fall * fall) / (1.0 + d2 * 0.14);
          float ndl = max(0.15, dot(N, toL / max(d, 0.001)));
          acc += uDynLightCol[i].rgb * (inten * atten * ndl * 0.08);
        }
        return acc;
      }
    `;

    // 1. Opaque Terrain Material — Greedy Atlas Tiling + 2-Cascade CSM + 3D Voxel Global Illumination (Colored Emissives & 1-Bounce Color Bleed)!
    this.opaqueMat = new THREE.ShaderMaterial({
      uniforms: this.shaderUniforms,
      vertexShader: `
        attribute vec4 aTile;
        attribute vec3 color;
        attribute vec3 aBlockLight;
        attribute vec3 aBounceLight;
        varying vec4 vTile;
        varying vec2 vLocalUv;
        varying vec3 vWorldPos;
        varying vec3 vWorldNorm;
        varying vec3 vColor;
        varying vec3 vBlockLight;
        varying vec3 vBounceLight;
        void main() {
          vWorldPos = position;
          vWorldNorm = normal;
          vLocalUv = uv;
          vTile = aTile;
          vColor = color;
          vBlockLight = aBlockLight;
          vBounceLight = aBounceLight;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        ${CSM_LIGHTING_GLSL}
        varying vec4 vTile;
        varying vec2 vLocalUv;
        varying vec3 vWorldPos;
        varying vec3 vWorldNorm;
        varying vec3 vColor;
        varying vec3 vBlockLight;
        varying vec3 vBounceLight;

        void main() {
          vec2 wrappedUv = vTile.z < 0.99
            ? (vTile.xy + clamp(fract(vLocalUv), 0.004, 0.996) * vTile.zw)
            : vLocalUv;
          vec4 tex = texture2D(uAtlas, wrappedUv);
          vec3 albedo = tex.rgb;
          vec3 geomN = normalize(vWorldNorm);
          vec3 L = normalize(uSunDir);
          vec3 M = normalize(uMoonDir);
          vec3 activeL = uDayFactor > 0.08 ? L : M;
          vec3 viewVec = vWorldPos - cameraPosition;
          float dist = length(viewVec);
          vec3 viewDir = viewVec / max(dist, 0.001);
          vec3 V = -viewDir;

          // Unpack 3D Voxel GI Channels
          float ao = clamp(vColor.r, 0.25, 1.15);
          float skyVis = clamp(vColor.g, 0.0, 1.0);
          float vEmit = clamp(vColor.b, 0.0, 1.0);
          float outdoorMask = smoothstep(0.05, 0.45, skyVis);

          // Sample LabPBR Material Atlas (Roughness, Metalness, Reflectivity F0, Per-Texel Emission) + Tangent Normal Map!
          vec4 pbr = uPbrOn > 0.5 ? texture2D(uPbrAtlas, wrappedUv) : vec4(0.88, 0.0, 0.04, 0.0);
          float roughness = clamp(pbr.r, 0.06, 0.98);
          float metalness = pbr.g;
          float f0Scalar = clamp(pbr.b, 0.02, 0.95);
          float emissive = max(vEmit * max(0.35, pbr.a), pbr.a * step(0.45, pbr.a));
          vec3 N = perturbVoxelNormal(geomN, wrappedUv, dist);

          // Dynamic Weather Rain Wetness & Puddles on outdoor top faces!
          if (uPbrOn > 0.5 && uWetness > 0.01 && skyVis > 0.65) {
            float pWave = sin(vWorldPos.x * 0.45) * cos(vWorldPos.z * 0.45) + sin((vWorldPos.x + vWorldPos.z) * 0.9) * 0.5;
            float puddle = smoothstep(-0.15, 0.65, pWave) * smoothstep(0.5, 0.95, geomN.y);
            float wetAmt = uWetness * (0.45 + 0.55 * puddle) * smoothstep(0.65, 0.95, skyVis);
            roughness = mix(roughness, 0.12, wetAmt * 0.85);
            f0Scalar = mix(f0Scalar, 0.16, wetAmt * 0.5);
            albedo *= (1.0 - 0.18 * wetAmt * (1.0 - metalness));
            if (puddle > 0.35) N = normalize(mix(N, geomN, puddle * uWetness * 0.72));
          }

          // 2-Cascade Rotated Poisson PCF Shadow (using geometric normal for acne-free bias, occluded in caves by skyVis!)
          float shadow = computeCSMShadow(vWorldPos, geomN, false) * smoothstep(0.08, 0.55, skyVis);
          float ndl = max(0.0, dot(N, activeL));
          float directTerm = ndl * shadow;

          vec3 hemi = mix(uHemiGroundColor, uHemiSkyColor, N.y * 0.5 + 0.5) * uHemiIntensity;
          float fillNdl = max(0.0, dot(N, normalize(vec3(-activeL.x, 0.55, -activeL.z))));
          vec3 fill = uFillColor * (uFillIntensity * (0.35 + 0.65 * fillNdl));

          // Physically-Based Diffuse vs Metallic Energy Conservation
          vec3 F0 = mix(vec3(f0Scalar), albedo, metalness);
          vec3 diffAlbedo = albedo * (1.0 - metalness * 0.82);

          vec3 directLight = uSunLightColor * (uSunLightIntensity * directTerm * 0.96);
          vec3 skyIndirect = (hemi * 0.72 + fill * 0.45) * (skyVis * skyVis * 0.88 + 0.045) * ao;
          vec3 bounceGI = vBounceLight * uSunColor * (0.52 * uDayFactor * (0.35 + 0.65 * (1.0 - directTerm * 0.5))) * ao;
          vec3 blockGI = (vBlockLight * vBlockLight * 2.28 + vBlockLight * 0.24) * mix(0.65, 1.0, ao);
          vec3 localFlicker = computeDynamicPointLights(vWorldPos, N);

          vec3 lit = diffAlbedo * (directLight * mix(0.55, 1.0, ao) + skyIndirect + bounceGI + blockGI + localFlicker);

          if (uShaderOn > 0.5) {
            float litFactor = clamp(directTerm * uDayFactor, 0.0, 1.0);
            vec3 warmSunTint = mix(vec3(1.07, 1.03, 0.95), vec3(1.26, 1.00, 0.78), uSunsetFactor);
            vec3 coolShadowTint = mix(vec3(0.86, 0.92, 1.08), vec3(0.92, 0.96, 1.06), uDayFactor);
            float blkStrength = clamp(dot(vBlockLight, vec3(0.4, 0.4, 0.4)), 0.0, 1.0);
            lit *= mix(mix(coolShadowTint, warmSunTint, litFactor), vec3(1.0), blkStrength * 0.75);

            // Subtle Outdoor Sky Bounce Lift
            lit += diffAlbedo * uHorizonColor * (0.042 * uDayFactor * outdoorMask * (1.0 - litFactor * 0.65) * ao * skyVis);

            // Cool Sapphire Moonlight Silhouette Rim at Night
            float nightAmt = clamp(1.0 - uDayFactor * 1.5, 0.0, 1.0) * outdoorMask;
            if (nightAmt > 0.01) {
              float moonLit = smoothstep(-0.15, 0.65, dot(N, M)) * (0.30 + 0.70 * shadow);
              float rimN = pow(1.0 - max(0.0, dot(N, V)), 2.8);
              lit += diffAlbedo * vec3(0.18, 0.36, 0.72) * (moonLit * 0.38 + rimN * 0.24) * nightAmt;
            }

            // Cook-Torrance GGX Direct Specular + Sky IBL Reflection + Colored GI Specular Sheen (Image 2!)
            if (uPbrOn > 0.5) {
              float NoV = max(0.001, dot(N, V));
              float NoL = max(0.0, dot(N, activeL));
              vec3 H = normalize(V + activeL);
              float NoH = max(0.0, dot(N, H));
              float HoV = max(0.0, dot(H, V));

              if (NoL > 0.001 && shadow > 0.005) {
                float D = D_GGX(NoH, roughness);
                float G = G_SchlickGGX(NoV, NoL, roughness);
                vec3 F = F_Schlick(HoV, F0);
                vec3 specBRDF = (D * G * F) / max(4.0 * NoV * NoL, 0.004);
                float specFade = 1.0 - smoothstep(55.0, 175.0, dist) * 0.65;
                lit += min(specBRDF * uSunLightColor * (uSunLightIntensity * NoL * shadow * 0.65), vec3(4.0)) * specFade;
              }

              // Environment IBL Reflection (Iron/Gold/Diamond metallic gleam + wet stone/brick Fresnel!)
              vec3 R = reflect(-V, N);
              vec3 envCol = sampleEnvIBL(R, roughness, skyVis);
              vec3 F_env = F_Schlick(NoV, F0) * (1.0 - roughness * 0.72);
              lit += envCol * F_env * ao * (0.45 + 0.75 * metalness);

              // Colored Voxel GI Specular Reflection across bevelled stone bricks & metals (Image 2 glowstone/diamond/lava sheen!)
              float smoothSpec = pow(1.0 - roughness, 2.2) * (0.28 + 0.72 * pow(1.0 - NoV, 2.4));
              lit += (vBlockLight * vBlockLight) * mix(vec3(1.0), albedo, metalness) * smoothSpec * 1.15 * ao;
            }

            // Shimmering Underwater Caustics on Submerged Riverbeds & Ocean Floors
            if (vWorldPos.y < ${SEA_LEVEL}.05 && geomN.y > 0.25 && uDayFactor > 0.05) {
              float dSub = ${SEA_LEVEL}.05 - vWorldPos.y;
              float depthFade = smoothstep(0.0, 1.8, dSub) * smoothstep(20.0, 2.0, dSub);
              float c1 = sin(vWorldPos.x * 2.1 + uTime * 2.0 + vWorldPos.z * 0.9);
              float c2 = cos(vWorldPos.z * 2.3 - uTime * 1.8 - vWorldPos.x * 0.8);
              float cSum = max(0.0, (c1 + c2) * 0.5);
              lit += vec3(0.22, 0.50, 0.56) * (cSum * cSum * cSum) * depthFade * uDayFactor * (0.35 + 0.65 * shadow) * 0.78;
            }

            // Colored HDR Self-Emissive Radiance (Gold Glowstone, Molten Lava, Cyan Diamond, Warm Torch!)
            if (emissive > 0.01) {
              lit += (albedo * 1.45 + vBlockLight * 2.35) * emissive;
            }

            // Low-Altitude Atmospheric Valley Mist + Volumetric Sun-Aligned Haze
            float sa = max(0.0, dot(viewDir, L));
            float sunAlign = sa * sa * sa;
            float valleyH = exp(-max(0.0, vWorldPos.y - ${SEA_LEVEL - 2}.0) * 0.052);
            float valleyMist = valleyH * smoothstep(24.0, 145.0, dist) * outdoorMask * mix(0.38, 0.48, uSunsetFactor) * (1.0 - smoothstep(180.0, 320.0, dist) * 0.35);
            vec3 mistDay = mix(uHorizonColor * 1.04, uSunColor * 1.24, sunAlign * (0.42 + 0.58 * uSunsetFactor));
            vec3 mistNight = vec3(0.11, 0.28, 0.58);
            vec3 mistCol = mix(mistNight, mistDay, uDayFactor);
            mistCol = mix(mistCol, uSunsetColor * 1.15, sunAlign * uSunsetFactor * 0.45);
            lit = mix(lit, mistCol, clamp(valleyMist, 0.0, 0.58));

            float hazeFactor = smoothstep(uFogNear * 0.44, uFogFar, dist) * outdoorMask;
            vec3 atmFog = mix(uHorizonColor, uSunColor * 1.15, sunAlign * (0.36 + 0.62 * uSunsetFactor) * uDayFactor);
            atmFog = mix(atmFog, uSunsetColor * 1.08, sunAlign * uSunsetFactor * 0.48);
            lit = mix(lit, atmFog, hazeFactor);
          } else {
            if (emissive > 0.01) {
              lit += (albedo * 1.1 + vBlockLight * 1.8) * emissive;
            }
            float fogF = smoothstep(uFogNear, uFogFar, dist);
            lit = mix(lit, uHorizonColor, fogF);
          }

          gl_FragColor = vec4(lit, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });

    // 1b. Distant Horizons 512-Chunk High-Detail LOD Terrain Materials
    // Dual-material iPad/Apple TBDR optimization:
    // - `this.lodMat` (with circular cutout discard) ONLY on innermost ring tiles overlapping full-detail chunks (~24 meshes)
    // - `this.lodMatOuter` (ZERO `discard`!) on 90%+ of outer LOD tiles -> keeps hardware Early-Z / Apple HSR enabled!
    const buildLodMat = (withInnerCutout) => {
      const mat = new THREE.MeshLambertMaterial({
        vertexColors: true,
        polygonOffset: withInnerCutout,
        polygonOffsetFactor: withInnerCutout ? 2 : 0,
        polygonOffsetUnits: withInnerCutout ? 2 : 0
      });
      mat.customProgramCacheKey = () => (withInnerCutout ? 'lod_inner_v29' : 'lod_outer_v29');
      mat.onBeforeCompile = (shader) => {
        const uniforms = {
          uTime: this.shaderUniforms.uTime,
          uWaveStrength: this.shaderUniforms.uWaveStrength,
          uShaderOn: this.shaderUniforms.uShaderOn,
          uSunDir: this.shaderUniforms.uSunDir,
          uSunColor: this.shaderUniforms.uSunColor,
          uTopColor: this.shaderUniforms.uTopColor,
          uMidColor: this.shaderUniforms.uMidColor,
          uHorizonColor: this.shaderUniforms.uHorizonColor,
          uSunsetColor: this.shaderUniforms.uSunsetColor,
          uDayFactor: this.shaderUniforms.uDayFactor,
          uSunsetFactor: this.shaderUniforms.uSunsetFactor,
          uRainFactor: this.shaderUniforms.uRainFactor,
          uFogNear: this.shaderUniforms.uFogNear,
          uFogFar: this.shaderUniforms.uFogFar
        };
        if (withInnerCutout) {
          uniforms.uLodInnerCenter = this.shaderUniforms.uLodInnerCenter;
          uniforms.uLodBlendInner = this.shaderUniforms.uLodBlendInner;
          uniforms.uLodBlendOuter = this.shaderUniforms.uLodBlendOuter;
        }
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = `
          attribute float aMat;
          varying vec3 vWorldPos;
          varying vec3 vWorldNorm;
          varying float vMat;
        ` + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
           vWorldNorm = normal;
           vMat = aMat;`
        );
        shader.fragmentShader = `
          uniform float uTime;
          uniform float uWaveStrength;
          uniform float uShaderOn;
          uniform vec3 uSunDir;
          uniform vec3 uSunColor;
          uniform vec3 uTopColor;
          uniform vec3 uMidColor;
          uniform vec3 uHorizonColor;
          uniform vec3 uSunsetColor;
          uniform float uDayFactor;
          uniform float uSunsetFactor;
          uniform float uRainFactor;
          uniform float uFogNear;
          uniform float uFogFar;
          ${withInnerCutout ? 'uniform vec2 uLodInnerCenter;\nuniform float uLodBlendInner;\nuniform float uLodBlendOuter;' : ''}
          varying vec3 vWorldPos;
          varying vec3 vWorldNorm;
          varying float vMat;
        ` + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <fog_fragment>',
          `${withInnerCutout ? `vec2 lodDelta = vWorldPos.xz - uLodInnerCenter;
           float lodDistXZ = length(lodDelta);
           if (lodDistXZ < uLodBlendInner) discard;
           if (lodDistXZ < uLodBlendOuter) {
             float fadeT = (lodDistXZ - uLodBlendInner) / max(0.001, uLodBlendOuter - uLodBlendInner);
             float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
             if (fadeT < ign) discard;
           }` : ''}

           vec3 viewVec = vWorldPos - cameraPosition;
           float dist = length(viewVec);
           vec3 viewDir = viewVec / max(dist, 0.001);
           vec3 N = normalize(vWorldNorm);
           vec3 L = normalize(uSunDir);

           // Crisp 1-block (1m) + 0.25m sub-voxel procedural Minecraft detail & rock strata (early-exits beyond 920m!)
           float detailFade = 1.0 - smoothstep(180.0, 920.0, dist);
           if (detailFade > 0.01 && (vMat < 0.15 || vMat > 0.37)) {
             vec3 sampleP = vWorldPos - N * 0.05;
             vec3 bCoord = floor(sampleP);
             vec3 h3 = fract(bCoord * vec3(0.1031, 0.1030, 0.0973));
             h3 += dot(h3, h3.yzx + 33.33);
             float blockRand = fract((h3.x + h3.y) * h3.z);

             // Sub-block 4x4 texel pixel grain on near-mid LODs (< 340m) so LODs match textured voxel chunks!
             float texelFade = 1.0 - smoothstep(110.0, 340.0, dist);
             float texelRand = 0.5;
             if (texelFade > 0.01) {
               vec3 tCoord = floor(sampleP * 4.0);
               vec3 th = fract(tCoord * vec3(0.1031, 0.1030, 0.0973));
               th += dot(th, th.yzx + 19.19);
               texelRand = fract((th.x + th.y) * th.z);
             }
             float grain = (blockRand - 0.5) * 0.14 * detailFade + (texelRand - 0.5) * 0.12 * texelFade;

             if (vMat > 0.85) {
               float strata = sin(vWorldPos.y * 1.45 + blockRand * 1.5) * 0.09;
               gl_FragColor.rgb *= (0.94 + blockRand * 0.14 + strata + (texelRand - 0.5) * 0.14 * texelFade) * detailFade + (1.0 - detailFade);
             } else if (vMat > 0.37 && vMat < 0.62) {
               gl_FragColor.rgb *= 1.0 + (blockRand - 0.5) * 0.22 * detailFade + (texelRand - 0.5) * 0.18 * texelFade;
             } else if (vMat > 0.62) {
               gl_FragColor.rgb *= 1.0 + (blockRand - 0.5) * 0.06 * detailFade + (texelRand - 0.5) * 0.05 * texelFade;
             } else {
               gl_FragColor.rgb *= 1.0 + grain;
               if (abs(N.y) < 0.5) {
                 float strataSoil = 0.93 + 0.11 * fract(vWorldPos.y * 0.5);
                 gl_FragColor.rgb *= mix(1.0, strataSoil, detailFade);
               }
             }
           }

           if (uShaderOn > 0.5) {
             bool isWater = (vMat > 0.15 && vMat < 0.37);
             if (isWater && N.y > 0.5) {
               // Live BSL Reflective Sky-Mirror Water (fast analytic path beyond 1.4km for 512-chunk iPad speed!)
               vec3 V = -viewDir;
               vec3 wN = vec3(0.0, 1.0, 0.0);
               float rippleMul = 0.78;
               bool nearWater = dist < 1400.0;
               if (nearWater) {
                 vec2 wp = vWorldPos.xz;
                 float wt = uTime;
                 float wA = sin(wp.x * 1.35 + wt * 1.7 + wp.y * 0.65);
                 float wB = cos(wp.y * 1.55 - wt * 1.4 - wp.x * 0.55);
                 float wAmp = mix(0.015, 0.078, clamp(uWaveStrength, 0.0, 1.2)) * (1.0 - smoothstep(120.0, 1350.0, dist) * 0.85);
                 wN = normalize(vec3(wA * wAmp, 1.0, wB * wAmp));
                 rippleMul = 0.76 + 0.14 * wA * wB * uDayFactor;
               }

               float NoV = max(0.0, dot(wN, V));
               float omv = 1.0 - NoV;
               float fresnel = clamp(0.14 + 0.82 * omv * omv * omv, 0.14, 0.94);

               vec3 R = reflect(-V, wN);
               float rY = clamp(abs(R.y), 0.02, 1.0);
               vec3 reflCol = mix(uHorizonColor, uMidColor, smoothstep(0.0, 0.38, rY));
               reflCol = mix(reflCol, uTopColor, smoothstep(0.28, 0.92, rY));
               float rSun = max(0.0, dot(normalize(R), L));
               float rSun2 = rSun * rSun;
               float rSun4 = rSun2 * rSun2;
               reflCol = mix(reflCol, uSunsetColor, (1.0 - rY) * (0.28 + 0.52 * rSun2) * uSunsetFactor * (1.0 - uRainFactor * 0.7));
               reflCol += uSunColor * (rSun4 * rSun4 * 0.42) * smoothstep(-0.1, 0.06, L.y) * (1.0 - uRainFactor * 0.8);

               gl_FragColor.rgb = mix(gl_FragColor.rgb * rippleMul, reflCol, fresnel);

               if (nearWater) {
                 vec3 H = normalize(V + L);
                 float nh = max(0.0, dot(wN, H));
                 float nh2 = nh * nh;
                 float nh4 = nh2 * nh2;
                 float nh16 = nh4 * nh4 * nh4 * nh4;
                 float nh64 = nh16 * nh16 * nh16 * nh16;
                 float sunUp = smoothstep(-0.08, 0.08, L.y) * (1.0 - uRainFactor * 0.85);
                 gl_FragColor.rgb += uSunColor * (nh64 * 1.9 + nh16 * 0.28) * sunUp;
               }
             } else {
               float sunLit = smoothstep(-0.22, 0.58, dot(N, L));
               vec3 warmSunTint = mix(vec3(1.10, 1.04, 0.94), vec3(1.34, 1.02, 0.78), uSunsetFactor);
               vec3 coolShadowTint = mix(vec3(0.84, 0.91, 1.09), vec3(0.92, 0.98, 1.10), uDayFactor);
               gl_FragColor.rgb *= mix(coolShadowTint, warmSunTint, sunLit * uDayFactor);
               gl_FragColor.rgb += uHorizonColor * 0.042 * uDayFactor * (1.0 - sunLit * 0.65);

               if (vMat > 0.37 && vMat < 0.62) {
                 float saF = max(0.0, dot(viewDir, L));
                 float sss = (saF * saF * saF) * 0.32 * uDayFactor;
                 gl_FragColor.rgb += gl_FragColor.rgb * uSunColor * sss;
               } else if (vMat > 0.62 && vMat < 0.85) {
                 vec3 H = normalize(-viewDir + L);
                 float nh = max(0.0, dot(N, H));
                 float nh2 = nh * nh;
                 float nh8 = nh2 * nh2 * nh2 * nh2;
                 gl_FragColor.rgb += uSunColor * (nh8 * 0.24 * sunLit * uDayFactor);
               }
             }

             // Matching Low-Altitude Valley Mist + Volumetric Sun-Aligned Horizon Haze out to 1024 chunks!
             float sa = max(0.0, dot(viewDir, L));
             float sunAlign = sa * sa * sa;
             float valleyH = exp(-max(0.0, vWorldPos.y - ${SEA_LEVEL - 2}.0) * 0.052);
             float valleyMist = valleyH * smoothstep(24.0, 145.0, dist) * mix(0.42, 0.52, uSunsetFactor) * (1.0 - smoothstep(180.0, 420.0, dist) * 0.30);
             vec3 mistDay = mix(uHorizonColor * 1.04, uSunColor * 1.24, sunAlign * (0.42 + 0.58 * uSunsetFactor));
             vec3 mistNight = vec3(0.11, 0.28, 0.58);
             vec3 mistCol = mix(mistNight, mistDay, uDayFactor);
             mistCol = mix(mistCol, uSunsetColor * 1.15, sunAlign * uSunsetFactor * 0.45);
             gl_FragColor.rgb = mix(gl_FragColor.rgb, mistCol, clamp(valleyMist, 0.0, 0.62));

             float hazeFactor = smoothstep(uFogNear * 0.44, uFogFar, dist);
             vec3 atmFog = mix(uHorizonColor, uSunColor * 1.15, sunAlign * (0.36 + 0.62 * uSunsetFactor) * uDayFactor);
             atmFog = mix(atmFog, uSunsetColor * 1.08, sunAlign * uSunsetFactor * 0.48);
             gl_FragColor.rgb = mix(gl_FragColor.rgb, atmFog, hazeFactor);
           } else {
             #include <fog_fragment>
           }`
        );
      };
      return mat;
    };
    this.lodMat = buildLodMat(true);
    this.lodMatOuter = buildLodMat(false);

    // 2. Cutout Foliage Material — Root-Anchored Wind Sway + 2-Cascade CSM + 3D Voxel GI + Subsurface Backlighting!
    this.cutoutMat = new THREE.ShaderMaterial({
      uniforms: this.shaderUniforms,
      side: THREE.DoubleSide,
      vertexShader: `
        attribute vec3 color;
        attribute vec3 aBlockLight;
        attribute vec3 aBounceLight;
        uniform float uTime;
        uniform float uWaveStrength;
        varying vec2 vLocalUv;
        varying vec3 vWorldPos;
        varying vec3 vWorldNorm;
        varying vec3 vColor;
        varying vec3 vBlockLight;
        varying vec3 vBounceLight;
        void main() {
          vec3 p = position;
          if (uWaveStrength > 0.01) {
            float fy = fract(p.y + 0.001);
            float swayWeight = (fy > 0.01 && fy < 0.12) ? 0.0 : (fy >= 0.12 ? 1.0 : 0.28);
            float gust = 0.72 + 0.28 * sin(uTime * 0.85 + p.x * 0.12 - p.z * 0.1);
            p.x += sin(uTime * 2.2 + p.x * 0.75 + p.z * 0.55) * 0.055 * uWaveStrength * gust * swayWeight;
            p.z += cos(uTime * 1.85 + p.z * 0.7 - p.x * 0.45) * 0.04 * uWaveStrength * gust * swayWeight;
          }
          vWorldPos = p;
          vWorldNorm = normal;
          vLocalUv = uv;
          vColor = color;
          vBlockLight = aBlockLight;
          vBounceLight = aBounceLight;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        ${CSM_LIGHTING_GLSL}
        varying vec2 vLocalUv;
        varying vec3 vWorldPos;
        varying vec3 vWorldNorm;
        varying vec3 vColor;
        varying vec3 vBlockLight;
        varying vec3 vBounceLight;
        void main() {
          vec4 tex = texture2D(uAtlas, vLocalUv);
          if (tex.a < 0.35) discard;
          vec3 albedo = tex.rgb;
          vec3 N = normalize(gl_FrontFacing ? vWorldNorm : -vWorldNorm);
          vec3 L = normalize(uSunDir);
          vec3 activeL = uDayFactor > 0.08 ? L : normalize(uMoonDir);
          vec3 viewVec = vWorldPos - cameraPosition;
          float dist = length(viewVec);
          vec3 viewDir = viewVec / max(dist, 0.001);
          float ao = clamp(vColor.r, 0.25, 1.15);
          float skyVis = clamp(vColor.g, 0.0, 1.0);
          float emissive = clamp(vColor.b, 0.0, 1.0);

          float shadow = computeCSMShadow(vWorldPos, N, true) * smoothstep(0.06, 0.45, skyVis);
          float ndl = clamp(dot(N, activeL) * 0.65 + 0.35, 0.0, 1.0);
          vec3 hemi = mix(uHemiGroundColor, uHemiSkyColor, 0.68) * uHemiIntensity;
          vec3 directLight = uSunLightColor * (uSunLightIntensity * ndl * (0.20 + 0.80 * shadow) * 0.90);
          vec3 skyIndirect = hemi * (skyVis * skyVis * 0.82 + 0.05) * ao;
          vec3 bounceGI = vBounceLight * uSunColor * (0.45 * uDayFactor) * ao;
          vec3 blockGI = (vBlockLight * vBlockLight * 2.15 + vBlockLight * 0.20) * ao;
          vec3 localFlicker = computeDynamicPointLights(vWorldPos, N);
          vec3 lit = albedo * (directLight * mix(0.55, 1.0, ao) + skyIndirect + bounceGI + blockGI + localFlicker);

          if (uShaderOn > 0.5) {
            float sa = max(0.0, dot(viewDir, L));
            float sunAlign = sa * sa * sa;
            float sss = (sunAlign * (0.58 + 0.45 * uSunsetFactor) + 0.10 * shadow) * uDayFactor * (0.35 + 0.65 * shadow) * skyVis;
            lit += albedo * uSunColor * sss;
            if (emissive > 0.01) {
              lit += (albedo * 1.3 + vBlockLight * 2.2) * emissive;
            }
            float outdoorLift = smoothstep(0.05, 0.45, skyVis);
            float valleyH = exp(-max(0.0, vWorldPos.y - ${SEA_LEVEL - 2}.0) * 0.052);
            float valleyMist = valleyH * smoothstep(24.0, 145.0, dist) * outdoorLift * mix(0.38, 0.48, uSunsetFactor);
            vec3 mistDay = mix(uHorizonColor * 1.04, uSunColor * 1.24, sunAlign * (0.42 + 0.58 * uSunsetFactor));
            vec3 mistCol = mix(vec3(0.11, 0.28, 0.58), mistDay, uDayFactor);
            lit = mix(lit, mistCol, clamp(valleyMist, 0.0, 0.56));

            float hazeFactor = smoothstep(uFogNear * 0.48, uFogFar, dist) * outdoorLift;
            vec3 atmFog = mix(uHorizonColor, uSunColor * 1.15, sunAlign * (0.36 + 0.62 * uSunsetFactor) * uDayFactor);
            atmFog = mix(atmFog, uSunsetColor * 1.08, sunAlign * uSunsetFactor * 0.45);
            lit = mix(lit, atmFog, hazeFactor);
          } else {
            lit = mix(lit, uHorizonColor, smoothstep(uFogNear, uFogFar, dist));
          }

          gl_FragColor = vec4(lit, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });

    // 2b. Static Cutout Material (Glass, Ice, Torches, Ladders, Lava — crisp 2-Cascade CSM + 3D Voxel GI + HDR Emission!)
    this.staticCutoutMat = new THREE.ShaderMaterial({
      uniforms: this.shaderUniforms,
      side: THREE.DoubleSide,
      vertexShader: `
        attribute vec3 color;
        attribute vec3 aBlockLight;
        attribute vec3 aBounceLight;
        varying vec2 vLocalUv;
        varying vec3 vWorldPos;
        varying vec3 vWorldNorm;
        varying vec3 vColor;
        varying vec3 vBlockLight;
        varying vec3 vBounceLight;
        void main() {
          vWorldPos = position;
          vWorldNorm = normal;
          vLocalUv = uv;
          vColor = color;
          vBlockLight = aBlockLight;
          vBounceLight = aBounceLight;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        ${CSM_LIGHTING_GLSL}
        varying vec2 vLocalUv;
        varying vec3 vWorldPos;
        varying vec3 vWorldNorm;
        varying vec3 vColor;
        varying vec3 vBlockLight;
        varying vec3 vBounceLight;
        void main() {
          vec4 tex = texture2D(uAtlas, vLocalUv);
          if (tex.a < 0.35) discard;
          vec3 albedo = tex.rgb;
          vec3 geomN = normalize(gl_FrontFacing ? vWorldNorm : -vWorldNorm);
          vec3 L = normalize(uSunDir);
          vec3 activeL = uDayFactor > 0.08 ? L : normalize(uMoonDir);
          vec3 viewVec = vWorldPos - cameraPosition;
          float dist = length(viewVec);
          vec3 viewDir = viewVec / max(dist, 0.001);
          vec3 V = -viewDir;
          float ao = clamp(vColor.r, 0.25, 1.15);
          float skyVis = clamp(vColor.g, 0.0, 1.0);
          vec4 pbr = uPbrOn > 0.5 ? texture2D(uPbrAtlas, vLocalUv) : vec4(0.85, 0.0, 0.05, 0.0);
          float roughness = clamp(pbr.r, 0.06, 0.98);
          float f0Scalar = clamp(pbr.b, 0.02, 0.95);
          float emissive = max(clamp(vColor.b, 0.0, 1.0), pbr.a * step(0.45, pbr.a));
          vec3 N = perturbVoxelNormal(geomN, vLocalUv, dist);

          float shadow = computeCSMShadow(vWorldPos, geomN, false) * smoothstep(0.08, 0.55, skyVis);
          float ndl = max(0.0, dot(N, activeL));
          vec3 hemi = mix(uHemiGroundColor, uHemiSkyColor, N.y * 0.5 + 0.5) * uHemiIntensity;
          vec3 directLight = uSunLightColor * (uSunLightIntensity * ndl * shadow * 0.92);
          vec3 skyIndirect = hemi * (skyVis * skyVis * 0.85 + 0.045) * ao;
          vec3 bounceGI = vBounceLight * uSunColor * (0.45 * uDayFactor) * ao;
          vec3 blockGI = (vBlockLight * vBlockLight * 2.2 + vBlockLight * 0.22) * ao;
          vec3 localFlicker = computeDynamicPointLights(vWorldPos, N);
          vec3 lit = albedo * (directLight * mix(0.55, 1.0, ao) + skyIndirect + bounceGI + blockGI + localFlicker);

          // Crisp Glass & Ice Fresnel Sky Reflections + Specular Glints!
          if (uPbrOn > 0.5 && roughness < 0.35) {
            float NoV = max(0.001, dot(N, V));
            vec3 R = reflect(-V, N);
            vec3 envCol = sampleEnvIBL(R, roughness, skyVis);
            vec3 F = F_Schlick(NoV, vec3(f0Scalar));
            lit += envCol * F * 0.85;
            vec3 H = normalize(V + activeL);
            float D = D_GGX(max(0.0, dot(N, H)), roughness);
            lit += min(uSunLightColor * D * F * shadow * 0.22, vec3(3.0));
          }

          if (emissive > 0.01) {
            lit += (albedo * 1.7 + vBlockLight * 2.5) * emissive;
          }

          if (uShaderOn > 0.5) {
            float sa = max(0.0, dot(viewDir, L));
            float sunAlign = sa * sa * sa;
            float hazeFactor = smoothstep(uFogNear * 0.55, uFogFar, dist) * smoothstep(0.05, 0.45, skyVis);
            vec3 atmFog = mix(uHorizonColor, uSunColor * 1.05, sunAlign * (0.28 + 0.52 * uSunsetFactor) * uDayFactor);
            atmFog = mix(atmFog, uSunsetColor, sunAlign * uSunsetFactor * 0.35);
            lit = mix(lit, atmFog, hazeFactor);
          } else {
            lit = mix(lit, uHorizonColor, smoothstep(uFogNear, uFogFar, dist));
          }

          gl_FragColor = vec4(lit, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });

    // 2c. Dedicated 10x Animated Pixel-Art Minecraft Fire Shader (roaring 16x16 flames + HDR glow + subtle sway!)
    this.fireMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.shaderUniforms.uTime,
        uFogNear: this.shaderUniforms.uFogNear,
        uFogFar: this.shaderUniforms.uFogFar,
        uHorizonColor: this.shaderUniforms.uHorizonColor,
        uShaderOn: this.shaderUniforms.uShaderOn
      },
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      vertexShader: `
        uniform float uTime;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying float vPhase;
        void main() {
          vUv = uv;
          vec3 p = position;
          // Unique per-block animation phase so flames across a burning tree dance organically!
          vec3 cell = floor(p + vec3(0.01));
          vPhase = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453) * 16.0;
          // Subtle lively lick/sway only at upper flame tips (base stays locked flush to wood/leaves!)
          float tip = smoothstep(0.15, 1.0, uv.y);
          float flick = sin(uTime * 11.5 + vPhase + p.y * 4.0) * 0.045 * tip;
          float flickZ = cos(uTime * 9.8 + vPhase * 1.3 + p.x * 3.5) * 0.045 * tip;
          p.x += flick;
          p.z += flickZ;
          vWorldPos = p;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uFogNear;
        uniform float uFogFar;
        uniform vec3 uHorizonColor;
        uniform float uShaderOn;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying float vPhase;

        float fHash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        float fNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(fHash(i), fHash(i + vec2(1.0, 0.0)), f.x),
            mix(fHash(i + vec2(0.0, 1.0)), fHash(i + vec2(1.0, 1.0)), f.x),
            f.y
          );
        }

        void main() {
          // Authentic 16x16 quantized Minecraft pixel-art fire roaring upward at 18 FPS!
          vec2 pix = floor(vUv * 16.0) / 16.0;
          float tStep = floor(uTime * 18.0 + vPhase) * 0.145;

          // Multi-tongue roaring flame turbulence scrolling upward
          float n1 = fNoise(vec2(pix.x * 4.5 + vPhase * 0.7, pix.y * 3.6 - tStep * 2.2));
          float n2 = fNoise(vec2(pix.x * 9.0 - vPhase * 0.4, pix.y * 7.2 - tStep * 3.9));
          float tongues = sin(pix.x * 18.8495 + sin(tStep * 1.6 + vPhase) * 1.8) * 0.14;
          float edgePinch = 1.0 - pow(abs(pix.x - 0.5) * 2.0, 2.6) * (0.28 + 0.58 * pix.y);

          float heat = (1.0 - pix.y * 1.04) * edgePinch + (n1 * 0.58 + n2 * 0.34 - 0.30) + tongues * pix.y;

          // Occasional detached rising pixel sparks licking above the main flame!
          float spark = step(0.84, fHash(vec2(floor(pix.x * 16.0), floor(pix.y * 16.0 - floor(uTime * 14.0 + vPhase)))))
                      * step(0.45, pix.y) * step(pix.y, 0.94) * step(0.18, heat + 0.25);

          if (heat < 0.14 && spark < 0.5) discard;

          // Authentic Minecraft Fire Palette (incandescent white-yellow core -> bright gold -> fiery orange -> crimson tip!)
          vec3 col;
          if (spark > 0.5 && heat < 0.18) {
            col = vec3(1.55, 0.72, 0.10);
          } else if (heat > 0.72) {
            col = vec3(2.25, 2.15, 1.65); // blazing HDR white-cream core (triggers soft warm bloom!)
          } else if (heat > 0.52) {
            col = vec3(1.85, 1.38, 0.24); // luminous golden yellow
          } else if (heat > 0.32) {
            col = vec3(1.55, 0.64, 0.06); // vivid fiery orange
          } else {
            col = vec3(1.18, 0.24, 0.03); // flickering crimson ember tip
          }

          float pulse = 0.93 + 0.09 * sin(uTime * 23.0 + vPhase * 2.0);
          col *= pulse;

          if (uShaderOn > 0.5) {
            float dist = length(vWorldPos - cameraPosition);
            float haze = smoothstep(uFogNear * 0.55, uFogFar, dist);
            col = mix(col, uHorizonColor, haze);
          }

          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });

    // 3. RTX / SEUS PTGI-Quality Realistic Water Shader (True SSR + Refraction + Beer-Lambert Depth Absorption + Multi-Octave Waves + Foam!)
    this.waterMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.shaderUniforms.uTime,
        uWaveStrength: this.shaderUniforms.uWaveStrength,
        uSunDir: this.shaderUniforms.uSunDir,
        uMoonDir: this.shaderUniforms.uMoonDir,
        uTopColor: this.shaderUniforms.uTopColor,
        uMidColor: this.shaderUniforms.uMidColor,
        uHorizonColor: this.shaderUniforms.uHorizonColor,
        uSunsetColor: this.shaderUniforms.uSunsetColor,
        uSunColor: this.shaderUniforms.uSunColor,
        uCloudLitColor: this.shaderUniforms.uCloudLitColor,
        uDayFactor: this.shaderUniforms.uDayFactor,
        uSunsetFactor: this.shaderUniforms.uSunsetFactor,
        uRainFactor: this.shaderUniforms.uRainFactor,
        uFogNear: this.shaderUniforms.uFogNear,
        uFogFar: this.shaderUniforms.uFogFar,
        tOpaqueColor: { value: this._dummyShadowTex },
        tOpaqueDepth: { value: this._dummyShadowTex },
        uHasOpaqueCopy: { value: 0.0 },
        uSsrSteps: { value: 0.0 },
        uResolution: { value: new THREE.Vector2(1024, 768) },
        uInvProjection: { value: new THREE.Matrix4() },
        uProjection: { value: new THREE.Matrix4() },
        uViewMatrix: { value: new THREE.Matrix4() }
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: true,
      vertexShader: `
        varying vec3 vWorldPos;
        varying vec3 vBaseNormal;
        void main() {
          vWorldPos = position;
          vBaseNormal = normal;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uWaveStrength;
        uniform vec3 uSunDir;
        uniform vec3 uMoonDir;
        uniform vec3 uTopColor;
        uniform vec3 uMidColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uSunsetColor;
        uniform vec3 uSunColor;
        uniform vec3 uCloudLitColor;
        uniform float uDayFactor;
        uniform float uSunsetFactor;
        uniform float uRainFactor;
        uniform float uFogNear;
        uniform float uFogFar;
        uniform sampler2D tOpaqueColor;
        uniform sampler2D tOpaqueDepth;
        uniform float uHasOpaqueCopy;
        uniform float uSsrSteps;
        uniform vec2 uResolution;
        uniform mat4 uInvProjection;
        uniform mat4 uProjection;
        uniform mat4 uViewMatrix;
        varying vec3 vWorldPos;
        varying vec3 vBaseNormal;

        float wIgn(vec2 p) {
          return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
        }

        float wHash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        float wNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x),
            mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x),
            f.y
          );
        }

        // Smooth 3-octave animated wave heightfield (organic SEUS/RTX capillary + wind swell normals!)
        float waterHeight(vec2 p, float t) {
          float h = 0.0;
          h += wNoise(p * 0.58 + vec2(t * 0.52, t * 0.31)) * 0.52;
          h += wNoise(p * 1.45 - vec2(t * 0.74, -t * 0.48)) * 0.30;
          h += wNoise(p * 3.20 + vec2(-t * 0.95, t * 0.85)) * 0.18;
          if (uRainFactor > 0.05) {
            h += sin(p.x * 9.0 + t * 7.0) * cos(p.y * 9.0 - t * 6.5) * 0.12 * uRainFactor;
          }
          return h;
        }

        vec3 reconstructViewPos(vec2 uv, float depth) {
          vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
          vec4 vp = uInvProjection * ndc;
          return vp.xyz / vp.w;
        }

        // Analytical Sky + Clouds + Sun/Moon reflection fallback (seamless when SSR ray leaves screen!)
        vec3 sampleSkyReflection(vec3 R, vec3 sunDir, vec3 moonDir, float skyMask, float t) {
          float rY = clamp(abs(R.y), 0.015, 1.0);
          vec3 reflCol = mix(uHorizonColor * 1.06, uMidColor, smoothstep(0.0, 0.34, rY));
          reflCol = mix(reflCol, uTopColor, smoothstep(0.24, 0.90, rY));

          float rSun = max(0.0, dot(R, sunDir));
          float rSun2 = rSun * rSun;
          float rSun4 = rSun2 * rSun2;
          float rSun16 = rSun4 * rSun4 * rSun4 * rSun4;
          float sunUp = smoothstep(-0.08, 0.08, sunDir.y) * (1.0 - uRainFactor * 0.82) * skyMask;
          reflCol = mix(reflCol, uSunsetColor * 1.16, (1.0 - rY) * (0.36 + 0.64 * rSun2) * uSunsetFactor * (1.0 - uRainFactor * 0.7));
          reflCol += uSunColor * (rSun4 * 0.44 + rSun16 * 1.35) * sunUp;

          // Reflected clouds matching the sky dome
          vec2 cUv = (R.xz / (rY + 0.14)) * 0.36 + vec2(t * 0.007, t * 0.0025);
          float cDens = wNoise(cUv * 1.4) * 0.65 + wNoise(cUv * 3.1) * 0.35;
          float cMask = smoothstep(0.50, 0.76, cDens) * smoothstep(0.02, 0.22, rY) * (1.0 - rY * 0.5);
          reflCol = mix(reflCol, uCloudLitColor * 1.06, cMask * 0.45 * (1.0 - uRainFactor * 0.4));
          return reflCol;
        }

        // True Screen-Space Reflection (SSR) with binary hit refinement (reflects bridges, trees, cliffs & castles!)
        vec4 traceSSR(vec3 waterViewPos, vec3 reflViewDir, float maxSteps) {
          if (maxSteps < 1.0 || reflViewDir.z > 0.35) return vec4(0.0);
          int steps = int(maxSteps);
          float jitter = wIgn(gl_FragCoord.xy);
          float stepDist = 0.42;
          float curT = 0.18 + jitter * 0.28;
          vec3 prevPos = waterViewPos;

          for (int i = 0; i < 22; i++) {
            if (i >= steps) break;
            vec3 samplePos = waterViewPos + reflViewDir * curT;
            if (samplePos.z > -0.15) break;
            vec4 clip = uProjection * vec4(samplePos, 1.0);
            if (clip.w <= 0.001) break;
            vec2 sUv = (clip.xy / clip.w) * 0.5 + 0.5;
            if (sUv.x < 0.003 || sUv.x > 0.997 || sUv.y < 0.003 || sUv.y > 0.997) break;

            float sDepth = texture2D(tOpaqueDepth, sUv).r;
            if (sDepth < 0.9997) {
              vec3 hitView = reconstructViewPos(sUv, sDepth);
              float dz = hitView.z - samplePos.z;
              float thickness = 0.28 + stepDist * 1.45;
              if (dz > 0.0 && dz < thickness) {
                // 3-step binary refinement for razor-sharp bridge & tree silhouettes on water!
                vec3 lo = prevPos;
                vec3 hi = samplePos;
                vec2 bestUv = sUv;
                for (int b = 0; b < 3; b++) {
                  vec3 mid = (lo + hi) * 0.5;
                  vec4 mClip = uProjection * vec4(mid, 1.0);
                  vec2 mUv = (mClip.xy / mClip.w) * 0.5 + 0.5;
                  float mD = texture2D(tOpaqueDepth, clamp(mUv, vec2(0.002), vec2(0.998))).r;
                  vec3 mHit = reconstructViewPos(mUv, mD);
                  if (mHit.z - mid.z > 0.0) {
                    hi = mid;
                    bestUv = mUv;
                  } else {
                    lo = mid;
                  }
                }
                vec2 edgeDist = min(bestUv, 1.0 - bestUv);
                float edgeFade = smoothstep(0.0, 0.11, min(edgeDist.x, edgeDist.y));
                float rayFade = 1.0 - smoothstep(float(steps) * 0.65, float(steps), float(i));
                vec3 hitCol = texture2D(tOpaqueColor, bestUv).rgb;
                return vec4(hitCol, edgeFade * rayFade);
              }
            }
            prevPos = samplePos;
            curT += stepDist;
            stepDist *= 1.18;
          }
          return vec4(0.0);
        }

        void main() {
          vec3 viewVec = cameraPosition - vWorldPos;
          float dist = length(viewVec);
          vec3 V = viewVec / max(dist, 0.001);
          vec3 sunDir = normalize(uSunDir);
          vec3 moonDir = normalize(uMoonDir);
          vec2 p = vWorldPos.xz;
          float t = uTime;

          // UNDERSIDE WATER SURFACE CEILING (Snell's Window + Shimmering Overhead Water Surface!)
          if (!gl_FrontFacing) {
            vec2 pix = floor(p * 10.0) / 10.0;
            float shimmer = waterHeight(pix * 1.6, t * 1.4);
            float lookUp = clamp(dot(vec3(0.0, -1.0, 0.0), V), 0.0, 1.0);
            // Physical Snell's window critical angle (~48.6 deg -> cos ~ 0.66)
            float snell = smoothstep(0.52, 0.78, lookUp);
            vec3 skyWin = mix(uHorizonColor * 0.75, uMidColor * 1.05, snell) * (0.28 + 0.72 * uDayFactor);
            vec3 tirCol = mix(vec3(0.03, 0.11, 0.24), vec3(0.08, 0.28, 0.52), uDayFactor);
            vec3 underCol = mix(tirCol, skyWin, snell * (0.55 + 0.45 * shimmer));
            underCol += uSunColor * 0.35 * snell * smoothstep(0.55, 0.9, shimmer) * uDayFactor;
            float uwFog = smoothstep(10.0, 48.0, dist);
            vec3 uwFogCol = mix(vec3(0.03, 0.09, 0.20), vec3(0.08, 0.28, 0.48), uDayFactor);
            underCol = mix(underCol, uwFogCol, uwFog * 0.76);
            float underAlpha = mix(0.84, 0.52, snell * (1.0 - uwFog));
            gl_FragColor = vec4(underCol, underAlpha);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
            return;
          }

          // Smooth Animated Multi-Octave Wave Normals (distance-attenuated to prevent far sparkling aliasing)
          float amp = mix(0.025, 0.14, clamp(uWaveStrength, 0.0, 1.2)) * (1.0 - smoothstep(28.0, 130.0, dist) * 0.72);
          vec3 N = normalize(vBaseNormal);
          float wH = 0.5;
          if (vBaseNormal.y > 0.5 && amp > 0.002) {
            float eps = 0.08;
            float hC = waterHeight(p, t);
            float hX = waterHeight(p + vec2(eps, 0.0), t);
            float hZ = waterHeight(p + vec2(0.0, eps), t);
            wH = hC;
            N = normalize(vec3((hC - hX) * amp / eps, 1.0, (hC - hZ) * amp / eps));
          }

          float skyMask = smoothstep(${SEA_LEVEL - 10}.0, ${SEA_LEVEL - 2}.0, vWorldPos.y);
          float NoV = max(0.001, dot(N, V));
          // Physical Water Schlick Fresnel (F0 = 0.025 -> crystal clear looking down, mirror at grazing angles!)
          float fresnel = clamp(0.03 + 0.94 * pow(1.0 - NoV, 4.2), 0.03, 0.96);

          // Sky + Cloud analytical reflection (always ready as seamless fallback!)
          vec3 R = normalize(reflect(-V, N));
          vec3 skyRefl = sampleSkyReflection(R, sunDir, moonDir, skyMask, t);
          vec3 reflCol = skyRefl;

          vec3 col;
          float outAlpha = 1.0;

          if (uHasOpaqueCopy > 0.5) {
            vec2 screenUv = gl_FragCoord.xy / max(uResolution, vec2(1.0));
            vec3 waterViewPos = (uViewMatrix * vec4(vWorldPos, 1.0)).xyz;
            float waterLinZ = -waterViewPos.z;

            // 1. TRUE SCREEN-SPACE REFLECTIONS (SSR) blended smoothly with Sky Reflection!
            if (uSsrSteps > 0.5 && vBaseNormal.y > 0.5 && dist < 110.0) {
              vec3 reflViewDir = normalize((uViewMatrix * vec4(R, 0.0)).xyz);
              vec4 ssr = traceSSR(waterViewPos, reflViewDir, uSsrSteps);
              float ssrDistFade = 1.0 - smoothstep(65.0, 110.0, dist);
              reflCol = mix(skyRefl, ssr.rgb, ssr.a * ssrDistFade);
            }

            // 2. TRUE REFRACTION + BEER-LAMBERT DEPTH-BASED WATER COLORATION!
            float bgRawD = texture2D(tOpaqueDepth, screenUv).r;
            float bgLinZ = bgRawD >= 0.9998 ? (waterLinZ + 28.0) : -reconstructViewPos(screenUv, bgRawD).z;
            float rawWaterDepth = max(0.0, bgLinZ - waterLinZ);

            // Distort underwater refraction UV by wave normal (with foreground anti-bleed depth guard!)
            float distortAmt = clamp(rawWaterDepth * 0.012, 0.0015, 0.026) / max(1.0, dist * 0.06);
            vec2 refrUv = clamp(screenUv + N.xz * distortAmt, vec2(0.002), vec2(0.998));
            float refrRawD = texture2D(tOpaqueDepth, refrUv).r;
            float refrLinZ = refrRawD >= 0.9998 ? (waterLinZ + 28.0) : -reconstructViewPos(refrUv, refrRawD).z;
            float waterDepth = rawWaterDepth;
            if (refrLinZ < waterLinZ + 0.02) {
              // Distorted UV hit dry land/hand in front of water -> fall back cleanly!
              refrUv = screenUv;
            } else {
              waterDepth = max(0.0, refrLinZ - waterLinZ);
            }

            vec3 bgCol = texture2D(tOpaqueColor, refrUv).rgb;
            // Physical Beer-Lambert exponential light absorption (red absorbs first -> crystal turquoise -> emerald -> deep sapphire!)
            vec3 transmittance = exp(-waterDepth * vec3(0.36, 0.13, 0.085));
            vec3 shallowScatter = mix(vec3(0.015, 0.05, 0.09), vec3(0.04, 0.24, 0.28), uDayFactor * skyMask);
            vec3 deepScatter = mix(vec3(0.01, 0.03, 0.08), vec3(0.02, 0.11, 0.20), uDayFactor * skyMask);
            deepScatter = mix(deepScatter, vec3(0.06, 0.05, 0.09), uSunsetFactor * 0.55 * skyMask);
            vec3 volumeCol = mix(shallowScatter, deepScatter, smoothstep(1.5, 11.0, waterDepth));
            vec3 refractedCol = bgCol * transmittance + volumeCol * (1.0 - transmittance);

            // Subtle animated shoreline foam where shallow water laps rocks/sand/bridges!
            float foamWave = smoothstep(0.45, 0.72, wH + sin(t * 2.4 + p.x * 2.0 + p.y * 1.7) * 0.12);
            float shoreFoam = (1.0 - smoothstep(0.02, 0.42, waterDepth)) * foamWave * 0.38 * (0.35 + 0.65 * uDayFactor);
            refractedCol = mix(refractedCol, vec3(0.92, 0.97, 1.0) * (0.4 + 0.6 * uDayFactor), shoreFoam);

            col = mix(refractedCol, reflCol, fresnel * mix(0.35, 1.0, skyMask));
            // Smooth alpha at the very shallowest 8cm shoreline edge so water meets sand seamlessly
            outAlpha = smoothstep(0.0, 0.09, waterDepth);
          } else {
            // Classic / Low fallback without opaque copy
            vec3 deepWater = mix(vec3(0.02, 0.06, 0.14), vec3(0.04, 0.24, 0.36), uDayFactor * skyMask);
            col = mix(deepWater, reflCol, fresnel * skyMask);
            outAlpha = mix(0.68, 0.94, fresnel);
          }

          // Crisp Sparkling Golden Sun & Silver Crescent Moon Specular Highlights!
          float sunUp = smoothstep(-0.08, 0.08, sunDir.y) * (1.0 - uRainFactor * 0.82) * skyMask;
          if (sunUp > 0.01) {
            vec3 H = normalize(V + sunDir);
            float nh = max(0.0, dot(N, H));
            float nh2 = nh * nh;
            float nh4 = nh2 * nh2;
            float nh16 = nh4 * nh4 * nh4 * nh4;
            float nh64 = nh16 * nh16 * nh16 * nh16;
            float nh256 = nh64 * nh64 * nh64 * nh64;
            col += uSunColor * (nh256 * 5.5 + nh64 * 1.45 + nh16 * 0.16) * sunUp;
          }

          float moonUp = smoothstep(-0.08, 0.08, moonDir.y) * (1.0 - uDayFactor * 0.88) * (1.0 - uRainFactor * 0.82) * skyMask;
          if (moonUp > 0.01) {
            vec3 Hm = normalize(V + moonDir);
            float nm = max(0.0, dot(N, Hm));
            float nm2 = nm * nm;
            float nm4 = nm2 * nm2;
            float nm16 = nm4 * nm4 * nm4 * nm4;
            float nm64 = nm16 * nm16 * nm16 * nm16;
            col += vec3(0.65, 0.90, 1.35) * (nm64 * 2.2 + nm16 * 0.28) * moonUp;
          }

          // Seamless Atmospheric Distance Haze matching terrain & LODs
          float hazeFactor = smoothstep(uFogNear * 0.44, uFogFar, dist) * skyMask;
          float sa = max(0.0, dot(-V, sunDir));
          float sunAlign = sa * sa * sa;
          vec3 atmFog = mix(uHorizonColor, uSunColor * 1.15, sunAlign * (0.36 + 0.62 * uSunsetFactor) * uDayFactor);
          atmFog = mix(atmFog, uSunsetColor * 1.08, sunAlign * uSunsetFactor * 0.48);
          col = mix(col, atmFog, hazeFactor);

          gl_FragColor = vec4(col, mix(outAlpha, 1.0, hazeFactor));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });

    this.group = new THREE.Group();
    this.scene.add(this.group);

    // Distant Horizons 512-Chunk 6-Tier Quadtree LOD Group (Web Worker Pool + Greedy Meshing + Apple HSR!)
    this.lodGroup = new THREE.Group();
    this.scene.add(this.lodGroup);
    this.lodRegions = new Map(); // key -> { rx, rz, tier, mesh, retiring }
    this.maxDetailRadius = options.maxDetailRadius || 10;
    this._lodQueue = [];
    this._lodActiveKeys = new Set();
    this._lodInnerKeys = new Set(); // innermost tiles needing circular cutout `lodMat` (rest use HSR `lodMatOuter`!)
    this._lodRetiringKeys = new Set();
    this._lodPool = null;
    this._lodMaxWorkers = this.maxDetailRadius <= 6 ? 3 : 4;
    this._lastLodRx = 1e9;
    this._lastLodRz = 1e9;
    this._lastLodRD = -1;

    this.meshQueue = [];
    this._spiralOffsets = [];
    this._spiralDataOffsets = [];
    this._spiralForRD = -1;

    // Precomputed fast lookup tables for zero-overhead greedy meshing inner loop
    this._defTable = new Array(256);
    this._solidTable = new Uint8Array(256);
    this._transTable = new Uint8Array(256);
    this._specialTable = new Uint8Array(256); // 1 only for blocks needing PASS 1 (beds, torches, lights, transparent, cross, liquids)
    this._litTable = new Uint8Array(256);     // 1 when block emits light (avoids defTable lookup in PASS 2!)
    this._uvTable = new Array(256); // [blockId] -> Array(6) of { u0, v0, u1, v1, du, dv }
    for (let id = 1; id < 256; id++) {
      const def = getBlockDef(id);
      if (!def) continue;
      this._defTable[id] = def;
      this._solidTable[id] = isBlockSolid(id) ? 1 : 0;
      const isTr = isBlockTransparent(id);
      this._transTable[id] = isTr ? 1 : 0;
      this._litTable[id] = def.light > 0 ? 1 : 0;
      this._specialTable[id] = (
        isTr || def.cross || def.liquid || isBedBlock(id) || isDoorBlock(id) || isFenceOrGate(id) || isWheatBlock(id) ||
        id === BLOCK.TORCH || id === BLOCK.GLOWSTONE || id === BLOCK.FIRE || id === BLOCK.LADDER
      ) ? 1 : 0;
      const faceUVs = new Array(6);
      for (let fi = 0; fi < 6; fi++) {
        const ft = FACES[fi].faceType;
        const texName = def.faces[ft] || def.faces.all || def.faces.side;
        const uv = this.textures.getUV(texName);
        faceUVs[fi] = { u0: uv.u0, v0: uv.v0, u1: uv.u1, v1: uv.v1, du: uv.u1 - uv.u0, dv: uv.v1 - uv.v0 };
      }
      this._uvTable[id] = faceUVs;
    }
    this._bedTopUV = this.textures.getUV('bed_top');
    this._bedSideUV = this.textures.getUV('bed_side');
    this._bedWoodUV = this.textures.getUV('oak_planks');
    this._bedRedUV = this.textures.getUV('wool_red');
    this._bedWhiteUV = this.textures.getUV('wool_white');
    this._torchWoodUV = this.textures.getUV('oak_planks');
    this._torchCoalUV = this.textures.getUV('coal_ore');
    this._torchGlowUV = this.textures.getUV('glowstone');

    // Dynamic Placed & Generated Torch/Glowstone Lighting Pool (4 hero PointLights for mobs/flicker; Voxel GI lights ALL blocks!)
    this.lightSources = new Map(); // "x,y,z" -> { x, y, z, isGlowstone }
    this._lightDirty = true;
    this._lightRefreshTimer = 0;
    this._lightClock = 0;
    this._activeLightSources = [];
    this.torchLightPool = [];
    for (let i = 0; i < 4; i++) {
      const pl = new THREE.PointLight(0xffb44c, 0, 44, 0.85);
      pl.castShadow = false;
      this.group.add(pl);
      this.torchLightPool.push(pl);
    }
  }

  _ensureSpiralOffsets(r) {
    if (this._spiralForRD === r) return;
    this._spiralForRD = r;
    const meshList = [];
    const dataList = [];
    const rMeshSq = (r + 0.5) * (r + 0.5);
    const rData = r + 1;
    const rDataSq = (rData + 0.5) * (rData + 0.5);
    for (let dz = -rData; dz <= rData; dz++) {
      for (let dx = -rData; dx <= rData; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 <= rDataSq) dataList.push({ dx, dz, d2 });
        if (d2 <= rMeshSq) meshList.push({ dx, dz, d2 });
      }
    }
    dataList.sort((a, b) => a.d2 - b.d2);
    meshList.sort((a, b) => a.d2 - b.d2);
    this._spiralDataOffsets = dataList;
    this._spiralOffsets = meshList;
  }

  // Fast numeric integer key — ZERO string allocations in getBlock/raycast/meshing!
  chunkKey(cx, cz) {
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  indexModifiedBlock(x, y, z, blockId) {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const ck = this.chunkKey(cx, cz);
    const lx = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const lz = ((z % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    let map = this.modsByChunk.get(ck);
    if (!map) {
      map = new Map();
      this.modsByChunk.set(ck, map);
    }
    map.set(lx + (lz << 4) + (y << 8), blockId);

    const pk = `${x},${y},${z}`;
    if (LEAF_BLOCK_SET.has(blockId)) this.persistentLeaves.add(pk);
    else this.persistentLeaves.delete(pk);
  }

  // Single-pass combined Biome + Terrain Height sampler (512-height, wide continents, 11 biomes, giant mountains & valleys!)
  sampleColumn(wx, wz) {
    if (this.worldType === 'flat') return { biome: 'Plains', height: SEA_LEVEL + 2 };

    // Wider macro climate & terrain fields (~2.3x larger biomes, landmasses, valleys, sweeping oceans & mountain ranges!)
    const temp = this.biomeNoise.fbm2D(wx * 0.00145, wz * 0.00145, 3);
    const moist = this.moistureNoise.fbm2D(wx * 0.00145, wz * 0.00145, 3);
    const mountField = this.heightNoise.fbm2D(wx * 0.00155 + 50, wz * 0.00155 - 50, 3);
    const cont = this.heightNoise.fbm2D(wx * 0.0018, wz * 0.0018, 4);
    const oceanDistSq = wx * wx + wz * wz;
    const isOceanZone = cont < -0.175 && mountField < 0.04 && oceanDistSq > 140 * 140;

    let biome = 'Plains';
    if (isOceanZone) biome = cont < -0.265 ? 'Deep Ocean' : 'Ocean';
    else if (mountField > 0.145) biome = 'Mountains';
    else if (temp > 0.21 && moist < -0.05) biome = 'Badlands';
    else if (temp > 0.13 && moist < 0.01) biome = 'Desert';
    else if (temp > 0.10 && moist < 0.11) biome = 'Savanna';
    else if (temp > 0.09 && moist >= 0.11) biome = 'Jungle';
    else if (temp < -0.13) biome = 'Snowy Taiga';
    else if (moist > 0.13 && cont < 0.04 && temp > -0.06) biome = 'Swamp';
    else if (mountField > 0.055 && temp > -0.08 && temp < 0.10 && moist > -0.05) biome = 'Cherry Grove';
    else if (moist > 0.07) biome = temp > 0.0 ? 'Forest' : 'Birch Forest';

    // 1. Broad rolling hills + sweeping wide valleys + crisp micro detail
    const hills = this.heightNoise.fbm2D(wx * 0.0085, wz * 0.0085, 3);
    const micro = this.heightNoise.noise2D(wx * 0.042, wz * 0.042) * 1.3;

    // 2. Massive continuous Alpine Mountain Ranges (soaring to Y=175..245+ inside 512-block world!)
    const mRaw = Math.max(0, Math.min(1, (mountField - 0.01) / 0.34));
    const mSmooth = mRaw * mRaw * (3 - 2 * mRaw);

    let alpineBoost = 0;
    if (mSmooth > 0.001) {
      const warpX = this.biomeNoise.fbm2D(wx * 0.0042 + 11, wz * 0.0042 - 19, 2) * 48;
      const warpZ = this.moistureNoise.fbm2D(wx * 0.0042 - 27, wz * 0.0042 + 33, 2) * 48;
      const rx = wx + warpX;
      const rz = wz + warpZ;

      const r1 = 1.0 - Math.abs(this.heightNoise.noise2D(rx * 0.0044, rz * 0.0044) * 1.85);
      const r2 = 1.0 - Math.abs(this.heightNoise.noise2D(rx * 0.0105 + 41, rz * 0.0105 - 17) * 1.85);
      const r3 = 1.0 - Math.abs(this.heightNoise.noise2D(rx * 0.025 - 13, rz * 0.025 + 29) * 1.85);

      const ridgeA = Math.pow(Math.max(0, r1), 1.65);
      const ridgeB = Math.pow(Math.max(0, r2), 1.95) * (0.35 + 0.65 * ridgeA);
      const ridgeC = Math.pow(Math.max(0, r3), 2.1) * (0.25 + 0.75 * ridgeB);

      const foothill = mSmooth * 24.0;
      const massif = (mSmooth * mSmooth) * (ridgeA * 106.0 + ridgeB * 40.0 + ridgeC * 12.0);
      alpineBoost = foothill + massif;
    }

    // 3. Sweeping wide river valleys & scenic lakeside basins
    const riverRaw = Math.abs(this.moistureNoise.fbm2D(wx * 0.0028 + 200, wz * 0.0028 - 150, 3));
    const valleyT = riverRaw < 0.14 ? (1 - riverRaw / 0.14) : 0;
    const valleyCarve = (valleyT * valleyT * (3 - 2 * valleyT)) * 12.0 * (1 - mSmooth * 0.45);
    const riverT = riverRaw < 0.044 ? (1 - riverRaw / 0.044) : 0;
    const riverCarve = (riverT * riverT * (3 - 2 * riverT)) * 14.0 * (1 - mSmooth * 0.72);

    const pondNoise = this.biomeNoise.fbm2D(wx * 0.0075 - 90, wz * 0.0075 + 110, 2);
    const pondT = pondNoise < -0.24 ? Math.min(1, (-0.24 - pondNoise) / 0.22) : 0;
    const pondCarve = (pondT * pondT * (3 - 2 * pondT)) * 9.0 * (1 - mSmooth * 0.9);

    // 4. Biome-specific terrain variation (Badlands stepped mesas, Savanna plateaus, low Swamps!)
    const flatBlend = Math.max(0, Math.min(1, 1 - mSmooth * 1.8));
    let biomeOffset = 0;
    let hillAmp = (temp > 0.13 ? 5.5 : 8.2) * flatBlend + 4.5 * mSmooth;
    if (biome === 'Badlands') {
      const mesaRaw = Math.max(0, Math.min(1, (hills + 0.18) * 2.2));
      const stepped = Math.floor(mesaRaw * 4) * 7.0 + Math.min(1, (mesaRaw * 4) % 1 * 3.5) * 2.0;
      biomeOffset = stepped * flatBlend;
      hillAmp = 2.5 * flatBlend;
    } else if (biome === 'Savanna') {
      biomeOffset = (hills > 0.12 ? 9.0 : 2.5) * flatBlend;
      hillAmp = 4.5 * flatBlend;
    } else if (biome === 'Jungle') {
      hillAmp = 10.5 * flatBlend;
      biomeOffset = 4.0 * flatBlend;
    } else if (biome === 'Swamp') {
      hillAmp = 2.4 * flatBlend;
      biomeOffset = -6.5 * flatBlend;
    } else if (biome === 'Cherry Grove') {
      biomeOffset = 8.0 * flatBlend;
      hillAmp = 6.5 * flatBlend;
    }

    const terrace = Math.sin(hills * 3.14159) * 0.5 * flatBlend;
    // Deep sweeping Ocean basin carve with gentle sandy seabed dunes!
    let oceanCarve = 0;
    if (isOceanZone) {
      const oRaw = Math.max(0, Math.min(1, (-0.175 - cont) / 0.18));
      const oSmooth = oRaw * oRaw * (3 - 2 * oRaw);
      oceanCarve = 10.5 + oSmooth * 18.5;
    }
    let baseH = SEA_LEVEL + 7.5 + cont * 21.0 + (hills * hillAmp + terrace) + biomeOffset + micro + alpineBoost - valleyCarve - riverCarve - pondCarve - oceanCarve;
    if (isOceanZone) {
      baseH = Math.min(baseH, SEA_LEVEL - 4.5 + hills * 2.5);
    } else if (biome === 'Swamp' && mSmooth < 0.15) {
      // Keep swamps as lush low-lying wetlands with shallow marsh channels
      baseH = Math.min(baseH, SEA_LEVEL + 3.5 + hills * 3.0);
      baseH = Math.max(baseH, SEA_LEVEL - 2.5);
    }
    const height = Math.max(10, Math.min(CHUNK_HEIGHT - 16, Math.floor(baseH)));
    return { biome, height };
  }

  getBiomeAt(wx, wz) {
    if (this.worldType === 'flat') return 'Plains';
    const temp = this.biomeNoise.fbm2D(wx * 0.00145, wz * 0.00145, 3);
    const moist = this.moistureNoise.fbm2D(wx * 0.00145, wz * 0.00145, 3);
    const mount = this.heightNoise.fbm2D(wx * 0.00155 + 50, wz * 0.00155 - 50, 3);
    const cont = this.heightNoise.fbm2D(wx * 0.0018, wz * 0.0018, 4);
    if (cont < -0.175 && mount < 0.04 && (wx * wx + wz * wz) > 140 * 140) {
      return cont < -0.265 ? 'Deep Ocean' : 'Ocean';
    }
    if (mount > 0.145) return 'Mountains';
    if (temp > 0.21 && moist < -0.05) return 'Badlands';
    if (temp > 0.13 && moist < 0.01) return 'Desert';
    if (temp > 0.10 && moist < 0.11) return 'Savanna';
    if (temp > 0.09 && moist >= 0.11) return 'Jungle';
    if (temp < -0.13) return 'Snowy Taiga';
    if (moist > 0.13 && cont < 0.04 && temp > -0.06) return 'Swamp';
    if (mount > 0.055 && temp > -0.08 && temp < 0.10 && moist > -0.05) return 'Cherry Grove';
    if (moist > 0.07) return temp > 0.0 ? 'Forest' : 'Birch Forest';
    return 'Plains';
  }

  // Realistic Continuous Domain-Warped Terrain & Alpine Mountains (ZERO abrupt cliff seams!)
  getTerrainHeight(wx, wz) {
    return this.sampleColumn(wx, wz).height;
  }

  // Guarantees new worlds spawn on safe, flat, scenic dry land with an open vista (NEVER underwater or facing a wall!)
  findSafeSpawn(startX = 0.5, startZ = 0.5) {
    if (this.worldType === 'flat') return { x: startX, z: startZ };
    const isGood = (wx, wz) => {
      // Avoid village terracing seams so spawn view is always clean open nature near the village
      if (this.getVillageForChunk(wx >> 4, wz >> 4)) return false;
      const col = this.sampleColumn(wx, wz);
      const h = col.height;
      if (h < SEA_LEVEL + 2 || h > SEA_LEVEL + 32) return false;
      // Check surrounding flat meadow & open sightline ahead (-Z)
      const hN = this.sampleColumn(wx, wz - 2).height;
      const hN2 = this.sampleColumn(wx, wz - 5).height;
      const hS = this.sampleColumn(wx, wz + 2).height;
      const hE = this.sampleColumn(wx + 2, wz).height;
      const hW = this.sampleColumn(wx - 2, wz).height;
      if (hN <= SEA_LEVEL || hS <= SEA_LEVEL || hE <= SEA_LEVEL || hW <= SEA_LEVEL) return false;
      if (Math.abs(hN - h) > 1 || Math.abs(hS - h) > 2 || Math.abs(hE - h) > 2 || Math.abs(hW - h) > 2) return false;
      if (hN2 > h + 2) return false;
      return true;
    };
    const bx = Math.floor(startX);
    const bz = Math.floor(startZ);
    if (isGood(bx, bz)) return { x: bx + 0.5, z: bz + 0.5 };

    for (let rad = 4; rad <= 128; rad += 4) {
      for (let i = 0; i < 16; i++) {
        const ang = (i / 16) * Math.PI * 2;
        const wx = Math.floor(bx + Math.cos(ang) * rad);
        const wz = Math.floor(bz + Math.sin(ang) * rad);
        if (isGood(wx, wz)) return { x: wx + 0.5, z: wz + 0.5 };
      }
    }
    return { x: startX, z: startZ };
  }

  isVillageCenter(vcx, vcz) {
    if (this.worldType === 'flat' || !this.generateStructures) return false;
    // Guaranteed Grand 5x5 (80x80 block!) starter village near spawn centered at chunk (3, 2)!
    if (vcx === 3 && vcz === 2) return true;
    // Spread out on a wide 16x16 chunk grid (256x256 blocks) so huge 5x5 & 3x3 villages never crowd!
    if (((vcx % 16) + 16) % 16 !== 5 || ((vcz % 16) + 16) % 16 !== 5) return false;
    return coordHash(vcx * 13, vcz * 17, this.seed + 555) > 0.24;
  }

  getVillageRadius(vcx, vcz) {
    if (vcx === 3 && vcz === 2) return 2; // Starter village is a Grand 5x5 Town!
    return coordHash(vcx * 37, vcz * 53, this.seed + 619) > 0.40 ? 2 : 1; // 60% Grand 5x5 Towns, 40% Cozy 3x3 Villages!
  }

  // Deterministic Mega-Structure Locator (64x64 Great Pyramids & 64x64 Mega Castles — widely spaced!)
  // Returns { type, name, variant, originCx, originCz, sizeChunks, dx, dz, baseY, centerWx, centerWz, villagerCount }
  getMegaStructureForChunk(cx, cz) {
    if (this.worldType === 'flat' || !this.generateStructures) return null;
    const ck = this.chunkKey(cx, cz);
    if (this._megaChunkCache.has(ck)) return this._megaChunkCache.get(ck);
    const res = this._computeMegaStructureForChunk(cx, cz);
    if (this._megaChunkCache.size > 4096) this._megaChunkCache.clear();
    this._megaChunkCache.set(ck, res);
    return res;
  }

  _computeMegaStructureForChunk(cx, cz) {

    // 1. Guaranteed Starter Great Pyramid (~120m NW of spawn: cx in [-9..-6], cz in [-8..-5])
    if (cx >= -9 && cx <= -6 && cz >= -8 && cz <= -5) {
      const originCx = -9;
      const originCz = -8;
      const centerWx = (originCx + 2) * CHUNK_SIZE;
      const centerWz = (originCz + 2) * CHUNK_SIZE;
      const biome = this.getBiomeAt(centerWx, centerWz);
      const rawH = this.getTerrainHeight(centerWx, centerWz, biome);
      const baseY = Math.max(SEA_LEVEL + 4, Math.min(SEA_LEVEL + 42, rawH));
      return {
        type: 'great_pyramid',
        name: 'The Great Pyramid',
        variant: Math.floor(coordHash(originCx, originCz, this.seed + 1907) * 3),
        originCx, originCz,
        sizeChunks: 4,
        dx: cx - originCx,
        dz: cz - originCz,
        baseY,
        centerWx, centerWz,
        villagerCount: 200
      };
    }

    // 2. Guaranteed Starter Mega Castle (~185m NE of spawn: cx in [10..13], cz in [-9..-6])
    if (cx >= 10 && cx <= 13 && cz >= -9 && cz <= -6) {
      const originCx = 10;
      const originCz = -9;
      const centerWx = (originCx + 2) * CHUNK_SIZE;
      const centerWz = (originCz + 2) * CHUNK_SIZE;
      const biome = this.getBiomeAt(centerWx, centerWz);
      const rawH = this.getTerrainHeight(centerWx, centerWz, biome);
      if (biome !== 'Ocean' && biome !== 'Deep Ocean' && rawH > SEA_LEVEL - 2) {
        const baseY = Math.max(SEA_LEVEL + 5, Math.min(SEA_LEVEL + 46, rawH));
        const variant = Math.floor(coordHash(originCx, originCz, this.seed + 1909) * 3);
        const castleNames = ['Royal Stone Citadel', 'Highland Mega Castle', 'Sunstone Imperial Keep'];
        return {
          type: 'grand_citadel',
          name: castleNames[variant] || 'Mega Castle',
          variant,
          originCx, originCz,
          sizeChunks: 4,
          dx: cx - originCx,
          dz: cz - originCz,
          baseY,
          centerWx, centerWz,
          villagerCount: 150
        };
      }
    }

    // 3. Repeating World Mega-Structures on a wide 36x36 chunk grid (576 blocks apart, never crowded!)
    const GRID = 36;
    const gx = Math.floor((cx + 18) / GRID);
    const gz = Math.floor((cz + 18) / GRID);
    if (gx === 0 && gz === 0) return null;

    const hRoll = coordHash(gx * 59, gz * 83, this.seed + 1901);
    if (hRoll < 0.25) return null;

    const isCastle = (((gx + gz) & 1) === 1) || hRoll > 0.62;
    const sizeChunks = 4; // Both Great Pyramids AND Mega Castles are massive 64x64 (4x4 chunk) Mega-Structures!
    const offX = 5 + Math.floor(coordHash(gx * 37, gz * 71, this.seed + 1913) * (GRID - 12));
    const offZ = 5 + Math.floor(coordHash(gx * 97, gz * 41, this.seed + 1931) * (GRID - 12));
    const originCx = gx * GRID - 18 + offX;
    const originCz = gz * GRID - 18 + offZ;

    if (cx < originCx || cx >= originCx + sizeChunks || cz < originCz || cz >= originCz + sizeChunks) {
      return null;
    }

    const centerWx = (originCx + sizeChunks * 0.5) * CHUNK_SIZE;
    const centerWz = (originCz + sizeChunks * 0.5) * CHUNK_SIZE;
    const biome = this.getBiomeAt(centerWx, centerWz);
    if (biome === 'Ocean' || biome === 'Deep Ocean') return null;
    const rawH = this.getTerrainHeight(centerWx, centerWz, biome);
    if (rawH <= SEA_LEVEL - 1 || rawH > SEA_LEVEL + 56) return null;
    const baseY = Math.max(SEA_LEVEL + 4, Math.min(SEA_LEVEL + 46, rawH));
    const variant = Math.floor(coordHash(gx * 19, gz * 31, this.seed + 1951) * 3);
    const castleNames = ['Royal Stone Citadel', 'Highland Mega Castle', 'Sunstone Imperial Keep'];

    return {
      type: isCastle ? 'grand_citadel' : 'great_pyramid',
      name: isCastle ? (castleNames[variant] || 'Mega Castle') : 'The Great Pyramid',
      variant,
      originCx, originCz,
      sizeChunks,
      dx: cx - originCx,
      dz: cz - originCz,
      baseY,
      centerWx, centerWz,
      villagerCount: isCastle ? 150 : 200
    };
  }

  // Returns { vcx, vcz, dx, dz, radius, variant, baseY, biome } if chunk (cx, cz) belongs to a 3x3 or 5x5 village!
  getVillageForChunk(cx, cz) {
    if (this.worldType === 'flat' || !this.generateStructures) return null;
    const ck = this.chunkKey(cx, cz);
    if (this._villageChunkCache.has(ck)) return this._villageChunkCache.get(ck);
    const res = this._computeVillageForChunk(cx, cz);
    if (this._villageChunkCache.size > 4096) this._villageChunkCache.clear();
    this._villageChunkCache.set(ck, res);
    return res;
  }

  _computeVillageForChunk(cx, cz) {
    if (this.getMegaStructureForChunk(cx, cz)) return null;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const vcx = cx - dx;
        const vcz = cz - dz;
        if (this.isVillageCenter(vcx, vcz)) {
          const radius = this.getVillageRadius(vcx, vcz);
          if (Math.abs(dx) > radius || Math.abs(dz) > radius) continue;
          if (this.getMegaStructureForChunk(vcx, vcz)) return null;
          const centerWx = vcx * CHUNK_SIZE + 8;
          const centerWz = vcz * CHUNK_SIZE + 8;
          const biome = this.getBiomeAt(centerWx, centerWz);
          const rawH = this.getTerrainHeight(centerWx, centerWz, biome);
          const isStarter = vcx === 3 && vcz === 2;
          if (!isStarter) {
            if (biome === 'Ocean' || biome === 'Deep Ocean' || biome === 'Mountains' || biome === 'Swamp') return null;
            if (rawH <= SEA_LEVEL + 1 || rawH > SEA_LEVEL + 36) return null;
          }
          const baseY = isStarter ? Math.max(SEA_LEVEL + 3, Math.min(SEA_LEVEL + 34, rawH)) : rawH;
          const variant = Math.floor(coordHash(vcx * 73, vcz * 41, this.seed + 701) * 3);
          return { vcx, vcz, dx, dz, radius, variant, baseY, biome: isStarter && (biome === 'Ocean' || biome === 'Deep Ocean' || biome === 'Swamp') ? 'Plains' : biome };
        }
      }
    }
    return null;
  }

  isVillageChunk(cx, cz) {
    return !!this.getVillageForChunk(cx, cz);
  }

  // HUGE Varied 3x3 (48x48) & 5x5 (80x80!) Multi-District Living Villages with Real Wheat Farms, Dirt Paths & Windmills!
  buildVillageDistrict(cx, cz, ox, oz, heights, setLocal, getLocal, vInfo) {
    const { vcx, vcz, dx: vdx, dz: vdz, radius = 1, variant = 0, baseY, biome } = vInfo;
    const isDesert = biome === 'Desert' || biome === 'Badlands';
    const isSnow = biome === 'Snowy Taiga';
    const isBirch = biome === 'Birch Forest';
    const isSavanna = biome === 'Savanna';
    const isJungle = biome === 'Jungle';
    const isCherry = biome === 'Cherry Grove';

    const wallBlk = isDesert ? BLOCK.SANDSTONE : (isSnow ? BLOCK.SPRUCE_PLANKS : (isBirch ? BLOCK.BIRCH_PLANKS : (isSavanna ? BLOCK.ACACIA_PLANKS : (isJungle ? BLOCK.JUNGLE_PLANKS : (isCherry ? BLOCK.CHERRY_PLANKS : (variant === 2 ? BLOCK.BIRCH_PLANKS : BLOCK.OAK_PLANKS))))));
    const logBlk = isDesert ? BLOCK.SANDSTONE : (isSnow ? BLOCK.SPRUCE_LOG : (isBirch ? BLOCK.BIRCH_LOG : (isSavanna ? BLOCK.ACACIA_LOG : (isJungle ? BLOCK.JUNGLE_LOG : (isCherry ? BLOCK.CHERRY_LOG : (variant === 1 ? BLOCK.SPRUCE_LOG : BLOCK.OAK_LOG))))));
    const roofBlk = isDesert ? (variant === 1 ? BLOCK.TERRACOTTA_ORANGE : BLOCK.SANDSTONE) : (isSnow ? BLOCK.SPRUCE_LOG : (isSavanna ? BLOCK.ACACIA_LOG : (isCherry ? BLOCK.CHERRY_LOG : (variant === 0 ? BLOCK.BRICKS : (variant === 1 ? BLOCK.SPRUCE_PLANKS : BLOCK.OAK_LOG)))));
    const trimBlk = isDesert ? BLOCK.SANDSTONE : (variant === 1 ? BLOCK.MOSSY_COBBLESTONE : BLOCK.STONE_BRICKS);
    const pathBlk = isDesert ? BLOCK.SANDSTONE : BLOCK.DIRT_PATH;
    const groundBlk = biome === 'Badlands' ? BLOCK.RED_SAND : (isDesert ? BLOCK.SAND : (isSnow ? BLOCK.SNOW : (isSavanna ? BLOCK.SAVANNA_GRASS : (isJungle ? BLOCK.JUNGLE_GRASS : BLOCK.GRASS))));
    const fillBlk = biome === 'Badlands' ? BLOCK.TERRACOTTA : (isDesert ? BLOCK.SAND : BLOCK.DIRT);

    // 1. Terrace this district smoothly to shared village baseY (feathered on outer village rim!)
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const outerEdge =
          (vdx === -radius && lx <= 1) || (vdx === radius && lx >= 14) ||
          (vdz === -radius && lz <= 1) || (vdz === radius && lz >= 14);
        const curH = heights[lx + lz * CHUNK_SIZE];
        const targetY = outerEdge ? Math.round((curH + baseY) * 0.5) : baseY;
        if (curH < targetY) {
          for (let y = Math.max(1, curH); y < targetY; y++) setLocal(lx, y, lz, y === targetY - 1 ? fillBlk : BLOCK.COBBLESTONE);
        } else if (curH > targetY) {
          for (let y = targetY + 1; y <= Math.min(CHUNK_HEIGHT - 2, curH + 10); y++) setLocal(lx, y, lz, BLOCK.AIR);
        }
        setLocal(lx, targetY, lz, groundBlk);
        heights[lx + lz * CHUNK_SIZE] = targetY;
      }
    }

    // 2. Wide 3-block Authentic Minecraft Dirt Path Avenues connecting every district!
    const layRoad = (x0, z0, x1, z1) => {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          setLocal(x, baseY, z, pathBlk);
        }
      }
    };
    if (vdz === 0) layRoad(0, 6, 15, 8);
    if (vdx === 0) layRoad(6, 0, 8, 15);
    if (Math.abs(vdx) === 1 && Math.abs(vdz) === 1) {
      // Inner-ring boulevards connecting to outer districts!
      layRoad(0, 6, 15, 8);
      layRoad(6, 0, 8, 15);
    } else if (vdx !== 0 && vdz !== 0) {
      if (vdx < 0) layRoad(7, 6, 15, 8);
      if (vdx > 0) layRoad(0, 6, 8, 8);
      if (vdz < 0) layRoad(6, 7, 8, 15);
      if (vdz > 0) layRoad(6, 0, 8, 8);
    }

    const addLootChest = (lx, ly, lz, tier = 'house') => {
      setLocal(lx, ly, lz, BLOCK.CHEST);
      const wKey = `${ox + lx},${ly},${oz + lz}`;
      if (!this.chests.has(wKey)) {
        const loot = new Array(27).fill(null);
        const r = Math.floor(coordHash(ox + lx, oz + lz, this.seed + 19) * 4);
        if (tier === 'forge') {
          loot[0] = { id: 'iron_ingot', count: 4 + r };
          loot[1] = { id: 'coal', count: 8 + r * 2 };
          loot[2] = { id: 'iron_pickaxe', count: 1, durability: 251 };
          loot[3] = { id: 'emerald', count: 3 + r };
          loot[4] = { id: 'steak', count: 4 };
        } else if (tier === 'library') {
          loot[0] = { id: 'emerald', count: 4 + r };
          loot[1] = { id: 'bookshelf', count: 3 };
          loot[2] = { id: 'glowstone', count: 4 };
          loot[3] = { id: 'bread', count: 5 };
          loot[4] = { id: 'torch', count: 12 };
        } else {
          loot[0] = { id: 'emerald', count: 2 + r };
          loot[1] = { id: 'bread', count: 4 };
          loot[2] = { id: 'apple', count: 3 };
          loot[3] = { id: 'oak_planks', count: 12 };
          loot[4] = { id: 'bed', count: 1 };
        }
        this.chests.set(wKey, loot);
      }
    };

    const addLamp = (lx, lz) => {
      setLocal(lx, baseY + 1, lz, BLOCK.COBBLESTONE);
      setLocal(lx, baseY + 2, lz, BLOCK.OAK_FENCE);
      setLocal(lx, baseY + 3, lz, logBlk);
      setLocal(lx, baseY + 4, lz, BLOCK.GLOWSTONE);
      // Warm flanking wall torches on streetlamp post!
      if (lx + 1 <= 14 && getLocal(lx + 1, baseY + 3, lz) === BLOCK.AIR) setLocal(lx + 1, baseY + 3, lz, BLOCK.TORCH);
      if (lx - 1 >= 1 && getLocal(lx - 1, baseY + 3, lz) === BLOCK.AIR) setLocal(lx - 1, baseY + 3, lz, BLOCK.TORCH);
    };

    const villageDoorId = isSnow ? BLOCK.SPRUCE_DOOR_B : (isBirch ? BLOCK.BIRCH_DOOR_B : (isSavanna ? BLOCK.ACACIA_DOOR_B : (isJungle ? BLOCK.JUNGLE_DOOR_B : (isCherry ? BLOCK.CHERRY_DOOR_B : BLOCK.OAK_DOOR_B))));
    const setDoorLocal = (lx, by, lz, doorBottomId, facing) => {
      if (lx < 0 || lx >= 16 || lz < 0 || lz >= 16) return;
      setLocal(lx, by, lz, doorBottomId);
      setLocal(lx, by + 1, lz, doorBottomId + 1);
      this.doorStates.set(`${ox + lx},${by},${oz + lz}`, { facing: facing & 3, open: false });
    };

    // Detailed Gable-Roofed Village House Helper with Overhanging Eaves, Beds, Chimney & Flowers!
    const buildDetailedHouse = (x0, z0, w, d, h, opts = {}) => {
      const { doorSide = 'south', beds = 1, chestTier = null, furnace = false, library = false, chimney = true, twoStory = false } = opts;
      const totalH = twoStory ? h + 3 : h;

      // Foundation + walls + interior floor
      for (let dz = 0; dz < d; dz++) {
        for (let dx = 0; dx < w; dx++) {
          setLocal(x0 + dx, baseY, z0 + dz, (dx === 0 || dx === w - 1 || dz === 0 || dz === d - 1) ? trimBlk : wallBlk);
          for (let dy = 1; dy <= totalH; dy++) {
            const edgeX = dx === 0 || dx === w - 1;
            const edgeZ = dz === 0 || dz === d - 1;
            if (edgeX && edgeZ) {
              setLocal(x0 + dx, baseY + dy, z0 + dz, logBlk);
            } else if (edgeX || edgeZ) {
              const isFloorBeam = twoStory && dy === h + 1;
              const isWin = (dy === 2 || (twoStory && dy === h + 3)) &&
                ((edgeZ && dx > 1 && dx < w - 2 && dx % 2 === 1) || (edgeX && dz > 1 && dz < d - 2 && dz % 2 === 1));
              setLocal(x0 + dx, baseY + dy, z0 + dz, isFloorBeam ? logBlk : (isWin ? BLOCK.GLASS : (dy === 1 ? BLOCK.COBBLESTONE : wallBlk)));
            } else {
              const midFloor = twoStory && dy === h + 1 && !(dx === 1 && dz === 1);
              setLocal(x0 + dx, baseY + dy, z0 + dz, midFloor ? wallBlk : BLOCK.AIR);
            }
          }
        }
      }

      // Overhanging Pitched Gable Roof!
      const roofSteps = Math.ceil(Math.min(w, d) / 2);
      for (let step = 0; step <= roofSteps; step++) {
        const ry = baseY + totalH + 1 + step;
        const zStart = z0 - 1 + step;
        const zEnd = z0 + d - step;
        if (zStart > zEnd) break;
        for (let x = x0 - 1; x <= x0 + w; x++) {
          if (x < 0 || x > 15) continue;
          if (zStart >= 0 && zStart <= 15) setLocal(x, ry, zStart, (x === x0 - 1 || x === x0 + w) ? logBlk : roofBlk);
          if (zEnd >= 0 && zEnd <= 15) setLocal(x, ry, zEnd, (x === x0 - 1 || x === x0 + w) ? logBlk : roofBlk);
        }
        // Fill gable wall triangles on east & west ends
        for (let z = Math.max(z0, zStart + 1); z <= Math.min(z0 + d - 1, zEnd - 1); z++) {
          setLocal(x0, ry, z, wallBlk);
          setLocal(x0 + w - 1, ry, z, wallBlk);
        }
      }

      // Stone Chimney
      if (chimney && x0 + w - 2 >= 1 && x0 + w - 2 <= 14) {
        for (let dy = 1; dy <= totalH + roofSteps + 2; dy++) {
          setLocal(x0 + w - 2, baseY + dy, z0 + 1, BLOCK.COBBLESTONE);
        }
      }

      // Real Interactive Wood Door + Cobble Porch Step + Exterior Porch Wall Torch!
      const midX = x0 + Math.floor(w / 2);
      const midZ = z0 + Math.floor(d / 2);
      if (doorSide === 'south') {
        setDoorLocal(midX, baseY + 1, z0 + d - 1, villageDoorId, 2);
        setLocal(midX, baseY, z0 + d, BLOCK.COBBLESTONE);
        if (midX - 1 > x0 && z0 + d <= 15) setLocal(midX - 1, baseY + 2, z0 + d, BLOCK.TORCH);
      } else if (doorSide === 'north') {
        setDoorLocal(midX, baseY + 1, z0, villageDoorId, 0);
        setLocal(midX, baseY, z0 - 1, BLOCK.COBBLESTONE);
        if (midX + 1 < x0 + w - 1 && z0 - 1 >= 0) setLocal(midX + 1, baseY + 2, z0 - 1, BLOCK.TORCH);
      } else if (doorSide === 'east') {
        setDoorLocal(x0 + w - 1, baseY + 1, midZ, villageDoorId, 1);
        setLocal(x0 + w, baseY, midZ, BLOCK.COBBLESTONE);
        if (midZ - 1 > z0 && x0 + w <= 15) setLocal(x0 + w, baseY + 2, midZ - 1, BLOCK.TORCH);
      } else {
        setDoorLocal(x0, baseY + 1, midZ, villageDoorId, 3);
        setLocal(x0 - 1, baseY, midZ, BLOCK.COBBLESTONE);
        if (midZ + 1 < z0 + d - 1 && x0 - 1 >= 0) setLocal(x0 - 1, baseY + 2, midZ + 1, BLOCK.TORCH);
      }
      // Extra warm wall-mounted interior torch on back wall
      if (x0 + 1 < x0 + w - 1 && z0 + 1 < z0 + d - 1) {
        setLocal(x0 + 1, baseY + 2, z0 + 1, BLOCK.TORCH);
      }

      // Interior Furnishings: Torches, REAL 2-BLOCK-LONG 3D BEDS, Crafting Table, Bookshelves, Furnace & Chest!
      setLocal(x0 + 1, baseY + 2, z0 + 1, BLOCK.TORCH);
      if (beds >= 1) {
        // Place a full 2-block-long × 1-block-wide bed (Head at z0+1, Foot at z0+2)
        setLocal(x0 + 1, baseY + 1, z0 + 1, BLOCK.BED_HEAD_N);
        setLocal(x0 + 1, baseY + 1, z0 + 2, BLOCK.BED);
      }
      if (beds >= 2 && w >= 6) {
        setLocal(x0 + 2, baseY + 1, z0 + 1, BLOCK.BED_HEAD_N);
        setLocal(x0 + 2, baseY + 1, z0 + 2, BLOCK.BED);
      }
      if (twoStory) {
        for (let ly = 1; ly <= h + 1; ly++) setLocal(x0 + 1, baseY + ly, z0 + d - 2, BLOCK.LADDER);
        setLocal(x0 + 2, baseY + h + 2, z0 + 1, BLOCK.BED_HEAD_N);
        setLocal(x0 + 2, baseY + h + 2, z0 + 2, BLOCK.BED);
        setLocal(x0 + 1, baseY + h + 3, z0 + 1, BLOCK.TORCH);
      }
      if (furnace) setLocal(x0 + w - 2, baseY + 1, z0 + d - 2, BLOCK.FURNACE);
      else setLocal(x0 + w - 2, baseY + 1, z0 + d - 2, BLOCK.CRAFTING_TABLE);

      if (library) {
        for (let bx = x0 + 1; bx <= x0 + w - 2; bx++) {
          setLocal(bx, baseY + 1, z0 + 1, BLOCK.BOOKSHELF);
          setLocal(bx, baseY + 2, z0 + 1, BLOCK.BOOKSHELF);
        }
        setLocal(x0 + 1, baseY + 1, z0 + d - 2, BLOCK.BED_FOOT_E);
        setLocal(x0 + 2, baseY + 1, z0 + d - 2, BLOCK.BED_HEAD_E);
      }
      if (chestTier) addLootChest(x0 + w - 2, baseY + 1, z0 + 2, chestTier);

      // Cute flower bed outside front wall
      if (z0 + d <= 14 && x0 + 1 <= 14) {
        setLocal(x0 + 1, baseY + 1, z0 + d, BLOCK.FLOWER_RED);
        if (x0 + w - 2 <= 14) setLocal(x0 + w - 2, baseY + 1, z0 + d, BLOCK.FLOWER_YELLOW);
      }
    };

    // 3. Build Unique Architecture for Each of the 9 Districts!
    if (vdx === 0 && vdz === 0) {
      // --- CENTER DISTRICT: Grand Town Square, Ornate Stone Well, Bell/Clock Tower & Market Stalls! ---
      for (let z = 2; z <= 13; z++) {
        for (let x = 2; x <= 13; x++) {
          setLocal(x, baseY, z, ((x + z) % 2 === 0) ? BLOCK.COBBLESTONE : BLOCK.GRAVEL);
        }
      }
      // Ornate Well (center-left)
      for (let dz = 0; dz < 4; dz++) {
        for (let dx = 0; dx < 4; dx++) {
          const edge = dx === 0 || dx === 3 || dz === 0 || dz === 3;
          setLocal(2 + dx, baseY, 2 + dz, edge ? trimBlk : BLOCK.WATER);
          setLocal(2 + dx, baseY + 1, 2 + dz, edge ? trimBlk : BLOCK.WATER);
        }
      }
      for (const [px, pz] of [[2, 2], [5, 2], [2, 5], [5, 5]]) {
        setLocal(px, baseY + 2, pz, logBlk);
        setLocal(px, baseY + 3, pz, logBlk);
      }
      for (let dz = 0; dz < 4; dz++) {
        for (let dx = 0; dx < 4; dx++) {
          setLocal(2 + dx, baseY + 4, 2 + dz, roofBlk);
        }
      }
      setLocal(3, baseY + 5, 3, BLOCK.GLOWSTONE);

      // Iconic Village Bell/Clock Tower (top-right quadrant)
      for (let dz = 0; dz < 5; dz++) {
        for (let dx = 0; dx < 5; dx++) {
          const edgeX = dx === 0 || dx === 4;
          const edgeZ = dz === 0 || dz === 4;
          for (let dy = 1; dy <= 10; dy++) {
            if (edgeX && edgeZ) setLocal(10 + dx, baseY + dy, 1 + dz, logBlk);
            else if (edgeX || edgeZ) {
              const openBell = dy >= 7 && dy <= 9 && (dx === 2 || dz === 2);
              const win = dy === 4 && (dx === 2 || dz === 2);
              setLocal(10 + dx, baseY + dy, 1 + dz, openBell ? BLOCK.AIR : (win ? BLOCK.GLASS : (dy <= 3 ? trimBlk : wallBlk)));
            } else {
              setLocal(10 + dx, baseY + dy, 1 + dz, dy === 6 || dy === 10 ? wallBlk : BLOCK.AIR);
            }
          }
          setLocal(10 + dx, baseY + 11, 1 + dz, roofBlk);
        }
      }
      // Spire + Glowing Gold Bell!
      for (let dz = 1; dz <= 3; dz++) for (let dx = 1; dx <= 3; dx++) setLocal(10 + dx, baseY + 12, 1 + dz, roofBlk);
      setLocal(12, baseY + 13, 3, logBlk);
      setLocal(12, baseY + 14, 3, BLOCK.GLOWSTONE);
      setLocal(12, baseY + 8, 3, BLOCK.GOLD_BLOCK);
      setLocal(12, baseY + 1, 5, BLOCK.AIR); setLocal(12, baseY + 2, 5, BLOCK.AIR);
      setLocal(11, baseY + 1, 2, BLOCK.BED_HEAD_N);
      setLocal(11, baseY + 1, 3, BLOCK.BED);

      // Market Stalls with Colorful Wool Awnings (bottom quadrants!)
      const buildStall = (sx, sz, woolA, woolB) => {
        for (let i = 0; i < 4; i++) {
          setLocal(sx + i, baseY + 1, sz, wallBlk);
          setLocal(sx + i, baseY + 3, sz, i % 2 === 0 ? woolA : woolB);
          setLocal(sx + i, baseY + 3, sz + 1, i % 2 === 0 ? woolA : woolB);
        }
        setLocal(sx, baseY + 2, sz, logBlk);
        setLocal(sx + 3, baseY + 2, sz, logBlk);
      };
      buildStall(2, 11, BLOCK.WOOL_RED, BLOCK.WOOL_WHITE);
      buildStall(10, 11, BLOCK.WOOL_BLUE, BLOCK.WOOL_YELLOW);
      addLamp(6, 9); addLamp(9, 6);
    } else if (vdx === 0 && vdz === -1) {
      // --- NORTH DISTRICT: Blacksmith Forge + 2-Story Manor House! ---
      buildDetailedHouse(1, 2, 6, 6, 3, { doorSide: 'south', beds: 1, chestTier: 'forge', furnace: true, chimney: true });
      buildDetailedHouse(9, 2, 6, 7, 3, { doorSide: 'west', beds: 2, chestTier: 'house', twoStory: true });
      addLamp(5, 11);
    } else if (vdx === 0 && vdz === 1) {
      // --- SOUTH DISTRICT: Twin Cozy Cottages with Beds & Gardens! ---
      buildDetailedHouse(1, 3, 5, 6, 3, { doorSide: 'east', beds: 1, chestTier: 'house' });
      buildDetailedHouse(10, 3, 5, 6, 3, { doorSide: 'west', beds: 2, furnace: true });
      addLamp(5, 2); addLamp(9, 10);
    } else if (vdx === 1 && vdz === 0) {
      // --- EAST DISTRICT: Grand Village Library + Cozy Inn! ---
      buildDetailedHouse(2, 1, 8, 5, 4, { doorSide: 'south', library: true, chestTier: 'library', chimney: false });
      buildDetailedHouse(3, 10, 7, 5, 3, { doorSide: 'north', beds: 2, chestTier: 'house' });
      addLamp(11, 5);
    } else if (vdx === -1 && vdz === 0) {
      // --- WEST DISTRICT: Lush Hydrated Wheat Farmlands + Rustic Farmhouse! ---
      const buildFarmPlot = (fx, fz, fw, fd) => {
        for (let dz = 0; dz < fd; dz++) {
          for (let dx = 0; dx < fw; dx++) {
            const border = dx === 0 || dx === fw - 1 || dz === 0 || dz === fd - 1;
            if (border) {
              setLocal(fx + dx, baseY, fz + dz, logBlk);
            } else if (dx === Math.floor(fw / 2)) {
              setLocal(fx + dx, baseY, fz + dz, BLOCK.WATER);
            } else {
              setLocal(fx + dx, baseY, fz + dz, BLOCK.FARMLAND_WET);
              const wStage = BLOCK.WHEAT_4 + ((dx + dz + variant) & 3);
              setLocal(fx + dx, baseY + 1, fz + dz, wStage);
            }
          }
        }
      };
      buildFarmPlot(1, 1, 7, 5);
      buildFarmPlot(9, 1, 6, 5);
      buildDetailedHouse(2, 10, 7, 5, 3, { doorSide: 'north', beds: 1, chestTier: 'house', chimney: false });
      addLamp(10, 10);
    } else if (Math.abs(vdx) === 2 || Math.abs(vdz) === 2) {
      // --- OUTER RING DISTRICTS (5x5 Grand Towns!): Windmills, Double Wheat Farms, Townhouses, Pastures & Gates! ---
      const dRoll = Math.floor(coordHash((vcx + vdx) * 31, (vcz + vdz) * 47, this.seed + 881) * 4);
      if (vdx === 0 && (vdz === -2 || vdz === 2)) {
        // Grand Village Entrance Gateway Arch + Flanking Guard Cottages!
        const gz = vdz === -2 ? 4 : 11;
        for (let dy = 1; dy <= 5; dy++) {
          setLocal(5, baseY + dy, gz, trimBlk);
          setLocal(9, baseY + dy, gz, trimBlk);
        }
        for (let gx = 5; gx <= 9; gx++) {
          setLocal(gx, baseY + 5, gz, logBlk);
          setLocal(gx, baseY + 6, gz, roofBlk);
        }
        setLocal(7, baseY + 5, gz, BLOCK.GLOWSTONE);
        buildDetailedHouse(1, vdz === -2 ? 7 : 1, 4, 5, 3, { doorSide: 'east', beds: 1, chestTier: 'house', chimney: false });
        buildDetailedHouse(11, vdz === -2 ? 7 : 1, 4, 5, 3, { doorSide: 'west', beds: 1, chimney: true });
      } else if (vdz === 0 && (vdx === -2 || vdx === 2)) {
        // East/West Entrance Arch + Tall Rustic Village Windmill!
        const gx = vdx === -2 ? 4 : 11;
        for (let dy = 1; dy <= 5; dy++) {
          setLocal(gx, baseY + dy, 5, trimBlk);
          setLocal(gx, baseY + dy, 9, trimBlk);
        }
        for (let gz = 5; gz <= 9; gz++) {
          setLocal(gx, baseY + 5, gz, logBlk);
          setLocal(gx, baseY + 6, gz, roofBlk);
        }
        setLocal(gx, baseY + 5, 7, BLOCK.GLOWSTONE);
        // Windmill Tower beside entrance
        const wx0 = vdx === -2 ? 8 : 2, wz0 = 1;
        for (let dy = 1; dy <= 10; dy++) {
          for (let dz = 0; dz < 4; dz++) {
            for (let dx = 0; dx < 4; dx++) {
              const e = dx === 0 || dx === 3 || dz === 0 || dz === 3;
              if (e) setLocal(wx0 + dx, baseY + dy, wz0 + dz, dy <= 3 ? trimBlk : wallBlk);
              else setLocal(wx0 + dx, baseY + dy, wz0 + dz, BLOCK.AIR);
            }
          }
        }
        // Wool windmill sails!
        for (let s = -3; s <= 3; s++) {
          if (wx0 + 2 + s >= 0 && wx0 + 2 + s < 16) setLocal(wx0 + 2 + s, baseY + 8, wz0, BLOCK.WOOL_WHITE);
          if (baseY + 8 + s > baseY + 2) setLocal(wx0 + 2, baseY + 8 + s, wz0, BLOCK.WOOL_WHITE);
        }
        setLocal(wx0 + 2, baseY + 8, wz0, logBlk);
      } else if (dRoll === 0) {
        // Expansive Irrigated Double Wheat Farm + Farmer Silo!
        for (const [fx, fz] of [[2, 2], [2, 9]]) {
          for (let dz = 0; dz < 5; dz++) {
            for (let dx = 0; dx < 11; dx++) {
              const border = dx === 0 || dx === 10 || dz === 0 || dz === 4;
              if (border) setLocal(fx + dx, baseY, fz + dz, logBlk);
              else if (dx === 5) setLocal(fx + dx, baseY, fz + dz, BLOCK.WATER);
              else {
                setLocal(fx + dx, baseY, fz + dz, BLOCK.FARMLAND_WET);
                setLocal(fx + dx, baseY + 1, fz + dz, BLOCK.WHEAT_4 + ((dx + dz) & 3));
              }
            }
          }
        }
        addLamp(13, 7);
      } else if (dRoll === 1) {
        // Grand 2-Story Townhouse + Real Fenced Animal Pasture with Openable Gate!
        buildDetailedHouse(2, 2, 6, 6, 3, { doorSide: 'south', beds: 2, chestTier: 'house', twoStory: true });
        for (let dz = 0; dz < 5; dz++) {
          for (let dx = 0; dx < 6; dx++) {
            if (dx === 0 || dx === 5 || dz === 0 || dz === 4) {
              setLocal(9 + dx, baseY + 1, 9 + dz, (dz === 0 && dx === 2) ? BLOCK.OAK_FENCE_GATE : BLOCK.OAK_FENCE);
            }
          }
        }
        addLamp(10, 4);
      } else if (dRoll === 2) {
        // Artisan Blacksmith / Bakery Row!
        buildDetailedHouse(2, 2, 6, 5, 3, { doorSide: 'south', beds: 1, chestTier: 'forge', furnace: true, chimney: true });
        buildDetailedHouse(9, 8, 5, 6, 3, { doorSide: 'west', beds: 2, chestTier: 'house' });
        addLamp(8, 3);
      } else {
        // Cozy Twin Cottages with Flower Courtyard!
        buildDetailedHouse(2, 2, 5, 5, 3, { doorSide: 'east', beds: 1, chestTier: 'house' });
        buildDetailedHouse(9, 9, 5, 5, 3, { doorSide: 'north', beds: 1 });
        setLocal(10, baseY + 1, 4, BLOCK.FLOWER_RED);
        setLocal(11, baseY + 1, 5, BLOCK.FLOWER_YELLOW);
        addLamp(8, 8);
      }
    } else {
      // --- INNER CORNER DISTRICTS: Varied Cottages, Blacksmiths, Markets & Orchards! ---
      const doorDir = vdz < 0 ? 'south' : 'north';
      const isTwoStory = ((vdx + vdz + variant) & 1) === 0;
      buildDetailedHouse(3, 3, 6, 6, 3, { doorSide: doorDir, beds: isTwoStory ? 2 : 1, chestTier: (vdx > 0 ? 'house' : 'library'), twoStory: isTwoStory });
      addLamp(3, 11);
      // Plant a scenic orchard tree strictly in a verified open corner yard (never overlapping houses!)
      const tx = vdx === -1 ? 13 : 2;
      const tz = vdz === -1 ? 13 : 2;
      const yardLog = isSavanna ? BLOCK.ACACIA_LOG : (isCherry ? BLOCK.CHERRY_LOG : (isJungle ? BLOCK.JUNGLE_LOG : (isSnow ? BLOCK.SPRUCE_LOG : BLOCK.OAK_LOG)));
      const yardLeaf = isSavanna ? BLOCK.ACACIA_LEAVES : (isCherry ? BLOCK.CHERRY_LEAVES : (isJungle ? BLOCK.JUNGLE_LEAVES : (isSnow ? BLOCK.SPRUCE_LEAVES : BLOCK.OAK_LEAVES)));
      let yardClear = true;
      for (let dz = -2; dz <= 2 && yardClear; dz++) {
        for (let dx = -2; dx <= 2 && yardClear; dx++) {
          for (let dy = 1; dy <= 5; dy++) {
            const bx = tx + dx, bz = tz + dz;
            if (bx < 1 || bx > 14 || bz < 1 || bz > 14) continue;
            if (getLocal(bx, baseY + dy, bz) !== BLOCK.AIR) { yardClear = false; break; }
          }
        }
      }
      if (yardClear) {
        for (let ty = 1; ty <= 4; ty++) setLocal(tx, baseY + ty, tz, yardLog);
        for (let dy = 3; dy <= 5; dy++) {
          const rad = dy === 5 ? 1 : 2;
          for (let ldz = -rad; ldz <= rad; ldz++) {
            for (let ldx = -rad; ldx <= rad; ldx++) {
              if (tx + ldx >= 1 && tx + ldx <= 14 && tz + ldz >= 1 && tz + ldz <= 14) {
                if (getLocal(tx + ldx, baseY + dy, tz + ldz) === BLOCK.AIR) {
                  setLocal(tx + ldx, baseY + dy, tz + ldz, yardLeaf);
                }
              }
            }
          }
        }
      }
    }

    // Register center village record for Villager/Golem spawning & Radar marker!
    if (vdx === 0 && vdz === 0) {
      const vKey = this.chunkKey(vcx, vcz);
      if (!this.villageChunks.has(vKey)) {
        this.villageChunks.set(vKey, {
          x: ox + 8,
          y: baseY + 1,
          z: oz + 8,
          biome,
          spawned: false
        });
      }
    }
  }

  // Deterministic Biome-Specific World Structure Locator (10 unique structures + 3 variants each, nicely spread out!)
  getStructureTypeForChunk(cx, cz) {
    if (this.worldType === 'flat' || !this.generateStructures) return null;
    if (this.getMegaStructureForChunk(cx, cz)) return null;
    if (this.getVillageForChunk(cx, cz)) return null;
    // Wide 10x10 chunk grid (160x160 blocks) so landmarks feel grand & well-spaced!
    const gx = Math.floor(cx / 10);
    const gz = Math.floor(cz / 10);
    const ox = Math.floor(coordHash(gx * 43, gz * 67, this.seed + 811) * 6) + 2;
    const oz = Math.floor(coordHash(gx * 71, gz * 29, this.seed + 823) * 6) + 2;
    if (cx !== gx * 10 + ox || cz !== gz * 10 + oz) return null;
    const roll = coordHash(cx * 31, cz * 29, this.seed + 777);
    if (roll < 0.22) return null;

    const col = this.sampleColumn(cx * CHUNK_SIZE + 8, cz * CHUNK_SIZE + 8);
    const h = col.height;
    const b = col.biome;
    if (h > CHUNK_HEIGHT - 28) return null;

    // Ocean & Deep Ocean & Coastal Seabed -> Sunken & Half-Buried Shipwrecks!
    if (b === 'Ocean' || b === 'Deep Ocean' || h <= SEA_LEVEL - 4) {
      return h <= SEA_LEVEL - 3 ? 'shipwreck' : null;
    }
    if (h <= SEA_LEVEL + 1 && b !== 'Swamp') return null;

    if (b === 'Desert') return roll > 0.70 ? 'desert_pyramid' : (roll > 0.44 ? 'desert_oasis' : 'tent_camp');
    if (b === 'Badlands') return roll > 0.65 ? 'desert_pyramid' : (roll > 0.42 ? 'ruined_portal' : 'tent_camp');
    if (b === 'Jungle') return roll > 0.45 ? 'jungle_temple' : 'tent_camp';
    if (b === 'Snowy Taiga') return roll > 0.46 ? 'igloo' : 'tent_camp';
    if (b === 'Swamp') return 'witch_hut';
    if (b === 'Savanna') return roll > 0.50 ? 'savanna_outpost' : 'tent_camp';
    if (b === 'Mountains') return h < SEA_LEVEL + 72 ? (roll > 0.62 ? 'watchtower' : 'ruined_portal') : null;
    if (b === 'Cherry Grove') return roll > 0.64 ? 'ruined_portal' : (roll > 0.42 ? 'tent_camp' : 'watchtower');
    // Plains, Forest, Birch Forest -> Watchtowers, Adventurer Tent Camps & Ruined Portals!
    if (roll > 0.72) return 'watchtower';
    if (roll > 0.45) return 'tent_camp';
    return 'ruined_portal';
  }

  buildWorldStructure(structType, cx, cz, ox, oz, heights, setLocal, getLocal, noTreeMask) {
    const th = heights[8 + 8 * CHUNK_SIZE];
    const markNoTrees = (x0, z0, x1, z1, pad = 4) => {
      const a0 = Math.max(0, x0 - pad), a1 = Math.min(15, x1 + pad);
      const b0 = Math.max(0, z0 - pad), b1 = Math.min(15, z1 + pad);
      for (let z = b0; z <= b1; z++) {
        for (let x = a0; x <= a1; x++) noTreeMask[x + (z << 4)] = 1;
      }
    };
    const fillFoundation = (x0, z0, x1, z1, baseY, mat) => {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const ch = heights[x + (z << 4)];
          for (let y = Math.max(1, Math.min(ch, baseY - 6)); y <= baseY; y++) {
            setLocal(x, y, z, mat);
          }
          // Clear terrain poking up inside footprint
          for (let y = baseY + 1; y <= Math.min(CHUNK_HEIGHT - 2, ch + 14); y++) {
            setLocal(x, y, z, BLOCK.AIR);
          }
        }
      }
    };
    const placeChest = (lx, ly, lz, items) => {
      setLocal(lx, ly, lz, BLOCK.CHEST);
      const wKey = `${ox + lx},${ly},${oz + lz}`;
      if (!this.chests.has(wKey)) {
        const loot = new Array(27).fill(null);
        for (let i = 0; i < items.length && i < 27; i++) loot[i] = items[i];
        this.chests.set(wKey, loot);
      }
    };

    const variant = Math.floor(coordHash(cx * 53, cz * 97, this.seed + 1337) * 3);

    if (structType === 'shipwreck') {
      // 3 Distinct Ocean Shipwreck Variants (Oak Galleon, Tilted Spruce Brig, Half-Buried Birch Caravel!)
      const hullPlanks = variant === 0 ? BLOCK.OAK_PLANKS : (variant === 1 ? BLOCK.SPRUCE_PLANKS : BLOCK.BIRCH_PLANKS);
      const hullLog = variant === 0 ? BLOCK.OAK_LOG : (variant === 1 ? BLOCK.SPRUCE_LOG : BLOCK.BIRCH_LOG);
      const sailA = variant === 0 ? BLOCK.WOOL_WHITE : (variant === 1 ? BLOCK.WOOL_BLUE : BLOCK.WOOL_RED);
      const sailB = variant === 0 ? BLOCK.WOOL_RED : BLOCK.WOOL_WHITE;
      const baseY = Math.max(12, Math.min(SEA_LEVEL - 4, th));
      const tilt = variant === 1 ? 1 : 0; // Variant 1 heels sideways on seabed!
      const buried = variant === 2 ? 1 : 0; // Variant 2 is half-buried in ocean sand!
      const x0 = 5, z0 = 1, w = 6, len = 14;
      for (let dz = 0; dz < len; dz++) {
        const taper = (dz === 0 || dz === len - 1) ? 2 : ((dz === 1 || dz === len - 2) ? 1 : 0);
        for (let dx = taper; dx < w - taper; dx++) {
          const yOff = (tilt && dx >= 3) ? 1 : 0;
          const by = baseY - buried + yOff;
          const isRim = dx === taper || dx === w - 1 - taper || dz === 0 || dz === len - 1;
          // Keel & deck floor
          setLocal(x0 + dx, by, z0 + dz, hullLog);
          setLocal(x0 + dx, by + 1, z0 + dz, isRim ? hullPlanks : BLOCK.WATER);
          setLocal(x0 + dx, by + 2, z0 + dz, isRim ? hullPlanks : BLOCK.WATER);
          if (dz >= 2 && dz <= len - 3) {
            setLocal(x0 + dx, by + 3, z0 + dz, hullPlanks); // main deck
          }
          // Stern Captain's Cabin (dz >= 9)
          if (dz >= 9 && dz <= len - 2) {
            for (let cy = 4; cy <= 6; cy++) {
              const cabEdge = isRim || dz === 9 || cy === 6;
              if (cabEdge) {
                const isPort = cy === 5 && (dx === taper || dx === w - 1 - taper) && dz === 11;
                setLocal(x0 + dx, by + cy, z0 + dz, isPort ? BLOCK.GLASS : hullPlanks);
              } else {
                setLocal(x0 + dx, by + cy, z0 + dz, BLOCK.WATER);
              }
            }
          }
        }
      }
      // Tall Mast & Billowing/Tattered Wool Sail!
      const mastH = variant === 0 ? 11 : (variant === 1 ? 8 : 6);
      for (let my = 1; my <= mastH; my++) {
        setLocal(x0 + 3, baseY - buried + my, z0 + 6, hullLog);
      }
      if (variant !== 2) {
        const sailY0 = baseY - buried + 5;
        for (let sy = 0; sy < 4; sy++) {
          for (let sx = 0; sx < w; sx++) {
            if (variant === 1 && ((sx + sy) % 3 === 0)) continue; // tattered sail on tilted brig!
            setLocal(x0 + sx, sailY0 + sy, z0 + 5, (sy & 1) === 0 ? sailA : sailB);
          }
        }
      }
      // Captain's Treasure Chest & Supply Chest!
      placeChest(x0 + 3, baseY - buried + 4, z0 + 11, [
        { id: 'emerald', count: 4 + variant * 2 },
        { id: 'gold_ingot', count: 5 + variant * 2 },
        { id: 'diamond', count: 1 + (variant === 0 ? 2 : 1) },
        { id: 'iron_ingot', count: 6 },
        { id: 'bread', count: 6 },
        { id: 'golden_sword', count: 1, durability: 64 }
      ]);
      placeChest(x0 + 2, baseY - buried + 1, z0 + 4, [
        { id: 'wheat', count: 8 },
        { id: 'wheat_seeds', count: 10 },
        { id: 'coal', count: 12 },
        { id: 'iron_shovel', count: 1, durability: 251 },
        { id: 'iron_hoe', count: 1, durability: 251 }
      ]);
      return;
    } else if (structType === 'tent_camp') {
      // 3 Distinct Explorer & Nomad Tent Camp Variants (Striped A-Frame, Blue Pavilion, Green Twin Ranger Camp!)
      const x0 = 3, z0 = 3, w = 10, d = 10;
      markNoTrees(x0 - 1, z0 - 1, x0 + w, z0 + d, 4);
      fillFoundation(x0, z0, x0 + w - 1, z0 + d - 1, th, BLOCK.GRASS);
      // Natural packed dirt path clearing around campfire
      for (let dz = 2; dz <= d - 3; dz++) {
        for (let dx = 2; dx <= w - 3; dx++) {
          setLocal(x0 + dx, th, z0 + dz, BLOCK.DIRT_PATH);
        }
      }
      const woolA = variant === 0 ? BLOCK.WOOL_RED : (variant === 1 ? BLOCK.WOOL_BLUE : BLOCK.WOOL_GREEN);
      const woolB = variant === 0 ? BLOCK.WOOL_WHITE : (variant === 1 ? BLOCK.WOOL_YELLOW : BLOCK.WOOL_WHITE);
      const pole = variant === 2 ? BLOCK.SPRUCE_LOG : BLOCK.OAK_LOG;

      // Pitched A-Frame Tent (left/back side of camp)
      const tx = x0 + 1, tz = z0 + 1, tw = 5, td = 6;
      for (let dz = 0; dz < td; dz++) {
        for (let dx = 0; dx < tw; dx++) {
          const isBack = dz === 0;
          const isFront = dz === td - 1;
          const distMid = Math.abs(dx - 2);
          const roofY = 3 - distMid; // peak at dx=2 (dy=3), eaves at dx=0,4 (dy=1)
          for (let dy = 1; dy <= roofY; dy++) {
            const stripe = ((dz + dx) & 1) === 0 ? woolA : woolB;
            if (dy === roofY) {
              setLocal(tx + dx, th + dy, tz + dz, stripe);
            } else if (isBack) {
              setLocal(tx + dx, th + dy, tz + dz, woolA);
            } else if (!isFront && (dx === 0 || dx === tw - 1)) {
              setLocal(tx + dx, th + dy, tz + dz, stripe);
            }
          }
        }
      }
      // Wooden ridge poles at front & back
      for (let py = 1; py <= 3; py++) {
        setLocal(tx + 2, th + py, tz, pole);
        if (py === 3) setLocal(tx + 2, th + py, tz + td - 1, pole);
      }
      // Cozy tent interior: Bed, Crafting Table & Explorer Chest
      setLocal(tx + 1, th + 1, tz + 2, BLOCK.BED_HEAD_N);
      setLocal(tx + 1, th + 1, tz + 3, BLOCK.BED);
      setLocal(tx + 3, th + 1, tz + 1, BLOCK.CRAFTING_TABLE);
      if (variant === 1) setLocal(tx + 3, th + 1, tz + 2, BLOCK.FURNACE);
      placeChest(tx + 3, th + 1, tz + 3, [
        { id: 'bread', count: 5 },
        { id: 'cooked_beef', count: 3 },
        { id: 'torch', count: 14 },
        { id: 'iron_shovel', count: 1, durability: 251 },
        { id: 'wheat_seeds', count: 6 },
        { id: 'emerald', count: 3 }
      ]);

      // Variant 2 adds a second smaller side tent facing the campfire!
      if (variant === 2) {
        const sx = x0 + 6, sz = z0 + 1;
        for (let dz = 0; dz < 4; dz++) {
          for (let dx = 0; dx < 3; dx++) {
            const ry = dx === 1 ? 2 : 1;
            setLocal(sx + dx, th + ry, sz + dz, (dz & 1) ? woolB : woolA);
            if (dz === 0 && ry > 1) setLocal(sx + dx, th + 1, sz, woolA);
          }
        }
      }

      // Outdoor Stone-Ring Campfire + Log Seating + Lantern Post!
      const fx = x0 + 7, fz = z0 + 7;
      setLocal(fx, th, fz, BLOCK.COBBLESTONE);
      setLocal(fx, th + 1, fz, BLOCK.TORCH);
      setLocal(fx - 1, th, fz, BLOCK.COBBLESTONE);
      setLocal(fx + 1, th, fz, BLOCK.COBBLESTONE);
      setLocal(fx, th, fz - 1, BLOCK.COBBLESTONE);
      setLocal(fx, th, fz + 1, BLOCK.COBBLESTONE);
      setLocal(fx - 2, th + 1, fz, pole);
      setLocal(fx, th + 1, fz - 2, pole);
      for (let ly = 1; ly <= 3; ly++) setLocal(x0 + 8, th + ly, z0 + 5, pole);
      setLocal(x0 + 8, th + 4, z0 + 5, BLOCK.GLOWSTONE);
      return;
    } else if (structType === 'watchtower') {
      const x0 = 5, z0 = 5, w = 6, hT = 10 + variant * 2;
      const wallA = variant === 0 ? BLOCK.STONE_BRICKS : (variant === 1 ? BLOCK.MOSSY_COBBLESTONE : BLOCK.BRICKS);
      const wallB = variant === 0 ? BLOCK.COBBLESTONE : (variant === 1 ? BLOCK.STONE_BRICKS : BLOCK.STONE_BRICKS);
      const floorWood = variant === 1 ? BLOCK.SPRUCE_PLANKS : BLOCK.OAK_PLANKS;
      markNoTrees(x0, z0, x0 + w - 1, z0 + w - 1, 5);
      fillFoundation(x0, z0, x0 + w - 1, z0 + w - 1, th, BLOCK.COBBLESTONE);
      for (let dz = 0; dz < w; dz++) {
        for (let dx = 0; dx < w; dx++) {
          for (let dy = 1; dy <= hT; dy++) {
            const edgeX = dx === 0 || dx === w - 1;
            const edgeZ = dz === 0 || dz === w - 1;
            if (edgeX && edgeZ) setLocal(x0 + dx, th + dy, z0 + dz, wallA);
            else if (edgeX || edgeZ) {
              const isWin = (dy === 4 || dy === 8) && (dx === 2 || dx === 3 || dz === 2 || dz === 3);
              setLocal(x0 + dx, th + dy, z0 + dz, isWin ? BLOCK.GLASS : (dy % 2 === 0 ? wallA : wallB));
            } else {
              setLocal(x0 + dx, th + dy, z0 + dz, dy === 5 || dy === hT ? floorWood : BLOCK.AIR);
            }
          }
          if ((dx === 0 || dx === w - 1 || dz === 0 || dz === w - 1) && (dx + dz) % 2 === 0) {
            setLocal(x0 + dx, th + hT + 1, z0 + dz, wallA);
          }
        }
      }
      setLocal(x0 + 2, th + 1, z0, BLOCK.AIR);
      setLocal(x0 + 2, th + 2, z0, BLOCK.AIR);
      for (let ly = 1; ly <= hT; ly++) setLocal(x0 + 1, th + ly, z0 + 4, BLOCK.LADDER);
      setLocal(x0, th + hT + 2, z0, BLOCK.GLOWSTONE);
      setLocal(x0 + w - 1, th + hT + 2, z0 + w - 1, BLOCK.GLOWSTONE);
      placeChest(x0 + 3, th + 1, z0 + 3, [
        { id: 'emerald', count: 5 },
        { id: 'iron_sword', count: 1, durability: 251 },
        { id: 'diamond', count: 2 },
        { id: 'bread', count: 6 },
        { id: 'torch', count: 16 }
      ]);
    } else if (structType === 'desert_pyramid') {
      // Stepped Sandstone & Terracotta Desert Temple with 3 Accent Variants!
      const x0 = 2, z0 = 2, size = 12;
      const accent = variant === 0 ? BLOCK.TERRACOTTA_ORANGE : (variant === 1 ? BLOCK.TERRACOTTA_RED : BLOCK.GOLD_BLOCK);
      markNoTrees(x0, z0, x0 + size - 1, z0 + size - 1, 4);
      fillFoundation(x0, z0, x0 + size - 1, z0 + size - 1, th, BLOCK.SANDSTONE);
      for (let layer = 0; layer < 6; layer++) {
        const min = layer;
        const max = size - 1 - layer;
        for (let dz = min; dz <= max; dz++) {
          for (let dx = min; dx <= max; dx++) {
            const isRim = dx === min || dx === max || dz === min || dz === max || layer === 5;
            if (isRim) {
              const isAccent = (layer === 2 && (dx === 5 || dx === 6 || dz === 5 || dz === 6)) || layer === 5;
              setLocal(x0 + dx, th + 1 + layer, z0 + dz, isAccent ? accent : BLOCK.SANDSTONE);
            } else {
              setLocal(x0 + dx, th + 1 + layer, z0 + dz, BLOCK.AIR);
            }
          }
        }
      }
      // Grand front doorway & interior torch sconces + sandstone pillars
      for (let dy = 1; dy <= 3; dy++) {
        setLocal(x0 + 5, th + dy, z0, BLOCK.AIR);
        setLocal(x0 + 6, th + dy, z0, BLOCK.AIR);
        setLocal(x0 + 5, th + dy, z0 + 1, BLOCK.AIR);
        setLocal(x0 + 6, th + dy, z0 + 1, BLOCK.AIR);
      }
      setLocal(x0 + 4, th + 3, z0 + 4, BLOCK.TORCH);
      setLocal(x0 + 7, th + 3, z0 + 7, BLOCK.TORCH);
      setLocal(x0 + 5, th + 1, z0 + 5, BLOCK.TERRACOTTA_ORANGE);
      setLocal(x0 + 6, th + 1, z0 + 6, BLOCK.TERRACOTTA_ORANGE);
      placeChest(x0 + 5, th + 1, z0 + 6, [
        { id: 'gold_ingot', count: 6 },
        { id: 'raw_gold', count: 5 },
        { id: 'emerald', count: 4 },
        { id: 'flint_and_steel', count: 1, durability: 64 },
        { id: 'tnt', count: 4 },
        { id: 'golden_helmet', count: 1, durability: 112 }
      ]);
    } else if (structType === 'desert_oasis') {
      // Desert Sandstone Well & Oasis Pool (3 Variants: Classic Canopy, Twin Pillar Shrine, Lush Palm Oasis!)
      const x0 = 5, z0 = 5;
      const trim = variant === 1 ? BLOCK.TERRACOTTA_ORANGE : (variant === 2 ? BLOCK.GOLD_BLOCK : BLOCK.SANDSTONE);
      markNoTrees(x0 - 1, z0 - 1, x0 + 6, z0 + 6, 4);
      fillFoundation(x0, z0, x0 + 5, z0 + 5, th, BLOCK.SANDSTONE);
      for (let dz = 1; dz <= 4; dz++) {
        for (let dx = 1; dx <= 4; dx++) {
          const edge = dx === 1 || dx === 4 || dz === 1 || dz === 4;
          setLocal(x0 + dx, th, z0 + dz, edge ? BLOCK.SANDSTONE : BLOCK.WATER);
          setLocal(x0 + dx, th - 1, z0 + dz, edge ? BLOCK.SANDSTONE : BLOCK.WATER);
          setLocal(x0 + dx, th + 1, z0 + dz, edge ? trim : BLOCK.AIR);
        }
      }
      for (const [px, pz] of [[1, 1], [4, 1], [1, 4], [4, 4]]) {
        for (let dy = 2; dy <= 4 + (variant === 1 ? 1 : 0); dy++) setLocal(x0 + px, th + dy, z0 + pz, BLOCK.SANDSTONE);
      }
      for (let dz = 1; dz <= 4; dz++) {
        for (let dx = 1; dx <= 4; dx++) setLocal(x0 + dx, th + 5 + (variant === 1 ? 1 : 0), z0 + dz, variant === 2 ? BLOCK.WOOL_YELLOW : BLOCK.SANDSTONE);
      }
      setLocal(x0 + 2, th + 6 + (variant === 1 ? 1 : 0), z0 + 2, BLOCK.GLOWSTONE);
      placeChest(x0 + 0, th + 1, z0 + 2, [
        { id: 'bread', count: 5 },
        { id: 'apple', count: 4 },
        { id: 'gold_ingot', count: 3 },
        { id: 'flint', count: 3 }
      ]);
    } else if (structType === 'jungle_temple') {
      // Mossy Cobblestone Ancient Jungle Temple (3 Variants: Classic Mossy, Tall Pyramid Spire, Brick Sanctuary!)
      const x0 = 3, z0 = 3, w = 10, d = 10;
      const bodyA = variant === 2 ? BLOCK.STONE_BRICKS : BLOCK.MOSSY_COBBLESTONE;
      const bodyB = variant === 1 ? BLOCK.COBBLESTONE : BLOCK.STONE_BRICKS;
      const topH = variant === 1 ? 8 : 6;
      markNoTrees(x0, z0, x0 + w - 1, z0 + d - 1, 5);
      fillFoundation(x0, z0, x0 + w - 1, z0 + d - 1, th, bodyA);
      for (let dz = 0; dz < d; dz++) {
        for (let dx = 0; dx < w; dx++) {
          const edge = dx === 0 || dx === w - 1 || dz === 0 || dz === d - 1;
          for (let dy = 1; dy <= topH; dy++) {
            const wallBlk = ((dx + dy + dz) % 3 === 0) ? bodyB : bodyA;
            if (edge || dy === topH) setLocal(x0 + dx, th + dy, z0 + dz, wallBlk);
            else setLocal(x0 + dx, th + dy, z0 + dz, BLOCK.AIR);
          }
          // Stepped temple crown
          if (dx >= 2 && dx <= w - 3 && dz >= 2 && dz <= d - 3) {
            setLocal(x0 + dx, th + topH + 1, z0 + dz, bodyA);
            if (dx >= 3 && dx <= w - 4 && dz >= 3 && dz <= d - 4) {
              setLocal(x0 + dx, th + topH + 2, z0 + dz, variant === 2 ? BLOCK.GOLD_BLOCK : bodyB);
            }
          }
        }
      }
      // Entrance + torches + overgrown vine patches
      for (let dy = 1; dy <= 3; dy++) {
        setLocal(x0 + 4, th + dy, z0, BLOCK.AIR);
        setLocal(x0 + 5, th + dy, z0, BLOCK.AIR);
      }
      setLocal(x0 + 3, th + 3, z0 + 1, BLOCK.TORCH);
      setLocal(x0 + 6, th + 3, z0 + 1, BLOCK.TORCH);
      setLocal(x0 + 4, th + 3, z0 + 7, BLOCK.TORCH);
      placeChest(x0 + 5, th + 1, z0 + 7, [
        { id: 'diamond', count: 3 },
        { id: 'emerald', count: 6 },
        { id: 'gold_ingot', count: 5 },
        { id: 'golden_pickaxe', count: 1, durability: 64 },
        { id: 'flint_and_steel', count: 1, durability: 64 }
      ]);
    } else if (structType === 'igloo') {
      // Cozy Snow & Packed Ice Igloo with Bed, Furnace, Crafting Table & Chest!
      const x0 = 4, z0 = 4, w = 8, d = 8;
      markNoTrees(x0, z0, x0 + w - 1, z0 + d - 1, 5);
      fillFoundation(x0, z0, x0 + w - 1, z0 + d - 1, th, BLOCK.SNOW);
      for (let dz = 0; dz < d; dz++) {
        for (let dx = 0; dx < w; dx++) {
          const dist = Math.hypot(dx - 3.5, dz - 3.5);
          if (dist > 4.2) continue;
          setLocal(x0 + dx, th, z0 + dz, (dx >= 2 && dx <= 5 && dz >= 2 && dz <= 5) ? (variant === 0 ? BLOCK.WOOL_RED : (variant === 1 ? BLOCK.WOOL_BLUE : BLOCK.WOOL_GREEN)) : BLOCK.SNOW);
          for (let dy = 1; dy <= 4; dy++) {
            const rLim = dy === 4 ? 2.1 : (dy === 3 ? 3.2 : 4.0);
            const rIn = dy === 4 ? 0 : (dy === 3 ? 2.1 : 3.0);
            if (dist <= rLim && dist >= rIn) {
              const isWin = dy === 2 && (dx === 0 || dx === w - 1) && (dz === 3 || dz === 4);
              setLocal(x0 + dx, th + dy, z0 + dz, isWin ? BLOCK.PACKED_ICE : BLOCK.SNOW);
            } else if (dist < rIn) {
              setLocal(x0 + dx, th + dy, z0 + dz, BLOCK.AIR);
            }
          }
        }
      }
      // Tunnel entryway facing North (-Z)
      for (let dz = -1; dz <= 1; dz++) {
        setLocal(x0 + 3, th + 1, z0 + dz, BLOCK.AIR);
        setLocal(x0 + 3, th + 2, z0 + dz, BLOCK.AIR);
        setLocal(x0 + 4, th + 1, z0 + dz, BLOCK.AIR);
        setLocal(x0 + 4, th + 2, z0 + dz, BLOCK.AIR);
        setLocal(x0 + 2, th + 1, z0 + dz, BLOCK.SNOW);
        setLocal(x0 + 2, th + 2, z0 + dz, BLOCK.SNOW);
        setLocal(x0 + 5, th + 1, z0 + dz, BLOCK.SNOW);
        setLocal(x0 + 5, th + 2, z0 + dz, BLOCK.SNOW);
        setLocal(x0 + 3, th + 3, z0 + dz, BLOCK.SNOW);
        setLocal(x0 + 4, th + 3, z0 + dz, BLOCK.SNOW);
      }
      setLocal(x0 + 2, th + 1, z0 + 4, BLOCK.CRAFTING_TABLE);
      setLocal(x0 + 2, th + 1, z0 + 5, BLOCK.FURNACE);
      setLocal(x0 + 5, th + 1, z0 + 3, BLOCK.BED_HEAD_N);
      setLocal(x0 + 5, th + 1, z0 + 4, BLOCK.BED);
      setLocal(x0 + 3, th + 3, z0 + 4, BLOCK.TORCH);
      placeChest(x0 + 4, th + 1, z0 + 5, [
        { id: 'apple', count: 5 },
        { id: 'coal', count: 10 },
        { id: 'iron_ingot', count: 4 },
        { id: 'cooked_salmon', count: 4 },
        { id: 'flint_and_steel', count: 1, durability: 64 }
      ]);
    } else if (structType === 'witch_hut') {
      // Elevated Swamp Stilted Witch Cabin (3 Timber Variants: Spruce, Oak, Dark Birch)!
      const wLog = variant === 0 ? BLOCK.SPRUCE_LOG : (variant === 1 ? BLOCK.OAK_LOG : BLOCK.BIRCH_LOG);
      const wPlank = variant === 0 ? BLOCK.SPRUCE_PLANKS : (variant === 1 ? BLOCK.OAK_PLANKS : BLOCK.BIRCH_PLANKS);
      const x0 = 4, z0 = 4, w = 7, d = 8;
      const deckY = Math.max(th, SEA_LEVEL) + 2;
      markNoTrees(x0, z0, x0 + w - 1, z0 + d - 1, 5);
      // Clear above water/ground
      for (let dz = 0; dz < d; dz++) {
        for (let dx = 0; dx < w; dx++) {
          for (let y = deckY; y <= deckY + 8; y++) setLocal(x0 + dx, y, z0 + dz, BLOCK.AIR);
        }
      }
      // 4 sturdy stilts down into mud/water
      for (const [sx, sz] of [[0, 0], [w - 1, 0], [0, d - 1], [w - 1, d - 1]]) {
        for (let y = Math.max(1, SEA_LEVEL - 4); y <= deckY + 4; y++) {
          setLocal(x0 + sx, y, z0 + sz, wLog);
        }
      }
      // Deck floor, cabin walls & gabled roof
      for (let dz = 0; dz < d; dz++) {
        for (let dx = 0; dx < w; dx++) {
          setLocal(x0 + dx, deckY, z0 + dz, wPlank);
          if (dz >= 2) {
            const edge = dx === 0 || dx === w - 1 || dz === 2 || dz === d - 1;
            for (let dy = 1; dy <= 3; dy++) {
              if (edge) {
                const isWin = dy === 2 && ((dx === 0 || dx === w - 1) && dz === 5);
                setLocal(x0 + dx, deckY + dy, z0 + dz, isWin ? BLOCK.GLASS : wPlank);
              }
            }
            setLocal(x0 + dx, deckY + 4, z0 + dz, wLog);
          }
        }
      }
      setLocal(x0 + 3, deckY + 1, z0 + 2, BLOCK.AIR);
      setLocal(x0 + 3, deckY + 2, z0 + 2, BLOCK.AIR);
      setLocal(x0 + 1, deckY + 1, z0 + 6, BLOCK.CRAFTING_TABLE);
      setLocal(x0 + 5, deckY + 3, z0 + 3, BLOCK.TORCH);
      placeChest(x0 + 5, deckY + 1, z0 + 6, [
        { id: 'gunpowder', count: 6 },
        { id: 'flint_and_steel', count: 1, durability: 64 },
        { id: 'apple', count: 4 },
        { id: 'emerald', count: 3 },
        { id: 'bone', count: 5 }
      ]);
    } else if (structType === 'savanna_outpost') {
      // Acacia Timber Lookout Outpost with Warm Wool Banners!
      const x0 = 5, z0 = 5, w = 6, hT = 9;
      markNoTrees(x0, z0, x0 + w - 1, z0 + w - 1, 5);
      fillFoundation(x0, z0, x0 + w - 1, z0 + w - 1, th, BLOCK.COBBLESTONE);
      for (let dz = 0; dz < w; dz++) {
        for (let dx = 0; dx < w; dx++) {
          const corner = (dx === 0 || dx === w - 1) && (dz === 0 || dz === w - 1);
          const edge = dx === 0 || dx === w - 1 || dz === 0 || dz === w - 1;
          for (let dy = 1; dy <= hT; dy++) {
            if (corner) setLocal(x0 + dx, th + dy, z0 + dz, BLOCK.ACACIA_LOG);
            else if (edge && (dy <= 4 || dy === hT)) setLocal(x0 + dx, th + dy, z0 + dz, BLOCK.ACACIA_PLANKS);
            else if (!edge && (dy === 5 || dy === hT - 1)) setLocal(x0 + dx, th + dy, z0 + dz, BLOCK.ACACIA_PLANKS);
            else setLocal(x0 + dx, th + dy, z0 + dz, BLOCK.AIR);
          }
          // Canopy roof overhang (3 vibrant banner palettes!)
          const canA = variant === 0 ? BLOCK.WOOL_RED : (variant === 1 ? BLOCK.WOOL_BLUE : BLOCK.WOOL_GREEN);
          const canB = variant === 0 ? BLOCK.WOOL_YELLOW : BLOCK.WOOL_WHITE;
          setLocal(x0 + dx, th + hT + 1, z0 + dz, edge ? canA : canB);
        }
      }
      setLocal(x0 + 2, th + 1, z0, BLOCK.AIR);
      setLocal(x0 + 2, th + 2, z0, BLOCK.AIR);
      for (let ly = 1; ly <= hT - 1; ly++) setLocal(x0 + 1, th + ly, z0 + 4, BLOCK.LADDER);
      setLocal(x0 + 2, th + hT, z0 + 2, BLOCK.TORCH);
      placeChest(x0 + 3, th + 6, z0 + 3, [
        { id: 'gold_ingot', count: 4 },
        { id: 'iron_axe', count: 1, durability: 251 },
        { id: 'steak', count: 5 },
        { id: 'flint_and_steel', count: 1, durability: 64 },
        { id: 'acacia_log', count: 12 }
      ]);
    } else if (structType === 'ruined_portal') {
      // Ancient Cracked Obsidian Monolith Arch with Gold Crown & Ruin Chest!
      const x0 = 4, z0 = 5, w = 8, d = 6;
      markNoTrees(x0, z0, x0 + w - 1, z0 + d - 1, 5);
      fillFoundation(x0, z0, x0 + w - 1, z0 + d - 1, th, BLOCK.MOSSY_COBBLESTONE);
      for (let dz = 0; dz < d; dz++) {
        for (let dx = 0; dx < w; dx++) {
          const r = coordHash(ox + x0 + dx, oz + z0 + dz, this.seed + 909);
          setLocal(x0 + dx, th, z0 + dz, r > 0.5 ? BLOCK.STONE_BRICKS : BLOCK.MOSSY_COBBLESTONE);
        }
      }
      // Tall broken obsidian gateway frame
      for (let dy = 1; dy <= 6; dy++) {
        setLocal(x0 + 2, th + dy, z0 + 2, BLOCK.OBSIDIAN);
        if (dy <= 5) setLocal(x0 + 5, th + dy, z0 + 2, BLOCK.OBSIDIAN);
      }
      setLocal(x0 + 3, th + 6, z0 + 2, BLOCK.OBSIDIAN);
      setLocal(x0 + 4, th + 6, z0 + 2, BLOCK.GOLD_BLOCK);
      setLocal(x0 + 3, th + 7, z0 + 2, BLOCK.GOLD_BLOCK);
      setLocal(x0 + 1, th + 1, z0 + 3, BLOCK.TORCH);
      setLocal(x0 + 6, th + 1, z0 + 3, BLOCK.TORCH);
      placeChest(x0 + 6, th + 1, z0 + 1, [
        { id: 'golden_sword', count: 1, durability: 64 },
        { id: 'golden_chestplate', count: 1, durability: 112 },
        { id: 'flint_and_steel', count: 1, durability: 64 },
        { id: 'gold_ingot', count: 5 },
        { id: 'obsidian', count: 4 }
      ]);
    }
  }

  // MEGA-STRUCTURES: The Great Pyramid of Secrets (64x64 + Tiny Village + 200 Villagers + 130+ Underground Secrets!)
  //                  and The Grand Citadel (48x48 Stone Fortress + Courtyard Village + 120 Villagers + Dungeon Vaults!)
  buildMegaStructureChunk(mega, cx, cz, ox, oz, heights, setLocal, getLocal, noTreeMask) {
    noTreeMask.fill(1);
    const { type, originCx, originCz, sizeChunks, dx: cdx, dz: cdz, baseY, centerWx, centerWz, villagerCount } = mega;

    const placeChest = (lx, ly, lz, items) => {
      if (lx < 0 || lx >= 16 || lz < 0 || lz >= 16 || ly < 2 || ly >= CHUNK_HEIGHT - 2) return;
      setLocal(lx, ly, lz, BLOCK.CHEST);
      const wKey = `${ox + lx},${ly},${oz + lz}`;
      if (!this.chests.has(wKey)) {
        const loot = new Array(27).fill(null);
        for (let i = 0; i < items.length && i < 27; i++) loot[i] = items[i];
        this.chests.set(wKey, loot);
      }
    };

    // Deterministic secret loot generator (scales with underground depth!)
    const makeSecretLoot = (salt, tier) => {
      const h1 = coordHash(cx * 37 + salt * 13, cz * 53 - salt * 19, this.seed + 3101 + tier * 97);
      const h2 = coordHash(cx * 71 - salt * 7, cz * 29 + salt * 41, this.seed + 3209 + tier * 61);
      const eggs = ['spawn_villager', 'spawn_camel', 'spawn_panda', 'spawn_wolf', 'spawn_fox', 'spawn_polar_bear', 'spawn_goat', 'spawn_iron_golem', 'spawn_creeper', 'spawn_skeleton'];
      const gear = [
        { id: 'golden_sword', count: 1, durability: 64 },
        { id: 'golden_pickaxe', count: 1, durability: 64 },
        { id: 'golden_helmet', count: 1, durability: 77 },
        { id: 'golden_chestplate', count: 1, durability: 112 },
        { id: 'golden_leggings', count: 1, durability: 105 },
        { id: 'golden_boots', count: 1, durability: 91 },
        { id: 'iron_sword', count: 1, durability: 251 },
        { id: 'iron_pickaxe', count: 1, durability: 251 }
      ];
      const items = [];
      items.push({ id: 'emerald', count: 2 + Math.floor(h1 * (4 + tier * 3)) });
      items.push({ id: 'gold_ingot', count: 2 + Math.floor(h2 * (5 + tier * 3)) });
      if (tier >= 1 || h1 > 0.45) items.push({ id: 'diamond', count: 1 + Math.floor(h2 * (2 + tier * 2)) });
      if (h1 > 0.32) items.push(gear[Math.floor(h2 * gear.length)]);
      if (h2 > 0.50) items.push({ id: eggs[Math.floor(h1 * eggs.length)], count: 1 + (tier >= 2 ? 1 : 0) });
      if (h1 < 0.36) items.push({ id: h2 > 0.5 ? 'lava_bucket' : 'water_bucket', count: 1 });
      if (h2 < 0.34) items.push({ id: 'flint_and_steel', count: 1, durability: 64 });
      items.push({ id: 'torch', count: 6 + Math.floor(h1 * 10) });
      return items;
    };

    if (type === 'great_pyramid') {
      const levels = [baseY - 11, baseY - 22, Math.max(10, baseY - 33)];
      const minSubY = levels[2] - 2;

      // 1. Solidify subterranean footprint + build colossal stepped exterior + hollow vaulted interior!
      for (let lz = 0; lz < 16; lz++) {
        const gz = cdz * 16 + lz;
        for (let lx = 0; lx < 16; lx++) {
          const gx = cdx * 16 + lx;
          const ch = heights[lx + (lz << 4)];
          const dxC = Math.abs(gx - 31.5);
          const dzC = Math.abs(gz - 31.5);
          const dist = Math.max(dxC, dzC);

          // Solid subterranean stone/sandstone block mass beneath the entire pyramid (no random caves cutting vaults!)
          for (let y = minSubY; y < baseY; y++) {
            setLocal(lx, y, lz, y >= baseY - 4 ? BLOCK.SANDSTONE : BLOCK.STONE);
          }

          // Floor of the Great Pyramid & Tiny Village courtyard (baseY)
          const onRoadX = gx >= 30 && gx <= 33 && gz >= 2 && gz <= 61;
          const onRoadZ = gz >= 30 && gz <= 33 && gx >= 2 && gx <= 61;
          const inPlaza = gx >= 25 && gx <= 38 && gz >= 25 && gz <= 38;
          let floorBlk = BLOCK.SANDSTONE;
          if (onRoadX || onRoadZ) floorBlk = ((gx + gz) & 1) ? BLOCK.COBBLESTONE : BLOCK.STONE_BRICKS;
          else if (inPlaza) floorBlk = ((gx + gz) % 3 === 0) ? BLOCK.TERRACOTTA_ORANGE : BLOCK.SANDSTONE;
          setLocal(lx, baseY, lz, floorBlk);

          // Clear natural terrain above the pyramid slope so it stands crisp and dramatic
          const clearTop = Math.min(CHUNK_HEIGHT - 2, Math.max(ch + 4, baseY + 35));
          for (let y = baseY + 1; y <= clearTop; y++) {
            const dy = y - baseY;
            if (dy <= 31) {
              const outerR = 31.5 - dy;
              if (dist <= outerR) {
                const isShell = dist >= outerR - 1.5;
                // 4 Grand Arched Entrances (N/S/E/W)
                const inGateNS = dxC <= 3.0 && (gz <= 11 || gz >= 52) && dy >= 1 && dy <= 6;
                const inGateEW = dzC <= 3.0 && (gx <= 11 || gx >= 52) && dy >= 1 && dy <= 6;
                const inGateArch = (inGateNS || inGateEW) && (dy <= 5 || Math.min(dxC, dzC) <= 2.0);
                if (inGateArch) {
                  setLocal(lx, y, lz, BLOCK.AIR);
                } else if (isShell) {
                  let blk = BLOCK.SANDSTONE;
                  if (dy >= 29) {
                    blk = (dy === 31 && dist <= 0.6) ? BLOCK.GLOWSTONE : BLOCK.GOLD_BLOCK;
                  } else if (Math.abs(dxC - dzC) <= 0.6 && dy >= 2) {
                    blk = (dy % 2 === 0) ? BLOCK.GOLD_BLOCK : BLOCK.TERRACOTTA_ORANGE;
                  } else if (dy % 6 === 0) {
                    blk = BLOCK.TERRACOTTA_ORANGE;
                  } else if (dy % 6 === 3) {
                    blk = BLOCK.TERRACOTTA_YELLOW;
                  }
                  setLocal(lx, y, lz, blk);
                } else {
                  setLocal(lx, y, lz, BLOCK.AIR);
                }
                continue;
              }
            }
            setLocal(lx, y, lz, BLOCK.AIR);
          }

          // Gateway golden pillars & blazing torches
          const nearGateFrameNS = Math.abs(dxC - 3.5) < 0.1 && (gz === 1 || gz === 62 || gz === 6 || gz === 57);
          const nearGateFrameEW = Math.abs(dzC - 3.5) < 0.1 && (gx === 1 || gx === 62 || gx === 6 || gx === 57);
          if (nearGateFrameNS || nearGateFrameEW) {
            for (let dy = 1; dy <= 7; dy++) {
              setLocal(lx, baseY + dy, lz, dy === 7 ? BLOCK.GOLD_BLOCK : BLOCK.TERRACOTTA_ORANGE);
            }
            if (gz === 1 || gz === 62 || gx === 1 || gx === 62) {
              setLocal(lx, baseY + 8, lz, BLOCK.TORCH);
            }
          }
        }
      }

      // 2. Hanging Glowstone Chandeliers lighting the entire interior village!
      const chandeliers = [
        [20, 20], [43, 20], [20, 43], [43, 43],
        [31, 18], [31, 45], [18, 31], [45, 31], [31, 31]
      ];
      for (const [cxG, czG] of chandeliers) {
        const distC = Math.max(Math.abs(cxG - 31.5), Math.abs(czG - 31.5));
        const ceilDy = Math.floor(30.0 - distC);
        const hangY = Math.min(baseY + ceilDy - 2, baseY + 11);
        for (let ozC = -1; ozC <= 1; ozC++) {
          for (let oxC = -1; oxC <= 1; oxC++) {
            const gx = cxG + oxC, gz = czG + ozC;
            const lx = gx - cdx * 16, lz = gz - cdz * 16;
            if (lx < 0 || lx >= 16 || lz < 0 || lz >= 16) continue;
            if (oxC === 0 && ozC === 0) {
              for (let y = hangY; y <= baseY + ceilDy; y++) {
                setLocal(lx, y, lz, y === hangY ? BLOCK.GOLD_BLOCK : BLOCK.OAK_LOG);
              }
              setLocal(lx, hangY - 1, lz, BLOCK.GLOWSTONE);
            } else if (Math.abs(oxC) + Math.abs(ozC) === 1) {
              setLocal(lx, hangY, lz, BLOCK.GLOWSTONE);
            }
          }
        }
      }

      // 3. Central Oasis Fountain Plaza inside the Giant Pyramid (gx,gz in [29..34])
      for (let lz = 0; lz < 16; lz++) {
        const gz = cdz * 16 + lz;
        for (let lx = 0; lx < 16; lx++) {
          const gx = cdx * 16 + lx;
          if (gx >= 29 && gx <= 34 && gz >= 29 && gz <= 34) {
            const rim = gx === 29 || gx === 34 || gz === 29 || gz === 34;
            if (rim) {
              setLocal(lx, baseY + 1, lz, BLOCK.STONE_BRICKS);
              if ((gx === 29 || gx === 34) && (gz === 29 || gz === 34)) {
                setLocal(lx, baseY + 2, lz, BLOCK.GLOWSTONE);
              }
            } else {
              setLocal(lx, baseY, lz, BLOCK.STONE_BRICKS);
              setLocal(lx, baseY + 1, lz, BLOCK.WATER);
            }
            if ((gx === 31 || gx === 32) && (gz === 31 || gz === 32)) {
              setLocal(lx, baseY + 1, lz, BLOCK.GOLD_BLOCK);
              setLocal(lx, baseY + 2, lz, BLOCK.SANDSTONE);
              setLocal(lx, baseY + 3, lz, BLOCK.GLOWSTONE);
              if (gx === 31 && gz === 31) setLocal(lx, baseY + 4, lz, BLOCK.WATER);
            }
          }
        }
      }

      // 4. Tiny Village INSIDE the Giant Pyramid — 12 Cozy Miniature Cottages!
      const cottages = [
        // NW quadrant
        { x: 14, z: 14, dir: 'S', wall: BLOCK.SANDSTONE, roof: BLOCK.TERRACOTTA_ORANGE },
        { x: 21, z: 14, dir: 'S', wall: BLOCK.OAK_PLANKS, roof: BLOCK.TERRACOTTA_YELLOW },
        { x: 14, z: 21, dir: 'E', wall: BLOCK.ACACIA_PLANKS, roof: BLOCK.TERRACOTTA_RED },
        // NE quadrant
        { x: 38, z: 14, dir: 'S', wall: BLOCK.SANDSTONE, roof: BLOCK.TERRACOTTA_RED },
        { x: 45, z: 14, dir: 'S', wall: BLOCK.BIRCH_PLANKS, roof: BLOCK.TERRACOTTA_ORANGE },
        { x: 45, z: 21, dir: 'W', wall: BLOCK.OAK_PLANKS, roof: BLOCK.TERRACOTTA_YELLOW },
        // SW quadrant
        { x: 14, z: 38, dir: 'E', wall: BLOCK.BIRCH_PLANKS, roof: BLOCK.TERRACOTTA_YELLOW },
        { x: 14, z: 45, dir: 'N', wall: BLOCK.SANDSTONE, roof: BLOCK.TERRACOTTA_ORANGE },
        { x: 21, z: 45, dir: 'N', wall: BLOCK.ACACIA_PLANKS, roof: BLOCK.TERRACOTTA_RED },
        // SE quadrant
        { x: 45, z: 38, dir: 'W', wall: BLOCK.SANDSTONE, roof: BLOCK.TERRACOTTA_RED },
        { x: 38, z: 45, dir: 'N', wall: BLOCK.OAK_PLANKS, roof: BLOCK.TERRACOTTA_ORANGE },
        { x: 45, z: 45, dir: 'N', wall: BLOCK.ACACIA_PLANKS, roof: BLOCK.TERRACOTTA_YELLOW }
      ];
      for (let ci = 0; ci < cottages.length; ci++) {
        const cot = cottages[ci];
        const w = 5, d = 5;
        for (let dz = 0; dz < d; dz++) {
          const gz = cot.z + dz;
          const lz = gz - cdz * 16;
          if (lz < 0 || lz >= 16) continue;
          for (let dx = 0; dx < w; dx++) {
            const gx = cot.x + dx;
            const lx = gx - cdx * 16;
            if (lx < 0 || lx >= 16) continue;
            const edgeX = dx === 0 || dx === w - 1;
            const edgeZ = dz === 0 || dz === d - 1;
            const corner = edgeX && edgeZ;
            const isDoor =
              (cot.dir === 'S' && dz === d - 1 && dx === 2) ||
              (cot.dir === 'N' && dz === 0 && dx === 2) ||
              (cot.dir === 'E' && dx === w - 1 && dz === 2) ||
              (cot.dir === 'W' && dx === 0 && dz === 2);

            setLocal(lx, baseY, lz, BLOCK.OAK_PLANKS);
            for (let dy = 1; dy <= 3; dy++) {
              if (edgeX || edgeZ) {
                if (isDoor && dy === 1) {
                  const dFace = cot.dir === 'S' ? 2 : (cot.dir === 'N' ? 0 : (cot.dir === 'E' ? 1 : 3));
                  setLocal(lx, baseY + 1, lz, BLOCK.ACACIA_DOOR_B);
                  setLocal(lx, baseY + 2, lz, BLOCK.ACACIA_DOOR_T);
                  this.doorStates.set(`${ox + lx},${baseY + 1},${oz + lz}`, { facing: dFace, open: false });
                } else if (isDoor && dy === 2) {
                  // Top half placed above
                } else if (corner) setLocal(lx, baseY + dy, lz, BLOCK.ACACIA_LOG);
                else if (dy === 2 && !isDoor && (dx === 2 || dz === 2)) setLocal(lx, baseY + dy, lz, BLOCK.GLASS);
                else setLocal(lx, baseY + dy, lz, cot.wall);
              } else {
                setLocal(lx, baseY + dy, lz, BLOCK.AIR);
              }
            }
            // Pitched stepped terracotta roof
            setLocal(lx, baseY + 4, lz, cot.roof);
            if (!edgeX && !edgeZ) setLocal(lx, baseY + 5, lz, cot.roof);

            // Cozy miniature interior furnishings + wall-mounted torch (never floating!)
            if (dx === 1 && dz === 1) setLocal(lx, baseY + 1, lz, BLOCK.BED_HEAD_N);
            if (dx === 1 && dz === 2) setLocal(lx, baseY + 1, lz, BLOCK.BED);
            if (dx === 3 && dz === 1) setLocal(lx, baseY + 1, lz, (ci & 1) ? BLOCK.CRAFTING_TABLE : BLOCK.FURNACE);
            if (dx === 3 && dz === 3) {
              placeChest(lx, baseY + 1, lz, [
                { id: 'bread', count: 5 + (ci % 4) },
                { id: 'emerald', count: 2 + (ci % 3) },
                { id: 'gold_ingot', count: 1 + (ci % 3) },
                { id: 'torch', count: 6 }
              ]);
            }
            if (dx === 2 && dz === 1) setLocal(lx, baseY + 2, lz, BLOCK.TORCH);
            if (dx === 1 && dz === 3 && cot.dir !== 'W') setLocal(lx, baseY + 2, lz, BLOCK.TORCH);
          }
        }
      }

      // 5. 8 Colorful Market Stalls lining the interior village avenues!
      const stalls = [
        [25, 17, BLOCK.WOOL_RED], [36, 17, BLOCK.WOOL_BLUE],
        [25, 44, BLOCK.WOOL_GREEN], [36, 44, BLOCK.WOOL_YELLOW],
        [17, 25, BLOCK.WOOL_YELLOW], [17, 36, BLOCK.WOOL_RED],
        [44, 25, BLOCK.WOOL_BLUE], [44, 36, BLOCK.WOOL_GREEN]
      ];
      for (let si = 0; si < stalls.length; si++) {
        const [sx, sz, wool] = stalls[si];
        for (let dz = 0; dz < 3; dz++) {
          const lz = sz + dz - cdz * 16;
          if (lz < 0 || lz >= 16) continue;
          for (let dx = 0; dx < 3; dx++) {
            const lx = sx + dx - cdx * 16;
            if (lx < 0 || lx >= 16) continue;
            const corner = (dx === 0 || dx === 2) && (dz === 0 || dz === 2);
            if (corner) {
              setLocal(lx, baseY + 1, lz, BLOCK.OAK_LOG);
              setLocal(lx, baseY + 2, lz, BLOCK.OAK_LOG);
            }
            setLocal(lx, baseY + 3, lz, ((dx + dz) & 1) ? BLOCK.WOOL_WHITE : wool);
            if (dx === 1 && dz === 1) {
              placeChest(lx, baseY + 1, lz, [
                { id: 'emerald', count: 3 + (si % 4) },
                { id: 'apple', count: 4 },
                { id: 'bread', count: 4 },
                { id: si % 2 === 0 ? 'water_bucket' : 'flint_and_steel', count: 1, durability: 64 }
              ]);
              setLocal(lx, baseY + 4, lz, BLOCK.TORCH);
            }
          }
        }
      }

      // 6. Grand Descend Stairwell from the Central Plaza down to ALL 3 Underground Labyrinth Levels!
      // Located at gx in [25..28], gz in [25..28] (chunk dx=1, dz=1: lx=9..12, lz=9..12)
      for (let y = levels[2]; y <= baseY + 5; y++) {
        for (let gz = 25; gz <= 28; gz++) {
          const lz = gz - cdz * 16;
          if (lz < 0 || lz >= 16) continue;
          for (let gx = 25; gx <= 28; gx++) {
            const lx = gx - cdx * 16;
            if (lx < 0 || lx >= 16) continue;
            const rim = gx === 25 || gx === 28 || gz === 25 || gz === 28;
            if (y > baseY) {
              // Ornate Obsidian & Gold portal canopy over the underground stairs
              if (rim && ((gx === 25 || gx === 28) && (gz === 25 || gz === 28)) && y <= baseY + 4) {
                setLocal(lx, y, lz, y === baseY + 4 ? BLOCK.GOLD_BLOCK : BLOCK.OBSIDIAN);
              } else if (y === baseY + 4 && rim) {
                setLocal(lx, y, lz, BLOCK.GOLD_BLOCK);
              } else if (y === baseY + 5 && gx >= 26 && gx <= 27 && gz >= 26 && gz <= 27) {
                setLocal(lx, y, lz, BLOCK.GLOWSTONE);
              }
            } else {
              // Spiral stairwell shaft descending all 3 underground levels!
              const isCenterPillar = gx === 26 && gz === 26;
              if (isCenterPillar) {
                setLocal(lx, y, lz, (y % 4 === 0) ? BLOCK.GLOWSTONE : BLOCK.OBSIDIAN);
              } else if (gx >= 26 && gx <= 27 && gz >= 26 && gz <= 27) {
                // Spiral step rotating around center pillar
                const phase = ((y % 3) + 3) % 3;
                const isStep =
                  (phase === 0 && gx === 27 && gz === 26) ||
                  (phase === 1 && gx === 27 && gz === 27) ||
                  (phase === 2 && gx === 26 && gz === 27);
                setLocal(lx, y, lz, isStep ? BLOCK.STONE_BRICKS : BLOCK.AIR);
              } else if (rim && y === baseY) {
                setLocal(lx, y, lz, (gx === 27 && gz === 28) ? BLOCK.AIR : BLOCK.OBSIDIAN);
              } else if (rim && y < baseY) {
                // Openings on each underground level leading into the labyrinth corridors!
                const onLevelOpen = levels.some((ly) => y >= ly + 1 && y <= ly + 3);
                if (onLevelOpen && ((gx === 27 && gz === 28) || (gx === 28 && gz === 27))) {
                  setLocal(lx, y, lz, BLOCK.AIR);
                } else {
                  setLocal(lx, y, lz, BLOCK.STONE_BRICKS);
                }
              }
            }
          }
        }
      }

      // 7. UNDERNEATH THE PYRAMID — 3-LEVEL SUBTERRANEAN LABYRINTH WITH 130+ SECRETS!
      const wallMats = [BLOCK.SANDSTONE, BLOCK.STONE_BRICKS, BLOCK.OBSIDIAN];
      const accentMats = [BLOCK.TERRACOTTA_ORANGE, BLOCK.MOSSY_COBBLESTONE, BLOCK.GOLD_BLOCK];
      const falseWallMats = [BLOCK.SANDSTONE, BLOCK.MOSSY_COBBLESTONE, BLOCK.GRAVEL];

      for (let lvl = 0; lvl < 3; lvl++) {
        const ly0 = levels[lvl];
        const wMat = wallMats[lvl];
        const aMat = accentMats[lvl];
        const fMat = falseWallMats[lvl];

        // 7A. Interconnected 4x4 Labyrinth Corridors across all 16 chunks (lx=6..9, lz=6..9)
        for (let lz = 0; lz < 16; lz++) {
          const gz = cdz * 16 + lz;
          for (let lx = 0; lx < 16; lx++) {
            const gx = cdx * 16 + lx;
            if (gx <= 1 || gx >= 62 || gz <= 1 || gz >= 62) continue;
            const inNS = lx >= 6 && lx <= 9;
            const inEW = lz >= 6 && lz <= 9;
            if (!inNS && !inEW) continue;
            // Don't overwrite central spiral shaft interior
            if (gx >= 25 && gx <= 28 && gz >= 25 && gz <= 28) continue;

            setLocal(lx, ly0, lz, ((gx + gz) & 1) ? wMat : BLOCK.COBBLESTONE);
            setLocal(lx, ly0 + 5, lz, wMat);
            for (let dy = 1; dy <= 4; dy++) setLocal(lx, ly0 + dy, lz, BLOCK.AIR);
            // Wall-mounted hallway torches (strictly touching solid corridor walls, NEVER floating in mid-air!)
            if (((lx === 6 || lx === 9) && (lz === 2 || lz === 13)) || ((lz === 6 || lz === 9) && (lx === 2 || lx === 13))) {
              setLocal(lx, ly0 + 2, lz, BLOCK.TORCH);
            }
            if (lx === 7 && lz === 7) {
              setLocal(lx, ly0 + 5, lz, BLOCK.GLOWSTONE);
            }
          }
        }

        // 7B. 4 Corner Secret Chambers per Chunk per Level (~130-150 unique secrets beneath the pyramid!)
        const corners = [
          { x0: 1, z0: 1, doorX: 5, doorZ: 3, inX: 4, inZ: 3 },
          { x0: 11, z0: 1, doorX: 10, doorZ: 3, inX: 11, inZ: 3 },
          { x0: 1, z0: 11, doorX: 5, doorZ: 12, inX: 4, inZ: 12 },
          { x0: 11, z0: 11, doorX: 10, doorZ: 12, inX: 11, inZ: 12 }
        ];
        for (let cIdx = 0; cIdx < 4; cIdx++) {
          const c = corners[cIdx];
          const gxMid = cdx * 16 + c.x0 + 2;
          const gzMid = cdz * 16 + c.z0 + 2;
          // Skip overlap with central stairwell or Level 2 Pharaoh's Inner Sanctum
          if (gxMid >= 23 && gxMid <= 30 && gzMid >= 23 && gzMid <= 30) continue;
          if (lvl === 2 && gxMid >= 20 && gxMid <= 43 && gzMid >= 20 && gzMid <= 43) continue;
          // Stay inside outer pyramid border
          if (gxMid <= 2 || gxMid >= 61 || gzMid <= 2 || gzMid >= 61) continue;

          const sHash = coordHash(gxMid * 19 + lvl * 43, gzMid * 29 + cIdx * 17, this.seed + 4409);
          // 92% of corner chambers hold a secret -> ~135+ secrets under EVERY Great Pyramid!
          if (sHash < 0.08) continue;

          const secretType = Math.floor(sHash * 7) % 7;

          // Carve hidden 4x4x3 secret chamber
          for (let dz = 0; dz < 4; dz++) {
            for (let dx = 0; dx < 4; dx++) {
              const lx = c.x0 + dx, lz = c.z0 + dz;
              if (lx <= 1 || lx >= 14 || lz <= 1 || lz >= 14) {
                // Keep outer chunk safety if on perimeter
                const gx = cdx * 16 + lx, gz = cdz * 16 + lz;
                if (gx <= 0 || gx >= 63 || gz <= 0 || gz >= 63) continue;
              }
              setLocal(lx, ly0, lz, secretType === 3 ? BLOCK.TERRACOTTA_RED : aMat);
              for (let dy = 1; dy <= 3; dy++) setLocal(lx, ly0 + dy, lz, BLOCK.AIR);
              setLocal(lx, ly0 + 4, lz, wMat);
            }
          }

          // Accessible Loot Room Doorway with Real Interactive Wood Door (never blocked off!)
          const dFacePyr = c.doorX === 5 ? 1 : 3;
          setLocal(c.doorX, ly0, c.doorZ, wMat);
          setLocal(c.doorX, ly0 + 1, c.doorZ, BLOCK.OAK_DOOR_B);
          setLocal(c.doorX, ly0 + 2, c.doorZ, BLOCK.OAK_DOOR_T);
          setLocal(c.doorX, ly0 + 3, c.doorZ, BLOCK.GOLD_BLOCK);
          this.doorStates.set(`${ox + c.doorX},${ly0 + 1},${oz + c.doorZ}`, { facing: dFacePyr, open: false });

          // Furnish the secret room by archetype + wall-mounted torch flush on the solid chamber wall!
          const cxR = c.x0 + 1;
          const czR = c.z0 + 1;
          setLocal(c.x0, ly0 + 2, c.z0 + 1, BLOCK.TORCH);
          setLocal(c.x0 + 3, ly0 + 2, c.z0 + 2, BLOCK.TORCH);
          const lootSalt = lvl * 100 + cIdx * 23 + cdx * 7 + cdz * 11;

          if (secretType === 0) {
            // Hidden Treasure Vault
            setLocal(cxR, ly0 + 1, czR, BLOCK.GOLD_BLOCK);
            placeChest(cxR + 1, ly0 + 1, czR + 1, makeSecretLoot(lootSalt, lvl + 1));
          } else if (secretType === 1) {
            // Secret Armory & Relic Pedestal
            setLocal(cxR, ly0 + 1, czR, BLOCK.IRON_BLOCK);
            setLocal(cxR + 1, ly0 + 1, czR, BLOCK.FURNACE);
            placeChest(cxR, ly0 + 1, czR + 1, makeSecretLoot(lootSalt + 5, lvl + 1));
          } else if (secretType === 2) {
            // Forbidden Underground Library
            setLocal(cxR, ly0 + 1, czR, BLOCK.BOOKSHELF);
            setLocal(cxR, ly0 + 2, czR, BLOCK.BOOKSHELF);
            setLocal(cxR + 1, ly0 + 1, czR, BLOCK.BOOKSHELF);
            setLocal(cxR + 1, ly0 + 2, czR, BLOCK.BOOKSHELF);
            setLocal(cxR, ly0 + 1, czR + 1, BLOCK.CRAFTING_TABLE);
            placeChest(cxR + 1, ly0 + 1, czR + 1, makeSecretLoot(lootSalt + 11, lvl + 1));
          } else if (secretType === 3) {
            // Trapped Pharaoh Reliquary (TNT + Diamond Treasure!)
            setLocal(cxR, ly0 + 1, czR, BLOCK.TNT);
            setLocal(cxR + 1, ly0 + 1, czR, BLOCK.GOLD_BLOCK);
            placeChest(cxR + 1, ly0 + 1, czR + 1, makeSecretLoot(lootSalt + 17, lvl + 2));
          } else if (secretType === 4) {
            // Subterranean Lava Forge Shrine
            setLocal(cxR, ly0, czR, BLOCK.OBSIDIAN);
            setLocal(cxR, ly0 + 1, czR, BLOCK.LAVA);
            setLocal(cxR + 1, ly0 + 1, czR, BLOCK.OBSIDIAN);
            placeChest(cxR + 1, ly0 + 1, czR + 1, makeSecretLoot(lootSalt + 23, lvl + 1));
          } else if (secretType === 5) {
            // Secret Crystal Ore Cache (Exposed Diamond & Gold Ore!)
            setLocal(cxR, ly0 + 1, czR, BLOCK.DIAMOND_ORE);
            setLocal(cxR, ly0 + 2, czR, BLOCK.GOLD_ORE);
            setLocal(cxR + 1, ly0 + 1, czR, BLOCK.DIAMOND_ORE);
            placeChest(cxR + 1, ly0 + 1, czR + 1, makeSecretLoot(lootSalt + 29, lvl + 2));
          } else {
            // Hidden Vertical Shaft & Relic Stash
            placeChest(cxR + 1, ly0 + 1, czR + 1, makeSecretLoot(lootSalt + 37, lvl + 1));
            if (lvl < 2) {
              for (let yS = levels[lvl + 1] + 1; yS <= ly0 + 1; yS++) {
                setLocal(cxR, yS, czR, BLOCK.LADDER);
              }
            } else {
              setLocal(cxR, ly0 + 1, czR, BLOCK.DIAMOND_BLOCK);
            }
          }
        }
      }

      // 8. THE PHARAOH'S INNER SANCTUM (Level 2 Center 2x2 Chunks: gx,gz in [22..41])!
      const sY = levels[2];
      for (let lz = 0; lz < 16; lz++) {
        const gz = cdz * 16 + lz;
        if (gz < 22 || gz > 41) continue;
        for (let lx = 0; lx < 16; lx++) {
          const gx = cdx * 16 + lx;
          if (gx < 22 || gx > 41) continue;
          const dxS = Math.abs(gx - 31.5);
          const dzS = Math.abs(gz - 31.5);
          const dS = Math.max(dxS, dzS);

          // Vaulted 7-block-tall Obsidian & Gold Sanctum!
          for (let dy = 1; dy <= 7; dy++) setLocal(lx, sY + dy, lz, BLOCK.AIR);
          setLocal(lx, sY + 8, lz, (dS <= 5.5 && ((gx + gz) % 4 === 0)) ? BLOCK.GLOWSTONE : BLOCK.OBSIDIAN);

          const isBridge = dxS <= 1.5 || dzS <= 1.5;
          if (dS >= 7.5 && dS <= 9.0 && !isBridge) {
            // Glowing Lava Moat encircling the Pharaoh's Throne!
            setLocal(lx, sY - 1, lz, BLOCK.OBSIDIAN);
            setLocal(lx, sY, lz, BLOCK.LAVA);
          } else if (dS <= 4.5) {
            // Raised Royal Obsidian & Gold Throne Dais!
            setLocal(lx, sY, lz, BLOCK.OBSIDIAN);
            setLocal(lx, sY + 1, lz, ((gx + gz) & 1) ? BLOCK.GOLD_BLOCK : BLOCK.OBSIDIAN);
            if (dxS <= 1.5 && dzS <= 1.5) {
              setLocal(lx, sY + 2, lz, BLOCK.GOLD_BLOCK);
              if (dxS <= 0.6 && dzS <= 0.6) {
                setLocal(lx, sY + 3, lz, BLOCK.DIAMOND_BLOCK);
                setLocal(lx, sY + 4, lz, BLOCK.GLOWSTONE);
              }
            }
          } else {
            setLocal(lx, sY, lz, isBridge ? BLOCK.GOLD_BLOCK : BLOCK.STONE_BRICKS);
          }

          // 4 Towering Diamond & Gold Pillars around the throne
          if (Math.abs(dxS - 5.5) < 0.1 && Math.abs(dzS - 5.5) < 0.1) {
            for (let dy = 1; dy <= 7; dy++) {
              setLocal(lx, sY + dy, lz, dy === 4 ? BLOCK.DIAMOND_BLOCK : (dy === 7 ? BLOCK.GLOWSTONE : BLOCK.GOLD_BLOCK));
            }
          }

          // 4 Royal Pharaoh Treasure Chests on the dais corners!
          if (Math.abs(dxS - 3.5) < 0.1 && Math.abs(dzS - 3.5) < 0.1) {
            placeChest(lx, sY + 2, lz, [
              { id: 'diamond', count: 8 },
              { id: 'emerald', count: 14 },
              { id: 'gold_ingot', count: 16 },
              { id: 'golden_sword', count: 1, durability: 64 },
              { id: 'golden_chestplate', count: 1, durability: 112 },
              { id: 'lava_bucket', count: 1 },
              { id: 'water_bucket', count: 1 },
              { id: 'spawn_iron_golem', count: 2 },
              { id: 'spawn_villager', count: 3 }
            ]);
          }
        }
      }

      // Register Great Pyramid in world.megaStructures when center chunk (dx=1, dz=1) generates!
      if (cdx === 1 && cdz === 1) {
        const mKey = this.chunkKey(originCx, originCz);
        if (!this.megaStructures.has(mKey)) {
          this.megaStructures.set(mKey, {
            key: mKey,
            type: 'great_pyramid',
            name: 'The Great Pyramid',
            x: centerWx,
            y: baseY + 1,
            z: centerWz,
            radius: 32,
            innerRadius: 21,
            villagerCount,
            discovered: false,
            crowdSpawned: false
          });
        }
      }
      return;
    }

    // MEGA-STRUCTURE #2: THE MEGA CASTLE (64x64 Fortified Citadel + 26-Block Grand Keep + 3 Architectural Variants + 150 Villagers + Dungeons!)
    if (type === 'grand_citadel') {
      const mVar = mega.variant || 0;
      const wallMain = mVar === 0 ? BLOCK.STONE_BRICKS : (mVar === 1 ? BLOCK.MOSSY_COBBLESTONE : BLOCK.SANDSTONE);
      const wallTrim = mVar === 0 ? BLOCK.COBBLESTONE : (mVar === 1 ? BLOCK.STONE_BRICKS : BLOCK.TERRACOTTA_ORANGE);
      const bannerWool = mVar === 0 ? BLOCK.WOOL_RED : (mVar === 1 ? BLOCK.WOOL_GREEN : BLOCK.WOOL_BLUE);
      const roofBlk = mVar === 0 ? BLOCK.BRICKS : (mVar === 1 ? BLOCK.SPRUCE_PLANKS : BLOCK.TERRACOTTA_RED);
      const woodPlanks = mVar === 1 ? BLOCK.SPRUCE_PLANKS : BLOCK.OAK_PLANKS;
      const woodLog = mVar === 1 ? BLOCK.SPRUCE_LOG : BLOCK.OAK_LOG;
      const levels = [baseY - 11, Math.max(10, baseY - 22)];

      for (let lz = 0; lz < 16; lz++) {
        const gz = cdz * 16 + lz;
        for (let lx = 0; lx < 16; lx++) {
          const gx = cdx * 16 + lx;
          const ch = heights[lx + (lz << 4)];
          const dxC = Math.abs(gx - 31.5);
          const dzC = Math.abs(gz - 31.5);
          const dist = Math.max(dxC, dzC);

          for (let y = levels[1] - 2; y < baseY; y++) setLocal(lx, y, lz, BLOCK.STONE);
          const onRoad = (gx >= 30 && gx <= 33) || (gz >= 30 && gz <= 33);
          setLocal(lx, baseY, lz, onRoad ? BLOCK.DIRT_PATH : (((gx + gz) & 1) ? wallMain : BLOCK.GRASS));

          // Clear interior & sky up above the soaring 28-block Grand Keep!
          for (let y = baseY + 1; y <= Math.min(CHUNK_HEIGHT - 2, Math.max(ch + 4, baseY + 32)); y++) {
            setLocal(lx, y, lz, BLOCK.AIR);
          }

          // 1. Massive 64x64 Outer Curtain Walls + 4 Towering 22-Block Corner Watchtowers (with Doors & Full-Height Ladders!)
          const inTower = (gx <= 8 || gx >= 55) && (gz <= 8 || gz >= 55);
          const isOuterWall = dist >= 29.5 && dist <= 31.5;
          const inGate = ((dxC <= 3.0 && (gz <= 3 || gz >= 60)) || (dzC <= 3.0 && (gx <= 3 || gx >= 60)));
          if (inTower) {
            const tEdge = gx === 0 || gx === 8 || gx === 55 || gx === 63 || gz === 0 || gz === 8 || gz === 55 || gz === 63;
            // Courtyard ground doorway into each corner watchtower!
            const isTowerDoor = ((gx === 8 || gx === 55) && (gz === 4 || gz === 59));
            // Vertical ladder shaft climbing ALL floors (ground -> 2nd floor dy=11 -> rooftop dy=20!)
            const isTowerLadder = ((gx === 2 || gx === 61) && (gz === 4 || gz === 59));
            const isTowerLadderBack = ((gx === 1 || gx === 62) && (gz === 4 || gz === 59));
            for (let dy = 1; dy <= 22; dy++) {
              if (tEdge) {
                if (isTowerDoor && dy <= 2) {
                  if (dy === 1) {
                    const cDoor = mVar === 1 ? BLOCK.SPRUCE_DOOR_B : BLOCK.OAK_DOOR_B;
                    setLocal(lx, baseY + 1, lz, cDoor);
                    setLocal(lx, baseY + 2, lz, cDoor + 1);
                    this.doorStates.set(`${ox + lx},${baseY + 1},${oz + lz}`, { facing: gx === 8 ? 1 : 3, open: false });
                  }
                  continue;
                }
                const isCrenel = dy === 22 && ((gx + gz) & 1);
                const isSlit = (dy === 10 || dy === 16) && (gx === 4 || gx === 59 || gz === 4 || gz === 59);
                if (!isCrenel) setLocal(lx, baseY + dy, lz, isSlit ? BLOCK.GLASS : (dy % 5 === 0 ? wallTrim : wallMain));
              } else if (isTowerLadder && dy <= 20) {
                // Keep floor hatches open right at the ladder column!
                setLocal(lx, baseY + dy, lz, BLOCK.LADDER);
              } else if (isTowerLadderBack && dy <= 20) {
                // Solid stone backing pillar behind the ladder so the 3D ladder mounts flush!
                setLocal(lx, baseY + dy, lz, wallMain);
              } else if (dy === 11 || dy === 20) {
                setLocal(lx, baseY + dy, lz, woodPlanks);
              }
            }
            // Wall-mounted tower torches on every floor + rooftop glowstone beacon!
            if ((gx === 4 || gx === 59) && (gz === 1 || gz === 62)) {
              setLocal(lx, baseY + 3, lz, BLOCK.TORCH);
              setLocal(lx, baseY + 14, lz, BLOCK.TORCH);
            }
            if ((gx === 4 || gx === 59) && (gz === 4 || gz === 59)) setLocal(lx, baseY + 21, lz, BLOCK.GLOWSTONE);
          } else if (isOuterWall) {
            const wallH = inGate ? 16 : 13;
            for (let dy = 1; dy <= wallH; dy++) {
              if (inGate && dy <= 6 && (dxC <= 2.2 || dzC <= 2.2)) continue;
              if (dy === wallH && ((gx + gz) & 1)) continue;
              setLocal(lx, baseY + dy, lz, dy === wallH - 1 ? wallTrim : wallMain);
            }
            // Hanging colored banners along the outer ramparts!
            if (dist >= 31.0 && !inGate && ((gx % 10 === 0) || (gz % 10 === 0))) {
              for (let by = 6; by <= 10; by++) setLocal(lx, baseY + by, lz, bannerWool);
            }
            // Bright battlement torches along curtain walls!
            if ((gx === 1 || gx === 62) && gz % 6 === 0) setLocal(lx, baseY + 13, lz, BLOCK.TORCH);
            if ((gz === 1 || gz === 62) && gx % 6 === 0) setLocal(lx, baseY + 13, lz, BLOCK.TORCH);
          }
          // Wall-mounted ladders on the inner face of the N & S curtain walls to climb up to battlements!
          if ((gx === 27 && gz === 3) || (gx === 27 && gz === 60)) {
            for (let dy = 1; dy <= 12; dy++) setLocal(lx, baseY + dy, lz, BLOCK.LADDER);
          }

          // 2. Towering Central Grand Keep (20x20 footprint: gx,gz in [22..41], 26 blocks tall + Full Multi-Floor Ladders!)
          if (gx >= 22 && gx <= 41 && gz >= 22 && gz <= 41) {
            const kEdgeX = gx === 22 || gx === 41;
            const kEdgeZ = gz === 22 || gz === 41;
            const kCorner = (gx <= 24 || gx >= 39) && (gz <= 24 || gz >= 39);
            const kDoor = (gz === 41 || gz === 22) && gx >= 30 && gx <= 33;
            const keepH = kCorner ? 27 : 22;

            // Carpeted Throne Room floor!
            const onCarpet = gx >= 30 && gx <= 33 && gz >= 25 && gz <= 40;
            setLocal(lx, baseY, lz, onCarpet ? bannerWool : wallMain);

            for (let dy = 1; dy <= keepH; dy++) {
              if (kEdgeX || kEdgeZ) {
                if (kDoor && dy <= 4) continue;
                if (dy === keepH && ((gx + gz) & 1)) continue;
                const isTallWin = (dy === 4 || dy === 5 || dy === 11 || dy === 12 || dy === 17) && !kCorner && ((gx % 4 === 0) || (gz % 4 === 0));
                setLocal(lx, baseY + dy, lz, isTallWin ? BLOCK.GLASS : (kCorner ? wallTrim : wallMain));
              } else if (dy === 8 || dy === 15 || dy === 21) {
                // Keep multi-story floors (leave stairwell open for ladders!)
                const isStairWell = gx >= 36 && gx <= 38 && gz >= 25 && gz <= 27;
                if (!isStairWell) setLocal(lx, baseY + dy, lz, dy === 21 ? wallMain : woodPlanks);
              }
            }
            // Full-height Grand Keep Ladder Shaft climbing Ground -> 2nd Floor Library -> 3rd Floor -> Roof Parapet!
            if (gx === 37 && gz === 24) {
              for (let dy = 1; dy <= 21; dy++) setLocal(lx, baseY + dy, lz, wallMain);
            }
            if (gx === 37 && gz === 25) {
              for (let dy = 1; dy <= 21; dy++) setLocal(lx, baseY + dy, lz, BLOCK.LADDER);
            }
            // Wall-mounted Keep torches on all 3 interior stories (flush against inner walls!)
            if ((gx === 23 || gx === 40) && (gz === 28 || gz === 34 || gz === 39)) {
              setLocal(lx, baseY + 3, lz, BLOCK.TORCH);
              setLocal(lx, baseY + 11, lz, BLOCK.TORCH);
              setLocal(lx, baseY + 18, lz, BLOCK.TORCH);
            }
            // Golden Throne at North end of Throne Room!
            if (gx >= 30 && gx <= 33 && gz >= 24 && gz <= 26) {
              setLocal(lx, baseY + 1, lz, BLOCK.GOLD_BLOCK);
              if (gz === 24) setLocal(lx, baseY + 2, lz, BLOCK.GOLD_BLOCK);
              if (gz === 24 && (gx === 31 || gx === 32)) setLocal(lx, baseY + 3, lz, BLOCK.GOLD_BLOCK);
            }
            // Hanging Glowstone Chandeliers in the Grand Hall
            if ((gx === 27 || gx === 36) && (gz === 31 || gz === 36)) {
              setLocal(lx, baseY + 7, lz, BLOCK.GLOWSTONE);
              setLocal(lx, baseY + 14, lz, BLOCK.GLOWSTONE);
            }
            // Royal Library Bookshelves on 2nd Floor!
            if ((gx === 23 || gx === 40) && gz >= 26 && gz <= 37) {
              setLocal(lx, baseY + 9, lz, BLOCK.BOOKSHELF);
              setLocal(lx, baseY + 10, lz, BLOCK.BOOKSHELF);
            }
            // Royal Vault Chests inside the Keep!
            if (gx === 24 && gz === 24) placeChest(lx, baseY + 1, lz, makeSecretLoot(101 + mVar * 13, 3));
            if (gx === 39 && gz === 24) placeChest(lx, baseY + 9, lz, makeSecretLoot(207 + mVar * 17, 3));
            if (gx === 31 && gz === 25) placeChest(lx, baseY + 16, lz, makeSecretLoot(311 + mVar * 19, 3));
          }
          // Extra Courtyard Streetlight Posts so the Mega Castle glows brightly at night!
          if ((gx === 28 || gx === 35) && (gz === 12 || gz === 51)) {
            setLocal(lx, baseY + 1, lz, BLOCK.OAK_FENCE);
            setLocal(lx, baseY + 2, lz, BLOCK.OAK_FENCE);
            setLocal(lx, baseY + 3, lz, BLOCK.GLOWSTONE);
          }
          if ((gz === 28 || gz === 35) && (gx === 12 || gx === 51)) {
            setLocal(lx, baseY + 1, lz, BLOCK.OAK_FENCE);
            setLocal(lx, baseY + 2, lz, BLOCK.OAK_FENCE);
            setLocal(lx, baseY + 3, lz, BLOCK.GLOWSTONE);
          }
        }
      }

      // 3. 12 Castle Courtyard Guildhouses, Barracks & Stables (with Real Wood Doors & Wall Torches!)
      const houses = [
        [11, 11], [11, 20], [20, 11],
        [46, 11], [46, 20], [37, 11],
        [11, 46], [11, 37], [20, 46],
        [46, 46], [46, 37], [37, 46]
      ];
      const castleDoorId = mVar === 1 ? BLOCK.SPRUCE_DOOR_B : BLOCK.OAK_DOOR_B;
      for (let hi = 0; hi < houses.length; hi++) {
        const [hx, hz] = houses[hi];
        for (let dz = 0; dz < 6; dz++) {
          const lz = hz + dz - cdz * 16;
          if (lz < 0 || lz >= 16) continue;
          for (let dx = 0; dx < 6; dx++) {
            const lx = hx + dx - cdx * 16;
            if (lx < 0 || lx >= 16) continue;
            const eX = dx === 0 || dx === 5, eZ = dz === 0 || dz === 5;
            const isDoor = dz === 5 && dx === 2;
            setLocal(lx, baseY, lz, woodPlanks);
            for (let dy = 1; dy <= 4; dy++) {
              if (eX || eZ) {
                if (isDoor && dy === 1) {
                  setLocal(lx, baseY + 1, lz, castleDoorId);
                  setLocal(lx, baseY + 2, lz, castleDoorId + 1);
                  this.doorStates.set(`${ox + lx},${baseY + 1},${oz + lz}`, { facing: 2, open: false });
                } else if (isDoor && dy === 2) {
                  // Top half placed above
                } else if (eX && eZ) setLocal(lx, baseY + dy, lz, woodLog);
                else if (dy === 2 && !isDoor && (dx === 2 || dz === 2)) setLocal(lx, baseY + dy, lz, BLOCK.GLASS);
                else setLocal(lx, baseY + dy, lz, woodPlanks);
              }
            }
            setLocal(lx, baseY + 5, lz, roofBlk);
            if (!eX && !eZ) setLocal(lx, baseY + 6, lz, roofBlk);
            // Wall-mounted torch flush on back wall (never floating in air!)
            if (dx === 2 && dz === 1) setLocal(lx, baseY + 3, lz, BLOCK.TORCH);
            if (dx === 4 && dz === 1) placeChest(lx, baseY + 1, lz, makeSecretLoot(hi * 17 + mVar * 9, 2));
          }
        }
      }

      // 4. 2-Level Underground Mega Castle Dungeon Vaults (Accessible via Wood Doors + Wall-Mounted Torches + Ladder Descent!)
      for (let lvl = 0; lvl < 2; lvl++) {
        const ly0 = levels[lvl];
        for (let lz = 6; lz <= 9; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            setLocal(lx, ly0, lz, wallMain);
            for (let dy = 1; dy <= 3; dy++) setLocal(lx, ly0 + dy, lz, BLOCK.AIR);
          }
        }
        for (let lx = 6; lx <= 9; lx++) {
          for (let lz = 0; lz < 16; lz++) {
            setLocal(lx, ly0, lz, wallMain);
            for (let dy = 1; dy <= 3; dy++) setLocal(lx, ly0 + dy, lz, BLOCK.AIR);
          }
        }
        setLocal(7, ly0 + 4, 7, BLOCK.GLOWSTONE);
        // Wall-mounted hallway torches (strictly touching solid corridor walls, never floating!)
        setLocal(6, ly0 + 2, 2, BLOCK.TORCH);
        setLocal(9, ly0 + 2, 13, BLOCK.TORCH);
        setLocal(2, ly0 + 2, 6, BLOCK.TORCH);
        setLocal(13, ly0 + 2, 9, BLOCK.TORCH);

        // Accessible Loot Vaults connected directly into the dungeon halls with real interactive Wood Doors!
        const vaults = [
          { vx: 2, vz: 2, doorX: 5, doorZ: 3, dFace: 1, salt: 13 },
          { vx: 11, vz: 11, doorX: 10, doorZ: 12, dFace: 3, salt: 29 }
        ];
        for (const v of vaults) {
          for (let dz = 0; dz < 3; dz++) {
            for (let dx = 0; dx < 3; dx++) {
              setLocal(v.vx + dx, ly0, v.vz + dz, BLOCK.MOSSY_COBBLESTONE);
              for (let dy = 1; dy <= 3; dy++) setLocal(v.vx + dx, ly0 + dy, v.vz + dz, BLOCK.AIR);
            }
          }
          // Carve doorway between vault and hall + install interactive Wood Door!
          setLocal(v.doorX, ly0, v.doorZ, wallMain);
          setLocal(v.doorX, ly0 + 1, v.doorZ, castleDoorId);
          setLocal(v.doorX, ly0 + 2, v.doorZ, castleDoorId + 1);
          setLocal(v.doorX, ly0 + 3, v.doorZ, wallMain);
          this.doorStates.set(`${ox + v.doorX},${ly0 + 1},${oz + v.doorZ}`, { facing: v.dFace, open: false });
          // Wall-mounted vault torch (flush on wall, never floating!)
          setLocal(v.vx, ly0 + 2, v.vz + 1, BLOCK.TORCH);
          placeChest(v.vx + 1, ly0 + 1, v.vz + 1, makeSecretLoot(v.salt + lvl * 50 + mVar * 11, lvl + 1));
        }
      }
      // Dungeon access ladder shaft in center-north chunk (cdx=1, cdz=1) connecting courtyard down to both dungeon levels!
      if (cdx === 1 && cdz === 1) {
        for (let yS = levels[1] + 1; yS <= baseY; yS++) {
          setLocal(6, yS, 5, wallMain);
          setLocal(6, yS, 6, BLOCK.LADDER);
        }
      }

      if (cdx === 1 && cdz === 1) {
        const mKey = this.chunkKey(originCx, originCz);
        if (!this.megaStructures.has(mKey)) {
          this.megaStructures.set(mKey, {
            key: mKey,
            type: 'grand_citadel',
            name: mega.name || 'Mega Castle',
            x: centerWx,
            y: baseY + 1,
            z: centerWz,
            radius: 32,
            innerRadius: 26,
            villagerCount,
            discovered: false,
            crowdSpawned: false
          });
        }
      }
    }
  }

  // Deterministic Inter-Landmark Connecting Dirt Path Network (Villages <-> Great Pyramids <-> Mega Castles!)
  _getRoadSegmentsForChunk(cx, cz) {
    if (this.worldType === 'flat' || !this.generateStructures) return null;
    const rgx = Math.floor(cx / 16);
    const rgz = Math.floor(cz / 16);
    const rKey = `${rgx},${rgz}`;
    let segs = this._roadRegionCache.get(rKey);
    if (!segs) {
      segs = [];
      const villages = [];
      const megas = [];

      // Collect villages & mega-structures in a generous surrounding window
      const minVcx = (rgx - 2) * 16;
      const maxVcx = (rgx + 3) * 16;
      const minVcz = (rgz - 2) * 16;
      const maxVcz = (rgz + 3) * 16;

      // Starter hubs around spawn
      if (rgx >= -2 && rgx <= 2 && rgz >= -2 && rgz <= 2) {
        villages.push({ x: 3 * 16 + 8, z: 2 * 16 + 8 }); // Starter Grand Village
        megas.push({ x: -7 * 16, z: -6 * 16 });          // Starter Great Pyramid
        megas.push({ x: 12 * 16, z: -7 * 16 });          // Starter Mega Castle
      }

      // Repeating Villages on 16x16 grid (vcx % 16 === 5, vcz % 16 === 5)
      for (let gx = Math.floor(minVcx / 16); gx <= Math.floor(maxVcx / 16); gx++) {
        const vcx = gx * 16 + 5;
        for (let gz = Math.floor(minVcz / 16); gz <= Math.floor(maxVcz / 16); gz++) {
          const vcz = gz * 16 + 5;
          if (this.isVillageCenter(vcx, vcz)) {
            villages.push({ x: vcx * 16 + 8, z: vcz * 16 + 8 });
          }
        }
      }

      // Repeating Great Pyramids & Mega Castles on 36x36 grid
      const minMgx = Math.floor((minVcx + 18) / 36) - 1;
      const maxMgx = Math.floor((maxVcx + 18) / 36) + 1;
      const minMgz = Math.floor((minVcz + 18) / 36) - 1;
      const maxMgz = Math.floor((maxVcz + 18) / 36) + 1;
      const GRID = 36;
      for (let gx = minMgx; gx <= maxMgx; gx++) {
        for (let gz = minMgz; gz <= maxMgz; gz++) {
          if (gx === 0 && gz === 0) continue;
          const hRoll = coordHash(gx * 59, gz * 83, this.seed + 1901);
          if (hRoll < 0.25) continue;
          const offX = 5 + Math.floor(coordHash(gx * 37, gz * 71, this.seed + 1913) * (GRID - 12));
          const offZ = 5 + Math.floor(coordHash(gx * 97, gz * 41, this.seed + 1931) * (GRID - 12));
          const ocx = gx * GRID - 18 + offX;
          const ocz = gz * GRID - 18 + offZ;
          megas.push({ x: (ocx + 2) * 16, z: (ocz + 2) * 16 });
        }
      }

      const seenPair = new Set();
      const addSeg = (a, b) => {
        const key = a.x < b.x || (a.x === b.x && a.z < b.z)
          ? `${a.x},${a.z}-${b.x},${b.z}`
          : `${b.x},${b.z}-${a.x},${a.z}`;
        if (seenPair.has(key)) return;
        seenPair.add(key);
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 36 || len > 520) return;
        const bend = (coordHash(a.x + b.x, a.z - b.z, this.seed + 4441) - 0.5) * Math.min(48, len * 0.22);
        const pad = Math.abs(bend) + 10;
        segs.push({
          ax: a.x, az: a.z, bx: b.x, bz: b.z, bend, len,
          minX: Math.min(a.x, b.x) - pad,
          maxX: Math.max(a.x, b.x) + pad,
          minZ: Math.min(a.z, b.z) - pad,
          maxZ: Math.max(a.z, b.z) + pad
        });
      };

      // Link every Village to its closest Great Pyramid / Mega Castle (up to 2 links) + closest Neighbor Village!
      for (const v of villages) {
        const sortedMegas = megas
          .map((m) => ({ m, d: Math.hypot(m.x - v.x, m.z - v.z) }))
          .filter((e) => e.d > 48 && e.d <= 480)
          .sort((a, b) => a.d - b.d);
        if (sortedMegas[0]) addSeg(v, sortedMegas[0].m);
        if (sortedMegas[1] && sortedMegas[1].d <= 280) addSeg(v, sortedMegas[1].m);

        let bestV = null, bestVd = 340;
        for (const v2 of villages) {
          if (v2 === v) continue;
          const d = Math.hypot(v2.x - v.x, v2.z - v.z);
          if (d > 64 && d < bestVd) { bestVd = d; bestV = v2; }
        }
        if (bestV) addSeg(v, bestV);
      }

      // Detect Bridge/Path Intersection Points -> Center Crossroads Outpost Hubs!
      const hubs = [];
      const evalSeg = (s, t) => {
        const dx = s.bx - s.ax, dz = s.bz - s.az;
        const nx = -dz / s.len, nz = dx / s.len;
        const curve = Math.sin(t * Math.PI) * s.bend;
        return { x: s.ax + dx * t + nx * curve, z: s.az + dz * t + nz * curve };
      };
      for (let i = 0; i < segs.length; i++) {
        for (let j = i + 1; j < segs.length; j++) {
          const s1 = segs[i], s2 = segs[j];
          if (s1.maxX < s2.minX || s1.minX > s2.maxX || s1.maxZ < s2.minZ || s1.minZ > s2.maxZ) continue;
          // Sample 10 chords per segment to accurately locate curved intersections (fast: only on overlapping AABBs!)
          let bestD = 5.5, bestPt = null;
          for (let a = 1; a <= 9; a++) {
            const p1 = evalSeg(s1, a * 0.1);
            for (let b = 1; b <= 9; b++) {
              const p2 = evalSeg(s2, b * 0.1);
              const d = Math.hypot(p1.x - p2.x, p1.z - p2.z);
              if (d < bestD) {
                bestD = d;
                bestPt = { x: Math.round((p1.x + p2.x) * 0.5), z: Math.round((p1.z + p2.z) * 0.5) };
              }
            }
          }
          if (bestPt) {
            // Avoid duplicates or hubs right on top of a Village/Mega endpoint
            let nearEnd = false;
            for (const ep of [
              { x: s1.ax, z: s1.az }, { x: s1.bx, z: s1.bz },
              { x: s2.ax, z: s2.az }, { x: s2.bx, z: s2.bz }
            ]) {
              if (Math.hypot(bestPt.x - ep.x, bestPt.z - ep.z) < 38) { nearEnd = true; break; }
            }
            if (!nearEnd && !hubs.some((h) => Math.hypot(h.x - bestPt.x, h.z - bestPt.z) < 22)) {
              hubs.push(bestPt);
            }
          }
        }
      }

      const bundle = { segs, hubs };
      if (this._roadRegionCache.size > 48) this._roadRegionCache.clear();
      this._roadRegionCache.set(rKey, bundle);
      return bundle;
    }
    return segs;
  }

  stampConnectingPaths(cx, cz, ox, oz, heights, biomes, setLocal, getLocal, noTreeMask) {
    const bundle = this._getRoadSegmentsForChunk(cx, cz);
    if (!bundle) return;
    const segs = Array.isArray(bundle) ? bundle : bundle.segs;
    const hubs = Array.isArray(bundle) ? [] : (bundle.hubs || []);
    if (!segs || segs.length === 0) return;

    // Fast chunk-level AABB cull so 90%+ of chunks exit immediately!
    const hits = [];
    const cMaxX = ox + 15, cMaxZ = oz + 15;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (cMaxX < s.minX || ox > s.maxX || cMaxZ < s.minZ || oz > s.maxZ) continue;
      hits.push(s);
    }
    const nearHubs = [];
    for (let i = 0; i < hubs.length; i++) {
      const h = hubs[i];
      if (cMaxX >= h.x - 6 && ox <= h.x + 6 && cMaxZ >= h.z - 6 && oz <= h.z + 6) nearHubs.push(h);
    }
    if (hits.length === 0 && nearHubs.length === 0) return;

    for (let lz = 0; lz < 16; lz++) {
      const wz = oz + lz;
      for (let lx = 0; lx < 16; lx++) {
        const wx = ox + lx;
        const idx2 = lx + (lz << 4);
        const biome = biomes[idx2];
        if (biome === 'Ocean' || biome === 'Deep Ocean') continue;

        let minDist = 999;
        let bestAlong = 0;
        let closeCount = 0;
        for (let hi = 0; hi < hits.length; hi++) {
          const s = hits[hi];
          const dx = s.bx - s.ax;
          const dz = s.bz - s.az;
          const invLen2 = 1 / (dx * dx + dz * dz);
          const t = Math.max(0, Math.min(1, ((wx - s.ax) * dx + (wz - s.az) * dz) * invLen2));
          // Gentle organic perpendicular arch so roads feel handcrafted, never ruler-straight!
          const nx = -dz / s.len;
          const nz = dx / s.len;
          const curve = Math.sin(t * Math.PI) * s.bend;
          const px = s.ax + dx * t + nx * curve;
          const pz = s.az + dz * t + nz * curve;
          const d = Math.hypot(wx - px, wz - pz);
          if (d <= 2.3) closeCount++;
          if (d < minDist) {
            minDist = d;
            bestAlong = t * s.len;
          }
        }

        if (minDist > 3.6) continue;
        // Clear tree exclusion buffer around roads so canopies never block highways!
        noTreeMask[idx2] = 1;

        const h = heights[idx2];
        if (h > SEA_LEVEL + 64) continue;
        const isDesertRoad = biome === 'Desert' || biome === 'Badlands';

        if (h <= SEA_LEVEL) {
          // Upgraded Wooden Plank Bridge across water:
          // - Walkable deck (minDist <= 1.35)
          // - Authentic Minecraft Oak Fence Railings (1.35 < minDist <= 2.15)
          // - Sturdy Oak Log Support Posts reaching all the way to the riverbed/seabed every ~12 blocks!
          // - Climbable 3D Wooden Ladder mounted on the outer side of each support post from underwater up to the deck!
          const by = SEA_LEVEL + 1;
          const onPostPeriod = Math.abs((bestAlong % 12) - 6) < 0.72;
          if (minDist <= 2.18) {
            const isRail = minDist > 1.32 && closeCount < 2;
            setLocal(lx, by, lz, isRail && onPostPeriod ? BLOCK.OAK_LOG : BLOCK.OAK_PLANKS);
            if (isRail) {
              // Leave opening at top of ladder post so players climb cleanly onto the bridge!
              setLocal(lx, by + 1, lz, onPostPeriod ? BLOCK.AIR : BLOCK.OAK_FENCE);
            } else {
              setLocal(lx, by + 1, lz, BLOCK.AIR);
            }
            setLocal(lx, by + 2, lz, BLOCK.AIR);
            setLocal(lx, by + 3, lz, BLOCK.AIR);
            // Full-depth Oak Log support post all the way down to the bottom of the river/lake!
            if (isRail && onPostPeriod) {
              for (let py = Math.max(1, h - 1); py < by; py++) {
                setLocal(lx, py, lz, BLOCK.OAK_LOG);
              }
              // Attach a climbable 3D Wooden Ladder column directly onto the outer water-facing side of this post!
              const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
              let bestDir = null, bestD = minDist;
              for (const [ddx, ddz] of dirs) {
                const nlx = lx + ddx, nlz = lz + ddz;
                if (nlx < 0 || nlx >= 16 || nlz < 0 || nlz >= 16) continue;
                const nwx = ox + nlx, nwz = oz + nlz;
                let ndMin = 999;
                for (let hi = 0; hi < hits.length; hi++) {
                  const s = hits[hi];
                  const sdx = s.bx - s.ax, sdz = s.bz - s.az;
                  const t2 = Math.max(0, Math.min(1, ((nwx - s.ax) * sdx + (nwz - s.az) * sdz) / (sdx * sdx + sdz * sdz)));
                  const c2 = Math.sin(t2 * Math.PI) * s.bend;
                  const d2 = Math.hypot(nwx - (s.ax + sdx * t2 + (-sdz / s.len) * c2), nwz - (s.az + sdz * t2 + (sdx / s.len) * c2));
                  if (d2 < ndMin) ndMin = d2;
                }
                if (ndMin > bestD) { bestD = ndMin; bestDir = [nlx, nlz]; }
              }
              if (bestDir) {
                const [llx, llz] = bestDir;
                const nh = heights[llx + (llz << 4)];
                const ladBottom = Math.max(Math.max(2, nh + 1), SEA_LEVEL - 4);
                for (let ly = ladBottom; ly <= by; ly++) {
                  const existing = getLocal(llx, ly, llz);
                  if (existing === BLOCK.AIR || existing === BLOCK.WATER) {
                    setLocal(llx, ly, llz, BLOCK.LADDER);
                  }
                }
              }
            }
          }
        } else {
          if (minDist > 1.85) {
            // Occasional rustic roadside torch signpost every ~28 blocks along one road edge!
            if (minDist >= 2.05 && minDist <= 2.75 && Math.abs((bestAlong % 28) - 14) < 0.75) {
              if (h > SEA_LEVEL + 1 && h < SEA_LEVEL + 52) {
                setLocal(lx, h + 1, lz, BLOCK.OAK_FENCE);
                setLocal(lx, h + 2, lz, BLOCK.OAK_FENCE);
                setLocal(lx, h + 3, lz, BLOCK.TORCH);
              }
            }
            continue;
          }
          // Terrain-hugging authentic Minecraft Dirt Path (or Sandstone Highway in Desert!)
          const roadBlk = isDesertRoad ? BLOCK.SANDSTONE : BLOCK.DIRT_PATH;
          setLocal(lx, h, lz, roadBlk);
          setLocal(lx, h + 1, lz, BLOCK.AIR);
          setLocal(lx, h + 2, lz, BLOCK.AIR);
          setLocal(lx, h + 3, lz, BLOCK.AIR);
        }
      }
    }

    // Stamp Crossroads Center Outpost Pavilion wherever two bridges or paths intersect!
    for (let hi = 0; hi < nearHubs.length; hi++) {
      const hub = nearHubs[hi];
      const hubRawH = this.getTerrainHeight(hub.x, hub.z);
      const isWaterHub = hubRawH <= SEA_LEVEL;
      const hubY = isWaterHub ? (SEA_LEVEL + 1) : Math.max(SEA_LEVEL + 1, Math.min(SEA_LEVEL + 56, hubRawH));
      for (let lz = 0; lz < 16; lz++) {
        const dz = (oz + lz) - hub.z;
        if (Math.abs(dz) > 4) continue;
        for (let lx = 0; lx < 16; lx++) {
          const dx = (ox + lx) - hub.x;
          if (Math.abs(dx) > 4) continue;
          const adx = Math.abs(dx), adz = Math.abs(dz);
          noTreeMask[lx + (lz << 4)] = 1;
          const isCorner = adx === 4 && adz === 4;
          const isEdge = adx === 4 || adz === 4;
          const isDoorway = (adx <= 1 && adz === 4) || (adz <= 1 && adx === 4);

          // Floor deck (cobblestone rim + oak plank plaza) & support pilings down to ground/riverbed!
          const curH = heights[lx + (lz << 4)];
          setLocal(lx, hubY, lz, isEdge ? BLOCK.COBBLESTONE : (((dx + dz) & 1) ? BLOCK.OAK_PLANKS : BLOCK.DIRT_PATH));
          if (isCorner || (!isWaterHub && curH < hubY)) {
            for (let py = Math.max(1, curH - 1); py < hubY; py++) {
              setLocal(lx, py, lz, isCorner ? BLOCK.OAK_LOG : BLOCK.COBBLESTONE);
            }
          }
          // Clear interior headroom
          for (let py = hubY + 1; py <= hubY + 6; py++) setLocal(lx, py, lz, BLOCK.AIR);

          // Corner pillars, Fence railings with 4 open gateways, pitched canopy roof & hanging Glowstone lantern!
          if (isCorner) {
            for (let py = 1; py <= 4; py++) setLocal(lx, hubY + py, lz, BLOCK.OAK_LOG);
            setLocal(lx, hubY + 5, lz, BLOCK.TORCH);
          } else if (isEdge && !isDoorway) {
            setLocal(lx, hubY + 1, lz, BLOCK.OAK_FENCE);
          }
          if (adx <= 3 && adz <= 3) {
            const roofY = hubY + 5 + (adx <= 1 && adz <= 1 ? 1 : 0);
            setLocal(lx, roofY, lz, ((adx + adz) & 1) === 0 ? BLOCK.WOOL_RED : BLOCK.WOOL_WHITE);
          }
          if (dx === 0 && dz === 0) {
            setLocal(lx, hubY + 4, lz, BLOCK.GLOWSTONE);
          }
          // Wayfarer Crafting Table & Supply Chest inside the Crossroads Outpost!
          if (dx === -3 && dz === -3) setLocal(lx, hubY + 1, lz, BLOCK.CRAFTING_TABLE);
          if (dx === 3 && dz === -3) {
            setLocal(lx, hubY + 1, lz, BLOCK.CHEST);
            const wKey = `${ox + lx},${hubY + 1},${oz + lz}`;
            if (!this.chests.has(wKey)) {
              const loot = new Array(27).fill(null);
              loot[0] = { id: 'bread', count: 6 };
              loot[1] = { id: 'torch', count: 16 };
              loot[2] = { id: 'oak_fence', count: 12 };
              loot[3] = { id: 'oak_fence_gate', count: 2 };
              loot[4] = { id: 'ladder', count: 8 };
              loot[5] = { id: 'emerald', count: 3 };
              this.chests.set(wKey, loot);
            }
          }
        }
      }
    }
  }

  // Standalone Underground Structures in normal chunks (Abandoned Mineshafts, Mossy Dungeon Crypts, Deep Lava Shrines!)
  buildUndergroundStructure(cx, cz, ox, oz, heights, setLocal) {
    if (!this.generateStructures) return;
    const gx = Math.floor(cx / 4);
    const gz = Math.floor(cz / 4);
    const rx = Math.floor(coordHash(gx * 53, gz * 79, this.seed + 2503) * 4);
    const rz = Math.floor(coordHash(gx * 89, gz * 31, this.seed + 2521) * 4);
    if (cx !== gx * 4 + rx || cz !== gz * 4 + rz) return;

    const minSurface = heights[8 + (8 << 4)];
    if (minSurface < 36) return;
    const roll = coordHash(cx * 41, cz * 67, this.seed + 2557);

    const placeChest = (lx, ly, lz, items) => {
      setLocal(lx, ly, lz, BLOCK.CHEST);
      const wKey = `${ox + lx},${ly},${oz + lz}`;
      if (!this.chests.has(wKey)) {
        const loot = new Array(27).fill(null);
        for (let i = 0; i < items.length && i < 27; i++) loot[i] = items[i];
        this.chests.set(wKey, loot);
      }
    };

    if (roll < 0.45) {
      // 1. ABANDONED MINESHAFT: Timber-framed cross galleries + ore veins + miner's chest!
      const y0 = 20 + Math.floor(coordHash(cx, cz, this.seed + 2601) * 16);
      if (y0 + 6 >= minSurface) return;
      for (let i = 1; i <= 14; i++) {
        // East-West & North-South timber galleries
        for (let w = -1; w <= 1; w++) {
          setLocal(i, y0, 8 + w, BLOCK.OAK_PLANKS);
          setLocal(8 + w, y0, i, BLOCK.OAK_PLANKS);
          for (let dy = 1; dy <= 3; dy++) {
            setLocal(i, y0 + dy, 8 + w, BLOCK.AIR);
            setLocal(8 + w, y0 + dy, i, BLOCK.AIR);
          }
        }
        // Oak log support arches every 4 blocks
        if (i % 4 === 2) {
          for (let dy = 1; dy <= 3; dy++) {
            setLocal(i, y0 + dy, 7, BLOCK.OAK_LOG);
            setLocal(i, y0 + dy, 9, BLOCK.OAK_LOG);
            setLocal(7, y0 + dy, i, BLOCK.OAK_LOG);
            setLocal(9, y0 + dy, i, BLOCK.OAK_LOG);
          }
          setLocal(i, y0 + 3, 8, BLOCK.OAK_PLANKS);
          setLocal(8, y0 + 3, i, BLOCK.OAK_PLANKS);
          setLocal(i, y0 + 2, 8, BLOCK.TORCH);
        }
      }
      // Exposed rich ore pocket on side wall
      setLocal(3, y0 + 1, 6, BLOCK.IRON_ORE);
      setLocal(4, y0 + 2, 6, BLOCK.GOLD_ORE);
      setLocal(12, y0 + 1, 10, BLOCK.COAL_ORE);
      placeChest(8, y0 + 1, 8, [
        { id: 'iron_ingot', count: 6 },
        { id: 'raw_gold', count: 5 },
        { id: 'bucket', count: 1 },
        { id: 'torch', count: 16 },
        { id: 'flint_and_steel', count: 1, durability: 64 },
        { id: 'bread', count: 5 }
      ]);
    } else if (roll < 0.78) {
      // 2. MOSSY STONE DUNGEON CRYPT: Hidden stone vault with torches & treasure chest!
      const y0 = 18 + Math.floor(coordHash(cx, cz, this.seed + 2707) * 18);
      if (y0 + 7 >= minSurface) return;
      for (let lz = 4; lz <= 12; lz++) {
        for (let lx = 4; lx <= 12; lx++) {
          const wall = lx === 4 || lx === 12 || lz === 4 || lz === 12;
          setLocal(lx, y0, lz, ((lx + lz) & 1) ? BLOCK.MOSSY_COBBLESTONE : BLOCK.COBBLESTONE);
          setLocal(lx, y0 + 5, lz, BLOCK.STONE_BRICKS);
          for (let dy = 1; dy <= 4; dy++) {
            setLocal(lx, y0 + dy, lz, wall ? (((lx + lz + dy) % 3 === 0) ? BLOCK.MOSSY_COBBLESTONE : BLOCK.STONE_BRICKS) : BLOCK.AIR);
          }
        }
      }
      // Entrance arch & inner torch pillars
      setLocal(8, y0 + 1, 4, BLOCK.AIR);
      setLocal(8, y0 + 2, 4, BLOCK.AIR);
      setLocal(6, y0 + 1, 6, BLOCK.STONE_BRICKS);
      setLocal(6, y0 + 2, 6, BLOCK.TORCH);
      setLocal(10, y0 + 1, 10, BLOCK.STONE_BRICKS);
      setLocal(10, y0 + 2, 10, BLOCK.TORCH);
      setLocal(8, y0 + 4, 8, BLOCK.GLOWSTONE);
      placeChest(8, y0 + 1, 10, [
        { id: 'diamond', count: 2 },
        { id: 'emerald', count: 5 },
        { id: 'golden_pickaxe', count: 1, durability: 64 },
        { id: 'golden_helmet', count: 1, durability: 77 },
        { id: 'spawn_zombie', count: 1 },
        { id: 'water_bucket', count: 1 }
      ]);
    } else {
      // 3. DEEP OBSIDIAN LAVA SHRINE: Ancient underground obsidian chamber with glowing lava pit!
      const y0 = 13 + Math.floor(coordHash(cx, cz, this.seed + 2801) * 8);
      if (y0 + 7 >= minSurface) return;
      for (let lz = 4; lz <= 12; lz++) {
        for (let lx = 4; lx <= 12; lx++) {
          const wall = lx === 4 || lx === 12 || lz === 4 || lz === 12;
          const centerPit = lx >= 7 && lx <= 9 && lz >= 7 && lz <= 9;
          setLocal(lx, y0, lz, centerPit ? BLOCK.LAVA : BLOCK.OBSIDIAN);
          setLocal(lx, y0 - 1, lz, BLOCK.OBSIDIAN);
          setLocal(lx, y0 + 5, lz, BLOCK.OBSIDIAN);
          for (let dy = 1; dy <= 4; dy++) {
            setLocal(lx, y0 + dy, lz, wall ? BLOCK.STONE_BRICKS : BLOCK.AIR);
          }
        }
      }
      for (const [px, pz] of [[5, 5], [11, 5], [5, 11], [11, 11]]) {
        for (let dy = 1; dy <= 4; dy++) setLocal(px, y0 + dy, pz, dy === 4 ? BLOCK.GOLD_BLOCK : BLOCK.OBSIDIAN);
      }
      setLocal(8, y0 + 1, 4, BLOCK.AIR);
      setLocal(8, y0 + 2, 4, BLOCK.AIR);
      placeChest(8, y0 + 1, 11, [
        { id: 'diamond', count: 4 },
        { id: 'gold_ingot', count: 8 },
        { id: 'lava_bucket', count: 1 },
        { id: 'water_bucket', count: 1 },
        { id: 'obsidian', count: 6 },
        { id: 'flint_and_steel', count: 1, durability: 64 }
      ]);
    }
  }

  generateChunk(cx, cz) {
    const key = this.chunkKey(cx, cz);
    if (this.chunks.has(key)) return this.chunks.get(key);

    const data = new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE);
    let maxY = 1;
    const setLocal = (lx, y, lz, id) => {
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 0 || y >= CHUNK_HEIGHT) return;
      data[lx + (lz << 4) + (y << 8)] = id;
      if (id !== 0 && y > maxY) maxY = y;
    };
    const getLocal = (lx, y, lz) => {
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 0 || y >= CHUNK_HEIGHT) return 0;
      return data[lx + (lz << 4) + (y << 8)];
    };

    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;

    const heights = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);
    const padHeights = new Int16Array(18 * 18); // 1-block border padding for zero-recompute slope!
    const biomes = new Array(CHUNK_SIZE * CHUNK_SIZE);
    let chunkPeakH = SEA_LEVEL;

    // Precompute padded heightmap & biome map in a single noise pass
    for (let pz = 0; pz < 18; pz++) {
      const wz = oz + pz - 1;
      for (let px = 0; px < 18; px++) {
        const wx = ox + px - 1;
        const col = this.sampleColumn(wx, wz);
        padHeights[px + pz * 18] = col.height;
        if (px >= 1 && px <= 16 && pz >= 1 && pz <= 16) {
          const idx2 = (px - 1) + ((pz - 1) << 4);
          biomes[idx2] = col.biome;
          heights[idx2] = col.height;
          if (col.height > chunkPeakH) chunkPeakH = col.height;
        }
      }
    }

    // Precompute dual coarse 4x4x4 3D cave grids (Minecraft 1.18 Spaghetti Tunnels + Cheese Caverns, up to Y=248!)
    const isFlat = this.worldType === 'flat';
    const megaPre = !isFlat ? this.getMegaStructureForChunk(cx, cz) : null;
    const vInfoPre = !isFlat && !megaPre ? this.getVillageForChunk(cx, cz) : null;
    const structTypePre = !isFlat && !megaPre && !vInfoPre ? this.getStructureTypeForChunk(cx, cz) : null;
    const maxCaveCellY = (isFlat || megaPre) ? 0 : Math.min(62, Math.ceil((chunkPeakH + 1) / 4));
    if (!isFlat && !megaPre) {
      for (let cy = 0; cy <= maxCaveCellY; cy++) {
        const wy = cy * 4;
        const yBase = cy * 25;
        for (let czg = 0; czg < 5; czg++) {
          const wz = oz + czg * 4;
          const zBase = yBase + czg * 5;
          for (let cxg = 0; cxg < 5; cxg++) {
            const wx = ox + cxg * 4;
            // Winding spaghetti noise pair + cheese cavern field
            CAVE_GRID[zBase + cxg] = this.caveNoise.noise3D(wx * 0.036, wy * 0.056, wz * 0.036);
            CAVE_GRID_B[zBase + cxg] = this.oreNoise.noise3D(wx * 0.036 + 131.7, wy * 0.056 - 73.4, wz * 0.036 + 59.2);
          }
        }
      }
    }

    const SNOW_LINE = SEA_LEVEL + 64; // Y = 128 alpine snow caps!
    const ROCK_LINE = SEA_LEVEL + 46; // Y = 110 high granite cliffs!
    const TERRACOTTA_BANDS = [
      BLOCK.TERRACOTTA, BLOCK.TERRACOTTA_ORANGE, BLOCK.TERRACOTTA,
      BLOCK.TERRACOTTA_RED, BLOCK.TERRACOTTA_YELLOW, BLOCK.TERRACOTTA,
      BLOCK.TERRACOTTA_ORANGE, BLOCK.TERRACOTTA_RED
    ];

    // 1. Base Terrain + Jagged Bedrock (y=0..4) + Spaghetti/Cheese Caves + Surface Cave Mouths & Ravines!
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const gz = lz >> 2;
      const fz = (lz & 3) * 0.25;
      const wz = oz + lz;
      const padRow = (lz + 1) * 18;
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const gx = lx >> 2;
        const fx = (lx & 3) * 0.25;
        const wx = ox + lx;
        const idx2 = lx + (lz << 4);
        const biome = biomes[idx2];
        const h = heights[idx2];

        const padIdx = padRow + (lx + 1);
        const hL = padHeights[padIdx - 1];
        const hR = padHeights[padIdx + 1];
        const hD = padHeights[padIdx - 18];
        const hU = padHeights[padIdx + 18];
        const slope = Math.max(Math.abs(h - hL), Math.abs(h - hR), Math.abs(h - hD), Math.abs(h - hU));

        const colBase = lx + (lz << 4);
        const fillTopY = isFlat ? h : Math.max(h, SEA_LEVEL);
        if (fillTopY > maxY) maxY = fillTopY;

        // Layer 0: 100% solid unbreakable Minecraft Bedrock floor!
        data[colBase] = BLOCK.BEDROCK;

        // Surface Cave Entrance & Canyon Ravine fields (avoid mega-structures, villages, structures & under-ocean flooding!)
        let allowSurfaceCave = false;
        let ravineBottomY = 999;
        if (!isFlat && !megaPre && !vInfoPre && !structTypePre && h >= SEA_LEVEL + 2 && biome !== 'Swamp') {
          const mouthN = this.caveNoise.fbm2D(wx * 0.0115 - 310, wz * 0.0115 + 220, 2);
          if (mouthN > 0.22) allowSurfaceCave = true;
          if (h >= SEA_LEVEL + 6) {
            const ravRaw = Math.abs(this.oreNoise.fbm2D(wx * 0.0085 + 77, wz * 0.0085 - 41, 2));
            if (ravRaw < 0.020) {
              const ravT = 1.0 - ravRaw / 0.020;
              const ravDepth = Math.floor(ravT * ravT * 28 + 6);
              ravineBottomY = Math.max(10, h - ravDepth);
            }
          }
        }

        const caveMaxY = allowSurfaceCave ? h : (h - 2);
        for (let y = 1; y <= h; y++) {
          // Authentic Jagged Minecraft Bedrock Layers (y = 1..4)!
          if (y <= 4) {
            const brHash = coordHash(wx * 13 + y * 37, wz * 17 - y * 29, this.seed + 555);
            const brChance = isFlat
              ? (y === 1 ? 0.55 : 0)
              : (y === 1 ? 0.82 : (y === 2 ? 0.56 : (y === 3 ? 0.30 : 0.12)));
            if (brHash < brChance) {
              data[colBase + (y << 8)] = BLOCK.BEDROCK;
              continue;
            }
          }

          // Multi-Layer Cave & Ravine Carving (capped cleanly within CAVE_GRID bounds!)
          if (!isFlat && !megaPre && y >= 5 && y <= caveMaxY && y < 248) {
            if (y >= ravineBottomY) continue; // AIR!

            const gy = y >> 2;
            const fy = (y & 3) * 0.25;
            const i000 = gy * 25 + gz * 5 + gx;
            const i100 = i000 + 1;
            const i010 = i000 + 5;
            const i110 = i010 + 1;
            const i001 = i000 + 25;
            const i101 = i001 + 1;
            const i011 = i001 + 5;
            const i111 = i011 + 1;

            const a00 = CAVE_GRID[i000] + (CAVE_GRID[i100] - CAVE_GRID[i000]) * fx;
            const a10 = CAVE_GRID[i010] + (CAVE_GRID[i110] - CAVE_GRID[i010]) * fx;
            const a01 = CAVE_GRID[i001] + (CAVE_GRID[i101] - CAVE_GRID[i001]) * fx;
            const a11 = CAVE_GRID[i011] + (CAVE_GRID[i111] - CAVE_GRID[i011]) * fx;
            const nA = (a00 + (a10 - a00) * fz) + ((a01 + (a11 - a01) * fz) - (a00 + (a10 - a00) * fz)) * fy;

            const b00 = CAVE_GRID_B[i000] + (CAVE_GRID_B[i100] - CAVE_GRID_B[i000]) * fx;
            const b10 = CAVE_GRID_B[i010] + (CAVE_GRID_B[i110] - CAVE_GRID_B[i010]) * fx;
            const b01 = CAVE_GRID_B[i001] + (CAVE_GRID_B[i101] - CAVE_GRID_B[i001]) * fx;
            const b11 = CAVE_GRID_B[i011] + (CAVE_GRID_B[i111] - CAVE_GRID_B[i011]) * fx;
            const nB = (b00 + (b10 - b00) * fz) + ((b01 + (b11 - b01) * fz) - (b00 + (b10 - b00) * fz)) * fy;

            const depthBoost = y < 44 ? 0.005 : 0.0;
            const isSpaghetti = (nA * nA + nB * nB) < (0.0155 + depthBoost);
            const isCheese = y >= 8 && y <= 46 && nA > 0.35;

            if (isSpaghetti || isCheese) {
              // Deep subterranean glowing Lava Lakes near bedrock (y <= 11)!
              if (y <= 11 && !allowSurfaceCave) {
                data[colBase + (y << 8)] = BLOCK.LAVA;
              }
              continue;
            }
          }

          let blk;
          if (biome === 'Badlands' && y >= SEA_LEVEL - 2) {
            if (y === h && h <= SEA_LEVEL + 6) blk = BLOCK.RED_SAND;
            else if (y >= h - 18) blk = TERRACOTTA_BANDS[(y + Math.floor(coordHash(wx >> 2, wz >> 2, this.seed + 19) * 2)) & 7];
            else blk = BLOCK.STONE;
          } else if (y === h) {
            if (h < SEA_LEVEL + 1 && !isFlat) {
              if (biome === 'Swamp') blk = BLOCK.MUD;
              else blk = (slope >= 2 && biome === 'Mountains') ? BLOCK.GRAVEL : BLOCK.SAND;
            } else if (biome === 'Desert') {
              blk = BLOCK.SAND;
            } else if (h >= SNOW_LINE + 28 && slope >= 2) {
              blk = BLOCK.PACKED_ICE;
            } else if (h >= SNOW_LINE || (biome === 'Snowy Taiga' && slope <= 2)) {
              blk = BLOCK.SNOW;
            } else if (slope >= 3 && h > SEA_LEVEL + 6) {
              blk = BLOCK.STONE;
            } else if (h >= ROCK_LINE && slope >= 2) {
              blk = coordHash(wx, wz, this.seed + 41) > 0.65 ? BLOCK.GRAVEL : BLOCK.STONE;
            } else if (biome === 'Savanna') {
              blk = BLOCK.SAVANNA_GRASS;
            } else if (biome === 'Jungle') {
              blk = BLOCK.JUNGLE_GRASS;
            } else if (biome === 'Swamp') {
              blk = coordHash(wx, wz, this.seed + 47) > 0.72 ? BLOCK.MUD : BLOCK.SWAMP_GRASS;
            } else {
              blk = BLOCK.GRASS;
            }
          } else if (y >= h - 3) {
            if (biome === 'Desert') blk = y >= h - 2 ? BLOCK.SAND : BLOCK.SANDSTONE;
            else if (biome === 'Swamp') blk = BLOCK.MUD;
            else if (slope >= 3 || h >= ROCK_LINE + 4) blk = BLOCK.STONE;
            else blk = BLOCK.DIRT;
          } else {
            blk = BLOCK.STONE;
          }
          data[colBase + (y << 8)] = blk;
        }

        if (!isFlat && h < SEA_LEVEL) {
          for (let y = h + 1; y <= SEA_LEVEL; y++) {
            data[colBase + (y << 8)] = (y === SEA_LEVEL && biome === 'Snowy Taiga') ? BLOCK.ICE : BLOCK.WATER;
          }
        }
      }
    }

    // 1b. Authentic Deterministic Minecraft Ore Veins (deep caves + high mountain veins!)
    if (!isFlat) {
      const placeVeins = (blockId, count, minY, maxY, veinSize, salt) => {
        for (let v = 0; v < count; v++) {
          let vx = Math.floor(coordHash(cx * 31 + v, cz * 17 + salt, this.seed + salt) * 14) + 1;
          let vz = Math.floor(coordHash(cx * 19 + salt, cz * 29 + v, this.seed + salt + 7) * 14) + 1;
          let vy = minY + Math.floor(coordHash(cx + v * 7, cz - v * 11, this.seed + salt + 19) * (maxY - minY));
          for (let s = 0; s < veinSize; s++) {
            if (vx >= 0 && vx < 16 && vz >= 0 && vz < 16 && vy > 1 && vy < CHUNK_HEIGHT - 4) {
              const idx = vx + (vz << 4) + (vy << 8);
              if (data[idx] === BLOCK.STONE) data[idx] = blockId;
            }
            const step = Math.floor(coordHash(vx * 13 + s, vz * 23 + vy, this.seed + salt + 53) * 6);
            if (step === 0) vx++;
            else if (step === 1) vx--;
            else if (step === 2) vz++;
            else if (step === 3) vz--;
            else if (step === 4) vy++;
            else vy--;
          }
        }
      };
      placeVeins(BLOCK.COAL_ORE, 18, 8, Math.min(145, chunkPeakH), 8, 101);
      placeVeins(BLOCK.IRON_ORE, 14, 6, Math.min(118, chunkPeakH), 7, 202);
      placeVeins(BLOCK.GOLD_ORE, 7, 6, 52, 5, 303);
      placeVeins(BLOCK.DIAMOND_ORE, 5, 4, 28, 5, 404);
      placeVeins(BLOCK.GRAVEL, 4, 8, 56, 8, 505);
    }

    // 2. Mega-Structures, Underground Structures, Villages, 7 Biome Structures (with Tree Exclusion Mask!), OR Biome-Specific Trees
    const noTreeMask = new Uint8Array(256);
    if (megaPre) {
      this.buildMegaStructureChunk(megaPre, cx, cz, ox, oz, heights, setLocal, getLocal, noTreeMask);
    } else if (vInfoPre) {
      this.buildVillageDistrict(cx, cz, ox, oz, heights, setLocal, getLocal, vInfoPre);
    } else if (structTypePre) {
      this.buildWorldStructure(structTypePre, cx, cz, ox, oz, heights, setLocal, getLocal, noTreeMask);
    }

    // Standalone Underground Structures (Abandoned Mineshafts, Mossy Dungeon Crypts, Deep Obsidian Lava Shrines)
    if (!isFlat && !megaPre) {
      this.buildUndergroundStructure(cx, cz, ox, oz, heights, setLocal);
    }

    // Inter-Landmark Connecting Dirt Paths linking Villages <-> Great Pyramids <-> Mega Castles!
    if (!isFlat && !megaPre && !vInfoPre && !structTypePre) {
      this.stampConnectingPaths(cx, cz, ox, oz, heights, biomes, setLocal, getLocal, noTreeMask);
    }

    // Also pad chunk borders adjacent to a neighboring Mega-Structure, Village or Structure so canopies NEVER poke inside!
    if (!isFlat && !megaPre && !vInfoPre) {
      const adjN = !!(this.getMegaStructureForChunk(cx, cz - 1) || this.getVillageForChunk(cx, cz - 1) || this.getStructureTypeForChunk(cx, cz - 1));
      const adjS = !!(this.getMegaStructureForChunk(cx, cz + 1) || this.getVillageForChunk(cx, cz + 1) || this.getStructureTypeForChunk(cx, cz + 1));
      const adjW = !!(this.getMegaStructureForChunk(cx - 1, cz) || this.getVillageForChunk(cx - 1, cz) || this.getStructureTypeForChunk(cx - 1, cz));
      const adjE = !!(this.getMegaStructureForChunk(cx + 1, cz) || this.getVillageForChunk(cx + 1, cz) || this.getStructureTypeForChunk(cx + 1, cz));
      if (adjN || adjS || adjW || adjE) {
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            if ((adjN && z < 4) || (adjS && z > 11) || (adjW && x < 4) || (adjE && x > 11)) {
              noTreeMask[x + (z << 4)] = 1;
            }
          }
        }
      }
    }

    if (!isFlat && !megaPre && !vInfoPre) {
      const isNaturalGround = (b) => (
        b === BLOCK.GRASS || b === BLOCK.SAVANNA_GRASS || b === BLOCK.JUNGLE_GRASS ||
        b === BLOCK.SWAMP_GRASS || b === BLOCK.SNOW || b === BLOCK.MUD
      );
      const canPlaceLeaf = (lx, y, lz) => {
        if (lx < 0 || lx >= 16 || lz < 0 || lz >= 16) return false;
        if (noTreeMask[lx + (lz << 4)]) return false;
        return getLocal(lx, y, lz) === BLOCK.AIR;
      };

      for (let lz = 2; lz < CHUNK_SIZE - 2; lz++) {
        for (let lx = 2; lx < CHUNK_SIZE - 2; lx++) {
          if (noTreeMask[lx + (lz << 4)]) continue;
          const wx = ox + lx;
          const wz = oz + lz;
          const h = heights[lx + lz * CHUNK_SIZE];
          const biome = biomes[lx + lz * CHUNK_SIZE];
          const topBlock = getLocal(lx, h, lz);
          if (h <= SEA_LEVEL || h >= CHUNK_HEIGHT - 16) continue;
          if (getLocal(lx, h + 1, lz) !== BLOCK.AIR) continue;

          const r = coordHash(wx, wz, this.seed + 77);
          const treeChance =
            biome === 'Jungle' ? 0.068 :
            biome === 'Forest' ? 0.052 :
            biome === 'Birch Forest' ? 0.048 :
            biome === 'Cherry Grove' ? 0.042 :
            biome === 'Snowy Taiga' ? 0.040 :
            biome === 'Swamp' ? 0.032 :
            biome === 'Savanna' ? 0.018 :
            biome === 'Plains' ? 0.008 : 0;

          if (r < treeChance && isNaturalGround(topBlock) && h < SNOW_LINE - 2) {
            const styleR = coordHash(wx, wz, this.seed + 88);
            if (biome === 'Savanna') {
              // Iconic Flat-Topped Forked Acacia Tree!
              const trunkH = 4 + Math.floor(styleR * 2);
              const leanX = styleR > 0.5 ? 1 : -1;
              for (let ty = 1; ty <= trunkH - 1; ty++) setLocal(lx, h + ty, lz, BLOCK.ACACIA_LOG);
              const topX = Math.max(2, Math.min(13, lx + leanX));
              setLocal(topX, h + trunkH, lz, BLOCK.ACACIA_LOG);
              setLocal(topX, h + trunkH + 1, lz, BLOCK.ACACIA_LOG);
              for (let dz = -2; dz <= 2; dz++) {
                for (let dx = -2; dx <= 2; dx++) {
                  if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
                  if (canPlaceLeaf(topX + dx, h + trunkH + 1, lz + dz)) setLocal(topX + dx, h + trunkH + 1, lz + dz, BLOCK.ACACIA_LEAVES);
                }
              }
              for (let dz = -1; dz <= 1; dz++) {
                for (let dx = -1; dx <= 1; dx++) {
                  if (canPlaceLeaf(topX + dx, h + trunkH + 2, lz + dz)) setLocal(topX + dx, h + trunkH + 2, lz + dz, BLOCK.ACACIA_LEAVES);
                }
              }
            } else if (biome === 'Jungle') {
              // Towering Lush Jungle Tree with wide multi-tier canopy!
              const trunkH = 7 + Math.floor(styleR * 5);
              for (let ty = 1; ty <= trunkH; ty++) setLocal(lx, h + ty, lz, BLOCK.JUNGLE_LOG);
              for (let dy = trunkH - 2; dy <= trunkH + 2; dy++) {
                const rad = dy >= trunkH + 1 ? 1 : (dy === trunkH - 2 ? 2 : 3);
                for (let dz = -rad; dz <= rad; dz++) {
                  for (let dx = -rad; dx <= rad; dx++) {
                    if (dx === 0 && dz === 0 && dy <= trunkH) continue;
                    if (dx * dx + dz * dz > rad * rad + 1) continue;
                    if (canPlaceLeaf(lx + dx, h + dy, lz + dz)) setLocal(lx + dx, h + dy, lz + dz, BLOCK.JUNGLE_LEAVES);
                  }
                }
              }
            } else if (biome === 'Cherry Grove') {
              // Graceful Pink Cherry Blossom Tree!
              const trunkH = 5 + Math.floor(styleR * 2);
              for (let ty = 1; ty <= trunkH; ty++) setLocal(lx, h + ty, lz, BLOCK.CHERRY_LOG);
              for (let dy = trunkH - 1; dy <= trunkH + 2; dy++) {
                const rad = dy === trunkH + 2 ? 1 : (dy === trunkH - 1 ? 3 : 2);
                for (let dz = -rad; dz <= rad; dz++) {
                  for (let dx = -rad; dx <= rad; dx++) {
                    if (dx === 0 && dz === 0 && dy <= trunkH) continue;
                    if (dx * dx + dz * dz > rad * rad + 1) continue;
                    if (canPlaceLeaf(lx + dx, h + dy, lz + dz)) setLocal(lx + dx, h + dy, lz + dz, BLOCK.CHERRY_LEAVES);
                  }
                }
              }
            } else if (biome === 'Swamp') {
              // Squat Broad-Canopied Swamp Oak with Draped Leaves!
              const trunkH = 4 + Math.floor(styleR * 2);
              for (let ty = 1; ty <= trunkH; ty++) setLocal(lx, h + ty, lz, BLOCK.OAK_LOG);
              for (let dy = trunkH - 1; dy <= trunkH + 1; dy++) {
                const rad = dy === trunkH + 1 ? 1 : 2;
                for (let dz = -rad; dz <= rad; dz++) {
                  for (let dx = -rad; dx <= rad; dx++) {
                    if (dx === 0 && dz === 0 && dy <= trunkH) continue;
                    if (canPlaceLeaf(lx + dx, h + dy, lz + dz)) setLocal(lx + dx, h + dy, lz + dz, BLOCK.OAK_LEAVES);
                  }
                }
              }
            } else if (biome === 'Snowy Taiga') {
              // Tall conical Alpine Spruce
              const trunkH = 6 + Math.floor(styleR * 3);
              for (let ty = 1; ty <= trunkH; ty++) setLocal(lx, h + ty, lz, BLOCK.SPRUCE_LOG);
              for (let dy = 2; dy <= trunkH + 2; dy++) {
                const rad = dy >= trunkH + 1 ? 0 : (dy >= trunkH - 1 ? 1 : (dy % 2 === 0 ? 2 : 1));
                for (let dz = -rad; dz <= rad; dz++) {
                  for (let dx = -rad; dx <= rad; dx++) {
                    if (dx === 0 && dz === 0 && dy <= trunkH) continue;
                    if (rad === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
                    if (canPlaceLeaf(lx + dx, h + dy, lz + dz)) setLocal(lx + dx, h + dy, lz + dz, BLOCK.SPRUCE_LEAVES);
                  }
                }
              }
            } else {
              const mixedBirch = biome === 'Forest' && coordHash(wx, wz, this.seed + 61) > 0.78;
              const logType = (biome === 'Birch Forest' || mixedBirch) ? BLOCK.BIRCH_LOG : BLOCK.OAK_LOG;
              const leafType = (biome === 'Birch Forest' || mixedBirch) ? BLOCK.BIRCH_LEAVES : BLOCK.OAK_LEAVES;

              if (logType === BLOCK.OAK_LOG && styleR > 0.72 && lx >= 3 && lx <= CHUNK_SIZE - 4 && lz >= 3 && lz <= CHUNK_SIZE - 4) {
                const trunkH = 6 + Math.floor((styleR - 0.72) * 8);
                for (let ty = 1; ty <= trunkH; ty++) setLocal(lx, h + ty, lz, logType);
                for (let dy = trunkH - 2; dy <= trunkH + 3; dy++) {
                  const rad = (dy === trunkH + 3) ? 1 : (dy === trunkH - 2 || dy === trunkH + 2 ? 2 : 3);
                  for (let dz = -rad; dz <= rad; dz++) {
                    for (let dx = -rad; dx <= rad; dx++) {
                      if (dx === 0 && dz === 0 && dy <= trunkH) continue;
                      if (dx * dx + dz * dz > rad * rad + 1) continue;
                      if (canPlaceLeaf(lx + dx, h + dy, lz + dz)) setLocal(lx + dx, h + dy, lz + dz, leafType);
                    }
                  }
                }
              } else {
                const trunkH = 4 + Math.floor(styleR * 3);
                for (let ty = 1; ty <= trunkH; ty++) setLocal(lx, h + ty, lz, logType);
                for (let dy = trunkH - 1; dy <= trunkH + 2; dy++) {
                  const rad = dy >= trunkH + 1 ? 1 : 2;
                  for (let dz = -rad; dz <= rad; dz++) {
                    for (let dx = -rad; dx <= rad; dx++) {
                      if (dx === 0 && dz === 0 && dy <= trunkH) continue;
                      if (Math.abs(dx) === rad && Math.abs(dz) === rad && dy === trunkH + 2) continue;
                      if (canPlaceLeaf(lx + dx, h + dy, lz + dz)) setLocal(lx + dx, h + dy, lz + dz, leafType);
                    }
                  }
                }
              }
            }
          } else if ((biome === 'Desert' || biome === 'Badlands') && (topBlock === BLOCK.SAND || topBlock === BLOCK.RED_SAND) && r < 0.012) {
            const ch = 2 + Math.floor(coordHash(wx, wz, this.seed + 99) * 3);
            for (let cy = 1; cy <= ch; cy++) setLocal(lx, h + cy, lz, BLOCK.CACTUS);
          } else if (isNaturalGround(topBlock) && topBlock !== BLOCK.SNOW && topBlock !== BLOCK.MUD) {
            const meadowPatch = this.moistureNoise.noise2D(wx * 0.09, wz * 0.09);
            const grassThresh = biome === 'Jungle' ? 0.56 : (biome === 'Plains' || biome === 'Cherry Grove' ? (meadowPatch > 0.0 ? 0.66 : 0.84) : 0.78);
            if (r > grassThresh) {
              if (r > 0.972 || (biome === 'Cherry Grove' && r > 0.92)) setLocal(lx, h + 1, lz, BLOCK.FLOWER_RED);
              else if (r > 0.952) setLocal(lx, h + 1, lz, BLOCK.FLOWER_YELLOW);
              else setLocal(lx, h + 1, lz, BLOCK.TALL_GRASS);
            }
          }
        }
      }
    }

    // 3. Apply player-modified blocks in this chunk in O(1)!
    const chunkMods = this.modsByChunk.get(key);
    if (chunkMods) {
      for (const [idx, blockId] of chunkMods.entries()) {
        data[idx] = blockId;
        const my = idx >> 8;
        if (blockId !== 0 && my > maxY) maxY = my;
        if (blockId >= BLOCK.WHEAT_0 && blockId < BLOCK.WHEAT_7) {
          const lxM = idx & 15, lzM = (idx >> 4) & 15;
          const wxM = ox + lxM, wzM = oz + lzM;
          this.activeCrops.set(`${wxM},${my},${wzM}`, { x: wxM, y: my, z: wzM, timer: 4 + Math.random() * 6 });
        } else if (isFarmlandBlock(blockId)) {
          const lxM = idx & 15, lzM = (idx >> 4) & 15;
          const wxM = ox + lxM, wzM = oz + lzM;
          this.activeFarmlands.set(`${wxM},${my},${wzM}`, { x: wxM, y: my, z: wzM, timer: 1.5 + Math.random() * 2, dryAge: 0 });
        }
      }
    }

    const chunk = { cx, cz, key, data, maxY, meshes: [], dirty: true, queued: false };
    this.chunks.set(key, chunk);

    // Trigger natural flowing physics for any naturally spawned overhanging Water or Lava (e.g. cave waterfalls/lavafalls!)
    if (!isFlat && this.fluidQueue.size < 220) {
      let queuedNat = 0;
      const scanMaxY = Math.min(SEA_LEVEL + 2, maxY);
      for (let y = 6; y <= scanMaxY && queuedNat < 8; y++) {
        const yOff = y << 8;
        const yBelow = (y - 1) << 8;
        for (let lz = 1; lz < 15 && queuedNat < 8; lz++) {
          const zOff = lz << 4;
          for (let lx = 1; lx < 15 && queuedNat < 8; lx++) {
            const b = data[lx + zOff + yOff];
            if ((b === BLOCK.WATER || b === BLOCK.LAVA) && data[lx + zOff + yBelow] === BLOCK.AIR) {
              this.scheduleFluid(ox + lx, y, oz + lz, b);
              queuedNat++;
            }
          }
        }
      }
    }

    return chunk;
  }

  getBlock(wx, wy, wz) {
    const y = Math.floor(wy);
    if (y < 0 || y >= CHUNK_HEIGHT) return BLOCK.AIR;
    const x = Math.floor(wx);
    const z = Math.floor(wz);
    const cx = x >> 4;
    const cz = z >> 4;
    const chunk = this.chunks.get((cx + 32768) * 65536 + (cz + 32768));
    if (!chunk || y > chunk.maxY) return BLOCK.AIR;
    return chunk.data[(x & 15) + ((z & 15) << 4) + (y << 8)];
  }

  setBlock(wx, wy, wz, blockId, record = true) {
    const x = Math.floor(wx);
    const y = Math.floor(wy);
    const z = Math.floor(wz);
    if (y < 0 || y >= CHUNK_HEIGHT) return;

    if (record) {
      this.modifiedBlocks.set(`${x},${y},${z}`, blockId);
      this.indexModifiedBlock(x, y, z, blockId);
    }

    // Clean up tile entities if broken
    const bKey = `${x},${y},${z}`;
    if (blockId === BLOCK.AIR) {
      this.chests.delete(bKey);
      this.furnaces.delete(bKey);
      this.doorStates.delete(bKey);
      this.gateStates.delete(bKey);
      this.ladderStates.delete(bKey);
    } else if (blockId === BLOCK.CHEST && !this.chests.has(bKey)) {
      this.chests.set(bKey, new Array(27).fill(null));
    } else if (blockId === BLOCK.FURNACE && !this.furnaces.has(bKey)) {
      this.furnaces.set(bKey, {
        input: null, fuel: null, output: null,
        burnTime: 0, burnMax: 0, cookTime: 0
      });
    }

    // Track placed/removed light-emitting blocks for real dynamic PointLights
    if (blockId === BLOCK.TORCH || blockId === BLOCK.GLOWSTONE || blockId === BLOCK.FIRE || blockId === BLOCK.LAVA) {
      this.lightSources.set(bKey, { x, y, z, isGlowstone: blockId === BLOCK.GLOWSTONE || blockId === BLOCK.LAVA });
      this._lightDirty = true;
    } else if (this.lightSources.delete(bKey)) {
      this._lightDirty = true;
    }

    // Track active Fire blocks for realistic spreading & burning!
    if (blockId === BLOCK.FIRE) {
      if (!this.activeFires.has(bKey)) {
        this.activeFires.set(bKey, { x, y, z, age: 0, timer: 0.55 + Math.random() * 0.9 });
      }
    } else {
      this.activeFires.delete(bKey);
    }

    // Track growing Wheat crops & Hydrated/Dry Farmland!
    if (blockId >= BLOCK.WHEAT_0 && blockId < BLOCK.WHEAT_7) {
      if (!this.activeCrops.has(bKey)) {
        this.activeCrops.set(bKey, { x, y, z, timer: 6 + Math.random() * 7 });
      }
    } else {
      this.activeCrops.delete(bKey);
    }
    if (isFarmlandBlock(blockId)) {
      if (!this.activeFarmlands.has(bKey)) {
        this.activeFarmlands.set(bKey, { x, y, z, timer: 1.2 + Math.random() * 1.8, dryAge: 0 });
      }
    } else {
      this.activeFarmlands.delete(bKey);
    }

    const cx = x >> 4;
    const cz = z >> 4;
    const chunk = this.chunks.get(this.chunkKey(cx, cz));
    if (!chunk) return;

    const lx = x & 15;
    const lz = z & 15;
    const cellIdx = lx + (lz << 4) + (y << 8);
    const prevId = chunk.data[cellIdx];
    chunk.data[cellIdx] = blockId;
    if (blockId !== 0 && y > chunk.maxY) chunk.maxY = y;
    this.markDirty(cx, cz);

    // Neighbor chunks if on edge (or within 6 blocks when placing/removing a GI light emitter!)
    const emitChange = VOXEL_GI.isEmissiveBlock(blockId) || VOXEL_GI.isEmissiveBlock(prevId);
    const pad = emitChange ? 6 : 0;
    if (lx <= pad) this.markDirty(cx - 1, cz);
    if (lx >= CHUNK_SIZE - 1 - pad) this.markDirty(cx + 1, cz);
    if (lz <= pad) this.markDirty(cx, cz - 1);
    if (lz >= CHUNK_SIZE - 1 - pad) this.markDirty(cx, cz + 1);

    // Trigger leaf decay checks whenever a tree log or leaf is removed
    if (prevId !== blockId) {
      // Breaking either half of a 2-block-tall Wood Door cleanly removes its partner half!
      if (blockId === BLOCK.AIR && isDoorBlock(prevId)) {
        const partnerY = isDoorTop(prevId) ? y - 1 : y + 1;
        this.doorStates.delete(`${x},${Math.min(y, partnerY)},${z}`);
        if (isDoorBlock(this.getBlock(x, partnerY, z))) {
          this.setBlock(x, partnerY, z, BLOCK.AIR, record);
        }
      }
      // Breaking farmland pops any wheat crop growing on top of it!
      if (!isFarmlandBlock(blockId) && isFarmlandBlock(prevId)) {
        if (isWheatBlock(this.getBlock(x, y + 1, z))) {
          this.setBlock(x, y + 1, z, BLOCK.AIR, record);
        }
      }
      // Placing/removing water immediately refreshes nearby farmland hydration within 4 blocks!
      if (blockId === BLOCK.WATER || prevId === BLOCK.WATER) {
        for (const f of this.activeFarmlands.values()) {
          if (Math.abs(f.x - x) <= 4 && Math.abs(f.z - z) <= 4 && Math.abs(f.y - y) <= 1) {
            f.timer = Math.min(f.timer, 0.25);
          }
        }
      }
      if (LOG_BLOCK_SET.has(prevId)) {
        this.scheduleLeafDecayAround(x, y, z, LEAF_MAX_WOOD_DIST);
      } else if (LEAF_BLOCK_SET.has(prevId)) {
        this.leafDecayQueue.delete(bKey);
        this.scheduleLeafDecayAround(x, y, z, 2);
      }
      // Schedule fluid updates when water/lava is placed, removed, or exposed by digging!
      if (blockId === BLOCK.WATER || blockId === BLOCK.LAVA) {
        if (!this.fluidLevels.has(bKey)) this.fluidLevels.set(bKey, 0);
        this.scheduleFluid(x, y, z, blockId);
        this.scheduleNeighborFluids(x, y, z);
      } else {
        if (prevId === BLOCK.WATER || prevId === BLOCK.LAVA) {
          this.fluidLevels.delete(bKey);
          this.fluidQueue.delete(bKey);
        }
        this.scheduleNeighborFluids(x, y, z);
      }
    }
  }

  getFluidLevel(x, y, z) {
    const k = `${x},${y},${z}`;
    const lv = this.fluidLevels.get(k);
    return lv !== undefined ? lv : 0; // Unrecorded worldgen water/lava is a source block (level 0)
  }

  scheduleFluid(x, y, z, type) {
    const k = `${x},${y},${z}`;
    const delay = type === BLOCK.LAVA ? 0.78 : 0.22; // Water flows ~3.5x faster than Lava!
    const ex = this.fluidQueue.get(k);
    if (!ex || ex.timer > delay) {
      this.fluidQueue.set(k, { x, y, z, type, timer: delay });
    }
  }

  scheduleNeighborFluids(x, y, z) {
    for (let i = 0; i < 6; i++) {
      const d = LEAF_DIRS[i];
      const nx = x + d[0], ny = y + d[1], nz = z + d[2];
      const nb = this.getBlock(nx, ny, nz);
      if (nb === BLOCK.WATER || nb === BLOCK.LAVA) {
        this.scheduleFluid(nx, ny, nz, nb);
      }
    }
  }

  // Place a Water or Lava source block (from bucket!) and immediately trigger fluid physics & mixing!
  placeFluidSource(x, y, z, fluidBlockId) {
    const cur = this.getBlock(x, y, z);
    if (fluidBlockId === BLOCK.WATER && cur === BLOCK.LAVA) {
      const res = this.getFluidLevel(x, y, z) === 0 ? BLOCK.OBSIDIAN : BLOCK.COBBLESTONE;
      this.setBlock(x, y, z, res, true);
      if (this.onFluidMix) this.onFluidMix(x, y, z, res);
      return;
    }
    if (fluidBlockId === BLOCK.LAVA && cur === BLOCK.WATER) {
      this.setBlock(x, y, z, BLOCK.COBBLESTONE, true);
      if (this.onFluidMix) this.onFluidMix(x, y, z, BLOCK.COBBLESTONE);
      return;
    }
    this.fluidLevels.set(`${x},${y},${z}`, 0);
    this.setBlock(x, y, z, fluidBlockId, true);
    this.scheduleFluid(x, y, z, fluidBlockId);
  }

  // Compute authentic Minecraft visual fluid surface height (0.12 .. 1.0) for sloped multi-level Water & Lava!
  getFluidSurfaceHeight(x, y, z, fluidId) {
    if (this.getBlock(x, y + 1, z) === fluidId) return 1.0;
    const lv = this.getFluidLevel(x, y, z);
    if (lv <= 0) return 0.875; // Full source block (7/8 height)
    if (fluidId === BLOCK.LAVA) {
      // Lava spreads 3 blocks: crisp sloped steps 7/8 -> 0.66 -> 0.42 -> 0.19!
      if (lv === 1) return 0.66;
      if (lv === 2) return 0.42;
      return 0.19;
    }
    // Water spreads 7 blocks: smooth 8-level slope 7/8 down to 0.12!
    return Math.max(0.12, (8 - lv) / 9.0);
  }

  // Smooth Minecraft 4-neighbor corner height averaging for sloped Lava & Water quads!
  getFluidCornerHeight(vx, y, vz, fluidId) {
    let sum = 0;
    let weight = 0;
    for (let dz = -1; dz <= 0; dz++) {
      for (let dx = -1; dx <= 0; dx++) {
        const cx = vx + dx;
        const cz = vz + dz;
        if (this.getBlock(cx, y + 1, cz) === fluidId) return 1.0;
        const b = this.getBlock(cx, y, cz);
        if (b === fluidId) {
          const lv = this.getFluidLevel(cx, y, cz);
          const h = this.getFluidSurfaceHeight(cx, y, cz, fluidId);
          // Source blocks carry 10x corner weight (matches real Minecraft flat pool rims + smooth spillways!)
          const w = lv === 0 ? 10.0 : 1.0;
          sum += h * w;
          weight += w;
        } else if (!isBlockSolid(b)) {
          // Open air gently tapers outer flowing edge downward!
          weight += 1.0;
        }
      }
    }
    return weight > 0 ? Math.max(0.08, sum / weight) : 0.875;
  }

  _markFluidDirty(x, z) {
    const cx = x >> 4, cz = z >> 4;
    this.markDirty(cx, cz);
    const lx = x & 15, lz = z & 15;
    if (lx === 0) this.markDirty(cx - 1, cz);
    if (lx === 15) this.markDirty(cx + 1, cz);
    if (lz === 0) this.markDirty(cx, cz - 1);
    if (lz === 15) this.markDirty(cx, cz + 1);
  }

  // Scoop up a Water or Lava source with an Empty Bucket and immediately cascade smooth drainage!
  pickupFluidSource(x, y, z) {
    const cur = this.getBlock(x, y, z);
    if (cur !== BLOCK.WATER && cur !== BLOCK.LAVA) return null;
    if (this.getFluidLevel(x, y, z) !== 0) return null;
    const k = `${x},${y},${z}`;
    this.fluidLevels.delete(k);
    this.fluidQueue.delete(k);
    this.setBlock(x, y, z, BLOCK.AIR, true);
    // Cascade drain schedule to all 6 neighbors (plus 2-deep horizontal so lava drains cleanly!)
    this.scheduleNeighborFluids(x, y, z);
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const nb = this.getBlock(x + dx, y, z + dz);
      if (nb === cur) this.scheduleFluid(x + dx, y, z + dz, nb);
    }
    return cur;
  }

  // Authentic Minecraft Fluid Flow, Upgraded Smooth Drainage & Water+Lava Mixing (Obsidian, Cobblestone, Stone!)
  updateFluids(dt) {
    if (this.fluidQueue.size === 0) return;
    let processed = 0;
    const maxPerFrame = 24;
    const ready = [];
    for (const [k, entry] of this.fluidQueue) {
      entry.timer -= dt;
      if (entry.timer <= 0 && ready.length < maxPerFrame) {
        ready.push([k, entry]);
      }
    }

    const canFlowInto = (b) => (
      b === BLOCK.AIR || b === BLOCK.FIRE || b === BLOCK.TALL_GRASS ||
      b === BLOCK.FLOWER_RED || b === BLOCK.FLOWER_YELLOW || b === BLOCK.TORCH ||
      (b >= BLOCK.WHEAT_0 && b <= BLOCK.WHEAT_7)
    );

    for (const [k, entry] of ready) {
      this.fluidQueue.delete(k);
      const { x, y, z } = entry;
      const cur = this.getBlock(x, y, z);
      if (cur !== BLOCK.WATER && cur !== BLOCK.LAVA) {
        this.fluidLevels.delete(k);
        continue;
      }
      processed++;
      const isLava = cur === BLOCK.LAVA;
      const maxSpread = isLava ? 3 : 7;
      let level = this.getFluidLevel(x, y, z);

      // 1. For flowing fluid (level > 0): check infinite water source (Water only!) & authentic step-by-step drainage!
      if (level > 0) {
        const above = this.getBlock(x, y + 1, z);
        let minNeigh = 99;
        let adjSources = 0;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (this.getBlock(x + dx, y, z + dz) === cur) {
            const nl = this.getFluidLevel(x + dx, y, z + dz);
            if (nl < minNeigh) minNeigh = nl;
            if (nl === 0) adjSources++;
          }
        }

        // Authentic Minecraft Infinite Water Source (2+ horizontal water sources + solid/water below; NEVER Lava!)
        if (!isLava && adjSources >= 2) {
          const bel = this.getBlock(x, y - 1, z);
          if (isBlockSolid(bel) || (bel === BLOCK.WATER && this.getFluidLevel(x, y - 1, z) === 0)) {
            this.fluidLevels.set(k, 0);
            this._markFluidDirty(x, z);
            this.scheduleNeighborFluids(x, y, z);
            level = 0;
          }
        }

        if (level > 0) {
          const targetLevel = (above === cur) ? 1 : (minNeigh + 1);
          if (targetLevel > level) {
            // Upstream source was removed or scooped up -> recede smoothly one level per fluid tick!
            const nextLv = level + 1;
            if (nextLv > maxSpread) {
              this.fluidLevels.delete(k);
              this.setBlock(x, y, z, BLOCK.AIR, true);
              this.scheduleNeighborFluids(x, y, z);
            } else {
              this.fluidLevels.set(k, nextLv);
              this._markFluidDirty(x, z);
              this.scheduleFluid(x, y, z, cur);
              this.scheduleNeighborFluids(x, y, z);
            }
            continue; // Do NOT spread outward while draining!
          }
          if (targetLevel > maxSpread) {
            this.fluidLevels.delete(k);
            this.setBlock(x, y, z, BLOCK.AIR, true);
            this.scheduleNeighborFluids(x, y, z);
            continue;
          }
          if (targetLevel < level) {
            level = targetLevel;
            this.fluidLevels.set(k, level);
            this._markFluidDirty(x, z);
          }
        }
      }

      // 2. Check downward flow first (gravity!)
      if (y > 1) {
        const below = this.getBlock(x, y - 1, z);
        if (isLava && below === BLOCK.WATER) {
          this.fluidLevels.delete(`${x},${y - 1},${z}`);
          this.setBlock(x, y - 1, z, BLOCK.STONE, true);
          if (this.onFluidMix) this.onFluidMix(x, y - 1, z, BLOCK.STONE);
          continue;
        }
        if (!isLava && below === BLOCK.LAVA) {
          const res = this.getFluidLevel(x, y - 1, z) === 0 ? BLOCK.OBSIDIAN : BLOCK.COBBLESTONE;
          this.fluidLevels.delete(`${x},${y - 1},${z}`);
          this.setBlock(x, y - 1, z, res, true);
          if (this.onFluidMix) this.onFluidMix(x, y - 1, z, res);
          continue;
        }
        if (canFlowInto(below)) {
          this.fluidLevels.set(`${x},${y - 1},${z}`, 1);
          this.setBlock(x, y - 1, z, cur, true);
          this.scheduleFluid(x, y - 1, z, cur);
          continue; // Falling stream flows straight down before spreading sideways!
        }
        if (below === cur) {
          const bl = this.getFluidLevel(x, y - 1, z);
          if (bl > 1) {
            this.fluidLevels.set(`${x},${y - 1},${z}`, 1);
            this._markFluidDirty(x, z);
            this.scheduleFluid(x, y - 1, z, cur);
          }
          // Falling stream onto another fluid still spreads if source or on top of a pool
          if (level > 0) continue;
        }
      }

      // 3. Horizontal spread (up to 7 blocks for Water, 3 blocks for Lava) + sideways mixing!
      if (level < maxSpread) {
        const nextLevel = level + 1;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, nz = z + dz;
          const nb = this.getBlock(nx, y, nz);

          if (!isLava && nb === BLOCK.LAVA) {
            const res = this.getFluidLevel(nx, y, nz) === 0 ? BLOCK.OBSIDIAN : BLOCK.COBBLESTONE;
            this.fluidLevels.delete(`${nx},${y},${nz}`);
            this.setBlock(nx, y, nz, res, true);
            if (this.onFluidMix) this.onFluidMix(nx, y, nz, res);
            continue;
          }
          if (isLava && nb === BLOCK.WATER) {
            const res = BLOCK.COBBLESTONE;
            this.fluidLevels.delete(`${nx},${y},${nz}`);
            this.setBlock(nx, y, nz, res, true);
            if (this.onFluidMix) this.onFluidMix(nx, y, nz, res);
            continue;
          }
          if (canFlowInto(nb)) {
            this.fluidLevels.set(`${nx},${y},${nz}`, nextLevel);
            this.setBlock(nx, y, nz, cur, true);
            this.scheduleFluid(nx, y, nz, cur);
          } else if (nb === cur && this.getFluidLevel(nx, y, nz) > nextLevel) {
            this.fluidLevels.set(`${nx},${y},${nz}`, nextLevel);
            this._markFluidDirty(nx, nz);
            this.scheduleFluid(nx, y, nz, cur);
          }
        }
      }
      if (processed >= maxPerFrame) break;
    }
  }

  // --- AUTHENTIC MINECRAFT FARMING: HYDRATION, HOE TILLING & WATER-DEPENDENT WHEAT GROWTH ---
  isFarmlandHydrated(x, y, z) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dz = -4; dz <= 4; dz++) {
        for (let dx = -4; dx <= 4; dx++) {
          if (this.getBlock(x + dx, y + dy, z + dz) === BLOCK.WATER) return true;
        }
      }
    }
    return false;
  }

  tillBlock(wx, wy, wz) {
    const x = Math.floor(wx), y = Math.floor(wy), z = Math.floor(wz);
    const id = this.getBlock(x, y, z);
    const tillable = (
      id === BLOCK.GRASS || id === BLOCK.DIRT || id === BLOCK.DIRT_PATH ||
      id === BLOCK.SAVANNA_GRASS || id === BLOCK.JUNGLE_GRASS || id === BLOCK.SWAMP_GRASS
    );
    if (!tillable || this.getBlock(x, y + 1, z) !== BLOCK.AIR) return false;
    const hydrated = this.isFarmlandHydrated(x, y, z);
    this.setBlock(x, y, z, hydrated ? BLOCK.FARMLAND_WET : BLOCK.FARMLAND, true);
    return true;
  }

  // Authentic Minecraft Shovel Grass/Dirt Path creation!
  makeDirtPath(wx, wy, wz) {
    const x = Math.floor(wx), y = Math.floor(wy), z = Math.floor(wz);
    const id = this.getBlock(x, y, z);
    const pathable = (
      id === BLOCK.GRASS || id === BLOCK.DIRT ||
      id === BLOCK.SAVANNA_GRASS || id === BLOCK.JUNGLE_GRASS || id === BLOCK.SWAMP_GRASS
    );
    if (!pathable || this.getBlock(x, y + 1, z) !== BLOCK.AIR) return false;
    this.setBlock(x, y, z, BLOCK.DIRT_PATH, true);
    return true;
  }

  updateCrops(dt, isDay = true, farmSpeed = 1.0) {
    const speedMult = typeof farmSpeed === 'number' && Number.isFinite(farmSpeed) ? Math.max(0, Math.min(20, farmSpeed)) : 1.0;
    // 1. Update Farmland Hydration (water within 4 blocks -> dark wet farmland; dry bare farmland reverts to dirt)
    if (this.activeFarmlands.size > 0) {
      let fTicks = 0;
      for (const [k, f] of this.activeFarmlands) {
        f.timer -= dt;
        if (f.timer > 0) continue;
        f.timer = 2.0 + Math.random() * 2.5;
        const cur = this.getBlock(f.x, f.y, f.z);
        if (!isFarmlandBlock(cur)) {
          this.activeFarmlands.delete(k);
          continue;
        }
        const hydrated = this.isFarmlandHydrated(f.x, f.y, f.z);
        if (hydrated) {
          f.dryAge = 0;
          if (cur !== BLOCK.FARMLAND_WET) {
            this.setBlock(f.x, f.y, f.z, BLOCK.FARMLAND_WET, true);
          }
        } else {
          if (cur === BLOCK.FARMLAND_WET) {
            this.setBlock(f.x, f.y, f.z, BLOCK.FARMLAND, true);
          }
          const above = this.getBlock(f.x, f.y + 1, f.z);
          if (!isWheatBlock(above)) {
            f.dryAge += 3.0;
            if (f.dryAge > 42 && Math.random() < 0.35) {
              this.setBlock(f.x, f.y, f.z, BLOCK.DIRT, true);
            }
          }
        }
        if (++fTicks >= 12) break;
      }
    }

    // 2. Grow Wheat Crops (REQUIRES nearby Water / Hydrated Farmland + daylight or torch/glowstone light!)
    if (this.activeCrops.size > 0 && speedMult > 0) {
      let cTicks = 0;
      const cropDt = dt * speedMult;
      for (const [k, c] of this.activeCrops) {
        c.timer -= cropDt;
        if (c.timer > 0) continue;
        c.timer = 7.0 + Math.random() * 8.0; // Scales directly with Farm Speed Multiplier!
        const cur = this.getBlock(c.x, c.y, c.z);
        if (!isWheatBlock(cur) || cur >= BLOCK.WHEAT_7) {
          this.activeCrops.delete(k);
          continue;
        }
        const below = this.getBlock(c.x, c.y - 1, c.z);
        if (!isFarmlandBlock(below)) {
          this.setBlock(c.x, c.y, c.z, BLOCK.AIR, true);
          continue;
        }
        // Check water hydration (required for wheat to grow!)
        const hydrated = below === BLOCK.FARMLAND_WET || this.isFarmlandHydrated(c.x, c.y - 1, c.z);
        if (!hydrated) continue;
        if (below !== BLOCK.FARMLAND_WET) {
          this.setBlock(c.x, c.y - 1, c.z, BLOCK.FARMLAND_WET, true);
        }
        // Check light: daytime sky OR nearby torch/glowstone within 6 blocks!
        let hasLight = isDay;
        if (!hasLight && this.lightSources.size > 0) {
          for (const ls of this.lightSources.values()) {
            const dx = ls.x - c.x, dy = ls.y - c.y, dz = ls.z - c.z;
            if (dx * dx + dy * dy + dz * dz <= 49) { hasLight = true; break; }
          }
        }
        if (hasLight) {
          this.setBlock(c.x, c.y, c.z, cur + 1, true);
        }
        if (++cTicks >= 10) break;
      }
    }
  }

  // Authentic Minecraft Fire Spread, Tree/Wood/Plant Burning, Rain Extinguish & TNT Ignition!
  updateFire(dt, isRaining = false) {
    if (this.activeFires.size === 0) return;
    let ticks = 0;
    const maxTicks = 8;
    const ready = [];
    for (const [k, f] of this.activeFires) {
      f.age += dt;
      f.timer -= dt;
      if (f.timer <= 0 && ready.length < maxTicks) {
        ready.push([k, f]);
      }
    }

    for (const [k, f] of ready) {
      const { x, y, z } = f;
      if (this.getBlock(x, y, z) !== BLOCK.FIRE) {
        this.activeFires.delete(k);
        continue;
      }
      ticks++;
      f.timer = 0.75 + Math.random() * 1.15;

      // 1. Extinguish if next to Water or exposed to Rain!
      let touchingWater = false;
      let hasFuelNeighbor = false;
      const below = this.getBlock(x, y - 1, z);
      const eternalBase = below === BLOCK.OBSIDIAN || below === BLOCK.COAL_ORE;

      for (let i = 0; i < 6; i++) {
        const d = LEAF_DIRS[i];
        const nx = x + d[0], ny = y + d[1], nz = z + d[2];
        const nb = this.getBlock(nx, ny, nz);
        if (nb === BLOCK.WATER) touchingWater = true;
        else if (nb === BLOCK.TNT) {
          if (this.onFireIgniteTnt) this.onFireIgniteTnt(nx, ny, nz);
        } else if (FLAMMABLE_SET.has(nb)) {
          hasFuelNeighbor = true;
        }
      }

      if (touchingWater || (isRaining && !eternalBase && y >= this.getSurfaceY(x, z) - 1 && Math.random() < 0.65)) {
        this.setBlock(x, y, z, BLOCK.AIR, true);
        continue;
      }

      // 2. Burn & consume adjacent wood, leaves, planks, wool & plants!
      for (let i = 0; i < 6; i++) {
        const d = LEAF_DIRS[i];
        const nx = x + d[0], ny = y + d[1], nz = z + d[2];
        const nb = this.getBlock(nx, ny, nz);
        if (!FLAMMABLE_SET.has(nb)) continue;
        const burnChance = FAST_BURN_SET.has(nb) ? 0.42 : 0.19;
        if (Math.random() < burnChance) {
          // Cap total simultaneous active fires so giant forest fires never lag!
          const replaceWithFire = this.activeFires.size < 160 && Math.random() < 0.58;
          this.setBlock(nx, ny, nz, replaceWithFire ? BLOCK.FIRE : BLOCK.AIR, true);
        }
      }

      // 3. Spread fire naturally upward & outward onto nearby flammable trees/wood/plants!
      if (this.activeFires.size < 160) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const sx = x + Math.floor(Math.random() * 3) - 1;
          const sy = y + Math.floor(Math.random() * 4) - 1; // climbs up -1..+2!
          const sz = z + Math.floor(Math.random() * 3) - 1;
          if (sy <= 1 || sy >= CHUNK_HEIGHT - 2) continue;
          if (this.getBlock(sx, sy, sz) !== BLOCK.AIR) continue;
          // Must touch a flammable block to catch fire there
          let nearFuel = false;
          for (let j = 0; j < 6; j++) {
            const d = LEAF_DIRS[j];
            if (FLAMMABLE_SET.has(this.getBlock(sx + d[0], sy + d[1], sz + d[2]))) {
              nearFuel = true;
              break;
            }
          }
          if (nearFuel && Math.random() < 0.32) {
            this.setBlock(sx, sy, sz, BLOCK.FIRE, true);
          }
        }
      }

      // 4. Burn out naturally if unsupported or after fuel is gone (stays clinging to trees, leaves & wood sides!)
      const supported = isBlockSolid(below) || LEAF_BLOCK_SET.has(below) || hasFuelNeighbor;
      if (!supported || (!eternalBase && !hasFuelNeighbor && f.age > 4.5 + Math.random() * 4.0) || (!eternalBase && f.age > 26)) {
        this.setBlock(x, y, z, BLOCK.AIR, true);
      }
      if (ticks >= maxTicks) break;
    }
  }

  // Enqueue nearby natural leaves for wood-support verification with staggered organic timers
  scheduleLeafDecayAround(cx, cy, cz, radius = LEAF_MAX_WOOD_DIST) {
    const rXZ = Math.min(6, radius);
    const minY = Math.max(1, cy - Math.min(3, radius));
    const maxY = Math.min(CHUNK_HEIGHT - 2, cy + Math.min(6, radius));
    for (let y = minY; y <= maxY; y++) {
      for (let z = cz - rXZ; z <= cz + rXZ; z++) {
        for (let x = cx - rXZ; x <= cx + rXZ; x++) {
          const id = this.getBlock(x, y, z);
          if (!LEAF_BLOCK_SET.has(id)) continue;
          const k = `${x},${y},${z}`;
          if (this.persistentLeaves.has(k)) continue;
          const delay = 0.65 + Math.random() * 4.2;
          const existing = this.leafDecayQueue.get(k);
          if (!existing) {
            this.leafDecayQueue.set(k, { x, y, z, timer: delay });
          } else if (existing.timer > delay) {
            existing.timer = delay;
          }
        }
      }
    }
  }

  // Bounded 6-neighbor BFS: returns true if a leaf connects to any log within LEAF_MAX_WOOD_DIST blocks
  hasWoodSupport(sx, sy, sz) {
    const visited = new Set();
    const pack = (dx, dy, dz) => (dx + 8) | ((dy + 8) << 5) | ((dz + 8) << 10);
    visited.add(pack(0, 0, 0));

    const queue = [sx, sy, sz, 0];
    let head = 0;

    while (head < queue.length) {
      const x = queue[head++];
      const y = queue[head++];
      const z = queue[head++];
      const dist = queue[head++];

      for (let i = 0; i < 6; i++) {
        const d = LEAF_DIRS[i];
        const nx = x + d[0];
        const ny = y + d[1];
        const nz = z + d[2];
        if (ny < 0 || ny >= CHUNK_HEIGHT) continue;

        // Don't falsely decay leaves whose trunk sits in an unloaded chunk
        if (!this.chunks.has(this.chunkKey(nx >> 4, nz >> 4))) return true;

        const nb = this.getBlock(nx, ny, nz);
        if (LOG_BLOCK_SET.has(nb)) return true;

        if (LEAF_BLOCK_SET.has(nb) && dist + 1 < LEAF_MAX_WOOD_DIST) {
          const pk = pack(nx - sx, ny - sy, nz - sz);
          if (!visited.has(pk)) {
            visited.add(pk);
            queue.push(nx, ny, nz, dist + 1);
          }
        }
      }
    }
    return false;
  }

  // Tick queued leaf decays + light ambient sweep around player for any floating natural leaves
  updateLeafDecay(dt, playerPos) {
    // 1. Process scheduled leaf decay timers (rate-limited for silky 60 FPS)
    let decaysThisFrame = 0;
    const maxDecaysPerFrame = 5;
    for (const [k, entry] of this.leafDecayQueue) {
      entry.timer -= dt;
      if (entry.timer <= 0) {
        if (decaysThisFrame >= maxDecaysPerFrame) continue;
        this.leafDecayQueue.delete(k);
        if (this.persistentLeaves.has(k)) continue;
        const id = this.getBlock(entry.x, entry.y, entry.z);
        if (!LEAF_BLOCK_SET.has(id)) continue;
        if (!this.hasWoodSupport(entry.x, entry.y, entry.z)) {
          decaysThisFrame++;
          this.setBlock(entry.x, entry.y, entry.z, BLOCK.AIR, true);
          if (this.onLeafDecay) this.onLeafDecay(entry.x, entry.y, entry.z, id);
        }
      }
    }

    // 2. Gentle periodic sweep around player (catches leaves orphaned by explosions or older saves)
    if (!playerPos) return;
    this._leafAmbientTimer += dt;
    if (this._leafAmbientTimer >= 0.7) {
      this._leafAmbientTimer = 0;
      const px = Math.floor(playerPos.x);
      const py = Math.floor(playerPos.y);
      const pz = Math.floor(playerPos.z);
      for (let i = 0; i < 16; i++) {
        const wx = px + Math.floor((Math.random() - 0.5) * 44);
        const wy = Math.max(2, Math.min(CHUNK_HEIGHT - 2, py - 4 + Math.floor(Math.random() * 24)));
        const wz = pz + Math.floor((Math.random() - 0.5) * 44);
        const id = this.getBlock(wx, wy, wz);
        if (!LEAF_BLOCK_SET.has(id)) continue;
        const k = `${wx},${wy},${wz}`;
        if (this.persistentLeaves.has(k) || this.leafDecayQueue.has(k)) continue;
        if (!this.hasWoodSupport(wx, wy, wz)) {
          this.leafDecayQueue.set(k, { x: wx, y: wy, z: wz, timer: 0.4 + Math.random() * 1.8 });
        }
      }
    }
  }

  markDirty(cx, cz) {
    const c = this.chunks.get(this.chunkKey(cx, cz));
    if (c) {
      c.dirty = true;
      if (!c.queued) {
        c.queued = true;
        // Player block edits jump straight to the front for instant 0-latency feedback!
        this.meshQueue.unshift(c);
      }
    }
  }

  buildChunkMesh(chunk) {
    // Dispose old meshes
    for (const m of chunk.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    chunk.meshes = [];
    chunk.dirty = false;
    chunk.queued = false;
    chunk.meshed = true;

    // Refresh light-emitting block registry for this chunk
    if (chunk.lightKeys) {
      for (const lk of chunk.lightKeys) this.lightSources.delete(lk);
    }
    chunk.lightKeys = [];

    const bOpaque = SCRATCH_BUCKETS.opaque;
    const bCutout = SCRATCH_BUCKETS.cutout;
    const bStatic = SCRATCH_BUCKETS.staticCutout;
    const bWater = SCRATCH_BUCKETS.water;
    const bFire = SCRATCH_BUCKETS.fire;
    bOpaque.reset();
    bCutout.reset();
    bStatic.reset();
    bWater.reset();
    bFire.reset();

    const cx = chunk.cx;
    const cz = chunk.cz;
    const ox = cx << 4;
    const oz = cz << 4;
    const data = chunk.data;
    const defTable = this._defTable;
    const solidTable = this._solidTable;
    const transTable = this._transTable;
    const specialTable = this._specialTable;
    const litTable = this._litTable;
    const uvTable = this._uvTable;

    // Pre-fetch 3x3 neighbor chunk Uint8Arrays ONCE -> ZERO Map/string lookups in the inner loop!
    const getNbr = (dcx, dcz) => {
      const c = this.chunks.get((cx + dcx + 32768) * 65536 + (cz + dcz + 32768));
      return c ? c.data : null;
    };
    const dPX = getNbr(1, 0), dNX = getNbr(-1, 0), dPZ = getNbr(0, 1), dNZ = getNbr(0, -1);
    const dPP = getNbr(1, 1), dPN = getNbr(1, -1), dNP = getNbr(-1, 1), dNN = getNbr(-1, -1);

    const fastGet = (lx, y, lz) => {
      if (y < 0 || y >= CHUNK_HEIGHT) return 0;
      if (lx >= 0 && lx < 16) {
        if (lz >= 0 && lz < 16) return data[lx + (lz << 4) + (y << 8)];
        if (lz < 0) return dNZ ? dNZ[lx + ((lz + 16) << 4) + (y << 8)] : 0;
        return dPZ ? dPZ[lx + ((lz - 16) << 4) + (y << 8)] : 0;
      }
      if (lx < 0) {
        if (lz >= 0 && lz < 16) return dNX ? dNX[(lx + 16) + (lz << 4) + (y << 8)] : 0;
        if (lz < 0) return dNN ? dNN[(lx + 16) + ((lz + 16) << 4) + (y << 8)] : 0;
        return dNP ? dNP[(lx + 16) + ((lz - 16) << 4) + (y << 8)] : 0;
      }
      if (lz >= 0 && lz < 16) return dPX ? dPX[(lx - 16) + (lz << 4) + (y << 8)] : 0;
      if (lz < 0) return dPN ? dPN[(lx - 16) + ((lz + 16) << 4) + (y << 8)] : 0;
      return dPP ? dPP[(lx - 16) + ((lz - 16) << 4) + (y << 8)] : 0;
    };

    const yLimit = Math.min(CHUNK_HEIGHT - 1, (chunk.maxY || CHUNK_HEIGHT - 1) + 1);
    const bedTopUV = this._bedTopUV;
    const bedSideUV = this._bedSideUV;
    const bedWoodUV = this._bedWoodUV;

    // Compute Full 3D Voxel Global Illumination (Wall-Occluded Sky BFS + Colored RGB Emissives + 1-Bounce Color Bleeding!)
    const giVol = VOXEL_GI;
    giVol.compute(data, fastGet, transTable, yLimit);

    const applyGI = (bucket, nlx, ny, nlz, selfId = 0) => {
      const idx = giVol.sampleIndex(nlx, ny, nlz);
      const sky = ny >= giVol.activeH ? 1.0 : (ny < 0 ? 0.0 : giVol.sky[idx] / 15.0);
      let br = giVol.blkR[idx] / 15.0;
      let bg = giVol.blkG[idx] / 15.0;
      let bb = giVol.blkB[idx] / 15.0;
      const gr = giVol.bncR[idx] / 15.0;
      const gg = giVol.bncG[idx] / 15.0;
      const gb = giVol.bncB[idx] / 15.0;
      let emit = 0.0;
      if (selfId && giVol.isEmissiveBlock(selfId)) {
        giVol.getBlockEmitRGB(selfId, GI_EMIT_TMP);
        if (GI_EMIT_TMP[0] > br) br = GI_EMIT_TMP[0];
        if (GI_EMIT_TMP[1] > bg) bg = GI_EMIT_TMP[1];
        if (GI_EMIT_TMP[2] > bb) bb = GI_EMIT_TMP[2];
        emit = (selfId === BLOCK.LAVA || selfId === BLOCK.GLOWSTONE || selfId === BLOCK.TORCH || selfId === BLOCK.FIRE)
          ? 1.0
          : (selfId === BLOCK.DIAMOND_BLOCK ? 0.65 : 0.22);
      }
      bucket.setGI(sky, br, bg, bb, gr, gg, gb, emit);
    };

    const calcSkyLight = (nlx, ny, nlz) => giVol.getSky(nlx, ny, nlz);

    let hasWater = false;

    // PASS 1: Special Geometry (3D Beds, 3D Torches, Cross Foliage, Cutout Leaves/Glass/Ice, Water Sides) + Light Registry
    // Fast skip via specialTable avoids touching ~97% of solid stone/dirt/ore blocks!
    for (let y = 0; y <= yLimit; y++) {
      const yOff = y << 8;
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const zOff = lz << 4;
        const wz = oz + lz;
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const id = data[lx + zOff + yOff];
          if (id === 0 || specialTable[id] === 0) continue;
          const def = defTable[id];
          if (!def) continue;

          const wx = ox + lx;
          // Apply 3D Voxel GI for all PASS 1 special geometry (beds, doors, fences, torches, ladders, foliage, lava!)
          applyGI(bOpaque, lx, y, lz, id);
          applyGI(bCutout, lx, y, lz, id);
          applyGI(bStatic, lx, y, lz, id);

          // Register light-emitting blocks (placed OR generated village torches / glowstone / fire / lava!)
          if (id === BLOCK.TORCH || id === BLOCK.GLOWSTONE || id === BLOCK.FIRE) {
            const lKey = `${wx},${y},${wz}`;
            chunk.lightKeys.push(lKey);
            this.lightSources.set(lKey, { x: wx, y, z: wz, isGlowstone: id === BLOCK.GLOWSTONE });
          }

          // True 2-Block-Long × 1-Block-Wide Sculpted 3D Bed Geometry (Seamless Head + Foot Halves!)
          if (isBedBlock(id)) {
            const info = getBedInfo(id);
            const bedRedUV = this._bedRedUV;
            const bedWhiteUV = this._bedWhiteUV;
            const addBox = (x0, y0, z0, x1, y1, z1, uTop, uSide, uBot) => {
              const bx0 = wx + x0, by0 = y + y0, bz0 = wz + z0;
              const bx1 = wx + x1, by1 = y + y1, bz1 = wz + z1;
              bOpaque.pushQuad(bx0,by1,bz1,uTop.u0,uTop.v0,1.0, bx1,by1,bz1,uTop.u1,uTop.v0,1.0, bx1,by1,bz0,uTop.u1,uTop.v1,1.0, bx0,by1,bz0,uTop.u0,uTop.v1,1.0, 0,1,0);
              bOpaque.pushQuad(bx0,by0,bz0,uBot.u0,uBot.v0,0.58, bx1,by0,bz0,uBot.u1,uBot.v0,0.58, bx1,by0,bz1,uBot.u1,uBot.v1,0.58, bx0,by0,bz1,uBot.u0,uBot.v1,0.58, 0,-1,0);
              bOpaque.pushQuad(bx1,by0,bz1,uSide.u0,uSide.v0,0.84, bx1,by0,bz0,uSide.u1,uSide.v0,0.84, bx1,by1,bz0,uSide.u1,uSide.v1,0.84, bx1,by1,bz1,uSide.u0,uSide.v1,0.84, 1,0,0);
              bOpaque.pushQuad(bx0,by0,bz0,uSide.u0,uSide.v0,0.84, bx0,by0,bz1,uSide.u1,uSide.v0,0.84, bx0,by1,bz1,uSide.u1,uSide.v1,0.84, bx0,by1,bz0,uSide.u0,uSide.v1,0.84, -1,0,0);
              bOpaque.pushQuad(bx0,by0,bz1,uSide.u0,uSide.v0,0.74, bx1,by0,bz1,uSide.u1,uSide.v0,0.74, bx1,by1,bz1,uSide.u1,uSide.v1,0.74, bx0,by1,bz1,uSide.u0,uSide.v1,0.74, 0,0,1);
              bOpaque.pushQuad(bx1,by0,bz0,uSide.u0,uSide.v0,0.74, bx0,by0,bz0,uSide.u1,uSide.v0,0.74, bx0,by1,bz0,uSide.u1,uSide.v1,0.74, bx1,by1,bz0,uSide.u0,uSide.v1,0.74, 0,0,-1);
            };
            const addBedOriented = (u0, y0, v0, u1, y1, v1, uTop, uSide, uBot) => {
              let x0, x1, z0, z1;
              if (info.dx === 0 && info.dz === -1) {
                x0 = u0; x1 = u1; z0 = v0; z1 = v1;
              } else if (info.dx === 0 && info.dz === 1) {
                x0 = u0; x1 = u1; z0 = 1 - v1; z1 = 1 - v0;
              } else if (info.dx === 1 && info.dz === 0) {
                x0 = 1 - v1; x1 = 1 - v0; z0 = u0; z1 = u1;
              } else {
                x0 = v0; x1 = v1; z0 = u0; z1 = u1;
              }
              addBox(x0, y0, z0, x1, y1, z1, uTop, uSide, uBot);
            };

            addBedOriented(0.02, 0.20, 0.0, 0.98, 0.34, 0.98, bedWoodUV, bedWoodUV, bedWoodUV);
            addBedOriented(0.04, 0.0, 0.80, 0.22, 0.20, 0.96, bedWoodUV, bedWoodUV, bedWoodUV);
            addBedOriented(0.78, 0.0, 0.80, 0.96, 0.20, 0.96, bedWoodUV, bedWoodUV, bedWoodUV);

            if (info.isHead) {
              addBedOriented(0.02, 0.34, 0.0, 0.98, 0.56, 0.32, bedRedUV, bedRedUV, bedWoodUV);
              addBedOriented(0.02, 0.34, 0.32, 0.98, 0.57, 0.94, bedWhiteUV, bedWhiteUV, bedWoodUV);
              addBedOriented(0.10, 0.57, 0.44, 0.90, 0.69, 0.88, bedWhiteUV, bedWhiteUV, bedWhiteUV);
              addBedOriented(0.02, 0.34, 0.92, 0.98, 0.66, 0.98, bedWoodUV, bedWoodUV, bedWoodUV);
            } else {
              addBedOriented(0.02, 0.34, 0.0, 0.98, 0.56, 0.96, bedRedUV, bedRedUV, bedWoodUV);
              addBedOriented(0.02, 0.20, 0.94, 0.98, 0.46, 0.98, bedWoodUV, bedWoodUV, bedWoodUV);
            }
            continue;
          }

          // Sculpted 3/16-thick 3D Openable/Closeable Wood Door Geometry (with transparent window cutouts!)
          if (isDoorBlock(id)) {
            const st = this.getDoorState(wx, y, wz);
            const edge = st.open ? ((st.facing + 3) & 3) : st.facing;
            const thick = 0.1875;
            let dx0 = 0, dx1 = 1, dz0 = 0, dz1 = 1;
            if (edge === 0) { dz0 = 0; dz1 = thick; }
            else if (edge === 1) { dx0 = 1 - thick; dx1 = 1; }
            else if (edge === 2) { dz0 = 1 - thick; dz1 = 1; }
            else { dx0 = 0; dx1 = thick; }

            const skyF = calcSkyLight(lx, y, lz);
            const faceUV = uvTable[id][2]; // door top or bottom face tile
            const edgeUV = uvTable[id][0]; // matching wood plank UV for thin rim
            const bx0 = wx + dx0, bx1 = wx + dx1, by0 = y, by1 = y + 1, bz0 = wz + dz0, bz1 = wz + dz1;
            const wideX = (edge === 0 || edge === 2);
            const uZ = wideX ? faceUV : edgeUV;
            const uX = wideX ? edgeUV : faceUV;
            const sTop = 0.96 * skyF, sBot = 0.62 * skyF, sX = 0.88 * skyF, sZ = 0.80 * skyF;

            // Render in bStatic (alpha-tested cutout material so Oak/Acacia/Jungle/Cherry door windows are see-through!)
            bStatic.pushQuad(bx0,by1,bz1,edgeUV.u0,edgeUV.v0,sTop, bx1,by1,bz1,edgeUV.u1,edgeUV.v0,sTop, bx1,by1,bz0,edgeUV.u1,edgeUV.v1,sTop, bx0,by1,bz0,edgeUV.u0,edgeUV.v1,sTop, 0,1,0);
            bStatic.pushQuad(bx0,by0,bz0,edgeUV.u0,edgeUV.v0,sBot, bx1,by0,bz0,edgeUV.u1,edgeUV.v0,sBot, bx1,by0,bz1,edgeUV.u1,edgeUV.v1,sBot, bx0,by0,bz1,edgeUV.u0,edgeUV.v1,sBot, 0,-1,0);
            bStatic.pushQuad(bx1,by0,bz1,uX.u0,uX.v0,sX, bx1,by0,bz0,uX.u1,uX.v0,sX, bx1,by1,bz0,uX.u1,uX.v1,sX, bx1,by1,bz1,uX.u0,uX.v1,sX, 1,0,0);
            bStatic.pushQuad(bx0,by0,bz0,uX.u0,uX.v0,sX, bx0,by0,bz1,uX.u1,uX.v0,sX, bx0,by1,bz1,uX.u1,uX.v1,sX, bx0,by1,bz0,uX.u0,uX.v1,sX, -1,0,0);
            bStatic.pushQuad(bx0,by0,bz1,uZ.u0,uZ.v0,sZ, bx1,by0,bz1,uZ.u1,uZ.v0,sZ, bx1,by1,bz1,uZ.u1,uZ.v1,sZ, bx0,by1,bz1,uZ.u0,uZ.v1,sZ, 0,0,1);
            bStatic.pushQuad(bx1,by0,bz0,uZ.u0,uZ.v0,sZ, bx0,by0,bz0,uZ.u1,uZ.v0,sZ, bx0,by1,bz0,uZ.u1,uZ.v1,sZ, bx1,by1,bz0,uZ.u0,uZ.v1,sZ, 0,0,-1);
            continue;
          }

          // Authentic Minecraft Auto-Connecting 3D Wood Fence Geometry (Central Post + Dynamic N/S/E/W Bars!)
          if (isFenceBlock(id)) {
            const skyF = calcSkyLight(lx, y, lz);
            const uv = uvTable[id][0];
            const sTop = 0.98 * skyF, sBot = 0.62 * skyF, sX = 0.86 * skyF, sZ = 0.78 * skyF;
            const addBox = (x0, y0, z0, x1, y1, z1) => {
              const bx0 = wx + x0, bx1 = wx + x1, by0 = y + y0, by1 = y + y1, bz0 = wz + z0, bz1 = wz + z1;
              const u0 = uv.u0, u1 = uv.u1, v0 = uv.v0, v1 = uv.v1;
              bOpaque.pushQuad(bx0,by1,bz1,u0,v0,sTop, bx1,by1,bz1,u1,v0,sTop, bx1,by1,bz0,u1,v1,sTop, bx0,by1,bz0,u0,v1,sTop, 0,1,0);
              bOpaque.pushQuad(bx0,by0,bz0,u0,v0,sBot, bx1,by0,bz0,u1,v0,sBot, bx1,by0,bz1,u1,v1,sBot, bx0,by0,bz1,u0,v1,sBot, 0,-1,0);
              bOpaque.pushQuad(bx1,by0,bz1,u0,v0,sX, bx1,by0,bz0,u1,v0,sX, bx1,by1,bz0,u1,v1,sX, bx1,by1,bz1,u0,v1,sX, 1,0,0);
              bOpaque.pushQuad(bx0,by0,bz0,u0,v0,sX, bx0,by0,bz1,u1,v0,sX, bx0,by1,bz1,u1,v1,sX, bx0,by1,bz0,u0,v1,sX, -1,0,0);
              bOpaque.pushQuad(bx0,by0,bz1,u0,v0,sZ, bx1,by0,bz1,u1,v0,sZ, bx1,by1,bz1,u1,v1,sZ, bx0,by1,bz1,u0,v1,sZ, 0,0,1);
              bOpaque.pushQuad(bx1,by0,bz0,u0,v0,sZ, bx0,by0,bz0,u1,v0,sZ, bx0,by1,bz0,u1,v1,sZ, bx1,by1,bz0,u0,v1,sZ, 0,0,-1);
            };
            const connects = (nid) => nid !== 0 && (isFenceOrGate(nid) || (solidTable[nid] === 1 && transTable[nid] === 0));
            // 4/16 x 16/16 x 4/16 center post
            addBox(0.375, 0.0, 0.375, 0.625, 1.0, 0.625);
            // Upper & lower horizontal bars connecting to adjacent Fences, Fence Gates & full solid blocks!
            if (connects(fastGet(lx, y, lz - 1))) {
              addBox(0.4375, 0.75, 0.0, 0.5625, 0.9375, 0.375);
              addBox(0.4375, 0.375, 0.0, 0.5625, 0.5625, 0.375);
            }
            if (connects(fastGet(lx, y, lz + 1))) {
              addBox(0.4375, 0.75, 0.625, 0.5625, 0.9375, 1.0);
              addBox(0.4375, 0.375, 0.625, 0.5625, 0.5625, 1.0);
            }
            if (connects(fastGet(lx + 1, y, lz))) {
              addBox(0.625, 0.75, 0.4375, 1.0, 0.9375, 0.5625);
              addBox(0.625, 0.375, 0.4375, 1.0, 0.5625, 0.5625);
            }
            if (connects(fastGet(lx - 1, y, lz))) {
              addBox(0.0, 0.75, 0.4375, 0.375, 0.9375, 0.5625);
              addBox(0.0, 0.375, 0.4375, 0.375, 0.5625, 0.5625);
            }
            continue;
          }

          // Authentic Minecraft Openable/Closeable 3D Wood Fence Gate Geometry!
          if (isFenceGateBlock(id)) {
            const st = this.getFenceGateState(wx, y, wz);
            const skyF = calcSkyLight(lx, y, lz);
            const uv = uvTable[id][0];
            const sTop = 0.98 * skyF, sBot = 0.62 * skyF, sX = 0.86 * skyF, sZ = 0.78 * skyF;
            const alongX = (st.facing === 0 || st.facing === 2);
            const addGateBox = (ax0, y0, az0, ax1, y1, az1) => {
              // Transform local gate coordinates (ax=across gate span, az=depth) into world X/Z!
              const x0 = alongX ? ax0 : az0, x1 = alongX ? ax1 : az1;
              const z0 = alongX ? az0 : ax0, z1 = alongX ? az1 : ax1;
              const bx0 = wx + x0, bx1 = wx + x1, by0 = y + y0, by1 = y + y1, bz0 = wz + z0, bz1 = wz + z1;
              const u0 = uv.u0, u1 = uv.u1, v0 = uv.v0, v1 = uv.v1;
              bOpaque.pushQuad(bx0,by1,bz1,u0,v0,sTop, bx1,by1,bz1,u1,v0,sTop, bx1,by1,bz0,u1,v1,sTop, bx0,by1,bz0,u0,v1,sTop, 0,1,0);
              bOpaque.pushQuad(bx0,by0,bz0,u0,v0,sBot, bx1,by0,bz0,u1,v0,sBot, bx1,by0,bz1,u1,v1,sBot, bx0,by0,bz1,u0,v1,sBot, 0,-1,0);
              bOpaque.pushQuad(bx1,by0,bz1,u0,v0,sX, bx1,by0,bz0,u1,v0,sX, bx1,by1,bz0,u1,v1,sX, bx1,by1,bz1,u0,v1,sX, 1,0,0);
              bOpaque.pushQuad(bx0,by0,bz0,u0,v0,sX, bx0,by0,bz1,u1,v0,sX, bx0,by1,bz1,u1,v1,sX, bx0,by1,bz0,u0,v1,sX, -1,0,0);
              bOpaque.pushQuad(bx0,by0,bz1,u0,v0,sZ, bx1,by0,bz1,u1,v0,sZ, bx1,by1,bz1,u1,v1,sZ, bx0,by1,bz1,u0,v1,sZ, 0,0,1);
              bOpaque.pushQuad(bx1,by0,bz0,u0,v0,sZ, bx0,by0,bz0,u1,v0,sZ, bx0,by1,bz0,u1,v1,sZ, bx1,by1,bz0,u0,v1,sZ, 0,0,-1);
            };
            // Left & right side posts
            addGateBox(0.0, 0.3125, 0.4375, 0.125, 1.0, 0.5625);
            addGateBox(0.875, 0.3125, 0.4375, 1.0, 1.0, 0.5625);
            if (!st.open) {
              // Closed double-leaf bars + center meeting stiles
              addGateBox(0.125, 0.75, 0.4375, 0.875, 0.9375, 0.5625);
              addGateBox(0.125, 0.375, 0.4375, 0.875, 0.5625, 0.5625);
              addGateBox(0.375, 0.5625, 0.4375, 0.625, 0.75, 0.5625);
            } else {
              // Swung open 90 degrees outward!
              const swingPos = (st.facing === 1 || st.facing === 2);
              const dz0 = swingPos ? 0.5625 : 0.0625;
              const dz1 = swingPos ? 0.9375 : 0.4375;
              // Left swung gate leaf
              addGateBox(0.0, 0.75, dz0, 0.125, 0.9375, dz1);
              addGateBox(0.0, 0.375, dz0, 0.125, 0.5625, dz1);
              addGateBox(0.0, 0.5625, swingPos ? 0.8125 : 0.0625, 0.125, 0.75, swingPos ? 0.9375 : 0.1875);
              // Right swung gate leaf
              addGateBox(0.875, 0.75, dz0, 1.0, 0.9375, dz1);
              addGateBox(0.875, 0.375, dz0, 1.0, 0.5625, dz1);
              addGateBox(0.875, 0.5625, swingPos ? 0.8125 : 0.0625, 1.0, 0.75, swingPos ? 0.9375 : 0.1875);
            }
            continue;
          }

          // Authentic Flush 3D Wall-Mounted Minecraft Ladder Geometry (2 vertical rails + 4 3D rungs matching Screenshot 1!)
          if (id === BLOCK.LADDER) {
            const lf = this.getLadderFacing(wx, y, wz, fastGet, lx, lz);
            const skyF = calcSkyLight(lx, y, lz);
            const woodUV = this._torchWoodUV || uvTable[BLOCK.OAK_PLANKS][0];
            const sTop = 1.02 * skyF, sBot = 0.55 * skyF, sSide = 0.84 * skyF, sFront = 0.94 * skyF;
            const addLadBox = (u0, y0, d0, u1, y1, d1) => {
              // u = across ladder width [0..1], d = depth off supporting wall [0..0.09]
              let x0, x1, z0, z1;
              if (lf === 0) { x0 = u0; x1 = u1; z0 = d0; z1 = d1; }              // Mounted on -Z (North) wall
              else if (lf === 2) { x0 = 1 - u1; x1 = 1 - u0; z0 = 1 - d1; z1 = 1 - d0; } // Mounted on +Z (South) wall
              else if (lf === 1) { x0 = 1 - d1; x1 = 1 - d0; z0 = u0; z1 = u1; }         // Mounted on +X (East) wall
              else { x0 = d0; x1 = d1; z0 = 1 - u1; z1 = 1 - u0; }                       // Mounted on -X (West) wall
              const bx0 = wx + x0, bx1 = wx + x1, by0 = y + y0, by1 = y + y1, bz0 = wz + z0, bz1 = wz + z1;
              const tu0 = woodUV.u0, tu1 = woodUV.u1, tv0 = woodUV.v0, tv1 = woodUV.v1;
              bOpaque.pushQuad(bx0,by1,bz1,tu0,tv0,sTop, bx1,by1,bz1,tu1,tv0,sTop, bx1,by1,bz0,tu1,tv1,sTop, bx0,by1,bz0,tu0,tv1,sTop, 0,1,0);
              bOpaque.pushQuad(bx0,by0,bz0,tu0,tv0,sBot, bx1,by0,bz0,tu1,tv0,sBot, bx1,by0,bz1,tu1,tv1,sBot, bx0,by0,bz1,tu0,tv1,sBot, 0,-1,0);
              bOpaque.pushQuad(bx1,by0,bz1,tu0,tv0,sSide, bx1,by0,bz0,tu1,tv0,sSide, bx1,by1,bz0,tu1,tv1,sSide, bx1,by1,bz1,tu0,tv1,sSide, 1,0,0);
              bOpaque.pushQuad(bx0,by0,bz0,tu0,tv0,sSide, bx0,by0,bz1,tu1,tv0,sSide, bx0,by1,bz1,tu1,tv1,sSide, bx0,by1,bz0,tu0,tv1,sSide, -1,0,0);
              bOpaque.pushQuad(bx0,by0,bz1,tu0,tv0,sFront, bx1,by0,bz1,tu1,tv0,sFront, bx1,by1,bz1,tu1,tv1,sFront, bx0,by1,bz1,tu0,tv1,sFront, 0,0,1);
              bOpaque.pushQuad(bx1,by0,bz0,tu0,tv0,sFront, bx0,by0,bz0,tu1,tv0,sFront, bx0,by1,bz0,tu1,tv1,sFront, bx1,by1,bz0,tu0,tv1,sFront, 0,0,-1);
            };
            // Left & right vertical oak rails clinging flush to wall
            addLadBox(0.125, 0.0, 0.0, 0.25, 1.0, 0.07);
            addLadBox(0.75,  0.0, 0.0, 0.875, 1.0, 0.07);
            // 4 proud 3D wooden horizontal rungs (slightly deeper than side rails for crisp 3D relief like Screenshot 1!)
            for (const ry of [0.09, 0.34, 0.59, 0.84]) {
              addLadBox(0.06, ry, 0.015, 0.94, ry + 0.11, 0.095);
            }
            continue;
          }

          // Sculpted 3D Voxel Torch Model (wooden shaft + charred ember collar + blazing emissive flame tip + auto wall-mount tilt!)
          if (id === BLOCK.TORCH) {
            const hasFloor = solidTable[fastGet(lx, y - 1, lz)] === 1;
            let tiltX = 0, tiltZ = 0, offX = 0, offY = 0, offZ = 0;
            if (!hasFloor) {
              if (solidTable[fastGet(lx - 1, y, lz)] === 1) { offX = -0.34; offY = 0.16; tiltX = 0.34; }
              else if (solidTable[fastGet(lx + 1, y, lz)] === 1) { offX = 0.34; offY = 0.16; tiltX = -0.34; }
              else if (solidTable[fastGet(lx, y, lz - 1)] === 1) { offZ = -0.34; offY = 0.16; tiltZ = 0.34; }
              else if (solidTable[fastGet(lx, y, lz + 1)] === 1) { offZ = 0.34; offY = 0.16; tiltZ = -0.34; }
            }

            const addTorchBox = (x0, y0, z0, x1, y1, z1, uv, sTop, sSide, sBot) => {
              const tx0 = tiltX * y0 + offX, tz0 = tiltZ * y0 + offZ;
              const tx1 = tiltX * y1 + offX, tz1 = tiltZ * y1 + offZ;
              const bx00 = wx + x0 + tx0, bx10 = wx + x1 + tx0;
              const bz00 = wz + z0 + tz0, bz10 = wz + z1 + tz0;
              const bx01 = wx + x0 + tx1, bx11 = wx + x1 + tx1;
              const bz01 = wz + z0 + tz1, bz11 = wz + z1 + tz1;
              const by0 = y + y0 + offY, by1 = y + y1 + offY;
              bOpaque.pushQuad(bx01,by1,bz11,uv.u0,uv.v0,sTop, bx11,by1,bz11,uv.u1,uv.v0,sTop, bx11,by1,bz01,uv.u1,uv.v1,sTop, bx01,by1,bz01,uv.u0,uv.v1,sTop, 0,1,0);
              bOpaque.pushQuad(bx00,by0,bz00,uv.u0,uv.v0,sBot, bx10,by0,bz00,uv.u1,uv.v0,sBot, bx10,by0,bz10,uv.u1,uv.v1,sBot, bx00,by0,bz10,uv.u0,uv.v1,sBot, 0,-1,0);
              bOpaque.pushQuad(bx10,by0,bz10,uv.u0,uv.v0,sSide, bx10,by0,bz00,uv.u1,uv.v0,sSide, bx11,by1,bz01,uv.u1,uv.v1,sSide, bx11,by1,bz11,uv.u0,uv.v1,sSide, 1,0,0);
              bOpaque.pushQuad(bx00,by0,bz00,uv.u0,uv.v0,sSide, bx00,by0,bz10,uv.u1,uv.v0,sSide, bx01,by1,bz11,uv.u1,uv.v1,sSide, bx01,by1,bz01,uv.u0,uv.v1,sSide, -1,0,0);
              bOpaque.pushQuad(bx00,by0,bz10,uv.u0,uv.v0,sSide * 0.94, bx10,by0,bz10,uv.u1,uv.v0,sSide * 0.94, bx11,by1,bz11,uv.u1,uv.v1,sSide * 0.94, bx01,by1,bz11,uv.u0,uv.v1,sSide * 0.94, 0,0,1);
              bOpaque.pushQuad(bx10,by0,bz00,uv.u0,uv.v0,sSide * 0.94, bx00,by0,bz00,uv.u1,uv.v0,sSide * 0.94, bx01,by1,bz01,uv.u1,uv.v1,sSide * 0.94, bx11,by1,bz01,uv.u0,uv.v1,sSide * 0.94, 0,0,-1);
            };

            const woodUV = this._torchWoodUV;
            const coalUV = this._torchCoalUV;
            const glowUV = this._torchGlowUV;
            if (hasFloor) addTorchBox(0.39, 0.0, 0.39, 0.61, 0.06, 0.61, woodUV, 0.9, 0.78, 0.58);
            addTorchBox(0.425, 0.0, 0.425, 0.575, 0.54, 0.575, woodUV, 0.95, 0.86, 0.62);
            addTorchBox(0.405, 0.53, 0.405, 0.595, 0.63, 0.595, coalUV, 0.55, 0.46, 0.38);
            addTorchBox(0.415, 0.63, 0.415, 0.585, 0.77, 0.585, glowUV, 1.54, 1.48, 1.32);
            addTorchBox(0.445, 0.77, 0.445, 0.555, 0.88, 0.555, glowUV, 1.72, 1.66, 1.5);
            addTorchBox(0.47, 0.88, 0.47, 0.53, 0.96, 0.53, glowUV, 1.82, 1.76, 1.6);
            continue;
          }

          // Cross-quad blocks (flowers, tall grass, blazing fire sway; ladders stay static!)
          // 10x Authentic Tree-Clinging 3D Animated Minecraft Fire Geometry!
          // Clings to sides of leaves, logs & walls (like real Minecraft burning trees!) + multi-curtain floor flames!
          if (id === BLOCK.FIRE) {
            const isFireSupport = (nid) => nid !== 0 && (solidTable[nid] === 1 || LEAF_BLOCK_SET.has(nid) || FLAMMABLE_SET.has(nid));
            const supBelow = isFireSupport(fastGet(lx, y - 1, lz));
            const supAbove = isFireSupport(fastGet(lx, y + 1, lz));
            const supPX = isFireSupport(fastGet(lx + 1, y, lz));
            const supNX = isFireSupport(fastGet(lx - 1, y, lz));
            const supPZ = isFireSupport(fastGet(lx, y, lz + 1));
            const supNZ = isFireSupport(fastGet(lx, y, lz - 1));
            const hasAnySide = supPX || supNX || supPZ || supNZ;

            const pushFlame = (x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3) => {
              bFire.pushQuad(
                x0, y0, z0, 0, 0, 1.0,
                x1, y1, z1, 1, 0, 1.0,
                x2, y2, z2, 1, 1, 1.0,
                x3, y3, z3, 0, 1, 1.0,
                0, 1, 0
              );
            };

            // Side-clinging flame curtains hugging adjacent tree leaves, trunks & walls!
            const hSide = 1.22;
            if (supPX) pushFlame(wx + 0.96, y, wz + 0.02, wx + 0.96, y, wz + 0.98, wx + 0.84, y + hSide, wz + 0.98, wx + 0.84, y + hSide, wz + 0.02);
            if (supNX) pushFlame(wx + 0.04, y, wz + 0.98, wx + 0.04, y, wz + 0.02, wx + 0.16, y + hSide, wz + 0.02, wx + 0.16, y + hSide, wz + 0.98);
            if (supPZ) pushFlame(wx + 0.98, y, wz + 0.96, wx + 0.02, y, wz + 0.96, wx + 0.02, y + hSide, wz + 0.84, wx + 0.98, y + hSide, wz + 0.84);
            if (supNZ) pushFlame(wx + 0.02, y, wz + 0.04, wx + 0.98, y, wz + 0.04, wx + 0.98, y + hSide, wz + 0.16, wx + 0.02, y + hSide, wz + 0.16);

            // Multi-layered roaring floor flames (4 inward-slanted perimeter curtains + 2 crossed inner tongues!)
            if (supBelow || !hasAnySide) {
              const hFloor = 1.24;
              pushFlame(wx + 0.04, y, wz + 0.04, wx + 0.96, y, wz + 0.04, wx + 0.92, y + hFloor, wz + 0.28, wx + 0.08, y + hFloor, wz + 0.28);
              pushFlame(wx + 0.96, y, wz + 0.96, wx + 0.04, y, wz + 0.96, wx + 0.08, y + hFloor, wz + 0.72, wx + 0.92, y + hFloor, wz + 0.72);
              pushFlame(wx + 0.04, y, wz + 0.96, wx + 0.04, y, wz + 0.04, wx + 0.28, y + hFloor, wz + 0.08, wx + 0.28, y + hFloor, wz + 0.92);
              pushFlame(wx + 0.96, y, wz + 0.04, wx + 0.96, y, wz + 0.96, wx + 0.72, y + hFloor, wz + 0.92, wx + 0.72, y + hFloor, wz + 0.08);
              // Inner crossed flame core
              pushFlame(wx + 0.14, y, wz + 0.14, wx + 0.86, y, wz + 0.86, wx + 0.86, y + 1.14, wz + 0.86, wx + 0.14, y + 1.14, wz + 0.14);
              pushFlame(wx + 0.14, y, wz + 0.86, wx + 0.86, y, wz + 0.14, wx + 0.86, y + 1.14, wz + 0.14, wx + 0.14, y + 1.14, wz + 0.86);
            } else if (supAbove) {
              // Under-canopy flame licks beneath burning tree branches!
              pushFlame(wx + 0.12, y + 0.15, wz + 0.12, wx + 0.88, y + 0.15, wz + 0.88, wx + 0.88, y + 0.99, wz + 0.88, wx + 0.12, y + 0.99, wz + 0.12);
              pushFlame(wx + 0.12, y + 0.15, wz + 0.88, wx + 0.88, y + 0.15, wz + 0.12, wx + 0.88, y + 0.99, wz + 0.12, wx + 0.12, y + 0.99, wz + 0.88);
            }
            continue;
          }

          // Authentic Minecraft 4-Plane '#' Hash-Grid 3D Wheat Crop Geometry (lush & dense like Screenshot 2!)
          if (isWheatBlock(id)) {
            const uv = uvTable[id][0];
            const shade = 0.96 * calcSkyLight(lx, y, lz);
            const y0 = y - 0.05;
            const y1 = y + 0.94;
            // 2 parallel North-South planes at x = 0.25 and x = 0.75
            bCutout.pushQuad(wx + 0.25, y0, wz, uv.u0, uv.v0, shade, wx + 0.25, y0, wz + 1, uv.u1, uv.v0, shade, wx + 0.25, y1, wz + 1, uv.u1, uv.v1, shade, wx + 0.25, y1, wz, uv.u0, uv.v1, shade, 1, 0, 0);
            bCutout.pushQuad(wx + 0.75, y0, wz + 1, uv.u0, uv.v0, shade, wx + 0.75, y0, wz, uv.u1, uv.v0, shade, wx + 0.75, y1, wz, uv.u1, uv.v1, shade, wx + 0.75, y1, wz + 1, uv.u0, uv.v1, shade, -1, 0, 0);
            // 2 parallel East-West planes at z = 0.25 and z = 0.75
            bCutout.pushQuad(wx, y0, wz + 0.25, uv.u0, uv.v0, shade, wx + 1, y0, wz + 0.25, uv.u1, uv.v0, shade, wx + 1, y1, wz + 0.25, uv.u1, uv.v1, shade, wx, y1, wz + 0.25, uv.u0, uv.v1, shade, 0, 0, 1);
            bCutout.pushQuad(wx + 1, y0, wz + 0.75, uv.u0, uv.v0, shade, wx, y0, wz + 0.75, uv.u1, uv.v0, shade, wx, y1, wz + 0.75, uv.u1, uv.v1, shade, wx + 1, y1, wz + 0.75, uv.u0, uv.v1, shade, 0, 0, -1);
            continue;
          }

          if (def.cross) {
            const isStaticCross = id === BLOCK.LADDER;
            const isFire = id === BLOCK.FIRE;
            const b = isStaticCross ? bStatic : bCutout;
            const uv = uvTable[id][0];
            const shade = isFire ? 1.65 : ((def.light > 0 ? 1.18 : 0.94) * calcSkyLight(lx, y, lz));
            const y0 = y + (isStaticCross || isFire ? 0.0 : 0.02);
            const y1 = y + (isFire ? 0.98 : 0.9);
            b.pushQuad(
              wx + 0.15, y0, wz + 0.15, uv.u0, uv.v0, shade,
              wx + 0.85, y0, wz + 0.85, uv.u1, uv.v0, shade,
              wx + 0.85, y1, wz + 0.85, uv.u1, uv.v1, shade,
              wx + 0.15, y1, wz + 0.15, uv.u0, uv.v1, shade,
              0, 1, 0
            );
            b.pushQuad(
              wx + 0.15, y0, wz + 0.85, uv.u0, uv.v0, shade,
              wx + 0.85, y0, wz + 0.15, uv.u1, uv.v0, shade,
              wx + 0.85, y1, wz + 0.15, uv.u1, uv.v1, shade,
              wx + 0.15, y1, wz + 0.85, uv.u0, uv.v1, shade,
              0, 1, 0
            );
            continue;
          }

          // Solid opaque cubes are greedily meshed in PASS 2!
          if (transTable[id] === 0) continue;

          const isWater = id === BLOCK.WATER;
          const isLava = id === BLOCK.LAVA;
          if (isWater) hasWater = true;
          const isStaticCutout = id === BLOCK.GLASS || id === BLOCK.ICE || isLava;
          const b = isWater ? bWater : (isStaticCutout ? bStatic : bCutout);
          const faceUVs = uvTable[id];
          const lightBoost = isLava ? 1.55 : (def.light > 0 ? 1.18 : 1.0);

          // Authentic Minecraft Sloped Multi-Level Lava & Flowing Water Geometry (matches Screenshot 1!)
          // Calm flat ocean/lake water sources (no flowing water in fluidLevels nearby) stay greedily merged in PASS 3!
          let fluidSloped = false;
          let hNW = 0.875, hNE = 0.875, hSE = 0.875, hSW = 0.875;
          if (isWater || isLava) {
            const aboveSame = fastGet(lx, y + 1, lz) === id;
            const myLv = this.fluidLevels.size > 0 ? this.getFluidLevel(wx, y, wz) : 0;
            const checkSlope = isLava || myLv > 0 || (this.fluidLevels.size > 0 && (
              this.fluidLevels.has(`${wx + 1},${y},${wz}`) || this.fluidLevels.has(`${wx - 1},${y},${wz}`) ||
              this.fluidLevels.has(`${wx},${y},${wz + 1}`) || this.fluidLevels.has(`${wx},${y},${wz - 1}`) ||
              this.fluidLevels.has(`${wx + 1},${y},${wz + 1}`) || this.fluidLevels.has(`${wx - 1},${y},${wz - 1}`) ||
              this.fluidLevels.has(`${wx + 1},${y},${wz - 1}`) || this.fluidLevels.has(`${wx - 1},${y},${wz + 1}`)
            ));
            if (aboveSame) {
              hNW = hNE = hSE = hSW = 1.0;
              fluidSloped = isLava || checkSlope;
            } else if (checkSlope) {
              hNW = this.getFluidCornerHeight(wx, y, wz, id);
              hNE = this.getFluidCornerHeight(wx + 1, y, wz, id);
              hSE = this.getFluidCornerHeight(wx + 1, y, wz + 1, id);
              hSW = this.getFluidCornerHeight(wx, y, wz + 1, id);
              fluidSloped = true;
            }
          }

          // Calm flat water +Y surface is greedily meshed in PASS 3; sloped flowing water & ALL lava emit exact sloped quads here!
          const startFi = (isWater && !fluidSloped) ? 1 : 0;
          for (let fi = startFi; fi < 6; fi++) {
            const face = FACES[fi];
            const dx0 = face.dir[0];
            const dy0 = face.dir[1];
            const dz0 = face.dir[2];
            const nlx = lx + dx0;
            const ny = y + dy0;
            const nlz = lz + dz0;
            const neighbor = fastGet(nlx, ny, nlz);

            if (isWater || isLava) {
              if (fi === 0) {
                // Keep water/lava top face visible even when a solid block sits directly above (water top is at y+0.88, zero Z-fighting!)
                if (neighbor === id) continue;
              } else {
                if (neighbor === id || (neighbor !== 0 && transTable[neighbor] === 0)) continue;
              }
            } else {
              if (neighbor === id && isStaticCutout) continue;
              if (neighbor !== 0 && transTable[neighbor] === 0) continue;
            }

            const uv = faceUVs[fi];
            const c0 = face.corners[0], c1 = face.corners[1], c2 = face.corners[2], c3 = face.corners[3];
            if (!isWater) applyGI(b, nlx, ny, nlz, id);
            const s = face.shade;
            const cornerY = (c) => {
              if (!(isWater || isLava) || c[1] !== 1) return y + c[1];
              if (c[0] === 0 && c[2] === 0) return y + hNW;
              if (c[0] === 1 && c[2] === 0) return y + hNE;
              if (c[0] === 1 && c[2] === 1) return y + hSE;
              return y + hSW;
            };
            const py0 = cornerY(c0);
            const py1 = cornerY(c1);
            const py2 = cornerY(c2);
            const py3 = cornerY(c3);

            b.pushQuad(
              wx + c0[0], py0, wz + c0[2], c0[3] ? uv.u1 : uv.u0, c0[4] ? uv.v1 : uv.v0, s,
              wx + c1[0], py1, wz + c1[2], c1[3] ? uv.u1 : uv.u0, c1[4] ? uv.v1 : uv.v0, s,
              wx + c2[0], py2, wz + c2[2], c2[3] ? uv.u1 : uv.u0, c2[4] ? uv.v1 : uv.v0, s,
              wx + c3[0], py3, wz + c3[2], c3[3] ? uv.u1 : uv.u0, c3[4] ? uv.v1 : uv.v0, s,
              dx0, dy0, dz0
            );
          }
        }
      }
    }

    // PASS 2: TRUE GREEDY MESHING for Opaque Cubes (5x–10x fewer triangles + smooth 4-corner AO + Full 3D Voxel GI!)
    const gMask = GREEDY_MASK;
    const gGi = GREEDY_GI;
    const gShade = GREEDY_SHADE;

    // 2A. +Y (fi=0) and -Y (fi=1) Horizontal Slices
    for (let fi = 0; fi < 2; fi++) {
      const dy0 = fi === 0 ? 1 : -1;
      const faceShade = FACES[fi].shade;
      for (let y = 0; y <= yLimit; y++) {
        const yOff = y << 8;
        const ny = y + dy0;
        let anyInSlice = false;
        gMask.fill(0, 0, 256);

        for (let lz = 0; lz < 16; lz++) {
          const zOff = lz << 4;
          for (let lx = 0; lx < 16; lx++) {
            const id = data[lx + zOff + yOff];
            if (id === 0 || transTable[id] !== 0) continue;
            const neighbor = fastGet(lx, ny, lz);
            if (neighbor !== 0 && transTable[neighbor] === 0) continue;

            const baseShade = faceShade;
            const giKey = giVol.getLightPack(lx, ny, lz) | (giVol.isEmissiveBlock(id) ? (1 << 28) : 0);

            if (fi === 0) {
              // 4-corner AO for +Y top face
              const o00 = solidTable[fastGet(lx - 1, ny, lz)] + solidTable[fastGet(lx, ny, lz + 1)] + solidTable[fastGet(lx - 1, ny, lz + 1)];
              const o10 = solidTable[fastGet(lx + 1, ny, lz)] + solidTable[fastGet(lx, ny, lz + 1)] + solidTable[fastGet(lx + 1, ny, lz + 1)];
              const o11 = solidTable[fastGet(lx + 1, ny, lz)] + solidTable[fastGet(lx, ny, lz - 1)] + solidTable[fastGet(lx + 1, ny, lz - 1)];
              const o01 = solidTable[fastGet(lx - 1, ny, lz)] + solidTable[fastGet(lx, ny, lz - 1)] + solidTable[fastGet(lx - 1, ny, lz - 1)];
              if (o00 === o10 && o10 === o11 && o11 === o01) {
                const s = baseShade * (1.0 - o00 * 0.11);
                const idx2 = lx + zOff;
                gMask[idx2] = (id << 10) | ((s * 128) | 0);
                gGi[idx2] = giKey;
                gShade[idx2] = s;
                anyInSlice = true;
              } else {
                const uv = uvTable[id][0];
                const wx = ox + lx, wz = oz + lz;
                applyGI(bOpaque, lx, ny, lz, id);
                bOpaque.pushTiledQuad(
                  wx,     y + 1, wz + 1, 0, 0, baseShade * (1.0 - o00 * 0.11),
                  wx + 1, y + 1, wz + 1, 1, 0, baseShade * (1.0 - o10 * 0.11),
                  wx + 1, y + 1, wz,     1, 1, baseShade * (1.0 - o11 * 0.11),
                  wx,     y + 1, wz,     0, 1, baseShade * (1.0 - o01 * 0.11),
                  0, 1, 0, uv.u0, uv.v0, uv.du, uv.dv
                );
              }
            } else {
              const s = baseShade;
              const idx2 = lx + zOff;
              gMask[idx2] = (id << 10) | ((s * 128) | 0);
              gGi[idx2] = giKey;
              gShade[idx2] = s;
              anyInSlice = true;
            }
          }
        }

        if (!anyInSlice) continue;
        // Greedy 2D Rectangle Sweep across 16x16 slice (preserves full 3D Voxel GI gradients!)
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const slot0 = lx + (lz << 4);
            const key = gMask[slot0];
            if (key === 0) continue;
            const giKey = gGi[slot0];
            let w = 1;
            while (lx + w < 16 && gMask[(lx + w) + (lz << 4)] === key && gGi[(lx + w) + (lz << 4)] === giKey) w++;
            let h = 1;
            outerH: while (lz + h < 16) {
              const rowOff = (lz + h) << 4;
              for (let k = 0; k < w; k++) {
                if (gMask[lx + k + rowOff] !== key || gGi[lx + k + rowOff] !== giKey) break outerH;
              }
              h++;
            }
            const s = gShade[slot0];
            for (let dz = 0; dz < h; dz++) {
              const rowOff = (lz + dz) << 4;
              for (let dx = 0; dx < w; dx++) gMask[lx + dx + rowOff] = 0;
            }
            const id = key >>> 10;
            const uv = uvTable[id][fi];
            const wx = ox + lx, wz = oz + lz;
            applyGI(bOpaque, lx, ny, lz, id);
            if (fi === 0) {
              bOpaque.pushTiledQuad(
                wx,     y + 1, wz + h, 0, 0, s,
                wx + w, y + 1, wz + h, w, 0, s,
                wx + w, y + 1, wz,     w, h, s,
                wx,     y + 1, wz,     0, h, s,
                0, 1, 0, uv.u0, uv.v0, uv.du, uv.dv
              );
            } else {
              bOpaque.pushTiledQuad(
                wx,     y, wz,     0, 0, s,
                wx + w, y, wz,     w, 0, s,
                wx + w, y, wz + h, w, h, s,
                wx,     y, wz + h, 0, h, s,
                0, -1, 0, uv.u0, uv.v0, uv.du, uv.dv
              );
            }
          }
        }
      }
    }

    // 2B. +X (fi=2) and -X (fi=3) Vertical Slices
    const sliceLen = (yLimit + 1) << 4;
    for (let fi = 2; fi <= 3; fi++) {
      const dx0 = fi === 2 ? 1 : -1;
      const faceShade = FACES[fi].shade;
      for (let lx = 0; lx < 16; lx++) {
        const nlx = lx + dx0;
        const wx = ox + lx;
        let anyInSlice = false;
        gMask.fill(0, 0, sliceLen);

        for (let y = 0; y <= yLimit; y++) {
          const yOff = y << 8;
          const mRow = y << 4;
          for (let lz = 0; lz < 16; lz++) {
            const id = data[lx + (lz << 4) + yOff];
            if (id === 0 || transTable[id] !== 0) continue;
            const neighbor = fastGet(nlx, y, lz);
            if (neighbor !== 0 && transTable[neighbor] === 0) continue;

            const baseShade = faceShade;
            const giKey = giVol.getLightPack(nlx, y, lz) | (giVol.isEmissiveBlock(id) ? (1 << 28) : 0);

            const calcS = (dy, dz) =>
              solidTable[fastGet(nlx, y + dy, lz)] +
              solidTable[fastGet(nlx, y, lz + dz)] +
              solidTable[fastGet(nlx, y + dy, lz + dz)];
            const o0 = fi === 2 ? calcS(-1, 1) : calcS(-1, -1);
            const o1 = fi === 2 ? calcS(-1, -1) : calcS(-1, 1);
            const o2 = fi === 2 ? calcS(1, -1) : calcS(1, 1);
            const o3 = fi === 2 ? calcS(1, 1) : calcS(1, -1);

            if (o0 === o1 && o1 === o2 && o2 === o3) {
              const s = baseShade * (1.0 - o0 * 0.11);
              gMask[lz + mRow] = (id << 10) | ((s * 128) | 0);
              gGi[lz + mRow] = giKey;
              gShade[lz + mRow] = s;
              anyInSlice = true;
            } else {
              const uv = uvTable[id][fi];
              const wz = oz + lz;
              const xPos = fi === 2 ? wx + 1 : wx;
              applyGI(bOpaque, nlx, y, lz, id);
              if (fi === 2) {
                bOpaque.pushTiledQuad(
                  xPos, y,     wz + 1, 0, 0, baseShade * (1.0 - o0 * 0.11),
                  xPos, y,     wz,     1, 0, baseShade * (1.0 - o1 * 0.11),
                  xPos, y + 1, wz,     1, 1, baseShade * (1.0 - o2 * 0.11),
                  xPos, y + 1, wz + 1, 0, 1, baseShade * (1.0 - o3 * 0.11),
                  1, 0, 0, uv.u0, uv.v0, uv.du, uv.dv
                );
              } else {
                bOpaque.pushTiledQuad(
                  xPos, y,     wz,     0, 0, baseShade * (1.0 - o0 * 0.11),
                  xPos, y,     wz + 1, 1, 0, baseShade * (1.0 - o1 * 0.11),
                  xPos, y + 1, wz + 1, 1, 1, baseShade * (1.0 - o2 * 0.11),
                  xPos, y + 1, wz,     0, 1, baseShade * (1.0 - o3 * 0.11),
                  -1, 0, 0, uv.u0, uv.v0, uv.du, uv.dv
                );
              }
            }
          }
        }

        if (!anyInSlice) continue;
        const xPos = fi === 2 ? wx + 1 : wx;
        for (let y = 0; y <= yLimit; y++) {
          const mRow = y << 4;
          for (let lz = 0; lz < 16; lz++) {
            const slot0 = lz + mRow;
            const key = gMask[slot0];
            if (key === 0) continue;
            const giKey = gGi[slot0];
            let w = 1;
            while (lz + w < 16 && gMask[(lz + w) + mRow] === key && gGi[(lz + w) + mRow] === giKey) w++;
            let h = 1;
            outerHX: while (y + h <= yLimit) {
              const rOff = (y + h) << 4;
              for (let k = 0; k < w; k++) {
                if (gMask[lz + k + rOff] !== key || gGi[lz + k + rOff] !== giKey) break outerHX;
              }
              h++;
            }
            const s = gShade[slot0];
            for (let dy = 0; dy < h; dy++) {
              const rOff = (y + dy) << 4;
              for (let dz = 0; dz < w; dz++) gMask[lz + dz + rOff] = 0;
            }
            const id = key >>> 10;
            const uv = uvTable[id][fi];
            const wz = oz + lz;
            applyGI(bOpaque, nlx, y, lz, id);
            if (fi === 2) {
              bOpaque.pushTiledQuad(
                xPos, y,     wz + w, 0, 0, s,
                xPos, y,     wz,     w, 0, s,
                xPos, y + h, wz,     w, h, s,
                xPos, y + h, wz + w, 0, h, s,
                1, 0, 0, uv.u0, uv.v0, uv.du, uv.dv
              );
            } else {
              bOpaque.pushTiledQuad(
                xPos, y,     wz,     0, 0, s,
                xPos, y,     wz + w, w, 0, s,
                xPos, y + h, wz + w, w, h, s,
                xPos, y + h, wz,     0, h, s,
                -1, 0, 0, uv.u0, uv.v0, uv.du, uv.dv
              );
            }
          }
        }
      }
    }

    // 2C. +Z (fi=4) and -Z (fi=5) Vertical Slices
    for (let fi = 4; fi <= 5; fi++) {
      const dz0 = fi === 4 ? 1 : -1;
      const faceShade = FACES[fi].shade;
      for (let lz = 0; lz < 16; lz++) {
        const nlz = lz + dz0;
        const wz = oz + lz;
        let anyInSlice = false;
        gMask.fill(0, 0, sliceLen);

        for (let y = 0; y <= yLimit; y++) {
          const yOff = y << 8;
          const mRow = y << 4;
          const zOff = lz << 4;
          for (let lx = 0; lx < 16; lx++) {
            const id = data[lx + zOff + yOff];
            if (id === 0 || transTable[id] !== 0) continue;
            const neighbor = fastGet(lx, y, nlz);
            if (neighbor !== 0 && transTable[neighbor] === 0) continue;

            const baseShade = faceShade;
            const giKey = giVol.getLightPack(lx, y, nlz) | (giVol.isEmissiveBlock(id) ? (1 << 28) : 0);

            const calcS = (dy, dx) =>
              solidTable[fastGet(lx, y + dy, nlz)] +
              solidTable[fastGet(lx + dx, y, nlz)] +
              solidTable[fastGet(lx + dx, y + dy, nlz)];
            const o0 = fi === 4 ? calcS(-1, -1) : calcS(-1, 1);
            const o1 = fi === 4 ? calcS(-1, 1) : calcS(-1, -1);
            const o2 = fi === 4 ? calcS(1, 1) : calcS(1, -1);
            const o3 = fi === 4 ? calcS(1, -1) : calcS(1, 1);

            if (o0 === o1 && o1 === o2 && o2 === o3) {
              const s = baseShade * (1.0 - o0 * 0.11);
              gMask[lx + mRow] = (id << 10) | ((s * 128) | 0);
              gGi[lx + mRow] = giKey;
              gShade[lx + mRow] = s;
              anyInSlice = true;
            } else {
              const uv = uvTable[id][fi];
              const wx = ox + lx;
              const zPos = fi === 4 ? wz + 1 : wz;
              applyGI(bOpaque, lx, y, nlz, id);
              if (fi === 4) {
                bOpaque.pushTiledQuad(
                  wx,     y,     zPos, 0, 0, baseShade * (1.0 - o0 * 0.11),
                  wx + 1, y,     zPos, 1, 0, baseShade * (1.0 - o1 * 0.11),
                  wx + 1, y + 1, zPos, 1, 1, baseShade * (1.0 - o2 * 0.11),
                  wx,     y + 1, zPos, 0, 1, baseShade * (1.0 - o3 * 0.11),
                  0, 0, 1, uv.u0, uv.v0, uv.du, uv.dv
                );
              } else {
                bOpaque.pushTiledQuad(
                  wx + 1, y,     zPos, 0, 0, baseShade * (1.0 - o0 * 0.11),
                  wx,     y,     zPos, 1, 0, baseShade * (1.0 - o1 * 0.11),
                  wx,     y + 1, zPos, 1, 1, baseShade * (1.0 - o2 * 0.11),
                  wx + 1, y + 1, zPos, 0, 1, baseShade * (1.0 - o3 * 0.11),
                  0, 0, -1, uv.u0, uv.v0, uv.du, uv.dv
                );
              }
            }
          }
        }

        if (!anyInSlice) continue;
        const zPos = fi === 4 ? wz + 1 : wz;
        for (let y = 0; y <= yLimit; y++) {
          const mRow = y << 4;
          for (let lx = 0; lx < 16; lx++) {
            const slot0 = lx + mRow;
            const key = gMask[slot0];
            if (key === 0) continue;
            const giKey = gGi[slot0];
            let w = 1;
            while (lx + w < 16 && gMask[(lx + w) + mRow] === key && gGi[(lx + w) + mRow] === giKey) w++;
            let h = 1;
            outerHZ: while (y + h <= yLimit) {
              const rOff = (y + h) << 4;
              for (let k = 0; k < w; k++) {
                if (gMask[lx + k + rOff] !== key || gGi[lx + k + rOff] !== giKey) break outerHZ;
              }
              h++;
            }
            const s = gShade[slot0];
            for (let dy = 0; dy < h; dy++) {
              const rOff = (y + dy) << 4;
              for (let dx = 0; dx < w; dx++) gMask[lx + dx + rOff] = 0;
            }
            const id = key >>> 10;
            const uv = uvTable[id][fi];
            const wx = ox + lx;
            applyGI(bOpaque, lx, y, nlz, id);
            if (fi === 4) {
              bOpaque.pushTiledQuad(
                wx,     y,     zPos, 0, 0, s,
                wx + w, y,     zPos, w, 0, s,
                wx + w, y + h, zPos, w, h, s,
                wx,     y + h, zPos, 0, h, s,
                0, 0, 1, uv.u0, uv.v0, uv.du, uv.dv
              );
            } else {
              bOpaque.pushTiledQuad(
                wx + w, y,     zPos, 0, 0, s,
                wx,     y,     zPos, w, 0, s,
                wx,     y + h, zPos, w, h, s,
                wx + w, y + h, zPos, 0, h, s,
                0, 0, -1, uv.u0, uv.v0, uv.du, uv.dv
              );
            }
          }
        }
      }
    }

    // PASS 3: TRUE GREEDY MESHING for +Y Water Surface (16x16 ocean -> 1 single quad!)
    if (hasWater) {
      const wMask = GREEDY_WATER_MASK;
      const wUV = uvTable[BLOCK.WATER][0];
      for (let y = 0; y <= yLimit; y++) {
        const yOff = y << 8;
        let anyW = false;
        wMask.fill(0);
        for (let lz = 0; lz < 16; lz++) {
          const zOff = lz << 4;
          for (let lx = 0; lx < 16; lx++) {
            if (data[lx + zOff + yOff] !== BLOCK.WATER) continue;
            const above = fastGet(lx, y + 1, lz);
            // NEVER cull water surface when a block sits above it — water surface sits at y+0.88 so it flows seamlessly under blocks & bridges!
            if (above === BLOCK.WATER) continue;
            // Skip sloped flowing water (already rendered with exact 4-corner slopes in PASS 1!)
            if (this.fluidLevels.size > 0) {
              const wxW = ox + lx, wzW = oz + lz;
              if (
                this.getFluidLevel(wxW, y, wzW) > 0 ||
                this.fluidLevels.has(`${wxW + 1},${y},${wzW}`) || this.fluidLevels.has(`${wxW - 1},${y},${wzW}`) ||
                this.fluidLevels.has(`${wxW},${y},${wzW + 1}`) || this.fluidLevels.has(`${wxW},${y},${wzW - 1}`) ||
                this.fluidLevels.has(`${wxW + 1},${y},${wzW + 1}`) || this.fluidLevels.has(`${wxW - 1},${y},${wzW - 1}`) ||
                this.fluidLevels.has(`${wxW + 1},${y},${wzW - 1}`) || this.fluidLevels.has(`${wxW - 1},${y},${wzW + 1}`)
              ) continue;
            }
            wMask[lx + zOff] = 1;
            anyW = true;
          }
        }
        if (!anyW) continue;
        const wy = y + 0.88;
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            if (!wMask[lx + (lz << 4)]) continue;
            let w = 1;
            while (lx + w < 16 && wMask[(lx + w) + (lz << 4)]) w++;
            let h = 1;
            outerHW: while (lz + h < 16) {
              const rOff = (lz + h) << 4;
              for (let k = 0; k < w; k++) {
                if (!wMask[lx + k + rOff]) break outerHW;
              }
              h++;
            }
            for (let dz = 0; dz < h; dz++) {
              const rOff = (lz + dz) << 4;
              for (let dx = 0; dx < w; dx++) wMask[lx + dx + rOff] = 0;
            }
            const wx = ox + lx, wz = oz + lz;
            bWater.pushQuad(
              wx,     wy, wz + h, wUV.u0, wUV.v0, 1.0,
              wx + w, wy, wz + h, wUV.u1, wUV.v0, 1.0,
              wx + w, wy, wz,     wUV.u1, wUV.v1, 1.0,
              wx,     wy, wz,     wUV.u0, wUV.v1, 1.0,
              0, 1, 0
            );
          }
        }
      }
    }

    const useShadows = this.shaderMode !== 'low';
    const useFar = this.shaderMode === 'high' || this.shaderMode === 'ultra';
    const shadowChunkR = useFar ? 6 : 3;
    const nearShadow = Math.abs(cx - this._lastChunkPcx) <= shadowChunkR && Math.abs(cz - this._lastChunkPcz) <= shadowChunkR;
    const addBucket = (bucket, mat, renderOrder = 0, shadowKind = 'none') => {
      const geo = bucket.toGeometry();
      if (!geo) return;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = renderOrder;
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (shadowKind === 'opaque') {
        mesh.castShadow = useShadows && nearShadow;
      } else if (shadowKind === 'cutout') {
        mesh.customDepthMaterial = this.cutoutDepthMat;
        mesh.castShadow = useFar && nearShadow;
      } else if (shadowKind === 'water') {
        // Put Water on Three.js Layer 1 so PostFX splits Opaque (Layer 0) -> Water SSR/Refraction (Layer 1) with ZERO extra opaque draws!
        mesh.layers.set(1);
      }
      mesh.receiveShadow = false; // Handled directly by our 2-Cascade CSM Shader!
      this.group.add(mesh);
      chunk.meshes.push(mesh);
    };

    addBucket(bOpaque, this.opaqueMat, 0, 'opaque');
    addBucket(bCutout, this.cutoutMat, 1, 'cutout');
    addBucket(bStatic, this.staticCutoutMat, 1, 'cutout');
    addBucket(bFire, this.fireMat, 2, 'none');
    addBucket(bWater, this.waterMat, 3, 'water');
    if (chunk.lightKeys.length > 0) this._lightDirty = true;
    this._shadowNeedsUpdate = true;
  }

  setShaderMode(mode) {
    const m = mode === 'off' ? 'low' : (mode === 'enhanced' ? 'medium' : (mode || 'ultra'));
    this.shaderMode = m;
    this.shaderUniforms.uWaveStrength.value = m === 'low' ? 0.0 : (m === 'ultra' ? 1.15 : (m === 'high' ? 1.0 : 0.85));
    this.shaderUniforms.uShaderOn.value = m === 'low' ? 0.0 : 1.0;
    this.shaderUniforms.uPbrOn.value = m === 'low' ? 0.0 : 1.0;
    const useShadows = m !== 'low';
    const useFar = m === 'high' || m === 'ultra';
    const shadowChunkR = useFar ? 6 : 3;
    this.shaderUniforms.uShadowsOn.value = useShadows ? 1.0 : 0.0;
    this.shaderUniforms.uHasFarCascade.value = useFar ? 1.0 : 0.0;
    this.shaderUniforms.uShadowSoftness.value = m === 'ultra' ? 1.55 : (m === 'high' ? 1.3 : 1.05);
    for (const chunk of this.chunks.values()) {
      const inR = Math.abs(chunk.cx - this._lastChunkPcx) <= shadowChunkR && Math.abs(chunk.cz - this._lastChunkPcz) <= shadowChunkR;
      for (const mesh of chunk.meshes) {
        if (mesh.material === this.opaqueMat) {
          mesh.castShadow = useShadows && inR;
        } else if (mesh.material === this.cutoutMat || mesh.material === this.staticCutoutMat) {
          mesh.castShadow = useFar && inR;
        }
      }
    }
    this._shadowNeedsUpdate = true;
  }

  setWaterSplitPass(active) {
    if (!this.waterMat || !this.waterMat.uniforms) return;
    this.waterMat.uniforms.uHasOpaqueCopy.value = active ? 1.0 : 0.0;
    if (!active) this.waterMat.uniforms.uSsrSteps.value = 0.0;
  }

  syncWaterPass(opaqueColorTex, opaqueDepthTex, camera, width, height, ssrSteps = 20) {
    const u = this.waterMat.uniforms;
    u.tOpaqueColor.value = opaqueColorTex || this._dummyShadowTex;
    u.tOpaqueDepth.value = opaqueDepthTex || this._dummyShadowTex;
    u.uHasOpaqueCopy.value = (opaqueColorTex && opaqueDepthTex) ? 1.0 : 0.0;
    u.uSsrSteps.value = ssrSteps;
    u.uResolution.value.set(width, height);
    u.uInvProjection.value.copy(camera.projectionMatrixInverse);
    u.uProjection.value.copy(camera.projectionMatrix);
    u.uViewMatrix.value.copy(camera.matrixWorldInverse);
  }

  updateShaders(dt, sky = null) {
    this.shaderUniforms.uTime.value += dt;
    if (sky) {
      const p = sky.getShaderParams();
      this.shaderUniforms.uSunDir.value.copy(p.sunDir);
      if (p.moonDir) this.shaderUniforms.uMoonDir.value.copy(p.moonDir);
      this.shaderUniforms.uTopColor.value.copy(p.topColor);
      this.shaderUniforms.uMidColor.value.copy(p.midColor);
      this.shaderUniforms.uHorizonColor.value.copy(p.horizonColor);
      this.shaderUniforms.uSunsetColor.value.copy(p.sunsetColor);
      this.shaderUniforms.uSunColor.value.copy(p.sunColor);
      this.shaderUniforms.uCloudLitColor.value.copy(p.cloudLitColor);
      this.shaderUniforms.uCloudShadowColor.value.copy(p.cloudShadowColor);
      this.shaderUniforms.uDayFactor.value = p.dayFactor;
      this.shaderUniforms.uSunsetFactor.value = p.sunsetFactor;
      this.shaderUniforms.uRainFactor.value = p.rainFactor;
      if (typeof p.wetness === 'number') this.shaderUniforms.uWetness.value = p.wetness;
      this.shaderUniforms.uCloudTime.value = p.cloudTime;
      this.shaderUniforms.uFogNear.value = sky.fog.near;
      this.shaderUniforms.uFogFar.value = sky.fog.far;

      if (sky.getShadowParams) {
        const sp = sky.getShadowParams();
        this.shaderUniforms.uShadowDir.value.copy(sp.shadowDir);
        this.shaderUniforms.uSunLightColor.value.copy(sp.sunLightColor);
        this.shaderUniforms.uSunLightIntensity.value = sp.sunLightIntensity;
        this.shaderUniforms.uHemiSkyColor.value.copy(sp.hemiSkyColor);
        this.shaderUniforms.uHemiGroundColor.value.copy(sp.hemiGroundColor);
        this.shaderUniforms.uHemiIntensity.value = sp.hemiIntensity;
        this.shaderUniforms.uFillColor.value.copy(sp.fillColor);
        this.shaderUniforms.uFillIntensity.value = sp.fillIntensity;
        this.shaderUniforms.uShadowMap0.value = sp.nearMap || this._dummyShadowTex;
        this.shaderUniforms.uShadowMap1.value = sp.farMap || this._dummyShadowTex;
        // Bind shadow matrices BY REFERENCE so WebGLShadowMap's in-frame update is instantly synced!
        this.shaderUniforms.uShadowMatrix0.value = sp.nearMatrix;
        this.shaderUniforms.uShadowMatrix1.value = sp.farMatrix;
        this.shaderUniforms.uShadowTexel0.value = sp.nearTexelSize;
        this.shaderUniforms.uShadowTexel1.value = sp.farTexelSize;
        this.shaderUniforms.uShadowsOn.value = (sp.useShadows && sp.nearMap) ? 1.0 : 0.0;
        this.shaderUniforms.uHasFarCascade.value = (sp.useFarCascade && sp.farMap) ? 1.0 : 0.0;
        this.shaderUniforms.uShadowSoftness.value = sp.shadowSoftness;
      }
    }
  }

  _hasCardinalNeighbors(cx, cz) {
    return (
      this.chunks.has(this.chunkKey(cx + 1, cz)) &&
      this.chunks.has(this.chunkKey(cx - 1, cz)) &&
      this.chunks.has(this.chunkKey(cx, cz + 1)) &&
      this.chunks.has(this.chunkKey(cx, cz - 1))
    );
  }

  _tryQueueChunkForMesh(cx, cz, pcx, pcz, rSq) {
    const c = this.chunks.get(this.chunkKey(cx, cz));
    if (!c || !c.dirty || c.queued) return;
    const dx = cx - pcx;
    const dz = cz - pcz;
    if (dx * dx + dz * dz > rSq) return;
    if (this._hasCardinalNeighbors(cx, cz)) {
      c.queued = true;
      this.meshQueue.push(c);
    }
  }

  updateChunksAround(px, pz, maxBuildsPerFrame = 2, budgetMs = 4.0, camDirX = 0, camDirZ = -1) {
    const pcx = Math.floor(px / CHUNK_SIZE);
    const pcz = Math.floor(pz / CHUNK_SIZE);
    const fullRD = this.renderDistance;
    // Full 1x1x1 voxel detail inner radius + Distant Horizons LOD ring all the way out to 64 chunks!
    const r = Math.min(fullRD, this.maxDetailRadius);
    this._ensureSpiralOffsets(r);

    const movedChunk = pcx !== this._lastChunkPcx || pcz !== this._lastChunkPcz || r !== this._lastChunkRD;
    if (movedChunk) {
      this._lastChunkPcx = pcx;
      this._lastChunkPcz = pcz;
      this._lastChunkRD = r;
      this._chunksAllLoaded = false;
      this._spiralCursor = 0;
    }

    const tStart = performance.now();
    const rMeshSq = (r + 0.5) * (r + 0.5);

    // 1. Stream missing chunk voxel data in pre-sorted spiral order under strict frame budget!
    if (!this._chunksAllLoaded) {
      const dataOffsets = this._spiralDataOffsets;
      let cursor = this._spiralCursor || 0;
      let generated = 0;
      const maxGen = r > 8 ? 3 : 2;
      const genBudget = budgetMs * 0.48;

      while (cursor < dataOffsets.length) {
        const off = dataOffsets[cursor];
        const cx = pcx + off.dx;
        const cz = pcz + off.dz;
        const ck = this.chunkKey(cx, cz);
        if (!this.chunks.has(ck)) {
          this.generateChunk(cx, cz);
          generated++;
          // Check if this chunk or any cardinal neighbor now has all 4 neighbors ready to mesh
          this._tryQueueChunkForMesh(cx, cz, pcx, pcz, rMeshSq);
          this._tryQueueChunkForMesh(cx + 1, cz, pcx, pcz, rMeshSq);
          this._tryQueueChunkForMesh(cx - 1, cz, pcx, pcz, rMeshSq);
          this._tryQueueChunkForMesh(cx, cz + 1, pcx, pcz, rMeshSq);
          this._tryQueueChunkForMesh(cx, cz - 1, pcx, pcz, rMeshSq);

          cursor++;
          if (generated >= maxGen || performance.now() - tStart >= genBudget) break;
        } else {
          // Ensure already-generated unmeshed chunks inside radius get queued
          const existing = this.chunks.get(ck);
          if (existing && existing.dirty && !existing.queued && off.d2 <= rMeshSq && this._hasCardinalNeighbors(cx, cz)) {
            existing.queued = true;
            this.meshQueue.push(existing);
          }
          cursor++;
        }
      }

      this._spiralCursor = cursor;
      if (cursor >= dataOffsets.length) {
        this._chunksAllLoaded = true;
      }
    }

    // 2. Build dirty chunk meshes within the remaining frame budget (zero lag spikes!)
    if (this.meshQueue.length > 0) {
      if (this.meshQueue.length > 2) {
        this.meshQueue.sort((a, b) => {
          const da = (a.cx - pcx) ** 2 + (a.cz - pcz) ** 2;
          const db = (b.cx - pcx) ** 2 + (b.cz - pcz) ** 2;
          return da - db;
        });
      }

      let built = 0;
      while (this.meshQueue.length > 0 && built < maxBuildsPerFrame) {
        const chunk = this.meshQueue.shift();
        if (!chunk) continue;
        chunk.queued = false;
        if (chunk.dirty && this.chunks.has(chunk.key)) {
          this.buildChunkMesh(chunk);
          built++;
          if (performance.now() - tStart >= budgetMs) break;
        }
      }
    }

    // 3. Only check unload & update nearby shadow casters when crossing a chunk border!
    if (movedChunk) {
      const unloadR = r + 3;
      const unloadSq = unloadR * unloadR;
      const useShadows = this.shaderMode !== 'low';
      const useFar = this.shaderMode === 'high' || this.shaderMode === 'ultra';
      const shadowChunkR = useFar ? 6 : 3;
      for (const [key, chunk] of this.chunks.entries()) {
        const dx = chunk.cx - pcx;
        const dz = chunk.cz - pcz;
        if (dx * dx + dz * dz > unloadSq) {
          for (const m of chunk.meshes) {
            this.group.remove(m);
            m.geometry.dispose();
          }
          if (chunk.lightKeys && chunk.lightKeys.length > 0) {
            for (const lk of chunk.lightKeys) this.lightSources.delete(lk);
            this._lightDirty = true;
          }
          this.chunks.delete(key);
        } else if (useShadows) {
          const inShadowFrustum = Math.abs(dx) <= shadowChunkR && Math.abs(dz) <= shadowChunkR;
          for (const m of chunk.meshes) {
            if (m.material === this.opaqueMat) {
              m.castShadow = inShadowFrustum;
            } else if (m.material === this.cutoutMat || m.material === this.staticCutoutMat) {
              m.castShadow = useFar && inShadowFrustum;
            }
          }
        }
      }
      this._shadowNeedsUpdate = true;
    }

    // 4. Seamless Contiguous Ready-Radius + Soft 14m Dither Crossfade into Distant Horizons LOD!
    // Measure exact contiguous meshed radius along pre-sorted spiral so LOD NEVER leaves an empty hole!
    const lodActive = fullRD > r;
    let readyChunks = r;
    if (lodActive && this._spiralOffsets && this._spiralOffsets.length > 0) {
      readyChunks = r;
      for (let i = 0; i < this._spiralOffsets.length; i++) {
        const off = this._spiralOffsets[i];
        const c = this.chunks.get(this.chunkKey(pcx + off.dx, pcz + off.dz));
        if (!c || !c.meshed) {
          readyChunks = Math.max(0, Math.sqrt(off.d2) - 0.5);
          break;
        }
      }
      // Only refresh chunk visibility flags when readyChunks changes or player moves chunk (avoids per-frame O(N) loop!)
      const qReady = Math.round(readyChunks * 4);
      if (movedChunk || qReady !== this._lastVisReadyQ || this.meshQueue.length > 0) {
        this._lastVisReadyQ = qReady;
        const visLimSq = (readyChunks + 0.95) * (readyChunks + 0.95);
        for (const chunk of this.chunks.values()) {
          if (!chunk.meshed || chunk.meshes.length === 0) continue;
          const dx = chunk.cx - pcx;
          const dz = chunk.cz - pcz;
          const shouldVis = (dx * dx + dz * dz) <= visLimSq;
          if (chunk.meshes[0].visible !== shouldVis) {
            for (let mi = 0; mi < chunk.meshes.length; mi++) chunk.meshes[mi].visible = shouldVis;
          }
        }
      }
    } else if (!lodActive && this._lastVisReadyQ !== -1) {
      this._lastVisReadyQ = -1;
      for (const chunk of this.chunks.values()) {
        if (chunk.meshes.length > 0 && !chunk.meshes[0].visible) {
          for (let mi = 0; mi < chunk.meshes.length; mi++) chunk.meshes[mi].visible = true;
        }
      }
    }

    const targetReadyBlocks = Math.max(0, (readyChunks - 0.45) * CHUNK_SIZE);
    if (this._smoothReadyBlocks === undefined) this._smoothReadyBlocks = targetReadyBlocks;
    // Shrink immediately if flying faster than chunks build (zero holes!), glide smoothly outward as chunks finish!
    if (targetReadyBlocks < this._smoothReadyBlocks) {
      this._smoothReadyBlocks = targetReadyBlocks;
    } else {
      this._smoothReadyBlocks += (targetReadyBlocks - this._smoothReadyBlocks) * 0.14;
    }

    const centerX = pcx * CHUNK_SIZE + 8;
    const centerZ = pcz * CHUNK_SIZE + 8;
    this.shaderUniforms.uLodInnerCenter.value.set(centerX, centerZ);
    const blendOuter = Math.max(0, this._smoothReadyBlocks);
    const blendInner = Math.max(0, blendOuter - 14.0);
    this.shaderUniforms.uLodBlendInner.value = blendInner;
    this.shaderUniforms.uLodBlendOuter.value = blendOuter;
    this.shaderUniforms.uLodInnerRadiusSq.value = blendInner * blendInner;

    const effectiveLodInnerR = Math.max(0, this._smoothReadyBlocks / CHUNK_SIZE);
    this.updateLodAround(pcx, pcz, effectiveLodInnerR, fullRD, Math.max(1.2, budgetMs * 0.42), camDirX, camDirZ);
  }

  _ensureLodPool() {
    if (!this._lodPool) {
      this._lodPool = new LodWorkerPool(this.seed, this.worldType, this._lodMaxWorkers);
    }
    return this._lodPool;
  }

  // Zero-copy mount of a compact worker-built LOD BufferGeometry (19 bytes/vert!)
  _mountLodResult(res, useInnerCutout = false) {
    if (!res || res.vCount === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(res.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(res.norm, 3, true));
    geo.setAttribute('color', new THREE.BufferAttribute(res.col, 3, true));
    geo.setAttribute('aMat', new THREE.BufferAttribute(res.mat, 1, true));
    geo.setIndex(new THREE.BufferAttribute(res.idx, 1));

    const mesh = new THREE.Mesh(geo, useInnerCutout ? this.lodMat : this.lodMatOuter);
    mesh.frustumCulled = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Tiny 3cm tier bias prevents z-fighting during 2-frame parent/child swaps while keeping 512-chunk oceans flat!
    mesh.position.y = -0.03 * res.tier;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  _sweepRetiringLods(forceAll = false) {
    if (this._lodRetiringKeys.size === 0) return;
    const active = this._lodActiveKeys;
    for (const key of this._lodRetiringKeys) {
      const rec = this.lodRegions.get(key);
      if (!rec) {
        this._lodRetiringKeys.delete(key);
        continue;
      }
      let canRemove = forceAll;
      if (!canRemove) {
        const { tier, rx, rz } = rec;
        // Check if replaced by coarser parent (merged)
        if (tier < 6) {
          const pKey = `${tier + 1}:${rx >> 1},${rz >> 1}`;
          if (active.has(pKey) && this.lodRegions.has(pKey)) canRemove = true;
        }
        // Check if replaced by 4 finer children (split)
        if (!canRemove && tier > 0) {
          const cx0 = rx * 2;
          const cz0 = rz * 2;
          const cTier = tier - 1;
          let allReady = true;
          let anyActive = false;
          for (let dz = 0; dz < 2; dz++) {
            for (let dx = 0; dx < 2; dx++) {
              const ck = `${cTier}:${cx0 + dx},${cz0 + dz}`;
              if (active.has(ck)) {
                anyActive = true;
                if (!this.lodRegions.has(ck)) allReady = false;
              }
            }
          }
          if (anyActive && allReady) canRemove = true;
        }
      }
      if (canRemove) {
        this.lodGroup.remove(rec.mesh);
        rec.mesh.geometry.dispose();
        this.lodRegions.delete(key);
        this._lodRetiringKeys.delete(key);
      }
    }
  }

  updateLodAround(pcx, pcz, detailR, fullRD, budgetMs = 1.6, camDirX = 0, camDirZ = -1) {
    if (fullRD <= detailR) {
      if (this.lodRegions.size > 0) {
        for (const rec of this.lodRegions.values()) {
          this.lodGroup.remove(rec.mesh);
          rec.mesh.geometry.dispose();
        }
        this.lodRegions.clear();
        this._lodRetiringKeys.clear();
        this._lodActiveKeys.clear();
        this._lodInnerKeys.clear();
        this._lodQueue.length = 0;
        this._lastLodRD = -1;
      }
      if (this._lodPool) {
        this._lodPool.clearQueue();
      }
      return;
    }

    const pool = this._ensureLodPool();
    const isTouchLOD = this.maxDetailRadius <= 6;

    // Re-evaluate zero-overlap 7-tier Quadtree LOD partition every 2 chunks or on renderDistance change!
    // T0=1m (4x4ch), T1=2m (8x8ch), T2=4m (16x16ch), T3=8m (32x32ch), T4=16m (64x64ch), T5=32m (128x128ch), T6=64m (256x256ch -> 1024ch!)
    const prx = pcx >> 1;
    const prz = pcz >> 1;

    if (prx !== this._lastLodRx || prz !== this._lastLodRz || fullRD !== this._lastLodRD) {
      this._lastLodRx = prx;
      this._lastLodRz = prz;
      this._lastLodRD = fullRD;

      const TIER_CHUNKS = [4, 8, 16, 32, 64, 128, 256];
      // Logarithmic split thresholds: ultra-lean ~95-115 frustum draw calls on iPad even at 1024 chunks (16.4 km!)
      const SPLIT_DIST = isTouchLOD
        ? [0, 13, 30, 68, 152, 310, 620]
        : [0, 20, 48, 100, 208, 390, 720];
      const clampedRD = Math.min(1024, fullRD);
      const maxDistLimit = clampedRD + 2;
      const innerCullDist = Math.max(0, detailR - 2.4);
      const innerCutoutCheck = detailR + 3.0;
      const rootTier = clampedRD > 512 ? 6 : (clampedRD > 128 ? 5 : 3);
      const rootSpan = TIER_CHUNKS[rootTier];

      const pxC = pcx + 0.5;
      const pzC = pcz + 0.5;
      const dirLen = Math.hypot(camDirX, camDirZ) || 1;
      const ldx = camDirX / dirLen;
      const ldz = camDirZ / dirLen;

      const activeKeys = new Set();
      const innerKeys = new Set();
      const needed = [];

      const visitNode = (tier, rx, rz) => {
        const span = TIER_CHUNKS[tier];
        const cX0 = rx * span;
        const cZ0 = rz * span;
        const cX1 = cX0 + span;
        const cZ1 = cZ0 + span;

        // Exact closest & farthest chunk distances from player to this quadtree tile
        const clX = pxC < cX0 ? cX0 : (pxC > cX1 ? cX1 : pxC);
        const clZ = pzC < cZ0 ? cZ0 : (pzC > cZ1 ? cZ1 : pzC);
        const minDist = Math.hypot(pxC - clX, pzC - clZ);
        if (minDist > maxDistLimit) return;

        const farDx = Math.max(Math.abs(pxC - cX0), Math.abs(pxC - cX1));
        const farDz = Math.max(Math.abs(pzC - cZ0), Math.abs(pzC - cZ1));
        const maxDist = Math.hypot(farDx, farDz);
        if (maxDist < innerCullDist) return;

        // Subdivide into 4 finer children if close enough!
        if (tier > 0 && minDist < SPLIT_DIST[tier]) {
          const cx0 = rx * 2;
          const cz0 = rz * 2;
          const nt = tier - 1;
          visitNode(nt, cx0, cz0);
          visitNode(nt, cx0 + 1, cz0);
          visitNode(nt, cx0, cz0 + 1);
          visitNode(nt, cx0 + 1, cz0 + 1);
          return;
        }

        const key = `${tier}:${rx},${rz}`;
        activeKeys.add(key);
        const needsCutout = minDist < innerCutoutCheck;
        if (needsCutout) innerKeys.add(key);

        const existing = this.lodRegions.get(key);
        if (existing) {
          existing.retiring = false;
          this._lodRetiringKeys.delete(key);
          // Zero-cost material swap so outer tiles always keep Apple TBDR Early-Z / HSR enabled!
          const targetMat = needsCutout ? this.lodMat : this.lodMatOuter;
          if (existing.mesh.material !== targetMat) {
            existing.mesh.material = targetMat;
          }
        } else {
          // Camera look-direction + distance priority: tiles right in front of the player build FIRST!
          const toX = (cX0 + span * 0.5) - pxC;
          const toZ = (cZ0 + span * 0.5) - pzC;
          const cDist = Math.hypot(toX, toZ) || 1;
          const lookDot = (toX * ldx + toZ * ldz) / cDist;
          const score = minDist * (1.0 - lookDot * 0.44) + tier * 2.5;
          needed.push({ rx, rz, tier, key, score });
        }
      };

      const minRX = Math.floor((pxC - maxDistLimit) / rootSpan);
      const maxRX = Math.floor((pxC + maxDistLimit) / rootSpan);
      const minRZ = Math.floor((pzC - maxDistLimit) / rootSpan);
      const maxRZ = Math.floor((pzC + maxDistLimit) / rootSpan);

      for (let rz = minRZ; rz <= maxRZ; rz++) {
        for (let rx = minRX; rx <= maxRX; rx++) {
          visitNode(rootTier, rx, rz);
        }
      }

      this._lodActiveKeys = activeKeys;
      this._lodInnerKeys = innerKeys;
      pool.prunePending(activeKeys);

      needed.sort((a, b) => a.score - b.score);
      this._lodQueue = needed;

      // Immediately dispose far out-of-range tiles; hold tier-transition tiles briefly until replacement arrives!
      for (const [key, rec] of this.lodRegions.entries()) {
        if (!activeKeys.has(key)) {
          const span = TIER_CHUNKS[rec.tier];
          const cX0 = rec.rx * span;
          const cZ0 = rec.rz * span;
          const clX = pxC < cX0 ? cX0 : (pxC > cX0 + span ? cX0 + span : pxC);
          const clZ = pzC < cZ0 ? cZ0 : (pzC > cZ0 + span ? cZ0 + span : pzC);
          const minDist = Math.hypot(pxC - clX, pzC - clZ);
          const farDx = Math.max(Math.abs(pxC - cX0), Math.abs(pxC - (cX0 + span)));
          const farDz = Math.max(Math.abs(pzC - cZ0), Math.abs(pzC - (cZ0 + span)));
          const maxDist = Math.hypot(farDx, farDz);

          if (minDist > maxDistLimit + 6 || maxDist < innerCullDist - 1.5) {
            this.lodGroup.remove(rec.mesh);
            rec.mesh.geometry.dispose();
            this.lodRegions.delete(key);
            this._lodRetiringKeys.delete(key);
          } else {
            rec.retiring = true;
            this._lodRetiringKeys.add(key);
          }
        }
      }
      this._sweepRetiringLods(needed.length === 0 && pool.inFlight.size === 0);
    }

    // 1. Feed queued regions to the multi-threaded Web Worker pool (or budget-capped sync fallback)
    if (this._lodQueue.length > 0) {
      if (pool.useWorkers) {
        const maxPipe = this._lodMaxWorkers * 4;
        while (this._lodQueue.length > 0 && pool.inFlight.size < maxPipe) {
          const item = this._lodQueue.shift();
          if (!this._lodActiveKeys.has(item.key) || this.lodRegions.has(item.key)) continue;
          pool.enqueue(item);
        }
      } else {
        const t0 = performance.now();
        let built = 0;
        while (this._lodQueue.length > 0 && built < 4) {
          const item = this._lodQueue.shift();
          if (!this._lodActiveKeys.has(item.key) || this.lodRegions.has(item.key)) continue;
          pool.enqueue(item);
          built++;
          if (performance.now() - t0 >= budgetMs) break;
        }
      }
    }

    // 2. Mount completed worker geometries onto scene (paced gently on iPad so WebGL uploads never stutter!)
    if (pool.readyResults.length > 0) {
      let mounted = 0;
      const maxMountPerFrame = isTouchLOD ? 6 : 12;
      while (pool.readyResults.length > 0 && mounted < maxMountPerFrame) {
        const res = pool.readyResults.shift();
        if (!this._lodActiveKeys.has(res.key) || this.lodRegions.has(res.key)) continue;
        const mesh = this._mountLodResult(res, this._lodInnerKeys.has(res.key));
        if (mesh) {
          this.lodGroup.add(mesh);
          this.lodRegions.set(res.key, { rx: res.rx, rz: res.rz, tier: res.tier, mesh, retiring: false });
          mounted++;
        }
      }
      if (mounted > 0) {
        this._sweepRetiringLods(false);
      }
    }

    // Clean up any leftover multi-step retiring tiles once all pending builds finish (e.g. after teleport!)
    if (this._lodRetiringKeys.size > 0 && this._lodQueue.length === 0 && pool.inFlight.size === 0 && pool.readyResults.length === 0) {
      this._sweepRetiringLods(true);
    }
  }

  // Smooth Frame-Sliced Spawn Preload (generates 5x5 data + meshes inner 3x3 with ZERO freezes!)
  async preloadSpawnAsync(px, pz, onProgress = null) {
    const pcx = Math.floor(px / CHUNK_SIZE);
    const pcz = Math.floor(pz / CHUNK_SIZE);

    const dataCoords = [];
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        dataCoords.push([pcx + dx, pcz + dz, dx * dx + dz * dz]);
      }
    }
    dataCoords.sort((a, b) => a[2] - b[2]);

    const meshCoords = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        meshCoords.push([pcx + dx, pcz + dz, dx * dx + dz * dz]);
      }
    }
    meshCoords.sort((a, b) => a[2] - b[2]);

    const total = dataCoords.length + meshCoords.length;
    let done = 0;
    const yieldFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

    let t = performance.now();
    for (const [cx, cz] of dataCoords) {
      this.generateChunk(cx, cz);
      done++;
      if (performance.now() - t > 10) {
        if (onProgress) onProgress(done / total, 'Generating terrain...');
        await yieldFrame();
        t = performance.now();
      }
    }

    for (const [cx, cz] of meshCoords) {
      const c = this.chunks.get(this.chunkKey(cx, cz));
      if (c) this.buildChunkMesh(c);
      done++;
      if (performance.now() - t > 10) {
        if (onProgress) onProgress(done / total, 'Building world meshes...');
        await yieldFrame();
        t = performance.now();
      }
    }
    if (onProgress) onProgress(1, 'Ready!');
  }

  // Synchronous fallback
  preloadSpawn(px, pz) {
    const pcx = Math.floor(px / CHUNK_SIZE);
    const pcz = Math.floor(pz / CHUNK_SIZE);
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.generateChunk(pcx + dx, pcz + dz);
      }
    }
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.chunks.get(this.chunkKey(pcx + dx, pcz + dz));
        if (c) this.buildChunkMesh(c);
      }
    }
  }

  getSurfaceY(wx, wz) {
    const x = Math.floor(wx);
    const z = Math.floor(wz);
    const cx = x >> 4;
    const cz = z >> 4;
    const chunk = this.chunks.get((cx + 32768) * 65536 + (cz + 32768));
    if (!chunk) return SEA_LEVEL + 4;
    const base = (x & 15) + ((z & 15) << 4);
    const topY = Math.min(CHUNK_HEIGHT - 2, chunk.maxY || SEA_LEVEL + 4);
    const data = chunk.data;
    for (let y = topY; y >= 1; y--) {
      const b = data[base + (y << 8)];
      if (b !== BLOCK.AIR && !isBlockCross(b)) return y + 1;
    }
    return SEA_LEVEL + 4;
  }

  // DDA Voxel Raycast (set hitLiquids=true when holding an empty Bucket to scoop Water/Lava!)
  raycast(origin, dir, maxDist = 5.5, hitLiquids = false) {
    let x = Math.floor(origin.x);
    let y = Math.floor(origin.y);
    let z = Math.floor(origin.z);

    const stepX = dir.x > 0 ? 1 : -1;
    const stepY = dir.y > 0 ? 1 : -1;
    const stepZ = dir.z > 0 ? 1 : -1;

    const tDeltaX = dir.x !== 0 ? Math.abs(1 / dir.x) : 1e9;
    const tDeltaY = dir.y !== 0 ? Math.abs(1 / dir.y) : 1e9;
    const tDeltaZ = dir.z !== 0 ? Math.abs(1 / dir.z) : 1e9;

    let tMaxX = dir.x !== 0 ? ((dir.x > 0 ? (x + 1 - origin.x) : (origin.x - x)) * tDeltaX) : 1e9;
    let tMaxY = dir.y !== 0 ? ((dir.y > 0 ? (y + 1 - origin.y) : (origin.y - y)) * tDeltaY) : 1e9;
    let tMaxZ = dir.z !== 0 ? ((dir.z > 0 ? (z + 1 - origin.z) : (origin.z - z)) * tDeltaZ) : 1e9;

    let nx = 0, ny = 0, nz = 0;
    let dist = 0;

    for (let i = 0; i < 64; i++) {
      const blockId = this.getBlock(x, y, z);
      if (blockId !== BLOCK.AIR && (hitLiquids || (blockId !== BLOCK.WATER && blockId !== BLOCK.LAVA))) {
        return { x, y, z, nx, ny, nz, blockId, dist };
      }

      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        dist = tMaxX;
        tMaxX += tDeltaX;
        x += stepX;
        nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        dist = tMaxY;
        tMaxY += tDeltaY;
        y += stepY;
        nx = 0; ny = -stepY; nz = 0;
      } else {
        dist = tMaxZ;
        tMaxZ += tDeltaZ;
        z += stepZ;
        nx = 0; ny = 0; nz = -stepZ;
      }
      if (dist > maxDist) break;
    }
    return null;
  }

  explode(cx, cy, cz, radius = 4.4) {
    const centerBlock = this.getBlock(cx, cy, cz);
    const inWater = centerBlock === BLOCK.WATER;
    const effRadius = inWater ? Math.max(1.2, radius * 0.32) : radius;
    const r = Math.ceil(effRadius + 0.6);
    const broken = [];
    const chainTnt = [];

    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const bx = Math.floor(cx + dx);
          const by = Math.floor(cy + dy);
          const bz = Math.floor(cz + dz);
          // Organic jagged crater rim like authentic Minecraft explosions!
          const jitter = (coordHash(bx * 7 + by, bz * 13 - by, this.seed + 911) - 0.5) * 0.85;
          if (d <= effRadius + jitter) {
            const id = this.getBlock(bx, by, bz);
            if (id === BLOCK.AIR || id === BLOCK.BEDROCK || id === BLOCK.OBSIDIAN || id === BLOCK.WATER) continue;
            if (id === BLOCK.TNT) {
              this.setBlock(bx, by, bz, BLOCK.AIR, true);
              chainTnt.push({ x: bx + 0.5, y: by + 0.5, z: bz + 0.5 });
              continue;
            }
            // Clear linked 2-block bed partner cleanly
            const bedInfo = getBedInfo(id);
            if (bedInfo) {
              const px = bx + bedInfo.dx;
              const pz = bz + bedInfo.dz;
              if (this.getBlock(px, by, pz) === bedInfo.partner) {
                this.setBlock(px, by, pz, BLOCK.AIR, true);
              }
            }
            this.setBlock(bx, by, bz, BLOCK.AIR, true);
            broken.push({ x: bx, y: by, z: bz, id });
          }
        }
      }
    }
    return { broken, chainTnt, inWater };
  }

  updateFurnaces(dt) {
    for (const f of this.furnaces.values()) {
      const outId = f.input ? SMELTING_RECIPES[f.input.id] : null;
      const canSmelt = outId && (!f.output || (f.output.id === outId && f.output.count < 64));

      if (f.burnTime > 0) {
        f.burnTime = Math.max(0, f.burnTime - dt);
      }

      if (f.burnTime <= 0 && canSmelt && f.fuel && FUEL_VALUES[f.fuel.id]) {
        f.burnMax = FUEL_VALUES[f.fuel.id];
        f.burnTime = f.burnMax;
        f.fuel.count--;
        if (f.fuel.count <= 0) f.fuel = null;
      }

      if (f.burnTime > 0 && canSmelt) {
        f.cookTime += dt;
        if (f.cookTime >= 5.0) { // 5 seconds per smelt
          f.cookTime = 0;
          f.input.count--;
          if (f.input.count <= 0) f.input = null;
          if (!f.output) f.output = { id: outId, count: 1 };
          else f.output.count++;
        }
      } else {
        f.cookTime = Math.max(0, f.cookTime - dt * 2);
      }
    }
  }

  // Returns true if (wx, wy, wz) is lit by any Torch, Glowstone, Fire, or Lava within `radius` blocks (blocks hostile spawns!)
  isPosLitByLightSource(wx, wy, wz, radius = 12) {
    const r2 = radius * radius;
    if (this.lightSources && this.lightSources.size > 0) {
      for (const src of this.lightSources.values()) {
        const dx = src.x + 0.5 - wx;
        const dy = src.y + 0.5 - wy;
        const dz = src.z + 0.5 - wz;
        if (dx * dx + dy * dy + dz * dz <= r2) return true;
      }
    }
    if (this.activeFires && this.activeFires.size > 0) {
      for (const f of this.activeFires.values()) {
        const dx = f.x + 0.5 - wx;
        const dy = f.y + 0.5 - wy;
        const dz = f.z + 0.5 - wz;
        if (dx * dx + dy * dy + dz * dz <= r2) return true;
      }
    }
    return false;
  }

  // Update pooled real-time PointLights for the closest placed/generated Torches & Glowstone (brighter towns, castles & pyramids!)
  updateTorchLights(dt, playerPos, sky = null) {
    if (!this.torchLightPool || this.torchLightPool.length === 0 || !playerPos) return;
    this._lightClock += dt;
    this._lightRefreshTimer -= dt;

    if (this._lightDirty || this._lightRefreshTimer <= 0) {
      this._lightDirty = false;
      this._lightRefreshTimer = 0.16;

      const maxDistSq = 68 * 68;
      const near = [];
      for (const src of this.lightSources.values()) {
        const dx = src.x + 0.5 - playerPos.x;
        const dy = src.y + 0.8 - playerPos.y;
        const dz = src.z + 0.5 - playerPos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= maxDistSq) near.push({ src, d2 });
      }
      near.sort((a, b) => a.d2 - b.d2);
      const count = Math.min(this.torchLightPool.length, near.length);
      this._activeLightSources.length = count;
      for (let i = 0; i < count; i++) {
        this._activeLightSources[i] = near[i].src;
      }
    }

    const dayFactor = sky && sky.skyUniforms ? sky.skyUniforms.uDayFactor.value : 0.5;
    const nightFactor = Math.max(0, Math.min(1, 1.0 - dayFactor));
    const t = this._lightClock;
    const activeCount = this._activeLightSources.length;

    for (let i = 0; i < this.torchLightPool.length; i++) {
      const pl = this.torchLightPool[i];
      const dlPos = this._dynLightPos[i];
      const dlCol = this._dynLightCol[i];
      if (i < activeCount) {
        const s = this._activeLightSources[i];
        const lx = s.x + 0.5, ly = s.y + (s.isGlowstone ? 0.6 : 1.18), lz = s.z + 0.5;
        pl.position.set(lx, ly, lz);
        const phase = s.x * 1.7 + s.z * 2.3 + s.y * 0.9;
        const flicker = s.isGlowstone
          ? Math.sin(t * 3.5 + phase) * 0.25
          : Math.sin(t * 8.5 + phase) * 0.55 + Math.cos(t * 15.2 + phase * 1.3) * 0.28;
        const baseIntensity = s.isGlowstone
          ? (13.5 + nightFactor * 20.5)
          : (12.0 + nightFactor * 19.0);
        const inten = Math.max(1.5, baseIntensity + flicker);
        const range = 48 + nightFactor * 18;
        pl.intensity = inten;
        pl.distance = range;
        pl.color.setHex(s.isGlowstone ? 0xffd584 : 0xffb64e);
        if (dlPos && dlCol) {
          dlPos.set(lx, ly, lz, range * 0.65);
          dlCol.set(pl.color.r, pl.color.g, pl.color.b, inten * 0.48);
        }
      } else {
        pl.intensity = 0;
        if (dlPos && dlCol) {
          dlPos.set(0, -9999, 0, 1);
          dlCol.set(0, 0, 0, 0);
        }
      }
    }
  }

  // --- WOOD DOOR HELPERS (2-block-tall open/close state keyed on bottom half!) ---
  getDoorState(wx, wy, wz) {
    const x = Math.floor(wx), y = Math.floor(wy), z = Math.floor(wz);
    const id = this.getBlock(x, y, z);
    const by = isDoorTop(id) ? y - 1 : y;
    const st = this.doorStates.get(`${x},${by},${z}`);
    return st || { facing: 0, open: false };
  }

  isDoorOpenAt(wx, wy, wz) {
    const x = Math.floor(wx), y = Math.floor(wy), z = Math.floor(wz);
    const id = this.getBlock(x, y, z);
    if (!isDoorBlock(id)) return false;
    const by = isDoorTop(id) ? y - 1 : y;
    const st = this.doorStates.get(`${x},${by},${z}`);
    return !!(st && st.open);
  }

  placeDoor(wx, wy, wz, bottomBlockId, facing = 0) {
    const x = Math.floor(wx), y = Math.floor(wy), z = Math.floor(wz);
    this.doorStates.set(`${x},${y},${z}`, { facing: facing & 3, open: false });
    this.setBlock(x, y, z, bottomBlockId, true);
    this.setBlock(x, y + 1, z, bottomBlockId + 1, true);
  }

  toggleDoor(wx, wy, wz) {
    const x = Math.floor(wx), y = Math.floor(wy), z = Math.floor(wz);
    const id = this.getBlock(x, y, z);
    if (!isDoorBlock(id)) return false;
    const by = isDoorTop(id) ? y - 1 : y;
    const key = `${x},${by},${z}`;
    let st = this.doorStates.get(key);
    if (!st) {
      st = { facing: 0, open: false };
      this.doorStates.set(key, st);
    }
    st.open = !st.open;
    const cx = x >> 4, cz = z >> 4;
    this.markDirty(cx, cz);
    const lx = x & 15, lz = z & 15;
    if (lx === 0) this.markDirty(cx - 1, cz);
    if (lx === 15) this.markDirty(cx + 1, cz);
    if (lz === 0) this.markDirty(cx, cz - 1);
    if (lz === 15) this.markDirty(cx, cz + 1);
    return st.open;
  }

  // --- FENCE GATE & WALL-MOUNTED LADDER HELPERS ---
  getFenceGateState(wx, wy, wz) {
    const x = Math.floor(wx), y = Math.floor(wy), z = Math.floor(wz);
    const st = this.gateStates.get(`${x},${y},${z}`);
    if (st) return st;
    // Auto-orient world-generated fence gates to align cleanly with adjacent fences!
    const fE = isFenceOrGate(this.getBlock(x + 1, y, z));
    const fW = isFenceOrGate(this.getBlock(x - 1, y, z));
    const fN = isFenceOrGate(this.getBlock(x, y, z - 1));
    const fS = isFenceOrGate(this.getBlock(x, y, z + 1));
    return { facing: (fN || fS) && !(fE || fW) ? 1 : 0, open: false };
  }

  isFenceGateOpenAt(wx, wy, wz) {
    const x = Math.floor(wx), y = Math.floor(wy), z = Math.floor(wz);
    const st = this.gateStates.get(`${x},${y},${z}`);
    return !!(st && st.open);
  }

  placeFenceGate(wx, wy, wz, blockId, facing = 0) {
    const x = Math.floor(wx), y = Math.floor(wy), z = Math.floor(wz);
    this.gateStates.set(`${x},${y},${z}`, { facing: facing & 3, open: false });
    this.setBlock(x, y, z, blockId, true);
  }

  toggleFenceGate(wx, wy, wz, playerYaw = 0) {
    const x = Math.floor(wx), y = Math.floor(wy), z = Math.floor(wz);
    const id = this.getBlock(x, y, z);
    if (!isFenceGateBlock(id)) return false;
    const key = `${x},${y},${z}`;
    let st = this.gateStates.get(key);
    if (!st) {
      st = this.getFenceGateState(x, y, z);
      this.gateStates.set(key, st);
    }
    st.open = !st.open;
    // Swing open AWAY from the player just like real Minecraft!
    if (st.open) {
      const fx = -Math.sin(playerYaw);
      const fz = -Math.cos(playerYaw);
      if (st.facing === 0 || st.facing === 2) st.facing = fz >= 0 ? 2 : 0;
      else st.facing = fx >= 0 ? 1 : 3;
    }
    const cx = x >> 4, cz = z >> 4;
    this.markDirty(cx, cz);
    const lx = x & 15, lz = z & 15;
    if (lx === 0) this.markDirty(cx - 1, cz);
    if (lx === 15) this.markDirty(cx + 1, cz);
    if (lz === 0) this.markDirty(cx, cz - 1);
    if (lz === 15) this.markDirty(cx, cz + 1);
    return st.open;
  }

  placeLadder(wx, wy, wz, nx = 0, ny = 0, nz = 0) {
    const x = Math.floor(wx), y = Math.floor(wy), z = Math.floor(wz);
    // Attach to the exact solid wall face clicked (0=-Z wall, 1=+X wall, 2=+Z wall, 3=-X wall)
    let facing = -1;
    if (nz === 1) facing = 0;       // clicked +Z face of wall at z-1 -> mounts to -Z wall
    else if (nx === -1) facing = 1; // clicked -X face of wall at x+1 -> mounts to +X wall
    else if (nz === -1) facing = 2; // clicked -Z face of wall at z+1 -> mounts to +Z wall
    else if (nx === 1) facing = 3;  // clicked +X face of wall at x-1 -> mounts to -X wall
    if (facing < 0) facing = this.getLadderFacing(x, y, z);
    this.ladderStates.set(`${x},${y},${z}`, facing);
    this.setBlock(x, y, z, BLOCK.LADDER, true);
  }

  getLadderFacing(wx, wy, wz, fastGet = null, lx = 0, lz = 0) {
    const x = Math.floor(wx), y = Math.floor(wy), z = Math.floor(wz);
    const saved = this.ladderStates.get(`${x},${y},${z}`);
    if (saved !== undefined) return saved;
    const isWall = (bid) => bid !== 0 && bid !== BLOCK.LADDER && this._solidTable[bid] === 1 && !isFenceOrGate(bid);
    const getB = (dx, dz) => fastGet ? fastGet(lx + dx, y, lz + dz) : this.getBlock(x + dx, y, z + dz);
    if (isWall(getB(0, -1))) return 0; // -Z North wall
    if (isWall(getB(1, 0))) return 1;  // +X East wall
    if (isWall(getB(0, 1))) return 2;  // +Z South wall
    if (isWall(getB(-1, 0))) return 3; // -X West wall
    return 0;
  }

  dispose() {
    for (const chunk of this.chunks.values()) {
      for (const m of chunk.meshes) {
        this.group.remove(m);
        m.geometry.dispose();
      }
    }
    this.chunks.clear();
    for (const rec of this.lodRegions.values()) {
      this.lodGroup.remove(rec.mesh);
      rec.mesh.geometry.dispose();
    }
    this.lodRegions.clear();
    this._lodRetiringKeys.clear();
    this._lodActiveKeys.clear();
    this._lodInnerKeys.clear();
    this._lodQueue.length = 0;
    if (this._lodPool) {
      this._lodPool.dispose();
      this._lodPool = null;
    }
    this.lightSources.clear();
    this._activeLightSources = [];
    this.leafDecayQueue.clear();
    this.persistentLeaves.clear();
    this.activeFires.clear();
    this.fluidLevels.clear();
    this.fluidQueue.clear();
    this.activeCrops.clear();
    this.activeFarmlands.clear();
    this._roadRegionCache.clear();
    this._megaChunkCache.clear();
    this._villageChunkCache.clear();
    this.doorStates.clear();
    this.gateStates.clear();
    this.ladderStates.clear();
    this.megaStructures.clear();
    this.scene.remove(this.group);
    this.scene.remove(this.lodGroup);
  }
}
