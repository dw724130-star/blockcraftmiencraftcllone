import * as THREE from 'three';
import { ITEMS, isBlockSolid } from './blocks.js';

// Biome Ambient Effects (Snow, Desert Dust, Forest Leaves/Fireflies, Plains Pollen, Mountain Wind)
// + 3D Block-Break Voxel Burst Particles

function createParticleSprite() {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

export class EffectsManager {
  constructor(scene, textures = null) {
    this.scene = scene;
    this.textures = textures;
    this.enabled = true;
    this.currentBiome = 'Plains';

    // 1. Biome Ambient Particle Cloud (soft glowing sprites — no harsh squares!)
    this.ambientCount = 160;
    const pos = new Float32Array(this.ambientCount * 3);
    this.ambientVel = new Float32Array(this.ambientCount * 3);
    for (let i = 0; i < this.ambientCount; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 32;
      pos[i * 3 + 1] = Math.random() * 16 - 4;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 32;
      this.ambientVel[i * 3] = (Math.random() - 0.5) * 1.2;
      this.ambientVel[i * 3 + 1] = -0.5 - Math.random() * 1.2;
      this.ambientVel[i * 3 + 2] = (Math.random() - 0.5) * 1.2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.ambientMat = new THREE.PointsMaterial({
      color: 0xffffff,
      map: createParticleSprite(),
      size: 0.34,
      transparent: true,
      opacity: 0.78,
      depthWrite: false
    });
    this.ambientPoints = new THREE.Points(geo, this.ambientMat);
    this.scene.add(this.ambientPoints);

    // 2. Pixel-Art Block Break & Mining Chip Particles (cached UV crumb geometries!)
    this.bursts = [];
    this.cubeGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
    this.crumbGeoCache = {};
    this.foodCrumbMats = {};
    this.atlasMat = textures
      ? new THREE.MeshLambertMaterial({ map: textures.atlasTexture, alphaTest: 0.35 })
      : null;
    this.burstGroup = new THREE.Group();
    this.scene.add(this.burstGroup);

    // 3. Real-Time 3D Explosion VFX (Fireballs, Shockwaves, Billowing Smoke & Primed TNT!)
    this.explosions = [];
    this.smokePuffs = [];
    this.primedTnts = [];
    this.sphereGeo = new THREE.SphereGeometry(1, 14, 10);
    this.ringGeo = new THREE.RingGeometry(0.75, 1.0, 24);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.smokeGeo = new THREE.BoxGeometry(0.45, 0.45, 0.45);
    this.sparkGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16);
    this.tntWhiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.tntGeo = textures && textures.createBlockDropGeometry && ITEMS.tnt
      ? textures.createBlockDropGeometry(ITEMS.tnt, 0.98)
      : new THREE.BoxGeometry(0.98, 0.98, 0.98);
    this.tntMat = textures
      ? new THREE.MeshLambertMaterial({ map: textures.atlasTexture })
      : new THREE.MeshLambertMaterial({ color: 0xd93829 });
    this.sparkMat = new THREE.MeshBasicMaterial({ color: 0xffd54f });
    this.fireMat = new THREE.MeshBasicMaterial({ color: 0xff6b1a });
  }

  setEnabled(val) {
    this.enabled = val;
    this.ambientPoints.visible = val;
  }

  makeCrumbGeometry(blockDef) {
    const faceName = blockDef?.faces?.side || blockDef?.faces?.all || blockDef?.faces?.top;
    if (!this.textures || !faceName) return this.cubeGeo;
    let pool = this.crumbGeoCache[faceName];
    if (!pool) {
      pool = [];
      const tile = this.textures.getUV(faceName);
      const uSpan = (tile.u1 - tile.u0) * 0.28;
      const vSpan = (tile.v1 - tile.v0) * 0.28;
      for (let k = 0; k < 6; k++) {
        const geo = new THREE.BoxGeometry(0.13, 0.13, 0.13);
        const uvAttr = geo.attributes.uv;
        const uOff = tile.u0 + ((k * 0.29) % 0.72) * (tile.u1 - tile.u0);
        const vOff = tile.v0 + ((k * 0.43) % 0.72) * (tile.v1 - tile.v0);
        for (let i = 0; i < uvAttr.count; i++) {
          uvAttr.setXY(i, uOff + uvAttr.getX(i) * uSpan, vOff + uvAttr.getY(i) * vSpan);
        }
        uvAttr.needsUpdate = true;
        pool.push(geo);
      }
      this.crumbGeoCache[faceName] = pool;
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }

  spawnBlockBreak(x, y, z, blockDefOrColor = 0x999999) {
    if (!this.enabled) return;
    const isDef = blockDefOrColor && typeof blockDefOrColor === 'object';
    const useAtlas = isDef && this.atlasMat;
    const fallbackMat = useAtlas ? null : new THREE.MeshLambertMaterial({
      color: typeof blockDefOrColor === 'number' ? blockDefOrColor : 0x999999
    });

    for (let i = 0; i < 10; i++) {
      const geo = useAtlas ? this.makeCrumbGeometry(blockDefOrColor) : this.cubeGeo;
      const m = new THREE.Mesh(geo, useAtlas ? this.atlasMat : fallbackMat);
      m.position.set(
        x + 0.15 + Math.random() * 0.7,
        y + 0.15 + Math.random() * 0.7,
        z + 0.15 + Math.random() * 0.7
      );
      this.burstGroup.add(m);
      this.bursts.push({
        mesh: m,
        vx: (Math.random() - 0.5) * 4.8,
        vy: 1.9 + Math.random() * 3.6,
        vz: (Math.random() - 0.5) * 4.8,
        life: 0.45 + Math.random() * 0.35
      });
    }
  }

  // Live pixel-art chips spraying from the block face while actively mining!
  spawnMiningChip(x, y, z, nx, ny, nz, blockDef) {
    if (!this.enabled || !this.atlasMat || !blockDef || this.bursts.length > 48) return;
    for (let i = 0; i < 2; i++) {
      const geo = this.makeCrumbGeometry(blockDef);
      const m = new THREE.Mesh(geo, this.atlasMat);
      m.position.set(
        x + 0.5 + nx * 0.54 + (nx === 0 ? (Math.random() - 0.5) * 0.6 : 0),
        y + 0.5 + ny * 0.54 + (ny === 0 ? (Math.random() - 0.5) * 0.6 : 0),
        z + 0.5 + nz * 0.54 + (nz === 0 ? (Math.random() - 0.5) * 0.6 : 0)
      );
      m.scale.setScalar(0.75);
      this.burstGroup.add(m);
      this.bursts.push({
        mesh: m,
        vx: nx * (1.2 + Math.random() * 1.4) + (Math.random() - 0.5) * 2.2,
        vy: 1.4 + Math.random() * 2.0 + ny * 0.8,
        vz: nz * (1.2 + Math.random() * 1.4) + (Math.random() - 0.5) * 2.2,
        life: 0.28 + Math.random() * 0.22
      });
    }
  }

  // Spray tiny food crumbs right in front of the player while chewing!
  spawnEatCrumbs(eyePos, lookDir, foodDef) {
    if (!this.enabled || !eyePos || !lookDir || this.bursts.length > 64) return;
    const id = foodDef?.id || 'apple';
    let color = 0xd99957;
    if (id === 'apple') color = 0xe32626;
    else if (id === 'bread') color = 0xe8b95b;
    else if (id.includes('pork') && id.includes('raw')) color = 0xf2949d;
    else if (id.includes('beef') || id.includes('venison') || id.includes('mutton')) {
      color = id.includes('raw') ? 0xd42c38 : 0x8a4522;
    } else if (id.includes('steak')) color = 0x824020;
    else if (id.includes('salmon')) color = id.includes('raw') ? 0xe36b5f : 0xf2a45a;
    else if (id.includes('chicken') || id.includes('rabbit')) {
      color = id.includes('raw') ? 0xfac4b6 : 0xde983c;
    }

    let mat = this.foodCrumbMats[color];
    if (!mat) {
      mat = new THREE.MeshLambertMaterial({ color });
      this.foodCrumbMats[color] = mat;
    }

    const baseX = eyePos.x + lookDir.x * 0.42;
    const baseY = eyePos.y - 0.16 + lookDir.y * 0.32;
    const baseZ = eyePos.z + lookDir.z * 0.42;

    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(this.cubeGeo, mat);
      m.position.set(
        baseX + (Math.random() - 0.5) * 0.12,
        baseY + (Math.random() - 0.5) * 0.08,
        baseZ + (Math.random() - 0.5) * 0.12
      );
      m.scale.setScalar(0.32 + Math.random() * 0.18);
      this.burstGroup.add(m);
      this.bursts.push({
        mesh: m,
        vx: lookDir.x * (0.9 + Math.random() * 0.8) + (Math.random() - 0.5) * 1.4,
        vy: 0.9 + Math.random() * 1.2,
        vz: lookDir.z * (0.9 + Math.random() * 0.8) + (Math.random() - 0.5) * 1.4,
        life: 0.24 + Math.random() * 0.16
      });
    }
  }

  // Rising glowing fire embers & soft dark smoke puffs floating off burning trees and flames!
  spawnFireEmber(x, y, z) {
    if (!this.enabled || this.bursts.length > 90) return;
    // Glowing hot orange-gold ember spark
    const ember = new THREE.Mesh(this.sparkGeo, Math.random() < 0.55 ? this.sparkMat : this.fireMat);
    ember.position.set(
      x + 0.15 + Math.random() * 0.7,
      y + 0.5 + Math.random() * 0.6,
      z + 0.15 + Math.random() * 0.7
    );
    ember.scale.setScalar(0.32 + Math.random() * 0.25);
    this.burstGroup.add(ember);
    this.bursts.push({
      mesh: ember,
      vx: (Math.random() - 0.5) * 0.85,
      vy: 1.6 + Math.random() * 1.4,
      vz: (Math.random() - 0.5) * 0.85,
      life: 0.55 + Math.random() * 0.55,
      noGravity: true
    });
    // Occasional soft dark smoke wisp
    if (Math.random() < 0.45 && this.smokePuffs.length < 48) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x3b3838, transparent: true, opacity: 0.45, depthWrite: false });
      const sm = new THREE.Mesh(this.smokeGeo, mat);
      sm.position.set(x + 0.2 + Math.random() * 0.6, y + 0.95, z + 0.2 + Math.random() * 0.6);
      sm.scale.setScalar(0.42 + Math.random() * 0.35);
      this.burstGroup.add(sm);
      this.smokePuffs.push({
        mesh: sm,
        mat,
        vx: (Math.random() - 0.5) * 0.45,
        vy: 1.15 + Math.random() * 0.65,
        vz: (Math.random() - 0.5) * 0.45,
        age: 0,
        maxAge: 0.95 + Math.random() * 0.7
      });
    }
  }

  // Crackling white-gold sparks & charge smoke rising from a priming Creeper!
  spawnCreeperSpark(x, y, z, intensity = 0.5) {
    if (!this.enabled || this.bursts.length > 84) return;
    const count = intensity > 0.65 ? 3 : 2;
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(this.sparkGeo, Math.random() < 0.55 ? this.tntWhiteMat : this.sparkMat);
      m.position.set(
        x + (Math.random() - 0.5) * 0.72,
        y + 0.5 + Math.random() * 1.15,
        z + (Math.random() - 0.5) * 0.72
      );
      m.scale.setScalar(0.45 + intensity * 0.45);
      this.burstGroup.add(m);
      this.bursts.push({
        mesh: m,
        vx: (Math.random() - 0.5) * (1.8 + intensity * 2.5),
        vy: 2.0 + Math.random() * (2.4 + intensity * 2.2),
        vz: (Math.random() - 0.5) * (1.8 + intensity * 2.5),
        life: 0.25 + Math.random() * 0.22
      });
    }
  }

  // Spawn a live bouncing, flashing, hissing Primed TNT 3D Entity!
  spawnPrimedTnt(x, y, z, fuse = 2.6, vx = null, vy = null, vz = null, remote = false) {
    const mesh = new THREE.Mesh(this.tntGeo, this.tntMat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    this.burstGroup.add(mesh);
    const ang = Math.random() * Math.PI * 2;
    this.primedTnts.push({
      mesh,
      pos: new THREE.Vector3(x, y, z),
      vel: new THREE.Vector3(
        vx !== null ? vx : Math.cos(ang) * 1.4,
        vy !== null ? vy : 4.2,
        vz !== null ? vz : Math.sin(ang) * 1.4
      ),
      fuse,
      maxFuse: fuse,
      sparkCd: 0,
      // Remote TNT (ignited by another multiplayer client) is only a visual: its owner decides where it
      // actually explodes and broadcasts that, so every client carves the identical crater.
      remote
    });
  }

  // Remove the remote primed TNT closest to (x, y, z) once its owner's explosion arrives.
  claimRemoteTnt(x, y, z, maxDist = 10) {
    let best = -1;
    let bestD = maxDist * maxDist;
    for (let i = 0; i < this.primedTnts.length; i++) {
      const t = this.primedTnts[i];
      if (!t.remote) continue;
      const d = t.pos.distanceToSquared({ x, y, z });
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      this.burstGroup.remove(this.primedTnts[best].mesh);
      this.primedTnts.splice(best, 1);
    }
  }

  // Dramatic 3D Explosion: White-hot Fireball + Expanding Shockwave Ring + Billowing Smoke + Flying Sparks!
  spawnExplosion(x, y, z, radius = 4.4) {
    // 1. Expanding white-gold -> fiery orange fireball core
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xfff5c2,
      transparent: true,
      opacity: 0.95,
      depthWrite: false
    });
    const core = new THREE.Mesh(this.sphereGeo, coreMat);
    core.position.set(x, y, z);
    core.scale.setScalar(0.5);
    this.burstGroup.add(core);

    const outerMat = new THREE.MeshBasicMaterial({
      color: 0xff6b1a,
      transparent: true,
      opacity: 0.78,
      depthWrite: false
    });
    const outer = new THREE.Mesh(this.sphereGeo, outerMat);
    outer.position.set(x, y, z);
    outer.scale.setScalar(0.8);
    this.burstGroup.add(outer);

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffd57a,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const ring = new THREE.Mesh(this.ringGeo, ringMat);
    ring.position.set(x, y + 0.15, z);
    ring.scale.setScalar(0.5);
    this.burstGroup.add(ring);

    this.explosions.push({
      core, coreMat, outer, outerMat, ring, ringMat,
      age: 0, maxAge: 0.52, radius
    });

    // 2. Billowing 3D volumetric smoke clouds rising from the crater!
    const smokeCount = 24;
    for (let i = 0; i < smokeCount; i++) {
      const shade = 0.22 + Math.random() * 0.45;
      const sMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(shade, shade * 0.98, shade * 0.95),
        transparent: true,
        opacity: 0.86,
        depthWrite: false
      });
      const sm = new THREE.Mesh(this.smokeGeo, sMat);
      const ang = Math.random() * Math.PI * 2;
      const spd = 1.4 + Math.random() * (radius * 1.45);
      sm.position.set(
        x + (Math.random() - 0.5) * 1.1,
        y + (Math.random() - 0.5) * 0.9,
        z + (Math.random() - 0.5) * 1.1
      );
      const startScale = 0.8 + Math.random() * 1.1;
      sm.scale.setScalar(startScale);
      this.burstGroup.add(sm);
      this.smokePuffs.push({
        mesh: sm, mat: sMat,
        vx: Math.cos(ang) * spd,
        vy: 1.8 + Math.random() * 4.2,
        vz: Math.sin(ang) * spd,
        age: 0,
        maxAge: 0.85 + Math.random() * 0.75,
        startScale
      });
    }

    // 3. Fiery flying sparks & glowing embers!
    for (let i = 0; i < 18; i++) {
      const m = new THREE.Mesh(this.sparkGeo, i % 2 === 0 ? this.sparkMat : this.fireMat);
      m.position.set(x, y + 0.2, z);
      this.burstGroup.add(m);
      const ang = Math.random() * Math.PI * 2;
      const spd = 4.5 + Math.random() * 8.5;
      this.bursts.push({
        mesh: m,
        vx: Math.cos(ang) * spd,
        vy: 3.5 + Math.random() * 6.5,
        vz: Math.sin(ang) * spd,
        life: 0.45 + Math.random() * 0.55
      });
    }
  }

  updatePrimedTnts(dt, world, onDetonate) {
    for (let i = this.primedTnts.length - 1; i >= 0; i--) {
      const t = this.primedTnts[i];
      t.fuse -= dt;

      // Gravity + solid block bounce physics
      t.vel.y -= 20 * dt;
      const nx = t.pos.x + t.vel.x * dt;
      const nz = t.pos.z + t.vel.z * dt;
      if (!isBlockSolid(world.getBlock(nx, t.pos.y, t.pos.z))) t.pos.x = nx;
      else t.vel.x *= -0.3;
      if (!isBlockSolid(world.getBlock(t.pos.x, t.pos.y, nz))) t.pos.z = nz;
      else t.vel.z *= -0.3;

      const ny = t.pos.y + t.vel.y * dt;
      if (t.vel.y < 0 && isBlockSolid(world.getBlock(t.pos.x, ny - 0.5, t.pos.z))) {
        t.pos.y = Math.floor(ny - 0.5) + 1.5;
        t.vel.y = 0;
        t.vel.x *= 0.72;
        t.vel.z *= 0.72;
      } else {
        t.pos.y = ny;
      }
      t.mesh.position.copy(t.pos);

      // Authentic Minecraft accelerating white/red flash + final swell right before boom!
      const prog = 1 - Math.max(0, t.fuse) / t.maxFuse;
      const flashFreq = 10 + prog * 34;
      const flashWhite = Math.sin(t.fuse * flashFreq) > 0;
      t.mesh.material = flashWhite ? this.tntWhiteMat : this.tntMat;
      const swell = t.fuse < 0.45 ? 1.0 + (0.45 - t.fuse) * 0.65 : 1.0 + Math.sin(prog * Math.PI * 8) * 0.04;
      t.mesh.scale.setScalar(swell);

      // Emit small rising fuse sparks
      t.sparkCd -= dt;
      if (t.sparkCd <= 0 && this.bursts.length < 70) {
        t.sparkCd = 0.09;
        const sp = new THREE.Mesh(this.sparkGeo, this.sparkMat);
        sp.position.set(t.pos.x, t.pos.y + 0.55, t.pos.z);
        sp.scale.setScalar(0.55);
        this.burstGroup.add(sp);
        this.bursts.push({
          mesh: sp,
          vx: (Math.random() - 0.5) * 1.4,
          vy: 2.2 + Math.random() * 1.6,
          vz: (Math.random() - 0.5) * 1.4,
          life: 0.28
        });
      }

      if (t.remote) {
        // Wait (briefly) for the owner's authoritative explosion; drop silently if it never comes.
        if (t.fuse <= -2.5) {
          this.burstGroup.remove(t.mesh);
          this.primedTnts.splice(i, 1);
        }
        continue;
      }
      if (t.fuse <= 0) {
        this.burstGroup.remove(t.mesh);
        this.primedTnts.splice(i, 1);
        if (onDetonate) onDetonate(t.pos.x, t.pos.y, t.pos.z);
      }
    }
  }

  update(dt, playerPos, biome, isNight) {
    // Update active 3D fireballs & shockwaves
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const ex = this.explosions[i];
      ex.age += dt;
      const p = ex.age / ex.maxAge;
      if (p >= 1) {
        this.burstGroup.remove(ex.core, ex.outer, ex.ring);
        ex.coreMat.dispose();
        ex.outerMat.dispose();
        ex.ringMat.dispose();
        this.explosions.splice(i, 1);
        continue;
      }
      const ease = 1 - Math.pow(1 - p, 3);
      ex.core.scale.setScalar(0.4 + ease * ex.radius * 0.72);
      ex.coreMat.opacity = Math.max(0, (1 - p * 1.35) * 0.95);
      ex.outer.scale.setScalar(0.6 + ease * ex.radius * 1.05);
      ex.outerMat.opacity = Math.max(0, (1 - p) * 0.75);
      ex.outerMat.color.setHex(p < 0.45 ? 0xff7b1a : 0xcc2b14);
      ex.ring.scale.setScalar(0.5 + ease * ex.radius * 1.9);
      ex.ringMat.opacity = Math.max(0, (1 - p) * 0.8);
    }

    // Update billowing explosion smoke clouds
    for (let i = this.smokePuffs.length - 1; i >= 0; i--) {
      const s = this.smokePuffs[i];
      s.age += dt;
      const p = s.age / s.maxAge;
      if (p >= 1) {
        this.burstGroup.remove(s.mesh);
        s.mat.dispose();
        this.smokePuffs.splice(i, 1);
        continue;
      }
      s.vx *= 0.94;
      s.vz *= 0.94;
      s.vy *= 0.96;
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y += (s.vy + 0.8) * dt;
      s.mesh.position.z += s.vz * dt;
      s.mesh.rotation.x += dt * 1.2;
      s.mesh.rotation.y += dt * 1.5;
      s.mesh.scale.setScalar(s.startScale * (1 + p * 1.8));
      s.mat.opacity = Math.max(0, (1 - p) * 0.82);
    }

    // Update block break bursts & sparks
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const p = this.bursts[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.burstGroup.remove(p.mesh);
        this.bursts.splice(i, 1);
        continue;
      }
      if (!p.noGravity) p.vy -= 14 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      p.mesh.rotation.x += dt * 7;
      p.mesh.rotation.y += dt * 5;
      const sc = Math.max(0.01, p.life * 1.6);
      p.mesh.scale.setScalar(sc);
    }

    if (!this.enabled) {
      this.ambientPoints.visible = false;
      return;
    }

    this.ambientPoints.visible = true;
    this.ambientPoints.position.set(playerPos.x, playerPos.y, playerPos.z);

    // Style ambient particles per biome
    let vxMult = 1, vyBase = -0.8, size = 0.22, color = 0xffffff, opacity = 0.65;

    if (biome === 'Snowy Taiga' || (biome === 'Mountains' && playerPos.y > 118)) {
      // Gentle falling snowflakes
      color = 0xf2f8ff;
      size = 0.28;
      opacity = 0.85;
      vyBase = -2.2;
      vxMult = 1.4;
    } else if (biome === 'Cherry Grove') {
      // Drifting soft pink cherry blossom petals!
      color = 0xffb3d1;
      size = 0.26;
      opacity = 0.85;
      vyBase = -1.0;
      vxMult = 2.0;
    } else if (biome === 'Desert' || biome === 'Badlands' || biome === 'Savanna') {
      // Blowing warm desert/red-canyon sand dust
      color = biome === 'Badlands' ? 0xd97d4a : 0xe8d28e;
      size = 0.24;
      opacity = 0.55;
      vyBase = -0.25;
      vxMult = 5.5;
    } else if (biome === 'Forest' || biome === 'Birch Forest' || biome === 'Jungle' || biome === 'Swamp') {
      if (isNight || biome === 'Swamp') {
        // Glowing golden-lime fireflies!
        color = 0xd4ff59;
        size = 0.26;
        opacity = 0.92;
        vyBase = 0.25;
        vxMult = 0.8;
      } else {
        // Drifting forest / jungle leaves
        color = biome === 'Birch Forest' ? 0x8cc947 : (biome === 'Jungle' ? 0x32b838 : 0x529932);
        size = 0.22;
        opacity = 0.72;
        vyBase = -1.1;
        vxMult = 1.5;
      }
    } else if (biome === 'Mountains') {
      // Crisp wind mist
      color = 0xdbeeff;
      size = 0.24;
      opacity = 0.45;
      vyBase = -0.4;
      vxMult = 3.8;
    } else {
      // Plains: soft sunlit pollen / fireflies at night
      color = isNight ? 0xb8f2ff : 0xfff7c2;
      size = 0.18;
      opacity = isNight ? 0.6 : 0.45;
      vyBase = 0.15;
      vxMult = 1.0;
    }

    this.ambientMat.color.setHex(color);
    this.ambientMat.size = size;
    this.ambientMat.opacity = opacity;

    const attr = this.ambientPoints.geometry.attributes.position;
    const t = performance.now() * 0.001;
    for (let i = 0; i < this.ambientCount; i++) {
      let x = attr.getX(i);
      let y = attr.getY(i);
      let z = attr.getZ(i);

      const swirl = Math.sin(t + i * 0.7) * 0.5;
      x += (this.ambientVel[i * 3] * vxMult + swirl * 0.4) * dt;
      y += (vyBase + Math.cos(t * 1.3 + i) * 0.35) * dt;
      z += (this.ambientVel[i * 3 + 2] * vxMult + swirl * 0.3) * dt;

      if (x > 15) x -= 30;
      if (x < -15) x += 30;
      if (z > 15) z -= 30;
      if (z < -15) z += 30;
      if (y < -5) y += 16;
      if (y > 11) y -= 16;

      attr.setXYZ(i, x, y, z);
    }
    attr.needsUpdate = true;
  }

  clear() {
    for (const p of this.bursts) this.burstGroup.remove(p.mesh);
    for (const ex of this.explosions) {
      this.burstGroup.remove(ex.core, ex.outer, ex.ring);
      ex.coreMat.dispose();
      ex.outerMat.dispose();
      ex.ringMat.dispose();
    }
    for (const s of this.smokePuffs) {
      this.burstGroup.remove(s.mesh);
      s.mat.dispose();
    }
    for (const t of this.primedTnts) this.burstGroup.remove(t.mesh);
    this.bursts = [];
    this.explosions = [];
    this.smokePuffs = [];
    this.primedTnts = [];
  }
}
