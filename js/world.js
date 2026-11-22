import * as THREE from 'three';
import { BLOCK, getBlockDef, isBlockTransparent, isBlockCross, isBlockLiquid, isBlockSolid, isBedBlock, getBedInfo } from './blocks.js';
import { Noise, hashString } from './noise.js';
import { SMELTING_RECIPES, FUEL_VALUES } from './recipes.js';

export const CHUNK_SIZE = 16;
export const CHUNK_HEIGHT = 96;
export const SEA_LEVEL = 34;

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
    shade: 0.55,
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
    shade: 0.82,
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
    shade: 0.82,
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
    shade: 0.72,
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
    shade: 0.72,
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

// Reusable zero-GC TypedArray scratch buffer for chunk meshing!
class MeshBucket {
  constructor(initialVerts = 16384) {
    this.cap = initialVerts;
    this.pos = new Float32Array(initialVerts * 3);
    this.norm = new Float32Array(initialVerts * 3);
    this.uv = new Float32Array(initialVerts * 2);
    this.col = new Float32Array(initialVerts * 3);
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

    const ii = this.iCount;
    const idx = this.idx;
    idx[ii] = base; idx[ii + 1] = base + 1; idx[ii + 2] = base + 2;
    idx[ii + 3] = base; idx[ii + 4] = base + 2; idx[ii + 5] = base + 3;

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
    const idxSlice = this.vCount < 65536
      ? new Uint16Array(this.idx.subarray(0, this.iCount))
      : this.idx.slice(0, this.iCount);
    geo.setIndex(new THREE.BufferAttribute(idxSlice, 1));
    return geo;
  }
}

const SCRATCH_BUCKETS = {
  opaque: new MeshBucket(24576),
  cutout: new MeshBucket(8192),
  staticCutout: new MeshBucket(4096),
  water: new MeshBucket(8192)
};
// Scratch grid for coarse 4x4x4 trilinear cave noise (5 x 25 x 5 = 625 floats)
const CAVE_GRID = new Float32Array(5 * 25 * 5);

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
      uFogFar: { value: 110.0 }
    };

    // 1. Opaque Terrain Material — Atmospheric Aerial Perspective + Golden-Hour Sun Warmth + Emissive Glow
    this.opaqueMat = new THREE.MeshLambertMaterial({
      map: this.textures.atlasTexture,
      vertexColors: true
    });
    this.opaqueMat.onBeforeCompile = (shader) => {
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
        varying vec3 vWorldNorm;
        varying float vEmissive;
      ` + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vWorldPos = position;
         vWorldNorm = normal;
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
        varying vec3 vWorldNorm;
        varying float vEmissive;
      ` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <fog_fragment>',
        `if (uShaderOn > 0.5) {
           // Warm golden-hour rim & gentle contrast lift (BSL look)
           vec3 viewVec = vWorldPos - cameraPosition;
           float dist = length(viewVec);
           vec3 viewDir = viewVec / max(dist, 0.001);
           float sunWrap = max(0.0, dot(normalize(vWorldNorm), normalize(uSunDir)) * 0.65 + 0.35);
           gl_FragColor.rgb *= mix(vec3(1.0), vec3(1.06, 1.01, 0.94), sunWrap * (0.35 + 0.65 * uSunsetFactor) * uDayFactor);

           // Warm torch & glowstone emissive radiance (glows vibrantly day & night!)
           if (vEmissive > 0.01) {
             gl_FragColor.rgb += vec3(1.0, 0.76, 0.30) * vEmissive * 3.1;
           }

           // Sun-directional Atmospheric Aerial Perspective Haze (golden toward sun, misty sky away!)
           float hazeFactor = smoothstep(uFogNear * 0.55, uFogFar, dist);
           float sunAlign = pow(max(0.0, dot(viewDir, normalize(uSunDir))), 3.0);
           vec3 atmFog = mix(uHorizonColor, uSunColor * 1.05, sunAlign * (0.28 + 0.52 * uSunsetFactor) * uDayFactor);
           atmFog = mix(atmFog, uSunsetColor, sunAlign * uSunsetFactor * 0.35);
           gl_FragColor.rgb = mix(gl_FragColor.rgb, atmFog, hazeFactor);
         } else {
           if (vEmissive > 0.01) {
             gl_FragColor.rgb += vec3(1.0, 0.76, 0.30) * vEmissive * 3.1;
           }
           #include <fog_fragment>
         }`
      );
    };

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

    // 3. BSL / Complementary Reflective Rippling Water Shader (replicates Screenshot 2!)
    this.waterMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.shaderUniforms.uTime,
        uCloudTime: this.shaderUniforms.uCloudTime,
        uWaveStrength: this.shaderUniforms.uWaveStrength,
        uSunDir: this.shaderUniforms.uSunDir,
        uTopColor: this.shaderUniforms.uTopColor,
        uMidColor: this.shaderUniforms.uMidColor,
        uHorizonColor: this.shaderUniforms.uHorizonColor,
        uSunsetColor: this.shaderUniforms.uSunsetColor,
        uSunColor: this.shaderUniforms.uSunColor,
        uCloudLitColor: this.shaderUniforms.uCloudLitColor,
        uCloudShadowColor: this.shaderUniforms.uCloudShadowColor,
        uDayFactor: this.shaderUniforms.uDayFactor,
        uSunsetFactor: this.shaderUniforms.uSunsetFactor,
        uRainFactor: this.shaderUniforms.uRainFactor,
        uFogNear: this.shaderUniforms.uFogNear,
        uFogFar: this.shaderUniforms.uFogFar
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      vertexShader: `
        uniform float uTime;
        uniform float uWaveStrength;
        varying vec3 vWorldPos;
        varying vec3 vBaseNormal;
        void main() {
          vec3 pos = position;
          if (uWaveStrength > 0.01 && normal.y > 0.5) {
            float w1 = sin(pos.x * 0.95 + uTime * 2.1 + pos.z * 0.55) * 0.045;
            float w2 = cos(pos.z * 1.25 - uTime * 1.75 + pos.x * 0.4) * 0.032;
            pos.y += (w1 + w2) * uWaveStrength;
          }
          vWorldPos = pos;
          vBaseNormal = normal;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uCloudTime;
        uniform float uWaveStrength;
        uniform vec3 uSunDir;
        uniform vec3 uTopColor;
        uniform vec3 uMidColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uSunsetColor;
        uniform vec3 uSunColor;
        uniform vec3 uCloudLitColor;
        uniform vec3 uCloudShadowColor;
        uniform float uDayFactor;
        uniform float uSunsetFactor;
        uniform float uRainFactor;
        uniform float uFogNear;
        uniform float uFogFar;
        varying vec3 vWorldPos;
        varying vec3 vBaseNormal;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        float noise2D(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }

        float fbmWater(vec2 p) {
          float v = 0.62 * noise2D(p);
          p = mat2(0.80, 0.60, -0.60, 0.80) * p * 2.02 + vec2(17.1, 31.7);
          v += 0.34 * noise2D(p);
          return v;
        }

        // Fast mirror of SkyDome's atmospheric gradient + puffy volumetric clouds!
        vec3 sampleSkyReflection(vec3 dir, vec3 sunDir) {
          float h = clamp(dir.y, 0.0, 1.0);
          float sunDot = max(0.0, dot(dir, sunDir));
          vec3 skyCol = mix(uHorizonColor, uMidColor, smoothstep(0.0, 0.34, h));
          skyCol = mix(skyCol, uTopColor, smoothstep(0.22, 0.92, h));

          float horizonBand = pow(1.0 - h, 3.0);
          float sunSide = sunDot * sunDot;
          skyCol = mix(skyCol, uSunsetColor, horizonBand * (0.3 + 0.62 * sunSide) * uSunsetFactor * (1.0 - uRainFactor * 0.7));

          float twilightArc = smoothstep(0.02, 0.26, h) * (1.0 - smoothstep(0.26, 0.68, h));
          skyCol += vec3(0.28, 0.12, 0.24) * twilightArc * uSunsetFactor * (1.0 - uRainFactor * 0.8);

          float clearAmt = 1.0 - uRainFactor * 0.85;
          float sunVisible = smoothstep(-0.12, 0.05, sunDir.y) * clearAmt;
          float s4 = sunSide * sunSide;
          skyCol += uSunColor * (s4 * s4 * (0.35 + 0.65 * uSunsetFactor) + pow(sunDot, 48.0) * 1.1) * sunVisible;

          if (dir.y > 0.015) {
            vec2 cloudUV = (dir.xz / (dir.y + 0.11)) * 0.42;
            vec2 drift = vec2(uCloudTime * 0.0085, uCloudTime * 0.0032);
            float rawD = fbmWater(cloudUV * 1.15 + drift);
            float thresh = mix(0.49, 0.36, uRainFactor);
            float cAlpha = smoothstep(thresh, thresh + 0.22, rawD) * smoothstep(0.015, 0.18, dir.y) * 0.88;
            vec3 cCol = mix(uCloudShadowColor, uCloudLitColor, clamp(rawD * 1.35 - 0.15, 0.0, 1.0));
            skyCol = mix(skyCol, cCol, cAlpha);
          }
          return skyCol;
        }

        void main() {
          vec3 viewVec = cameraPosition - vWorldPos;
          float dist = length(viewVec);
          vec3 V = viewVec / max(dist, 0.001);
          vec3 sunDir = normalize(uSunDir);

          // Ultra-fast multi-wave silky animated ripple normal
          vec2 p = vWorldPos.xz;
          float t = uTime;
          float r1 = sin(p.x * 1.9 + t * 1.7 + p.y * 0.9) * cos(p.y * 1.6 - t * 1.3);
          float r2 = sin(p.x * 3.7 - t * 2.3 + p.y * 2.5) * 0.6;
          float nWave = noise2D(p * 1.7 + vec2(t * 0.55, -t * 0.42));
          float r3 = (nWave - 0.5) * 1.25;

          float amp = mix(0.02, 0.13, clamp(uWaveStrength, 0.0, 1.2)) * (1.0 - smoothstep(45.0, 130.0, dist) * 0.45);
          vec3 N = normalize(vec3(
            (r1 + r3) * amp,
            1.0,
            (r2 - r3) * amp
          ));
          if (vBaseNormal.y < 0.5) N = normalize(vBaseNormal);

          // Fresnel Mirror Reflection of Live Sky & Clouds!
          float NoV = max(0.0, dot(N, V));
          float oneMinusNoV = 1.0 - NoV;
          float fresnel = clamp(0.10 + 0.90 * oneMinusNoV * oneMinusNoV * oneMinusNoV, 0.10, 0.96);

          vec3 R = reflect(-V, N);
          R.y = max(0.02, abs(R.y));
          vec3 reflCol = sampleSkyReflection(normalize(R), sunDir);

          vec3 deepWater = mix(vec3(0.02, 0.05, 0.10), vec3(0.04, 0.24, 0.34), uDayFactor);
          deepWater = mix(deepWater, vec3(0.14, 0.11, 0.20), uSunsetFactor * 0.55);
          // Reuse nWave for free caustic shimmer (zero extra noise call!)
          deepWater += vec3(0.06, 0.22, 0.26) * (nWave * nWave * nWave) * 0.2 * uDayFactor;

          vec3 col = mix(deepWater, reflCol, fresnel);

          // Sparkling Sun Specular Glitter across the Ripples!
          vec3 H = normalize(V + sunDir);
          float NoH = max(0.0, dot(N, H));
          float specTight = pow(NoH, 160.0) * 2.5;
          float specBroad = pow(NoH, 24.0) * 0.42;
          float sunUp = smoothstep(-0.08, 0.08, sunDir.y) * (1.0 - uRainFactor * 0.85);
          col += uSunColor * (specTight + specBroad) * sunUp;

          // Atmospheric Distance Haze matching Terrain & Sky seamlessly!
          float hazeFactor = smoothstep(uFogNear * 0.55, uFogFar, dist);
          float sunAlign = pow(max(0.0, dot(-V, sunDir)), 3.0);
          vec3 atmFog = mix(uHorizonColor, uSunColor * 1.05, sunAlign * (0.28 + 0.52 * uSunsetFactor) * uDayFactor);
          atmFog = mix(atmFog, uSunsetColor, sunAlign * uSunsetFactor * 0.35);
          col = mix(col, atmFog, hazeFactor);

          float alpha = mix(mix(0.74, 0.96, fresnel), 1.0, hazeFactor);

          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.meshQueue = [];
    this._spiralOffsets = [];
    this._spiralDataOffsets = [];
    this._spiralForRD = -1;

    // Precomputed fast lookup tables for zero-overhead meshing inner loop
    this._defTable = new Array(256);
    this._solidTable = new Uint8Array(256);
    this._transTable = new Uint8Array(256);
    this._uvTable = new Array(256); // [blockId] -> Array(6) of UV objects
    for (let id = 1; id < 256; id++) {
      const def = getBlockDef(id);
      if (!def) continue;
      this._defTable[id] = def;
      this._solidTable[id] = isBlockSolid(id) ? 1 : 0;
      this._transTable[id] = isBlockTransparent(id) ? 1 : 0;
      const faceUVs = new Array(6);
      for (let fi = 0; fi < 6; fi++) {
        const ft = FACES[fi].faceType;
        const texName = def.faces[ft] || def.faces.all || def.faces.side;
        faceUVs[fi] = this.textures.getUV(texName);
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

    // Dynamic Placed Torch & Glowstone Lighting Pool (illuminates ground & walls at night!)
    this.lightSources = new Map(); // "x,y,z" -> { x, y, z, isGlowstone }
    this._lightDirty = true;
    this._lightRefreshTimer = 0;
    this._lightClock = 0;
    this._activeLightSources = [];
    this.torchLightPool = [];
    for (let i = 0; i < 10; i++) {
      const pl = new THREE.PointLight(0xffb44c, 0, 28, 1.0);
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
  }

  // Single-pass combined Biome + Terrain Height sampler (eliminates duplicate 2D fbm calls!)
  sampleColumn(wx, wz) {
    if (this.worldType === 'flat') return { biome: 'Plains', height: 36 };

    const temp = this.biomeNoise.fbm2D(wx * 0.0034, wz * 0.0034, 3);
    const moist = this.moistureNoise.fbm2D(wx * 0.0034, wz * 0.0034, 3);
    const mountField = this.heightNoise.fbm2D(wx * 0.0038 + 50, wz * 0.0038 - 50, 3);

    let biome = 'Plains';
    if (mountField > 0.16) biome = 'Mountains';
    else if (temp > 0.15 && moist < 0.03) biome = 'Desert';
    else if (temp < -0.14) biome = 'Snowy Taiga';
    else if (moist > 0.11) biome = temp > 0.0 ? 'Forest' : 'Birch Forest';

    // 1. Continental elevation + smooth gentle rolling hills
    const cont = this.heightNoise.fbm2D(wx * 0.0042, wz * 0.0042, 4);
    const hills = this.heightNoise.fbm2D(wx * 0.015, wz * 0.015, 3);
    const micro = this.heightNoise.noise2D(wx * 0.048, wz * 0.048) * 1.4;

    // 2. Smooth continuous Mountain Massif Weight (seamless foothills -> high alpine peaks!)
    const mRaw = Math.max(0, Math.min(1, (mountField - 0.02) / 0.34));
    const mSmooth = mRaw * mRaw * (3 - 2 * mRaw);

    let alpineBoost = 0;
    if (mSmooth > 0.001) {
      const warpX = this.biomeNoise.fbm2D(wx * 0.009 + 11, wz * 0.009 - 19, 2) * 28;
      const warpZ = this.moistureNoise.fbm2D(wx * 0.009 - 27, wz * 0.009 + 33, 2) * 28;
      const rx = wx + warpX;
      const rz = wz + warpZ;

      const r1 = 1.0 - Math.abs(this.heightNoise.noise2D(rx * 0.0085, rz * 0.0085) * 1.85);
      const r2 = 1.0 - Math.abs(this.heightNoise.noise2D(rx * 0.019 + 41, rz * 0.019 - 17) * 1.85);
      const r3 = 1.0 - Math.abs(this.heightNoise.noise2D(rx * 0.042 - 13, rz * 0.042 + 29) * 1.85);

      const ridgeA = Math.pow(Math.max(0, r1), 1.75);
      const ridgeB = Math.pow(Math.max(0, r2), 2.0) * (0.35 + 0.65 * ridgeA);
      const ridgeC = Math.pow(Math.max(0, r3), 2.2) * (0.25 + 0.75 * ridgeB);

      const foothill = mSmooth * 10.5;
      const massif = (mSmooth * mSmooth) * (ridgeA * 34.0 + ridgeB * 14.0 + ridgeC * 4.5);
      alpineBoost = foothill + massif;
    }

    // 3. Smooth meandering scenic rivers & natural lakeside basins
    const riverRaw = Math.abs(this.moistureNoise.fbm2D(wx * 0.0052 + 200, wz * 0.0052 - 150, 3));
    const riverT = riverRaw < 0.056 ? (1 - riverRaw / 0.056) : 0;
    const riverCarve = (riverT * riverT * (3 - 2 * riverT)) * 11.5 * (1 - mSmooth * 0.72);

    const pondNoise = this.biomeNoise.fbm2D(wx * 0.011 - 90, wz * 0.011 + 110, 2);
    const pondT = pondNoise < -0.24 ? Math.min(1, (-0.24 - pondNoise) / 0.22) : 0;
    const pondCarve = (pondT * pondT * (3 - 2 * pondT)) * 7.5 * (1 - mSmooth * 0.9);

    // 4. Gentle Plains/Desert flattening + terraced forested meadow hills
    const flatBlend = Math.max(0, Math.min(1, 1 - mSmooth * 1.8));
    const hillAmp = (temp > 0.14 ? 4.0 : 6.4) * flatBlend + 3.0 * mSmooth;
    const terrace = Math.sin(hills * 3.14159) * 0.45 * flatBlend;

    const baseH = SEA_LEVEL + 4.8 + cont * 13.0 + (hills * hillAmp + terrace) + micro + alpineBoost - riverCarve - pondCarve;
    const height = Math.max(8, Math.min(CHUNK_HEIGHT - 8, Math.floor(baseH)));
    return { biome, height };
  }

  getBiomeAt(wx, wz) {
    if (this.worldType === 'flat') return 'Plains';
    const temp = this.biomeNoise.fbm2D(wx * 0.0034, wz * 0.0034, 3);
    const moist = this.moistureNoise.fbm2D(wx * 0.0034, wz * 0.0034, 3);
    const mount = this.heightNoise.fbm2D(wx * 0.0038 + 50, wz * 0.0038 - 50, 3);
    if (mount > 0.16) return 'Mountains';
    if (temp > 0.15 && moist < 0.03) return 'Desert';
    if (temp < -0.14) return 'Snowy Taiga';
    if (moist > 0.11) return temp > 0.0 ? 'Forest' : 'Birch Forest';
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
      if (h < SEA_LEVEL + 2 || h > 52) return false;
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

  // Returns { vcx, vcz, dx, dz, baseY, biome } if chunk (cx, cz) belongs to any 3x3 village!
  getVillageForChunk(cx, cz) {
    if (this.worldType === 'flat') return null;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const vcx = cx - dx;
        const vcz = cz - dz;
        if (this.isVillageCenter(vcx, vcz)) {
          const centerWx = vcx * CHUNK_SIZE + 8;
          const centerWz = vcz * CHUNK_SIZE + 8;
          const biome = this.getBiomeAt(centerWx, centerWz);
          const baseY = this.getTerrainHeight(centerWx, centerWz, biome);
          if (baseY <= SEA_LEVEL + 1 || baseY > 56 || biome === 'Mountains') return null;
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
    const isDesert = biome === 'Desert';
    const isSnow = biome === 'Snowy Taiga';
    const isBirch = biome === 'Birch Forest';

    const wallBlk = isDesert ? BLOCK.SANDSTONE : (isSnow ? BLOCK.SPRUCE_PLANKS : (isBirch ? BLOCK.BIRCH_PLANKS : BLOCK.OAK_PLANKS));
    const logBlk = isDesert ? BLOCK.SANDSTONE : (isSnow ? BLOCK.SPRUCE_LOG : (isBirch ? BLOCK.BIRCH_LOG : BLOCK.OAK_LOG));
    const roofBlk = isDesert ? BLOCK.SANDSTONE : (isSnow ? BLOCK.SPRUCE_LOG : BLOCK.BRICKS);
    const trimBlk = isDesert ? BLOCK.SANDSTONE : BLOCK.STONE_BRICKS;
    const pathBlk = isDesert ? BLOCK.SANDSTONE : BLOCK.GRAVEL;
    const groundBlk = isDesert ? BLOCK.SAND : (isSnow ? BLOCK.SNOW : BLOCK.GRASS);
    const fillBlk = isDesert ? BLOCK.SAND : BLOCK.DIRT;

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
      // Plant a scenic orchard oak tree in the corner yard
      const tx = vdx === -1 ? 12 : 2;
      const tz = vdz === -1 ? 12 : 2;
      if (getLocal(tx, baseY + 1, tz) === BLOCK.AIR) {
        for (let ty = 1; ty <= 4; ty++) setLocal(tx, baseY + ty, tz, BLOCK.OAK_LOG);
        for (let dy = 3; dy <= 5; dy++) {
          const rad = dy === 5 ? 1 : 2;
          for (let ldz = -rad; ldz <= rad; ldz++) {
            for (let ldx = -rad; ldx <= rad; ldx++) {
              if (tx + ldx >= 1 && tx + ldx <= 14 && tz + ldz >= 1 && tz + ldz <= 14) {
                if (getLocal(tx + ldx, baseY + dy, tz + ldz) === BLOCK.AIR) {
                  setLocal(tx + ldx, baseY + dy, tz + ldz, BLOCK.OAK_LEAVES);
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

    // Precompute coarse 4x4x4 3D cave noise grid (~400 samples instead of ~9,000 = 15x faster!)
    const isFlat = this.worldType === 'flat';
    const maxCaveCellY = isFlat ? 0 : Math.min(24, Math.ceil((chunkPeakH - 2) / 4));
    if (!isFlat) {
      for (let cy = 0; cy <= maxCaveCellY; cy++) {
        const wy = cy * 4;
        const yBase = cy * 25;
        for (let czg = 0; czg < 5; czg++) {
          const wz = oz + czg * 4;
          const zBase = yBase + czg * 5;
          for (let cxg = 0; cxg < 5; cxg++) {
            const wx = ox + cxg * 4;
            CAVE_GRID[zBase + cxg] = this.caveNoise.noise3D(wx * 0.065, wy * 0.085, wz * 0.065);
          }
        }
      }
    }

    // 1. Base Terrain + Realistic Slope-Aware Alpine Geology + Trilinear 3D Caves
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

        data[colBase] = BLOCK.BEDROCK;

        const caveMaxY = h - 3;
        for (let y = 1; y <= h; y++) {
          if (!isFlat && y > 3 && y < caveMaxY) {
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

            const c00 = CAVE_GRID[i000] + (CAVE_GRID[i100] - CAVE_GRID[i000]) * fx;
            const c10 = CAVE_GRID[i010] + (CAVE_GRID[i110] - CAVE_GRID[i010]) * fx;
            const c01 = CAVE_GRID[i001] + (CAVE_GRID[i101] - CAVE_GRID[i001]) * fx;
            const c11 = CAVE_GRID[i011] + (CAVE_GRID[i111] - CAVE_GRID[i011]) * fx;
            const c0 = c00 + (c10 - c00) * fz;
            const c1 = c01 + (c11 - c01) * fz;
            if (c0 + (c1 - c0) * fy > 0.34) continue; // AIR (already 0!)
          }

          let blk;
          if (y === h) {
            if (h < SEA_LEVEL + 1 && !isFlat) {
              blk = (slope >= 2 && biome === 'Mountains') ? BLOCK.GRAVEL : BLOCK.SAND;
            } else if (biome === 'Desert') {
              blk = BLOCK.SAND;
            } else if (slope >= 3 && h > SEA_LEVEL + 5) {
              blk = BLOCK.STONE;
            } else if (h >= 58 || (biome === 'Snowy Taiga' && slope <= 2)) {
              blk = BLOCK.SNOW;
            } else if (h >= 52 && slope >= 2) {
              blk = coordHash(wx, wz, this.seed + 41) > 0.65 ? BLOCK.GRAVEL : BLOCK.STONE;
            } else {
              blk = BLOCK.GRASS;
            }
          } else if (y >= h - 3) {
            if (biome === 'Desert') blk = y >= h - 2 ? BLOCK.SAND : BLOCK.SANDSTONE;
            else if (slope >= 3 || h >= 54) blk = BLOCK.STONE;
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

    // 1b. Authentic Deterministic Minecraft Ore Veins (100x faster than 8,000 noise3D calls!)
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
      placeVeins(BLOCK.COAL_ORE, 10, 6, 48, 7, 101);
      placeVeins(BLOCK.IRON_ORE, 9, 4, 42, 6, 202);
      placeVeins(BLOCK.GOLD_ORE, 4, 3, 25, 5, 303);
      placeVeins(BLOCK.DIAMOND_ORE, 3, 2, 15, 4, 404);
    }

    // 2. Multi-Chunk Villages, Scenic Hilltop Watchtowers, OR Trees, Cacti, Lush Meadows & Wildflowers
    const vInfo = this.getVillageForChunk(cx, cz);
    const isWatchtowerChunk =
      this.worldType !== 'flat' &&
      !vInfo &&
      ((cx % 9) + 9) % 9 === 5 &&
      ((cz % 9) + 9) % 9 === 4 &&
      coordHash(cx * 31, cz * 29, this.seed + 777) > 0.45;

    if (vInfo) {
      this.buildVillageDistrict(cx, cz, ox, oz, heights, setLocal, getLocal, vInfo);
    } else if (isWatchtowerChunk) {
      const th = heights[8 + 8 * CHUNK_SIZE];
      const tb = biomes[8 + 8 * CHUNK_SIZE];
      if (th > SEA_LEVEL + 3 && th < CHUNK_HEIGHT - 18 && tb !== 'Desert') {
        // Scenic Stone-Brick Watchtower Keep with Battlements & Treasure Chest!
        const x0 = 5, z0 = 5, w = 6, hT = 10;
        for (let dz = 0; dz < w; dz++) {
          for (let dx = 0; dx < w; dx++) {
            for (let y = th - 3; y <= th; y++) setLocal(x0 + dx, y, z0 + dz, BLOCK.COBBLESTONE);
            for (let dy = 1; dy <= hT; dy++) {
              const edgeX = dx === 0 || dx === w - 1;
              const edgeZ = dz === 0 || dz === w - 1;
              if (edgeX && edgeZ) {
                setLocal(x0 + dx, th + dy, z0 + dz, BLOCK.STONE_BRICKS);
              } else if (edgeX || edgeZ) {
                const isWin = (dy === 4 || dy === 8) && (dx === 2 || dx === 3 || dz === 2 || dz === 3);
                setLocal(x0 + dx, th + dy, z0 + dz, isWin ? BLOCK.GLASS : (dy % 2 === 0 ? BLOCK.STONE_BRICKS : BLOCK.COBBLESTONE));
              } else {
                setLocal(x0 + dx, th + dy, z0 + dz, dy === 5 || dy === hT ? BLOCK.OAK_PLANKS : BLOCK.AIR);
              }
            }
            // Battlements
            if (dx === 0 || dx === w - 1 || dz === 0 || dz === w - 1) {
              if ((dx + dz) % 2 === 0) setLocal(x0 + dx, th + hT + 1, z0 + dz, BLOCK.STONE_BRICKS);
            }
          }
        }
        // Doorway + Glowing Corner Lanterns + Treasure Chest
        setLocal(x0 + 2, th + 1, z0, BLOCK.AIR);
        setLocal(x0 + 2, th + 2, z0, BLOCK.AIR);
        setLocal(x0, th + hT + 2, z0, BLOCK.GLOWSTONE);
        setLocal(x0 + w - 1, th + hT + 2, z0 + w - 1, BLOCK.GLOWSTONE);
        setLocal(x0 + 3, th + 1, z0 + 3, BLOCK.CHEST);
        const wKey = `${ox + x0 + 3},${th + 1},${oz + z0 + 3}`;
        if (!this.chests.has(wKey)) {
          const loot = new Array(27).fill(null);
          loot[0] = { id: 'emerald', count: 5 };
          loot[1] = { id: 'iron_sword', count: 1, durability: 251 };
          loot[2] = { id: 'diamond', count: 2 };
          loot[3] = { id: 'bread', count: 6 };
          loot[4] = { id: 'torch', count: 16 };
          this.chests.set(wKey, loot);
        }
      }
    }

    if (this.worldType !== 'flat' && !vInfo) {
      for (let lz = 2; lz < CHUNK_SIZE - 2; lz++) {
        for (let lx = 2; lx < CHUNK_SIZE - 2; lx++) {
          const wx = ox + lx;
          const wz = oz + lz;
          const h = heights[lx + lz * CHUNK_SIZE];
          const biome = biomes[lx + lz * CHUNK_SIZE];
          const topBlock = getLocal(lx, h, lz);
          if (h <= SEA_LEVEL || h >= CHUNK_HEIGHT - 12) continue;
          if (getLocal(lx, h + 1, lz) !== BLOCK.AIR) continue;

          const r = coordHash(wx, wz, this.seed + 77);
          const treeChance =
            biome === 'Forest' ? 0.052 :
            biome === 'Birch Forest' ? 0.048 :
            biome === 'Snowy Taiga' ? 0.042 :
            biome === 'Plains' ? 0.0085 : 0;

          if (r < treeChance && (topBlock === BLOCK.GRASS || topBlock === BLOCK.SNOW)) {
            const mixedBirch = biome === 'Forest' && coordHash(wx, wz, this.seed + 61) > 0.78;
            const logType =
              (biome === 'Birch Forest' || mixedBirch) ? BLOCK.BIRCH_LOG :
              biome === 'Snowy Taiga' ? BLOCK.SPRUCE_LOG : BLOCK.OAK_LOG;
            const leafType =
              (biome === 'Birch Forest' || mixedBirch) ? BLOCK.BIRCH_LEAVES :
              biome === 'Snowy Taiga' ? BLOCK.SPRUCE_LEAVES : BLOCK.OAK_LEAVES;

            const styleR = coordHash(wx, wz, this.seed + 88);
            if (biome === 'Snowy Taiga') {
              // Tall conical Alpine Spruce
              const trunkH = 6 + Math.floor(styleR * 3);
              for (let ty = 1; ty <= trunkH; ty++) setLocal(lx, h + ty, lz, logType);
              for (let dy = 2; dy <= trunkH + 2; dy++) {
                const rad = dy >= trunkH + 1 ? 0 : (dy >= trunkH - 1 ? 1 : (dy % 2 === 0 ? 2 : 1));
                for (let dz = -rad; dz <= rad; dz++) {
                  for (let dx = -rad; dx <= rad; dx++) {
                    if (dx === 0 && dz === 0 && dy <= trunkH) continue;
                    if (rad === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
                    if (getLocal(lx + dx, h + dy, lz + dz) === BLOCK.AIR) {
                      setLocal(lx + dx, h + dy, lz + dz, leafType);
                    }
                  }
                }
              }
            } else if (logType === BLOCK.OAK_LOG && styleR > 0.72 && lx >= 3 && lx <= CHUNK_SIZE - 4 && lz >= 3 && lz <= CHUNK_SIZE - 4) {
              // Grand Lush Oak Tree (wide natural canopy!)
              const trunkH = 6 + Math.floor((styleR - 0.72) * 8);
              for (let ty = 1; ty <= trunkH; ty++) setLocal(lx, h + ty, lz, logType);
              for (let dy = trunkH - 2; dy <= trunkH + 3; dy++) {
                const rad = (dy === trunkH + 3) ? 1 : (dy === trunkH - 2 || dy === trunkH + 2 ? 2 : 3);
                for (let dz = -rad; dz <= rad; dz++) {
                  for (let dx = -rad; dx <= rad; dx++) {
                    if (dx === 0 && dz === 0 && dy <= trunkH) continue;
                    if (dx * dx + dz * dz > rad * rad + 1) continue;
                    if (getLocal(lx + dx, h + dy, lz + dz) === BLOCK.AIR) {
                      setLocal(lx + dx, h + dy, lz + dz, leafType);
                    }
                  }
                }
              }
            } else {
              // Classic Oak / Birch Tree
              const trunkH = 4 + Math.floor(styleR * 3);
              for (let ty = 1; ty <= trunkH; ty++) setLocal(lx, h + ty, lz, logType);
              for (let dy = trunkH - 1; dy <= trunkH + 2; dy++) {
                const rad = dy >= trunkH + 1 ? 1 : 2;
                for (let dz = -rad; dz <= rad; dz++) {
                  for (let dx = -rad; dx <= rad; dx++) {
                    if (dx === 0 && dz === 0 && dy <= trunkH) continue;
                    if (Math.abs(dx) === rad && Math.abs(dz) === rad && dy === trunkH + 2) continue;
                    if (getLocal(lx + dx, h + dy, lz + dz) === BLOCK.AIR) {
                      setLocal(lx + dx, h + dy, lz + dz, leafType);
                    }
                  }
                }
              }
            }
          } else if (biome === 'Desert' && topBlock === BLOCK.SAND && r < 0.012) {
            const ch = 2 + Math.floor(coordHash(wx, wz, this.seed + 99) * 3);
            for (let cy = 1; cy <= ch; cy++) setLocal(lx, h + cy, lz, BLOCK.CACTUS);
          } else if (topBlock === BLOCK.GRASS) {
            // Lush swaying meadow patches & clustered wildflowers (like Screenshot 1!)
            const meadowPatch = this.moistureNoise.noise2D(wx * 0.09, wz * 0.09);
            const grassThresh = biome === 'Plains' ? (meadowPatch > 0.0 ? 0.66 : 0.84) : 0.78;
            if (r > grassThresh) {
              if (r > 0.978) setLocal(lx, h + 1, lz, BLOCK.FLOWER_RED);
              else if (r > 0.955) setLocal(lx, h + 1, lz, BLOCK.FLOWER_YELLOW);
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
    if (blockId === BLOCK.TORCH || blockId === BLOCK.GLOWSTONE) {
      this.lightSources.set(bKey, { x, y, z, isGlowstone: blockId === BLOCK.GLOWSTONE });
      this._lightDirty = true;
    } else if (this.lightSources.delete(bKey)) {
      this._lightDirty = true;
    }

    const cx = x >> 4;
    const cz = z >> 4;
    const chunk = this.chunks.get(this.chunkKey(cx, cz));
    if (!chunk) return;

    const lx = x & 15;
    const lz = z & 15;
    chunk.data[lx + (lz << 4) + (y << 8)] = blockId;
    if (blockId !== 0 && y > chunk.maxY) chunk.maxY = y;
    this.markDirty(cx, cz);

    // Neighbor chunks if on edge
    if (lx === 0) this.markDirty(cx - 1, cz);
    if (lx === CHUNK_SIZE - 1) this.markDirty(cx + 1, cz);
    if (lz === 0) this.markDirty(cx, cz - 1);
    if (lz === CHUNK_SIZE - 1) this.markDirty(cx, cz + 1);
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

    for (let y = 0; y <= yLimit; y++) {
      const yOff = y << 8;
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const zOff = lz << 4;
        const wz = oz + lz;
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const id = data[lx + zOff + yOff];
          if (id === 0) continue;
          const def = defTable[id];
          if (!def) continue;

          const wx = ox + lx;

          // Register light-emitting blocks (placed OR generated village torches / glowstone!)
          if (id === BLOCK.TORCH || id === BLOCK.GLOWSTONE) {
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
            // Local coordinates: u = across width [0..1], v = along length from join edge (0) to outer end (1)
            const addBedOriented = (u0, y0, v0, u1, y1, v1, uTop, uSide, uBot) => {
              // dir is toward Head; partner is at (dx, dz). So join edge is toward (dx, dz) and outer edge is away!
              let x0, x1, z0, z1;
              if (info.dx === 0 && info.dz === -1) {
                // Partner is at -Z (join at z=0, outer at z=1)
                x0 = u0; x1 = u1; z0 = v0; z1 = v1;
              } else if (info.dx === 0 && info.dz === 1) {
                // Partner is at +Z (join at z=1, outer at z=0)
                x0 = u0; x1 = u1; z0 = 1 - v1; z1 = 1 - v0;
              } else if (info.dx === 1 && info.dz === 0) {
                // Partner is at +X (join at x=1, outer at x=0)
                x0 = 1 - v1; x1 = 1 - v0; z0 = u0; z1 = u1;
              } else {
                // Partner is at -X (join at x=0, outer at x=1)
                x0 = v0; x1 = v1; z0 = u0; z1 = u1;
              }
              addBox(x0, y0, z0, x1, y1, z1, uTop, uSide, uBot);
            };

            // 1. Sturdy Oak Bedframe Base (seamless join at v=0, clean 0.96 width!)
            addBedOriented(0.02, 0.20, 0.0, 0.98, 0.34, 0.98, bedWoodUV, bedWoodUV, bedWoodUV);
            // 2. Two Oak Legs at the outer corners of this half
            addBedOriented(0.04, 0.0, 0.80, 0.22, 0.20, 0.96, bedWoodUV, bedWoodUV, bedWoodUV);
            addBedOriented(0.78, 0.0, 0.80, 0.96, 0.20, 0.96, bedWoodUV, bedWoodUV, bedWoodUV);

            if (info.isHead) {
              // HEAD HALF: Red blanket meeting join + folded white sheet + plush raised white pillow + oak headboard!
              addBedOriented(0.02, 0.34, 0.0, 0.98, 0.56, 0.32, bedRedUV, bedRedUV, bedWoodUV);
              addBedOriented(0.02, 0.34, 0.32, 0.98, 0.57, 0.94, bedWhiteUV, bedWhiteUV, bedWoodUV);
              // Raised sculpted fluffy white pillow!
              addBedOriented(0.10, 0.57, 0.44, 0.90, 0.69, 0.88, bedWhiteUV, bedWhiteUV, bedWhiteUV);
              // Subtle oak headboard rim at outer head end
              addBedOriented(0.02, 0.34, 0.92, 0.98, 0.66, 0.98, bedWoodUV, bedWoodUV, bedWoodUV);
            } else {
              // FOOT HALF: Full plush quilted crimson wool blanket + subtle footboard trim!
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
              // Automatically attach & angle off an adjacent solid wall block!
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
              // Top & Bottom
              bOpaque.pushQuad(bx01,by1,bz11,uv.u0,uv.v0,sTop, bx11,by1,bz11,uv.u1,uv.v0,sTop, bx11,by1,bz01,uv.u1,uv.v1,sTop, bx01,by1,bz01,uv.u0,uv.v1,sTop, 0,1,0);
              bOpaque.pushQuad(bx00,by0,bz00,uv.u0,uv.v0,sBot, bx10,by0,bz00,uv.u1,uv.v0,sBot, bx10,by0,bz10,uv.u1,uv.v1,sBot, bx00,by0,bz10,uv.u0,uv.v1,sBot, 0,-1,0);
              // +X & -X sides
              bOpaque.pushQuad(bx10,by0,bz10,uv.u0,uv.v0,sSide, bx10,by0,bz00,uv.u1,uv.v0,sSide, bx11,by1,bz01,uv.u1,uv.v1,sSide, bx11,by1,bz11,uv.u0,uv.v1,sSide, 1,0,0);
              bOpaque.pushQuad(bx00,by0,bz00,uv.u0,uv.v0,sSide, bx00,by0,bz10,uv.u1,uv.v0,sSide, bx01,by1,bz11,uv.u1,uv.v1,sSide, bx01,by1,bz01,uv.u0,uv.v1,sSide, -1,0,0);
              // +Z & -Z sides
              bOpaque.pushQuad(bx00,by0,bz10,uv.u0,uv.v0,sSide * 0.94, bx10,by0,bz10,uv.u1,uv.v0,sSide * 0.94, bx11,by1,bz11,uv.u1,uv.v1,sSide * 0.94, bx01,by1,bz11,uv.u0,uv.v1,sSide * 0.94, 0,0,1);
              bOpaque.pushQuad(bx10,by0,bz00,uv.u0,uv.v0,sSide * 0.94, bx00,by0,bz00,uv.u1,uv.v0,sSide * 0.94, bx01,by1,bz01,uv.u1,uv.v1,sSide * 0.94, bx11,by1,bz01,uv.u0,uv.v1,sSide * 0.94, 0,0,-1);
            };

            const woodUV = this._torchWoodUV;
            const coalUV = this._torchCoalUV;
            const glowUV = this._torchGlowUV;
            // 1. Grounded Oak Base Foot (on floor torches)
            if (hasFloor) {
              addTorchBox(0.39, 0.0, 0.39, 0.61, 0.06, 0.61, woodUV, 0.9, 0.78, 0.58);
            }
            // 2. Sturdy Oak Wooden Handle Shaft
            addTorchBox(0.425, 0.0, 0.425, 0.575, 0.54, 0.575, woodUV, 0.95, 0.86, 0.62);
            // 3. Dark Charred Coal/Iron Ember Collar
            addTorchBox(0.405, 0.53, 0.405, 0.595, 0.63, 0.595, coalUV, 0.55, 0.46, 0.38);
            // 4. Glowing Amber-Orange Torch Head (emissive!)
            addTorchBox(0.415, 0.63, 0.415, 0.585, 0.77, 0.585, glowUV, 1.54, 1.48, 1.32);
            // 5. Blazing Sculpted Inner Flame Core & Tapered Crown Tip (super-emissive!)
            addTorchBox(0.445, 0.77, 0.445, 0.555, 0.88, 0.555, glowUV, 1.72, 1.66, 1.5);
            addTorchBox(0.47, 0.88, 0.47, 0.53, 0.96, 0.53, glowUV, 1.82, 1.76, 1.6);
            continue;
          }

          // Cross-quad blocks (flowers, tall grass sway; ladders stay static!)
          if (def.cross) {
            const isStaticCross = id === BLOCK.TORCH || id === BLOCK.LADDER;
            const b = isStaticCross ? bStatic : bCutout;
            const uv = uvTable[id][0];
            const shade = def.light > 0 ? 1.18 : 0.94;
            const y0 = y + (isStaticCross ? 0.0 : 0.02);
            const y1 = y + 0.9;
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

          const isWater = id === BLOCK.WATER;
          const isStaticCutout = id === BLOCK.GLASS || id === BLOCK.ICE;
          const isCutout = !isWater && !isStaticCutout && def.transparent;
          const b = isWater
            ? bWater
            : (isStaticCutout ? bStatic : (isCutout ? bCutout : bOpaque));
          const waterTopLower = isWater && fastGet(lx, y + 1, lz) !== BLOCK.WATER;
          const faceUVs = uvTable[id];
          const lightBoost = def.light > 0 ? 1.18 : 1.0;

          for (let fi = 0; fi < 6; fi++) {
            const face = FACES[fi];
            const dx0 = face.dir[0];
            const dy0 = face.dir[1];
            const dz0 = face.dir[2];
            const nlx = lx + dx0;
            const ny = y + dy0;
            const nlz = lz + dz0;
            const neighbor = fastGet(nlx, ny, nlz);

            // Fast culling via lookup table
            if (isWater) {
              if (neighbor === BLOCK.WATER || (neighbor !== 0 && transTable[neighbor] === 0)) continue;
            } else if (isCutout || isStaticCutout) {
              if (neighbor === id && isStaticCutout) continue;
              if (neighbor !== 0 && transTable[neighbor] === 0) continue;
            } else {
              if (neighbor !== 0 && transTable[neighbor] === 0) continue;
            }

            const uv = faceUVs[fi];
            const c0 = face.corners[0];
            const c1 = face.corners[1];
            const c2 = face.corners[2];
            const c3 = face.corners[3];
            const baseShade = face.shade * lightBoost;

            let s0, s1, s2, s3;
            if (isWater || fi === 1) {
              const s = baseShade > 1.2 ? 1.2 : baseShade;
              s0 = s1 = s2 = s3 = s;
            } else if (fi === 0) {
              // Top face AO (inlined!)
              const y1 = y + 1;
              const calcTop = (cx0, cz0) => {
                const ddx = cx0 === 0 ? -1 : 1;
                const ddz = cz0 === 0 ? -1 : 1;
                const occ = solidTable[fastGet(lx + ddx, y1, lz)]
                  + solidTable[fastGet(lx, y1, lz + ddz)]
                  + solidTable[fastGet(lx + ddx, y1, lz + ddz)];
                const v = baseShade * (1.0 - occ * 0.12);
                return v > 1.2 ? 1.2 : v;
              };
              s0 = calcTop(c0[0], c0[2]);
              s1 = calcTop(c1[0], c1[2]);
              s2 = calcTop(c2[0], c2[2]);
              s3 = calcTop(c3[0], c3[2]);
            } else {
              // Side face AO (inlined!)
              const calcSide = (cx0, cy0, cz0) => {
                const ddy = cy0 === 0 ? -1 : 1;
                const sdx = dx0 === 0 ? (cx0 === 0 ? -1 : 1) : 0;
                const sdz = dz0 === 0 ? (cz0 === 0 ? -1 : 1) : 0;
                const occ = solidTable[fastGet(nlx, y + ddy, nlz)]
                  + solidTable[fastGet(nlx + sdx, y, nlz + sdz)]
                  + solidTable[fastGet(nlx + sdx, y + ddy, nlz + sdz)];
                const v = baseShade * (1.0 - occ * 0.12);
                return v > 1.2 ? 1.2 : v;
              };
              s0 = calcSide(c0[0], c0[1], c0[2]);
              s1 = calcSide(c1[0], c1[1], c1[2]);
              s2 = calcSide(c2[0], c2[1], c2[2]);
              s3 = calcSide(c3[0], c3[1], c3[2]);
            }

            const py0 = (waterTopLower && c0[1] === 1) ? y + 0.88 : y + c0[1];
            const py1 = (waterTopLower && c1[1] === 1) ? y + 0.88 : y + c1[1];
            const py2 = (waterTopLower && c2[1] === 1) ? y + 0.88 : y + c2[1];
            const py3 = (waterTopLower && c3[1] === 1) ? y + 0.88 : y + c3[1];

            b.pushQuad(
              wx + c0[0], py0, wz + c0[2], c0[3] ? uv.u1 : uv.u0, c0[4] ? uv.v1 : uv.v0, s0,
              wx + c1[0], py1, wz + c1[2], c1[3] ? uv.u1 : uv.u0, c1[4] ? uv.v1 : uv.v0, s1,
              wx + c2[0], py2, wz + c2[2], c2[3] ? uv.u1 : uv.u0, c2[4] ? uv.v1 : uv.v0, s2,
              wx + c3[0], py3, wz + c3[2], c3[3] ? uv.u1 : uv.u0, c3[4] ? uv.v1 : uv.v0, s3,
              dx0, dy0, dz0
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
      mesh.castShadow = shadows && this.shaderMode === 'ultra';
      mesh.receiveShadow = (shadows || mat === this.cutoutMat) && this.shaderMode === 'ultra';
      this.group.add(mesh);
      chunk.meshes.push(mesh);
    };

    addBucket(bOpaque, this.opaqueMat, 0, true);
    addBucket(bCutout, this.cutoutMat, 1, false);
    addBucket(bStatic, this.staticCutoutMat, 1, false);
    addBucket(bWater, this.waterMat, 2, false);
    if (chunk.lightKeys.length > 0) this._lightDirty = true;
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

  updateChunksAround(px, pz, maxBuildsPerFrame = 2, budgetMs = 4.0) {
    const pcx = Math.floor(px / CHUNK_SIZE);
    const pcz = Math.floor(pz / CHUNK_SIZE);
    const r = this.renderDistance;
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
      const genBudget = budgetMs * 0.52;

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

    // 3. Only check unload when crossing a chunk border!
    if (movedChunk) {
      const unloadR = r + 3;
      const unloadSq = unloadR * unloadR;
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
        }
      }
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
    for (let y = CHUNK_HEIGHT - 2; y >= 1; y--) {
      const b = this.getBlock(x, y, z);
      if (b !== BLOCK.AIR && !isBlockCross(b)) return y + 1;
    }
    return SEA_LEVEL + 4;
  }

  // DDA Voxel Raycast
  raycast(origin, dir, maxDist = 5.5) {
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
      if (blockId !== BLOCK.AIR && blockId !== BLOCK.WATER) {
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

      const maxDistSq = 34 * 34;
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
        pl.position.set(s.x + 0.5, s.y + (s.isGlowstone ? 0.6 : 1.15), s.z + 0.5);
        const phase = s.x * 1.7 + s.z * 2.3 + s.y * 0.9;
        const flicker = s.isGlowstone
          ? Math.sin(t * 3.5 + phase) * 0.12
          : Math.sin(t * 8.5 + phase) * 0.28 + Math.cos(t * 15.2 + phase * 1.3) * 0.14;
        // Rich warm light during dusk/day, and dramatically brighter & wider at night!
        const baseIntensity = s.isGlowstone
          ? (4.8 + nightFactor * 7.2)
          : (4.0 + nightFactor * 6.8);
        pl.intensity = Math.max(0.5, baseIntensity + flicker);
        pl.distance = 24 + nightFactor * 8;
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
    this.lightSources.clear();
    this._activeLightSources = [];
    this.scene.remove(this.group);
  }
}
