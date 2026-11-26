import * as THREE from 'three';
import { ITEMS, BLOCK, getBlockDef } from './blocks.js';
import { createSteveModel, updateSteveArmor, updateHeldItemRig, createSteveFireGroup } from './player.js';

// Unambiguous uppercase room code alphabet (no 0/O/1/I confusion!)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PEER_PREFIX = 'bc44mp-';
const RECENT_CODES_KEY = 'blockcraft_recent_mp_codes_v1';
const PLAYER_NAME_KEY = 'blockcraft_mp_name_v1';

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

export function getSavedPlayerName() {
  try {
    const s = localStorage.getItem(PLAYER_NAME_KEY);
    if (s && s.trim()) return s.trim().slice(0, 16);
  } catch {}
  return `Player${Math.floor(100 + Math.random() * 899)}`;
}

export function savePlayerName(name) {
  const clean = String(name || '').trim().slice(0, 16) || 'Player';
  try { localStorage.setItem(PLAYER_NAME_KEY, clean); } catch {}
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

function createNametagSprite(name, isHost = false) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 56;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 56);

  const label = isHost ? `★ ${name}` : name;
  ctx.font = 'bold 26px "Courier New", monospace';
  const tw = Math.min(232, Math.max(88, Math.ceil(ctx.measureText(label).width) + 28));
  const rx = (256 - tw) * 0.5;

  // Translucent Minecraft-style dark name plate
  ctx.fillStyle = 'rgba(10, 14, 22, 0.72)';
  ctx.fillRect(rx, 8, tw, 40);
  ctx.strokeStyle = isHost ? 'rgba(255, 213, 79, 0.85)' : 'rgba(134, 239, 172, 0.75)';
  ctx.lineWidth = 2;
  ctx.strokeRect(rx + 1, 9, tw - 2, 38);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000000';
  ctx.fillText(label, 130, 30);
  ctx.fillStyle = isHost ? '#ffe57f' : '#ffffff';
  ctx.fillText(label, 128, 28);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.9, 0.42, 1);
  sprite.position.set(0, 2.28, 0);
  return { sprite, tex, mat };
}

function lerpAngle(a, b, t) {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

const r2 = (n) => Math.round(n * 100) / 100;

export class MultiplayerManager {
  constructor(game) {
    this.game = game;
    this.role = 'offline'; // 'offline' | 'host' | 'guest'
    this.roomCode = '';
    this.localId = 'p_' + Math.random().toString(36).slice(2, 9);
    this.playerName = getSavedPlayerName();
    this.onlineMode = 'none'; // 'none' | 'online' | 'local'

    this.peer = null;
    this.hostConn = null;        // Guest -> Host PeerJS DataConnection
    this.connections = new Map(); // Host: peerId -> DataConnection
    this.bc = null;              // Same-browser BroadcastChannel fast transport
    this.bcPeers = new Set();    // Peer IDs connected over BroadcastChannel

    this.remotePlayers = new Map(); // peerId -> RemotePlayerState
    this._sendTimer = 0;
    this._timeSyncTimer = 0;
    this._lastSentSig = '';
    this._suppressBroadcast = false;
    this._rayTmp = new THREE.Vector3();
    this._rayTo = new THREE.Vector3();
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
    this.onlineMode = 'local';
    this._lastSentSig = '';

    // 1. Open instant local BroadcastChannel bridge (allows same-browser co-op in <30ms!)
    this._setupBroadcastChannel(this.roomCode);

    // 2. Open WebRTC PeerJS Signaling endpoint for cross-device / internet co-op!
    const PeerCtor = await loadPeerJS();
    if (PeerCtor && this.role === 'host') {
      await new Promise((resolve) => {
        let settled = false;
        const finish = (mode) => {
          if (settled) return;
          settled = true;
          this.onlineMode = mode;
          resolve();
        };
        const timeout = setTimeout(() => finish('local'), 7500);
        try {
          const peerId = PEER_PREFIX + this.roomCode;
          const peer = new PeerCtor(peerId, {
            debug: 0,
            config: {
              iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
              ]
            }
          });
          this.peer = peer;
          peer.on('open', () => {
            clearTimeout(timeout);
            finish('online');
          });
          peer.on('connection', (conn) => {
            this._attachHostPeerConnection(conn);
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
    }

    rememberRoomCode(this.roomCode, this.game.worldMeta?.name || 'Hosted World');
    this._emitState();
    return { code: this.roomCode, onlineMode: this.onlineMode };
  }

  _attachHostPeerConnection(conn) {
    conn.on('open', () => {
      conn.on('data', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        this._handleIncoming(msg, conn.peer, conn);
      });
    });
    const onClose = () => {
      const pid = conn._bcPlayerId || conn.peer;
      this.connections.delete(pid);
      this._removeRemotePlayer(pid, true);
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
    this._lastSentSig = '';

    const report = (msg) => { if (onStatus) onStatus(msg); };
    report(`Connecting to room ${formatRoomCode(code)}...`);

    return new Promise(async (resolve, reject) => {
      let connected = false;
      let done = false;

      const fail = (errMsg) => {
        if (done) return;
        done = true;
        this.disconnect(true);
        reject(new Error(errMsg));
      };

      const onWelcome = async (snapshot) => {
        if (done) return;
        done = true;
        connected = true;
        rememberRoomCode(code, snapshot?.meta?.name || 'Multiplayer World');
        report('World received! Loading terrain...');
        try {
          await this.game.loadMultiplayerWorld(snapshot);
          // Re-attach any remote players from snapshot roster after scene init
          if (Array.isArray(snapshot.players)) {
            for (const p of snapshot.players) {
              if (p.id && p.id !== this.localId) {
                this._upsertRemotePlayer(p.id, p.name, p.isHost, p);
              }
            }
          }
          this._emitState();
          resolve(snapshot);
        } catch (e) {
          this.disconnect(true);
          reject(e);
        }
      };

      this._pendingWelcome = onWelcome;
      const overallTimeout = setTimeout(() => {
        if (!connected) {
          fail(`Could not find world "${formatRoomCode(code)}". Check the code and make sure the host opened Multiplayer World.`);
        }
      }, 13000);

      // 1. Try instant local BroadcastChannel first (connects in <30ms for same-browser testing!)
      this._setupBroadcastChannel(code);
      this._sendBroadcastChannel({ t: 'hello', id: this.localId, name: this.playerName });

      // 2. Simultaneously connect over WebRTC PeerJS for cross-device / internet multiplayer!
      const PeerCtor = await loadPeerJS();
      if (done) { clearTimeout(overallTimeout); return; }
      if (!PeerCtor) {
        report('Checking local room...');
        return;
      }

      report(`Searching online for ${formatRoomCode(code)}...`);
      try {
        const peer = new PeerCtor(undefined, {
          debug: 0,
          config: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' }
            ]
          }
        });
        this.peer = peer;
        peer.on('open', () => {
          if (done) return;
          const hostPeerId = PEER_PREFIX + code;
          const conn = peer.connect(hostPeerId, { reliable: true, serialization: 'json' });
          this.hostConn = conn;
          conn.on('open', () => {
            if (done) return;
            this.onlineMode = 'online';
            report('Connected! Downloading world snapshot...');
            conn.send({ t: 'hello', id: this.localId, name: this.playerName });
          });
          conn.on('data', (msg) => {
            if (!msg || typeof msg !== 'object') return;
            this._handleIncoming(msg, 'host', conn);
          });
          conn.on('close', () => {
            if (connected && this.role === 'guest') {
              this.game.ui?.addChatMessage('Disconnected from host world.');
              this.game.ui?.toast('Host closed the multiplayer world');
              this.disconnect(false);
            }
          });
          conn.on('error', () => {
            if (!connected && !this.bc) {
              clearTimeout(overallTimeout);
              fail(`Unable to reach host "${formatRoomCode(code)}".`);
            }
          });
        });
        peer.on('error', (err) => {
          if (!connected && err && err.type === 'peer-unavailable') {
            // Wait a brief moment in case local BroadcastChannel responds
            setTimeout(() => {
              if (!connected && !done) {
                clearTimeout(overallTimeout);
                fail(`World code "${formatRoomCode(code)}" is not online right now.`);
              }
            }, 900);
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
        if (msg._to && msg._to !== this.localId) return;
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
      try { this.hostConn.close(); } catch {}
      this.hostConn = null;
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
    const wasActive = this.isActive();
    this.role = 'offline';
    this.roomCode = '';
    this.onlineMode = 'none';
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
    if (this.game?.scene && rp.model?.root) {
      this.game.scene.remove(rp.model.root);
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
    const players = [this._buildLocalPlayerPacket()];
    for (const rp of this.remotePlayers.values()) {
      players.push({
        id: rp.id,
        name: rp.name,
        isHost: rp.isHost,
        x: r2(rp.targetPos.x),
        y: r2(rp.targetPos.y),
        z: r2(rp.targetPos.z),
        yw: r2(rp.targetYaw),
        pt: r2(rp.targetPitch),
        h: rp.heldId,
        ar: rp.armorIds
      });
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
      modifiedBlocks: Array.from(w.modifiedBlocks.entries()),
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

  _buildLocalPlayerPacket() {
    const p = this.game.player;
    const inv = this.game.inventory;
    const held = inv ? inv.getHeldDef() : null;
    const armorIds = inv && inv.armor
      ? inv.armor.map((a) => (a && a.id) ? a.id : '')
      : ['', '', '', ''];
    return {
      t: 'p',
      id: this.localId,
      name: this.playerName,
      isHost: this.role === 'host',
      x: r2(p.pos.x),
      y: r2(p.pos.y),
      z: r2(p.pos.z),
      yw: r2(p.yaw),
      pt: r2(p.pitch),
      h: held ? held.id : '',
      ar: armorIds,
      sw: p.swingAnim > 0.25 ? 1 : 0,
      ea: p.isEating ? 1 : 0,
      sn: p.sneaking ? 1 : 0,
      fl: p.flying ? 1 : 0,
      wt: p.inWater ? 1 : 0,
      bn: (p.burnTimer > 0 || p.inLava || p.inFire) ? 1 : 0,
      hp: Math.round(p.hp)
    };
  }

  // --- TRANSPORT SENDERS ---
  _sendToHost(msg) {
    if (this.hostConn && this.hostConn.open) {
      try { this.hostConn.send(msg); } catch {}
    } else if (this.bc) {
      this._sendBroadcastChannel(msg);
    }
  }

  _broadcastRaw(msg, excludeId = null) {
    for (const [pid, conn] of this.connections.entries()) {
      if (pid === excludeId) continue;
      if (conn && conn.open) {
        try { conn.send(msg); } catch {}
      }
    }
    if (this.bc && this.bcPeers.size > 0) {
      for (const pid of this.bcPeers) {
        if (pid === excludeId) continue;
        this._sendBroadcastChannel(msg, pid);
      }
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

  // --- INCOMING PACKET DISPATCHER ---
  _handleIncoming(msg, senderKey, conn = null, viaBc = false) {
    const type = msg.t;

    // 1. Host receives Join handshake
    if (type === 'hello' && this.role === 'host') {
      const pid = msg.id || senderKey;
      const pname = String(msg.name || 'Player').slice(0, 16);
      if (conn) {
        conn._bcPlayerId = pid;
        this.connections.set(pid, conn);
      }
      if (viaBc) {
        this.bcPeers.add(pid);
      }
      const snap = this._buildWorldSnapshot();
      if (conn && conn.open) {
        conn.send(snap);
      } else if (viaBc) {
        this._sendBroadcastChannel(snap, pid);
      }
      // Spawn remote Steve for the new player and notify everyone!
      const pPos = this.game.player ? this.game.player.pos : { x: 0.5, y: 48, z: 0.5 };
      this._upsertRemotePlayer(pid, pname, false, { x: pPos.x + 1.5, y: pPos.y + 0.5, z: pPos.z + 1.5 });
      this._broadcastRaw({ t: 'join', id: pid, name: pname }, pid);
      this.game.ui?.addChatMessage(`${pname} joined the world!`);
      this.game.ui?.toast(`${pname} joined!`);
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
      if (msg.id && msg.id !== this.localId) {
        this._upsertRemotePlayer(msg.id, msg.name || 'Player', false);
        this.game.ui?.addChatMessage(`${msg.name || 'Player'} joined the world!`);
        this._emitState();
      }
      return;
    }

    if (type === 'leave') {
      this._removeRemotePlayer(msg.id, false);
      return;
    }

    // Host relays packets to all other connected guests!
    const senderId = msg.id || senderKey;
    if (this.role === 'host' && type !== 'welcome' && type !== 'hello') {
      this._broadcastRaw(msg, senderId);
    }

    // Ignore packets if world isn't mounted yet
    if (!this.game || !this.game.running || !this.game.world) return;

    if (type === 'p') {
      if (senderId === this.localId) return;
      this._upsertRemotePlayer(senderId, msg.name || 'Player', Boolean(msg.isHost), msg);
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
      if (msg.to === this.localId && this.game.player) {
        this.game.player.vel.x += msg.kx || 0;
        this.game.player.vel.y = Math.max(this.game.player.vel.y, msg.ky || 4.0);
        this.game.player.vel.z += msg.kz || 0;
        this.game.player.takeDamage(msg.d || 2, `Slain by ${msg.nm || 'Player'}`);
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
      const model = createSteveModel(this.game.textures);
      const nametag = createNametagSprite(name, isHost);
      model.root.add(nametag.sprite);
      const fireGroup = createSteveFireGroup(this.game.textures);
      model.root.add(fireGroup);

      const sx = data?.x ?? (this.game.player ? this.game.player.pos.x + 1.5 : 0.5);
      const sy = data?.y ?? (this.game.player ? this.game.player.pos.y : 48);
      const sz = data?.z ?? (this.game.player ? this.game.player.pos.z + 1.5 : 0.5);
      model.root.position.set(sx, sy, sz);

      if (this.game.scene) this.game.scene.add(model.root);

      rp = {
        id,
        name,
        isHost,
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
        swingAnim: 0,
        isEating: false,
        eatTime: 0,
        sneaking: false,
        flying: false,
        inWater: false,
        burning: false,
        walkPhase: 0,
        hp: 20,
        lastSeen: performance.now()
      };
      this.remotePlayers.set(id, rp);
      this._emitState();
    }

    rp.lastSeen = performance.now();
    if (name && name !== rp.name) {
      rp.name = name;
      rp.model.root.remove(rp.nametag.sprite);
      rp.nametag.tex?.dispose();
      rp.nametag.mat?.dispose();
      rp.nametag = createNametagSprite(name, rp.isHost);
      rp.model.root.add(rp.nametag.sprite);
    }

    if (data) {
      if (typeof data.x === 'number') rp.targetPos.set(data.x, data.y, data.z);
      if (typeof data.yw === 'number') rp.targetYaw = data.yw;
      if (typeof data.pt === 'number') rp.targetPitch = data.pt;
      if (typeof data.h === 'string' && data.h !== rp.heldId) {
        rp.heldId = data.h;
        updateHeldItemRig(rp.model.heldRig, rp.heldId ? ITEMS[rp.heldId] : null, this.game.textures, false);
      }
      if (Array.isArray(data.ar)) {
        rp.armorIds = data.ar;
        updateSteveArmor(rp.model, data.ar.map((aid) => (aid ? { id: aid } : null)));
      }
      if (data.sw && rp.swingAnim < 0.2) rp.swingAnim = 1.0;
      rp.isEating = Boolean(data.ea);
      rp.sneaking = Boolean(data.sn);
      rp.flying = Boolean(data.fl);
      rp.inWater = Boolean(data.wt);
      rp.burning = Boolean(data.bn);
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

  // Raycast remote players for hover nametags & PvP hits!
  raycastRemotePlayer(origin, dir, maxDist = 4.6) {
    if (this.remotePlayers.size === 0) return null;
    let best = null;
    let bestDist = maxDist;
    for (const rp of this.remotePlayers.values()) {
      const cx = rp.pos.x;
      const cy = rp.pos.y + 0.92;
      const cz = rp.pos.z;
      const dx = cx - origin.x;
      const dy = cy - origin.y;
      const dz = cz - origin.z;
      const proj = dx * dir.x + dy * dir.y + dz * dir.z;
      if (proj < 0.2 || proj > bestDist) continue;
      const px = origin.x + dir.x * proj - cx;
      const py = origin.y + dir.y * proj - cy;
      const pz = origin.z + dir.z * proj - cz;
      if (px * px + pz * pz <= 0.34 && Math.abs(py) <= 1.0) {
        bestDist = proj;
        best = { player: rp, dist: proj };
      }
    }
    return best;
  }

  // Called once per frame in BlockCraftGame.loop()
  update(dt) {
    if (!this.isActive() || !this.game || !this.game.player) return;

    // 1. Send compact local pose update at 18 Hz (only if anything changed, plus keepalive every 0.8s!)
    this._sendTimer += dt;
    if (this._sendTimer >= 0.055) {
      this._sendTimer = 0;
      const pkt = this._buildLocalPlayerPacket();
      const sig = `${pkt.x}|${pkt.y}|${pkt.z}|${pkt.yw}|${pkt.pt}|${pkt.h}|${pkt.ar.join(',')}|${pkt.sw}|${pkt.ea}|${pkt.sn}|${pkt.fl}|${pkt.bn}`;
      this._keepaliveAccum = (this._keepaliveAccum || 0) + 0.055;
      if (sig !== this._lastSentSig || this._keepaliveAccum >= 0.8) {
        this._lastSentSig = sig;
        this._keepaliveAccum = 0;
        if (this.role === 'host') this._broadcastRaw(pkt);
        else this._sendToHost(pkt);
      }
    }

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

    // 3. Smoothly interpolate & animate all remote 3D Steves (including 3D held items, swing, eating & burning!)
    const now = performance.now();
    const posLerp = Math.min(1, dt * 15);
    const rotLerp = Math.min(1, dt * 16);

    for (const [id, rp] of this.remotePlayers.entries()) {
      // Stale timeout guard (25s with no heartbeat)
      if (now - rp.lastSeen > 25000) {
        this._removeRemotePlayer(id, this.role === 'host');
        continue;
      }

      const prevX = rp.pos.x;
      const prevZ = rp.pos.z;
      if (rp.pos.distanceToSquared(rp.targetPos) > 144) {
        rp.pos.copy(rp.targetPos);
      } else {
        rp.pos.lerp(rp.targetPos, posLerp);
      }
      rp.yaw = lerpAngle(rp.yaw, rp.targetYaw, rotLerp);
      rp.pitch = THREE.MathUtils.lerp(rp.pitch, rp.targetPitch, rotLerp);

      const horizSpeed = dt > 0.0001 ? Math.hypot(rp.pos.x - prevX, rp.pos.z - prevZ) / dt : 0;
      if (horizSpeed > 0.25) {
        rp.walkPhase += dt * Math.min(14, 8.5 + horizSpeed * 0.75);
      }
      if (rp.swingAnim > 0) rp.swingAnim = Math.max(0, rp.swingAnim - dt * 5.8);
      if (rp.isEating) rp.eatTime += dt;
      else rp.eatTime = 0;

      const pm = rp.model;
      pm.root.position.copy(rp.pos);
      pm.root.rotation.y = rp.yaw;
      pm.headPivot.rotation.x = rp.pitch * 0.85;

      const targetBodyPitch = rp.flying ? -0.35 : (rp.inWater && horizSpeed > 0.4 ? -0.55 : (rp.sneaking ? -0.25 : 0));
      pm.bodyPivot.rotation.x = THREE.MathUtils.lerp(pm.bodyPivot.rotation.x, targetBodyPitch, Math.min(1, dt * 12));
      pm.bodyPivot.position.y = rp.sneaking ? -0.14 : 0;

      const legSwing = horizSpeed > 0.25
        ? Math.sin(rp.walkPhase) * Math.min(0.85, 0.45 + horizSpeed * 0.07)
        : (rp.inWater ? Math.sin(now * 0.01) * 0.42 : 0);
      pm.leftLeg.rotation.x = THREE.MathUtils.lerp(pm.leftLeg.rotation.x, legSwing, Math.min(1, dt * 16));
      pm.rightLeg.rotation.x = THREE.MathUtils.lerp(pm.rightLeg.rotation.x, -legSwing, Math.min(1, dt * 16));
      pm.leftArm.rotation.x = THREE.MathUtils.lerp(pm.leftArm.rotation.x, -legSwing * 0.85, Math.min(1, dt * 16));

      const swingArc = Math.sin(rp.swingAnim * Math.PI);
      const rightArmTarget = rp.isEating
        ? (1.28 + Math.sin(rp.eatTime * 19.0) * 0.22)
        : (rp.swingAnim > 0
            ? (1.45 - swingArc * 1.9)
            : (legSwing * 0.85 + (rp.heldId ? 0.28 : 0)));
      pm.rightArm.rotation.x = THREE.MathUtils.lerp(pm.rightArm.rotation.x, rightArmTarget, Math.min(1, dt * 20));
      pm.rightArm.rotation.z = THREE.MathUtils.lerp(pm.rightArm.rotation.z, rp.isEating ? -0.32 : 0, Math.min(1, dt * 16));

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
