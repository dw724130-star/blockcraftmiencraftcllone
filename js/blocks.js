// Complete Block & Item Registry

export const BLOCK = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  COBBLESTONE: 4,
  BEDROCK: 5,
  SAND: 6,
  SANDSTONE: 7,
  GRAVEL: 8,
  WATER: 9,
  OAK_LOG: 10,
  OAK_LEAVES: 11,
  OAK_PLANKS: 12,
  BIRCH_LOG: 13,
  BIRCH_LEAVES: 14,
  BIRCH_PLANKS: 15,
  SPRUCE_LOG: 16,
  SPRUCE_LEAVES: 17,
  SPRUCE_PLANKS: 18,
  CACTUS: 19,
  SNOW: 20,
  ICE: 21,
  COAL_ORE: 22,
  IRON_ORE: 23,
  GOLD_ORE: 24,
  DIAMOND_ORE: 25,
  CRAFTING_TABLE: 26,
  FURNACE: 27,
  CHEST: 28,
  GLASS: 29,
  BRICKS: 30,
  TNT: 31,
  TORCH: 32,
  BOOKSHELF: 33,
  WOOL_WHITE: 34,
  WOOL_RED: 35,
  WOOL_BLUE: 36,
  WOOL_GREEN: 37,
  WOOL_YELLOW: 38,
  OBSIDIAN: 39,
  GLOWSTONE: 40,
  TALL_GRASS: 41,
  FLOWER_RED: 42,
  FLOWER_YELLOW: 43,
  BED: 44,          // Foot half facing North (-Z) (partner head at z - 1)
  STONE_BRICKS: 45,
  IRON_BLOCK: 46,
  GOLD_BLOCK: 47,
  DIAMOND_BLOCK: 48,
  LADDER: 49,
  FARMLAND: 50,
  BED_HEAD_N: 51,   // Head half facing North (-Z) (partner foot at z + 1)
  BED_FOOT_S: 52,   // Foot half facing South (+Z) (partner head at z + 1)
  BED_HEAD_S: 53,   // Head half facing South (+Z) (partner foot at z - 1)
  BED_FOOT_E: 54,   // Foot half facing East (+X) (partner head at x + 1)
  BED_HEAD_E: 55,   // Head half facing East (+X) (partner foot at x - 1)
  BED_FOOT_W: 56,   // Foot half facing West (-X) (partner head at x - 1)
  BED_HEAD_W: 57    // Head half facing West (-X) (partner foot at x + 1)
};

// Block numeric ID -> string item key
export const BLOCK_TO_KEY = {};
export const KEY_TO_BLOCK = {};

// Full item & block metadata dictionary keyed by string ID
export const ITEMS = {};

function regBlock(id, key, props) {
  BLOCK_TO_KEY[id] = key;
  KEY_TO_BLOCK[key] = id;
  ITEMS[key] = {
    id: key,
    blockId: id,
    isBlock: true,
    stackSize: 64,
    solid: true,
    transparent: false,
    liquid: false,
    cross: false,
    light: 0,
    hardness: 1.0,
    tool: null, // 'pickaxe' | 'axe' | 'shovel' | null
    minTier: 0, // 0=hand, 1=wood, 2=stone, 3=iron, 4=diamond
    sound: 'stone',
    drop: key,
    dropCount: 1,
    ...props
  };
}

function regItem(key, props) {
  ITEMS[key] = {
    id: key,
    blockId: null,
    isBlock: false,
    stackSize: 64,
    ...props
  };
}

// --- BLOCKS ---
regBlock(BLOCK.GRASS, 'grass', { name: 'Grass Block', hardness: 0.7, tool: 'shovel', sound: 'grass', drop: 'dirt', faces: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' } });
regBlock(BLOCK.DIRT, 'dirt', { name: 'Dirt', hardness: 0.6, tool: 'shovel', sound: 'dirt', faces: { all: 'dirt' } });
regBlock(BLOCK.STONE, 'stone', { name: 'Stone', hardness: 2.2, tool: 'pickaxe', minTier: 1, sound: 'stone', drop: 'cobblestone', faces: { all: 'stone' } });
regBlock(BLOCK.COBBLESTONE, 'cobblestone', { name: 'Cobblestone', hardness: 2.4, tool: 'pickaxe', minTier: 1, sound: 'stone', faces: { all: 'cobblestone' } });
regBlock(BLOCK.BEDROCK, 'bedrock', { name: 'Bedrock', hardness: -1, sound: 'stone', drop: null, faces: { all: 'bedrock' } });
regBlock(BLOCK.SAND, 'sand', { name: 'Sand', hardness: 0.6, tool: 'shovel', sound: 'sand', faces: { all: 'sand' } });
regBlock(BLOCK.SANDSTONE, 'sandstone', { name: 'Sandstone', hardness: 1.6, tool: 'pickaxe', minTier: 1, sound: 'stone', faces: { top: 'sandstone_top', side: 'sandstone_side', bottom: 'sandstone_top' } });
regBlock(BLOCK.GRAVEL, 'gravel', { name: 'Gravel', hardness: 0.7, tool: 'shovel', sound: 'sand', faces: { all: 'gravel' } });
regBlock(BLOCK.WATER, 'water', { name: 'Water', solid: false, transparent: true, liquid: true, hardness: -1, sound: 'water', drop: null, faces: { all: 'water' } });

regBlock(BLOCK.OAK_LOG, 'oak_log', { name: 'Oak Log', hardness: 1.8, tool: 'axe', sound: 'wood', faces: { top: 'oak_log_top', side: 'oak_log_side', bottom: 'oak_log_top' } });
regBlock(BLOCK.OAK_LEAVES, 'oak_leaves', { name: 'Oak Leaves', hardness: 0.35, transparent: true, sound: 'grass', drop: 'oak_leaves', faces: { all: 'oak_leaves' } });
regBlock(BLOCK.OAK_PLANKS, 'oak_planks', { name: 'Oak Planks', hardness: 1.5, tool: 'axe', sound: 'wood', faces: { all: 'oak_planks' } });

regBlock(BLOCK.BIRCH_LOG, 'birch_log', { name: 'Birch Log', hardness: 1.8, tool: 'axe', sound: 'wood', faces: { top: 'birch_log_top', side: 'birch_log_side', bottom: 'birch_log_top' } });
regBlock(BLOCK.BIRCH_LEAVES, 'birch_leaves', { name: 'Birch Leaves', hardness: 0.35, transparent: true, sound: 'grass', drop: 'birch_leaves', faces: { all: 'birch_leaves' } });
regBlock(BLOCK.BIRCH_PLANKS, 'birch_planks', { name: 'Birch Planks', hardness: 1.5, tool: 'axe', sound: 'wood', faces: { all: 'birch_planks' } });

regBlock(BLOCK.SPRUCE_LOG, 'spruce_log', { name: 'Spruce Log', hardness: 1.8, tool: 'axe', sound: 'wood', faces: { top: 'spruce_log_top', side: 'spruce_log_side', bottom: 'spruce_log_top' } });
regBlock(BLOCK.SPRUCE_LEAVES, 'spruce_leaves', { name: 'Spruce Leaves', hardness: 0.35, transparent: true, sound: 'grass', drop: 'spruce_leaves', faces: { all: 'spruce_leaves' } });
regBlock(BLOCK.SPRUCE_PLANKS, 'spruce_planks', { name: 'Spruce Planks', hardness: 1.5, tool: 'axe', sound: 'wood', faces: { all: 'spruce_planks' } });

regBlock(BLOCK.CACTUS, 'cactus', { name: 'Cactus', hardness: 0.6, sound: 'grass', faces: { top: 'cactus_top', side: 'cactus_side', bottom: 'cactus_top' } });
regBlock(BLOCK.SNOW, 'snow', { name: 'Snow Block', hardness: 0.5, tool: 'shovel', sound: 'sand', faces: { all: 'snow' } });
regBlock(BLOCK.ICE, 'ice', { name: 'Ice', hardness: 0.8, transparent: true, tool: 'pickaxe', sound: 'glass', faces: { all: 'ice' } });

regBlock(BLOCK.COAL_ORE, 'coal_ore', { name: 'Coal Ore', hardness: 2.8, tool: 'pickaxe', minTier: 1, sound: 'stone', drop: 'coal', dropCount: 1, xp: 2, faces: { all: 'coal_ore' } });
regBlock(BLOCK.IRON_ORE, 'iron_ore', { name: 'Iron Ore', hardness: 3.2, tool: 'pickaxe', minTier: 2, sound: 'stone', drop: 'raw_iron', dropCount: 1, xp: 3, faces: { all: 'iron_ore' } });
regBlock(BLOCK.GOLD_ORE, 'gold_ore', { name: 'Gold Ore', hardness: 3.5, tool: 'pickaxe', minTier: 3, sound: 'stone', drop: 'gold_ore', dropCount: 1, xp: 5, faces: { all: 'gold_ore' } });
regBlock(BLOCK.DIAMOND_ORE, 'diamond_ore', { name: 'Diamond Ore', hardness: 4.5, tool: 'pickaxe', minTier: 3, sound: 'stone', drop: 'diamond', dropCount: 1, xp: 10, faces: { all: 'diamond_ore' } });

regBlock(BLOCK.CRAFTING_TABLE, 'crafting_table', { name: 'Crafting Table', hardness: 1.6, tool: 'axe', sound: 'wood', interactive: 'crafting_table', faces: { top: 'craft_top', side: 'craft_side', bottom: 'oak_planks' } });
regBlock(BLOCK.FURNACE, 'furnace', { name: 'Furnace', hardness: 2.6, tool: 'pickaxe', minTier: 1, sound: 'stone', interactive: 'furnace', faces: { top: 'furnace_top', side: 'furnace_front', bottom: 'furnace_top' } });
regBlock(BLOCK.CHEST, 'chest', { name: 'Chest', hardness: 1.8, tool: 'axe', sound: 'wood', interactive: 'chest', faces: { top: 'chest_top', side: 'chest_front', bottom: 'chest_top' } });

regBlock(BLOCK.GLASS, 'glass', { name: 'Glass', hardness: 0.5, transparent: true, sound: 'glass', faces: { all: 'glass' } });
regBlock(BLOCK.BRICKS, 'bricks', { name: 'Bricks', hardness: 2.2, tool: 'pickaxe', minTier: 1, sound: 'stone', faces: { all: 'bricks' } });
regBlock(BLOCK.TNT, 'tnt', { name: 'TNT', hardness: 0.3, sound: 'grass', interactive: 'tnt', faces: { top: 'tnt_top', side: 'tnt_side', bottom: 'tnt_top' } });
regBlock(BLOCK.TORCH, 'torch', { name: 'Torch', solid: false, transparent: true, cross: true, light: 14, hardness: 0.1, sound: 'wood', faces: { all: 'torch' } });
regBlock(BLOCK.BOOKSHELF, 'bookshelf', { name: 'Bookshelf', hardness: 1.4, tool: 'axe', sound: 'wood', faces: { top: 'oak_planks', side: 'bookshelf', bottom: 'oak_planks' } });

regBlock(BLOCK.WOOL_WHITE, 'wool_white', { name: 'White Wool', hardness: 0.7, sound: 'grass', faces: { all: 'wool_white' } });
regBlock(BLOCK.WOOL_RED, 'wool_red', { name: 'Red Wool', hardness: 0.7, sound: 'grass', faces: { all: 'wool_red' } });
regBlock(BLOCK.WOOL_BLUE, 'wool_blue', { name: 'Blue Wool', hardness: 0.7, sound: 'grass', faces: { all: 'wool_blue' } });
regBlock(BLOCK.WOOL_GREEN, 'wool_green', { name: 'Green Wool', hardness: 0.7, sound: 'grass', faces: { all: 'wool_green' } });
regBlock(BLOCK.WOOL_YELLOW, 'wool_yellow', { name: 'Yellow Wool', hardness: 0.7, sound: 'grass', faces: { all: 'wool_yellow' } });

regBlock(BLOCK.OBSIDIAN, 'obsidian', { name: 'Obsidian', hardness: 8.0, tool: 'pickaxe', minTier: 4, sound: 'stone', faces: { all: 'obsidian' } });
regBlock(BLOCK.GLOWSTONE, 'glowstone', { name: 'Glowstone', hardness: 0.6, light: 15, sound: 'glass', faces: { all: 'glowstone' } });

regBlock(BLOCK.TALL_GRASS, 'tall_grass', { name: 'Tall Grass', solid: false, transparent: true, cross: true, hardness: 0.05, sound: 'grass', drop: 'wheat', dropChance: 0.35, faces: { all: 'tall_grass' } });
regBlock(BLOCK.FLOWER_RED, 'flower_red', { name: 'Poppy', solid: false, transparent: true, cross: true, hardness: 0.05, sound: 'grass', faces: { all: 'flower_red' } });
regBlock(BLOCK.FLOWER_YELLOW, 'flower_yellow', { name: 'Dandelion', solid: false, transparent: true, cross: true, hardness: 0.05, sound: 'grass', faces: { all: 'flower_yellow' } });

regBlock(BLOCK.BED, 'bed', { name: 'Red Bed', hardness: 0.6, transparent: true, sound: 'wood', interactive: 'bed', faces: { top: 'bed_top', side: 'bed_side', bottom: 'oak_planks' } });
regBlock(BLOCK.BED_HEAD_N, 'bed_head_n', { name: 'Red Bed', hardness: 0.6, transparent: true, sound: 'wood', interactive: 'bed', drop: 'bed', hiddenFromCreative: true, faces: { top: 'bed_top', side: 'bed_side', bottom: 'oak_planks' } });
regBlock(BLOCK.BED_FOOT_S, 'bed_foot_s', { name: 'Red Bed', hardness: 0.6, transparent: true, sound: 'wood', interactive: 'bed', drop: 'bed', hiddenFromCreative: true, faces: { top: 'bed_top', side: 'bed_side', bottom: 'oak_planks' } });
regBlock(BLOCK.BED_HEAD_S, 'bed_head_s', { name: 'Red Bed', hardness: 0.6, transparent: true, sound: 'wood', interactive: 'bed', drop: 'bed', hiddenFromCreative: true, faces: { top: 'bed_top', side: 'bed_side', bottom: 'oak_planks' } });
regBlock(BLOCK.BED_FOOT_E, 'bed_foot_e', { name: 'Red Bed', hardness: 0.6, transparent: true, sound: 'wood', interactive: 'bed', drop: 'bed', hiddenFromCreative: true, faces: { top: 'bed_top', side: 'bed_side', bottom: 'oak_planks' } });
regBlock(BLOCK.BED_HEAD_E, 'bed_head_e', { name: 'Red Bed', hardness: 0.6, transparent: true, sound: 'wood', interactive: 'bed', drop: 'bed', hiddenFromCreative: true, faces: { top: 'bed_top', side: 'bed_side', bottom: 'oak_planks' } });
regBlock(BLOCK.BED_FOOT_W, 'bed_foot_w', { name: 'Red Bed', hardness: 0.6, transparent: true, sound: 'wood', interactive: 'bed', drop: 'bed', hiddenFromCreative: true, faces: { top: 'bed_top', side: 'bed_side', bottom: 'oak_planks' } });
regBlock(BLOCK.BED_HEAD_W, 'bed_head_w', { name: 'Red Bed', hardness: 0.6, transparent: true, sound: 'wood', interactive: 'bed', drop: 'bed', hiddenFromCreative: true, faces: { top: 'bed_top', side: 'bed_side', bottom: 'oak_planks' } });
regBlock(BLOCK.STONE_BRICKS, 'stone_bricks', { name: 'Stone Bricks', hardness: 2.3, tool: 'pickaxe', minTier: 1, sound: 'stone', faces: { all: 'stone_bricks' } });
regBlock(BLOCK.IRON_BLOCK, 'iron_block', { name: 'Block of Iron', hardness: 3.8, tool: 'pickaxe', minTier: 2, sound: 'stone', faces: { all: 'iron_block' } });
regBlock(BLOCK.GOLD_BLOCK, 'gold_block', { name: 'Block of Gold', hardness: 3.4, tool: 'pickaxe', minTier: 3, sound: 'stone', faces: { all: 'gold_block' } });
regBlock(BLOCK.DIAMOND_BLOCK, 'diamond_block', { name: 'Block of Diamond', hardness: 4.8, tool: 'pickaxe', minTier: 3, sound: 'stone', faces: { all: 'diamond_block' } });
regBlock(BLOCK.LADDER, 'ladder', { name: 'Ladder', solid: false, transparent: true, cross: true, climbable: true, hardness: 0.5, tool: 'axe', sound: 'wood', faces: { all: 'ladder' } });
regBlock(BLOCK.FARMLAND, 'farmland', { name: 'Farmland', hardness: 0.6, tool: 'shovel', sound: 'dirt', drop: 'dirt', faces: { top: 'farmland_top', side: 'dirt', bottom: 'dirt' } });

// --- MATERIALS & FOOD ---
regItem('stick', { name: 'Stick', icon: 'stick' });
regItem('coal', { name: 'Coal', icon: 'coal', fuel: 80 });
regItem('raw_iron', { name: 'Raw Iron', icon: 'raw_iron' });
regItem('iron_ingot', { name: 'Iron Ingot', icon: 'iron_ingot' });
regItem('gold_ingot', { name: 'Gold Ingot', icon: 'gold_ingot' });
regItem('diamond', { name: 'Diamond', icon: 'diamond' });
regItem('emerald', { name: 'Emerald', icon: 'emerald' });
regItem('gunpowder', { name: 'Gunpowder', icon: 'gunpowder' });
regItem('bone', { name: 'Bone', icon: 'bone' });
regItem('leather', { name: 'Leather', icon: 'leather' });
regItem('feather', { name: 'Feather', icon: 'feather' });
regItem('wheat', { name: 'Wheat', icon: 'wheat' });

regItem('apple', { name: 'Apple', icon: 'apple', food: 4 });
regItem('bread', { name: 'Bread', icon: 'bread', food: 6 });
regItem('raw_porkchop', { name: 'Raw Porkchop', icon: 'raw_porkchop', food: 3 });
regItem('cooked_porkchop', { name: 'Cooked Porkchop', icon: 'cooked_porkchop', food: 8 });
regItem('raw_beef', { name: 'Raw Beef', icon: 'raw_beef', food: 3 });
regItem('steak', { name: 'Steak', icon: 'steak', food: 8 });
regItem('raw_chicken', { name: 'Raw Poultry', icon: 'raw_chicken', food: 2 });
regItem('cooked_chicken', { name: 'Roast Poultry', icon: 'cooked_chicken', food: 6 });
regItem('raw_mutton', { name: 'Raw Mutton', icon: 'raw_mutton', food: 2 });
regItem('cooked_mutton', { name: 'Cooked Mutton', icon: 'cooked_mutton', food: 6 });
regItem('raw_venison', { name: 'Raw Venison', icon: 'raw_venison', food: 3 });
regItem('cooked_venison', { name: 'Cooked Venison', icon: 'cooked_venison', food: 8 });
regItem('raw_rabbit', { name: 'Raw Rabbit', icon: 'raw_rabbit', food: 2 });
regItem('cooked_rabbit', { name: 'Cooked Rabbit', icon: 'cooked_rabbit', food: 6 });
regItem('raw_salmon', { name: 'Raw Salmon', icon: 'raw_salmon', food: 2 });
regItem('cooked_salmon', { name: 'Cooked Salmon', icon: 'cooked_salmon', food: 7 });

// --- TOOLS & WEAPONS ---
const TIERS = [
  { key: 'wooden', name: 'Wooden', tier: 1, speed: 2.2, dur: 60, dmg: 1 },
  { key: 'stone', name: 'Stone', tier: 2, speed: 4.0, dur: 132, dmg: 2 },
  { key: 'iron', name: 'Iron', tier: 3, speed: 6.2, dur: 251, dmg: 3 },
  { key: 'diamond', name: 'Diamond', tier: 4, speed: 9.0, dur: 1561, dmg: 4 }
];

for (const t of TIERS) {
  regItem(`${t.key}_pickaxe`, {
    name: `${t.name} Pickaxe`, stackSize: 1, toolType: 'pickaxe', tier: t.tier,
    speed: t.speed, durability: t.dur, damage: 2 + t.dmg, icon: `${t.key}_pickaxe`
  });
  regItem(`${t.key}_axe`, {
    name: `${t.name} Axe`, stackSize: 1, toolType: 'axe', tier: t.tier,
    speed: t.speed, durability: t.dur, damage: 3 + t.dmg, icon: `${t.key}_axe`
  });
  regItem(`${t.key}_shovel`, {
    name: `${t.name} Shovel`, stackSize: 1, toolType: 'shovel', tier: t.tier,
    speed: t.speed, durability: t.dur, damage: 1 + t.dmg, icon: `${t.key}_shovel`
  });
  regItem(`${t.key}_sword`, {
    name: `${t.name} Sword`, stackSize: 1, toolType: 'sword', tier: t.tier,
    speed: 1.5, durability: t.dur, damage: 4 + t.dmg * 1.5, icon: `${t.key}_sword`
  });
}

// --- ARMOR ---
const ARMOR_MATS = [
  { key: 'leather', name: 'Leather', def: [1, 3, 2, 1], dur: 80 },
  { key: 'iron', name: 'Iron', def: [2, 6, 5, 2], dur: 240 },
  { key: 'diamond', name: 'Diamond', def: [3, 8, 6, 3], dur: 520 }
];
const ARMOR_SLOTS = ['helmet', 'chestplate', 'leggings', 'boots'];
const ARMOR_LABELS = ['Helmet', 'Chestplate', 'Leggings', 'Boots'];

for (const m of ARMOR_MATS) {
  for (let i = 0; i < 4; i++) {
    const slot = ARMOR_SLOTS[i];
    regItem(`${m.key}_${slot}`, {
      name: `${m.name} ${ARMOR_LABELS[i]}`,
      stackSize: 1,
      armorSlot: i,
      defense: m.def[i],
      durability: m.dur,
      icon: `${m.key}_${slot}`
    });
  }
}

export function getBlockDef(blockId) {
  const key = BLOCK_TO_KEY[blockId];
  return key ? ITEMS[key] : null;
}

export function isBlockSolid(blockId) {
  if (!blockId) return false;
  const def = getBlockDef(blockId);
  return def ? !!def.solid : false;
}

export function isBlockTransparent(blockId) {
  if (!blockId) return true;
  const def = getBlockDef(blockId);
  return def ? !!def.transparent : true;
}

export function isBlockLiquid(blockId) {
  return blockId === BLOCK.WATER;
}

export function isBlockCross(blockId) {
  if (!blockId) return false;
  const def = getBlockDef(blockId);
  return def ? !!def.cross : false;
}

// 2-Block-Long × 1-Block-Wide Bed Metadata & Orientation Helpers
const BED_META = {
  [BLOCK.BED]:        { isHead: false, dir: 'N', dx: 0, dz: -1, partner: BLOCK.BED_HEAD_N },
  [BLOCK.BED_HEAD_N]: { isHead: true,  dir: 'N', dx: 0, dz: 1,  partner: BLOCK.BED },
  [BLOCK.BED_FOOT_S]: { isHead: false, dir: 'S', dx: 0, dz: 1,  partner: BLOCK.BED_HEAD_S },
  [BLOCK.BED_HEAD_S]: { isHead: true,  dir: 'S', dx: 0, dz: -1, partner: BLOCK.BED_FOOT_S },
  [BLOCK.BED_FOOT_E]: { isHead: false, dir: 'E', dx: 1, dz: 0,  partner: BLOCK.BED_HEAD_E },
  [BLOCK.BED_HEAD_E]: { isHead: true,  dir: 'E', dx: -1, dz: 0, partner: BLOCK.BED_FOOT_E },
  [BLOCK.BED_FOOT_W]: { isHead: false, dir: 'W', dx: -1, dz: 0, partner: BLOCK.BED_HEAD_W },
  [BLOCK.BED_HEAD_W]: { isHead: true,  dir: 'W', dx: 1, dz: 0,  partner: BLOCK.BED_FOOT_W }
};

export function isBedBlock(blockId) {
  return Boolean(BED_META[blockId]);
}

export function getBedInfo(blockId) {
  return BED_META[blockId] || null;
}

export function getBedPairForYaw(yaw) {
  // Forward look direction is (-sin(yaw), -cos(yaw))
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  if (Math.abs(fx) > Math.abs(fz)) {
    return fx > 0
      ? { foot: BLOCK.BED_FOOT_E, head: BLOCK.BED_HEAD_E, dx: 1, dz: 0 }
      : { foot: BLOCK.BED_FOOT_W, head: BLOCK.BED_HEAD_W, dx: -1, dz: 0 };
  }
  return fz > 0
    ? { foot: BLOCK.BED_FOOT_S, head: BLOCK.BED_HEAD_S, dx: 0, dz: 1 }
    : { foot: BLOCK.BED, head: BLOCK.BED_HEAD_N, dx: 0, dz: -1 };
}

export function getItemCategory(def) {
  if (!def) return 'materials';
  if (def.armorSlot !== undefined) return 'armor';
  if (def.toolType) return 'tools';
  if (def.food) return 'food';
  if (!def.isBlock) return 'materials';
  const id = def.id;
  if (['crafting_table', 'furnace', 'chest', 'bed', 'tnt', 'torch', 'bookshelf', 'ladder', 'glowstone', 'glass'].includes(id)) {
    return 'utility';
  }
  if (['grass', 'dirt', 'sand', 'gravel', 'water', 'oak_log', 'oak_leaves', 'birch_log', 'birch_leaves', 'spruce_log', 'spruce_leaves', 'cactus', 'snow', 'ice', 'tall_grass', 'flower_red', 'flower_yellow', 'farmland', 'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore'].includes(id)) {
    return 'nature';
  }
  return 'building';
}
