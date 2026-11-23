// Seeded PRNG & fast 2D/3D Value/Perlin-style Simplex Noise

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function grad3Fast(hash, x, y, z) {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
  return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
}

export class Noise {
  constructor(seed = 1337) {
    const rand = mulberry32(seed);
    this.perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  lerp(a, b, t) {
    return a + t * (b - a);
  }

  grad2(hash, x, y) {
    const h = hash & 7;
    const u = h < 4 ? x : y;
    const v = h < 4 ? y : x;
    return ((h & 1) ? -u : u) + ((h & 2) ? -2.0 * v : 2.0 * v);
  }

  grad3(hash, x, y, z) {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
    return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
  }

  noise2D(x, y) {
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

    const p = this.perm;
    const pX = p[X];
    const pX1 = p[X + 1];
    const aa = p[pX + Y] & 7;
    const ab = p[pX + Y + 1] & 7;
    const ba = p[pX1 + Y] & 7;
    const bb = p[pX1 + Y + 1] & 7;

    const xf1 = xf - 1;
    const yf1 = yf - 1;

    // Inlined grad2 for all 4 corners (zero method call overhead!)
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

  noise3D(x, y, z) {
    let xi = x | 0;
    if (x < xi) xi--;
    let yi = y | 0;
    if (y < yi) yi--;
    let zi = z | 0;
    if (z < zi) zi--;
    const xf = x - xi;
    const yf = y - yi;
    const zf = z - zi;
    const X = xi & 255;
    const Y = yi & 255;
    const Z = zi & 255;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const w = zf * zf * zf * (zf * (zf * 6 - 15) + 10);

    const p = this.perm;
    const A = p[X] + Y;
    const AA = p[A] + Z;
    const AB = p[A + 1] + Z;
    const B = p[X + 1] + Y;
    const BA = p[B] + Z;
    const BB = p[B + 1] + Z;

    const xf1 = xf - 1;
    const yf1 = yf - 1;
    const zf1 = zf - 1;

    const g000 = grad3Fast(p[AA], xf, yf, zf);
    const g100 = grad3Fast(p[BA], xf1, yf, zf);
    const g010 = grad3Fast(p[AB], xf, yf1, zf);
    const g110 = grad3Fast(p[BB], xf1, yf1, zf);
    const x1 = g000 + u * (g100 - g000);
    const x2 = g010 + u * (g110 - g010);
    const y1 = x1 + v * (x2 - x1);

    const g001 = grad3Fast(p[AA + 1], xf, yf, zf1);
    const g101 = grad3Fast(p[BA + 1], xf1, yf, zf1);
    const g011 = grad3Fast(p[AB + 1], xf, yf1, zf1);
    const g111 = grad3Fast(p[BB + 1], xf1, yf1, zf1);
    const x3 = g001 + u * (g101 - g001);
    const x4 = g011 + u * (g111 - g011);
    const y2 = x3 + v * (x4 - x3);

    return y1 + w * (y2 - y1);
  }

  fbm2D(x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let max = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise2D(x * freq, y * freq) * amp;
      max += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / max;
  }
}
