// Unified iPad Multi-Touch + Desktop Keyboard/Mouse Controls
import { DEFAULT_KEYBINDS } from './storage.js';

export class ControlManager {
  constructor(domCanvas, sound) {
    this.canvas = domCanvas;
    this.sound = sound;
    this.enabled = false; // true only during active gameplay (no modal open)
    this.rebinding = false; // true while Settings keybind capture is listening
    this.sensitivity = 1.0;
    this.controlStyle = 'joystick'; // 'joystick' | 'dpad'
    this.keybinds = { ...DEFAULT_KEYBINDS };

    this.input = {
      moveForward: 0,
      moveRight: 0,
      jump: false,
      sneak: false,
      sprint: false,
      breaking: false,
      using: false,
      lookDeltaX: 0,
      lookDeltaY: 0
    };

    // Callbacks
    this.onPlaceOrUse = null;
    this.onTapAttack = null;
    this.onToggleFly = null;
    this.onHotbarSelect = null;
    this.onOpenInventory = null;
    this.onOpenPause = null;
    this.onOpenChat = null;
    this.onToggleCamera = null;
    this.onDropItem = null;

    // State
    this.keys = new Set();
    this.joyTouchId = null;
    this.joyOrigin = { x: 0, y: 0 };
    this.joyVec = { x: 0, y: 0 };
    this.joySprint = false;

    this.dpadDirs = new Set();
    this.dpadSprint = false;

    this.lookTouchId = null;
    this.lookLast = { x: 0, y: 0 };

    this.touchSneakToggle = false;
    this.touchSneakHeld = false;
    this.touchSprintToggle = false;
    this.touchJumpHeld = false;
    this.touchBreakHeld = false;
    this.touchPlaceHeld = false;
    this.mousePlaceHeld = false;
    this._placeRepeatTimer = null;
    this.isFlying = false;
    this.lastJumpTap = 0;

    this.bindTouchControls();
    this.bindKeyboardMouse();
  }

  setKeybinds(kb) {
    this.keybinds = { ...DEFAULT_KEYBINDS, ...(kb || {}) };
    this.keys.clear();
  }

  setControlStyle(style) {
    this.controlStyle = style;
    const joy = document.getElementById('joystick-base');
    const dpad = document.getElementById('dpad-container');
    if (style === 'dpad') {
      joy.classList.add('hidden');
      dpad.classList.remove('hidden');
    } else {
      joy.classList.remove('hidden');
      dpad.classList.add('hidden');
    }
  }

  setShowTouch(show) {
    const tc = document.getElementById('touch-controls');
    tc.classList.toggle('hidden', !show);
  }

  resetInputs() {
    this.keys.clear();
    this.joyTouchId = null;
    this.joyVec = { x: 0, y: 0 };
    this.joySprint = false;
    this.dpadDirs.clear();
    this.lookTouchId = null;
    this.touchJumpHeld = false;
    this.touchSneakHeld = false;
    this.touchBreakHeld = false;
    this.touchPlaceHeld = false;
    this.mousePlaceHeld = false;
    if (this._placeRepeatTimer) {
      clearInterval(this._placeRepeatTimer);
      this._placeRepeatTimer = null;
    }
    this.input.moveForward = 0;
    this.input.moveRight = 0;
    this.input.jump = false;
    this.input.breaking = false;
    this.input.using = false;
    this.input.lookDeltaX = 0;
    this.input.lookDeltaY = 0;
    const knob = document.getElementById('joystick-knob');
    if (knob) knob.style.transform = 'translate(0px, 0px)';
    const sprintRing = document.getElementById('joystick-sprint-ring');
    if (sprintRing) sprintRing.classList.remove('active');
    const joyBase = document.getElementById('joystick-base');
    if (joyBase) joyBase.classList.remove('sprinting');
  }

  setFlyingState(flying) {
    this.isFlying = Boolean(flying);
    if (this.isFlying && this.touchSneakToggle) {
      this.touchSneakToggle = false;
      const btnSneak = document.getElementById('btn-sneak');
      if (btnSneak) btnSneak.classList.remove('active');
    }
  }

  bindTouchControls() {
    const joyBase = document.getElementById('joystick-base');
    const joyKnob = document.getElementById('joystick-knob');
    const sprintRing = document.getElementById('joystick-sprint-ring');

    const updateJoy = (clientX, clientY) => {
      const rect = joyBase.getBoundingClientRect();
      const maxR = Math.max(36, rect.width * 0.34);
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let dx = clientX - cx;
      let dy = clientY - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > maxR) {
        dx = (dx / dist) * maxR;
        dy = (dy / dist) * maxR;
      }
      joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
      const dead = 7;
      this.joyVec.x = Math.abs(dx) < dead ? 0 : dx / maxR;
      this.joyVec.y = Math.abs(dy) < dead ? 0 : -dy / maxR;
      this.joySprint = this.joyVec.y > 0.84 && Math.abs(this.joyVec.x) < 0.48;
      if (sprintRing) sprintRing.classList.toggle('active', this.joySprint);
      joyBase.classList.toggle('sprinting', this.joySprint);
    };

    joyBase.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.sound.unlock();
      if (this.joyTouchId !== null) return;
      const t = e.changedTouches[0];
      this.joyTouchId = t.identifier;
      updateJoy(t.clientX, t.clientY);
    }, { passive: false });

    joyBase.addEventListener('touchmove', (e) => {
      e.preventDefault();
      e.stopPropagation();
      for (const t of e.changedTouches) {
        if (t.identifier === this.joyTouchId) {
          updateJoy(t.clientX, t.clientY);
          break;
        }
      }
    }, { passive: false });

    const endJoy = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.joyTouchId) {
          this.joyTouchId = null;
          this.joyVec = { x: 0, y: 0 };
          this.joySprint = false;
          joyKnob.style.transform = 'translate(0px, 0px)';
          if (sprintRing) sprintRing.classList.remove('active');
          joyBase.classList.remove('sprinting');
          break;
        }
      }
    };
    joyBase.addEventListener('touchend', endJoy, { passive: false });
    joyBase.addEventListener('touchcancel', endJoy, { passive: false });

    // D-Pad buttons
    document.querySelectorAll('.dpad-btn').forEach((btn) => {
      const dir = btn.dataset.dir;
      let activeTid = null;
      const start = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.sound.unlock();
        if (e.changedTouches && e.changedTouches.length > 0) {
          if (activeTid !== null) return;
          activeTid = e.changedTouches[0].identifier;
        }
        if (dir === 'sprint') {
          this.dpadSprint = !this.dpadSprint;
          btn.classList.toggle('active', this.dpadSprint);
        } else {
          this.dpadDirs.add(dir);
          btn.classList.add('active');
        }
      };
      const end = (e) => {
        if (e.changedTouches) {
          let match = false;
          for (const t of e.changedTouches) {
            if (t.identifier === activeTid) { match = true; break; }
          }
          if (!match) return;
          activeTid = null;
        }
        e.preventDefault();
        if (dir !== 'sprint') {
          this.dpadDirs.delete(dir);
          btn.classList.remove('active');
        }
      };
      btn.addEventListener('touchstart', start, { passive: false });
      btn.addEventListener('touchend', end, { passive: false });
      btn.addEventListener('touchcancel', end, { passive: false });
      btn.addEventListener('mousedown', start);
      btn.addEventListener('mouseup', end);
      btn.addEventListener('mouseleave', end);
    });

    // Right Action Buttons
    const btnJump = document.getElementById('btn-jump');
    const btnSneak = document.getElementById('btn-sneak');
    const btnSprint = document.getElementById('btn-sprint');
    const btnBreak = document.getElementById('btn-break');
    const btnPlace = document.getElementById('btn-place');
    const btnFly = document.getElementById('btn-fly');

    const bindHold = (el, onDown, onUp) => {
      if (!el) return;
      let usingTouch = false;
      let activeTid = null;
      el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        usingTouch = true;
        this.sound.unlock();
        if (activeTid !== null) return;
        activeTid = e.changedTouches[0].identifier;
        el.classList.add('active');
        onDown();
      }, { passive: false });
      const tEnd = (e) => {
        let match = false;
        for (const t of e.changedTouches) {
          if (t.identifier === activeTid) { match = true; break; }
        }
        if (!match) return;
        activeTid = null;
        e.preventDefault();
        el.classList.remove('active');
        onUp();
      };
      el.addEventListener('touchend', tEnd, { passive: false });
      el.addEventListener('touchcancel', tEnd, { passive: false });
      el.addEventListener('mousedown', (e) => {
        if (usingTouch) return;
        e.preventDefault();
        this.sound.unlock();
        el.classList.add('active');
        onDown();
      });
      const mEnd = () => {
        if (usingTouch) return;
        el.classList.remove('active');
        onUp();
      };
      el.addEventListener('mouseup', mEnd);
      el.addEventListener('mouseleave', mEnd);
    };

    bindHold(
      btnJump,
      () => {
        const now = performance.now();
        if (now - this.lastJumpTap < 300) {
          if (this.onToggleFly) this.onToggleFly();
        }
        this.lastJumpTap = now;
        this.touchJumpHeld = true;
      },
      () => {
        this.touchJumpHeld = false;
      }
    );

    bindHold(
      btnSneak,
      () => {
        if (this.isFlying) {
          this.touchSneakHeld = true;
          btnSneak.classList.add('active');
        } else {
          this.touchSneakToggle = !this.touchSneakToggle;
          btnSneak.classList.toggle('active', this.touchSneakToggle);
        }
      },
      () => {
        if (this.isFlying) {
          this.touchSneakHeld = false;
          btnSneak.classList.remove('active');
        } else {
          btnSneak.classList.toggle('active', this.touchSneakToggle);
        }
      }
    );

    if (btnSprint) {
      bindHold(
        btnSprint,
        () => {
          this.touchSprintToggle = !this.touchSprintToggle;
          btnSprint.classList.toggle('active', this.touchSprintToggle);
        },
        () => {
          btnSprint.classList.toggle('active', this.touchSprintToggle);
        }
      );
    }

    if (btnFly) {
      bindHold(
        btnFly,
        () => {
          if (this.onToggleFly) this.onToggleFly();
        },
        () => {
          btnFly.classList.toggle('active', this.isFlying);
        }
      );
    }

    bindHold(
      btnBreak,
      () => {
        this.touchBreakHeld = true;
        if (this.onTapAttack) this.onTapAttack();
      },
      () => {
        this.touchBreakHeld = false;
      }
    );

    bindHold(
      btnPlace,
      () => {
        this.touchPlaceHeld = true;
        if (this.onPlaceOrUse) this.onPlaceOrUse(false);
        if (this._placeRepeatTimer) clearInterval(this._placeRepeatTimer);
        this._placeRepeatTimer = setInterval(() => {
          if (this.touchPlaceHeld && this.enabled && this.onPlaceOrUse) {
            this.onPlaceOrUse(true);
          }
        }, 220);
      },
      () => {
        this.touchPlaceHeld = false;
        if (this._placeRepeatTimer) {
          clearInterval(this._placeRepeatTimer);
          this._placeRepeatTimer = null;
        }
      }
    );

    // Touch-drag camera look anywhere on the canvas (preventDefault avoids iPad Safari gesture bounce!)
    this.canvas.addEventListener('touchstart', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.sound.unlock();
      for (const t of e.changedTouches) {
        if (this.lookTouchId === null && t.identifier !== this.joyTouchId) {
          this.lookTouchId = t.identifier;
          this.lookLast.x = t.clientX;
          this.lookLast.y = t.clientY;
          break;
        }
      }
    }, { passive: false });

    this.canvas.addEventListener('touchmove', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === this.lookTouchId) {
          const dx = t.clientX - this.lookLast.x;
          const dy = t.clientY - this.lookLast.y;
          this.lookLast.x = t.clientX;
          this.lookLast.y = t.clientY;
          const sens = 0.0052 * this.sensitivity;
          this.input.lookDeltaX += dx * sens;
          this.input.lookDeltaY += dy * sens;
          break;
        }
      }
    }, { passive: false });

    const endLook = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.lookTouchId) {
          this.lookTouchId = null;
          break;
        }
      }
    };
    this.canvas.addEventListener('touchend', endLook, { passive: true });
    this.canvas.addEventListener('touchcancel', endLook, { passive: true });
  }

  bindKeyboardMouse() {
    let lastSpace = 0;

    window.addEventListener('keydown', (e) => {
      if (this.rebinding) return;
      const kb = this.keybinds;

      if (!this.enabled) {
        if ((e.code === 'Escape' || e.code === kb.pause) && this.onOpenPause) this.onOpenPause();
        return;
      }
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;

      if (e.code === kb.jump && !e.repeat) {
        const now = performance.now();
        if (now - lastSpace < 280 && this.onToggleFly) this.onToggleFly();
        lastSpace = now;
      }

      if (e.code === kb.inventory) {
        e.preventDefault();
        if (this.onOpenInventory) this.onOpenInventory();
        return;
      }
      if (e.code === (kb.drop || 'KeyQ')) {
        e.preventDefault();
        if (this.onDropItem) this.onDropItem(Boolean(e.ctrlKey || e.metaKey));
        return;
      }
      if (e.code === kb.chat || e.code === 'Slash') {
        e.preventDefault();
        if (this.onOpenChat) this.onOpenChat();
        return;
      }
      if (e.code === kb.camera || e.code === 'F5') {
        e.preventDefault();
        if (this.onToggleCamera) this.onToggleCamera();
        return;
      }
      if (e.code === kb.pause || e.code === 'Escape') {
        if (this.onOpenPause) this.onOpenPause();
        return;
      }
      if (e.code.startsWith('Digit')) {
        const num = parseInt(e.code.replace('Digit', ''), 10);
        if (num >= 1 && num <= 9 && this.onHotbarSelect) {
          this.onHotbarSelect(num - 1);
        }
      }

      this.keys.add(e.code);
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });

    // Pointer lock for desktop mouse
    this.canvas.addEventListener('click', () => {
      if (!this.enabled) return;
      this.sound.unlock();
      if (document.pointerLockElement !== this.canvas && this.canvas.requestPointerLock) {
        try {
          const p = this.canvas.requestPointerLock();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {}
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement !== this.canvas) return;
      const sens = 0.0022 * this.sensitivity;
      this.input.lookDeltaX += e.movementX * sens;
      this.input.lookDeltaY += e.movementY * sens;
    });

    window.addEventListener('mousedown', (e) => {
      if (!this.enabled || document.pointerLockElement !== this.canvas) return;
      if (e.button === 0) {
        this.input.breaking = true;
        if (this.onTapAttack) this.onTapAttack();
      } else if (e.button === 2) {
        this.mousePlaceHeld = true;
        if (this.onPlaceOrUse) this.onPlaceOrUse(false);
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.input.breaking = false;
      else if (e.button === 2) this.mousePlaceHeld = false;
    });

    window.addEventListener('blur', () => {
      this.mousePlaceHeld = false;
      this.input.breaking = false;
      this.input.using = false;
    });

    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== this.canvas) {
        this.mousePlaceHeld = false;
        if (!this.touchBreakHeld) this.input.breaking = false;
      }
    });

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('wheel', (e) => {
      if (!this.enabled || !this.onHotbarSelect) return;
      this.onHotbarSelect(e.deltaY > 0 ? 'next' : 'prev');
    }, { passive: true });
  }

  poll() {
    let fwd = 0;
    let right = 0;
    const kb = this.keybinds;

    // Keyboard (customizable keybinds + Arrow keys convenience)
    if (this.keys.has(kb.forward) || this.keys.has('ArrowUp')) fwd += 1;
    if (this.keys.has(kb.backward) || this.keys.has('ArrowDown')) fwd -= 1;
    if (this.keys.has(kb.right) || this.keys.has('ArrowRight')) right += 1;
    if (this.keys.has(kb.left) || this.keys.has('ArrowLeft')) right -= 1;

    // Touch Joystick or D-Pad
    if (this.controlStyle === 'joystick') {
      if (Math.abs(this.joyVec.y) > 0.01) fwd = this.joyVec.y;
      if (Math.abs(this.joyVec.x) > 0.01) right = this.joyVec.x;
    } else {
      if (this.dpadDirs.has('up')) fwd = 1;
      if (this.dpadDirs.has('down')) fwd = -1;
      if (this.dpadDirs.has('right')) right = 1;
      if (this.dpadDirs.has('left')) right = -1;
    }

    this.input.moveForward = fwd;
    this.input.moveRight = right;
    this.input.jump = this.keys.has(kb.jump) || this.touchJumpHeld;
    this.input.sneak = this.keys.has(kb.sneak) || (kb.sneak === 'ShiftLeft' && this.keys.has('ShiftRight')) || (this.isFlying ? this.touchSneakHeld : this.touchSneakToggle);
    this.input.sprint = this.keys.has(kb.sprint) || this.joySprint || this.dpadSprint || this.touchSprintToggle;
    if (this.touchBreakHeld) this.input.breaking = true;
    else if (!document.pointerLockElement) this.input.breaking = false;
    this.input.using = this.touchPlaceHeld || (this.mousePlaceHeld && document.pointerLockElement === this.canvas);

    return this.input;
  }
}
