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
  BED_HEAD_W: 57,   // Head half facing West (-X) (partner foot at x + 1)
  ACACIA_LOG: 58,
  ACACIA_LEAVES: 59,
  ACACIA_PLANKS: 60,
  JUNGLE_LOG: 61,
  JUNGLE_LEAVES: 62,
  JUNGLE_PLANKS: 63,
  CHERRY_LOG: 64,
  CHERRY_LEAVES: 65,
  CHERRY_PLANKS: 66,
  RED_SAND: 67,
  TERRACOTTA: 68,
  TERRACOTTA_RED: 69,
  TERRACOTTA_ORANGE: 70,
  TERRACOTTA_YELLOW: 71,
  MOSSY_COBBLESTONE: 72,
  MUD: 73,
  PACKED_ICE: 74,
  SAVANNA_GRASS: 75,
  JUNGLE_GRASS: 76,
  SWAMP_GRASS: 77,
  LAVA: 78,
  FIRE: 79,
  OAK_DOOR_B: 80,
  OAK_DOOR_T: 81,
  BIRCH_DOOR_B: 82,
  BIRCH_DOOR_T: 83,
  SPRUCE_DOOR_B: 84,
  SPRUCE_DOOR_T: 85,
  ACACIA_DOOR_B: 86,
  ACACIA_DOOR_T: 87,
  JUNGLE_DOOR_B: 88,
  JUNGLE_DOOR_T: 89,
  CHERRY_DOOR_B: 90,
  CHERRY_DOOR_T: 91,
  FARMLAND_WET: 92,
  WHEAT_0: 93,
  WHEAT_1: 94,
  WHEAT_2: 95,
  WHEAT_3: 96,
  WHEAT_4: 97,
  WHEAT_5: 98,
  WHEAT_6: 99,
  WHEAT_7: 100,
  DIRT_PATH: 101,
  OAK_FENCE: 102,
  BIRCH_FENCE: 103,
  SPRUCE_FENCE: 104,
  ACACIA_FENCE: 105,
  JUNGLE_FENCE: 106,
  CHERRY_FENCE: 107,
  OAK_FENCE_GATE: 108,
  BIRCH_FENCE_GATE: 109,
  SPRUCE_FENCE_GATE: 110,
  ACACIA_FENCE_GATE: 111,
  JUNGLE_FENCE_GATE: 112,
  CHERRY_FENCE_GATE: 113,
  // Deepslate + 5 New Stone Blocks
  DEEPSLATE: 114,
  GRANITE: 115,
  DIORITE: 116,
  ANDESITE: 117,
  TUFF: 118,
  BASALT: 119,
  // Stairs for Every Building Material (Wood + Stone + Masonry + Deepslate + New Stones)
  OAK_STAIRS: 120,
  BIRCH_STAIRS: 121,
  SPRUCE_STAIRS: 122,
  ACACIA_STAIRS: 123,
  JUNGLE_STAIRS: 124,
  CHERRY_STAIRS: 125,
  STONE_STAIRS: 126,
  COBBLESTONE_STAIRS: 127,
  MOSSY_COBBLESTONE_STAIRS: 128,
  STONE_BRICK_STAIRS: 129,
  SANDSTONE_STAIRS: 130,
  BRICK_STAIRS: 131,
  DEEPSLATE_STAIRS: 132,
  GRANITE_STAIRS: 133,
  DIORITE_STAIRS: 134,
  ANDESITE_STAIRS: 135,
  TUFF_STAIRS: 136,
  BASALT_STAIRS: 137
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
regBlock(BLOCK.GOLD_ORE, 'gold_ore', { name: 'Gold Ore', hardness: 3.5, tool: 'pickaxe', minTier: 3, sound: 'stone', drop: 'raw_gold', dropCount: 1, xp: 5, faces: { all: 'gold_ore' } });
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

regBlock(BLOCK.TALL_GRASS, 'tall_grass', { name: 'Tall Grass', solid: false, transparent: true, cross: true, hardness: 0.05, sound: 'grass', drop: 'wheat_seeds', dropChance: 0.48, faces: { all: 'tall_grass' } });
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
regBlock(BLOCK.LADDER, 'ladder', { name: 'Ladder', solid: false, transparent: true, cross: false, climbable: true, hardness: 0.5, tool: 'axe', sound: 'wood', faces: { all: 'ladder' } });
regBlock(BLOCK.FARMLAND, 'farmland', { name: 'Farmland', hardness: 0.6, tool: 'shovel', sound: 'dirt', drop: 'dirt', faces: { top: 'farmland_top', side: 'dirt', bottom: 'dirt' } });
regBlock(BLOCK.FARMLAND_WET, 'farmland_wet', { name: 'Hydrated Farmland', hardness: 0.6, tool: 'shovel', sound: 'dirt', drop: 'dirt', hiddenFromCreative: true, faces: { top: 'farmland_wet_top', side: 'dirt', bottom: 'dirt' } });
regBlock(BLOCK.DIRT_PATH, 'dirt_path', { name: 'Dirt Path', hardness: 0.65, tool: 'shovel', sound: 'dirt', drop: 'dirt', faces: { top: 'dirt_path_top', side: 'dirt_path_side', bottom: 'dirt' } });
for (let st = 0; st <= 7; st++) {
  regBlock(BLOCK.WHEAT_0 + st, `wheat_stage_${st}`, {
    name: st === 7 ? 'Ripe Wheat' : 'Wheat Crop',
    solid: false, transparent: true, isCrop: true, wheatStage: st,
    hardness: 0.05, sound: 'grass',
    drop: st === 7 ? 'wheat' : 'wheat_seeds',
    hiddenFromCreative: true,
    faces: { all: `wheat_stage_${st}` }
  });
}

// --- NEW BIOME BLOCKS (Savanna, Jungle, Cherry Grove, Badlands, Swamp, Frozen) ---
regBlock(BLOCK.ACACIA_LOG, 'acacia_log', { name: 'Acacia Log', hardness: 1.8, tool: 'axe', sound: 'wood', faces: { top: 'acacia_log_top', side: 'acacia_log_side', bottom: 'acacia_log_top' } });
regBlock(BLOCK.ACACIA_LEAVES, 'acacia_leaves', { name: 'Acacia Leaves', hardness: 0.35, transparent: true, sound: 'grass', drop: 'acacia_leaves', faces: { all: 'acacia_leaves' } });
regBlock(BLOCK.ACACIA_PLANKS, 'acacia_planks', { name: 'Acacia Planks', hardness: 1.5, tool: 'axe', sound: 'wood', faces: { all: 'acacia_planks' } });

regBlock(BLOCK.JUNGLE_LOG, 'jungle_log', { name: 'Jungle Log', hardness: 1.8, tool: 'axe', sound: 'wood', faces: { top: 'jungle_log_top', side: 'jungle_log_side', bottom: 'jungle_log_top' } });
regBlock(BLOCK.JUNGLE_LEAVES, 'jungle_leaves', { name: 'Jungle Leaves', hardness: 0.35, transparent: true, sound: 'grass', drop: 'jungle_leaves', faces: { all: 'jungle_leaves' } });
regBlock(BLOCK.JUNGLE_PLANKS, 'jungle_planks', { name: 'Jungle Planks', hardness: 1.5, tool: 'axe', sound: 'wood', faces: { all: 'jungle_planks' } });

regBlock(BLOCK.CHERRY_LOG, 'cherry_log', { name: 'Cherry Log', hardness: 1.8, tool: 'axe', sound: 'wood', faces: { top: 'cherry_log_top', side: 'cherry_log_side', bottom: 'cherry_log_top' } });
regBlock(BLOCK.CHERRY_LEAVES, 'cherry_leaves', { name: 'Cherry Leaves', hardness: 0.35, transparent: true, sound: 'grass', drop: 'cherry_leaves', faces: { all: 'cherry_leaves' } });
regBlock(BLOCK.CHERRY_PLANKS, 'cherry_planks', { name: 'Cherry Planks', hardness: 1.5, tool: 'axe', sound: 'wood', faces: { all: 'cherry_planks' } });

regBlock(BLOCK.RED_SAND, 'red_sand', { name: 'Red Sand', hardness: 0.6, tool: 'shovel', sound: 'sand', faces: { all: 'red_sand' } });
regBlock(BLOCK.TERRACOTTA, 'terracotta', { name: 'Terracotta', hardness: 1.9, tool: 'pickaxe', minTier: 1, sound: 'stone', faces: { all: 'terracotta' } });
regBlock(BLOCK.TERRACOTTA_RED, 'terracotta_red', { name: 'Red Terracotta', hardness: 1.9, tool: 'pickaxe', minTier: 1, sound: 'stone', faces: { all: 'terracotta_red' } });
regBlock(BLOCK.TERRACOTTA_ORANGE, 'terracotta_orange', { name: 'Orange Terracotta', hardness: 1.9, tool: 'pickaxe', minTier: 1, sound: 'stone', faces: { all: 'terracotta_orange' } });
regBlock(BLOCK.TERRACOTTA_YELLOW, 'terracotta_yellow', { name: 'Yellow Terracotta', hardness: 1.9, tool: 'pickaxe', minTier: 1, sound: 'stone', faces: { all: 'terracotta_yellow' } });

regBlock(BLOCK.MOSSY_COBBLESTONE, 'mossy_cobblestone', { name: 'Mossy Cobblestone', hardness: 2.4, tool: 'pickaxe', minTier: 1, sound: 'stone', faces: { all: 'mossy_cobblestone' } });
regBlock(BLOCK.MUD, 'mud', { name: 'Mud', hardness: 0.6, tool: 'shovel', sound: 'dirt', faces: { all: 'mud' } });
regBlock(BLOCK.PACKED_ICE, 'packed_ice', { name: 'Packed Ice', hardness: 1.2, tool: 'pickaxe', sound: 'glass', faces: { all: 'packed_ice' } });

regBlock(BLOCK.SAVANNA_GRASS, 'savanna_grass', { name: 'Savanna Grass', hardness: 0.7, tool: 'shovel', sound: 'grass', drop: 'dirt', faces: { top: 'savanna_grass_top', side: 'savanna_grass_side', bottom: 'dirt' } });
regBlock(BLOCK.JUNGLE_GRASS, 'jungle_grass', { name: 'Jungle Grass', hardness: 0.7, tool: 'shovel', sound: 'grass', drop: 'dirt', faces: { top: 'jungle_grass_top', side: 'jungle_grass_side', bottom: 'dirt' } });
regBlock(BLOCK.SWAMP_GRASS, 'swamp_grass', { name: 'Swamp Grass', hardness: 0.7, tool: 'shovel', sound: 'grass', drop: 'dirt', faces: { top: 'swamp_grass_top', side: 'swamp_grass_side', bottom: 'dirt' } });

// --- LAVA & FIRE ---
regBlock(BLOCK.LAVA, 'lava', { name: 'Lava', solid: false, transparent: true, liquid: true, light: 15, hardness: -1, sound: 'water', drop: null, hiddenFromCreative: true, faces: { all: 'lava' } });
regBlock(BLOCK.FIRE, 'fire', { name: 'Fire', solid: false, transparent: true, cross: true, light: 15, hardness: 0.05, sound: 'grass', drop: null, hiddenFromCreative: true, faces: { all: 'fire' } });

// --- WOOD DOORS (All 6 wood types — 2-block-tall openable/closeable Minecraft doors!) ---
export const DOOR_WOODS = [
  { key: 'oak',    name: 'Oak Door',    bId: BLOCK.OAK_DOOR_B,    tId: BLOCK.OAK_DOOR_T,    planks: 'oak_planks' },
  { key: 'birch',  name: 'Birch Door',  bId: BLOCK.BIRCH_DOOR_B,  tId: BLOCK.BIRCH_DOOR_T,  planks: 'birch_planks' },
  { key: 'spruce', name: 'Spruce Door', bId: BLOCK.SPRUCE_DOOR_B, tId: BLOCK.SPRUCE_DOOR_T, planks: 'spruce_planks' },
  { key: 'acacia', name: 'Acacia Door', bId: BLOCK.ACACIA_DOOR_B, tId: BLOCK.ACACIA_DOOR_T, planks: 'acacia_planks' },
  { key: 'jungle', name: 'Jungle Door', bId: BLOCK.JUNGLE_DOOR_B, tId: BLOCK.JUNGLE_DOOR_T, planks: 'jungle_planks' },
  { key: 'cherry', name: 'Cherry Door', bId: BLOCK.CHERRY_DOOR_B, tId: BLOCK.CHERRY_DOOR_T, planks: 'cherry_planks' }
];
for (const dw of DOOR_WOODS) {
  regBlock(dw.bId, `${dw.key}_door`, {
    name: dw.name, hardness: 2.2, tool: 'axe', sound: 'wood',
    transparent: true, solid: true, isDoor: true, doorHalf: 'bottom',
    doorPartner: dw.tId, doorWood: dw.key, interactive: 'door',
    faces: { all: `${dw.key}_door_bottom`, side: `${dw.key}_door_bottom`, top: dw.planks, bottom: dw.planks }
  });
  regBlock(dw.tId, `${dw.key}_door_top`, {
    name: dw.name, hardness: 2.2, tool: 'axe', sound: 'wood',
    transparent: true, solid: true, isDoor: true, doorHalf: 'top',
    doorPartner: dw.bId, doorWood: dw.key, interactive: 'door',
    drop: `${dw.key}_door`, hiddenFromCreative: true,
    faces: { all: `${dw.key}_door_top`, side: `${dw.key}_door_top`, top: dw.planks, bottom: dw.planks }
  });
}

// --- WOOD FENCES & FENCE GATES (All 6 wood types — auto-connecting fences & openable swinging gates!) ---
export const FENCE_WOODS = [
  { key: 'oak',    label: 'Oak',    fId: BLOCK.OAK_FENCE,    gId: BLOCK.OAK_FENCE_GATE,    planks: 'oak_planks' },
  { key: 'birch',  label: 'Birch',  fId: BLOCK.BIRCH_FENCE,  gId: BLOCK.BIRCH_FENCE_GATE,  planks: 'birch_planks' },
  { key: 'spruce', label: 'Spruce', fId: BLOCK.SPRUCE_FENCE, gId: BLOCK.SPRUCE_FENCE_GATE, planks: 'spruce_planks' },
  { key: 'acacia', label: 'Acacia', fId: BLOCK.ACACIA_FENCE, gId: BLOCK.ACACIA_FENCE_GATE, planks: 'acacia_planks' },
  { key: 'jungle', label: 'Jungle', fId: BLOCK.JUNGLE_FENCE, gId: BLOCK.JUNGLE_FENCE_GATE, planks: 'jungle_planks' },
  { key: 'cherry', label: 'Cherry', fId: BLOCK.CHERRY_FENCE, gId: BLOCK.CHERRY_FENCE_GATE, planks: 'cherry_planks' }
];
for (const fw of FENCE_WOODS) {
  regBlock(fw.fId, `${fw.key}_fence`, {
    name: `${fw.label} Fence`, hardness: 1.8, tool: 'axe', sound: 'wood',
    transparent: true, solid: true, isFence: true, fenceWood: fw.key,
    faces: { all: fw.planks }
  });
  regBlock(fw.gId, `${fw.key}_fence_gate`, {
    name: `${fw.label} Fence Gate`, hardness: 1.8, tool: 'axe', sound: 'wood',
    transparent: true, solid: true, isFenceGate: true, fenceWood: fw.key,
    interactive: 'fence_gate',
    faces: { all: fw.planks }
  });
}

// --- DEEPSLATE & 5 NEW STONE BLOCKS (Granite, Diorite, Andesite, Tuff, Basalt) ---
regBlock(BLOCK.DEEPSLATE, 'deepslate', {
  name: 'Deepslate', hardness: 3.0, tool: 'pickaxe', minTier: 1, sound: 'stone',
  faces: { top: 'deepslate_top', side: 'deepslate_side', bottom: 'deepslate_top' }
});
regBlock(BLOCK.GRANITE, 'granite', {
  name: 'Granite', hardness: 2.2, tool: 'pickaxe', minTier: 1, sound: 'stone',
  faces: { all: 'granite' }
});
regBlock(BLOCK.DIORITE, 'diorite', {
  name: 'Diorite', hardness: 2.2, tool: 'pickaxe', minTier: 1, sound: 'stone',
  faces: { all: 'diorite' }
});
regBlock(BLOCK.ANDESITE, 'andesite', {
  name: 'Andesite', hardness: 2.2, tool: 'pickaxe', minTier: 1, sound: 'stone',
  faces: { all: 'andesite' }
});
regBlock(BLOCK.TUFF, 'tuff', {
  name: 'Tuff', hardness: 2.4, tool: 'pickaxe', minTier: 1, sound: 'stone',
  faces: { all: 'tuff' }
});
regBlock(BLOCK.BASALT, 'basalt', {
  name: 'Basalt', hardness: 2.6, tool: 'pickaxe', minTier: 1, sound: 'stone',
  faces: { top: 'basalt_top', side: 'basalt_side', bottom: 'basalt_top' }
});

// --- STAIRS FOR EVERY MATERIAL (Woods, Classic Stones, Masonry, Deepslate & All 5 New Stones!) ---
export const STAIR_DEFS = [
  { key: 'oak',               label: 'Oak',               id: BLOCK.OAK_STAIRS,               mat: 'oak_planks',        isWood: true,  hardness: 1.6, minTier: 0, faces: { all: 'oak_planks' } },
  { key: 'birch',             label: 'Birch',             id: BLOCK.BIRCH_STAIRS,             mat: 'birch_planks',      isWood: true,  hardness: 1.6, minTier: 0, faces: { all: 'birch_planks' } },
  { key: 'spruce',            label: 'Spruce',            id: BLOCK.SPRUCE_STAIRS,            mat: 'spruce_planks',     isWood: true,  hardness: 1.6, minTier: 0, faces: { all: 'spruce_planks' } },
  { key: 'acacia',            label: 'Acacia',            id: BLOCK.ACACIA_STAIRS,            mat: 'acacia_planks',     isWood: true,  hardness: 1.6, minTier: 0, faces: { all: 'acacia_planks' } },
  { key: 'jungle',            label: 'Jungle',            id: BLOCK.JUNGLE_STAIRS,            mat: 'jungle_planks',     isWood: true,  hardness: 1.6, minTier: 0, faces: { all: 'jungle_planks' } },
  { key: 'cherry',            label: 'Cherry',            id: BLOCK.CHERRY_STAIRS,            mat: 'cherry_planks',     isWood: true,  hardness: 1.6, minTier: 0, faces: { all: 'cherry_planks' } },
  { key: 'stone',             label: 'Stone',             id: BLOCK.STONE_STAIRS,             mat: 'stone',             isWood: false, hardness: 2.2, minTier: 1, faces: { all: 'stone' } },
  { key: 'cobblestone',       label: 'Cobblestone',       id: BLOCK.COBBLESTONE_STAIRS,       mat: 'cobblestone',       isWood: false, hardness: 2.4, minTier: 1, faces: { all: 'cobblestone' } },
  { key: 'mossy_cobblestone', label: 'Mossy Cobblestone', id: BLOCK.MOSSY_COBBLESTONE_STAIRS, mat: 'mossy_cobblestone', isWood: false, hardness: 2.4, minTier: 1, faces: { all: 'mossy_cobblestone' } },
  { key: 'stone_brick',       label: 'Stone Brick',       id: BLOCK.STONE_BRICK_STAIRS,       mat: 'stone_bricks',      isWood: false, hardness: 2.3, minTier: 1, faces: { all: 'stone_bricks' } },
  { key: 'sandstone',         label: 'Sandstone',         id: BLOCK.SANDSTONE_STAIRS,         mat: 'sandstone',         isWood: false, hardness: 1.8, minTier: 1, faces: { top: 'sandstone_top', side: 'sandstone_side', bottom: 'sandstone_top' } },
  { key: 'brick',             label: 'Brick',             id: BLOCK.BRICK_STAIRS,             mat: 'bricks',            isWood: false, hardness: 2.2, minTier: 1, faces: { all: 'bricks' } },
  { key: 'deepslate',         label: 'Deepslate',         id: BLOCK.DEEPSLATE_STAIRS,         mat: 'deepslate',         isWood: false, hardness: 3.0, minTier: 1, faces: { top: 'deepslate_top', side: 'deepslate_side', bottom: 'deepslate_top' } },
  { key: 'granite',           label: 'Granite',           id: BLOCK.GRANITE_STAIRS,           mat: 'granite',           isWood: false, hardness: 2.2, minTier: 1, faces: { all: 'granite' } },
  { key: 'diorite',           label: 'Diorite',           id: BLOCK.DIORITE_STAIRS,           mat: 'diorite',           isWood: false, hardness: 2.2, minTier: 1, faces: { all: 'diorite' } },
  { key: 'andesite',          label: 'Andesite',          id: BLOCK.ANDESITE_STAIRS,          mat: 'andesite',          isWood: false, hardness: 2.2, minTier: 1, faces: { all: 'andesite' } },
  { key: 'tuff',              label: 'Tuff',              id: BLOCK.TUFF_STAIRS,              mat: 'tuff',              isWood: false, hardness: 2.4, minTier: 1, faces: { all: 'tuff' } },
  { key: 'basalt',            label: 'Basalt',            id: BLOCK.BASALT_STAIRS,            mat: 'basalt',            isWood: false, hardness: 2.6, minTier: 1, faces: { top: 'basalt_top', side: 'basalt_side', bottom: 'basalt_top' } }
];
for (const st of STAIR_DEFS) {
  regBlock(st.id, `${st.key}_stairs`, {
    name: `${st.label} Stairs`,
    hardness: st.hardness,
    tool: st.isWood ? 'axe' : 'pickaxe',
    minTier: st.minTier,
    sound: st.isWood ? 'wood' : 'stone',
    transparent: true,
    solid: true,
    isStair: true,
    stairMat: st.mat,
    faces: st.faces
  });
}

// --- MATERIALS & FOOD ---
regItem('stick', { name: 'Stick', icon: 'stick' });
regItem('coal', { name: 'Coal', icon: 'coal', fuel: 80 });
regItem('flint', { name: 'Flint', icon: 'flint' });
regItem('flint_and_steel', { name: 'Flint and Steel', stackSize: 1, toolType: 'flint_and_steel', durability: 64, icon: 'flint_and_steel' });
regItem('shears', { name: 'Shears', stackSize: 1, toolType: 'shears', durability: 238, speed: 5.0, icon: 'shears' });
regItem('bucket', { name: 'Bucket', stackSize: 16, bucketType: 'empty', icon: 'bucket' });
regItem('water_bucket', { name: 'Water Bucket', stackSize: 1, bucketType: 'water', icon: 'water_bucket' });
regItem('lava_bucket', { name: 'Lava Bucket', stackSize: 1, bucketType: 'lava', fuel: 200, icon: 'lava_bucket' });
regItem('raw_iron', { name: 'Raw Iron', icon: 'raw_iron' });
regItem('iron_ingot', { name: 'Iron Ingot', icon: 'iron_ingot' });
regItem('raw_gold', { name: 'Raw Gold', icon: 'raw_gold' });
regItem('gold_ingot', { name: 'Gold Ingot', icon: 'gold_ingot' });
regItem('diamond', { name: 'Diamond', icon: 'diamond' });
regItem('emerald', { name: 'Emerald', icon: 'emerald' });
regItem('gunpowder', { name: 'Gunpowder', icon: 'gunpowder' });
regItem('bone', { name: 'Bone', icon: 'bone' });
regItem('leather', { name: 'Leather', icon: 'leather' });
regItem('feather', { name: 'Feather', icon: 'feather' });
regItem('wheat_seeds', { name: 'Wheat Seeds', icon: 'wheat_seeds' });
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
  { key: 'golden', name: 'Golden', tier: 2, speed: 11.5, dur: 64, dmg: 2 },
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
  regItem(`${t.key}_hoe`, {
    name: `${t.name} Hoe`, stackSize: 1, toolType: 'hoe', tier: t.tier,
    speed: t.speed, durability: t.dur, damage: 1 + Math.max(0, t.dmg - 1), icon: `${t.key}_hoe`
  });
}

// --- ARMOR ---
const ARMOR_MATS = [
  { key: 'leather', name: 'Leather', def: [1, 3, 2, 1], dur: 80 },
  { key: 'golden', name: 'Golden', def: [2, 5, 3, 1], dur: 112 },
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

// --- MOB SPAWN EGGS (Every single mob & animal in the game!) ---
export const SPAWN_EGG_DEFS = [
  { mob: 'pig',        name: 'Pig',          base: '#f0a5a2', spot: '#db635f' },
  { mob: 'cow',        name: 'Cow',          base: '#443626', spot: '#a1a1a1' },
  { mob: 'sheep',      name: 'Sheep',        base: '#e7e7e7', spot: '#ffb5b5' },
  { mob: 'chicken',    name: 'Chicken',      base: '#a1a1a1', spot: '#ff0000' },
  { mob: 'deer',       name: 'Deer',         base: '#9c663b', spot: '#f0dfc8' },
  { mob: 'fox',        name: 'Fox',          base: '#d96b27', spot: '#f5f5f5' },
  { mob: 'rabbit',     name: 'Rabbit',       base: '#995f40', spot: '#734831' },
  { mob: 'wolf',       name: 'Wolf',         base: '#d7d3d3', spot: '#ceaf96' },
  { mob: 'duck',       name: 'Duck',         base: '#8c6d52', spot: '#1e7a48' },
  { mob: 'turtle',     name: 'Turtle',       base: '#e7e7e7', spot: '#00afaf' },
  { mob: 'bird',       name: 'Songbird',     base: '#2b7de9', spot: '#ffd54f' },
  { mob: 'fish',       name: 'River Fish',   base: '#a00f10', spot: '#0e8474' },
  { mob: 'butterfly',  name: 'Butterfly',    base: '#ff8c1a', spot: '#241914' },
  { mob: 'camel',      name: 'Camel',        base: '#fcc369', spot: '#cb9337' },
  { mob: 'zebra',      name: 'Zebra',        base: '#f2f4f7', spot: '#1b1d22' },
  { mob: 'panda',      name: 'Panda',        base: '#e7e7e7', spot: '#1b1b22' },
  { mob: 'frog',       name: 'Frog',         base: '#529c38', spot: '#d9e89b' },
  { mob: 'polar_bear', name: 'Polar Bear',   base: '#f2f2f2', spot: '#959590' },
  { mob: 'goat',       name: 'Mountain Goat',base: '#a5947c', spot: '#55493e' },
  { mob: 'villager',         name: 'Villager',         base: '#563c33', spot: '#bd8b72' },
  { mob: 'villager_soldier', name: 'Villager Soldier', base: '#7d8796', spot: '#3a78c9' },
  { mob: 'iron_golem',       name: 'Iron Golem',       base: '#dbdbdb', spot: '#74a332' },
  { mob: 'zombie',     name: 'Zombie',       base: '#00afaf', spot: '#799c65' },
  { mob: 'skeleton',   name: 'Skeleton',     base: '#c1c1c1', spot: '#494949' },
  { mob: 'creeper',    name: 'Creeper',      base: '#0da70b', spot: '#000000' },
  { mob: 'spider',     name: 'Night Spider', base: '#342d27', spot: '#a80e0e' }
];

for (const eg of SPAWN_EGG_DEFS) {
  regItem(`spawn_${eg.mob}`, {
    name: `${eg.name} Spawn Egg`,
    stackSize: 64,
    spawnMob: eg.mob,
    eggBase: eg.base,
    eggSpot: eg.spot,
    icon: `spawn_${eg.mob}`
  });
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
  return blockId === BLOCK.WATER || blockId === BLOCK.LAVA;
}

export function isBlockWater(blockId) {
  return blockId === BLOCK.WATER;
}

export function isBlockLava(blockId) {
  return blockId === BLOCK.LAVA;
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

export function isDoorBlock(id) {
  return id >= BLOCK.OAK_DOOR_B && id <= BLOCK.CHERRY_DOOR_T;
}

export function isDoorTop(id) {
  return isDoorBlock(id) && ((id - BLOCK.OAK_DOOR_B) & 1) === 1;
}

export function isDoorBottom(id) {
  return isDoorBlock(id) && ((id - BLOCK.OAK_DOOR_B) & 1) === 0;
}

export function isFenceBlock(id) {
  return id >= BLOCK.OAK_FENCE && id <= BLOCK.CHERRY_FENCE;
}

export function isFenceGateBlock(id) {
  return id >= BLOCK.OAK_FENCE_GATE && id <= BLOCK.CHERRY_FENCE_GATE;
}

export function isFenceOrGate(id) {
  return id >= BLOCK.OAK_FENCE && id <= BLOCK.CHERRY_FENCE_GATE;
}

export function isStairBlock(id) {
  return id >= BLOCK.OAK_STAIRS && id <= BLOCK.BASALT_STAIRS;
}

export function isNaturalStoneBlock(id) {
  return (
    id === BLOCK.STONE || id === BLOCK.DEEPSLATE ||
    id === BLOCK.GRANITE || id === BLOCK.DIORITE ||
    id === BLOCK.ANDESITE || id === BLOCK.TUFF || id === BLOCK.BASALT
  );
}

export function isWheatBlock(id) {
  return id >= BLOCK.WHEAT_0 && id <= BLOCK.WHEAT_7;
}

export function isFarmlandBlock(id) {
  return id === BLOCK.FARMLAND || id === BLOCK.FARMLAND_WET;
}

export function getItemCategory(def) {
  if (!def) return 'materials';
  if (def.spawnMob) return 'eggs';
  if (def.armorSlot !== undefined) return 'armor';
  if (def.toolType || def.bucketType) return 'tools';
  if (def.food) return 'food';
  if (!def.isBlock) return 'materials';
  if (def.isDoor || def.isFenceGate) return 'utility';
  if (def.isFence || def.isStair) return 'building';
  const id = def.id;
  if (['crafting_table', 'furnace', 'chest', 'bed', 'tnt', 'torch', 'bookshelf', 'ladder', 'glowstone', 'glass'].includes(id)) {
    return 'utility';
  }
  if (['grass', 'savanna_grass', 'jungle_grass', 'swamp_grass', 'dirt', 'dirt_path', 'mud', 'sand', 'red_sand', 'gravel', 'water', 'oak_log', 'oak_leaves', 'birch_log', 'birch_leaves', 'spruce_log', 'spruce_leaves', 'acacia_log', 'acacia_leaves', 'jungle_log', 'jungle_leaves', 'cherry_log', 'cherry_leaves', 'cactus', 'snow', 'ice', 'packed_ice', 'tall_grass', 'flower_red', 'flower_yellow', 'farmland', 'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore'].includes(id)) {
    return 'nature';
  }
  return 'building';
}
