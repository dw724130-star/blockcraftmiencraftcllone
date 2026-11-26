import * as THREE from 'three';
import { BLOCK, ITEMS, getBlockDef, isBlockSolid, isBlockLiquid, isDoorBlock, isFenceGateBlock, isFenceOrGate } from './blocks.js';

const PLAYER_RADIUS = 0.33;
const PLAYER_HEIGHT = 1.75;
const EYE_HEIGHT = 1.56;

// Shared Classic Minecraft Steve 3D Model + Visible 3D Armor Shells (used by BOTH 3rd-Person Player AND Inventory Doll!)
export function createSteveModel(textures) {
  const root = new THREE.Group();
  const sTex = textures && textures.getSteveTextures ? textures.getSteveTextures() : null;

  const skinMat = new THREE.MeshLambertMaterial({ color: 0xc6906c });
  const sleeveMat = new THREE.MeshLambertMaterial({ color: 0x14a6ad });
  const jeanTopMat = new THREE.MeshLambertMaterial({ color: 0x262169 });
  const shoeBotMat = new THREE.MeshLambertMaterial({ color: 0x303030 });

  const headMats = sTex ? [
    new THREE.MeshLambertMaterial({ map: sTex.headSide }),
    new THREE.MeshLambertMaterial({ map: sTex.headSide }),
    new THREE.MeshLambertMaterial({ map: sTex.headTop }),
    new THREE.MeshLambertMaterial({ map: sTex.headBottom }),
    new THREE.MeshLambertMaterial({ map: sTex.headBack }),
    new THREE.MeshLambertMaterial({ map: sTex.headFront })
  ] : skinMat;

  const torsoMats = sTex ? [
    new THREE.MeshLambertMaterial({ map: sTex.torsoSide }),
    new THREE.MeshLambertMaterial({ map: sTex.torsoSide }),
    sleeveMat,
    jeanTopMat,
    new THREE.MeshLambertMaterial({ map: sTex.torsoBack }),
    new THREE.MeshLambertMaterial({ map: sTex.torsoFront })
  ] : sleeveMat;

  const armMats = sTex ? [
    new THREE.MeshLambertMaterial({ map: sTex.armSide }),
    new THREE.MeshLambertMaterial({ map: sTex.armSide }),
    sleeveMat,
    skinMat,
    new THREE.MeshLambertMaterial({ map: sTex.armFront }),
    new THREE.MeshLambertMaterial({ map: sTex.armFront })
  ] : skinMat;

  const legMats = sTex ? [
    new THREE.MeshLambertMaterial({ map: sTex.legSide }),
    new THREE.MeshLambertMaterial({ map: sTex.legSide }),
    jeanTopMat,
    shoeBotMat,
    new THREE.MeshLambertMaterial({ map: sTex.legFront }),
    new THREE.MeshLambertMaterial({ map: sTex.legFront })
  ] : jeanTopMat;

  const bodyPivot = new THREE.Group();
  root.add(bodyPivot);

  const placeholderMat = new THREE.MeshLambertMaterial({ color: 0xd0d6de });

  // Legs (pivoted at hip Y = 0.70, classic Steve 4x12x4 proportions!)
  const makeLeg = (xOff) => {
    const pivot = new THREE.Group();
    pivot.position.set(xOff, 0.70, 0);
    const legMesh = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.70, 0.24), legMats);
    legMesh.position.set(0, -0.35, 0);
    legMesh.castShadow = true;
    pivot.add(legMesh);

    // 3D Legging Greave Shell
    const legArmor = new THREE.Mesh(new THREE.BoxGeometry(0.285, 0.48, 0.285), placeholderMat);
    legArmor.position.set(0, -0.24, 0);
    legArmor.visible = false;
    pivot.add(legArmor);

    // 3D Armored Boot Shell
    const bootArmor = new THREE.Mesh(new THREE.BoxGeometry(0.305, 0.24, 0.315), placeholderMat);
    bootArmor.position.set(0, -0.59, -0.01);
    bootArmor.visible = false;
    pivot.add(bootArmor);

    bodyPivot.add(pivot);
    return { pivot, legArmor, bootArmor };
  };
  const leftLegObj = makeLeg(-0.125);
  const rightLegObj = makeLeg(0.125);

  // Torso (Y = 0.70 .. 1.40, classic Steve 8x12x4 proportions!)
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.49, 0.70, 0.25), torsoMats);
  torso.position.set(0, 1.05, 0);
  torso.castShadow = true;
  bodyPivot.add(torso);

  // 3D Chestplate Cuirass Shell
  const chestArmor = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.73, 0.315), placeholderMat);
  chestArmor.position.set(0, 1.05, 0);
  chestArmor.visible = false;
  bodyPivot.add(chestArmor);

  // 3D Leggings Waist Belt Shell
  const waistArmor = new THREE.Mesh(new THREE.BoxGeometry(0.535, 0.16, 0.295), placeholderMat);
  waistArmor.position.set(0, 0.74, 0);
  waistArmor.visible = false;
  bodyPivot.add(waistArmor);

  // Arms (pivoted at shoulder Y = 1.38, classic Steve 4x12x4 proportions!)
  const makeArm = (xOff, isRight) => {
    const pivot = new THREE.Group();
    pivot.position.set(xOff, 1.38, 0);
    const armMesh = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.70, 0.24), armMats);
    armMesh.position.set(0, -0.33, 0);
    armMesh.castShadow = true;
    pivot.add(armMesh);

    // 3D Chestplate Shoulder Pauldron Shell
    const pauldronArmor = new THREE.Mesh(new THREE.BoxGeometry(0.285, 0.34, 0.285), placeholderMat);
    pauldronArmor.position.set(0, -0.15, 0);
    pauldronArmor.visible = false;
    pivot.add(pauldronArmor);

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
    return { pivot, pauldronArmor, heldItem };
  };
  const leftArmObj = makeArm(-0.365, false);
  const rightArmObj = makeArm(0.365, true);

  // Head (pivoted at neck Y = 1.40, classic Steve 8x8x8 proportions!)
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 1.40, 0);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.48, 0.48), headMats);
  head.position.set(0, 0.24, 0);
  head.castShadow = true;
  headPivot.add(head);

  // 3D Helmet Shell (with open front face visor cutout so Steve's eyes & goatee shine through!)
  const helmArmor = new THREE.Mesh(new THREE.BoxGeometry(0.545, 0.545, 0.545), placeholderMat);
  helmArmor.position.set(0, 0.245, 0);
  helmArmor.visible = false;
  headPivot.add(helmArmor);

  bodyPivot.add(headPivot);

  return {
    root,
    bodyPivot,
    headPivot,
    leftLeg: leftLegObj.pivot,
    rightLeg: rightLegObj.pivot,
    leftArm: leftArmObj.pivot,
    rightArm: rightArmObj.pivot,
    heldItem: rightArmObj.heldItem,
    armorMeshes: {
      helm: helmArmor,
      chest: chestArmor,
      pauldronL: leftArmObj.pauldronArmor,
      pauldronR: rightArmObj.pauldronArmor,
      waist: waistArmor,
      legL: leftLegObj.legArmor,
      legR: rightLegObj.legArmor,
      bootL: leftLegObj.bootArmor,
      bootR: rightLegObj.bootArmor
    },
    _textures: textures,
    _armorMatCache: {},
    _lastArmorSig: ''
  };
}

function resolveArmorTier(item) {
  if (!item || !item.id) return null;
  if (item.id.startsWith('diamond')) return 'diamond';
  if (item.id.startsWith('iron')) return 'iron';
  if (item.id.startsWith('golden') || item.id.startsWith('gold')) return 'golden';
  if (item.id.startsWith('leather')) return 'leather';
  return null;
}

export function updateSteveArmor(model, armorArray) {
  if (!model || !model.armorMeshes) return;
  const t0 = resolveArmorTier(armorArray && armorArray[0]);
  const t1 = resolveArmorTier(armorArray && armorArray[1]);
  const t2 = resolveArmorTier(armorArray && armorArray[2]);
  const t3 = resolveArmorTier(armorArray && armorArray[3]);
  const sig = `${t0 || ''}|${t1 || ''}|${t2 || ''}|${t3 || ''}`;
  if (sig === model._lastArmorSig) return;
  model._lastArmorSig = sig;

  const getTierMats = (tier) => {
    if (!tier) return null;
    if (model._armorMatCache[tier]) return model._armorMatCache[tier];
    const at = model._textures && model._textures.getArmorTextures ? model._textures.getArmorTextures(tier) : null;
    if (!at) return null;
    const clearMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    const helmFrontM = new THREE.MeshLambertMaterial({ map: at.helmFront, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide });
    const helmSideM = new THREE.MeshLambertMaterial({ map: at.helmSide, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide });
    const helmTopM = new THREE.MeshLambertMaterial({ map: at.helmTop });
    const chestFrontM = new THREE.MeshLambertMaterial({ map: at.chestFront });
    const chestBackM = new THREE.MeshLambertMaterial({ map: at.chestBack });
    const pauldronM = new THREE.MeshLambertMaterial({ map: at.pauldron });
    const leggingM = new THREE.MeshLambertMaterial({ map: at.legging });
    const bootM = new THREE.MeshLambertMaterial({ map: at.boot });
    const bundle = {
      helm: [helmSideM, helmSideM, helmTopM, clearMat, helmSideM, helmFrontM],
      chest: [chestBackM, chestBackM, chestBackM, chestBackM, chestBackM, chestFrontM],
      pauldron: pauldronM,
      legging: leggingM,
      boot: bootM
    };
    model._armorMatCache[tier] = bundle;
    return bundle;
  };

  const am = model.armorMeshes;
  const m0 = getTierMats(t0);
  am.helm.visible = !!m0;
  if (m0) am.helm.material = m0.helm;

  const m1 = getTierMats(t1);
  am.chest.visible = !!m1;
  am.pauldronL.visible = !!m1;
  am.pauldronR.visible = !!m1;
  if (m1) {
    am.chest.material = m1.chest;
    am.pauldronL.material = m1.pauldron;
    am.pauldronR.material = m1.pauldron;
  }

  const m2 = getTierMats(t2);
  am.waist.visible = !!m2;
  am.legL.visible = !!m2;
  am.legR.visible = !!m2;
  if (m2) {
    am.waist.material = m2.legging;
    am.legL.material = m2.legging;
    am.legR.material = m2.legging;
  }

  const m3 = getTierMats(t3);
  am.bootL.visible = !!m3;
  am.bootR.visible = !!m3;
  if (m3) {
    am.bootL.material = m3.boot;
    am.bootR.material = m3.boot;
  }
}

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
    this.inLava = false;
    this.headInLava = false;
    this.inFire = false;
    this.burnTimer = 0;
    this._burnTick = 0;
    this.flying = false;
    this.sneaking = false;
    this.sprinting = false;
    this.cameraMode = 0; // 0 = 1st person, 1 = 3rd person back, 2 = 3rd person front
    this.walkPhase = 0;
    this.eatAnim = 0;
    this.isEating = false;
    this.eatProgress = 0;
    this.eatTime = 0;
    this._eatBlend = 0;
    this.flightSpeed = 1.0;
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

    // Active Potion / Cheat Status Effects (seconds remaining)
    this.statusEffects = { speed: 0, jump: 0, regen: 0, nightvision: 0 };
    this._effectRegenTick = 0;

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

    // Sculpted 3D First-Person Held Torch Model!
    this.heldTorchGroup = new THREE.Group();
    const htWoodMat = new THREE.MeshLambertMaterial({ color: 0x9c6e3b });
    const htCollarMat = new THREE.MeshLambertMaterial({ color: 0x2c2826 });
    const htHeadMat = new THREE.MeshBasicMaterial({ color: 0xffa62b });
    const htFlameMat = new THREE.MeshBasicMaterial({ color: 0xfff099 });
    const htShaft = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.24, 0.062), htWoodMat);
    htShaft.position.set(0, -0.02, 0);
    const htCollar = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.042, 0.072), htCollarMat);
    htCollar.position.set(0, 0.11, 0);
    const htHead = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.062, 0.068), htHeadMat);
    htHead.position.set(0, 0.16, 0);
    const htTip = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.054, 0.044), htFlameMat);
    htTip.position.set(0, 0.215, 0);
    this.heldTorchGroup.add(htShaft, htCollar, htHead, htTip);
    this.heldTorchGroup.position.set(-0.04, 0.08, -0.14);
    this.heldTorchGroup.rotation.set(0.18, -0.22, 0.12);
    this.heldTorchGroup.visible = false;
    this.handPivot.add(this.heldTorchGroup);

    // Dynamic Torch / Glowstone PointLight (+100% brighter & wider reach!)
    this.heldLight = new THREE.PointLight(0xffb64f, 0, 42, 0.85);
    this.heldLight.position.set(0.3, 0.08, -0.45);
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
    return createSteveModel(this.textures);
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

  applyEffect(name, duration = 60) {
    if (!(name in this.statusEffects)) return false;
    this.statusEffects[name] = Math.max(0, duration);
    if (this.onHudDirty) this.onHudDirty();
    return true;
  }

  clearEffects() {
    for (const k of Object.keys(this.statusEffects)) this.statusEffects[k] = 0;
    if (this.onHudDirty) this.onHudDirty();
  }

  respawn() {
    this.dead = false;
    this.hp = this.maxHp;
    this.hunger = this.maxHunger;
    this.air = this.maxAir;
    this.clearEffects();
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
          const bid = this.world.getBlock(x, y, z);
          if (isBlockSolid(bid)) {
            if (isDoorBlock(bid) && this.world.isDoorOpenAt(x, y, z)) continue;
            if (isFenceGateBlock(bid) && this.world.isFenceGateOpenAt(x, y, z)) continue;
            return true;
          }
          // Authentic Minecraft 1.5-block tall Fence & Closed Fence Gate collision (cannot jump over fences!)
          if (y === minY) {
            const below = this.world.getBlock(x, y - 1, z);
            if (isFenceOrGate(below) && !(isFenceGateBlock(below) && this.world.isFenceGateOpenAt(x, y - 1, z))) {
              if (py < y + 0.48) return true;
            }
          }
        }
      }
    }
    return false;
  }

  update(dt, input, mods = null, gameRules = null) {
    if (this.dead) return;
    const superMob = !!(mods && mods.isEnabled('super_mobility'));
    const moonGrav = !!(mods && mods.isEnabled('moon_gravity'));
    const difficulty = (gameRules && gameRules.difficulty) ? gameRules.difficulty : 'normal';
    const hungerRate = (gameRules && typeof gameRules.hungerRate === 'number') ? Math.max(0, gameRules.hungerRate) : 1.0;

    // Tick active status effects
    for (const k of Object.keys(this.statusEffects)) {
      if (this.statusEffects[k] > 0) {
        this.statusEffects[k] = Math.max(0, this.statusEffects[k] - dt);
      }
    }
    const hasSpeed = this.statusEffects.speed > 0;
    const hasJump = this.statusEffects.jump > 0;
    const hasRegen = this.statusEffects.regen > 0;

    // Look
    this.yaw -= input.lookDeltaX;
    this.pitch = Math.max(-Math.PI / 2 + 0.03, Math.min(Math.PI / 2 - 0.03, this.pitch - input.lookDeltaY));
    input.lookDeltaX = 0;
    input.lookDeltaY = 0;

    // Environment checks (strictly distinguish Water vs Lava vs Fire!)
    const feetBlock = this.world.getBlock(this.pos.x, this.pos.y + 0.2, this.pos.z);
    const waistBlock = this.world.getBlock(this.pos.x, this.pos.y + 0.85, this.pos.z);
    const headBlock = this.world.getBlock(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z);
    const nowInWater = feetBlock === BLOCK.WATER;
    const nowInLava = feetBlock === BLOCK.LAVA || waistBlock === BLOCK.LAVA || headBlock === BLOCK.LAVA;
    const nowInFire = feetBlock === BLOCK.FIRE || waistBlock === BLOCK.FIRE;
    if (nowInWater && !this.wasInWater && this.sound.playSplash) {
      this.sound.playSplash();
    }
    this.wasInWater = nowInWater;
    this.inWater = nowInWater;
    this.headInWater = headBlock === BLOCK.WATER;
    this.inLava = nowInLava;
    this.headInLava = headBlock === BLOCK.LAVA;
    this.inFire = nowInFire;
    if (nowInWater) this.burnTimer = 0;
    const onLadder = feetBlock === BLOCK.LADDER || waistBlock === BLOCK.LADDER || headBlock === BLOCK.LADDER;

    this.sneaking = input.sneak && !this.flying;
    this.sprinting = input.sprint && input.moveForward > 0.4 && !this.sneaking && !this.isEating && (this.mode === 'creative' || this.hunger > 4);

    // Movement vector relative to yaw
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    let moveX = (-sinY * input.moveForward + cosY * input.moveRight);
    let moveZ = (-cosY * input.moveForward - sinY * input.moveRight);
    const len = Math.hypot(moveX, moveZ);
    if (len > 1) { moveX /= len; moveZ /= len; }

    const fMul = Math.max(0.5, Math.min(12, this.flightSpeed || 1.0));
    let speed = superMob ? 5.6 : 4.6;
    if (this.flying) speed = (this.sprinting ? 14.5 : 9.5) * fMul;
    else if (this.inLava) speed = 1.7;
    else if (this.sneaking) speed = 2.1;
    else if (this.sprinting) speed = superMob ? 8.6 : 6.5;
    else if (this.inWater) speed = 3.2;
    if (this.isEating && !this.flying) speed *= 0.48;
    if (hasSpeed && !this.flying) speed *= 1.55;

    const targetVx = moveX * speed;
    const targetVz = moveZ * speed;
    const accel = this.onGround || this.flying ? 16 : 6;
    this.vel.x = THREE.MathUtils.lerp(this.vel.x, targetVx, Math.min(1, dt * accel));
    this.vel.z = THREE.MathUtils.lerp(this.vel.z, targetVz, Math.min(1, dt * accel));

    // Vertical physics
    if (this.flying) {
      let vy = 0;
      const vFlySpd = 7.5 * Math.max(1.0, 0.55 + fMul * 0.45);
      if (input.jump) vy += vFlySpd;
      if (input.sneak) vy -= vFlySpd;
      this.vel.y = THREE.MathUtils.lerp(this.vel.y, vy, Math.min(1, dt * 10));
      this.fallStartY = null;
    } else if (onLadder) {
      // Smooth Minecraft ladder climbing (works seamlessly climbing straight out of water onto bridges!)
      if (input.jump || input.moveForward > 0.15) this.vel.y = 4.4;
      else if (input.sneak) this.vel.y = 0;
      else if (input.moveForward < -0.15) this.vel.y = -3.4;
      else this.vel.y = -1.6;
      this.fallStartY = null;
    } else if (this.inLava) {
      // Thick viscous molten lava: falling through lava is MUCH slower, while pressing Jump swims up & hops cleanly onto banks!
      if (this.vel.y < -1.15) {
        this.vel.y = THREE.MathUtils.lerp(this.vel.y, -1.15, Math.min(1, dt * 9.0));
      } else {
        this.vel.y -= 2.4 * dt;
      }
      if (input.jump) {
        this.vel.y = Math.max(this.vel.y, 4.35);
      }
      this.vel.y = Math.max(-1.15, Math.min(7.2, this.vel.y));
      this.fallStartY = null;
    } else if (this.inWater) {
      this.vel.y -= 9.5 * dt;
      if (input.jump) this.vel.y = Math.max(this.vel.y, 4.4);
      this.vel.y = Math.max(-4.2, Math.min(7.0, this.vel.y));
      this.fallStartY = null;
    } else {
      const grav = moonGrav ? 9.5 : 25.0;
      const jumpV = (moonGrav ? 8.6 : (superMob ? 10.6 : 8.4)) * (hasJump ? 1.42 : 1.0);
      this.vel.y -= grav * dt;
      if (input.jump && this.onGround) {
        this.vel.y = jumpV;
        this.onGround = false;
      }
    }

    // Horizontal move with sneak edge-clamp & authentic Minecraft liquid-to-bank climb hop!
    const dx = this.vel.x * dt;
    const dz = this.vel.z * dt;
    let horizBlocked = false;

    if (dx !== 0) {
      const nx = this.pos.x + dx;
      const safeEdge = !this.sneaking || !this.onGround || this.collidesAt(nx, this.pos.y - 0.2, this.pos.z);
      if (!this.collidesAt(nx, this.pos.y, this.pos.z) && safeEdge) {
        this.pos.x = nx;
      } else {
        horizBlocked = true;
        this.vel.x = 0;
      }
    }

    if (dz !== 0) {
      const nz = this.pos.z + dz;
      const safeEdge = !this.sneaking || !this.onGround || this.collidesAt(this.pos.x, this.pos.y - 0.2, nz);
      if (!this.collidesAt(this.pos.x, this.pos.y, nz) && safeEdge) {
        this.pos.z = nz;
      } else {
        horizBlocked = true;
        this.vel.z = 0;
      }
    }

    // Authentic Minecraft shore-climb hop: pressing Jump while swimming against a block in Lava or Water cleanly vaults you onto the bank!
    if ((this.inLava || this.inWater) && input.jump && horizBlocked) {
      const stepX = this.pos.x + moveX * 0.48;
      const stepZ = this.pos.z + moveZ * 0.48;
      if (!this.collidesAt(stepX, this.pos.y + 1.06, stepZ)) {
        this.vel.y = Math.max(this.vel.y, 6.85);
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
            const mult = (superMob ? 0.5 : 1.0) * (hasJump ? 0.5 : 1.0);
            this.takeDamage(Math.max(1, Math.floor(rawDmg * mult)), 'Fell from a high place');
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

    // Survival Hunger, Air, Lava/Fire Burn, Regen
    if (this.mode === 'survival') {
      // Lava & Fire Damage (authentic Minecraft burning!)
      if (this.inLava) {
        this.burnTimer = Math.max(this.burnTimer, 3.2);
        this._burnTick += dt;
        if (this._burnTick >= 0.5) {
          this._burnTick = 0;
          this.takeDamage(4, 'Tried to swim in lava');
        }
      } else if (this.inFire) {
        this.burnTimer = Math.max(this.burnTimer, 2.2);
        this._burnTick += dt;
        if (this._burnTick >= 0.6) {
          this._burnTick = 0;
          this.takeDamage(2, 'Went up in flames');
        }
      } else if (this.burnTimer > 0) {
        this.burnTimer = Math.max(0, this.burnTimer - dt);
        this._burnTick += dt;
        if (this._burnTick >= 0.9) {
          this._burnTick = 0;
          this.takeDamage(1, 'Burned to a crisp');
        }
      } else {
        this._burnTick = 0;
      }

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

      // Hunger (scaled by Difficulty & Hunger Drain Speed!)
      if (difficulty === 'peaceful') {
        if (this.hunger < this.maxHunger) {
          this.hunger = this.maxHunger;
          if (this.onHudDirty) this.onHudDirty();
        }
        if (this.hp < this.maxHp) {
          this.regenTimer += dt;
          if (this.regenTimer >= 1.2) {
            this.regenTimer = 0;
            this.hp = Math.min(this.maxHp, this.hp + 1);
            if (this.onHudDirty) this.onHudDirty();
          }
        }
      } else {
        const diffHungerMul = difficulty === 'easy' ? 0.75 : (difficulty === 'hard' ? 1.45 : 1.0);
        const effHungerMul = diffHungerMul * hungerRate;
        const drain = this.sprinting ? 0.09 : (horizSpeed > 0.5 ? 0.025 : 0.008);
        if (effHungerMul > 0) {
          this.hungerTimer += dt * drain * effHungerMul;
        }
        if (this.hungerTimer >= 1.0) {
          this.hungerTimer = 0;
          if (this.hunger > 0) {
            this.hunger = Math.max(0, this.hunger - 0.5);
            if (this.onHudDirty) this.onHudDirty();
          } else {
            const minStarveHp = difficulty === 'hard' ? 0 : (difficulty === 'normal' ? 1 : 10);
            if (this.hp > minStarveHp) {
              this.takeDamage(1, 'Starved');
            }
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

      // Potion / Cheat Regeneration Effect
      if (hasRegen && this.hp < this.maxHp) {
        this._effectRegenTick += dt;
        if (this._effectRegenTick >= 0.65) {
          this._effectRegenTick = 0;
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

    const isWallBlock = (wx, wy, wz) => {
      const bid = this.world.getBlock(wx, wy, wz);
      if (!isBlockSolid(bid)) return false;
      if (isDoorBlock(bid) && this.world.isDoorOpenAt(wx, wy, wz)) return false;
      if (isFenceGateBlock(bid) && this.world.isFenceGateOpenAt(wx, wy, wz)) return false;
      return true;
    };

    if (this.cameraMode === 1 || this.cameraMode === 2) {
      const dir = this.getLookDirection();
      const sign = this.cameraMode === 1 ? -1 : 1;
      const maxDist = this.cameraMode === 1 ? 3.8 : 3.6;
      // Ray-step 3rd-person camera against solid walls so it NEVER clips inside blocks!
      let safeDist = maxDist;
      for (let dStep = 0.4; dStep <= maxDist; dStep += 0.22) {
        const cx = eye.x + dir.x * sign * dStep;
        const cy = eye.y + dir.y * sign * dStep + 0.35 * (dStep / maxDist);
        const cz = eye.z + dir.z * sign * dStep;
        if (isWallBlock(cx, cy, cz)) {
          safeDist = Math.max(0.45, dStep - 0.28);
          break;
        }
      }
      const camPos = eye.clone().addScaledVector(dir, sign * safeDist);
      camPos.y += (this.cameraMode === 1 ? 0.42 : 0.32) * (safeDist / maxDist);
      this.camera.position.copy(camPos);
      if (this.cameraMode === 1) {
        this.camera.rotation.order = 'YXZ';
        this.camera.rotation.y = this.yaw;
        this.camera.rotation.x = this.pitch;
        this.camera.rotation.z = 0;
      } else {
        this.camera.lookAt(eye.x, eye.y - 0.15, eye.z);
      }
      this.handGroup.visible = false;
      this.playerModel.root.visible = true;
    } else {
      // Anti-X-Ray Wall Guard: keep 1st-person eye safely padded from adjacent solid block faces!
      const bx = Math.floor(eye.x), by = Math.floor(eye.y), bz = Math.floor(eye.z);
      const pad = 0.22;
      if (isWallBlock(bx + 1, by, bz) && eye.x > bx + 1 - pad) eye.x = bx + 1 - pad;
      if (isWallBlock(bx - 1, by, bz) && eye.x < bx + pad) eye.x = bx + pad;
      if (isWallBlock(bx, by, bz + 1) && eye.z > bz + 1 - pad) eye.z = bz + 1 - pad;
      if (isWallBlock(bx, by, bz - 1) && eye.z < bz + pad) eye.z = bz + pad;
      if (isWallBlock(bx, by + 1, bz) && eye.y > by + 1 - pad) eye.y = by + 1 - pad;
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

    const isTorchHeld = !!(held && held.id === 'torch');
    const isBlockHeld = !!(held && held.isBlock && !held.cross && held.id !== 'bed' && !isTorchHeld);
    const isSpriteHeld = !!(held && !isBlockHeld && !isTorchHeld);
    this.heldTorchGroup.visible = isTorchHeld;
    this.heldBlockMesh.visible = isBlockHeld;
    this.heldSpriteMesh.visible = isSpriteHeld;
    this.armMesh.visible = !isBlockHeld && !isSpriteHeld && !isTorchHeld;
    this.sleeveMesh.visible = !isBlockHeld && !isSpriteHeld && !isTorchHeld;

    if (isBlockHeld && this.textures && this._lastHeldBlockId !== held.id) {
      this._lastHeldBlockId = held.id;
      this.heldBlockMesh.geometry = this.textures.createBlockDropGeometry(held, 0.26);
    } else if (isSpriteHeld && this.textures && this._lastHeldSpriteId !== held.id) {
      this._lastHeldSpriteId = held.id;
      this.heldSpriteMat.map = this.textures.getItemTexture(held.id);
      this.heldSpriteMat.needsUpdate = true;
    }

    // Dynamic Torch / Glowstone Light flicker (+100% brighter & wider reach!)
    const emitsLight = !!(held && (held.id === 'torch' || held.id === 'glowstone'));
    if (emitsLight) {
      const flicker = 10.8 + Math.sin(performance.now() * 0.015) * 0.55 + Math.cos(performance.now() * 0.037) * 0.28;
      this.heldLight.intensity = flicker;
    } else {
      this.heldLight.intensity = 0;
    }

    // Animate 1st-Person Held Arm/Item
    if (this.swingAnim > 0) this.swingAnim = Math.max(0, this.swingAnim - dt * 5.8);
    if (this.eatAnim > 0) this.eatAnim = Math.max(0, this.eatAnim - dt * 2.5);
    const eatTarget = this.isEating ? 1 : 0;
    this._eatBlend = THREE.MathUtils.lerp(this._eatBlend, eatTarget, Math.min(1, dt * (this.isEating ? 14 : 10)));

    const speedRatio = Math.min(1.5, horizSpeed / 4.6);
    if (this.onGround && horizSpeed > 0.25) {
      this.walkPhase += dt * (this.sprinting ? 13.5 : 9.2) * Math.max(0.5, speedRatio);
    }

    const bobY = this.onGround && horizSpeed > 0.25 ? Math.sin(this.walkPhase * 2) * (this.sprinting ? 0.038 : 0.022) : 0;
    const bobX = this.onGround && horizSpeed > 0.25 ? Math.cos(this.walkPhase) * 0.018 : 0;
    const eb = this._eatBlend;
    const chewPhase = this.eatTime * 20.0;
    const eatChompY = eb > 0.01 ? Math.abs(Math.sin(chewPhase)) * 0.068 * eb : 0;
    const eatChompX = eb > 0.01 ? Math.cos(chewPhase) * 0.024 * eb : 0;
    const eatChompZ = eb > 0.01 ? Math.sin(chewPhase) * 0.022 * eb : 0;
    const eatBounce = (this.eatAnim > 0 && !this.isEating) ? Math.sin(this.eatAnim * Math.PI * 6) * 0.04 : 0;
    const swingArc = Math.sin(this.swingAnim * Math.PI);

    this.handPivot.position.set(
      0.52 + bobX * (1 - eb * 0.7) - 0.27 * eb + eatChompX,
      -0.46 + bobY * (1 - eb * 0.7) + 0.19 * eb + eatChompY + eatBounce,
      -0.62 + swingArc * 0.14 + 0.06 * eb + eatChompZ
    );
    this.handPivot.rotation.set(
      0.22 - swingArc * 1.05 + 0.32 * eb - eatChompY * 1.4,
      -0.26 + swingArc * 0.28 + 0.58 * eb,
      0.08 + swingArc * 0.22 + 0.26 * eb + eatChompX * 2.2
    );

    // Animate 3D Player Model (for 3rd-person views) + sync visible 3D Armor!
    const pm = this.playerModel;
    updateSteveArmor(pm, this.inventory.armor);
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

    // Right arm combines walk swing + eating raise + mining/attack swing
    const rightArmTarget = this.isEating
      ? (1.28 + Math.sin(this.eatTime * 19.0) * 0.22)
      : (this.swingAnim > 0
          ? (1.45 - swingArc * 1.9)
          : (legSwing * 0.85 + (held ? 0.25 : 0)));
    pm.rightArm.rotation.x = THREE.MathUtils.lerp(pm.rightArm.rotation.x, rightArmTarget, Math.min(1, dt * 20));
    const rightArmZTarget = this.isEating ? -0.32 : 0;
    pm.rightArm.rotation.z = THREE.MathUtils.lerp(pm.rightArm.rotation.z, rightArmZTarget, Math.min(1, dt * 16));

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
