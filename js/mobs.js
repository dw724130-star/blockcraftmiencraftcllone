import * as THREE from 'three';
import { BLOCK, ITEMS, isBlockSolid, isBlockLiquid } from './blocks.js';

// Pre-allocated scratch vectors for zero-GC per-frame raycasts & pickups!
const _scratchV1 = new THREE.Vector3();
const _scratchV2 = new THREE.Vector3();

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

  // Village NPCs
  villager: {
    label: 'Villager', hostile: false, hp: 20, speed: 1.7, color: 0x8f6234, headColor: 0xd19f7b,
    size: [0.68, 1.92, 0.68], villager: true, drop: ['emerald'], xp: 3
  },
  iron_golem: {
    label: 'Iron Golem', hostile: false, hp: 60, speed: 1.5, color: 0xd8dce0, headColor: 0xc5cad1,
    size: [1.15, 2.55, 0.95], golem: true, drop: ['iron_ingot', 'iron_ingot', 'flower_red'], xp: 8
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

    // 3. Authentic Angled Crossed Minecraft Villager Arms (diagonal upper sleeves -> folded forearm cuff!)
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

    // 4. Articulated 6-Face Pixel-Art Expressive Villager Head + Sculpted Textured Nose!
    headGroup = new THREE.Group();
    headGroup.position.set(0, 1.41, 0);
    const headMats = [headSideMat, headSideMat, headTopMat, skinUnderMat, headFrontMat, headBackMat];
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.46, 0.58, 0.46), headMats, 0, 0.29, 0);
    // Iconic sculpted protruding Villager nose (with nostril shading on bottom!)
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.12, 0.24, 0.15), noseMat, 0, 0.14, 0.29, false);
    // Raised 3D brow ridge for extra expressiveness
    addShadowMesh(headGroup, new THREE.BoxGeometry(0.38, 0.055, 0.04), new THREE.MeshLambertMaterial({ color: 0x472d1b }), 0, 0.40, 0.24, false);

    // 5. Ultra-Detailed Profession 3D Gear & Headwear!
    if (profName === 'Farmer') {
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

    addShadowMesh(group, new THREE.BoxGeometry(w * 0.92, h * 0.48, l * 0.78), bodyMat, 0, legH + h * 0.24, 0);

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
      addShadowMesh(headGroup, new THREE.BoxGeometry(w * 0.62, w * 0.20, w * 0.56), bodyMat, 0, 0.24, 0.02, false); // wool crown
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

  return {
    group,
    legs,
    arms,
    wings,
    tail,
    headGroup,
    bodyMat,
    headMat,
    baseColor: usesCoatMap ? 0xffffff : bodyColor,
    label: customLabel
  };
}

export class EntityManager {
  constructor(scene, world, sound, textures = null) {
    this.scene = scene;
    this.world = world;
    this.sound = sound;
    this.textures = textures;
    this.mobs = [];
    this.drops = [];
    this.spawnTimer = 1.2;
    this.hostileSpawnTimer = 0.85;
    this.ambienceTimer = 4.0;
    this.initialPopulated = false;
    this._pendingVillageSpawns = [];
    this.onPickup = null;

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.dropGeo = new THREE.BoxGeometry(0.28, 0.28, 0.28);
    this.dropSpriteGeo = new THREE.PlaneGeometry(0.36, 0.36);
    this.dropSpriteMatCache = {};
    this.blockDropMat = textures
      ? new THREE.MeshLambertMaterial({ map: textures.atlasTexture, alphaTest: 0.35 })
      : null;
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
          if (isBlockSolid(this.world.getBlock(bx, by, bz))) return true;
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

  // Verify a full 3D water volume for fish so they never clip riverbanks!
  isWaterVolume(x, y, z, pad = 0.32) {
    const pts = [
      [x, y, z],
      [x - pad, y, z], [x + pad, y, z],
      [x, y, z - pad], [x, y, z + pad],
      [x, y + 0.22, z], [x, y - 0.22, z]
    ];
    for (const [px, py, pz] of pts) {
      if (!isBlockLiquid(this.world.getBlock(px, py, pz))) return false;
    }
    return true;
  }

  // Spawn a lively Herd / Pack / Flock / School of animals clustered together!
  spawnHerd(type, centerX, centerZ, count = 4, biome = 'Plains', maxTotal = 64) {
    const def = MOB_TYPES[type];
    if (!def) return 0;
    let spawned = 0;
    const hw = Math.max(def.size[0], def.size[2]) * 0.48;
    const herdHomeX = centerX + 0.5;
    const herdHomeZ = centerZ + 0.5;

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
        } else if (ground === BLOCK.GRASS || ground === BLOCK.SNOW || ground === BLOCK.SAND || ground === BLOCK.DIRT || ground === BLOCK.STONE) {
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
    for (let tries = 0; tries < 75 && (landHerds < 5 || waterHerds < 2); tries++) {
      const ang = (tries * 1.15) + Math.random() * 0.6;
      const dist = 10 + Math.random() * 26;
      const sx = Math.floor(playerPos.x + Math.cos(ang) * dist);
      const sz = Math.floor(playerPos.z + Math.sin(ang) * dist);
      const sy = this.world.getSurfaceY(sx, sz);
      const ground = this.world.getBlock(sx, sy - 1, sz);
      const biome = this.world.getBiomeAt(sx, sz);

      if (ground === BLOCK.WATER && waterHerds < 2) {
        const wType = Math.random() < 0.6 ? 'fish' : 'duck';
        const cnt = 3 + Math.floor(Math.random() * 3);
        if (this.spawnHerd(wType, sx, sz, cnt, biome, 64) > 0) waterHerds++;
      } else if ((ground === BLOCK.GRASS || ground === BLOCK.SNOW || ground === BLOCK.SAND) && landHerds < 5) {
        const type = this.pickWildlifeForBiome(biome, ground);
        const herdSize = type === 'butterfly' ? 4 : (3 + Math.floor(Math.random() * 3)); // 3-5 per herd!
        if (this.spawnHerd(type, sx, sz, herdSize, biome, 64) > 0) landHerds++;
      }
    }
  }

  pickWildlifeForBiome(biome, ground) {
    if (ground === BLOCK.SAND) {
      return Math.random() < 0.55 ? 'turtle' : 'rabbit';
    }
    if (biome === 'Snowy Taiga') {
      const pool = ['fox', 'wolf', 'rabbit', 'deer', 'sheep'];
      return pool[Math.floor(Math.random() * pool.length)];
    }
    if (biome === 'Forest' || biome === 'Birch Forest') {
      const pool = ['deer', 'deer', 'fox', 'wolf', 'rabbit', 'butterfly', 'pig', 'chicken'];
      return pool[Math.floor(Math.random() * pool.length)];
    }
    const pool = ['deer', 'rabbit', 'fox', 'butterfly', 'butterfly', 'cow', 'sheep', 'pig', 'chicken', 'duck'];
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
    const { group, legs, arms, wings, tail, headGroup, bodyMat, headMat, baseColor, label } =
      createMobMesh(type, { profession: prof, biome, textures: this.textures });
    group.position.set(x, y, z);
    this.group.add(group);

    const mob = {
      type,
      def,
      label,
      profession: prof ? prof.name : null,
      baseColor,
      halfW,
      height,
      mesh: group,
      legs,
      arms: arms || [],
      wings,
      tail,
      headGroup,
      bodyMat,
      headMat,
      pos: new THREE.Vector3(x, y, z),
      homePos: new THREE.Vector3(x, y, z),
      herdHome: null,
      vel: new THREE.Vector3(),
      yaw: Math.random() * Math.PI * 2,
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
      fleeTimer: 0,
      panicZigTimer: 0,
      panicJumpTimer: 0,
      fuseTimer: 0,
      orbitRadius: 10 + Math.random() * 14,
      orbitAngle: Math.random() * Math.PI * 2,
      cruiseY: y
    };
    this.mobs.push(mob);
    return mob;
  }

  // Pixel-Art 3D Falling Blocks & True 3D Voxel-Extruded Dropped Items!
  spawnDrop(itemId, count, x, y, z) {
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

    mesh.position.set(x, y + 0.32, z);
    this.group.add(mesh);

    this.drops.push({
      id: itemId,
      count,
      mesh,
      pos: new THREE.Vector3(x, y + 0.32, z),
      vel: new THREE.Vector3((Math.random() - 0.5) * 2.4, 3.4, (Math.random() - 0.5) * 2.4),
      age: 0
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

  hitMob(mob, damage, knockDir, player) {
    if (!mob || mob.hurtCd > 0) return false;
    mob.hp -= Math.max(1, damage || 2);
    mob.hurtFlash = 0.28;
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
    if (mob.bodyMat) mob.bodyMat.color.setHex(0xff4444);
    if (mob.headMat) mob.headMat.color.setHex(0xff4444);
    if (!mob.def.hostile) {
      // Go haywire! Frantic high-speed zig-zagging + repeated jumps to escape!
      mob.fleeTimer = 5.5 + Math.random() * 2.5;
      mob.panicZigTimer = 0.22 + Math.random() * 0.28;
      mob.panicJumpTimer = 0.14 + Math.random() * 0.18;
      mob.wanderDir = Math.atan2(kx, kz) + (Math.random() - 0.5) * 1.15;
      mob.moving = true;
    }
    this.sound.playHurt();

    if (mob.hp <= 0) {
      for (const dropId of mob.def.drop) {
        this.spawnDrop(dropId, 1, mob.pos.x, mob.pos.y + 0.4, mob.pos.z);
      }
      if (player) player.addXP(mob.def.xp || 2);
      this.removeMob(mob);
      return true;
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
    this.group.remove(mob.mesh);
  }

  despawnHostiles() {
    let removed = 0;
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      if (this.mobs[i].def.hostile) {
        this.group.remove(this.mobs[i].mesh);
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
        const hType = pool[Math.floor(Math.random() * pool.length)];
        const mob = this.spawnMob(hType, sx + 0.5, cy, sz + 0.5, null, biome);
        return mob ? 1 : 0;
      }
    }
    return 0;
  }

  update(dt, player, sky, onExplosion, mods = null, gameRules = null) {
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

    // 0. Stagger Village Population Spawning (1-2 per frame so approaching a village NEVER spikes!)
    for (const v of this.world.villageChunks.values()) {
      if (!v.spawned) {
        const d = Math.hypot(player.pos.x - v.x, player.pos.z - v.z);
        if (d < 84) {
          v.spawned = true;
          const spawns = [
            ['villager', -3.5, 3.5, VILLAGER_PROFESSIONS[0]],
            ['villager', 3.5, -3.5, VILLAGER_PROFESSIONS[1]],
            ['villager', -2.5, -4.0, VILLAGER_PROFESSIONS[2]],
            ['villager', 5.0, 2.5, VILLAGER_PROFESSIONS[3]],
            ['villager', -6.0, 0.5, VILLAGER_PROFESSIONS[0]],
            ['villager', 1.5, 5.5, VILLAGER_PROFESSIONS[1]],
            ['iron_golem', 0.5, 4.5, null],
            ['iron_golem', -4.5, -2.5, null]
          ];
          for (const [mType, ox, oz, prof] of spawns) {
            this._pendingVillageSpawns.push({ mType, sx: v.x + ox, sz: v.z + oz, baseY: v.y, prof });
          }
        }
      }
    }
    if (this._pendingVillageSpawns.length > 0) {
      for (let k = 0; k < 2 && this._pendingVillageSpawns.length > 0; k++) {
        const sp = this._pendingVillageSpawns.shift();
        const sy = this.world.getSurfaceY(sp.sx, sp.sz);
        this.spawnMob(sp.mType, sp.sx, Math.max(sp.baseY, sy), sp.sz, sp.prof);
      }
    }

    // 1A. Dynamic Biome-Aware Passive Wildlife Herd Spawning (capped independently from Hostiles!)
    const isNight = sky.isNight();
    let passiveCount = 0;
    let hostileCount = 0;
    for (let i = 0; i < this.mobs.length; i++) {
      if (this.mobs[i].def.hostile) hostileCount++;
      else passiveCount++;
    }

    const passiveCap = Math.round(52 * moreMobsMul);
    const totalPassiveCap = passiveCap + hostileCount;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = (mods && mods.isEnabled('more_mobs')) ? 1.1 : 1.75;
      if (passiveCount < passiveCap) {
        const birdCount = this.mobs.filter((m) => m.type === 'bird').length;

        if (!isNight && birdCount < 10 && Math.random() < 0.22) {
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
            const waterMobs = this.mobs.filter((m) => m.type === 'fish' || m.type === 'duck').length;
            if (waterMobs < 16) {
              const wType = Math.random() < 0.65 ? 'fish' : 'duck';
              this.spawnHerd(wType, sx, sz, 3 + Math.floor(Math.random() * 3), biome, totalPassiveCap);
            }
          } else if (ground === BLOCK.GRASS || ground === BLOCK.SNOW || ground === BLOCK.SAND) {
            const type = this.pickWildlifeForBiome(biome, ground);
            if (!(type === 'butterfly' && isNight)) {
              const herdSize = 3 + Math.floor(Math.random() * 4); // Herds of 3-6 animals!
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

    // 2. Update All Mobs & Wildlife (with full 3D AABB collision!)
    const nowSec = performance.now() * 0.001;
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      if (difficulty === 'peaceful' && m.def.hostile) {
        this.removeMob(m);
        continue;
      }
      const distToPlayer = m.pos.distanceTo(player.pos);

      const despawnDist = (m.def.villager || m.def.golem) ? 115 : 74;
      if (distToPlayer > despawnDist || m.pos.y < -5) {
        this.removeMob(m);
        continue;
      }

      if (m.hurtCd > 0) m.hurtCd = Math.max(0, m.hurtCd - dt);
      if (m.turnCd > 0) m.turnCd = Math.max(0, m.turnCd - dt);
      if (m.knockbackTimer > 0) m.knockbackTimer = Math.max(0, m.knockbackTimer - dt);

      if (m.hurtFlash > 0) {
        m.hurtFlash -= dt;
        const hurtCol = m.hurtFlash > 0 ? 0xff4444 : (m.baseColor ?? 0xffffff);
        if (m.bodyMat) m.bodyMat.color.setHex(hurtCol);
        if (m.headMat) m.headMat.color.setHex(m.hurtFlash > 0 ? 0xff4444 : (m.headBaseColor ?? 0xffffff));
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
          m.hp -= dt * 2.5;
          m.hurtFlash = 0.15;
          if (m.hp <= 0) {
            this.removeMob(m);
            continue;
          }
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

      // AI Movement
      let moveX = 0, moveZ = 0;
      if (m.def.hostile && player.mode === 'survival' && !player.dead && distToPlayer < 18) {
        const dx = player.pos.x - m.pos.x;
        const dz = player.pos.z - m.pos.z;
        m.yaw = Math.atan2(dx, dz);

        if (m.def.creeper && distToPlayer < 3.2) {
          if (m.fuseTimer === 0 && this.sound && this.sound.playFuse) this.sound.playFuse();
          m.fuseTimer += dt;
          const pulse = Math.sin(m.fuseTimer * 28) > 0;
          m.bodyMat.color.setHex(pulse ? 0xffffff : m.baseColor);
          if (m.headMat) m.headMat.color.setHex(pulse ? 0xffffff : m.baseColor);
          const swell = 1.0 + (m.fuseTimer / 1.4) * 0.28;
          m.mesh.scale.set(swell, 1.0 + (m.fuseTimer / 1.4) * 0.12, swell);
          if (m.fuseTimer >= 1.4) {
            if (onExplosion) onExplosion(m.pos.x, m.pos.y + 0.8, m.pos.z, 3.8);
            this.removeMob(m);
            continue;
          }
        } else {
          if (m.def.creeper && m.fuseTimer > 0) {
            m.fuseTimer = Math.max(0, m.fuseTimer - dt * 1.5);
            m.mesh.scale.setScalar(1.0);
            m.bodyMat.color.setHex(m.baseColor);
            if (m.headMat) m.headMat.color.setHex(m.baseColor);
          }
          if (distToPlayer > 1.35) {
            moveX = Math.sin(m.yaw) * m.def.speed;
            moveZ = Math.cos(m.yaw) * m.def.speed;
          } else if (m.attackCd <= 0 && !m.def.creeper) {
            m.attackCd = 1.1;
            const scaledDmg = Math.max(1, Math.round((m.def.dmg || 3) * diffCfg.dmgMul));
            player.takeDamage(scaledDmg, `Slain by ${m.label || m.type}`);
          }
        }
      } else {
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
          if (m.aiTimer <= 0) {
            m.aiTimer = 2.4 + Math.random() * 4.2;
            m.moving = Math.random() > 0.35;
            if ((m.def.villager || m.def.golem) && m.pos.distanceTo(m.homePos) > 22) {
              m.wanderDir = Math.atan2(m.homePos.x - m.pos.x, m.homePos.z - m.pos.z) + (Math.random() - 0.5) * 0.5;
              m.moving = true;
            } else if (m.herdHome && !m.def.hostile && m.pos.distanceTo(m.herdHome) > 13) {
              // Steer gently back toward herd only when choosing a new waypoint (never per-frame!)
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
          } else if (m.def.villager && distToPlayer < 5.5) {
            const lookYaw = Math.atan2(player.pos.x - m.pos.x, player.pos.z - m.pos.z);
            m.yaw = lerpAngle(m.yaw, lookYaw, Math.min(1, dt * 6));
          }
        }
      }

      // Gravity & Water Buoyancy
      const inWater = isBlockLiquid(this.world.getBlock(m.pos.x, m.pos.y + 0.15, m.pos.z));
      if (m.def.floatsOnWater && inWater) {
        const surfaceY = Math.floor(m.pos.y + 0.15) + 0.72;
        m.vel.y = (surfaceY - m.pos.y) * 5.0;
      } else {
        m.vel.y -= (inWater ? 6 : 22) * dt;
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

      // Apply transform + limb/arm/head/tail/wing animations
      m.mesh.position.copy(m.pos);
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
      // Articulated Hostile Zombie & Skeleton Arm Sway!
      if (m.arms && m.arms.length === 2) {
        const sway = Math.sin(nowSec * 3.2 + m.walkPhase) * 0.12;
        m.arms[0].rotation.x = -Math.PI * 0.44 + sway;
        m.arms[1].rotation.x = -Math.PI * 0.44 - sway;
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
      if (dist < 2.6 && d.age > 0.25 && dist > 0.001) {
        d.pos.addScaledVector(_scratchV1, (dt * 7.5) / dist);
      }
      if (dist < 0.85 && d.age > 0.2) {
        if (player.inventory.addItem(d.id, d.count)) {
          this.sound.playPop();
          this.group.remove(d.mesh);
          this.drops.splice(i, 1);
          if (this.onPickup) this.onPickup(d.id, d.count);
          continue;
        }
      }

      d.mesh.position.set(d.pos.x, d.pos.y + Math.sin(d.age * 4) * 0.08, d.pos.z);
      d.mesh.rotation.y += dt * 2.2;
    }
  }

  clearAll() {
    for (const m of this.mobs) this.group.remove(m.mesh);
    for (const d of this.drops) this.group.remove(d.mesh);
    this.mobs = [];
    this.drops = [];
    this._pendingVillageSpawns = [];
    this.initialPopulated = false;
  }
}
