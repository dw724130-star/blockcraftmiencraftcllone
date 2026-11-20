// Unified iPad Multi-Touch + Desktop Keyboard/Mouse Controls

export class ControlManager {
  constructor(domCanvas, sound) {
    this.canvas = domCanvas;
    this.sound = sound;
    this.enabled = false; // true only during active gameplay (no modal open)
    this.sensitivity = 1.0;
    this.controlStyle = 'joystick'; // 'joystick' | 'dpad'

    this.input = {
      moveForward: 0,
      moveRight: 0,
      jump: false,
      sneak: false,
      sprint: false,
      breaking: false,
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
    this.touchSprintToggle = false;
    this.touchJumpHeld = false;
    this.touchBreakHeld = false;
    this.lastJumpTap = 0;

    this.bindTouchControls();
    this.bindKeyboardMouse();
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
    this.touchBreakHeld = false;
    this.input.moveForward = 0;
    this.input.moveRight = 0;
    this.input.jump = false;
    this.input.breaking = false;
    this.input.lookDeltaX = 0;
    this.input.lookDeltaY = 0;
    const knob = document.getElementById('joystick-knob');
    if (knob) knob.style.transform = 'translate(0px, 0px)';
  }

  bindTouchControls() {
    const joyBase = document.getElementById('joystick-base');
    const joyKnob = document.getElementById('joystick-knob');
    const sprintRing = document.getElementById('joystick-sprint-ring');
    const maxR = 46;

    const updateJoy = (clientX, clientY) => {
      const rect = joyBase.getBoundingClientRect();
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
      this.joySprint = this.joyVec.y > 0.85 && Math.abs(this.joyVec.x) < 0.45;
      sprintRing.classList.toggle('active', this.joySprint);
    };

    joyBase.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.sound.unlock();
      if (this.joyTouchId !== null) return;
      const t = e.changedTouches[0];
      this.joyTouchId = t.identifier;
      updateJoy(t.clientX, t.clientY);
    }, { passive: false });

    joyBase.addEventListener('touchmove', (e) => {
      e.preventDefault();
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
          sprintRing.classList.remove('active');
          break;
        }
      }
    };
    joyBase.addEventListener('touchend', endJoy, { passive: false });
    joyBase.addEventListener('touchcancel', endJoy, { passive: false });

    // D-Pad buttons
    document.querySelectorAll('.dpad-btn').forEach((btn) => {
      const dir = btn.dataset.dir;
      const start = (e) => {
        e.preventDefault();
        this.sound.unlock();
        if (dir === 'sprint') {
          this.dpadSprint = !this.dpadSprint;
          btn.classList.toggle('active', this.dpadSprint);
        } else {
          this.dpadDirs.add(dir);
          btn.classList.add('active');
        }
      };
      const end = (e) => {
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

    const bindHold = (el, onDown, onUp) => {
      let usingTouch = false;
      el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        usingTouch = true;
        this.sound.unlock();
        el.classList.add('active');
        onDown();
      }, { passive: false });
      const tEnd = (e) => {
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
        if (now - this.lastJumpTap < 280) {
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
        this.touchSneakToggle = !this.touchSneakToggle;
        btnSneak.classList.toggle('active', this.touchSneakToggle);
      },
      () => {
        // keep toggle visual state
        btnSneak.classList.toggle('active', this.touchSneakToggle);
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
        if (this.onPlaceOrUse) this.onPlaceOrUse();
      },
      () => {}
    );

    // Touch-drag camera look anywhere on the canvas
    this.canvas.addEventListener('touchstart', (e) => {
      if (!this.enabled) return;
      this.sound.unlock();
      for (const t of e.changedTouches) {
        if (this.lookTouchId === null && t.identifier !== this.joyTouchId) {
          this.lookTouchId = t.identifier;
          this.lookLast.x = t.clientX;
          this.lookLast.y = t.clientY;
          break;
        }
      }
    }, { passive: true });

    this.canvas.addEventListener('touchmove', (e) => {
      if (!this.enabled) return;
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
    }, { passive: true });

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
      if (!this.enabled) {
        if (e.code === 'Escape' && this.onOpenPause) this.onOpenPause();
        return;
      }
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;

      if (e.code === 'Space' && !e.repeat) {
        const now = performance.now();
        if (now - lastSpace < 280 && this.onToggleFly) this.onToggleFly();
        lastSpace = now;
      }

      if (e.code === 'KeyE') {
        e.preventDefault();
        if (this.onOpenInventory) this.onOpenInventory();
        return;
      }
      if (e.code === 'KeyT' || e.code === 'Slash') {
        e.preventDefault();
        if (this.onOpenChat) this.onOpenChat();
        return;
      }
      if (e.code === 'KeyV' || e.code === 'F5') {
        e.preventDefault();
        if (this.onToggleCamera) this.onToggleCamera();
        return;
      }
      if (e.code === 'Escape') {
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
        try { this.canvas.requestPointerLock(); } catch {}
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
        if (this.onPlaceOrUse) this.onPlaceOrUse();
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.input.breaking = false;
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

    // Keyboard
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) fwd += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) fwd -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) right += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) right -= 1;

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
    this.input.jump = this.keys.has('Space') || this.touchJumpHeld;
    this.input.sneak = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.touchSneakToggle;
    this.input.sprint = this.keys.has('ControlLeft') || this.keys.has('KeyR') || this.joySprint || this.dpadSprint || this.touchSprintToggle;
    if (this.touchBreakHeld) this.input.breaking = true;
    else if (!document.pointerLockElement) this.input.breaking = false;

    return this.input;
  }
}
