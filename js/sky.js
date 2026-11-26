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

    // 1. Lighting Rig (2-Cascade Texel-Snapped Sun/Moon Shadows + Cool Sky Hemisphere + Bounce Fill)
    this.hemiLight = new THREE.HemisphereLight(0xcbe8ff, 0x5c694b, 0.92);
    this.scene.add(this.hemiLight);

    // Cascade 0: Near Hero Shadow Map (razor-sharp 2.5cm texels around player, trees, houses & mobs!)
    this.sunLight = new THREE.DirectionalLight(0xfff4dc, 1.35);
    this.sunLight.position.set(55, 85, 35);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 6;
    this.sunLight.shadow.camera.far = 210;
    this._nearExtent = 26;
    this.sunLight.shadow.camera.left = -this._nearExtent;
    this.sunLight.shadow.camera.right = this._nearExtent;
    this.sunLight.shadow.camera.top = this._nearExtent;
    this.sunLight.shadow.camera.bottom = -this._nearExtent;
    this.sunLight.shadow.bias = -0.0005;
    this.sunLight.shadow.normalBias = 0.045;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    // Cascade 1: Far Landscape Shadow Map (±92m covering entire villages, castles & mountain slopes!)
    // Tiny 0.0001 intensity keeps Three.js WebGLShadowMap updating it natively without double-lighting mobs!
    this.sunLightFar = new THREE.DirectionalLight(0xffffff, 0.0001);
    this.sunLightFar.position.set(55, 85, 35);
    this.sunLightFar.castShadow = true;
    this.sunLightFar.shadow.mapSize.set(1024, 1024);
    this.sunLightFar.shadow.camera.near = 6;
    this.sunLightFar.shadow.camera.far = 280;
    this._farExtent = 92;
    this.sunLightFar.shadow.camera.left = -this._farExtent;
    this.sunLightFar.shadow.camera.right = this._farExtent;
    this.sunLightFar.shadow.camera.top = this._farExtent;
    this.sunLightFar.shadow.camera.bottom = -this._farExtent;
    this.sunLightFar.shadow.bias = -0.0008;
    this.sunLightFar.shadow.normalBias = 0.08;
    this.scene.add(this.sunLightFar);
    this.scene.add(this.sunLightFar.target);

    // Subtle cool fill light from opposite direction so shadows have rich atmospheric tint
    this.fillLight = new THREE.DirectionalLight(0x88b4ff, 0.24);
    this.fillLight.position.set(-40, 30, -30);
    this.scene.add(this.fillLight);

    // Scratch vectors for texel-locked light-space shadow snapping (ZERO shadow swimming!)
    this._shadowDir = new THREE.Vector3(0.6, 0.5, -0.25).normalize();
    this._sUp = new THREE.Vector3(0, 1, 0);
    this._sRight = new THREE.Vector3();
    this._sOrthoUp = new THREE.Vector3();
    this._sTarget = new THREE.Vector3();
    this._shadowParams = {
      nearMap: null,
      farMap: null,
      nearMatrix: this.sunLight.shadow.matrix,
      farMatrix: this.sunLightFar.shadow.matrix,
      nearTexelSize: 1 / 2048,
      farTexelSize: 1 / 1024,
      useShadows: true,
      useFarCascade: true,
      shadowSoftness: 1.45,
      shadowDir: this._shadowDir,
      sunLightColor: this.sunLight.color,
      sunLightIntensity: 1.35,
      hemiSkyColor: this.hemiLight.color,
      hemiGroundColor: this.hemiLight.groundColor,
      hemiIntensity: 0.92,
      fillColor: this.fillLight.color,
      fillIntensity: 0.24
    };

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
      uWetness: { value: 0.0 },
      uCloudCover: { value: 1.0 },
      uCloudSteps: { value: 4.0 }
    };

    // Physically-Inspired Rayleigh + Mie Atmospheric Scattering & Ray-Marched Volumetric Cloud Sky Dome
    const domeGeo = new THREE.SphereGeometry(2800, 28, 20);
    const domeMat = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      depthFunc: THREE.LessEqualDepth,
      fog: false,
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 clipPos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = clipPos.xyww;
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
        uniform float uCloudSteps;
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
          float v = 0.50 * noise2D(p);
          p = mat2(0.80, 0.60, -0.60, 0.80) * p * 2.04 + vec2(17.1, 31.7);
          v += 0.27 * noise2D(p);
          p = mat2(0.80, 0.60, -0.60, 0.80) * p * 2.03 + vec2(9.4, 21.3);
          v += 0.14 * noise2D(p);
          p = mat2(0.80, 0.60, -0.60, 0.80) * p * 2.05 + vec2(3.7, 11.9);
          v += 0.09 * noise2D(p);
          return v;
        }

        float fbmCloudFast(vec2 p) {
          float v = 0.62 * noise2D(p);
          p = mat2(0.80, 0.60, -0.60, 0.80) * p * 2.04 + vec2(17.1, 31.7);
          v += 0.30 * noise2D(p);
          p = mat2(0.80, 0.60, -0.60, 0.80) * p * 2.03 + vec2(5.2, 13.7);
          v += 0.08 * noise2D(p);
          return v;
        }

        // Henyey-Greenstein Mie forward-scattering phase function (true atmospheric aureole & cloud silver lining!)
        float hgPhase(float cosTheta, float g) {
          float g2 = g * g;
          float denom = max(0.05, 1.0 + g2 - 2.0 * g * cosTheta);
          return (1.0 - g2) / (4.0 * 3.14159 * pow(denom, 1.5));
        }

        void main() {
          vec3 dir = normalize(vDir);
          vec3 sunDir = normalize(uSunDir);
          vec3 moonDir = normalize(uMoonDir);
          float h = clamp(dir.y, 0.0, 1.0);
          float cosSun = dot(dir, sunDir);
          float sunDot = max(0.0, cosSun);
          float moonDot = max(0.0, dot(dir, moonDir));
          float clearAmt = 1.0 - uRainFactor * 0.82;

          // 1. Physically-Inspired Rayleigh Optical-Depth Sky Gradient + Mie Forward Scattering
          float airMass = 1.0 / (h + 0.16);
          float rayleighT = exp(-airMass * 0.42);
          vec3 skyCol = mix(uHorizonColor, uMidColor, smoothstep(0.0, 0.34, h));
          skyCol = mix(skyCol, uTopColor, clamp(rayleighT * 1.08, 0.0, 1.0));

          // Mie forward-scattering golden aureole & dramatic horizon glow at sunrise/sunset (Image 3!)
          float sunVisible = smoothstep(-0.14, 0.06, sunDir.y) * clearAmt;
          float mieWide = hgPhase(cosSun, 0.62) * (0.24 + 0.68 * uSunsetFactor);
          float mieTight = hgPhase(cosSun, 0.88) * (0.09 + 0.24 * uSunsetFactor);
          float horizonBand = pow(1.0 - h, 2.8);
          skyCol = mix(skyCol, uSunsetColor, horizonBand * (0.34 + 0.66 * pow(sunDot, 1.8)) * uSunsetFactor * clearAmt);
          skyCol += uSunColor * (mieWide * 0.72 + mieTight * 0.55) * (0.45 + 0.55 * horizonBand) * sunVisible;

          // Subtle Belt of Venus rose-violet twilight band opposite the setting/rising sun
          float antiSun = clamp(-cosSun, 0.0, 1.0);
          float twilightArc = smoothstep(0.02, 0.26, h) * (1.0 - smoothstep(0.26, 0.68, h));
          skyCol += vec3(0.30, 0.13, 0.28) * twilightArc * (0.45 + 0.55 * antiSun) * uSunsetFactor * clearAmt;

          // 2. Deep Sapphire Night Sky: Milky Way Galactic Nebula + Twinkling Multi-Color Stars
          float nightAmt = clamp(1.0 - uDayFactor * 1.85, 0.0, 1.0) * clearAmt;
          if (nightAmt > 0.01 && dir.y > 0.0) {
            float galCoord = dir.x * 0.62 + dir.z * 0.78 - dir.y * 0.35;
            float galBand = exp(-galCoord * galCoord * 11.0) * smoothstep(0.04, 0.35, dir.y);
            vec2 galUv = vec2(atan(dir.z, dir.x) * 2.2, dir.y * 4.5);
            float neb1 = fbmCloudFast(galUv * 1.6);
            float neb2 = noise2D(galUv * 4.2 + vec2(3.1, 7.4));
            float dustLane = smoothstep(0.32, 0.68, neb1 * 0.72 + neb2 * 0.28);
            vec3 milkyCol = mix(vec3(0.09, 0.22, 0.56), vec3(0.26, 0.52, 0.95), dustLane);
            skyCol += milkyCol * galBand * dustLane * 0.64 * nightAmt;

            vec2 starGrid = vec2(atan(dir.z, dir.x) * 64.0, asin(clamp(dir.y, 0.0, 1.0)) * 64.0);
            vec2 starCell = floor(starGrid);
            float sRnd = hash21(starCell);
            if (sRnd > 0.960) {
              vec2 sFrac = fract(starGrid) - 0.5;
              float sDist = length(sFrac);
              float twinkle = 0.65 + 0.35 * sin(uTime * (2.5 + sRnd * 5.0) + sRnd * 90.0);
              float sBright = smoothstep(0.24, 0.02, sDist) * (0.65 + (sRnd - 0.960) * 32.0) * twinkle;
              vec3 sCol = sRnd > 0.988 ? vec3(1.1, 0.95, 0.78) : (sRnd > 0.975 ? vec3(0.75, 0.92, 1.25) : vec3(0.95, 0.98, 1.05));
              skyCol += sCol * sBright * 1.65 * smoothstep(0.04, 0.22, dir.y) * nightAmt;
            }
          }

          // 3. Blazing HDR Sun Disc + Multi-Ring Golden Corona
          float sunHaloTight = pow(sunDot, 160.0) * 1.45;
          float sunDisc = smoothstep(0.9982, 0.9994, sunDot) * 4.2;
          skyCol += uSunColor * (sunHaloTight + sunDisc) * sunVisible;

          // 4. Crisp Glowing Crescent Moon + Sapphire Lunar Halo
          float moonVisible = smoothstep(-0.08, 0.08, moonDir.y) * clearAmt * (1.0 - uDayFactor * 0.88);
          if (moonVisible > 0.005) {
            vec3 mUp = normalize(vec3(0.0, 1.0, 0.0) - moonDir * moonDir.y + vec3(0.0001, 0.001, 0.0));
            vec3 mRight = normalize(cross(mUp, moonDir));
            float mx = dot(dir - moonDir, mRight);
            float my = dot(dir - moonDir, mUp);
            float mR = length(vec2(mx, my));
            float outerDisc = smoothstep(0.045, 0.040, mR);
            float cutR = length(vec2(mx - 0.017, my - 0.008));
            float shadowCut = smoothstep(0.036, 0.041, cutR);
            float crescent = outerDisc * shadowCut;
            float earthshine = outerDisc * (1.0 - shadowCut) * 0.14;
            float moonGlowTight = pow(moonDot, 48.0) * 0.78;
            float moonGlowWide = pow(moonDot, 8.0) * 0.34;
            skyCol += vec3(0.76, 0.92, 1.15) * (crescent * 3.4 + earthshine) * moonVisible;
            skyCol += vec3(0.28, 0.62, 1.15) * (moonGlowTight + moonGlowWide) * moonVisible;
          }

          // 5. True Multi-Layer Ray-Marched Volumetric Cumulus + Painterly Cirrus Clouds (Image 3!)
          if (dir.y > 0.006 && uCloudCover > 0.01) {
            // High-altitude windswept cirrus streaks (catch sunrise/sunset gold first!)
            vec2 cirrusUV = (dir.xz / (dir.y + 0.24)) * 0.48 + vec2(uTime * 0.0042, -uTime * 0.0018);
            float cirrus = smoothstep(0.50, 0.84, fbmCloudFast(cirrusUV * vec2(2.1, 0.62)));
            vec3 cirrusCol = mix(uCloudLitColor, uSunColor * 1.25, 0.35 + 0.60 * uSunsetFactor);
            skyCol = mix(skyCol, cirrusCol, cirrus * smoothstep(0.012, 0.22, dir.y) * 0.44 * (1.0 - uRainFactor * 0.6) * uCloudCover);

            // Multi-slice 3D Volumetric Cumulus Slab with Beer-Powder Self-Shadowing & HG Silver Lining!
            int steps = int(clamp(uCloudSteps, 1.0, 4.0));
            vec2 drift = vec2(uTime * 0.0072, uTime * 0.0026);
            vec2 lDirXZ = normalize((uDayFactor > 0.2 ? sunDir.xz : moonDir.xz) + vec2(0.0001));
            float thresh = mix(0.41, 0.29, uRainFactor);
            float hgCloud = hgPhase(cosSun, 0.65) * 0.85 + 0.22;

            vec3 cloudAcc = vec3(0.0);
            float transmittance = 1.0;

            for (int i = 0; i < 4; i++) {
              if (i >= steps) break;
              float sliceFrac = (float(i) + 0.5) / float(steps);
              float slabAlt = mix(0.32, 0.44, sliceFrac);
              vec2 cUv = (dir.xz / (dir.y + 0.115)) * slabAlt;
              // Vertical dome envelope: flat cloud base, billowy rounded tops!
              float shapeEnv = 1.0 - abs(sliceFrac - 0.42) * 0.55;
              float baseN = (i == 0 || i == 2) ? fbmCloud(cUv * 1.15 + drift + vec2(sliceFrac * 0.08, -sliceFrac * 0.05))
                                               : fbmCloudFast(cUv * 1.15 + drift + vec2(sliceFrac * 0.08, -sliceFrac * 0.05));
              float dSample = smoothstep(thresh, thresh + 0.24, baseN * shapeEnv);
              if (dSample > 0.005) {
                // Sun-direction optical thickness march for real 3D volumetric cloud self-shadowing
                float sunOcc = fbmCloudFast((cUv + lDirXZ * 0.065) * 1.15 + drift);
                float beer = exp(-max(0.0, sunOcc - thresh) * 3.8);
                float powder = 1.0 - exp(-dSample * 2.4);
                float litF = clamp(mix(0.28, 1.0, beer) * (0.65 + 0.45 * sliceFrac) + powder * 0.18, 0.0, 1.15);

                vec3 sampleCol = mix(uCloudShadowColor, uCloudLitColor, clamp(litF, 0.0, 1.0));
                // Dramatic golden-apricot silver lining around sun & cyan rim around crescent moon
                float silver = hgCloud * (1.0 - dSample * 0.45) * sunVisible;
                sampleCol += uSunColor * (0.48 + 0.92 * uSunsetFactor) * silver * 0.85;
                sampleCol += vec3(0.45, 0.75, 1.18) * pow(moonDot, 6.0) * (1.0 - dSample * 0.4) * moonVisible * 0.75;

                float stepAlpha = dSample * (0.58 / float(steps)) * 2.2;
                cloudAcc += transmittance * sampleCol * stepAlpha;
                transmittance *= (1.0 - clamp(stepAlpha, 0.0, 0.92));
                if (transmittance < 0.04) break;
              }
            }

            float horizonFade = smoothstep(0.006, 0.15, dir.y);
            float cloudWeight = (1.0 - transmittance) * horizonFade * uCloudCover;
            // Atmospheric aerial perspective on distant horizon clouds so they melt naturally into sunrise/sunset!
            vec3 finalCloud = mix(uHorizonColor, cloudAcc / max(1.0 - transmittance, 0.001), smoothstep(0.006, 0.18, dir.y));
            skyCol = mix(skyCol, finalCloud, clamp(cloudWeight, 0.0, 0.96));
          }

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
    this.skyDome.renderOrder = 2;
    this.skyDome.frustumCulled = false;
    this.skyGroup.add(this.skyDome);

    // 3. Soft Circular Twinkling Stars (never harsh squares!)
    const starTex = createSoftCircleTexture(32, 0.2);
    const starPts = [];
    for (let i = 0; i < 360; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.88 + 0.08);
      const r = 2480;
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
      size: 28.0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending
    });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.stars.renderOrder = 2;
    this.stars.frustumCulled = false;
    this.stars.visible = false;
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

    // Scratch colors (zero per-frame GC churn) — Rich Cobalt Sapphire Night matching Image 4!
    this._nightTop = new THREE.Color(0x040d26);
    this._nightMid = new THREE.Color(0x0c2154);
    this._nightHor = new THREE.Color(0x16397a);
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
    this._tmp = new THREE.Color();
    this._shaderParams = {
      sunDir: this.skyUniforms.uSunDir.value,
      moonDir: this.skyUniforms.uMoonDir.value,
      topColor: this.skyUniforms.uTopColor.value,
      midColor: this.skyUniforms.uMidColor.value,
      horizonColor: this.skyUniforms.uHorizonColor.value,
      sunsetColor: this.skyUniforms.uSunsetColor.value,
      sunColor: this.skyUniforms.uSunColor.value,
      cloudLitColor: this.skyUniforms.uCloudLitColor.value,
      cloudShadowColor: this.skyUniforms.uCloudShadowColor.value,
      dayFactor: 1.0,
      sunsetFactor: 0.0,
      rainFactor: 0.0,
      wetness: 0.0,
      cloudTime: 0.0
    };
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
    const far = Math.max(68, chunks * 16 - 4);
    this.fog.near = far * (chunks > 512 ? 0.30 : (chunks > 128 ? 0.36 : 0.42));
    this.fog.far = far;
    // Keep stars strictly behind distant mountains all the way out to 1024 chunks while preserving angular size!
    if (this.stars && this.starMat) {
      const starScale = Math.max(1.0, (chunks * 18 + 400) / 2480);
      this.stars.scale.setScalar(starScale);
      this.starMat.size = 28.0 * starScale;
    }
  }

  setShaderMode(mode, isTouch = false) {
    const m = (mode === 'off') ? 'low' : (mode === 'enhanced' ? 'medium' : (mode || 'ultra'));
    this.shaderMode = m;
    const useShadows = m !== 'low';
    const useFar = m === 'high' || m === 'ultra';
    const nearSize = m === 'ultra' ? (isTouch ? 1536 : 2048) : 1024;
    const nearExtent = m === 'medium' ? 38 : 26;

    this.sunLight.castShadow = useShadows;
    this.sunLightFar.castShadow = useFar;
    this.sunLightFar.intensity = useFar ? 0.0001 : 0.0;

    if (this.sunLight.shadow.mapSize.x !== nearSize) {
      this.sunLight.shadow.mapSize.set(nearSize, nearSize);
      if (this.sunLight.shadow.map) {
        this.sunLight.shadow.map.dispose();
        this.sunLight.shadow.map = null;
      }
    }
    if (this._nearExtent !== nearExtent) {
      this._nearExtent = nearExtent;
      this.sunLight.shadow.camera.left = -nearExtent;
      this.sunLight.shadow.camera.right = nearExtent;
      this.sunLight.shadow.camera.top = nearExtent;
      this.sunLight.shadow.camera.bottom = -nearExtent;
      this.sunLight.shadow.camera.updateProjectionMatrix();
    }

    this._shadowParams.useShadows = useShadows;
    this._shadowParams.useFarCascade = useFar;
    this._shadowParams.nearTexelSize = 1 / nearSize;
    this._shadowParams.farTexelSize = 1 / 1024;
    this._shadowParams.shadowSoftness = m === 'ultra' ? 1.55 : (m === 'high' ? 1.3 : 1.05);
    this.skyUniforms.uCloudCover.value = m === 'low' ? 0.55 : 1.0;
    this.skyUniforms.uCloudSteps.value = m === 'ultra' ? (isTouch ? 3.0 : 4.0) : (m === 'high' ? 3.0 : (m === 'medium' ? 2.0 : 1.0));
  }

  _positionShadowCascade(light, centerPos, dir, halfExtent, mapSize, lightDist) {
    // Texel-locked light-space projection snapping eliminates shadow edge swimming completely!
    const right = this._sRight;
    const orthoUp = this._sOrthoUp;
    right.crossVectors(this._sUp, dir);
    if (right.lengthSq() < 1e-5) right.set(1, 0, 0);
    else right.normalize();
    orthoUp.crossVectors(dir, right).normalize();

    const texelWorld = (halfExtent * 2) / mapSize;
    const u = Math.round(centerPos.dot(right) / texelWorld) * texelWorld;
    const v = Math.round(centerPos.dot(orthoUp) / texelWorld) * texelWorld;
    const w = centerPos.dot(dir);

    this._sTarget
      .set(0, 0, 0)
      .addScaledVector(right, u)
      .addScaledVector(orthoUp, v)
      .addScaledVector(dir, w);

    light.target.position.copy(this._sTarget);
    light.position.copy(this._sTarget).addScaledVector(dir, lightDist);
    light.target.updateMatrixWorld();
    light.updateMatrixWorld();
  }

  getShadowParams() {
    this._shadowParams.nearMap = this.sunLight.shadow.map ? this.sunLight.shadow.map.texture : null;
    this._shadowParams.farMap = this.sunLightFar.shadow.map ? this.sunLightFar.shadow.map.texture : null;
    this._shadowParams.nearMatrix = this.sunLight.shadow.matrix;
    this._shadowParams.farMatrix = this.sunLightFar.shadow.matrix;
    this._shadowParams.sunLightIntensity = this.sunLight.intensity;
    this._shadowParams.hemiIntensity = this.hemiLight.intensity;
    this._shadowParams.fillIntensity = this.fillLight.intensity;
    return this._shadowParams;
  }

  getShaderParams() {
    this._shaderParams.dayFactor = this.skyUniforms.uDayFactor.value;
    this._shaderParams.sunsetFactor = this.skyUniforms.uSunsetFactor.value;
    this._shaderParams.rainFactor = this.skyUniforms.uRainFactor.value;
    this._shaderParams.wetness = this.skyUniforms.uWetness.value;
    this._shaderParams.cloudTime = this.cloudTime;
    return this._shaderParams;
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
    // Wetness rises smoothly during rain and slowly evaporates after rain clears (feeds Stage 5 PBR puddles!)
    const wetRate = isRain ? 0.35 : 0.08;
    this.skyUniforms.uWetness.value = THREE.MathUtils.lerp(this.skyUniforms.uWetness.value, rainTarget, Math.min(1, dt * wetRate));
    this.skyUniforms.uDayFactor.value = dayFactor;
    this.skyUniforms.uSunsetFactor.value = sunsetFactor;

    // Palette inspired by BSL / Complementary Shaders — ZERO per-frame allocations!
    const tmp = this._tmp;
    this._dayTop.setHex(0x245ec2).lerp(tmp.setHex(0x465569), rainFactor * 0.8);
    this._dayMid.setHex(0x63a8ed).lerp(tmp.setHex(0x647488), rainFactor * 0.8);
    this._dayHor.setHex(0xd4e8fa).lerp(tmp.setHex(0x8898ab), rainFactor * 0.8);

    if (this.biomeEffects && rainFactor < 0.5) {
      if (biome === 'Desert') {
        this._dayHor.lerp(tmp.setHex(0xf5e3ba), 0.42);
        this._dayMid.lerp(tmp.setHex(0x88bfe8), 0.3);
      } else if (biome === 'Snowy Taiga') {
        this._dayHor.lerp(tmp.setHex(0xe2f1ff), 0.45);
        this._dayTop.lerp(tmp.setHex(0x4a82c9), 0.3);
      } else if (biome === 'Forest' || biome === 'Birch Forest') {
        this._dayHor.lerp(tmp.setHex(0xbce6dc), 0.2);
      } else if (biome === 'Mountains') {
        this._dayTop.lerp(tmp.setHex(0x1b4fb8), 0.35);
      }
    }

    this._sunsetHor.setHex(0xffbe73);
    this._sunsetMid.setHex(0xd984a4);
    this._sunsetTop.setHex(0x364894);

    const topCol = this.skyUniforms.uTopColor.value.copy(this._nightTop).lerp(this._dayTop, dayFactor);
    const midCol = this.skyUniforms.uMidColor.value.copy(this._nightMid).lerp(this._dayMid, dayFactor);
    const horCol = this.skyUniforms.uHorizonColor.value.copy(this._nightHor).lerp(this._dayHor, dayFactor);

    const clearSunset = sunsetFactor * (1.0 - rainFactor * 0.75);
    topCol.lerp(this._sunsetTop, clearSunset * 0.78);
    midCol.lerp(this._sunsetMid, clearSunset * 0.82);
    horCol.lerp(this._sunsetHor, clearSunset * 0.92);

    this.skyUniforms.uSunsetColor.value.setHex(0xff9b54).lerp(tmp.setHex(0xffcfa0), 0.35);
    this._sunCol.setHex(0xfff6dc).lerp(tmp.setHex(0xffb86b), clearSunset * 0.88);
    this.skyUniforms.uSunColor.value.copy(this._sunCol);

    this._cloudLit.setHex(0x1f2b47)
      .lerp(tmp.setHex(0xfffcf5), dayFactor)
      .lerp(tmp.setHex(0xffd2b3), clearSunset * 0.85)
      .lerp(tmp.setHex(0x7c8a9b), rainFactor * 0.75);

    this._cloudShadow.setHex(0x0c1326)
      .lerp(tmp.setHex(0x88a4c7), dayFactor)
      .lerp(tmp.setHex(0x876c96), clearSunset * 0.85)
      .lerp(tmp.setHex(0x4c5866), rainFactor * 0.75);

    this.skyUniforms.uCloudLitColor.value.copy(this._cloudLit);
    this.skyUniforms.uCloudShadowColor.value.copy(this._cloudShadow);

    this.skyColor.copy(horCol);
    this.scene.background = this.skyColor;
    this.fog.color.copy(horCol);

    const rainDim = 1.0 - rainFactor * 0.42;
    const shaderBoost = this.shaderMode === 'ultra' ? 1.32 : (this.shaderMode === 'high' ? 1.24 : (this.shaderMode === 'medium' ? 1.15 : 1.0));
    this.sunLight.intensity = (0.16 + dayFactor * 1.18) * rainDim * shaderBoost;
    this.sunLight.color.setHex(0x88aeff)
      .lerp(tmp.setHex(0xfff5e0), dayFactor)
      .lerp(tmp.setHex(0xffa458), clearSunset * 0.86);

    const rawLightDir = dayFactor > 0.08 ? this.skyUniforms.uSunDir.value : this.skyUniforms.uMoonDir.value;
    // Keep shadow elevation >= 0.24 so golden-hour shadows are sweeping & dramatic without infinite horizon streaks!
    this._shadowDir.set(rawLightDir.x, Math.max(0.24, rawLightDir.y), rawLightDir.z).normalize();
    this._positionShadowCascade(this.sunLight, playerPos, this._shadowDir, this._nearExtent, this.sunLight.shadow.mapSize.x, 90);
    if (this.sunLightFar.castShadow) {
      this._positionShadowCascade(this.sunLightFar, playerPos, this._shadowDir, this._farExtent, this.sunLightFar.shadow.mapSize.x, 125);
    }

    this._hemiSky.copy(midCol).lerp(tmp.setHex(0xe8f6ff), 0.45);
    // Luminous BSL bounced ground light so shadows & shaded vertical faces stay crisp & airy (never crushed black!)
    this._hemiGround.setHex(0x283238).lerp(tmp.setHex(0xa8ba9e), dayFactor).lerp(tmp.setHex(0xb88b76), clearSunset * 0.5);
    this.hemiLight.color.copy(this._hemiSky);
    this.hemiLight.groundColor.copy(this._hemiGround);
    this.hemiLight.intensity = (0.42 + dayFactor * 0.86) * rainDim;

    // Opposite-side sky bounce fill light illuminates shaded +Z/-X faces cleanly!
    this.fillLight.color.copy(midCol).lerp(tmp.setHex(0xd8ecff), 0.5);
    this.fillLight.position.set(-rawLightDir.x * 50, 34, 42);
    this.fillLight.intensity = (0.14 + dayFactor * 0.36) * rainDim;

    // Stars twinkle gently at night (completely skipped during day for zero draw calls!)
    const starAlpha = Math.max(0, 1.0 - dayFactor * 2.4) * (1.0 - rainFactor * 0.9) * 0.92;
    this.starMat.opacity = starAlpha;
    this.stars.visible = starAlpha > 0.01;
    if (this.stars.visible) this.stars.rotation.y += dt * 0.004;

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
