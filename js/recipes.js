// Crafting & Smelting Recipes

export const SMELTING_RECIPES = {
  raw_iron: 'iron_ingot',
  iron_ore: 'iron_ingot',
  raw_gold: 'gold_ingot',
  gold_ore: 'gold_ingot',
  sand: 'glass',
  cobblestone: 'stone',
  raw_porkchop: 'cooked_porkchop',
  raw_beef: 'steak',
  raw_chicken: 'cooked_chicken',
  raw_mutton: 'cooked_mutton',
  raw_venison: 'cooked_venison',
  raw_rabbit: 'cooked_rabbit',
  raw_salmon: 'cooked_salmon',
  oak_log: 'coal',
  birch_log: 'coal',
  spruce_log: 'coal',
  acacia_log: 'coal',
  jungle_log: 'coal',
  cherry_log: 'coal',
  red_sand: 'glass'
};

// Ore-only auto-smelting map used by the Auto-Smelt mod (never smelts wood, sand, or stone!)
export const AUTO_SMELT_ORES = {
  raw_iron: 'iron_ingot',
  iron_ore: 'iron_ingot',
  raw_gold: 'gold_ingot',
  gold_ore: 'gold_ingot'
};

export const FUEL_VALUES = {
  coal: 80,
  lava_bucket: 200,
  oak_planks: 15,
  birch_planks: 15,
  spruce_planks: 15,
  acacia_planks: 15,
  jungle_planks: 15,
  cherry_planks: 15,
  oak_door: 10,
  birch_door: 10,
  spruce_door: 10,
  acacia_door: 10,
  jungle_door: 10,
  cherry_door: 10,
  oak_log: 15,
  birch_log: 15,
  spruce_log: 15,
  acacia_log: 15,
  jungle_log: 15,
  cherry_log: 15,
  stick: 5,
  crafting_table: 15,
  chest: 15
};

// Recipe format:
// { id, out: itemKey, count, table: boolean (true = needs 3x3), pattern: ['AB','CD'] or ingredients: { key: count }, map: { A: itemKey } }
// For matching grids AND quick-craft, every recipe also computes a flat `cost: { itemKey: count }`.

const RAW_RECIPES = [
  // Authentic Minecraft 2x2 Basics & Building Blocks
  { out: 'oak_planks', count: 4, ingredients: { oak_log: 1 } },
  { out: 'birch_planks', count: 4, ingredients: { birch_log: 1 } },
  { out: 'spruce_planks', count: 4, ingredients: { spruce_log: 1 } },
  { out: 'acacia_planks', count: 4, ingredients: { acacia_log: 1 } },
  { out: 'jungle_planks', count: 4, ingredients: { jungle_log: 1 } },
  { out: 'cherry_planks', count: 4, ingredients: { cherry_log: 1 } },
  { out: 'stick', count: 4, pattern: ['P', 'P'], map: { P: 'any_planks' } },
  { out: 'crafting_table', count: 1, pattern: ['PP', 'PP'], map: { P: 'any_planks' } },
  { out: 'torch', count: 4, pattern: ['C', 'S'], map: { C: 'coal', S: 'stick' } },
  { out: 'flint_and_steel', count: 1, ingredients: { iron_ingot: 1, flint: 1 } },
  { out: 'bucket', count: 1, table: true, pattern: ['I I', ' I '], map: { I: 'iron_ingot' } },
  // Authentic Minecraft Wood Door Recipes (2x3 planks -> 3 doors for every wood type!)
  { out: 'oak_door',    count: 3, table: true, pattern: ['PP', 'PP', 'PP'], map: { P: 'oak_planks' } },
  { out: 'birch_door',  count: 3, table: true, pattern: ['PP', 'PP', 'PP'], map: { P: 'birch_planks' } },
  { out: 'spruce_door', count: 3, table: true, pattern: ['PP', 'PP', 'PP'], map: { P: 'spruce_planks' } },
  { out: 'acacia_door', count: 3, table: true, pattern: ['PP', 'PP', 'PP'], map: { P: 'acacia_planks' } },
  { out: 'jungle_door', count: 3, table: true, pattern: ['PP', 'PP', 'PP'], map: { P: 'jungle_planks' } },
  { out: 'cherry_door', count: 3, table: true, pattern: ['PP', 'PP', 'PP'], map: { P: 'cherry_planks' } },
  { out: 'sandstone', count: 1, pattern: ['SS', 'SS'], map: { S: 'sand' } },
  { out: 'stone_bricks', count: 4, pattern: ['SS', 'SS'], map: { S: 'stone' } },

  // Authentic Minecraft 3x3 Utility, Food & Redstone/Explosives
  { out: 'furnace', count: 1, table: true, pattern: ['CCC', 'C C', 'CCC'], map: { C: 'cobblestone' } },
  { out: 'chest', count: 1, table: true, pattern: ['PPP', 'P P', 'PPP'], map: { P: 'any_planks' } },
  { out: 'ladder', count: 3, table: true, pattern: ['S S', 'SSS', 'S S'], map: { S: 'stick' } },
  { out: 'bed', count: 1, table: true, pattern: ['WWW', 'PPP'], map: { W: 'any_wool', P: 'any_planks' } },
  { out: 'tnt', count: 1, table: true, pattern: ['GSG', 'SGS', 'GSG'], map: { G: 'gunpowder', S: 'sand' } },
  { out: 'bread', count: 1, table: true, pattern: ['WWW'], map: { W: 'wheat' } },

  // Authentic Minecraft Metal & Gem Storage Blocks (9 <-> 1)
  { out: 'iron_block', count: 1, table: true, pattern: ['III', 'III', 'III'], map: { I: 'iron_ingot' } },
  { out: 'gold_block', count: 1, table: true, pattern: ['GGG', 'GGG', 'GGG'], map: { G: 'gold_ingot' } },
  { out: 'diamond_block', count: 1, table: true, pattern: ['DDD', 'DDD', 'DDD'], map: { D: 'diamond' } },
  { out: 'iron_ingot', count: 9, ingredients: { iron_block: 1 } },
  { out: 'gold_ingot', count: 9, ingredients: { gold_block: 1 } },
  { out: 'diamond', count: 9, ingredients: { diamond_block: 1 } }
];

// Tools & Weapons
const TOOL_MATS = [
  { prefix: 'wooden', mat: 'any_planks' },
  { prefix: 'stone', mat: 'cobblestone' },
  { prefix: 'golden', mat: 'gold_ingot' },
  { prefix: 'iron', mat: 'iron_ingot' },
  { prefix: 'diamond', mat: 'diamond' }
];

for (const tm of TOOL_MATS) {
  RAW_RECIPES.push(
    { out: `${tm.prefix}_pickaxe`, count: 1, table: true, pattern: ['MMM', ' S ', ' S '], map: { M: tm.mat, S: 'stick' } },
    { out: `${tm.prefix}_axe`, count: 1, table: true, pattern: ['MM', 'MS', ' S'], map: { M: tm.mat, S: 'stick' } },
    { out: `${tm.prefix}_shovel`, count: 1, table: true, pattern: ['M', 'S', 'S'], map: { M: tm.mat, S: 'stick' } },
    { out: `${tm.prefix}_sword`, count: 1, table: true, pattern: ['M', 'M', 'S'], map: { M: tm.mat, S: 'stick' } },
    { out: `${tm.prefix}_hoe`, count: 1, table: true, pattern: ['MM', ' S', ' S'], map: { M: tm.mat, S: 'stick' } }
  );
}

// Armor
const ARMOR_RECIPES = [
  { prefix: 'leather', mat: 'leather' },
  { prefix: 'golden', mat: 'gold_ingot' },
  { prefix: 'iron', mat: 'iron_ingot' },
  { prefix: 'diamond', mat: 'diamond' }
];

for (const am of ARMOR_RECIPES) {
  RAW_RECIPES.push(
    { out: `${am.prefix}_helmet`, count: 1, table: true, pattern: ['MMM', 'M M'], map: { M: am.mat } },
    { out: `${am.prefix}_chestplate`, count: 1, table: true, pattern: ['M M', 'MMM', 'MMM'], map: { M: am.mat } },
    { out: `${am.prefix}_leggings`, count: 1, table: true, pattern: ['MMM', 'M M', 'M M'], map: { M: am.mat } },
    { out: `${am.prefix}_boots`, count: 1, table: true, pattern: ['M M', 'M M'], map: { M: am.mat } }
  );
}

export const PLANK_TYPES = ['oak_planks', 'birch_planks', 'spruce_planks', 'acacia_planks', 'jungle_planks', 'cherry_planks'];
export const WOOL_TYPES = ['wool_white', 'wool_red', 'wool_blue', 'wool_green', 'wool_yellow'];

export function matchesItemTag(itemId, req) {
  if (!itemId) return false;
  if (req === 'any_planks') return PLANK_TYPES.includes(itemId);
  if (req === 'any_wool') return WOOL_TYPES.includes(itemId);
  return itemId === req;
}

// Precompute flat cost map for each recipe
export const RECIPES = RAW_RECIPES.map((r, idx) => {
  const cost = {};
  if (r.ingredients) {
    Object.assign(cost, r.ingredients);
  } else if (r.pattern) {
    for (const row of r.pattern) {
      for (const ch of row) {
        if (ch !== ' ') {
          const item = r.map[ch];
          cost[item] = (cost[item] || 0) + 1;
        }
      }
    }
  }
  return { ...r, id: idx, cost };
});

// Match a 2x2 or 3x3 crafting grid (array of length size*size with null or {id, count})
export function matchCraftingGrid(grid, size) {
  // Trim bounding box of non-empty cells
  let minR = size, maxR = -1, minC = size, maxC = -1;
  const flatItems = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const slot = grid[r * size + c];
      if (slot && slot.count > 0) {
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
        flatItems.push(slot.id);
      }
    }
  }
  if (flatItems.length === 0) return null;

  const h = maxR - minR + 1;
  const w = maxC - minC + 1;

  for (const recipe of RECIPES) {
    if (recipe.table && size < 3) continue;

    if (recipe.ingredients) {
      // Shapeless match
      const reqList = [];
      for (const [k, cnt] of Object.entries(recipe.ingredients)) {
        for (let i = 0; i < cnt; i++) reqList.push(k);
      }
      if (reqList.length !== flatItems.length) continue;
      const used = new Array(flatItems.length).fill(false);
      let ok = true;
      for (const req of reqList) {
        const foundIdx = flatItems.findIndex((it, idx) => !used[idx] && matchesItemTag(it, req));
        if (foundIdx === -1) { ok = false; break; }
        used[foundIdx] = true;
      }
      if (ok) return recipe;
    } else if (recipe.pattern) {
      const ph = recipe.pattern.length;
      const pw = recipe.pattern[0].length;
      if (ph !== h || pw !== w) continue;

      let matchNormal = true;
      let matchFlip = true;
      for (let r = 0; r < ph; r++) {
        for (let c = 0; c < pw; c++) {
          const chN = recipe.pattern[r][c];
          const chF = recipe.pattern[r][pw - 1 - c];
          const slot = grid[(minR + r) * size + (minC + c)];
          const id = slot ? slot.id : null;

          if (chN === ' ') {
            if (id) matchNormal = false;
          } else {
            if (!matchesItemTag(id, recipe.map[chN])) matchNormal = false;
          }

          if (chF === ' ') {
            if (id) matchFlip = false;
          } else {
            if (!matchesItemTag(id, recipe.map[chF])) matchFlip = false;
          }
        }
      }
      if (matchNormal || matchFlip) return recipe;
    }
  }
  return null;
}

export function canCraftRecipe(recipe, inventory, isTable) {
  if (recipe.table && !isTable) return false;
  for (const [req, needed] of Object.entries(recipe.cost)) {
    let have = 0;
    for (const slot of inventory.slots) {
      if (slot && matchesItemTag(slot.id, req)) have += slot.count;
    }
    if (have < needed) return false;
  }
  return true;
}

export function quickCraftRecipe(recipe, inventory, isTable) {
  if (!canCraftRecipe(recipe, inventory, isTable)) return false;
  // Consume ingredients
  for (const [req, needed] of Object.entries(recipe.cost)) {
    let rem = needed;
    for (let i = 0; i < inventory.slots.length && rem > 0; i++) {
      const slot = inventory.slots[i];
      if (slot && matchesItemTag(slot.id, req)) {
        const take = Math.min(slot.count, rem);
        slot.count -= take;
        rem -= take;
        if (slot.count <= 0) inventory.slots[i] = null;
      }
    }
  }
  inventory.addItem(recipe.out, recipe.count);
  return true;
}
