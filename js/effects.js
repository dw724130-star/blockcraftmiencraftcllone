import * as THREE from 'three';

// Biome Ambient Effects (Snow, Desert Dust, Forest Leaves/Fireflies, Plains Pollen, Mountain Wind)
// + 3D Block-Break Voxel Burst Particles

export class EffectsManager {
  constructor(scene) {
    this.scene = scene;
    this.enabled = true;
    this.currentBiome = 'Plains';

    // 1. Biome Ambient Particle Cloud (follows player)
    this.ambientCount = 160;
    const pos = new Float32Array(this.ambientCount * 3);
    this.ambientVel = new Float32Array(this.ambientCount * 3);
    for (let i = 0; i < this.ambientCount; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 30;
      pos[i * 3 + 1] = Math.random() * 16 - 4;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 30;
      this.ambientVel[i * 3] = (Math.random() - 0.5) * 1.2;
      this.ambientVel[i * 3 + 1] = -0.5 - Math.random() * 1.2;
      this.ambientVel[i * 3 + 2] = (Math.random() - 0.5) * 1.2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.ambientMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.22,
      transparent: true,
      opacity: 0.75,
      depthWrite: false
    });
    this.ambientPoints = new THREE.Points(geo, this.ambientMat);
    this.scene.add(this.ambientPoints);

    // 2. Block Break Burst Particles
    this.bursts = [];
    this.cubeGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
    this.burstGroup = new THREE.Group();
    this.scene.add(this.burstGroup);
  }

  setEnabled(val) {
    this.enabled = val;
    this.ambientPoints.visible = val;
  }

  spawnBlockBreak(x, y, z, colorHex = 0x999999) {
    if (!this.enabled) return;
    const mat = new THREE.MeshLambertMaterial({ color: colorHex });
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(this.cubeGeo, mat);
      m.position.set(
        x + 0.2 + Math.random() * 0.6,
        y + 0.2 + Math.random() * 0.6,
        z + 0.2 + Math.random() * 0.6
      );
      this.burstGroup.add(m);
      this.bursts.push({
        mesh: m,
        mat,
        vx: (Math.random() - 0.5) * 4.5,
        vy: 1.8 + Math.random() * 3.5,
        vz: (Math.random() - 0.5) * 4.5,
        life: 0.45 + Math.random() * 0.35
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
