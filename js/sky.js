import * as THREE from 'three';

function createSoftCircleTexture(size = 64, coreStop = 0.25) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const half = size / 2;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(coreStop, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

export class SkySystem {
  constructor(scene) {
    this.scene = scene;
    // 0.0 = midnight, 0.25 = sunrise (06:00), 0.5 = noon (12:00), 0.75 = sunset (18:00)
    this.time = 0.31; // Golden morning sunbeams on fresh world start
    this.dayCount = 1;
    this.dayLengthSeconds = 540; // 9 real minutes per Minecraft day
    this.weather = 'clear'; // 'clear' | 'rain'
    this.shaderMode = 'ultra';
    this.biomeEffects = true;
    this.cloudTime = 0;

    // 1. Lighting Rig (Warm Sun + Cool Sky Hemisphere + Subtle Bounce Fill)
    this.hemiLight = new THREE.HemisphereLight(0xcbe8ff, 0x5c694b, 0.92);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xfff4dc, 1.35);
    this.sunLight.position.set(55, 85, 35);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 10;
    this.sunLight.shadow.camera.far = 230;
    const d = 58;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0007;
    this.sunLight.shadow.normalBias = 0.035;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    // Subtle cool fill light from opposite direction so shadows have rich atmospheric tint
    this.fillLight = new THREE.DirectionalLight(0x88b4ff, 0.24);
    this.fillLight.position.set(-40, 30, -30);
    this.scene.add(this.fillLight);

    // 2. Sky Group — strictly centered on player/camera every frame so it never clips
    this.skyGroup = new THREE.Group();
    this.scene.add(this.skyGroup);

    // Shared Sky & Cloud Uniforms (also read by Water & Terrain shaders!)
    this.skyUniforms = {
      uTopColor: { value: new THREE.Color(0x2866c8) },
      uMidColor: { value: new THREE.Color(0x6eb3f5) },
      uHorizonColor: { value: new THREE.Color(0xcce7ff) },
      uSunsetColor: { value: new THREE.Color(0xff8e5c) },
      uSunColor: { value: new THREE.Color(0xfff1c4) },
      uCloudLitColor: { value: new THREE.Color(0xffffff) },
      uCloudShadowColor: { value: new THREE.Color(0x8da6c9) },
      uSunDir: { value: new THREE.Vector3(0.6, 0.5, -0.25).normalize() },
      uMoonDir: { value: new THREE.Vector3(-0.6, -0.5, 0.25).normalize() },
      uTime: { value: 0 },
      uDayFactor: { value: 1.0 },
      uSunsetFactor: { value: 0.0 },
      uRainFactor: { value: 0.0 },
      uCloudCover: { value: 1.0 }
    };

    // Volumetric Atmospheric Sky Dome (BSL / Complementary / Bliss Shader Style)
    const domeGeo = new THREE.SphereGeometry(420, 32, 24);
    const domeMat = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
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
        uniform vec3 uMidColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uSunsetColor;
        uniform vec3 uSunColor;
        uniform vec3 uCloudLitColor;
        uniform vec3 uCloudShadowColor;
        uniform vec3 uSunDir;
        uniform vec3 uMoonDir;
        uniform float uTime;
        uniform float uDayFactor;
        uniform float uSunsetFactor;
        uniform float uRainFactor;
        uniform float uCloudCover;
        varying vec3 vDir;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        float noise2D(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }

        float fbmCloud(vec2 p) {
          float v = 0.0;
          float amp = 0.52;
          mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
          for (int i = 0; i < 5; i++) {
            v += amp * noise2D(p);
            p = rot * p * 2.04 + vec2(17.1, 31.7);
            amp *= 0.5;
          }
          return v;
        }

        void main() {
          vec3 dir = normalize(vDir);
          vec3 sunDir = normalize(uSunDir);
          vec3 moonDir = normalize(uMoonDir);
          float h = clamp(dir.y, 0.0, 1.0);
          float sunDot = max(0.0, dot(dir, sunDir));
          float moonDot = max(0.0, dot(dir, moonDir));

          // 1. Multi-stop Atmospheric Rayleigh + Mie Scattering Sky Gradient
          vec3 skyCol = mix(uHorizonColor, uMidColor, smoothstep(0.0, 0.34, h));
          skyCol = mix(skyCol, uTopColor, smoothstep(0.22, 0.92, h));

          // Warm horizon Mie scattering around sun (creates dreamy sunset/sunrise peach-gold haze)
          float horizonBand = pow(1.0 - h, 3.2);
          float sunSide = pow(sunDot, 2.2);
          skyCol = mix(skyCol, uSunsetColor, horizonBand * (0.28 + 0.62 * sunSide) * uSunsetFactor * (1.0 - uRainFactor * 0.7));

          // Soft pink/lavender twilight band mid-sky during sunset/sunrise
          float twilightArc = smoothstep(0.02, 0.25, h) * (1.0 - smoothstep(0.25, 0.65, h));
          skyCol += vec3(0.26, 0.11, 0.22) * twilightArc * uSunsetFactor * (1.0 - uRainFactor * 0.8);

          // 2. Glowing Sun Disc + Soft Bloom Halo + Subtle Atmospheric Shafts
          float clearAmt = 1.0 - uRainFactor * 0.85;
          float sunVisible = smoothstep(-0.12, 0.05, sunDir.y) * clearAmt;
          float sunHaloWide = pow(sunDot, 7.0) * (0.32 + 0.58 * uSunsetFactor);
          float sunHaloTight = pow(sunDot, 48.0) * (0.65 + 0.65 * uSunsetFactor);
          float sunDisc = smoothstep(0.9982, 0.9994, sunDot) * 2.4;
          skyCol += uSunColor * (sunHaloWide + sunHaloTight + sunDisc) * sunVisible;

          // Subtle diagonal sunbeam rays near horizon during golden hour
          float rayAngle = atan(dir.y - sunDir.y, dir.x - sunDir.x);
          float rays = 0.5 + 0.5 * sin(rayAngle * 7.0 + uTime * 0.15) * cos(rayAngle * 4.0 - uTime * 0.1);
          skyCol += uSunColor * pow(sunDot, 12.0) * rays * 0.18 * (0.35 + 0.65 * uSunsetFactor) * sunVisible;

          // 3. Soft Glowing Moon + Halo at Night
          float moonVisible = smoothstep(-0.08, 0.1, moonDir.y) * clearAmt * (1.0 - uDayFactor * 0.85);
          float moonDisc = smoothstep(0.9988, 0.9995, moonDot) * 1.45;
          float moonHalo = pow(moonDot, 36.0) * 0.28;
          skyCol += vec3(0.78, 0.88, 1.0) * (moonDisc + moonHalo) * moonVisible;

          // 4. Procedural Multi-Layered Volumetric-Style Puffy Clouds (BSL / Bliss Look!)
          if (dir.y > 0.012 && uCloudCover > 0.01) {
            // Curved sky plane projection so clouds stretch gracefully to the horizon
            float projY = dir.y + 0.11;
            vec2 cloudUV = (dir.xz / projY) * 0.42;
            vec2 drift = vec2(uTime * 0.0085, uTime * 0.0032);

            float n1 = fbmCloud(cloudUV * 1.15 + drift);
            float n2 = fbmCloud(cloudUV * 2.35 - drift * 0.65 + vec2(4.2, 9.1));
            float rawDensity = n1 * 0.72 + n2 * 0.28;

            float thresh = mix(0.49, 0.36, uRainFactor);
            float cloudAlpha = smoothstep(thresh, thresh + 0.22, rawDensity);

            // Directional pseudo-volumetric self-shadowing: sample slightly toward the sun!
            vec2 sunStep = normalize(sunDir.xz + vec2(0.0001)) * 0.075;
            float nSun = fbmCloud((cloudUV + sunStep) * 1.15 + drift) * 0.72 + n2 * 0.28;
            float selfLight = clamp((rawDensity - nSun) * 3.4 + 0.58, 0.0, 1.0);

            // Warm sunlit rim + silver lining around sun
            float silverLining = pow(sunDot, 9.0) * (1.0 - cloudAlpha * 0.45) * sunVisible;
            vec3 cCol = mix(uCloudShadowColor, uCloudLitColor, selfLight);
            cCol += uSunColor * (0.45 + 0.55 * uSunsetFactor) * silverLining * 0.9;

            // Fade clouds smoothly into distant atmospheric horizon haze
            float horizonFade = smoothstep(0.012, 0.19, dir.y);
            float finalAlpha = cloudAlpha * horizonFade * 0.92 * uCloudCover;
            skyCol = mix(skyCol, cCol, finalAlpha);
          }

          // Smooth lower hemisphere reflection color (matches horizon for water/void)
          if (dir.y < 0.0) {
            vec3 groundFade = mix(uHorizonColor, uTopColor * 0.35, clamp(-dir.y * 2.2, 0.0, 1.0));
            skyCol = mix(skyCol, groundFade, smoothstep(0.0, -0.15, dir.y));
          }

          gl_FragColor = vec4(skyCol, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });

    this.skyDome = new THREE.Mesh(domeGeo, domeMat);
    this.skyDome.renderOrder = -1000;
    this.skyDome.frustumCulled = false;
    this.skyGroup.add(this.skyDome);

    // 3. Soft Circular Twinkling Stars (never harsh squares!)
    const starTex = createSoftCircleTexture(32, 0.2);
    const starPts = [];
    for (let i = 0; i < 360; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.88 + 0.08);
      const r = 340;
      starPts.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta)
      );
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPts, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xeaf4ff,
      map: starTex,
      size: 4.2,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending
    });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.stars.renderOrder = -999;
    this.stars.frustumCulled = false;
    this.skyGroup.add(this.stars);

    // 4. Rain Streaks (soft translucent droplets)
    const rainCount = 520;
    const rainPos = new Float32Array(rainCount * 3);
    for (let i = 0; i < rainCount; i++) {
      rainPos[i * 3] = (Math.random() - 0.5) * 38;
      rainPos[i * 3 + 1] = Math.random() * 26;
      rainPos[i * 3 + 2] = (Math.random() - 0.5) * 38;
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
    this.rainMat = new THREE.PointsMaterial({
      color: 0xaad4ff,
      map: starTex,
      size: 0.28,
      transparent: true,
      opacity: 0.65,
      depthWrite: false
    });
    this.rainPoints = new THREE.Points(rainGeo, this.rainMat);
    this.rainPoints.visible = false;
    this.scene.add(this.rainPoints);

    // Distance Fog
    this.fog = new THREE.Fog(0xbadfff, 45, 110);
    this.scene.fog = this.fog;
    this.skyColor = new THREE.Color(0xbadfff);

    // Scratch colors (zero per-frame GC churn)
    this._nightTop = new THREE.Color(0x060b1c);
    this._nightMid = new THREE.Color(0x0f1a38);
    this._nightHor = new THREE.Color(0x19284a);
    this._dayTop = new THREE.Color();
    this._dayMid = new THREE.Color();
    this._dayHor = new THREE.Color();
    this._sunsetHor = new THREE.Color();
    this._sunsetMid = new THREE.Color();
    this._sunsetTop = new THREE.Color();
    this._sunCol = new THREE.Color();
    this._cloudLit = new THREE.Color();
    this._cloudShadow = new THREE.Color();
    this._hemiSky = new THREE.Color();
    this._hemiGround = new THREE.Color();
  }

  isNight() {
    return this.time < 0.22 || this.time > 0.78;
  }

  getFormattedTime() {
    const totalMinutes = Math.floor(this.time * 24 * 60);
    const hh = String(Math.floor(totalMinutes / 60) % 24).padStart(2, '0');
    const mm = String(totalMinutes % 60).padStart(2, '0');
    return `Day ${this.dayCount} ${hh}:${mm}`;
  }

  setRenderDistance(chunks) {
    const far = Math.max(54, chunks * 16 - 2);
    this.fog.near = far * 0.48;
    this.fog.far = far;
  }

  setShaderMode(mode) {
    this.shaderMode = mode;
    this.sunLight.castShadow = mode === 'ultra';
    this.skyUniforms.uCloudCover.value = mode === 'off' ? 0.55 : 1.0;
  }

  getShaderParams() {
    return {
      sunDir: this.skyUniforms.uSunDir.value,
      topColor: this.skyUniforms.uTopColor.value,
      midColor: this.skyUniforms.uMidColor.value,
      horizonColor: this.skyUniforms.uHorizonColor.value,
      sunsetColor: this.skyUniforms.uSunsetColor.value,
      sunColor: this.skyUniforms.uSunColor.value,
      cloudLitColor: this.skyUniforms.uCloudLitColor.value,
      cloudShadowColor: this.skyUniforms.uCloudShadowColor.value,
      dayFactor: this.skyUniforms.uDayFactor.value,
      sunsetFactor: this.skyUniforms.uSunsetFactor.value,
      rainFactor: this.skyUniforms.uRainFactor.value,
      cloudTime: this.cloudTime
    };
  }

  update(dt, playerPos, biome = 'Plains') {
    this.time += dt / this.dayLengthSeconds;
    if (this.time >= 1.0) {
      this.time -= 1.0;
      this.dayCount++;
    }
    this.cloudTime += dt;
    this.skyUniforms.uTime.value = this.cloudTime;

    // Keep sky dome strictly centered on the player/camera in all 3 axes!
    this.skyGroup.position.set(playerPos.x, playerPos.y, playerPos.z);

    // Sun angle: 0.25 = sunrise east, 0.5 = noon zenith, 0.75 = sunset west
    const angle = (this.time - 0.25) * Math.PI * 2;
    const sunDirX = Math.cos(angle);
    const sunDirY = Math.sin(angle);
    const sunDirZ = -0.28; // Slight south tilt for gorgeous angled shadows & reflections!

    this.skyUniforms.uSunDir.value.set(sunDirX, sunDirY, sunDirZ).normalize();
    this.skyUniforms.uMoonDir.value.set(-sunDirX, -sunDirY, -sunDirZ).normalize();

    const sunH = Math.sin(angle);
    const dayFactor = THREE.MathUtils.clamp((sunH + 0.14) / 0.36, 0, 1);
    // Broad golden-hour / sunset curve peaking near sunH = 0.08
    const sunsetFactor = Math.pow(THREE.MathUtils.clamp(1.0 - Math.abs(sunH - 0.06) * 3.1, 0, 1), 1.45);
    const isRain = this.weather === 'rain';
    const rainTarget = isRain ? 1.0 : 0.0;
    const rainFactor = THREE.MathUtils.lerp(this.skyUniforms.uRainFactor.value, rainTarget, Math.min(1, dt * 1.8));
    this.skyUniforms.uRainFactor.value = rainFactor;
    this.skyUniforms.uDayFactor.value = dayFactor;
    this.skyUniforms.uSunsetFactor.value = sunsetFactor;

    // Palette inspired by BSL / Complementary Shaders (Images 1 & 2)
    this._dayTop.setHex(0x245ec2).lerp(new THREE.Color(0x465569), rainFactor * 0.8);
    this._dayMid.setHex(0x63a8ed).lerp(new THREE.Color(0x647488), rainFactor * 0.8);
    this._dayHor.setHex(0xd4e8fa).lerp(new THREE.Color(0x8898ab), rainFactor * 0.8);

    // Subtle Biome Atmosphere Tint
    if (this.biomeEffects && rainFactor < 0.5) {
      if (biome === 'Desert') {
        this._dayHor.lerp(new THREE.Color(0xf5e3ba), 0.42);
        this._dayMid.lerp(new THREE.Color(0x88bfe8), 0.3);
      } else if (biome === 'Snowy Taiga') {
        this._dayHor.lerp(new THREE.Color(0xe2f1ff), 0.45);
        this._dayTop.lerp(new THREE.Color(0x4a82c9), 0.3);
      } else if (biome === 'Forest' || biome === 'Birch Forest') {
        this._dayHor.lerp(new THREE.Color(0xbce6dc), 0.2);
      } else if (biome === 'Mountains') {
        this._dayTop.lerp(new THREE.Color(0x1b4fb8), 0.35);
      }
    }

    // Golden-Hour & Dreamy Sunset Palette (warm peach/gold horizon -> rose/violet sky!)
    this._sunsetHor.setHex(0xffb574);
    this._sunsetMid.setHex(0xd47d9e);
    this._sunsetTop.setHex(0x3b488c);

    // Blend Night -> Day -> Sunset
    const topCol = this.skyUniforms.uTopColor.value.copy(this._nightTop).lerp(this._dayTop, dayFactor);
    const midCol = this.skyUniforms.uMidColor.value.copy(this._nightMid).lerp(this._dayMid, dayFactor);
    const horCol = this.skyUniforms.uHorizonColor.value.copy(this._nightHor).lerp(this._dayHor, dayFactor);

    const clearSunset = sunsetFactor * (1.0 - rainFactor * 0.75);
    topCol.lerp(this._sunsetTop, clearSunset * 0.78);
    midCol.lerp(this._sunsetMid, clearSunset * 0.82);
    horCol.lerp(this._sunsetHor, clearSunset * 0.92);

    this.skyUniforms.uSunsetColor.value.setHex(0xff9b54).lerp(new THREE.Color(0xffcfa0), 0.35);
    this._sunCol.setHex(0xfff6dc).lerp(new THREE.Color(0xffb86b), clearSunset * 0.88);
    this.skyUniforms.uSunColor.value.copy(this._sunCol);

    // Volumetric Cloud Lighting (warm golden-cream tops, soft violet-blue undersides!)
    this._cloudLit.setHex(0x1f2b47)
      .lerp(new THREE.Color(0xfffcf5), dayFactor)
      .lerp(new THREE.Color(0xffd2b3), clearSunset * 0.85)
      .lerp(new THREE.Color(0x7c8a9b), rainFactor * 0.75);

    this._cloudShadow.setHex(0x0c1326)
      .lerp(new THREE.Color(0x88a4c7), dayFactor)
      .lerp(new THREE.Color(0x876c96), clearSunset * 0.85)
      .lerp(new THREE.Color(0x4c5866), rainFactor * 0.75);

    this.skyUniforms.uCloudLitColor.value.copy(this._cloudLit);
    this.skyUniforms.uCloudShadowColor.value.copy(this._cloudShadow);

    // Match scene background & fog smoothly to atmospheric horizon
    this.skyColor.copy(horCol);
    this.scene.background = this.skyColor;
    this.fog.color.copy(horCol);

    // Directional Sun & Hemisphere Lighting
    const rainDim = 1.0 - rainFactor * 0.42;
    const shaderBoost = this.shaderMode === 'ultra' ? 1.28 : (this.shaderMode === 'enhanced' ? 1.16 : 1.0);
    this.sunLight.intensity = (0.16 + dayFactor * 1.12) * rainDim * shaderBoost;
    this.sunLight.color.setHex(0x9ab8ff)
      .lerp(new THREE.Color(0xfff5e0), dayFactor)
      .lerp(new THREE.Color(0xffa65c), clearSunset * 0.82);

    // Texel-snapped shadow camera follows player smoothly without shimmer!
    const snapX = Math.round(playerPos.x);
    const snapY = Math.round(playerPos.y);
    const snapZ = Math.round(playerPos.z);
    const lightDir = dayFactor > 0.08 ? this.skyUniforms.uSunDir.value : this.skyUniforms.uMoonDir.value;
    this.sunLight.position.set(
      snapX + lightDir.x * 85,
      snapY + Math.max(26, lightDir.y * 85),
      snapZ + lightDir.z * 85
    );
    this.sunLight.target.position.set(snapX, snapY, snapZ);
    this.sunLight.target.updateMatrixWorld();

    this._hemiSky.copy(midCol).lerp(new THREE.Color(0xdcf0ff), 0.35);
    this._hemiGround.setHex(0x212926).lerp(new THREE.Color(0x63704d), dayFactor).lerp(new THREE.Color(0x7a5646), clearSunset * 0.55);
    this.hemiLight.color.copy(this._hemiSky);
    this.hemiLight.groundColor.copy(this._hemiGround);
    this.hemiLight.intensity = (0.34 + dayFactor * 0.58) * rainDim;

    this.fillLight.color.copy(midCol);
    this.fillLight.intensity = (0.1 + dayFactor * 0.18) * rainDim;

    // Stars twinkle gently at night
    this.starMat.opacity = Math.max(0, 1.0 - dayFactor * 2.4) * (1.0 - rainFactor * 0.9) * 0.92;
    this.stars.rotation.y += dt * 0.004;

    // Rain animation
    this.rainPoints.visible = isRain;
    if (isRain) {
      this.rainPoints.position.set(playerPos.x, playerPos.y - 4, playerPos.z);
      const pos = this.rainPoints.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        let ry = pos.getY(i) - dt * 24;
        if (ry < 0) ry += 26;
        pos.setY(i, ry);
      }
      pos.needsUpdate = true;
    }
  }
}
