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
    this.shaderMode = options.shaders || 'enhanced';
    this.shaderUniforms = {
      uTime: { value: 0 },
      uWaveStrength: { value: this.shaderMode === 'off' ? 0.0 : 1.0 }
    };

    // Shared Materials with optional GLSL Shader Hooks
    this.opaqueMat = new THREE.MeshLambertMaterial({
      map: this.textures.atlasTexture,
      vertexColors: true
    });

    this.cutoutMat = new THREE.MeshLambertMaterial({
      map: this.textures.atlasTexture,
      vertexColors: true,
      alphaTest: 0.35,
      side: THREE.DoubleSide
    });
    this.cutoutMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.shaderUniforms.uTime;
      shader.uniforms.uWaveStrength = this.shaderUniforms.uWaveStrength;
      shader.vertexShader = 'uniform float uTime;\nuniform float uWaveStrength;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         if (uWaveStrength > 0.01) {
           float sway = sin(uTime * 2.1 + position.x * 0.9 + position.z * 0.7) * 0.045 * uWaveStrength;
           transformed.x += sway;
           transformed.z += cos(uTime * 1.7 + position.z * 0.8) * 0.03 * uWaveStrength;
         }`
      );
    };

    this.waterMat = new THREE.MeshLambertMaterial({
      map: this.textures.atlasTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0.76,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    this.waterMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.shaderUniforms.uTime;
      shader.uniforms.uWaveStrength = this.shaderUniforms.uWaveStrength;
      shader.vertexShader = 'uniform float uTime;\nuniform float uWaveStrength;\nvarying vec3 vWorldPos;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         if (uWaveStrength > 0.01) {
           float wave = sin(uTime * 2.6 + position.x * 1.1 + position.z * 0.9) * 0.065
                      + cos(uTime * 1.9 + position.z * 1.3 - position.x * 0.6) * 0.04;
           transformed.y += wave * uWaveStrength;
         }
         vWorldPos = position;`
      );
      shader.fragmentShader = 'uniform float uTime;\nuniform float uWaveStrength;\nvarying vec3 vWorldPos;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `if (uWaveStrength > 0.01) {
           float shimmer = pow(max(0.0, sin(vWorldPos.x * 2.2 + uTime * 2.4) * cos(vWorldPos.z * 2.2 - uTime * 1.8)), 4.0);
           gl_FragColor.rgb += vec3(0.18, 0.24, 0.3) * shimmer * uWaveStrength;
         }
         #include <dithering_fragment>`
      );
    };

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

    // 2. Villages OR Trees, Cacti, Flowers, Tall Grass
    if (this.worldType !== 'flat' && this.isVillageChunk(cx, cz)) {
      this.buildVillageInChunk(cx, cz, ox, oz, heights, biomes, setLocal, getLocal);
    } else if (this.worldType !== 'flat') {
      for (let lz = 2; lz < CHUNK_SIZE - 2; lz++) {
        for (let lx = 2; lx < CHUNK_SIZE - 2; lx++) {
          const wx = ox + lx;
          const wz = oz + lz;
          const h = heights[lx + lz * CHUNK_SIZE];
          const biome = biomes[lx + lz * CHUNK_SIZE];
          const topBlock = getLocal(lx, h, lz);
          if (h <= SEA_LEVEL || h >= CHUNK_HEIGHT - 10) continue;

          const r = coordHash(wx, wz, this.seed + 77);
          const treeChance =
            biome === 'Forest' ? 0.055 :
            biome === 'Birch Forest' ? 0.05 :
            biome === 'Snowy Taiga' ? 0.04 :
            biome === 'Plains' ? 0.008 : 0;

          if (r < treeChance && (topBlock === BLOCK.GRASS || topBlock === BLOCK.SNOW)) {
            const logType =
              biome === 'Birch Forest' ? BLOCK.BIRCH_LOG :
              biome === 'Snowy Taiga' ? BLOCK.SPRUCE_LOG : BLOCK.OAK_LOG;
            const leafType =
              biome === 'Birch Forest' ? BLOCK.BIRCH_LEAVES :
              biome === 'Snowy Taiga' ? BLOCK.SPRUCE_LEAVES : BLOCK.OAK_LEAVES;

            const trunkH = 4 + Math.floor(coordHash(wx, wz, this.seed + 88) * 3);
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
          } else if (biome === 'Desert' && topBlock === BLOCK.SAND && r < 0.012) {
            const ch = 2 + Math.floor(coordHash(wx, wz, this.seed + 99) * 3);
            for (let cy = 1; cy <= ch; cy++) setLocal(lx, h + cy, lz, BLOCK.CACTUS);
          } else if (topBlock === BLOCK.GRASS && r > 0.88 && getLocal(lx, h + 1, lz) === BLOCK.AIR) {
            if (r > 0.985) setLocal(lx, h + 1, lz, BLOCK.FLOWER_RED);
            else if (r > 0.97) setLocal(lx, h + 1, lz, BLOCK.FLOWER_YELLOW);
            else setLocal(lx, h + 1, lz, BLOCK.TALL_GRASS);
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

          // Cross-quad blocks (flowers, tall grass, torches, ladders)
          if (def.cross) {
            const b = buckets.cutout;
            const uv = this.textures.getUV(def.faces.all);
            const shade = def.light > 0 ? 1.15 : 0.92;
            const quads = [
              [[0.15, 0, 0.15, 0, 0], [0.85, 0, 0.85, 1, 0], [0.85, 0.9, 0.85, 1, 1], [0.15, 0.9, 0.15, 0, 1]],
              [[0.15, 0, 0.85, 0, 0], [0.85, 0, 0.15, 1, 0], [0.85, 0.9, 0.15, 1, 1], [0.15, 0.9, 0.85, 0, 1]]
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
          const isCutout = !isWater && def.transparent;
          const b = isWater ? buckets.water : (isCutout ? buckets.cutout : buckets.opaque);

          for (const face of FACES) {
            const nx = wx + face.dir[0];
            const ny = y + face.dir[1];
            const nz = wz + face.dir[2];
            const neighbor = this.getBlock(nx, ny, nz);

            // Culling logic
            if (isWater) {
              if (neighbor === BLOCK.WATER || (neighbor !== BLOCK.AIR && !isBlockTransparent(neighbor))) continue;
            } else if (isCutout) {
              if (neighbor === id && id === BLOCK.GLASS) continue;
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
      mesh.receiveShadow = shadows && this.shaderMode === 'ultra';
      this.group.add(mesh);
      chunk.meshes.push(mesh);
    };

    addBucket(buckets.opaque, this.opaqueMat, 0, true);
    addBucket(buckets.cutout, this.cutoutMat, 1, false);
    addBucket(buckets.water, this.waterMat, 2, false);
  }

  setShaderMode(mode) {
    this.shaderMode = mode;
    this.shaderUniforms.uWaveStrength.value = mode === 'off' ? 0.0 : (mode === 'ultra' ? 1.2 : 0.85);
    const useShadows = mode === 'ultra';
    for (const chunk of this.chunks.values()) {
      for (const m of chunk.meshes) {
        if (m.material === this.opaqueMat) {
          m.castShadow = useShadows;
          m.receiveShadow = useShadows;
        }
      }
    }
  }

  updateShaders(dt) {
    this.shaderUniforms.uTime.value += dt;
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
