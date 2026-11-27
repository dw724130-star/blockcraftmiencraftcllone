import * as THREE from 'three';
import { BLOCK, ITEMS, getBlockDef, isBlockSolid, isBlockLiquid, isDoorBlock, isFenceGateBlock, isFenceOrGate, isStairBlock } from './blocks.js';
import { getSavedPlayerName, getSavedPlayerSkin } from './storage.js';

const PLAYER_RADIUS = 0.33;
const PLAYER_HEIGHT = 1.75;
const EYE_HEIGHT = 1.56;

// Authentic Minecraft Floating Nametag Sprite positioned directly above the player's head!
export function createPlayerNametag(name = 'Player', isHost = false) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    opacity: 0.94,
    depthTest: false,
    depthWrite: false
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.12, 0.21, 1);
  sprite.position.set(0, 2.08, 0);
  sprite.renderOrder = 30;
  sprite.frustumCulled = false;
  const tagObj = { sprite, canvas, tex, mat, name: '', isHost: false };
  updatePlayerNametag(tagObj, name, isHost);
  return tagObj;
}

export function updatePlayerNametag(tagObj, name = 'Player', isHost = false) {
  if (!tagObj) return;
  const clean = String(name || 'Player').trim().slice(0, 16) || 'Player';
  const hostFlag = Boolean(isHost);
  if (tagObj.name === clean && tagObj.isHost === hostFlag) return;
  tagObj.name = clean;
  tagObj.isHost = hostFlag;

  const ctx = tagObj.canvas.getContext('2d');
  ctx.clearRect(0, 0, 512, 96);

  const label = hostFlag ? `★ ${clean}` : clean;
  ctx.font = 'bold 46px "Courier New", Consolas, monospace';
  const tw = Math.min(488, Math.max(136, Math.ceil(ctx.measureText(label).width) + 44));
  const rx = Math.round((512 - tw) * 0.5);

  // Classic Minecraft translucent dark nameplate floating cleanly above head
  ctx.fillStyle = 'rgba(0, 0, 0, 0.44)';
  ctx.fillRect(rx, 16, tw, 64);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.82)';
  ctx.fillText(label, 259, 51);
  ctx.fillStyle = hostFlag ? '#ffe57f' : '#ffffff';
  ctx.fillText(label, 256, 48);
  tagObj.tex.needsUpdate = true;
}

function buildSkinMaterialBundle(textures, skinId = 'steve') {
  const sTex = textures && textures.getPlayerSkinTextures
    ? textures.getPlayerSkinTextures(skinId)
    : (textures && textures.getSteveTextures ? textures.getSteveTextures() : null);

  const skinMat = new THREE.MeshLambertMaterial({ color: sTex?.skinHex ?? 0xc6906c });
  const sleeveMat = new THREE.MeshLambertMaterial({ color: sTex?.sleeveHex ?? 0x14a6ad });
  const jeanTopMat = new THREE.MeshLambertMaterial({ color: sTex?.pantHex ?? 0x262169 });
  const shoeBotMat = new THREE.MeshLambertMaterial({ color: sTex?.shoeHex ?? 0x303030 });

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

  return { headMats, torsoMats, armMats, legMats, slimArms: Boolean(sTex?.slimArms), sTex };
}

// Shared Classic Minecraft Character 3D Model + Multi-Skin + Visible 3D Armor Shells (Main Menu, Inventory, 3rd-Person & Multiplayer!)
export function createSteveModel(textures, skinId = null) {
  const resolvedSkin = skinId || getSavedPlayerSkin();
  const root = new THREE.Group();
  const bundle = buildSkinMaterialBundle(textures, resolvedSkin);
  const { headMats, torsoMats, armMats, legMats } = bundle;

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
    return { pivot, legMesh, legArmor, bootArmor };
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

  // Arms (pivoted at shoulder Y = 1.38; Alex slim arms scale X to 0.78!)
  const makeArm = (xOff, isRight) => {
    const pivot = new THREE.Group();
    pivot.position.set(xOff, 1.38, 0);
    const armMesh = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.70, 0.24), armMats);
    armMesh.position.set(0, -0.33, 0);
    armMesh.scale.x = bundle.slimArms ? 0.78 : 1.0;
    armMesh.castShadow = true;
    pivot.add(armMesh);

    // 3D Chestplate Shoulder Pauldron Shell
    const pauldronArmor = new THREE.Mesh(new THREE.BoxGeometry(0.285, 0.34, 0.285), placeholderMat);
    pauldronArmor.position.set(0, -0.15, 0);
    pauldronArmor.visible = false;
    pivot.add(pauldronArmor);

    let heldItem = null;
    if (isRight) {
      heldItem = createHeldItemRig(textures, false);
      pivot.add(heldItem);
    }
    bodyPivot.add(pivot);
    return { pivot, armMesh, pauldronArmor, heldItem };
  };
  const leftArmObj = makeArm(bundle.slimArms ? -0.34 : -0.365, false);
  const rightArmObj = makeArm(bundle.slimArms ? 0.34 : 0.365, true);

  // Head (pivoted at neck Y = 1.40, classic Steve 8x8x8 proportions!)
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 1.40, 0);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.48, 0.48), headMats);
  head.position.set(0, 0.24, 0);
  head.castShadow = true;
  headPivot.add(head);

  // 3D Helmet Shell (with open front face visor cutout so eyes & face shine through!)
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
    heldRig: rightArmObj.heldItem,
    skinMeshes: {
      head,
      torso,
      leftArmMesh: leftArmObj.armMesh,
      rightArmMesh: rightArmObj.armMesh,
      leftLegMesh: leftLegObj.legMesh,
      rightLegMesh: rightLegObj.legMesh
    },
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
    _skinMatCache: { [resolvedSkin]: bundle },
    _armorMatCache: {},
    _lastSkinId: resolvedSkin,
    _lastArmorSig: ''
  };
}

export function updateSteveSkin(model, skinId = 'steve') {
  if (!model || !model.skinMeshes) return;
  const next = skinId || 'steve';
  if (model._lastSkinId === next) return;
  model._lastSkinId = next;
  let bundle = model._skinMatCache[next];
  if (!bundle) {
    bundle = buildSkinMaterialBundle(model._textures, next);
    model._skinMatCache[next] = bundle;
  }
  const sm = model.skinMeshes;
  sm.head.material = bundle.headMats;
  sm.torso.material = bundle.torsoMats;
  sm.leftArmMesh.material = bundle.armMats;
  sm.rightArmMesh.material = bundle.armMats;
  sm.leftLegMesh.material = bundle.legMats;
  sm.rightLegMesh.material = bundle.legMats;

  const armScaleX = bundle.slimArms ? 0.78 : 1.0;
  sm.leftArmMesh.scale.x = armScaleX;
  sm.rightArmMesh.scale.x = armScaleX;
  model.leftArm.position.x = bundle.slimArms ? -0.34 : -0.365;
  model.rightArm.position.x = bundle.slimArms ? 0.34 : 0.365;
}

// Minecraft Red Damage Tint Flash across a player's 3D skin & armor meshes!
export function setSteveHurtFlash(model, active) {
  if (!model) return;
  const flag = Boolean(active);
  if (model._hurtFlashing === flag) return;
  model._hurtFlashing = flag;
  const applyMat = (m) => {
    if (!m) return;
    if (Array.isArray(m)) {
      for (let i = 0; i < m.length; i++) applyMat(m[i]);
      return;
    }
    if (m.emissive) m.emissive.setHex(flag ? 0xb81616 : 0x000000);
    if (m.color) m.color.setHex(flag ? 0xff5a5a : 0xffffff);
  };
  if (model.skinMeshes) {
    for (const mesh of Object.values(model.skinMeshes)) {
      if (mesh) applyMat(mesh.material);
    }
  }
  if (model.armorMeshes) {
    for (const mesh of Object.values(model.armorMeshes)) {
      if (mesh && mesh.visible) applyMat(mesh.material);
    }
  }
}

// Shared geometries/materials for sculpted 3D held torches (reused across 1st-person, 3rd-person & all multiplayer friends!)
let _sharedTorchAssets = null;
function getSharedTorchAssets() {
  if (_sharedTorchAssets) return _sharedTorchAssets;
  _sharedTorchAssets = {
    woodGeo: new THREE.BoxGeometry(0.062, 0.26, 0.062),
    collarGeo: new THREE.BoxGeometry(0.074, 0.044, 0.074),
    headGeo: new THREE.BoxGeometry(0.070, 0.064, 0.070),
    tipGeo: new THREE.BoxGeometry(0.044, 0.056, 0.044),
    woodMat: new THREE.MeshLambertMaterial({ color: 0x9c6e3b }),
    collarMat: new THREE.MeshLambertMaterial({ color: 0x2c2826 }),
    headMat: new THREE.MeshBasicMaterial({ color: 0xffa62b }),
    flameMat: new THREE.MeshBasicMaterial({ color: 0xfff099 })
  };
  return _sharedTorchAssets;
}

// Unified Detailed 3D Held-Item Rig (used in 1st-person hand, 3rd-person Steve, AND multiplayer remote players!)
export function createHeldItemRig(textures, isFirstPerson = false) {
  const rig = new THREE.Group();
  rig.visible = false;

  const blockMat = textures && textures.getBlockAtlasMaterial
    ? textures.getBlockAtlasMaterial()
    : new THREE.MeshLambertMaterial({ color: 0xc9b393 });
  const blockMesh = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.24), blockMat);
  blockMesh.visible = false;
  rig.add(blockMesh);

  // Inner pivot for voxel-extruded 3D tools, swords, foods, buckets, doors, gems, flowers & armor
  const itemPivot = new THREE.Group();
  itemPivot.rotation.order = 'YXZ';
  const itemMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.01, 0.01, 0.01),
    new THREE.MeshLambertMaterial({ color: 0xffffff })
  );
  itemPivot.add(itemMesh);
  itemPivot.visible = false;
  rig.add(itemPivot);

  // Sculpted 3D Torch (wood shaft + soot collar + glowing ember + flame tip)
  const ta = getSharedTorchAssets();
  const torchGroup = new THREE.Group();
  const tShaft = new THREE.Mesh(ta.woodGeo, ta.woodMat);
  tShaft.position.set(0, -0.02, 0);
  const tCollar = new THREE.Mesh(ta.collarGeo, ta.collarMat);
  tCollar.position.set(0, 0.12, 0);
  const tHead = new THREE.Mesh(ta.headGeo, ta.headMat);
  tHead.position.set(0, 0.17, 0);
  const tTip = new THREE.Mesh(ta.tipGeo, ta.flameMat);
  tTip.position.set(0, 0.228, 0);
  torchGroup.add(tShaft, tCollar, tHead, tTip);
  torchGroup.visible = false;
  rig.add(torchGroup);

  rig.userData = {
    isFirstPerson,
    blockMesh,
    itemPivot,
    itemMesh,
    torchGroup,
    lastItemId: null
  };
  return rig;
}

// Updates a held-item rig to the exact 3D model + authentic Minecraft hand grip & tool orientation!
export function updateHeldItemRig(rig, itemDef, textures, isFirstPerson = false) {
  if (!rig || !rig.userData) return;
  const ud = rig.userData;
  const nextId = itemDef ? itemDef.id : null;
  if (!nextId) {
    rig.visible = false;
    ud.lastItemId = null;
    return;
  }
  rig.visible = true;
  if (ud.lastItemId === nextId) return;
  ud.lastItemId = nextId;

  const { blockMesh, itemPivot, itemMesh, torchGroup } = ud;
  blockMesh.visible = false;
  itemPivot.visible = false;
  torchGroup.visible = false;

  // 1. Sculpted 3D Torch
  if (nextId === 'torch') {
    torchGroup.visible = true;
    if (isFirstPerson) {
      torchGroup.scale.setScalar(1.05);
      torchGroup.position.set(-0.04, 0.08, -0.14);
      torchGroup.rotation.set(0.14, -0.20, 0.10);
    } else {
      torchGroup.scale.setScalar(1.18);
      torchGroup.position.set(0.0, -0.56, -0.14);
      torchGroup.rotation.set(-0.48, 0, 0);
    }
    return;
  }

  // 2. Full 3D Block Models (Cubes, Stairs, Fences, Fence Gates, Beds, Ladders)
  const is3DBlockShape = !!(
    itemDef.isBlock &&
    !itemDef.cross &&
    !itemDef.isDoor
  );
  if (is3DBlockShape && textures && textures.createBlockDropGeometry) {
    const size = isFirstPerson ? 0.29 : 0.27;
    blockMesh.geometry = textures.createBlockDropGeometry(itemDef, size);
    blockMesh.material = textures.getBlockAtlasMaterial();
    blockMesh.visible = true;
    if (isFirstPerson) {
      if (itemDef.id === 'bed') {
        blockMesh.position.set(-0.04, 0.08, -0.15);
        blockMesh.rotation.set(0.24, 0.72, 0.06);
      } else if (itemDef.isFence || itemDef.isFenceGate || itemDef.id === 'ladder') {
        blockMesh.position.set(-0.04, 0.09, -0.14);
        blockMesh.rotation.set(0.12, 0.48, 0.06);
      } else {
        blockMesh.position.set(-0.04, 0.08, -0.14);
        blockMesh.rotation.set(0.20, 0.68, 0.05);
      }
    } else {
      blockMesh.position.set(0.0, -0.60, -0.18);
      blockMesh.rotation.set(0.26, 0.62, 0.08);
    }
    return;
  }

  // 3. Detailed 3D Voxel-Extruded Pixel-Art Model for ALL Tools, Weapons, Foods, Buckets, Doors, Ores, Gems & Items!
  if (textures && textures.createExtrudedItemGeometry) {
    const tt = itemDef.toolType || null;
    const isHandheldTool = tt === 'pickaxe' || tt === 'axe' || tt === 'shovel' || tt === 'hoe' || tt === 'sword';
    const size = isHandheldTool
      ? (isFirstPerson ? 0.56 : 0.62)
      : (itemDef.isDoor ? (isFirstPerson ? 0.40 : 0.42) : (isFirstPerson ? 0.36 : 0.36));

    itemMesh.geometry = textures.createExtrudedItemGeometry(nextId, size);
    itemMesh.material = textures.getExtrudedItemMaterial(nextId);
    itemPivot.visible = true;

    if (isHandheldTool) {
      // Anchor pivot cleanly at the bottom-left handle so the hand grips the handle naturally!
      itemMesh.position.set(size * 0.30, size * 0.30, 0);
      // For Axe & Hoe, pure rigid rotation (Rx=PI, Rz=PI/2) keeps handle in hand & flips blade/hook to face FORWARD & DOWN!
      if (tt === 'axe' || tt === 'hoe') {
        itemMesh.rotation.set(Math.PI, 0, Math.PI * 0.5);
      } else {
        // Pickaxe, Sword, Shovel: shaft runs bottom-left -> top-right, pickaxe front prong already curves forward-down!
        itemMesh.rotation.set(0, 0, 0);
      }

      if (isFirstPerson) {
        itemPivot.position.set(-0.02, -0.04, -0.10);
        if (tt === 'sword') {
          // Proud forward-up Minecraft combat stance (with 'YXZ', Rz pitches forward-down in tool plane, Ry faces -Z!)
          itemPivot.rotation.set(0.04, Math.PI * 0.44, 0.06);
        } else if (tt === 'pickaxe') {
          // Pickaxe head pointing cleanly forward & curving down toward blocks
          itemPivot.rotation.set(0.04, Math.PI * 0.47, -0.22);
        } else if (tt === 'axe' || tt === 'hoe') {
          // Cutting/tilling edge facing cleanly forward-down
          itemPivot.rotation.set(0.04, Math.PI * 0.47, -0.18);
        } else {
          // Shovel ready to dig forward
          itemPivot.rotation.set(0.04, Math.PI * 0.47, -0.24);
        }
      } else {
        // 3rd-Person & Multiplayer Remote Steve: handle gripped inside right fist, tool pointing straight forward (-Z)!
        itemPivot.position.set(0.02, -0.58, -0.10);
        if (tt === 'sword') {
          itemPivot.rotation.set(0.0, Math.PI * 0.5, -0.32);
        } else {
          itemPivot.rotation.set(0.0, Math.PI * 0.5, -0.52);
        }
      }
    } else if (itemDef.id === 'stick') {
      itemMesh.position.set(size * 0.24, size * 0.24, 0);
      itemMesh.rotation.set(0, 0, 0);
      if (isFirstPerson) {
        itemPivot.position.set(-0.02, -0.02, -0.12);
        itemPivot.rotation.set(0.04, Math.PI * 0.45, -0.12);
      } else {
        itemPivot.position.set(0.02, -0.58, -0.10);
        itemPivot.rotation.set(0.0, Math.PI * 0.5, -0.45);
      }
    } else if (itemDef.isDoor) {
      itemMesh.position.set(0, size * 0.15, 0);
      itemMesh.rotation.set(0, 0, 0);
      if (isFirstPerson) {
        itemPivot.position.set(-0.04, 0.08, -0.14);
        itemPivot.rotation.set(0.08, 0.36, 0.04);
      } else {
        itemPivot.position.set(0.0, -0.58, -0.16);
        itemPivot.rotation.set(0.18, 0.38, 0);
      }
    } else if (itemDef.food) {
      itemMesh.position.set(0, 0, 0);
      itemMesh.rotation.set(0, 0, 0);
      if (isFirstPerson) {
        itemPivot.position.set(-0.04, 0.11, -0.14);
        itemPivot.rotation.set(0.10, -0.32, 0.10);
      } else {
        itemPivot.position.set(0.0, -0.60, -0.16);
        itemPivot.rotation.set(0.32, 0.28, 0.06);
      }
    } else {
      // Buckets, Flint & Steel, Armor, Ingots, Gems, Flowers, Saplings, Spawn Eggs, Seeds, etc.
      itemMesh.position.set(0, 0, 0);
      itemMesh.rotation.set(0, 0, 0);
      if (isFirstPerson) {
        itemPivot.position.set(-0.04, 0.11, -0.14);
        itemPivot.rotation.set(0.10, -0.34, 0.08);
      } else {
        itemPivot.position.set(0.0, -0.60, -0.16);
        itemPivot.rotation.set(0.28, 0.35, 0.04);
      }
    }
  }
}

// Reusable 3D Animated Burning Flame Wrap for 3rd-Person Steve & Multiplayer Remote Players!
export function createSteveFireGroup(textures) {
  const group = new THREE.Group();
  const firePlaneGeo = new THREE.PlaneGeometry(0.95, 1.35);
  const fireOuterMat = new THREE.MeshBasicMaterial({
    color: 0xff6a14,
    transparent: true,
    opacity: 0.82,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  const fireInnerMat = new THREE.MeshBasicMaterial({
    color: 0xffd23f,
    transparent: true,
    opacity: 0.78,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  if (textures && textures.atlasTexture && textures.getUV) {
    const fuv = textures.getUV('fire');
    const uvAttr = firePlaneGeo.attributes.uv;
    uvAttr.setXY(0, fuv.u0, fuv.v1);
    uvAttr.setXY(1, fuv.u1, fuv.v1);
    uvAttr.setXY(2, fuv.u0, fuv.v0);
    uvAttr.setXY(3, fuv.u1, fuv.v0);
    uvAttr.needsUpdate = true;
    fireOuterMat.map = textures.atlasTexture;
    fireOuterMat.color.setHex(0xffffff);
    fireOuterMat.alphaTest = 0.25;
    fireInnerMat.map = textures.atlasTexture;
    fireInnerMat.color.setHex(0xffe082);
    fireInnerMat.alphaTest = 0.25;
  }
  const f1 = new THREE.Mesh(firePlaneGeo, fireOuterMat);
  f1.position.set(0, 0.78, 0);
  f1.rotation.y = Math.PI * 0.25;
  const f2 = new THREE.Mesh(firePlaneGeo, fireInnerMat);
  f2.position.set(0, 0.76, 0);
  f2.rotation.y = -Math.PI * 0.25;
  group.add(f1, f2);
  group.visible = false;
  return group;
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
    this.hurtTimer = 0;
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
    this.skinId = getSavedPlayerSkin();
    this.displayName = getSavedPlayerName();
    const initSkinTex = textures && textures.getPlayerSkinTextures
      ? textures.getPlayerSkinTextures(this.skinId)
      : null;

    this.handGroup = new THREE.Group();
    this.handPivot = new THREE.Group();
    this.handGroup.add(this.handPivot);

    this.armMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.17, 0.17, 0.48),
      new THREE.MeshLambertMaterial({ color: initSkinTex?.skinHex ?? 0xdba882 })
    );
    this.armMesh.position.set(0, 0, 0);
    this.sleeveMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.19, 0.19, 0.22),
      new THREE.MeshLambertMaterial({ color: initSkinTex?.sleeveHex ?? 0x14a6ad })
    );
    this.sleeveMesh.position.set(0, 0, 0.2);
    this.handPivot.add(this.armMesh, this.sleeveMesh);

    // Unified Detailed 3D Held-Item Rig (true 3D blocks, stairs, fences, beds, ladders, torches & voxel-extruded tools/items!)
    this.heldRig = createHeldItemRig(textures, true);
    this.handPivot.add(this.heldRig);

    // Reusable scratch vectors to avoid per-frame GC allocations in camera & physics loops
    this._camPosScratch = new THREE.Vector3();
    this._eyeTmp = new THREE.Vector3();
    this._dirTmp = new THREE.Vector3();

    // Dynamic Torch / Glowstone PointLight (+100% brighter & wider reach!)
    this.heldLight = new THREE.PointLight(0xffb64f, 0, 42, 0.85);
    this.heldLight.position.set(0.3, 0.08, -0.45);
    this.handGroup.add(this.heldLight);

    this.handPivot.position.set(0.52, -0.46, -0.62);
    this.handPivot.rotation.set(0.22, -0.26, 0.08);
    this.camera.add(this.handGroup);
    this.wasInWater = false;

    // 3D Articulated Player Model (visible in 3rd-person back & front views) + Authentic Minecraft Nametag on top!
    this.playerModel = this.buildPlayerModel();
    this.playerModel.root.visible = false;
    this.nametag = createPlayerNametag(this.displayName, false);
    this.playerModel.root.add(this.nametag.sprite);

    // 3D Animated Burning Flames wrapping Steve when on fire (visible in 3rd-person views!)
    this.playerFireGroup = createSteveFireGroup(textures);
    this.playerModel.root.add(this.playerFireGroup);

    // Callbacks wired by main.js
    this.onDamage = null;
    this.onDeath = null;
    this.onRespawn = null;
    this.onHudDirty = null;
  }

  buildPlayerModel() {
    return createSteveModel(this.textures, this.skinId);
  }

  setSkin(skinId) {
    const next = skinId || 'steve';
    this.skinId = next;
    if (this.playerModel) updateSteveSkin(this.playerModel, next);
    const sTex = this.textures && this.textures.getPlayerSkinTextures
      ? this.textures.getPlayerSkinTextures(next)
      : null;
    if (sTex) {
      if (this.armMesh?.material) this.armMesh.material.color.setHex(sTex.skinHex);
      if (this.sleeveMesh?.material) this.sleeveMesh.material.color.setHex(sTex.sleeveHex);
    }
  }

  setDisplayName(name, isHost = false) {
    this.displayName = String(name || 'Player').trim().slice(0, 16) || 'Player';
    if (this.nametag) updatePlayerNametag(this.nametag, this.displayName, isHost);
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
    if (this.dead) return;
    if (this.mode === 'creative') {
      // Still flash hurt feedback cleanly if hit in Creative PvP, without draining HP
      this.hurtTimer = 0.36;
      this.sound.playHurt();
      if (this.onDamage) this.onDamage();
      return;
    }
    const def = this.inventory.getArmorDefense();
    const reduced = Math.max(0.5, amount * (1 - Math.min(0.8, def * 0.04)));
    this.hp = Math.max(0, this.hp - reduced);
    this.hurtTimer = 0.38;
    this.inventory.damageArmor();
    this.sound.playHurt();
    if (this.onDamage) this.onDamage();
    if (this.onHudDirty) this.onHudDirty();

    if (this.hp <= 0) {
      this.dead = true;
      // Hide local player model & hand cleanly while on the Death Screen!
      if (this.playerModel?.root) this.playerModel.root.visible = false;
      if (this.handGroup) this.handGroup.visible = false;
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
    this.hurtTimer = 0;
    this.hp = this.maxHp;
    this.hunger = this.maxHunger;
    this.air = this.maxAir;
    this.burnTimer = 0;
    this._burnTick = 0;
    this.inLava = false;
    this.inFire = false;
    this.clearEffects();
    this.vel.set(0, 0, 0);
    this.pos.copy(this.spawnPos);
    const sy = this.world.getSurfaceY(this.pos.x, this.pos.z);
    if (this.pos.y < sy) this.pos.y = sy + 0.5;
    this.fallStartY = null;
    if (this.playerModel) setSteveHurtFlash(this.playerModel, false);
    if (this.onRespawn) this.onRespawn();
    if (this.onHudDirty) this.onHudDirty();
  }

  _getStairStepSupportY(px, py, pz, x, y, z) {
    // Returns highest stair sub-box top Y colliding with player AABB, or -1 if no collision!
    const st = this.world.getStairState ? this.world.getStairState(x, y, z) : { facing: 0, half: 'bottom' };
    const pMinX = px - PLAYER_RADIUS, pMaxX = px + PLAYER_RADIUS;
    const pMinZ = pz - PLAYER_RADIUS, pMaxZ = pz + PLAYER_RADIUS;
    const pMinY = py, pMaxY = py + PLAYER_HEIGHT - 0.05;
    let hitTop = -1;
    const checkBox = (x0, y0, z0, x1, y1, z1) => {
      if (pMaxX > x0 && pMinX < x1 && pMaxZ > z0 && pMinZ < z1 && pMaxY > y0 && pMinY < y1) {
        if (y1 > hitTop) hitTop = y1;
      }
    };
    let sx0 = x, sx1 = x + 1, sz0 = z, sz1 = z + 1;
    if (st.facing === 0) { sz1 = z + 0.5; }
    else if (st.facing === 1) { sx0 = x + 0.5; }
    else if (st.facing === 2) { sz0 = z + 0.5; }
    else { sx1 = x + 0.5; }
    if (st.half === 'top') {
      checkBox(x, y + 0.5, z, x + 1, y + 1.0, z + 1);
      checkBox(sx0, y, sz0, sx1, y + 0.5, sz1);
    } else {
      checkBox(x, y, z, x + 1, y + 0.5, z + 1);
      checkBox(sx0, y + 0.5, sz0, sx1, y + 1.0, sz1);
    }
    return hitTop;
  }

  _doorBoxOverlaps(px, pz, x, y, z) {
    const st = this.world.getDoorState(x, y, z);
    if (st && st.open) return false;
    const edge = st ? (st.facing & 3) : 0;
    const thick = 0.1875;
    let dx0 = x, dx1 = x + 1, dz0 = z, dz1 = z + 1;
    if (edge === 0) { dz1 = z + thick; }
    else if (edge === 1) { dx0 = x + 1 - thick; }
    else if (edge === 2) { dz0 = z + 1 - thick; }
    else { dx1 = x + thick; }
    return (px + PLAYER_RADIUS > dx0 && px - PLAYER_RADIUS < dx1 &&
            pz + PLAYER_RADIUS > dz0 && pz - PLAYER_RADIUS < dz1);
  }

  _getLandingY(px, ny, pz) {
    const minX = Math.floor(px - PLAYER_RADIUS);
    const maxX = Math.floor(px + PLAYER_RADIUS);
    const minY = Math.floor(ny);
    // Only scan foot-level blocks (within step height) so torso/head overlaps (like closing a door) NEVER launch the player upward!
    const maxY = Math.floor(ny + 0.62);
    const minZ = Math.floor(pz - PLAYER_RADIUS);
    const maxZ = Math.floor(pz + PLAYER_RADIUS);
    let bestY = Math.floor(ny) + 1;
    let found = false;
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          const bid = this.world.getBlock(x, y, z);
          if (isBlockSolid(bid)) {
            if (isDoorBlock(bid)) {
              // Doors are thin vertical panels — never use a door block to snap/boost landing height if we're already inside its footprint!
              if (!this._doorBoxOverlaps(px, pz, x, y, z)) continue;
              if (ny > y + 0.15) continue;
            }
            if (isFenceGateBlock(bid) && this.world.isFenceGateOpenAt(x, y, z)) continue;
            if (isStairBlock(bid)) {
              const topY = this._getStairStepSupportY(px, ny, pz, x, y, z);
              if (topY > 0 && topY <= ny + 0.65 && (!found || topY > bestY)) { bestY = topY; found = true; }
            } else {
              const topY = y + 1;
              if (topY <= ny + 0.65 && (!found || topY > bestY)) { bestY = topY; found = true; }
            }
          }
        }
      }
    }
    return found ? bestY : this.pos.y;
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
            if (isDoorBlock(bid)) {
              if (!this._doorBoxOverlaps(px, pz, x, y, z)) continue;
              return true;
            }
            if (isFenceGateBlock(bid) && this.world.isFenceGateOpenAt(x, y, z)) continue;
            if (isStairBlock(bid)) {
              if (this._getStairStepSupportY(px, py, pz, x, y, z) > 0) return true;
              continue;
            }
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
    const isWaterOrLogged = (wx, wy, wz, bid) => (
      bid === BLOCK.WATER ||
      (bid === BLOCK.LADDER && this.world.isLadderWaterlogged && this.world.isLadderWaterlogged(wx, wy, wz))
    );
    const nowInWater = isWaterOrLogged(this.pos.x, this.pos.y + 0.2, this.pos.z, feetBlock);
    const nowInLava = feetBlock === BLOCK.LAVA || waistBlock === BLOCK.LAVA || headBlock === BLOCK.LAVA;
    const nowInFire = feetBlock === BLOCK.FIRE || waistBlock === BLOCK.FIRE;
    if (nowInWater && !this.wasInWater && this.sound.playSplash) {
      this.sound.playSplash();
    }
    this.wasInWater = nowInWater;
    this.inWater = nowInWater;
    this.headInWater = isWaterOrLogged(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z, headBlock);
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
      } else if (this.onGround && !this.flying && !this.sneaking && !this.collidesAt(nx, this.pos.y + 0.56, this.pos.z)) {
        // Smooth Minecraft 0.5-block stair step-up!
        this.pos.x = nx;
        this.pos.y = this._getLandingY(nx, this.pos.y, this.pos.z);
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
      } else if (this.onGround && !this.flying && !this.sneaking && !this.collidesAt(this.pos.x, this.pos.y + 0.56, nz)) {
        // Smooth Minecraft 0.5-block stair step-up!
        this.pos.z = nz;
        this.pos.y = this._getLandingY(this.pos.x, this.pos.y, nz);
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
        // Landed (supports both full blocks and 0.5-block stair steps!)
        const landedY = this._getLandingY(this.pos.x, ny, this.pos.z);
        if (this.fallStartY !== null && !this.inWater && this.mode === 'survival' && !moonGrav) {
          const drop = this.fallStartY - landedY;
          if (drop > 3.5) {
            const rawDmg = Math.floor(drop - 3);
            const mult = (superMob ? 0.5 : 1.0) * (hasJump ? 0.5 : 1.0);
            this.takeDamage(Math.max(1, Math.floor(rawDmg * mult)), 'Fell from a high place');
          }
        }
        this.fallStartY = null;
        if (landedY <= this.pos.y + 0.65) {
          this.pos.y = landedY;
        }
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

    // World Border clamp (keeps player cleanly inside the configured chunk border!)
    if (this.world && this.world.worldBorderChunks > 0) {
      const lim = this.world.worldBorderChunks * 16 - 0.38;
      if (this.pos.x < -lim) { this.pos.x = -lim; this.vel.x = Math.max(0, this.vel.x); }
      else if (this.pos.x > lim) { this.pos.x = lim; this.vel.x = Math.min(0, this.vel.x); }
      if (this.pos.z < -lim) { this.pos.z = -lim; this.vel.z = Math.max(0, this.vel.z); }
      else if (this.pos.z > lim) { this.pos.z = lim; this.vel.z = Math.min(0, this.vel.z); }
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

    // Burning state (catch on fire in Lava/Fire in BOTH Survival & Creative; extinguished immediately by Water!)
    if (this.inWater) {
      this.burnTimer = 0;
      this._burnTick = 0;
    } else if (this.inLava) {
      this.burnTimer = Math.max(this.burnTimer, 8.0);
    } else if (this.inFire) {
      this.burnTimer = Math.max(this.burnTimer, 5.0);
    } else if (this.burnTimer > 0) {
      this.burnTimer = Math.max(0, this.burnTimer - dt);
    }

    // Survival Hunger, Air, Lava/Fire Burn, Regen
    if (this.mode === 'survival') {
      // Lava & Fire Damage (authentic Minecraft burning!)
      if (this.inLava) {
        this._burnTick += dt;
        if (this._burnTick >= 0.5) {
          this._burnTick = 0;
          this.takeDamage(4, 'Tried to swim in lava');
        }
      } else if (this.inFire) {
        this._burnTick += dt;
        if (this._burnTick >= 0.6) {
          this._burnTick = 0;
          this.takeDamage(2, 'Went up in flames');
        }
      } else if (this.burnTimer > 0) {
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
    const eye = this.getEyePosition(this._eyeTmp);
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
      const dir = this.getLookDirection(this._dirTmp);
      const sign = this.cameraMode === 1 ? -1 : 1;
      const maxDist = this.cameraMode === 1 ? 4.2 : 3.8;
      const yLift = this.cameraMode === 1 ? 0.56 : 0.34;
      // Ray-step 3rd-person camera cleanly against solid walls without clipping ground blocks behind feet!
      let safeDist = maxDist;
      for (let dStep = 0.65; dStep <= maxDist; dStep += 0.20) {
        const cx = eye.x + dir.x * sign * dStep;
        const cy = Math.max(this.pos.y + 0.55, eye.y + dir.y * sign * dStep + yLift * (dStep / maxDist));
        const cz = eye.z + dir.z * sign * dStep;
        if (isWallBlock(cx, cy, cz)) {
          safeDist = Math.max(1.05, dStep - 0.30);
          break;
        }
      }
      const camPos = this._camPosScratch.copy(eye).addScaledVector(dir, sign * safeDist);
      camPos.y = Math.max(this.pos.y + 0.55, camPos.y + yLift * (safeDist / maxDist));
      this.camera.position.copy(camPos);
      if (this.cameraMode === 1) {
        this.camera.rotation.order = 'YXZ';
        this.camera.rotation.y = this.yaw;
        this.camera.rotation.x = this.pitch;
        this.camera.rotation.z = 0;
      } else {
        this.camera.lookAt(eye.x, eye.y - 0.12, eye.z);
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

    // Detailed 3D Held Item Model (1st-person hand + 3rd-person Steve) & dynamic torch/glowstone light!
    const held = this.inventory.getHeldDef();
    updateHeldItemRig(this.heldRig, held, this.textures, true);
    this.armMesh.visible = !held;
    this.sleeveMesh.visible = !held;

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

    // Animate 3D Player Model (for 3rd-person views) + sync visible 3D Armor, Hurt Red Flash & 3D Held Item!
    if (this.hurtTimer > 0) this.hurtTimer = Math.max(0, this.hurtTimer - dt);
    const pm = this.playerModel;
    updateSteveArmor(pm, this.inventory.armor);
    setSteveHurtFlash(pm, this.hurtTimer > 0);
    updateHeldItemRig(pm.heldRig, held, this.textures, false);
    if (this.nametag?.sprite) {
      this.nametag.sprite.visible = !this.dead && this.cameraMode !== 0;
    }
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
          : (legSwing * 0.85 + (held ? 0.28 : 0)));
    pm.rightArm.rotation.x = THREE.MathUtils.lerp(pm.rightArm.rotation.x, rightArmTarget, Math.min(1, dt * 20));
    const rightArmZTarget = this.isEating ? -0.32 : 0;
    pm.rightArm.rotation.z = THREE.MathUtils.lerp(pm.rightArm.rotation.z, rightArmZTarget, Math.min(1, dt * 16));

    // Animate 3rd-person flames when Steve is burning!
    if (this.playerFireGroup) {
      const burning = this.burnTimer > 0 || this.inLava || this.inFire;
      this.playerFireGroup.visible = burning;
      if (burning) {
        const ft = performance.now() * 0.015;
        this.playerFireGroup.scale.set(
          0.96 + Math.sin(ft * 1.9) * 0.08,
          0.92 + Math.cos(ft * 2.6) * 0.14,
          0.96 + Math.cos(ft * 2.1) * 0.08
        );
        this.playerFireGroup.position.y = Math.sin(ft * 3.1) * 0.04;
      }
    }
  }

  getMiningSpeed(blockDef) {
    if (this.mode === 'creative') return 999;
    if (!blockDef || blockDef.hardness < 0) return 0;
    if (blockDef.hardness <= 0.06) return 100;

    const held = this.inventory.getHeldDef();
    let mult = 1.0;
    if (held && held.toolType) {
      if (held.toolType === blockDef.tool) {
        mult = held.speed || 2.0;
      } else if (held.toolType === 'shears' && (blockDef.id.startsWith('wool_') || blockDef.id.endsWith('_leaves'))) {
        mult = held.speed || 5.0;
      }
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
