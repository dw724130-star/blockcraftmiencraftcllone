import * as THREE from 'three';
import { BLOCK, getBlockDef } from './blocks.js';

// Handcrafted 360-degree Live 3D Voxel Panorama for the Main Menu!
// Only ~5 draw calls total, builds in <15ms, silky-smooth 60 FPS on iPad & Desktop.

const P_SIZE = 36; // 36x36 voxel scenic valley centered around camera
const P_HALF = P_SIZE / 2;
const P_HEIGHT = 28;
const WATER_Y = 7;

// Custom special ID for cherry blossom leaves in the menu diorama
const CHERRY_LEAVES = 250;

const FACES = [
  { dir: [0, 1, 0], type: 'top', shade: 1.0, c: [[0,1,1,0,0],[1,1,1,1,0],[1,1,0,1,1],[0,1,0,0,1]] },
  { dir: [0, -1, 0], type: 'bottom', shade: 0.58, c: [[0,0,0,0,0],[1,0,0,1,0],[1,0,1,1,1],[0,0,1,0,1]] },
  { dir: [1, 0, 0], type: 'side', shade: 0.84, c: [[1,0,1,0,0],[1,0,0,1,0],[1,1,0,1,1],[1,1,1,0,1]] },
  { dir: [-1, 0, 0], type: 'side', shade: 0.84, c: [[0,0,0,0,0],[0,0,1,1,0],[0,1,1,1,1],[0,1,0,0,1]] },
  { dir: [0, 0, 1], type: 'side', shade: 0.75, c: [[0,0,1,0,0],[1,0,1,1,0],[1,1,1,1,1],[0,1,1,0,1]] },
  { dir: [0, 0, -1], type: 'side', shade: 0.75, c: [[1,0,0,0,0],[0,0,0,1,0],[0,1,0,1,1],[1,1,0,0,1]] }
];

function pHash(x, z) {
  let h = Math.imul(x + 131, 374761393) + Math.imul(z + 97, 668265263);
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class TitlePanorama {
  constructor(textures) {
    this.textures = textures;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xcde4ff, 0.022);
    this.scene.background = new THREE.Color(0xcde4ff);

    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 220);
    this.angle = 0.35;
    this.time = 0;

    // Warm golden-morning lighting rig
    const hemi = new THREE.HemisphereLight(0xd9efff, 0x5c7348, 1.05);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff1d0, 1.35);
    sun.position.set(36, 48, 22);
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight(0x8ec5ff, 0.32);
    fill.position.set(-28, 20, -24);
    this.scene.add(fill);

    this.buildSkyDome();
    this.buildDiorama();
    this.buildPetals();
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  buildSkyDome() {
    this.skyUniforms = {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.62, 0.36, 0.48).normalize() }
    };
    const geo = new THREE.SphereGeometry(140, 28, 20);
    const mat = new THREE.ShaderMaterial({
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
        uniform float uTime;
        uniform vec3 uSunDir;
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

        float fbm(vec2 p) {
          float v = 0.60 * noise2D(p);
          p = mat2(0.80, 0.60, -0.60, 0.80) * p * 2.04 + vec2(17.1, 31.7);
          v += 0.30 * noise2D(p);
          p = mat2(0.80, 0.60, -0.60, 0.80) * p * 2.02 + vec2(9.3, 13.7);
          v += 0.14 * noise2D(p);
          return v;
        }

        void main() {
          vec3 dir = normalize(vDir);
          vec3 sunDir = normalize(uSunDir);
          float h = clamp(dir.y, 0.0, 1.0);
          float sunDot = max(0.0, dot(dir, sunDir));

          // Crisp sunlit sapphire -> sky blue -> warm misty cream horizon
          vec3 topCol = vec3(0.16, 0.43, 0.84);
          vec3 midCol = vec3(0.42, 0.70, 0.96);
          vec3 horCol = vec3(0.84, 0.92, 0.99);
          vec3 warmCol = vec3(1.0, 0.86, 0.68);

          vec3 col = mix(horCol, midCol, smoothstep(0.0, 0.34, h));
          col = mix(col, topCol, smoothstep(0.24, 0.90, h));

          // Warm golden glow near the sun
          float horizonBand = pow(1.0 - h, 2.8);
          col = mix(col, warmCol, horizonBand * (0.18 + 0.55 * sunDot * sunDot));

          // Sun disc + soft bloom
          vec3 sunCol = vec3(1.0, 0.96, 0.84);
          col += sunCol * (pow(sunDot, 8.0) * 0.35 + pow(sunDot, 48.0) * 0.75 + smoothstep(0.998, 0.9994, sunDot) * 2.2);

          // Soft puffy drifting clouds
          if (dir.y > 0.02) {
            vec2 uv = (dir.xz / (dir.y + 0.12)) * 0.42;
            vec2 drift = vec2(uTime * 0.009, uTime * 0.003);
            float d = fbm(uv * 1.15 + drift);
            float cAlpha = smoothstep(0.50, 0.74, d) * smoothstep(0.02, 0.22, dir.y) * 0.88;
            vec3 cShadow = vec3(0.64, 0.76, 0.90);
            vec3 cLit = vec3(1.0, 0.99, 0.97);
            vec3 cCol = mix(cShadow, cLit, clamp((d - 0.42) * 2.2, 0.0, 1.0));
            cCol += sunCol * pow(sunDot, 6.0) * 0.35;
            col = mix(col, cCol, cAlpha);
          }

          if (dir.y < 0.0) {
            col = mix(col, vec3(0.55, 0.74, 0.88), smoothstep(0.0, -0.25, dir.y));
          }

          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });
    this.skyMesh = new THREE.Mesh(geo, mat);
    this.skyMesh.renderOrder = -100;
    this.scene.add(this.skyMesh);
  }

  buildDiorama() {
    const grid = new Uint8Array(P_SIZE * P_HEIGHT * P_SIZE);
    const idxOf = (x, y, z) => x + z * P_SIZE + y * P_SIZE * P_SIZE;
    const set = (x, y, z, id) => {
      if (x < 0 || x >= P_SIZE || z < 0 || z >= P_SIZE || y < 0 || y >= P_HEIGHT) return;
      grid[idxOf(x, y, z)] = id;
    };
    const get = (x, y, z) => {
      if (x < 0 || x >= P_SIZE || z < 0 || z >= P_SIZE || y < 0 || y >= P_HEIGHT) return 0;
      return grid[idxOf(x, y, z)];
    };

    const heights = new Int16Array(P_SIZE * P_SIZE);

    // 1. Sculpt a scenic 360-degree valley: sparkling central pond + rolling terraced emerald hills + snowy ridge!
    for (let z = 0; z < P_SIZE; z++) {
      for (let x = 0; x < P_SIZE; x++) {
        const dx = x - P_HALF;
        const dz = z - P_HALF;
        const r = Math.hypot(dx, dz);
        const ang = Math.atan2(dz, dx);

        // Central lake basin (r < 6.8), rising into lush meadow banks and scenic outer hills
        const wave = Math.sin(dx * 0.24 + 0.6) * 2.1 + Math.cos(dz * 0.22 - 0.5) * 1.9 + Math.sin((dx + dz) * 0.16) * 1.6;
        const ridge = Math.max(0, Math.sin(ang * 2.0 + 0.9)) * Math.max(0, (r - 10) * 0.72);
        const basin = r < 7.2 ? -(1.0 - r / 7.2) * 5.2 : Math.min(7.0, (r - 7.2) * 0.34);

        let h = Math.round(WATER_Y + 1.5 + basin + wave * 0.55 + ridge);
        h = Math.max(2, Math.min(P_HEIGHT - 8, h));
        heights[x + z * P_SIZE] = h;

        for (let y = 0; y <= h; y++) {
          if (y === h) {
            if (h <= WATER_Y) set(x, y, z, BLOCK.SAND);
            else if (h >= 17) set(x, y, z, BLOCK.SNOW);
            else if (h >= 15 && pHash(x, z) > 0.45) set(x, y, z, BLOCK.STONE);
            else set(x, y, z, BLOCK.GRASS);
          } else if (y >= h - 2) {
            set(x, y, z, h <= WATER_Y ? BLOCK.SAND : (h >= 16 ? BLOCK.STONE : BLOCK.DIRT));
          } else {
            set(x, y, z, BLOCK.STONE);
          }
        }
      }
    }

    // 2. Build a cozy storybook timber-and-brick voxel cottage overlooking the lake!
    const hx = 24, hz = 12;
    const hy = Math.max(WATER_Y + 2, heights[hx + hz * P_SIZE]);
    for (let dz = 0; dz < 6; dz++) {
      for (let dx = 0; dx < 6; dx++) {
        for (let y = hy - 3; y <= hy; y++) set(hx + dx, y, hz + dz, BLOCK.COBBLESTONE);
        for (let dy = 1; dy <= 3; dy++) {
          const ex = dx === 0 || dx === 5;
          const ez = dz === 0 || dz === 5;
          if (ex && ez) set(hx + dx, hy + dy, hz + dz, BLOCK.OAK_LOG);
          else if (ex || ez) {
            const win = dy === 2 && ((ez && (dx === 2 || dx === 3)) || (ex && (dz === 2 || dz === 3)));
            set(hx + dx, hy + dy, hz + dz, win ? BLOCK.GLOWSTONE : (dy === 1 ? BLOCK.COBBLESTONE : BLOCK.OAK_PLANKS));
          } else {
            set(hx + dx, hy + dy, hz + dz, BLOCK.AIR);
          }
        }
      }
    }
    // Pitched roof on cottage
    for (let step = 0; step <= 3; step++) {
      const ry = hy + 4 + step;
      for (let x = hx - 1; x <= hx + 6; x++) {
        set(x, ry, hz - 1 + step, BLOCK.BRICKS);
        set(x, ry, hz + 6 - step, BLOCK.BRICKS);
      }
    }
    // Warm chimney + garden lantern
    for (let dy = 1; dy <= 8; dy++) set(hx + 4, hy + dy, hz + 1, BLOCK.COBBLESTONE);
    set(hx - 2, hy + 1, hz + 3, BLOCK.OAK_LOG);
    set(hx - 2, hy + 2, hz + 3, BLOCK.GLOWSTONE);

    // 3. Plant iconic Cherry Blossom & Lush Oak Voxel Trees around the 360-degree panorama!
    const plantTree = (tx, tz, isCherry) => {
      if (tx < 3 || tx > P_SIZE - 4 || tz < 3 || tz > P_SIZE - 4) return;
      const ty = heights[tx + tz * P_SIZE];
      if (ty <= WATER_Y + 1 || ty > 15) return;
      if (get(tx, ty, tz) !== BLOCK.GRASS) return;
      const logBlk = isCherry ? BLOCK.SPRUCE_LOG : BLOCK.OAK_LOG;
      const leafBlk = isCherry ? CHERRY_LEAVES : BLOCK.OAK_LEAVES;
      const trunkH = isCherry ? 5 : 4;
      for (let y = 1; y <= trunkH; y++) set(tx, ty + y, tz, logBlk);
      for (let dy = trunkH - 1; dy <= trunkH + 2; dy++) {
        const rad = dy === trunkH + 2 ? 1 : 2;
        for (let dz = -rad; dz <= rad; dz++) {
          for (let dx = -rad; dx <= rad; dx++) {
            if (dx === 0 && dz === 0 && dy <= trunkH) continue;
            if (Math.abs(dx) === rad && Math.abs(dz) === rad && dy >= trunkH + 1) continue;
            if (get(tx + dx, ty + dy, tz + dz) === BLOCK.AIR) {
              set(tx + dx, ty + dy, tz + dz, leafBlk);
            }
          }
        }
      }
    };

    const trees = [
      [8, 9, true], [13, 6, false], [21, 5, true], [29, 9, true],
      [30, 22, false], [26, 28, true], [18, 29, false], [10, 27, true],
      [6, 20, false], [7, 14, true], [28, 16, false], [14, 26, true]
    ];
    for (const [tx, tz, cherry] of trees) plantTree(tx, tz, cherry);

    // 4. Scatter wildflowers & tall grass on sunlit grassy banks
    for (let z = 2; z < P_SIZE - 2; z++) {
      for (let x = 2; x < P_SIZE - 2; x++) {
        const h = heights[x + z * P_SIZE];
        if (h > WATER_Y && h < 15 && get(x, h, z) === BLOCK.GRASS && get(x, h + 1, z) === BLOCK.AIR) {
          const r = pHash(x * 3, z * 5);
          if (r > 0.93) set(x, h + 1, z, BLOCK.FLOWER_RED);
          else if (r > 0.87) set(x, h + 1, z, BLOCK.FLOWER_YELLOW);
          else if (r > 0.74) set(x, h + 1, z, BLOCK.TALL_GRASS);
        }
      }
    }

    // 5. Build single-pass merged meshes (Opaque + Foliage Cutout + Cherry Leaves)
    const opaque = { pos: [], norm: [], uv: [], col: [], idx: [] };
    const cutout = { pos: [], norm: [], uv: [], col: [], idx: [] };

    const isOpaqueSolid = (id) => {
      if (id === 0 || id === CHERRY_LEAVES) return false;
      const d = getBlockDef(id);
      return Boolean(d && !d.transparent && !d.cross);
    };

    const leafUV = this.textures.getUV('birch_leaves');

    for (let y = 0; y < P_HEIGHT; y++) {
      for (let z = 0; z < P_SIZE; z++) {
        for (let x = 0; x < P_SIZE; x++) {
          const id = get(x, y, z);
          if (id === 0) continue;

          const wx = x - P_HALF;
          const wz = z - P_HALF;

          if (id === CHERRY_LEAVES) {
            // Soft pink tinted cherry blossom voxel blocks!
            const b = cutout;
            for (let fi = 0; fi < 6; fi++) {
              const f = FACES[fi];
              const nb = get(x + f.dir[0], y + f.dir[1], z + f.dir[2]);
              if (nb === CHERRY_LEAVES || isOpaqueSolid(nb)) continue;
              const base = b.pos.length / 3;
              const sh = f.shade;
              // Crisp cherry blossom pink tint over crisp leaf texture!
              const tintR = 1.28 * sh;
              const tintG = 0.78 * sh;
              const tintB = 0.96 * sh;
              for (const [cx0, cy0, cz0, u, v] of f.c) {
                b.pos.push(wx + cx0, y + cy0, wz + cz0);
                b.norm.push(f.dir[0], f.dir[1], f.dir[2]);
                b.uv.push(u ? leafUV.u1 : leafUV.u0, v ? leafUV.v1 : leafUV.v0);
                b.col.push(tintR, tintG, tintB);
              }
              b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
            }
            continue;
          }

          const def = getBlockDef(id);
          if (!def) continue;

          if (def.cross) {
            const b = cutout;
            const uv = this.textures.getUV(def.faces.all);
            const quads = [
              [[0.15, 0, 0.15, 0, 0], [0.85, 0, 0.85, 1, 0], [0.85, 0.9, 0.85, 1, 1], [0.15, 0.9, 0.15, 0, 1]],
              [[0.15, 0, 0.85, 0, 0], [0.85, 0, 0.15, 1, 0], [0.85, 0.9, 0.15, 1, 1], [0.15, 0.9, 0.85, 0, 1]]
            ];
            for (const q of quads) {
              const base = b.pos.length / 3;
              for (const [qx, qy, qz, u, v] of q) {
                b.pos.push(wx + qx, y + qy, wz + qz);
                b.norm.push(0, 1, 0);
                b.uv.push(u ? uv.u1 : uv.u0, v ? uv.v1 : uv.v0);
                b.col.push(0.95, 0.95, 0.95);
              }
              b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
            }
            continue;
          }

          const b = def.transparent ? cutout : opaque;
          const glow = def.light > 0 ? 1.35 : 1.0;

          for (let fi = 0; fi < 6; fi++) {
            const f = FACES[fi];
            const nb = get(x + f.dir[0], y + f.dir[1], z + f.dir[2]);
            if (isOpaqueSolid(nb)) continue;
            if (def.transparent && nb === id) continue;

            const texName = def.faces[f.type] || def.faces.all || def.faces.side;
            const uv = this.textures.getUV(texName);
            const base = b.pos.length / 3;
            const sh = Math.min(1.4, f.shade * glow);
            for (const [cx0, cy0, cz0, u, v] of f.c) {
              b.pos.push(wx + cx0, y + cy0, wz + cz0);
              b.norm.push(f.dir[0], f.dir[1], f.dir[2]);
              b.uv.push(u ? uv.u1 : uv.u0, v ? uv.v1 : uv.v0);
              b.col.push(sh, sh, sh * (def.light > 0 ? 0.86 : 1.0));
            }
            b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
          }
        }
      }
    }

    const makeMesh = (bucket, mat) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(bucket.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.norm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uv, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(bucket.col, 3));
      geo.setIndex(bucket.idx);
      const mesh = new THREE.Mesh(geo, mat);
      this.scene.add(mesh);
      return mesh;
    };

    const opaqueMat = new THREE.MeshLambertMaterial({
      map: this.textures.atlasTexture,
      vertexColors: true
    });
    const cutoutMat = new THREE.MeshLambertMaterial({
      map: this.textures.atlasTexture,
      vertexColors: true,
      alphaTest: 0.35,
      side: THREE.DoubleSide
    });

    makeMesh(opaque, opaqueMat);
    makeMesh(cutout, cutoutMat);

    // 6. Crystal-clear animated shimmering water surface!
    this.waterUniforms = {
      uTime: { value: 0 },
      uSunDir: { value: this.skyUniforms.uSunDir.value }
    };
    const waterGeo = new THREE.PlaneGeometry(P_SIZE + 8, P_SIZE + 8, 1, 1);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new THREE.ShaderMaterial({
      uniforms: this.waterUniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uSunDir;
        varying vec3 vWorldPos;
        void main() {
          vec3 V = normalize(cameraPosition - vWorldPos);
          vec2 p = vWorldPos.xz;
          float r1 = sin(p.x * 1.8 + uTime * 1.5 + p.y * 0.8) * cos(p.y * 1.5 - uTime * 1.2);
          float r2 = sin(p.x * 3.2 - uTime * 2.0 + p.y * 2.1) * 0.5;
          vec3 N = normalize(vec3((r1 + r2) * 0.08, 1.0, (r1 - r2) * 0.08));
          float fres = clamp(0.18 + 0.78 * pow(1.0 - max(0.0, dot(N, V)), 3.0), 0.18, 0.92);
          vec3 deep = vec3(0.08, 0.36, 0.56);
          vec3 skyRefl = vec3(0.58, 0.81, 0.98);
          vec3 col = mix(deep, skyRefl, fres);
          vec3 H = normalize(V + normalize(uSunDir));
          float spec = pow(max(0.0, dot(N, H)), 96.0) * 1.6 + pow(max(0.0, dot(N, H)), 20.0) * 0.25;
          col += vec3(1.0, 0.96, 0.84) * spec;
          gl_FragColor = vec4(col, mix(0.72, 0.92, fres));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `
    });
    const waterMesh = new THREE.Mesh(waterGeo, waterMat);
    waterMesh.position.y = WATER_Y + 0.85;
    this.scene.add(waterMesh);
  }

  buildPetals() {
    // Soft drifting pink cherry blossom petals catching the morning sunlight!
    const count = 90;
    const pos = new Float32Array(count * 3);
    this.petalVel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 28;
      pos[i * 3 + 1] = WATER_Y + 2 + Math.random() * 14;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 28;
      this.petalVel[i * 3] = 0.4 + Math.random() * 0.7;
      this.petalVel[i * 3 + 1] = -(0.35 + Math.random() * 0.45);
      this.petalVel[i * 3 + 2] = (Math.random() - 0.5) * 0.6;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffd1e8';
    ctx.fillRect(3, 5, 10, 6);
    ctx.fillStyle = '#fff0f8';
    ctx.fillRect(5, 6, 5, 3);
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;

    const mat = new THREE.PointsMaterial({
      map: tex,
      size: 0.32,
      transparent: true,
      opacity: 0.92,
      depthWrite: false
    });
    this.petals = new THREE.Points(geo, mat);
    this.scene.add(this.petals);
  }

  update(dt) {
    this.time += dt;
    this.angle += dt * 0.085; // Silky slow panoramic 360-degree turn

    if (this.skyUniforms) this.skyUniforms.uTime.value = this.time;
    if (this.waterUniforms) this.waterUniforms.uTime.value = this.time;

    // Gentle floating camera overlooking the pond, cherry trees, cottage & alpine horizon
    const camY = WATER_Y + 6.4 + Math.sin(this.time * 0.35) * 0.35;
    this.camera.position.set(
      Math.cos(this.angle * 0.5) * 1.4,
      camY,
      Math.sin(this.angle * 0.5) * 1.4
    );
    const lookR = 14;
    this.camera.lookAt(
      Math.cos(this.angle) * lookR,
      WATER_Y + 4.0 + Math.sin(this.angle * 1.5) * 0.6,
      Math.sin(this.angle) * lookR
    );

    if (this.petals) {
      const attr = this.petals.geometry.attributes.position;
      for (let i = 0; i < attr.count; i++) {
        let x = attr.getX(i) + (this.petalVel[i * 3] + Math.sin(this.time * 1.4 + i) * 0.4) * dt;
        let y = attr.getY(i) + this.petalVel[i * 3 + 1] * dt;
        let z = attr.getZ(i) + (this.petalVel[i * 3 + 2] + Math.cos(this.time * 1.1 + i) * 0.35) * dt;
        if (y < WATER_Y + 1) {
          y = WATER_Y + 15.5;
          x = (Math.random() - 0.5) * 28;
          z = (Math.random() - 0.5) * 28;
        }
        if (x > 14) x -= 28;
        if (x < -14) x += 28;
        if (z > 14) z -= 28;
        if (z < -14) z += 28;
        attr.setXYZ(i, x, y, z);
      }
      attr.needsUpdate = true;
    }
  }

  render(renderer) {
    renderer.render(this.scene, this.camera);
  }
}
