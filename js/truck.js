import * as THREE  from 'three';
import * as CANNON from 'cannon-es';

/**
 * Monster Truck — cannon-es RaycastVehicle + Three.js mesh.
 *
 * Key tuning goals (vs previous version):
 *  - Much higher engine / friction → climbs anything
 *  - Very low roll-influence + low CoM → hard to flip unintentionally
 *  - High angular damping → stays upright on landings
 *  - Auto-flip after 1.5 s upside-down
 *  - Jump mechanic (applies vertical impulse when wheels touch ground)
 */

const STYLES = [
    { bw:1.20, bh:0.45, bl:2.10, wr:0.70, ww:0.52, cs:1.0  }, // Classic
    { bw:1.05, bh:0.38, bl:2.50, wr:0.62, ww:0.42, cs:0.88 }, // Sporty
    { bw:1.50, bh:0.52, bl:1.95, wr:0.90, ww:0.68, cs:1.12 }, // Bigfoot
];

const _q90z = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1), Math.PI/2);
const _wq   = new THREE.Quaternion();

// Reusable cannon-es vec to avoid per-frame alloc
const _canUp = new CANNON.Vec3(0, 1, 0);
const _truckUp = new CANNON.Vec3();

export class Truck {
    constructor(world, scene, customization, spawnPos) {
        this.world  = world;
        this.scene  = scene;
        this.custom = customization;

        const style = STYLES[Math.max(0, Math.min(2, customization.style || 0))];

        this._buildPhysics(world, style, spawnPos || new CANNON.Vec3(0, 4, 0));
        this._buildMesh(scene, style, customization);

        // Public state
        this.speed      = 0;   // mph
        this.isAirborne = false;

        // Auto-flip
        this._autoFlipTimer = 0;
        this.autoFlipCountdown = 0; // 0-1, used by HUD for warning

        // Jump cooldown (prevent spam)
        this._jumpCooldown = 0;

        // Driving params — balanced: enough punch to climb, not enough to wheelie
        this.maxForce   = 1800;
        this.boostForce = 3000;
        this.maxSteer   = 0.55;
        this.brakeForce = 70;
        this._steerAngle = 0;
        this._steerVel   = 0;
    }

    // ----------------------------------------------------------------
    // Physics
    // ----------------------------------------------------------------
    _buildPhysics(world, s, spawnPos) {
        // Wide, low chassis → high stability
        const chassisShape = new CANNON.Box(new CANNON.Vec3(s.bw, s.bh, s.bl));
        this.chassisBody = new CANNON.Body({ mass: 180 });  // heavier = harder to flip
        // CoM kept very low so front wheels don't lift on hard acceleration
        this.chassisBody.addShape(chassisShape, new CANNON.Vec3(0, -0.05, 0));
        this.chassisBody.position.copy(spawnPos);
        this.chassisBody.angularDamping = 0.88;   // strong resistance to rotation
        this.chassisBody.linearDamping  = 0.14;

        this.vehicle = new CANNON.RaycastVehicle({
            chassisBody:      this.chassisBody,
            indexRightAxis:   0,
            indexUpAxis:      1,
            indexForwardAxis: 2,
        });

        const wx = s.bw + s.ww * 0.70;
        const wz = s.bl * 0.72;

        const baseOpts = {
            radius:              s.wr,
            directionLocal:      new CANNON.Vec3(0, -1, 0),
            // Firm enough to not rock on acceleration, compliant enough for bumps
            suspensionStiffness: 30,
            suspensionRestLength:0.42,
            // High frictionSlip = good grip for climbing
            frictionSlip:        8.0,
            dampingRelaxation:   2.4,
            dampingCompression:  4.4,
            maxSuspensionForce:  160000,
            // Very low roll influence — prevents tip-overs on turns
            rollInfluence:       0.005,
            axleLocal:           new CANNON.Vec3(1, 0, 0),
            maxSuspensionTravel: 0.65,
            customSlidingRotationalSpeed:    -30,
            useCustomSlidingRotationalSpeed: true,
        };

        [
            new CANNON.Vec3(-wx, 0,  wz),
            new CANNON.Vec3( wx, 0,  wz),
            new CANNON.Vec3(-wx, 0, -wz),
            new CANNON.Vec3( wx, 0, -wz),
        ].forEach(p => this.vehicle.addWheel({ ...baseOpts, chassisConnectionPointLocal: p }));

        this.vehicle.addToWorld(world);

        this._wheelBodies = this.vehicle.wheelInfos.map(w => {
            const b = new CANNON.Body({ mass: 0 });
            b.type = CANNON.Body.KINEMATIC;
            b.collisionFilterGroup = 0;
            b.collisionFilterMask  = 0;
            const cyl  = new CANNON.Cylinder(w.radius, w.radius, w.radius * 0.3, 12);
            const tilt = new CANNON.Quaternion();
            tilt.setFromAxisAngle(new CANNON.Vec3(1,0,0), Math.PI/2);
            b.addShape(cyl, new CANNON.Vec3(), tilt);
            world.addBody(b);
            return b;
        });
    }

    // ----------------------------------------------------------------
    // Three.js mesh
    // ----------------------------------------------------------------
    _buildMesh(scene, s, custom) {
        const bodyMat  = new THREE.MeshLambertMaterial({ color: custom.bodyColor  });
        const wheelMat = new THREE.MeshLambertMaterial({ color: custom.wheelColor });
        const hubMat   = new THREE.MeshLambertMaterial({ color: 0xcccccc });
        const glassMat = new THREE.MeshLambertMaterial({ color: 0x88ccff, transparent: true, opacity: 0.65 });
        const darkMat  = new THREE.MeshLambertMaterial({ color: 0x111111 });
        const lightMat = new THREE.MeshLambertMaterial({ color: 0xffffcc, emissive: 0xffffcc, emissiveIntensity: 1.0 });
        const tlMat    = new THREE.MeshLambertMaterial({ color: 0xff2200, emissive: 0xff2200, emissiveIntensity: 0.7 });

        this.chassisGroup = new THREE.Group();
        scene.add(this.chassisGroup);

        const add = (geo, mat, x, y, z) => {
            const m = new THREE.Mesh(geo, mat);
            m.position.set(x, y, z);
            m.castShadow = true;
            this.chassisGroup.add(m);
            return m;
        };

        // Main body
        add(new THREE.BoxGeometry(s.bw*2, s.bh*2, s.bl*2), bodyMat, 0, 0.1, 0);

        // Cab
        const cw = s.bw * 1.62 * s.cs;
        const ch = s.bh * 1.75 * s.cs;
        const cl = s.bl * 0.88 * s.cs;
        const cabY = s.bh*2 + ch*0.5 + 0.04;
        add(new THREE.BoxGeometry(cw, ch, cl), bodyMat, 0, cabY, s.bl * 0.08);

        // Windshield + rear window
        const wGeo = new THREE.BoxGeometry(cw*0.86, ch*0.52, 0.06);
        add(wGeo, glassMat, 0, cabY + ch*0.04,  s.bl*0.08 + cl*0.5 + 0.01);
        add(wGeo, glassMat, 0, cabY + ch*0.04,  s.bl*0.08 - cl*0.5 - 0.01);

        // Bumpers
        add(new THREE.BoxGeometry(s.bw*2.35, s.bh*0.65, 0.28), darkMat, 0, 0.05,  s.bl+0.12);
        add(new THREE.BoxGeometry(s.bw*2.35, s.bh*0.65, 0.28), darkMat, 0, 0.05, -s.bl-0.12);

        // Exhaust stacks
        const exG = new THREE.CylinderGeometry(0.07, 0.07, 1.1, 8);
        [-s.bw*0.78, s.bw*0.78].forEach(x =>
            add(exG, darkMat, x, s.bh*2 + ch*0.6, -s.bl*0.25));

        // Headlights
        const hlG = new THREE.BoxGeometry(0.26, 0.22, 0.1);
        [-s.bw*0.7, s.bw*0.7].forEach(x => {
            add(hlG, lightMat, x, 0.35,  s.bl+0.07);
            add(hlG, tlMat,   x, 0.35, -s.bl-0.07);
        });

        // Undercarriage (chassis rail)
        add(new THREE.BoxGeometry(s.bw*1.5, 0.1, s.bl*1.9), darkMat, 0, -s.bh+0.05, 0);

        this.chassisGroup.traverse(c => { if (c.isMesh) c.castShadow = true; });

        // ---- Wheels (world-space, not parented to chassis) ----
        const wheelGeo = new THREE.CylinderGeometry(s.wr, s.wr, s.ww, 22);
        const rimGeo   = new THREE.CylinderGeometry(s.wr*0.30, s.wr*0.30, s.ww+0.05, 8);
        const lug1Geo  = new THREE.BoxGeometry(s.wr*0.22, s.wr*2.1, s.ww*0.82);
        const lug2Geo  = new THREE.BoxGeometry(s.wr*2.1, s.wr*0.22, s.ww*0.82);

        this.wheelMeshes = this.vehicle.wheelInfos.map(() => {
            const g = new THREE.Group();
            const tyre = new THREE.Mesh(wheelGeo, wheelMat);
            tyre.castShadow = true;
            g.add(tyre);
            // Cross lug pattern
            g.add(Object.assign(new THREE.Mesh(lug1Geo, darkMat)));
            g.add(Object.assign(new THREE.Mesh(lug2Geo, darkMat)));
            g.add(new THREE.Mesh(rimGeo, hubMat));
            scene.add(g);
            return g;
        });
    }

    // ----------------------------------------------------------------
    // Per-frame update
    // ----------------------------------------------------------------
    update(controls, dt) {
        controls.pollGamepad();

        const wi    = this.vehicle.wheelInfos;
        const boost = controls.boost;
        const maxF  = boost ? this.boostForce : this.maxForce;

        let force = 0;
        if (controls.forward)  force = -maxF;
        if (controls.backward) force =  maxF * 0.80;

        // Smooth steering with mild speed-sensitive limiting
        const speedFactor = Math.max(0.4, 1 - this.speed / 80);
        const targetSteer = controls.left  ?  this.maxSteer * speedFactor
                          : controls.right ? -this.maxSteer * speedFactor : 0;
        const steerRate = controls.left || controls.right ? 0.18 : 0.25;
        this._steerAngle += (targetSteer - this._steerAngle) * steerRate;

        const brakeF = controls.brake ? this.brakeForce : (force === 0 ? 10 : 0);

        // Rear-wheel drive by default — prevents front lift / wheelies.
        // Boost engages all four wheels for maximum traction on ramps.
        const frontForce = boost ? force * 0.6 : 0;
        this.vehicle.applyEngineForce(frontForce, 0);
        this.vehicle.applyEngineForce(frontForce, 1);
        this.vehicle.applyEngineForce(force, 2);
        this.vehicle.applyEngineForce(force, 3);

        for (let i = 0; i < 4; i++) this.vehicle.setBrake(brakeF, i);
        this.vehicle.setSteeringValue(this._steerAngle, 0);
        this.vehicle.setSteeringValue(this._steerAngle, 1);

        // Jump
        if (controls.jump && this._jumpCooldown <= 0) {
            this._tryJump();
            controls.jump = false;
        }
        if (this._jumpCooldown > 0) this._jumpCooldown -= dt;

        // Auto-flip
        this._updateAutoFlip(dt);

        // Manual flip reset
        if (controls.flip) {
            this._flipReset();
            controls.flip = false;
        }

        this._syncMesh();

        const v = this.chassisBody.velocity;
        this.speed = Math.sqrt(v.x*v.x + v.z*v.z) * 2.237;
        this.isAirborne = !wi.some(w => w.isInContact);
    }

    // ----------------------------------------------------------------
    // Jump
    // ----------------------------------------------------------------
    _tryJump() {
        const contactCount = this.vehicle.wheelInfos.filter(w => w.isInContact).length;
        if (contactCount < 1) return; // must be grounded

        // Speed-based jump height — faster = more dramatic
        const vspeed = Math.max(8, Math.min(16, 8 + this.speed * 0.18));
        this.chassisBody.velocity.y = vspeed;
        this._jumpCooldown = 0.6; // seconds before next jump
    }

    // ----------------------------------------------------------------
    // Auto-flip: recover if upside-down for > 1.5 s
    // ----------------------------------------------------------------
    _updateAutoFlip(dt) {
        this.chassisBody.quaternion.vmult(_canUp, _truckUp);
        const isFlipped = _truckUp.y < 0.15;

        if (isFlipped) {
            this._autoFlipTimer += dt;
            this.autoFlipCountdown = Math.min(1, this._autoFlipTimer / 1.5);
            if (this._autoFlipTimer >= 1.5) {
                this._flipReset();
                this._autoFlipTimer = 0;
                this.autoFlipCountdown = 0;
            }
        } else {
            this._autoFlipTimer = 0;
            this.autoFlipCountdown = 0;
        }
    }

    // ----------------------------------------------------------------
    // Flip reset — put truck upright with current yaw
    // ----------------------------------------------------------------
    _flipReset() {
        const p = this.chassisBody.position;
        const q = this.chassisBody.quaternion;
        const yaw = 2 * Math.atan2(q.y, q.w);
        this.chassisBody.position.set(p.x, p.y + 2.0, p.z);
        this.chassisBody.quaternion.setFromEuler(0, yaw, 0);
        this.chassisBody.velocity.set(0, 1, 0);
        this.chassisBody.angularVelocity.set(0, 0, 0);
    }

    // ----------------------------------------------------------------
    // Sync Three.js from cannon-es
    // ----------------------------------------------------------------
    _syncMesh() {
        const cb = this.chassisBody;
        this.chassisGroup.position.set(cb.position.x, cb.position.y, cb.position.z);
        this.chassisGroup.quaternion.set(cb.quaternion.x, cb.quaternion.y, cb.quaternion.z, cb.quaternion.w);

        this.vehicle.wheelInfos.forEach((wheel, i) => {
            this.vehicle.updateWheelTransform(i);
            const t  = wheel.worldTransform;
            const wm = this.wheelMeshes[i];
            wm.position.set(t.position.x, t.position.y, t.position.z);
            _wq.set(t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w);
            wm.quaternion.multiplyQuaternions(_wq, _q90z);
        });

        this._wheelBodies.forEach((body, i) => {
            this.vehicle.updateWheelTransform(i);
            const t = this.vehicle.wheelInfos[i].worldTransform;
            body.position.copy(t.position);
            body.quaternion.copy(t.quaternion);
        });
    }

    destroy() {
        this.vehicle.removeFromWorld(this.world);
        this._wheelBodies.forEach(b => this.world.removeBody(b));
        this.scene.remove(this.chassisGroup);
        this.wheelMeshes.forEach(m => this.scene.remove(m));
    }
}
