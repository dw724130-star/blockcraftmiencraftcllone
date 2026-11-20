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

    this.chunks = new Map(); // "cx,cz" -> { cx, cz, data: Uint8Array, meshes: [], dirty: bool }
    this.modifiedBlocks = new Map(); // "x,y,z" -> blockId
    this.chests = new Map(); // "x,y,z" -> Array(27)
    this.furnaces = new Map(); // "x,y,z" -> { input, fuel, output, burnTime, burnMax, cookTime }
    this.villageChunks = new Map(); // "cx,cz" -> { x, y, z, biome, spawned: bool }
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
          float v = 0.0;
          float amp = 0.52;
          mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
          for (int i = 0; i < 4; i++) {
            v += amp * noise2D(p);
            p = rot * p * 2.02 + vec2(17.1, 31.7);
            amp *= 0.5;
          }
          return v;
        }

        // Exact mirror of SkyDome's atmospheric gradient + puffy volumetric clouds!
        vec3 sampleSkyReflection(vec3 dir, vec3 sunDir) {
          float h = clamp(dir.y, 0.0, 1.0);
          float sunDot = max(0.0, dot(dir, sunDir));
          vec3 skyCol = mix(uHorizonColor, uMidColor, smoothstep(0.0, 0.34, h));
          skyCol = mix(skyCol, uTopColor, smoothstep(0.22, 0.92, h));

          float horizonBand = pow(1.0 - h, 3.0);
          float sunSide = pow(sunDot, 2.0);
          skyCol = mix(skyCol, uSunsetColor, horizonBand * (0.3 + 0.62 * sunSide) * uSunsetFactor * (1.0 - uRainFactor * 0.7));

          float twilightArc = smoothstep(0.02, 0.26, h) * (1.0 - smoothstep(0.26, 0.68, h));
          skyCol += vec3(0.28, 0.12, 0.24) * twilightArc * uSunsetFactor * (1.0 - uRainFactor * 0.8);

          // Sun reflection bloom
          float clearAmt = 1.0 - uRainFactor * 0.85;
          float sunVisible = smoothstep(-0.12, 0.05, sunDir.y) * clearAmt;
          skyCol += uSunColor * (pow(sunDot, 8.0) * (0.35 + 0.65 * uSunsetFactor) + pow(sunDot, 54.0) * 1.1) * sunVisible;

          // Reflected puffy clouds!
          if (dir.y > 0.012) {
            vec2 cloudUV = (dir.xz / (dir.y + 0.11)) * 0.42;
            vec2 drift = vec2(uCloudTime * 0.0085, uCloudTime * 0.0032);
            float rawD = fbmWater(cloudUV * 1.15 + drift);
            float thresh = mix(0.49, 0.36, uRainFactor);
            float cAlpha = smoothstep(thresh, thresh + 0.22, rawD) * smoothstep(0.012, 0.18, dir.y) * 0.88;
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

          // Multi-octave silky animated ripple normal (BSL water ripples)
          vec2 p = vWorldPos.xz;
          float t = uTime;
          float r1 = sin(p.x * 1.9 + t * 1.7 + p.y * 0.9) * cos(p.y * 1.6 - t * 1.3);
          float r2 = sin(p.x * 3.7 - t * 2.3 + p.y * 2.5) * 0.55;
          float r3 = (noise2D(p * 1.6 + vec2(t * 0.55, -t * 0.42)) - 0.5) * 1.2;
          float r4 = (noise2D(p * 3.4 - vec2(t * 0.72, t * 0.58)) - 0.5) * 0.7;

          float amp = mix(0.02, 0.13, clamp(uWaveStrength, 0.0, 1.2)) * (1.0 - smoothstep(45.0, 130.0, dist) * 0.45);
          vec3 N = normalize(vec3(
            (r1 + r3 + r4) * amp,
            1.0,
            (r2 + r3 - r4) * amp
          ));
          if (vBaseNormal.y < 0.5) N = normalize(vBaseNormal);

          // Fresnel Mirror Reflection of Live Sky & Clouds!
          float NoV = max(0.0, dot(N, V));
          float fresnel = clamp(0.10 + 0.90 * pow(1.0 - NoV, 3.2), 0.10, 0.96);

          vec3 R = reflect(-V, N);
          R.y = max(0.02, abs(R.y));
          vec3 reflCol = sampleSkyReflection(normalize(R), sunDir);

          // Crystal clear deep-teal water absorption tint
          vec3 deepWater = mix(vec3(0.02, 0.05, 0.10), vec3(0.04, 0.24, 0.34), uDayFactor);
          deepWater = mix(deepWater, vec3(0.14, 0.11, 0.20), uSunsetFactor * 0.55);

          // Subtle caustic shimmer in shallow/steep view angles
          float caustic = pow(max(0.0, noise2D(p * 2.4 + vec2(t * 0.8, t * 0.6))), 3.0) * 0.18 * uDayFactor;
          deepWater += vec3(0.06, 0.22, 0.26) * caustic;

          vec3 col = mix(deepWater, reflCol, fresnel);

          // Sparkling Sun Specular Glitter across the Ripples!
          vec3 H = normalize(V + sunDir);
          float specTight = pow(max(0.0, dot(N, H)), 180.0) * 2.6;
          float specBroad = pow(max(0.0, dot(N, H)), 26.0) * 0.45;
          float sunUp = smoothstep(-0.08, 0.08, sunDir.y) * (1.0 - uRainFactor * 0.85);
          col += uSunColor * (specTight + specBroad) * sunUp;

          // Atmospheric Distance Haze matching Terrain & Sky seamlessly!
          vec3 viewOut = -V;
          float hazeFactor = smoothstep(uFogNear * 0.55, uFogFar, dist);
          float sunAlign = pow(max(0.0, dot(viewOut, sunDir)), 3.0);
          vec3 atmFog = mix(uHorizonColor, uSunColor * 1.05, sunAlign * (0.28 + 0.52 * uSunsetFactor) * uDayFactor);
          atmFog = mix(atmFog, uSunsetColor, sunAlign * uSunsetFactor * 0.35);
          col = mix(col, atmFog, hazeFactor);

          float alpha = mix(0.74, 0.96, fresnel);
          alpha = mix(alpha, 1.0, hazeFactor);

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

  chunkKey(cx, cz) {
    return `${cx},${cz}`;
  }

  getBiomeAt(wx, wz) {
    if (this.worldType === 'flat') return 'Plains';
    const temp = this.biomeNoise.fbm2D(wx * 0.0038, wz * 0.0038, 3);
    const moist = this.moistureNoise.fbm2D(wx * 0.0038, wz * 0.0038, 3);
    const mount = this.heightNoise.fbm2D(wx * 0.0055 + 50, wz * 0.0055 - 50, 3);
    if (mount > 0.20) return 'Mountains';
    if (temp > 0.14 && moist < 0.04) return 'Desert';
    if (temp < -0.13) return 'Snowy Taiga';
    if (moist > 0.12) return temp > 0.0 ? 'Forest' : 'Birch Forest';
    return 'Plains';
  }

  getTerrainHeight(wx, wz, biome) {
    if (this.worldType === 'flat') return 36;
    const cont = this.heightNoise.fbm2D(wx * 0.006, wz * 0.006, 4);
    const hills = this.heightNoise.fbm2D(wx * 0.018, wz * 0.018, 3);
    const detail = this.heightNoise.noise2D(wx * 0.055, wz * 0.055) * 2.2;

    // Scenic rivers carved where river noise crosses 0
    const riverRaw = Math.abs(this.moistureNoise.fbm2D(wx * 0.007 + 200, wz * 0.007 - 150, 3));
    const riverCarve = riverRaw < 0.045 ? (1 - riverRaw / 0.045) * 11 : 0;

    let h = SEA_LEVEL + 5 + cont * 16 + hills * 8 + detail - riverCarve;

    if (biome === 'Mountains') {
      // Dramatic ridged multifractal alpine peaks!
      const ridge1 = 1.0 - Math.abs(this.heightNoise.noise2D(wx * 0.014, wz * 0.014) * 2.1);
      const ridge2 = 1.0 - Math.abs(this.heightNoise.noise2D(wx * 0.032 + 17, wz * 0.032 - 23) * 2.1);
      const peak = Math.pow(Math.max(0, ridge1), 2.1) * 38 + Math.pow(Math.max(0, ridge2), 2.0) * 12;
      h = SEA_LEVEL + 10 + cont * 10 + peak + detail - riverCarve * 0.4;
    } else if (biome === 'Desert') {
      h = SEA_LEVEL + 4 + cont * 9 + hills * 4 + detail * 0.5 - riverCarve * 0.7;
    } else if (biome === 'Plains') {
      h = SEA_LEVEL + 5 + cont * 8 + hills * 3.5 + detail * 0.35 - riverCarve;
    }
    return Math.max(8, Math.min(CHUNK_HEIGHT - 8, Math.floor(h)));
  }

  isVillageChunk(cx, cz) {
    if (this.worldType === 'flat') return false;
    // Guaranteed scenic starter village near spawn at chunk (2, 1) if land is above sea level
    if (cx === 2 && cz === 1) return true;
    // Otherwise spaced grid of 7x7 chunks with deterministic hash
    if (((cx % 7) + 7) % 7 !== 3 || ((cz % 7) + 7) % 7 !== 3) return false;
    return coordHash(cx * 13, cz * 17, this.seed + 555) > 0.32;
  }

  buildVillageInChunk(cx, cz, ox, oz, heights, biomes, setLocal, getLocal) {
    const centerH = heights[8 + 8 * CHUNK_SIZE];
    const biome = biomes[8 + 8 * CHUNK_SIZE];
    if (centerH <= SEA_LEVEL + 1 || centerH > 62) return;
    if (biome === 'Mountains') return;

    const isDesert = biome === 'Desert';
    const isSnow = biome === 'Snowy Taiga';
    const wallBlk = isDesert ? BLOCK.SANDSTONE : (isSnow ? BLOCK.SPRUCE_PLANKS : BLOCK.OAK_PLANKS);
    const logBlk = isDesert ? BLOCK.SANDSTONE : (isSnow ? BLOCK.SPRUCE_LOG : BLOCK.OAK_LOG);
    const roofBlk = isDesert ? BLOCK.SANDSTONE : (isSnow ? BLOCK.SPRUCE_LOG : BLOCK.COBBLESTONE);
    const pathBlk = isDesert ? BLOCK.SANDSTONE : BLOCK.GRAVEL;

    // Flatten village plaza (3..13)
    const baseY = centerH;
    for (let lz = 1; lz < 15; lz++) {
      for (let lx = 1; lx < 15; lx++) {
        const curH = heights[lx + lz * CHUNK_SIZE];
        if (curH < baseY) {
          for (let y = curH; y <= baseY; y++) setLocal(lx, y, lz, isDesert ? BLOCK.SAND : BLOCK.DIRT);
        } else {
          for (let y = baseY + 1; y <= Math.min(CHUNK_HEIGHT - 2, curH + 8); y++) setLocal(lx, y, lz, BLOCK.AIR);
        }
        setLocal(lx, baseY, lz, isDesert ? BLOCK.SAND : (isSnow ? BLOCK.SNOW : BLOCK.GRASS));
        heights[lx + lz * CHUNK_SIZE] = baseY;
      }
    }

    // Cross paths
    for (let i = 1; i < 15; i++) {
      setLocal(i, baseY, 7, pathBlk);
      setLocal(i, baseY, 8, pathBlk);
      setLocal(7, baseY, i, pathBlk);
      setLocal(8, baseY, i, pathBlk);
    }

    // Helper: build a cozy villager house with doorway, windows, roof, torch & loot chest
    const buildHouse = (x0, z0, w, d, h, withChest) => {
      for (let dz = 0; dz < d; dz++) {
        for (let dx = 0; dx < w; dx++) {
          setLocal(x0 + dx, baseY, z0 + dz, BLOCK.COBBLESTONE);
          for (let dy = 1; dy <= h; dy++) {
            const isEdgeX = dx === 0 || dx === w - 1;
            const isEdgeZ = dz === 0 || dz === d - 1;
            if (isEdgeX && isEdgeZ) {
              setLocal(x0 + dx, baseY + dy, z0 + dz, logBlk);
            } else if (isEdgeX || isEdgeZ) {
              const isWindow = dy === 2 && ((dx === Math.floor(w / 2)) || (dz === Math.floor(d / 2)));
              setLocal(x0 + dx, baseY + dy, z0 + dz, isWindow ? BLOCK.GLASS : wallBlk);
            } else {
              setLocal(x0 + dx, baseY + dy, z0 + dz, BLOCK.AIR);
            }
          }
          // Roof
          setLocal(x0 + dx, baseY + h + 1, z0 + dz, roofBlk);
        }
      }
      // Pitched second roof layer
      for (let dz = 1; dz < d - 1; dz++) {
        for (let dx = 1; dx < w - 1; dx++) {
          setLocal(x0 + dx, baseY + h + 2, z0 + dz, wallBlk);
        }
      }
      // Doorway facing center road
      const doorX = x0 + Math.floor(w / 2);
      const doorZ = z0 < 7 ? z0 + d - 1 : z0;
      setLocal(doorX, baseY + 1, doorZ, BLOCK.AIR);
      setLocal(doorX, baseY + 2, doorZ, BLOCK.AIR);

      // Interior torch + crafting table or chest
      setLocal(x0 + 1, baseY + 2, z0 + 1, BLOCK.TORCH);
      if (withChest) {
        const cxLoc = x0 + w - 2;
        const czLoc = z0 + 1;
        setLocal(cxLoc, baseY + 1, czLoc, BLOCK.CHEST);
        const worldKey = `${ox + cxLoc},${baseY + 1},${oz + czLoc}`;
        if (!this.chests.has(worldKey)) {
          const loot = new Array(27).fill(null);
          loot[0] = { id: 'emerald', count: 3 + Math.floor(coordHash(ox, oz, 1) * 4) };
          loot[1] = { id: 'bread', count: 4 };
          loot[2] = { id: 'apple', count: 3 };
          loot[3] = { id: 'coal', count: 6 };
          loot[4] = { id: 'iron_ingot', count: 2 };
          this.chests.set(worldKey, loot);
        }
      } else {
        setLocal(x0 + w - 2, baseY + 1, z0 + 1, BLOCK.CRAFTING_TABLE);
      }
    };

    // Two houses + Well + Farm Plot
    buildHouse(1, 1, 5, 5, 3, true);
    buildHouse(10, 10, 5, 5, 3, false);

    // Village Well (top-right quadrant)
    for (let dz = 0; dz < 4; dz++) {
      for (let dx = 0; dx < 4; dx++) {
        const edge = dx === 0 || dx === 3 || dz === 0 || dz === 3;
        setLocal(10 + dx, baseY + 1, 2 + dz, edge ? BLOCK.COBBLESTONE : BLOCK.WATER);
        setLocal(10 + dx, baseY, 2 + dz, edge ? BLOCK.COBBLESTONE : BLOCK.WATER);
      }
    }
    for (const [px, pz] of [[10, 2], [13, 2], [10, 5], [13, 5]]) {
      setLocal(px, baseY + 2, pz, logBlk);
      setLocal(px, baseY + 3, pz, logBlk);
    }
    for (let dz = 0; dz < 4; dz++) {
      for (let dx = 0; dx < 4; dx++) {
        setLocal(10 + dx, baseY + 4, 2 + dz, roofBlk);
      }
    }

    // Farm Plot (bottom-left quadrant)
    for (let dz = 0; dz < 4; dz++) {
      for (let dx = 0; dx < 5; dx++) {
        if (dx === 2) {
          setLocal(1 + dx, baseY, 10 + dz, BLOCK.WATER);
        } else {
          setLocal(1 + dx, baseY, 10 + dz, BLOCK.FARMLAND);
          setLocal(1 + dx, baseY + 1, 10 + dz, BLOCK.TALL_GRASS);
        }
      }
    }

    // Street Lamp Post
    setLocal(6, baseY + 1, 6, logBlk);
    setLocal(6, baseY + 2, 6, logBlk);
    setLocal(6, baseY + 3, 6, logBlk);
    setLocal(6, baseY + 4, 6, BLOCK.GLOWSTONE);

    const vKey = this.chunkKey(cx, cz);
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

  generateChunk(cx, cz) {
    const key = this.chunkKey(cx, cz);
    if (this.chunks.has(key)) return this.chunks.get(key);

    const data = new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE);
    const setLocal = (lx, y, lz, id) => {
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 0 || y >= CHUNK_HEIGHT) return;
      data[lx + lz * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE] = id;
    };
    const getLocal = (lx, y, lz) => {
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 0 || y >= CHUNK_HEIGHT) return 0;
      return data[lx + lz * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE];
    };

    const ox = cx * CHUNK_SIZE;
    const oz = cz * CHUNK_SIZE;

    const heights = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);
    const biomes = new Array(CHUNK_SIZE * CHUNK_SIZE);

    // 1. Base Terrain + Caves + Ores
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = ox + lx;
        const wz = oz + lz;
        const biome = this.getBiomeAt(wx, wz);
        const h = this.getTerrainHeight(wx, wz, biome);
        heights[lx + lz * CHUNK_SIZE] = h;
        biomes[lx + lz * CHUNK_SIZE] = biome;

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
                setLocal(lx, y, lz, BLOCK.SAND);
              } else if (biome === 'Desert') {
                setLocal(lx, y, lz, BLOCK.SAND);
              } else if (biome === 'Snowy Taiga' || (biome === 'Mountains' && h > 58)) {
                setLocal(lx, y, lz, BLOCK.SNOW);
              } else if (biome === 'Mountains' && h > 50) {
                setLocal(lx, y, lz, BLOCK.STONE);
              } else {
                setLocal(lx, y, lz, BLOCK.GRASS);
              }
            } else if (y >= h - 3) {
              if (biome === 'Desert') setLocal(lx, y, lz, y >= h - 2 ? BLOCK.SAND : BLOCK.SANDSTONE);
              else if (biome === 'Mountains' && h > 50) setLocal(lx, y, lz, BLOCK.STONE);
              else setLocal(lx, y, lz, BLOCK.DIRT);
            } else {
              // Stone + Ore Veins
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

    // 2. Villages, Scenic Hilltop Watchtowers, OR Trees, Cacti, Lush Meadows & Wildflowers
    const isWatchtowerChunk =
      this.worldType !== 'flat' &&
      !this.isVillageChunk(cx, cz) &&
      ((cx % 9) + 9) % 9 === 5 &&
      ((cz % 9) + 9) % 9 === 4 &&
      coordHash(cx * 31, cz * 29, this.seed + 777) > 0.45;

    if (this.worldType !== 'flat' && this.isVillageChunk(cx, cz)) {
      this.buildVillageInChunk(cx, cz, ox, oz, heights, biomes, setLocal, getLocal);
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

    if (this.worldType !== 'flat' && !this.isVillageChunk(cx, cz)) {
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
            const logType =
              biome === 'Birch Forest' ? BLOCK.BIRCH_LOG :
              biome === 'Snowy Taiga' ? BLOCK.SPRUCE_LOG : BLOCK.OAK_LOG;
            const leafType =
              biome === 'Birch Forest' ? BLOCK.BIRCH_LEAVES :
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

    // 3. Apply player-modified blocks in this chunk
    for (const [mkey, blockId] of this.modifiedBlocks.entries()) {
      const [mx, my, mz] = mkey.split(',').map(Number);
      const mcx = Math.floor(mx / CHUNK_SIZE);
      const mcz = Math.floor(mz / CHUNK_SIZE);
      if (mcx === cx && mcz === cz) {
        const lx = ((mx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const lz = ((mz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        setLocal(lx, my, lz, blockId);
      }
    }

    const chunk = { cx, cz, key, data, meshes: [], dirty: true };
    this.chunks.set(key, chunk);
    return chunk;
  }

  getBlock(wx, wy, wz) {
    const y = Math.floor(wy);
    if (y < 0 || y >= CHUNK_HEIGHT) return BLOCK.AIR;
    const x = Math.floor(wx);
    const z = Math.floor(wz);
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const chunk = this.chunks.get(this.chunkKey(cx, cz));
    if (!chunk) return BLOCK.AIR;
    const lx = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const lz = ((z % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    return chunk.data[lx + lz * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE];
  }

  setBlock(wx, wy, wz, blockId, record = true) {
    const x = Math.floor(wx);
    const y = Math.floor(wy);
    const z = Math.floor(wz);
    if (y < 0 || y >= CHUNK_HEIGHT) return;

    if (record) {
      this.modifiedBlocks.set(`${x},${y},${z}`, blockId);
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

    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const chunk = this.chunks.get(this.chunkKey(cx, cz));
    if (!chunk) return;

    const lx = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const lz = ((z % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    chunk.data[lx + lz * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE] = blockId;
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

    const ox = chunk.cx * CHUNK_SIZE;
    const oz = chunk.cz * CHUNK_SIZE;
    const data = chunk.data;

    for (let y = 0; y < CHUNK_HEIGHT; y++) {
      const yOff = y * CHUNK_SIZE * CHUNK_SIZE;
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const zOff = lz * CHUNK_SIZE;
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const id = data[lx + zOff + yOff];
          if (id === BLOCK.AIR) continue;
          const def = getBlockDef(id);
          if (!def) continue;

          const wx = ox + lx;
          const wz = oz + lz;

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

          for (const face of FACES) {
            const nx = wx + face.dir[0];
            const ny = y + face.dir[1];
            const nz = wz + face.dir[2];
            const neighbor = this.getBlock(nx, ny, nz);

            // Culling logic
            if (isWater) {
              if (neighbor === BLOCK.WATER || (neighbor !== BLOCK.AIR && !isBlockTransparent(neighbor))) continue;
            } else if (isCutout || isStaticCutout) {
              if (neighbor === id && (id === BLOCK.GLASS || id === BLOCK.ICE)) continue;
              if (neighbor !== BLOCK.AIR && !isBlockTransparent(neighbor)) continue;
            } else {
              if (neighbor !== BLOCK.AIR && !isBlockTransparent(neighbor)) continue;
            }

            const texName = def.faces[face.faceType] || def.faces.all || def.faces.side;
            const uv = this.textures.getUV(texName);
            const baseIdx = b.pos.length / 3;
            const lightBoost = def.light > 0 ? 1.18 : 1.0;

            for (const [cx0, cy0, cz0, u, v] of face.corners) {
              const py = (isWater && cy0 === 1 && this.getBlock(wx, y + 1, wz) !== BLOCK.WATER) ? y + 0.88 : y + cy0;
              b.pos.push(wx + cx0, py, wz + cz0);
              b.norm.push(face.dir[0], face.dir[1], face.dir[2]);
              b.uv.push(u ? uv.u1 : uv.u0, v ? uv.v1 : uv.v0);

              // 4-corner Ambient Occlusion on all 6 faces for rich Minecraft depth!
              let ao = 1.0;
              if (!isWater) {
                let occ = 0;
                if (face.faceType === 'top') {
                  const dx = cx0 === 0 ? -1 : 1;
                  const dz = cz0 === 0 ? -1 : 1;
                  if (isBlockSolid(this.getBlock(wx + dx, y + 1, wz))) occ++;
                  if (isBlockSolid(this.getBlock(wx, y + 1, wz + dz))) occ++;
                  if (isBlockSolid(this.getBlock(wx + dx, y + 1, wz + dz))) occ++;
                } else if (face.faceType === 'side') {
                  const dy = cy0 === 0 ? -1 : 1;
                  const sdx = face.dir[0] === 0 ? (cx0 === 0 ? -1 : 1) : 0;
                  const sdz = face.dir[2] === 0 ? (cz0 === 0 ? -1 : 1) : 0;
                  if (isBlockSolid(this.getBlock(nx, y + dy, nz))) occ++;
                  if (isBlockSolid(this.getBlock(nx + sdx, y, nz + sdz))) occ++;
                  if (isBlockSolid(this.getBlock(nx + sdx, y + dy, nz + sdz))) occ++;
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

    // 1. Generate missing chunks in spiral-like distance order
    const needed = [];
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > (r + 0.5) * (r + 0.5)) continue;
        const cx = pcx + dx;
        const cz = pcz + dz;
        const key = this.chunkKey(cx, cz);
        if (!this.chunks.has(key)) {
          needed.push({ cx, cz, dist: dx * dx + dz * dz });
        }
      }
    }
    needed.sort((a, b) => a.dist - b.dist);

    let generated = 0;
    const maxGen = this.renderDistance > 8 ? 4 : 2;
    for (const n of needed) {
      if (generated >= maxGen) break;
      const chunk = this.generateChunk(n.cx, n.cz);
      this.meshQueue.push(chunk);
      generated++;
    }

    // 2. Build dirty chunk meshes (prioritize closest)
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
        // Frame-budget guard for smooth iPad 60FPS even at high render distances
        if (performance.now() - tStart > 5.5) break;
      }
    }

    // 3. Unload far chunks
    const unloadR = r + 2;
    for (const [key, chunk] of this.chunks.entries()) {
      const dx = chunk.cx - pcx;
      const dz = chunk.cz - pcz;
      if (dx * dx + dz * dz > unloadR * unloadR) {
        for (const m of chunk.meshes) {
          this.group.remove(m);
          m.geometry.dispose();
        }
        this.chunks.delete(key);
      }
    }
  }

  // Preload immediate spawn chunks synchronously
  preloadSpawn(px, pz) {
    const pcx = Math.floor(px / CHUNK_SIZE);
    const pcz = Math.floor(pz / CHUNK_SIZE);
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.generateChunk(pcx + dx, pcz + dz);
      }
    }
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
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
