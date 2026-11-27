// Module Web Worker hosting a headless copy of the real World generator.
// Jobs:
//   gen  -> real chunk voxel data + the tile entities generation created (chests, doors, villages...)
//   mesh -> chunk mesh buffers (same mesher as the main thread) from 3x3 neighbor voxel data
//   lod  -> Distant-Horizons LOD tile built from REAL terrain heights, real structures & real roads
// Everything here runs the exact same code as the main thread, so LODs match the actual world.

const VERSION = new URL(self.location.href).search;

let world = null;
let kernel = null;
let ready = null;

// Reusable full-height scratch voxel buffers for mesh jobs (9 = 3x3 neighborhood)
let scratchData = null;
const scratchLens = new Int32Array(9);

function makeStubs(tileMap) {
  const scene = { add() {}, remove() {} };
  const textures = {
    tileMap,
    getUV: (n) => tileMap[n] || tileMap.stone,
    atlasTexture: null,
    normalTexture: null,
    pbrTexture: null
  };
  return { scene, textures };
}

function clearGenTiles() {
  world.chests.clear();
  world.doorStates.clear();
  world.stairStates.clear();
  world.gateStates.clear();
  world.ladderStates.clear();
  world.waterloggedLadders.clear();
  world.villageChunks.clear();
  world.megaStructures.clear();
  world.activeFarmlands.clear();
  world.activeCrops.clear();
  world.fluidQueue.clear && world.fluidQueue.clear();
}

async function init(msg) {
  const worldMod = await import('./world.js' + VERSION);
  const lodMod = await import('./lod-mesher.js');
  const blocksMod = await import('./blocks.js');
  const { scene, textures } = makeStubs(msg.tileMap);
  world = new worldMod.World(scene, textures, {
    seed: msg.seedStr,
    worldType: msg.worldType,
    renderDistance: 2,
    maxDetailRadius: 2,
    shaders: 'low',
    generateStructures: msg.generateStructures !== false,
    worldBorderChunks: msg.worldBorderChunks || 0,
    headless: true
  });
  // Road networks are expensive to derive; keep many more regions cached than the main thread does.
  world._roadCacheLimit = 256;
  const CH = worldMod.CHUNK_SIZE * worldMod.CHUNK_HEIGHT * worldMod.CHUNK_SIZE;
  scratchData = [];
  for (let i = 0; i < 9; i++) scratchData.push(new Uint8Array(CH));
  kernel = lodMod.createLodKernel(world.seed, msg.worldType, {
    world,
    blocks: blocksMod,
    palTop: msg.palTop,
    palSide: msg.palSide,
    generateStructures: msg.generateStructures !== false,
    worldBorderChunks: msg.worldBorderChunks || 0
  });
}

function runGen(msg) {
  clearGenTiles();
  const raw = world._genChunkRaw(msg.cx, msg.cz);
  kernel.rememberChunk(msg.cx, msg.cz, raw.data, raw.maxY);
  const tiles = {
    chests: Array.from(world.chests.entries()),
    doors: Array.from(world.doorStates.entries()),
    stairs: Array.from(world.stairStates.entries()),
    wl: Array.from(world.waterloggedLadders),
    villages: Array.from(world.villageChunks.entries()),
    megas: Array.from(world.megaStructures.entries()),
    farmlands: Array.from(world.activeFarmlands.entries())
  };
  self.postMessage({ type: 'gen', id: msg.id, cx: msg.cx, cz: msg.cz, data: raw.data, maxY: raw.maxY, tiles }, [raw.data.buffer]);
}

function runMesh(msg) {
  world.chunks.clear();
  const datas = msg.datas;
  let center = null;
  for (let i = 0; i < 9; i++) {
    const src = datas[i];
    const buf = scratchData[i];
    if (scratchLens[i] > 0) buf.fill(0, 0, scratchLens[i]);
    scratchLens[i] = 0;
    if (!src) continue;
    buf.set(src);
    scratchLens[i] = src.length;
    const dx = (i % 3) - 1;
    const dz = Math.floor(i / 3) - 1;
    const cx = msg.cx + dx;
    const cz = msg.cz + dz;
    const key = world.chunkKey(cx, cz);
    const ch = { cx, cz, key, data: buf, maxY: msg.maxYs[i], meshes: [], hasEmitters: msg.emit[i] === 0 ? false : (msg.emit[i] === 1 ? true : undefined) };
    world.chunks.set(key, ch);
    if (dx === 0 && dz === 0) center = ch;
  }
  if (!center) throw new Error('mesh job without center chunk');
  const res = world._computeChunkMesh(center, !!msg.far);
  world.chunks.clear();
  const transfer = [];
  for (const k of ['opaque', 'cutout', 'staticCutout', 'lava', 'fire', 'water']) {
    const a = res[k];
    if (!a) continue;
    for (const f of ['pos', 'norm', 'uv', 'col', 'tile', 'blk', 'bnc', 'idx']) {
      if (a[f]) transfer.push(a[f].buffer);
    }
  }
  self.postMessage({ type: 'mesh', id: msg.id, cx: msg.cx, cz: msg.cz, seq: msg.seq, far: !!msg.far, res }, transfer);
}

function runLod(msg) {
  const res = kernel.buildRegion(msg.rx, msg.rz, msg.tier);
  self.postMessage({
    type: 'lod', id: msg.id, key: msg.key, rx: msg.rx, rz: msg.rz, tier: msg.tier,
    pos: res.pos, norm: res.norm, col: res.col, mat: res.mat, idx: res.idx, vCount: res.vCount, iCount: res.iCount
  }, [res.pos.buffer, res.norm.buffer, res.col.buffer, res.mat.buffer, res.idx.buffer]);
}

const backlog = [];

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    ready = init(msg).then(() => {
      self.postMessage({ type: 'ready' });
      for (const m of backlog.splice(0)) dispatch(m);
    }, (err) => {
      self.postMessage({ type: 'fatal', message: String((err && err.message) || err) });
    });
    return;
  }
  if (!world) {
    backlog.push(msg);
    return;
  }
  dispatch(msg);
};

function dispatch(msg) {
  try {
    if (msg.type === 'gen') runGen(msg);
    else if (msg.type === 'mesh') runMesh(msg);
    else if (msg.type === 'lod') runLod(msg);
    else if (msg.type === 'sums') {
      for (const s of msg.sums) kernel.putSummary(s.cx, s.cz, s.topY, s.topId);
      self.postMessage({ type: 'ack', id: msg.id });
    } else if (msg.type === 'mods') {
      // Player edits relevant to generation-time tile lookups are main-thread only; nothing to do.
      self.postMessage({ type: 'ack', id: msg.id });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, job: msg.type, key: msg.key, cx: msg.cx, cz: msg.cz, message: String((err && err.message) || err) });
  }
}
