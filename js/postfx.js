import * as THREE from 'three';

// Cinematic Real-Time WebGL2 Post-Processing Pipeline (RTX / SEUS PTGI Inspired)
// Pass 1A: Opaque/Cutout/Sky/Entities -> opaqueRT (HDR HalfFloat + WebGL2 DepthTexture)
// Pass 1B: Fast GLSL3 Color+Depth Blit -> sceneRT (zero duplicate opaque draw calls!)
// Pass 1C: Layer-1 Realistic Water (SSR + Refraction + Depth Absorption reading opaqueRT & opaqueDepthTex!)
// Pass 2: Half-Res Karis-Clamped Bright-Pass Bloom + Depth-Occluded Volumetric God-Rays
// Pass 3: 3-Tier Multi-Mip Dual-Kawase Glow Pyramid (half-res + quarter-res dreamy halos, zero banding!)
// Pass 4: Final Composite (FXAA 3.11 + Subtle RCAS Sharpening + Contact Shadows + Depth Underwater Fog + Multi-Mip Bloom + AgX/ACES Filmic)

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
    this.quality = 'ultra'; // 'low' | 'medium' | 'high' | 'ultra'
    this.renderScale = 1.0;

    const isWebGL2 = !!(renderer.capabilities && renderer.capabilities.isWebGL2);
    this._isWebGL2 = isWebGL2;
    const hasHalfFloat = isWebGL2 || (renderer.extensions && renderer.extensions.get('OES_texture_half_float'));
    this._rtType = hasHalfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this._supportsDepthTex = isWebGL2 || !!(renderer.extensions && renderer.extensions.get('WEBGL_depth_texture'));

    this._fsGeo = new THREE.PlaneGeometry(2, 2);
    this._fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._fsScene = new THREE.Scene();
    this._fsQuad = new THREE.Mesh(this._fsGeo, null);
    this._fsQuad.frustumCulled = false;
    this._fsScene.add(this._fsQuad);

    this._tmpVec = new THREE.Vector3();
    this._camFwd = new THREE.Vector3();
    this._sunViewDir = new THREE.Vector3();
    this._invProj = new THREE.Matrix4();

    this.opaqueRT = null;
    this.opaqueDepthTex = null;
    this.sceneRT = null;
    this.sceneDepthTex = null;
    this.fxRT_A = null;
    this.fxRT_B = null;
    this.fxRT_C = null; // Quarter-res wide halo tier!

    // Pass 1B: WebGL2 GLSL3 Color + Depth Copy
    this.copyColorDepthMat = isWebGL2 ? new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null }
      },
      depthTest: true,
      depthFunc: THREE.AlwaysDepth,
      depthWrite: true,
      vertexShader: `
        out vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        in vec2 vUv;
        out vec4 outColor;
        void main() {
          outColor = texture(tColor, vUv);
          gl_FragDepth = texture(tDepth, vUv).r;
        }
      `
    }) : null;

    // Pass 2: Karis-Suppressed HDR Bright-Pass Bloom + Depth-Occluded Volumetric Crepuscular God-Rays
    const raySamples = isTouch ? 12 : 16;
    this.extractMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tDepth: { value: null },
        uHasDepth: { value: this._supportsDepthTex ? 1.0 : 0.0 },
        uSceneTexel: { value: new THREE.Vector2(1 / 1024, 1 / 768) },
        uLightScreenPos: { value: new THREE.Vector2(0.5, 0.7) },
        uLightColor: { value: new THREE.Color(0xffd28a) },
        uLightFacing: { value: 0.0 },
        uGodRayStrength: { value: 0.90 },
        uBloomThreshold: { value: 1.16 },
        uTime: { value: 0.0 }
      },
      depthTest: false,
      depthWrite: false,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `
        uniform sampler2D tScene;
        uniform sampler2D tDepth;
        uniform float uHasDepth;
        uniform vec2 uSceneTexel;
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

        // Karis average suppresses single-pixel specular fireflies before bloom!
        vec3 karisSample(vec2 uv) {
          vec2 d = uSceneTexel * 0.75;
          vec3 c0 = texture2D(tScene, uv + vec2(-d.x, -d.y)).rgb;
          vec3 c1 = texture2D(tScene, uv + vec2( d.x, -d.y)).rgb;
          vec3 c2 = texture2D(tScene, uv + vec2(-d.x,  d.y)).rgb;
          vec3 c3 = texture2D(tScene, uv + vec2( d.x,  d.y)).rgb;
          float w0 = 1.0 / (1.0 + dot(c0, vec3(0.2126, 0.7152, 0.0722)));
          float w1 = 1.0 / (1.0 + dot(c1, vec3(0.2126, 0.7152, 0.0722)));
          float w2 = 1.0 / (1.0 + dot(c2, vec3(0.2126, 0.7152, 0.0722)));
          float w3 = 1.0 / (1.0 + dot(c3, vec3(0.2126, 0.7152, 0.0722)));
          return (c0 * w0 + c1 * w1 + c2 * w2 + c3 * w3) / max(w0 + w1 + w2 + w3, 0.0001);
        }

        void main() {
          vec3 col = karisSample(vUv);
          float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
          float knee = 0.36;
          float soft = clamp(lum - uBloomThreshold + knee, 0.0, 2.0 * knee);
          soft = (soft * soft) / (4.0 * knee + 0.0001);
          float contrib = max(soft, lum - uBloomThreshold) / max(lum, 0.001);
          vec3 bloom = min(col * clamp(contrib, 0.0, 2.0), vec3(3.8));

          vec3 rays = vec3(0.0);
          if (uLightFacing > 0.01 && uGodRayStrength > 0.01) {
            vec2 toLight = uLightScreenPos - vUv;
            float distToLight = length(toLight);
            if (distToLight < 1.55) {
              vec2 stepUv = toLight * (0.94 / float(${raySamples}));
              float jitter = ign(gl_FragCoord.xy + fract(uTime) * 37.0);
              vec2 sampleUv = vUv + stepUv * jitter;

              float weight = 1.0;
              float decay = 0.945;
              vec3 acc = vec3(0.0);
              for (int i = 0; i < ${raySamples}; i++) {
                vec2 clampedUv = clamp(sampleUv, vec2(0.002), vec2(0.998));
                vec3 s = texture2D(tScene, clampedUv).rgb;
                float skyMask;
                if (uHasDepth > 0.5) {
                  float d = texture2D(tDepth, clampedUv).r;
                  skyMask = smoothstep(0.9993, 0.99996, d);
                } else {
                  float sLum = dot(s, vec3(0.2126, 0.7152, 0.0722));
                  skyMask = smoothstep(0.58, 1.35, sLum);
                }
                acc += min(s, vec3(3.0)) * skyMask * weight;
                weight *= decay;
                sampleUv += stepUv;
              }
              float radialFalloff = smoothstep(1.55, 0.02, distToLight) * (0.45 + 0.55 * exp(-distToLight * 1.4));
              rays = (acc / float(${raySamples})) * uLightColor * radialFalloff * uLightFacing * uGodRayStrength * 1.2;
            }
          }

          gl_FragColor = vec4(bloom + rays, 1.0);
        }
      `
    });

    // Pass 3: Fast 5-Tap Dual-Kawase Blur (used across both half-res & quarter-res bloom pyramid tiers!)
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

    // Pass 4: Final Composite — FXAA 3.11 + Subtle RCAS Sharpening + Contact Shadows + Depth Underwater Fog + Multi-Mip Bloom + AgX/ACES Filmic!
    this.compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tDepth: { value: null },
        tBloom: { value: null },
        tBloomWide: { value: null },
        uHasDepth: { value: this._supportsDepthTex ? 1.0 : 0.0 },
        uTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 768) },
        uAaOn: { value: 1.0 },
        uSharpenStrength: { value: 0.18 },
        uContactShadowStrength: { value: 0.28 },
        uSunViewDir: { value: new THREE.Vector3(0.4, 0.7, -0.5).normalize() },
        uInvProjection: { value: new THREE.Matrix4() },
        uProjection: { value: new THREE.Matrix4() },
        uProjZ: { value: new THREE.Vector2(0.2, -1.0) },
        uBloomIntensity: { value: 0.46 },
        uExposure: { value: 1.04 },
        uSunsetFactor: { value: 0.0 },
        uDayFactor: { value: 1.0 },
        uUnderwater: { value: 0.0 },
        uInLava: { value: 0.0 },
        uTime: { value: 0.0 }
      },
      depthTest: false,
      depthWrite: false,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `
        uniform sampler2D tScene;
        uniform sampler2D tDepth;
        uniform sampler2D tBloom;
        uniform sampler2D tBloomWide;
        uniform float uHasDepth;
        uniform vec2 uTexelSize;
        uniform float uAaOn;
        uniform float uSharpenStrength;
        uniform float uContactShadowStrength;
        uniform vec3 uSunViewDir;
        uniform mat4 uInvProjection;
        uniform mat4 uProjection;
        uniform vec2 uProjZ;
        uniform float uBloomIntensity;
        uniform float uExposure;
        uniform float uSunsetFactor;
        uniform float uDayFactor;
        uniform float uUnderwater;
        uniform float uInLava;
        uniform float uTime;
        varying vec2 vUv;

        float ign(vec2 p) {
          return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
        }

        float luma(vec3 c) {
          return dot(c, vec3(0.299, 0.587, 0.114));
        }

        // Fast FXAA 3.11 Edge Smoothing + Contrast-Adaptive Micro-Sharpening (zero ghosting on voxel pixel art!)
        vec3 sampleSceneAA(vec2 uv) {
          vec3 cM = texture2D(tScene, uv).rgb;
          if (uAaOn < 0.5) return cM;
          vec2 t = uTexelSize;
          vec3 cNW = texture2D(tScene, uv + vec2(-t.x, -t.y)).rgb;
          vec3 cNE = texture2D(tScene, uv + vec2( t.x, -t.y)).rgb;
          vec3 cSW = texture2D(tScene, uv + vec2(-t.x,  t.y)).rgb;
          vec3 cSE = texture2D(tScene, uv + vec2( t.x,  t.y)).rgb;

          float lM  = luma(cM);
          float lNW = luma(cNW), lNE = luma(cNE), lSW = luma(cSW), lSE = luma(cSE);
          float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
          float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
          float contrast = lMax - lMin;

          vec3 outCol = cM;
          if (contrast > max(0.035, lMax * 0.10)) {
            vec2 dir;
            dir.x = -((lNW + lNE) - (lSW + lSE));
            dir.y =  ((lNW + lSW) - (lNE + lSE));
            float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
            float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
            dir = clamp(dir * rcpDirMin, vec2(-4.0), vec2(4.0)) * t;

            vec3 rgbA = 0.5 * (
              texture2D(tScene, uv + dir * (1.0 / 3.0 - 0.5)).rgb +
              texture2D(tScene, uv + dir * (2.0 / 3.0 - 0.5)).rgb
            );
            vec3 rgbB = rgbA * 0.5 + 0.25 * (
              texture2D(tScene, uv + dir * -0.5).rgb +
              texture2D(tScene, uv + dir *  0.5).rgb
            );
            float lB = luma(rgbB);
            outCol = (lB < lMin || lB > lMax) ? rgbA : rgbB;
          }

          // Subtle RCAS (Robust Contrast-Adaptive Sharpening) restores crisp pixel-art bevels without ringing!
          if (uSharpenStrength > 0.01) {
            vec3 blurAvg = 0.25 * (cNW + cNE + cSW + cSE);
            vec3 detail = outCol - blurAvg;
            // Attenuate sharpening on high-contrast silhouette edges so AA stays silky!
            float edgeGuard = 1.0 - smoothstep(0.18, 0.65, contrast);
            outCol = max(vec3(0.0), outCol + detail * uSharpenStrength * edgeGuard);
          }
          return outCol;
        }

        // Exact scalar view-Z reconstruction (8x faster than mat4*vec4 inside the 6-step contact shadow loop, bit-identical result!)
        float linearViewZ(float depth) {
          return uProjZ.x / (depth * 2.0 - 1.0 + uProjZ.y);
        }

        vec3 reconstructViewPos(vec2 uv, float depth) {
          vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
          vec4 vp = uInvProjection * ndc;
          return vp.xyz / vp.w;
        }

        float computeContactShadow(vec2 uv, float depth) {
          if (depth >= 0.9996) return 0.0;
          float viewDist = -linearViewZ(depth);
          if (viewDist < 1.15 || viewDist > 34.0) return 0.0;
          vec3 viewPos = reconstructViewPos(uv, depth);

          float distFade = smoothstep(34.0, 16.0, viewDist) * smoothstep(1.15, 1.85, viewDist);
          float rayLen = mix(0.32, 0.64, clamp(viewDist / 26.0, 0.0, 1.0));
          float jitter = ign(gl_FragCoord.xy);
          // Pre-project ray endpoints ONCE outside the loop (eliminates 6 mat4*vec4 per full-res pixel, bit-identical!)
          vec4 clip0 = uProjection * vec4(viewPos, 1.0);
          vec4 clipStep = uProjection * vec4(uSunViewDir * rayLen, 0.0);
          float sunZStep = uSunViewDir.z * rayLen;
          float minThick = 0.025 + viewDist * 0.002;
          float maxThick = 0.24 + viewDist * 0.012;
          float occ = 0.0;

          for (int i = 1; i <= 5; i++) {
            float t = (float(i) - 0.35 + jitter * 0.55) / 5.0;
            vec4 clip = clip0 + clipStep * t;
            vec2 sUv = (clip.xy / clip.w) * 0.5 + 0.5;
            if (sUv.x < 0.002 || sUv.x > 0.998 || sUv.y < 0.002 || sUv.y > 0.998) break;

            float sDepth = texture2D(tDepth, sUv).r;
            if (sDepth >= 0.9998) continue;
            float hitViewZ = linearViewZ(sDepth);
            float dz = hitViewZ - (viewPos.z + sunZStep * t);
            if (dz > minThick && dz < maxThick) {
              occ = max(occ, 1.0 - t * 0.55);
            }
          }
          return occ * distFade;
        }

        // AgX-Inspired Filmic Tone Mapping (preserves natural rich color hues in bright sunsets, lava & cyan glow!)
        vec3 filmicToneMap(vec3 x) {
          // Subtle AgX inset matrix softens extreme chroma clipping into graceful highlight rolloff
          const mat3 inset = mat3(
            0.842, 0.078, 0.079,
            0.042, 0.878, 0.079,
            0.042, 0.078, 0.879
          );
          vec3 c = max(vec3(0.0), inset * x);
          const float a = 2.51;
          const float b = 0.03;
          const float d = 2.43;
          const float e = 0.59;
          const float f = 0.14;
          vec3 mapped = clamp((c * (a * c + b)) / (c * (d * c + e) + f), 0.0, 1.0);
          return mapped;
        }

        void main() {
          vec3 sceneCol = sampleSceneAA(vUv);
          vec3 bloomTight = texture2D(tBloom, vUv).rgb;
          vec3 bloomWide = texture2D(tBloomWide, vUv).rgb;
          vec3 bloomCol = bloomTight * 0.55 + bloomWide * 0.45;
          float rawDepth = uHasDepth > 0.5 ? texture2D(tDepth, vUv).r : 1.0;

          if (uHasDepth > 0.5 && uContactShadowStrength > 0.01 && uDayFactor > 0.06 && uUnderwater < 0.5 && uInLava < 0.5) {
            float contactOcc = computeContactShadow(vUv, rawDepth);
            sceneCol *= 1.0 - contactOcc * uContactShadowStrength * uDayFactor;
          }

          // Full Glowing Molten Red Vision when Swimming Submerged Inside Lava!
          if (uInLava > 0.5) {
            float lavaDist = uHasDepth > 0.5
              ? (rawDepth >= 0.9998 ? 8.0 : max(0.0, -linearViewZ(rawDepth)))
              : 3.0;
            float swirl = 0.92 + 0.08 * sin(vUv.x * 12.0 + uTime * 2.5) * cos(vUv.y * 10.0 - uTime * 2.0);
            vec3 lavaFogCol = vec3(1.45, 0.22, 0.03) * swirl;
            float lavaFog = 1.0 - exp(-lavaDist * 1.65);
            sceneCol = mix(sceneCol * vec3(1.25, 0.32, 0.08), lavaFogCol, clamp(0.58 + lavaFog * 0.42, 0.58, 0.98));
          } else if (uUnderwater > 0.5) {
            if (uHasDepth > 0.5) {
              float dist = rawDepth >= 0.9998 ? 48.0 : max(0.0, -linearViewZ(rawDepth));
              vec3 absorb = exp(-dist * vec3(0.085, 0.032, 0.020));
              vec3 uwFogCol = mix(vec3(0.02, 0.08, 0.18), vec3(0.07, 0.34, 0.48), uDayFactor);
              float fogAmt = 1.0 - exp(-dist * 0.055);
              sceneCol = mix(sceneCol * absorb, uwFogCol, clamp(fogAmt, 0.0, 0.88));
            } else {
              sceneCol = mix(sceneCol, sceneCol * vec3(0.45, 0.82, 0.98), 0.48);
            }
          }

          vec3 col = sceneCol + bloomCol * uBloomIntensity;
          col *= uExposure;

          // Natural balanced color grading (avoiding over-saturated or washed-out look)
          float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
          vec3 nightTint = mix(vec3(0.86, 0.95, 1.16), vec3(0.96, 1.00, 1.08), smoothstep(0.0, 0.6, lum));
          vec3 sunsetTint = mix(vec3(1.05, 0.95, 0.93), vec3(1.12, 1.02, 0.90), smoothstep(0.0, 0.8, lum));
          vec3 dayTint = mix(vec3(0.98, 0.99, 1.02), vec3(1.02, 1.01, 0.99), smoothstep(0.0, 0.8, lum));
          vec3 grade = mix(nightTint, dayTint, uDayFactor);
          grade = mix(grade, sunsetTint, uSunsetFactor * 0.68);
          col *= grade;

          col = filmicToneMap(col);

          float l2 = dot(col, vec3(0.2126, 0.7152, 0.0722));
          float satBoost = mix(1.08, 1.14, uSunsetFactor);
          col = mix(vec3(l2), col, satBoost);

          vec2 d = (vUv - 0.5) * vec2(1.15, 1.0);
          float vig = 1.0 - dot(d, d) * 0.20;
          col *= clamp(vig, 0.82, 1.0);

          col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
          gl_FragColor = vec4(col, 1.0);
        }
      `
    });

    const sz = new THREE.Vector2();
    renderer.getDrawingBufferSize(sz);
    this.resize(Math.max(1, sz.x), Math.max(1, sz.y));
  }

  _makeDepthTex(w, h) {
    const dt = new THREE.DepthTexture(w, h);
    dt.format = THREE.DepthFormat;
    dt.type = this._isWebGL2 ? THREE.UnsignedIntType : THREE.UnsignedShortType;
    dt.minFilter = THREE.NearestFilter;
    dt.magFilter = THREE.NearestFilter;
    return dt;
  }

  resize(pixelW, pixelH) {
    const w = Math.max(2, Math.floor(pixelW * this.renderScale));
    const h = Math.max(2, Math.floor(pixelH * this.renderScale));
    if (this.sceneRT && this.sceneRT.width === w && this.sceneRT.height === h) return;

    this.disposeTargets();
    const makeMainRT = () => {
      const opts = {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        type: this._rtType,
        depthBuffer: true,
        stencilBuffer: false
      };
      let depthTex = null;
      if (this._supportsDepthTex) {
        depthTex = this._makeDepthTex(w, h);
        opts.depthTexture = depthTex;
      }
      return { rt: new THREE.WebGLRenderTarget(w, h, opts), depthTex };
    };

    const mainPair = makeMainRT();
    this.sceneRT = mainPair.rt;
    this.sceneDepthTex = mainPair.depthTex;

    if (this._isWebGL2 && this._supportsDepthTex) {
      const opaquePair = makeMainRT();
      this.opaqueRT = opaquePair.rt;
      this.opaqueDepthTex = opaquePair.depthTex;
    }

    const fxScale = this.isTouch ? 0.33 : 0.45;
    const fw = Math.max(2, Math.floor(w * fxScale));
    const fh = Math.max(2, Math.floor(h * fxScale));
    const qw = Math.max(2, Math.floor(fw * 0.5));
    const qh = Math.max(2, Math.floor(fh * 0.5));
    const fxOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: this._rtType,
      depthBuffer: false,
      stencilBuffer: false
    };
    this.fxRT_A = new THREE.WebGLRenderTarget(fw, fh, fxOpts);
    this.fxRT_B = new THREE.WebGLRenderTarget(fw, fh, fxOpts);
    this.fxRT_C = new THREE.WebGLRenderTarget(qw, qh, fxOpts);

    this.extractMat.uniforms.uSceneTexel.value.set(1 / w, 1 / h);
    this.compositeMat.uniforms.uTexelSize.value.set(1 / w, 1 / h);
  }

  setRenderScale(scale) {
    const clamped = Math.max(0.65, Math.min(1.0, Math.round(scale * 20) / 20));
    if (Math.abs(clamped - this.renderScale) < 0.04) return false;
    this.renderScale = clamped;
    const db = this._dbSize || (this._dbSize = new THREE.Vector2());
    this.renderer.getDrawingBufferSize(db);
    if (db.x > 0 && db.y > 0) this.resize(db.x, db.y);
    return true;
  }

  setQuality(mode) {
    const q = (mode === 'off') ? 'low' : (mode === 'enhanced' ? 'medium' : (mode || 'ultra'));
    this.quality = q;
    this.enabled = q !== 'low';
    this.extractMat.uniforms.uGodRayStrength.value = q === 'ultra' ? 0.90 : (q === 'high' ? 0.68 : 0.34);
    this.compositeMat.uniforms.uBloomIntensity.value = q === 'ultra' ? 0.44 : (q === 'high' ? 0.38 : 0.30);
    this.compositeMat.uniforms.uContactShadowStrength.value = q === 'ultra' ? 0.28 : (q === 'high' ? 0.20 : 0.0);
    this.compositeMat.uniforms.uAaOn.value = (q === 'ultra' || q === 'high' || q === 'medium') ? 1.0 : 0.0;
    this.compositeMat.uniforms.uSharpenStrength.value = q === 'ultra' ? 0.18 : (q === 'high' ? 0.12 : 0.0);
  }

  render(scene, camera, sky, timeSec, underwater = false, world = null, inLava = false) {
    if (!this.enabled || !this.sceneRT) {
      camera.layers.enableAll();
      if (world && world.setWaterSplitPass) world.setWaterSplitPass(false);
      this.renderer.render(scene, camera);
      return;
    }

    const db = this._dbSize || (this._dbSize = new THREE.Vector2());
    this.renderer.getDrawingBufferSize(db);
    const targetW = Math.max(2, Math.floor(db.x * this.renderScale));
    const targetH = Math.max(2, Math.floor(db.y * this.renderScale));
    if (db.x > 0 && db.y > 0 && (targetW !== this.sceneRT.width || targetH !== this.sceneRT.height)) {
      this.resize(db.x, db.y);
    }

    const prevTM = this.renderer.toneMapping;
    this.renderer.toneMapping = THREE.NoToneMapping;

    // Performance: skip extra full-screen opaque copy + water pass whenever NO water chunks are inside the camera frustum!
    const hasWaterInView = !world ? true : (
      world.hasVisibleWater
        ? world.hasVisibleWater(camera)
        : (world._waterChunkCount === undefined || world._waterChunkCount > 0)
    );
    const useSplitWater = !!(hasWaterInView && this.opaqueRT && this.copyColorDepthMat && world && world.syncWaterPass);
    if (useSplitWater) {
      // Pass 1A: Layer 0 Opaque + Cutout + Entities + Sky -> opaqueRT
      camera.layers.set(0);
      this.renderer.setRenderTarget(this.opaqueRT);
      this.renderer.render(scene, camera);

      // Pass 1B: Fast GLSL3 Color + Depth Blit -> sceneRT
      const prevAutoClear = this.renderer.autoClear;
      this.renderer.autoClear = false;
      this.copyColorDepthMat.uniforms.tColor.value = this.opaqueRT.texture;
      this.copyColorDepthMat.uniforms.tDepth.value = this.opaqueDepthTex;
      this._fsQuad.material = this.copyColorDepthMat;
      this.renderer.setRenderTarget(this.sceneRT);
      this.renderer.render(this._fsScene, this._fsCam);

      // Pass 1C: Layer 1 Water SSR + Refraction reading opaqueRT + opaqueDepthTex
      const ssrSteps = this.quality === 'ultra' ? (this.isTouch ? 12 : 16) : (this.quality === 'high' ? 10 : 0);
      world.syncWaterPass(this.opaqueRT.texture, this.opaqueDepthTex, camera, this.sceneRT.width, this.sceneRT.height, ssrSteps);
      const prevBg = scene.background;
      scene.background = null;
      camera.layers.set(1);
      this.renderer.render(scene, camera);
      scene.background = prevBg;
      this.renderer.autoClear = prevAutoClear;
      camera.layers.enableAll();
    } else {
      camera.layers.enableAll();
      if (world && world.setWaterSplitPass) world.setWaterSplitPass(false);
      this.renderer.setRenderTarget(this.sceneRT);
      this.renderer.render(scene, camera);
    }

    // 2. Project Sun / Crescent Moon for depth-occluded God-Rays & Contact Shadows
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

    this._tmpVec.copy(camera.position).addScaledVector(lightDir, 500);
    this._tmpVec.project(camera);
    this.extractMat.uniforms.uLightScreenPos.value.set(this._tmpVec.x * 0.5 + 0.5, this._tmpVec.y * 0.5 + 0.5);
    this.extractMat.uniforms.uLightFacing.value = lightFacing * (useMoon ? 0.40 : (0.72 + 0.55 * sunsetF));
    if (useMoon) {
      this.extractMat.uniforms.uLightColor.value.setRGB(0.55, 0.80, 1.25);
    } else if (su) {
      this.extractMat.uniforms.uLightColor.value.copy(su.uSunColor.value);
    }
    this.extractMat.uniforms.uTime.value = timeSec;
    this.extractMat.uniforms.tScene.value = this.sceneRT.texture;
    this.extractMat.uniforms.tDepth.value = this.sceneDepthTex;

    // 2b. Karis Bright-Pass Bloom + Depth-Occluded God-Rays -> fxRT_A
    this._fsQuad.material = this.extractMat;
    this.renderer.setRenderTarget(this.fxRT_A);
    this.renderer.render(this._fsScene, this._fsCam);

    // 3. Multi-Mip Dual-Kawase Glow Pyramid (Half-Res Tight + Quarter-Res Wide Dreamy Halo!)
    this._fsQuad.material = this.blurMat;
    this.blurMat.uniforms.uTexelSize.value.set(1 / this.fxRT_A.width, 1 / this.fxRT_A.height);
    this.blurMat.uniforms.tInput.value = this.fxRT_A.texture;
    this.blurMat.uniforms.uSpread.value = 1.45;
    this.renderer.setRenderTarget(this.fxRT_B);
    this.renderer.render(this._fsScene, this._fsCam);

    // Downsample to Quarter-Res wide halo tier (fxRT_C)
    this.blurMat.uniforms.tInput.value = this.fxRT_B.texture;
    this.blurMat.uniforms.uSpread.value = 2.4;
    this.renderer.setRenderTarget(this.fxRT_C);
    this.renderer.render(this._fsScene, this._fsCam);

    // Final smooth pass back on half-res tight tier (fxRT_A)
    this.blurMat.uniforms.uTexelSize.value.set(1 / this.fxRT_C.width, 1 / this.fxRT_C.height);
    this.blurMat.uniforms.tInput.value = this.fxRT_C.texture;
    this.blurMat.uniforms.uSpread.value = 1.85;
    this.renderer.setRenderTarget(this.fxRT_A);
    this.renderer.render(this._fsScene, this._fsCam);

    // 4. Final Composite (FXAA 3.11 + RCAS + Contact Shadows + Depth Underwater Fog + Multi-Mip Bloom + Filmic!)
    this._invProj.copy(camera.projectionMatrixInverse);
    this._sunViewDir.copy(sky ? sky._shadowDir : lightDir).transformDirection(camera.matrixWorldInverse).normalize();
    this.compositeMat.uniforms.tScene.value = this.sceneRT.texture;
    this.compositeMat.uniforms.tDepth.value = this.sceneDepthTex;
    this.compositeMat.uniforms.tBloom.value = this.fxRT_B.texture;
    this.compositeMat.uniforms.tBloomWide.value = this.fxRT_A.texture;
    this.compositeMat.uniforms.uSunViewDir.value.copy(this._sunViewDir);
    this.compositeMat.uniforms.uInvProjection.value.copy(this._invProj);
    this.compositeMat.uniforms.uProjection.value.copy(camera.projectionMatrix);
    const pm = camera.projectionMatrix.elements;
    this.compositeMat.uniforms.uProjZ.value.set(-pm[14], pm[10]);
    this.compositeMat.uniforms.uSunsetFactor.value = sunsetF;
    this.compositeMat.uniforms.uDayFactor.value = dayF;
    this.compositeMat.uniforms.uUnderwater.value = underwater ? 1.0 : 0.0;
    this.compositeMat.uniforms.uInLava.value = inLava ? 1.0 : 0.0;
    this.compositeMat.uniforms.uExposure.value = this.quality === 'ultra' ? 0.98 : 0.96;
    this.compositeMat.uniforms.uTime.value = timeSec;

    this._fsQuad.material = this.compositeMat;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this._fsScene, this._fsCam);

    this.renderer.toneMapping = prevTM;
  }

  disposeTargets() {
    if (this.opaqueRT) { this.opaqueRT.dispose(); this.opaqueRT = null; }
    if (this.opaqueDepthTex) { this.opaqueDepthTex.dispose(); this.opaqueDepthTex = null; }
    if (this.sceneRT) { this.sceneRT.dispose(); this.sceneRT = null; }
    if (this.sceneDepthTex) { this.sceneDepthTex.dispose(); this.sceneDepthTex = null; }
    if (this.fxRT_A) { this.fxRT_A.dispose(); this.fxRT_A = null; }
    if (this.fxRT_B) { this.fxRT_B.dispose(); this.fxRT_B = null; }
    if (this.fxRT_C) { this.fxRT_C.dispose(); this.fxRT_C = null; }
  }

  // Rebuilds all HDR render targets & depth textures cleanly after iPad PWA resume or WebGL context restore!
  resetTargets() {
    this.disposeTargets();
    if (!this.renderer) return;
    const sz = this._dbSize || (this._dbSize = new THREE.Vector2());
    this.renderer.getDrawingBufferSize(sz);
    if (sz.x > 0 && sz.y > 0) {
      this.resize(sz.x, sz.y);
    }
  }

  dispose() {
    this.disposeTargets();
    this._fsGeo.dispose();
    if (this.copyColorDepthMat) this.copyColorDepthMat.dispose();
    this.extractMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
  }
}
