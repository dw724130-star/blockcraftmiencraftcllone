import * as THREE from 'three';

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
    this.atlasMat = textures
      ? new THREE.MeshLambertMaterial({ map: textures.atlasTexture, alphaTest: 0.35 })
      : null;
    this.burstGroup = new THREE.Group();
    this.scene.add(this.burstGroup);
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

  update(dt, playerPos, biome, isNight) {
    // Update block break bursts
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const p = this.bursts[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.burstGroup.remove(p.mesh);
        this.bursts.splice(i, 1);
        continue;
      }
      p.vy -= 14 * dt;
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

    if (biome === 'Snowy Taiga' || (biome === 'Mountains' && playerPos.y > 52)) {
      // Gentle falling snowflakes
      color = 0xf2f8ff;
      size = 0.28;
      opacity = 0.85;
      vyBase = -2.2;
      vxMult = 1.4;
    } else if (biome === 'Desert') {
      // Blowing warm sand dust
      color = 0xe8d28e;
      size = 0.24;
      opacity = 0.55;
      vyBase = -0.25;
      vxMult = 5.5;
    } else if (biome === 'Forest' || biome === 'Birch Forest') {
      if (isNight) {
        // Glowing golden fireflies at night!
        color = 0xd4ff59;
        size = 0.26;
        opacity = 0.92;
        vyBase = 0.25;
        vxMult = 0.8;
      } else {
        // Drifting forest leaves
        color = biome === 'Birch Forest' ? 0x8cc947 : 0x529932;
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
    this.bursts = [];
  }
}
