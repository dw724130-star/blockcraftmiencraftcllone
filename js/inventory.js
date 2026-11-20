import { ITEMS } from './blocks.js';

export class Inventory {
  constructor() {
    this.slots = new Array(36).fill(null); // 0-8 hotbar, 9-35 main
    this.armor = new Array(4).fill(null);  // 0:helmet, 1:chest, 2:legs, 3:boots
    this.selected = 0; // 0..8
  }

  getHeldItem() {
    return this.slots[this.selected];
  }

  getHeldDef() {
    const it = this.getHeldItem();
    return it ? ITEMS[it.id] : null;
  }

  giveStarterKit(mode) {
    this.slots.fill(null);
    this.armor.fill(null);
    if (mode === 'creative') {
      const starter = [
        'grass', 'stone', 'oak_planks', 'oak_log', 'glass',
        'bricks', 'torch', 'tnt', 'diamond_sword'
      ];
      starter.forEach((id, i) => {
        this.slots[i] = this.makeStack(id, ITEMS[id].stackSize || 64);
      });
    }
    // Survival starts completely empty (no tools or items) — true survival!
  }

  makeStack(id, count = 1) {
    const def = ITEMS[id];
    if (!def) return null;
    const st = { id, count: Math.min(count, def.stackSize || 64) };
    if (def.durability) st.durability = def.durability;
    return st;
  }

  addItem(id, count = 1) {
    const def = ITEMS[id];
    if (!def || count <= 0) return false;
    const maxStack = def.stackSize || 64;
    let rem = count;

    // 1. Merge into existing stacks
    if (maxStack > 1) {
      for (let i = 0; i < this.slots.length && rem > 0; i++) {
        const s = this.slots[i];
        if (s && s.id === id && s.count < maxStack) {
          const add = Math.min(maxStack - s.count, rem);
          s.count += add;
          rem -= add;
        }
      }
    }

    // 2. Place in empty slots
    for (let i = 0; i < this.slots.length && rem > 0; i++) {
      if (!this.slots[i]) {
        const add = Math.min(maxStack, rem);
        this.slots[i] = this.makeStack(id, add);
        rem -= add;
      }
    }

    return rem === 0;
  }

  consumeSelected(amount = 1) {
    const s = this.slots[this.selected];
    if (!s) return false;
    s.count -= amount;
    if (s.count <= 0) this.slots[this.selected] = null;
    return true;
  }

  damageSelectedTool(amount = 1) {
    const s = this.slots[this.selected];
    if (!s || s.durability === undefined) return;
    s.durability -= amount;
    if (s.durability <= 0) {
      this.slots[this.selected] = null;
    }
  }

  getArmorDefense() {
    let def = 0;
    for (const a of this.armor) {
      if (a && ITEMS[a.id]) def += ITEMS[a.id].defense || 0;
    }
    return def;
  }

  damageArmor() {
    for (let i = 0; i < 4; i++) {
      const a = this.armor[i];
      if (a && a.durability !== undefined) {
        a.durability -= 1;
        if (a.durability <= 0) this.armor[i] = null;
      }
    }
  }

  serialize() {
    return {
      slots: this.slots.map((s) => (s ? { ...s } : null)),
      armor: this.armor.map((a) => (a ? { ...a } : null)),
      selected: this.selected
    };
  }

  deserialize(data) {
    if (!data) return;
    if (Array.isArray(data.slots)) {
      this.slots = new Array(36).fill(null).map((_, i) => (data.slots[i] ? { ...data.slots[i] } : null));
    }
    if (Array.isArray(data.armor)) {
      this.armor = new Array(4).fill(null).map((_, i) => (data.armor[i] ? { ...data.armor[i] } : null));
    }
    if (typeof data.selected === 'number') this.selected = data.selected;
  }
}
