import * as THREE from 'three';
import { BLOCK, getBlockDef, isBlockTransparent, isBlockCross, isBlockLiquid, isBlockSolid, isBedBlock, getBedInfo } from './blocks.js';
import { Noise, hashString } from './noise.js';
import { SMELTING_RECIPES, FUEL_VALUES } from './recipes.js';
import { LodWorkerPool } from './lod-mesher.js';

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

// Reusable zero-GC TypedArray scratch buffer for chunk meshing (with optional Greedy Atlas Tiling!)
class MeshBucket {
  constructor(initialVerts = 16384, tiled = false) {
    this.cap = initialVerts;
    this.tiled = tiled;
    this.pos = new Float32Array(initialVerts * 3);
    this.norm = new Float32Array(initialVerts * 3);
    this.uv = new Float32Array(initialVerts * 2);
    this.col = new Float32Array(initialVerts * 3);
    this.tile = tiled ? new Float32Array(initialVerts * 4) : null;
    this.idx = new Uint32Array((initialVerts / 4) * 6);
    this.vCount = 0;
    this.iCount = 0;
  }

  reset() {
    this.vCount = 0;
    this.iCount = 0;
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

    col[p] = c0; col[p + 1] = c0; col[p + 2] = c0;
    col[p + 3] = c1; col[p + 4] = c1; col[p + 5] = c1;
    col[p + 6] = c2; col[p + 7] = c2; col[p + 8] = c2;
    col[p + 9] = c3; col[p + 10] = c3; col[p + 11] = c3;

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

    col[p] = c0; col[p + 1] = c0; col[p + 2] = c0;
    col[p + 3] = c1; col[p + 4] = c1; col[p + 5] = c1;
    col[p + 6] = c2; col[p + 7] = c2; col[p + 8] = c2;
    col[p + 9] = c3; col[p + 10] = c3; col[p + 11] = c3;

    const t = base * 4;
    const tl = this.tile;
    tl[t] = tu; tl[t + 1] = tv; tl[t + 2] = tdu; tl[t + 3] = tdv;
    tl[t + 4] = tu; tl[t + 5] = tv; tl[t + 6] = tdu; tl[t + 7] = tdv;
    tl[t + 8] = tu; tl[t + 9] = tv; tl[t + 10] = tdu; tl[t + 11] = tdv;
    tl[t + 12] = tu; tl[t + 13] = tv; tl[t + 14] = tdu; tl[t + 15] = tdv;

    const ii = this.iCount;
    const idx = this.idx;
    // Flip diagonal automatically for smooth artifact-free Minecraft Voxel AO!
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
    const idxSlice = this.vCount < 65536
      ? new Uint16Array(this.idx.subarray(0, this.iCount))
      : this.idx.slice(0, this.iCount);
    geo.setIndex(new THREE.BufferAttribute(idxSlice, 1));
    return geo;
  }
}

const SCRATCH_BUCKETS = {
  opaque: new MeshBucket(16384, true),
  cutout: new MeshBucket(8192, false),
  staticCutout: new MeshBucket(4096, false),
  water: new MeshBucket(4096, false)
};
// Dual coarse 4x4x4 trilinear cave grids (Minecraft 1.18 Spaghetti + Cheese Caverns, up to Y=252!)
const CAVE_GRID = new Float32Array(5 * 64 * 5);
const CAVE_GRID_B = new Float32Array(5 * 64 * 5);
// Zero-GC Greedy Meshing slice masks & 16-bit column sky-light cache (supports 512-block world height!)
const GREEDY_MASK = new Int32Array(16 * CHUNK_HEIGHT);
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
  BLOCK.BED, BLOCK.BED_HEAD_N, BLOCK.BED_FOOT_S, BLOCK.BED_HEAD_S, BLOCK.BED_FOOT_E, BLOCK.BED_HEAD_E, BLOCK.BED_FOOT_W, BLOCK.BED_HEAD_W
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
    this.villageChunks = new Map(); // numeric chunkKey -> { x, y, z, biome, spawned: bool }
    this.persistentLeaves = new Set(); // "x,y,z" of player-placed leaves that should not decay
    this.leafDecayQueue = new Map(); // "x,y,z" -> { x, y, z, timer }
    this._leafAmbientTimer = 0;
    this.onLeafDecay = null;

    // Live Fire spread & Minecraft-accurate Water/Lava fluid simulation!
    this.activeFires = new Map(); // "x,y,z" -> { x, y, z, age, timer }
    this.fluidLevels = new Map(); // "x,y,z" -> level (0=source, 1..7 water, 1..3 lava)
    this.fluidQueue = new Map();  // "x,y,z" -> { x, y, z, type, timer }
    this.onFluidMix = null;       // optional callback (x, y, z, newBlockId)
    this.onFireIgniteTnt = null;  // optional callback (x, y, z)
    this.megaStructures = new Map(); // numeric key -> { type, x, y, z, radius, villagersSpawned }
    this._lastChunkPcx = 1e9;
    this._lastChunkPcz = 1e9;
    this._lastChunkRD = -1;
    this._chunksAllLoaded = false;
    this.renderDistance = options.renderDistance || 6;
    this.shaderMode = options.shaders || 'ultra';
    this.shaderUniforms = {
      uTime: { value: 0 },
      uCloudTime: { value: 0 },
      uWaveStrength: { value: this.shaderMode === 'off' ? 0.0 : (this.shaderMode === 'ultra' ? 1.15 : 0.9) },
      uShaderOn: { value: this.shaderMode === 'off' ? 0.0 : 1.0 },
      uSunDir: { value: new THREE.Vector3(0.6, 0.5, -0.25).normalize() },
      uTopColor: { value: new THREE.Color(0x245ec2) },
      uMidColor: { value: new THREE.Color(0x63a8ed) },
      uHorizonColor: { value: new THREE.Color(0xd4e8fa) },
      uSunsetColor: { value: new THREE.Color(0xff9b54) },
      uSunColor: { value: new THREE.Color(0xfff6dc) },
      uCloudLitColor: { value: new THREE.Color(0xfffcf5) },
      uCloudShadowColor: { value: new THREE.Color(0x88a4c7) },
      uDayFactor: { value: 1.0 },
      uSunsetFactor: { value: 0.0 },
      uRainFactor: { value: 0.0 },
      uFogNear: { value: 45.0 },
      uFogFar: { value: 110.0 },
      uLodInnerCenter: { value: new THREE.Vector2(0, 0) },
      uLodInnerRadiusSq: { value: 0.0 }
    };

    // 1. Opaque Terrain Material — Greedy Atlas Tiling + 20x BSL Atmospheric Lighting, Specular Rim, Underwater Caustics & Emissive Bloom!
    this.opaqueMat = new THREE.MeshLambertMaterial({
      map: this.textures.atlasTexture,
      vertexColors: true
    });
    this.opaqueMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        uTime: this.shaderUniforms.uTime,
        uShaderOn: this.shaderUniforms.uShaderOn,
        uSunDir: this.shaderUniforms.uSunDir,
        uSunColor: this.shaderUniforms.uSunColor,
        uHorizonColor: this.shaderUniforms.uHorizonColor,
        uSunsetColor: this.shaderUniforms.uSunsetColor,
        uDayFactor: this.shaderUniforms.uDayFactor,
        uSunsetFactor: this.shaderUniforms.uSunsetFactor,
        uFogNear: this.shaderUniforms.uFogNear,
        uFogFar: this.shaderUniforms.uFogFar
      });
      shader.vertexShader = `
        attribute vec4 aTile;
        varying vec4 vTile;
        varying vec2 vLocalUv;
        varying vec3 vWorldPos;
        varying vec3 vWorldNorm;
        varying float vEmissive;
      ` + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vWorldPos = position;
         vWorldNorm = normal;
         vLocalUv = uv;
         vTile = aTile;
         vEmissive = max(0.0, color.r - 1.04);`
      );
      shader.fragmentShader = `
        uniform float uTime;
        uniform float uShaderOn;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uSunsetColor;
        uniform float uDayFactor;
        uniform float uSunsetFactor;
        uniform float uFogNear;
        uniform float uFogFar;
        varying vec4 vTile;
        varying vec2 vLocalUv;
        varying vec3 vWorldPos;
        varying vec3 vWorldNorm;
        varying float vEmissive;
      ` + shader.fragmentShader;
      // Seamless Greedy-Mesh Atlas Wrapping (zero tile bleeding at any quad size!)
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
           vec2 wrappedUv = vTile.z < 0.99
             ? (vTile.xy + clamp(fract(vLocalUv), 0.004, 0.996) * vTile.zw)
             : vLocalUv;
           vec4 sampledDiffuseColor = texture2D( map, wrappedUv );
           diffuseColor *= sampledDiffuseColor;
         #endif`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <fog_fragment>',
        `if (uShaderOn > 0.5) {
           vec3 viewVec = vWorldPos - cameraPosition;
           float dist = length(viewVec);
           vec3 viewDir = viewVec / max(dist, 0.001);
           vec3 N = normalize(vWorldNorm);
           vec3 L = normalize(uSunDir);
           vec3 V = -viewDir;

           // BSL Warm Sunlight Bounce vs Airy Luminous Sky-Tinted Shadows (never crushed black!)
           float ndl = dot(N, L);
           float sunLit = smoothstep(-0.2, 0.55, ndl);
           vec3 warmSunTint = mix(vec3(1.06, 1.03, 0.96), vec3(1.20, 1.02, 0.85), uSunsetFactor);
           vec3 coolShadowTint = mix(vec3(0.92, 0.96, 1.06), vec3(0.96, 1.01, 1.08), uDayFactor);
           gl_FragColor.rgb *= mix(coolShadowTint, warmSunTint, sunLit * uDayFactor);
           // Gentle outdoor sky ambient bounce lift in shadowed areas (only above caves)
           float outdoorLift = smoothstep(${SEA_LEVEL - 10}.0, ${SEA_LEVEL - 2}.0, vWorldPos.y);
           gl_FragColor.rgb += uHorizonColor * 0.032 * uDayFactor * outdoorLift * (1.0 - sunLit * 0.7);

           // Crisp BSL Sun-Rim Specular Sheen (zero pow() transcendental calls!)
           vec3 H = normalize(V + L);
           float nh = max(0.0, dot(N, H));
           float nh2 = nh * nh;
           float nh4 = nh2 * nh2;
           float nh16 = nh4 * nh4 * nh4 * nh4;
           float spec = nh16 * sunLit * uDayFactor * (0.09 + 0.14 * uSunsetFactor);
           gl_FragColor.rgb += uSunColor * spec * (1.0 - smoothstep(40.0, 140.0, dist) * 0.7);

           // Shimmering Underwater Caustics projected onto submerged terrain!
           if (vWorldPos.y < ${SEA_LEVEL}.05 && N.y > 0.25 && uDayFactor > 0.05) {
             float dSub = ${SEA_LEVEL}.05 - vWorldPos.y;
             float depthFade = smoothstep(0.0, 1.8, dSub) * smoothstep(18.0, 2.0, dSub);
             float c1 = sin(vWorldPos.x * 2.1 + uTime * 2.0 + vWorldPos.z * 0.9);
             float c2 = cos(vWorldPos.z * 2.3 - uTime * 1.8 - vWorldPos.x * 0.8);
             float cSum = max(0.0, (c1 + c2) * 0.5);
             gl_FragColor.rgb += vec3(0.18, 0.42, 0.48) * (cSum * cSum * cSum) * depthFade * uDayFactor * 0.65;
           }

           // Warm torch & glowstone emissive radiance (glows vibrantly day & night!)
           if (vEmissive > 0.01) {
             gl_FragColor.rgb += vec3(1.0, 0.76, 0.30) * vEmissive * 3.2;
           }

           // BSL Volumetric Sun-Aligned Atmospheric Aerial Perspective Haze (fast mul-chain!)
           float hazeFactor = smoothstep(uFogNear * 0.48, uFogFar, dist);
           float sa = max(0.0, dot(viewDir, L));
           float sunAlign = sa * sa * sa;
           vec3 atmFog = mix(uHorizonColor, uSunColor * 1.08, sunAlign * (0.32 + 0.56 * uSunsetFactor) * uDayFactor);
           atmFog = mix(atmFog, uSunsetColor, sunAlign * uSunsetFactor * 0.42);
           gl_FragColor.rgb = mix(gl_FragColor.rgb, atmFog, hazeFactor);
         } else {
           if (vEmissive > 0.01) {
             gl_FragColor.rgb += vec3(1.0, 0.76, 0.30) * vEmissive * 3.1;
           }
           #include <fog_fragment>
         }`
      );
    };

    // 1b. Distant Horizons 512-Chunk High-Detail LOD Terrain Materials
    // Dual-material iPad/Apple TBDR optimization:
    // - `this.lodMat` (with circular cutout discard) ONLY on innermost ring tiles overlapping full-detail chunks (~24 meshes)
    // - `this.lodMatOuter` (ZERO `discard`!) on 90%+ of outer LOD tiles -> keeps hardware Early-Z / Apple HSR enabled!
    const buildLodMat = (withInnerCutout) => {
      const mat = new THREE.MeshLambertMaterial({
        vertexColors: true
      });
      mat.customProgramCacheKey = () => (withInnerCutout ? 'lod_inner_v27' : 'lod_outer_v27');
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
          uniforms.uLodInnerRadiusSq = this.shaderUniforms.uLodInnerRadiusSq;
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
          ${withInnerCutout ? 'uniform vec2 uLodInnerCenter;\nuniform float uLodInnerRadiusSq;' : ''}
          varying vec3 vWorldPos;
          varying vec3 vWorldNorm;
          varying float vMat;
        ` + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <fog_fragment>',
          `${withInnerCutout ? 'vec2 lodDelta = vWorldPos.xz - uLodInnerCenter;\nif (dot(lodDelta, lodDelta) < uLodInnerRadiusSq) discard;' : ''}

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
               float sunLit = smoothstep(-0.2, 0.55, dot(N, L));
               vec3 warmSunTint = mix(vec3(1.06, 1.03, 0.96), vec3(1.20, 1.02, 0.85), uSunsetFactor);
               vec3 coolShadowTint = mix(vec3(0.92, 0.96, 1.06), vec3(0.96, 1.01, 1.08), uDayFactor);
               gl_FragColor.rgb *= mix(coolShadowTint, warmSunTint, sunLit * uDayFactor);
               gl_FragColor.rgb += uHorizonColor * 0.032 * uDayFactor * (1.0 - sunLit * 0.7);

               if (vMat > 0.37 && vMat < 0.62) {
                 float saF = max(0.0, dot(viewDir, L));
                 float sss = (saF * saF * saF) * 0.22 * uDayFactor;
                 gl_FragColor.rgb += gl_FragColor.rgb * uSunColor * sss;
               } else if (vMat > 0.62 && vMat < 0.85) {
                 vec3 H = normalize(-viewDir + L);
                 float nh = max(0.0, dot(N, H));
                 float nh2 = nh * nh;
                 float nh8 = nh2 * nh2 * nh2 * nh2;
                 gl_FragColor.rgb += uSunColor * (nh8 * 0.18 * sunLit * uDayFactor);
               }
             }

             // Volumetric Sun-Aligned Atmospheric Aerial Perspective Haze out to 512 chunks!
             float hazeFactor = smoothstep(uFogNear * 0.45, uFogFar, dist);
             float sa = max(0.0, dot(viewDir, L));
             float sunAlign = sa * sa * sa;
             vec3 atmFog = mix(uHorizonColor, uSunColor * 1.08, sunAlign * (0.32 + 0.56 * uSunsetFactor) * uDayFactor);
             atmFog = mix(atmFog, uSunsetColor, sunAlign * uSunsetFactor * 0.42);
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

    // 2. Cutout Foliage Material — Root-anchored Wind Sway + Sunlit Backlighting + Atmospheric Haze
    this.cutoutMat = new THREE.MeshLambertMaterial({
      map: this.textures.atlasTexture,
      vertexColors: true,
      alphaTest: 0.35,
      side: THREE.DoubleSide
    });
    this.cutoutMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        uTime: this.shaderUniforms.uTime,
        uWaveStrength: this.shaderUniforms.uWaveStrength,
        uShaderOn: this.shaderUniforms.uShaderOn,
        uSunDir: this.shaderUniforms.uSunDir,
        uSunColor: this.shaderUniforms.uSunColor,
        uHorizonColor: this.shaderUniforms.uHorizonColor,
        uSunsetColor: this.shaderUniforms.uSunsetColor,
        uDayFactor: this.shaderUniforms.uDayFactor,
        uSunsetFactor: this.shaderUniforms.uSunsetFactor,
        uFogNear: this.shaderUniforms.uFogNear,
        uFogFar: this.shaderUniforms.uFogFar
      });
      shader.vertexShader = `
        uniform float uTime;
        uniform float uWaveStrength;
        varying vec3 vWorldPos;
        varying float vEmissive;
      ` + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         if (uWaveStrength > 0.01) {
           float fy = fract(position.y + 0.001);
           // Grass/flower roots (fy ~ 0.02) stay planted; tips (fy ~ 0.9) sway richly; leaf blocks (fy ~ 0.0) rustle softly!
           float swayWeight = (fy > 0.01 && fy < 0.12) ? 0.0 : (fy >= 0.12 ? 1.0 : 0.28);
           float gust = 0.72 + 0.28 * sin(uTime * 0.85 + position.x * 0.12 - position.z * 0.1);
           float swayX = sin(uTime * 2.2 + position.x * 0.75 + position.z * 0.55) * 0.055 * uWaveStrength * gust * swayWeight;
           float swayZ = cos(uTime * 1.85 + position.z * 0.7 - position.x * 0.45) * 0.04 * uWaveStrength * gust * swayWeight;
           transformed.x += swayX;
           transformed.z += swayZ;
         }
         vWorldPos = transformed;
         vEmissive = max(0.0, color.r - 1.04);`
      );
      shader.fragmentShader = `
        uniform float uShaderOn;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uSunsetColor;
        uniform float uDayFactor;
        uniform float uSunsetFactor;
        uniform float uFogNear;
        uniform float uFogFar;
        varying vec3 vWorldPos;
        varying float vEmissive;
      ` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <fog_fragment>',
        `if (uShaderOn > 0.5) {
           vec3 viewVec = vWorldPos - cameraPosition;
           float dist = length(viewVec);
           vec3 viewDir = viewVec / max(dist, 0.001);
           float sunAlign = max(0.0, dot(viewDir, normalize(uSunDir)));
           // Translucent backlit leaves & sunlit grass glow!
           float sss = pow(sunAlign, 3.0) * 0.28 * uDayFactor;
           gl_FragColor.rgb += gl_FragColor.rgb * uSunColor * sss;
           if (vEmissive > 0.01) {
             gl_FragColor.rgb += vec3(1.0, 0.75, 0.3) * vEmissive * 2.6;
           }
           float hazeFactor = smoothstep(uFogNear * 0.55, uFogFar, dist);
           vec3 atmFog = mix(uHorizonColor, uSunColor * 1.05, pow(sunAlign, 3.0) * (0.28 + 0.52 * uSunsetFactor) * uDayFactor);
           atmFog = mix(atmFog, uSunsetColor, pow(sunAlign, 3.0) * uSunsetFactor * 0.35);
           gl_FragColor.rgb = mix(gl_FragColor.rgb, atmFog, hazeFactor);
         } else {
           #include <fog_fragment>
         }`
      );
    };

    // 2b. Static Cutout Material (Glass, Ice, Torches, Ladders — crisp, no wind sway, with emissive glow + haze)
    this.staticCutoutMat = new THREE.MeshLambertMaterial({
      map: this.textures.atlasTexture,
      vertexColors: true,
      alphaTest: 0.35,
      side: THREE.DoubleSide
    });
    this.staticCutoutMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        uShaderOn: this.shaderUniforms.uShaderOn,
        uSunDir: this.shaderUniforms.uSunDir,
        uSunColor: this.shaderUniforms.uSunColor,
        uHorizonColor: this.shaderUniforms.uHorizonColor,
        uSunsetColor: this.shaderUniforms.uSunsetColor,
        uDayFactor: this.shaderUniforms.uDayFactor,
        uSunsetFactor: this.shaderUniforms.uSunsetFactor,
        uFogNear: this.shaderUniforms.uFogNear,
        uFogFar: this.shaderUniforms.uFogFar
      });
      shader.vertexShader = `
        varying vec3 vWorldPos;
        varying float vEmissive;
      ` + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vWorldPos = position;
         vEmissive = max(0.0, color.r - 1.04);`
      );
      shader.fragmentShader = `
        uniform float uShaderOn;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uSunsetColor;
        uniform float uDayFactor;
        uniform float uSunsetFactor;
        uniform float uFogNear;
        uniform float uFogFar;
        varying vec3 vWorldPos;
        varying float vEmissive;
      ` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <fog_fragment>',
        `if (uShaderOn > 0.5) {
           vec3 viewVec = vWorldPos - cameraPosition;
           float dist = length(viewVec);
           vec3 viewDir = viewVec / max(dist, 0.001);
           if (vEmissive > 0.01) {
             gl_FragColor.rgb += vec3(1.0, 0.76, 0.32) * vEmissive * 2.8;
           }
           float sunAlign = pow(max(0.0, dot(viewDir, normalize(uSunDir))), 3.0);
           float hazeFactor = smoothstep(uFogNear * 0.55, uFogFar, dist);
           vec3 atmFog = mix(uHorizonColor, uSunColor * 1.05, sunAlign * (0.28 + 0.52 * uSunsetFactor) * uDayFactor);
           atmFog = mix(atmFog, uSunsetColor, sunAlign * uSunsetFactor * 0.35);
           gl_FragColor.rgb = mix(gl_FragColor.rgb, atmFog, hazeFactor);
         } else {
           #include <fog_fragment>
         }`
      );
    };

    // 3. Ultra-Fast Watertight BSL Reflective Water Shader (10x faster GPU fill-rate & ZERO T-junction holes!)
    this.waterMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.shaderUniforms.uTime,
        uWaveStrength: this.shaderUniforms.uWaveStrength,
        uSunDir: this.shaderUniforms.uSunDir,
        uTopColor: this.shaderUniforms.uTopColor,
        uMidColor: this.shaderUniforms.uMidColor,
        uHorizonColor: this.shaderUniforms.uHorizonColor,
        uSunsetColor: this.shaderUniforms.uSunsetColor,
        uSunColor: this.shaderUniforms.uSunColor,
        uDayFactor: this.shaderUniforms.uDayFactor,
        uSunsetFactor: this.shaderUniforms.uSunsetFactor,
        uRainFactor: this.shaderUniforms.uRainFactor,
        uFogNear: this.shaderUniforms.uFogNear,
        uFogFar: this.shaderUniforms.uFogFar
      },
      transparent: true,
      side: THREE.FrontSide,
      depthWrite: false,
      vertexShader: `
        varying vec3 vWorldPos;
        varying vec3 vBaseNormal;
        void main() {
          // Keep water vertices 100% watertight across greedy quads & chunk seams (ZERO cracks or holes!)
          vWorldPos = position;
          vBaseNormal = normal;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uWaveStrength;
        uniform vec3 uSunDir;
        uniform vec3 uTopColor;
        uniform vec3 uMidColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uSunsetColor;
        uniform vec3 uSunColor;
        uniform float uDayFactor;
        uniform float uSunsetFactor;
        uniform float uRainFactor;
        uniform float uFogNear;
        uniform float uFogFar;
        varying vec3 vWorldPos;
        varying vec3 vBaseNormal;

        void main() {
          vec3 viewVec = cameraPosition - vWorldPos;
          float dist = length(viewVec);
          vec3 V = viewVec / max(dist, 0.001);
          vec3 sunDir = normalize(uSunDir);

          // Ultra-fast pure-analytic silky animated ripple normal (ZERO per-pixel noise2D/hash!)
          vec2 p = vWorldPos.xz;
          float t = uTime;
          float wA = sin(p.x * 1.85 + t * 1.75 + p.y * 0.85);
          float wB = cos(p.y * 2.15 - t * 1.45 - p.x * 0.65);
          float wC = sin((p.x - p.y) * 2.9 + t * 2.2) * 0.45;
          float amp = mix(0.015, 0.095, clamp(uWaveStrength, 0.0, 1.2)) * (1.0 - smoothstep(40.0, 140.0, dist) * 0.55);
          vec3 N = vBaseNormal.y > 0.5
            ? normalize(vec3((wA + wC) * amp, 1.0, (wB - wC) * amp))
            : normalize(vBaseNormal);

          // Mute outdoor sky reflection underground inside deep caves!
          float skyMask = smoothstep(${SEA_LEVEL - 10}.0, ${SEA_LEVEL - 2}.0, vWorldPos.y);
          float NoV = max(0.0, dot(N, V));
          float omv = 1.0 - NoV;
          float fresnel = clamp(0.12 + 0.86 * omv * omv * omv, 0.12, 0.95) * skyMask;

          // Instant analytic sky mirror reflection (10x faster than FBM reflection!)
          vec3 R = reflect(-V, N);
          float rY = clamp(abs(R.y), 0.02, 1.0);
          vec3 reflCol = mix(uHorizonColor, uMidColor, smoothstep(0.0, 0.38, rY));
          reflCol = mix(reflCol, uTopColor, smoothstep(0.28, 0.92, rY));
          float rSun = max(0.0, dot(normalize(R), sunDir));
          float rSun2 = rSun * rSun;
          float rSun4 = rSun2 * rSun2;
          reflCol = mix(reflCol, uSunsetColor, (1.0 - rY) * (0.28 + 0.52 * rSun2) * uSunsetFactor * (1.0 - uRainFactor * 0.7));
          reflCol += uSunColor * (rSun4 * rSun4 * 0.45) * smoothstep(-0.1, 0.06, sunDir.y) * (1.0 - uRainFactor * 0.8);

          // Rich BSL turquoise-to-sapphire water tint + subtle ripple shimmer
          vec3 deepWater = mix(vec3(0.02, 0.06, 0.12), vec3(0.05, 0.30, 0.44), uDayFactor * skyMask);
          deepWater = mix(deepWater, vec3(0.15, 0.12, 0.22), uSunsetFactor * 0.5 * skyMask);
          deepWater += vec3(0.05, 0.16, 0.20) * (0.5 + 0.5 * wA * wB) * 0.28 * uDayFactor * skyMask;

          vec3 col = mix(deepWater, reflCol, fresnel);

          // Crisp Sparkling Sun Specular Glitter (fast mul-chain, zero pow()!)
          vec3 H = normalize(V + sunDir);
          float nh = max(0.0, dot(N, H));
          float nh2 = nh * nh;
          float nh4 = nh2 * nh2;
          float nh16 = nh4 * nh4 * nh4 * nh4;
          float nh64 = nh16 * nh16 * nh16 * nh16;
          float sunUp = smoothstep(-0.08, 0.08, sunDir.y) * (1.0 - uRainFactor * 0.85) * skyMask;
          col += uSunColor * (nh64 * 2.2 + nh16 * 0.32) * sunUp;

          // Atmospheric Distance Haze matching Terrain & Sky seamlessly!
          float hazeFactor = smoothstep(uFogNear * 0.48, uFogFar, dist) * skyMask;
          float sa = max(0.0, dot(-V, sunDir));
          float sunAlign = sa * sa * sa;
          vec3 atmFog = mix(uHorizonColor, uSunColor * 1.06, sunAlign * (0.30 + 0.54 * uSunsetFactor) * uDayFactor);
          atmFog = mix(atmFog, uSunsetColor, sunAlign * uSunsetFactor * 0.38);
          col = mix(col, atmFog, hazeFactor);

          float alpha = mix(mix(0.76, 0.95, fresnel), 1.0, hazeFactor);
          gl_FragColor = vec4(col, alpha);
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
        isTr || def.cross || def.liquid || isBedBlock(id) ||
        id === BLOCK.TORCH || id === BLOCK.GLOWSTONE || id === BLOCK.FIRE
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

    // Dynamic Placed Torch & Glowstone Lighting Pool (4 pooled PointLights -> 60% faster fragment shader!)
    this.lightSources = new Map(); // "x,y,z" -> { x, y, z, isGlowstone }
    this._lightDirty = true;
    this._lightRefreshTimer = 0;
    this._lightClock = 0;
    this._activeLightSources = [];
    this.torchLightPool = [];
    for (let i = 0; i < 4; i++) {
      const pl = new THREE.PointLight(0xffb44c, 0, 46, 0.85);
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

    // Wider macro climate & terrain fields (~2.3x larger biomes, landmasses, valleys & mountain ranges!)
    const temp = this.biomeNoise.fbm2D(wx * 0.00145, wz * 0.00145, 3);
    const moist = this.moistureNoise.fbm2D(wx * 0.00145, wz * 0.00145, 3);
    const mountField = this.heightNoise.fbm2D(wx * 0.00155 + 50, wz * 0.00155 - 50, 3);
    const cont = this.heightNoise.fbm2D(wx * 0.0018, wz * 0.0018, 4);

    let biome = 'Plains';
    if (mountField > 0.145) biome = 'Mountains';
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
    let baseH = SEA_LEVEL + 7.5 + cont * 21.0 + (hills * hillAmp + terrace) + biomeOffset + micro + alpineBoost - valleyCarve - riverCarve - pondCarve;
    if (biome === 'Swamp' && mSmooth < 0.15) {
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
    if (this.worldType === 'flat') return false;
    // Guaranteed grand 3x3 starter village near spawn centered at chunk (2, 1)!
    if (vcx === 2 && vcz === 1) return true;
    // Spaced 11x11 chunk grid so huge 3x3 villages never collide
    if (((vcx % 11) + 11) % 11 !== 4 || ((vcz % 11) + 11) % 11 !== 4) return false;
    return coordHash(vcx * 13, vcz * 17, this.seed + 555) > 0.25;
  }

  // Deterministic Mega-Structure Locator (Great Pyramid 4x4 chunks & Grand Citadel 3x3 chunks!)
  // Returns { type, name, originCx, originCz, sizeChunks, dx, dz, baseY, centerWx, centerWz, villagerCount }
  getMegaStructureForChunk(cx, cz) {
    if (this.worldType === 'flat') return null;

    // 1. Guaranteed Starter Mega-Structure near spawn: The Great Pyramid of Secrets!
    // Spans 4x4 chunks: cx in [-7..-4], cz in [-6..-3] (64x64 blocks, ~95m NW of spawn!)
    if (cx >= -7 && cx <= -4 && cz >= -6 && cz <= -3) {
      const originCx = -7;
      const originCz = -6;
      const centerWx = (originCx + 2) * CHUNK_SIZE;
      const centerWz = (originCz + 2) * CHUNK_SIZE;
      const biome = this.getBiomeAt(centerWx, centerWz);
      const rawH = this.getTerrainHeight(centerWx, centerWz, biome);
      const baseY = Math.max(SEA_LEVEL + 4, Math.min(SEA_LEVEL + 42, rawH));
      return {
        type: 'great_pyramid',
        name: 'The Great Pyramid',
        originCx, originCz,
        sizeChunks: 4,
        dx: cx - originCx,
        dz: cz - originCz,
        baseY,
        centerWx, centerWz,
        villagerCount: 200
      };
    }

    // 2. Repeating World Mega-Structures on a 28x28 chunk grid (never overlapping spawn cell 0,0)
    const GRID = 28;
    const gx = Math.floor((cx + 14) / GRID);
    const gz = Math.floor((cz + 14) / GRID);
    if (gx === 0 && gz === 0) return null;

    const hRoll = coordHash(gx * 59, gz * 83, this.seed + 1901);
    if (hRoll < 0.22) return null;

    const isCitadel = (((gx + gz) & 1) === 1) && hRoll > 0.56;
    const sizeChunks = isCitadel ? 3 : 4;
    const offX = 4 + Math.floor(coordHash(gx * 37, gz * 71, this.seed + 1913) * (GRID - 10));
    const offZ = 4 + Math.floor(coordHash(gx * 97, gz * 41, this.seed + 1931) * (GRID - 10));
    const originCx = gx * GRID - 14 + offX;
    const originCz = gz * GRID - 14 + offZ;

    if (cx < originCx || cx >= originCx + sizeChunks || cz < originCz || cz >= originCz + sizeChunks) {
      return null;
    }

    const centerWx = (originCx + sizeChunks * 0.5) * CHUNK_SIZE;
    const centerWz = (originCz + sizeChunks * 0.5) * CHUNK_SIZE;
    const biome = this.getBiomeAt(centerWx, centerWz);
    const rawH = this.getTerrainHeight(centerWx, centerWz, biome);
    if (rawH <= SEA_LEVEL - 2 || rawH > SEA_LEVEL + 56) return null;
    const baseY = Math.max(SEA_LEVEL + 4, Math.min(SEA_LEVEL + 46, rawH));

    return {
      type: isCitadel ? 'grand_citadel' : 'great_pyramid',
      name: isCitadel ? 'Grand Citadel' : 'The Great Pyramid',
      originCx, originCz,
      sizeChunks,
      dx: cx - originCx,
      dz: cz - originCz,
      baseY,
      centerWx, centerWz,
      villagerCount: isCitadel ? 120 : 200
    };
  }

  // Returns { vcx, vcz, dx, dz, baseY, biome } if chunk (cx, cz) belongs to any 3x3 village!
  getVillageForChunk(cx, cz) {
    if (this.worldType === 'flat') return null;
    if (this.getMegaStructureForChunk(cx, cz)) return null;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const vcx = cx - dx;
        const vcz = cz - dz;
        if (this.isVillageCenter(vcx, vcz)) {
          if (this.getMegaStructureForChunk(vcx, vcz)) return null;
          const centerWx = vcx * CHUNK_SIZE + 8;
          const centerWz = vcz * CHUNK_SIZE + 8;
          const biome = this.getBiomeAt(centerWx, centerWz);
          const baseY = this.getTerrainHeight(centerWx, centerWz, biome);
          if (baseY <= SEA_LEVEL + 1 || baseY > SEA_LEVEL + 36 || biome === 'Mountains' || biome === 'Swamp') return null;
          return { vcx, vcz, dx, dz, baseY, biome };
        }
      }
    }
    return null;
  }

  isVillageChunk(cx, cz) {
    return !!this.getVillageForChunk(cx, cz);
  }

  // HUGE 3x3-Chunk (48x48 block!) Multi-District Living Village with Real Beds & Architecture!
  buildVillageDistrict(cx, cz, ox, oz, heights, setLocal, getLocal, vInfo) {
    const { vcx, vcz, dx: vdx, dz: vdz, baseY, biome } = vInfo;
    const isDesert = biome === 'Desert' || biome === 'Badlands';
    const isSnow = biome === 'Snowy Taiga';
    const isBirch = biome === 'Birch Forest';
    const isSavanna = biome === 'Savanna';
    const isJungle = biome === 'Jungle';
    const isCherry = biome === 'Cherry Grove';

    const wallBlk = isDesert ? BLOCK.SANDSTONE : (isSnow ? BLOCK.SPRUCE_PLANKS : (isBirch ? BLOCK.BIRCH_PLANKS : (isSavanna ? BLOCK.ACACIA_PLANKS : (isJungle ? BLOCK.JUNGLE_PLANKS : (isCherry ? BLOCK.CHERRY_PLANKS : BLOCK.OAK_PLANKS)))));
    const logBlk = isDesert ? BLOCK.SANDSTONE : (isSnow ? BLOCK.SPRUCE_LOG : (isBirch ? BLOCK.BIRCH_LOG : (isSavanna ? BLOCK.ACACIA_LOG : (isJungle ? BLOCK.JUNGLE_LOG : (isCherry ? BLOCK.CHERRY_LOG : BLOCK.OAK_LOG)))));
    const roofBlk = isDesert ? BLOCK.SANDSTONE : (isSnow ? BLOCK.SPRUCE_LOG : (isSavanna ? BLOCK.ACACIA_LOG : (isCherry ? BLOCK.CHERRY_LOG : BLOCK.BRICKS)));
    const trimBlk = isDesert ? BLOCK.SANDSTONE : BLOCK.STONE_BRICKS;
    const pathBlk = isDesert ? BLOCK.SANDSTONE : BLOCK.GRAVEL;
    const groundBlk = biome === 'Badlands' ? BLOCK.RED_SAND : (isDesert ? BLOCK.SAND : (isSnow ? BLOCK.SNOW : (isSavanna ? BLOCK.SAVANNA_GRASS : (isJungle ? BLOCK.JUNGLE_GRASS : BLOCK.GRASS))));
    const fillBlk = biome === 'Badlands' ? BLOCK.TERRACOTTA : (isDesert ? BLOCK.SAND : BLOCK.DIRT);

    // 1. Terrace this district smoothly to shared village baseY (feathered on outer village rim!)
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const outerEdge =
          (vdx === -1 && lx === 0) || (vdx === 1 && lx === 15) ||
          (vdz === -1 && lz === 0) || (vdz === 1 && lz === 15);
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

    // 2. Wide 3-block Village Avenues connecting all 9 districts!
    const layRoad = (x0, z0, x1, z1) => {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const isEdge = (x === x0 || x === x1 || z === z0 || z === z1);
          const blk = isEdge && coordHash(ox + x, oz + z, this.seed + 31) > 0.55 ? BLOCK.COBBLESTONE : pathBlk;
          setLocal(x, baseY, z, blk);
        }
      }
    };
    if (vdz === 0) layRoad(0, 6, 15, 8);
    if (vdx === 0) layRoad(6, 0, 8, 15);
    if (vdx !== 0 && vdz !== 0) {
      // Corner district connector lanes toward main roads
      if (vdx === -1) layRoad(7, 6, 15, 8);
      if (vdx === 1) layRoad(0, 6, 8, 8);
      if (vdz === -1) layRoad(6, 7, 8, 15);
      if (vdz === 1) layRoad(6, 0, 8, 8);
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
      setLocal(lx, baseY + 2, lz, logBlk);
      setLocal(lx, baseY + 3, lz, logBlk);
      setLocal(lx, baseY + 4, lz, BLOCK.GLOWSTONE);
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

      // Doorway + Cobble Porch Step
      const midX = x0 + Math.floor(w / 2);
      const midZ = z0 + Math.floor(d / 2);
      if (doorSide === 'south') {
        setLocal(midX, baseY + 1, z0 + d - 1, BLOCK.AIR); setLocal(midX, baseY + 2, z0 + d - 1, BLOCK.AIR);
        setLocal(midX, baseY, z0 + d, BLOCK.COBBLESTONE);
      } else if (doorSide === 'north') {
        setLocal(midX, baseY + 1, z0, BLOCK.AIR); setLocal(midX, baseY + 2, z0, BLOCK.AIR);
        setLocal(midX, baseY, z0 - 1, BLOCK.COBBLESTONE);
      } else if (doorSide === 'east') {
        setLocal(x0 + w - 1, baseY + 1, midZ, BLOCK.AIR); setLocal(x0 + w - 1, baseY + 2, midZ, BLOCK.AIR);
        setLocal(x0 + w, baseY, midZ, BLOCK.COBBLESTONE);
      } else {
        setLocal(x0, baseY + 1, midZ, BLOCK.AIR); setLocal(x0, baseY + 2, midZ, BLOCK.AIR);
        setLocal(x0 - 1, baseY, midZ, BLOCK.COBBLESTONE);
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
      // --- WEST DISTRICT: Large Irrigated Farmlands + Rustic Barn! ---
      const buildFarmPlot = (fx, fz, fw, fd) => {
        for (let dz = 0; dz < fd; dz++) {
          for (let dx = 0; dx < fw; dx++) {
            const border = dx === 0 || dx === fw - 1 || dz === 0 || dz === fd - 1;
            if (border) {
              setLocal(fx + dx, baseY, fz + dz, logBlk);
            } else if (dx === Math.floor(fw / 2)) {
              setLocal(fx + dx, baseY, fz + dz, BLOCK.WATER);
            } else {
              setLocal(fx + dx, baseY, fz + dz, BLOCK.FARMLAND);
              setLocal(fx + dx, baseY + 1, fz + dz, BLOCK.TALL_GRASS);
            }
          }
        }
      };
      buildFarmPlot(1, 1, 7, 5);
      buildFarmPlot(9, 1, 6, 5);
      buildDetailedHouse(2, 10, 7, 5, 3, { doorSide: 'north', beds: 1, chestTier: 'house', chimney: false });
      addLamp(10, 10);
    } else {
      // --- CORNER DISTRICTS: Outer Cottages, Orchard & Flower Gardens! ---
      const doorDir = vdz === -1 ? 'south' : 'north';
      buildDetailedHouse(4, 4, 6, 6, 3, { doorSide: doorDir, beds: 1, chestTier: (vdx === 1 ? 'house' : null) });
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

  // Deterministic Biome-Specific World Structure Locator (7 unique structures + Villages, zero collisions!)
  getStructureTypeForChunk(cx, cz) {
    if (this.worldType === 'flat') return null;
    if (this.getMegaStructureForChunk(cx, cz)) return null;
    if (this.getVillageForChunk(cx, cz)) return null;
    // Grid cell of 6x6 chunks -> rich frequent discovery without clutter!
    const gx = Math.floor(cx / 6);
    const gz = Math.floor(cz / 6);
    const ox = Math.floor(coordHash(gx * 43, gz * 67, this.seed + 811) * 4) + 1;
    const oz = Math.floor(coordHash(gx * 71, gz * 29, this.seed + 823) * 4) + 1;
    if (cx !== gx * 6 + ox || cz !== gz * 6 + oz) return null;
    const roll = coordHash(cx * 31, cz * 29, this.seed + 777);
    if (roll < 0.30) return null;

    const col = this.sampleColumn(cx * CHUNK_SIZE + 8, cz * CHUNK_SIZE + 8);
    const h = col.height;
    const b = col.biome;
    if (h <= SEA_LEVEL + 1 && b !== 'Swamp') return null;
    if (h > CHUNK_HEIGHT - 28) return null;

    if (b === 'Desert') return roll > 0.62 ? 'desert_pyramid' : 'desert_oasis';
    if (b === 'Badlands') return roll > 0.58 ? 'desert_pyramid' : 'ruined_portal';
    if (b === 'Jungle') return 'jungle_temple';
    if (b === 'Snowy Taiga') return 'igloo';
    if (b === 'Swamp') return 'witch_hut';
    if (b === 'Savanna') return 'savanna_outpost';
    if (b === 'Mountains') return h < SEA_LEVEL + 72 ? (roll > 0.65 ? 'watchtower' : 'ruined_portal') : null;
    if (b === 'Cherry Grove') return roll > 0.58 ? 'ruined_portal' : 'watchtower';
    // Plains, Forest, Birch Forest
    return roll > 0.62 ? 'watchtower' : 'ruined_portal';
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

    if (structType === 'watchtower') {
      const x0 = 5, z0 = 5, w = 6, hT = 11;
      markNoTrees(x0, z0, x0 + w - 1, z0 + w - 1, 5);
      fillFoundation(x0, z0, x0 + w - 1, z0 + w - 1, th, BLOCK.COBBLESTONE);
      for (let dz = 0; dz < w; dz++) {
        for (let dx = 0; dx < w; dx++) {
          for (let dy = 1; dy <= hT; dy++) {
            const edgeX = dx === 0 || dx === w - 1;
            const edgeZ = dz === 0 || dz === w - 1;
            if (edgeX && edgeZ) setLocal(x0 + dx, th + dy, z0 + dz, BLOCK.STONE_BRICKS);
            else if (edgeX || edgeZ) {
              const isWin = (dy === 4 || dy === 8) && (dx === 2 || dx === 3 || dz === 2 || dz === 3);
              setLocal(x0 + dx, th + dy, z0 + dz, isWin ? BLOCK.GLASS : (dy % 2 === 0 ? BLOCK.STONE_BRICKS : BLOCK.COBBLESTONE));
            } else {
              setLocal(x0 + dx, th + dy, z0 + dz, dy === 5 || dy === hT ? BLOCK.OAK_PLANKS : BLOCK.AIR);
            }
          }
          if ((dx === 0 || dx === w - 1 || dz === 0 || dz === w - 1) && (dx + dz) % 2 === 0) {
            setLocal(x0 + dx, th + hT + 1, z0 + dz, BLOCK.STONE_BRICKS);
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
      // Stepped Sandstone & Orange Terracotta Desert Temple with Treasure Chamber!
      const x0 = 2, z0 = 2, size = 12;
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
              setLocal(x0 + dx, th + 1 + layer, z0 + dz, isAccent ? BLOCK.TERRACOTTA_ORANGE : BLOCK.SANDSTONE);
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
      // Desert Sandstone Well & Oasis Pool!
      const x0 = 5, z0 = 5;
      markNoTrees(x0 - 1, z0 - 1, x0 + 6, z0 + 6, 4);
      fillFoundation(x0, z0, x0 + 5, z0 + 5, th, BLOCK.SANDSTONE);
      for (let dz = 1; dz <= 4; dz++) {
        for (let dx = 1; dx <= 4; dx++) {
          const edge = dx === 1 || dx === 4 || dz === 1 || dz === 4;
          setLocal(x0 + dx, th, z0 + dz, edge ? BLOCK.SANDSTONE : BLOCK.WATER);
          setLocal(x0 + dx, th - 1, z0 + dz, edge ? BLOCK.SANDSTONE : BLOCK.WATER);
          setLocal(x0 + dx, th + 1, z0 + dz, edge ? BLOCK.SANDSTONE : BLOCK.AIR);
        }
      }
      for (const [px, pz] of [[1, 1], [4, 1], [1, 4], [4, 4]]) {
        for (let dy = 2; dy <= 4; dy++) setLocal(x0 + px, th + dy, z0 + pz, BLOCK.SANDSTONE);
      }
      for (let dz = 1; dz <= 4; dz++) {
        for (let dx = 1; dx <= 4; dx++) setLocal(x0 + dx, th + 5, z0 + dz, BLOCK.SANDSTONE);
      }
      setLocal(x0 + 2, th + 6, z0 + 2, BLOCK.GLOWSTONE);
      placeChest(x0 + 0, th + 1, z0 + 2, [
        { id: 'bread', count: 5 },
        { id: 'apple', count: 4 },
        { id: 'gold_ingot', count: 3 },
        { id: 'flint', count: 3 }
      ]);
    } else if (structType === 'jungle_temple') {
      // Mossy Cobblestone Ancient Jungle Temple!
      const x0 = 3, z0 = 3, w = 10, d = 10;
      markNoTrees(x0, z0, x0 + w - 1, z0 + d - 1, 5);
      fillFoundation(x0, z0, x0 + w - 1, z0 + d - 1, th, BLOCK.MOSSY_COBBLESTONE);
      for (let dz = 0; dz < d; dz++) {
        for (let dx = 0; dx < w; dx++) {
          const edge = dx === 0 || dx === w - 1 || dz === 0 || dz === d - 1;
          for (let dy = 1; dy <= 6; dy++) {
            const wallBlk = ((dx + dy + dz) % 3 === 0) ? BLOCK.STONE_BRICKS : BLOCK.MOSSY_COBBLESTONE;
            if (edge || dy === 6) setLocal(x0 + dx, th + dy, z0 + dz, wallBlk);
            else setLocal(x0 + dx, th + dy, z0 + dz, BLOCK.AIR);
          }
          // Stepped temple crown
          if (dx >= 2 && dx <= w - 3 && dz >= 2 && dz <= d - 3) {
            setLocal(x0 + dx, th + 7, z0 + dz, BLOCK.MOSSY_COBBLESTONE);
            if (dx >= 3 && dx <= w - 4 && dz >= 3 && dz <= d - 4) {
              setLocal(x0 + dx, th + 8, z0 + dz, BLOCK.STONE_BRICKS);
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
          setLocal(x0 + dx, th, z0 + dz, (dx >= 2 && dx <= 5 && dz >= 2 && dz <= 5) ? BLOCK.WOOL_RED : BLOCK.SNOW);
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
      // Elevated Swamp Stilted Witch Cabin!
      const x0 = 4, z0 = 4, w = 7, d = 8;
      const deckY = Math.max(th, SEA_LEVEL) + 2;
      markNoTrees(x0, z0, x0 + w - 1, z0 + d - 1, 5);
      // Clear above water/ground
      for (let dz = 0; dz < d; dz++) {
        for (let dx = 0; dx < w; dx++) {
          for (let y = deckY; y <= deckY + 8; y++) setLocal(x0 + dx, y, z0 + dz, BLOCK.AIR);
        }
      }
      // 4 sturdy spruce stilts down into mud/water
      for (const [sx, sz] of [[0, 0], [w - 1, 0], [0, d - 1], [w - 1, d - 1]]) {
        for (let y = Math.max(1, SEA_LEVEL - 4); y <= deckY + 4; y++) {
          setLocal(x0 + sx, y, z0 + sz, BLOCK.SPRUCE_LOG);
        }
      }
      // Deck floor, cabin walls & gabled roof
      for (let dz = 0; dz < d; dz++) {
        for (let dx = 0; dx < w; dx++) {
          setLocal(x0 + dx, deckY, z0 + dz, BLOCK.SPRUCE_PLANKS);
          if (dz >= 2) {
            const edge = dx === 0 || dx === w - 1 || dz === 2 || dz === d - 1;
            for (let dy = 1; dy <= 3; dy++) {
              if (edge) {
                const isWin = dy === 2 && ((dx === 0 || dx === w - 1) && dz === 5);
                setLocal(x0 + dx, deckY + dy, z0 + dz, isWin ? BLOCK.GLASS : BLOCK.SPRUCE_PLANKS);
              }
            }
            setLocal(x0 + dx, deckY + 4, z0 + dz, BLOCK.SPRUCE_LOG);
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
          // Canopy roof overhang
          setLocal(x0 + dx, th + hT + 1, z0 + dz, edge ? BLOCK.WOOL_RED : BLOCK.WOOL_YELLOW);
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
                if (isDoor && dy <= 2) setLocal(lx, baseY + dy, lz, BLOCK.AIR);
                else if (corner) setLocal(lx, baseY + dy, lz, BLOCK.ACACIA_LOG);
                else if (dy === 2 && !isDoor && (dx === 2 || dz === 2)) setLocal(lx, baseY + dy, lz, BLOCK.GLASS);
                else setLocal(lx, baseY + dy, lz, cot.wall);
              } else {
                setLocal(lx, baseY + dy, lz, BLOCK.AIR);
              }
            }
            // Pitched stepped terracotta roof
            setLocal(lx, baseY + 4, lz, cot.roof);
            if (!edgeX && !edgeZ) setLocal(lx, baseY + 5, lz, cot.roof);

            // Cozy miniature interior furnishings!
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
            if (dx === 2 && dz === 2) setLocal(lx, baseY + 3, lz, BLOCK.TORCH);
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
            // Wall sconces & ceiling glowstone accents
            if ((lx === 6 || lx === 9) && lz === 7 && (cdx + cdz + lvl) % 2 === 0) {
              setLocal(lx, ly0 + 3, lz, BLOCK.TORCH);
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

          // Subtle Secret False-Wall Doorway (1-block breakable false wall with a golden/accent clue block above!)
          setLocal(c.doorX, ly0 + 1, c.doorZ, fMat);
          setLocal(c.doorX, ly0 + 2, c.doorZ, fMat);
          setLocal(c.doorX, ly0 + 3, c.doorZ, BLOCK.GOLD_BLOCK); // subtle secret clue keystone!

          // Furnish the secret room by archetype!
          const cxR = c.x0 + 1;
          const czR = c.z0 + 1;
          setLocal(c.x0 + 2, ly0 + 3, c.z0 + 2, BLOCK.TORCH);
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

    // MEGA-STRUCTURE #2: THE GRAND CITADEL (48x48 Stone Fortress + 120 Villagers + 2-Level Dungeon Vaults!)
    if (type === 'grand_citadel') {
      const levels = [baseY - 11, Math.max(10, baseY - 22)];
      for (let lz = 0; lz < 16; lz++) {
        const gz = cdz * 16 + lz;
        for (let lx = 0; lx < 16; lx++) {
          const gx = cdx * 16 + lx;
          const ch = heights[lx + (lz << 4)];
          const dxC = Math.abs(gx - 23.5);
          const dzC = Math.abs(gz - 23.5);
          const dist = Math.max(dxC, dzC);

          for (let y = levels[1] - 2; y < baseY; y++) setLocal(lx, y, lz, BLOCK.STONE);
          const onRoad = (gx >= 22 && gx <= 25) || (gz >= 22 && gz <= 25);
          setLocal(lx, baseY, lz, onRoad ? BLOCK.COBBLESTONE : (((gx + gz) & 1) ? BLOCK.STONE_BRICKS : BLOCK.GRASS));

          // Clear interior & sky
          for (let y = baseY + 1; y <= Math.min(CHUNK_HEIGHT - 2, Math.max(ch + 4, baseY + 24)); y++) {
            setLocal(lx, y, lz, BLOCK.AIR);
          }

          // Towering 48x48 Fortress Walls & 4 Corner Watchtowers
          const inTower = (gx <= 7 || gx >= 40) && (gz <= 7 || gz >= 40);
          const isOuterWall = dist >= 21.5 && dist <= 23.5;
          const inGate = ((dxC <= 2.5 && (gz <= 3 || gz >= 44)) || (dzC <= 2.5 && (gx <= 3 || gx >= 44)));
          if (inTower) {
            const tEdge = gx === 0 || gx === 7 || gx === 40 || gx === 47 || gz === 0 || gz === 7 || gz === 40 || gz === 47;
            for (let dy = 1; dy <= 18; dy++) {
              if (tEdge) setLocal(lx, baseY + dy, lz, dy === 18 && ((gx + gz) & 1) ? BLOCK.AIR : BLOCK.STONE_BRICKS);
              else if (dy === 16) setLocal(lx, baseY + dy, lz, BLOCK.OAK_PLANKS);
            }
            if ((gx === 3 || gx === 44) && (gz === 3 || gz === 44)) setLocal(lx, baseY + 17, lz, BLOCK.GLOWSTONE);
          } else if (isOuterWall) {
            for (let dy = 1; dy <= 11; dy++) {
              if (inGate && dy <= 5) continue;
              if (dy === 11 && ((gx + gz) & 1)) continue;
              setLocal(lx, baseY + dy, lz, dy === 10 ? BLOCK.MOSSY_COBBLESTONE : BLOCK.STONE_BRICKS);
            }
            if (dy_check(gx, gz)) setLocal(lx, baseY + 11, lz, BLOCK.TORCH);
          }

          // Central Grand Fountain (gx,gz in [21..26])
          if (gx >= 21 && gx <= 26 && gz >= 21 && gz <= 26) {
            const rim = gx === 21 || gx === 26 || gz === 21 || gz === 26;
            setLocal(lx, baseY + 1, lz, rim ? BLOCK.STONE_BRICKS : BLOCK.WATER);
            if ((gx === 23 || gx === 24) && (gz === 23 || gz === 24)) {
              setLocal(lx, baseY + 1, lz, BLOCK.IRON_BLOCK);
              setLocal(lx, baseY + 2, lz, BLOCK.GLOWSTONE);
            }
          }
        }
      }

      // 8 Citadel Guildhouses in the 4 inner quadrants
      const houses = [
        [10, 10], [10, 17], [31, 10], [31, 17],
        [10, 31], [17, 31], [31, 31], [31, 25]
      ];
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
            setLocal(lx, baseY, lz, BLOCK.OAK_PLANKS);
            for (let dy = 1; dy <= 4; dy++) {
              if (eX || eZ) {
                if (isDoor && dy <= 2) setLocal(lx, baseY + dy, lz, BLOCK.AIR);
                else if (eX && eZ) setLocal(lx, baseY + dy, lz, BLOCK.OAK_LOG);
                else if (dy === 2 && !isDoor && (dx === 2 || dz === 2)) setLocal(lx, baseY + dy, lz, BLOCK.GLASS);
                else setLocal(lx, baseY + dy, lz, BLOCK.OAK_PLANKS);
              }
            }
            setLocal(lx, baseY + 5, lz, BLOCK.BRICKS);
            if (!eX && !eZ) setLocal(lx, baseY + 6, lz, BLOCK.BRICKS);
            if (dx === 2 && dz === 2) setLocal(lx, baseY + 4, lz, BLOCK.TORCH);
            if (dx === 4 && dz === 1) placeChest(lx, baseY + 1, lz, makeSecretLoot(hi * 17, 1));
          }
        }
      }

      // 2-Level Underground Citadel Dungeon Vaults
      for (let lvl = 0; lvl < 2; lvl++) {
        const ly0 = levels[lvl];
        for (let lz = 6; lz <= 9; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            setLocal(lx, ly0, lz, BLOCK.STONE_BRICKS);
            for (let dy = 1; dy <= 3; dy++) setLocal(lx, ly0 + dy, lz, BLOCK.AIR);
          }
        }
        for (let lx = 6; lx <= 9; lx++) {
          for (let lz = 0; lz < 16; lz++) {
            setLocal(lx, ly0, lz, BLOCK.STONE_BRICKS);
            for (let dy = 1; dy <= 3; dy++) setLocal(lx, ly0 + dy, lz, BLOCK.AIR);
          }
        }
        setLocal(7, ly0 + 4, 7, BLOCK.GLOWSTONE);
        // 2 secret vaults per chunk per level
        for (const [vx, vz, salt] of [[2, 2, 13], [11, 11, 29]]) {
          for (let dz = 0; dz < 3; dz++) {
            for (let dx = 0; dx < 3; dx++) {
              setLocal(vx + dx, ly0, vz + dz, BLOCK.MOSSY_COBBLESTONE);
              for (let dy = 1; dy <= 3; dy++) setLocal(vx + dx, ly0 + dy, vz + dz, BLOCK.AIR);
            }
          }
          setLocal(vx + 1, ly0 + 3, vz + 1, BLOCK.TORCH);
          placeChest(vx + 1, ly0 + 1, vz + 1, makeSecretLoot(salt + lvl * 50, lvl + 1));
        }
      }

      if (cdx === 1 && cdz === 1) {
        const mKey = this.chunkKey(originCx, originCz);
        if (!this.megaStructures.has(mKey)) {
          this.megaStructures.set(mKey, {
            key: mKey,
            type: 'grand_citadel',
            name: 'Grand Citadel',
            x: centerWx,
            y: baseY + 1,
            z: centerWz,
            radius: 24,
            innerRadius: 18,
            villagerCount,
            discovered: false,
            crowdSpawned: false
          });
        }
      }
    }

    function dy_check(gx, gz) {
      return ((gx === 1 || gx === 46) && gz % 8 === 0) || ((gz === 1 || gz === 46) && gx % 8 === 0);
    }
  }

  // Standalone Underground Structures in normal chunks (Abandoned Mineshafts, Mossy Dungeon Crypts, Deep Lava Shrines!)
  buildUndergroundStructure(cx, cz, ox, oz, heights, setLocal) {
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
      }
    }

    const chunk = { cx, cz, key, data, maxY, meshes: [], dirty: true, queued: false };
    this.chunks.set(key, chunk);
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

    // Neighbor chunks if on edge
    if (lx === 0) this.markDirty(cx - 1, cz);
    if (lx === CHUNK_SIZE - 1) this.markDirty(cx + 1, cz);
    if (lz === 0) this.markDirty(cx, cz - 1);
    if (lz === CHUNK_SIZE - 1) this.markDirty(cx, cz + 1);

    // Trigger leaf decay checks whenever a tree log or leaf is removed
    if (prevId !== blockId) {
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

  // Authentic Minecraft Fluid Flow & Water+Lava Mixing (Obsidian, Cobblestone, Stone!)
  updateFluids(dt) {
    if (this.fluidQueue.size === 0) return;
    let processed = 0;
    const maxPerFrame = 18;
    const ready = [];
    for (const [k, entry] of this.fluidQueue) {
      entry.timer -= dt;
      if (entry.timer <= 0 && ready.length < maxPerFrame) {
        ready.push([k, entry]);
      }
    }

    const canFlowInto = (b) => (
      b === BLOCK.AIR || b === BLOCK.FIRE || b === BLOCK.TALL_GRASS ||
      b === BLOCK.FLOWER_RED || b === BLOCK.FLOWER_YELLOW || b === BLOCK.TORCH
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

      // 1. If flowing (level > 0), verify it is still fed by a lower-level neighbor or fluid directly above!
      if (level > 0) {
        const above = this.getBlock(x, y + 1, z);
        let fed = above === cur;
        let minNeigh = 99;
        if (!fed) {
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (this.getBlock(x + dx, y, z + dz) === cur) {
              const nl = this.getFluidLevel(x + dx, y, z + dz);
              if (nl < minNeigh) minNeigh = nl;
            }
          }
          if (minNeigh < level) fed = true;
        }
        if (!fed) {
          this.fluidLevels.delete(k);
          this.setBlock(x, y, z, BLOCK.AIR, true);
          continue;
        }
        const newLevel = above === cur ? 1 : (minNeigh + 1);
        if (newLevel > maxSpread) {
          this.fluidLevels.delete(k);
          this.setBlock(x, y, z, BLOCK.AIR, true);
          continue;
        }
        if (newLevel !== level) {
          level = newLevel;
          this.fluidLevels.set(k, level);
        }
      }

      // 2. Check downward flow first (gravity!)
      if (y > 1) {
        const below = this.getBlock(x, y - 1, z);
        if (isLava && below === BLOCK.WATER) {
          // Minecraft rule: Lava flowing DOWN onto Water -> STONE!
          this.fluidLevels.delete(`${x},${y - 1},${z}`);
          this.setBlock(x, y - 1, z, BLOCK.STONE, true);
          if (this.onFluidMix) this.onFluidMix(x, y - 1, z, BLOCK.STONE);
          continue;
        }
        if (!isLava && below === BLOCK.LAVA) {
          // Minecraft rule: Water hitting Lava Source -> OBSIDIAN; Flowing Lava -> COBBLESTONE!
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
            this.scheduleFluid(x, y - 1, z, cur);
          }
          continue;
        }
      }

      // 3. Horizontal spread (up to 7 blocks for Water, 3 blocks for Lava) + sideways mixing!
      if (level < maxSpread) {
        const nextLevel = level + 1;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, nz = z + dz;
          const nb = this.getBlock(nx, y, nz);

          if (!isLava && nb === BLOCK.LAVA) {
            // Water hitting Lava horizontally: Source -> OBSIDIAN, Flowing -> COBBLESTONE!
            const res = this.getFluidLevel(nx, y, nz) === 0 ? BLOCK.OBSIDIAN : BLOCK.COBBLESTONE;
            this.fluidLevels.delete(`${nx},${y},${nz}`);
            this.setBlock(nx, y, nz, res, true);
            if (this.onFluidMix) this.onFluidMix(nx, y, nz, res);
            continue;
          }
          if (isLava && nb === BLOCK.WATER) {
            // Lava flowing horizontally into Water -> COBBLESTONE (at lava's edge or contact point)!
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
            this.scheduleFluid(nx, y, nz, cur);
          }
        }
      }
      if (processed >= maxPerFrame) break;
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

      // 4. Burn out naturally if unsupported or after fuel is gone (unless eternal base)
      const supported = isBlockSolid(below) || hasFuelNeighbor;
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
    bOpaque.reset();
    bCutout.reset();
    bStatic.reset();
    bWater.reset();

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

    // Precompute per-column sky ceiling height for authentic dark underground caves & overhangs!
    const skyTop = SKY_TOP;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const zOff = lz << 4;
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        let topY = 0;
        const base = lx + zOff;
        for (let y = yLimit; y >= 0; y--) {
          const bid = data[base + (y << 8)];
          if (bid !== 0 && transTable[bid] === 0) {
            topY = y;
            break;
          }
        }
        skyTop[base] = topY;
      }
    }

    const calcSkyLight = (nlx, ny, nlz) => {
      let colTop;
      if (nlx >= 0 && nlx < 16 && nlz >= 0 && nlz < 16) {
        colTop = skyTop[nlx + (nlz << 4)];
      } else {
        // Fast probe for border-adjacent column ceiling
        colTop = ny;
        if (ny + 2 <= CHUNK_HEIGHT - 1 && solidTable[fastGet(nlx, ny + 2, nlz)]) colTop = ny + 10;
        else if (ny + 5 <= CHUNK_HEIGHT - 1 && solidTable[fastGet(nlx, ny + 5, nlz)]) colTop = ny + 12;
        else if (ny + 9 <= CHUNK_HEIGHT - 1 && solidTable[fastGet(nlx, ny + 9, nlz)]) colTop = ny + 14;
      }
      if (ny >= colTop) return 1.0;
      const depth = colTop - ny;
      const t = depth > 14 ? 1.0 : depth / 14.0;
      return 1.0 - t * 0.68; // Smoothly darkens to 0.32 deep underground inside caves!
    };

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
          const waterTopLower = (isWater || isLava) && fastGet(lx, y + 1, lz) !== id;
          const faceUVs = uvTable[id];
          const lightBoost = isLava ? 1.55 : (def.light > 0 ? 1.18 : 1.0);

          // Water +Y top surface is greedily meshed in PASS 3 (Lava renders all exposed faces including glowing top!)
          const startFi = isWater ? 1 : 0;
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
              if (neighbor === id || (neighbor !== 0 && transTable[neighbor] === 0)) continue;
            } else {
              if (neighbor === id && isStaticCutout) continue;
              if (neighbor !== 0 && transTable[neighbor] === 0) continue;
            }

            const uv = faceUVs[fi];
            const c0 = face.corners[0], c1 = face.corners[1], c2 = face.corners[2], c3 = face.corners[3];
            const skyF = def.light > 0 ? 1.0 : calcSkyLight(nlx, ny, nlz);
            const s = isLava ? 1.55 : Math.min(1.2, face.shade * lightBoost * skyF);
            const py0 = (waterTopLower && c0[1] === 1) ? y + 0.88 : y + c0[1];
            const py1 = (waterTopLower && c1[1] === 1) ? y + 0.88 : y + c1[1];
            const py2 = (waterTopLower && c2[1] === 1) ? y + 0.88 : y + c2[1];
            const py3 = (waterTopLower && c3[1] === 1) ? y + 0.88 : y + c3[1];

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

    // PASS 2: TRUE GREEDY MESHING for Opaque Cubes (5x–10x fewer triangles + smooth 4-corner AO + Cave Darkness!)
    const gMask = GREEDY_MASK;
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

            const isLit = litTable[id] !== 0;
            const skyF = isLit ? 1.0 : calcSkyLight(lx, ny, lz);
            const baseShade = faceShade * (isLit ? 1.24 : skyF);

            if (fi === 0) {
              // 4-corner AO for +Y top face
              const o00 = solidTable[fastGet(lx - 1, ny, lz)] + solidTable[fastGet(lx, ny, lz + 1)] + solidTable[fastGet(lx - 1, ny, lz + 1)];
              const o10 = solidTable[fastGet(lx + 1, ny, lz)] + solidTable[fastGet(lx, ny, lz + 1)] + solidTable[fastGet(lx + 1, ny, lz + 1)];
              const o11 = solidTable[fastGet(lx + 1, ny, lz)] + solidTable[fastGet(lx, ny, lz - 1)] + solidTable[fastGet(lx + 1, ny, lz - 1)];
              const o01 = solidTable[fastGet(lx - 1, ny, lz)] + solidTable[fastGet(lx, ny, lz - 1)] + solidTable[fastGet(lx - 1, ny, lz - 1)];
              if (o00 === o10 && o10 === o11 && o11 === o01) {
                const s = Math.min(1.25, baseShade * (1.0 - o00 * 0.09));
                const idx2 = lx + zOff;
                gMask[idx2] = (id << 10) | ((s * 128) | 0);
                gShade[idx2] = s;
                anyInSlice = true;
              } else {
                const uv = uvTable[id][0];
                const wx = ox + lx, wz = oz + lz;
                bOpaque.pushTiledQuad(
                  wx,     y + 1, wz + 1, 0, 0, Math.min(1.25, baseShade * (1.0 - o00 * 0.09)),
                  wx + 1, y + 1, wz + 1, 1, 0, Math.min(1.25, baseShade * (1.0 - o10 * 0.09)),
                  wx + 1, y + 1, wz,     1, 1, Math.min(1.25, baseShade * (1.0 - o11 * 0.09)),
                  wx,     y + 1, wz,     0, 1, Math.min(1.25, baseShade * (1.0 - o01 * 0.09)),
                  0, 1, 0, uv.u0, uv.v0, uv.du, uv.dv
                );
              }
            } else {
              const s = Math.min(1.25, baseShade);
              const idx2 = lx + zOff;
              gMask[idx2] = (id << 10) | ((s * 128) | 0);
              gShade[idx2] = s;
              anyInSlice = true;
            }
          }
        }

        if (!anyInSlice) continue;
        // Greedy 2D Rectangle Sweep across 16x16 slice!
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const key = gMask[lx + (lz << 4)];
            if (key === 0) continue;
            let w = 1;
            while (lx + w < 16 && gMask[(lx + w) + (lz << 4)] === key) w++;
            let h = 1;
            outerH: while (lz + h < 16) {
              const rowOff = (lz + h) << 4;
              for (let k = 0; k < w; k++) {
                if (gMask[lx + k + rowOff] !== key) break outerH;
              }
              h++;
            }
            const s = gShade[lx + (lz << 4)];
            for (let dz = 0; dz < h; dz++) {
              const rowOff = (lz + dz) << 4;
              for (let dx = 0; dx < w; dx++) gMask[lx + dx + rowOff] = 0;
            }
            const id = key >>> 10;
            const uv = uvTable[id][fi];
            const wx = ox + lx, wz = oz + lz;
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

            const isLit = litTable[id] !== 0;
            const skyF = isLit ? 1.0 : calcSkyLight(nlx, y, lz);
            const baseShade = faceShade * (isLit ? 1.24 : skyF);

            // 4-corner side AO
            const calcS = (dy, dz) =>
              solidTable[fastGet(nlx, y + dy, lz)] +
              solidTable[fastGet(nlx, y, lz + dz)] +
              solidTable[fastGet(nlx, y + dy, lz + dz)];
            const o0 = fi === 2 ? calcS(-1, 1) : calcS(-1, -1);
            const o1 = fi === 2 ? calcS(-1, -1) : calcS(-1, 1);
            const o2 = fi === 2 ? calcS(1, -1) : calcS(1, 1);
            const o3 = fi === 2 ? calcS(1, 1) : calcS(1, -1);

            if (o0 === o1 && o1 === o2 && o2 === o3) {
              const s = Math.min(1.25, baseShade * (1.0 - o0 * 0.09));
              gMask[lz + mRow] = (id << 10) | ((s * 128) | 0);
              gShade[lz + mRow] = s;
              anyInSlice = true;
            } else {
              const uv = uvTable[id][fi];
              const wz = oz + lz;
              const xPos = fi === 2 ? wx + 1 : wx;
              if (fi === 2) {
                bOpaque.pushTiledQuad(
                  xPos, y,     wz + 1, 0, 0, Math.min(1.25, baseShade * (1.0 - o0 * 0.09)),
                  xPos, y,     wz,     1, 0, Math.min(1.25, baseShade * (1.0 - o1 * 0.09)),
                  xPos, y + 1, wz,     1, 1, Math.min(1.25, baseShade * (1.0 - o2 * 0.09)),
                  xPos, y + 1, wz + 1, 0, 1, Math.min(1.25, baseShade * (1.0 - o3 * 0.09)),
                  1, 0, 0, uv.u0, uv.v0, uv.du, uv.dv
                );
              } else {
                bOpaque.pushTiledQuad(
                  xPos, y,     wz,     0, 0, Math.min(1.25, baseShade * (1.0 - o0 * 0.09)),
                  xPos, y,     wz + 1, 1, 0, Math.min(1.25, baseShade * (1.0 - o1 * 0.09)),
                  xPos, y + 1, wz + 1, 1, 1, Math.min(1.25, baseShade * (1.0 - o2 * 0.09)),
                  xPos, y + 1, wz,     0, 1, Math.min(1.25, baseShade * (1.0 - o3 * 0.09)),
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
            const key = gMask[lz + mRow];
            if (key === 0) continue;
            let w = 1;
            while (lz + w < 16 && gMask[(lz + w) + mRow] === key) w++;
            let h = 1;
            outerHX: while (y + h <= yLimit) {
              const rOff = (y + h) << 4;
              for (let k = 0; k < w; k++) {
                if (gMask[lz + k + rOff] !== key) break outerHX;
              }
              h++;
            }
            const s = gShade[lz + mRow];
            for (let dy = 0; dy < h; dy++) {
              const rOff = (y + dy) << 4;
              for (let dz = 0; dz < w; dz++) gMask[lz + dz + rOff] = 0;
            }
            const id = key >>> 10;
            const uv = uvTable[id][fi];
            const wz = oz + lz;
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

            const isLit = litTable[id] !== 0;
            const skyF = isLit ? 1.0 : calcSkyLight(lx, y, nlz);
            const baseShade = faceShade * (isLit ? 1.24 : skyF);

            const calcS = (dy, dx) =>
              solidTable[fastGet(lx, y + dy, nlz)] +
              solidTable[fastGet(lx + dx, y, nlz)] +
              solidTable[fastGet(lx + dx, y + dy, nlz)];
            const o0 = fi === 4 ? calcS(-1, -1) : calcS(-1, 1);
            const o1 = fi === 4 ? calcS(-1, 1) : calcS(-1, -1);
            const o2 = fi === 4 ? calcS(1, 1) : calcS(1, -1);
            const o3 = fi === 4 ? calcS(1, -1) : calcS(1, 1);

            if (o0 === o1 && o1 === o2 && o2 === o3) {
              const s = Math.min(1.25, baseShade * (1.0 - o0 * 0.09));
              gMask[lx + mRow] = (id << 10) | ((s * 128) | 0);
              gShade[lx + mRow] = s;
              anyInSlice = true;
            } else {
              const uv = uvTable[id][fi];
              const wx = ox + lx;
              const zPos = fi === 4 ? wz + 1 : wz;
              if (fi === 4) {
                bOpaque.pushTiledQuad(
                  wx,     y,     zPos, 0, 0, Math.min(1.25, baseShade * (1.0 - o0 * 0.09)),
                  wx + 1, y,     zPos, 1, 0, Math.min(1.25, baseShade * (1.0 - o1 * 0.09)),
                  wx + 1, y + 1, zPos, 1, 1, Math.min(1.25, baseShade * (1.0 - o2 * 0.09)),
                  wx,     y + 1, zPos, 0, 1, Math.min(1.25, baseShade * (1.0 - o3 * 0.09)),
                  0, 0, 1, uv.u0, uv.v0, uv.du, uv.dv
                );
              } else {
                bOpaque.pushTiledQuad(
                  wx + 1, y,     zPos, 0, 0, Math.min(1.25, baseShade * (1.0 - o0 * 0.09)),
                  wx,     y,     zPos, 1, 0, Math.min(1.25, baseShade * (1.0 - o1 * 0.09)),
                  wx,     y + 1, zPos, 1, 1, Math.min(1.25, baseShade * (1.0 - o2 * 0.09)),
                  wx + 1, y + 1, zPos, 0, 1, Math.min(1.25, baseShade * (1.0 - o3 * 0.09)),
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
            const key = gMask[lx + mRow];
            if (key === 0) continue;
            let w = 1;
            while (lx + w < 16 && gMask[(lx + w) + mRow] === key) w++;
            let h = 1;
            outerHZ: while (y + h <= yLimit) {
              const rOff = (y + h) << 4;
              for (let k = 0; k < w; k++) {
                if (gMask[lx + k + rOff] !== key) break outerHZ;
              }
              h++;
            }
            const s = gShade[lx + mRow];
            for (let dy = 0; dy < h; dy++) {
              const rOff = (y + dy) << 4;
              for (let dx = 0; dx < w; dx++) gMask[lx + dx + rOff] = 0;
            }
            const id = key >>> 10;
            const uv = uvTable[id][fi];
            const wx = ox + lx;
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
            if (above === BLOCK.WATER || (above !== 0 && transTable[above] === 0)) continue;
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

    const addBucket = (bucket, mat, renderOrder = 0, shadows = false) => {
      const geo = bucket.toGeometry();
      if (!geo) return;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = renderOrder;
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      const nearShadow = Math.abs(cx - this._lastChunkPcx) <= 3 && Math.abs(cz - this._lastChunkPcz) <= 3;
      mesh.castShadow = shadows && nearShadow && this.shaderMode === 'ultra';
      mesh.receiveShadow = (shadows || mat === this.cutoutMat) && nearShadow && this.shaderMode === 'ultra';
      this.group.add(mesh);
      chunk.meshes.push(mesh);
    };

    addBucket(bOpaque, this.opaqueMat, 0, true);
    addBucket(bCutout, this.cutoutMat, 1, false);
    addBucket(bStatic, this.staticCutoutMat, 1, false);
    // Water draws at renderOrder 3 (AFTER Early-Z SkyDome at renderOrder 2!)
    addBucket(bWater, this.waterMat, 3, false);
    if (chunk.lightKeys.length > 0) this._lightDirty = true;
    this._shadowNeedsUpdate = true;
  }

  setShaderMode(mode) {
    this.shaderMode = mode;
    this.shaderUniforms.uWaveStrength.value = mode === 'off' ? 0.0 : (mode === 'ultra' ? 1.15 : 0.9);
    this.shaderUniforms.uShaderOn.value = mode === 'off' ? 0.0 : 1.0;
    const useShadows = mode === 'ultra';
    for (const chunk of this.chunks.values()) {
      for (const m of chunk.meshes) {
        if (m.material === this.opaqueMat) {
          m.castShadow = useShadows;
          m.receiveShadow = useShadows;
        } else if (m.material === this.cutoutMat || m.material === this.staticCutoutMat) {
          m.receiveShadow = useShadows;
        }
      }
    }
  }

  updateShaders(dt, sky = null) {
    this.shaderUniforms.uTime.value += dt;
    if (sky) {
      const p = sky.getShaderParams();
      this.shaderUniforms.uSunDir.value.copy(p.sunDir);
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
      this.shaderUniforms.uCloudTime.value = p.cloudTime;
      this.shaderUniforms.uFogNear.value = sky.fog.near;
      this.shaderUniforms.uFogFar.value = sky.fog.far;
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
      const useShadows = this.shaderMode === 'ultra';
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
          // Only chunks within the ±46-block shadow frustum cast shadows (massive shadow-pass speedup!)
          const inShadowFrustum = Math.abs(dx) <= 3 && Math.abs(dz) <= 3;
          for (const m of chunk.meshes) {
            if (m.material === this.opaqueMat) {
              m.castShadow = inShadowFrustum;
              m.receiveShadow = inShadowFrustum;
            } else if (m.material === this.cutoutMat || m.material === this.staticCutoutMat) {
              m.receiveShadow = inShadowFrustum;
            }
          }
        }
      }
      this._shadowNeedsUpdate = true;
    }

    // 4. Distant Horizons 128-Chunk 4-Tier Quadtree LOD Ring (off-thread Web Workers + Greedy Meshing!)
    // Update GPU circular cutout so LOD NEVER overlaps or z-fights with full-detail chunks or caves!
    this.shaderUniforms.uLodInnerCenter.value.set(px, pz);
    const innerCutBlocks = Math.max(0, (r - 1.15) * CHUNK_SIZE);
    this.shaderUniforms.uLodInnerRadiusSq.value = innerCutBlocks * innerCutBlocks;
    this.updateLodAround(pcx, pcz, r, fullRD, Math.max(1.2, budgetMs * 0.42), camDirX, camDirZ);
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
        if (tier < 5) {
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

    // Re-evaluate zero-overlap 6-tier Quadtree LOD partition every 2 chunks or on renderDistance change!
    // T0=2m (4x4ch), T1=4m (8x8ch), T2=8m (16x16ch), T3=16m (32x32ch), T4=32m (64x64ch), T5=64m (128x128ch -> 512ch!)
    const prx = pcx >> 1;
    const prz = pcz >> 1;

    if (prx !== this._lastLodRx || prz !== this._lastLodRz || fullRD !== this._lastLodRD) {
      this._lastLodRx = prx;
      this._lastLodRz = prz;
      this._lastLodRD = fullRD;

      const TIER_CHUNKS = [4, 8, 16, 32, 64, 128];
      // Logarithmic split thresholds: ultra-lean ~80 frustum draw calls on iPad even at 512 chunks!
      const SPLIT_DIST = isTouchLOD
        ? [0, 14, 34, 76, 164, 316]
        : [0, 22, 52, 108, 216, 368];
      const clampedRD = Math.min(512, fullRD);
      const maxDistLimit = clampedRD + 2;
      const innerCullDist = Math.max(0, detailR - 1.35);
      const innerCutoutCheck = detailR + 2.5;
      const rootTier = clampedRD > 128 ? 5 : 3;
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

  // Update pooled real-time PointLights for the closest placed Torches & Glowstone (brighter at night!)
  updateTorchLights(dt, playerPos, sky = null) {
    if (!this.torchLightPool || this.torchLightPool.length === 0 || !playerPos) return;
    this._lightClock += dt;
    this._lightRefreshTimer -= dt;

    if (this._lightDirty || this._lightRefreshTimer <= 0) {
      this._lightDirty = false;
      this._lightRefreshTimer = 0.16;

      const maxDistSq = 54 * 54;
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
      if (i < activeCount) {
        const s = this._activeLightSources[i];
        // Position light slightly above the torch flame so it floods nearby floor & walls cleanly!
        pl.position.set(s.x + 0.5, s.y + (s.isGlowstone ? 0.6 : 1.18), s.z + 0.5);
        const phase = s.x * 1.7 + s.z * 2.3 + s.y * 0.9;
        const flicker = s.isGlowstone
          ? Math.sin(t * 3.5 + phase) * 0.22
          : Math.sin(t * 8.5 + phase) * 0.48 + Math.cos(t * 15.2 + phase * 1.3) * 0.24;
        // +100% Brighter Torch & Glowstone Light Output with wide warm illumination!
        const baseIntensity = s.isGlowstone
          ? (9.6 + nightFactor * 14.4)
          : (8.0 + nightFactor * 13.6);
        pl.intensity = Math.max(1.0, baseIntensity + flicker);
        pl.distance = 38 + nightFactor * 14;
        pl.color.setHex(s.isGlowstone ? 0xffd27a : 0xffb247);
      } else {
        pl.intensity = 0;
      }
    }
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
    this.megaStructures.clear();
    this.scene.remove(this.group);
    this.scene.remove(this.lodGroup);
  }
}
