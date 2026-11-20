import * as THREE from 'three';

export class SkySystem {
  constructor(scene) {
    this.scene = scene;
    // 0.0 = midnight, 0.25 = sunrise (06:00), 0.5 = noon (12:00), 0.75 = sunset (18:00)
    this.time = 0.34; // Start around 08:10 morning
    this.dayCount = 1;
    this.dayLengthSeconds = 480; // 8 real minutes per Minecraft day
    this.weather = 'clear'; // 'clear' | 'rain'

    // Lights
    this.hemiLight = new THREE.HemisphereLight(0xdff2ff, 0x4b5c42, 0.85);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xfff8e6, 0.9);
    this.sunLight.position.set(40, 80, 30);
    this.sunLight.castShadow = false;
    this.sunLight.shadow.mapSize.set(1024, 1024);
    this.sunLight.shadow.camera.near = 10;
    this.sunLight.shadow.camera.far = 180;
    const d = 48;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0012;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
    this.shaderMode = 'enhanced';
    this.biomeEffects = true;

    // Sky Group follows player
    this.skyGroup = new THREE.Group();
    this.scene.add(this.skyGroup);

    // Custom GLSL Atmospheric Gradient Sky Dome
    this.skyUniforms = {
      uTopColor: { value: new THREE.Color(0x2e78e6) },
      uHorizonColor: { value: new THREE.Color(0xa6dcff) },
      uSunDir: { value: new THREE.Vector3(0.5, 0.7, -0.2).normalize() },
      uSunGlow: { value: 0.55 }
    };
    const domeGeo = new THREE.SphereGeometry(260, 20, 14);
    const domeMat = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uTopColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uSunDir;
        uniform float uSunGlow;
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 col = mix(uHorizonColor, uTopColor, pow(h, 0.58));
          float sunDot = max(0.0, dot(normalize(vDir), normalize(uSunDir)));
          col += vec3(1.0, 0.88, 0.62) * pow(sunDot, 14.0) * uSunGlow;
          gl_FragColor = vec4(col, 1.0);
        }
      `
    });
    this.skyDome = new THREE.Mesh(domeGeo, domeMat);
    this.skyGroup.add(this.skyDome);

    // Sun & Moon
    const sunGeo = new THREE.BoxGeometry(14, 14, 1);
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xfff5b8, fog: false });
    this.sunMesh = new THREE.Mesh(sunGeo, sunMat);
    this.skyGroup.add(this.sunMesh);

    const moonGeo = new THREE.BoxGeometry(10, 10, 1);
    const moonMat = new THREE.MeshBasicMaterial({ color: 0xdce8ff, fog: false });
    this.moonMesh = new THREE.Mesh(moonGeo, moonMat);
    this.skyGroup.add(this.moonMesh);

    // Stars
    const starPts = [];
    for (let i = 0; i < 240; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.9 + 0.05);
      const r = 135;
      starPts.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta)
      );
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPts, 3));
    this.starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.5, transparent: true, opacity: 0, fog: false });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.skyGroup.add(this.stars);

    // Blocky Clouds
    this.clouds = [];
    const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.82, fog: true });
    for (let i = 0; i < 18; i++) {
      const w = 10 + Math.random() * 14;
      const d = 6 + Math.random() * 10;
      const cMesh = new THREE.Mesh(new THREE.BoxGeometry(w, 2.2, d), cloudMat);
      cMesh.position.set((Math.random() - 0.5) * 180, 74 + Math.random() * 6, (Math.random() - 0.5) * 180);
      this.skyGroup.add(cMesh);
      this.clouds.push(cMesh);
    }
    this.cloudMat = cloudMat;

    // Rain Particles
    const rainCount = 450;
    const rainPos = new Float32Array(rainCount * 3);
    for (let i = 0; i < rainCount; i++) {
      rainPos[i * 3] = (Math.random() - 0.5) * 36;
      rainPos[i * 3 + 1] = Math.random() * 24;
      rainPos[i * 3 + 2] = (Math.random() - 0.5) * 36;
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
    this.rainMat = new THREE.PointsMaterial({ color: 0x9ecaff, size: 0.22, transparent: true, opacity: 0.7 });
    this.rainPoints = new THREE.Points(rainGeo, this.rainMat);
    this.rainPoints.visible = false;
    this.scene.add(this.rainPoints);

    this.fog = new THREE.Fog(0x88c5ff, 35, 95);
    this.scene.fog = this.fog;
    this.skyColor = new THREE.Color(0x88c5ff);
  }

  isNight() {
    return this.time < 0.23 || this.time > 0.78;
  }

  getFormattedTime() {
    const totalMinutes = Math.floor(this.time * 24 * 60);
    const hh = String(Math.floor(totalMinutes / 60) % 24).padStart(2, '0');
    const mm = String(totalMinutes % 60).padStart(2, '0');
    return `Day ${this.dayCount} ${hh}:${mm}`;
  }

  setRenderDistance(chunks) {
    const far = Math.max(46, chunks * 16 - 4);
    this.fog.near = far * 0.52;
    this.fog.far = far;
  }

  setShaderMode(mode) {
    this.shaderMode = mode;
    this.sunLight.castShadow = mode === 'ultra';
  }

  update(dt, playerPos, biome = 'Plains') {
    this.time += dt / this.dayLengthSeconds;
    if (this.time >= 1.0) {
      this.time -= 1.0;
      this.dayCount++;
    }

    this.skyGroup.position.set(playerPos.x, 0, playerPos.z);

    // Sun angle: 0.25 = horizon east, 0.5 = zenith, 0.75 = horizon west
    const angle = (this.time - 0.25) * Math.PI * 2;
    const dist = 140;
    const sx = Math.cos(angle) * dist;
    const sy = Math.sin(angle) * dist;

    this.sunMesh.position.set(sx, sy + 20, -25);
    this.sunMesh.lookAt(playerPos.x, 20, playerPos.z);

    this.moonMesh.position.set(-sx, -sy + 20, -25);
    this.moonMesh.lookAt(playerPos.x, 20, playerPos.z);

    // Sun height factor: -1 (midnight) to +1 (noon)
    const sunH = Math.sin(angle);
    const dayFactor = Math.max(0, Math.min(1, (sunH + 0.15) / 0.45));
    const sunsetFactor = Math.max(0, 1 - Math.abs(sunH) * 4.5);

    const nightTop = new THREE.Color(0x050918);
    const nightHor = new THREE.Color(0x111a36);
    const dayTop = new THREE.Color(this.weather === 'rain' ? 0x455466 : 0x2a74e0);
    const dayHor = new THREE.Color(this.weather === 'rain' ? 0x6f7f91 : 0xaadfff);
    const sunsetCol = new THREE.Color(this.shaderMode !== 'off' ? 0xff8d47 : 0xf08c54);

    // Subtle Biome Atmosphere Tint
    if (this.biomeEffects && this.weather === 'clear') {
      if (biome === 'Desert') {
        dayTop.lerp(new THREE.Color(0x5ea2e8), 0.35);
        dayHor.lerp(new THREE.Color(0xf0dfb0), 0.48);
      } else if (biome === 'Snowy Taiga') {
        dayTop.lerp(new THREE.Color(0x6fa6db), 0.35);
        dayHor.lerp(new THREE.Color(0xdcf0ff), 0.45);
      } else if (biome === 'Forest' || biome === 'Birch Forest') {
        dayHor.lerp(new THREE.Color(0x8edbd0), 0.22);
      } else if (biome === 'Mountains') {
        dayTop.lerp(new THREE.Color(0x1f5bc4), 0.35);
        dayHor.lerp(new THREE.Color(0xc2dcfa), 0.32);
      }
    }

    const topCol = nightTop.clone().lerp(dayTop, dayFactor);
    this.skyColor.copy(nightHor).lerp(dayHor, dayFactor);
    if (this.weather === 'clear') {
      this.skyColor.lerp(sunsetCol, sunsetFactor * (this.shaderMode !== 'off' ? 0.72 : 0.48));
      topCol.lerp(new THREE.Color(0x52366e), sunsetFactor * 0.42);
    }

    // Update GLSL Sky Dome uniforms
    this.skyUniforms.uTopColor.value.copy(topCol);
    this.skyUniforms.uHorizonColor.value.copy(this.skyColor);
    this.skyUniforms.uSunDir.value.set(Math.cos(angle), Math.sin(angle), -0.2).normalize();
    this.skyUniforms.uSunGlow.value = (this.weather === 'rain' ? 0.08 : 0.45 + sunsetFactor * 0.55) * dayFactor;

    this.scene.background = this.skyColor;
    this.fog.color.copy(this.skyColor);

    const rainDim = this.weather === 'rain' ? 0.65 : 1.0;
    const shaderBoost = this.shaderMode === 'ultra' ? 1.2 : (this.shaderMode === 'enhanced' ? 1.08 : 1.0);
    this.sunLight.intensity = (0.14 + dayFactor * 0.98) * rainDim * shaderBoost;
    this.sunLight.color.setHex(0xfff8e6).lerp(new THREE.Color(0xffa45b), sunsetFactor * (this.shaderMode !== 'off' ? 0.65 : 0.25));

    // Texel-snapped shadow center eliminates shadow shimmer while walking!
    const snapX = Math.round(playerPos.x * 2) / 2;
    const snapY = Math.round(playerPos.y * 2) / 2;
    const snapZ = Math.round(playerPos.z * 2) / 2;
    this.sunLight.position.set(snapX + Math.cos(angle) * 58, Math.max(20, Math.sin(angle) * 58 + 26), snapZ + 24);
    this.sunLight.target.position.set(snapX, snapY, snapZ);
    this.sunLight.target.updateMatrixWorld();
    this.hemiLight.intensity = (0.30 + dayFactor * 0.62) * rainDim;

    this.starMat.opacity = Math.max(0, 1 - dayFactor * 2.2) * (this.weather === 'rain' ? 0.1 : 0.9);
    this.cloudMat.color.setRGB(
      (0.25 + dayFactor * 0.75) * rainDim,
      (0.28 + dayFactor * 0.72) * rainDim,
      (0.35 + dayFactor * 0.65) * rainDim
    );

    // Drift clouds
    for (const c of this.clouds) {
      c.position.x += dt * 1.4;
      if (c.position.x > 95) c.position.x = -95;
    }

    // Rain animation
    this.rainPoints.visible = this.weather === 'rain';
    if (this.weather === 'rain') {
      this.rainPoints.position.set(playerPos.x, playerPos.y - 4, playerPos.z);
      const pos = this.rainPoints.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        let ry = pos.getY(i) - dt * 22;
        if (ry < 0) ry += 24;
        pos.setY(i, ry);
      }
      pos.needsUpdate = true;
    }
  }
}
