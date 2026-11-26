// High-Detail Multi-Threaded Greedy LOD Terrain Mesher (4-Tier Quadtree + Web Worker Pool)
// Runs completely off-thread with zero-copy Transferable ArrayBuffers and automatic sync fallback.

// Material flags packed into normalized Uint8 `aMat` vertex attribute (0..255 -> 0.0..1.0 in shader):
// 0   (0.00) = Standard terrain (grass, dirt, sand, village paths/buildings -> 1m voxel micro-grain)
// 64  (0.25) = Water (oceans, lakes, rivers -> live BSL sky reflection, ripples & sun sparkle!)
// 128 (0.50) = Foliage (oak, birch, spruce canopies -> dappled leaves & sunlit backlighting)
// 192 (0.75) = Snow / Ice (alpine caps, snowy taiga, frozen water -> frosty sun glint)
// 255 (1.00) = Exposed Rock / Cliff / Stone Watchtower (horizontal sedimentary strata banding)

// Self-contained kernel factory — stringified verbatim into inline Blob Web Workers AND used directly on main thread!
export function createLodKernel(seed, worldType) {
  const SEA_LEVEL = 64;
  const CHUNK_HEIGHT = 512;
  const CHUNK_SIZE = 16;
  const SNOW_LINE = SEA_LEVEL + 92;
  const ROCK_LINE = SEA_LEVEL + 66;
  const CELLS = 64; // 64x64 voxel columns per super-region -> TRUE 1m voxel detail on Tier 0 & 2x resolution on ALL tiers!
  const PAD = CELLS + 2; // 66x66 padded grid for exact slopes, cliffs, and corner AO

  const MAT_TERRAIN = 0;
  const MAT_WATER = 64;
  const MAT_FOLIAGE = 128;
  const MAT_SNOW = 192;
  const MAT_ROCK = 255;

  const isFlat = worldType === 'flat';

  function mulberry32(s) {
    let a = s >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makePerm(s) {
    const rand = mulberry32(s);
    const perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    return perm;
  }

  const permH = makePerm(seed);
  const permB = makePerm(seed + 101);
  const permM = makePerm(seed + 202);

  function noise2D(p, x, y) {
    let xi = x | 0;
    if (x < xi) xi--;
    let yi = y | 0;
    if (y < yi) yi--;
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);

    const pX = p[X];
    const pX1 = p[X + 1];
    const aa = p[pX + Y] & 7;
    const ab = p[pX + Y + 1] & 7;
    const ba = p[pX1 + Y] & 7;
    const bb = p[pX1 + Y + 1] & 7;

    const xf1 = xf - 1;
    const yf1 = yf - 1;

    let uu = aa < 4 ? xf : yf, vv = aa < 4 ? yf : xf;
    const gAA = ((aa & 1) ? -uu : uu) + ((aa & 2) ? -2.0 * vv : 2.0 * vv);
    uu = ba < 4 ? xf1 : yf; vv = ba < 4 ? yf : xf1;
    const gBA = ((ba & 1) ? -uu : uu) + ((ba & 2) ? -2.0 * vv : 2.0 * vv);
    uu = ab < 4 ? xf : yf1; vv = ab < 4 ? yf1 : xf;
    const gAB = ((ab & 1) ? -uu : uu) + ((ab & 2) ? -2.0 * vv : 2.0 * vv);
    uu = bb < 4 ? xf1 : yf1; vv = bb < 4 ? yf1 : xf1;
    const gBB = ((bb & 1) ? -uu : uu) + ((bb & 2) ? -2.0 * vv : 2.0 * vv);

    const x1 = gAA + u * (gBA - gAA);
    const x2 = gAB + u * (gBB - gAB);
    return (x1 + v * (x2 - x1)) * 0.45;
  }

  function fbm2D(p, x, y, octaves) {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let max = 0;
    for (let i = 0; i < octaves; i++) {
      sum += noise2D(p, x * freq, y * freq) * amp;
      max += amp;
      amp *= 0.5;
      freq *= 2.0;
    }
    return sum / max;
  }

  function coordHash(x, z, s) {
    let h = Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(s, 1442695041);
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // Zero-allocation terrain column sampler matching World.sampleColumn() exactly!
  // Biome IDs: 0=Plains, 1=Mountains, 2=Desert, 3=Snowy Taiga, 4=Forest, 5=Birch Forest,
  //            6=Savanna, 7=Jungle, 8=Badlands, 9=Swamp, 10=Cherry Grove
  let outH = SEA_LEVEL + 2;
  let outB = 0;

  function sampleColumnLod(wx, wz, detailLevel) {
    if (isFlat) {
      outH = SEA_LEVEL + 2;
      outB = 0;
      return;
    }
    const octBiome = detailLevel >= 2 ? 2 : 3;
    const temp = fbm2D(permB, wx * 0.00062, wz * 0.00062, octBiome);
    const moist = fbm2D(permM, wx * 0.00062, wz * 0.00062, octBiome);
    const mountField = fbm2D(permH, wx * 0.00068 + 50, wz * 0.00068 - 50, octBiome);
    const octCont = detailLevel >= 3 ? 2 : (detailLevel >= 1 ? 3 : 4);
    const cont = fbm2D(permH, wx * 0.00078, wz * 0.00078, octCont);
    const isOceanZone = cont < -0.175 && mountField < 0.04 && (wx * wx + wz * wz) > 260 * 260;

    let biome = 0;
    if (isOceanZone) biome = 11;
    else if (mountField > 0.145) biome = 1;
    else if (temp > 0.21 && moist < -0.05) biome = 8;
    else if (temp > 0.13 && moist < 0.01) biome = 2;
    else if (temp > 0.10 && moist < 0.11) biome = 6;
    else if (temp > 0.09 && moist >= 0.11) biome = 7;
    else if (temp < -0.13) biome = 3;
    else if (moist > 0.13 && cont < 0.04 && temp > -0.06) biome = 9;
    else if (mountField > 0.055 && temp > -0.08 && temp < 0.10 && moist > -0.05) biome = 10;
    else if (moist > 0.07) biome = temp > 0.0 ? 4 : 5;

    const octHills = detailLevel >= 3 ? 1 : (detailLevel >= 1 ? 2 : 3);
    const hills = fbm2D(permH, wx * 0.0042, wz * 0.0042, octHills);
    const micro = detailLevel === 0 ? noise2D(permH, wx * 0.028, wz * 0.028) * 1.5 : 0;

    let mRaw = (mountField - 0.01) / 0.34;
    if (mRaw < 0) mRaw = 0;
    else if (mRaw > 1) mRaw = 1;
    const mSmooth = mRaw * mRaw * (3 - 2 * mRaw);

    let alpineBoost = 0;
    if (mSmooth > 0.001) {
      const warpOct = detailLevel >= 2 ? 1 : 2;
      const warpX = fbm2D(permB, wx * 0.0022 + 11, wz * 0.0022 - 19, warpOct) * 78;
      const warpZ = fbm2D(permM, wx * 0.0022 - 27, wz * 0.0022 + 33, warpOct) * 78;
      const rx = wx + warpX;
      const rz = wz + warpZ;

      const r1 = 1.0 - Math.abs(noise2D(permH, rx * 0.0024, rz * 0.0024) * 1.85);
      const ridgeA = r1 > 0 ? Math.pow(r1, 1.65) : 0;

      let ridgeB = 0;
      let ridgeC = 0;
      if (detailLevel < 3) {
        const r2 = 1.0 - Math.abs(noise2D(permH, rx * 0.0058 + 41, rz * 0.0058 - 17) * 1.85);
        if (r2 > 0) ridgeB = Math.pow(r2, 1.95) * (0.35 + 0.65 * ridgeA);
        if (detailLevel === 0) {
          const r3 = 1.0 - Math.abs(noise2D(permH, rx * 0.015 - 13, rz * 0.015 + 29) * 1.85);
          if (r3 > 0) ridgeC = Math.pow(r3, 2.1) * (0.25 + 0.75 * ridgeB);
        }
      }

      alpineBoost = mSmooth * 36.0 + (mSmooth * mSmooth) * (ridgeA * 142.0 + ridgeB * 52.0 + ridgeC * 16.0);
    }

    let valleyCarve = 0;
    let riverCarve = 0;
    let pondCarve = 0;
    if (detailLevel < 3 && mSmooth < 0.78) {
      const octRiv = detailLevel >= 1 ? 2 : 3;
      const riverRaw = Math.abs(fbm2D(permM, wx * 0.0015 + 200, wz * 0.0015 - 150, octRiv));
      const valleyT = riverRaw < 0.14 ? (1 - riverRaw / 0.14) : 0;
      valleyCarve = (valleyT * valleyT * (3 - 2 * valleyT)) * 18.0 * (1 - mSmooth * 0.45);
      const riverT = riverRaw < 0.044 ? (1 - riverRaw / 0.044) : 0;
      riverCarve = (riverT * riverT * (3 - 2 * riverT)) * 20.0 * (1 - mSmooth * 0.72);

      const pondOct = detailLevel >= 2 ? 1 : 2;
      const pondNoise = fbm2D(permB, wx * 0.0042 - 90, wz * 0.0042 + 110, pondOct);
      let pondT = pondNoise < -0.24 ? (-0.24 - pondNoise) / 0.22 : 0;
      if (pondT > 1) pondT = 1;
      pondCarve = (pondT * pondT * (3 - 2 * pondT)) * 11.0 * (1 - mSmooth * 0.9);
    }

    let flatBlend = 1 - mSmooth * 1.8;
    if (flatBlend < 0) flatBlend = 0;
    else if (flatBlend > 1) flatBlend = 1;

    let biomeOffset = 0;
    let hillAmp = (temp > 0.13 ? 8.5 : 13.5) * flatBlend + 7.0 * mSmooth;
    if (biome === 8) {
      const mesaRaw = Math.max(0, Math.min(1, (hills + 0.18) * 2.2));
      const stepped = Math.floor(mesaRaw * 4) * 10.0 + Math.min(1, (mesaRaw * 4) % 1 * 3.5) * 3.0;
      biomeOffset = stepped * flatBlend;
      hillAmp = 3.5 * flatBlend;
    } else if (biome === 6) {
      biomeOffset = (hills > 0.12 ? 14.0 : 4.0) * flatBlend;
      hillAmp = 7.0 * flatBlend;
    } else if (biome === 7) {
      hillAmp = 15.5 * flatBlend;
      biomeOffset = 6.5 * flatBlend;
    } else if (biome === 9) {
      hillAmp = 2.6 * flatBlend;
      biomeOffset = -12.0 * flatBlend;
    } else if (biome === 10) {
      biomeOffset = 12.0 * flatBlend;
      hillAmp = 9.5 * flatBlend;
    }

    const terrace = detailLevel < 3 ? Math.sin(hills * 3.14159) * 0.75 * flatBlend : 0;
    let oceanCarve = 0;
    if (isOceanZone) {
      let oRaw = (-0.175 - cont) / 0.18;
      if (oRaw < 0) oRaw = 0;
      else if (oRaw > 1) oRaw = 1;
      oceanCarve = 18.0 + (oRaw * oRaw * (3 - 2 * oRaw)) * 24.0;
    }
    let baseH = SEA_LEVEL + 16.5 + cont * 32.0 + (hills * hillAmp + terrace) + biomeOffset + micro + alpineBoost - valleyCarve - riverCarve - pondCarve - oceanCarve;
    if (isOceanZone) {
      baseH = Math.min(baseH, SEA_LEVEL - 5.0 + hills * 3.0);
    } else if (biome === 9 && mSmooth < 0.15) {
      baseH = Math.min(baseH, SEA_LEVEL + 3.5 + hills * 3.0);
      baseH = Math.max(baseH, SEA_LEVEL - 2.5);
    }
    let h = Math.floor(baseH);
    if (h < 10) h = 10;
    else if (h > CHUNK_HEIGHT - 16) h = CHUNK_HEIGHT - 16;
    outH = h;
    outB = biome;
  }

  function isVillageCenter(vcx, vcz) {
    if (isFlat) return false;
    if (vcx === 5 && vcz === 4) return true;
    if (((vcx % 32) + 32) % 32 !== 11 || ((vcz % 32) + 32) % 32 !== 11) return false;
    return coordHash(vcx * 13, vcz * 17, seed + 555) > 0.28;
  }

  function isWatchtowerChunk(cx, cz) {
    if (isFlat) return false;
    if (((cx % 20) + 20) % 20 !== 10 || ((cz % 20) + 20) % 20 !== 9) return false;
    return coordHash(cx * 31, cz * 29, seed + 777) > 0.55;
  }

  // Exact match to World.getMegaStructureForChunk so Great Pyramids & 64x64 Mega Castles rise majestically on the horizon!
  function getMegaOriginInGrid(gx, gz) {
    if (gx === 0 && gz === 0) {
      return { type: 1, originCx: -15, originCz: -13, sizeChunks: 4 }; // Starter Great Pyramid!
    }
    const GRID = 68;
    const HALF_GRID = 34;
    const hRoll = coordHash(gx * 59, gz * 83, seed + 1901);
    if (hRoll < 0.25) return null;
    const isCastle = (((gx + gz) & 1) === 1) || hRoll > 0.62;
    const sizeChunks = 4;
    const offX = 8 + Math.floor(coordHash(gx * 37, gz * 71, seed + 1913) * (GRID - 18));
    const offZ = 8 + Math.floor(coordHash(gx * 97, gz * 41, seed + 1931) * (GRID - 18));
    return {
      type: isCastle ? 2 : 1,
      originCx: gx * GRID - HALF_GRID + offX,
      originCz: gz * GRID - HALF_GRID + offZ,
      sizeChunks
    };
  }

  // Reusable zero-GC scratch arrays (allocated ONCE per worker/instance!)
  const gridN = PAD * PAD;
  const colBaseH = new Int16Array(gridN);
  const colBiome = new Uint8Array(gridN);
  const colTopY = new Int16Array(gridN);
  const colTopRGB = new Uint32Array(gridN);  // packed 0xRRGGBB
  const colSideRGB = new Uint32Array(gridN); // packed 0xRRGGBB
  const colMat = new Uint8Array(gridN);      // MAT_* flag
  const colSideMat = new Uint8Array(gridN);  // MAT_* flag for cliffs
  const colVillage = new Uint8Array(gridN);  // 0=none, 1=road, 2=roof, 3=spire, 4=tower, 5=pyramid, 6=pyramid_gold, 7=pyramid_band, 8=citadel_wall, 9=citadel_roof
  const colStructH = new Int16Array(gridN);  // Exact extra height for mega-structures (stepped pyramid & citadel!)

  // Greedy meshing scratch buffers for 64x64 top faces
  const topVisited = new Uint8Array(CELLS * CELLS);
  const topAO = new Uint8Array(CELLS * CELLS); // 4 corners * 2 bits = 8 bits per cell!

  // Reusable geometry output scratch buffers (grow automatically if needed)
  let capVerts = 32768;
  let posBuf = new Float32Array(capVerts * 3);
  let normBuf = new Int8Array(capVerts * 3);
  let colBuf = new Uint8Array(capVerts * 3);
  let matBuf = new Uint8Array(capVerts);
  let idxBuf = new Uint32Array((capVerts >> 2) * 6);

  function ensureVerts(needed) {
    if (needed <= capVerts) return;
    let nextCap = capVerts * 2;
    while (nextCap < needed) nextCap *= 2;
    const grow = (old, Ctor, stride) => {
      const n = new Ctor(nextCap * stride);
      n.set(old);
      return n;
    };
    posBuf = grow(posBuf, Float32Array, 3);
    normBuf = grow(normBuf, Int8Array, 3);
    colBuf = grow(colBuf, Uint8Array, 3);
    matBuf = grow(matBuf, Uint8Array, 1);
    const nIdx = new Uint32Array((nextCap >> 2) * 6);
    nIdx.set(idxBuf);
    idxBuf = nIdx;
    capVerts = nextCap;
  }

  function packRGB(r, g, b) {
    const ri = r < 0 ? 0 : (r > 255 ? 255 : (r | 0));
    const gi = g < 0 ? 0 : (g > 255 ? 255 : (g | 0));
    const bi = b < 0 ? 0 : (b > 255 ? 255 : (b | 0));
    return (ri << 16) | (gi << 8) | bi;
  }

  // AO brightness table for 0..3 occluders (crisp Minecraft corner shadows!)
  const AO_MUL = [1.0, 0.89, 0.79, 0.71];

  function buildRegion(rx, rz, tier) {
    // 7-Tier Ultra-Detail Quadtree steps (with CELLS=64):
    // T0=1m (64m/4ch FULL VOXEL!), T1=2m (128m/8ch), T2=4m (256m/16ch), T3=8m (512m/32ch),
    // T4=16m (1km/64ch), T5=32m (2km/128ch), T6=64m (4km/256ch -> 1024-CHUNK HORIZON!)
    const step = 1 << tier;
    const detailLevel = tier === 0 ? 0 : (tier <= 2 ? 1 : (tier === 3 ? 2 : 3));
    const regionBlocks = CELLS * step;
    const ox = rx * regionBlocks;
    const oz = rz * regionBlocks;
    const halfStep = step >> 1;
    // Ultra-far horizon tiers (T4=16m, T5=32m, T6=64m) quantize dry elevation for 90%+ greedy quad compression!
    const yQuant = tier === 4 ? 2 : (tier === 5 ? 3 : (tier >= 6 ? 4 : 1));

    // Pass 1A: Sample 66x66 padded base terrain heights & biomes
    for (let pz = 0; pz < PAD; pz++) {
      const wz = oz + (pz - 1) * step + halfStep;
      const row = pz * PAD;
      for (let px = 0; px < PAD; px++) {
        const wx = ox + (px - 1) * step + halfStep;
        sampleColumnLod(wx, wz, detailLevel);
        const idx = row + px;
        let h = outH;
        if (yQuant > 1 && h >= SEA_LEVEL) {
          h = SEA_LEVEL + (((h - SEA_LEVEL) / yQuant) | 0) * yQuant;
        }
        colBaseH[idx] = h;
        colBiome[idx] = outB;
        colVillage[idx] = 0;
        colStructH[idx] = 0;
      }
    }

    // Pass 1B-Mega: Render Great Pyramids & Grand Citadels on the horizon (Tiers 0..3)!
    if (!isFlat && tier <= 3) {
      const GRID = 68;
      const HALF_GRID = 34;
      const minCxM = Math.floor((ox - step) / CHUNK_SIZE) - 4;
      const maxCxM = Math.floor((ox + regionBlocks + step) / CHUNK_SIZE) + 4;
      const minCzM = Math.floor((oz - step) / CHUNK_SIZE) - 4;
      const maxCzM = Math.floor((oz + regionBlocks + step) / CHUNK_SIZE) + 4;
      const gx0 = Math.floor((minCxM + HALF_GRID) / GRID);
      const gx1 = Math.floor((maxCxM + HALF_GRID) / GRID);
      const gz0 = Math.floor((minCzM + HALF_GRID) / GRID);
      const gz1 = Math.floor((maxCzM + HALF_GRID) / GRID);

      const megaList = [];
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const m = getMegaOriginInGrid(gx, gz);
          if (m) megaList.push({ ...m, isStarter: gx === 0 && gz === 0 });
        }
      }
      // Also include the Starter Mega Castle at (16, -14) when near origin!
      if (minCxM <= 20 && maxCxM >= 16 && minCzM <= -10 && maxCzM >= -14) {
        megaList.push({ type: 2, originCx: 16, originCz: -14, sizeChunks: 4, isStarter: true });
      }

      for (let mi = 0; mi < megaList.length; mi++) {
        const m = megaList[mi];
        const mx0 = m.originCx * CHUNK_SIZE;
        const mz0 = m.originCz * CHUNK_SIZE;
        const spanB = m.sizeChunks * CHUNK_SIZE;
        const mx1 = mx0 + spanB;
        const mz1 = mz0 + spanB;
        if (mx1 < ox - step || mx0 > ox + regionBlocks + step || mz1 < oz - step || mz0 > oz + regionBlocks + step) continue;

        sampleColumnLod(mx0 + (spanB >> 1), mz0 + (spanB >> 1), 0);
        if (m.type === 1 && !m.isStarter && (outH <= SEA_LEVEL - 2 || outH > SEA_LEVEL + 96)) continue;
        if (m.type === 2 && (outH <= SEA_LEVEL - 2 || outH > SEA_LEVEL + 96)) continue;
        const baseY = Math.max(SEA_LEVEL + 4, Math.min(SEA_LEVEL + 86, outH));

        const pxStart = Math.max(0, Math.floor((mx0 - ox) / step) + 1);
        const pxEnd = Math.min(PAD - 1, Math.ceil((mx1 - ox) / step) + 1);
        const pzStart = Math.max(0, Math.floor((mz0 - oz) / step) + 1);
        const pzEnd = Math.min(PAD - 1, Math.ceil((mz1 - oz) / step) + 1);

        for (let pz = pzStart; pz <= pzEnd; pz++) {
          const wz = oz + (pz - 1) * step + halfStep;
          if (wz < mz0 || wz >= mz1) continue;
          const lzM = wz - mz0;
          const row = pz * PAD;
          for (let px = pxStart; px <= pxEnd; px++) {
            const wx = ox + (px - 1) * step + halfStep;
            if (wx < mx0 || wx >= mx1) continue;
            const lxM = wx - mx0;
            const idx = row + px;

            colBaseH[idx] = baseY;
            if (m.type === 1) {
              // Stepped Great Pyramid silhouette with golden apex & royal terracotta bands!
              const dxC = Math.abs(lxM - 31.5);
              const dzC = Math.abs(lzM - 31.5);
              const dist = Math.max(dxC, dzC);
              const pyH = Math.max(0, Math.floor(31.5 - dist));
              colStructH[idx] = pyH;
              if (pyH >= 29 || (Math.abs(dxC - dzC) <= Math.max(1.0, step * 0.6) && pyH >= 3)) {
                colVillage[idx] = 6; // Shimmering Gold Capstone & Corner Ribs!
              } else if (pyH > 0 && (pyH % 6 === 0 || pyH % 6 === 3)) {
                colVillage[idx] = 7; // Royal Terracotta Band
              } else {
                colVillage[idx] = 5; // Monumental Sandstone Step
              }
            } else {
              // Grand Citadel Fortress Walls, Corner Watchtowers & Red-Roof Guilds!
              const inTower = (lxM <= 8 || lxM >= 55) && (lzM <= 8 || lzM >= 55);
              const dxC = Math.abs(lxM - 31.5);
              const dzC = Math.abs(lzM - 31.5);
              const dist = Math.max(dxC, dzC);
              if (inTower) {
                colStructH[idx] = 22;
                colVillage[idx] = 8;
              } else if (dist >= 29.0) {
                colStructH[idx] = 13;
                colVillage[idx] = 8;
              } else if (lxM >= 22 && lxM <= 41 && lzM >= 22 && lzM <= 41) {
                colStructH[idx] = 24;
                colVillage[idx] = 9;
              } else {
                colStructH[idx] = 0;
                colVillage[idx] = 1;
              }
            }
          }
        }
      }
    }

    // Pass 1B: Deterministic Distant Villages & Hilltop Watchtowers on Tier 0 & Tier 1!
    if (!isFlat && tier <= 1) {
      const minCx = Math.floor((ox - step) / CHUNK_SIZE) - 1;
      const maxCx = Math.floor((ox + regionBlocks + step) / CHUNK_SIZE) + 1;
      const minCz = Math.floor((oz - step) / CHUNK_SIZE) - 1;
      const maxCz = Math.floor((oz + regionBlocks + step) / CHUNK_SIZE) + 1;

      for (let vcz = minCz; vcz <= maxCz; vcz++) {
        for (let vcx = minCx; vcx <= maxCx; vcx++) {
          if (isVillageCenter(vcx, vcz)) {
            const centerWx = vcx * CHUNK_SIZE + 8;
            const centerWz = vcz * CHUNK_SIZE + 8;
            sampleColumnLod(centerWx, centerWz, 0);
            const baseY = outH;
            const vBiome = outB;
            if (baseY > SEA_LEVEL + 1 && baseY <= SEA_LEVEL + 82 && vBiome !== 1 && vBiome !== 9) {
              // 3x3 chunk village footprint: [(vcx-1)*16 .. (vcx+2)*16)
              const vx0 = (vcx - 1) * CHUNK_SIZE;
              const vz0 = (vcz - 1) * CHUNK_SIZE;
              const vx1 = (vcx + 2) * CHUNK_SIZE;
              const vz1 = (vcz + 2) * CHUNK_SIZE;

              const pxStart = Math.max(0, Math.floor((vx0 - ox) / step) + 1);
              const pxEnd = Math.min(PAD - 1, Math.ceil((vx1 - ox) / step) + 1);
              const pzStart = Math.max(0, Math.floor((vz0 - oz) / step) + 1);
              const pzEnd = Math.min(PAD - 1, Math.ceil((vz1 - oz) / step) + 1);

              for (let pz = pzStart; pz <= pzEnd; pz++) {
                const wz = oz + (pz - 1) * step + halfStep;
                if (wz < vz0 || wz >= vz1) continue;
                const lzV = wz - vz0; // 0..47 inside 48x48 village
                const row = pz * PAD;
                for (let px = pxStart; px <= pxEnd; px++) {
                  const wx = ox + (px - 1) * step + halfStep;
                  if (wx < vx0 || wx >= vx1) continue;
                  const lxV = wx - vx0; // 0..47
                  const idx = row + px;

                  colBaseH[idx] = baseY;
                  colBiome[idx] = vBiome;

                  // Belltower spire in center-NE quadrant (chunk 0,0 local 10..14, 1..5 -> lxV 26..30, lzV 17..21)
                  if (lxV >= 26 && lxV <= 30 && lzV >= 17 && lzV <= 21) {
                    colVillage[idx] = 3; // Belltower!
                  } else if ((lxV >= 22 && lxV <= 24) || (lzV >= 22 && lzV <= 24)) {
                    colVillage[idx] = 1; // Grand cobblestone/gravel avenue
                  } else {
                    // Authentic village houses clustered in districts around avenues!
                    const dLx = lxV & 15;
                    const dLz = lzV & 15;
                    const inHouse =
                      (dLx >= 2 && dLx <= 6 && dLz >= 2 && dLz <= 7) ||
                      (dLx >= 9 && dLx <= 14 && dLz >= 2 && dLz <= 7) ||
                      (dLx >= 3 && dLx <= 11 && dLz >= 10 && dLz <= 14);
                    colVillage[idx] = inHouse ? 2 : 1;
                  }
                }
              }
            }
          } else if (isWatchtowerChunk(vcx, vcz)) {
            const tx0 = vcx * CHUNK_SIZE + 5;
            const tz0 = vcz * CHUNK_SIZE + 5;
            const tx1 = tx0 + 6;
            const tz1 = tz0 + 6;
            sampleColumnLod(vcx * CHUNK_SIZE + 8, vcz * CHUNK_SIZE + 8, 0);
            const th = outH;
            const tb = outB;
            if (th > SEA_LEVEL + 3 && th < CHUNK_HEIGHT - 18 && tb !== 2) {
              const pxStart = Math.max(0, Math.floor((tx0 - ox) / step) + 1);
              const pxEnd = Math.min(PAD - 1, Math.ceil((tx1 - ox) / step) + 1);
              const pzStart = Math.max(0, Math.floor((tz0 - oz) / step) + 1);
              const pzEnd = Math.min(PAD - 1, Math.ceil((tz1 - oz) / step) + 1);
              for (let pz = pzStart; pz <= pzEnd; pz++) {
                const wz = oz + (pz - 1) * step + halfStep;
                if (wz < tz0 || wz >= tz1) continue;
                const row = pz * PAD;
                for (let px = pxStart; px <= pxEnd; px++) {
                  const wx = ox + (px - 1) * step + halfStep;
                  if (wx < tx0 || wx >= tx1) continue;
                  const idx = row + px;
                  if (colVillage[idx] === 0) {
                    colBaseH[idx] = th;
                    colVillage[idx] = 4; // Hilltop Stone Watchtower!
                  }
                }
              }
            }
          }
        }
      }
    }

    // Pass 1C: Slope-aware Material Classification, Stratified Rock, Organic Clustered Canopies & Mega-Landmarks
    const slopeScale = step <= 1 ? 1.0 : (step === 2 ? 0.65 : (step === 4 ? 0.38 : (step === 8 ? 0.22 : (step === 16 ? 0.14 : 0.10))));
    const canopyDetail = tier <= 1 ? 2 : (tier === 2 ? 1 : 0); // 2=rounded multi-block domes, 1=soft rolling forest canopy, 0=velvety horizon carpet!

    for (let pz = 0; pz < PAD; pz++) {
      const wz = oz + (pz - 1) * step + halfStep;
      const cellZ = Math.floor(wz / step);
      const row = pz * PAD;
      const pzU = pz > 0 ? pz - 1 : 0;
      const pzD = pz < PAD - 1 ? pz + 1 : PAD - 1;

      for (let px = 0; px < PAD; px++) {
        const wx = ox + (px - 1) * step + halfStep;
        const cellX = Math.floor(wx / step);
        const idx = row + px;
        const h = colBaseH[idx];
        const biome = colBiome[idx];
        const vTag = colVillage[idx];

        const pxL = px > 0 ? px - 1 : 0;
        const pxR = px < PAD - 1 ? px + 1 : PAD - 1;
        const hL = colBaseH[row + pxL];
        const hR = colBaseH[row + pxR];
        const hU = colBaseH[pzU * PAD + px];
        const hD = colBaseH[pzD * PAD + px];
        const maxDiff = Math.max(
          Math.abs(h - hL), Math.abs(h - hR),
          Math.abs(h - hU), Math.abs(h - hD)
        );
        const normSlope = maxDiff * slopeScale;

        let yTop = h;
        let topRGB = 0x64a63d;
        let sideRGB = 0x7a593b;
        let mat = MAT_TERRAIN;
        let sMat = MAT_TERRAIN;

        // Landmark overrides (Great Pyramid, Grand Citadel, Villages & Watchtowers!)
        if (vTag !== 0) {
          if (vTag === 6) {
            // Great Pyramid Shimmering Gold Capstone & Royal Corner Ribs!
            yTop = h + colStructH[idx];
            topRGB = packRGB(246, 206, 62);
            sideRGB = packRGB(218, 174, 42);
            mat = MAT_SNOW;
            sMat = MAT_ROCK;
          } else if (vTag === 7) {
            // Great Pyramid Terracotta Royal Trim Band
            yTop = h + colStructH[idx];
            topRGB = packRGB(196, 102, 44);
            sideRGB = packRGB(170, 84, 36);
            mat = MAT_ROCK;
            sMat = MAT_ROCK;
          } else if (vTag === 5) {
            // Great Pyramid Monumental Sandstone Step
            yTop = h + colStructH[idx];
            topRGB = packRGB(222, 204, 146);
            sideRGB = packRGB(202, 184, 128);
            mat = MAT_TERRAIN;
            sMat = MAT_ROCK;
          } else if (vTag === 8) {
            // Grand Citadel Stone-Brick Walls & Watchtowers!
            yTop = h + colStructH[idx];
            topRGB = packRGB(132, 138, 146);
            sideRGB = packRGB(112, 118, 126);
            mat = MAT_ROCK;
            sMat = MAT_ROCK;
          } else if (vTag === 9) {
            // Grand Citadel Brick Guild Roofs
            yTop = h + colStructH[idx];
            topRGB = packRGB(166, 78, 58);
            sideRGB = packRGB(176, 144, 100);
            mat = MAT_TERRAIN;
            sMat = MAT_TERRAIN;
          } else if (vTag === 4) {
            // Stone-brick Watchtower Keep!
            yTop = h + 10;
            topRGB = packRGB(134, 138, 144);
            sideRGB = packRGB(116, 120, 126);
            mat = MAT_ROCK;
            sMat = MAT_ROCK;
          } else if (vTag === 3) {
            // Village Belltower Spire!
            yTop = h + 12;
            topRGB = biome === 2 ? packRGB(218, 198, 138) : (biome === 3 ? packRGB(112, 82, 54) : packRGB(178, 88, 66));
            sideRGB = biome === 2 ? packRGB(204, 184, 126) : packRGB(152, 134, 108);
            mat = MAT_TERRAIN;
            sMat = MAT_ROCK;
          } else if (vTag === 2) {
            // Village House Pitched Roof!
            yTop = h + 5;
            if (biome === 2) {
              topRGB = packRGB(218, 198, 140);
              sideRGB = packRGB(202, 182, 124);
            } else if (biome === 3) {
              topRGB = packRGB(108, 78, 52);
              sideRGB = packRGB(128, 98, 68);
            } else {
              topRGB = packRGB(168, 82, 62); // Warm terracotta brick roof!
              sideRGB = packRGB(178, 146, 102); // Oak plank walls!
            }
            mat = MAT_TERRAIN;
            sMat = MAT_TERRAIN;
          } else {
            // Village Avenue / Courtyard
            topRGB = biome === 2 ? packRGB(214, 196, 136) : packRGB(154, 152, 144);
            sideRGB = packRGB(128, 124, 118);
            mat = MAT_TERRAIN;
            sMat = MAT_ROCK;
          }
        } else if (!isFlat && h < SEA_LEVEL) {
          // Ocean, Lake, or River Water!
          yTop = SEA_LEVEL;
          if (biome === 3) {
            // Frozen Snowy Taiga Ice
            topRGB = packRGB(176, 220, 250);
            sideRGB = packRGB(142, 188, 224);
            mat = MAT_SNOW;
            sMat = MAT_SNOW;
          } else {
            // Quantized 5-band water depth -> smooth tropical shallows to deep sapphire + ultra-greedy merging!
            const depth = SEA_LEVEL - h;
            const band = depth <= 2 ? 0 : (depth <= 5 ? 1 : (depth <= 9 ? 2 : (depth <= 14 ? 3 : 4)));
            const wr = 38 - band * 6;
            const wg = 142 - band * 17;
            const wb = 198 - band * 14;
            topRGB = packRGB(wr, wg, wb);
            sideRGB = packRGB(wr * 0.82, wg * 0.84, wb * 0.90);
            mat = MAT_WATER;
            sMat = MAT_WATER;
          }
        } else if (biome === 8) {
          // Badlands / Mesa — stratified terracotta canyon bands & red sand floor!
          if (h <= SEA_LEVEL + 6) {
            topRGB = packRGB(204, 102, 52);
            sideRGB = packRGB(178, 86, 42);
          } else {
            const band = h & 7;
            if (band === 1 || band === 6) topRGB = packRGB(190, 96, 44);
            else if (band === 3 || band === 7) topRGB = packRGB(156, 62, 48);
            else if (band === 4) topRGB = packRGB(202, 146, 44);
            else topRGB = packRGB(160, 102, 74);
            sideRGB = packRGB(152, 82, 54);
          }
          mat = MAT_ROCK;
          sMat = MAT_ROCK;
        } else if (biome === 2) {
          // Desert — clean golden sand dunes & sandstone cliffs + occasional cactus on Tier 0
          const bh = coordHash(cellX, cellZ, seed + 713);
          if (tier === 0 && !isFlat && h > SEA_LEVEL + 2 && normSlope < 1.2 && bh > 0.988) {
            yTop = h + 3;
            topRGB = packRGB(52, 136, 54);
            sideRGB = packRGB(44, 116, 46);
            mat = MAT_FOLIAGE;
            sMat = MAT_FOLIAGE;
          } else {
            const dune = (h & 3) === 0 ? 1.0 : 0.97;
            topRGB = packRGB(220 * dune, 202 * dune, 142 * dune);
            sideRGB = packRGB(198, 180, 124);
            mat = MAT_TERRAIN;
            sMat = MAT_TERRAIN;
          }
        } else if (!isFlat && h <= SEA_LEVEL + 1) {
          // Shoreline: mud in swamp, gravel in mountains, warm sand beach elsewhere
          if (biome === 9) {
            topRGB = packRGB(68, 64, 68);
            sideRGB = packRGB(54, 50, 54);
            mat = MAT_TERRAIN;
            sMat = MAT_TERRAIN;
          } else if (biome === 1 && normSlope >= 1.2) {
            topRGB = packRGB(144, 146, 152);
            sideRGB = packRGB(122, 124, 130);
            mat = MAT_ROCK;
            sMat = MAT_ROCK;
          } else {
            topRGB = packRGB(216, 200, 144);
            sideRGB = packRGB(192, 176, 126);
            mat = MAT_TERRAIN;
            sMat = MAT_TERRAIN;
          }
        } else if (!isFlat && h >= SNOW_LINE + 26 && normSlope >= 1.5) {
          // Glacial Packed-Ice Alpine Ridges!
          topRGB = packRGB(152, 202, 240);
          sideRGB = packRGB(124, 174, 216);
          mat = MAT_SNOW;
          sMat = MAT_SNOW;
        } else if (!isFlat && ((normSlope >= 2.2 && h > SEA_LEVEL + 6) || (h >= ROCK_LINE && h < SNOW_LINE && normSlope >= 1.35))) {
          // Steep Exposed Granite & Gravel Alpine Cliffs
          const rockVar = h >= ROCK_LINE + 8 ? 1.05 : 0.98;
          topRGB = packRGB(132 * rockVar, 136 * rockVar, 144 * rockVar);
          sideRGB = packRGB(116 * rockVar, 120 * rockVar, 128 * rockVar);
          mat = MAT_ROCK;
          sMat = MAT_ROCK;
        } else if (h >= SNOW_LINE || (biome === 3 && h >= SEA_LEVEL + 2)) {
          // Alpine Snow Peaks & Organic Clustered Snowy Taiga Conifers!
          if (biome === 3 && h < SNOW_LINE - 2 && normSlope < 1.9 && canopyDetail > 0) {
            const cVal = noise2D(permM, wx * 0.14, wz * 0.14) + (canopyDetail === 2 ? noise2D(permB, wx * 0.30, wz * 0.30) * 0.45 : 0);
            if (cVal > 0.11) {
              const crownH = canopyDetail === 2 ? (3 + Math.min(4, ((cVal - 0.11) * 14) | 0)) : (2 + Math.min(2, ((cVal - 0.11) * 7) | 0));
              yTop = h + crownH;
              const snowTip = cVal > 0.34;
              topRGB = snowTip ? packRGB(192, 218, 224) : packRGB(42, 86, 56);
              sideRGB = packRGB(32, 68, 44);
              mat = snowTip ? MAT_SNOW : MAT_FOLIAGE;
              sMat = MAT_FOLIAGE;
            } else {
              topRGB = packRGB(238, 244, 252);
              sideRGB = packRGB(132, 138, 146);
              mat = MAT_SNOW;
              sMat = MAT_ROCK;
            }
          } else if (biome === 3 && h < SNOW_LINE - 4) {
            const cFar = noise2D(permM, wx * 0.045, wz * 0.045);
            topRGB = cFar > 0.05 ? packRGB(78, 120, 106) : packRGB(186, 206, 214);
            sideRGB = packRGB(96, 114, 118);
            mat = cFar > 0.05 ? MAT_FOLIAGE : MAT_SNOW;
            sMat = MAT_ROCK;
          } else {
            topRGB = packRGB(240, 246, 255);
            sideRGB = packRGB(134, 139, 148);
            mat = MAT_SNOW;
            sMat = MAT_ROCK;
          }
        } else if (h >= ROCK_LINE) {
          topRGB = packRGB(136, 140, 148);
          sideRGB = packRGB(118, 122, 130);
          mat = MAT_ROCK;
          sMat = MAT_ROCK;
        } else if (biome === 6) {
          // Warm Golden-Olive Savanna with organic flat-topped Acacia clusters!
          const cVal = canopyDetail > 0 ? (noise2D(permM, wx * 0.125, wz * 0.125) + (canopyDetail === 2 ? noise2D(permB, wx * 0.28, wz * 0.28) * 0.42 : 0)) : -1;
          if (canopyDetail > 0 && normSlope < 1.8 && cVal > 0.24) {
            yTop = h + (canopyDetail === 2 ? 4 + (cVal > 0.36 ? 1 : 0) : 2);
            topRGB = packRGB(122, 144, 46);
            sideRGB = packRGB(96, 114, 36);
            mat = MAT_FOLIAGE;
            sMat = MAT_FOLIAGE;
          } else {
            const tone = noise2D(permB, wx * 0.022, wz * 0.022) > 0.08 ? 1.03 : 0.97;
            topRGB = packRGB(154 * tone, 158 * tone, 66 * tone);
            sideRGB = packRGB(126, 94, 58);
            mat = MAT_TERRAIN;
            sMat = MAT_TERRAIN;
          }
        } else if (biome === 7) {
          // Deep Lush Emerald Jungle with multi-layered rolling rainforest canopy!
          const cVal = canopyDetail > 0 ? (noise2D(permM, wx * 0.12, wz * 0.12) + (canopyDetail === 2 ? noise2D(permB, wx * 0.26, wz * 0.26) * 0.45 : 0)) : -1;
          if (canopyDetail > 0 && normSlope < 2.2 && cVal > -0.02) {
            const crownH = canopyDetail === 2 ? (4 + Math.min(5, ((cVal + 0.02) * 14) | 0)) : (2 + Math.min(3, ((cVal + 0.02) * 7) | 0));
            yTop = h + crownH;
            topRGB = cVal > 0.24 ? packRGB(52, 162, 48) : packRGB(38, 138, 40);
            sideRGB = packRGB(28, 108, 30);
            mat = MAT_FOLIAGE;
            sMat = MAT_FOLIAGE;
          } else {
            topRGB = packRGB(46, 150, 48);
            sideRGB = packRGB(96, 76, 48);
            mat = canopyDetail === 0 ? MAT_FOLIAGE : MAT_TERRAIN;
            sMat = MAT_TERRAIN;
          }
        } else if (biome === 9) {
          // Murky Wetland Swamp with organic drooping mossy canopies!
          const cVal = canopyDetail > 0 ? noise2D(permM, wx * 0.14, wz * 0.14) : -1;
          if (canopyDetail > 0 && normSlope < 1.6 && cVal > 0.16) {
            yTop = h + (canopyDetail === 2 ? 4 : 2);
            topRGB = packRGB(62, 94, 44);
            sideRGB = packRGB(48, 72, 34);
            mat = MAT_FOLIAGE;
            sMat = MAT_FOLIAGE;
          } else {
            topRGB = packRGB(84, 108, 62);
            sideRGB = packRGB(66, 62, 64);
            mat = MAT_TERRAIN;
            sMat = MAT_TERRAIN;
          }
        } else if (biome === 10) {
          // Cherry Grove with lush rounded pink sakura blossom canopies!
          const cVal = canopyDetail > 0 ? (noise2D(permM, wx * 0.135, wz * 0.135) + (canopyDetail === 2 ? noise2D(permB, wx * 0.29, wz * 0.29) * 0.42 : 0)) : -1;
          if (canopyDetail > 0 && normSlope < 2.0 && cVal > 0.11) {
            const crownH = canopyDetail === 2 ? (3 + Math.min(3, ((cVal - 0.11) * 12) | 0)) : 2;
            yTop = h + crownH;
            topRGB = cVal > 0.28 ? packRGB(252, 184, 212) : packRGB(238, 154, 188);
            sideRGB = packRGB(214, 122, 160);
            mat = MAT_FOLIAGE;
            sMat = MAT_FOLIAGE;
          } else if (canopyDetail === 0) {
            const blossom = noise2D(permM, wx * 0.04, wz * 0.04) > 0.04;
            topRGB = blossom ? packRGB(236, 158, 190) : packRGB(112, 174, 74);
            sideRGB = packRGB(122, 92, 62);
            mat = blossom ? MAT_FOLIAGE : MAT_TERRAIN;
            sMat = MAT_TERRAIN;
          } else {
            topRGB = packRGB(108, 174, 72);
            sideRGB = packRGB(122, 92, 62);
            mat = MAT_TERRAIN;
            sMat = MAT_TERRAIN;
          }
        } else if (biome === 4) {
          // Lush Oak Forest with organic rounded tree crowns & subtle birch clusters!
          if (canopyDetail === 0) {
            const cFar = noise2D(permM, wx * 0.04, wz * 0.04);
            if (tier === 3 && cFar > 0.06 && normSlope < 1.8) yTop = h + 1;
            topRGB = cFar > 0.10 ? packRGB(52, 124, 40) : packRGB(68, 138, 48);
            sideRGB = packRGB(76, 94, 52);
            mat = MAT_FOLIAGE;
            sMat = MAT_TERRAIN;
          } else {
            const cVal = noise2D(permM, wx * 0.14, wz * 0.14) + (canopyDetail === 2 ? noise2D(permB, wx * 0.29, wz * 0.29) * 0.45 : 0);
            if (normSlope < 2.0 && cVal > 0.06) {
              const isBirch = noise2D(permB, wx * 0.075 + 41, wz * 0.075 - 29) > 0.22;
              const crownH = canopyDetail === 2 ? (3 + Math.min(3, ((cVal - 0.06) * 11) | 0)) : (2 + (cVal > 0.24 ? 1 : 0));
              yTop = h + crownH;
              if (isBirch) {
                topRGB = packRGB(86, 152, 58);
                sideRGB = packRGB(68, 124, 46);
              } else {
                topRGB = cVal > 0.26 ? packRGB(46, 118, 36) : packRGB(58, 134, 44);
                sideRGB = packRGB(40, 98, 32);
              }
              mat = MAT_FOLIAGE;
              sMat = MAT_FOLIAGE;
            } else {
              topRGB = packRGB(84, 148, 56);
              sideRGB = packRGB(118, 86, 58);
              mat = MAT_TERRAIN;
              sMat = MAT_TERRAIN;
            }
          }
        } else if (biome === 5) {
          // Bright Birch Forest with airy rounded crowns!
          if (canopyDetail === 0) {
            const cFar = noise2D(permM, wx * 0.04, wz * 0.04);
            if (tier === 3 && cFar > 0.08 && normSlope < 1.8) yTop = h + 1;
            topRGB = cFar > 0.08 ? packRGB(88, 154, 60) : packRGB(98, 160, 66);
            sideRGB = packRGB(96, 108, 60);
            mat = MAT_FOLIAGE;
            sMat = MAT_TERRAIN;
          } else {
            const cVal = noise2D(permM, wx * 0.14, wz * 0.14) + (canopyDetail === 2 ? noise2D(permB, wx * 0.29, wz * 0.29) * 0.45 : 0);
            if (normSlope < 2.0 && cVal > 0.10) {
              const crownH = canopyDetail === 2 ? (3 + Math.min(3, ((cVal - 0.10) * 11) | 0)) : 2;
              yTop = h + crownH;
              topRGB = cVal > 0.28 ? packRGB(96, 162, 64) : packRGB(84, 148, 56);
              sideRGB = packRGB(70, 124, 46);
              mat = MAT_FOLIAGE;
              sMat = MAT_FOLIAGE;
            } else {
              topRGB = packRGB(98, 158, 66);
              sideRGB = packRGB(122, 90, 60);
              mat = MAT_TERRAIN;
              sMat = MAT_TERRAIN;
            }
          }
        } else {
          // Sunlit Plains (with organic meadow grass gradients & occasional cozy oak groves!)
          const cVal = (!isFlat && canopyDetail === 2) ? (noise2D(permM, wx * 0.115, wz * 0.115) + noise2D(permB, wx * 0.26, wz * 0.26) * 0.4) : -1;
          if (!isFlat && canopyDetail === 2 && normSlope < 1.8 && cVal > 0.34) {
            yTop = h + 3 + (cVal > 0.44 ? 1 : 0);
            topRGB = packRGB(56, 126, 42);
            sideRGB = packRGB(44, 102, 34);
            mat = MAT_FOLIAGE;
            sMat = MAT_FOLIAGE;
          } else {
            // Subtle 3-band sunlit meadow grass warmth (preserves greedy meshing!)
            const mN = noise2D(permB, wx * 0.018, wz * 0.018);
            topRGB = mN > 0.12 ? packRGB(108, 172, 64) : (mN < -0.12 ? packRGB(94, 156, 58) : packRGB(102, 166, 62));
            sideRGB = packRGB(122, 90, 58);
            mat = MAT_TERRAIN;
            sMat = MAT_TERRAIN;
          }
        }

        colTopY[idx] = yTop;
        colTopRGB[idx] = topRGB;
        colSideRGB[idx] = sideRGB;
        colMat[idx] = mat;
        colSideMat[idx] = sMat;
      }
    }

    // Pass 1D: Precompute per-cell 4-corner Voxel Ambient Occlusion (Tiers 0-2 only; skipping sub-pixel AO on T3-T5 triples greedy merging!)
    if (tier >= 3) {
      topAO.fill(0);
    } else {
      for (let gz = 0; gz < CELLS; gz++) {
        const pz = gz + 1;
        const pRow = pz * PAD;
        const gRow = gz * CELLS;
        for (let gx = 0; gx < CELLS; gx++) {
          const px = gx + 1;
          const ci = pRow + px;
          const y = colTopY[ci];
          const m = colMat[ci];

          // Water stays crisp & mirror-flat with zero corner darkening!
          if (m === MAT_WATER) {
            topAO[gRow + gx] = 0;
            continue;
          }

          const nW = colTopY[ci - 1] > y ? 1 : 0;
          const nE = colTopY[ci + 1] > y ? 1 : 0;
          const nN = colTopY[ci - PAD] > y ? 1 : 0;
          const nS = colTopY[ci + PAD] > y ? 1 : 0;
          const nNW = colTopY[ci - PAD - 1] > y ? 1 : 0;
          const nNE = colTopY[ci - PAD + 1] > y ? 1 : 0;
          const nSW = colTopY[ci + PAD - 1] > y ? 1 : 0;
          const nSE = colTopY[ci + PAD + 1] > y ? 1 : 0;

          // 4 corners matching top quad winding: (x0,z1)=SW, (x1,z1)=SE, (x1,z0)=NE, (x0,z0)=NW
          const cSW = (nW && nS) ? 3 : (nW + nS + nSW);
          const cSE = (nE && nS) ? 3 : (nE + nS + nSE);
          const cNE = (nE && nN) ? 3 : (nE + nN + nNE);
          const cNW = (nW && nN) ? 3 : (nW + nN + nNW);

          topAO[gRow + gx] = cSW | (cSE << 2) | (cNE << 4) | (cNW << 6);
        }
      }
    }

    let vCount = 0;
    let iCount = 0;

    function pushQuad(
      x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3,
      nx, ny, nz, rgb, matFlag,
      ao0, ao1, ao2, ao3
    ) {
      ensureVerts(vCount + 4);
      const base = vCount;
      const p = base * 3;
      const pos = posBuf, norm = normBuf, col = colBuf, mat = matBuf;

      pos[p] = x0; pos[p + 1] = y0; pos[p + 2] = z0;
      pos[p + 3] = x1; pos[p + 4] = y1; pos[p + 5] = z1;
      pos[p + 6] = x2; pos[p + 7] = y2; pos[p + 8] = z2;
      pos[p + 9] = x3; pos[p + 10] = y3; pos[p + 11] = z3;

      const bnx = (nx * 127) | 0;
      const bny = (ny * 127) | 0;
      const bnz = (nz * 127) | 0;
      norm[p] = bnx; norm[p + 1] = bny; norm[p + 2] = bnz;
      norm[p + 3] = bnx; norm[p + 4] = bny; norm[p + 5] = bnz;
      norm[p + 6] = bnx; norm[p + 7] = bny; norm[p + 8] = bnz;
      norm[p + 9] = bnx; norm[p + 10] = bny; norm[p + 11] = bnz;

      const r = (rgb >>> 16) & 255;
      const g = (rgb >>> 8) & 255;
      const b = rgb & 255;

      col[p] = (r * ao0) | 0; col[p + 1] = (g * ao0) | 0; col[p + 2] = (b * ao0) | 0;
      col[p + 3] = (r * ao1) | 0; col[p + 4] = (g * ao1) | 0; col[p + 5] = (b * ao1) | 0;
      col[p + 6] = (r * ao2) | 0; col[p + 7] = (g * ao2) | 0; col[p + 8] = (b * ao2) | 0;
      col[p + 9] = (r * ao3) | 0; col[p + 10] = (g * ao3) | 0; col[p + 11] = (b * ao3) | 0;

      mat[base] = matFlag;
      mat[base + 1] = matFlag;
      mat[base + 2] = matFlag;
      mat[base + 3] = matFlag;

      const idx = idxBuf;
      // Anisotropy-free AO diagonal flip (prevents corner shadow shading artifacts!)
      if (ao0 + ao2 < ao1 + ao3) {
        idx[iCount] = base + 1; idx[iCount + 1] = base + 2; idx[iCount + 2] = base + 3;
        idx[iCount + 3] = base + 1; idx[iCount + 4] = base + 3; idx[iCount + 5] = base;
      } else {
        idx[iCount] = base; idx[iCount + 1] = base + 1; idx[iCount + 2] = base + 2;
        idx[iCount + 3] = base; idx[iCount + 4] = base + 2; idx[iCount + 5] = base + 3;
      }
      vCount = base + 4;
      iCount += 6;
    }

    // Pass 2A: 2D GREEDY MESHING for Top Faces (+Y) -> 60% to 85% fewer vertices!
    topVisited.fill(0);
    for (let gz = 0; gz < CELLS; gz++) {
      const gRow = gz * CELLS;
      const pRow = (gz + 1) * PAD;
      for (let gx = 0; gx < CELLS; gx++) {
        const gIdx = gRow + gx;
        if (topVisited[gIdx]) continue;

        const ci = pRow + (gx + 1);
        const yTop = colTopY[ci];
        const rgb = colTopRGB[ci];
        const mat = colMat[ci];
        const aoPack = topAO[gIdx];

        // Only greedy-expand across X when corner AO matches cleanly
        const aoSW = aoPack & 3;
        const aoSE = (aoPack >>> 2) & 3;
        const aoNE = (aoPack >>> 4) & 3;
        const aoNW = (aoPack >>> 6) & 3;
        const canMergeX = (aoSW === aoSE) && (aoNW === aoNE);
        const canMergeZ = (aoSW === aoNW) && (aoSE === aoNE);

        let w = 1;
        if (canMergeX) {
          while (gx + w < CELLS) {
            const ngIdx = gRow + gx + w;
            if (topVisited[ngIdx]) break;
            const nci = ci + w;
            if (colTopY[nci] !== yTop || colTopRGB[nci] !== rgb || colMat[nci] !== mat || topAO[ngIdx] !== aoPack) break;
            w++;
          }
        }

        let h = 1;
        if (canMergeZ) {
          outerZ: while (gz + h < CELLS) {
            const nextGRow = (gz + h) * CELLS;
            const nextPRow = (gz + h + 1) * PAD;
            for (let dx = 0; dx < w; dx++) {
              const ngIdx = nextGRow + gx + dx;
              if (topVisited[ngIdx]) break outerZ;
              const nci = nextPRow + (gx + dx + 1);
              if (colTopY[nci] !== yTop || colTopRGB[nci] !== rgb || colMat[nci] !== mat || topAO[ngIdx] !== aoPack) break outerZ;
            }
            h++;
          }
        }

        for (let dz = 0; dz < h; dz++) {
          const vRow = (gz + dz) * CELLS + gx;
          for (let dx = 0; dx < w; dx++) topVisited[vRow + dx] = 1;
        }

        const wx0 = ox + gx * step;
        const wx1 = wx0 + w * step;
        const wz0 = oz + gz * step;
        const wz1 = wz0 + h * step;
        const yDraw = yTop + 1.0;

        pushQuad(
          wx0, yDraw, wz1,
          wx1, yDraw, wz1,
          wx1, yDraw, wz0,
          wx0, yDraw, wz0,
          0, 1, 0, rgb, mat,
          AO_MUL[aoSW], AO_MUL[aoSE], AO_MUL[aoNE], AO_MUL[aoNW]
        );
      }
    }

    // Pass 2B: 1D Horizontal GREEDY MESHING for Vertical Cliff / Block Sides (+X, -X, +Z, -Z) + Boundary Skirts!
    // Helper computes cliff RGB & matFlag (tall cliffs >=4 blocks expose granite stone rock!)
    const skirtDrop = Math.min(18, Math.max(2, step >> 1));
    const STONE_RGB = packRGB(126, 131, 139);

    // 1) +X and -X faces: sweep along Z for each gx column (merges consecutive Z strips!)
    for (let gx = 0; gx < CELLS; gx++) {
      const px = gx + 1;
      const wx0 = ox + gx * step;
      const wx1 = wx0 + step;
      const isEastBorder = gx === CELLS - 1;
      const isWestBorder = gx === 0;

      // +X (East) strip merge
      let gz = 0;
      while (gz < CELLS) {
        const ci = (gz + 1) * PAD + px;
        const yTop = colTopY[ci];
        let yNeigh = colTopY[ci + 1];
        if (isEastBorder && colMat[ci] !== MAT_WATER) {
          yNeigh = Math.min(yNeigh, yTop - skirtDrop);
        }
        if (yTop <= yNeigh) { gz++; continue; }

        const drop = yTop - yNeigh;
        const isStoneCliff = drop >= 4 && colBaseH[ci] > SEA_LEVEL + 3 && yTop === colBaseH[ci] && colVillage[ci] === 0 && colBiome[ci] !== 2;
        const sRgb = isStoneCliff ? STONE_RGB : colSideRGB[ci];
        const sMat = isStoneCliff ? MAT_ROCK : colSideMat[ci];

        let len = 1;
        while (gz + len < CELLS) {
          const nci = (gz + len + 1) * PAD + px;
          const nyTop = colTopY[nci];
          let nyNeigh = colTopY[nci + 1];
          if (isEastBorder && colMat[nci] !== MAT_WATER) {
            nyNeigh = Math.min(nyNeigh, nyTop - skirtDrop);
          }
          if (nyTop !== yTop || nyNeigh !== yNeigh) break;
          const nDrop = nyTop - nyNeigh;
          const nStone = nDrop >= 4 && colBaseH[nci] > SEA_LEVEL + 3 && nyTop === colBaseH[nci] && colVillage[nci] === 0 && colBiome[nci] !== 2;
          const nRgb = nStone ? STONE_RGB : colSideRGB[nci];
          const nMat = nStone ? MAT_ROCK : colSideMat[nci];
          if (nRgb !== sRgb || nMat !== sMat) break;
          len++;
        }

        const wz0 = oz + gz * step;
        const wz1 = wz0 + len * step;
        const yBot = yNeigh + 1.0;
        const yDraw = yTop + 1.0;
        // East face directional shade (0.90) + subtle bottom crevice AO (0.76)
        const topSh = 0.90;
        const botSh = sMat === MAT_WATER ? 0.86 : 0.77;
        pushQuad(
          wx1, yBot, wz1,
          wx1, yBot, wz0,
          wx1, yDraw, wz0,
          wx1, yDraw, wz1,
          1, 0, 0, sRgb, sMat,
          botSh, botSh, topSh, topSh
        );
        gz += len;
      }

      // -X (West) strip merge
      gz = 0;
      while (gz < CELLS) {
        const ci = (gz + 1) * PAD + px;
        const yTop = colTopY[ci];
        let yNeigh = colTopY[ci - 1];
        if (isWestBorder && colMat[ci] !== MAT_WATER) {
          yNeigh = Math.min(yNeigh, yTop - skirtDrop);
        }
        if (yTop <= yNeigh) { gz++; continue; }

        const drop = yTop - yNeigh;
        const isStoneCliff = drop >= 4 && colBaseH[ci] > SEA_LEVEL + 3 && yTop === colBaseH[ci] && colVillage[ci] === 0 && colBiome[ci] !== 2;
        const sRgb = isStoneCliff ? STONE_RGB : colSideRGB[ci];
        const sMat = isStoneCliff ? MAT_ROCK : colSideMat[ci];

        let len = 1;
        while (gz + len < CELLS) {
          const nci = (gz + len + 1) * PAD + px;
          const nyTop = colTopY[nci];
          let nyNeigh = colTopY[nci - 1];
          if (isWestBorder && colMat[nci] !== MAT_WATER) {
            nyNeigh = Math.min(nyNeigh, nyTop - skirtDrop);
          }
          if (nyTop !== yTop || nyNeigh !== yNeigh) break;
          const nDrop = nyTop - nyNeigh;
          const nStone = nDrop >= 4 && colBaseH[nci] > SEA_LEVEL + 3 && nyTop === colBaseH[nci] && colVillage[nci] === 0 && colBiome[nci] !== 2;
          const nRgb = nStone ? STONE_RGB : colSideRGB[nci];
          const nMat = nStone ? MAT_ROCK : colSideMat[nci];
          if (nRgb !== sRgb || nMat !== sMat) break;
          len++;
        }

        const wz0 = oz + gz * step;
        const wz1 = wz0 + len * step;
        const yBot = yNeigh + 1.0;
        const yDraw = yTop + 1.0;
        const topSh = 0.90;
        const botSh = sMat === MAT_WATER ? 0.86 : 0.77;
        pushQuad(
          wx0, yBot, wz0,
          wx0, yBot, wz1,
          wx0, yDraw, wz1,
          wx0, yDraw, wz0,
          -1, 0, 0, sRgb, sMat,
          botSh, botSh, topSh, topSh
        );
        gz += len;
      }
    }

    // 2) +Z and -Z faces: sweep along X for each gz row (merges consecutive X strips!)
    for (let gz = 0; gz < CELLS; gz++) {
      const pz = gz + 1;
      const pRow = pz * PAD;
      const wz0 = oz + gz * step;
      const wz1 = wz0 + step;
      const isSouthBorder = gz === CELLS - 1;
      const isNorthBorder = gz === 0;

      // +Z (South) strip merge
      let gx = 0;
      while (gx < CELLS) {
        const ci = pRow + (gx + 1);
        const yTop = colTopY[ci];
        let yNeigh = colTopY[ci + PAD];
        if (isSouthBorder && colMat[ci] !== MAT_WATER) {
          yNeigh = Math.min(yNeigh, yTop - skirtDrop);
        }
        if (yTop <= yNeigh) { gx++; continue; }

        const drop = yTop - yNeigh;
        const isStoneCliff = drop >= 4 && colBaseH[ci] > SEA_LEVEL + 3 && yTop === colBaseH[ci] && colVillage[ci] === 0 && colBiome[ci] !== 2;
        const sRgb = isStoneCliff ? STONE_RGB : colSideRGB[ci];
        const sMat = isStoneCliff ? MAT_ROCK : colSideMat[ci];

        let len = 1;
        while (gx + len < CELLS) {
          const nci = pRow + (gx + len + 1);
          const nyTop = colTopY[nci];
          let nyNeigh = colTopY[nci + PAD];
          if (isSouthBorder && colMat[nci] !== MAT_WATER) {
            nyNeigh = Math.min(nyNeigh, nyTop - skirtDrop);
          }
          if (nyTop !== yTop || nyNeigh !== yNeigh) break;
          const nDrop = nyTop - nyNeigh;
          const nStone = nDrop >= 4 && colBaseH[nci] > SEA_LEVEL + 3 && nyTop === colBaseH[nci] && colVillage[nci] === 0 && colBiome[nci] !== 2;
          const nRgb = nStone ? STONE_RGB : colSideRGB[nci];
          const nMat = nStone ? MAT_ROCK : colSideMat[nci];
          if (nRgb !== sRgb || nMat !== sMat) break;
          len++;
        }

        const wx0 = ox + gx * step;
        const wx1 = wx0 + len * step;
        const yBot = yNeigh + 1.0;
        const yDraw = yTop + 1.0;
        const topSh = 0.83;
        const botSh = sMat === MAT_WATER ? 0.79 : 0.71;
        pushQuad(
          wx0, yBot, wz1,
          wx1, yBot, wz1,
          wx1, yDraw, wz1,
          wx0, yDraw, wz1,
          0, 0, 1, sRgb, sMat,
          botSh, botSh, topSh, topSh
        );
        gx += len;
      }

      // -Z (North) strip merge
      gx = 0;
      while (gx < CELLS) {
        const ci = pRow + (gx + 1);
        const yTop = colTopY[ci];
        let yNeigh = colTopY[ci - PAD];
        if (isNorthBorder && colMat[ci] !== MAT_WATER) {
          yNeigh = Math.min(yNeigh, yTop - skirtDrop);
        }
        if (yTop <= yNeigh) { gx++; continue; }

        const drop = yTop - yNeigh;
        const isStoneCliff = drop >= 4 && colBaseH[ci] > SEA_LEVEL + 3 && yTop === colBaseH[ci] && colVillage[ci] === 0 && colBiome[ci] !== 2;
        const sRgb = isStoneCliff ? STONE_RGB : colSideRGB[ci];
        const sMat = isStoneCliff ? MAT_ROCK : colSideMat[ci];

        let len = 1;
        while (gx + len < CELLS) {
          const nci = pRow + (gx + len + 1);
          const nyTop = colTopY[nci];
          let nyNeigh = colTopY[nci - PAD];
          if (isNorthBorder && colMat[nci] !== MAT_WATER) {
            nyNeigh = Math.min(nyNeigh, nyTop - skirtDrop);
          }
          if (nyTop !== yTop || nyNeigh !== yNeigh) break;
          const nDrop = nyTop - nyNeigh;
          const nStone = nDrop >= 4 && colBaseH[nci] > SEA_LEVEL + 3 && nyTop === colBaseH[nci] && colVillage[nci] === 0 && colBiome[nci] !== 2;
          const nRgb = nStone ? STONE_RGB : colSideRGB[nci];
          const nMat = nStone ? MAT_ROCK : colSideMat[nci];
          if (nRgb !== sRgb || nMat !== sMat) break;
          len++;
        }

        const wx0 = ox + gx * step;
        const wx1 = wx0 + len * step;
        const yBot = yNeigh + 1.0;
        const yDraw = yTop + 1.0;
        const topSh = 0.83;
        const botSh = sMat === MAT_WATER ? 0.79 : 0.71;
        pushQuad(
          wx1, yBot, wz0,
          wx0, yBot, wz0,
          wx0, yDraw, wz0,
          wx1, yDraw, wz0,
          0, 0, -1, sRgb, sMat,
          botSh, botSh, topSh, topSh
        );
        gx += len;
      }
    }

    // Slice exact compact buffers (16-bit indices whenever vCount < 65536 for 2x faster GPU index fetch!)
    const pos = posBuf.slice(0, vCount * 3);
    const norm = normBuf.slice(0, vCount * 3);
    const col = colBuf.slice(0, vCount * 3);
    const mat = matBuf.slice(0, vCount);
    const idx = vCount < 65536
      ? new Uint16Array(idxBuf.subarray(0, iCount))
      : idxBuf.slice(0, iCount);

    return { pos, norm, col, mat, idx, vCount, iCount };
  }

  return { buildRegion };
}

// Multi-threaded inline-Blob Web Worker Pool for zero-stutter off-thread LOD generation!
export class LodWorkerPool {
  constructor(seed, worldType, maxWorkers = 3) {
    this.seed = seed;
    this.worldType = worldType;
    this.workers = [];
    this.idleWorkers = [];
    this.pending = []; // queued jobs when all workers busy
    this.inFlight = new Set(); // active keys currently being built
    this.readyResults = []; // completed buffers waiting to be mounted on main thread
    this.disposed = false;
    this._blobUrl = null;
    this._fallbackKernel = null;
    this.useWorkers = false;

    this._initWorkers(maxWorkers);
  }

  _initWorkers(maxWorkers) {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
      this._fallbackKernel = createLodKernel(this.seed, this.worldType);
      return;
    }

    try {
      const workerCode = `
        const createLodKernel = ${createLodKernel.toString()};
        let kernel = null;
        self.onmessage = function(e) {
          const msg = e.data;
          if (msg.type === 'init') {
            kernel = createLodKernel(msg.seed, msg.worldType);
            return;
          }
          if (msg.type === 'build' && kernel) {
            const res = kernel.buildRegion(msg.rx, msg.rz, msg.tier);
            self.postMessage({
              key: msg.key,
              rx: msg.rx,
              rz: msg.rz,
              tier: msg.tier,
              pos: res.pos,
              norm: res.norm,
              col: res.col,
              mat: res.mat,
              idx: res.idx,
              vCount: res.vCount,
              iCount: res.iCount
            }, [res.pos.buffer, res.norm.buffer, res.col.buffer, res.mat.buffer, res.idx.buffer]);
          }
        };
      `;

      const blob = new Blob([workerCode], { type: 'application/javascript' });
      this._blobUrl = URL.createObjectURL(blob);

      const hw = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
      const count = Math.max(1, Math.min(maxWorkers, hw - 1));

      for (let i = 0; i < count; i++) {
        const w = new Worker(this._blobUrl);
        w.postMessage({ type: 'init', seed: this.seed, worldType: this.worldType });
        w.onmessage = (e) => {
          if (this.disposed) return;
          const data = e.data;
          w._curKey = null;
          this.inFlight.delete(data.key);
          this.readyResults.push(data);
          this.idleWorkers.push(w);
          this._pump();
        };
        w.onerror = () => {
          if (w._curKey) {
            this.inFlight.delete(w._curKey);
            w._curKey = null;
          }
          this.idleWorkers.push(w);
          this._pump();
        };
        this.workers.push(w);
        this.idleWorkers.push(w);
      }
      this.useWorkers = true;
    } catch {
      this._fallbackKernel = createLodKernel(this.seed, this.worldType);
      this.useWorkers = false;
    }
  }

  enqueue(job) {
    if (this.disposed || this.inFlight.has(job.key)) return;
    if (this.useWorkers) {
      this.inFlight.add(job.key);
      this.pending.push(job);
      this._pump();
    } else {
      // Synchronous fallback (still runs the exact same fast greedy mesher!)
      if (!this._fallbackKernel) this._fallbackKernel = createLodKernel(this.seed, this.worldType);
      const res = this._fallbackKernel.buildRegion(job.rx, job.rz, job.tier);
      this.readyResults.push({
        key: job.key,
        rx: job.rx,
        rz: job.rz,
        tier: job.tier,
        ...res
      });
    }
  }

  // Cancel queued (not yet started) jobs no longer in activeKeys
  prunePending(activeKeys) {
    if (this.pending.length === 0) return;
    let write = 0;
    for (let i = 0; i < this.pending.length; i++) {
      const job = this.pending[i];
      if (activeKeys.has(job.key)) {
        this.pending[write++] = job;
      } else {
        this.inFlight.delete(job.key);
      }
    }
    this.pending.length = write;
  }

  clearQueue() {
    for (let i = 0; i < this.pending.length; i++) {
      this.inFlight.delete(this.pending[i].key);
    }
    this.pending.length = 0;
    this.readyResults.length = 0;
  }

  _pump() {
    while (this.idleWorkers.length > 0 && this.pending.length > 0) {
      const w = this.idleWorkers.pop();
      const job = this.pending.shift();
      w._curKey = job.key;
      w.postMessage({
        type: 'build',
        key: job.key,
        rx: job.rx,
        rz: job.rz,
        tier: job.tier
      });
    }
  }

  dispose() {
    this.disposed = true;
    this.clearQueue();
    for (const w of this.workers) {
      try { w.terminate(); } catch {}
    }
    this.workers.length = 0;
    this.idleWorkers.length = 0;
    if (this._blobUrl) {
      try { URL.revokeObjectURL(this._blobUrl); } catch {}
      this._blobUrl = null;
    }
  }
}
