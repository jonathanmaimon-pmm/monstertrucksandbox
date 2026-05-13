/**
 * Controls — keyboard + virtual joystick + gamepad.
 *
 * Key layout (desktop):
 *   W / ↑      = forward
 *   S / ↓      = reverse
 *   A / ←      = steer left
 *   D / →      = steer right
 *   Space      = JUMP
 *   Shift      = BOOST
 *   B / X      = brake
 *   F / R      = flip reset (manual)
 *   Escape / P = pause
 */
export class Controls {
    constructor() {
        this.forward  = false;
        this.backward = false;
        this.left     = false;
        this.right    = false;
        this.brake    = false;
        this.boost    = false;
        this.jump     = false;
        this.flip     = false;
        this.pause    = false;

        this._joyX = 0;
        this._joyY = 0;
        this._keyMap = {};

        this._setupKeyboard();
    }

    // ----------------------------------------------------------------
    // Keyboard
    // ----------------------------------------------------------------
    _setupKeyboard() {
        window.addEventListener('keydown', (e) => {
            this._keyMap[e.code] = true;
            this._syncKeys();
            if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) {
                e.preventDefault();
            }
            // One-shot actions on keydown
            if (e.code === 'Space' && !e.repeat)    this.jump  = true;
            if ((e.code === 'KeyF' || e.code === 'KeyR') && !e.repeat) this.flip = true;
            if ((e.code === 'Escape' || e.code === 'KeyP') && !e.repeat) this.pause = true;
        });

        window.addEventListener('keyup', (e) => {
            this._keyMap[e.code] = false;
            this._syncKeys();
        });
    }

    _syncKeys() {
        const k = this._keyMap;
        this.forward  = !!(k['ArrowUp']    || k['KeyW']);
        this.backward = !!(k['ArrowDown']  || k['KeyS']);
        this.left     = !!(k['ArrowLeft']  || k['KeyA']);
        this.right    = !!(k['ArrowRight'] || k['KeyD']);
        this.brake    = !!(k['KeyB']       || k['KeyX']);
        this.boost    = !!(k['ShiftLeft']  || k['ShiftRight']);
    }

    // ----------------------------------------------------------------
    // Virtual joystick
    // ----------------------------------------------------------------
    setupJoystick(baseEl, knobEl) {
        const MAX = 46;
        let active = false, startX = 0, startY = 0;

        const getT = (e) => {
            const t = e.touches ? e.touches[0] || e.changedTouches[0] : e;
            return { x: t.clientX, y: t.clientY };
        };

        baseEl.addEventListener('touchstart', (e) => {
            e.preventDefault();
            active = true;
            const p = getT(e); startX = p.x; startY = p.y;
        }, { passive: false });

        baseEl.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (!active) return;
            const p = getT(e);
            let dx = p.x - startX, dy = p.y - startY;
            const d = Math.sqrt(dx*dx + dy*dy);
            if (d > MAX) { dx = dx/d*MAX; dy = dy/d*MAX; }
            knobEl.style.transform = `translate(${dx}px,${dy}px)`;
            this._joyX = dx / MAX;
            this._joyY = dy / MAX;
            this._syncJoy();
        }, { passive: false });

        const end = (e) => {
            e.preventDefault();
            active = false;
            knobEl.style.transform = '';
            this._joyX = 0; this._joyY = 0;
            this._syncJoy();
        };
        baseEl.addEventListener('touchend',    end, { passive: false });
        baseEl.addEventListener('touchcancel', end, { passive: false });
    }

    _syncJoy() {
        const D = 0.2;
        this.forward  = this._joyY < -D;
        this.backward = this._joyY >  D;
        this.left     = this._joyX < -D;
        this.right    = this._joyX >  D;
    }

    // ----------------------------------------------------------------
    // Action buttons (touch + mouse)
    // ----------------------------------------------------------------
    setupActionButtons(boostEl, jumpEl, flipEl) {
        const hold = (el, flag) => {
            if (!el) return;
            el.addEventListener('touchstart',  (e) => { e.preventDefault(); this[flag] = true;  }, { passive: false });
            el.addEventListener('touchend',    (e) => { e.preventDefault(); this[flag] = false; }, { passive: false });
            el.addEventListener('touchcancel', (e) => { e.preventDefault(); this[flag] = false; }, { passive: false });
            el.addEventListener('mousedown',  () => this[flag] = true);
            el.addEventListener('mouseup',    () => this[flag] = false);
        };
        hold(boostEl, 'boost');
        hold(flipEl,  'flip');
        // Jump is a one-shot — set true on press, truck.js resets it
        if (jumpEl) {
            jumpEl.addEventListener('touchstart',  (e) => { e.preventDefault(); this.jump = true; }, { passive: false });
            jumpEl.addEventListener('mousedown',   ()  => { this.jump = true; });
        }
    }

    // ----------------------------------------------------------------
    // Gamepad polling (called each frame)
    // ----------------------------------------------------------------
    pollGamepad() {
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (const gp of pads) {
            if (!gp) continue;
            const lx = gp.axes[0] || 0, ly = gp.axes[1] || 0;
            const D = 0.25;
            if (Math.abs(lx) > D || Math.abs(ly) > D) {
                this.forward  = ly < -D;
                this.backward = ly >  D;
                this.left     = lx < -D;
                this.right    = lx >  D;
            }
            if (gp.buttons[0]?.pressed) this.boost = true;
            if (gp.buttons[2]?.pressed && !this._gpJumpPrev) this.jump = true;
            this._gpJumpPrev = gp.buttons[2]?.pressed;
            if (gp.buttons[1]?.pressed) this.brake = true;
            break;
        }
    }
}
