import * as THREE  from 'three';
import * as CANNON from 'cannon-es';

import { Controls }             from './controls.js';
import { UI }                   from './ui.js';
import { Truck }                from './truck.js';
import { buildArena, cleanupArena } from './arenas.js';

// ====================================================================
// CONSTANTS
// ====================================================================
const TIMED_DURATION    = 120;   // seconds
const AIR_SCORE_RATE    = 200;   // pts/sec airborne
const WHEELIE_SCORE_RATE = 130;
const PHYSICS_STEP      = 1 / 60;

// Camera spring-damper constants
const CAM_SPRING     = 9.0;   // spring stiffness
const CAM_DAMPING    = 6.5;   // damping (critical ≈ 2*sqrt(k))
const CAM_BEHIND     = 14;    // metres behind truck
const CAM_HEIGHT     = 8.5;   // metres above truck
const CAM_YAW_SPEED  = 0.10;  // yaw follow rate

// ====================================================================
// GAME CLASS
// ====================================================================
class Game {
    constructor() {
        this.state        = 'menu';
        this.mode         = 'freeplay';
        this.currentArena = 0;
        this.score        = 0;
        this.timeLeft     = TIMED_DURATION;
        this.customization = {};

        // ---- Controls + UI first (so menu always works) ----
        this.controls = new Controls();
        this.ui = new UI(this);

        // ---- 3D + physics (wrapped) ----
        try {
            this.canvas   = document.getElementById('gameCanvas');
            this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
            this.renderer.shadowMap.enabled = true;
            this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

            this.scene  = new THREE.Scene();
            this.camera = new THREE.PerspectiveCamera(65, 1, 0.3, 600);
            this._resize();

            this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -20, 0) });
            this.world.broadphase = new CANNON.SAPBroadphase(this.world);
            this.world.allowSleep = true;
        } catch (err) {
            console.error('Engine init failed:', err);
            showFatalError(err);
            return;
        }

        // Runtime
        this.truck        = null;
        this.arenaObjects = [];
        this._lastTime    = 0;

        // Score breakdown
        this._airTimer     = 0;
        this._wheelieTmr   = 0;
        this._comboCount   = 0;
        this._comboReset   = null;
        this._breakdown    = { crushes: 0, airtime: 0, wheelies: 0 };

        // Camera state — spring-damper system
        this._camPos = new THREE.Vector3(0, CAM_HEIGHT, CAM_BEHIND);
        this._camVel = new THREE.Vector3();
        this._camLook = new THREE.Vector3();
        this._camLookVel = new THREE.Vector3();
        this._camYaw  = 0;

        this._animate(0);
        window.addEventListener('resize', () => this._resize());
    }

    // ----------------------------------------------------------------
    // Lifecycle
    // ----------------------------------------------------------------
    startGame(arenaIndex, mode) {
        this.currentArena = arenaIndex;
        this.mode         = mode;
        this.score        = 0;
        this.timeLeft     = TIMED_DURATION;
        this._airTimer    = 0;
        this._wheelieTmr  = 0;
        this._comboCount  = 0;
        this._breakdown   = { crushes: 0, airtime: 0, wheelies: 0 };

        this._destroyGame();

        const { objects, spawnPos } = buildArena(arenaIndex, this.scene, this.world);
        this.arenaObjects = objects;

        this.truck = new Truck(this.world, this.scene, this.customization, spawnPos);

        // Snap camera to spawn immediately
        const sp = spawnPos;
        this._camPos.set(sp.x, sp.y + CAM_HEIGHT, sp.z + CAM_BEHIND);
        this._camVel.set(0, 0, 0);
        this._camYaw = 0;
        this._lastTime = 0;

        this.state = 'playing';
        this.ui.show('hud');
    }

    pause() {
        if (this.state !== 'playing') return;
        this.state = 'paused';
        this.ui.show('pause');
    }

    resume() {
        if (this.state !== 'paused') return;
        this.state = 'playing';
        this._lastTime = 0;
        this.ui.show('hud');
    }

    quit() {
        this._destroyGame();
        this.state = 'menu';
    }

    _destroyGame() {
        if (this.truck) { this.truck.destroy(); this.truck = null; }
        cleanupArena(this.scene, this.world);
        this.arenaObjects = [];
    }

    // ----------------------------------------------------------------
    // Loop
    // ----------------------------------------------------------------
    _animate(ts) {
        requestAnimationFrame(t => this._animate(t));

        const dt = this._lastTime > 0
            ? Math.min((ts - this._lastTime) / 1000, 0.05)
            : PHYSICS_STEP;
        this._lastTime = ts;

        if (this.state === 'playing') this._step(dt);

        // Sync camera to its spring-tracked position
        this.camera.position.copy(this._camPos);

        this.renderer.render(this.scene, this.camera);
    }

    _step(dt) {
        // Check keyboard pause
        if (this.controls.pause) {
            this.controls.pause = false;
            this.pause();
            return;
        }

        this.world.step(PHYSICS_STEP, dt, 3);
        this.truck.update(this.controls, dt);

        this._updateCamera(dt);
        this._checkCollisions();
        this._updateAirScore(dt);
        this._updateWheelieScore(dt);

        // Timed mode
        if (this.mode === 'timed') {
            this.timeLeft -= dt;
            if (this.timeLeft <= 0) {
                this.timeLeft = 0;
                this._endGame();
                return;
            }
        }

        // Auto-flip HUD warning
        const afc = this.truck.autoFlipCountdown;
        if (afc > 0) {
            const secs = Math.ceil(1.5 - afc * 1.5);
            this.ui.showFlipWarning(secs);
        } else {
            this.ui.clearFlipWarning();
        }

        this.ui.updateHUD(
            Math.round(this.score),
            this.mode === 'timed' ? this.timeLeft : null,
            this.truck.speed,
            this.customization.name || 'MY TRUCK'
        );
    }

    _endGame() {
        this.state = 'gameover';
        const bd = this._breakdown;
        this.ui.showGameOver(
            Math.round(this.score),
            this.mode === 'timed',
            `🚗 Crushes: ${Math.round(bd.crushes).toLocaleString()} pts<br>` +
            `🚀 Air time: ${Math.round(bd.airtime).toLocaleString()} pts<br>` +
            `🔥 Wheelies: ${Math.round(bd.wheelies).toLocaleString()} pts`
        );
    }

    // ----------------------------------------------------------------
    // Camera — spring-damper follow
    // ----------------------------------------------------------------
    _updateCamera(dt) {
        const cb  = this.truck.chassisBody;
        const pos = cb.position;
        const q   = cb.quaternion;

        // Truck forward direction (project to horizontal)
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(
            new THREE.Quaternion(q.x, q.y, q.z, q.w)
        );
        fwd.y = 0;
        if (fwd.lengthSq() < 0.001) fwd.set(0, 0, 1);
        fwd.normalize();

        // Smooth yaw tracking
        const targetYaw = Math.atan2(fwd.x, fwd.z);
        let dyaw = targetYaw - this._camYaw;
        while (dyaw >  Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        this._camYaw += dyaw * CAM_YAW_SPEED;

        // Desired camera world position
        const sinY = Math.sin(this._camYaw);
        const cosY = Math.cos(this._camYaw);

        // Height adapts slightly to truck's vertical speed for air-time drama
        const vy   = cb.velocity.y;
        const extraH = Math.max(0, vy * 0.25);

        const targetPos = new THREE.Vector3(
            pos.x - sinY * CAM_BEHIND,
            pos.y + CAM_HEIGHT + extraH,
            pos.z - cosY * CAM_BEHIND
        );

        // Spring-damper integration
        const disp = targetPos.clone().sub(this._camPos);
        const springForce  = disp.clone().multiplyScalar(CAM_SPRING);
        const dampForce    = this._camVel.clone().multiplyScalar(-CAM_DAMPING);
        const accel = springForce.add(dampForce);

        this._camVel.addScaledVector(accel, dt);
        this._camPos.addScaledVector(this._camVel, dt);

        // Clamp so camera can never go below ground
        this._camPos.y = Math.max(this._camPos.y, 1.5);

        // Smooth look-at (separate spring on look target)
        const lookTarget = new THREE.Vector3(pos.x, pos.y + 1.8, pos.z);
        const lookDisp   = lookTarget.clone().sub(this._camLook);
        this._camLookVel.addScaledVector(lookDisp.multiplyScalar(12), dt);
        this._camLookVel.multiplyScalar(0.82);  // drag
        this._camLook.addScaledVector(this._camLookVel, dt);

        this.camera.lookAt(this._camLook);
    }

    // ----------------------------------------------------------------
    // Collision scoring
    // ----------------------------------------------------------------
    _checkCollisions() {
        for (const obj of this.arenaObjects) {
            if (obj.destroyed || !obj.isDestructible || !obj.points) continue;

            const vel   = obj.body.velocity;
            const speed = Math.sqrt(vel.x*vel.x + vel.y*vel.y + vel.z*vel.z);
            const dy    = Math.abs(obj.body.position.y - obj.origY);

            if (speed > 1.0 || dy > 0.35) {
                obj.destroyed = true;

                const mult  = 1 + this._comboCount * 0.5;
                const pts   = obj.points * mult;
                this.score += pts;
                this._breakdown.crushes += pts;

                this._comboCount++;
                clearTimeout(this._comboReset);
                this._comboReset = setTimeout(() => { this._comboCount = 0; }, 3000);

                const combo = this._comboCount > 1 ? ` ×${this._comboCount} COMBO!` : '';
                this.ui.showStunt(`${obj.label || '💥 SMASH!'}${combo}  +${Math.round(pts)}`);
            }
        }
    }

    // ----------------------------------------------------------------
    // Air time scoring
    // ----------------------------------------------------------------
    _updateAirScore(dt) {
        if (!this.truck.isAirborne) {
            if (this._airTimer >= 0.4) {
                const pts = this._airTimer * AIR_SCORE_RATE;
                this.score += pts;
                this._breakdown.airtime += pts;
                if (this._airTimer >= 1.5) this.ui.showStunt(`🚀 BIG AIR!  +${Math.round(pts)}`);
                else if (this._airTimer >= 0.8) this.ui.showStunt(`✈️ AIRBORNE!  +${Math.round(pts)}`);
            }
            this._airTimer = 0;
        } else {
            this._airTimer += dt;
            const pts = dt * AIR_SCORE_RATE * 0.3;
            this.score += pts;
            this._breakdown.airtime += pts;
        }
    }

    // ----------------------------------------------------------------
    // Wheelie scoring
    // ----------------------------------------------------------------
    _updateWheelieScore(dt) {
        const wi = this.truck.vehicle.wheelInfos;
        const frontUp = !wi[0].isInContact && !wi[1].isInContact;
        const rearDown = wi[2].isInContact  ||  wi[3].isInContact;

        if (frontUp && rearDown && this.truck.speed > 5) {
            this._wheelieTmr += dt;
            const pts = dt * WHEELIE_SCORE_RATE;
            this.score += pts;
            this._breakdown.wheelies += pts;

            if (Math.floor(this._wheelieTmr) > Math.floor(this._wheelieTmr - dt)) {
                this.ui.showStunt(`🔥 WHEELIE! +${Math.round(pts * 20)}`);
            }
        } else {
            this._wheelieTmr = 0;
        }
    }

    // ----------------------------------------------------------------
    _resize() {
        const w = window.innerWidth, h = window.innerHeight;
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }
}

// ====================================================================
// Boot
// ====================================================================
function showFatalError(err) {
    const el = document.createElement('div');
    el.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:9999;background:#cc1122;' +
        'color:#fff;padding:14px 18px;font-family:monospace;font-size:13px;' +
        'line-height:1.5;white-space:pre-wrap;max-height:50vh;overflow:auto;';
    el.textContent = `Engine init failed — check console.\n${err?.message || err}\n\n${err?.stack || ''}`;
    document.body.appendChild(el);
}

window.addEventListener('DOMContentLoaded', () => {
    try { window._game = new Game(); }
    catch (err) { console.error(err); showFatalError(err); }
});

window.addEventListener('error', (e) => {
    if (e.filename?.includes('esm.sh') || e.filename?.includes('jsdelivr')) {
        showFatalError(new Error(`Module load failed: ${e.filename}\n${e.message}`));
    }
});
