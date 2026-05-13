/**
 * Controls — keyboard + virtual joystick + gamepad input.
 * All state is normalised into simple boolean flags so the truck
 * doesn't need to know where the input came from.
 */
export class Controls {
    constructor() {
        this.forward  = false;
        this.backward = false;
        this.left     = false;
        this.right    = false;
        this.brake    = false;
        this.boost    = false;
        this.flip     = false;

        // Touch joystick raw axes (-1 … 1)
        this._joyX = 0;
        this._joyY = 0;

        this._keyMap = {};
        this._setupKeyboard();
        this._gamepadIndex = null;
    }

    // ----------------------------------------------------------------
    // Keyboard
    // ----------------------------------------------------------------
    _setupKeyboard() {
        window.addEventListener('keydown', (e) => {
            this._keyMap[e.code] = true;
            this._syncKeys();
            // Prevent page scroll on arrow keys / space
            if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) {
                e.preventDefault();
            }
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
        this.brake    = !!(k['Space']);
        this.boost    = !!(k['ShiftLeft']  || k['ShiftRight']);
    }

    // ----------------------------------------------------------------
    // Virtual Joystick (touch)
    // ----------------------------------------------------------------
    setupJoystick(baseEl, knobEl) {
        const MAX_DIST = 46; // pixels from centre
        let active = false;
        let startX = 0, startY = 0;

        const getTouch = (e) => {
            const t = e.touches[0] || e.changedTouches[0];
            return { x: t.clientX, y: t.clientY };
        };

        const onStart = (e) => {
            e.preventDefault();
            active = true;
            const p = getTouch(e);
            startX = p.x; startY = p.y;
        };

        const onMove = (e) => {
            e.preventDefault();
            if (!active) return;
            const p = getTouch(e);
            let dx = p.x - startX;
            let dy = p.y - startY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > MAX_DIST) {
                dx = (dx / dist) * MAX_DIST;
                dy = (dy / dist) * MAX_DIST;
            }
            knobEl.style.transform = `translate(${dx}px,${dy}px)`;
            this._joyX = dx / MAX_DIST;
            this._joyY = dy / MAX_DIST;
            this._syncJoy();
        };

        const onEnd = (e) => {
            e.preventDefault();
            active = false;
            knobEl.style.transform = 'translate(0,0)';
            this._joyX = 0; this._joyY = 0;
            this._syncJoy();
        };

        baseEl.addEventListener('touchstart',  onStart, { passive: false });
        baseEl.addEventListener('touchmove',   onMove,  { passive: false });
        baseEl.addEventListener('touchend',    onEnd,   { passive: false });
        baseEl.addEventListener('touchcancel', onEnd,   { passive: false });
    }

    _syncJoy() {
        // Joystick overrides keyboard directional state when active
        const DEAD = 0.2;
        this.forward  = this._joyY < -DEAD;
        this.backward = this._joyY >  DEAD;
        this.left     = this._joyX < -DEAD;
        this.right    = this._joyX >  DEAD;
    }

    // ----------------------------------------------------------------
    // Action buttons (Boost, Flip) — wired from UI
    // ----------------------------------------------------------------
    setupActionButtons(boostEl, flipEl) {
        const hold = (el, flag) => {
            const set = (v) => { this[flag] = v; };
            el.addEventListener('touchstart',  (e) => { e.preventDefault(); set(true);  }, { passive: false });
            el.addEventListener('touchend',    (e) => { e.preventDefault(); set(false); }, { passive: false });
            el.addEventListener('touchcancel', (e) => { e.preventDefault(); set(false); }, { passive: false });
            el.addEventListener('mousedown', () => set(true));
            el.addEventListener('mouseup',   () => set(false));
        };
        hold(boostEl, 'boost');
        hold(flipEl,  'flip');
    }

    // ----------------------------------------------------------------
    // Gamepad polling (called each frame)
    // ----------------------------------------------------------------
    pollGamepad() {
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (let i = 0; i < pads.length; i++) {
            const gp = pads[i];
            if (!gp) continue;
            // Left stick or d-pad
            const lx = gp.axes[0] || 0;
            const ly = gp.axes[1] || 0;
            const DEAD = 0.2;
            if (Math.abs(lx) > DEAD || Math.abs(ly) > DEAD) {
                this.forward  = ly < -DEAD;
                this.backward = ly >  DEAD;
                this.left     = lx < -DEAD;
                this.right    = lx >  DEAD;
            }
            // A / Cross = boost, B / Circle = brake
            if (gp.buttons[0]) this.boost  = gp.buttons[0].pressed;
            if (gp.buttons[1]) this.brake  = gp.buttons[1].pressed;
            if (gp.buttons[2]) this.flip   = gp.buttons[2].pressed;
            break;
        }
    }
}
