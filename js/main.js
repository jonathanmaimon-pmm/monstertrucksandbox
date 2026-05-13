/**
 * main.js — Game entry point.
 *
 * Owns: Three.js renderer/scene/camera, cannon-es world, game-state machine,
 * score tracker, stunt detection, camera follow, and the main animation loop.
 */

import * as THREE  from 'three';
import * as CANNON from 'cannon-es';
window.CANNON = CANNON;   // expose for truck.js / arenas.js (loaded after this)

import { Controls } from './controls.js';
import { UI }       from './ui.js';
import { Truck }    from './truck.js';
import { buildArena, cleanupArena } from './arenas.js';

// ====================================================================
// CONSTANTS
// ====================================================================
const TIMED_DURATION = 120; // seconds
const AIR_SCORE_RATE = 200; // pts / second airborne
const WHEELIE_SCORE_RATE = 120;
const STUNT_SCORE_BONUS = 50; // combo boost
const CAMERA_HEIGHT  = 9;
const CAMERA_BEHIND  = 14;
const CAMERA_LERP    = 0.06;

// ====================================================================
// GAME CLASS
// ====================================================================
class Game {
    constructor() {
        // Public state (read by UI)
        this.state        = 'menu';  // menu | playing | paused | gameover
        this.mode         = 'freeplay';
        this.currentArena = 0;
        this.score        = 0;
        this.timeLeft     = TIMED_DURATION;
        this.customization = {};     // filled in by UI

        // Three.js
        this.canvas   = document.getElementById('gameCanvas');
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

        this.scene  = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(65, 1, 0.3, 600);
        this._resize();

        // Physics world
        this.world = new CANNON.World({
            gravity: new CANNON.Vec3(0, -22, 0),
        });
        this.world.broadphase = new CANNON.SAPBroadphase(this.world);
        this.world.allowSleep = true;

        // Ground contact material (shared)
        this.groundMat  = new CANNON.Material('ground');
        this.vehicleMat = new CANNON.Material('vehicle');
        this.world.addContactMaterial(new CANNON.ContactMaterial(
            this.groundMat, this.vehicleMat, { friction: 0.6, restitution: 0.2 }
        ));

        // Input
        this.controls = new Controls();

        // UI (references game and controls)
        this.ui = new UI(this);

        // Runtime
        this.truck        = null;
        this.arenaObjects = [];
        this._lastTime    = 0;
        this._airTimer    = 0;
        this._wheelieTimer = 0;
        this._comboCount  = 0;
        this._comboReset  = null;
        this._scoreBreakdown = { crushes: 0, airtime: 0, wheelies: 0 };

        // Camera target helpers
        this._camTarget = new THREE.Vector3(0, CAMERA_HEIGHT, 0);
        this._camLook   = new THREE.Vector3();
        this._camYaw    = 0; // smooth yaw following

        // Start render loop (even before game starts, so menu looks alive)
        this._animate(0);

        // Handle resize
        window.addEventListener('resize', () => this._resize());
    }

    // ----------------------------------------------------------------
    // LIFECYCLE
    // ----------------------------------------------------------------
    startGame(arenaIndex, mode) {
        this.currentArena = arenaIndex;
        this.mode         = mode;
        this.score        = 0;
        this.timeLeft     = TIMED_DURATION;
        this._airTimer    = 0;
        this._wheelieTimer = 0;
        this._comboCount  = 0;
        this._scoreBreakdown = { crushes: 0, airtime: 0, wheelies: 0 };

        // Tear down previous game
        this._destroyGame();

        // Build arena
        const result = buildArena(arenaIndex, this.scene, this.world);
        this.arenaObjects = result.objects;

        // Spawn truck
        this.truck = new Truck(
            this.world,
            this.scene,
            this.customization,
            result.spawnPos
        );

        // Set camera directly above spawn to avoid swoop-in
        const sp = result.spawnPos;
        this.camera.position.set(sp.x, sp.y + CAMERA_HEIGHT, sp.z + CAMERA_BEHIND);
        this._camYaw = 0;

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
        this._lastTime = 0; // reset dt to avoid jump
        this.ui.show('hud');
    }

    quit() {
        this._destroyGame();
        this.state = 'menu';
    }

    _destroyGame() {
        if (this.truck) {
            this.truck.destroy();
            this.truck = null;
        }
        cleanupArena(this.scene, this.world);
        this.arenaObjects = [];
    }

    // ----------------------------------------------------------------
    // MAIN LOOP
    // ----------------------------------------------------------------
    _animate(timestamp) {
        requestAnimationFrame(t => this._animate(t));

        const dt = this._lastTime > 0
            ? Math.min((timestamp - this._lastTime) / 1000, 0.05)
            : 0.016;
        this._lastTime = timestamp;

        if (this.state === 'playing') {
            this._step(dt);
        }

        this.renderer.render(this.scene, this.camera);
    }

    _step(dt) {
        // Physics
        this.world.step(1 / 60, dt, 3);

        // Truck update (apply controls → physics, sync mesh)
        this.truck.update(this.controls);

        // Camera follow
        this._updateCamera();

        // Scoring — destructibles
        this._checkCollisions();

        // Scoring — air time
        this._updateAirScore(dt);

        // Scoring — wheelie detection
        this._updateWheelieScore(dt);

        // Timed mode countdown
        if (this.mode === 'timed') {
            this.timeLeft -= dt;
            if (this.timeLeft <= 0) {
                this.timeLeft = 0;
                this._endGame();
                return;
            }
        }

        // HUD
        this.ui.updateHUD(
            Math.round(this.score),
            this.mode === 'timed' ? this.timeLeft : null,
            this.truck.speed,
            this.customization.name || 'MY TRUCK'
        );
    }

    _endGame() {
        this.state = 'gameover';
        const bd = this._scoreBreakdown;
        const breakdown = `
            🚗 Crushes: ${bd.crushes.toLocaleString()} pts<br>
            🚀 Air time: ${bd.airtime.toLocaleString()} pts<br>
            🔥 Wheelies: ${bd.wheelies.toLocaleString()} pts
        `;
        this.ui.showGameOver(Math.round(this.score), this.mode === 'timed', breakdown);
    }

    // ----------------------------------------------------------------
    // CAMERA
    // ----------------------------------------------------------------
    _updateCamera() {
        const pos = this.truck.chassisBody.position;
        const quat = this.truck.chassisBody.quaternion;

        // Extract truck's forward direction (chassis +Z in world space)
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(
            new THREE.Quaternion(quat.x, quat.y, quat.z, quat.w)
        );
        fwd.y = 0;
        if (fwd.lengthSq() > 0.001) fwd.normalize();

        // Smooth yaw
        const targetYaw = Math.atan2(fwd.x, fwd.z);
        let dyaw = targetYaw - this._camYaw;
        // Wrap to [-π, π]
        while (dyaw >  Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        this._camYaw += dyaw * CAMERA_LERP * 2;

        const sinY = Math.sin(this._camYaw);
        const cosY = Math.cos(this._camYaw);

        // Target position = behind + above truck
        const tx = pos.x - sinY * CAMERA_BEHIND;
        const ty = pos.y + CAMERA_HEIGHT;
        const tz = pos.z - cosY * CAMERA_BEHIND;

        this._camTarget.set(tx, ty, tz);
        this.camera.position.lerp(this._camTarget, CAMERA_LERP);

        // Look at truck + slight vertical offset
        this._camLook.set(pos.x, pos.y + 1.5, pos.z);
        this.camera.lookAt(this._camLook);
    }

    // ----------------------------------------------------------------
    // COLLISION SCORING
    // ----------------------------------------------------------------
    _checkCollisions() {
        const truckBody = this.truck.chassisBody;

        for (const obj of this.arenaObjects) {
            if (obj.destroyed || !obj.isDestructible || obj.points === 0) continue;

            // Simple displacement check: if the object moved significantly from spawn
            const dy = Math.abs(obj.body.position.y - obj.origY);
            const body = obj.body;
            const vel  = body.velocity;
            const speed = Math.sqrt(vel.x*vel.x + vel.y*vel.y + vel.z*vel.z);

            // Detect if knocked
            if (speed > 1.2 || dy > 0.4) {
                obj.destroyed = true;
                const pts = obj.points * (1 + this._comboCount * 0.5);
                this.score += pts;
                this._scoreBreakdown.crushes += pts;

                // Combo
                this._comboCount++;
                clearTimeout(this._comboReset);
                this._comboReset = setTimeout(() => { this._comboCount = 0; }, 3000);

                const label = obj.label || '💥 SMASH!';
                const comboText = this._comboCount > 1 ? ` x${this._comboCount} COMBO!` : '';
                this.ui.showStunt(`${label}${comboText} +${Math.round(pts)}`);
            }
        }
    }

    // ----------------------------------------------------------------
    // AIR TIME
    // ----------------------------------------------------------------
    _updateAirScore(dt) {
        if (!this.truck.isAirborne) {
            if (this._airTimer >= 0.4) {
                // Reward sustained air time
                const pts = this._airTimer * AIR_SCORE_RATE;
                this.score += pts;
                this._scoreBreakdown.airtime += pts;
                if (this._airTimer >= 1.5) {
                    this.ui.showStunt(`🚀 BIG AIR! +${Math.round(pts)}`);
                }
            }
            this._airTimer = 0;
        } else {
            this._airTimer += dt;
            // Continuous trickle while in air
            const pts = dt * AIR_SCORE_RATE * 0.3;
            this.score += pts;
            this._scoreBreakdown.airtime += pts;
        }
    }

    // ----------------------------------------------------------------
    // WHEELIE (front wheels off, rear wheels on)
    // ----------------------------------------------------------------
    _updateWheelieScore(dt) {
        const wi = this.truck.vehicle.wheelInfos;
        // Front wheels [0,1] in air, rear wheels [2,3] on ground
        const frontUp = !wi[0].isInContact && !wi[1].isInContact;
        const rearDown = wi[2].isInContact || wi[3].isInContact;
        const isWheelie = frontUp && rearDown && this.truck.speed > 5;

        if (isWheelie) {
            this._wheelieTimer += dt;
            const pts = dt * WHEELIE_SCORE_RATE;
            this.score += pts;
            this._scoreBreakdown.wheelies += pts;

            if (Math.floor(this._wheelieTimer) > Math.floor(this._wheelieTimer - dt)) {
                this.ui.showStunt(`🔥 WHEELIE! +${Math.round(pts * 20)}`);
            }
        } else {
            this._wheelieTimer = 0;
        }
    }

    // ----------------------------------------------------------------
    // RESIZE
    // ----------------------------------------------------------------
    _resize() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }
}

// ====================================================================
// Boot
// ====================================================================
window.addEventListener('DOMContentLoaded', () => {
    window._game = new Game();
});
