import * as THREE from 'three';
import { BLOCK, isBlockSolid, isBlockLiquid } from './blocks.js';

export const VILLAGER_TRADES = {
  Farmer: [
    { give: 'wheat', giveCount: 4, get: 'emerald', getCount: 1 },
    { give: 'oak_log', giveCount: 6, get: 'emerald', getCount: 1 },
    { give: 'emerald', giveCount: 1, get: 'bread', getCount: 4 },
    { give: 'emerald', giveCount: 1, get: 'apple', getCount: 4 }
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
  ]
};

const VILLAGER_PROFESSIONS = [
  { name: 'Farmer', robe: 0x8f6234, trim: 0xd9b84c },
  { name: 'Blacksmith', robe: 0x454952, trim: 0x26282e },
  { name: 'Librarian', robe: 0x9c2b2b, trim: 0xe6e0cf }
];

const BIRD_VARIANTS = [
  { label: 'Bluejay', body: 0x3b82d6, wing: 0x1e4d8f, belly: 0xeef6ff, beak: 0x2b2d33 },
  { label: 'Cardinal', body: 0xd93838, wing: 0x9e1c1c, belly: 0xe84a4a, beak: 0xf59e0b },
  { label: 'Song Robin', body: 0x6b5344, wing: 0x4a382d, belly: 0xe06d3b, beak: 0xfacc15 },
  { label: 'Golden Finch', body: 0xf4c430, wing: 0x262626, belly: 0xfff3a8, beak: 0xf97316 },
  { label: 'Seagull', body: 0xf5f7fa, wing: 0xbec7d4, belly: 0xffffff, beak: 0xf5b342 }
];

const FISH_VARIANTS = [
  { label: 'River Salmon', body: 0xc95f55, fin: 0x8a3932, accent: 0x5c736b },
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
  // Classic Farm Animals
  pig: {
    label: 'Pig', hostile: false, hp: 10, speed: 2.0, color: 0xf2a2a8, headColor: 0xf7b2b8,
    size: [0.85, 0.75, 1.15], drop: ['raw_porkchop'], xp: 2
  },
  cow: {
    label: 'Cow', hostile: false, hp: 12, speed: 1.9, color: 0x5c422c, headColor: 0x473120,
    size: [0.9, 1.15, 1.3], drop: ['raw_beef', 'leather'], xp: 2
  },
  sheep: {
    label: 'Sheep', hostile: false, hp: 10, speed: 2.0, color: 0xedeff2, headColor: 0xd9c2a8,
    size: [0.85, 1.05, 1.2], drop: ['wool_white'], xp: 2
  },
  chicken: {
    label: 'Chicken', hostile: false, hp: 6, speed: 2.3, color: 0xffffff, headColor: 0xfcfcfc,
    size: [0.5, 0.65, 0.6], drop: ['feather'], xp: 1
  },

  // Rich Wildlife!
  deer: {
    label: 'Forest Deer', hostile: false, wildlife: true, shy: true, hp: 12, speed: 3.4,
    color: 0xa66e42, headColor: 0x915b32, size: [0.75, 1.55, 1.35], drop: ['leather', 'raw_beef'], xp: 3
  },
  fox: {
    label: 'Red Fox', hostile: false, wildlife: true, shy: true, hp: 10, speed: 3.3,
    color: 0xd96b27, headColor: 0xe67a32, size: [0.58, 0.68, 1.05], drop: ['leather'], xp: 3
  },
  rabbit: {
    label: 'Wild Bunny', hostile: false, wildlife: true, shy: true, hopper: true, hp: 5, speed: 3.1,
    color: 0xb89672, headColor: 0xc7a785, size: [0.42, 0.48, 0.55], drop: ['leather'], xp: 2
  },
  wolf: {
    label: 'Timber Wolf', hostile: false, wildlife: true, hp: 16, speed: 2.9,
    color: 0xa6adb5, headColor: 0x8e959e, size: [0.64, 0.85, 1.15], drop: ['bone'], xp: 3
  },
  duck: {
    label: 'Mallard Duck', hostile: false, wildlife: true, floatsOnWater: true, hp: 6, speed: 2.0,
    color: 0x8c6d52, headColor: 0x1e6b43, size: [0.46, 0.52, 0.65], drop: ['feather'], xp: 1
  },
  turtle: {
    label: 'Shore Turtle', hostile: false, wildlife: true, floatsOnWater: true, hp: 14, speed: 1.05,
    color: 0x3b7a3e, headColor: 0x5ea356, size: [0.72, 0.4, 0.82], drop: ['leather'], xp: 2
  },
  bird: {
    label: 'Songbird', hostile: false, wildlife: true, flying: true, hp: 4, speed: 5.2,
    color: 0x3b82d6, headColor: 0x1e4d8f, size: [0.42, 0.3, 0.45], drop: ['feather'], xp: 2
  },
  fish: {
    label: 'River Fish', hostile: false, wildlife: true, aquatic: true, hp: 4, speed: 2.4,
    color: 0xc95f55, headColor: 0x8a3932, size: [0.28, 0.32, 0.62], drop: ['raw_beef'], xp: 2
  },
  butterfly: {
    label: 'Butterfly', hostile: false, wildlife: true, butterfly: true, hp: 2, speed: 1.6,
    color: 0xff8c1a, headColor: 0x241914, size: [0.34, 0.22, 0.34], drop: [], xp: 1
  },

  // Village NPCs
  villager: {
    label: 'Villager', hostile: false, hp: 20, speed: 1.7, color: 0x8f6234, headColor: 0xd19f7b,
    size: [0.65, 1.9, 0.65], villager: true, drop: ['emerald'], xp: 3
  },
  iron_golem: {
    label: 'Iron Golem', hostile: false, hp: 60, speed: 1.5, color: 0xd8dce0, headColor: 0xc5cad1,
    size: [1.1, 2.5, 0.9], golem: true, drop: ['iron_ingot', 'iron_ingot', 'flower_red'], xp: 8
  },

  // Hostile Night Mobs
  zombie: {
    label: 'Zombie', hostile: true, hp: 20, speed: 2.5, dmg: 3, color: 0x3b7a8c, headColor: 0x568c4d,
    size: [0.65, 1.85, 0.65], humanoid: true, burnsInDay: true, drop: ['coal'], xp: 5
  },
  skeleton: {
    label: 'Skeleton', hostile: true, hp: 16, speed: 2.7, dmg: 3, color: 0xd6d8dc, headColor: 0xe6e8ec,
    size: [0.6, 1.85, 0.6], humanoid: true, burnsInDay: true, drop: ['bone'], xp: 5
  },
  creeper: {
    label: 'Creeper', hostile: true, hp: 18, speed: 2.4, dmg: 10, color: 0x4ca64c, headColor: 0x3f8f3f,
    size: [0.65, 1.7, 0.65], humanoid: true, creeper: true, drop: ['gunpowder'], xp: 6
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

function createMobMesh(type, options = {}) {
  const def = MOB_TYPES[type];
  const group = new THREE.Group();
  const profession = options.profession || null;
  const biome = options.biome || 'Plains';

  let bodyColor = profession ? profession.robe : def.color;
  let headColor = def.headColor;
  let customLabel = profession ? profession.name : def.label;

  // Biome-adapted coats for Foxes & Rabbits!
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
  const eyeMat = new THREE.MeshBasicMaterial({
    color: def.villager ? 0x2e8b57 : (def.golem ? 0xc92a2a : (type === 'wolf' ? 0xf59e0b : 0x111111))
  });

  const legs = [];
  const wings = [];
  let tail = null;

  if (type === 'deer') {
    const isStag = Math.random() < 0.55;
    customLabel = isStag ? 'Forest Stag' : 'Forest Doe';
    const bellyMat = new THREE.MeshLambertMaterial({ color: 0xe8d9c5 });
    const hoofMat = new THREE.MeshLambertMaterial({ color: 0x3b281c });
    const antlerMat = new THREE.MeshLambertMaterial({ color: 0xd9c39e });

    // Slender long legs
    for (const [lx, lz] of [[-0.2, 0.36], [0.2, 0.36], [-0.2, -0.36], [0.2, -0.36]]) {
      const pivot = new THREE.Group();
      pivot.position.set(lx, 0.66, lz);
      addShadowMesh(pivot, new THREE.BoxGeometry(0.13, 0.54, 0.13), bodyMat, 0, -0.27, 0);
      addShadowMesh(pivot, new THREE.BoxGeometry(0.14, 0.14, 0.14), hoofMat, 0, -0.59, 0, false);
      group.add(pivot);
      legs.push(pivot);
    }
    // Torso & cream belly
    addShadowMesh(group, new THREE.BoxGeometry(0.56, 0.48, 1.05), bodyMat, 0, 0.88, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.46, 0.12, 0.88), bellyMat, 0, 0.64, 0, false);
    // White-underside tail
    tail = addShadowMesh(group, new THREE.BoxGeometry(0.14, 0.16, 0.22), bellyMat, 0, 0.98, -0.58, false);
    // Graceful upright neck + head + ears
    addShadowMesh(group, new THREE.BoxGeometry(0.26, 0.46, 0.28), bodyMat, 0, 1.24, 0.44);
    addShadowMesh(group, new THREE.BoxGeometry(0.32, 0.3, 0.44), headMat, 0, 1.5, 0.58);
    addShadowMesh(group, new THREE.BoxGeometry(0.2, 0.16, 0.2), hoofMat, 0, 1.44, 0.82, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.08, 0.16, 0.08), headMat, -0.18, 1.68, 0.46, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.08, 0.16, 0.08), headMat, 0.18, 1.68, 0.46, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.06, 0.06, 0.04), eyeMat, -0.16, 1.54, 0.72, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.06, 0.06, 0.04), eyeMat, 0.16, 1.54, 0.72, false);

    if (isStag) {
      // Branching voxel antlers!
      for (const s of [-1, 1]) {
        addShadowMesh(group, new THREE.BoxGeometry(0.06, 0.34, 0.06), antlerMat, s * 0.12, 1.8, 0.52);
        addShadowMesh(group, new THREE.BoxGeometry(0.22, 0.06, 0.06), antlerMat, s * 0.22, 1.88, 0.52);
        addShadowMesh(group, new THREE.BoxGeometry(0.06, 0.2, 0.06), antlerMat, s * 0.3, 1.98, 0.56);
        addShadowMesh(group, new THREE.BoxGeometry(0.05, 0.14, 0.05), antlerMat, s * 0.16, 1.92, 0.62);
      }
    }
  } else if (type === 'fox') {
    const whiteMat = new THREE.MeshLambertMaterial({ color: 0xfafafa });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x26201c });
    for (const [lx, lz] of [[-0.16, 0.28], [0.16, 0.28], [-0.16, -0.28], [0.16, -0.28]]) {
      const leg = addShadowMesh(group, new THREE.BoxGeometry(0.13, 0.3, 0.13), darkMat, lx, 0.15, lz);
      legs.push(leg);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.46, 0.36, 0.76), bodyMat, 0, 0.44, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.36, 0.1, 0.62), whiteMat, 0, 0.28, 0, false);
    // Pointed snout & ears
    addShadowMesh(group, new THREE.BoxGeometry(0.38, 0.32, 0.38), headMat, 0, 0.54, 0.44);
    addShadowMesh(group, new THREE.BoxGeometry(0.22, 0.16, 0.24), whiteMat, 0, 0.46, 0.68, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.08, 0.08, 0.06), darkMat, 0, 0.5, 0.8, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.1, 0.16, 0.08), darkMat, -0.14, 0.74, 0.38, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.1, 0.16, 0.08), darkMat, 0.14, 0.74, 0.38, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.06, 0.06, 0.04), eyeMat, -0.12, 0.58, 0.64, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.06, 0.06, 0.04), eyeMat, 0.12, 0.58, 0.64, false);
    // Fluffy white-tipped tail
    const tailPivot = new THREE.Group();
    tailPivot.position.set(0, 0.44, -0.38);
    addShadowMesh(tailPivot, new THREE.BoxGeometry(0.22, 0.22, 0.44), bodyMat, 0, 0.04, -0.2);
    addShadowMesh(tailPivot, new THREE.BoxGeometry(0.2, 0.2, 0.18), whiteMat, 0, 0.06, -0.44, false);
    group.add(tailPivot);
    tail = tailPivot;
  } else if (type === 'rabbit') {
    const whiteMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const pinkMat = new THREE.MeshLambertMaterial({ color: 0xf4a6b8 });
    for (const [lx, lz] of [[-0.12, 0.14], [0.12, 0.14], [-0.14, -0.14], [0.14, -0.14]]) {
      const leg = addShadowMesh(group, new THREE.BoxGeometry(0.1, 0.14, 0.16), bodyMat, lx, 0.07, lz);
      legs.push(leg);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.36, 0.3, 0.44), bodyMat, 0, 0.24, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.26, 0.24, 0.26), headMat, 0, 0.36, 0.24);
    addShadowMesh(group, new THREE.BoxGeometry(0.07, 0.24, 0.06), headMat, -0.08, 0.56, 0.2);
    addShadowMesh(group, new THREE.BoxGeometry(0.07, 0.24, 0.06), headMat, 0.08, 0.56, 0.2);
    addShadowMesh(group, new THREE.BoxGeometry(0.06, 0.05, 0.04), pinkMat, 0, 0.34, 0.38, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.05, 0.05, 0.04), eyeMat, -0.09, 0.39, 0.37, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.05, 0.05, 0.04), eyeMat, 0.09, 0.39, 0.37, false);
    tail = addShadowMesh(group, new THREE.BoxGeometry(0.14, 0.14, 0.14), whiteMat, 0, 0.24, -0.26, false);
  } else if (type === 'wolf') {
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x5c626b });
    const lightMat = new THREE.MeshLambertMaterial({ color: 0xdbe0e6 });
    for (const [lx, lz] of [[-0.18, 0.32], [0.18, 0.32], [-0.18, -0.32], [0.18, -0.32]]) {
      const leg = addShadowMesh(group, new THREE.BoxGeometry(0.15, 0.42, 0.15), bodyMat, lx, 0.21, lz);
      legs.push(leg);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.52, 0.44, 0.88), bodyMat, 0, 0.58, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.56, 0.46, 0.36), darkMat, 0, 0.6, 0.24);
    addShadowMesh(group, new THREE.BoxGeometry(0.42, 0.38, 0.4), headMat, 0, 0.68, 0.56);
    addShadowMesh(group, new THREE.BoxGeometry(0.22, 0.18, 0.24), lightMat, 0, 0.6, 0.82, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.11, 0.15, 0.08), darkMat, -0.15, 0.92, 0.52, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.11, 0.15, 0.08), darkMat, 0.15, 0.92, 0.52, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.07, 0.06, 0.04), eyeMat, -0.12, 0.74, 0.77, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.07, 0.06, 0.04), eyeMat, 0.12, 0.74, 0.77, false);
    const tailPivot = new THREE.Group();
    tailPivot.position.set(0, 0.62, -0.44);
    addShadowMesh(tailPivot, new THREE.BoxGeometry(0.16, 0.16, 0.44), darkMat, 0, 0.06, -0.2);
    group.add(tailPivot);
    tail = tailPivot;
  } else if (type === 'duck') {
    const billMat = new THREE.MeshLambertMaterial({ color: 0xf5a623 });
    const ringMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    for (const lx of [-0.1, 0.1]) {
      const leg = addShadowMesh(group, new THREE.BoxGeometry(0.07, 0.18, 0.09), billMat, lx, 0.09, 0, false);
      legs.push(leg);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.38, 0.28, 0.54), bodyMat, 0, 0.28, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.24, 0.06, 0.24), ringMat, 0, 0.44, 0.2, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.24, 0.24, 0.26), headMat, 0, 0.56, 0.22);
    addShadowMesh(group, new THREE.BoxGeometry(0.16, 0.08, 0.18), billMat, 0, 0.52, 0.4, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.05, 0.05, 0.04), eyeMat, -0.12, 0.6, 0.28, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.05, 0.05, 0.04), eyeMat, 0.12, 0.6, 0.28, false);
    for (const s of [-1, 1]) {
      const wp = new THREE.Group();
      wp.position.set(s * 0.2, 0.34, 0);
      addShadowMesh(wp, new THREE.BoxGeometry(0.06, 0.2, 0.38), bodyMat, s * 0.02, -0.04, 0, false);
      group.add(wp);
      wings.push(wp);
    }
  } else if (type === 'turtle') {
    const shellMat = new THREE.MeshLambertMaterial({ color: 0x2d6a36 });
    const rimMat = new THREE.MeshLambertMaterial({ color: 0xc2b270 });
    addShadowMesh(group, new THREE.BoxGeometry(0.62, 0.24, 0.72), shellMat, 0, 0.2, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.66, 0.08, 0.76), rimMat, 0, 0.1, 0, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.24, 0.2, 0.26), headMat, 0, 0.18, 0.44);
    addShadowMesh(group, new THREE.BoxGeometry(0.05, 0.05, 0.04), eyeMat, -0.08, 0.22, 0.57, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.05, 0.05, 0.04), eyeMat, 0.08, 0.22, 0.57, false);
    for (const [lx, lz] of [[-0.34, 0.22], [0.34, 0.22], [-0.3, -0.26], [0.3, -0.26]]) {
      const flip = addShadowMesh(group, new THREE.BoxGeometry(0.2, 0.07, 0.16), headMat, lx, 0.07, lz, false);
      legs.push(flip);
    }
  } else if (type === 'bird') {
    const v = BIRD_VARIANTS[Math.floor(Math.random() * BIRD_VARIANTS.length)];
    customLabel = v.label;
    bodyColor = v.body;
    bodyMat = new THREE.MeshLambertMaterial({ color: v.body });
    headMat = new THREE.MeshLambertMaterial({ color: v.body });
    const wingMat = new THREE.MeshLambertMaterial({ color: v.wing });
    const bellyMat = new THREE.MeshLambertMaterial({ color: v.belly });
    const beakMat = new THREE.MeshLambertMaterial({ color: v.beak });

    addShadowMesh(group, new THREE.BoxGeometry(0.2, 0.18, 0.38), bodyMat, 0, 0, 0, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.18, 0.08, 0.3), bellyMat, 0, -0.07, 0, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.18, 0.17, 0.18), headMat, 0, 0.06, 0.22, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.07, 0.06, 0.14), beakMat, 0, 0.04, 0.35, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.14, 0.04, 0.24), wingMat, 0, 0.03, -0.28, false);
    // Articulated flapping wings!
    for (const s of [-1, 1]) {
      const wp = new THREE.Group();
      wp.position.set(s * 0.1, 0.05, 0.02);
      addShadowMesh(wp, new THREE.BoxGeometry(0.38, 0.04, 0.22), wingMat, s * 0.19, 0, 0, false);
      group.add(wp);
      wings.push(wp);
    }
  } else if (type === 'fish') {
    const v = FISH_VARIANTS[Math.floor(Math.random() * FISH_VARIANTS.length)];
    customLabel = v.label;
    bodyColor = v.body;
    bodyMat = new THREE.MeshLambertMaterial({ color: v.body });
    const finMat = new THREE.MeshLambertMaterial({ color: v.fin });
    const accentMat = new THREE.MeshLambertMaterial({ color: v.accent });

    addShadowMesh(group, new THREE.BoxGeometry(0.14, 0.22, 0.44), bodyMat, 0, 0, 0, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.15, 0.07, 0.34), accentMat, 0, 0.08, 0, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.04, 0.12, 0.22), finMat, 0, 0.16, -0.02, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.04, 0.04, 0.04), eyeMat, -0.07, 0.04, 0.15, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.04, 0.04, 0.04), eyeMat, 0.07, 0.04, 0.15, false);
    const tailPivot = new THREE.Group();
    tailPivot.position.set(0, 0, -0.22);
    addShadowMesh(tailPivot, new THREE.BoxGeometry(0.04, 0.2, 0.18), finMat, 0, 0, -0.09, false);
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
      addShadowMesh(wp, new THREE.BoxGeometry(0.17, 0.015, 0.2), bodyMat, s * 0.09, 0, 0.02, false);
      addShadowMesh(wp, new THREE.BoxGeometry(0.12, 0.015, 0.14), rimMat, s * 0.07, 0.004, -0.08, false);
      group.add(wp);
      wings.push(wp);
    }
  } else if (def.villager) {
    const trimMat = new THREE.MeshLambertMaterial({ color: profession ? profession.trim : 0x5c3e20 });
    const legGeo = new THREE.BoxGeometry(0.22, 0.56, 0.22);
    for (const lx of [-0.13, 0.13]) {
      const leg = addShadowMesh(group, legGeo, trimMat, lx, 0.28, 0);
      legs.push(leg);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.54, 0.88, 0.34), bodyMat, 0, 0.96, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.68, 0.22, 0.22), trimMat, 0, 1.06, 0.2);
    addShadowMesh(group, new THREE.BoxGeometry(0.46, 0.56, 0.46), headMat, 0, 1.68, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.36, 0.06, 0.04), new THREE.MeshBasicMaterial({ color: 0x3b2718 }), 0, 1.78, 0.24, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.12, 0.24, 0.14), headMat, 0, 1.56, 0.28, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.08, 0.07, 0.04), eyeMat, -0.11, 1.71, 0.24, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.08, 0.07, 0.04), eyeMat, 0.11, 1.71, 0.24, false);
  } else if (def.golem) {
    const vineMat = new THREE.MeshLambertMaterial({ color: 0x458534 });
    const legGeo = new THREE.BoxGeometry(0.32, 0.92, 0.32);
    for (const lx of [-0.24, 0.24]) {
      const leg = addShadowMesh(group, legGeo, bodyMat, lx, 0.46, 0);
      legs.push(leg);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.95, 0.92, 0.52), bodyMat, 0, 1.38, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.97, 0.2, 0.54), vineMat, 0, 1.48, 0, false);
    for (const ax of [-0.66, 0.66]) {
      addShadowMesh(group, new THREE.BoxGeometry(0.28, 1.25, 0.28), headMat, ax, 1.2, 0.08);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.5, 0.56, 0.5), headMat, 0, 2.12, 0.06);
    addShadowMesh(group, new THREE.BoxGeometry(0.12, 0.2, 0.12), headMat, 0, 2.02, 0.34, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.09, 0.07, 0.04), eyeMat, -0.12, 2.16, 0.32, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.09, 0.07, 0.04), eyeMat, 0.12, 2.16, 0.32, false);
  } else if (def.humanoid) {
    const legGeo = new THREE.BoxGeometry(0.24, 0.72, 0.24);
    for (const lx of [-0.14, 0.14]) {
      const leg = addShadowMesh(group, legGeo, bodyMat, lx, 0.36, 0);
      legs.push(leg);
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.52, 0.68, 0.28), bodyMat, 0, 1.06, 0);
    if (!def.creeper) {
      const armGeo = new THREE.BoxGeometry(0.2, 0.62, 0.2);
      for (const ax of [-0.38, 0.38]) {
        const arm = addShadowMesh(group, armGeo, headMat, ax, 1.08, 0.18);
        arm.rotation.x = type === 'zombie' ? -Math.PI * 0.42 : -0.2;
      }
    }
    addShadowMesh(group, new THREE.BoxGeometry(0.46, 0.46, 0.46), headMat, 0, 1.62, 0);
    addShadowMesh(group, new THREE.BoxGeometry(0.09, 0.09, 0.04), eyeMat, -0.11, 1.66, 0.23, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.09, 0.09, 0.04), eyeMat, 0.11, 1.66, 0.23, false);
  } else {
    // Upgraded Pig, Cow, Sheep, Chicken with snouts, horns, beaks & shadows!
    const [w, h, l] = def.size;
    const legH = h * 0.38;
    const legGeo = new THREE.BoxGeometry(w * 0.22, legH, w * 0.22);
    const legPos = type === 'chicken'
      ? [[-w * 0.2, legH * 0.5, 0], [w * 0.2, legH * 0.5, 0]]
      : [
          [-w * 0.26, legH * 0.5, l * 0.28],
          [w * 0.26, legH * 0.5, l * 0.28],
          [-w * 0.26, legH * 0.5, -l * 0.28],
          [w * 0.26, legH * 0.5, -l * 0.28]
        ];
    const legMat = type === 'chicken' ? new THREE.MeshLambertMaterial({ color: 0xf5b342 }) : bodyMat;
    for (const [lx, ly, lz] of legPos) {
      const leg = addShadowMesh(group, legGeo, legMat, lx, ly, lz);
      legs.push(leg);
    }
    addShadowMesh(group, new THREE.BoxGeometry(w, h * 0.52, l * 0.8), bodyMat, 0, legH + h * 0.24, 0);
    addShadowMesh(group, new THREE.BoxGeometry(w * 0.58, w * 0.56, w * 0.58), headMat, 0, legH + h * 0.42, l * 0.46);
    addShadowMesh(group, new THREE.BoxGeometry(0.08, 0.08, 0.04), eyeMat, -w * 0.16, legH + h * 0.46, l * 0.46 + w * 0.3, false);
    addShadowMesh(group, new THREE.BoxGeometry(0.08, 0.08, 0.04), eyeMat, w * 0.16, legH + h * 0.46, l * 0.46 + w * 0.3, false);

    if (type === 'pig') {
      const snoutMat = new THREE.MeshLambertMaterial({ color: 0xe88a94 });
      addShadowMesh(group, new THREE.BoxGeometry(0.26, 0.18, 0.12), snoutMat, 0, legH + h * 0.36, l * 0.46 + w * 0.33, false);
    } else if (type === 'cow') {
      const hornMat = new THREE.MeshLambertMaterial({ color: 0xd8d2c5 });
      const patchMat = new THREE.MeshLambertMaterial({ color: 0xe8e4dc });
      addShadowMesh(group, new THREE.BoxGeometry(0.08, 0.16, 0.08), hornMat, -0.24, legH + h * 0.72, l * 0.46, false);
      addShadowMesh(group, new THREE.BoxGeometry(0.08, 0.16, 0.08), hornMat, 0.24, legH + h * 0.72, l * 0.46, false);
      addShadowMesh(group, new THREE.BoxGeometry(w + 0.02, h * 0.25, l * 0.32), patchMat, 0, legH + h * 0.32, 0.12, false);
    } else if (type === 'chicken') {
      const beakMat = new THREE.MeshLambertMaterial({ color: 0xf5b342 });
      const combMat = new THREE.MeshLambertMaterial({ color: 0xd93838 });
      addShadowMesh(group, new THREE.BoxGeometry(0.12, 0.08, 0.14), beakMat, 0, legH + h * 0.38, l * 0.46 + w * 0.32, false);
      addShadowMesh(group, new THREE.BoxGeometry(0.08, 0.1, 0.08), combMat, 0, legH + h * 0.28, l * 0.46 + w * 0.28, false);
    }
  }

  return { group, legs, wings, tail, bodyMat, headMat, baseColor: bodyColor, label: customLabel };
}

export class EntityManager {
  constructor(scene, world, sound) {
    this.scene = scene;
    this.world = world;
    this.sound = sound;
    this.mobs = [];
    this.drops = [];
    this.spawnTimer = 1.2;
    this.ambienceTimer = 4.0;
    this.initialPopulated = false;

    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.dropGeo = new THREE.BoxGeometry(0.28, 0.28, 0.28);
  }

  populateInitialWildlife(playerPos) {
    if (this.initialPopulated) return;
    this.initialPopulated = true;

    // 1. Spawn a lively flock of songbirds soaring in the sky
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + Math.random();
      const dist = 10 + Math.random() * 18;
      const bx = playerPos.x + Math.cos(ang) * dist;
      const bz = playerPos.z + Math.sin(ang) * dist;
      const by = Math.max(playerPos.y + 8, this.world.getSurfaceY(bx, bz) + 9 + Math.random() * 8);
      this.spawnMob('bird', bx, by, bz);
    }

    // 2. Spawn nearby land wildlife, butterflies, ducks & fish
    let landCount = 0;
    let waterCount = 0;
    for (let tries = 0; tries < 42 && (landCount < 8 || waterCount < 5); tries++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 9 + Math.random() * 24;
      const sx = Math.floor(playerPos.x + Math.cos(ang) * dist);
      const sz = Math.floor(playerPos.z + Math.sin(ang) * dist);
      const sy = this.world.getSurfaceY(sx, sz);
      const ground = this.world.getBlock(sx, sy - 1, sz);
      const biome = this.world.getBiomeAt(sx, sz);

      if (ground === BLOCK.WATER && waterCount < 5) {
        if (Math.random() < 0.65) {
          this.spawnMob('fish', sx + 0.5, sy - 1.6, sz + 0.5, null, biome);
        } else {
          this.spawnMob('duck', sx + 0.5, sy - 0.15, sz + 0.5, null, biome);
        }
        waterCount++;
      } else if ((ground === BLOCK.GRASS || ground === BLOCK.SNOW || ground === BLOCK.SAND) && landCount < 8) {
        const type = this.pickWildlifeForBiome(biome, ground);
        if (type === 'butterfly') {
          this.spawnMob('butterfly', sx + 0.5, sy + 1.2, sz + 0.5, null, biome);
        } else {
          this.spawnMob(type, sx + 0.5, sy, sz + 0.5, null, biome);
        }
        landCount++;
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
    // Plains / Mountains
    const pool = ['deer', 'rabbit', 'fox', 'butterfly', 'butterfly', 'cow', 'sheep', 'pig', 'chicken', 'duck'];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  spawnMob(type, x, y, z, profession = null, biome = 'Plains') {
    const def = MOB_TYPES[type];
    if (!def) return null;
    const prof = type === 'villager'
      ? (profession || VILLAGER_PROFESSIONS[Math.floor(Math.random() * VILLAGER_PROFESSIONS.length)])
      : null;
    const { group, legs, wings, tail, bodyMat, headMat, baseColor, label } = createMobMesh(type, { profession: prof, biome });
    group.position.set(x, y, z);
    this.group.add(group);

    const mob = {
      type,
      def,
      label,
      profession: prof ? prof.name : null,
      baseColor,
      mesh: group,
      legs,
      wings,
      tail,
      bodyMat,
      headMat,
      pos: new THREE.Vector3(x, y, z),
      homePos: new THREE.Vector3(x, y, z),
      vel: new THREE.Vector3(),
      yaw: Math.random() * Math.PI * 2,
      hp: def.hp,
      maxHp: def.hp,
      walkPhase: Math.random() * 6,
      aiTimer: 1 + Math.random() * 3,
      wanderDir: Math.random() * Math.PI * 2,
      moving: true,
      hurtFlash: 0,
      attackCd: 0,
      fleeTimer: 0,
      fuseTimer: 0,
      orbitRadius: 10 + Math.random() * 14,
      orbitAngle: Math.random() * Math.PI * 2,
      cruiseY: y
    };
    this.mobs.push(mob);
    return mob;
  }

  spawnDrop(itemId, count, x, y, z) {
    if (!itemId || count <= 0) return;
    const mat = new THREE.MeshLambertMaterial({ color: this.getDropColor(itemId) });
    const mesh = new THREE.Mesh(this.dropGeo, mat);
    mesh.position.set(x, y + 0.3, z);
    this.group.add(mesh);

    this.drops.push({
      id: itemId,
      count,
      mesh,
      pos: new THREE.Vector3(x, y + 0.3, z),
      vel: new THREE.Vector3((Math.random() - 0.5) * 2.2, 3.2, (Math.random() - 0.5) * 2.2),
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
    if (id.includes('pork') || id.includes('beef') || id.includes('apple')) return 0xe05555;
    return 0xe6e6e6;
  }

  raycastMob(origin, dir, maxDist = 4.2) {
    let best = null;
    let bestDist = maxDist;
    const toMob = new THREE.Vector3();

    for (const mob of this.mobs) {
      const center = mob.pos.clone().add(new THREE.Vector3(0, mob.def.size[1] * 0.5, 0));
      toMob.subVectors(center, origin);
      const proj = toMob.dot(dir);
      if (proj < 0 || proj > bestDist) continue;
      const perpSq = toMob.lengthSq() - proj * proj;
      const rad = Math.max(mob.def.size[0], mob.def.size[2]) * 0.65;
      if (perpSq <= rad * rad) {
        bestDist = proj;
        best = mob;
      }
    }
    return best;
  }

  hitMob(mob, damage, knockDir, player) {
    mob.hp -= damage;
    mob.hurtFlash = 0.22;
    mob.vel.x = knockDir.x * 5.2;
    mob.vel.z = knockDir.z * 5.2;
    mob.vel.y = 4.2;
    if (!mob.def.hostile) mob.fleeTimer = 5.0;
    this.sound.playHurt();

    if (mob.hp <= 0) {
      for (const dropId of mob.def.drop) {
        this.spawnDrop(dropId, 1, mob.pos.x, mob.pos.y + 0.4, mob.pos.z);
      }
      if (player) player.addXP(mob.def.xp || 2);
      this.removeMob(mob);
      return true;
    }
    return false;
  }

  removeMob(mob) {
    const idx = this.mobs.indexOf(mob);
    if (idx !== -1) this.mobs.splice(idx, 1);
    this.group.remove(mob.mesh);
  }

  update(dt, player, sky, onExplosion, mods = null) {
    if (!this.initialPopulated) {
      this.populateInitialWildlife(player.pos);
    }

    // Subtle nature bird-chirp ambience during clear daytime!
    this.ambienceTimer -= dt;
    if (this.ambienceTimer <= 0) {
      this.ambienceTimer = 7 + Math.random() * 11;
      if (!sky.isNight() && sky.weather === 'clear' && this.sound.playBirdChirp) {
        const hasBirds = this.mobs.some((m) => m.type === 'bird');
        if (hasBirds) this.sound.playBirdChirp();
      }
    }

    // 0. Spawn Villagers & Iron Golems in discovered villages!
    for (const v of this.world.villageChunks.values()) {
      if (!v.spawned) {
        const d = Math.hypot(player.pos.x - v.x, player.pos.z - v.z);
        if (d < 72) {
          v.spawned = true;
          this.spawnMob('villager', v.x - 1.5, v.y, v.z + 1.5, VILLAGER_PROFESSIONS[0]);
          this.spawnMob('villager', v.x + 1.5, v.y, v.z - 1.5, VILLAGER_PROFESSIONS[1]);
          this.spawnMob('villager', v.x - 0.5, v.y, v.z - 2.0, VILLAGER_PROFESSIONS[2]);
          this.spawnMob('iron_golem', v.x + 0.5, v.y, v.z + 0.5);
        }
      }
    }

    // 1. Dynamic Biome-Aware Wildlife & Hostile Spawning
    const maxMobs = (mods && mods.isEnabled('more_mobs')) ? 48 : 32;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = (mods && mods.isEnabled('more_mobs')) ? 1.5 : 2.6;
      if (this.mobs.length < maxMobs) {
        const isNight = sky.isNight();
        const birdCount = this.mobs.filter((m) => m.type === 'bird').length;

        if (!isNight && birdCount < 5 && Math.random() < 0.25) {
          const ang = Math.random() * Math.PI * 2;
          const dist = 16 + Math.random() * 22;
          const bx = player.pos.x + Math.cos(ang) * dist;
          const bz = player.pos.z + Math.sin(ang) * dist;
          const by = Math.max(player.pos.y + 8, this.world.getSurfaceY(bx, bz) + 9 + Math.random() * 10);
          this.spawnMob('bird', bx, by, bz);
        } else {
          const angle = Math.random() * Math.PI * 2;
          const dist = 14 + Math.random() * 24;
          const sx = Math.floor(player.pos.x + Math.cos(angle) * dist);
          const sz = Math.floor(player.pos.z + Math.sin(angle) * dist);
          const sy = this.world.getSurfaceY(sx, sz);
          const ground = this.world.getBlock(sx, sy - 1, sz);
          const biome = this.world.getBiomeAt(sx, sz);

          if (ground === BLOCK.WATER) {
            const waterMobs = this.mobs.filter((m) => m.type === 'fish' || m.type === 'duck').length;
            if (waterMobs < 8) {
              if (Math.random() < 0.65) {
                this.spawnMob('fish', sx + 0.5, sy - 1.5, sz + 0.5, null, biome);
              } else {
                this.spawnMob('duck', sx + 0.5, sy - 0.12, sz + 0.5, null, biome);
              }
            }
          } else if (ground !== BLOCK.AIR) {
            if (isNight && player.mode === 'survival') {
              const pool = ['zombie', 'skeleton', 'creeper'];
              this.spawnMob(pool[Math.floor(Math.random() * pool.length)], sx + 0.5, sy, sz + 0.5);
            } else if (ground === BLOCK.GRASS || ground === BLOCK.SNOW || ground === BLOCK.SAND) {
              const type = this.pickWildlifeForBiome(biome, ground);
              if (type === 'butterfly' && isNight) {
                // Skip butterflies at night
              } else {
                this.spawnMob(type, sx + 0.5, type === 'butterfly' ? sy + 1.2 : sy, sz + 0.5, null, biome);
              }
            }
          }
        }
      }
    }

    // 2. Update All Mobs & Wildlife
    const nowSec = performance.now() * 0.001;
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      const distToPlayer = m.pos.distanceTo(player.pos);

      const despawnDist = (m.def.villager || m.def.golem) ? 115 : 74;
      if (distToPlayer > despawnDist || m.pos.y < -5) {
        this.removeMob(m);
        continue;
      }

      // Hurt flash tint
      if (m.hurtFlash > 0) {
        m.hurtFlash -= dt;
        m.bodyMat.color.setHex(m.hurtFlash > 0 ? 0xff4444 : (m.baseColor ?? m.def.color));
      }

      // --- A. FLYING SONGBIRDS ---
      if (m.def.flying) {
        m.orbitAngle += dt * (m.def.speed / m.orbitRadius);
        // Gently shift orbit center toward player if player walks far
        m.homePos.x = THREE.MathUtils.lerp(m.homePos.x, player.pos.x, dt * 0.03);
        m.homePos.z = THREE.MathUtils.lerp(m.homePos.z, player.pos.z, dt * 0.03);

        const targetX = m.homePos.x + Math.cos(m.orbitAngle) * m.orbitRadius;
        const targetZ = m.homePos.z + Math.sin(m.orbitAngle) * m.orbitRadius;
        const groundY = this.world.getSurfaceY(targetX, targetZ);
        const targetY = Math.max(groundY + 7.5, m.cruiseY + Math.sin(nowSec * 1.4 + m.walkPhase) * 2.2);

        const dx = targetX - m.pos.x;
        const dz = targetZ - m.pos.z;
        m.yaw = Math.atan2(dx, dz);
        m.pos.x = THREE.MathUtils.lerp(m.pos.x, targetX, Math.min(1, dt * 2.2));
        m.pos.z = THREE.MathUtils.lerp(m.pos.z, targetZ, Math.min(1, dt * 2.2));
        m.pos.y = THREE.MathUtils.lerp(m.pos.y, targetY, Math.min(1, dt * 1.6));

        m.mesh.position.copy(m.pos);
        m.mesh.rotation.y = m.yaw;
        m.mesh.rotation.z = Math.sin(m.orbitAngle) * 0.16; // gentle bank turn
        const flap = Math.sin(nowSec * 15 + m.walkPhase) * 0.65;
        if (m.wings.length === 2) {
          m.wings[0].rotation.z = flap;
          m.wings[1].rotation.z = -flap;
        }
        continue;
      }

      // --- B. FLUTTERING BUTTERFLIES ---
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
        if (!isBlockSolid(this.world.getBlock(nx, m.pos.y, nz))) {
          m.pos.x = nx;
          m.pos.z = nz;
        } else {
          m.wanderDir += Math.PI * 0.8;
        }
        const groundY = this.world.getSurfaceY(m.pos.x, m.pos.z);
        const targetY = groundY + 1.15 + Math.sin(nowSec * 3.8 + m.walkPhase) * 0.45;
        m.pos.y = THREE.MathUtils.lerp(m.pos.y, targetY, Math.min(1, dt * 4));
        m.mesh.position.copy(m.pos);
        m.mesh.rotation.y = m.wanderDir;
        const flap = Math.sin(nowSec * 28 + m.walkPhase) * 1.05;
        if (m.wings.length === 2) {
          m.wings[0].rotation.z = flap;
          m.wings[1].rotation.z = -flap;
        }
        continue;
      }

      // --- C. AQUATIC SWIMMING FISH ---
      if (m.def.aquatic) {
        m.aiTimer -= dt;
        if (m.aiTimer <= 0) {
          m.aiTimer = 1.5 + Math.random() * 3.0;
          m.wanderDir += (Math.random() - 0.5) * 1.8;
        }
        const nx = m.pos.x + Math.sin(m.wanderDir) * m.def.speed * dt;
        const nz = m.pos.z + Math.cos(m.wanderDir) * m.def.speed * dt;
        const nextBlk = this.world.getBlock(nx, m.pos.y, nz);
        if (isBlockLiquid(nextBlk)) {
          m.pos.x = nx;
          m.pos.z = nz;
        } else {
          m.wanderDir += Math.PI * 0.75 + (Math.random() - 0.5) * 0.6;
        }
        // Keep safely submerged inside water column
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

      // Daylight burn for undead
      if (m.def.burnsInDay && !sky.isNight() && sky.weather === 'clear') {
        m.hp -= dt * 2.5;
        m.hurtFlash = 0.15;
        if (m.hp <= 0) {
          this.removeMob(m);
          continue;
        }
      }

      m.attackCd = Math.max(0, m.attackCd - dt);

      // Shy wildlife (deer, foxes, bunnies) gently dart away if player sprints very close!
      if (m.def.shy && distToPlayer < 4.5 && player.sprinting && m.fleeTimer <= 0) {
        m.fleeTimer = 2.6;
      }

      // AI Movement
      let moveX = 0, moveZ = 0;
      if (m.def.hostile && player.mode === 'survival' && !player.dead && distToPlayer < 18) {
        const dx = player.pos.x - m.pos.x;
        const dz = player.pos.z - m.pos.z;
        m.yaw = Math.atan2(dx, dz);

        if (m.def.creeper && distToPlayer < 3.0) {
          m.fuseTimer += dt;
          const pulse = Math.sin(m.fuseTimer * 26) > 0;
          m.bodyMat.color.setHex(pulse ? 0xffffff : m.def.color);
          if (m.fuseTimer >= 1.35) {
            if (onExplosion) onExplosion(m.pos.x, m.pos.y + 0.8, m.pos.z, 3.0);
            this.removeMob(m);
            continue;
          }
        } else {
          m.fuseTimer = Math.max(0, m.fuseTimer - dt);
          if (distToPlayer > 1.35) {
            moveX = Math.sin(m.yaw) * m.def.speed;
            moveZ = Math.cos(m.yaw) * m.def.speed;
          } else if (m.attackCd <= 0 && !m.def.creeper) {
            m.attackCd = 1.1;
            player.takeDamage(m.def.dmg || 3, `Slain by ${m.type}`);
          }
        }
      } else {
        m.aiTimer -= dt;
        if (m.fleeTimer > 0) {
          m.fleeTimer -= dt;
          const dx = m.pos.x - player.pos.x;
          const dz = m.pos.z - player.pos.z;
          m.yaw = Math.atan2(dx, dz);
          moveX = Math.sin(m.yaw) * m.def.speed * 1.45;
          moveZ = Math.cos(m.yaw) * m.def.speed * 1.45;
        } else {
          if (m.aiTimer <= 0) {
            m.aiTimer = 2 + Math.random() * 4;
            m.moving = Math.random() > 0.35;
            m.wanderDir = Math.random() * Math.PI * 2;
          }
          if (m.moving) {
            if (m.def.villager && m.pos.distanceTo(m.homePos) > 10) {
              m.wanderDir = Math.atan2(m.homePos.x - m.pos.x, m.homePos.z - m.pos.z);
            }
            m.yaw = m.wanderDir;
            moveX = Math.sin(m.yaw) * m.def.speed * 0.65;
            moveZ = Math.cos(m.yaw) * m.def.speed * 0.65;
          } else if (m.def.villager && distToPlayer < 5.5) {
            m.yaw = Math.atan2(player.pos.x - m.pos.x, player.pos.z - m.pos.z);
          }
        }
      }

      // Gravity & Water Buoyancy (ducks & turtles glide nicely on top of water!)
      const inWater = isBlockLiquid(this.world.getBlock(m.pos.x, m.pos.y + 0.15, m.pos.z));
      if (m.def.floatsOnWater && inWater) {
        const surfaceY = Math.floor(m.pos.y + 0.15) + 0.72;
        m.vel.y = (surfaceY - m.pos.y) * 5.0;
      } else {
        m.vel.y -= (inWater ? 6 : 22) * dt;
        if (inWater) m.vel.y = Math.max(m.vel.y, 1.8);
      }

      // Bouncy rabbit hops!
      const speedMag = Math.hypot(moveX, moveZ);
      if (m.def.hopper && speedMag > 0.4 && m.vel.y === 0 && !inWater && Math.random() < dt * 4.5) {
        m.vel.y = 5.6;
      }

      // Horizontal step + auto-jump over 1-block ledges
      m.vel.x = THREE.MathUtils.lerp(m.vel.x, moveX, Math.min(1, dt * 8));
      m.vel.z = THREE.MathUtils.lerp(m.vel.z, moveZ, Math.min(1, dt * 8));

      const nx = m.pos.x + m.vel.x * dt;
      const nz = m.pos.z + m.vel.z * dt;
      const blocked = isBlockSolid(this.world.getBlock(nx, m.pos.y + 0.3, nz));
      if (!blocked) {
        m.pos.x = nx;
        m.pos.z = nz;
      } else {
        if (!isBlockSolid(this.world.getBlock(nx, m.pos.y + 1.3, nz)) && m.vel.y <= 0.1) {
          m.vel.y = 7.4;
        } else {
          m.wanderDir += Math.PI * 0.7;
        }
      }

      // Vertical ground collision
      const ny = m.pos.y + m.vel.y * dt;
      if (m.vel.y <= 0 && isBlockSolid(this.world.getBlock(m.pos.x, ny, m.pos.z))) {
        m.pos.y = Math.floor(ny) + 1;
        m.vel.y = 0;
      } else {
        m.pos.y = ny;
      }

      // Apply transform + limb/tail/wing animations
      m.mesh.position.copy(m.pos);
      m.mesh.rotation.y = m.yaw;
      if (speedMag > 0.1) {
        m.walkPhase += dt * speedMag * 3.6;
        m.legs.forEach((leg, idx) => {
          leg.rotation.x = Math.sin(m.walkPhase + (idx % 2 === 0 ? 0 : Math.PI)) * 0.62;
        });
      } else {
        m.legs.forEach((leg) => (leg.rotation.x *= 0.85));
      }
      if (m.tail && (m.type === 'fox' || m.type === 'wolf')) {
        m.tail.rotation.y = Math.sin(nowSec * (speedMag > 0.2 ? 9 : 4) + m.walkPhase) * 0.28;
      }
      if (m.wings.length === 2 && m.type === 'duck') {
        const duckFlap = inWater ? Math.sin(nowSec * 4 + m.walkPhase) * 0.08 : (speedMag > 0.2 ? Math.sin(m.walkPhase * 1.5) * 0.2 : 0);
        m.wings[0].rotation.z = duckFlap;
        m.wings[1].rotation.z = -duckFlap;
      }
    }

    // 3. Update Dropped Items
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.age += dt;
      if (d.age > 180) {
        this.group.remove(d.mesh);
        this.drops.splice(i, 1);
        continue;
      }

      d.vel.y -= 18 * dt;
      d.pos.x += d.vel.x * dt;
      d.pos.z += d.vel.z * dt;
      d.vel.x *= 0.9;
      d.vel.z *= 0.9;

      const ny = d.pos.y + d.vel.y * dt;
      if (d.vel.y < 0 && isBlockSolid(this.world.getBlock(d.pos.x, ny - 0.18, d.pos.z))) {
        d.pos.y = Math.floor(ny - 0.18) + 1.18;
        d.vel.y = 0;
      } else {
        d.pos.y = ny;
      }

      const toPlayer = new THREE.Vector3(player.pos.x, player.pos.y + 0.9, player.pos.z).sub(d.pos);
      const dist = toPlayer.length();
      if (dist < 2.6 && d.age > 0.25) {
        d.pos.addScaledVector(toPlayer.normalize(), dt * 7.5);
      }
      if (dist < 0.85 && d.age > 0.2) {
        if (player.inventory.addItem(d.id, d.count)) {
          this.sound.playPop();
          this.group.remove(d.mesh);
          this.drops.splice(i, 1);
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
    this.initialPopulated = false;
  }
}
