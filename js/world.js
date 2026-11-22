import * as THREE from 'three';
import { BLOCK, getBlockDef, isBlockTransparent, isBlockCross, isBlockLiquid, isBlockSolid } from './blocks.js';
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

           // Warm torch & glowstone emissive radiance
           if (vEmissive > 0.01) {
             gl_FragColor.rgb += vec3(1.0, 0.72, 0.32) * vEmissive * 2.4;
           }

           // Sun-directional Atmospheric Aerial Perspective Haze (golden toward sun, misty sky away!)
           float hazeFactor = smoothstep(uFogNear * 0.55, uFogFar, dist);
           float sunAlign = pow(max(0.0, dot(viewDir, normalize(uSunDir))), 3.0);
           vec3 atmFog = mix(uHorizonColor, uSunColor * 1.05, sunAlign * (0.28 + 0.52 * uSunsetFactor) * uDayFactor);
           atmFog = mix(atmFog, uSunsetColor, sunAlign * uSunsetFactor * 0.35);
           gl_FragColor.rgb = mix(gl_FragColor.rgb, atmFog, hazeFactor);
         } else {
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
  getTerrainHeight(wx, wz, biome = null) {
    if (this.worldType === 'flat') return 36;

    // 1. Continental elevation + smooth gentle rolling hills
    const cont = this.heightNoise.fbm2D(wx * 0.0042, wz * 0.0042, 4);
    const hills = this.heightNoise.fbm2D(wx * 0.015, wz * 0.015, 3);
    const micro = this.heightNoise.noise2D(wx * 0.048, wz * 0.048) * 1.4;

    // 2. Smooth continuous Mountain Massif Weight (seamless foothills -> high alpine peaks!)
    const mountField = this.heightNoise.fbm2D(wx * 0.0038 + 50, wz * 0.0038 - 50, 3);
    const mRaw = Math.max(0, Math.min(1, (mountField - 0.02) / 0.34));
    const mSmooth = mRaw * mRaw * (3 - 2 * mRaw); // smoothstep

    // Domain warp bends mountain ridgelines into realistic sweeping alpine ranges & valleys!
    let alpineBoost = 0;
    if (mSmooth > 0.001) {
      const warpX = this.biomeNoise.fbm2D(wx * 0.009 + 11, wz * 0.009 - 19, 2) * 28;
      const warpZ = this.moistureNoise.fbm2D(wx * 0.009 - 27, wz * 0.009 + 33, 2) * 28;
      const rx = wx + warpX;
      const rz = wz + warpZ;

      // 3-octave eroded ridged multifractal (broad massif + sharp sweeping ridges + rocky crags)
      const r1 = 1.0 - Math.abs(this.heightNoise.noise2D(rx * 0.0085, rz * 0.0085) * 1.85);
      const r2 = 1.0 - Math.abs(this.heightNoise.noise2D(rx * 0.019 + 41, rz * 0.019 - 17) * 1.85);
      const r3 = 1.0 - Math.abs(this.heightNoise.noise2D(rx * 0.042 - 13, rz * 0.042 + 29) * 1.85);

      const ridgeA = Math.pow(Math.max(0, r1), 1.75);
      const ridgeB = Math.pow(Math.max(0, r2), 2.0) * (0.35 + 0.65 * ridgeA); // erosion weighting!
      const ridgeC = Math.pow(Math.max(0, r3), 2.2) * (0.25 + 0.75 * ridgeB);

      const foothill = mSmooth * 10.5;
      const massif = (mSmooth * mSmooth) * (ridgeA * 34.0 + ridgeB * 14.0 + ridgeC * 4.5);
      alpineBoost = foothill + massif;
    }

    // 3. Smooth meandering scenic rivers & natural lakeside basins (like classic Minecraft!)
    const riverRaw = Math.abs(this.moistureNoise.fbm2D(wx * 0.0052 + 200, wz * 0.0052 - 150, 3));
    const riverT = riverRaw < 0.056 ? (1 - riverRaw / 0.056) : 0;
    const riverCarve = (riverT * riverT * (3 - 2 * riverT)) * 11.5 * (1 - mSmooth * 0.72);

    // Occasional scenic meadow ponds / lake clearings in flat lowlands
    const pondNoise = this.biomeNoise.fbm2D(wx * 0.011 - 90, wz * 0.011 + 110, 2);
    const pondT = pondNoise < -0.24 ? Math.min(1, (-0.24 - pondNoise) / 0.22) : 0;
    const pondCarve = (pondT * pondT * (3 - 2 * pondT)) * 7.5 * (1 - mSmooth * 0.9);

    // 4. Gentle Plains/Desert flattening + terraced forested meadow hills
    const temp = this.biomeNoise.fbm2D(wx * 0.0034, wz * 0.0034, 3);
    const flatBlend = Math.max(0, Math.min(1, 1 - mSmooth * 1.8));
    const hillAmp = (temp > 0.14 ? 4.0 : 6.4) * flatBlend + 3.0 * mSmooth;
    // Subtle Minecraft-style natural meadow terracing on moderate hills
    const terrace = Math.sin(hills * 3.14159) * 0.45 * flatBlend;

    const baseH = SEA_LEVEL + 4.8 + cont * 13.0 + (hills * hillAmp + terrace) + micro + alpineBoost - riverCarve - pondCarve;
    return Math.max(8, Math.min(CHUNK_HEIGHT - 8, Math.floor(baseH)));
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
  buildVillageDistrict(cx, cz, ox, oz, heights, setLocal, vInfo) {
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

      // Interior Furnishings: Torches, REAL 3D BEDS, Crafting Table, Bookshelves, Furnace & Chest!
      setLocal(x0 + 1, baseY + 2, z0 + 1, BLOCK.TORCH);
      if (beds >= 1) setLocal(x0 + 1, baseY + 1, z0 + 1, BLOCK.BED);
      if (beds >= 2 && w >= 6) setLocal(x0 + 2, baseY + 1, z0 + 1, BLOCK.BED);
      if (twoStory) {
        for (let ly = 1; ly <= h + 1; ly++) setLocal(x0 + 1, baseY + ly, z0 + d - 2, BLOCK.LADDER);
        setLocal(x0 + 2, baseY + h + 2, z0 + 1, BLOCK.BED);
        setLocal(x0 + 1, baseY + h + 3, z0 + 1, BLOCK.TORCH);
      }
      if (furnace) setLocal(x0 + w - 2, baseY + 1, z0 + d - 2, BLOCK.FURNACE);
      else setLocal(x0 + w - 2, baseY + 1, z0 + d - 2, BLOCK.CRAFTING_TABLE);

      if (library) {
        for (let bx = x0 + 1; bx <= x0 + w - 2; bx++) {
          setLocal(bx, baseY + 1, z0 + 1, BLOCK.BOOKSHELF);
          setLocal(bx, baseY + 2, z0 + 1, BLOCK.BOOKSHELF);
        }
        setLocal(x0 + 1, baseY + 1, z0 + d - 2, BLOCK.BED);
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
      setLocal(11, baseY + 1, 2, BLOCK.BED);

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
    const biomes = new Array(CHUNK_SIZE * CHUNK_SIZE);

    // Precompute heightmap & biome map first so we can calculate real local terrain slope!
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = ox + lx;
        const wz = oz + lz;
        const biome = this.getBiomeAt(wx, wz);
        biomes[lx + lz * CHUNK_SIZE] = biome;
        heights[lx + lz * CHUNK_SIZE] = this.getTerrainHeight(wx, wz, biome);
      }
    }

    // 1. Base Terrain + Realistic Slope-Aware Alpine Geology + Caves + Ores
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = ox + lx;
        const wz = oz + lz;
        const idx2 = lx + lz * CHUNK_SIZE;
        const biome = biomes[idx2];
        const h = heights[idx2];

        // Local terrain slope for realistic rocky cliffs & snow caps!
        const hL = lx > 0 ? heights[idx2 - 1] : this.getTerrainHeight(wx - 1, wz);
        const hR = lx < 15 ? heights[idx2 + 1] : this.getTerrainHeight(wx + 1, wz);
        const hD = lz > 0 ? heights[idx2 - CHUNK_SIZE] : this.getTerrainHeight(wx, wz - 1);
        const hU = lz < 15 ? heights[idx2 + CHUNK_SIZE] : this.getTerrainHeight(wx, wz + 1);
        const slope = Math.max(Math.abs(h - hL), Math.abs(h - hR), Math.abs(h - hD), Math.abs(h - hU));

        for (let y = 0; y < CHUNK_HEIGHT; y++) {
          if (y === 0) {
            setLocal(lx, y, lz, BLOCK.BEDROCK);
            continue;
          }

          if (y <= h) {
            // 3D Caves (not in flat mode)
            if (this.worldType !== 'flat' && y > 3 && y < h - 3) {
              const cv = this.caveNoise.noise3D(wx * 0.065, y * 0.085, wz * 0.065);
              if (cv > 0.34) {
                setLocal(lx, y, lz, BLOCK.AIR);
                continue;
              }
            }

            if (y === h) {
              if (h < SEA_LEVEL + 1 && this.worldType !== 'flat') {
                setLocal(lx, y, lz, (slope >= 2 && biome === 'Mountains') ? BLOCK.GRAVEL : BLOCK.SAND);
              } else if (biome === 'Desert') {
                setLocal(lx, y, lz, BLOCK.SAND);
              } else if (slope >= 3 && h > SEA_LEVEL + 5) {
                // Steep alpine cliff faces expose realistic bare stone!
                setLocal(lx, y, lz, BLOCK.STONE);
              } else if (h >= 58 || (biome === 'Snowy Taiga' && slope <= 2)) {
                // Wind-swept snow caps on peaks & snowy taiga
                setLocal(lx, y, lz, BLOCK.SNOW);
              } else if (h >= 52 && slope >= 2) {
                // Rocky scree transition below the snow line
                setLocal(lx, y, lz, coordHash(wx, wz, this.seed + 41) > 0.65 ? BLOCK.GRAVEL : BLOCK.STONE);
              } else {
                setLocal(lx, y, lz, BLOCK.GRASS);
              }
            } else if (y >= h - 3) {
              if (biome === 'Desert') setLocal(lx, y, lz, y >= h - 2 ? BLOCK.SAND : BLOCK.SANDSTONE);
              else if (slope >= 3 || h >= 54) setLocal(lx, y, lz, BLOCK.STONE);
              else setLocal(lx, y, lz, BLOCK.DIRT);
            } else {
              let blk = BLOCK.STONE;
              if (this.worldType !== 'flat') {
                const ov = this.oreNoise.noise3D(wx * 0.16, y * 0.16, wz * 0.16);
                if (y < 16 && ov > 0.38) blk = BLOCK.DIAMOND_ORE;
                else if (y < 26 && ov > 0.34) blk = BLOCK.GOLD_ORE;
                else if (y < 44 && ov > 0.28) blk = BLOCK.IRON_ORE;
                else if (ov < -0.27) blk = BLOCK.COAL_ORE;
              }
              setLocal(lx, y, lz, blk);
            }
          } else if (this.worldType !== 'flat' && y <= SEA_LEVEL) {
            if (y === SEA_LEVEL && biome === 'Snowy Taiga') {
              setLocal(lx, y, lz, BLOCK.ICE);
            } else {
              setLocal(lx, y, lz, BLOCK.WATER);
            }
          }
        }
      }
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
      this.buildVillageDistrict(cx, cz, ox, oz, heights, setLocal, vInfo);
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

    const chunk = { cx, cz, key, data, maxY, meshes: [], dirty: true };
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
    if (blockId === BLOCK.AIR) {
      this.chests.delete(`${x},${y},${z}`);
      this.furnaces.delete(`${x},${y},${z}`);
    } else if (blockId === BLOCK.CHEST && !this.chests.has(`${x},${y},${z}`)) {
      this.chests.set(`${x},${y},${z}`, new Array(27).fill(null));
    } else if (blockId === BLOCK.FURNACE && !this.furnaces.has(`${x},${y},${z}`)) {
      this.furnaces.set(`${x},${y},${z}`, {
        input: null, fuel: null, output: null,
        burnTime: 0, burnMax: 0, cookTime: 0
      });
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
    if (c && !c.dirty) {
      c.dirty = true;
      this.meshQueue.push(c);
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

    const buckets = {
      opaque: { pos: [], norm: [], uv: [], col: [], idx: [] },
      cutout: { pos: [], norm: [], uv: [], col: [], idx: [] },
      staticCutout: { pos: [], norm: [], uv: [], col: [], idx: [] },
      water: { pos: [], norm: [], uv: [], col: [], idx: [] }
    };

    const cx = chunk.cx;
    const cz = chunk.cz;
    const ox = cx << 4;
    const oz = cz << 4;
    const data = chunk.data;

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

    for (let y = 0; y <= yLimit; y++) {
      const yOff = y << 8;
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const zOff = lz << 4;
        const wz = oz + lz;
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const id = data[lx + zOff + yOff];
          if (id === 0) continue;
          const def = getBlockDef(id);
          if (!def) continue;

          const wx = ox + lx;

          // Custom Sculpted 3D Bed Geometry (4 oak legs + quilted red mattress + raised white pillow!)
          if (id === BLOCK.BED) {
            const b = buckets.opaque;
            const topUV = this.textures.getUV('bed_top');
            const sideUV = this.textures.getUV('bed_side');
            const woodUV = this.textures.getUV('oak_planks');
            const addBox = (x0, y0, z0, x1, y1, z1, uTop, uSide, uBot) => {
              const boxFaces = [
                { n: [0, 1, 0], sh: 1.0, uv: uTop, pts: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]] },
                { n: [0, -1, 0], sh: 0.58, uv: uBot, pts: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
                { n: [1, 0, 0], sh: 0.84, uv: uSide, pts: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]] },
                { n: [-1, 0, 0], sh: 0.84, uv: uSide, pts: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] },
                { n: [0, 0, 1], sh: 0.74, uv: uSide, pts: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
                { n: [0, 0, -1], sh: 0.74, uv: uSide, pts: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]] }
              ];
              for (const f of boxFaces) {
                const baseIdx = b.pos.length / 3;
                const u = f.uv;
                for (let pi = 0; pi < 4; pi++) {
                  const pt = f.pts[pi];
                  b.pos.push(wx + pt[0], y + pt[1], wz + pt[2]);
                  b.norm.push(f.n[0], f.n[1], f.n[2]);
                  b.col.push(f.sh, f.sh, f.sh);
                }
                b.uv.push(u.u0, u.v0, u.u1, u.v0, u.u1, u.v1, u.u0, u.v1);
                b.idx.push(baseIdx, baseIdx + 1, baseIdx + 2, baseIdx, baseIdx + 2, baseIdx + 3);
              }
            };
            // Mattress + blanket
            addBox(0.02, 0.22, 0.02, 0.98, 0.56, 0.98, topUV, sideUV, woodUV);
            // 4 oak wooden legs
            addBox(0.04, 0.0, 0.04, 0.22, 0.22, 0.22, woodUV, woodUV, woodUV);
            addBox(0.78, 0.0, 0.04, 0.96, 0.22, 0.22, woodUV, woodUV, woodUV);
            addBox(0.04, 0.0, 0.78, 0.22, 0.22, 0.96, woodUV, woodUV, woodUV);
            addBox(0.78, 0.0, 0.78, 0.96, 0.22, 0.96, woodUV, woodUV, woodUV);
            continue;
          }

          // Cross-quad blocks (flowers, tall grass sway; torches & ladders stay static!)
          if (def.cross) {
            const isStaticCross = id === BLOCK.TORCH || id === BLOCK.LADDER;
            const b = isStaticCross ? buckets.staticCutout : buckets.cutout;
            const uv = this.textures.getUV(def.faces.all);
            const shade = def.light > 0 ? 1.18 : 0.94;
            const yBase = isStaticCross ? 0.0 : 0.02;
            const quads = [
              [[0.15, yBase, 0.15, 0, 0], [0.85, yBase, 0.85, 1, 0], [0.85, 0.9, 0.85, 1, 1], [0.15, 0.9, 0.15, 0, 1]],
              [[0.15, yBase, 0.85, 0, 0], [0.85, yBase, 0.15, 1, 0], [0.85, 0.9, 0.15, 1, 1], [0.15, 0.9, 0.85, 0, 1]]
            ];
            for (const q of quads) {
              const baseIdx = b.pos.length / 3;
              for (const [qx, qy, qz, u, v] of q) {
                b.pos.push(wx + qx, y + qy, wz + qz);
                b.norm.push(0, 1, 0);
                b.uv.push(u ? uv.u1 : uv.u0, v ? uv.v1 : uv.v0);
                b.col.push(shade, shade, shade);
              }
              b.idx.push(baseIdx, baseIdx + 1, baseIdx + 2, baseIdx, baseIdx + 2, baseIdx + 3);
            }
            continue;
          }

          const isWater = id === BLOCK.WATER;
          const isStaticCutout = id === BLOCK.GLASS || id === BLOCK.ICE;
          const isCutout = !isWater && !isStaticCutout && def.transparent;
          const b = isWater
            ? buckets.water
            : (isStaticCutout ? buckets.staticCutout : (isCutout ? buckets.cutout : buckets.opaque));
          const waterTopLower = isWater && fastGet(lx, y + 1, lz) !== BLOCK.WATER;

          for (let fi = 0; fi < 6; fi++) {
            const face = FACES[fi];
            const nlx = lx + face.dir[0];
            const ny = y + face.dir[1];
            const nlz = lz + face.dir[2];
            const neighbor = fastGet(nlx, ny, nlz);

            // Culling logic
            if (isWater) {
              if (neighbor === BLOCK.WATER || (neighbor !== 0 && !isBlockTransparent(neighbor))) continue;
            } else if (isCutout || isStaticCutout) {
              if (neighbor === id && (id === BLOCK.GLASS || id === BLOCK.ICE)) continue;
              if (neighbor !== 0 && !isBlockTransparent(neighbor)) continue;
            } else {
              if (neighbor !== 0 && !isBlockTransparent(neighbor)) continue;
            }

            const texName = def.faces[face.faceType] || def.faces.all || def.faces.side;
            const uv = this.textures.getUV(texName);
            const baseIdx = b.pos.length / 3;
            const lightBoost = def.light > 0 ? 1.18 : 1.0;

            for (let ci = 0; ci < 4; ci++) {
              const [cx0, cy0, cz0, u, v] = face.corners[ci];
              const py = (waterTopLower && cy0 === 1) ? y + 0.88 : y + cy0;
              b.pos.push(wx + cx0, py, wz + cz0);
              b.norm.push(face.dir[0], face.dir[1], face.dir[2]);
              b.uv.push(u ? uv.u1 : uv.u0, v ? uv.v1 : uv.v0);

              let ao = 1.0;
              if (!isWater) {
                let occ = 0;
                if (face.faceType === 'top') {
                  const dx = cx0 === 0 ? -1 : 1;
                  const dz = cz0 === 0 ? -1 : 1;
                  if (isBlockSolid(fastGet(lx + dx, y + 1, lz))) occ++;
                  if (isBlockSolid(fastGet(lx, y + 1, lz + dz))) occ++;
                  if (isBlockSolid(fastGet(lx + dx, y + 1, lz + dz))) occ++;
                } else if (face.faceType === 'side') {
                  const dy = cy0 === 0 ? -1 : 1;
                  const sdx = face.dir[0] === 0 ? (cx0 === 0 ? -1 : 1) : 0;
                  const sdz = face.dir[2] === 0 ? (cz0 === 0 ? -1 : 1) : 0;
                  if (isBlockSolid(fastGet(nlx, y + dy, nlz))) occ++;
                  if (isBlockSolid(fastGet(nlx + sdx, y, nlz + sdz))) occ++;
                  if (isBlockSolid(fastGet(nlx + sdx, y + dy, nlz + sdz))) occ++;
                }
                ao = 1.0 - occ * 0.12;
              }
              const s = Math.min(1.2, face.shade * ao * lightBoost);
              b.col.push(s, s, s);
            }
            b.idx.push(baseIdx, baseIdx + 1, baseIdx + 2, baseIdx, baseIdx + 2, baseIdx + 3);
          }
        }
      }
    }

    const addBucket = (bucket, mat, renderOrder = 0, shadows = false) => {
      if (bucket.pos.length === 0) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(bucket.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.norm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uv, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(bucket.col, 3));
      geo.setIndex(bucket.idx);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = renderOrder;
      mesh.frustumCulled = true;
      mesh.castShadow = shadows && this.shaderMode === 'ultra';
      mesh.receiveShadow = (shadows || mat === this.cutoutMat) && this.shaderMode === 'ultra';
      this.group.add(mesh);
      chunk.meshes.push(mesh);
    };

    addBucket(buckets.opaque, this.opaqueMat, 0, true);
    addBucket(buckets.cutout, this.cutoutMat, 1, false);
    addBucket(buckets.staticCutout, this.staticCutoutMat, 1, false);
    addBucket(buckets.water, this.waterMat, 2, false);
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

  updateChunksAround(px, pz, maxBuildsPerFrame = 3) {
    const pcx = Math.floor(px / CHUNK_SIZE);
    const pcz = Math.floor(pz / CHUNK_SIZE);
    const r = this.renderDistance;

    const movedChunk = pcx !== this._lastChunkPcx || pcz !== this._lastChunkPcz || r !== this._lastChunkRD;
    if (movedChunk) {
      this._lastChunkPcx = pcx;
      this._lastChunkPcz = pcz;
      this._lastChunkRD = r;
      this._chunksAllLoaded = false;
    }

    // 1. Only scan spiral grid when still streaming chunks or after crossing a chunk border!
    if (!this._chunksAllLoaded) {
      const needed = [];
      const rSq = (r + 0.5) * (r + 0.5);
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const d2 = dx * dx + dz * dz;
          if (d2 > rSq) continue;
          const cx = pcx + dx;
          const cz = pcz + dz;
          if (!this.chunks.has(this.chunkKey(cx, cz))) {
            needed.push({ cx, cz, dist: d2 });
          }
        }
      }

      if (needed.length === 0) {
        this._chunksAllLoaded = true;
      } else {
        needed.sort((a, b) => a.dist - b.dist);
        const maxGen = this.renderDistance > 8 ? 4 : 3;
        for (let i = 0; i < needed.length && i < maxGen; i++) {
          const chunk = this.generateChunk(needed[i].cx, needed[i].cz);
          this.meshQueue.push(chunk);
        }
      }
    }

    // 2. Build dirty chunk meshes (prioritize closest)
    if (this.meshQueue.length > 0) {
      if (this.meshQueue.length > 1) {
        this.meshQueue.sort((a, b) => {
          const da = (a.cx - pcx) ** 2 + (a.cz - pcz) ** 2;
          const db = (b.cx - pcx) ** 2 + (b.cz - pcz) ** 2;
          return da - db;
        });
      }

      let built = 0;
      const tStart = performance.now();
      while (this.meshQueue.length > 0 && built < maxBuildsPerFrame) {
        const chunk = this.meshQueue.shift();
        if (chunk && chunk.dirty && this.chunks.has(chunk.key)) {
          this.buildChunkMesh(chunk);
          built++;
          if (performance.now() - tStart > 4.5) break;
        }
      }
    }

    // 3. Only check unload when crossing a chunk border!
    if (movedChunk) {
      const unloadR = r + 2;
      const unloadSq = unloadR * unloadR;
      for (const [key, chunk] of this.chunks.entries()) {
        const dx = chunk.cx - pcx;
        const dz = chunk.cz - pcz;
        if (dx * dx + dz * dz > unloadSq) {
          for (const m of chunk.meshes) {
            this.group.remove(m);
            m.geometry.dispose();
          }
          this.chunks.delete(key);
        }
      }
    }
  }

  // Blazing-Fast Spawn Preload: build immediate 3x3 synchronously (<45ms!), stream outer rings seamlessly!
  preloadSpawn(px, pz) {
    const pcx = Math.floor(px / CHUNK_SIZE);
    const pcz = Math.floor(pz / CHUNK_SIZE);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
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

  explode(cx, cy, cz, radius = 3.2) {
    const r = Math.ceil(radius);
    const broken = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d <= radius) {
            const bx = Math.floor(cx + dx);
            const by = Math.floor(cy + dy);
            const bz = Math.floor(cz + dz);
            const id = this.getBlock(bx, by, bz);
            if (id !== BLOCK.AIR && id !== BLOCK.BEDROCK && id !== BLOCK.OBSIDIAN && id !== BLOCK.WATER) {
              this.setBlock(bx, by, bz, BLOCK.AIR, true);
              broken.push({ x: bx, y: by, z: bz, id });
            }
          }
        }
      }
    }
    return broken;
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

  dispose() {
    for (const chunk of this.chunks.values()) {
      for (const m of chunk.meshes) {
        this.group.remove(m);
        m.geometry.dispose();
      }
    }
    this.chunks.clear();
    this.scene.remove(this.group);
  }
}
