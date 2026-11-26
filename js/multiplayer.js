import * as THREE from 'three';
import { ITEMS, BLOCK, getBlockDef } from './blocks.js';
import { createSteveModel, updateSteveArmor, updateSteveSkin, setSteveHurtFlash, updateHeldItemRig, createSteveFireGroup, createPlayerNametag, updatePlayerNametag } from './player.js';
import { getSavedPlayerName, savePlayerName, getSavedPlayerSkin, savePlayerSkin } from './storage.js';

export { getSavedPlayerName, savePlayerName, getSavedPlayerSkin, savePlayerSkin };

// Unambiguous uppercase room code alphabet (no 0/O/1/I confusion!)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PEER_PREFIX = 'bc44mp-';
const RECENT_CODES_KEY = 'blockcraft_recent_mp_codes_v1';

export function generateRoomCode(len = 6) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

export function normalizeRoomCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
}

export function formatRoomCode(code) {
  const clean = normalizeRoomCode(code);
  if (clean.length === 6) return `${clean.slice(0, 3)}-${clean.slice(3)}`;
  return clean;
}

export function getRecentRoomCodes() {
  try {
    const raw = localStorage.getItem(RECENT_CODES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(0, 5) : [];
  } catch {
    return [];
  }
}

export function rememberRoomCode(code, worldName = '') {
  const clean = normalizeRoomCode(code);
  if (clean.length < 4) return;
  try {
    const prev = getRecentRoomCodes().filter((r) => r.code !== clean);
    prev.unshift({ code: clean, worldName: worldName || 'Multiplayer World', at: Date.now() });
    localStorage.setItem(RECENT_CODES_KEY, JSON.stringify(prev.slice(0, 5)));
  } catch {}
}

// Lazy-load PeerJS ONLY when a user hosts or joins (zero startup overhead in Singleplayer!)
let _peerJsPromise = null;
function loadPeerJS() {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window.Peer) return Promise.resolve(window.Peer);
  if (_peerJsPromise) return _peerJsPromise;

  const urls = [
    'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
    'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js'
  ];

  _peerJsPromise = new Promise((resolve) => {
    let idx = 0;
    const tryNext = () => {
      if (window.Peer) { resolve(window.Peer); return; }
      if (idx >= urls.length) { resolve(null); return; }
      const s = document.createElement('script');
      s.src = urls[idx++];
      s.async = true;
      const timer = setTimeout(() => {
        s.onerror = null;
        s.onload = null;
        tryNext();
      }, 6500);
      s.onload = () => {
        clearTimeout(timer);
        resolve(window.Peer || null);
      };
      s.onerror = () => {
        clearTimeout(timer);
        tryNext();
      };
      document.head.appendChild(s);
    };
    tryNext();
  });
  return _peerJsPromise;
}

function lerpAngle(a, b, t) {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

const r2 = (n) => Math.round(n * 100) / 100;

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// --- WIRE PROTOCOL TUNING ---
// Pose updates: 20 Hz while anything changes, 1 Hz keepalive while idle.
const POSE_SEND_INTERVAL = 0.05;
const POSE_KEEPALIVE = 1.0;
// Static appearance fields (name / skin / held item / armor) ride along on change + every 2s.
const APPEARANCE_RESEND = 2.0;
const STALE_PLAYER_MS = 25000;

// PeerJS's JSON channel hard-rejects any single message >= 16300 bytes ("Message too big for JSON
// channel"), which used to silently break online joins for any world with real edits. Large
// messages are gzip+base64'd (when both sides support it) and split under that cap.
const PEER_JSON_LIMIT = 15500;
const CHUNK_CHARS_B64 = 12000; // base64 is pure ASCII -> chars == bytes
const CHUNK_CHARS_RAW = 4800;  // raw JSON: worst-case 3 bytes/char after escaping
const LARGE_TYPES = new Set(['welcome', 'chest']);

// World-changing packets a guest receives while its world is still loading are queued and
// replayed afterwards (previously dropped -> permanent desync for edits made during a join).
const PRELOAD_QUEUE_TYPES = new Set(['blk', 'door', 'gate', 'stair', 'lad', 'fluid', 'tnt', 'chest', 'time', 'dead', 'chat']);
const PRELOAD_QUEUE_MAX = 20000;

// Compact pose flag bitfield (replaces 8 separate JSON keys per packet).
const F_SWING = 1, F_EAT = 2, F_SNEAK = 4, F_FLY = 8, F_WATER = 16, F_BURN = 32, F_HURT = 64, F_DEAD = 128;

const HAS_COMPRESSION = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

function bytesToBase64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gzipToBase64(str) {
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
}

async function gunzipFromBase64(b64) {
  const stream = new Blob([base64ToBytes(b64)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

function utf8Length(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

function disposeMaterial(m) {
  if (!m) return;
  if (Array.isArray(m)) { for (const x of m) disposeMaterial(x); return; }
  if (typeof m.dispose === 'function') m.dispose(); // maps are shared atlas/skin textures: never disposed here
}

export class MultiplayerManager {
  constructor(game) {
    this.game = game;
    this.role = 'offline'; // 'offline' | 'host' | 'guest'
    this.roomCode = '';
    this.localId = 'p_' + Math.random().toString(36).slice(2, 9);
    this.playerName = getSavedPlayerName();
    this.playerSkin = getSavedPlayerSkin();
    this.onlineMode = 'none'; // 'none' | 'online' | 'local'

    this.peer = null;
    this.hostConn = null;        // Guest -> Host PeerJS DataConnection
    this.connections = new Map(); // Host: peerId -> DataConnection
    this.bc = null;              // Same-browser BroadcastChannel fast transport
    this.bcPeers = new Set();    // Peer IDs connected over BroadcastChannel

    this.remotePlayers = new Map(); // peerId -> RemotePlayerState
    this._sendTimer = 0;
    this._keepaliveAccum = 0;
    this._appearanceAccum = APPEARANCE_RESEND;
    this._timeSyncTimer = 0;
    this._lastPose = null;
    this._lastAppearanceSig = '';
    this._suppressBroadcast = false;
    this._worldReady = false;
    this._preloadQueue = [];
    this._chunkSeq = 0;
    this._chunkBufs = new Map();
    this._onChunkProgress = null;
    this.onStateChange = null;
  }

  isActive() {
    return this.role === 'host' || this.role === 'guest';
  }

  getPlayerCount() {
    return this.isActive() ? 1 + this.remotePlayers.size : 1;
  }

  getPlayerRoster() {
    const list = [{ id: this.localId, name: this.playerName, isHost: this.role === 'host', isLocal: true }];
    for (const [id, rp] of this.remotePlayers.entries()) {
      list.push({ id, name: rp.name, isHost: rp.isHost, isLocal: false });
    }
    return list;
  }

  _emitState() {
    if (this.onStateChange) this.onStateChange(this);
  }

  _resetSendState() {
    this._sendTimer = 0;
    this._keepaliveAccum = 0;
    this._appearanceAccum = APPEARANCE_RESEND;
    this._lastPose = null;
    this._lastAppearanceSig = '';
    this._chunkBufs.clear();
    this._preloadQueue.length = 0;
  }

  // --- HOST A MULTIPLAYER WORLD (called from Settings -> "Multiplayer World") ---
  async hostWorld(playerName = null) {
    if (!this.game || !this.game.running || !this.game.world) {
      throw new Error('Load a world before starting Multiplayer.');
    }
    if (this.role === 'host' && this.roomCode) {
      return { code: this.roomCode, onlineMode: this.onlineMode };
    }
    if (this.role === 'guest') {
      throw new Error('Already connected to a multiplayer world.');
    }

    if (playerName) this.playerName = savePlayerName(playerName);
    this.roomCode = generateRoomCode(6);
    this.role = 'host';
    this.onlineMode = 'connecting';
    this._worldReady = true;
    this._resetSendState();

    // 1. Open instant local BroadcastChannel bridge & show the room code IMMEDIATELY (<1ms!)
    this._setupBroadcastChannel(this.roomCode);
    rememberRoomCode(this.roomCode, this.game.worldMeta?.name || 'Hosted World');
    this._emitState();

    // 2. Connect WebRTC PeerJS Signaling endpoint asynchronously in the background for cross-device online play!
    loadPeerJS().then((PeerCtor) => {
      if (this.role !== 'host') return;
      if (!PeerCtor) {
        this.onlineMode = 'local';
        this._emitState();
        return;
      }
      let settled = false;
      const finish = (mode) => {
        if (settled || this.role !== 'host') return;
        settled = true;
        this.onlineMode = mode;
        this._emitState();
      };
      const timeout = setTimeout(() => finish('local'), 7500);
      try {
        const peerId = PEER_PREFIX + this.roomCode;
        const peer = new PeerCtor(peerId, { debug: 0, config: ICE_CONFIG });
        this.peer = peer;
        peer.on('open', () => {
          clearTimeout(timeout);
          finish('online');
        });
        peer.on('connection', (conn) => {
          this._attachHostPeerConnection(conn);
        });
        peer.on('disconnected', () => {
          // Signaling socket dropped (sleep / network blip): existing P2P links survive, but new
          // guests can't find us until we re-register with the broker.
          if (this.role === 'host' && this.peer === peer && !peer.destroyed) {
            try { peer.reconnect(); } catch {}
          }
        });
        peer.on('error', () => {
          clearTimeout(timeout);
          finish('local');
        });
      } catch {
        clearTimeout(timeout);
        finish('local');
      }
    });

    return { code: this.roomCode, onlineMode: this.onlineMode };
  }

  _attachHostPeerConnection(conn) {
    // CRITICAL: Attach 'data' listener immediately (PeerJS can emit 'data' right as 'open' fires or already be open!)
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      this._handleIncoming(msg, conn.peer, conn);
    });
    const onClose = () => {
      const pid = conn._bcPlayerId || conn.peer;
      if (this.connections.get(pid) !== conn) return; // already replaced / cleaned up
      this.connections.delete(pid);
      // Same-browser guests may still be reachable over BroadcastChannel
      if (!this.bcPeers.has(pid)) this._removeRemotePlayer(pid, true);
    };
    conn.on('close', onClose);
    conn.on('error', onClose);
  }

  // --- JOIN A HOST'S MULTIPLAYER WORLD (called from Multiplayer -> "Join World" popup) ---
  async joinWorld(rawCode, playerName = null, onStatus = null) {
    const code = normalizeRoomCode(rawCode);
    if (code.length < 4) {
      throw new Error('Please enter a valid 6-character world code.');
    }
    this.disconnect(true);

    if (playerName) this.playerName = savePlayerName(playerName);
    this.roomCode = code;
    this.role = 'guest';
    this._worldReady = false;
    this._resetSendState();

    const report = (msg) => { if (onStatus) onStatus(msg); };
    report(`Connecting to room ${formatRoomCode(code)}...`);

    return new Promise(async (resolve, reject) => {
      let connected = false;
      let done = false;
      let bcRetryTimer = null;
      let overallTimeout = null;

      const armTimeout = (ms) => {
        clearTimeout(overallTimeout);
        overallTimeout = setTimeout(() => {
          if (!connected) {
            fail(`Could not find world "${formatRoomCode(code)}". Check the code and make sure the host opened Multiplayer World.`);
          }
        }, ms);
      };

      const clearTimers = () => {
        if (bcRetryTimer) { clearInterval(bcRetryTimer); bcRetryTimer = null; }
        clearTimeout(overallTimeout);
        this._onChunkProgress = null;
      };

      const fail = (errMsg) => {
        if (done) return;
        done = true;
        clearTimers();
        this.disconnect(true);
        reject(new Error(errMsg));
      };

      const onWelcome = async (snapshot) => {
        if (done) return;
        done = true;
        connected = true;
        clearTimers();
        rememberRoomCode(code, snapshot?.meta?.name || 'Multiplayer World');
        report('World received! Loading terrain...');
        // No pose packets flow while the world loads; keep the host from timing us out as stale.
        const loadKeepalive = setInterval(() => {
          if (this.role === 'guest') this._sendToHost({ t: 'ka', id: this.localId });
        }, 4000);
        try {
          try {
            await this.game.loadMultiplayerWorld(snapshot);
          } finally {
            clearInterval(loadKeepalive);
          }
          if (this.role !== 'guest') throw new Error('Disconnected while loading the world.');
          // Re-attach any remote players from snapshot roster after scene init
          if (Array.isArray(snapshot.players)) {
            for (const p of snapshot.players) {
              if (p.id && p.id !== this.localId) {
                this._upsertRemotePlayer(p.id, p.name, p.isHost, p);
              }
            }
          }
          this._flushPreloadQueue();
          this._emitState();
          resolve(snapshot);
        } catch (e) {
          this.disconnect(true);
          reject(e);
        }
      };

      this._pendingWelcome = onWelcome;
      armTimeout(13000);

      // Large worlds stream in as chunks: show progress and keep the join alive while bytes flow.
      let lastKa = 0;
      this._onChunkProgress = (frac) => {
        if (done) return;
        armTimeout(15000);
        const nowMs = performance.now();
        if (nowMs - lastKa > 4000) {
          lastKa = nowMs;
          this._sendToHost({ t: 'ka', id: this.localId });
        }
        report(`Downloading world... ${Math.round(frac * 100)}%`);
      };

      const helloPkt = { t: 'hello', id: this.localId, name: this.playerName, sk: this.playerSkin, gz: HAS_COMPRESSION ? 1 : 0 };

      // 1. Try instant local BroadcastChannel first (with retry pulse every 500ms while waiting!)
      this._setupBroadcastChannel(code);
      this._sendBroadcastChannel(helloPkt);
      bcRetryTimer = setInterval(() => {
        if (!done && this.bc) this._sendBroadcastChannel(helloPkt);
      }, 500);

      // 2. Simultaneously connect over WebRTC PeerJS for cross-device / internet multiplayer!
      const PeerCtor = await loadPeerJS();
      if (done) { clearTimers(); return; }
      if (!PeerCtor) {
        report('Checking local room...');
        return;
      }

      report(`Searching online for ${formatRoomCode(code)}...`);
      try {
        const peer = new PeerCtor(undefined, { debug: 0, config: ICE_CONFIG });
        this.peer = peer;
        peer.on('open', () => {
          if (done) return;
          const hostPeerId = PEER_PREFIX + code;
          const conn = peer.connect(hostPeerId, { reliable: true, serialization: 'json' });
          this.hostConn = conn;
          // Attach data handler immediately before open fires!
          conn.on('data', (msg) => {
            if (!msg || typeof msg !== 'object') return;
            this._handleIncoming(msg, 'host', conn);
          });
          const sendHello = () => {
            if (done) return;
            this.onlineMode = 'online';
            report('Connected! Downloading world snapshot...');
            conn.send(helloPkt);
          };
          if (conn.open) sendHello();
          else conn.on('open', sendHello);
          conn.on('close', () => {
            if (this.hostConn !== conn) return;
            if (connected && this.role === 'guest') {
              // Same-browser sessions can keep going over BroadcastChannel
              if (this.bc && this.onlineMode === 'local') return;
              this.game.ui?.addChatMessage('Disconnected from host world.');
              this.game.ui?.toast('Host closed the multiplayer world');
              this.disconnect(false);
            }
          });
          conn.on('error', () => {
            if (!connected && !this.bc) {
              fail(`Unable to reach host "${formatRoomCode(code)}".`);
            }
          });
        });
        peer.on('error', (err) => {
          if (!connected && err && err.type === 'peer-unavailable') {
            // Wait a brief moment in case local BroadcastChannel responds
            setTimeout(() => {
              if (!connected && !done) {
                fail(`World code "${formatRoomCode(code)}" is not online right now.`);
              }
            }, 1100);
          }
        });
      } catch {
        // Fallback stays on BroadcastChannel until timeout
      }
    });
  }

  _setupBroadcastChannel(code) {
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      if (this.bc) this.bc.close();
      this.bc = new BroadcastChannel(`blockcraft_mp_${code}`);
      this.bc.onmessage = (ev) => {
        const msg = ev.data;
        if (!msg || typeof msg !== 'object' || msg._from === this.localId) return;
        const to = msg._to;
        if (to) {
          if (Array.isArray(to) ? !to.includes(this.localId) : to !== this.localId) return;
        }
        this._handleIncoming(msg, msg._from, null, true);
      };
    } catch {
      this.bc = null;
    }
  }

  _sendBroadcastChannel(payload, targetId = null) {
    if (!this.bc) return;
    try {
      this.bc.postMessage({ ...payload, _from: this.localId, _to: targetId || undefined });
    } catch {}
  }

  disconnect(silent = false) {
    if (this.role === 'host') {
      this._broadcastRaw({ t: 'host_bye' });
    } else if (this.role === 'guest') {
      this._sendToHost({ t: 'bye', id: this.localId });
    }

    for (const conn of this.connections.values()) {
      try { conn.close(); } catch {}
    }
    this.connections.clear();
    if (this.hostConn) {
      const hc = this.hostConn;
      this.hostConn = null;
      try { hc.close(); } catch {}
    }
    if (this.peer) {
      try { this.peer.destroy(); } catch {}
      this.peer = null;
    }
    if (this.bc) {
      try { this.bc.close(); } catch {}
      this.bc = null;
    }
    this.bcPeers.clear();
    this.clearRemotePlayers();
    this._pendingWelcome = null;
    this._onChunkProgress = null;
    this._resetSendState();
    const wasActive = this.isActive();
    this.role = 'offline';
    this.roomCode = '';
    this.onlineMode = 'none';
    this._worldReady = false;
    if (wasActive && !silent && this.game?.ui) {
      this.game.ui.toast('Multiplayer session ended');
    }
    this._emitState();
  }

  clearRemotePlayers() {
    for (const rp of this.remotePlayers.values()) {
      this._disposeRemotePlayer(rp);
    }
    this.remotePlayers.clear();
  }

  _disposeRemotePlayer(rp) {
    if (!rp) return;
    const m = rp.model;
    if (m?.root) {
      if (m.root.parent) m.root.parent.remove(m.root);
      // Free per-player GPU buffers (geometry + materials). Textures are shared and kept.
      const meshes = [
        ...Object.values(m.skinMeshes || {}),
        ...Object.values(m.armorMeshes || {})
      ];
      for (const mesh of meshes) mesh?.geometry?.dispose();
      for (const b of Object.values(m._skinMatCache || {})) {
        disposeMaterial([b.headMats, b.torsoMats, b.armMats, b.legMats]);
      }
      for (const b of Object.values(m._armorMatCache || {})) {
        disposeMaterial([b.helm, b.chest, b.pauldron, b.legging, b.boot]);
      }
    }
    if (rp.fireGroup) {
      rp.fireGroup.traverse((o) => {
        if (o.isMesh) { o.geometry?.dispose(); disposeMaterial(o.material); }
      });
    }
    if (rp.nametag) {
      rp.nametag.tex?.dispose();
      rp.nametag.mat?.dispose();
    }
  }

  // --- WORLD SNAPSHOT BUILDER (HOST) ---
  _buildWorldSnapshot() {
    const g = this.game;
    const w = g.world;
    const m = g.worldMeta || {};
    const p = g.player;
    const players = [this._buildLocalPlayerPacket(true)];
    for (const rp of this.remotePlayers.values()) {
      players.push(this._buildRemotePlayerPacket(rp));
    }

    // Flat [x,y,z,id, x,y,z,id, ...] int list: ~2x smaller than ["x,y,z",id] pairs and
    // far cheaper for the guest to restore (no per-entry string splitting).
    const mb = new Array(w.modifiedBlocks.size * 4);
    let i = 0;
    for (const [k, v] of w.modifiedBlocks) {
      const c1 = k.indexOf(',');
      const c2 = k.indexOf(',', c1 + 1);
      mb[i++] = +k.slice(0, c1);
      mb[i++] = +k.slice(c1 + 1, c2);
      mb[i++] = +k.slice(c2 + 1);
      mb[i++] = v;
    }

    return {
      t: 'welcome',
      hostId: this.localId,
      hostName: this.playerName,
      meta: {
        name: m.name || 'Multiplayer World',
        mode: p ? p.mode : (m.mode || 'survival'),
        worldType: m.worldType || 'infinite',
        seed: m.seed,
        allowCheats: Boolean(m.allowCheats),
        difficulty: m.difficulty || 'normal',
        mobSpawnRate: m.mobSpawnRate ?? 1.0,
        hungerRate: m.hungerRate ?? 1.0,
        farmSpeed: m.farmSpeed ?? 1.0,
        generateStructures: m.generateStructures !== false
      },
      time: g.sky ? g.sky.time : 0.31,
      dayCount: g.sky ? g.sky.dayCount : 1,
      weather: g.sky ? g.sky.weather : 'clear',
      spawn: p ? { x: r2(p.pos.x + 1.5), y: r2(p.pos.y + 0.5), z: r2(p.pos.z + 1.5) } : { x: 0.5, y: 48, z: 0.5 },
      mb,
      doorStates: Array.from(w.doorStates.entries()),
      gateStates: Array.from(w.gateStates.entries()),
      ladderStates: Array.from(w.ladderStates.entries()),
      waterloggedLadders: Array.from(w.waterloggedLadders),
      stairStates: Array.from(w.stairStates.entries()),
      chests: Array.from(w.chests.entries()),
      furnaces: Array.from(w.furnaces.entries()),
      players
    };
  }

  _localFlags() {
    const p = this.game.player;
    let f = 0;
    if (p.swingAnim > 0.25) f |= F_SWING;
    if (p.isEating) f |= F_EAT;
    if (p.sneaking) f |= F_SNEAK;
    if (p.flying) f |= F_FLY;
    if (p.inWater) f |= F_WATER;
    if (p.burnTimer > 0 || p.inLava || p.inFire) f |= F_BURN;
    if (p.hurtTimer > 0) f |= F_HURT;
    if (p.dead) f |= F_DEAD;
    return f;
  }

  _localAppearance() {
    const inv = this.game.inventory;
    const held = inv ? inv.getHeldDef() : null;
    const ar = inv && inv.armor
      ? inv.armor.map((a) => (a && a.id) ? a.id : '')
      : ['', '', '', ''];
    return { sk: this.playerSkin || getSavedPlayerSkin(), h: held ? held.id : '', ar };
  }

  _buildLocalPlayerPacket(includeAppearance = true, appearance = null) {
    const p = this.game.player;
    const pkt = {
      t: 'p',
      id: this.localId,
      x: r2(p.pos.x),
      y: r2(p.pos.y),
      z: r2(p.pos.z),
      yw: r2(p.yaw),
      pt: r2(p.pitch),
      f: this._localFlags(),
      hp: Math.round(p.hp)
    };
    if (includeAppearance) {
      const ap = appearance || this._localAppearance();
      pkt.name = this.playerName;
      pkt.isHost = this.role === 'host';
      pkt.sk = ap.sk;
      pkt.h = ap.h;
      pkt.ar = ap.ar;
    }
    return pkt;
  }

  _buildRemotePlayerPacket(rp) {
    let f = 0;
    if (rp.sneaking) f |= F_SNEAK;
    if (rp.flying) f |= F_FLY;
    if (rp.inWater) f |= F_WATER;
    if (rp.burning) f |= F_BURN;
    if (rp.dead) f |= F_DEAD;
    return {
      id: rp.id,
      name: rp.name,
      isHost: rp.isHost,
      sk: rp.skinId || 'steve',
      x: r2(rp.targetPos.x),
      y: r2(rp.targetPos.y),
      z: r2(rp.targetPos.z),
      yw: r2(rp.targetYaw),
      pt: r2(rp.targetPitch),
      f,
      hp: rp.hp,
      h: rp.heldId,
      ar: rp.armorIds
    };
  }

  // --- TRANSPORT SENDERS ---
  // Every PeerJS send goes through here so large payloads are chunked and ordering is preserved
  // behind any in-flight (async-compressed) large message on the same connection.
  _sendConn(conn, msg) {
    if (!conn || !conn.open) return;
    if (conn._sendChain || LARGE_TYPES.has(msg.t)) {
      const prev = conn._sendChain || Promise.resolve();
      const chain = prev.then(() => this._sendLarge(conn, msg)).catch(() => {});
      conn._sendChain = chain;
      chain.then(() => { if (conn._sendChain === chain) conn._sendChain = null; });
      return;
    }
    try { conn.send(msg); } catch {}
  }

  async _sendLarge(conn, msg) {
    if (!conn.open) return;
    const json = JSON.stringify(msg);
    if (json.length < PEER_JSON_LIMIT / 3 || (json.length < PEER_JSON_LIMIT && utf8Length(json) < PEER_JSON_LIMIT)) {
      conn.send(msg);
      return;
    }
    let payload = json;
    let z = 0;
    if (conn._gz && HAS_COMPRESSION) {
      try {
        payload = await gzipToBase64(json);
        z = 1;
      } catch {
        payload = json;
      }
    }
    const step = z ? CHUNK_CHARS_B64 : CHUNK_CHARS_RAW;
    const n = Math.ceil(payload.length / step);
    const c = ++this._chunkSeq;
    for (let i = 0; i < n; i++) {
      if (!conn.open) return;
      conn.send({ t: 'chk', c, i, n, z, d: payload.slice(i * step, (i + 1) * step) });
    }
  }

  async _handleChunk(msg, senderKey, conn, viaBc) {
    const n = msg.n | 0;
    const idx = msg.i | 0;
    if (n <= 0 || n > 20000 || idx < 0 || idx >= n || typeof msg.d !== 'string') return;
    const key = `${senderKey}:${msg.c}`;
    let buf = this._chunkBufs.get(key);
    if (!buf) {
      buf = { parts: new Array(n), got: 0, at: performance.now() };
      this._chunkBufs.set(key, buf);
    }
    if (buf.parts[idx] === undefined) {
      buf.parts[idx] = msg.d;
      buf.got++;
      buf.at = performance.now();
    }
    if (this._onChunkProgress && n > 1) this._onChunkProgress(buf.got / n);
    if (buf.got < n) return;
    this._chunkBufs.delete(key);
    try {
      const joined = buf.parts.join('');
      const text = msg.z ? await gunzipFromBase64(joined) : joined;
      const full = JSON.parse(text);
      if (full && typeof full === 'object' && full.t !== 'chk') {
        this._handleIncoming(full, senderKey, conn, viaBc);
      }
    } catch {}
  }

  _sendToHost(msg) {
    if (this.hostConn && this.hostConn.open) {
      this._sendConn(this.hostConn, msg);
    } else if (this.bc) {
      this._sendBroadcastChannel(msg);
    }
  }

  _broadcastRaw(msg, excludeId = null) {
    for (const [pid, conn] of this.connections) {
      if (pid === excludeId) continue;
      if (conn && conn.open) this._sendConn(conn, msg);
    }
    if (this.bc && this.bcPeers.size > 0) {
      // One postMessage reaches every same-browser tab; skip peers already served over WebRTC.
      const targets = [];
      for (const pid of this.bcPeers) {
        if (pid === excludeId) continue;
        const c = this.connections.get(pid);
        if (c && c.open) continue;
        targets.push(pid);
      }
      if (targets.length > 0) this._sendBroadcastChannel(msg, targets.length === 1 ? targets[0] : targets);
    }
  }

  _sendAction(msg) {
    if (!this.isActive() || this._suppressBroadcast) return;
    msg.id = this.localId;
    if (this.role === 'host') {
      this._broadcastRaw(msg);
    } else {
      this._sendToHost(msg);
    }
  }

  // --- PUBLIC GAME ACTION BROADCASTERS ---
  sendBlock(x, y, z, blockId) {
    this._sendAction({ t: 'blk', x: x | 0, y: y | 0, z: z | 0, b: blockId | 0 });
  }

  sendDoor(x, y, z, op, blockId = 0, facing = 0, open = false) {
    this._sendAction({ t: 'door', x: x | 0, y: y | 0, z: z | 0, op, b: blockId | 0, f: facing & 3, o: open ? 1 : 0 });
  }

  sendGate(x, y, z, op, blockId = 0, facing = 0, open = false) {
    this._sendAction({ t: 'gate', x: x | 0, y: y | 0, z: z | 0, op, b: blockId | 0, f: facing & 3, o: open ? 1 : 0 });
  }

  sendStair(x, y, z, blockId, facing, half) {
    this._sendAction({ t: 'stair', x: x | 0, y: y | 0, z: z | 0, b: blockId | 0, f: facing & 3, hf: half === 'top' ? 1 : 0 });
  }

  sendLadder(x, y, z, facing, waterlogged) {
    this._sendAction({ t: 'lad', x: x | 0, y: y | 0, z: z | 0, f: facing & 3, wl: waterlogged ? 1 : 0 });
  }

  sendFluid(x, y, z, op, blockId = 0) {
    this._sendAction({ t: 'fluid', x: x | 0, y: y | 0, z: z | 0, op, b: blockId | 0 });
  }

  sendTnt(x, y, z, fuse = 2.6) {
    this._sendAction({ t: 'tnt', x: x | 0, y: y | 0, z: z | 0, fu: r2(fuse) });
  }

  sendChest(key, slots) {
    this._sendAction({ t: 'chest', k: key, s: slots });
  }

  sendChat(text) {
    this._sendAction({ t: 'chat', nm: this.playerName, txt: String(text).slice(0, 180) });
  }

  sendPvpHit(targetId, dmg, dir) {
    // Immediate local red hurt flash + flinch feedback on attacker's screen!
    const rp = this.remotePlayers.get(targetId);
    if (rp && !rp.dead) {
      rp.hurtTimer = 0.40;
      rp.flinchTimer = 0.24;
    }
    this._sendAction({
      t: 'pvp',
      to: targetId,
      d: dmg,
      kx: r2((dir?.x || 0) * 6.5),
      ky: 4.5,
      kz: r2((dir?.z || 0) * 6.5),
      nm: this.playerName
    });
  }

  sendDeathState(isDead, reason = '') {
    this._sendAction({ t: 'dead', dd: isDead ? 1 : 0, r: String(reason || '').slice(0, 64), nm: this.playerName });
  }

  _flushPreloadQueue() {
    this._worldReady = true;
    const queue = this._preloadQueue;
    this._preloadQueue = [];
    for (const [msg, senderKey] of queue) {
      this._handleIncoming(msg, senderKey, null, false);
    }
  }

  // --- INCOMING PACKET DISPATCHER ---
  _handleIncoming(msg, senderKey, conn = null, viaBc = false) {
    const type = msg.t;

    // 0. Reassemble chunked large payloads (world snapshot, big chests)
    if (type === 'chk') {
      this._handleChunk(msg, senderKey, conn, viaBc);
      return;
    }

    // 1. Host receives Join handshake
    if (type === 'hello' && this.role === 'host') {
      const pid = msg.id || senderKey;
      if (!pid || pid === this.localId) return;
      const pname = String(msg.name || 'Player').slice(0, 16);
      if (conn) {
        conn._bcPlayerId = pid;
        conn._gz = Boolean(msg.gz);
        this.connections.set(pid, conn);
      }
      if (viaBc) {
        this.bcPeers.add(pid);
      }
      // The guest pulses hello every 500ms over BroadcastChannel and may also arrive over WebRTC:
      // only the first hello builds & ships a snapshot (it used to rebuild the whole world and
      // spam "X joined!" on every retry).
      const now = performance.now();
      const existing = this.remotePlayers.get(pid);
      if (existing && now - (existing._helloAt || 0) < 15000) return;

      const snap = this._buildWorldSnapshot();
      if (conn && conn.open) {
        this._sendConn(conn, snap);
      } else if (viaBc) {
        this._sendBroadcastChannel(snap, pid);
      }
      // Spawn remote player model with their chosen skin and notify everyone!
      const pPos = this.game.player ? this.game.player.pos : { x: 0.5, y: 48, z: 0.5 };
      const pSkin = msg.sk || 'steve';
      const rp = this._upsertRemotePlayer(pid, pname, false, { x: pPos.x + 1.5, y: pPos.y + 0.5, z: pPos.z + 1.5, sk: pSkin });
      rp._helloAt = now;
      if (!existing) {
        this._broadcastRaw({ t: 'join', id: pid, name: pname, sk: pSkin }, pid);
        this.game.ui?.addChatMessage(`${pname} joined the world!`);
        this.game.ui?.toast(`${pname} joined!`);
      }
      this._emitState();
      return;
    }

    // 2. Guest receives initial World Snapshot
    if (type === 'welcome' && this.role === 'guest') {
      if (this._pendingWelcome) {
        const fn = this._pendingWelcome;
        this._pendingWelcome = null;
        if (viaBc && !this.hostConn?.open) this.onlineMode = 'local';
        fn(msg);
      }
      return;
    }

    if (type === 'host_bye' && this.role === 'guest') {
      this.game.ui?.addChatMessage('Host ended the multiplayer session.');
      this.game.ui?.toast('Host closed multiplayer world');
      this.disconnect(true);
      return;
    }

    if (type === 'bye') {
      const pid = msg.id || senderKey;
      this.connections.delete(pid);
      this.bcPeers.delete(pid);
      this._removeRemotePlayer(pid, this.role === 'host');
      return;
    }

    if (type === 'join') {
      if (msg.id && msg.id !== this.localId && this._worldReady) {
        const isNew = !this.remotePlayers.has(msg.id);
        this._upsertRemotePlayer(msg.id, msg.name || 'Player', false, { sk: msg.sk || 'steve' });
        if (isNew) this.game.ui?.addChatMessage(`${msg.name || 'Player'} joined the world!`);
        this._emitState();
      }
      return;
    }

    if (type === 'leave') {
      this._removeRemotePlayer(msg.id, false);
      return;
    }

    const senderId = msg.id || senderKey;
    // Any traffic from a known player proves they're alive (not just pose packets).
    if (this.role === 'host') {
      const known = this.remotePlayers.get(senderId);
      if (known) known.lastSeen = performance.now();
    }
    if (type === 'ka') return;

    // Host relays packets to all other connected guests!
    if (this.role === 'host' && type !== 'welcome' && type !== 'hello') {
      this._broadcastRaw(msg, senderId);
    }

    // Guest still loading the world: keep world edits for replay, drop transient packets.
    if (this.role === 'guest' && !this._worldReady) {
      if (PRELOAD_QUEUE_TYPES.has(type) && this._preloadQueue.length < PRELOAD_QUEUE_MAX) {
        this._preloadQueue.push([msg, senderKey]);
      }
      return;
    }

    // Ignore packets if world isn't mounted yet
    if (!this.game || !this.game.running || !this.game.world) return;

    if (type === 'p') {
      if (senderId === this.localId) return;
      this._upsertRemotePlayer(senderId, msg.name, Boolean(msg.isHost), msg);
      return;
    }

    if (type === 'chat') {
      if (senderId !== this.localId) {
        this.game.ui?.addChatMessage(`${msg.nm || 'Player'}: ${msg.txt || ''}`);
      }
      return;
    }

    if (type === 'time' && this.role === 'guest' && this.game.sky) {
      this.game.sky.time = msg.tm;
      this.game.sky.dayCount = msg.dc || 1;
      if (msg.w) this.game.sky.weather = msg.w;
      return;
    }

    if (type === 'pvp') {
      if (msg.to === this.localId && this.game.player && !this.game.player.dead) {
        this.game.player.vel.x += msg.kx || 0;
        this.game.player.vel.y = Math.max(this.game.player.vel.y, msg.ky || 4.0);
        this.game.player.vel.z += msg.kz || 0;
        if (this.game.sound?.playPlayerHit) this.game.sound.playPlayerHit();
        this.game.player.takeDamage(msg.d || 2, `Slain by ${msg.nm || 'Player'}`);
      } else if (msg.to && msg.to !== this.localId) {
        const victim = this.remotePlayers.get(msg.to);
        if (victim && !victim.dead) {
          victim.hurtTimer = 0.40;
          victim.flinchTimer = 0.24;
          if (this.game.player && victim.pos.distanceToSquared(this.game.player.pos) < 256) {
            if (this.game.sound?.playPlayerHit) this.game.sound.playPlayerHit();
          }
        }
      }
      return;
    }

    if (type === 'dead') {
      const rp = this.remotePlayers.get(senderId);
      if (rp) {
        const nowDead = Boolean(msg.dd);
        const wasDead = rp.dead;
        rp.dead = nowDead;
        rp.model.root.visible = !nowDead;
        if (rp.nametag?.sprite) rp.nametag.sprite.visible = !nowDead;
        if (nowDead && !wasDead) {
          rp.hurtTimer = 0;
          setSteveHurtFlash(rp.model, false);
          this.game.ui?.addChatMessage(msg.r ? `${rp.name}: ${msg.r}` : `${rp.name} died!`);
        } else if (!nowDead && wasDead) {
          rp._snapNextPos = true;
        }
      }
      return;
    }

    // Apply world mutations with broadcast suppressed so no echo loops occur!
    this._suppressBroadcast = true;
    try {
      const w = this.game.world;
      if (type === 'blk') {
        w.setBlock(msg.x, msg.y, msg.z, msg.b, true);
      } else if (type === 'door') {
        if (msg.op === 'place') {
          w.placeDoor(msg.x, msg.y, msg.z, msg.b, msg.f);
        } else {
          const key = `${msg.x},${msg.y},${msg.z}`;
          const st = w.doorStates.get(key) || { facing: msg.f || 0, open: false };
          st.open = Boolean(msg.o);
          w.doorStates.set(key, st);
          w.markDirty(msg.x >> 4, msg.z >> 4);
        }
      } else if (type === 'gate') {
        if (msg.op === 'place') {
          w.placeFenceGate(msg.x, msg.y, msg.z, msg.b, msg.f);
        } else {
          const key = `${msg.x},${msg.y},${msg.z}`;
          const st = w.gateStates.get(key) || { facing: msg.f || 0, open: false };
          st.facing = msg.f & 3;
          st.open = Boolean(msg.o);
          w.gateStates.set(key, st);
          w.markDirty(msg.x >> 4, msg.z >> 4);
        }
      } else if (type === 'stair') {
        w.placeStair(msg.x, msg.y, msg.z, msg.b, msg.f, msg.hf ? 'top' : 'bottom', true);
      } else if (type === 'lad') {
        const key = `${msg.x},${msg.y},${msg.z}`;
        w.ladderStates.set(key, msg.f & 3);
        if (msg.wl) w.waterloggedLadders.add(key);
        else w.waterloggedLadders.delete(key);
        w.setBlock(msg.x, msg.y, msg.z, BLOCK.LADDER, true);
      } else if (type === 'fluid') {
        if (msg.op === 'place') w.placeFluidSource(msg.x, msg.y, msg.z, msg.b);
        else w.pickupFluidSource(msg.x, msg.y, msg.z);
      } else if (type === 'tnt') {
        this.game.igniteTnt(msg.x, msg.y, msg.z, msg.fu || 2.6);
      } else if (type === 'chest' && msg.k && Array.isArray(msg.s)) {
        w.chests.set(msg.k, msg.s);
        if (this.game.ui?.activeModal === 'chest-modal' && this.game.ui.activeChestPos === msg.k) {
          this.game.ui.renderChestModal();
        }
      }
    } finally {
      this._suppressBroadcast = false;
    }
  }

  // --- REMOTE 3D PLAYER MANAGEMENT ---
  _upsertRemotePlayer(id, name, isHost = false, data = null) {
    let rp = this.remotePlayers.get(id);
    if (!rp) {
      const incomingSkin = data?.sk || 'steve';
      const displayName = name || 'Player';
      const model = createSteveModel(this.game.textures, incomingSkin);
      const nametag = createPlayerNametag(displayName, isHost);
      model.root.add(nametag.sprite);
      const fireGroup = createSteveFireGroup(this.game.textures);
      model.root.add(fireGroup);

      const sx = data?.x ?? (this.game.player ? this.game.player.pos.x + 1.5 : 0.5);
      const sy = data?.y ?? (this.game.player ? this.game.player.pos.y : 48);
      const sz = data?.z ?? (this.game.player ? this.game.player.pos.z + 1.5 : 0.5);
      model.root.position.set(sx, sy, sz);

      if (this.game.scene) this.game.scene.add(model.root);

      const startDead = typeof data?.f === 'number' ? Boolean(data.f & F_DEAD) : Boolean(data?.dd);
      rp = {
        id,
        name: displayName,
        isHost,
        skinId: incomingSkin,
        model,
        nametag,
        fireGroup,
        pos: new THREE.Vector3(sx, sy, sz),
        targetPos: new THREE.Vector3(sx, sy, sz),
        yaw: data?.yw ?? 0,
        targetYaw: data?.yw ?? 0,
        pitch: data?.pt ?? 0,
        targetPitch: data?.pt ?? 0,
        heldId: '',
        armorIds: ['', '', '', ''],
        _armorSig: '|||',
        swingAnim: 0,
        isEating: false,
        eatTime: 0,
        sneaking: false,
        flying: false,
        inWater: false,
        burning: false,
        hurtTimer: 0,
        flinchTimer: 0,
        dead: startDead,
        _snapNextPos: false,
        walkPhase: 0,
        hp: 20,
        lastSeen: performance.now()
      };
      model.root.visible = !rp.dead;
      if (nametag.sprite) nametag.sprite.visible = !rp.dead;
      this.remotePlayers.set(id, rp);
      this._emitState();
    }

    rp.lastSeen = performance.now();
    if (name && name !== rp.name) {
      rp.name = name;
      updatePlayerNametag(rp.nametag, name, rp.isHost);
      this._emitState();
    }

    if (data) {
      if (data.sk && data.sk !== rp.skinId) {
        rp.skinId = data.sk;
        updateSteveSkin(rp.model, data.sk);
      }

      let flags = -1;
      if (typeof data.f === 'number') flags = data.f;

      const nextDead = flags >= 0 ? Boolean(flags & F_DEAD) : (typeof data.dd === 'number' ? Boolean(data.dd) : rp.dead);
      if (nextDead !== rp.dead) {
        if (!nextDead && rp.dead) rp._snapNextPos = true;
        rp.dead = nextDead;
        rp.model.root.visible = !nextDead;
        if (rp.nametag?.sprite) rp.nametag.sprite.visible = !nextDead;
      }
      if (typeof data.x === 'number') {
        rp.targetPos.set(data.x, data.y, data.z);
        if (rp._snapNextPos) {
          rp.pos.copy(rp.targetPos);
          rp._snapNextPos = false;
        }
      }
      if (typeof data.yw === 'number') rp.targetYaw = data.yw;
      if (typeof data.pt === 'number') rp.targetPitch = data.pt;
      if (typeof data.h === 'string' && data.h !== rp.heldId) {
        rp.heldId = data.h;
        updateHeldItemRig(rp.model.heldRig, rp.heldId ? ITEMS[rp.heldId] : null, this.game.textures, false);
      }
      if (Array.isArray(data.ar)) {
        const sig = data.ar.join('|');
        if (sig !== rp._armorSig) {
          rp._armorSig = sig;
          rp.armorIds = data.ar;
          updateSteveArmor(rp.model, data.ar.map((aid) => (aid ? { id: aid } : null)));
        }
      }
      if (flags >= 0) {
        if ((flags & F_SWING) && rp.swingAnim < 0.2) rp.swingAnim = 1.0;
        if ((flags & F_HURT) && rp.hurtTimer < 0.15) rp.hurtTimer = 0.36;
        rp.isEating = Boolean(flags & F_EAT);
        rp.sneaking = Boolean(flags & F_SNEAK);
        rp.flying = Boolean(flags & F_FLY);
        rp.inWater = Boolean(flags & F_WATER);
        rp.burning = Boolean(flags & F_BURN);
      }
      if (typeof data.hp === 'number') rp.hp = data.hp;
    }
    return rp;
  }

  _removeRemotePlayer(id, broadcastLeave = false) {
    const rp = this.remotePlayers.get(id);
    if (!rp) return;
    const pname = rp.name;
    this._disposeRemotePlayer(rp);
    this.remotePlayers.delete(id);
    if (broadcastLeave) {
      this._broadcastRaw({ t: 'leave', id });
    }
    this.game?.ui?.addChatMessage(`${pname} left the world.`);
    this._emitState();
  }

  // Raycast remote players for hover nametags & PvP hits (ignores players currently on Death Screen!)
  raycastRemotePlayer(origin, dir, maxDist = 5.0) {
    if (this.remotePlayers.size === 0) return null;
    let best = null;
    let bestDist = maxDist;
    for (const rp of this.remotePlayers.values()) {
      if (rp.dead) continue;
      const cx = rp.pos.x;
      const cy = rp.pos.y + 0.95;
      const cz = rp.pos.z;
      const dx = cx - origin.x;
      const dy = cy - origin.y;
      const dz = cz - origin.z;
      const proj = dx * dir.x + dy * dir.y + dz * dir.z;
      if (proj < 0.15 || proj > bestDist) continue;
      const px = origin.x + dir.x * proj - cx;
      const py = origin.y + dir.y * proj - cy;
      const pz = origin.z + dir.z * proj - cz;
      if (px * px + pz * pz <= 0.46 && Math.abs(py) <= 1.05) {
        bestDist = proj;
        best = { player: rp, dist: proj };
      }
    }
    return best;
  }

  _sendLocalPose(dt) {
    this._sendTimer += dt;
    if (this._sendTimer < POSE_SEND_INTERVAL) return;
    // Keep a steady cadence (carry the remainder) without bursting after a long frame stall.
    this._sendTimer = Math.min(this._sendTimer - POSE_SEND_INTERVAL, POSE_SEND_INTERVAL);
    this._keepaliveAccum += POSE_SEND_INTERVAL;
    this._appearanceAccum += POSE_SEND_INTERVAL;

    const p = this.game.player;
    const x = r2(p.pos.x), y = r2(p.pos.y), z = r2(p.pos.z);
    const yw = r2(p.yaw), pt = r2(p.pitch);
    const f = this._localFlags();
    const hp = Math.round(p.hp);

    const ap = this._localAppearance();
    const apSig = `${this.playerName}|${ap.sk}|${ap.h}|${ap.ar.join(',')}`;
    const appearanceChanged = apSig !== this._lastAppearanceSig;

    const last = this._lastPose;
    const poseChanged = !last ||
      last[0] !== x || last[1] !== y || last[2] !== z ||
      last[3] !== yw || last[4] !== pt || last[5] !== f || last[6] !== hp;

    if (!poseChanged && !appearanceChanged && this._keepaliveAccum < POSE_KEEPALIVE) return;

    const includeAppearance = appearanceChanged || this._appearanceAccum >= APPEARANCE_RESEND;
    const pkt = { t: 'p', id: this.localId, x, y, z, yw, pt, f, hp };
    if (includeAppearance) {
      pkt.name = this.playerName;
      pkt.isHost = this.role === 'host';
      pkt.sk = ap.sk;
      pkt.h = ap.h;
      pkt.ar = ap.ar;
      this._appearanceAccum = 0;
      this._lastAppearanceSig = apSig;
    }
    if (last) {
      last[0] = x; last[1] = y; last[2] = z; last[3] = yw; last[4] = pt; last[5] = f; last[6] = hp;
    } else {
      this._lastPose = [x, y, z, yw, pt, f, hp];
    }
    this._keepaliveAccum = 0;

    if (this.role === 'host') this._broadcastRaw(pkt);
    else this._sendToHost(pkt);
  }

  // Called once per frame in BlockCraftGame.loop()
  update(dt) {
    if (!this.isActive() || !this.game || !this.game.player) return;
    if (this.role === 'guest' && !this._worldReady) return;

    // 1. Send compact local pose update (only when something changed, plus a keepalive)
    this._sendLocalPose(dt);

    // 2. Host syncs time & weather every 3 seconds
    if (this.role === 'host' && this.game.sky) {
      this._timeSyncTimer += dt;
      if (this._timeSyncTimer >= 3.0) {
        this._timeSyncTimer = 0;
        this._broadcastRaw({
          t: 'time',
          tm: Math.round(this.game.sky.time * 10000) / 10000,
          dc: this.game.sky.dayCount,
          w: this.game.sky.weather
        });
      }
    }

    const now = performance.now();

    // Drop half-received chunked payloads whose sender went quiet
    if (this._chunkBufs.size > 0) {
      for (const [k, buf] of this._chunkBufs) {
        if (now - buf.at > 30000) this._chunkBufs.delete(k);
      }
    }

    if (this.remotePlayers.size === 0) return;

    // 3. Smoothly interpolate & animate all remote 3D Steves (including 3D held items, swing, eating & burning!)
    const posLerp = Math.min(1, dt * 15);
    const rotLerp = Math.min(1, dt * 16);
    const limbLerp = Math.min(1, dt * 16);
    const cam = this.game.camera;

    for (const [id, rp] of this.remotePlayers) {
      // Stale timeout guard (no heartbeat)
      if (now - rp.lastSeen > STALE_PLAYER_MS) {
        this._removeRemotePlayer(id, this.role === 'host');
        continue;
      }

      // Keep dead players completely hidden out of view while on the Death Screen!
      if (rp.dead) {
        rp.model.root.visible = false;
        if (rp.nametag?.sprite) rp.nametag.sprite.visible = false;
        continue;
      }
      rp.model.root.visible = true;

      const prevX = rp.pos.x;
      const prevZ = rp.pos.z;
      if (rp.pos.distanceToSquared(rp.targetPos) > 144) {
        rp.pos.copy(rp.targetPos);
      } else {
        rp.pos.lerp(rp.targetPos, posLerp);
      }
      rp.yaw = lerpAngle(rp.yaw, rp.targetYaw, rotLerp);
      rp.pitch += (rp.targetPitch - rp.pitch) * rotLerp;

      const mdx = rp.pos.x - prevX;
      const mdz = rp.pos.z - prevZ;
      const horizSpeed = dt > 0.0001 ? Math.sqrt(mdx * mdx + mdz * mdz) / dt : 0;
      if (horizSpeed > 0.25) {
        rp.walkPhase += dt * Math.min(14, 8.5 + horizSpeed * 0.75);
      }
      if (rp.swingAnim > 0) rp.swingAnim = Math.max(0, rp.swingAnim - dt * 5.8);
      if (rp.hurtTimer > 0) rp.hurtTimer = Math.max(0, rp.hurtTimer - dt);
      if (rp.flinchTimer > 0) rp.flinchTimer = Math.max(0, rp.flinchTimer - dt);
      if (rp.isEating) rp.eatTime += dt;
      else rp.eatTime = 0;

      const pm = rp.model;
      setSteveHurtFlash(pm, rp.hurtTimer > 0);
      pm.root.position.copy(rp.pos);
      pm.root.rotation.y = rp.yaw;
      // Subtle classic Minecraft hit-flinch tilt when struck!
      pm.bodyPivot.rotation.z = rp.flinchTimer > 0 ? Math.sin((rp.flinchTimer / 0.24) * Math.PI) * 0.22 : 0;
      pm.headPivot.rotation.x = rp.pitch * 0.85;

      // Distance-scaled nametag; players far away also skip limb animation entirely.
      const dist = cam ? cam.position.distanceTo(rp.pos) : 0;
      if (rp.nametag?.sprite && cam) {
        const visibleDist = dist < 72;
        rp.nametag.sprite.visible = visibleDist;
        if (visibleDist) {
          const s = Math.max(0.88, Math.min(2.2, 0.78 + dist * 0.042));
          rp.nametag.sprite.scale.set(1.12 * s, 0.21 * s, 1);
          rp.nametag.sprite.position.y = 2.08 + Math.min(0.35, dist * 0.008);
          rp.nametag.mat.opacity = dist > 26 ? 0.65 : 0.95;
        }
      }
      if (dist > 96) continue;

      const targetBodyPitch = rp.flying ? -0.35 : (rp.inWater && horizSpeed > 0.4 ? -0.55 : (rp.sneaking ? -0.25 : 0));
      pm.bodyPivot.rotation.x += (targetBodyPitch - pm.bodyPivot.rotation.x) * Math.min(1, dt * 12);
      pm.bodyPivot.position.y = rp.sneaking ? -0.14 : 0;

      const legSwing = horizSpeed > 0.25
        ? Math.sin(rp.walkPhase) * Math.min(0.85, 0.45 + horizSpeed * 0.07)
        : (rp.inWater ? Math.sin(now * 0.01) * 0.42 : 0);
      pm.leftLeg.rotation.x += (legSwing - pm.leftLeg.rotation.x) * limbLerp;
      pm.rightLeg.rotation.x += (-legSwing - pm.rightLeg.rotation.x) * limbLerp;
      pm.leftArm.rotation.x += (-legSwing * 0.85 - pm.leftArm.rotation.x) * limbLerp;

      const swingArc = Math.sin(rp.swingAnim * Math.PI);
      const rightArmTarget = rp.isEating
        ? (1.28 + Math.sin(rp.eatTime * 19.0) * 0.22)
        : (rp.swingAnim > 0
            ? (1.45 - swingArc * 1.9)
            : (legSwing * 0.85 + (rp.heldId ? 0.28 : 0)));
      pm.rightArm.rotation.x += (rightArmTarget - pm.rightArm.rotation.x) * Math.min(1, dt * 20);
      pm.rightArm.rotation.z += ((rp.isEating ? -0.32 : 0) - pm.rightArm.rotation.z) * limbLerp;

      if (rp.fireGroup) {
        rp.fireGroup.visible = rp.burning;
        if (rp.burning) {
          const ft = now * 0.015;
          rp.fireGroup.scale.set(
            0.96 + Math.sin(ft * 1.9) * 0.08,
            0.92 + Math.cos(ft * 2.6) * 0.14,
            0.96 + Math.cos(ft * 2.1) * 0.08
          );
        }
      }
    }
  }
}
