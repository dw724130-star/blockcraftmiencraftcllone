import * as THREE from 'three';
import { BLOCK, ITEMS, getBlockDef, isBlockSolid, isBlockLiquid } from './blocks.js';

const PLAYER_RADIUS = 0.3;
const PLAYER_HEIGHT = 1.75;
const EYE_HEIGHT = 1.56;

export class Player {
  constructor(camera, world, inventory, sound, textures = null) {
    this.camera = camera;
    this.world = world;
    this.inventory = inventory;
    this.sound = sound;
    this.textures = textures;

    this.pos = new THREE.Vector3(0.5, 48, 0.5);
    this.spawnPos = new THREE.Vector3(0.5, 48, 0.5);
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

    this.mode = 'survival'; // 'survival' | 'creative'
    this.onGround = false;
    this.inWater = false;
    this.headInWater = false;
    this.flying = false;
    this.sneaking = false;
    this.sprinting = false;
    this.cameraMode = 0; // 0 = 1st person, 1 = 3rd person back, 2 = 3rd person front
    this.walkPhase = 0;
    this.eatAnim = 0;
    this.baseFov = camera.fov || 72;

    // Survival stats
    this.hp = 20;
    this.maxHp = 20;
    this.hunger = 20;
    this.maxHunger = 20;
    this.air = 10;
    this.maxAir = 10;
    this.xp = 0;
    this.level = 0;
    this.dead = false;
    this.fallStartY = null;
    this.hungerTimer = 0;
    this.regenTimer = 0;
    this.drownTimer = 0;
    this.stepDist = 0;

    // Mining state
    this.miningTarget = null; // "x,y,z"
    this.miningProgress = 0;
    this.swingAnim = 0;

    // 3D Target Block Outline (crisp Minecraft highlight)
    const boxGeo = new THREE.BoxGeometry(1.008, 1.008, 1.008);
    const edges = new THREE.EdgesGeometry(boxGeo);
    this.highlightMesh = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.72 })
    );
    this.highlightMesh.visible = false;

    // 3D Block-Breaking Pixel-Art Crack Overlay (stages 0..9!)
    this.crackMat = new THREE.MeshBasicMaterial({
      map: textures && textures.crackTextures ? textures.crackTextures[0] : null,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
    this.crackMesh = new THREE.Mesh(new THREE.BoxGeometry(1.005, 1.005, 1.005), this.crackMat);
    this.crackMesh.visible = false;
    this.crackMesh.renderOrder = 6;
    this._lastCrackStage = -1;

    // First-person sculpted Minecraft arm + sleeve + pixel-art held block/item/tool
    this.handGroup = new THREE.Group();
    this.handPivot = new THREE.Group();
    this.handGroup.add(this.handPivot);

    this.armMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.17, 0.17, 0.48),
      new THREE.MeshLambertMaterial({ color: 0xdba882 })
    );
    this.armMesh.position.set(0, 0, 0);
    this.sleeveMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.19, 0.19, 0.22),
      new THREE.MeshLambertMaterial({ color: 0x26a6b8 })
    );
    this.sleeveMesh.position.set(0, 0, 0.2);
    this.handPivot.add(this.armMesh, this.sleeveMesh);

    this.heldBlockMat = textures
      ? new THREE.MeshLambertMaterial({ map: textures.atlasTexture, alphaTest: 0.35 })
      : new THREE.MeshLambertMaterial({ color: 0xc9b393 });
    this.heldBlockMesh = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.24), this.heldBlockMat);
    this.heldBlockMesh.position.set(-0.04, 0.08, -0.14);
    this.heldBlockMesh.rotation.set(0.2, 0.65, 0.05);
    this.heldBlockMesh.visible = false;
    this._lastHeldBlockId = null;
    this.handPivot.add(this.heldBlockMesh);

    // Crisp pixel-art held item/food/tool sprite!
    this.heldSpriteMat = new THREE.MeshBasicMaterial({
      transparent: true,
      alphaTest: 0.45,
      side: THREE.DoubleSide
    });
    this.heldSpriteMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.32), this.heldSpriteMat);
    this.heldSpriteMesh.position.set(-0.04, 0.12, -0.14);
    this.heldSpriteMesh.rotation.set(0.08, -0.35, 0.12);
    this.heldSpriteMesh.visible = false;
    this._lastHeldSpriteId = null;
    this.handPivot.add(this.heldSpriteMesh);

    // Dynamic Torch / Glowstone PointLight (BSL Dynamic Lights!)
    this.heldLight = new THREE.PointLight(0xffb454, 0, 14, 1.6);
    this.heldLight.position.set(0.3, -0.1, -0.4);
    this.handGroup.add(this.heldLight);

    this.handPivot.position.set(0.52, -0.46, -0.62);
    this.handPivot.rotation.set(0.22, -0.26, 0.08);
    this.camera.add(this.handGroup);
    this.wasInWater = false;

    // 3D Articulated Player Model (visible in 3rd-person back & front views)
    this.playerModel = this.buildPlayerModel();
    this.playerModel.root.visible = false;

    // Callbacks wired by main.js
    this.onDamage = null;
    this.onDeath = null;
    this.onHudDirty = null;
  }

  buildPlayerModel() {
    const root = new THREE.Group();
    const skinMat = new THREE.MeshLambertMaterial({ color: 0xdba882 });
    const hairMat = new THREE.MeshLambertMaterial({ color: 0x3b2718 });
    const shirtMat = new THREE.MeshLambertMaterial({ color: 0x26a6b8 });
    const pantsMat = new THREE.MeshLambertMaterial({ color: 0x2e3b8e });
    const shoeMat = new THREE.MeshLambertMaterial({ color: 0x424242 });
    const eyeWhiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const eyePupilMat = new THREE.MeshBasicMaterial({ color: 0x34286e });

    const bodyPivot = new THREE.Group();
    root.add(bodyPivot);

    // Legs (pivoted at hip Y = 0.72)
    const makeLeg = (xOff) => {
      const pivot = new THREE.Group();
      pivot.position.set(xOff, 0.72, 0);
      const upper = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.56, 0.24), pantsMat);
      upper.position.set(0, -0.28, 0);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.16, 0.26), shoeMat);
      shoe.position.set(0, -0.64, 0.01);
      upper.castShadow = true;
      pivot.add(upper, shoe);
      bodyPivot.add(pivot);
      return pivot;
    };
    const leftLeg = makeLeg(-0.13);
    const rightLeg = makeLeg(0.13);

    // Torso (Y = 0.72 .. 1.38)
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.66, 0.26), shirtMat);
    torso.position.set(0, 1.05, 0);
    torso.castShadow = true;
    bodyPivot.add(torso);

    // Arms (pivoted at shoulder Y = 1.34)
    const makeArm = (xOff, isRight) => {
      const pivot = new THREE.Group();
      pivot.position.set(xOff, 1.34, 0);
      const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.24, 0.22), shirtMat);
      sleeve.position.set(0, -0.12, 0);
      const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.42, 0.2), skinMat);
      forearm.position.set(0, -0.45, 0);
      forearm.castShadow = true;
      pivot.add(sleeve, forearm);

      let heldItem = null;
      if (isRight) {
        heldItem = new THREE.Mesh(
          new THREE.BoxGeometry(0.24, 0.24, 0.24),
          new THREE.MeshLambertMaterial({ color: 0xc9b393 })
        );
        heldItem.position.set(0, -0.62, -0.18);
        heldItem.visible = false;
        pivot.add(heldItem);
      }
      bodyPivot.add(pivot);
      return { pivot, heldItem };
    };
    const leftArm = makeArm(-0.36, false);
    const rightArm = makeArm(0.36, true);

    // Head (pivoted at neck Y = 1.38)
    const headPivot = new THREE.Group();
    headPivot.position.set(0, 1.38, 0);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.46, 0.46), skinMat);
    head.position.set(0, 0.23, 0);
    head.castShadow = true;
    const hairTop = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.14, 0.48), hairMat);
    hairTop.position.set(0, 0.42, 0);
    const hairBack = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.34, 0.12), hairMat);
    hairBack.position.set(0, 0.24, 0.2);

    // Eyes facing -Z (forward look direction)
    const ew1 = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.06, 0.02), eyeWhiteMat);
    ew1.position.set(-0.11, 0.24, -0.235);
    const ep1 = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.06, 0.025), eyePupilMat);
    ep1.position.set(-0.085, 0.24, -0.238);
    const ew2 = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.06, 0.02), eyeWhiteMat);
    ew2.position.set(0.11, 0.24, -0.235);
    const ep2 = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.06, 0.025), eyePupilMat);
    ep2.position.set(0.085, 0.24, -0.238);

    headPivot.add(head, hairTop, hairBack, ew1, ep1, ew2, ep2);
    bodyPivot.add(headPivot);

    return {
      root,
      bodyPivot,
      headPivot,
      leftLeg,
      rightLeg,
      leftArm: leftArm.pivot,
      rightArm: rightArm.pivot,
      heldItem: rightArm.heldItem
    };
  }

  attachToScene(scene) {
    scene.add(this.highlightMesh);
    scene.add(this.crackMesh);
    scene.add(this.playerModel.root);
    scene.add(this.camera);
  }

  detachFromScene(scene) {
    scene.remove(this.highlightMesh);
    scene.remove(this.crackMesh);
    scene.remove(this.playerModel.root);
    this.camera.remove(this.handGroup);
  }

  updateCrackOverlay(target, progress) {
    if (!target || progress <= 0.005 || !this.textures || !this.textures.crackTextures.length) {
      this.crackMesh.visible = false;
      this._lastCrackStage = -1;
      return;
    }
    const stage = Math.max(0, Math.min(9, Math.floor(progress * 10)));
    this.crackMesh.visible = true;
    this.crackMesh.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5);
    if (stage !== this._lastCrackStage) {
      this._lastCrackStage = stage;
      this.crackMat.map = this.textures.crackTextures[stage];
      this.crackMat.needsUpdate = true;
    }
  }

  getLookDirection(out = new THREE.Vector3()) {
    const cosP = Math.cos(this.pitch);
    out.set(-Math.sin(this.yaw) * cosP, Math.sin(this.pitch), -Math.cos(this.yaw) * cosP);
    return out.normalize();
  }

  getEyePosition(out = new THREE.Vector3()) {
    const eyeH = this.sneaking ? EYE_HEIGHT - 0.22 : EYE_HEIGHT;
    return out.set(this.pos.x, this.pos.y + eyeH, this.pos.z);
  }

  addXP(amount) {
    this.xp += amount;
    const needed = 10 + this.level * 5;
    if (this.xp >= needed) {
      this.xp -= needed;
      this.level++;
      this.sound.playCraft();
    }
    if (this.onHudDirty) this.onHudDirty();
  }

  takeDamage(amount, reason = 'You died.') {
    if (this.mode === 'creative' || this.dead) return;
    const def = this.inventory.getArmorDefense();
    const reduced = Math.max(0.5, amount * (1 - Math.min(0.8, def * 0.04)));
    this.hp = Math.max(0, this.hp - reduced);
    this.inventory.damageArmor();
    this.sound.playHurt();
    if (this.onDamage) this.onDamage();
    if (this.onHudDirty) this.onHudDirty();

    if (this.hp <= 0) {
      this.dead = true;
      if (this.onDeath) this.onDeath(reason);
    }
  }

  respawn() {
    this.dead = false;
    this.hp = this.maxHp;
    this.hunger = this.maxHunger;
    this.air = this.maxAir;
    this.vel.set(0, 0, 0);
    this.pos.copy(this.spawnPos);
    const sy = this.world.getSurfaceY(this.pos.x, this.pos.z);
    if (this.pos.y < sy) this.pos.y = sy + 0.5;
    this.fallStartY = null;
    if (this.onHudDirty) this.onHudDirty();
  }

  collidesAt(px, py, pz) {
    const minX = Math.floor(px - PLAYER_RADIUS);
    const maxX = Math.floor(px + PLAYER_RADIUS);
    const minY = Math.floor(py);
    const maxY = Math.floor(py + PLAYER_HEIGHT - 0.05);
    const minZ = Math.floor(pz - PLAYER_RADIUS);
    const maxZ = Math.floor(pz + PLAYER_RADIUS);

    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          if (isBlockSolid(this.world.getBlock(x, y, z))) return true;
        }
      }
    }
    return false;
  }

  update(dt, input, mods = null) {
    if (this.dead) return;
    const superMob = !!(mods && mods.isEnabled('super_mobility'));
    const moonGrav = !!(mods && mods.isEnabled('moon_gravity'));

    // Look
    this.yaw -= input.lookDeltaX;
    this.pitch = Math.max(-Math.PI / 2 + 0.03, Math.min(Math.PI / 2 - 0.03, this.pitch - input.lookDeltaY));
    input.lookDeltaX = 0;
    input.lookDeltaY = 0;

    // Environment checks
    const feetBlock = this.world.getBlock(this.pos.x, this.pos.y + 0.2, this.pos.z);
    const headBlock = this.world.getBlock(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z);
    const nowInWater = isBlockLiquid(feetBlock);
    if (nowInWater && !this.wasInWater && this.sound.playSplash) {
      this.sound.playSplash();
    }
    this.wasInWater = nowInWater;
    this.inWater = nowInWater;
    this.headInWater = isBlockLiquid(headBlock);
    const onLadder = feetBlock === BLOCK.LADDER || headBlock === BLOCK.LADDER;

    this.sneaking = input.sneak && !this.flying;
    this.sprinting = input.sprint && input.moveForward > 0.4 && !this.sneaking && (this.mode === 'creative' || this.hunger > 4);

    // Movement vector relative to yaw
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    let moveX = (-sinY * input.moveForward + cosY * input.moveRight);
    let moveZ = (-cosY * input.moveForward - sinY * input.moveRight);
    const len = Math.hypot(moveX, moveZ);
    if (len > 1) { moveX /= len; moveZ /= len; }

    let speed = superMob ? 5.6 : 4.6;
    if (this.flying) speed = this.sprinting ? 14.5 : 9.5;
    else if (this.sneaking) speed = 2.1;
    else if (this.sprinting) speed = superMob ? 8.6 : 6.5;
    else if (this.inWater) speed = 3.2;

    const targetVx = moveX * speed;
    const targetVz = moveZ * speed;
    const accel = this.onGround || this.flying ? 16 : 6;
    this.vel.x = THREE.MathUtils.lerp(this.vel.x, targetVx, Math.min(1, dt * accel));
    this.vel.z = THREE.MathUtils.lerp(this.vel.z, targetVz, Math.min(1, dt * accel));

    // Vertical physics
    if (this.flying) {
      let vy = 0;
      if (input.jump) vy += 7.5;
      if (input.sneak) vy -= 7.5;
      this.vel.y = THREE.MathUtils.lerp(this.vel.y, vy, Math.min(1, dt * 10));
      this.fallStartY = null;
    } else if (onLadder) {
      this.vel.y = input.jump || input.moveForward > 0.2 ? 3.8 : (input.sneak ? 0 : -2.5);
      this.fallStartY = null;
    } else if (this.inWater) {
      this.vel.y -= 9.5 * dt;
      if (input.jump) this.vel.y = 4.2;
      this.vel.y = Math.max(-4.5, Math.min(4.5, this.vel.y));
      this.fallStartY = null;
    } else {
      const grav = moonGrav ? 9.5 : 25.0;
      const jumpV = moonGrav ? 8.6 : (superMob ? 10.6 : 8.4);
      this.vel.y -= grav * dt;
      if (input.jump && this.onGround) {
        this.vel.y = jumpV;
        this.onGround = false;
      }
    }

    // Horizontal move with sneak edge-clamp
    const dx = this.vel.x * dt;
    const dz = this.vel.z * dt;

    if (dx !== 0) {
      const nx = this.pos.x + dx;
      const safeEdge = !this.sneaking || !this.onGround || this.collidesAt(nx, this.pos.y - 0.2, this.pos.z);
      if (!this.collidesAt(nx, this.pos.y, this.pos.z) && safeEdge) {
        this.pos.x = nx;
      } else {
        this.vel.x = 0;
      }
    }

    if (dz !== 0) {
      const nz = this.pos.z + dz;
      const safeEdge = !this.sneaking || !this.onGround || this.collidesAt(this.pos.x, this.pos.y - 0.2, nz);
      if (!this.collidesAt(this.pos.x, this.pos.y, nz) && safeEdge) {
        this.pos.z = nz;
      } else {
        this.vel.z = 0;
      }
    }

    // Vertical move
    const dy = this.vel.y * dt;
    const ny = this.pos.y + dy;
    if (this.collidesAt(this.pos.x, ny, this.pos.z)) {
      if (this.vel.y < 0) {
        // Landed
        const landedY = Math.floor(ny) + 1;
        if (this.fallStartY !== null && !this.inWater && this.mode === 'survival' && !moonGrav) {
          const drop = this.fallStartY - landedY;
          if (drop > 3.5) {
            const rawDmg = Math.floor(drop - 3);
            this.takeDamage(superMob ? Math.max(1, Math.floor(rawDmg * 0.5)) : rawDmg, 'Fell from a high place');
          }
        }
        this.fallStartY = null;
        this.pos.y = landedY;
        this.onGround = true;
      }
      this.vel.y = 0;
    } else {
      if (this.onGround && this.vel.y < 0) this.fallStartY = this.pos.y;
      if (!this.onGround && this.vel.y < 0 && (this.fallStartY === null || this.pos.y > this.fallStartY)) {
        this.fallStartY = this.pos.y;
      }
      this.pos.y = ny;
      this.onGround = false;
    }

    // Void protection
    if (this.pos.y < -12) {
      this.takeDamage(20, 'Fell out of the world');
    }

    // Footstep sound + hunger drain
    const horizSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && horizSpeed > 0.6) {
      this.stepDist += horizSpeed * dt;
      if (this.stepDist > (this.sprinting ? 2.4 : 2.0)) {
        this.stepDist = 0;
        const below = getBlockDef(this.world.getBlock(this.pos.x, this.pos.y - 0.2, this.pos.z));
        this.sound.playStep(below ? below.sound : 'grass');
      }
    }

    // Survival Hunger, Air, Regen
    if (this.mode === 'survival') {
      // Drowning
      if (this.headInWater) {
        this.air = Math.max(0, this.air - dt * 1.1);
        if (this.air <= 0) {
          this.drownTimer += dt;
          if (this.drownTimer >= 1.2) {
            this.drownTimer = 0;
            this.takeDamage(2, 'Drowned');
          }
        }
      } else if (this.air < this.maxAir) {
        this.air = Math.min(this.maxAir, this.air + dt * 4.5);
      }

      // Hunger
      const drain = this.sprinting ? 0.09 : (horizSpeed > 0.5 ? 0.025 : 0.008);
      this.hungerTimer += dt * drain;
      if (this.hungerTimer >= 1.0) {
        this.hungerTimer = 0;
        if (this.hunger > 0) {
          this.hunger = Math.max(0, this.hunger - 0.5);
          if (this.onHudDirty) this.onHudDirty();
        } else if (this.hp > 2) {
          this.takeDamage(1, 'Starved');
        }
      }

      // Natural Health Regeneration when well-fed
      if (this.hunger >= 17 && this.hp < this.maxHp) {
        this.regenTimer += dt;
        if (this.regenTimer >= 2.5) {
          this.regenTimer = 0;
          this.hp = Math.min(this.maxHp, this.hp + 1);
          if (this.onHudDirty) this.onHudDirty();
        }
      }
    }

    // Update Camera (0 = 1st person, 1 = 3rd person back, 2 = 3rd person front)
    const eye = this.getEyePosition();
    const targetFov = this.baseFov + (this.sprinting ? 8 : 0);
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, Math.min(1, dt * 10));
      this.camera.updateProjectionMatrix();
    }

    if (this.cameraMode === 1) {
      const dir = this.getLookDirection();
      const camPos = eye.clone().addScaledVector(dir, -3.8);
      camPos.y += 0.45;
      this.camera.position.copy(camPos);
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = this.yaw;
      this.camera.rotation.x = this.pitch;
      this.camera.rotation.z = 0;
      this.handGroup.visible = false;
      this.playerModel.root.visible = true;
    } else if (this.cameraMode === 2) {
      const dir = this.getLookDirection();
      const camPos = eye.clone().addScaledVector(dir, 3.6);
      camPos.y += 0.35;
      this.camera.position.copy(camPos);
      this.camera.lookAt(eye.x, eye.y - 0.15, eye.z);
      this.handGroup.visible = false;
      this.playerModel.root.visible = true;
    } else {
      this.camera.position.copy(eye);
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = this.yaw;
      this.camera.rotation.x = this.pitch;
      this.camera.rotation.z = 0;
      this.handGroup.visible = true;
      this.playerModel.root.visible = false;
    }

    // Held item shape, pixel-art texture & dynamic torch/glowstone light!
    const held = this.inventory.getHeldDef();
    const heldCol = held
      ? (held.id.includes('diamond') ? 0x4de3e8 :
         held.id.includes('gold') ? 0xf5d033 :
         held.id.includes('iron') ? 0xdde2e8 :
         held.id.includes('stone') || held.id.includes('cobble') ? 0x8e939c :
         held.id.includes('grass') || held.id.includes('leaves') ? 0x5da135 :
         held.id.includes('wood') || held.id.includes('oak') || held.id.includes('spruce') ? 0xa87c46 :
         held.id.includes('birch') ? 0xd9cfa8 :
         held.id.includes('tnt') ? 0xc9382b :
         held.id.includes('torch') || held.id.includes('glowstone') ? 0xffc65c :
         held.id.includes('sand') ? 0xdfd09c :
         held.id.includes('snow') ? 0xf0f6fc :
         held.id.includes('apple') || held.id.includes('pork') || held.id.includes('beef') || held.id.includes('venison') || held.id.includes('salmon') ? 0xe05555 : 0xc9b393)
      : 0xdba882;

    const isBlockHeld = !!(held && held.isBlock && !held.cross);
    const isSpriteHeld = !!(held && !isBlockHeld);
    this.heldBlockMesh.visible = isBlockHeld;
    this.heldSpriteMesh.visible = isSpriteHeld;
    this.armMesh.visible = !isBlockHeld && !isSpriteHeld;
    this.sleeveMesh.visible = !isBlockHeld && !isSpriteHeld;

    if (isBlockHeld && this.textures && this._lastHeldBlockId !== held.id) {
      this._lastHeldBlockId = held.id;
      this.heldBlockMesh.geometry = this.textures.createBlockDropGeometry(held, 0.26);
    } else if (isSpriteHeld && this.textures && this._lastHeldSpriteId !== held.id) {
      this._lastHeldSpriteId = held.id;
      this.heldSpriteMat.map = this.textures.getItemTexture(held.id);
      this.heldSpriteMat.needsUpdate = true;
    }

    // Dynamic Torch / Glowstone Light flicker
    const emitsLight = !!(held && (held.id === 'torch' || held.id === 'glowstone'));
    if (emitsLight) {
      const flicker = 1.65 + Math.sin(performance.now() * 0.015) * 0.16 + Math.cos(performance.now() * 0.037) * 0.08;
      this.heldLight.intensity = flicker;
    } else {
      this.heldLight.intensity = 0;
    }

    // Animate 1st-Person Held Arm/Item
    if (this.swingAnim > 0) this.swingAnim = Math.max(0, this.swingAnim - dt * 5.8);
    if (this.eatAnim > 0) this.eatAnim = Math.max(0, this.eatAnim - dt * 2.5);

    const speedRatio = Math.min(1.5, horizSpeed / 4.6);
    if (this.onGround && horizSpeed > 0.25) {
      this.walkPhase += dt * (this.sprinting ? 13.5 : 9.2) * Math.max(0.5, speedRatio);
    }

    const bobY = this.onGround && horizSpeed > 0.25 ? Math.sin(this.walkPhase * 2) * (this.sprinting ? 0.038 : 0.022) : 0;
    const bobX = this.onGround && horizSpeed > 0.25 ? Math.cos(this.walkPhase) * 0.018 : 0;
    const eatBounce = this.eatAnim > 0 ? Math.sin(this.eatAnim * Math.PI * 6) * 0.055 : 0;
    const swingArc = Math.sin(this.swingAnim * Math.PI);

    this.handPivot.position.set(
      0.52 + bobX - (this.eatAnim > 0 ? 0.16 : 0),
      -0.46 + bobY + eatBounce + (this.eatAnim > 0 ? 0.12 : 0),
      -0.62 + swingArc * 0.14
    );
    this.handPivot.rotation.set(
      0.22 - swingArc * 1.05,
      -0.26 + swingArc * 0.28,
      0.08 + swingArc * 0.22
    );

    // Animate 3D Player Model (for 3rd-person views)
    const pm = this.playerModel;
    pm.root.position.copy(this.pos);
    pm.root.rotation.y = this.yaw;

    // Head looks up/down
    pm.headPivot.rotation.x = this.pitch * 0.85;

    // Body pose (Sneak, Fly, Swim)
    const targetBodyPitch = this.flying ? -0.35 : (this.inWater && horizSpeed > 0.4 ? -0.55 : (this.sneaking ? -0.25 : 0));
    pm.bodyPivot.rotation.x = THREE.MathUtils.lerp(pm.bodyPivot.rotation.x, targetBodyPitch, Math.min(1, dt * 12));
    pm.bodyPivot.position.y = this.sneaking ? -0.14 : 0;

    // Limb swing animations
    const legSwing = (this.onGround && horizSpeed > 0.25)
      ? Math.sin(this.walkPhase) * (this.sprinting ? 0.85 : 0.58)
      : (this.inWater ? Math.sin(performance.now() * 0.01) * 0.45 : (!this.onGround && !this.flying ? 0.35 : 0));

    pm.leftLeg.rotation.x = THREE.MathUtils.lerp(pm.leftLeg.rotation.x, legSwing, Math.min(1, dt * 16));
    pm.rightLeg.rotation.x = THREE.MathUtils.lerp(pm.rightLeg.rotation.x, -legSwing, Math.min(1, dt * 16));
    pm.leftArm.rotation.x = THREE.MathUtils.lerp(pm.leftArm.rotation.x, -legSwing * 0.85, Math.min(1, dt * 16));

    // Right arm combines walk swing + mining/attack swing
    const rightArmTarget = this.swingAnim > 0
      ? (1.45 - swingArc * 1.9)
      : (legSwing * 0.85 + (held ? 0.25 : 0));
    pm.rightArm.rotation.x = THREE.MathUtils.lerp(pm.rightArm.rotation.x, rightArmTarget, Math.min(1, dt * 20));

    // Held item on 3D player model
    pm.heldItem.visible = !!held;
    if (held) pm.heldItem.material.color.setHex(heldCol);
  }

  getMiningSpeed(blockDef) {
    if (this.mode === 'creative') return 999;
    if (!blockDef || blockDef.hardness < 0) return 0;
    if (blockDef.hardness <= 0.06) return 100;

    const held = this.inventory.getHeldDef();
    let mult = 1.0;
    if (held && held.toolType && held.toolType === blockDef.tool) {
      mult = held.speed || 2.0;
    }
    return mult / (blockDef.hardness * 1.15);
  }

  canHarvest(blockDef) {
    if (this.mode === 'creative') return true;
    if (!blockDef.minTier) return true;
    const held = this.inventory.getHeldDef();
    if (!held || held.toolType !== blockDef.tool) return false;
    return (held.tier || 0) >= blockDef.minTier;
  }
}
