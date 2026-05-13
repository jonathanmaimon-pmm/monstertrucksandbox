/**
 * UI — manages screen transitions, HUD updates, customization state,
 * and wires all button callbacks.
 *
 * game.customization is the single source of truth for truck config:
 *   { name, style, bodyColor, wheelColor }
 */
export class UI {
    constructor(game) {
        this.game = game;

        // Default customization
        game.customization = {
            name:       'MY TRUCK',
            style:      0,          // 0=Classic 1=Sporty 2=Bigfoot
            bodyColor:  '#ff2020',
            wheelColor: '#222222',
        };

        this._currentScreen = 'menu';
        this._stuntTimeout  = null;
        this._pendingArena  = 0;

        this._bindAll();
    }

    // ----------------------------------------------------------------
    // Screen management
    // ----------------------------------------------------------------
    show(name) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const el = document.getElementById(`screen-${name}`);
        if (el) el.classList.add('active');
        this._currentScreen = name;

        // Show/hide mobile controls
        const mc = document.getElementById('mobile-controls');
        if (name === 'hud') {
            mc.classList.add('visible');
        } else {
            mc.classList.remove('visible');
        }
    }

    // ----------------------------------------------------------------
    // HUD
    // ----------------------------------------------------------------
    updateHUD(score, timeLeft, speedMph, truckName) {
        document.getElementById('hud-score').textContent = score.toLocaleString();
        document.getElementById('hud-speed').textContent = Math.round(speedMph);
        document.getElementById('hud-truck-name').textContent = truckName;

        const timerBox = document.getElementById('hud-timer-box');
        const timerEl  = document.getElementById('hud-timer');

        if (timeLeft !== null) {
            timerBox.style.display = '';
            const m = Math.floor(timeLeft / 60);
            const s = Math.floor(timeLeft % 60);
            timerEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
            timerBox.classList.toggle('warning', timeLeft <= 20);
        } else {
            timerBox.style.display = 'none';
        }
    }

    showStunt(text) {
        const el = document.getElementById('stunt-display');
        el.textContent = text;
        el.classList.remove('show');
        // Force reflow
        void el.offsetWidth;
        el.classList.add('show');
        clearTimeout(this._stuntTimeout);
        this._stuntTimeout = setTimeout(() => el.classList.remove('show'), 1600);
    }

    showFlipWarning(secsLeft) {
        const el = document.getElementById('flip-warning');
        if (el) { el.style.display = ''; el.textContent = `⚠️ AUTO FLIP IN ${secsLeft}...`; }
    }

    clearFlipWarning() {
        const el = document.getElementById('flip-warning');
        if (el) el.style.display = 'none';
    }

    showGameOver(score, isTimedMode, breakdown) {
        document.getElementById('gameover-title').textContent =
            isTimedMode ? '⏱ TIME\'S UP!' : '🏁 NICE DRIVING!';
        document.getElementById('final-score').textContent = score.toLocaleString();
        document.getElementById('final-breakdown').innerHTML = breakdown;
        this.show('gameover');
    }

    // ----------------------------------------------------------------
    // Loading bar
    // ----------------------------------------------------------------
    showLoading(cb) {
        this.show('loading');
        const fill = document.getElementById('loading-fill');
        fill.style.width = '0%';
        let p = 0;
        const interval = setInterval(() => {
            p = Math.min(p + Math.random() * 18 + 8, 90);
            fill.style.width = `${p}%`;
        }, 80);
        // Give a brief moment for the repaint, then call cb
        setTimeout(() => {
            clearInterval(interval);
            fill.style.width = '100%';
            setTimeout(cb, 200);
        }, 800);
    }

    // ----------------------------------------------------------------
    // Customization UI
    // ----------------------------------------------------------------
    _bindCustomize() {
        const c = this.game.customization;

        // Name input
        const nameInput = document.getElementById('truck-name-input');
        nameInput.value = c.name;
        nameInput.addEventListener('input', () => {
            c.name = (nameInput.value.trim().toUpperCase() || 'MY TRUCK');
            document.getElementById('preview-name').textContent = c.name;
        });

        // Style buttons
        document.querySelectorAll('.style-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.style-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                c.style = parseInt(btn.dataset.style);
            });
        });

        // Body color
        this._bindColorGrid('body-color-grid', (color) => {
            c.bodyColor = color;
            document.getElementById('preview-truck').style.filter =
                `hue-rotate(${this._hueOffset(color)}deg) saturate(2)`;
        });

        // Wheel color
        this._bindColorGrid('wheel-color-grid', (color) => {
            c.wheelColor = color;
        });
    }

    _bindColorGrid(gridId, onChange) {
        document.querySelectorAll(`#${gridId} .color-swatch`).forEach(swatch => {
            swatch.addEventListener('click', () => {
                document.querySelectorAll(`#${gridId} .color-swatch`).forEach(s => s.classList.remove('active'));
                swatch.classList.add('active');
                onChange(swatch.dataset.color);
            });
        });
    }

    // Very rough hue rotation from hex color for the preview emoji
    _hueOffset(hex) {
        const r = parseInt(hex.slice(1,3), 16);
        const g = parseInt(hex.slice(3,5), 16);
        const b = parseInt(hex.slice(5,7), 16);
        // red baseline → 0°; shift accordingly
        const hue = Math.atan2(Math.sqrt(3) * (g - b), 2*r - g - b) * 180 / Math.PI;
        return hue;
    }

    // ----------------------------------------------------------------
    // Wire all buttons
    // ----------------------------------------------------------------
    _bindAll() {
        const g = this.game;

        // Main menu
        document.getElementById('btn-play').addEventListener('click', () => {
            this.show('arena');
        });
        document.getElementById('btn-customize').addEventListener('click', () => {
            this._bindCustomize();
            this.show('customize');
        });

        // Customize
        document.getElementById('btn-customize-back').addEventListener('click', () => this.show('menu'));
        document.getElementById('btn-customize-done').addEventListener('click', () => {
            const v = document.getElementById('truck-name-input').value.trim().toUpperCase();
            g.customization.name = v || 'MY TRUCK';
            this.show('arena');
        });

        // Arena select
        document.getElementById('btn-arena-back').addEventListener('click', () => this.show('menu'));
        document.querySelectorAll('.arena-card').forEach(card => {
            card.addEventListener('click', () => {
                this._pendingArena = parseInt(card.dataset.arena);
                this.show('mode');
            });
        });

        // Mode select
        document.getElementById('btn-mode-back').addEventListener('click', () => this.show('arena'));
        document.getElementById('btn-freeplay').addEventListener('click', () => {
            this.showLoading(() => g.startGame(this._pendingArena, 'freeplay'));
        });
        document.getElementById('btn-timed').addEventListener('click', () => {
            this.showLoading(() => g.startGame(this._pendingArena, 'timed'));
        });

        // HUD pause
        document.getElementById('btn-pause').addEventListener('click', () => {
            if (g.state === 'playing') g.pause();
        });

        // Pause screen
        document.getElementById('btn-resume').addEventListener('click', () => {
            g.resume();
        });
        document.getElementById('btn-restart').addEventListener('click', () => {
            this.showLoading(() => g.startGame(g.currentArena, g.mode));
        });
        document.getElementById('btn-quit').addEventListener('click', () => {
            g.quit();
            this.show('menu');
        });

        // Game over
        document.getElementById('btn-replay').addEventListener('click', () => {
            this.showLoading(() => g.startGame(g.currentArena, g.mode));
        });
        document.getElementById('btn-to-menu').addEventListener('click', () => {
            g.quit();
            this.show('menu');
        });

        // Mobile action buttons
        const boostBtn = document.getElementById('btn-boost');
        const jumpBtn  = document.getElementById('btn-jump');
        const flipBtn  = document.getElementById('btn-flip');
        if (g.controls) {
            g.controls.setupActionButtons(boostBtn, jumpBtn, flipBtn);
        }

        // Joystick
        const joystickBase = document.getElementById('joystick-base');
        const joystickKnob = document.getElementById('joystick-knob');
        if (g.controls) {
            g.controls.setupJoystick(joystickBase, joystickKnob);
        }

        // Keyboard hint for desktop — add Space = jump to hint text
        const hint = document.querySelector('.menu-controls-hint span');
        if (hint) hint.textContent =
            'Desktop: WASD/Arrows = drive  ·  Space = jump  ·  Shift = boost  ·  Esc = pause';
    }
}
