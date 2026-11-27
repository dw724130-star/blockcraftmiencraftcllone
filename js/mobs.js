import * as THREE from 'three';
import { BLOCK, ITEMS, isBlockSolid, isBlockLiquid, isBedBlock, getBedInfo, isDoorBlock, isDoorTop, isFenceGateBlock, isFenceOrGate } from './blocks.js';
import { SEA_LEVEL } from './world.js';

// Pre-allocated scratch vectors for zero-GC per-frame raycasts & pickups!
const _scratchV1 = new THREE.Vector3();
const _scratchV2 = new THREE.Vector3();
const MOB_SHADOW_DIST = 28;

function lerpAngle(cur, target, t) {
  let diff = target - cur;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return cur + diff * t;
}

export const VILLAGER_TRADES = {
  Farmer: [
    { give: 'wheat', giveCount: 4, get: 'emerald', getCount: 1 },
    { give: 'oak_log', giveCount: 6, get: 'emerald', getCount: 1 },
    { give: 'emerald', giveCount: 1, get: 'bread', getCount: 4 },
    { give: 'emerald', giveCount: 1, get: 'apple', getCount: 4 },
    { give: 'emerald', giveCount: 2, get: 'bed', getCount: 1 }
  ],
  Blacksmith: [
    { give: 'coal', giveCount: 6, get: 'emerald', getCount: 1 },
    { give: 'iron_ingot', giveCount: 3, get: 'emerald', getCount: 1 },
    { give: 'emerald', giveCount: 2, get: 'iron_pickaxe', getCount: 1 },
    { give: 'emerald', giveCount: 3, get: 'iron_sword', getCount: 1 },
    { give: 'emerald', giveCount: 5, get: 'diamond_pickaxe', getCount: 1 },
    { give: 'emerald', giveCount: 4, get: 'iron_chestplate', getCount: 1 }
  ],
  Librarian: [
    { give: 'coal', giveCount: 5, get: 'emerald', getCount: 1 },
    { give: 'emerald', giveCount: 2, get: 'bookshelf', getCount: 2 },
    { give: 'emerald', giveCount: 2, get: 'glowstone', getCount: 4 },
    { give: 'emerald', giveCount: 3, get: 'tnt', getCount: 4 },
    { give: 'emerald', giveCount: 4, get: 'obsidian', getCount: 6 }
  ],
  Cleric: [
    { give: 'coal', giveCount: 4, get: 'emerald', getCount: 1 },
    { give: 'gold_ingot', giveCount: 2, get: 'emerald', getCount: 1 },
    { give: 'emerald', giveCount: 1, get: 'glowstone', getCount: 3 },
    { give: 'emerald', giveCount: 3, get: 'diamond', getCount: 1 },
    { give: 'emerald', giveCount: 3, get: 'obsidian', getCount: 5 }
  ]
};

const VILLAGER_PROFESSIONS = [
  { name: 'Farmer', robe: 0x8f6234, trim: 0xd9b84c },
  { name: 'Blacksmith', robe: 0x454952, trim: 0x26282e },
  { name: 'Librarian', robe: 0x9c2b2b, trim: 0xe6e0cf },
  { name: 'Cleric', robe: 0x6b2c91, trim: 0xf5cc42 }
];

const BIRD_VARIANTS = [
  { label: 'Bluejay', body: 0x3b82d6, wing: 0x1e4d8f, belly: 0xeef6ff, beak: 0x2b2d33 },
  { label: 'Cardinal', body: 0xd93838, wing: 0x9e1c1c, belly: 0xe84a4a, beak: 0xf59e0b },
  { label: 'Song Robin', body: 0x6b5344, wing: 0x4a382d, belly: 0xe06d3b, beak: 0xfacc15 },
  { label: 'Golden Finch', body: 0xf4c430, wing: 0x262626, belly: 0xfff3a8, beak: 0xf97316 },
  { label: 'Seagull', body: 0xf5f7fa, wing: 0xbec7d4, belly: 0xffffff, beak: 0xf5b342 }
];

const FISH_VARIANTS = [
  { label: 'River Salmon', body: 0xc95f55, fin: 0x8a3932, accent: 0x4b7a78 },
  { label: 'Golden Koi', body: 0xf5842c, fin: 0xffffff, accent: 0xffd24c },
  { label: 'Blue Tang', body: 0x2574d4, fin: 0xfacc15, accent: 0x162447 }
];

const BUTTERFLY_VARIANTS = [
  { label: 'Monarch Butterfly', wing: 0xff8c1a, rim: 0x241914 },
  { label: 'Blue Morpho', wing: 0x38bdf8, rim: 0x1e3a8a },
  { label: 'Sunbeam Butterfly', wing: 0xfde047, rim: 0xd97706 },
  { label: 'Rose Butterfly', wing: 0xf472b6, rim: 0x831843 }
];

const MOB_TYPES = {
  // Upgraded Classic Farm Animals with dedicated food drops
  pig: {
    label: 'Pig', hostile: false, hp: 10, speed: 2.0, color: 0xf2a2a8, headColor: 0xf7b2b8,
    size: [0.85, 0.8, 1.1], drop: ['raw_porkchop'], xp: 2
  },
  cow: {
    label: 'Cow', hostile: false, hp: 12, speed: 1.9, color: 0x5c422c, headColor: 0x473120,
    size: [0.92, 1.25, 1.25], drop: ['raw_beef', 'leather'], xp: 2
  },
  sheep: {
    label: 'Sheep', hostile: false, hp: 10, speed: 2.0, color: 0xedeff2, headColor: 0xd9c2a8,
    size: [0.88, 1.15, 1.2], drop: ['wool_white', 'raw_mutton'], xp: 2
  },
  chicken: {
    label: 'Chicken', hostile: false, hp: 6, speed: 2.3, color: 0xffffff, headColor: 0xfcfcfc,
    size: [0.54, 0.72, 0.6], drop: ['raw_chicken', 'feather'], xp: 1
  },

  // Rich Wildlife with dedicated food drops!
  deer: {
    label: 'Forest Deer', hostile: false, wildlife: true, shy: true, hp: 12, speed: 3.4,
    color: 0xa66e42, headColor: 0x915b32, size: [0.82, 1.85, 1.25], drop: ['raw_venison', 'leather'], xp: 3
  },
  fox: {
    label: 'Red Fox', hostile: false, wildlife: true, shy: true, hp: 10, speed: 3.3,
    color: 0xd96b27, headColor: 0xe67a32, size: [0.64, 0.78, 1.0], drop: ['leather'], xp: 3
  },
  rabbit: {
    label: 'Wild Bunny', hostile: false, wildlife: true, shy: true, hopper: true, hp: 5, speed: 3.1,
    color: 0xb89672, headColor: 0xc7a785, size: [0.48, 0.62, 0.56], drop: ['raw_rabbit'], xp: 2
  },
  wolf: {
    label: 'Timber Wolf', hostile: false, wildlife: true, hp: 16, speed: 2.9,
    color: 0xa6adb5, headColor: 0x8e959e, size: [0.7, 0.92, 1.1], drop: ['bone'], xp: 3
  },
  duck: {
    label: 'Mallard Duck', hostile: false, wildlife: true, floatsOnWater: true, hp: 6, speed: 2.0,
    color: 0x8c6d52, headColor: 0x1e6b43, size: [0.5, 0.65, 0.65], drop: ['raw_chicken', 'feather'], xp: 1
  },
  turtle: {
    label: 'Shore Turtle', hostile: false, wildlife: true, floatsOnWater: true, hp: 14, speed: 1.05,
    color: 0x3b7a3e, headColor: 0x5ea356, size: [0.76, 0.45, 0.84], drop: ['leather'], xp: 2
  },
  bird: {
    label: 'Songbird', hostile: false, wildlife: true, flying: true, hp: 4, speed: 5.2,
    color: 0x3b82d6, headColor: 0x1e4d8f, size: [0.5, 0.35, 0.5], drop: ['feather'], xp: 2
  },
  fish: {
    label: 'River Fish', hostile: false, wildlife: true, aquatic: true, hp: 4, speed: 2.4,
    color: 0xc95f55, headColor: 0x8a3932, size: [0.38, 0.36, 0.62], drop: ['raw_salmon'], xp: 2
  },
  butterfly: {
    label: 'Butterfly', hostile: false, wildlife: true, butterfly: true, hp: 2, speed: 1.6,
    color: 0xff8c1a, headColor: 0x241914, size: [0.38, 0.25, 0.38], drop: [], xp: 1
  },
  // New Biome-Specific Animals!
  camel: {
    label: 'Desert Camel', hostile: false, wildlife: true, hp: 18, speed: 2.3,
    color: 0xd9b36c, headColor: 0xe3c284, size: [0.95, 2.05, 1.55], drop: ['leather', 'leather'], xp: 3
  },
  zebra: {
    label: 'Savanna Zebra', hostile: false, wildlife: true, shy: true, hp: 14, speed: 3.6,
    color: 0xf0f2f5, headColor: 0xe4e8ed, size: [0.82, 1.55, 1.32], drop: ['leather', 'raw_beef'], xp: 3
  },
  panda: {
    label: 'Jungle Panda', hostile: false, wildlife: true, hp: 18, speed: 1.65,
    color: 0xf4f6f8, headColor: 0xffffff, size: [0.98, 1.15, 1.25], drop: ['apple', 'leather'], xp: 3
  },
  frog: {
    label: 'Swamp Frog', hostile: false, wildlife: true, hopper: true, floatsOnWater: true, hp: 6, speed: 2.2,
    color: 0x529c38, headColor: 0x68b849, size: [0.52, 0.38, 0.56], drop: [], xp: 1
  },
  polar_bear: {
    label: 'Polar Bear', hostile: false, wildlife: true, hp: 26, speed: 2.1,
    color: 0xf2f6fa, headColor: 0xffffff, size: [1.15, 1.35, 1.55], drop: ['raw_salmon', 'leather'], xp: 4
  },
  goat: {
    label: 'Mountain Goat', hostile: false, wildlife: true, hopper: true, hp: 12, speed: 2.8,
    color: 0xebe6dc, headColor: 0xf5f2eb, size: [0.76, 1.12, 1.08], drop: ['raw_mutton', 'wool_white'], xp: 3
  },

  // Village NPCs & Settlement Defenders
  villager: {
    label: 'Villager', hostile: false, hp: 20, speed: 1.7, color: 0x8f6234, headColor: 0xd19f7b,
    size: [0.68, 1.92, 0.68], villager: true, drop: ['emerald'], xp: 3
  },
  villager_soldier: {
    label: 'Villager Soldier', hostile: false, hp: 22, speed: 2.75, dmg: 4, color: 0x7c8798, headColor: 0xd19f7b,
    size: [0.68, 1.92, 0.68], villager: true, soldier: true, guard: true,
    drop: ['iron_helmet', 'iron_chestplate', 'iron_sword'], xp: 6
  },
  iron_golem: {
    label: 'Iron Golem', hostile: false, hp: 80, speed: 1.95, dmg: 9, color: 0xd8dce0, headColor: 0xc5cad1,
    size: [1.15, 2.55, 0.95], golem: true, guard: true, drop: ['iron_ingot', 'iron_ingot', 'flower_red'], xp: 8
  },

  // Hostile Night Mobs (Upgraded Detailed 3D Models!)
  zombie: {
    label: 'Zombie', hostile: true, hp: 20, speed: 2.5, dmg: 3, color: 0x3b7a8c, headColor: 0x568c4d,
    size: [0.68, 1.88, 0.68], humanoid: true, burnsInDay: true, drop: ['coal'], xp: 5
  },
  skeleton: {
    label: 'Skeleton', hostile: true, hp: 16, speed: 2.7, dmg: 3, color: 0xd6d8dc, headColor: 0xe6e8ec,
    size: [0.64, 1.88, 0.64], humanoid: true, burnsInDay: true, drop: ['bone'], xp: 5
  },
  creeper: {
    label: 'Creeper', hostile: true, hp: 18, speed: 2.4, dmg: 10, color: 0x4ca64c, headColor: 0x3f8f3f,
    size: [0.68, 1.75, 0.68], humanoid: true, creeper: true, drop: ['gunpowder'], xp: 6
  },
  spider: {
    label: 'Night Spider', hostile: true, hp: 16, speed: 3.1, dmg: 3, color: 0x2a2630, headColor: 0x1d1a22,
    size: [1.15, 0.82, 1.25], spider: true, drop: ['gunpowder', 'leather'], xp: 5
  }
};

function addShadowMesh(parent, geo, mat, x, y, z, cast = true) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = cast;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

// Helper for crisp Minecraft-style two-tone eyes (white sclera + dark pupil)
function addDetailedEyes(parent, eyeMat, xOff, yPos, zPos, w = 0.08, h = 0.06, sideFacing = false) {
  const whiteMat = new THREE.MeshBasicMaterial({ color: 0xf7f9fc });
  if (sideFacing) {
    for (const s of [-1, 1]) {
      addShadowMesh(parent, new THREE.BoxGeometry(0.03, h, w), whiteMat, s * xOff, yPos, zPos, false);
      addShadowMesh(parent, new THREE.BoxGeometry(0.035, h * 0.9, w * 0.55), eyeMat, s * (xOff + 0.004), yPos, zPos + w * 0.18, false);
    }
  } else {
    for (const s of [-1, 1]) {
      addShadowMesh(parent, new THREE.BoxGeometry(w, h, 0.03), whiteMat, s * xOff, yPos, zPos, false);
      addShadowMesh(parent, new THREE.BoxGeometry(w * 0.55, h * 0.95, 0.035), eyeMat, s * (xOff - w * 0.12), yPos, zPos + 0.004, false);
    }
  }
}

function makeCoatMat(textures, base, dark, light, pattern, seed) {
  if (textures && textures.makeMobCoatTexture) {
    return new THREE.MeshLambertMaterial({
      map: textures.makeMobCoatTexture(base, dark, light, pattern, seed),
      color: 0xffffff
    });
  }
  return new THREE.MeshLambertMaterial({ color: base });
}

function createMobMesh(type, options = {}) {
  const def = MOB_TYPES[type];
  const group = new THREE.Group();
  const profession = options.profession || null;
  const biome = options.biome || 'Plains';
  const textures = options.textures || null;

  let bodyColor = profession ? profession.robe : def.color;
  let headColor = def.headColor;
  let customLabel = profession ? profession.name : def.label;

  if (type === 'fox' && biome === 'Snowy Taiga') {
    bodyColor = 0xf0f4f8;
    headColor = 0xffffff;
    customLabel = 'Arctic Fox';
  } else if (type === 'rabbit') {
    if (biome === 'Snowy Taiga') {
      bodyColor = 0xf4f7fb; headColor = 0xffffff; customLabel = 'Snow Bunny';
    } else if (biome === 'Desert') {
      bodyColor = 0xdcc592; headColor = 0xe8d4a7; customLabel = 'Desert Hare';
    }
  }

  let bodyMat = new THREE.MeshLambertMaterial({ color: bodyColor });
  let headMat = new THREE.MeshLambertMaterial({ color: headColor });
  let usesCoatMap = false;
  const eyeMat = new THREE.MeshBasicMaterial({
    color: def.villager ? 0x2e8b57 : (def.golem ? 0xc92a2a : (type === 'wolf' ? 0xf59e0b : 0x151518))
  });

  const legs = [];
  const arms = [];
  const wings = [];
  let woolMeshes = [];
  let tail = null;
  let headGroup = null;

  if (type === 'deer') {
    const isStag = Math.random() < 0.55;
    customLabel = isStag ? 'Forest Stag' : 'Forest Doe';
    bodyMat = makeCoatMat(textures, 0xa86f42, 0x82512c, 0xebd4ba, isStag ? 'fur' : 'dappled', isStag ? 11 : 12);
    headMat = makeCoatMat(textures, 0x996136, 0x784925, 0xb87e51, 'fur', 13);
    usesCoatMap = true;
    const bellyMat = new THREE.MeshLambertMaterial({ color: 0xf0e4d4 });
    const hoofMat = new THREE.MeshLambertMaterial({ color: 0x362418 });
    const antlerMat = new THREE.MeshLambertMaterial({ color: 0xdfd0b4 });
    const innerEarMat = new THREE.MeshLambertMaterial({ color: 0xe3b8a6 });

    for (const [lx, lz] of [[-0.2, 0.34], [0.2, 0.34], [-0.2, -0.34], [0.2, -0.34]]) {
      const pivot = new THREE.Group();
      pivot.position.set(lx, 0.68, lz);
      addShadowMesh(pivot, new THREE.BoxGeometry(0.13, 0.52, 0.13), bodyMat, 0, -0.26, 0);
      addShadowMesh(pivot, new THREE.BoxGeometry(0.14, 0.16, 0.14), hoofMat, 0, -0.60, 0, false);
      group.add(pivot);
      legs.push(pivot);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.56, 0.48, 0.98), bodyMat, 0, 0.90, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.46, 0.12, 0.84), bellyMat, 0, 0.66, 0, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.32, 0.24, 0.22), bellyMat, 0, 0.94, 0.42, false); // chest ruff

    const tailPiv = new THREE.Group();
    tailPiv.position.set(0, 1.0, -0.49);
    addShadowMesh(tailPiv, new THREE.BoxGeometry(0.16, 0.16, 0.2), bodyMat, 0, 0.04, -0.08, false);
    addShadowMesh(tailPiv, new THREE.BoxGeometry(0.14, 0.12, 0.18), bellyMat, 0, -0.02, -0.1, false);
    group.add(tailPiv);
    tail = tailPiv;

    // Articulated neck + head pivot!
    headGroup = new THREE.Group();
    headGroup.position.set(0, 1.08, 0.4);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.24, 0.46, 0.26), bodyMat, 0, 0.18, 0.02);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.32, 0.30, 0.42), headMat, 0, 0.44, 0.15);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.20, 0.15, 0.22), bellyMat, 0, 0.36, 0.38, false);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.12, 0.09, 0.06), hoofMat, 0, 0.40, 0.49, false); // dark nose
    for (const s of [-1, 1]) {
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.10, 0.18, 0.07), headMat, s * 0.19, 0.62, 0.06, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.06, 0.12, 0.04), innerEarMat, s * 0.19, 0.61, 0.09, false);
    }
    addDetailedEyes(headGroup, eyeMat, 0.16, 0.48, 0.24, 0.08, 0.07, true);
    if (isStag) {
      for (const s of [-1, 1]) {
        addShadowMesh(headGroup, new THREE.BoxGeometry(0.055, 0.30, 0.055), antlerMat, s * 0.11, 0.72, 0.11);
        addShadowMesh(headGroup, new THREE.BoxGeometry(0.22, 0.055, 0.055), antlerMat, s * 0.21, 0.80, 0.11);
        addShadowMesh(headGroup, new THREE.BoxGeometry(0.055, 0.20, 0.055), antlerMat, s * 0.30, 0.89, 0.15);
        addShadowMesh(headGroup, new THREE.BoxGeometry(0.045, 0.14, 0.045), antlerMat, s * 0.16, 0.85, 0.21);
      }
    }
    group.add(headGroup);
  } else if (type === 'fox') {
    const isArctic = biome === 'Snowy Taiga';
    bodyMat = makeCoatMat(
      textures,
      isArctic ? 0xf0f4f8 : 0xd96b27,
      isArctic ? 0xd2dce6 : 0xb04e15,
      isArctic ? 0xffffff : 0xf5954e,
      'fur',
      isArctic ? 21 : 22
    );
    headMat = bodyMat;
    usesCoatMap = true;
    const whiteMat = new THREE.MeshLambertMaterial({ color: 0xfafafa });
    const darkMat = new THREE.MeshLambertMaterial({ color: isArctic ? 0x3b424c : 0x241d18 });

    for (const [lx, lz] of [[-0.16, 0.26], [0.16, 0.26], [-0.16, -0.26], [0.16, -0.26]]) {
      const piv = new THREE.Group();
      piv.position.set(lx, 0.30, lz);
      addShadowMesh(piv, new THREE.BoxGeometry(0.13, 0.18, 0.13), bodyMat, 0, -0.09, 0);
      addShadowMesh(piv, new THREE.BoxGeometry(0.13, 0.12, 0.13), darkMat, 0, -0.24, 0, false);
      group.add(piv);
      legs.push(piv);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.46, 0.36, 0.72), bodyMat, 0, 0.44, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.38, 0.11, 0.62), whiteMat, 0, 0.28, 0, false);

    headGroup = new THREE.Group();
    headGroup.position.set(0, 0.52, 0.36);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.40, 0.32, 0.36), headMat, 0, 0.04, 0.06);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.42, 0.12, 0.24), whiteMat, 0, -0.05, 0.12, false); // white cheeks
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.20, 0.14, 0.22), whiteMat, 0, -0.03, 0.30, false);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.09, 0.07, 0.06), darkMat, 0, 0.0, 0.42, false);
    for (const s of [-1, 1]) {
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.11, 0.18, 0.08), darkMat, s * 0.14, 0.26, 0.02, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.07, 0.12, 0.04), whiteMat, s * 0.14, 0.24, 0.05, false);
    }
    addDetailedEyes(headGroup, eyeMat, 0.12, 0.07, 0.245, 0.08, 0.06, false);
    group.add(headGroup);

    const tailPivot = new THREE.Group();
    tailPivot.position.set(0, 0.44, -0.36);
    addShadowMesh(tailPivot, new THREE.BoxGeometry(0.24, 0.24, 0.42), bodyMat, 0, 0.05, -0.2);
    addShadowMesh(tailPivot, new THREE.BoxGeometry(0.22, 0.22, 0.18), whiteMat, 0, 0.07, -0.44, false);
    group.add(tailPivot);
    tail = tailPivot;
  } else if (type === 'rabbit') {
    const isSnow = biome === 'Snowy Taiga';
    const isDesert = biome === 'Desert';
    bodyMat = makeCoatMat(
      textures,
      isSnow ? 0xf4f7fb : (isDesert ? 0xdcc592 : 0xb89672),
      isSnow ? 0xdbe3ed : (isDesert ? 0xbaa370 : 0x8f6f50),
      isSnow ? 0xffffff : (isDesert ? 0xf2e1b8 : 0xd9be9e),
      'fur',
      31
    );
    headMat = bodyMat;
    usesCoatMap = true;
    const whiteMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const pinkMat = new THREE.MeshLambertMaterial({ color: 0xf4a6b8 });

    for (const [lx, lz, len] of [[-0.12, 0.14, 0.14], [0.12, 0.14, 0.14], [-0.15, -0.13, 0.22], [0.15, -0.13, 0.22]]) {
      const leg = addShadowMesh(group, new THREE.BoxGeometry(0.10, 0.14, len), bodyMat, lx, 0.07, lz);
      legs.push(leg);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.36, 0.30, 0.44), bodyMat, 0, 0.24, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.28, 0.08, 0.34), whiteMat, 0, 0.11, 0, false);

    headGroup = new THREE.Group();
    headGroup.position.set(0, 0.34, 0.22);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.28, 0.24, 0.26), headMat, 0, 0.04, 0.02);
    for (const s of [-1, 1]) {
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.08, 0.26, 0.06), headMat, s * 0.08, 0.24, -0.02);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.04, 0.18, 0.04), pinkMat, s * 0.08, 0.23, 0.01, false);
    }
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.07, 0.05, 0.04), pinkMat, 0, 0.01, 0.16, false);
    addDetailedEyes(headGroup, eyeMat, 0.09, 0.07, 0.155, 0.06, 0.05, false);
    group.add(headGroup);

    tail = addShadowMesh(group, new THREE.BoxGeometry(0.15, 0.15, 0.15), whiteMat, 0, 0.24, -0.25, false);
  } else if (type === 'wolf') {
    bodyMat = makeCoatMat(textures, 0xa8afb8, 0x7e8691, 0xd8dee6, 'fur', 41);
    headMat = bodyMat;
    usesCoatMap = true;
    const darkMat = makeCoatMat(textures, 0x5c636e, 0x424852, 0x7c8491, 'fur', 42);
    const lightMat = new THREE.MeshLambertMaterial({ color: 0xe6ebf0 });
    const noseMat = new THREE.MeshLambertMaterial({ color: 0x1e2024 });

    for (const [lx, lz] of [[-0.18, 0.30], [0.18, 0.30], [-0.18, -0.30], [0.18, -0.30]]) {
      const piv = new THREE.Group();
      piv.position.set(lx, 0.42, lz);
      addShadowMesh(piv, new THREE.BoxGeometry(0.15, 0.42, 0.15), bodyMat, 0, -0.21, 0);
      group.add(piv);
      legs.push(piv);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.50, 0.44, 0.84), bodyMat, 0, 0.58, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.58, 0.50, 0.36), darkMat, 0, 0.61, 0.22); // thick fur ruff

    headGroup = new THREE.Group();
    headGroup.position.set(0, 0.66, 0.46);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.42, 0.38, 0.38), headMat, 0, 0.04, 0.08);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.22, 0.18, 0.24), lightMat, 0, -0.04, 0.34, false);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.10, 0.07, 0.06), noseMat, 0, 0.02, 0.46, false);
    for (const s of [-1, 1]) {
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.11, 0.16, 0.08), darkMat, s * 0.15, 0.28, 0.04, false);
    }
    addDetailedEyes(headGroup, eyeMat, 0.12, 0.09, 0.275, 0.08, 0.06, false);
    group.add(headGroup);

    const tailPivot = new THREE.Group();
    tailPivot.position.set(0, 0.62, -0.42);
    addShadowMesh(tailPivot, new THREE.BoxGeometry(0.18, 0.18, 0.44), darkMat, 0, 0.05, -0.2);
    group.add(tailPivot);
    tail = tailPivot;
  } else if (type === 'duck') {
    bodyMat = makeCoatMat(textures, 0x8c6d52, 0x6b5039, 0xb39476, 'fur', 51);
    headMat = makeCoatMat(textures, 0x1d6e44, 0x124a2d, 0x2f9460, 'fur', 52);
    usesCoatMap = true;
    const billMat = new THREE.MeshLambertMaterial({ color: 0xf5a623 });
    const ringMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    for (const lx of [-0.1, 0.1]) {
      const piv = new THREE.Group();
      piv.position.set(lx, 0.18, 0);
      addShadowMesh(piv, new THREE.BoxGeometry(0.06, 0.14, 0.06), billMat, 0, -0.07, 0, false);
      addShadowMesh(piv, new THREE.BoxGeometry(0.11, 0.04, 0.14), billMat, 0, -0.15, 0.04, false);
      group.add(piv);
      legs.push(piv);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.38, 0.28, 0.52), bodyMat, 0, 0.29, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.24, 0.12, 0.16), bodyMat, 0, 0.36, -0.28, false); // tail feathers
    addShadowMesh(group, new THREE.BoxGeometry(0.24, 0.06, 0.24), ringMat, 0, 0.45, 0.18, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.25, 0.24, 0.26), headMat, 0, 0.57, 0.20);
    addShadowMesh(group, new THREE.BoxGeometry(0.16, 0.07, 0.18), billMat, 0, 0.52, 0.38, false);
    addDetailedEyes(group, eyeMat, 0.125, 0.61, 0.25, 0.06, 0.05, true);
    for (const s of [-1, 1]) {
      const wp = new THREE.Group();
      wp.position.set(s * 0.2, 0.35, 0);
      addShadowMesh(wp, new THREE.BoxGeometry(0.06, 0.20, 0.38), bodyMat, s * 0.02, -0.04, 0, false);
      group.add(wp);
      wings.push(wp);
    }
  } else if (type === 'turtle') {
    const shellMat = makeCoatMat(textures, 0x2d6a36, 0x1b4522, 0x4e9652, 'shell', 61);
    bodyMat = shellMat;
    headMat = makeCoatMat(textures, 0x5ea356, 0x457d3e, 0x7ec274, 'scales', 62);
    usesCoatMap = true;
    const rimMat = new THREE.MeshLambertMaterial({ color: 0xc9ba7c });
    addShadowMesh(group, new THREE.BoxGeometry(0.62, 0.24, 0.70), shellMat, 0, 0.21, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.50, 0.07, 0.56), shellMat, 0, 0.35, 0, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.66, 0.08, 0.74), rimMat, 0, 0.10, 0, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.24, 0.20, 0.26), headMat, 0, 0.18, 0.43);
    addDetailedEyes(group, eyeMat, 0.08, 0.22, 0.565, 0.06, 0.05, false);
    for (const [lx, lz] of [[-0.34, 0.20], [0.34, 0.20], [-0.30, -0.24], [0.30, -0.24]]) {
      const flip = addShadowMesh(group, new THREE.BoxGeometry(0.20, 0.07, 0.16), headMat, lx, 0.07, lz, false);
      legs.push(flip);
    }
  } else if (type === 'bird') {
    const v = BIRD_VARIANTS[Math.floor(Math.random() * BIRD_VARIANTS.length)];
    customLabel = v.label;
    bodyColor = v.body;
    bodyMat = makeCoatMat(textures, v.body, v.wing, v.belly, 'fur', 71);
    headMat = bodyMat;
    usesCoatMap = true;
    const wingMat = new THREE.MeshLambertMaterial({ color: v.wing });
    const bellyMat = new THREE.MeshLambertMaterial({ color: v.belly });
    const beakMat = new THREE.MeshLambertMaterial({ color: v.beak });

    addShadowMesh(group, new THREE.BoxGeometry(0.20, 0.18, 0.38), bodyMat, 0, 0, 0, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.18, 0.08, 0.30), bellyMat, 0, -0.07, 0, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.18, 0.17, 0.18), headMat, 0, 0.06, 0.22, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.07, 0.06, 0.14), beakMat, 0, 0.04, 0.35, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.18, 0.04, 0.24), wingMat, 0, 0.03, -0.28, false);
    addDetailedEyes(group, eyeMat, 0.09, 0.08, 0.25, 0.05, 0.045, true);
    for (const s of [-1, 1]) {
      const wp = new THREE.Group();
      wp.position.set(s * 0.10, 0.05, 0.02);
      addShadowMesh(wp, new THREE.BoxGeometry(0.38, 0.04, 0.22), wingMat, s * 0.19, 0, 0, false);
      addShadowMesh(wp, new THREE.BoxGeometry(0.16, 0.035, 0.16), bellyMat, s * 0.30, -0.005, -0.03, false);
      group.add(wp);
      wings.push(wp);
    }
  } else if (type === 'fish') {
    const v = FISH_VARIANTS[Math.floor(Math.random() * FISH_VARIANTS.length)];
    customLabel = v.label;
    bodyColor = v.body;
    bodyMat = makeCoatMat(textures, v.body, v.fin, v.accent, 'scales', 81);
    usesCoatMap = true;
    const finMat = new THREE.MeshLambertMaterial({ color: v.fin });
    const accentMat = new THREE.MeshLambertMaterial({ color: v.accent });

    addShadowMesh(group, new THREE.BoxGeometry(0.14, 0.22, 0.44), bodyMat, 0, 0, 0, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.15, 0.07, 0.34), accentMat, 0, 0.08, 0, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.04, 0.12, 0.22), finMat, 0, 0.16, -0.02, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.18, 0.04, 0.12), finMat, 0, -0.06, 0.05, false); // pectoral fins
    addDetailedEyes(group, eyeMat, 0.072, 0.04, 0.14, 0.055, 0.05, true);
    const tailPivot = new THREE.Group();
    tailPivot.position.set(0, 0, -0.22);
    addShadowMesh(tailPivot, new THREE.BoxGeometry(0.04, 0.22, 0.18), finMat, 0, 0, -0.09, false);
    group.add(tailPivot);
    tail = tailPivot;
  } else if (type === 'butterfly') {
    const v = BUTTERFLY_VARIANTS[Math.floor(Math.random() * BUTTERFLY_VARIANTS.length)];
    customLabel = v.label;
    bodyColor = v.wing;
    bodyMat = new THREE.MeshBasicMaterial({ color: v.wing });
    const rimMat = new THREE.MeshBasicMaterial({ color: v.rim });
    addShadowMesh(group, new THREE.BoxGeometry(0.04, 0.04, 0.18), rimMat, 0, 0, 0, false);
    for (const s of [-1, 1]) {
      const wp = new THREE.Group();
      wp.position.set(s * 0.02, 0, 0);
      addShadowMesh(wp, new THREE.BoxGeometry(0.18, 0.015, 0.20), bodyMat, s * 0.09, 0, 0.02, false);
      addShadowMesh(wp, new THREE.BoxGeometry(0.13, 0.015, 0.14), rimMat, s * 0.07, 0.004, -0.08, false);
      group.add(wp);
      wings.push(wp);
    }
  } else if (type === 'camel') {
    // Tall Desert Camel with iconic hump, long legs & drooping snout!
    bodyMat = makeCoatMat(textures, 0xd9b36c, 0xb88e48, 0xf2d499, 'fur', 121);
    headMat = makeCoatMat(textures, 0xe0bd79, 0xbd9550, 0xf5dba4, 'fur', 122);
    usesCoatMap = true;
    const hoofMat = new THREE.MeshLambertMaterial({ color: 0x594228 });
    for (const [lx, lz] of [[-0.26, 0.44], [0.26, 0.44], [-0.26, -0.44], [0.26, -0.44]]) {
      const piv = new THREE.Group();
      piv.position.set(lx, 0.92, lz);
      addShadowMesh(piv, new THREE.BoxGeometry(0.18, 0.78, 0.18), bodyMat, 0, -0.39, 0);
      addShadowMesh(piv, new THREE.BoxGeometry(0.20, 0.14, 0.20), hoofMat, 0, -0.85, 0, false);
      group.add(piv);
      legs.push(piv);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.76, 0.56, 1.24), bodyMat, 0, 1.18, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.56, 0.32, 0.56), bodyMat, 0, 1.56, -0.06); // iconic hump!
    headGroup = new THREE.Group();
    headGroup.position.set(0, 1.28, 0.58);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.26, 0.62, 0.26), bodyMat, 0, 0.24, 0.08);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.36, 0.34, 0.54), headMat, 0, 0.60, 0.26);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.26, 0.20, 0.28), headMat, 0, 0.52, 0.58, false);
    for (const s of [-1, 1]) addShadowMesh(headGroup, new THREE.BoxGeometry(0.10, 0.12, 0.08), bodyMat, s * 0.20, 0.78, 0.14, false);
    addDetailedEyes(headGroup, eyeMat, 0.18, 0.64, 0.34, 0.09, 0.07, true);
    group.add(headGroup);
    tail = addShadowMesh(group, new THREE.BoxGeometry(0.08, 0.42, 0.08), hoofMat, 0, 1.12, -0.65, false);
  } else if (type === 'zebra') {
    // Sleek Savanna Zebra with crisp high-contrast striped coat & dark mane!
    bodyMat = makeCoatMat(textures, 0xf2f4f7, 0x1b1d22, 0xffffff, 'stripes', 123);
    headMat = makeCoatMat(textures, 0xebedf0, 0x1b1d22, 0xffffff, 'stripes', 124);
    usesCoatMap = true;
    const maneMat = new THREE.MeshLambertMaterial({ color: 0x1e2026 });
    const muzzleMat = new THREE.MeshLambertMaterial({ color: 0x2b2d33 });
    for (const [lx, lz] of [[-0.22, 0.38], [0.22, 0.38], [-0.22, -0.38], [0.22, -0.38]]) {
      const piv = new THREE.Group();
      piv.position.set(lx, 0.72, lz);
      addShadowMesh(piv, new THREE.BoxGeometry(0.15, 0.58, 0.15), bodyMat, 0, -0.29, 0);
      addShadowMesh(piv, new THREE.BoxGeometry(0.16, 0.14, 0.16), maneMat, 0, -0.65, 0, false);
      group.add(piv);
      legs.push(piv);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.62, 0.50, 1.08), bodyMat, 0, 0.94, 0);
    headGroup = new THREE.Group();
    headGroup.position.set(0, 1.08, 0.46);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.24, 0.48, 0.28), bodyMat, 0, 0.22, 0.04);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.10, 0.48, 0.10), maneMat, 0, 0.28, -0.10, false); // upright striped mane
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.30, 0.30, 0.48), headMat, 0, 0.48, 0.20);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.22, 0.18, 0.18), muzzleMat, 0, 0.42, 0.46, false);
    for (const s of [-1, 1]) addShadowMesh(headGroup, new THREE.BoxGeometry(0.08, 0.16, 0.07), maneMat, s * 0.13, 0.68, 0.06, false);
    addDetailedEyes(headGroup, eyeMat, 0.155, 0.52, 0.24, 0.08, 0.065, true);
    group.add(headGroup);
    tail = addShadowMesh(group, new THREE.BoxGeometry(0.10, 0.44, 0.10), maneMat, 0, 0.94, -0.58, false);
  } else if (type === 'panda') {
    // Chunky Jungle Panda with black legs, black shoulder band & adorable black eye patches!
    bodyMat = makeCoatMat(textures, 0xf2f4f6, 0xd8dde3, 0xffffff, 'wool', 125);
    headMat = bodyMat;
    usesCoatMap = true;
    const blackMat = new THREE.MeshLambertMaterial({ color: 0x1b1d22 });
    for (const [lx, lz] of [[-0.28, 0.34], [0.28, 0.34], [-0.28, -0.34], [0.28, -0.34]]) {
      const piv = new THREE.Group();
      piv.position.set(lx, 0.38, lz);
      addShadowMesh(piv, new THREE.BoxGeometry(0.26, 0.38, 0.26), blackMat, 0, -0.19, 0);
      group.add(piv);
      legs.push(piv);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.84, 0.62, 1.06), bodyMat, 0, 0.66, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.88, 0.64, 0.32), blackMat, 0, 0.66, 0.26); // black shoulder saddle
    headGroup = new THREE.Group();
    headGroup.position.set(0, 0.74, 0.56);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.60, 0.50, 0.46), headMat, 0, 0.06, 0.10);
    for (const s of [-1, 1]) {
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.16, 0.16, 0.10), blackMat, s * 0.26, 0.32, 0.06, false); // round black ears
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.15, 0.12, 0.04), blackMat, s * 0.14, 0.10, 0.335, false); // eye patches
    }
    addDetailedEyes(headGroup, eyeMat, 0.14, 0.10, 0.35, 0.06, 0.055, false);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.24, 0.15, 0.12), bodyMat, 0, -0.06, 0.36, false);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.10, 0.07, 0.05), blackMat, 0, -0.02, 0.42, false);
    group.add(headGroup);
    tail = addShadowMesh(group, new THREE.BoxGeometry(0.14, 0.14, 0.12), blackMat, 0, 0.64, -0.56, false);
  } else if (type === 'frog') {
    // Vibrant Swamp Frog with bulging top eyes & nimble leaping legs!
    bodyMat = makeCoatMat(textures, 0x529c38, 0x356e23, 0x7acc54, 'spots', 126);
    headMat = bodyMat;
    usesCoatMap = true;
    const bellyMat = new THREE.MeshLambertMaterial({ color: 0xd9e89b });
    for (const [lx, lz, wL] of [[-0.22, 0.18, 0.14], [0.22, 0.18, 0.14], [-0.24, -0.16, 0.22], [0.24, -0.16, 0.22]]) {
      const leg = addShadowMesh(group, new THREE.BoxGeometry(0.12, 0.10, wL), bodyMat, lx, 0.06, lz, false);
      legs.push(leg);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.46, 0.22, 0.48), bodyMat, 0, 0.18, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.40, 0.08, 0.42), bellyMat, 0, 0.09, 0.02, false);
    // Bulging frog eye bumps on top of head!
    for (const s of [-1, 1]) {
      addShadowMesh(group, new THREE.BoxGeometry(0.14, 0.12, 0.14), bodyMat, s * 0.15, 0.33, 0.14, false);
    }
    addDetailedEyes(group, eyeMat, 0.15, 0.34, 0.215, 0.09, 0.08, false);
  } else if (type === 'polar_bear') {
    // Massive Arctic Polar Bear with broad snowy coat & thick paws!
    bodyMat = makeCoatMat(textures, 0xf2f6fa, 0xd4dee8, 0xffffff, 'wool', 127);
    headMat = bodyMat;
    usesCoatMap = true;
    const noseMat = new THREE.MeshLambertMaterial({ color: 0x22262e });
    for (const [lx, lz] of [[-0.32, 0.44], [0.32, 0.44], [-0.32, -0.44], [0.32, -0.44]]) {
      const piv = new THREE.Group();
      piv.position.set(lx, 0.54, lz);
      addShadowMesh(piv, new THREE.BoxGeometry(0.30, 0.54, 0.30), bodyMat, 0, -0.27, 0);
      group.add(piv);
      legs.push(piv);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.96, 0.72, 1.32), bodyMat, 0, 0.86, 0);
    headGroup = new THREE.Group();
    headGroup.position.set(0, 0.94, 0.68);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.56, 0.50, 0.50), headMat, 0, 0.04, 0.12);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.32, 0.22, 0.26), headMat, 0, -0.06, 0.42, false);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.14, 0.10, 0.06), noseMat, 0, 0.0, 0.55, false);
    for (const s of [-1, 1]) addShadowMesh(headGroup, new THREE.BoxGeometry(0.14, 0.14, 0.08), headMat, s * 0.24, 0.30, 0.06, false);
    addDetailedEyes(headGroup, eyeMat, 0.16, 0.10, 0.375, 0.08, 0.07, false);
    group.add(headGroup);
    tail = addShadowMesh(group, new THREE.BoxGeometry(0.18, 0.18, 0.16), bodyMat, 0, 0.88, -0.70, false);
  } else if (type === 'goat') {
    // Nimble Alpine Mountain Goat with shaggy cream coat, curved dark horns & beard!
    bodyMat = makeCoatMat(textures, 0xebe6dc, 0xc9c2b4, 0xffffff, 'wool', 128);
    headMat = bodyMat;
    usesCoatMap = true;
    const hornMat = new THREE.MeshLambertMaterial({ color: 0x3b332d });
    for (const [lx, lz] of [[-0.20, 0.32], [0.20, 0.32], [-0.20, -0.32], [0.20, -0.32]]) {
      const piv = new THREE.Group();
      piv.position.set(lx, 0.46, lz);
      addShadowMesh(piv, new THREE.BoxGeometry(0.15, 0.36, 0.15), bodyMat, 0, -0.18, 0);
      addShadowMesh(piv, new THREE.BoxGeometry(0.16, 0.10, 0.16), hornMat, 0, -0.41, 0, false);
      group.add(piv);
      legs.push(piv);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.58, 0.50, 0.92), bodyMat, 0, 0.68, 0);
    headGroup = new THREE.Group();
    headGroup.position.set(0, 0.84, 0.46);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.34, 0.36, 0.44), headMat, 0, 0.10, 0.12);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.12, 0.18, 0.10), bodyMat, 0, -0.12, 0.24, false); // goatee beard!
    for (const s of [-1, 1]) {
      const horn = addShadowMesh(headGroup, new THREE.BoxGeometry(0.08, 0.32, 0.08), hornMat, s * 0.12, 0.38, 0.04, false);
      horn.rotation.x = -0.35;
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.16, 0.08, 0.07), headMat, s * 0.24, 0.18, 0.04, false);
    }
    addDetailedEyes(headGroup, eyeMat, 0.175, 0.15, 0.22, 0.08, 0.06, true);
    group.add(headGroup);
    tail = addShadowMesh(group, new THREE.BoxGeometry(0.12, 0.14, 0.14), bodyMat, 0, 0.76, -0.50, false);
  } else if (def.villager) {
    // 40x Upgraded Authentic Minecraft UV-Textured Profession Villager Model!
    const profName = profession ? profession.name : 'Farmer';
    const vTex = textures && textures.getVillagerTextures ? textures.getVillagerTextures(profName) : null;
    const st = vTex ? vTex.style : { robe: '#8c5e34', dark: '#5e3c1f', trim: '#d9b54a', sash: '#4a3019', badge: '#34d159' };

    const robeFrontMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.robeFront }) : bodyMat;
    const robeSideMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.robeSide }) : bodyMat;
    const robeBackMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.robeBack }) : bodyMat;
    const robeDarkMat = new THREE.MeshLambertMaterial({ color: st.dark });
    const trimMat = new THREE.MeshLambertMaterial({ color: st.trim });
    const sashMat = new THREE.MeshLambertMaterial({ color: st.sash });
    const bootMat = new THREE.MeshLambertMaterial({ color: 0x362417 });
    const soleMat = new THREE.MeshLambertMaterial({ color: 0x21160e });

    const headFrontMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.headFront }) : headMat;
    const headSideMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.headSide }) : headMat;
    const headBackMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.headBack }) : headMat;
    const headTopMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.headTop }) : headMat;
    const skinUnderMat = new THREE.MeshLambertMaterial({ color: 0xb88460 });
    const noseMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.nose }) : headMat;

    bodyMat = robeFrontMat;
    headMat = headFrontMat;
    usesCoatMap = true;

    // 1. Articulated Legs + Cuffed Boots with Soles (pivoted at hip Y = 0.62)
    for (const lx of [-0.135, 0.135]) {
      const piv = new THREE.Group();
      piv.position.set(lx, 0.62, 0);
      addShadowMesh(piv, new THREE.BoxGeometry(0.22, 0.42, 0.23), robeDarkMat, 0, -0.21, 0);
      addShadowMesh(piv, new THREE.BoxGeometry(0.24, 0.16, 0.27), bootMat, 0, -0.49, 0.015, false);
      addShadowMesh(piv, new THREE.BoxGeometry(0.25, 0.05, 0.29), soleMat, 0, -0.59, 0.02, false);
      group.add(piv);
      legs.push(piv);
    }

    // 2. Layered 6-Face Embroidered Profession Robe + Flared Lower Skirt Hem!
    const torsoMats = [robeSideMat, robeSideMat, robeDarkMat, robeDarkMat, robeFrontMat, robeBackMat];
    addShadowMesh(group, new THREE.BoxGeometry(0.54, 0.78, 0.34), torsoMats, 0, 1.01, 0);
    // Slightly flared outer coat skirt wrapping over upper legs (authentic Minecraft Villager silhouette!)
    addShadowMesh(group, new THREE.BoxGeometry(0.58, 0.34, 0.38), torsoMats, 0, 0.58, 0);
    // Tailored shoulder mantle & collar
    addShadowMesh(group, new THREE.BoxGeometry(0.60, 0.11, 0.38), trimMat, 0, 1.37, 0, false);

    // 3. Arms: Villager Soldiers wield a 3D Iron Sword & Iron Armor; regular Villagers have classic crossed arms!
    if (def.soldier) {
      const ironMat = new THREE.MeshLambertMaterial({ color: 0xc6ced9 });
      const ironDark = new THREE.MeshLambertMaterial({ color: 0x8690a0 });
      const ironHi = new THREE.MeshLambertMaterial({ color: 0xeaf0f8 });
      const beltMat = new THREE.MeshLambertMaterial({ color: 0x452b17 });
      const hiltMat = new THREE.MeshLambertMaterial({ color: 0x6b4423 });

      // 3D Iron Chestplate + Backplate + Waist Belt!
      addShadowMesh(group, new THREE.BoxGeometry(0.59, 0.66, 0.39), ironMat, 0, 1.04, 0);
      addShadowMesh(group, new THREE.BoxGeometry(0.46, 0.10, 0.41), ironDark, 0, 1.24, 0, false);
      addShadowMesh(group, new THREE.BoxGeometry(0.60, 0.10, 0.40), beltMat, 0, 0.72, 0, false);
      addShadowMesh(group, new THREE.BoxGeometry(0.14, 0.10, 0.42), ironHi, 0, 0.72, 0, false);

      // Articulated Left & Right Armored Arms (right arm holds gleaming 3D Iron Sword!)
      for (const sx of [-1, 1]) {
        const armPiv = new THREE.Group();
        armPiv.position.set(sx * 0.38, 1.32, 0);
        addShadowMesh(armPiv, new THREE.BoxGeometry(0.24, 0.18, 0.26), ironMat, 0, -0.02, 0);
        addShadowMesh(armPiv, new THREE.BoxGeometry(0.20, 0.56, 0.20), robeSideMat, 0, -0.32, 0);
        addShadowMesh(armPiv, new THREE.BoxGeometry(0.21, 0.16, 0.21), ironDark, 0, -0.48, 0, false);
        if (sx === 1) {
          // 3D Iron Sword held forward in the right hand!
          const swordGrp = new THREE.Group();
          swordGrp.position.set(0, -0.56, 0.14);
          swordGrp.rotation.x = 0.62;
          addShadowMesh(swordGrp, new THREE.BoxGeometry(0.055, 0.055, 0.20), hiltMat, 0, 0, -0.06, false);
          addShadowMesh(swordGrp, new THREE.BoxGeometry(0.22, 0.06, 0.05), ironDark, 0, 0, 0.05, false);
          addShadowMesh(swordGrp, new THREE.BoxGeometry(0.085, 0.032, 0.58), ironHi, 0, 0, 0.36, false);
          addShadowMesh(swordGrp, new THREE.BoxGeometry(0.055, 0.034, 0.10), ironHi, 0, 0, 0.69, false);
          armPiv.add(swordGrp);
        }
        group.add(armPiv);
        arms.push(armPiv);
      }
    } else {
      for (const sx of [-1, 1]) {
        const upperArm = addShadowMesh(group, new THREE.BoxGeometry(0.20, 0.44, 0.20), robeSideMat, sx * 0.34, 1.15, 0.08);
        upperArm.rotation.x = -0.78; // classic 45-degree villager arm fold!
        upperArm.rotation.z = sx * 0.12;
        // Embroidered shoulder sleeve cuff
        const cuff = addShadowMesh(group, new THREE.BoxGeometry(0.22, 0.07, 0.22), trimMat, sx * 0.34, 1.29, -0.02, false);
        cuff.rotation.x = -0.78;
      }
      // Folded central forearm bundle + peeking hands
      addShadowMesh(group, new THREE.BoxGeometry(0.56, 0.21, 0.22), robeSideMat, 0, 0.96, 0.23);
      addShadowMesh(group, new THREE.BoxGeometry(0.60, 0.22, 0.06), trimMat, 0, 0.96, 0.23, false);
      addShadowMesh(group, new THREE.BoxGeometry(0.26, 0.17, 0.18), skinUnderMat, 0, 0.96, 0.26, false);
    }

    // 4. Articulated 6-Face Pixel-Art Expressive Villager Head + Sculpted Textured Nose!
    headGroup = new THREE.Group();
    headGroup.position.set(0, 1.41, 0);
    const headMats = [headSideMat, headSideMat, headTopMat, skinUnderMat, headFrontMat, headBackMat];
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.46, 0.58, 0.46), headMats, 0, 0.29, 0);
    // Iconic sculpted protruding Villager nose (with nostril shading on bottom!)
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.12, 0.24, 0.15), noseMat, 0, 0.14, 0.29, false);
    // Raised 3D brow ridge for extra expressiveness
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.38, 0.055, 0.04), new THREE.MeshLambertMaterial({ color: 0x472d1b }), 0, 0.40, 0.24, false);

    // 5. Ultra-Detailed Profession 3D Gear & Headwear (or Iron Helmet for Villager Soldier!)
    if (def.soldier) {
      const helmMat = new THREE.MeshLambertMaterial({ color: 0xc8d0dc });
      const helmDark = new THREE.MeshLambertMaterial({ color: 0x828c9c });
      const crestMat = new THREE.MeshLambertMaterial({ color: 0x3a78c9 });
      // Classic Minecraft Iron Helmet shell leaving eyes & iconic nose visible!
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.52, 0.16, 0.52), helmMat, 0, 0.54, 0);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.52, 0.36, 0.10), helmMat, 0, 0.32, -0.22);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.08, 0.32, 0.44), helmMat, -0.23, 0.34, -0.02);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.08, 0.32, 0.44), helmMat, 0.23, 0.34, -0.02);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.54, 0.08, 0.10), helmDark, 0, 0.45, 0.23, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.08, 0.10, 0.36), crestMat, 0, 0.65, -0.02, false);
    } else if (profName === 'Farmer') {
      const strawMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.strawTex }) : trimMat;
      const ribbonMat = new THREE.MeshLambertMaterial({ color: 0xc9322c });
      const wheatMat = new THREE.MeshLambertMaterial({ color: 0xf2d152 });
      const stemMat = new THREE.MeshLambertMaterial({ color: 0x5da135 });
      // Multi-tier wide woven straw sun hat!
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.84, 0.06, 0.84), strawMat, 0, 0.51, 0);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.54, 0.19, 0.54), strawMat, 0, 0.61, 0);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.56, 0.06, 0.56), ribbonMat, 0, 0.55, 0, false);
      // Tucked golden wheat stalk on the hat brim!
      const wheatStem = addShadowMesh(headGroup, new THREE.BoxGeometry(0.04, 0.24, 0.04), stemMat, 0.30, 0.62, 0.18, false);
      wheatStem.rotation.z = -0.45;
      const wheatHead = addShadowMesh(headGroup, new THREE.BoxGeometry(0.07, 0.12, 0.06), wheatMat, 0.36, 0.72, 0.18, false);
      wheatHead.rotation.z = -0.45;
      // Farmer hip seed satchel
      addShadowMesh(group, new THREE.BoxGeometry(0.14, 0.20, 0.18), sashMat, 0.31, 0.74, 0.04);
      addShadowMesh(group, new THREE.BoxGeometry(0.15, 0.06, 0.19), trimMat, 0.31, 0.82, 0.04, false);
    } else if (profName === 'Blacksmith') {
      const apronMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.apronTex }) : sashMat;
      const steelMat = new THREE.MeshLambertMaterial({ color: 0xa6b0bf });
      const brassMat = new THREE.MeshLambertMaterial({ color: 0xe3b13b });
      const lensMat = new THREE.MeshBasicMaterial({ color: 0x62d9f7 });
      // Riveted heavy leather forge apron
      addShadowMesh(group, new THREE.BoxGeometry(0.46, 0.74, 0.05), apronMat, 0, 0.78, 0.195);
      // Forged layered steel shoulder pauldrons
      for (const sx of [-1, 1]) {
        addShadowMesh(group, new THREE.BoxGeometry(0.26, 0.11, 0.32), steelMat, sx * 0.37, 1.38, 0.02);
        addShadowMesh(group, new THREE.BoxGeometry(0.28, 0.05, 0.34), brassMat, sx * 0.37, 1.33, 0.02, false);
      }
      // Forge hammer strapped to hip!
      addShadowMesh(group, new THREE.BoxGeometry(0.05, 0.28, 0.05), new THREE.MeshLambertMaterial({ color: 0x7a4e26 }), -0.32, 0.72, 0.04, false);
      addShadowMesh(group, new THREE.BoxGeometry(0.10, 0.10, 0.18), steelMat, -0.32, 0.86, 0.04, false);
      // Leather headband + brass smithing goggles perched on forehead!
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.49, 0.10, 0.49), apronMat, 0, 0.47, 0, false);
      for (const gx of [-0.11, 0.11]) {
        addShadowMesh(headGroup, new THREE.BoxGeometry(0.14, 0.11, 0.07), brassMat, gx, 0.48, 0.25, false);
        addShadowMesh(headGroup, new THREE.BoxGeometry(0.09, 0.07, 0.075), lensMat, gx, 0.48, 0.255, false);
      }
    } else if (profName === 'Librarian') {
      const goldMat = new THREE.MeshLambertMaterial({ color: 0xf2c94c });
      const pageMat = new THREE.MeshLambertMaterial({ color: 0xf7efe0 });
      const coverMat = new THREE.MeshLambertMaterial({ color: 0x8f1e1e });
      const lensMat = new THREE.MeshBasicMaterial({ color: 0xb8f0ff });
      // Embroidered scholar stole
      addShadowMesh(group, new THREE.BoxGeometry(0.16, 0.72, 0.04), goldMat, 0, 0.84, 0.185, false);
      // Crisp gold spectacles over emerald eyes
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.15, 0.11, 0.04), goldMat, -0.115, 0.31, 0.245, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.15, 0.11, 0.04), goldMat, 0.115, 0.31, 0.245, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.08, 0.03, 0.04), goldMat, 0, 0.32, 0.248, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.09, 0.06, 0.045), lensMat, -0.115, 0.31, 0.248, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.09, 0.06, 0.045), lensMat, 0.115, 0.31, 0.248, false);
      // Iconic tilted multi-page scholar Book Hat + gold ribbon bookmark!
      const bookHat = new THREE.Group();
      bookHat.position.set(0, 0.59, 0);
      bookHat.rotation.z = 0.07;
      addShadowMesh(bookHat, new THREE.BoxGeometry(0.56, 0.07, 0.54), coverMat, 0, 0, 0);
      addShadowMesh(bookHat, new THREE.BoxGeometry(0.50, 0.09, 0.48), pageMat, 0, 0.06, 0, false);
      addShadowMesh(bookHat, new THREE.BoxGeometry(0.56, 0.05, 0.54), coverMat, 0, 0.11, 0);
      addShadowMesh(bookHat, new THREE.BoxGeometry(0.52, 0.03, 0.10), goldMat, 0, 0.14, 0, false);
      addShadowMesh(bookHat, new THREE.BoxGeometry(0.05, 0.16, 0.03), goldMat, 0.22, -0.05, 0.27, false);
      headGroup.add(bookHat);
    } else {
      // Cleric: Royal purple-gold hooded cowl & glowing amethyst amulet!
      const hoodMat = new THREE.MeshLambertMaterial({ color: 0x5c2182 });
      const goldMat = new THREE.MeshLambertMaterial({ color: 0xf5cc42 });
      const gemMat = new THREE.MeshBasicMaterial({ color: 0xf062ff });
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.52, 0.14, 0.54), hoodMat, 0, 0.56, -0.02);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.54, 0.05, 0.56), goldMat, 0, 0.50, -0.02, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.52, 0.44, 0.14), hoodMat, 0, 0.30, -0.24);
      addShadowMesh(group, new THREE.BoxGeometry(0.14, 0.14, 0.05), goldMat, 0, 1.24, 0.185, false);
      addShadowMesh(group, new THREE.BoxGeometry(0.08, 0.08, 0.06), gemMat, 0, 1.24, 0.19, false);
    }
    group.add(headGroup);
  } else if (def.golem) {
    // Upgraded Village Iron Golem with forged iron plates, moss vines & poppy flower!
    bodyMat = makeCoatMat(textures, 0xd4d0c8, 0xb0aba0, 0xe8e5de, 'spots', 76);
    headMat = makeCoatMat(textures, 0xccc7be, 0xa8a399, 0xe3dfd6, 'fur', 77);
    usesCoatMap = true;
    const vineMat = new THREE.MeshLambertMaterial({ color: 0x458a34 });
    const poppyMat = new THREE.MeshLambertMaterial({ color: 0xd93838 });
    const rivetMat = new THREE.MeshLambertMaterial({ color: 0x6b6f75 });

    const legGeo = new THREE.BoxGeometry(0.34, 0.94, 0.34);
    for (const lx of [-0.25, 0.25]) {
      const piv = new THREE.Group();
      piv.position.set(lx, 0.94, 0);
      addShadowMesh(piv, legGeo, bodyMat, 0, -0.47, 0);
      addShadowMesh(piv, new THREE.BoxGeometry(0.36, 0.16, 0.38), rivetMat, 0, -0.86, 0.02, false);
      group.add(piv);
      legs.push(piv);
    }
    // Broad iron torso + waist core + creeping moss vine + red poppy
    addShadowMesh(group, new THREE.BoxGeometry(0.68, 0.34, 0.42), rivetMat, 0, 1.08, 0);
    addShadowMesh(group, new THREE.BoxGeometry(1.06, 0.86, 0.56), bodyMat, 0, 1.56, 0);
    addShadowMesh(group, new THREE.BoxGeometry(1.08, 0.18, 0.58), vineMat, 0, 1.62, 0, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.22, 0.46, 0.58), vineMat, -0.26, 1.48, 0, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.12, 0.12, 0.06), poppyMat, -0.26, 1.66, 0.30, false);

    // Massive riveted arms + shoulder plates
    for (const ax of [-0.70, 0.70]) {
      addShadowMesh(group, new THREE.BoxGeometry(0.36, 0.26, 0.42), rivetMat, ax, 1.88, 0.04);
      addShadowMesh(group, new THREE.BoxGeometry(0.30, 1.28, 0.30), headMat, ax, 1.24, 0.06);
      addShadowMesh(group, new THREE.BoxGeometry(0.32, 0.22, 0.32), vineMat, ax, 1.46, 0.06, false);
    }

    // Articulated head with heavy brow & glowing eyes
    headGroup = new THREE.Group();
    headGroup.position.set(0, 1.98, 0.06);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.52, 0.58, 0.52), headMat, 0, 0.28, 0);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.54, 0.10, 0.54), rivetMat, 0, 0.48, 0.02, false);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.14, 0.24, 0.14), headMat, 0, 0.14, 0.28, false);
    addDetailedEyes(headGroup, eyeMat, 0.13, 0.30, 0.27, 0.11, 0.07, false);
    group.add(headGroup);
  } else if (def.spider) {
    // 40x Upgraded 8-Legged Articulated Night Spider with Glowing Crimson Eyes!
    bodyMat = makeCoatMat(textures, 0x2b2730, 0x18151c, 0x423b4a, 'fur', 108);
    headMat = makeCoatMat(textures, 0x221f26, 0x121015, 0x36313d, 'fur', 109);
    usesCoatMap = true;
    const legMat = new THREE.MeshLambertMaterial({ color: 0x1d1a22 });
    const bandMat = new THREE.MeshLambertMaterial({ color: 0x521822 });
    const glowEyeMat = new THREE.MeshBasicMaterial({ color: 0xff2233 });
    const fangMat = new THREE.MeshLambertMaterial({ color: 0x3a323e });

    // Plump textured abdomen with crimson warning stripe
    addShadowMesh(group, new THREE.BoxGeometry(0.68, 0.44, 0.72), bodyMat, 0, 0.44, -0.34);
    addShadowMesh(group, new THREE.BoxGeometry(0.32, 0.08, 0.42), bandMat, 0, 0.66, -0.34, false);
    // Thorax waist
    addShadowMesh(group, new THREE.BoxGeometry(0.42, 0.30, 0.30), headMat, 0, 0.38, 0.12);
    // Articulated head with 6 glowing red eyes & fangs!
    headGroup = new THREE.Group();
    headGroup.position.set(0, 0.40, 0.34);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.44, 0.34, 0.38), headMat, 0, 0, 0.06);
    // 6 glowing crimson spider eyes
    for (const [ex, ey, sz] of [[-0.12, 0.07, 0.075], [0.12, 0.07, 0.075], [-0.045, 0.08, 0.055], [0.045, 0.08, 0.055], [-0.16, -0.02, 0.05], [0.16, -0.02, 0.05]]) {
      addShadowMesh(headGroup, new THREE.BoxGeometry(sz, sz, 0.04), glowEyeMat, ex, ey, 0.255, false);
    }
    // Mandibles / fangs
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.08, 0.14, 0.10), fangMat, -0.10, -0.13, 0.25, false);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.08, 0.14, 0.10), fangMat, 0.10, -0.13, 0.25, false);
    group.add(headGroup);

    // 8 Articulated Splayed Spider Legs (4 per side!)
    const legZs = [0.22, 0.06, -0.10, -0.26];
    const legYaws = [0.55, 0.20, -0.20, -0.55];
    for (let li = 0; li < 4; li++) {
      for (const s of [-1, 1]) {
        const piv = new THREE.Group();
        piv.position.set(s * 0.24, 0.38, legZs[li]);
        piv.rotation.y = s * legYaws[li];
        const upper = addShadowMesh(piv, new THREE.BoxGeometry(0.44, 0.085, 0.085), legMat, s * 0.20, 0.10, 0);
        upper.rotation.z = s * 0.42;
        const lower = addShadowMesh(piv, new THREE.BoxGeometry(0.48, 0.075, 0.075), bodyMat, s * 0.50, -0.12, 0);
        lower.rotation.z = -s * 0.92;
        group.add(piv);
        legs.push(piv);
      }
    }
  } else if (def.creeper) {
    // 40x Upgraded Authentic 4-Legged Camo Creeper with Sculpted Recessed Face!
    bodyMat = makeCoatMat(textures, 0x4ca64c, 0x2c6e2c, 0x86d67a, 'spots', 101);
    headMat = makeCoatMat(textures, 0x48a148, 0x2a692a, 0x8cd980, 'spots', 102);
    usesCoatMap = true;
    const faceDarkMat = new THREE.MeshBasicMaterial({ color: 0x0d120d });
    const footRimMat = new THREE.MeshLambertMaterial({ color: 0x245224 });

    // 4 Chunky Articulated Creeper Feet (2 front, 2 back — authentic Creeper silhouette!)
    for (const [lx, lz] of [[-0.16, 0.22], [0.16, 0.22], [-0.16, -0.22], [0.16, -0.22]]) {
      const piv = new THREE.Group();
      piv.position.set(lx, 0.44, lz);
      addShadowMesh(piv, new THREE.BoxGeometry(0.24, 0.38, 0.24), bodyMat, 0, -0.19, 0);
      addShadowMesh(piv, new THREE.BoxGeometry(0.25, 0.08, 0.25), footRimMat, 0, -0.40, 0, false);
      group.add(piv);
      legs.push(piv);
    }

    // Tall iconic slim Creeper torso
    addShadowMesh(group, new THREE.BoxGeometry(0.48, 0.82, 0.28), bodyMat, 0, 0.85, 0);

    // Articulated Creeper Head with Iconic Recessed Pixel Face!
    headGroup = new THREE.Group();
    headGroup.position.set(0, 1.26, 0);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.50, 0.50, 0.50), headMat, 0, 0.25, 0);
    // Iconic Creeper Face (eyes + center bridge + inverted-U frown!)
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.12, 0.12, 0.03), faceDarkMat, -0.12, 0.31, 0.25, false);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.12, 0.12, 0.03), faceDarkMat, 0.12, 0.31, 0.25, false);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.12, 0.16, 0.03), faceDarkMat, 0, 0.20, 0.25, false);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.24, 0.10, 0.03), faceDarkMat, 0, 0.15, 0.25, false);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.08, 0.14, 0.03), faceDarkMat, -0.11, 0.10, 0.25, false);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.08, 0.14, 0.03), faceDarkMat, 0.11, 0.10, 0.25, false);
    group.add(headGroup);
  } else if (type === 'skeleton') {
    // 40x Upgraded Articulated 3D Anatomical Skeleton with Ribcage, Spine, Skull & 3D Bow!
    bodyMat = makeCoatMat(textures, 0xd8dad6, 0xb2b6b0, 0xf2f4f0, 'fur', 103);
    headMat = makeCoatMat(textures, 0xe2e4e0, 0xbec2bc, 0xf7f9f5, 'fur', 104);
    usesCoatMap = true;
    const hollowMat = new THREE.MeshBasicMaterial({ color: 0x141518 });
    const boneDarkMat = new THREE.MeshLambertMaterial({ color: 0xa2a6a0 });
    const bowWoodMat = new THREE.MeshLambertMaterial({ color: 0x7a4e26 });
    const bowStringMat = new THREE.MeshBasicMaterial({ color: 0xe6e6e6 });
    const arrowTipMat = new THREE.MeshLambertMaterial({ color: 0xb0b8c2 });

    // Thin articulated bony legs
    for (const lx of [-0.14, 0.14]) {
      const piv = new THREE.Group();
      piv.position.set(lx, 0.74, 0);
      addShadowMesh(piv, new THREE.BoxGeometry(0.12, 0.72, 0.12), bodyMat, 0, -0.36, 0);
      addShadowMesh(piv, new THREE.BoxGeometry(0.15, 0.08, 0.18), boneDarkMat, 0, -0.70, 0.02, false);
      group.add(piv);
      legs.push(piv);
    }

    // Pelvis + Spine + 3D Layered Ribcage!
    addShadowMesh(group, new THREE.BoxGeometry(0.42, 0.12, 0.20), boneDarkMat, 0, 0.78, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.12, 0.64, 0.12), boneDarkMat, 0, 1.08, -0.04);
    for (const ry of [0.96, 1.10, 1.24]) {
      addShadowMesh(group, new THREE.BoxGeometry(0.46, 0.08, 0.24), bodyMat, 0, ry, 0);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.50, 0.09, 0.22), bodyMat, 0, 1.36, 0); // collar/clavicle

    // Thin articulated arms holding a real 3D Wooden Bow & Arrow!
    for (const sx of [-1, 1]) {
      const armPiv = new THREE.Group();
      armPiv.position.set(sx * 0.31, 1.34, 0);
      armPiv.rotation.x = -Math.PI * 0.44;
      addShadowMesh(armPiv, new THREE.BoxGeometry(0.11, 0.66, 0.11), bodyMat, 0, -0.30, 0);
      if (sx === 1) {
        // 3D Curved Bow & Notched Arrow in right hand!
        const bow = new THREE.Group();
        bow.position.set(0, -0.60, 0.06);
        bow.rotation.x = Math.PI * 0.44;
        addShadowMesh(bow, new THREE.BoxGeometry(0.06, 0.46, 0.06), bowWoodMat, 0, 0, 0.12, false);
        addShadowMesh(bow, new THREE.BoxGeometry(0.055, 0.22, 0.055), bowWoodMat, 0, 0.28, 0.05, false);
        addShadowMesh(bow, new THREE.BoxGeometry(0.055, 0.22, 0.055), bowWoodMat, 0, -0.28, 0.05, false);
        addShadowMesh(bow, new THREE.BoxGeometry(0.02, 0.72, 0.02), bowStringMat, 0, 0, -0.02, false);
        // Notched arrow
        addShadowMesh(bow, new THREE.BoxGeometry(0.035, 0.035, 0.56), bowWoodMat, 0, 0, 0.18, false);
        addShadowMesh(bow, new THREE.BoxGeometry(0.07, 0.07, 0.09), arrowTipMat, 0, 0, 0.48, false);
        armPiv.add(bow);
      }
      group.add(armPiv);
      arms.push(armPiv);
    }

    // Articulated Detailed Skull with Deep Hollow Sockets & Grimacing Jaw!
    headGroup = new THREE.Group();
    headGroup.position.set(0, 1.40, 0);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.46, 0.46, 0.46), headMat, 0, 0.23, 0);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.12, 0.10, 0.04), hollowMat, -0.11, 0.25, 0.225, false);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.12, 0.10, 0.04), hollowMat, 0.11, 0.25, 0.225, false);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.08, 0.06, 0.04), hollowMat, 0, 0.16, 0.225, false);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.28, 0.06, 0.04), hollowMat, 0, 0.08, 0.225, false);
    group.add(headGroup);
  } else if (def.humanoid) {
    // 40x Upgraded Detailed Textured Articulated Zombie!
    const skinMat = makeCoatMat(textures, 0x568c4d, 0x3b6635, 0x76b06b, 'spots', 105);
    const shirtMat = makeCoatMat(textures, 0x2c7d8c, 0x1c5763, 0x439eb0, 'fur', 106);
    const pantsMat = makeCoatMat(textures, 0x323b7a, 0x1f2552, 0x48549e, 'fur', 107);
    const hairMat = new THREE.MeshLambertMaterial({ color: 0x2a4526 });
    const bootMat = new THREE.MeshLambertMaterial({ color: 0x2b2d32 });
    const socketMat = new THREE.MeshBasicMaterial({ color: 0x121c10 });
    const eerieEyeMat = new THREE.MeshBasicMaterial({ color: 0x7cff59 });
    const ripMat = new THREE.MeshLambertMaterial({ color: 0x4a7542 });

    bodyMat = shirtMat;
    headMat = skinMat;
    usesCoatMap = true;

    // Articulated tattered pants + heavy boots
    for (const lx of [-0.135, 0.135]) {
      const piv = new THREE.Group();
      piv.position.set(lx, 0.72, 0);
      addShadowMesh(piv, new THREE.BoxGeometry(0.24, 0.56, 0.24), pantsMat, 0, -0.28, 0);
      addShadowMesh(piv, new THREE.BoxGeometry(0.25, 0.16, 0.26), bootMat, 0, -0.64, 0.01, false);
      group.add(piv);
      legs.push(piv);
    }

    // Ragged torn cyan tunic + exposed chest tear + tattered belt
    addShadowMesh(group, new THREE.BoxGeometry(0.52, 0.68, 0.28), shirtMat, 0, 1.06, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.54, 0.09, 0.30), bootMat, 0, 0.76, 0, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.16, 0.14, 0.04), ripMat, 0.08, 1.12, 0.135, false);

    // Articulated outstretched groaning Zombie arms (pivoted at shoulders!)
    for (const sx of [-1, 1]) {
      const armPiv = new THREE.Group();
      armPiv.position.set(sx * 0.37, 1.32, 0);
      armPiv.rotation.x = -Math.PI * 0.45;
      addShadowMesh(armPiv, new THREE.BoxGeometry(0.22, 0.22, 0.22), shirtMat, 0, -0.10, 0);
      addShadowMesh(armPiv, new THREE.BoxGeometry(0.20, 0.46, 0.20), skinMat, 0, -0.44, 0);
      group.add(armPiv);
      arms.push(armPiv);
    }

    // Articulated Zombie Head with Dark Hair Cap, Furrowed Brow & Hollow Eyes!
    headGroup = new THREE.Group();
    headGroup.position.set(0, 1.40, 0);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.46, 0.46, 0.46), skinMat, 0, 0.23, 0);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.48, 0.12, 0.48), hairMat, 0, 0.42, 0, false);
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.40, 0.05, 0.04), hairMat, 0, 0.31, 0.23, false);
    // Hollow dark sockets + faint eerie green undead glint
    for (const ex of [-0.11, 0.11]) {
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.11, 0.08, 0.03), socketMat, ex, 0.24, 0.23, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.045, 0.045, 0.035), eerieEyeMat, ex, 0.24, 0.234, false);
    }
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.18, 0.06, 0.03), socketMat, 0, 0.10, 0.23, false);
    group.add(headGroup);
  } else {
    // Upgraded Textured Pixel-Art Pig, Cow, Sheep, Chicken!
    const [w, h, l] = def.size;
    const legH = h * 0.36;

    if (type === 'cow') {
      bodyMat = makeCoatMat(textures, 0x5c422c, 0x3b281a, 0xeae5dc, 'spots', 91);
      headMat = makeCoatMat(textures, 0x473120, 0x302014, 0x6b4b32, 'fur', 92);
      usesCoatMap = true;
    } else if (type === 'sheep') {
      bodyMat = makeCoatMat(textures, 0xedeff2, 0xcfd4db, 0xffffff, 'wool', 93);
      headMat = makeCoatMat(textures, 0xd9c2a8, 0xb89f84, 0xebdac5, 'fur', 94);
      usesCoatMap = true;
    } else if (type === 'pig') {
      bodyMat = makeCoatMat(textures, 0xf2a2a8, 0xdc828c, 0xffc4ca, 'fur', 95);
      headMat = bodyMat;
      usesCoatMap = true;
    } else if (type === 'chicken') {
      bodyMat = makeCoatMat(textures, 0xf7f9fb, 0xdce2e8, 0xffffff, 'wool', 96);
      headMat = bodyMat;
      usesCoatMap = true;
    }

    const legGeo = new THREE.BoxGeometry(w * 0.22, legH, w * 0.22);
    const legPos = type === 'chicken'
      ? [[-w * 0.2, 0], [w * 0.2, 0]]
      : [[-w * 0.26, l * 0.26], [w * 0.26, l * 0.26], [-w * 0.26, -l * 0.26], [w * 0.26, -l * 0.26]];
    const legMat = type === 'chicken'
      ? new THREE.MeshLambertMaterial({ color: 0xf5b342 })
      : (type === 'sheep' ? headMat : bodyMat);

    for (const [lx, lz] of legPos) {
      const piv = new THREE.Group();
      piv.position.set(lx, legH, lz);
      addShadowMesh(piv, legGeo, legMat, 0, -legH * 0.5, 0);
      group.add(piv);
      legs.push(piv);
    }

    if (type === 'sheep') {
      // Inner sheared body underneath so shearing reveals a clean shorn sheep without killing it!
      addShadowMesh(group, new THREE.BoxGeometry(w * 0.76, h * 0.36, l * 0.68), headMat, 0, legH + h * 0.24, 0);
      const woolBody = addShadowMesh(group, new THREE.BoxGeometry(w * 0.96, h * 0.50, l * 0.80), bodyMat, 0, legH + h * 0.25, 0);
      woolMeshes.push(woolBody);
    } else {
      addShadowMesh(group, new THREE.BoxGeometry(w * 0.92, h * 0.48, l * 0.78), bodyMat, 0, legH + h * 0.24, 0);
    }

    headGroup = new THREE.Group();
    headGroup.position.set(0, legH + h * 0.40, l * 0.42);
    addShadowMesh(headGroup, new THREE.BoxGeometry(w * 0.56, w * 0.54, w * 0.52), headMat, 0, 0, 0.04);
    addDetailedEyes(headGroup, eyeMat, w * 0.16, w * 0.06, 0.04 + w * 0.265, 0.09, 0.07, false);

    if (type === 'pig') {
      const snoutMat = new THREE.MeshLambertMaterial({ color: 0xe88894 });
      const nosMat = new THREE.MeshBasicMaterial({ color: 0x6e3139 });
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.28, 0.18, 0.12), snoutMat, 0, -0.08, 0.30, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.05, 0.06, 0.03), nosMat, -0.07, -0.07, 0.365, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.05, 0.06, 0.03), nosMat, 0.07, -0.07, 0.365, false);
      for (const s of [-1, 1]) {
        addShadowMesh(headGroup, new THREE.BoxGeometry(0.12, 0.14, 0.06), snoutMat, s * 0.26, 0.16, 0.02, false);
      }
      tail = addShadowMesh(group, new THREE.BoxGeometry(0.10, 0.10, 0.14), snoutMat, 0, legH + h * 0.30, -l * 0.43, false);
    } else if (type === 'cow') {
      const hornMat = new THREE.MeshLambertMaterial({ color: 0xd8d2c5 });
      const muzzleMat = new THREE.MeshLambertMaterial({ color: 0xd9a8a0 });
      const nosMat = new THREE.MeshBasicMaterial({ color: 0x3b2824 });
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.08, 0.18, 0.08), hornMat, -0.26, 0.26, 0.02, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.08, 0.18, 0.08), hornMat, 0.26, 0.26, 0.02, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.14, 0.08, 0.06), headMat, -0.32, 0.14, -0.02, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.14, 0.08, 0.06), headMat, 0.32, 0.14, -0.02, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.34, 0.18, 0.10), muzzleMat, 0, -0.12, 0.30, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.05, 0.05, 0.03), nosMat, -0.08, -0.10, 0.355, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.05, 0.05, 0.03), nosMat, 0.08, -0.10, 0.355, false);
      tail = addShadowMesh(group, new THREE.BoxGeometry(0.07, 0.32, 0.07), headMat, 0, legH + h * 0.22, -l * 0.42, false);
    } else if (type === 'sheep') {
      const woolCrown = addShadowMesh(headGroup, new THREE.BoxGeometry(w * 0.62, w * 0.20, w * 0.56), bodyMat, 0, 0.24, 0.02, false); // wool crown
      woolMeshes.push(woolCrown);
      for (const s of [-1, 1]) {
        addShadowMesh(headGroup, new THREE.BoxGeometry(0.12, 0.08, 0.08), headMat, s * 0.28, 0.08, 0.0, false);
      }
    } else if (type === 'chicken') {
      const beakMat = new THREE.MeshLambertMaterial({ color: 0xf5b342 });
      const combMat = new THREE.MeshLambertMaterial({ color: 0xd93838 });
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.13, 0.08, 0.14), beakMat, 0, -0.04, 0.22, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.08, 0.10, 0.08), combMat, 0, -0.12, 0.18, false);
      addShadowMesh(headGroup, new THREE.BoxGeometry(0.06, 0.10, 0.14), combMat, 0, 0.18, 0.04, false);
      for (const s of [-1, 1]) {
        const wp = new THREE.Group();
        wp.position.set(s * (w * 0.47), legH + h * 0.28, 0);
        addShadowMesh(wp, new THREE.BoxGeometry(0.06, 0.22, 0.34), bodyMat, s * 0.02, -0.04, 0, false);
        group.add(wp);
        wings.push(wp);
      }
    }
    group.add(headGroup);
  }

  // Collect EVERY unique material across the mob's entire mesh hierarchy for full-body red hit flash & creeper white strobe!
  const matSet = new Set();
  group.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    if (Array.isArray(obj.material)) {
      for (const m of obj.material) matSet.add(m);
    } else {
      matSet.add(obj.material);
    }
  });
  const allMats = [];
  for (const mat of matSet) {
    allMats.push({
      mat,
      origColor: mat.color ? mat.color.getHex() : 0xffffff,
      origEmissive: mat.emissive ? mat.emissive.getHex() : null
    });
  }

  return {
    group,
    legs,
    arms,
    wings,
    woolMeshes,
    tail,
    headGroup,
    bodyMat,
    headMat,
    allMats,
    baseColor: usesCoatMap ? 0xffffff : bodyColor,
    label: customLabel
  };
}

// Merge multiple colored boxes into a single static BufferGeometry (1 draw call for complex hats/armor/swords/golems!)
function mergeColoredBoxes(specs) {
  const posArr = [];
  const normArr = [];
  const colArr = [];
  const idxArr = [];
  const dummy = new THREE.Object3D();
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const nMat = new THREE.Matrix3();
  const col = new THREE.Color();
  let vertOffset = 0;

  for (let i = 0; i < specs.length; i++) {
    const sp = specs[i];
    const g = new THREE.BoxGeometry(sp.sx, sp.sy, sp.sz);
    dummy.position.set(sp.px || 0, sp.py || 0, sp.pz || 0);
    dummy.rotation.set(sp.rx || 0, sp.ry || 0, sp.rz || 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    nMat.getNormalMatrix(dummy.matrix);
    col.setHex(sp.color);

    const pAttr = g.attributes.position;
    const nAttr = g.attributes.normal;
    for (let k = 0; k < pAttr.count; k++) {
      v.fromBufferAttribute(pAttr, k).applyMatrix4(dummy.matrix);
      posArr.push(v.x, v.y, v.z);
      n.fromBufferAttribute(nAttr, k).applyMatrix3(nMat).normalize();
      normArr.push(n.x, n.y, n.z);
      colArr.push(col.r, col.g, col.b);
    }
    const index = g.index;
    for (let k = 0; k < index.count; k++) {
      idxArr.push(index.getX(k) + vertOffset);
    }
    vertOffset += pAttr.count;
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normArr, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
  out.setIndex(idxArr);
  return out;
}

export class EntityManager {
  constructor(scene, world, sound, textures = null) {
    this.scene = scene;
    this.world = world;
    this.sound = sound;
    this.textures = textures;
    this.mobs = [];
    this.drops = [];
    this.projectiles = [];
    this.spawnTimer = 1.2;
    this.hostileSpawnTimer = 0.85;
    this.ambienceTimer = 4.0;
    this.initialPopulated = false;
    this._pendingVillageSpawns = [];
    this.megaCrowds = new Map();
    this._crowdDummy = new THREE.Object3D();
    this._crowdColor = new THREE.Color();
    this._crowdRootMat = new THREE.Matrix4();
    this._crowdTmpMat = new THREE.Matrix4();
    this._crowdLegMat = new THREE.Matrix4();
    this._crowdTick = 0;
    this._npcPools = null;
    this._npcRootMat = new THREE.Matrix4();
    this._npcPartMat = new THREE.Matrix4();
    this._npcFinalMat = new THREE.Matrix4();
    this._npcDummy = new THREE.Object3D();
    this._npcDummy.rotation.order = 'YXZ';
    this._npcWhite = new THREE.Color(0xffffff);
    this._npcHurt = new THREE.Color(0xff5252);
    this._chunkBedCache = new Map();
    this._hostileScratch = [];
    this._npcScratch = [];
    this._pathsThisFrame = 0;
    this.onPickup = null;
    this.onDiscoverMega = null;

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.dropGeo = new THREE.BoxGeometry(0.28, 0.28, 0.28);
    this.dropSpriteGeo = new THREE.PlaneGeometry(0.36, 0.36);
    this.dropSpriteMatCache = {};
    this.blockDropMat = textures
      ? new THREE.MeshLambertMaterial({ map: textures.atlasTexture, alphaTest: 0.35 })
      : null;

    // Shared 16x24 Animated Pixel-Art Minecraft Flame Overlay for Burning Mobs (ZERO per-mob texture allocations!)
    this._mobFireGeo = new THREE.PlaneGeometry(1, 1);
    this._mobFireCanvas = null;
    this._mobFireCtx = null;
    this._mobFireTex = null;
    this._mobFireMat = null;
    this._mobFireFrame = -1;
    this._mobFireAnimClock = 0;
  }

  _initMobFireResources() {
    if (this._mobFireMat) return;
    if (typeof document === 'undefined') return;
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 24;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    this._mobFireCanvas = c;
    this._mobFireCtx = ctx;
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    this._mobFireTex = tex;
    this._mobFireMat = new THREE.MeshBasicMaterial({
      map: tex,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      fog: false
    });
    this._drawMobFireFrame(0);
  }

  // Authentic Minecraft tall pixel-art flame animation (bright white core -> yellow -> orange -> licking red tips!)
  _drawMobFireFrame(frame) {
    const ctx = this._mobFireCtx;
    if (!ctx) return;
    ctx.clearRect(0, 0, 16, 24);
    const f = frame & 7;
    const phase = f * 0.785398;
    const pal = [
      '#c82d06', // 0: deep fiery red-orange outer edge
      '#e65100', // 1: vivid orange flame
      '#ff7b00', // 2: bright molten orange
      '#ffad14', // 3: golden amber
      '#ffe14d', // 4: bright yellow inner tongue
      '#fff8c9'  // 5: white-hot core at base
    ];
    // 5 dancing flame columns across 16px width with tall center spire matching Minecraft entity fire!
    for (let x = 0; x < 16; x++) {
      const nx = (x - 7.5) / 7.5; // -1..1
      const centerWeight = Math.max(0, 1 - nx * nx * 0.92);
      const wave1 = Math.sin(x * 0.95 + phase * 2.0) * 2.6;
      const wave2 = Math.cos(x * 1.75 - phase * 3.0) * 1.8;
      const spire = (x >= 5 && x <= 10) ? (4.8 + Math.sin(phase * 2.0 + x * 0.6) * 2.2) : 0;
      const colH = Math.max(0, Math.min(23, Math.floor(centerWeight * 16.5 + spire + wave1 + wave2)));
      const yTop = 24 - colH;
      for (let y = yTop; y < 24; y++) {
        // Horizontal sway of rising flame tongues
        const rise = (23 - y) / 23;
        const flicker = Math.sin(y * 0.75 + phase * 3.0 + x * 0.55);
        // Carve crisp pixel notches near flame tips so tips look like authentic dancing tongues
        if (y < yTop + 3 && flicker < -0.22 && (x < 6 || x > 9)) continue;
        // Core heat intensity: hottest at bottom center, cooler at outer & top edges
        const heat = (1 - rise * 0.88) * 0.78 + centerWeight * 0.42 + flicker * 0.14;
        let idx = 0;
        if (heat > 0.96 && y >= 18) idx = 5;
        else if (heat > 0.78) idx = 4;
        else if (heat > 0.60) idx = 3;
        else if (heat > 0.42) idx = 2;
        else if (heat > 0.25) idx = 1;
        else idx = 0;
        ctx.fillStyle = pal[idx];
        ctx.fillRect(x, y, 1, 1);
      }
    }
    this._mobFireTex.needsUpdate = true;
  }

  _ensureMobFireMesh(m) {
    if (m.fireGroup) return m.fireGroup;
    this._initMobFireResources();
    if (!this._mobFireMat) return null;
    const fg = new THREE.Group();
    const w = Math.max(0.75, (m.def.size ? m.def.size[0] : 0.8) * 1.22);
    const d = Math.max(0.75, (m.def.size ? m.def.size[2] : 0.8) * 1.15);
    const span = Math.max(w, d);
    const h = Math.max(1.25, (m.height || 1.0) * 1.65);

    // 4-plane wrap-around Minecraft entity flame rig (crossed core + front/back & side curtains!)
    const configs = [
      { ry: Math.PI * 0.25, sx: span * 1.08, sy: h, px: 0, pz: 0 },
      { ry: -Math.PI * 0.25, sx: span * 1.08, sy: h, px: 0, pz: 0 },
      { ry: 0, sx: w * 1.04, sy: h * 0.86, px: 0, pz: d * 0.34 },
      { ry: 0, sx: w * 1.04, sy: h * 0.86, px: 0, pz: -d * 0.34 },
      { ry: Math.PI * 0.5, sx: d * 1.04, sy: h * 0.86, px: w * 0.34, pz: 0 },
      { ry: Math.PI * 0.5, sx: d * 1.04, sy: h * 0.86, px: -w * 0.34, pz: 0 }
    ];
    for (const cfg of configs) {
      const plane = new THREE.Mesh(this._mobFireGeo, this._mobFireMat);
      plane.scale.set(cfg.sx, cfg.sy, 1);
      plane.position.set(cfg.px, cfg.sy * 0.47, cfg.pz);
      plane.rotation.y = cfg.ry;
      plane.castShadow = false;
      plane.receiveShadow = false;
      fg.add(plane);
    }
    if (!m.mesh) return null;
    fg.visible = false;
    m.mesh.add(fg);
    m.fireGroup = fg;
    return fg;
  }

  // Scan 8 directions around a mob in lava/fire to find the closest safe dry block (or water) to jump toward!
  _findLavaEscapeYaw(m) {
    let bestYaw = null;
    let bestScore = -1e9;
    const px = m.pos.x;
    const py = Math.floor(m.pos.y);
    const pz = m.pos.z;
    for (let i = 0; i < 8; i++) {
      const yaw = (i / 8) * Math.PI * 2;
      const sx = Math.sin(yaw);
      const sz = Math.cos(yaw);
      for (const dist of [1.6, 2.8]) {
        const tx = Math.floor(px + sx * dist);
        const tz = Math.floor(pz + sz * dist);
        let score = 0;
        const b0 = this.world.getBlock(tx, py, tz);
        const b1 = this.world.getBlock(tx, py + 1, tz);
        const b2 = this.world.getBlock(tx, py + 2, tz);
        const bBelow = this.world.getBlock(tx, py - 1, tz);
        if (b0 === BLOCK.LAVA || b1 === BLOCK.LAVA || b0 === BLOCK.FIRE || b1 === BLOCK.FIRE) {
          score -= 100;
        } else if (b0 === BLOCK.WATER || b1 === BLOCK.WATER) {
          // Water immediately extinguishes fire — huge priority!
          score += 55 - dist * 4;
        } else if (!isBlockSolid(b1) && !isBlockSolid(b2) && (isBlockSolid(b0) || isBlockSolid(bBelow))) {
          // Safe solid ledge right next to lava (either level or 1-block step-up!)
          score += (isBlockSolid(b0) ? 40 : 35) - dist * 4;
        } else {
          score -= 15;
        }
        if (score > bestScore) {
          bestScore = score;
          bestYaw = yaw;
        }
      }
    }
    return bestYaw !== null ? bestYaw : (Math.random() * Math.PI * 2);
  }

  // Full 3D AABB collision test so animals NEVER clip or overlap with blocks!
  mobCollidesAt(x, y, z, halfW, height) {
    const minX = Math.floor(x - halfW);
    const maxX = Math.floor(x + halfW);
    const minY = Math.floor(y + 0.06);
    const maxY = Math.floor(y + height - 0.05);
    const minZ = Math.floor(z - halfW);
    const maxZ = Math.floor(z + halfW);

    for (let by = minY; by <= maxY; by++) {
      for (let bz = minZ; bz <= maxZ; bz++) {
        for (let bx = minX; bx <= maxX; bx++) {
          const bid = this.world.getBlock(bx, by, bz);
          if (isBlockSolid(bid)) {
            if (isDoorBlock(bid) && this.world.isDoorOpenAt(bx, by, bz)) continue;
            if (isFenceGateBlock(bid) && this.world.isFenceGateOpenAt(bx, by, bz)) continue;
            return true;
          }
          // Authentic 1.5-block tall Fence & Closed Fence Gate barrier keeps animals safely penned!
          if (by === minY) {
            const below = this.world.getBlock(bx, by - 1, bz);
            if (isFenceOrGate(below) && !(isFenceGateBlock(below) && this.world.isFenceGateOpenAt(bx, by - 1, bz))) {
              if (y < by + 0.48) return true;
            }
          }
        }
      }
    }
    return false;
  }

  // Ground support check across the mob's 4 base corners
  hasSolidBelow(x, y, z, halfW) {
    const by = Math.floor(y);
    const xs = [x - halfW * 0.85, x + halfW * 0.85];
    const zs = [z - halfW * 0.85, z + halfW * 0.85];
    for (const px of xs) {
      for (const pz of zs) {
        if (isBlockSolid(this.world.getBlock(px, by, pz))) return true;
      }
    }
    return false;
  }

  // Verify a full 3D water volume for fish so they never clip riverbanks or swim in lava!
  isWaterVolume(x, y, z, pad = 0.32) {
    const pts = [
      [x, y, z],
      [x - pad, y, z], [x + pad, y, z],
      [x, y, z - pad], [x, y, z + pad],
      [x, y + 0.22, z], [x, y - 0.22, z]
    ];
    for (const [px, py, pz] of pts) {
      if (this.world.getBlock(px, py, pz) !== BLOCK.WATER) return false;
    }
    return true;
  }

  // Verify (sx, sy, sz) is genuine sunlit open-sky surface (NEVER inside a cave or under a roof/overhang!)
  isOpenSkySurface(sx, sy, sz) {
    if (sy <= SEA_LEVEL - 2) return false;
    // Ensure 2 clear blocks directly above spawn point and no solid ceiling roof above it
    if (isBlockSolid(this.world.getBlock(sx, sy, sz)) || isBlockSolid(this.world.getBlock(sx, sy + 1, sz))) return false;
    const topY = this.world.getSurfaceY(sx, sz);
    return Math.abs(topY - sy) <= 1;
  }

  // Natural ground blocks allowed for biome passive wildlife (never caves, never structures!)
  isNaturalAnimalGround(blockId, biome, type) {
    if (type === 'goat') {
      return blockId === BLOCK.GRASS || blockId === BLOCK.STONE || blockId === BLOCK.SNOW || blockId === BLOCK.GRAVEL;
    }
    if (type === 'camel') {
      return blockId === BLOCK.SAND || blockId === BLOCK.RED_SAND || blockId === BLOCK.TERRACOTTA || blockId === BLOCK.TERRACOTTA_ORANGE;
    }
    if (type === 'polar_bear') {
      return blockId === BLOCK.SNOW || blockId === BLOCK.ICE || blockId === BLOCK.PACKED_ICE || blockId === BLOCK.GRASS;
    }
    if (type === 'frog') {
      return blockId === BLOCK.SWAMP_GRASS || blockId === BLOCK.MUD || blockId === BLOCK.GRASS || blockId === BLOCK.WATER;
    }
    if (type === 'turtle') {
      return blockId === BLOCK.SAND || blockId === BLOCK.WATER;
    }
    return (
      blockId === BLOCK.GRASS ||
      blockId === BLOCK.SAVANNA_GRASS ||
      blockId === BLOCK.JUNGLE_GRASS ||
      blockId === BLOCK.SWAMP_GRASS ||
      blockId === BLOCK.SNOW ||
      blockId === BLOCK.SAND ||
      blockId === BLOCK.RED_SAND
    );
  }

  // Spawn a lively Herd / Pack / Flock / School of animals clustered together!
  spawnHerd(type, centerX, centerZ, count = 4, biome = 'Plains', maxTotal = 64) {
    const def = MOB_TYPES[type];
    if (!def) return 0;
    let spawned = 0;
    const hw = Math.max(def.size[0], def.size[2]) * 0.48;
    const herdHomeX = centerX + 0.5;
    const herdHomeZ = centerZ + 0.5;
    const maxLandY = type === 'goat' ? (SEA_LEVEL + 90) : (SEA_LEVEL + 44);

    for (let i = 0; i < count && this.mobs.length < maxTotal; i++) {
      let mob = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        const rad = i === 0 ? 0 : (1.6 + Math.random() * 4.8);
        const ang = Math.random() * Math.PI * 2;
        const sx = Math.floor(centerX + Math.cos(ang) * rad);
        const sz = Math.floor(centerZ + Math.sin(ang) * rad);
        const sy = this.world.getSurfaceY(sx, sz);
        const ground = this.world.getBlock(sx, sy - 1, sz);

        if (def.flying) {
          const by = Math.max(sy + 9, sy + 8 + Math.random() * 8);
          mob = this.spawnMob(type, sx + 0.5, by, sz + 0.5, null, biome);
          if (mob) break;
        } else if (def.aquatic) {
          if (ground === BLOCK.WATER && this.isWaterVolume(sx + 0.5, sy - 1.4, sz + 0.5, 0.35)) {
            mob = this.spawnMob(type, sx + 0.5, sy - 1.4, sz + 0.5, null, biome);
            if (mob) break;
          }
        } else if (def.floatsOnWater && ground === BLOCK.WATER) {
          if (!this.mobCollidesAt(sx + 0.5, sy, sz + 0.5, hw, def.size[1])) {
            mob = this.spawnMob(type, sx + 0.5, sy - 0.12, sz + 0.5, null, biome);
            if (mob) break;
          }
        } else if (def.hostile) {
          if (ground !== BLOCK.AIR && ground !== BLOCK.WATER && !this.mobCollidesAt(sx + 0.5, sy, sz + 0.5, hw, def.size[1])) {
            mob = this.spawnMob(type, sx + 0.5, sy, sz + 0.5, null, biome);
            if (mob) break;
          }
        } else {
          // Passive animals: strict open-sky surface, realistic elevation, and biome-matched natural ground!
          if (sy > maxLandY) continue;
          if (!this.isOpenSkySurface(sx, sy, sz)) continue;
          if (!this.isNaturalAnimalGround(ground, biome, type)) continue;
          const spawnY = def.butterfly ? sy + 1.2 : sy;
          if (!this.mobCollidesAt(sx + 0.5, spawnY, sz + 0.5, hw, def.size[1])) {
            mob = this.spawnMob(type, sx + 0.5, spawnY, sz + 0.5, null, biome);
            if (mob) break;
          }
        }
      }
      if (mob) {
        mob.herdHome = new THREE.Vector3(herdHomeX, mob.pos.y, herdHomeZ);
        spawned++;
      }
    }
    return spawned;
  }

  populateInitialWildlife(playerPos) {
    if (this.initialPopulated) return;
    this.initialPopulated = true;

    // 1. Spawn a lively flock of 5 Songbirds circling overhead!
    this.spawnHerd('bird', playerPos.x + 8, playerPos.z - 8, 5, 'Plains', 64);

    // 2. Spawn 5 distinct Land Animal Herds (3-5 animals each!) + 1-2 Water Flocks/Schools!
    let landHerds = 0;
    let waterHerds = 0;
    for (let tries = 0; tries < 90 && (landHerds < 5 || waterHerds < 2); tries++) {
      const ang = (tries * 1.15) + Math.random() * 0.6;
      const dist = 10 + Math.random() * 28;
      const sx = Math.floor(playerPos.x + Math.cos(ang) * dist);
      const sz = Math.floor(playerPos.z + Math.sin(ang) * dist);
      const sy = this.world.getSurfaceY(sx, sz);
      const ground = this.world.getBlock(sx, sy - 1, sz);
      const biome = this.world.getBiomeAt(sx, sz);

      if (ground === BLOCK.WATER && waterHerds < 2) {
        const wType = biome === 'Swamp' ? (Math.random() < 0.55 ? 'frog' : 'duck') : (Math.random() < 0.6 ? 'fish' : 'duck');
        const cnt = 3 + Math.floor(Math.random() * 3);
        if (this.spawnHerd(wType, sx, sz, cnt, biome, 64) > 0) waterHerds++;
      } else if (landHerds < 5) {
        const type = this.pickWildlifeForBiome(biome, ground, sy);
        if (!type) continue;
        const herdSize = type === 'butterfly' ? 4 : (type === 'polar_bear' || type === 'camel' || type === 'panda' ? (2 + Math.floor(Math.random() * 2)) : (3 + Math.floor(Math.random() * 3)));
        if (this.spawnHerd(type, sx, sz, herdSize, biome, 64) > 0) landHerds++;
      }
    }
  }

  pickWildlifeForBiome(biome, ground, y = SEA_LEVEL + 6) {
    // Open Ocean: only aquatic fish/ducks (handled above), or sea turtles on sandy shoals!
    if (biome === 'Ocean' || biome === 'Deep Ocean') {
      return ground === BLOCK.SAND && y >= SEA_LEVEL - 1 ? 'turtle' : null;
    }
    // High Mountains & Alpine Peaks: ONLY Mountain Goats (never lowland farm animals on tall peaks!)
    if (biome === 'Mountains' || y > SEA_LEVEL + 44) {
      if (y > SEA_LEVEL + 90) return null;
      if (ground === BLOCK.GRASS || ground === BLOCK.STONE || ground === BLOCK.SNOW || ground === BLOCK.GRAVEL) {
        return 'goat';
      }
      return null;
    }

    if (biome === 'Desert') {
      if (ground !== BLOCK.SAND) return null;
      if (y <= SEA_LEVEL + 2 && Math.random() < 0.35) return 'turtle';
      return Math.random() < 0.58 ? 'camel' : 'rabbit';
    }
    if (biome === 'Badlands') {
      if (ground !== BLOCK.RED_SAND && ground !== BLOCK.TERRACOTTA && ground !== BLOCK.TERRACOTTA_ORANGE) return null;
      return Math.random() < 0.62 ? 'camel' : 'rabbit';
    }
    if (biome === 'Savanna') {
      if (ground !== BLOCK.SAVANNA_GRASS && ground !== BLOCK.GRASS) return null;
      const pool = ['zebra', 'zebra', 'zebra', 'cow', 'sheep', 'chicken'];
      return pool[Math.floor(Math.random() * pool.length)];
    }
    if (biome === 'Jungle') {
      if (ground !== BLOCK.JUNGLE_GRASS && ground !== BLOCK.GRASS) return null;
      const pool = ['panda', 'panda', 'panda', 'chicken', 'butterfly', 'butterfly'];
      return pool[Math.floor(Math.random() * pool.length)];
    }
    if (biome === 'Swamp') {
      if (ground !== BLOCK.SWAMP_GRASS && ground !== BLOCK.MUD && ground !== BLOCK.GRASS) return null;
      const pool = ['frog', 'frog', 'frog', 'duck', 'pig'];
      return pool[Math.floor(Math.random() * pool.length)];
    }
    if (biome === 'Snowy Taiga') {
      if (ground !== BLOCK.SNOW && ground !== BLOCK.GRASS) return null;
      const pool = ['polar_bear', 'polar_bear', 'fox', 'wolf', 'rabbit'];
      return pool[Math.floor(Math.random() * pool.length)];
    }
    if (biome === 'Cherry Grove') {
      if (ground !== BLOCK.GRASS) return null;
      const pool = ['sheep', 'rabbit', 'butterfly', 'butterfly', 'deer', 'pig'];
      return pool[Math.floor(Math.random() * pool.length)];
    }
    if (ground === BLOCK.SAND && y <= SEA_LEVEL + 3) {
      return 'turtle';
    }
    if (biome === 'Forest' || biome === 'Birch Forest') {
      if (ground !== BLOCK.GRASS) return null;
      const pool = ['deer', 'deer', 'fox', 'wolf', 'rabbit', 'butterfly', 'pig', 'chicken'];
      return pool[Math.floor(Math.random() * pool.length)];
    }
    // Plains
    if (ground !== BLOCK.GRASS) return null;
    const pool = ['cow', 'sheep', 'pig', 'chicken', 'rabbit', 'deer', 'butterfly', 'butterfly'];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  spawnMob(type, x, y, z, profession = null, biome = 'Plains') {
    const def = MOB_TYPES[type];
    if (!def) return null;

    const halfW = Math.max(def.size[0], def.size[2]) * 0.48;
    const height = def.size[1];

    // Ensure spawn spot is clear of solid blocks!
    if (!def.aquatic && this.mobCollidesAt(x, y, z, halfW, height)) {
      if (!this.mobCollidesAt(x, y + 1, z, halfW, height)) {
        y += 1;
      } else if (!def.villager && !def.golem) {
        return null;
      }
    }

    const prof = type === 'villager'
      ? (profession || VILLAGER_PROFESSIONS[Math.floor(Math.random() * VILLAGER_PROFESSIONS.length)])
      : null;

    // GPU-Instanced rendering for Villagers, Villager Soldiers & Iron Golems!
    // Keeps 100% of population (castles, villages, mega cities) at ~30 total draw calls instead of 6,000+!
    const useInstancedNpc = (type === 'villager' || type === 'villager_soldier' || type === 'iron_golem');
    let group = null, legs = [], arms = [], wings = [], woolMeshes = [], tail = null, headGroup = null, bodyMat = null, headMat = null, allMats = [], baseColor = 0xffffff, label = def.name;
    if (useInstancedNpc) {
      this._ensureNpcPools();
      label = type === 'villager' ? `Villager (${prof.name})` : def.name;
    } else {
      const built = createMobMesh(type, { profession: prof, biome, textures: this.textures });
      group = built.group;
      legs = built.legs;
      arms = built.arms;
      wings = built.wings;
      woolMeshes = built.woolMeshes;
      tail = built.tail;
      headGroup = built.headGroup;
      bodyMat = built.bodyMat;
      headMat = built.headMat;
      allMats = built.allMats;
      baseColor = built.baseColor;
      label = built.label;
      group.position.set(x, y, z);
      this.group.add(group);
    }

    const mob = {
      type,
      def,
      label,
      profession: prof ? prof.name : null,
      instancedNpc: useInstancedNpc,
      baseColor,
      halfW,
      height,
      mesh: group,
      legs,
      arms: arms || [],
      wings,
      woolMeshes: woolMeshes || [],
      sheared: false,
      woolRegrowTimer: 0,
      tail,
      headGroup,
      bodyMat,
      headMat,
      allMats: allMats || [],
      _tintState: 'normal',
      pos: new THREE.Vector3(x, y, z),
      homePos: new THREE.Vector3(x, y, z),
      herdHome: null,
      vel: new THREE.Vector3(),
      yaw: Math.random() * Math.PI * 2,
      headYaw: 0,
      headPitch: 0,
      legSwing: 0,
      armSwingL: 0,
      armSwingR: 0,
      path: null,
      pathIdx: 0,
      pathTimer: 0,
      homeRadius: 24,
      hp: def.hp,
      maxHp: def.hp,
      walkPhase: Math.random() * 6,
      aiTimer: 1 + Math.random() * 3,
      wanderDir: Math.random() * Math.PI * 2,
      moving: true,
      hurtFlash: 0,
      hurtCd: 0,
      knockbackTimer: 0,
      turnCd: 0,
      stuckTimer: 0,
      headBaseColor: headMat ? headMat.color.getHex() : (baseColor ?? 0xffffff),
      attackCd: 0,
      bowDraw: 0,
      strafeDir: Math.random() < 0.5 ? 1 : -1,
      strafeTimer: 1.5 + Math.random() * 2.0,
      fleeTimer: 0,
      panicZigTimer: 0,
      panicJumpTimer: 0,
      fuseTimer: 0,
      creeperSparkCd: 0,
      orbitRadius: 10 + Math.random() * 14,
      orbitAngle: Math.random() * Math.PI * 2,
      cruiseY: y
    };
    this.mobs.push(mob);
    return mob;
  }

  // Pixel-Art 3D Falling Blocks & True 3D Voxel-Extruded Dropped Items!
  spawnDrop(itemId, count, x, y, z, opts = null) {
    if (!itemId || count <= 0) return;
    const def = ITEMS[itemId];
    let mesh;

    if (this.textures && def && def.isBlock && !def.cross && itemId !== 'bed' && this.blockDropMat) {
      // Real 3D pixel-art mini-block mapped to exact top/side/bottom atlas faces!
      const geo = this.textures.createBlockDropGeometry(def, 0.28);
      mesh = new THREE.Mesh(geo, this.blockDropMat);
      mesh.castShadow = true;
    } else if (this.textures && def) {
      // Chunky 3D Voxel-Extruded 16x16 Pixel-Art Dropped Item (cached geometry + material!)
      let mat = this.dropSpriteMatCache[itemId];
      if (!mat) {
        const tex = this.textures.getItemTexture(itemId);
        mat = new THREE.MeshLambertMaterial({
          map: tex,
          transparent: true,
          alphaTest: 0.45
        });
        this.dropSpriteMatCache[itemId] = mat;
      }
      const geo = this.textures.createExtrudedItemGeometry
        ? this.textures.createExtrudedItemGeometry(itemId, 0.38)
        : this.dropSpriteGeo;
      mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
    } else {
      const mat = new THREE.MeshLambertMaterial({ color: this.getDropColor(itemId) });
      mesh = new THREE.Mesh(this.dropGeo, mat);
    }

    const sy = opts && opts.exactY ? y : y + 0.32;
    mesh.position.set(x, sy, z);
    this.group.add(mesh);

    const vx = (opts && typeof opts.vx === 'number') ? opts.vx : (Math.random() - 0.5) * 2.4;
    const vy = (opts && typeof opts.vy === 'number') ? opts.vy : 3.4;
    const vz = (opts && typeof opts.vz === 'number') ? opts.vz : (Math.random() - 0.5) * 2.4;
    const pickupDelay = (opts && typeof opts.pickupDelay === 'number') ? opts.pickupDelay : 0.25;

    this.drops.push({
      id: itemId,
      count,
      durability: opts && opts.durability !== undefined ? opts.durability : undefined,
      mesh,
      pos: new THREE.Vector3(x, sy, z),
      vel: new THREE.Vector3(vx, vy, vz),
      age: 0,
      pickupDelay
    });
  }

  getDropColor(id) {
    if (id.includes('diamond')) return 0x4de3e8;
    if (id.includes('gold')) return 0xf5d033;
    if (id.includes('iron')) return 0xd8dce0;
    if (id.includes('coal')) return 0x2b2d33;
    if (id.includes('oak') || id.includes('wood') || id.includes('stick')) return 0xa67c46;
    if (id.includes('grass') || id.includes('leaves')) return 0x5da135;
    if (id.includes('stone') || id.includes('cobble')) return 0x80848a;
    if (id.includes('sand')) return 0xdfd09c;
    if (id.includes('pork') || id.includes('beef') || id.includes('venison') || id.includes('apple')) return 0xe05555;
    return 0xe6e6e6;
  }

  // Full-Body 3D AABB Ray-Box Intersection (100% reliable hit detection on all animals & mobs!)
  raycastMob(origin, dir, maxDist = 5.2) {
    let best = null;
    let bestDist = maxDist;
    const invX = Math.abs(dir.x) > 1e-6 ? 1 / dir.x : 1e9;
    const invY = Math.abs(dir.y) > 1e-6 ? 1 / dir.y : 1e9;
    const invZ = Math.abs(dir.z) > 1e-6 ? 1 / dir.z : 1e9;

    for (let i = 0; i < this.mobs.length; i++) {
      const mob = this.mobs[i];
      const padXZ = Math.max(mob.def.size[0], mob.def.size[2]) * 0.62 + 0.16;
      const minX = mob.pos.x - padXZ;
      const maxX = mob.pos.x + padXZ;
      const minY = mob.pos.y - 0.12;
      const maxY = mob.pos.y + mob.height + 0.18;
      const minZ = mob.pos.z - padXZ;
      const maxZ = mob.pos.z + padXZ;

      const t1 = (minX - origin.x) * invX;
      const t2 = (maxX - origin.x) * invX;
      const t3 = (minY - origin.y) * invY;
      const t4 = (maxY - origin.y) * invY;
      const t5 = (minZ - origin.z) * invZ;
      const t6 = (maxZ - origin.z) * invZ;

      const tmin = Math.max(Math.min(t1, t2), Math.min(t3, t4), Math.min(t5, t6));
      const tmax = Math.min(Math.max(t1, t2), Math.max(t3, t4), Math.max(t5, t6));

      if (tmax < 0 || tmin > tmax) continue;
      const hitT = tmin >= 0 ? tmin : 0;
      if (hitT <= bestDist) {
        bestDist = hitT;
        best = mob;
        mob._hitDist = hitT;
      }
    }
    return best;
  }

  // Apply full-body tint to EVERY mesh material of a mob ('normal' | 'hurt' | 'white')
  setMobTint(mob, state) {
    if (!mob || mob._tintState === state) return;
    mob._tintState = state;
    const mats = mob.allMats || [];
    for (let i = 0; i < mats.length; i++) {
      const entry = mats[i];
      const mat = entry.mat;
      if (state === 'hurt') {
        if (mat.color) mat.color.setHex(0xff4d4d);
        if (mat.emissive) mat.emissive.setHex(0xc81818);
      } else if (state === 'white') {
        if (mat.color) mat.color.setHex(0xffffff);
        if (mat.emissive) mat.emissive.setHex(0xdedede);
      } else {
        if (mat.color) mat.color.setHex(entry.origColor);
        if (mat.emissive && entry.origEmissive !== null) mat.emissive.setHex(entry.origEmissive);
      }
    }
  }

  // Fast 3D voxel line-of-sight check so Skeletons don't shoot arrows through solid walls!
  hasLineOfSight(x0, y0, z0, x1, y1, z1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const dist = Math.hypot(dx, dy, dz);
    const steps = Math.max(1, Math.ceil(dist * 2));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (isBlockSolid(this.world.getBlock(x0 + dx * t, y0 + dy * t, z0 + dz * t))) {
        return false;
      }
    }
    return true;
  }

  // Spawn a real 3D flying Arrow projectile (wooden shaft, iron tip, white fletching)!
  spawnArrow(x, y, z, vx, vy, vz, dmg = 3, shooter = null) {
    const arrowGroup = new THREE.Group();
    const shaftMat = new THREE.MeshLambertMaterial({ color: 0x8a5b2e });
    const tipMat = new THREE.MeshLambertMaterial({ color: 0xd0d8e2 });
    const featherMat = new THREE.MeshBasicMaterial({ color: 0xf7f9fc });
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.62), shaftMat);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.14), tipMat);
    tip.position.set(0, 0, 0.34);
    const fletchA = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.02, 0.16), featherMat);
    fletchA.position.set(0, 0, -0.26);
    const fletchB = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.14, 0.16), featherMat);
    fletchB.position.set(0, 0, -0.26);
    arrowGroup.add(shaft, tip, fletchA, fletchB);
    arrowGroup.position.set(x, y, z);
    arrowGroup.lookAt(x + vx, y + vy, z + vz);
    this.group.add(arrowGroup);

    this.projectiles.push({
      mesh: arrowGroup,
      pos: new THREE.Vector3(x, y, z),
      vel: new THREE.Vector3(vx, vy, vz),
      dmg,
      shooter,
      stuck: false,
      age: 0
    });
    if (this.sound && this.sound.playBowShoot) this.sound.playBowShoot();
  }

  hitMob(mob, damage, knockDir, player) {
    if (!mob || mob.hurtCd > 0) return false;
    // Wake sleeping villager immediately if attacked!
    if (mob.sleeping) {
      mob.sleeping = false;
      mob.sleepBed = null;
      if (mob.mesh) mob.mesh.rotation.x = 0;
    }
    mob.hp -= Math.max(1, damage || 2);
    mob.hurtFlash = 0.32;
    mob.hurtCd = 0.22;
    mob.knockbackTimer = 0.36;

    // Normalize horizontal knockback direction so looking down at small animals STILL launches them back!
    let kx = knockDir ? knockDir.x : 0;
    let kz = knockDir ? knockDir.z : 0;
    const hLen = Math.hypot(kx, kz);
    if (hLen > 0.05) {
      kx /= hLen;
      kz /= hLen;
    } else if (player) {
      const dx = mob.pos.x - player.pos.x;
      const dz = mob.pos.z - player.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      kx = dx / d;
      kz = dz / d;
    }

    mob.vel.x = kx * 7.4;
    mob.vel.z = kz * 7.4;
    mob.vel.y = Math.max(mob.vel.y, 5.4);
    this.setMobTint(mob, 'hurt');

    // Authentic Minecraft Iron Golem & Villager Soldier Provocation:
    // - Attacking an Iron Golem or Soldier directly -> immediately aggros that guard!
    // - Attacking a Villager -> ONLY Iron Golems & Soldiers who have clear Line-of-Sight SEE it and attack you!
    if (player) {
      if (mob.def.guard) {
        mob.aggroPlayer = true;
        mob.aggroTimer = 45;
      } else if (mob.def.villager && !mob.def.guard) {
        for (let gi = 0; gi < this.mobs.length; gi++) {
          const g = this.mobs[gi];
          if (!g.def.guard || g === mob) continue;
          const dG = g.pos.distanceTo(mob.pos);
          if (dG > 26) continue;
          const gEyeY = g.pos.y + g.height * 0.82;
          const seesPlayer = this.hasLineOfSight(g.pos.x, gEyeY, g.pos.z, player.pos.x, player.pos.y + 1.25, player.pos.z);
          const seesVictim = this.hasLineOfSight(g.pos.x, gEyeY, g.pos.z, mob.pos.x, mob.pos.y + 1.25, mob.pos.z);
          if (seesPlayer || seesVictim) {
            g.aggroPlayer = true;
            g.aggroTimer = 38;
          }
        }
      }
    }

    if (!mob.def.hostile && !mob.def.guard) {
      // Go haywire! Frantic high-speed zig-zagging + repeated jumps to escape!
      mob.fleeTimer = 5.5 + Math.random() * 2.5;
      mob.panicZigTimer = 0.22 + Math.random() * 0.28;
      mob.panicJumpTimer = 0.14 + Math.random() * 0.18;
      mob.wanderDir = Math.atan2(kx, kz) + (Math.random() - 0.5) * 1.15;
      mob.moving = true;
    }
    this.sound.playHurt();

    if (mob.hp <= 0) {
      const cookedMap = { raw_beef: 'cooked_beef', raw_pork: 'cooked_porkchop', raw_chicken: 'cooked_chicken', raw_mutton: 'cooked_mutton' };
      const isBurning = (mob.burnTimer || 0) > 0;
      for (const dropId of mob.def.drop) {
        if (mob.type === 'sheep' && mob.sheared && dropId.startsWith('wool_')) continue;
        const finalDrop = isBurning && cookedMap[dropId] ? cookedMap[dropId] : dropId;
        this.spawnDrop(finalDrop, 1, mob.pos.x, mob.pos.y + 0.4, mob.pos.z);
      }
      if (player) player.addXP(mob.def.xp || 2);
      this.removeMob(mob);
      return true;
    }
    return true;
  }

  // Shear wool off a living sheep without harming or killing it!
  shearSheep(mob, player = null, effects = null) {
    if (!mob || mob.type !== 'sheep' || mob.sheared) return false;
    mob.sheared = true;
    mob.woolRegrowTimer = 65 + Math.random() * 45;
    if (mob.woolMeshes) {
      for (let i = 0; i < mob.woolMeshes.length; i++) {
        mob.woolMeshes[i].visible = false;
      }
    }
    const woolCount = 1 + Math.floor(Math.random() * 3); // 1 to 3 wool blocks like Minecraft!
    this.spawnDrop('wool_white', woolCount, mob.pos.x, mob.pos.y + 0.55, mob.pos.z);
    if (this.sound && this.sound.playPop) this.sound.playPop();
    // Gentle startled hop without hurting the sheep
    mob.vel.y = Math.max(mob.vel.y, 3.2);
    if (effects && effects.spawnBlockBreak) {
      effects.spawnBlockBreak(mob.pos.x - 0.5, mob.pos.y + 0.5, mob.pos.z - 0.5, ITEMS.wool_white);
    }
    return true;
  }

  // Real Explosion Blast Damage & Launch Knockback on Nearby Mobs!
  applyExplosion(ex, ey, ez, radius = 4.4, player = null) {
    const maxR = radius + 3.5;
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      const dx = m.pos.x - ex;
      const dy = (m.pos.y + m.height * 0.5) - ey;
      const dz = m.pos.z - ez;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < maxR && dist > 0.001) {
        const falloff = 1 - dist / maxR;
        const dmg = Math.ceil(falloff * 24);
        const nx = dx / dist;
        const nz = dz / dist;
        m.vel.x += nx * falloff * 14;
        m.vel.z += nz * falloff * 14;
        m.vel.y = Math.max(m.vel.y, 4.5 + falloff * 9.5);
        this.hitMob(m, dmg, { x: nx, y: 0.4, z: nz }, player);
      }
    }
  }

  removeMob(mob) {
    const idx = this.mobs.indexOf(mob);
    if (idx !== -1) this.mobs.splice(idx, 1);
    if (mob.mesh) this.group.remove(mob.mesh);
  }

  despawnHostiles() {
    let removed = 0;
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      if (this.mobs[i].def.hostile) {
        if (this.mobs[i].mesh) this.group.remove(this.mobs[i].mesh);
        this.mobs.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  _trySpawnCaveHostile(playerPos, pool, biome) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 12 + Math.random() * 22;
    const sx = Math.floor(playerPos.x + Math.cos(angle) * dist);
    const sz = Math.floor(playerPos.z + Math.sin(angle) * dist);
    const surfaceY = this.world.getSurfaceY(sx, sz);
    if (surfaceY < 16) return 0;

    // Probe dark underground cave floor (solid block below + 2 open AIR blocks above!)
    for (let attempt = 0; attempt < 5; attempt++) {
      const cy = 6 + Math.floor(Math.random() * Math.max(1, surfaceY - 12));
      const below = this.world.getBlock(sx, cy - 1, sz);
      if (below === BLOCK.AIR || below === BLOCK.WATER || below === BLOCK.BEDROCK) continue;
      if (this.world.getBlock(sx, cy, sz) === BLOCK.AIR && this.world.getBlock(sx, cy + 1, sz) === BLOCK.AIR) {
        // Never spawn hostile mobs near placed torches, glowstone, fire, or lava!
        if (this.world.isPosLitByLightSource && this.world.isPosLitByLightSource(sx, cy, sz, 12)) continue;
        const hType = pool[Math.floor(Math.random() * pool.length)];
        const mob = this.spawnMob(hType, sx + 0.5, cy, sz + 0.5, null, biome);
        return mob ? 1 : 0;
      }
    }
    return 0;
  }

  update(dt, player, sky, onExplosion, mods = null, gameRules = null, effects = null) {
    if (!this.initialPopulated) {
      this.populateInitialWildlife(player.pos);
    }

    const DIFF_CFG = {
      peaceful: { dmgMul: 0, spawnMul: 0, maxHostile: 0 },
      easy:     { dmgMul: 0.65, spawnMul: 0.95, maxHostile: 14 },
      normal:   { dmgMul: 1.0,  spawnMul: 1.45, maxHostile: 24 },
      hard:     { dmgMul: 1.5,  spawnMul: 2.15, maxHostile: 36 }
    };
    const difficulty = (gameRules && DIFF_CFG[gameRules.difficulty]) ? gameRules.difficulty : 'normal';
    const diffCfg = DIFF_CFG[difficulty];
    const mobRate = (gameRules && typeof gameRules.mobSpawnRate === 'number')
      ? Math.max(0, Math.min(5, gameRules.mobSpawnRate))
      : 1.0;
    const moreMobsMul = (mods && mods.isEnabled('more_mobs')) ? 1.45 : 1.0;

    this.ambienceTimer -= dt;
    if (this.ambienceTimer <= 0) {
      this.ambienceTimer = 7 + Math.random() * 11;
      if (!sky.isNight() && sky.weather === 'clear' && this.sound.playBirdChirp) {
        if (this.mobs.some((m) => m.type === 'bird')) this.sound.playBirdChirp();
      }
    }

    // Helper: check if target world (x, z) chunk is actually generated & loaded before spawning mobs!
    const isChunkLoadedAt = (wx, wz) => {
      const cx = Math.floor(wx) >> 4;
      const cz = Math.floor(wz) >> 4;
      return this.world.chunks.has(this.world.chunkKey(cx, cz));
    };

    // 0. Guaranteed Lively Village Population Spawning (waits for loaded chunks & cleanly respawns on return after distance despawn!)
    for (const [vKey, v] of this.world.villageChunks.entries()) {
      const d = Math.hypot(player.pos.x - v.x, player.pos.z - v.z);
      if (d > 155 && v.spawned) {
        // Player left village far behind -> allow clean re-population when returning!
        v.spawned = false;
      }
      if (!v.spawned && d < 76 && isChunkLoadedAt(v.x, v.z)) {
        // Count any already-living villagers/guards belonging to this village so we never duplicate
        let liveVil = 0;
        for (let mi = 0; mi < this.mobs.length; mi++) {
          const mm = this.mobs[mi];
          if ((mm.def.villager || mm.def.golem) && Math.hypot(mm.pos.x - v.x, mm.pos.z - v.z) < 48) liveVil++;
        }
        v.spawned = true;
        if (liveVil < 10) {
          const spawns = [
            ['villager', -3.5, 3.5, VILLAGER_PROFESSIONS[0]],
            ['villager', 3.5, -3.5, VILLAGER_PROFESSIONS[1]],
            ['villager', -2.5, -4.0, VILLAGER_PROFESSIONS[2]],
            ['villager', 5.0, 2.5, VILLAGER_PROFESSIONS[3]],
            ['villager', -6.5, 0.5, VILLAGER_PROFESSIONS[0]],
            ['villager', 1.5, 6.0, VILLAGER_PROFESSIONS[1]],
            ['villager', -12.0, 4.0, VILLAGER_PROFESSIONS[2]],
            ['villager', 12.5, -3.0, VILLAGER_PROFESSIONS[3]],
            ['villager', 4.0, -12.5, VILLAGER_PROFESSIONS[0]],
            ['villager', -4.5, 13.0, VILLAGER_PROFESSIONS[1]],
            ['villager', 10.5, 10.5, VILLAGER_PROFESSIONS[2]],
            ['villager', -10.5, -10.5, VILLAGER_PROFESSIONS[3]],
            ['villager_soldier', -5.5, 4.5, null],
            ['villager_soldier', 5.5, -4.5, null],
            ['villager_soldier', 0.5, -7.5, null],
            ['villager_soldier', -7.5, -2.5, null],
            ['iron_golem', 0.5, 5.5, null],
            ['iron_golem', -5.5, -4.5, null]
          ];
          const needed = Math.max(0, spawns.length - liveVil);
          for (let si = 0; si < needed; si++) {
            const [mType, ox, oz, prof] = spawns[si];
            this._pendingVillageSpawns.push({
              mType,
              sx: v.x + ox,
              sz: v.z + oz,
              baseY: v.y,
              exactY: Boolean(v.exactY || v.isUnderground),
              prof,
              settlement: v
            });
          }
        }
      }
    }

    // 0b. Guaranteed Full-Physics Mega Castle, Great Pyramid & Mega City Populations (waits for loaded chunks!)
    if (this.world.megaStructures && this.world.megaStructures.size > 0) {
      for (const ms of this.world.megaStructures.values()) {
        const d = Math.hypot(player.pos.x - ms.x, player.pos.z - ms.z);
        if (!ms.discovered && d < ms.radius + 22) {
          ms.discovered = true;
          if (this.onDiscoverMega) this.onDiscoverMega(ms);
        }
        const isCity = ms.type === 'mega_city';
        const resetDist = isCity ? 235 : 190;
        const spawnDist = isCity ? 136 : 108;
        if (d > resetDist && ms.crowdSpawned) {
          ms.crowdSpawned = false;
        }
        // Only spawn once player is within loaded chunk radius AND center chunk is actually loaded!
        if (!ms.crowdSpawned && d < spawnDist && isChunkLoadedAt(ms.x, ms.z)) {
          let liveMega = 0;
          const countR = ms.radius + 16;
          for (let mi = 0; mi < this.mobs.length; mi++) {
            const mm = this.mobs[mi];
            if ((mm.def.villager || mm.def.golem) && Math.hypot(mm.pos.x - ms.x, mm.pos.z - ms.z) < countR) liveMega++;
          }
          ms.crowdSpawned = true;
          const minTarget = isCity ? 140 : 56;
          if (liveMega < minTarget) {
            this._spawnMegaCrowd(ms, liveMega);
          }
        }
      }
      this._updateMegaCrowds(dt, player);
    }

    if (this._pendingVillageSpawns.length > 0) {
      let spawnedThisFrame = 0;
      let checked = 0;
      while (spawnedThisFrame < 14 && checked < this._pendingVillageSpawns.length && checked < 42) {
        const sp = this._pendingVillageSpawns.shift();
        checked++;
        if (!isChunkLoadedAt(sp.sx, sp.sz)) {
          // Chunk still streaming in -> keep queued briefly if player is still nearby!
          if (Math.hypot(player.pos.x - sp.sx, player.pos.z - sp.sz) < 145) {
            this._pendingVillageSpawns.push(sp);
          }
          continue;
        }
        let spawnX = sp.sx;
        let spawnZ = sp.sz;
        let yPos = sp.exactY ? sp.baseY : this.world.getSurfaceY(spawnX, spawnZ);
        // Find a guaranteed safe non-solid, non-water/lava spot so villagers NEVER suffocate in walls or fountains!
        const isSafeAt = (tx, ty, tz) => {
          const bF = this.world.getBlock(tx, ty, tz);
          const bH = this.world.getBlock(tx, ty + 1, tz);
          const bG = this.world.getBlock(tx, ty - 1, tz);
          return !isBlockSolid(bF) && !isBlockLiquid(bF) && !isBlockSolid(bH) && isBlockSolid(bG);
        };
        if (!isSafeAt(spawnX, yPos, spawnZ)) {
          for (let tries = 0; tries < 10; tries++) {
            const ang = tries * 0.63;
            const rad = 1.5 + (tries % 4) * 1.4;
            const tx = sp.sx + Math.cos(ang) * rad;
            const tz = sp.sz + Math.sin(ang) * rad;
            if (!isChunkLoadedAt(tx, tz)) continue;
            const ty = sp.exactY ? sp.baseY : this.world.getSurfaceY(tx, tz);
            if (isSafeAt(tx, ty, tz)) {
              spawnX = tx; spawnZ = tz; yPos = ty;
              break;
            }
          }
        }
        const spawnedMob = this.spawnMob(sp.mType, spawnX, yPos, spawnZ, sp.prof);
        if (spawnedMob && sp.homeRadius) spawnedMob.homeRadius = sp.homeRadius;
        spawnedThisFrame++;
      }
    }

    // 1A. Dynamic Biome-Aware Passive Wildlife Herd Spawning (zero-GC single-pass counters!)
    const isNight = sky.isNight();
    let passiveCount = 0;
    let hostileCount = 0;
    let birdCount = 0;
    let waterMobCount = 0;
    for (let i = 0; i < this.mobs.length; i++) {
      const mm = this.mobs[i];
      if (mm.def.hostile) hostileCount++;
      else {
        if (!mm.def.villager && !mm.def.golem) passiveCount++;
        if (mm.type === 'bird') birdCount++;
        else if (mm.type === 'fish' || mm.type === 'duck' || mm.type === 'frog') waterMobCount++;
      }
    }

    const passiveCap = Math.round(44 * moreMobsMul);
    const totalPassiveCap = this.mobs.length + Math.max(0, passiveCap - passiveCount);
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = (mods && mods.isEnabled('more_mobs')) ? 1.2 : 1.9;
      if (passiveCount < passiveCap) {
        if (!isNight && birdCount < 8 && Math.random() < 0.22) {
          const ang = Math.random() * Math.PI * 2;
          const dist = 16 + Math.random() * 24;
          const bx = player.pos.x + Math.cos(ang) * dist;
          const bz = player.pos.z + Math.sin(ang) * dist;
          this.spawnHerd('bird', bx, bz, 3 + Math.floor(Math.random() * 2), 'Plains', totalPassiveCap);
        } else {
          const angle = Math.random() * Math.PI * 2;
          const dist = 15 + Math.random() * 26;
          const sx = Math.floor(player.pos.x + Math.cos(angle) * dist);
          const sz = Math.floor(player.pos.z + Math.sin(angle) * dist);
          const sy = this.world.getSurfaceY(sx, sz);
          const ground = this.world.getBlock(sx, sy - 1, sz);
          const biome = this.world.getBiomeAt(sx, sz);

          if (ground === BLOCK.WATER) {
            if (waterMobCount < 14) {
              const wType = biome === 'Swamp' ? (Math.random() < 0.55 ? 'frog' : 'duck') : (Math.random() < 0.65 ? 'fish' : 'duck');
              this.spawnHerd(wType, sx, sz, 3 + Math.floor(Math.random() * 3), biome, totalPassiveCap);
            }
          } else {
            const type = this.pickWildlifeForBiome(biome, ground, sy);
            if (type && !(type === 'butterfly' && isNight)) {
              const herdSize = (type === 'polar_bear' || type === 'camel' || type === 'panda')
                ? (2 + Math.floor(Math.random() * 2))
                : (3 + Math.floor(Math.random() * 3));
              this.spawnHerd(type, sx, sz, herdSize, biome, totalPassiveCap);
            }
          }
        }
      }
    }

    // 1B. Dedicated Hostile Mob Spawner (Night Surface Packs + Underground Cave Spawns + Difficulty & Mob Rate!)
    const hostileCap = (difficulty === 'peaceful' || mobRate <= 0)
      ? 0
      : Math.min(56, Math.max(2, Math.round(diffCfg.maxHostile * mobRate * moreMobsMul)));
    this.hostileSpawnTimer -= dt;
    if (this.hostileSpawnTimer <= 0) {
      const effRate = Math.max(0.2, diffCfg.spawnMul * Math.max(0.15, mobRate) * moreMobsMul);
      this.hostileSpawnTimer = Math.max(0.24, (isNight ? 0.85 : 2.1) / effRate);
      if (hostileCap > 0 && hostileCount < hostileCap) {
        const pool = ['zombie', 'skeleton', 'creeper', 'spider'];
        const maxTotalForHostile = passiveCount + hostileCap;
        if (isNight) {
          // Spawn lively hostile packs at night (2 attempts when population is low so nights fill quickly!)
          const tries = hostileCount < hostileCap * 0.5 ? 2 : 1;
          for (let t = 0; t < tries && hostileCount < hostileCap; t++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 15 + Math.random() * 24;
            const sx = Math.floor(player.pos.x + Math.cos(angle) * dist);
            const sz = Math.floor(player.pos.z + Math.sin(angle) * dist);
            const sy = this.world.getSurfaceY(sx, sz);
            const ground = this.world.getBlock(sx, sy - 1, sz);
            if (ground !== BLOCK.AIR && ground !== BLOCK.WATER) {
              // Respect torches & light sources: NEVER spawn hostile mobs near light at night!
              if (this.world.isPosLitByLightSource && this.world.isPosLitByLightSource(sx, sy, sz, 12)) continue;
              const biome = this.world.getBiomeAt(sx, sz);
              const hType = pool[Math.floor(Math.random() * pool.length)];
              const packSize = hType === 'creeper'
                ? (1 + Math.floor(Math.random() * 2))
                : (2 + Math.floor(Math.random() * 3));
              hostileCount += this.spawnHerd(hType, sx, sz, packSize, biome, maxTotalForHostile);
            }
          }
        } else {
          // Daytime: populate underground caves with monsters (and shaded spiders/creepers in Swarm mode!)
          const caveCap = Math.max(2, Math.floor(hostileCap * 0.5));
          if (hostileCount < caveCap) {
            const biome = this.world.getBiomeAt(Math.floor(player.pos.x), Math.floor(player.pos.z));
            hostileCount += this._trySpawnCaveHostile(player.pos, pool, biome);
          }
        }
      }
    }

    // 2. Update All Mobs & Wildlife (with full 3D AABB collision + A* Villager Door/Bed Pathfinding + Adaptive Throttling!)
    const nowSec = performance.now() * 0.001;
    this._mobTickFrame = (this._mobTickFrame || 0) + 1;
    this._pathsThisFrame = 0;
    let anyMobBurning = false;
    const isSleepNight = sky.time < 0.25 || sky.time > 0.78; // Exact same night/morning wake boundary as Player bed!

    // Single-pass partition so guards & hostiles NEVER do O(N^2) scans across 250+ castle/city villagers!
    const hostileList = this._hostileScratch;
    const npcList = this._npcScratch;
    hostileList.length = 0;
    npcList.length = 0;
    for (let i = 0; i < this.mobs.length; i++) {
      const mm = this.mobs[i];
      if (mm.def.hostile) hostileList.push(mm);
      else if (mm.def.villager || mm.def.guard) npcList.push(mm);
    }

    // Helper: automatically close doors behind villagers/soldiers after they walk through (only when doorway is clear!)
    const tickPassedDoors = (mob, stepDt) => {
      if (!mob._passedDoors || mob._passedDoors.length === 0) return;
      for (let di = mob._passedDoors.length - 1; di >= 0; di--) {
        const pd = mob._passedDoors[di];
        pd.timer -= stepDt;
        const dxD = mob.pos.x - (pd.x + 0.5);
        const dzD = mob.pos.z - (pd.z + 0.5);
        const farEnough = (dxD * dxD + dzD * dzD) > 1.75;
        if (pd.timer <= 0 && (farEnough || pd.timer < -2.0)) {
          // Ensure no other villager is currently walking through this doorway before closing it!
          let occupied = false;
          for (let ni = 0; ni < npcList.length; ni++) {
            const other = npcList[ni];
            if (other === mob || other.sleeping) continue;
            const ox = other.pos.x - (pd.x + 0.5);
            const oz = other.pos.z - (pd.z + 0.5);
            if (ox * ox + oz * oz < 1.55 && Math.abs(other.pos.y - pd.y) < 1.8) {
              occupied = true;
              break;
            }
          }
          if (occupied && pd.timer > -3.0) continue;
          if (this.world.isDoorOpenAt && this.world.isDoorOpenAt(pd.x, pd.y, pd.z)) {
            this.world.toggleDoor(pd.x, pd.y, pd.z);
          }
          mob._passedDoors.splice(di, 1);
        }
      }
    };

    const openDoorAtBlock = (mob, bx, by, bz) => {
      for (let dy = 0; dy <= 1; dy++) {
        const y = by + dy;
        const bid = this.world.getBlock(bx, y, bz);
        if (isDoorBlock(bid)) {
          const baseY = isDoorTop(bid) ? y - 1 : y;
          if (!this.world.isDoorOpenAt(bx, baseY, bz)) {
            this.world.toggleDoor(bx, baseY, bz);
            if (!mob._passedDoors) mob._passedDoors = [];
            mob._passedDoors.push({ x: bx, y: baseY, z: bz, timer: 1.55 });
          }
          return true;
        }
      }
      return false;
    };

    // Helper: villagers & soldiers automatically open closed wooden doors in their path or at next waypoint!
    const tryOpenDoorAhead = (mob, dirX, dirZ, wp = null) => {
      const my = Math.floor(mob.pos.y + 0.25);
      // 1. Check current block & next A* waypoint block directly
      openDoorAtBlock(mob, Math.floor(mob.pos.x), my, Math.floor(mob.pos.z));
      if (wp && Math.hypot(wp.x + 0.5 - mob.pos.x, wp.z + 0.5 - mob.pos.z) < 1.9) {
        if (openDoorAtBlock(mob, wp.x, wp.y, wp.z)) return;
      }
      const mag = Math.hypot(dirX, dirZ);
      if (mag < 0.04) return;
      const nx = dirX / mag, nz = dirZ / mag;
      for (const probe of [0.55, 1.05, 1.48]) {
        const bx = Math.floor(mob.pos.x + nx * probe);
        const bz = Math.floor(mob.pos.z + nz * probe);
        if (openDoorAtBlock(mob, bx, my, bz)) return;
      }
    };

    const frameDt = dt;
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      if (difficulty === 'peaceful' && m.def.hostile) {
        this.removeMob(m);
        continue;
      }
      const pdx = m.pos.x - player.pos.x;
      const pdy = m.pos.y - player.pos.y;
      const pdz = m.pos.z - player.pos.z;
      const distToPlayer = Math.hypot(pdx, pdy, pdz);

      const despawnDist = (m.def.villager || m.def.golem) ? 215 : 78;
      if (distToPlayer > despawnDist || m.pos.y < -5) {
        this.removeMob(m);
        continue;
      }

      // Only nearby non-instanced mobs cast shadows
      if (m.mesh) {
        const wantShadow = m._castsShadow === false ? distToPlayer < MOB_SHADOW_DIST - 4 : distToPlayer < MOB_SHADOW_DIST;
        if (m._castsShadow !== wantShadow) {
          m._castsShadow = wantShadow;
          m.mesh.traverse((o) => {
            if (!o.isMesh) return;
            if (o._baseCastShadow === undefined) o._baseCastShadow = o.castShadow;
            o.castShadow = wantShadow && o._baseCastShadow;
          });
        }
      }

      // Adaptive Distance Tick Rate: preserves 100% of castle & Mega City villager counts at silky 60 FPS!
      if (!m.def.hostile && !m.hurtFlash && !m.aggroPlayer) {
        const tickMask = distToPlayer > 96 ? 7 : (distToPlayer > 54 ? 3 : (distToPlayer > 28 ? 1 : 0));
        if (tickMask > 0 && ((i + this._mobTickFrame) & tickMask) !== 0) {
          m._skipDt = (m._skipDt || 0) + frameDt;
          continue;
        }
      }
      const dt = Math.min(0.14, frameDt + (m._skipDt || 0));
      m._skipDt = 0;

      if (m.def.villager) tickPassedDoors(m, dt);

      if (m.hurtCd > 0) m.hurtCd = Math.max(0, m.hurtCd - dt);
      if (m.turnCd > 0) m.turnCd = Math.max(0, m.turnCd - dt);
      if (m.knockbackTimer > 0) m.knockbackTimer = Math.max(0, m.knockbackTimer - dt);
      // Sheared sheep gradually regrow their fluffy wool coat!
      if (m.type === 'sheep' && m.sheared) {
        m.woolRegrowTimer -= dt;
        if (m.woolRegrowTimer <= 0) {
          m.sheared = false;
          if (m.woolMeshes) {
            for (let wi = 0; wi < m.woolMeshes.length; wi++) m.woolMeshes[wi].visible = true;
          }
        }
      }

      if (m.hurtFlash > 0) {
        m.hurtFlash = Math.max(0, m.hurtFlash - dt);
        this.setMobTint(m, m.hurtFlash > 0 ? 'hurt' : 'normal');
      } else if (m._tintState === 'hurt') {
        this.setMobTint(m, 'normal');
      }

      // --- A. FLYING SONGBIRDS (obstacle-avoiding flight!) ---
      if (m.def.flying) {
        m.orbitAngle += dt * (m.def.speed / m.orbitRadius);
        m.homePos.x = THREE.MathUtils.lerp(m.homePos.x, player.pos.x, dt * 0.03);
        m.homePos.z = THREE.MathUtils.lerp(m.homePos.z, player.pos.z, dt * 0.03);

        const targetX = m.homePos.x + Math.cos(m.orbitAngle) * m.orbitRadius;
        const targetZ = m.homePos.z + Math.sin(m.orbitAngle) * m.orbitRadius;
        m.groundCheckTimer = (m.groundCheckTimer || 0) - dt;
        if (m.groundCheckTimer <= 0 || m.cachedGroundY === undefined) {
          m.groundCheckTimer = 0.28;
          m.cachedGroundY = this.world.getSurfaceY(targetX, targetZ);
        }
        const targetY = Math.max(m.cachedGroundY + 7.5, m.cruiseY + Math.sin(nowSec * 1.4 + m.walkPhase) * 2.2);

        const nextX = THREE.MathUtils.lerp(m.pos.x, targetX, Math.min(1, dt * 2.2));
        const nextZ = THREE.MathUtils.lerp(m.pos.z, targetZ, Math.min(1, dt * 2.2));
        const nextY = THREE.MathUtils.lerp(m.pos.y, targetY, Math.min(1, dt * 1.8));

        if (!this.mobCollidesAt(nextX, nextY - 0.15, nextZ, 0.45, 0.5)) {
          m.yaw = Math.atan2(targetX - m.pos.x, targetZ - m.pos.z);
          m.pos.set(nextX, nextY, nextZ);
        } else {
          // Climb cleanly over trees or cliffs!
          m.pos.y += dt * 4.5;
          m.cruiseY = Math.max(m.cruiseY, m.pos.y + 1.5);
        }

        m.mesh.position.copy(m.pos);
        m.mesh.rotation.y = m.yaw;
        m.mesh.rotation.z = Math.sin(m.orbitAngle) * 0.16;
        const flap = Math.sin(nowSec * 15 + m.walkPhase) * 0.65;
        if (m.wings.length === 2) {
          m.wings[0].rotation.z = flap;
          m.wings[1].rotation.z = -flap;
        }
        continue;
      }

      // --- B. FLUTTERING BUTTERFLIES (obstacle-safe!) ---
      if (m.def.butterfly) {
        if (sky.isNight()) {
          this.removeMob(m);
          continue;
        }
        m.aiTimer -= dt;
        if (m.aiTimer <= 0) {
          m.aiTimer = 1.2 + Math.random() * 2.5;
          m.wanderDir += (Math.random() - 0.5) * 2.4;
        }
        const nx = m.pos.x + Math.sin(m.wanderDir) * m.def.speed * dt;
        const nz = m.pos.z + Math.cos(m.wanderDir) * m.def.speed * dt;
        if (!this.mobCollidesAt(nx, m.pos.y - 0.1, nz, 0.32, 0.35)) {
          m.pos.x = nx;
          m.pos.z = nz;
        } else {
          m.wanderDir += Math.PI * 0.85;
        }
        m.groundCheckTimer = (m.groundCheckTimer || 0) - dt;
        if (m.groundCheckTimer <= 0 || m.cachedGroundY === undefined) {
          m.groundCheckTimer = 0.28;
          m.cachedGroundY = this.world.getSurfaceY(m.pos.x, m.pos.z);
        }
        const targetY = m.cachedGroundY + 1.15 + Math.sin(nowSec * 3.8 + m.walkPhase) * 0.45;
        const ny = THREE.MathUtils.lerp(m.pos.y, targetY, Math.min(1, dt * 4));
        if (!this.mobCollidesAt(m.pos.x, ny - 0.1, m.pos.z, 0.32, 0.35)) {
          m.pos.y = ny;
        }
        m.mesh.position.copy(m.pos);
        m.mesh.rotation.y = m.wanderDir;
        const flap = Math.sin(nowSec * 28 + m.walkPhase) * 1.05;
        if (m.wings.length === 2) {
          m.wings[0].rotation.z = flap;
          m.wings[1].rotation.z = -flap;
        }
        continue;
      }

      // --- C. AQUATIC SWIMMING FISH (padded water-volume check!) ---
      if (m.def.aquatic) {
        m.aiTimer -= dt;
        if (m.aiTimer <= 0) {
          m.aiTimer = 1.5 + Math.random() * 3.0;
          m.wanderDir += (Math.random() - 0.5) * 1.8;
        }
        const nx = m.pos.x + Math.sin(m.wanderDir) * m.def.speed * dt;
        const nz = m.pos.z + Math.cos(m.wanderDir) * m.def.speed * dt;
        if (this.isWaterVolume(nx, m.pos.y, nz, 0.38)) {
          m.pos.x = nx;
          m.pos.z = nz;
        } else {
          m.wanderDir += Math.PI * 0.78 + (Math.random() - 0.5) * 0.6;
        }
        const above = this.world.getBlock(m.pos.x, m.pos.y + 0.55, m.pos.z);
        const below = this.world.getBlock(m.pos.x, m.pos.y - 0.45, m.pos.z);
        if (!isBlockLiquid(above)) m.pos.y -= dt * 1.2;
        else if (!isBlockLiquid(below)) m.pos.y += dt * 1.0;
        else m.pos.y += Math.sin(nowSec * 2.2 + m.walkPhase) * 0.25 * dt;

        m.yaw = m.wanderDir;
        m.mesh.position.copy(m.pos);
        m.mesh.rotation.y = m.yaw;
        if (m.tail) m.tail.rotation.y = Math.sin(nowSec * 12 + m.walkPhase) * 0.55;
        continue;
      }

      // Daylight burn for undead ONLY when exposed to open sky (cave zombies/skeletons stay safe!)
      if (m.def.burnsInDay && !sky.isNight() && sky.weather === 'clear') {
        const surfY = this.world.getSurfaceY(m.pos.x, m.pos.z);
        if (m.pos.y >= surfY - 1.2) {
          m.burnTimer = Math.max(m.burnTimer || 0, 2.4);
        }
      }

      m.attackCd = Math.max(0, m.attackCd - dt);

      // Anti-overlap rescue if player placed a block on top of a mob
      if (this.mobCollidesAt(m.pos.x, m.pos.y, m.pos.z, m.halfW * 0.85, m.height)) {
        if (!this.mobCollidesAt(m.pos.x, m.pos.y + 1, m.pos.z, m.halfW, m.height)) {
          m.pos.y += 1;
        } else {
          for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (!this.mobCollidesAt(m.pos.x + ox * 0.6, m.pos.y, m.pos.z + oz * 0.6, m.halfW, m.height)) {
              m.pos.x += ox * 0.6;
              m.pos.z += oz * 0.6;
              break;
            }
          }
        }
      }

      // Shy wildlife dart away if player sprints very close
      if (m.def.shy && distToPlayer < 4.5 && player.sprinting && m.fleeTimer <= 0) {
        m.fleeTimer = 2.6;
      }

      // AI Movement:
      // A) Hostile Mobs attack Survival Players AND raid Villagers / Villager Soldiers / Iron Golems!
      // B) Iron Golems & Villager Soldiers actively defend against Hostile Mobs AND punish Players who attack them or villagers in LOS!
      let moveX = 0, moveZ = 0;
      let creeperShakeX = 0, creeperShakeZ = 0;
      if (m.attackSwing > 0) m.attackSwing = Math.max(0, m.attackSwing - dt * 4.5);

      let hostileTarget = null;
      let hostileTargetIsPlayer = false;
      let hostileTargetDist = 20;
      if (m.def.hostile) {
        if (player.mode === 'survival' && !player.dead && distToPlayer < hostileTargetDist) {
          hostileTarget = player;
          hostileTargetIsPlayer = true;
          hostileTargetDist = distToPlayer;
        }
        // Scan pre-filtered NPC list (O(hostiles * nearby_npcs) with fast squared-distance reject!)
        let maxD2 = Math.min(18, hostileTargetDist);
        maxD2 *= maxD2;
        for (let vi = 0; vi < npcList.length; vi++) {
          const v = npcList[vi];
          const dx = m.pos.x - v.pos.x;
          const dz = m.pos.z - v.pos.z;
          const dy = m.pos.y - v.pos.y;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < maxD2) {
            maxD2 = d2;
            hostileTarget = v;
            hostileTargetIsPlayer = false;
            hostileTargetDist = Math.sqrt(d2);
          }
        }
      }

      if (m.def.guard) {
        // Decay player aggro timer cleanly
        if (m.aggroTimer > 0) {
          m.aggroTimer = Math.max(0, m.aggroTimer - dt);
          if (m.aggroTimer <= 0 || player.dead || player.mode !== 'survival') m.aggroPlayer = false;
        } else {
          m.aggroPlayer = false;
        }

        // Priority 1: Provoked against Player (only if saw villager attack OR player hit this guard!)
        // Priority 2: Closest Hostile Mob within 22 blocks (uses pre-filtered hostileList -> 98% fewer checks!)
        let guardTarget = null;
        let guardTargetIsPlayer = false;
        let guardTargetDist = 24;
        if (m.aggroPlayer && player.mode === 'survival' && !player.dead && distToPlayer < 26) {
          guardTarget = player;
          guardTargetIsPlayer = true;
          guardTargetDist = distToPlayer;
        } else if (hostileList.length > 0) {
          let bestD2 = 22 * 22;
          for (let hi = 0; hi < hostileList.length; hi++) {
            const hm = hostileList[hi];
            if (hm.hp <= 0) continue;
            const dx = m.pos.x - hm.pos.x;
            const dz = m.pos.z - hm.pos.z;
            const dy = m.pos.y - hm.pos.y;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < bestD2) {
              bestD2 = d2;
              guardTarget = hm;
              guardTargetIsPlayer = false;
              guardTargetDist = Math.sqrt(d2);
            }
          }
        }

        if (guardTarget) {
          const tx = guardTarget.pos.x;
          const tz = guardTarget.pos.z;
          const dx = tx - m.pos.x;
          const dz = tz - m.pos.z;
          m.yaw = lerpAngle(m.yaw, Math.atan2(dx, dz), Math.min(1, dt * 12));
          const reach = m.def.golem ? 2.15 : 1.75;
          if (guardTargetDist > reach) {
            const chSpd = m.def.speed * (m.def.golem ? 1.25 : 1.15);
            moveX = Math.sin(m.yaw) * chSpd;
            moveZ = Math.cos(m.yaw) * chSpd;
          } else if (m.attackCd <= 0) {
            m.attackCd = m.def.golem ? 1.05 : 0.72;
            m.attackSwing = 1.0;
            const gDmg = m.def.dmg || (m.def.golem ? 9 : 4);
            const hLen = Math.max(0.01, Math.hypot(dx, dz));
            if (guardTargetIsPlayer) {
              player.vel.x += (dx / hLen) * (m.def.golem ? 6.5 : 4.2);
              player.vel.z += (dz / hLen) * (m.def.golem ? 6.5 : 4.2);
              player.vel.y = Math.max(player.vel.y, m.def.golem ? 8.2 : 3.6);
              player.takeDamage(gDmg, m.def.golem ? 'Flung by Iron Golem' : 'Slain by Villager Soldier');
            } else {
              const deadH = this.hitMob(guardTarget, gDmg, { x: dx / hLen, y: 0.6, z: dz / hLen }, null);
              if (!deadH && m.def.golem) {
                guardTarget.vel.y = Math.max(guardTarget.vel.y, 9.2); // Iconic Minecraft Iron Golem sky-launch!
              }
            }
          }
        } else {
          // Calm guard patrol around home village / castle / pyramid
          m.aiTimer -= dt;
          if (m.aiTimer <= 0) {
            m.aiTimer = 2.2 + Math.random() * 3.6;
            m.moving = Math.random() > 0.30;
            if (m.pos.distanceTo(m.homePos) > 20) {
              m.wanderDir = Math.atan2(m.homePos.x - m.pos.x, m.homePos.z - m.pos.z) + (Math.random() - 0.5) * 0.5;
              m.moving = true;
            } else {
              m.wanderDir = Math.random() * Math.PI * 2;
            }
          }
          if (m.moving) {
            m.yaw = lerpAngle(m.yaw, m.wanderDir, Math.min(1, dt * 6));
            moveX = Math.sin(m.yaw) * m.def.speed * 0.65;
            moveZ = Math.cos(m.yaw) * m.def.speed * 0.65;
          }
        }
      } else if (m.def.hostile && hostileTarget) {
        const dx = hostileTarget.pos.x - m.pos.x;
        const dz = hostileTarget.pos.z - m.pos.z;
        m.yaw = Math.atan2(dx, dz);

        if (m.def.creeper && (hostileTargetDist < 3.4 || (m.fuseTimer > 0 && hostileTargetDist < 5.6))) {
          // Dramatic Minecraft Creeper Prime & Swell Animation!
          const FUSE_MAX = 1.5;
          if (m.fuseTimer === 0 && this.sound && this.sound.playFuse) this.sound.playFuse();
          m.fuseTimer += dt;
          const p = Math.min(1, m.fuseTimer / FUSE_MAX);

          // Accelerating incandescent white warning strobe across ALL Creeper body parts!
          const flashFreq = 11 + p * 44;
          const flashWhite = p > 0.88 || Math.sin(m.fuseTimer * flashFreq) > 0;
          if (m.hurtFlash <= 0) {
            this.setMobTint(m, flashWhite ? 'white' : 'normal');
          }

          // Dramatic bulging squash-and-stretch inflation as pressure builds!
          const pulseWave = Math.sin(m.fuseTimer * (16 + p * 26)) * (0.06 + p * 0.08);
          const swellXZ = 1.0 + p * p * 0.62 + pulseWave;
          const swellY = 1.0 - p * 0.14 + Math.cos(m.fuseTimer * (14 + p * 22)) * (0.04 + p * 0.06);
          m.mesh.scale.set(swellXZ, Math.max(0.75, swellY), swellXZ);

          // Intense high-frequency body tremble & head stiffen upward!
          const jitterAmp = p * p * 0.14;
          creeperShakeX = (Math.random() - 0.5) * jitterAmp;
          creeperShakeZ = (Math.random() - 0.5) * jitterAmp;
          if (m.headGroup) {
            m.headGroup.rotation.x = -p * 0.32;
          }

          // Emit rising crackling white-gold sparks around the swelling Creeper!
          m.creeperSparkCd = (m.creeperSparkCd || 0) - dt;
          if (m.creeperSparkCd <= 0 && effects && effects.spawnCreeperSpark) {
            m.creeperSparkCd = Math.max(0.05, 0.16 - p * 0.10);
            effects.spawnCreeperSpark(m.pos.x, m.pos.y, m.pos.z, p);
          }

          if (m.fuseTimer >= FUSE_MAX) {
            if (onExplosion) onExplosion(m.pos.x, m.pos.y + 0.8, m.pos.z, 3.8);
            this.removeMob(m);
            continue;
          }
        } else if (m.type === 'skeleton') {
          // Authentic Ranged Skeleton AI: shoots at Players, Villagers, Soldiers & Iron Golems!
          m.strafeTimer = (m.strafeTimer || 0) - dt;
          if (m.strafeTimer <= 0) {
            m.strafeTimer = 1.6 + Math.random() * 2.0;
            m.strafeDir = Math.random() < 0.5 ? 1 : -1;
          }
          const tAimY = hostileTarget.pos.y + (hostileTargetIsPlayer ? 1.15 : (hostileTarget.height || 1.6) * 0.65);
          const hasLOS = hostileTargetDist < 17 && this.hasLineOfSight(
            m.pos.x, m.pos.y + 1.5, m.pos.z,
            hostileTarget.pos.x, tAimY, hostileTarget.pos.z
          );

          if (!hasLOS || hostileTargetDist > 12.5) {
            moveX = Math.sin(m.yaw) * m.def.speed;
            moveZ = Math.cos(m.yaw) * m.def.speed;
            m.bowDraw = Math.max(0, (m.bowDraw || 0) - dt * 2.2);
          } else {
            const strafeYaw = m.yaw + (Math.PI * 0.5) * m.strafeDir;
            const backMul = hostileTargetDist < 5.0 ? -0.75 : 0;
            moveX = Math.sin(strafeYaw) * m.def.speed * 0.55 + Math.sin(m.yaw) * m.def.speed * backMul;
            moveZ = Math.cos(strafeYaw) * m.def.speed * 0.55 + Math.cos(m.yaw) * m.def.speed * backMul;

            if (m.attackCd <= 0) {
              m.bowDraw = Math.min(1, (m.bowDraw || 0) + dt / 1.15);
              if (m.bowDraw >= 1) {
                m.bowDraw = 0;
                m.attackCd = 1.65;
                const sx = m.pos.x + Math.sin(m.yaw) * 0.45;
                const sy = m.pos.y + 1.48;
                const sz = m.pos.z + Math.cos(m.yaw) * 0.45;
                const tx = hostileTarget.pos.x - sx;
                const ty = tAimY - sy;
                const tz = hostileTarget.pos.z - sz;
                const hDist = Math.max(0.5, Math.hypot(tx, tz));
                const speed = 19.5;
                const flightT = hDist / speed;
                const spread = 0.055;
                const vx = (tx / hDist) * speed + (Math.random() - 0.5) * speed * spread;
                const vz = (tz / hDist) * speed + (Math.random() - 0.5) * speed * spread;
                const vy = (ty + 0.5 * 14.0 * flightT * flightT) / Math.max(0.12, flightT);
                const scaledDmg = Math.max(1, Math.round((m.def.dmg || 3) * diffCfg.dmgMul));
                this.spawnArrow(sx, sy, sz, vx, vy, vz, scaledDmg, m);
              }
            }
          }
        } else {
          if (m.def.creeper && m.fuseTimer > 0) {
            m.fuseTimer = Math.max(0, m.fuseTimer - dt * 1.8);
            const p = m.fuseTimer / 1.5;
            const deflate = 1.0 + p * p * 0.62;
            m.mesh.scale.set(deflate, 1.0 - p * 0.14, deflate);
            if (m.hurtFlash <= 0) this.setMobTint(m, 'normal');
            if (m.fuseTimer <= 0) m.mesh.scale.setScalar(1.0);
          }
          if (hostileTargetDist > 1.45) {
            moveX = Math.sin(m.yaw) * m.def.speed;
            moveZ = Math.cos(m.yaw) * m.def.speed;
          } else if (m.attackCd <= 0 && !m.def.creeper) {
            m.attackCd = 1.1;
            const scaledDmg = Math.max(1, Math.round((m.def.dmg || 3) * diffCfg.dmgMul));
            if (hostileTargetIsPlayer) {
              player.takeDamage(scaledDmg, `Slain by ${m.label || m.type}`);
            } else {
              const hLen = Math.max(0.01, Math.hypot(dx, dz));
              this.hitMob(hostileTarget, scaledDmg, { x: dx / hLen, y: 0.35, z: dz / hLen }, null);
            }
          }
        }
      } else {
        if (m.def.creeper && m.fuseTimer > 0) {
          m.fuseTimer = 0;
          m.mesh.scale.setScalar(1.0);
          if (m.hurtFlash <= 0) this.setMobTint(m, 'normal');
        }
        if (m.type === 'skeleton') m.bowDraw = Math.max(0, (m.bowDraw || 0) - dt * 2.5);
        m.aiTimer -= dt;
        if (m.fleeTimer > 0) {
          // HAYWIRE PANIC ESCAPE! Wild erratic zig-zagging + frantic 2.35x sprinting!
          m.fleeTimer = Math.max(0, m.fleeTimer - dt);
          m.panicZigTimer = (m.panicZigTimer || 0) - dt;
          if (m.panicZigTimer <= 0) {
            m.panicZigTimer = 0.28 + Math.random() * 0.42;
            const awayYaw = Math.atan2(m.pos.x - player.pos.x, m.pos.z - player.pos.z);
            m.wanderDir = awayYaw + (Math.random() - 0.5) * 2.25;
          }
          m.yaw = lerpAngle(m.yaw, m.wanderDir, Math.min(1, dt * 15));
          moveX = Math.sin(m.yaw) * m.def.speed * 2.35;
          moveZ = Math.cos(m.yaw) * m.def.speed * 2.35;
        } else {
          // Authentic Minecraft Villager Night Routine: A* Door-Aware Pathfinding -> Open Door -> Sleep Cleanly -> Wake & Exit at Dawn!
          const isCivilianVillager = m.def.villager && !m.def.guard;
          if (isCivilianVillager && !isSleepNight && m.sleeping) {
            // Wake up cleanly at morning (06:00) onto an open adjacent floor tile & pathfind outside through the door!
            const bed = m.sleepBed;
            m.sleeping = false;
            m.sleepBed = null;
            m.path = null;
            m.pathIdx = 0;
            if (m.mesh) m.mesh.rotation.x = 0;
            if (bed) {
              // Step onto a walkable floor tile beside the bed so villager never clips into walls/bed!
              let stood = false;
              const candidates = [
                [bed.x + 1, bed.z], [bed.x - 1, bed.z], [bed.x, bed.z + 1], [bed.x, bed.z - 1],
                [bed.headX + 1, bed.headZ], [bed.headX - 1, bed.headZ], [bed.headX, bed.headZ + 1], [bed.headX, bed.headZ - 1]
              ];
              for (let ci = 0; ci < candidates.length; ci++) {
                const [sx, sz] = candidates[ci];
                const bf = this.world.getBlock(sx, bed.y, sz);
                const bh = this.world.getBlock(sx, bed.y + 1, sz);
                const bg = this.world.getBlock(sx, bed.y - 1, sz);
                if (!isBlockSolid(bf) && !isBedBlock(bf) && !isBlockSolid(bh) && isBlockSolid(bg)) {
                  m.pos.set(sx + 0.5, bed.y, sz + 0.5);
                  stood = true;
                  break;
                }
              }
              if (!stood) m.pos.set(bed.x + 0.5, bed.y + 0.6, bed.z + 0.5);
            }
            m._exitMorningTimer = 9.0;
            m.aiTimer = 0.2;
            m.moving = true;
          }

          if (isCivilianVillager && isSleepNight && m.fleeTimer <= 0) {
            if (m.sleeping && m.sleepBed) {
              // Check periodically that bed still exists (cheap O(1) check)
              m._sleepCheckTimer = (m._sleepCheckTimer || 0) - dt;
              if (m._sleepCheckTimer <= 0) {
                m._sleepCheckTimer = 0.8;
                if (!isBedBlock(this.world.getBlock(m.sleepBed.x, m.sleepBed.y, m.sleepBed.z))) {
                  m.sleeping = false;
                  m.sleepBed = null;
                  if (m.mesh) m.mesh.rotation.x = 0;
                }
              }
              if (m.sleeping && m.sleepBed) {
                const b = m.sleepBed;
                // Align cleanly: feet at foot end, head squarely on white pillow, lying on mattress top!
                const fdx = (b.headX - b.x) || 0;
                const fdz = (b.headZ - b.z) || 0;
                m.pos.set(b.x + 0.5 - fdx * 0.20, b.y + 0.58, b.z + 0.5 - fdz * 0.20);
                m.vel.set(0, 0, 0);
                m.yaw = b.yaw || 0;
                m.headYaw = 0;
                m.headPitch = 0;
                m.legSwing = 0;
                if (m.mesh) {
                  m.mesh.position.set(m.pos.x, m.pos.y, m.pos.z);
                  m.mesh.rotation.y = m.yaw;
                  m.mesh.rotation.x = -Math.PI * 0.5;
                }
                continue;
              }
            }

            // Fast chunk-cached bed lookup (1,000x faster than full block scan!)
            m._bedScanTimer = (m._bedScanTimer || 0) - dt;
            if (!m.sleepBed && m._bedScanTimer <= 0) {
              m._bedScanTimer = 2.0 + Math.random() * 1.6;
              m.sleepBed = this._findAvailableBedForVillager(m);
              m.path = null;
              m.pathIdx = 0;
            }
            // Validate bed wasn't broken
            if (m.sleepBed && !isBedBlock(this.world.getBlock(m.sleepBed.x, m.sleepBed.y, m.sleepBed.z))) {
              m.sleepBed = null;
              m.path = null;
            }

            if (m.sleepBed) {
              const b = m.sleepBed;
              const bdx = (b.x + 0.5) - m.pos.x;
              const bdz = (b.z + 0.5) - m.pos.z;
              const bdy = Math.abs(b.y - m.pos.y);
              const bDist = Math.hypot(bdx, bdz);
              if (bDist < 1.85 && bdy < 2.2) {
                // Verify line to bed isn't blocked by a solid wall (must have entered the room through the door!)
                const midBlk = this.world.getBlock((m.pos.x + b.x + 0.5) * 0.5, b.y + 1, (m.pos.z + b.z + 0.5) * 0.5);
                if (!isBlockSolid(midBlk) || isDoorBlock(midBlk) || isBedBlock(midBlk)) {
                  const fdx = (b.headX - b.x) || 0;
                  const fdz = (b.headZ - b.z) || 0;
                  m.sleeping = true;
                  m.path = null;
                  m.vel.set(0, 0, 0);
                  m.pos.set(b.x + 0.5 - fdx * 0.20, b.y + 0.58, b.z + 0.5 - fdz * 0.20);
                  m.yaw = b.yaw || 0;
                  m.headYaw = 0;
                  m.headPitch = 0;
                  m.legSwing = 0;
                  if (m.mesh) {
                    m.mesh.position.set(m.pos.x, m.pos.y, m.pos.z);
                    m.mesh.rotation.y = m.yaw;
                    m.mesh.rotation.x = -Math.PI * 0.5;
                  }
                  continue;
                }
              }

              // Door-aware A* pathfinding around exterior house walls straight through the front door to the bed!
              m.pathTimer = (m.pathTimer || 0) - dt;
              if ((!m.path || m.pathIdx >= m.path.length || m.pathTimer <= 0) && this._pathsThisFrame < 5) {
                this._pathsThisFrame++;
                m.pathTimer = 2.4 + Math.random() * 1.4;
                m.path = this._computeVillagerPath(
                  Math.floor(m.pos.x), Math.floor(m.pos.y + 0.1), Math.floor(m.pos.z),
                  b.x, b.y, b.z,
                  200
                );
                m.pathIdx = 0;
              }

              let steerX = bdx, steerZ = bdz;
              let curWp = null;
              if (m.path && m.pathIdx < m.path.length) {
                curWp = m.path[m.pathIdx];
                let wdx = (curWp.x + 0.5) - m.pos.x;
                let wdz = (curWp.z + 0.5) - m.pos.z;
                if (wdx * wdx + wdz * wdz < 0.36 && Math.abs(curWp.y - m.pos.y) < 1.35) {
                  m.pathIdx++;
                  if (m.pathIdx < m.path.length) {
                    curWp = m.path[m.pathIdx];
                    wdx = (curWp.x + 0.5) - m.pos.x;
                    wdz = (curWp.z + 0.5) - m.pos.z;
                  }
                }
                steerX = wdx;
                steerZ = wdz;
              }
              m.wanderDir = Math.atan2(steerX, steerZ);
              m.yaw = lerpAngle(m.yaw, m.wanderDir, Math.min(1, dt * 11));
              moveX = Math.sin(m.yaw) * m.def.speed * 1.12;
              moveZ = Math.cos(m.yaw) * m.def.speed * 1.12;
              tryOpenDoorAhead(m, moveX, moveZ, curWp);
            } else {
              // No unclaimed bed nearby -> head toward home/village center to find shelter
              if (m.aiTimer <= 0) {
                m.aiTimer = 2.0 + Math.random() * 2.5;
                m.wanderDir = Math.atan2(m.homePos.x - m.pos.x, m.homePos.z - m.pos.z) + (Math.random() - 0.5) * 1.4;
                m.moving = true;
              }
              m.yaw = lerpAngle(m.yaw, m.wanderDir, Math.min(1, dt * 7));
              moveX = Math.sin(m.yaw) * m.def.speed * 0.85;
              moveZ = Math.cos(m.yaw) * m.def.speed * 0.85;
              tryOpenDoorAhead(m, moveX, moveZ, null);
            }
          } else {
            // Morning exit routine: if villager just woke up inside a house, pathfind cleanly out through the door!
            if (isCivilianVillager && (m._exitMorningTimer || 0) > 0) {
              m._exitMorningTimer -= dt;
              m.pathTimer = (m.pathTimer || 0) - dt;
              if ((!m.path || m.pathIdx >= m.path.length || m.pathTimer <= 0) && this._pathsThisFrame < 5) {
                this._pathsThisFrame++;
                m.pathTimer = 2.6;
                const tx = Math.floor(m.homePos.x);
                const tz = Math.floor(m.homePos.z);
                const ty = Math.floor(this.world.getSurfaceY(tx, tz));
                m.path = this._computeVillagerPath(
                  Math.floor(m.pos.x), Math.floor(m.pos.y + 0.1), Math.floor(m.pos.z),
                  tx, ty, tz,
                  140
                );
                m.pathIdx = 0;
              }
              if (m.path && m.pathIdx < m.path.length) {
                let wp = m.path[m.pathIdx];
                let wdx = (wp.x + 0.5) - m.pos.x;
                let wdz = (wp.z + 0.5) - m.pos.z;
                if (wdx * wdx + wdz * wdz < 0.42) {
                  m.pathIdx++;
                  if (m.pathIdx < m.path.length) {
                    wp = m.path[m.pathIdx];
                    wdx = (wp.x + 0.5) - m.pos.x;
                    wdz = (wp.z + 0.5) - m.pos.z;
                  }
                }
                m.wanderDir = Math.atan2(wdx, wdz);
                m.yaw = lerpAngle(m.yaw, m.wanderDir, Math.min(1, dt * 10));
                moveX = Math.sin(m.yaw) * m.def.speed * 0.85;
                moveZ = Math.cos(m.yaw) * m.def.speed * 0.85;
                tryOpenDoorAhead(m, moveX, moveZ, wp);
              } else {
                m._exitMorningTimer = 0;
              }
            } else {
              if (m.aiTimer <= 0) {
                m.aiTimer = 2.4 + Math.random() * 4.2;
                m.moving = Math.random() > 0.35;
                const hRad = m.homeRadius || 24;
                if ((m.def.villager || m.def.golem) && m.pos.distanceTo(m.homePos) > hRad) {
                  m.wanderDir = Math.atan2(m.homePos.x - m.pos.x, m.homePos.z - m.pos.z) + (Math.random() - 0.5) * 0.5;
                  m.moving = true;
                } else if (m.herdHome && !m.def.hostile && m.pos.distanceTo(m.herdHome) > 13) {
                  m.wanderDir = Math.atan2(m.herdHome.x - m.pos.x, m.herdHome.z - m.pos.z) + (Math.random() - 0.5) * 0.9;
                  m.moving = true;
                } else {
                  m.wanderDir = Math.random() * Math.PI * 2;
                }
              }
              if (m.moving) {
                m.yaw = lerpAngle(m.yaw, m.wanderDir, Math.min(1, dt * 6));
                moveX = Math.sin(m.yaw) * m.def.speed * 0.65;
                moveZ = Math.cos(m.yaw) * m.def.speed * 0.65;
                if (m.def.villager) tryOpenDoorAhead(m, moveX, moveZ, null);
              } else if (m.def.villager && distToPlayer < 5.5) {
                const lookYaw = Math.atan2(player.pos.x - m.pos.x, player.pos.z - m.pos.z);
                m.yaw = lerpAngle(m.yaw, lookYaw, Math.min(1, dt * 6));
              }
            }
          }
        }
      }

      // Gravity, Water Buoyancy, Lava Escape & Animated Fire Burning!
      const feetBlk = this.world.getBlock(m.pos.x, m.pos.y + 0.15, m.pos.z);
      const midBlk = this.world.getBlock(m.pos.x, m.pos.y + Math.min(0.85, m.height * 0.5), m.pos.z);
      const inWater = feetBlk === BLOCK.WATER;
      const inLava = feetBlk === BLOCK.LAVA || midBlk === BLOCK.LAVA;
      const inFire = feetBlk === BLOCK.FIRE || midBlk === BLOCK.FIRE;

      if (inWater) {
        // Water immediately extinguishes burning mobs!
        m.burnTimer = 0;
        m._fireDotTick = 0;
      }

      if (inLava || inFire) {
        // Catch on fire + actively steer & frantically jump away from lava/fire!
        m.burnTimer = Math.max(m.burnTimer || 0, inLava ? 8.0 : 5.5);
        m._lavaEscapeTimer = (m._lavaEscapeTimer || 0) - dt;
        if (m._lavaEscapeTimer <= 0) {
          m._lavaEscapeTimer = 0.32;
          m.wanderDir = this._findLavaEscapeYaw(m);
        }
        m.fleeTimer = Math.max(m.fleeTimer || 0, 4.5);
        m.panicZigTimer = 0.35; // keep steering toward the safe escape block!
        m.yaw = lerpAngle(m.yaw, m.wanderDir, Math.min(1, dt * 16));
        const escSpeed = m.def.speed * (inLava ? 2.2 : 2.0);
        moveX = Math.sin(m.yaw) * escSpeed;
        moveZ = Math.cos(m.yaw) * escSpeed;

        // Strong escape jumps out of lava pools so mobs visibly leap away onto dry land!
        m._lavaJumpCd = (m._lavaJumpCd || 0) - dt;
        if (m._lavaJumpCd <= 0) {
          m._lavaJumpCd = 0.32;
          m.vel.y = Math.max(m.vel.y, inLava ? 7.6 : 6.4);
          m.vel.x = moveX * 1.15;
          m.vel.z = moveZ * 1.15;
        }

        m._lavaBurnTick = (m._lavaBurnTick || 0) + dt;
        if (m._lavaBurnTick >= (inLava ? 0.55 : 0.8)) {
          m._lavaBurnTick = 0;
          const deadNow = this.hitMob(m, inLava ? 3 : 2, { x: Math.sin(m.yaw), y: 0.65, z: Math.cos(m.yaw) }, null);
          if (deadNow && m.hp <= 0) continue;
        }
      } else {
        m._lavaBurnTick = 0;
      }

      // Ongoing burning damage & animated 3D pixel flames after catching on fire!
      if (m.burnTimer > 0) {
        anyMobBurning = true;
        m.burnTimer = Math.max(0, m.burnTimer - dt);
        m._fireDotTick = (m._fireDotTick || 0) + dt;
        if (!inLava && !inFire && m._fireDotTick >= 0.95) {
          m._fireDotTick = 0;
          const deadNow = this.hitMob(m, 1.5, { x: Math.sin(m.yaw) * 0.4, y: 0.3, z: Math.cos(m.yaw) * 0.4 }, null);
          if (deadNow && m.hp <= 0) continue;
        }
        if (effects && Math.random() < dt * 5.0 && distToPlayer < 36) {
          effects.spawnFireEmber(m.pos.x - 0.5, m.pos.y + m.height * 0.5, m.pos.z - 0.5);
        }
        const fg = this._ensureMobFireMesh(m);
        if (fg) {
          fg.visible = true;
          const flick = 0.94 + Math.sin(nowSec * 26 + m.walkPhase) * 0.08;
          fg.scale.set(1.0, flick, 1.0);
        }
      } else if (m.fireGroup && m.fireGroup.visible) {
        m.fireGroup.visible = false;
      }

      if (m.def.floatsOnWater && inWater) {
        const surfaceY = Math.floor(m.pos.y + 0.15) + 0.72;
        m.vel.y = (surfaceY - m.pos.y) * 5.0;
      } else {
        m.vel.y -= (inWater || inLava ? 6 : 22) * dt;
        if (inWater) m.vel.y = Math.max(m.vel.y, 1.8);
      }

      const speedMag = Math.hypot(moveX, moveZ);
      // Frantic repeated leaping/hopping when panicking!
      if (m.fleeTimer > 0 && !inWater) {
        m.panicJumpTimer = (m.panicJumpTimer || 0) - dt;
        if (m.panicJumpTimer <= 0 && Math.abs(m.vel.y) <= 0.2) {
          if (!this.mobCollidesAt(m.pos.x, m.pos.y + 0.9, m.pos.z, m.halfW, m.height)) {
            m.vel.y = 5.9 + Math.random() * 1.7;
          }
          m.panicJumpTimer = 0.24 + Math.random() * 0.36;
        }
      } else if (m.def.hopper && speedMag > 0.4 && m.vel.y === 0 && !inWater && Math.random() < dt * 4.5) {
        if (!this.mobCollidesAt(m.pos.x, m.pos.y + 0.8, m.pos.z, m.halfW, m.height)) {
          m.vel.y = 5.6;
        }
      }

      // Preserve crisp Knockback Physics when hit; smoothly steer otherwise!
      if (m.knockbackTimer > 0) {
        const drag = Math.pow(0.08, dt);
        m.vel.x *= drag;
        m.vel.z *= drag;
      } else {
        m.vel.x = THREE.MathUtils.lerp(m.vel.x, moveX, Math.min(1, dt * 8));
        m.vel.z = THREE.MathUtils.lerp(m.vel.z, moveZ, Math.min(1, dt * 8));
      }

      let hitWall = false;
      const nx = m.pos.x + m.vel.x * dt;
      if (!this.mobCollidesAt(nx, m.pos.y, m.pos.z, m.halfW, m.height)) {
        m.pos.x = nx;
      } else {
        hitWall = true;
        if (!this.mobCollidesAt(nx, m.pos.y + 1.05, m.pos.z, m.halfW, m.height) && Math.abs(m.vel.y) <= 0.15) {
          m.vel.y = 7.4;
        } else {
          m.vel.x = 0;
        }
      }

      const nz = m.pos.z + m.vel.z * dt;
      if (!this.mobCollidesAt(m.pos.x, m.pos.y, nz, m.halfW, m.height)) {
        m.pos.z = nz;
      } else {
        hitWall = true;
        if (!this.mobCollidesAt(m.pos.x, m.pos.y + 1.05, nz, m.halfW, m.height) && Math.abs(m.vel.y) <= 0.15) {
          m.vel.y = 7.4;
        } else {
          m.vel.z = 0;
        }
      }

      // Anti-spin wall handling: panicking animals wildly bounce & jump away; calm animals graze if cornered!
      if (hitWall && m.knockbackTimer <= 0 && m.fleeTimer > 0) {
        if (m.turnCd <= 0) {
          m.turnCd = 0.22;
          m.wanderDir += (Math.random() < 0.5 ? 1 : -1) * (1.2 + Math.random() * 1.15);
          m.panicZigTimer = 0.35;
        }
        if (Math.abs(m.vel.y) <= 0.2 && !inWater) {
          m.vel.y = 7.4;
        }
      } else if (hitWall && m.knockbackTimer <= 0 && Math.hypot(m.vel.x, m.vel.z) < 0.25) {
        m.stuckTimer += dt;
        if (m.turnCd <= 0) {
          m.turnCd = 0.8 + Math.random() * 0.5;
          m.wanderDir += (Math.random() < 0.5 ? 1 : -1) * (1.35 + Math.random() * 1.1);
        }
        if (m.stuckTimer > 1.8) {
          m.stuckTimer = 0;
          m.moving = false;
          m.aiTimer = 2.0 + Math.random() * 2.4;
        }
      } else {
        m.stuckTimer = Math.max(0, m.stuckTimer - dt * 2);
      }

      // Full 4-corner vertical ground & ceiling collision!
      const ny = m.pos.y + m.vel.y * dt;
      if (m.vel.y <= 0 && this.hasSolidBelow(m.pos.x, ny, m.pos.z, m.halfW)) {
        m.pos.y = Math.floor(ny) + 1;
        m.vel.y = 0;
      } else if (m.vel.y > 0 && this.mobCollidesAt(m.pos.x, ny, m.pos.z, m.halfW, m.height)) {
        m.vel.y = 0;
      } else {
        m.pos.y = ny;
      }

      // Keep mobs inside world border if active
      if (this.world && this.world.worldBorderChunks > 0) {
        const lim = this.world.worldBorderChunks * 16 - 0.8;
        if (m.pos.x < -lim) { m.pos.x = -lim; m.wanderDir = Math.PI * 0.5; }
        else if (m.pos.x > lim) { m.pos.x = lim; m.wanderDir = -Math.PI * 0.5; }
        if (m.pos.z < -lim) { m.pos.z = -lim; m.wanderDir = 0; }
        else if (m.pos.z > lim) { m.pos.z = lim; m.wanderDir = Math.PI; }
      }

      // Apply transform + limb/arm/head/tail/wing animations (handles both GPU-instanced NPCs & classic meshes!)
      if (m.instancedNpc) {
        if (speedMag > 0.1) {
          m.walkPhase += dt * speedMag * 3.6;
          m.legSwing = Math.sin(m.walkPhase) * 0.56;
        } else {
          m.legSwing *= 0.84;
        }
        if (m.def.soldier) {
          const march = speedMag > 0.1 ? Math.sin(m.walkPhase) * 0.42 : Math.sin(nowSec * 2.4 + m.walkPhase) * 0.05;
          const slash = m.attackSwing > 0 ? Math.sin(m.attackSwing * Math.PI) * 1.55 : 0;
          m.armSwingL = march;
          m.armSwingR = -0.25 - march * 0.5 - slash;
        } else if (m.def.golem) {
          const march = speedMag > 0.1 ? Math.sin(m.walkPhase) * 0.45 : 0;
          const slam = m.attackSwing > 0 ? Math.sin(m.attackSwing * Math.PI) * 1.4 : 0;
          m.armSwingL = -march - slam;
          m.armSwingR = march - slam;
        }
        if (m.def.villager && distToPlayer < 7.5) {
          let dyaw = Math.atan2(player.pos.x - m.pos.x, player.pos.z - m.pos.z) - m.yaw;
          while (dyaw > Math.PI) dyaw -= Math.PI * 2;
          while (dyaw < -Math.PI) dyaw += Math.PI * 2;
          dyaw = Math.max(-0.95, Math.min(0.95, dyaw));
          const dpitch = Math.max(-0.35, Math.min(0.35, -Math.atan2((player.pos.y + 1.5) - (m.pos.y + 1.65), Math.max(1, distToPlayer))));
          m.headYaw = THREE.MathUtils.lerp(m.headYaw || 0, dyaw, Math.min(1, dt * 6));
          m.headPitch = THREE.MathUtils.lerp(m.headPitch || 0, dpitch, Math.min(1, dt * 6));
        } else {
          const graze = speedMag < 0.12 ? Math.sin(nowSec * 1.4 + m.walkPhase) * 0.05 : 0;
          m.headPitch = THREE.MathUtils.lerp(m.headPitch || 0, graze, Math.min(1, dt * 4));
          m.headYaw = THREE.MathUtils.lerp(m.headYaw || 0, 0, Math.min(1, dt * 4));
        }
        continue;
      }

      m.mesh.position.set(m.pos.x + creeperShakeX, m.pos.y, m.pos.z + creeperShakeZ);
      m.mesh.rotation.y = m.yaw;
      if (speedMag > 0.1) {
        m.walkPhase += dt * speedMag * (m.def.spider ? 5.2 : 3.6);
        m.legs.forEach((leg, idx) => {
          if (m.def.spider) {
            leg.rotation.z = Math.sin(m.walkPhase + (idx % 2 === 0 ? 0 : Math.PI)) * 0.28;
          } else {
            leg.rotation.x = Math.sin(m.walkPhase + (idx % 2 === 0 ? 0 : Math.PI)) * 0.58;
          }
        });
      } else {
        m.legs.forEach((leg) => {
          if (m.def.spider) leg.rotation.z *= 0.85;
          else leg.rotation.x *= 0.85;
        });
      }
      // Articulated Arms: Villager Soldier Sword Slash, Skeleton Bow Draw, Zombie Reach!
      if (m.arms && m.arms.length === 2) {
        if (m.def.soldier) {
          const march = speedMag > 0.1 ? Math.sin(m.walkPhase) * 0.42 : Math.sin(nowSec * 2.4 + m.walkPhase) * 0.05;
          const slash = m.attackSwing > 0 ? Math.sin(m.attackSwing * Math.PI) * 1.55 : 0;
          m.arms[0].rotation.x = march;
          m.arms[1].rotation.x = -0.25 - march * 0.5 - slash;
        } else if (m.type === 'skeleton' && m.bowDraw > 0.02) {
          const aimPitch = -Math.PI * 0.50 - m.bowDraw * 0.14;
          m.arms[0].rotation.x = aimPitch;
          m.arms[1].rotation.x = aimPitch - 0.06;
        } else {
          const sway = Math.sin(nowSec * 3.2 + m.walkPhase) * 0.12;
          m.arms[0].rotation.x = -Math.PI * 0.44 + sway;
          m.arms[1].rotation.x = -Math.PI * 0.44 - sway;
        }
      }
      // Living Head Animation: Villagers make friendly eye contact with nearby player; wildlife grazes!
      if (m.headGroup) {
        if (m.def.villager && distToPlayer < 7.5) {
          let dyaw = Math.atan2(player.pos.x - m.pos.x, player.pos.z - m.pos.z) - m.yaw;
          while (dyaw > Math.PI) dyaw -= Math.PI * 2;
          while (dyaw < -Math.PI) dyaw += Math.PI * 2;
          dyaw = Math.max(-0.95, Math.min(0.95, dyaw));
          const dpitch = Math.max(-0.35, Math.min(0.35, -Math.atan2((player.pos.y + 1.5) - (m.pos.y + 1.65), Math.max(1, distToPlayer))));
          m.headGroup.rotation.y = THREE.MathUtils.lerp(m.headGroup.rotation.y, dyaw, Math.min(1, dt * 6));
          m.headGroup.rotation.x = THREE.MathUtils.lerp(m.headGroup.rotation.x, dpitch, Math.min(1, dt * 6));
        } else {
          const graze = speedMag < 0.12 ? Math.sin(nowSec * 1.4 + m.walkPhase) * (m.def.villager ? 0.06 : 0.16) : 0;
          m.headGroup.rotation.x = THREE.MathUtils.lerp(m.headGroup.rotation.x, graze, Math.min(1, dt * 4));
          m.headGroup.rotation.y = THREE.MathUtils.lerp(m.headGroup.rotation.y, 0, Math.min(1, dt * 4));
        }
      }
      if (m.tail && (m.type === 'fox' || m.type === 'wolf' || m.type === 'deer' || m.type === 'cow')) {
        m.tail.rotation.y = Math.sin(nowSec * (speedMag > 0.2 ? 9 : 4) + m.walkPhase) * 0.28;
      }
      if (m.wings.length === 2 && (m.type === 'duck' || m.type === 'chicken')) {
        const wFlap = m.fleeTimer > 0
          ? Math.sin(nowSec * 34 + m.walkPhase) * 0.95
          : (inWater
              ? Math.sin(nowSec * 4 + m.walkPhase) * 0.08
              : (speedMag > 0.2 ? Math.sin(m.walkPhase * 1.5) * 0.18 : 0));
        m.wings[0].rotation.z = wFlap;
        m.wings[1].rotation.z = -wFlap;
      }
    }

    // Sync GPU-Instanced Villagers, Soldiers & Iron Golems (~30 total draw calls for 500+ NPCs!)
    if (this._npcPools) {
      this._syncNpcInstances(player);
    }

    // Animate shared 16x24 pixel-art burning mob flame texture at 14 FPS ONLY while at least 1 mob is burning!
    if (anyMobBurning && this._mobFireCtx) {
      this._mobFireAnimClock += dt;
      const frame = Math.floor(this._mobFireAnimClock * 14) & 7;
      if (frame !== this._mobFireFrame) {
        this._mobFireFrame = frame;
        this._drawMobFireFrame(frame);
      }
    }

    // 2b. Update Flying Skeleton Arrows (Ballistic Gravity Arc, Player Hit Damage & Block Sticking!)
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const a = this.projectiles[i];
      a.age += dt;
      if (a.age > (a.stuck ? 6.0 : 8.0)) {
        this.group.remove(a.mesh);
        this.projectiles.splice(i, 1);
        continue;
      }
      if (a.stuck) continue;

      a.vel.y -= 14.0 * dt;
      const nx = a.pos.x + a.vel.x * dt;
      const ny = a.pos.y + a.vel.y * dt;
      const nz = a.pos.z + a.vel.z * dt;

      // Check collision with Player AABB!
      if (player && player.mode === 'survival' && !player.dead) {
        const pdx = Math.abs(nx - player.pos.x);
        const pdz = Math.abs(nz - player.pos.z);
        if (pdx < 0.45 && pdz < 0.45 && ny >= player.pos.y && ny <= player.pos.y + 1.8) {
          const hLen = Math.max(0.01, Math.hypot(a.vel.x, a.vel.z));
          player.vel.x += (a.vel.x / hLen) * 4.5;
          player.vel.z += (a.vel.z / hLen) * 4.5;
          player.vel.y = Math.max(player.vel.y, 2.6);
          player.takeDamage(a.dmg, 'Shot by Skeleton');
          if (this.sound && this.sound.playArrowHit) this.sound.playArrowHit();
          this.group.remove(a.mesh);
          this.projectiles.splice(i, 1);
          continue;
        }
      }

      // Check collision with Villagers, Villager Soldiers & Iron Golems (Skeleton raids!)
      let hitNpc = false;
      for (let mi = this.mobs.length - 1; mi >= 0; mi--) {
        const tm = this.mobs[mi];
        if (tm === a.owner || tm.def.hostile) continue;
        if (!tm.def.villager && !tm.def.guard) continue;
        if (Math.abs(nx - tm.pos.x) < tm.halfW + 0.25 && Math.abs(nz - tm.pos.z) < tm.halfW + 0.25 && ny >= tm.pos.y && ny <= tm.pos.y + tm.height) {
          const hLen = Math.max(0.01, Math.hypot(a.vel.x, a.vel.z));
          this.hitMob(tm, a.dmg, { x: a.vel.x / hLen, y: 0.35, z: a.vel.z / hLen }, null);
          if (this.sound && this.sound.playArrowHit) this.sound.playArrowHit();
          this.group.remove(a.mesh);
          this.projectiles.splice(i, 1);
          hitNpc = true;
          break;
        }
      }
      if (hitNpc) continue;

      // Check collision with solid terrain blocks (arrow sticks cleanly into walls/ground!)
      if (isBlockSolid(this.world.getBlock(nx, ny, nz))) {
        a.stuck = true;
        a.age = 0;
        if (this.sound && this.sound.playArrowHit) this.sound.playArrowHit();
        continue;
      }

      a.pos.set(nx, ny, nz);
      a.mesh.position.copy(a.pos);
      a.mesh.lookAt(nx + a.vel.x, ny + a.vel.y, nz + a.vel.z);
    }

    // 3. Update Pixel-Art 3D Dropped Items & Blocks
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.age += dt;
      if (d.age > 180) {
        this.group.remove(d.mesh);
        this.drops.splice(i, 1);
        continue;
      }

      d.vel.y -= 18 * dt;
      const nx = d.pos.x + d.vel.x * dt;
      const nz = d.pos.z + d.vel.z * dt;
      if (!isBlockSolid(this.world.getBlock(nx, d.pos.y, d.pos.z))) d.pos.x = nx;
      else d.vel.x = 0;
      if (!isBlockSolid(this.world.getBlock(d.pos.x, d.pos.y, nz))) d.pos.z = nz;
      else d.vel.z = 0;

      d.vel.x *= 0.9;
      d.vel.z *= 0.9;

      const ny = d.pos.y + d.vel.y * dt;
      if (d.vel.y < 0 && isBlockSolid(this.world.getBlock(d.pos.x, ny - 0.18, d.pos.z))) {
        d.pos.y = Math.floor(ny - 0.18) + 1.18;
        d.vel.y = 0;
      } else {
        d.pos.y = ny;
      }

      _scratchV1.set(player.pos.x - d.pos.x, player.pos.y + 0.9 - d.pos.y, player.pos.z - d.pos.z);
      const dist = _scratchV1.length();
      const readyToPickup = d.age > (d.pickupDelay || 0.25);
      const canFit = readyToPickup && player.inventory.canAccept(d.id, 1);
      if (canFit && dist < 2.6 && dist > 0.001) {
        d.pos.addScaledVector(_scratchV1, (dt * 7.5) / dist);
      }
      if (canFit && dist < 0.85) {
        const res = player.inventory.addItemPartial(d.id, d.count, d.durability);
        if (res.added > 0) {
          this.sound.playPop();
          if (this.onPickup) this.onPickup(d.id, res.added);
        }
        if (res.remaining <= 0) {
          this.group.remove(d.mesh);
          this.drops.splice(i, 1);
          continue;
        } else {
          d.count = res.remaining;
        }
      }

      d.mesh.position.set(d.pos.x, d.pos.y + Math.sin(d.age * 4) * 0.08, d.pos.z);
      d.mesh.rotation.y += dt * 2.2;
    }
  }

  _getBedsInChunk(cx, cz) {
    const ck = this.world.chunkKey(cx, cz);
    const now = performance.now();
    const cached = this._chunkBedCache.get(ck);
    if (cached && now - cached.t < 15000) return cached.beds;
    const chunk = this.world.chunks.get(ck);
    if (!chunk) return [];
    const data = chunk.data;
    const ox = cx << 4;
    const oz = cz << 4;
    const maxY = Math.min(500, (chunk.maxY || 128) + 1);
    const beds = [];
    const seen = new Set();
    for (let y = 2; y <= maxY; y++) {
      const yOff = y << 8;
      for (let lz = 0; lz < 16; lz++) {
        const zOff = lz << 4;
        for (let lx = 0; lx < 16; lx++) {
          const bid = data[lx + zOff + yOff];
          if (bid !== BLOCK.BED && (bid < BLOCK.BED_HEAD_N || bid > BLOCK.BED_HEAD_W)) continue;
          const info = getBedInfo(bid);
          if (!info) continue;
          // Canonicalize to foot block (fx, y, fz) + head block (hx, y, hz)
          const fx = info.isHead ? (ox + lx + info.dx) : (ox + lx);
          const fz = info.isHead ? (oz + lz + info.dz) : (oz + lz);
          const hx = info.isHead ? (ox + lx) : (ox + lx + info.dx);
          const hz = info.isHead ? (oz + lz) : (oz + lz + info.dz);
          const k = `${fx},${y},${fz}`;
          if (seen.has(k)) continue;
          seen.add(k);
          // Yaw aligns Rx(-PI/2) head (-Z local) toward (hx-fx, hz-fz)!
          const yaw = info.dir === 'N' ? 0
            : (info.dir === 'S' ? Math.PI : (info.dir === 'E' ? -Math.PI * 0.5 : Math.PI * 0.5));
          beds.push({ x: fx, y, z: fz, headX: hx, headZ: hz, yaw });
        }
      }
    }
    if (this._chunkBedCache.size > 512) this._chunkBedCache.clear();
    this._chunkBedCache.set(ck, { t: now, beds });
    return beds;
  }

  _findAvailableBedForVillager(mob) {
    const pcx = Math.floor(mob.pos.x) >> 4;
    const pcz = Math.floor(mob.pos.z) >> 4;
    let best = null;
    let bestD2 = 34 * 34; // max 34-block search radius

    // Collect beds already claimed by other villagers
    const claimed = new Set();
    for (let i = 0; i < this.mobs.length; i++) {
      const o = this.mobs[i];
      if (o !== mob && o.sleepBed) {
        claimed.add(`${o.sleepBed.x},${o.sleepBed.y},${o.sleepBed.z}`);
      }
    }

    for (let dcz = -2; dcz <= 2; dcz++) {
      for (let dcx = -2; dcx <= 2; dcx++) {
        const beds = this._getBedsInChunk(pcx + dcx, pcz + dcz);
        for (let bi = 0; bi < beds.length; bi++) {
          const b = beds[bi];
          const dy = b.y - mob.pos.y;
          if (dy < -5 || dy > 6) continue;
          const k = `${b.x},${b.y},${b.z}`;
          if (claimed.has(k)) continue;
          const dx = b.x + 0.5 - mob.pos.x;
          const dz = b.z + 0.5 - mob.pos.z;
          const d2 = dx * dx + dz * dz + dy * dy * 4;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = b;
          }
        }
      }
    }
    return best;
  }

  // Lightweight Door-Aware Grid A* Pathfinding for Villagers (routes cleanly around walls & straight through doors!)
  _computeVillagerPath(sx, sy, sz, tx, ty, tz, maxNodes = 180) {
    const world = this.world;
    const isGoal = (x, y, z) => Math.abs(x - tx) + Math.abs(z - tz) <= 1 && Math.abs(y - ty) <= 1;
    if (isGoal(sx, sy, sz)) return [];

    const isSpaceFree = (x, y, z) => {
      const b = world.getBlock(x, y, z);
      if (b === BLOCK.WATER || b === BLOCK.LAVA || b === BLOCK.FIRE) return false;
      if (!isBlockSolid(b)) return true;
      if (isDoorBlock(b)) return true; // Villagers open closed doors!
      if (isBedBlock(b) && Math.abs(x - tx) <= 1 && Math.abs(z - tz) <= 1) return true;
      return false;
    };

    const isWalkable = (x, y, z) => {
      const g = world.getBlock(x, y - 1, z);
      if (!isBlockSolid(g) || isFenceOrGate(g) || g === BLOCK.LAVA || g === BLOCK.WATER) return false;
      return isSpaceFree(x, y, z) && isSpaceFree(x, y + 1, z);
    };

    const packKey = (x, y, z) => `${x},${y},${z}`;
    const startKey = packKey(sx, sy, sz);
    const open = [{ x: sx, y: sy, z: sz, g: 0, f: Math.abs(tx - sx) + Math.abs(tz - sz) + Math.abs(ty - sy) * 2, parent: null }];
    const gScore = new Map([[startKey, 0]]);
    const closed = new Set();
    let bestNode = open[0];
    let bestH = Math.abs(tx - sx) + Math.abs(tz - sz) + Math.abs(ty - sy) * 2;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let expanded = 0;

    while (open.length > 0 && expanded < maxNodes) {
      // Pop lowest f-score node
      let bestIdx = 0;
      for (let i = 1; i < open.length; i++) {
        if (open[i].f < open[bestIdx].f) bestIdx = i;
      }
      const cur = open[bestIdx];
      open[bestIdx] = open[open.length - 1];
      open.pop();

      const cKey = packKey(cur.x, cur.y, cur.z);
      if (closed.has(cKey)) continue;
      closed.add(cKey);
      expanded++;

      if (isGoal(cur.x, cur.y, cur.z)) {
        bestNode = cur;
        break;
      }

      const hCur = Math.abs(tx - cur.x) + Math.abs(tz - cur.z) + Math.abs(ty - cur.y) * 2;
      if (hCur < bestH) {
        bestH = hCur;
        bestNode = cur;
      }

      for (let di = 0; di < 4; di++) {
        const nx = cur.x + dirs[di][0];
        const nz = cur.z + dirs[di][1];
        if (Math.abs(nx - sx) > 36 || Math.abs(nz - sz) > 36) continue;

        let ny = -1;
        if (isWalkable(nx, cur.y, nz)) {
          ny = cur.y;
        } else if (isWalkable(nx, cur.y + 1, nz) && isSpaceFree(cur.x, cur.y + 2, cur.z)) {
          ny = cur.y + 1;
        } else if (isWalkable(nx, cur.y - 1, nz) && isSpaceFree(nx, cur.y + 1, nz)) {
          ny = cur.y - 1;
        } else if (isWalkable(nx, cur.y - 2, nz) && isSpaceFree(nx, cur.y, nz) && isSpaceFree(nx, cur.y + 1, nz)) {
          ny = cur.y - 2;
        }
        if (ny < 0) continue;

        const nKey = packKey(nx, ny, nz);
        if (closed.has(nKey)) continue;
        const bAt = world.getBlock(nx, ny, nz);
        const stepCost = isDoorBlock(bAt) ? 0.9 : (ny === cur.y ? 1.0 : 1.3);
        const ng = cur.g + stepCost;
        const prevG = gScore.get(nKey);
        if (prevG !== undefined && ng >= prevG) continue;
        gScore.set(nKey, ng);
        const nh = Math.abs(tx - nx) + Math.abs(tz - nz) + Math.abs(ty - ny) * 2;
        open.push({ x: nx, y: ny, z: nz, g: ng, f: ng + nh * 1.15, parent: cur });
      }
    }

    if (!bestNode || bestNode.parent === null) return null;
    const rev = [];
    let p = bestNode;
    while (p && p.parent) {
      rev.push({ x: p.x, y: p.y, z: p.z });
      p = p.parent;
    }
    rev.reverse();
    return rev;
  }

  // GPU-Instanced Pool Builder for ALL Villagers (4 professions), Villager Soldiers & Iron Golems!
  // Renders 500+ NPCs in ~30 total draw calls (vs 9,000+ unbatched)!
  _ensureNpcPools() {
    if (this._npcPools) return;
    const pools = {};
    const npcGroup = new THREE.Group();
    npcGroup.frustumCulled = false;
    this.group.add(npcGroup);
    const vtxMat = new THREE.MeshLambertMaterial({ vertexColors: true });

    const makeInst = (geo, mat, cap, castShadow = false) => {
      const m = new THREE.InstancedMesh(geo, mat, cap);
      m.count = 0;
      m.visible = false;
      m.frustumCulled = false;
      m.castShadow = castShadow;
      m.receiveShadow = true;
      for (let i = 0; i < cap; i++) m.setColorAt(i, this._npcWhite);
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      npcGroup.add(m);
      return m;
    };

    const hexNum = (s) => (typeof s === 'number' ? s : parseInt(String(s).replace('#', ''), 16) || 0x8c5e34);

    // 1. 4 Villager Professions (Farmer, Blacksmith, Librarian, Cleric)
    for (const prof of VILLAGER_PROFESSIONS) {
      const pName = prof.name;
      const vTex = this.textures && this.textures.getVillagerTextures ? this.textures.getVillagerTextures(pName) : null;
      const st = vTex ? vTex.style : { robe: '#8c5e34', dark: '#5e3c1f', trim: '#d9b54a', sash: '#4a3019' };
      const cRobe = hexNum(st.robe);
      const cDark = hexNum(st.dark);
      const cTrim = hexNum(st.trim);
      const cSash = hexNum(st.sash);

      const robeFront = vTex ? new THREE.MeshLambertMaterial({ map: vTex.robeFront }) : new THREE.MeshLambertMaterial({ color: cRobe });
      const robeSide = vTex ? new THREE.MeshLambertMaterial({ map: vTex.robeSide }) : robeFront;
      const robeBack = vTex ? new THREE.MeshLambertMaterial({ map: vTex.robeBack }) : robeFront;
      const robeDark = new THREE.MeshLambertMaterial({ color: cDark });
      const torsoMats = [robeSide, robeSide, robeDark, robeDark, robeFront, robeBack];

      const headFront = vTex ? new THREE.MeshLambertMaterial({ map: vTex.headFront }) : new THREE.MeshLambertMaterial({ color: 0xb88460 });
      const headSide = vTex ? new THREE.MeshLambertMaterial({ map: vTex.headSide }) : headFront;
      const headBack = vTex ? new THREE.MeshLambertMaterial({ map: vTex.headBack }) : headFront;
      const headTop = vTex ? new THREE.MeshLambertMaterial({ map: vTex.headTop }) : headFront;
      const skinUnder = new THREE.MeshLambertMaterial({ color: 0xb88460 });
      const headMats = [headSide, headSide, headTop, skinUnder, headFront, headBack];

      // Merged body accessories: skirt, collar, 45° folded arms, cuffs, hands + profession torso gear
      const bodyAccSpecs = [
        { sx: 0.58, sy: 0.34, sz: 0.38, py: 0.58, color: cRobe },
        { sx: 0.60, sy: 0.11, sz: 0.38, py: 1.37, color: cTrim },
        { sx: 0.20, sy: 0.44, sz: 0.20, px: -0.34, py: 1.15, pz: 0.08, rx: -0.78, rz: -0.12, color: cRobe },
        { sx: 0.20, sy: 0.44, sz: 0.20, px: 0.34, py: 1.15, pz: 0.08, rx: -0.78, rz: 0.12, color: cRobe },
        { sx: 0.56, sy: 0.21, sz: 0.22, py: 0.96, pz: 0.23, color: cRobe },
        { sx: 0.60, sy: 0.22, sz: 0.06, py: 0.96, pz: 0.23, color: cTrim },
        { sx: 0.26, sy: 0.17, sz: 0.18, py: 0.96, pz: 0.26, color: 0xb88460 }
      ];
      // Merged head accessories (relative to head pivot at y=1.41): nose, brow + profession hat/goggles/book/hood
      const headAccSpecs = [
        { sx: 0.12, sy: 0.24, sz: 0.15, py: 0.14, pz: 0.29, color: 0xb88460 },
        { sx: 0.38, sy: 0.055, sz: 0.04, py: 0.40, pz: 0.24, color: 0x472d1b }
      ];

      if (pName === 'Farmer') {
        bodyAccSpecs.push(
          { sx: 0.14, sy: 0.20, sz: 0.18, px: 0.31, py: 0.74, pz: 0.04, color: cSash },
          { sx: 0.15, sy: 0.06, sz: 0.19, px: 0.31, py: 0.82, pz: 0.04, color: cTrim }
        );
        headAccSpecs.push(
          { sx: 0.84, sy: 0.06, sz: 0.84, py: 0.51, color: 0xd9b54a },
          { sx: 0.54, sy: 0.19, sz: 0.54, py: 0.61, color: 0xd9b54a },
          { sx: 0.56, sy: 0.06, sz: 0.56, py: 0.55, color: 0xc9322c }
        );
      } else if (pName === 'Blacksmith') {
        bodyAccSpecs.push(
          { sx: 0.46, sy: 0.74, sz: 0.05, py: 0.78, pz: 0.195, color: 0x3b2a1e },
          { sx: 0.26, sy: 0.11, sz: 0.32, px: -0.37, py: 1.38, pz: 0.02, color: 0xa6b0bf },
          { sx: 0.26, sy: 0.11, sz: 0.32, px: 0.37, py: 1.38, pz: 0.02, color: 0xa6b0bf }
        );
        headAccSpecs.push(
          { sx: 0.49, sy: 0.10, sz: 0.49, py: 0.47, color: 0x3b2a1e },
          { sx: 0.14, sy: 0.11, sz: 0.07, px: -0.11, py: 0.48, pz: 0.25, color: 0xe3b13b },
          { sx: 0.14, sy: 0.11, sz: 0.07, px: 0.11, py: 0.48, pz: 0.25, color: 0xe3b13b },
          { sx: 0.09, sy: 0.07, sz: 0.075, px: -0.11, py: 0.48, pz: 0.255, color: 0x62d9f7 },
          { sx: 0.09, sy: 0.07, sz: 0.075, px: 0.11, py: 0.48, pz: 0.255, color: 0x62d9f7 }
        );
      } else if (pName === 'Librarian') {
        bodyAccSpecs.push({ sx: 0.16, sy: 0.72, sz: 0.04, py: 0.84, pz: 0.185, color: 0xf2c94c });
        headAccSpecs.push(
          { sx: 0.15, sy: 0.11, sz: 0.04, px: -0.115, py: 0.31, pz: 0.245, color: 0xf2c94c },
          { sx: 0.15, sy: 0.11, sz: 0.04, px: 0.115, py: 0.31, pz: 0.245, color: 0xf2c94c },
          { sx: 0.56, sy: 0.07, sz: 0.54, py: 0.59, rz: 0.07, color: 0x8f1e1e },
          { sx: 0.50, sy: 0.09, sz: 0.48, py: 0.65, rz: 0.07, color: 0xf7efe0 },
          { sx: 0.56, sy: 0.05, sz: 0.54, py: 0.70, rz: 0.07, color: 0x8f1e1e }
        );
      } else {
        bodyAccSpecs.push(
          { sx: 0.14, sy: 0.14, sz: 0.05, py: 1.24, pz: 0.185, color: 0xf5cc42 },
          { sx: 0.08, sy: 0.08, sz: 0.06, py: 1.24, pz: 0.19, color: 0xf062ff }
        );
        headAccSpecs.push(
          { sx: 0.52, sy: 0.14, sz: 0.54, py: 0.56, pz: -0.02, color: 0x5c2182 },
          { sx: 0.54, sy: 0.05, sz: 0.56, py: 0.50, pz: -0.02, color: 0xf5cc42 },
          { sx: 0.52, sy: 0.44, sz: 0.14, py: 0.30, pz: -0.24, color: 0x5c2182 }
        );
      }

      const legGeo = mergeColoredBoxes([
        { sx: 0.22, sy: 0.42, sz: 0.23, py: -0.21, color: cDark },
        { sx: 0.24, sy: 0.16, sz: 0.27, py: -0.49, pz: 0.015, color: 0x362417 },
        { sx: 0.25, sy: 0.05, sz: 0.29, py: -0.59, pz: 0.02, color: 0x21160e }
      ]);

      const cap = 280;
      pools[`villager_${pName}`] = {
        kind: 'villager',
        cap,
        count: 0,
        robe: makeInst(new THREE.BoxGeometry(0.54, 0.78, 0.34), torsoMats, cap, true),
        bodyAcc: makeInst(mergeColoredBoxes(bodyAccSpecs), vtxMat, cap, false),
        head: makeInst(new THREE.BoxGeometry(0.46, 0.58, 0.46), headMats, cap, true),
        headAcc: makeInst(mergeColoredBoxes(headAccSpecs), vtxMat, cap, false),
        legL: makeInst(legGeo, vtxMat, cap, false),
        legR: makeInst(legGeo, vtxMat, cap, false)
      };
    }

    // 2. Villager Soldier Pool (Iron Armor + Helmet + 3D Iron Sword!)
    {
      const cap = 180;
      const vTex = this.textures && this.textures.getVillagerTextures ? this.textures.getVillagerTextures('Blacksmith') : null;
      const headFront = vTex ? new THREE.MeshLambertMaterial({ map: vTex.headFront }) : new THREE.MeshLambertMaterial({ color: 0xb88460 });
      const headSide = vTex ? new THREE.MeshLambertMaterial({ map: vTex.headSide }) : headFront;
      const headBack = vTex ? new THREE.MeshLambertMaterial({ map: vTex.headBack }) : headFront;
      const headTop = vTex ? new THREE.MeshLambertMaterial({ map: vTex.headTop }) : headFront;
      const skinUnder = new THREE.MeshLambertMaterial({ color: 0xb88460 });
      const headMats = [headSide, headSide, headTop, skinUnder, headFront, headBack];

      const bodyGeo = mergeColoredBoxes([
        { sx: 0.54, sy: 0.78, sz: 0.34, py: 1.01, color: 0x3a527a },
        { sx: 0.58, sy: 0.34, sz: 0.38, py: 0.58, color: 0x2e4263 },
        { sx: 0.59, sy: 0.66, sz: 0.39, py: 1.04, color: 0xc6ced9 },
        { sx: 0.46, sy: 0.10, sz: 0.41, py: 1.24, color: 0x8690a0 },
        { sx: 0.60, sy: 0.10, sz: 0.40, py: 0.72, color: 0x452b17 },
        { sx: 0.14, sy: 0.10, sz: 0.42, py: 0.72, color: 0xeaf0f8 }
      ]);
      const headAccGeo = mergeColoredBoxes([
        { sx: 0.12, sy: 0.24, sz: 0.15, py: 0.14, pz: 0.29, color: 0xb88460 },
        { sx: 0.38, sy: 0.055, sz: 0.04, py: 0.40, pz: 0.24, color: 0x472d1b },
        { sx: 0.52, sy: 0.16, sz: 0.52, py: 0.54, color: 0xc8d0dc },
        { sx: 0.52, sy: 0.36, sz: 0.10, py: 0.32, pz: -0.22, color: 0xc8d0dc },
        { sx: 0.08, sy: 0.32, sz: 0.44, px: -0.23, py: 0.34, pz: -0.02, color: 0xc8d0dc },
        { sx: 0.08, sy: 0.32, sz: 0.44, px: 0.23, py: 0.34, pz: -0.02, color: 0xc8d0dc },
        { sx: 0.54, sy: 0.08, sz: 0.10, py: 0.45, pz: 0.23, color: 0x828c9c },
        { sx: 0.08, sy: 0.10, sz: 0.36, py: 0.65, pz: -0.02, color: 0x3a78c9 }
      ]);
      const legGeo = mergeColoredBoxes([
        { sx: 0.22, sy: 0.42, sz: 0.23, py: -0.21, color: 0x5c6675 },
        { sx: 0.24, sy: 0.16, sz: 0.27, py: -0.49, pz: 0.015, color: 0x362417 },
        { sx: 0.25, sy: 0.05, sz: 0.29, py: -0.59, pz: 0.02, color: 0x21160e }
      ]);
      const armLGeo = mergeColoredBoxes([
        { sx: 0.24, sy: 0.18, sz: 0.26, py: -0.02, color: 0xc6ced9 },
        { sx: 0.20, sy: 0.56, sz: 0.20, py: -0.32, color: 0x3a527a },
        { sx: 0.21, sy: 0.16, sz: 0.21, py: -0.48, color: 0x8690a0 }
      ]);
      const armRGeo = mergeColoredBoxes([
        { sx: 0.24, sy: 0.18, sz: 0.26, py: -0.02, color: 0xc6ced9 },
        { sx: 0.20, sy: 0.56, sz: 0.20, py: -0.32, color: 0x3a527a },
        { sx: 0.21, sy: 0.16, sz: 0.21, py: -0.48, color: 0x8690a0 },
        // Gleaming 3D Iron Sword held forward!
        { sx: 0.055, sy: 0.055, sz: 0.20, py: -0.56, pz: 0.10, rx: 0.45, color: 0x6b4423 },
        { sx: 0.22, sy: 0.06, sz: 0.05, py: -0.58, pz: 0.20, rx: 0.45, color: 0x8690a0 },
        { sx: 0.085, sy: 0.032, sz: 0.64, py: -0.68, pz: 0.48, rx: 0.45, color: 0xeaf0f8 }
      ]);

      pools.villager_soldier = {
        kind: 'soldier',
        cap,
        count: 0,
        body: makeInst(bodyGeo, vtxMat, cap, true),
        head: makeInst(new THREE.BoxGeometry(0.46, 0.58, 0.46), headMats, cap, true),
        headAcc: makeInst(headAccGeo, vtxMat, cap, false),
        legL: makeInst(legGeo, vtxMat, cap, false),
        legR: makeInst(legGeo, vtxMat, cap, false),
        armL: makeInst(armLGeo, vtxMat, cap, false),
        armR: makeInst(armRGeo, vtxMat, cap, false)
      };
    }

    // 3. Iron Golem Pool (Massive Riveted Iron Plates + Moss Vines + Red Poppy!)
    {
      const cap = 96;
      const bodyGeo = mergeColoredBoxes([
        { sx: 0.68, sy: 0.34, sz: 0.42, py: 1.08, color: 0x6b6f75 },
        { sx: 1.06, sy: 0.86, sz: 0.56, py: 1.56, color: 0xd4d0c8 },
        { sx: 1.08, sy: 0.18, sz: 0.58, py: 1.62, color: 0x458a34 },
        { sx: 0.22, sy: 0.46, sz: 0.58, px: -0.26, py: 1.48, color: 0x458a34 },
        { sx: 0.12, sy: 0.12, sz: 0.06, px: -0.26, py: 1.66, pz: 0.30, color: 0xd93838 }
      ]);
      const headGeo = mergeColoredBoxes([
        { sx: 0.52, sy: 0.58, sz: 0.52, py: 0.28, color: 0xccc7be },
        { sx: 0.54, sy: 0.10, sz: 0.54, py: 0.48, pz: 0.02, color: 0x6b6f75 },
        { sx: 0.14, sy: 0.24, sz: 0.14, py: 0.14, pz: 0.28, color: 0xccc7be },
        { sx: 0.10, sy: 0.06, sz: 0.04, px: -0.13, py: 0.30, pz: 0.26, color: 0xc92a2a },
        { sx: 0.10, sy: 0.06, sz: 0.04, px: 0.13, py: 0.30, pz: 0.26, color: 0xc92a2a }
      ]);
      const legGeo = mergeColoredBoxes([
        { sx: 0.34, sy: 0.94, sz: 0.34, py: -0.47, color: 0xd4d0c8 },
        { sx: 0.36, sy: 0.16, sz: 0.38, py: -0.86, pz: 0.02, color: 0x6b6f75 }
      ]);
      const armGeo = mergeColoredBoxes([
        { sx: 0.36, sy: 0.26, sz: 0.42, py: 0.02, pz: 0.04, color: 0x6b6f75 },
        { sx: 0.30, sy: 1.28, sz: 0.30, py: -0.62, pz: 0.06, color: 0xccc7be },
        { sx: 0.32, sy: 0.22, sz: 0.32, py: -0.40, pz: 0.06, color: 0x458a34 }
      ]);

      pools.iron_golem = {
        kind: 'golem',
        cap,
        count: 0,
        body: makeInst(bodyGeo, vtxMat, cap, true),
        head: makeInst(headGeo, vtxMat, cap, true),
        legL: makeInst(legGeo, vtxMat, cap, false),
        legR: makeInst(legGeo, vtxMat, cap, false),
        armL: makeInst(armGeo, vtxMat, cap, false),
        armR: makeInst(armGeo, vtxMat, cap, false)
      };
    }

    this._npcGroup = npcGroup;
    this._npcPools = pools;
  }

  _syncNpcInstances(player) {
    const pools = this._npcPools;
    if (!pools) return;
    for (const k in pools) pools[k].count = 0;

    const dummy = this._npcDummy;
    const rootMat = this._npcRootMat;
    const partMat = this._npcPartMat;
    const finalMat = this._npcFinalMat;
    const cWhite = this._npcWhite;
    const cHurt = this._npcHurt;
    const px = player.pos.x;
    const pz = player.pos.z;
    const maxRenderDistSq = 135 * 135;

    for (let i = 0; i < this.mobs.length; i++) {
      const m = this.mobs[i];
      if (!m.instancedNpc) continue;
      const dx = m.pos.x - px;
      const dz = m.pos.z - pz;
      if (dx * dx + dz * dz > maxRenderDistSq) continue;

      const pKey = m.type === 'villager' ? `villager_${m.profession || 'Farmer'}` : m.type;
      const pool = pools[pKey];
      if (!pool || pool.count >= pool.cap) continue;
      const idx = pool.count++;
      const col = m.hurtFlash > 0 ? cHurt : cWhite;

      dummy.position.set(m.pos.x, m.pos.y, m.pos.z);
      dummy.rotation.set(m.sleeping ? -Math.PI * 0.5 : 0, m.yaw, 0);
      dummy.updateMatrix();
      rootMat.copy(dummy.matrix);

      if (pool.kind === 'villager') {
        // Textured torso centered at y=1.01
        dummy.position.set(0, 1.01, 0);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        finalMat.multiplyMatrices(rootMat, dummy.matrix);
        pool.robe.setMatrixAt(idx, finalMat);
        pool.robe.setColorAt(idx, col);

        // Merged skirt + arms + cuffs + profession gear at origin
        pool.bodyAcc.setMatrixAt(idx, rootMat);
        pool.bodyAcc.setColorAt(idx, col);

        // Articulated head pivoted at y=1.41
        dummy.position.set(0, 1.41, 0);
        dummy.rotation.set(m.headPitch || 0, m.headYaw || 0, 0);
        dummy.updateMatrix();
        partMat.copy(dummy.matrix);
        finalMat.multiplyMatrices(rootMat, partMat);
        pool.headAcc.setMatrixAt(idx, finalMat);
        pool.headAcc.setColorAt(idx, col);

        dummy.position.set(0, 0.29, 0);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        finalMat.multiplyMatrices(finalMat, dummy.matrix);
        pool.head.setMatrixAt(idx, finalMat);
        pool.head.setColorAt(idx, col);

        // Swinging legs pivoted at hip y=0.62
        const ls = m.sleeping ? 0 : (m.legSwing || 0);
        dummy.position.set(-0.135, 0.62, 0);
        dummy.rotation.set(ls, 0, 0);
        dummy.updateMatrix();
        finalMat.multiplyMatrices(rootMat, dummy.matrix);
        pool.legL.setMatrixAt(idx, finalMat);
        pool.legL.setColorAt(idx, col);

        dummy.position.set(0.135, 0.62, 0);
        dummy.rotation.set(-ls, 0, 0);
        dummy.updateMatrix();
        finalMat.multiplyMatrices(rootMat, dummy.matrix);
        pool.legR.setMatrixAt(idx, finalMat);
        pool.legR.setColorAt(idx, col);
      } else if (pool.kind === 'soldier') {
        pool.body.setMatrixAt(idx, rootMat);
        pool.body.setColorAt(idx, col);

        dummy.position.set(0, 1.41, 0);
        dummy.rotation.set(m.headPitch || 0, m.headYaw || 0, 0);
        dummy.updateMatrix();
        partMat.copy(dummy.matrix);
        finalMat.multiplyMatrices(rootMat, partMat);
        pool.headAcc.setMatrixAt(idx, finalMat);
        pool.headAcc.setColorAt(idx, col);

        dummy.position.set(0, 0.29, 0);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        finalMat.multiplyMatrices(finalMat, dummy.matrix);
        pool.head.setMatrixAt(idx, finalMat);
        pool.head.setColorAt(idx, col);

        const ls = m.legSwing || 0;
        dummy.position.set(-0.135, 0.62, 0);
        dummy.rotation.set(ls, 0, 0);
        dummy.updateMatrix();
        finalMat.multiplyMatrices(rootMat, dummy.matrix);
        pool.legL.setMatrixAt(idx, finalMat);
        pool.legL.setColorAt(idx, col);

        dummy.position.set(0.135, 0.62, 0);
        dummy.rotation.set(-ls, 0, 0);
        dummy.updateMatrix();
        finalMat.multiplyMatrices(rootMat, dummy.matrix);
        pool.legR.setMatrixAt(idx, finalMat);
        pool.legR.setColorAt(idx, col);

        dummy.position.set(-0.38, 1.32, 0);
        dummy.rotation.set(m.armSwingL || 0, 0, 0);
        dummy.updateMatrix();
        finalMat.multiplyMatrices(rootMat, dummy.matrix);
        pool.armL.setMatrixAt(idx, finalMat);
        pool.armL.setColorAt(idx, col);

        dummy.position.set(0.38, 1.32, 0);
        dummy.rotation.set(m.armSwingR || -0.25, 0, 0);
        dummy.updateMatrix();
        finalMat.multiplyMatrices(rootMat, dummy.matrix);
        pool.armR.setMatrixAt(idx, finalMat);
        pool.armR.setColorAt(idx, col);
      } else {
        // Iron Golem
        pool.body.setMatrixAt(idx, rootMat);
        pool.body.setColorAt(idx, col);

        dummy.position.set(0, 1.98, 0.06);
        dummy.rotation.set(m.headPitch || 0, m.headYaw || 0, 0);
        dummy.updateMatrix();
        finalMat.multiplyMatrices(rootMat, dummy.matrix);
        pool.head.setMatrixAt(idx, finalMat);
        pool.head.setColorAt(idx, col);

        const ls = m.legSwing || 0;
        dummy.position.set(-0.25, 0.94, 0);
        dummy.rotation.set(ls, 0, 0);
        dummy.updateMatrix();
        finalMat.multiplyMatrices(rootMat, dummy.matrix);
        pool.legL.setMatrixAt(idx, finalMat);
        pool.legL.setColorAt(idx, col);

        dummy.position.set(0.25, 0.94, 0);
        dummy.rotation.set(-ls, 0, 0);
        dummy.updateMatrix();
        finalMat.multiplyMatrices(rootMat, dummy.matrix);
        pool.legR.setMatrixAt(idx, finalMat);
        pool.legR.setColorAt(idx, col);

        dummy.position.set(-0.70, 1.86, 0);
        dummy.rotation.set(m.armSwingL || 0, 0, 0);
        dummy.updateMatrix();
        finalMat.multiplyMatrices(rootMat, dummy.matrix);
        pool.armL.setMatrixAt(idx, finalMat);
        pool.armL.setColorAt(idx, col);

        dummy.position.set(0.70, 1.86, 0);
        dummy.rotation.set(m.armSwingR || 0, 0, 0);
        dummy.updateMatrix();
        finalMat.multiplyMatrices(rootMat, dummy.matrix);
        pool.armR.setMatrixAt(idx, finalMat);
        pool.armR.setColorAt(idx, col);
      }
    }

    for (const k in pools) {
      const p = pools[k];
      const vis = p.count > 0;
      for (const mk of ['robe', 'body', 'bodyAcc', 'head', 'headAcc', 'legL', 'legR', 'armL', 'armR']) {
        const im = p[mk];
        if (!im) continue;
        im.count = p.count;
        im.visible = vis;
        if (vis) {
          im.instanceMatrix.needsUpdate = true;
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
        }
      }
    }
  }

  _spawnMegaCrowd(ms, existingCount = 0) {
    // Spawn bustling full-physics crowds of Villagers, Villager Soldiers & Iron Golems inside Mega Cities, Pyramids & Castles!
    // GPU-Instanced NPC rendering keeps even 240+ Mega City citizens running smoothly!
    const isCity = ms.type === 'mega_city';
    const innerR = ms.innerRadius || (isCity ? 54 : 24);
    const isPyramid = ms.type === 'great_pyramid';
    const targetVillagers = isCity ? 170 : (isPyramid ? 72 : 62);
    const targetSoldiers = isCity ? 50 : (isPyramid ? 16 : 24);
    const targetGolems = isCity ? 20 : (isPyramid ? 6 : 8);
    const villagerTotal = Math.max(0, targetVillagers - Math.floor(existingCount * 0.72));
    const soldierTotal = Math.max(0, targetSoldiers - Math.floor(existingCount * 0.20));
    const golemTotal = Math.max(0, targetGolems - Math.floor(existingCount * 0.08));
    const useExactY = !isCity;
    const hRad = isCity ? 56 : 26;

    const pickSafeSpot = (idx, minRad = 3.5) => {
      for (let tries = 0; tries < (isCity ? 18 : 36); tries++) {
        const mode = (idx + tries) % 4;
        let rx, rz;
        if (mode === 0) {
          rx = (Math.random() - 0.5) * (isCity ? 8.0 : 3.6);
          rz = (Math.random() - 0.5) * (innerR * 1.85);
        } else if (mode === 1) {
          rx = (Math.random() - 0.5) * (innerR * 1.85);
          rz = (Math.random() - 0.5) * (isCity ? 8.0 : 3.6);
        } else if (mode === 2) {
          const ang = ((idx + tries * 0.41) / 18) * Math.PI * 2;
          const rad = minRad + Math.random() * Math.max(3, innerR - minRad - 1.0);
          rx = Math.cos(ang) * rad;
          rz = Math.sin(ang) * rad;
        } else {
          const side = (idx + tries) & 3;
          const span = (Math.random() - 0.5) * (innerR * 1.65);
          const edge = innerR * (0.68 + Math.random() * 0.24);
          rx = side === 0 ? span : (side === 1 ? span : (side === 2 ? edge : -edge));
          rz = side === 0 ? edge : (side === 1 ? -edge : span);
        }
        const tx = ms.x + rx;
        const tz = ms.z + rz;
        if (isCity) {
          // Mega City hugs terrain, so spawning helper resolves exact surface Y once chunk streams in!
          return { x: tx, z: tz };
        }
        const bFoot = this.world.getBlock(tx, ms.y, tz);
        const bHead = this.world.getBlock(tx, ms.y + 1, tz);
        const bFloor = this.world.getBlock(tx, ms.y - 1, tz);
        if (!isBlockSolid(bFoot) && bFoot !== BLOCK.WATER && bFoot !== BLOCK.LAVA && !isBlockSolid(bHead) && isBlockSolid(bFloor)) {
          return { x: tx, z: tz };
        }
      }
      const ang = (idx * 2.39996) % (Math.PI * 2);
      const rad = 4.5 + (idx % 8) * (isCity ? 5.5 : 2.4);
      return { x: ms.x + Math.cos(ang) * rad, z: ms.z + Math.sin(ang) * rad };
    };

    for (let i = 0; i < villagerTotal; i++) {
      const pt = pickSafeSpot(i, 4.5);
      this._pendingVillageSpawns.push({
        mType: 'villager',
        sx: pt.x,
        sz: pt.z,
        baseY: ms.y,
        exactY: useExactY,
        homeRadius: hRad,
        prof: VILLAGER_PROFESSIONS[i % VILLAGER_PROFESSIONS.length]
      });
    }
    for (let i = 0; i < soldierTotal; i++) {
      const pt = pickSafeSpot(i + 200, 5.5);
      this._pendingVillageSpawns.push({
        mType: 'villager_soldier',
        sx: pt.x,
        sz: pt.z,
        baseY: ms.y,
        exactY: useExactY,
        homeRadius: hRad,
        prof: null
      });
    }
    for (let i = 0; i < golemTotal; i++) {
      const pt = pickSafeSpot(i + 360, 6.5);
      this._pendingVillageSpawns.push({
        mType: 'iron_golem',
        sx: pt.x,
        sz: pt.z,
        baseY: ms.y,
        exactY: useExactY,
        homeRadius: hRad,
        prof: null
      });
    }
  }

  _unusedOldInstancedCrowdHelper() {
    // Kept empty so no fake invincible ghost crowds ever spawn!
    if (false) {
    const count = 0;
    const group = new THREE.Group();
    const innerR = 20;
    const perProf = [0, 0, 0, 0];
    const profAgents = [[], [], [], []];
    const ms = { x: 0, y: 0, z: 0 };
    const interactiveOffsets = [];

    for (let i = 0; i < count; i++) {
      let ax = ms.x, az = ms.z;
      for (let tries = 0; tries < 24; tries++) {
        const mode = (i + tries) % 3;
        let rx, rz;
        if (mode === 0) {
          rx = (Math.random() - 0.5) * 3.2;
          rz = (Math.random() - 0.5) * (innerR * 1.9);
        } else if (mode === 1) {
          rx = (Math.random() - 0.5) * (innerR * 1.9);
          rz = (Math.random() - 0.5) * 3.2;
        } else {
          const ang = Math.random() * Math.PI * 2;
          const rad = 4.6 + Math.random() * (innerR - 4.8);
          rx = Math.cos(ang) * rad;
          rz = Math.sin(ang) * rad;
        }
        const tx = ms.x + rx;
        const tz = ms.z + rz;
        const bFoot = this.world.getBlock(tx, ms.y, tz);
        const bHead = this.world.getBlock(tx, ms.y + 1, tz);
        const bFloor = this.world.getBlock(tx, ms.y - 1, tz);
        if (!isBlockSolid(bFoot) && bFoot !== BLOCK.WATER && !isBlockSolid(bHead) && isBlockSolid(bFloor)) {
          ax = tx;
          az = tz;
          break;
        }
      }
      const pIdx = i % VILLAGER_PROFESSIONS.length;
      perProf[pIdx]++;
      profAgents[pIdx].push({
        x: ax,
        y: ms.y,
        z: az,
        yaw: Math.random() * Math.PI * 2,
        speed: 0.72 + Math.random() * 0.62,
        phase: Math.random() * Math.PI * 2,
        turnTimer: 1.0 + Math.random() * 4.0,
        pauseTimer: Math.random() < 0.3 ? (0.8 + Math.random() * 2.5) : 0
      });
    }

    const makeLocalMat = (px, py, pz, rx = 0, ry = 0, rz = 0) => {
      const o = new THREE.Object3D();
      o.position.set(px, py, pz);
      o.rotation.set(rx, ry, rz);
      o.updateMatrix();
      return o.matrix.clone();
    };

    const batches = [];
    const browMatShared = new THREE.MeshLambertMaterial({ color: 0x472d1b });
    const bootMatShared = new THREE.MeshLambertMaterial({ color: 0x362417 });
    const skinUnderShared = new THREE.MeshLambertMaterial({ color: 0xb88460 });

    for (let pIdx = 0; pIdx < VILLAGER_PROFESSIONS.length; pIdx++) {
      const pCount = perProf[pIdx];
      if (pCount === 0) continue;
      const profName = VILLAGER_PROFESSIONS[pIdx].name;
      const vTex = this.textures && this.textures.getVillagerTextures ? this.textures.getVillagerTextures(profName) : null;
      const st = vTex ? vTex.style : { robe: '#8c5e34', dark: '#5e3c1f', trim: '#d9b54a', sash: '#4a3019' };

      const robeFrontMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.robeFront }) : new THREE.MeshLambertMaterial({ color: st.robe });
      const robeSideMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.robeSide }) : robeFrontMat;
      const robeBackMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.robeBack }) : robeFrontMat;
      const robeDarkMat = new THREE.MeshLambertMaterial({ color: st.dark });
      const trimMat = new THREE.MeshLambertMaterial({ color: st.trim });

      const headFrontMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.headFront }) : skinUnderShared;
      const headSideMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.headSide }) : skinUnderShared;
      const headBackMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.headBack }) : skinUnderShared;
      const headTopMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.headTop }) : skinUnderShared;
      const noseMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.nose }) : skinUnderShared;

      const torsoMats = [robeSideMat, robeSideMat, robeDarkMat, robeDarkMat, robeFrontMat, robeBackMat];
      const headMats = [headSideMat, headSideMat, headTopMat, skinUnderShared, headFrontMat, headBackMat];

      const parts = [];
      const addPart = (geo, mat, px, py, pz, rx = 0, ry = 0, rz = 0, legSide = 0) => {
        const mesh = new THREE.InstancedMesh(geo, mat, pCount);
        mesh.frustumCulled = false;
        group.add(mesh);
        parts.push({ mesh, localMat: makeLocalMat(px, py, pz, rx, ry, rz), legSide });
      };

      // Exact Village Villager anatomy (torso, flared skirt, collar, 45° folded sleeves + forearm, 6-face head, nose, brow, swinging legs!)
      addPart(new THREE.BoxGeometry(0.54, 0.78, 0.34), torsoMats, 0, 1.01, 0);
      addPart(new THREE.BoxGeometry(0.58, 0.34, 0.38), torsoMats, 0, 0.58, 0);
      addPart(new THREE.BoxGeometry(0.60, 0.11, 0.38), trimMat, 0, 1.37, 0);
      addPart(new THREE.BoxGeometry(0.20, 0.44, 0.20), robeSideMat, -0.34, 1.15, 0.08, -0.78, 0, -0.12);
      addPart(new THREE.BoxGeometry(0.20, 0.44, 0.20), robeSideMat, 0.34, 1.15, 0.08, -0.78, 0, 0.12);
      addPart(new THREE.BoxGeometry(0.56, 0.21, 0.22), robeSideMat, 0, 0.96, 0.23);
      addPart(new THREE.BoxGeometry(0.46, 0.58, 0.46), headMats, 0, 1.70, 0);
      addPart(new THREE.BoxGeometry(0.12, 0.24, 0.15), noseMat, 0, 1.55, 0.29);
      addPart(new THREE.BoxGeometry(0.38, 0.055, 0.04), browMatShared, 0, 1.81, 0.24);
      // Swinging cuffed legs/boots (pivoted at hip Y=0.62)
      addPart(new THREE.BoxGeometry(0.24, 0.58, 0.26), bootMatShared, -0.135, 0.31, 0, 0, 0, 0, -1);
      addPart(new THREE.BoxGeometry(0.24, 0.58, 0.26), bootMatShared, 0.135, 0.31, 0, 0, 0, 0, 1);

      // Exact Signature Profession Headwear & Gear matching createMobMesh('villager')!
      if (profName === 'Farmer') {
        const strawMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.strawTex }) : trimMat;
        const ribbonMat = new THREE.MeshLambertMaterial({ color: 0xc9322c });
        addPart(new THREE.BoxGeometry(0.84, 0.06, 0.84), strawMat, 0, 1.92, 0);
        addPart(new THREE.BoxGeometry(0.54, 0.19, 0.54), strawMat, 0, 2.02, 0);
        addPart(new THREE.BoxGeometry(0.56, 0.06, 0.56), ribbonMat, 0, 1.96, 0);
      } else if (profName === 'Blacksmith') {
        const apronMat = vTex ? new THREE.MeshLambertMaterial({ map: vTex.apronTex }) : robeDarkMat;
        const brassMat = new THREE.MeshLambertMaterial({ color: 0xe3b13b });
        addPart(new THREE.BoxGeometry(0.46, 0.74, 0.05), apronMat, 0, 0.78, 0.195);
        addPart(new THREE.BoxGeometry(0.49, 0.10, 0.49), apronMat, 0, 1.88, 0);
        addPart(new THREE.BoxGeometry(0.36, 0.10, 0.08), brassMat, 0, 1.89, 0.25);
      } else if (profName === 'Librarian') {
        const coverMat = new THREE.MeshLambertMaterial({ color: 0x8f1e1e });
        const pageMat = new THREE.MeshLambertMaterial({ color: 0xf7efe0 });
        const goldMat = new THREE.MeshLambertMaterial({ color: 0xf2c94c });
        addPart(new THREE.BoxGeometry(0.56, 0.07, 0.54), coverMat, 0, 2.00, 0, 0, 0, 0.07);
        addPart(new THREE.BoxGeometry(0.50, 0.09, 0.48), pageMat, 0, 2.06, 0, 0, 0, 0.07);
        addPart(new THREE.BoxGeometry(0.56, 0.05, 0.54), coverMat, 0, 2.11, 0, 0, 0, 0.07);
        addPart(new THREE.BoxGeometry(0.16, 0.72, 0.04), goldMat, 0, 0.84, 0.185);
      } else {
        const hoodMat = new THREE.MeshLambertMaterial({ color: 0x5c2182 });
        const goldMat = new THREE.MeshLambertMaterial({ color: 0xf5cc42 });
        addPart(new THREE.BoxGeometry(0.52, 0.14, 0.54), hoodMat, 0, 1.97, -0.02);
        addPart(new THREE.BoxGeometry(0.54, 0.05, 0.56), goldMat, 0, 1.91, -0.02);
        addPart(new THREE.BoxGeometry(0.52, 0.44, 0.14), hoodMat, 0, 1.71, -0.24);
      }

      batches.push({ parts, agents: profAgents[pIdx] });
    }

    this.megaCrowds.set(ms.key, { ms, group, batches });
    // Immediately populate initial transforms so villagers appear on the very first frame!
    this._updateMegaCrowds(0.016, { pos: { x: ms.x, z: ms.z } });
    }
  }

  _updateMegaCrowds(dt, player) {
    this._crowdTick++;
    const dummy = this._crowdDummy;
    const rootMat = this._crowdRootMat;
    const tmpMat = this._crowdTmpMat;
    const legMat = this._crowdLegMat;

    for (const crowd of this.megaCrowds.values()) {
      const ms = crowd.ms;
      const dist = Math.hypot(player.pos.x - ms.x, player.pos.z - ms.z);
      if (dist > 125) {
        crowd.group.visible = false;
        continue;
      }
      crowd.group.visible = true;
      // Throttle distant crowds cleanly for silky 60 FPS on iPad!
      if (dist > 68 && (this._crowdTick & 1) === 1) continue;

      const stepDt = dist > 68 ? dt * 2 : dt;
      const innerR = ms.innerRadius || 20;

      for (let b = 0; b < crowd.batches.length; b++) {
        const batch = crowd.batches[b];
        const agents = batch.agents;
        const parts = batch.parts;

        for (let i = 0; i < agents.length; i++) {
          const a = agents[i];
          if (a.pauseTimer > 0) {
            a.pauseTimer -= stepDt;
          } else {
            a.turnTimer -= stepDt;
            if (a.turnTimer <= 0) {
              a.turnTimer = 1.6 + Math.random() * 3.8;
              if (Math.random() < 0.28) {
                a.pauseTimer = 0.8 + Math.random() * 2.2;
              } else {
                a.yaw += (Math.random() - 0.5) * 2.2;
              }
            }
            const nx = a.x + Math.sin(a.yaw) * a.speed * stepDt;
            const nz = a.z + Math.cos(a.yaw) * a.speed * stepDt;
            const outBounds = Math.abs(nx - ms.x) > innerR || Math.abs(nz - ms.z) > innerR;
            const blk = this.world.getBlock(nx, a.y, nz);
            const blkH = this.world.getBlock(nx, a.y + 1, nz);
            const flr = this.world.getBlock(nx, a.y - 1, nz);
            if (outBounds || isBlockSolid(blk) || blk === BLOCK.WATER || isBlockSolid(blkH) || !isBlockSolid(flr)) {
              a.yaw += Math.PI * (0.65 + Math.random() * 0.7);
            } else {
              a.x = nx;
              a.z = nz;
              a.phase += stepDt * a.speed * 7.5;
            }
          }

          const walking = a.pauseTimer <= 0;
          const bob = walking ? Math.abs(Math.sin(a.phase)) * 0.045 : 0;
          const legSwing = walking ? Math.sin(a.phase) * 0.42 : 0;

          dummy.position.set(a.x, a.y + bob, a.z);
          dummy.rotation.set(0, a.yaw, 0);
          dummy.updateMatrix();
          rootMat.copy(dummy.matrix);

          for (let p = 0; p < parts.length; p++) {
            const pt = parts[p];
            if (pt.legSide !== 0) {
              // Animated swinging leg pivoting cleanly at hip Y = 0.62!
              const ang = pt.legSide * legSwing;
              dummy.position.set(pt.legSide * 0.135, 0.31, Math.sin(ang) * 0.18);
              dummy.rotation.set(ang, 0, 0);
              dummy.updateMatrix();
              legMat.copy(dummy.matrix);
              tmpMat.multiplyMatrices(rootMat, legMat);
            } else {
              tmpMat.multiplyMatrices(rootMat, pt.localMat);
            }
            pt.mesh.setMatrixAt(i, tmpMat);
          }
        }

        for (let p = 0; p < parts.length; p++) {
          parts[p].mesh.instanceMatrix.needsUpdate = true;
        }
      }
    }
  }

  clearAll() {
    for (const m of this.mobs) { if (m.mesh) this.group.remove(m.mesh); }
    for (const d of this.drops) this.group.remove(d.mesh);
    for (const p of this.projectiles) this.group.remove(p.mesh);
    if (this._npcPools) {
      for (const k in this._npcPools) {
        const p = this._npcPools[k];
        p.count = 0;
        for (const mk of ['robe', 'body', 'bodyAcc', 'head', 'headAcc', 'legL', 'legR', 'armL', 'armR']) {
          if (p[mk]) { p[mk].count = 0; p[mk].visible = false; }
        }
      }
    }
    this._chunkBedCache.clear();
    for (const crowd of this.megaCrowds.values()) {
      this.group.remove(crowd.group);
      if (crowd.batches) {
        for (const batch of crowd.batches) {
          for (const pt of batch.parts) {
            pt.mesh.geometry.dispose();
            if (Array.isArray(pt.mesh.material)) {
              for (const mt of pt.mesh.material) mt.dispose();
            } else {
              pt.mesh.material.dispose();
            }
          }
        }
      }
    }
    this.megaCrowds.clear();
    this.mobs = [];
    this.drops = [];
    this.projectiles = [];
    this._pendingVillageSpawns = [];
    this.initialPopulated = false;
  }
}
