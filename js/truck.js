import * as THREE from 'three';

/**
 * Monster Truck — cannon-es RaycastVehicle + Three.js visual mesh.
 *
 * Three styles share identical physics but different proportions:
 *   0 = Classic  — wide, tall
 *   1 = Sporty   — long, lower
 *   2 = Bigfoot  — widest, huge wheels
 *
 * Wheel meshes are direct children of `scene` (not of the chassis group)
 * so world-space transforms from cannon-es map directly without
 * any local/world conversion gymnastics.
 */

const STYLES = [
    { bw:1.20, bh:0.55, bl:2.10, wr:0.62, ww:0.48, cs:1.0  }, // Classic
    { bw:1.00, bh:0.40, bl:2.50, wr:0.54, ww:0.38, cs:0.88 }, // Sporty
    { bw:1.45, bh:0.60, bl:1.90, wr:0.80, ww:0.62, cs:1.10 }, // Bigfoot
];

// Pre-alloc reusable THREE objects to avoid garbage per frame
const _q90z = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1), Math.PI/2);
const _wq   = new THREE.Quaternion();

export class Truck {
    constructor(world, scene, customization, spawnPos) {
        this.world  = world;
        this.scene  = scene;
        this.custom = customization;

        const style = STYLES[Math.max(0, Math.min(2, customization.style || 0))];

        this._buildPhysics(world, style, spawnPos || new CANNON.Vec3(0, 4, 0));
        this._buildMesh(scene, style, customization);

        // Public state
        this.speed      = 0;   // approximate mph
        this.isAirborne = false;

        // Driving params
        this.maxForce   = 1400;
        this.boostForce = 2200;
        this.maxSteer   = 0.50;
        this.brakeForce = 60;
        this._steerAngle = 0;
    }

    // ----------------------------------------------------------------
    // Physics
    // ----------------------------------------------------------------
    _buildPhysics(world, s, spawnPos) {
        const chassisShape = new CANNON.Box(new CANNON.Vec3(s.bw, s.bh, s.bl));
        this.chassisBody = new CANNON.Body({ mass: 160 });
        this.chassisBody.addShape(chassisShape, new CANNON.Vec3(0, 0.3, 0));
        this.chassisBody.position.copy(spawnPos);
        this.chassisBody.angularDamping = 0.55;
        this.chassisBody.linearDamping  = 0.18;

        this.vehicle = new CANNON.RaycastVehicle({
            chassisBody:      this.chassisBody,
            indexRightAxis:   0,
            indexUpAxis:      1,
            indexForwardAxis: 2,
        });

        const wx = s.bw + s.ww * 0.65;
        const wz = s.bl * 0.72;

        const baseOpts = {
            radius:              s.wr,
            directionLocal:      new CANNON.Vec3(0, -1, 0),
            suspensionStiffness: 30,
            suspensionRestLength:0.38,
            frictionSlip:        4.5,
            dampingRelaxation:   2.3,
            dampingCompression:  4.2,
            maxSuspensionForce:  120000,
            rollInfluence:       0.015,
            axleLocal:           new CANNON.Vec3(1, 0, 0),
            maxSuspensionTravel: 0.42,
            customSlidingRotationalSpeed:    -30,
            useCustomSlidingRotationalSpeed: true,
        };

        // FL, FR, RL, RR
        [
            new CANNON.Vec3(-wx, 0,  wz),
            new CANNON.Vec3( wx, 0,  wz),
            new CANNON.Vec3(-wx, 0, -wz),
            new CANNON.Vec3( wx, 0, -wz),
        ].forEach(p => this.vehicle.addWheel({ ...baseOpts, chassisConnectionPointLocal: p }));

        this.vehicle.addToWorld(world);

        // Kinematic bodies required by cannon-es internals (zero collision mask)
        this._wheelBodies = this.vehicle.wheelInfos.map(w => {
            const b = new CANNON.Body({ mass: 0 });
            b.type = CANNON.Body.KINEMATIC;
            b.collisionFilterGroup = 0;
            b.collisionFilterMask  = 0;
            const cyl = new CANNON.Cylinder(w.radius, w.radius, w.radius * 0.3, 12);
            const tilt = new CANNON.Quaternion();
            tilt.setFromAxisAngle(new CANNON.Vec3(1,0,0), Math.PI/2);
            b.addShape(cyl, new CANNON.Vec3(), tilt);
            world.addBody(b);
            return b;
        });
    }

    // ----------------------------------------------------------------
    // Three.js mesh (chassis + 4 wheel groups in world space)
    // ----------------------------------------------------------------
    _buildMesh(scene, s, custom) {
        const bodyMat  = new THREE.MeshLambertMaterial({ color: custom.bodyColor  });
        const wheelMat = new THREE.MeshLambertMaterial({ color: custom.wheelColor });
        const hubMat   = new THREE.MeshLambertMaterial({ color: 0xcccccc });
        const glassMat = new THREE.MeshLambertMaterial({ color: 0x88ccff, transparent: true, opacity: 0.65 });
        const darkMat  = new THREE.MeshLambertMaterial({ color: 0x111111 });
        const lightMat = new THREE.MeshLambertMaterial({ color: 0xffffcc, emissive: 0xffffcc, emissiveIntensity: 1.0 });

        // Chassis group — follows chassisBody each frame
        this.chassisGroup = new THREE.Group();
        scene.add(this.chassisGroup);

        // Main body box
        this._addMesh(this.chassisGroup,
            new THREE.BoxGeometry(s.bw*2, s.bh*2, s.bl*2), bodyMat,
            0, 0.3, 0);

        // Cab
        const cw = s.bw * 1.6 * s.cs;
        const ch = s.bh * 1.7 * s.cs;
        const cl = s.bl * 0.88 * s.cs;
        this._addMesh(this.chassisGroup,
            new THREE.BoxGeometry(cw, ch, cl), bodyMat,
            0, s.bh*2 + ch*0.5 + 0.05, s.bl * 0.1);

        // Windshield
        this._addMesh(this.chassisGroup,
            new THREE.BoxGeometry(cw*0.86, ch*0.52, 0.06), glassMat,
            0, s.bh*2 + ch*0.52, s.bl * 0.1 + cl*0.5 + 0.01);

        // Rear window
        this._addMesh(this.chassisGroup,
            new THREE.BoxGeometry(cw*0.86, ch*0.52, 0.06), glassMat,
            0, s.bh*2 + ch*0.52, s.bl * 0.1 - cl*0.5 - 0.01);

        // Front bumper
        this._addMesh(this.chassisGroup,
            new THREE.BoxGeometry(s.bw*2.3, s.bh*0.65, 0.25), darkMat,
            0, 0.08, s.bl + 0.1);

        // Rear bumper
        this._addMesh(this.chassisGroup,
            new THREE.BoxGeometry(s.bw*2.3, s.bh*0.65, 0.25), darkMat,
            0, 0.08, -s.bl - 0.1);

        // Exhaust stacks
        const exGeo = new THREE.CylinderGeometry(0.065, 0.065, 1.0, 8);
        [-s.bw * 0.78, s.bw * 0.78].forEach(x => {
            this._addMesh(this.chassisGroup, exGeo, darkMat,
                x, s.bh*2 + ch*0.6, -s.bl * 0.25);
        });

        // Headlights
        const hlGeo = new THREE.BoxGeometry(0.24, 0.20, 0.09);
        [-s.bw*0.7, s.bw*0.7].forEach(x => {
            this._addMesh(this.chassisGroup, hlGeo, lightMat, x, 0.38, s.bl + 0.06);
        });

        // Tail lights
        const tlMat = new THREE.MeshLambertMaterial({ color: 0xff2200, emissive: 0xff2200, emissiveIntensity: 0.7 });
        [-s.bw*0.7, s.bw*0.7].forEach(x => {
            this._addMesh(this.chassisGroup, hlGeo, tlMat, x, 0.38, -s.bl - 0.06);
        });

        this.chassisGroup.traverse(c => {
            if (c.isMesh) { c.castShadow = true; c.receiveShadow = false; }
        });

        // ---- Wheel meshes — added directly to scene (world space) ----
        const wheelGeo = new THREE.CylinderGeometry(s.wr, s.wr, s.ww, 20);
        const rimGeo   = new THREE.CylinderGeometry(s.wr*0.28, s.wr*0.28, s.ww+0.04, 8);
        const treadGeo = new THREE.BoxGeometry(s.wr*2.15, 0.045, s.ww*0.95);

        this.wheelMeshes = this.vehicle.wheelInfos.map(() => {
            const g = new THREE.Group();

            // Tyre
            const tyre = new THREE.Mesh(wheelGeo, wheelMat);
            tyre.castShadow = true;
            g.add(tyre);

            // Tread marks around tyre
            for (let t = 0; t < 8; t++) {
                const tm = new THREE.Mesh(treadGeo, darkMat);
                tm.rotation.z = (t / 8) * Math.PI;
                g.add(tm);
            }

            // Rim / hub
            g.add(new THREE.Mesh(rimGeo, hubMat));

            // Cylinder is Y-up — needs 90° Z-tilt to align with X axle
            // Applied in _syncMesh every frame, so initial rotation is neutral
            scene.add(g);
            return g;
        });
    }

    _addMesh(parent, geo, mat, x, y, z) {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        parent.add(m);
        return m;
    }

    // ----------------------------------------------------------------
    // Per-frame update
    // ----------------------------------------------------------------
    update(controls) {
        controls.pollGamepad();

        const boost  = controls.boost;
        const maxF   = boost ? this.boostForce : this.maxForce;

        let force = 0;
        if (controls.forward)  force = -maxF;
        if (controls.backward) force =  maxF * 0.65;

        // Smooth steering
        const targetSteer = controls.left  ?  this.maxSteer
                          : controls.right ? -this.maxSteer : 0;
        this._steerAngle += (targetSteer - this._steerAngle) * 0.15;

        const brakeF = (controls.brake || (force === 0 && !controls.forward && !controls.backward))
            ? (controls.brake ? this.brakeForce : 6)
            : 0;

        for (let i = 0; i < 4; i++) {
            this.vehicle.applyEngineForce(force, i);
            this.vehicle.setBrake(brakeF, i);
        }
        // Steering on front wheels only
        this.vehicle.setSteeringValue(this._steerAngle, 0);
        this.vehicle.setSteeringValue(this._steerAngle, 1);

        // Flip reset
        if (controls.flip) {
            this._flipReset();
            controls.flip = false;
        }

        // Sync visuals
        this._syncMesh();

        // Speed in mph
        const v = this.chassisBody.velocity;
        this.speed = Math.sqrt(v.x*v.x + v.z*v.z) * 2.237;

        // Airborne
        this.isAirborne = !this.vehicle.wheelInfos.some(w => w.isInContact);
    }

    _syncMesh() {
        // Chassis
        const cb = this.chassisBody;
        this.chassisGroup.position.set(cb.position.x, cb.position.y, cb.position.z);
        this.chassisGroup.quaternion.set(cb.quaternion.x, cb.quaternion.y, cb.quaternion.z, cb.quaternion.w);

        // Wheels — cannon-es gives world-space transforms
        this.vehicle.wheelInfos.forEach((wheel, i) => {
            this.vehicle.updateWheelTransform(i);
            const t  = wheel.worldTransform;
            const wm = this.wheelMeshes[i];

            wm.position.set(t.position.x, t.position.y, t.position.z);

            // Physics quat, then tilt 90° around world-Z so cylinder aligns with axle
            _wq.set(t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w);
            wm.quaternion.multiplyQuaternions(_wq, _q90z);
        });

        // Kinematic wheel bodies (cannon-es needs them)
        this._wheelBodies.forEach((body, i) => {
            this.vehicle.updateWheelTransform(i);
            const t = this.vehicle.wheelInfos[i].worldTransform;
            body.position.copy(t.position);
            body.quaternion.copy(t.quaternion);
        });
    }

    _flipReset() {
        const p = this.chassisBody.position;
        const q = this.chassisBody.quaternion;
        this.chassisBody.position.set(p.x, p.y + 2.5, p.z);
        // Keep only yaw rotation
        const yaw = 2 * Math.atan2(q.y, q.w);
        this.chassisBody.quaternion.setFromEuler(0, yaw, 0);
        this.chassisBody.velocity.set(0, 0, 0);
        this.chassisBody.angularVelocity.set(0, 0, 0);
    }

    // ----------------------------------------------------------------
    // Cleanup
    // ----------------------------------------------------------------
    destroy() {
        this.vehicle.removeFromWorld(this.world);
        this._wheelBodies.forEach(b => this.world.removeBody(b));
        this.scene.remove(this.chassisGroup);
        this.wheelMeshes.forEach(m => this.scene.remove(m));
    }

    get chassisBodyRef() { return this.chassisBody; }
}
