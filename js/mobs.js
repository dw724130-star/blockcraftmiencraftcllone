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

const MOB_TYPES = {
  pig: {
    hostile: false, hp: 10, speed: 2.0, color: 0xf2a2a8, headColor: 0xf7b2b8,
    size: [0.85, 0.75, 1.15], drop: ['raw_porkchop'], xp: 2
  },
  cow: {
    hostile: false, hp: 12, speed: 1.9, color: 0x5c422c, headColor: 0x473120,
    size: [0.9, 1.15, 1.3], drop: ['raw_beef', 'leather'], xp: 2
  },
  sheep: {
    hostile: false, hp: 10, speed: 2.0, color: 0xedeff2, headColor: 0xd9c2a8,
    size: [0.85, 1.05, 1.2], drop: ['wool_white'], xp: 2
  },
  chicken: {
    hostile: false, hp: 6, speed: 2.3, color: 0xffffff, headColor: 0xffd54f,
    size: [0.5, 0.65, 0.6], drop: ['feather'], xp: 1
  },
  villager: {
    hostile: false, hp: 20, speed: 1.7, color: 0x8f6234, headColor: 0xd19f7b,
    size: [0.65, 1.9, 0.65], villager: true, drop: ['emerald'], xp: 3
  },
  iron_golem: {
    hostile: false, hp: 60, speed: 1.5, color: 0xd8dce0, headColor: 0xc5cad1,
    size: [1.1, 2.5, 0.9], golem: true, drop: ['iron_ingot', 'iron_ingot', 'flower_red'], xp: 8
  },
  zombie: {
    hostile: true, hp: 20, speed: 2.5, dmg: 3, color: 0x3b7a8c, headColor: 0x568c4d,
    size: [0.65, 1.85, 0.65], humanoid: true, burnsInDay: true, drop: ['coal'], xp: 5
  },
  skeleton: {
    hostile: true, hp: 16, speed: 2.7, dmg: 3, color: 0xd6d8dc, headColor: 0xe6e8ec,
    size: [0.6, 1.85, 0.6], humanoid: true, burnsInDay: true, drop: ['bone'], xp: 5
  },
  creeper: {
    hostile: true, hp: 18, speed: 2.4, dmg: 10, color: 0x4ca64c, headColor: 0x3f8f3f,
    size: [0.65, 1.7, 0.65], humanoid: true, creeper: true, drop: ['gunpowder'], xp: 6
  }
};

function createMobMesh(type, profession = null) {
  const def = MOB_TYPES[type];
  const group = new THREE.Group();
  const bodyColor = profession ? profession.robe : def.color;
  const bodyMat = new THREE.MeshLambertMaterial({ color: bodyColor });
  const headMat = new THREE.MeshLambertMaterial({ color: def.headColor });
  const eyeMat = new THREE.MeshBasicMaterial({ color: def.villager ? 0x2e8b57 : (def.golem ? 0xc92a2a : 0x111111) });

  const legs = [];

  if (def.villager) {
    // Classic Minecraft Villager: Robe, crossed arms, tall head, iconic big nose!
    const trimMat = new THREE.MeshLambertMaterial({ color: profession ? profession.trim : 0x5c3e20 });
    const legGeo = new THREE.BoxGeometry(0.22, 0.56, 0.22);
    for (const lx of [-0.13, 0.13]) {
      const leg = new THREE.Mesh(legGeo, trimMat);
      leg.position.set(lx, 0.28, 0);
      group.add(leg);
      legs.push(leg);
    }
    const robe = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.88, 0.34), bodyMat);
    robe.position.set(0, 0.96, 0);
    robe.castShadow = true;
    group.add(robe);

    // Crossed arms
    const arms = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.22, 0.22), trimMat);
    arms.position.set(0, 1.06, 0.2);
    group.add(arms);

    // Tall villager head + unibrow + nose
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.56, 0.46), headMat);
    head.position.set(0, 1.68, 0);
    head.castShadow = true;
    group.add(head);

    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.06, 0.04), new THREE.MeshBasicMaterial({ color: 0x3b2718 }));
    brow.position.set(0, 1.78, 0.24);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.24, 0.14), headMat);
    nose.position.set(0, 1.56, 0.28);
    const e1 = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.07, 0.04), eyeMat); e1.position.set(-0.11, 1.71, 0.24);
    const e2 = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.07, 0.04), eyeMat); e2.position.set(0.11, 1.71, 0.24);
    group.add(brow, nose, e1, e2);
  } else if (def.golem) {
    // Tall Iron Golem village guardian
    const vineMat = new THREE.MeshLambertMaterial({ color: 0x458534 });
    const legGeo = new THREE.BoxGeometry(0.32, 0.92, 0.32);
    for (const lx of [-0.24, 0.24]) {
      const leg = new THREE.Mesh(legGeo, bodyMat);
      leg.position.set(lx, 0.46, 0);
      group.add(leg);
      legs.push(leg);
    }
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.92, 0.52), bodyMat);
    torso.position.set(0, 1.38, 0);
    torso.castShadow = true;
    const vine = new THREE.Mesh(new THREE.BoxGeometry(0.97, 0.2, 0.54), vineMat);
    vine.position.set(0, 1.48, 0);
    const armGeo = new THREE.BoxGeometry(0.28, 1.25, 0.28);
    for (const ax of [-0.66, 0.66]) {
      const arm = new THREE.Mesh(armGeo, headMat);
      arm.position.set(ax, 1.2, 0.08);
      group.add(arm);
    }
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.56, 0.5), headMat);
    head.position.set(0, 2.12, 0.06);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, 0.12), headMat);
    nose.position.set(0, 2.02, 0.34);
    const e1 = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.07, 0.04), eyeMat); e1.position.set(-0.12, 2.16, 0.32);
    const e2 = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.07, 0.04), eyeMat); e2.position.set(0.12, 2.16, 0.32);
    group.add(torso, vine, head, nose, e1, e2);
  } else if (def.humanoid) {
    // Legs
    const legGeo = new THREE.BoxGeometry(0.24, 0.72, 0.24);
    for (const lx of [-0.14, 0.14]) {
      const leg = new THREE.Mesh(legGeo, bodyMat);
      leg.position.set(lx, 0.36, 0);
      group.add(leg);
      legs.push(leg);
    }
    // Torso
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.68, 0.28), bodyMat);
    torso.position.set(0, 1.06, 0);
    group.add(torso);

    // Arms (except creeper)
    if (!def.creeper) {
      const armGeo = new THREE.BoxGeometry(0.2, 0.62, 0.2);
      for (const ax of [-0.38, 0.38]) {
        const arm = new THREE.Mesh(armGeo, headMat);
        arm.position.set(ax, 1.08, 0.18);
        arm.rotation.x = type === 'zombie' ? -Math.PI * 0.42 : -0.2;
        group.add(arm);
      }
    }

    // Head
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.46, 0.46), headMat);
    head.position.set(0, 1.62, 0);
    group.add(head);

    // Eyes
    const eyeGeo = new THREE.BoxGeometry(0.09, 0.09, 0.04);
    const e1 = new THREE.Mesh(eyeGeo, eyeMat); e1.position.set(-0.11, 1.66, 0.23);
    const e2 = new THREE.Mesh(eyeGeo, eyeMat); e2.position.set(0.11, 1.66, 0.23);
    group.add(e1, e2);
  } else {
    // Quadruped / Chicken
    const [w, h, l] = def.size;
    const legH = h * 0.38;
    const legGeo = new THREE.BoxGeometry(w * 0.24, legH, w * 0.24);
    const legPos = [
      [-w * 0.26, legH * 0.5, l * 0.28],
      [w * 0.26, legH * 0.5, l * 0.28],
      [-w * 0.26, legH * 0.5, -l * 0.28],
      [w * 0.26, legH * 0.5, -l * 0.28]
    ];
    for (const [lx, ly, lz] of legPos) {
      const leg = new THREE.Mesh(legGeo, bodyMat);
      leg.position.set(lx, ly, lz);
      group.add(leg);
      legs.push(leg);
    }
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.52, l * 0.8), bodyMat);
    body.position.set(0, legH + h * 0.24, 0);
    group.add(body);

    const head = new THREE.Mesh(new THREE.BoxGeometry(w * 0.6, w * 0.58, w * 0.6), headMat);
    head.position.set(0, legH + h * 0.42, l * 0.46);
    group.add(head);

    const eyeGeo = new THREE.BoxGeometry(0.08, 0.08, 0.04);
    const e1 = new THREE.Mesh(eyeGeo, eyeMat); e1.position.set(-w * 0.16, legH + h * 0.46, l * 0.46 + w * 0.31);
    const e2 = new THREE.Mesh(eyeGeo, eyeMat); e2.position.set(w * 0.16, legH + h * 0.46, l * 0.46 + w * 0.31);
    group.add(e1, e2);
  }

  return { group, legs, bodyMat, headMat };
}

export class EntityManager {
  constructor(scene, world, sound) {
    this.scene = scene;
    this.world = world;
    this.sound = sound;
    this.mobs = [];
    this.drops = [];
    this.spawnTimer = 2.0;

    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.dropGeo = new THREE.BoxGeometry(0.28, 0.28, 0.28);
  }

  spawnMob(type, x, y, z, profession = null) {
    const def = MOB_TYPES[type];
    if (!def) return null;
    const prof = type === 'villager'
      ? (profession || VILLAGER_PROFESSIONS[Math.floor(Math.random() * VILLAGER_PROFESSIONS.length)])
      : null;
    const { group, legs, bodyMat, headMat } = createMobMesh(type, prof);
    group.position.set(x, y, z);
    this.group.add(group);

    const mob = {
      type,
      def,
      profession: prof ? prof.name : null,
      baseColor: prof ? prof.robe : def.color,
      mesh: group,
      legs,
      bodyMat,
      headMat,
      pos: new THREE.Vector3(x, y, z),
      homePos: new THREE.Vector3(x, y, z),
      vel: new THREE.Vector3(),
      yaw: Math.random() * Math.PI * 2,
      hp: def.hp,
      maxHp: def.hp,
      walkPhase: 0,
      aiTimer: 1 + Math.random() * 3,
      wanderDir: Math.random() * Math.PI * 2,
      moving: false,
      hurtFlash: 0,
      attackCd: 0,
      fleeTimer: 0,
      fuseTimer: 0
    };
    this.mobs.push(mob);
    return mob;
  }

  spawnDrop(itemId, count, x, y, z) {
    if (!itemId || count <= 0) return;
    // Color-coded glowing cube for dropped items
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
    if (!mob.def.hostile) mob.fleeTimer = 4.0;
    this.sound.playHurt();

    if (mob.hp <= 0) {
      // Drop loot + XP
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

    // 1. Spawning
    const maxMobs = (mods && mods.isEnabled('more_mobs')) ? 30 : 18;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = (mods && mods.isEnabled('more_mobs')) ? 2.0 : 3.5;
      if (this.mobs.length < maxMobs) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 16 + Math.random() * 20;
        const sx = Math.floor(player.pos.x + Math.cos(angle) * dist);
        const sz = Math.floor(player.pos.z + Math.sin(angle) * dist);
        const sy = this.world.getSurfaceY(sx, sz);
        const ground = this.world.getBlock(sx, sy - 1, sz);
        if (ground !== BLOCK.WATER && ground !== BLOCK.AIR) {
          const isNight = sky.isNight();
          if (isNight && player.mode === 'survival') {
            const pool = ['zombie', 'skeleton', 'creeper'];
            this.spawnMob(pool[Math.floor(Math.random() * pool.length)], sx + 0.5, sy, sz + 0.5);
          } else if (ground === BLOCK.GRASS) {
            const pool = ['pig', 'cow', 'sheep', 'chicken'];
            this.spawnMob(pool[Math.floor(Math.random() * pool.length)], sx + 0.5, sy, sz + 0.5);
          }
        }
      }
    }

    // 2. Update Mobs
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      const distToPlayer = m.pos.distanceTo(player.pos);

      // Despawn if too far (never despawn villagers quickly)
      const despawnDist = (m.def.villager || m.def.golem) ? 110 : 68;
      if (distToPlayer > despawnDist || m.pos.y < -5) {
        this.removeMob(m);
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

      // Hurt flash tint
      if (m.hurtFlash > 0) {
        m.hurtFlash -= dt;
        m.bodyMat.color.setHex(m.hurtFlash > 0 ? 0xff4444 : (m.baseColor ?? m.def.color));
      }

      m.attackCd = Math.max(0, m.attackCd - dt);

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
          moveX = Math.sin(m.yaw) * m.def.speed * 1.5;
          moveZ = Math.cos(m.yaw) * m.def.speed * 1.5;
        } else {
          if (m.aiTimer <= 0) {
            m.aiTimer = 2 + Math.random() * 4;
            m.moving = Math.random() > 0.4;
            m.wanderDir = Math.random() * Math.PI * 2;
          }
          if (m.moving) {
            // Keep villagers near their village home!
            if (m.def.villager && m.pos.distanceTo(m.homePos) > 10) {
              m.wanderDir = Math.atan2(m.homePos.x - m.pos.x, m.homePos.z - m.pos.z);
            }
            m.yaw = m.wanderDir;
            moveX = Math.sin(m.yaw) * m.def.speed * 0.65;
            moveZ = Math.cos(m.yaw) * m.def.speed * 0.65;
          } else if (m.def.villager && distToPlayer < 5.5) {
            // Villagers turn to look curiously at the player when nearby
            m.yaw = Math.atan2(player.pos.x - m.pos.x, player.pos.z - m.pos.z);
          }
        }
      }

      // Gravity & Water
      const inWater = isBlockLiquid(this.world.getBlock(m.pos.x, m.pos.y + 0.2, m.pos.z));
      m.vel.y -= (inWater ? 6 : 22) * dt;
      if (inWater) m.vel.y = Math.max(m.vel.y, 1.5);

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
        // Jump if 1 block step is clear
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

      // Apply transform + leg swing
      m.mesh.position.copy(m.pos);
      m.mesh.rotation.y = m.yaw;
      const speedMag = Math.hypot(moveX, moveZ);
      if (speedMag > 0.1) {
        m.walkPhase += dt * speedMag * 3.5;
        m.legs.forEach((leg, idx) => {
          leg.rotation.x = Math.sin(m.walkPhase + (idx % 2 === 0 ? 0 : Math.PI)) * 0.6;
        });
      } else {
        m.legs.forEach((leg) => (leg.rotation.x *= 0.85));
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

      // Magnetize toward player
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
  }
}
