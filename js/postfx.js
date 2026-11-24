import * as THREE from 'three';

// Cinematic Real-Time Post-Processing Pipeline (Complementary Reimagined / BSL Style!)
// Pass 1: Scene HDR RenderTarget (preserves >1.0 sun, crescent moon, fire, lava & torch radiance!)
// Pass 2: Half-Res Dual Bright-Pass Bloom Extraction + True Volumetric Screen-Space Crepuscular God-Rays!
// Pass 3: Fast Dual-Pass Kawase Glow Blur (silky dreamy halos, zero banding!)
// Pass 4: Final Composite (HDR Bloom + God-Rays + Warm/Cool Split-Toning + ACES Filmic Tone Mapping + Subtle Vignette!)

const FULLSCREEN_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export class PostFXPipeline {
  constructor(renderer, isTouch = false) {
    this.renderer = renderer;
    this.isTouch = isTouch;
    this.enabled = true;
    this.quality = 'ultra'; // 'ultra' | 'enhanced' | 'off'

    // Use HalfFloatType when supported for true HDR bloom (>1.0 radiance from sun, fire, torches & moon!)
    const isWebGL2 = renderer.capabilities && renderer.capabilities.isWebGL2;
    const hasHalfFloat = isWebGL2 || (renderer.extensions && renderer.extensions.get('OES_texture_half_float'));
    this._rtType = hasHalfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;

    this._fsGeo = new THREE.PlaneGeometry(2, 2);
    this._fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._fsScene = new THREE.Scene();
    this._fsQuad = new THREE.Mesh(this._fsGeo, null);
    this._fsQuad.frustumCulled = false;
    this._fsScene.add(this._fsQuad);

    this._tmpVec = new THREE.Vector3();
    this._camFwd = new THREE.Vector3();

    this.sceneRT = null;
    this.fxRT_A = null;
    this.fxRT_B = null;

    // Pass 2: Bright-Pass Bloom + Volumetric Radial Crepuscular God-Rays!
    const raySamples = isTouch ? 12 : 18;
    this.extractMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        uLightScreenPos: { value: new THREE.Vector2(0.5, 0.7) },
        uLightColor: { value: new THREE.Color(0xffd28a) },
        uLightFacing: { value: 0.0 },
        uGodRayStrength: { value: 0.85 },
        uBloomThreshold: { value: 0.92 },
        uTime: { value: 0.0 }
      },
      depthTest: false,
      depthWrite: false,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `
        uniform sampler2D tScene;
        uniform vec2 uLightScreenPos;
        uniform vec3 uLightColor;
        uniform float uLightFacing;
        uniform float uGodRayStrength;
        uniform float uBloomThreshold;
        uniform float uTime;
        varying vec2 vUv;

        float ign(vec2 p) {
          return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
        }

        void main() {
          vec3 col = texture2D(tScene, vUv).rgb;
          float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
          // Soft knee HDR bright extraction (captures sun, crescent moon, fire, lava, torches & water glints!)
          float knee = 0.35;
          float soft = clamp(lum - uBloomThreshold + knee, 0.0, 2.0 * knee);
          soft = (soft * soft) / (4.0 * knee + 0.0001);
          float contrib = max(soft, lum - uBloomThreshold) / max(lum, 0.001);
          vec3 bloom = col * clamp(contrib, 0.0, 2.8);

          // Real Volumetric Screen-Space Crepuscular God-Rays streaming between trees, mountains & castles!
          vec3 rays = vec3(0.0);
          if (uLightFacing > 0.01 && uGodRayStrength > 0.01) {
            vec2 toLight = uLightScreenPos - vUv;
            float distToLight = length(toLight);
            vec2 stepUv = toLight * (0.92 / float(${raySamples}));
            float jitter = ign(gl_FragCoord.xy + fract(uTime) * 37.0);
            vec2 sampleUv = vUv + stepUv * jitter;

            float weight = 1.0;
            float decay = 0.925;
            vec3 acc = vec3(0.0);
            for (int i = 0; i < ${raySamples}; i++) {
              vec2 clampedUv = clamp(sampleUv, vec2(0.002), vec2(0.998));
              vec3 s = texture2D(tScene, clampedUv).rgb;
              float sLum = dot(s, vec3(0.2126, 0.7152, 0.0722));
              // Only sky/sun/moon/bright openings cast volumetric shafts (occluded cleanly by dark tree silhouettes!)
              float skyMask = smoothstep(0.58, 1.35, sLum);
              acc += s * skyMask * weight;
              weight *= decay;
              sampleUv += stepUv;
            }
            float radialFalloff = smoothstep(1.45, 0.05, distToLight);
            rays = (acc / float(${raySamples})) * uLightColor * radialFalloff * uLightFacing * uGodRayStrength;
          }

          gl_FragColor = vec4(bloom + rays, 1.0);
        }
      `
    });

    // Pass 3: Fast 5-Tap Kawase Glow Blur (ultra-silky wide halo with minimal texture fetches!)
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        uTexelSize: { value: new THREE.Vector2(1 / 512, 1 / 512) },
        uSpread: { value: 1.5 }
      },
      depthTest: false,
      depthWrite: false,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `
        uniform sampler2D tInput;
        uniform vec2 uTexelSize;
        uniform float uSpread;
        varying vec2 vUv;
        void main() {
          vec2 o = uTexelSize * uSpread;
          vec3 c = texture2D(tInput, vUv).rgb * 0.28;
          c += texture2D(tInput, vUv + vec2( o.x,  o.y)).rgb * 0.18;
          c += texture2D(tInput, vUv + vec2(-o.x,  o.y)).rgb * 0.18;
          c += texture2D(tInput, vUv + vec2( o.x, -o.y)).rgb * 0.18;
          c += texture2D(tInput, vUv + vec2(-o.x, -o.y)).rgb * 0.18;
          gl_FragColor = vec4(c, 1.0);
        }
      `
    });

    // Pass 4: Final Cinematic Composite — HDR Bloom + God-Rays + Split-Toning + ACES Filmic + Vibrance + Vignette!
    this.compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        uBloomIntensity: { value: 0.58 },
        uExposure: { value: 1.06 },
        uSunsetFactor: { value: 0.0 },
        uDayFactor: { value: 1.0 },
        uUnderwater: { value: 0.0 }
      },
      depthTest: false,
      depthWrite: false,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `
        uniform sampler2D tScene;
        uniform sampler2D tBloom;
        uniform float uBloomIntensity;
        uniform float uExposure;
        uniform float uSunsetFactor;
        uniform float uDayFactor;
        uniform float uUnderwater;
        varying vec2 vUv;

        // Narkowicz ACES Filmic Tone Mapping (punchy highlights, rich cinematic shadow rolloff!)
        vec3 acesFilm(vec3 x) {
          const float a = 2.51;
          const float b = 0.03;
          const float c = 2.43;
          const float d = 0.59;
          const float e = 0.14;
          return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
        }

        void main() {
          vec3 sceneCol = texture2D(tScene, vUv).rgb;
          vec3 bloomCol = texture2D(tBloom, vUv).rgb;

          // Combine linear scene with luminous bloom & volumetric god-rays
          vec3 col = sceneCol + bloomCol * uBloomIntensity;
          col *= uExposure;

          // Subtle cinematic warm/cool split-toning (warm golden-peach sunset, rich cobalt-sapphire night!)
          float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
          vec3 nightTint = mix(vec3(0.84, 0.94, 1.18), vec3(0.96, 1.00, 1.08), smoothstep(0.0, 0.6, lum));
          vec3 sunsetTint = mix(vec3(1.06, 0.94, 0.92), vec3(1.14, 1.02, 0.88), smoothstep(0.0, 0.8, lum));
          vec3 dayTint = mix(vec3(0.97, 0.99, 1.03), vec3(1.04, 1.02, 0.98), smoothstep(0.0, 0.8, lum));
          vec3 grade = mix(nightTint, dayTint, uDayFactor);
          grade = mix(grade, sunsetTint, uSunsetFactor * 0.72);
          col *= grade;

          // Filmic ACES Tone Mapping
          col = acesFilm(col);

          // Subtle vibrance boost (makes sunsets, emerald forests, glowing fire & cobalt nights pop!)
          float l2 = dot(col, vec3(0.2126, 0.7152, 0.0722));
          float satBoost = mix(1.12, 1.19, uSunsetFactor);
          col = mix(vec3(l2), col, satBoost);

          // Gentle underwater turquoise tint if submerged
          if (uUnderwater > 0.5) {
            col = mix(col, col * vec3(0.58, 0.86, 1.05), 0.45);
          }

          // Subtle cinematic vignette (frames vistas & sunbeams nicely without darkening UI!)
          vec2 d = (vUv - 0.5) * vec2(1.15, 1.0);
          float vig = 1.0 - dot(d, d) * 0.24;
          col *= clamp(vig, 0.78, 1.0);

          // Convert linear to sRGB display output
          col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
          gl_FragColor = vec4(col, 1.0);
        }
      `
    });

    const sz = new THREE.Vector2();
    renderer.getDrawingBufferSize(sz);
    this.resize(Math.max(1, sz.x), Math.max(1, sz.y));
  }

  resize(pixelW, pixelH) {
    const w = Math.max(2, Math.floor(pixelW));
    const h = Math.max(2, Math.floor(pixelH));
    if (this.sceneRT && this.sceneRT.width === w && this.sceneRT.height === h) return;

    this.disposeTargets();
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: this._rtType,
      depthBuffer: true,
      stencilBuffer: false
    });

    const fxScale = this.isTouch ? 0.36 : 0.48;
    const fw = Math.max(2, Math.floor(w * fxScale));
    const fh = Math.max(2, Math.floor(h * fxScale));
    const fxOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: this._rtType,
      depthBuffer: false,
      stencilBuffer: false
    };
    this.fxRT_A = new THREE.WebGLRenderTarget(fw, fh, fxOpts);
    this.fxRT_B = new THREE.WebGLRenderTarget(fw, fh, fxOpts);
    this.blurMat.uniforms.uTexelSize.value.set(1 / fw, 1 / fh);
  }

  setQuality(mode) {
    this.quality = mode || 'ultra';
    this.enabled = this.quality !== 'off';
    this.extractMat.uniforms.uGodRayStrength.value = this.quality === 'ultra' ? 0.95 : 0.62;
    this.compositeMat.uniforms.uBloomIntensity.value = this.quality === 'ultra' ? 0.64 : 0.46;
  }

  render(scene, camera, sky, timeSec, underwater = false) {
    if (!this.enabled || !this.sceneRT) {
      this.renderer.render(scene, camera);
      return;
    }

    // Ensure target matches live drawing buffer size (handles DPR/orientation changes on iPad!)
    const db = this._dbSize || (this._dbSize = new THREE.Vector2());
    this.renderer.getDrawingBufferSize(db);
    if (db.x > 0 && db.y > 0 && (db.x !== this.sceneRT.width || db.y !== this.sceneRT.height)) {
      this.resize(db.x, db.y);
    }

    // Temporarily render scene in linear HDR without tone mapping (final Pass 4 applies ACES Filmic!)
    const prevTM = this.renderer.toneMapping;
    this.renderer.toneMapping = THREE.NoToneMapping;

    // 1. Render main 3D world into HDR sceneRT
    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.render(scene, camera);

    // 2. Project active Sun (day/sunset) OR Crescent Moon (night) into screen UV space for real God-Rays!
    const su = sky ? sky.skyUniforms : null;
    const dayF = su ? su.uDayFactor.value : 1.0;
    const sunsetF = su ? su.uSunsetFactor.value : 0.0;
    const rainF = su ? su.uRainFactor.value : 0.0;
    const useMoon = dayF < 0.22;
    const lightDir = su
      ? (useMoon ? su.uMoonDir.value : su.uSunDir.value)
      : this._tmpVec.set(0.6, 0.5, -0.25).normalize();

    camera.getWorldDirection(this._camFwd);
    const facingDot = this._camFwd.dot(lightDir);
    const lightUp = THREE.MathUtils.smoothstep(lightDir.y, -0.10, 0.08);
    const lightFacing = THREE.MathUtils.smoothstep(facingDot, 0.05, 0.68) * lightUp * (1.0 - rainF * 0.78);

    // Project distant sky light point through camera view-projection matrix
    this._tmpVec.copy(camera.position).addScaledVector(lightDir, 500);
    this._tmpVec.project(camera);
    this.extractMat.uniforms.uLightScreenPos.value.set(this._tmpVec.x * 0.5 + 0.5, this._tmpVec.y * 0.5 + 0.5);
    this.extractMat.uniforms.uLightFacing.value = lightFacing * (useMoon ? 0.42 : (0.72 + 0.55 * sunsetF));
    if (useMoon) {
      this.extractMat.uniforms.uLightColor.value.setRGB(0.55, 0.80, 1.25);
    } else if (su) {
      this.extractMat.uniforms.uLightColor.value.copy(su.uSunColor.value);
    }
    this.extractMat.uniforms.uTime.value = timeSec;
    this.extractMat.uniforms.tScene.value = this.sceneRT.texture;

    // 2b. Bright-pass bloom + Volumetric God-Ray pass -> fxRT_A
    this._fsQuad.material = this.extractMat;
    this.renderer.setRenderTarget(this.fxRT_A);
    this.renderer.render(this._fsScene, this._fsCam);

    // 3. Fast Dual-Pass Kawase Blur (fxRT_A -> fxRT_B -> fxRT_A)
    this._fsQuad.material = this.blurMat;
    this.blurMat.uniforms.tInput.value = this.fxRT_A.texture;
    this.blurMat.uniforms.uSpread.value = 1.65;
    this.renderer.setRenderTarget(this.fxRT_B);
    this.renderer.render(this._fsScene, this._fsCam);

    this.blurMat.uniforms.tInput.value = this.fxRT_B.texture;
    this.blurMat.uniforms.uSpread.value = 3.1;
    this.renderer.setRenderTarget(this.fxRT_A);
    this.renderer.render(this._fsScene, this._fsCam);

    // 4. Final Cinematic Composite to Screen!
    this.compositeMat.uniforms.tScene.value = this.sceneRT.texture;
    this.compositeMat.uniforms.tBloom.value = this.fxRT_A.texture;
    this.compositeMat.uniforms.uSunsetFactor.value = sunsetF;
    this.compositeMat.uniforms.uDayFactor.value = dayF;
    this.compositeMat.uniforms.uUnderwater.value = underwater ? 1.0 : 0.0;
    this.compositeMat.uniforms.uExposure.value = this.quality === 'ultra' ? 1.08 : 1.04;

    this._fsQuad.material = this.compositeMat;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this._fsScene, this._fsCam);

    this.renderer.toneMapping = prevTM;
  }

  disposeTargets() {
    if (this.sceneRT) { this.sceneRT.dispose(); this.sceneRT = null; }
    if (this.fxRT_A) { this.fxRT_A.dispose(); this.fxRT_A = null; }
    if (this.fxRT_B) { this.fxRT_B.dispose(); this.fxRT_B = null; }
  }

  dispose() {
    this.disposeTargets();
    this._fsGeo.dispose();
    this.extractMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
  }
}
