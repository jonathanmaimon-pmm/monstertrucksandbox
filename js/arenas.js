import * as THREE  from 'three';
import * as CANNON from 'cannon-es';

/**
 * Arena builder — returns { objects, spawnPos }
 *
 * objects is an array of { mesh, body, isDestructible, points, destroyed }
 * used by main.js for collision scoring and scene cleanup.
 *
 * Three arenas:
 *   0 = Desert Dunes  — orange/tan, sand dunes, car stacks, barrels
 *   1 = City Crusher  — dark asphalt, parked cars, urban obstacles
 *   2 = Stadium Slam  — green/brown, big ramps, pyramids, tyre stacks
 */

export function buildArena(index, scene, world) {
    cleanupArena(scene, world); // safety: remove previous tagged objects
    const builders = [buildDesert, buildCity, buildStadium];
    return (builders[index] || builders[0])(scene, world);
}

// Tag physics bodies so we can clean up later
const TAG = '__arenaBody';
function tag(body) { body[TAG] = true; return body; }

export function cleanupArena(scene, world) {
    const toRemove = world.bodies.filter(b => b[TAG]);
    toRemove.forEach(b => world.removeBody(b));
    const meshes = scene.children.filter(c => c.__arenaTag);
    meshes.forEach(m => scene.remove(m));
}

// ====================================================================
// Shared helpers
// ====================================================================
function makeGround(scene, world, size, color) {
    // Physics
    const groundBody = new CANNON.Body({ mass: 0, material: new CANNON.Material('ground') });
    groundBody.addShape(new CANNON.Plane());
    groundBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    tag(groundBody);
    world.addBody(groundBody);

    // Visual
    const geo  = new THREE.PlaneGeometry(size, size, 32, 32);
    const mat  = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    mesh.__arenaTag = true;
    scene.add(mesh);

    return { groundBody, groundMaterial: groundBody.material };
}

function makeBoundaryWalls(scene, world, halfSize, wallH) {
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x445566, transparent: true, opacity: 0.0 });
    const defs = [
        { pos: [0, wallH/2, -halfSize], rot: null },
        { pos: [0, wallH/2,  halfSize], rot: null },
        { pos: [-halfSize, wallH/2, 0], rot: [0,1,0,Math.PI/2] },
        { pos: [ halfSize, wallH/2, 0], rot: [0,1,0,Math.PI/2] },
    ];
    defs.forEach(({ pos, rot }) => {
        const body = new CANNON.Body({ mass: 0 });
        body.addShape(new CANNON.Box(new CANNON.Vec3(halfSize, wallH/2, 0.5)));
        body.position.set(...pos);
        if (rot) body.quaternion.setFromAxisAngle(new CANNON.Vec3(rot[0],rot[1],rot[2]), rot[3]);
        tag(body);
        world.addBody(body);
    });
}

function addStaticBox(scene, world, hw, hh, hl, px, py, pz, color, rx=0, ry=0, rz=0) {
    const body = new CANNON.Body({ mass: 0 });
    body.addShape(new CANNON.Box(new CANNON.Vec3(hw, hh, hl)));
    body.position.set(px, py, pz);
    if (rx || ry || rz) {
        const q = new CANNON.Quaternion();
        q.setFromEuler(rx, ry, rz);
        body.quaternion.copy(q);
    }
    tag(body);
    world.addBody(body);

    const geo  = new THREE.BoxGeometry(hw*2, hh*2, hl*2);
    const mat  = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(px, py, pz);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.__arenaTag = true;
    scene.add(mesh);

    return { mesh, body };
}

function addRamp(scene, world, hw, hh, hl, px, py, pz, angle, color, ryaw=0) {
    // A ramp is just a tilted box
    const body = new CANNON.Body({ mass: 0 });
    body.addShape(new CANNON.Box(new CANNON.Vec3(hw, hh, hl)));
    body.position.set(px, py, pz);
    const q = new CANNON.Quaternion();
    q.setFromEuler(angle, ryaw, 0);
    body.quaternion.copy(q);
    tag(body);
    world.addBody(body);

    const geo  = new THREE.BoxGeometry(hw*2, hh*2, hl*2);
    const mat  = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(px, py, pz);
    mesh.rotation.set(angle, ryaw, 0);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.__arenaTag = true;
    scene.add(mesh);

    return { mesh, body };
}

function addDynamic(scene, world, shape, mass, px, py, pz, color, rx=0, ry=0, rz=0) {
    const body = new CANNON.Body({ mass });
    body.addShape(shape);
    body.position.set(px, py, pz);
    if (rx || ry || rz) {
        const q = new CANNON.Quaternion();
        q.setFromEuler(rx, ry, rz);
        body.quaternion.copy(q);
    }
    body.linearDamping  = 0.3;
    body.angularDamping = 0.4;
    tag(body);
    world.addBody(body);

    let geo;
    if (shape instanceof CANNON.Box) {
        geo = new THREE.BoxGeometry(shape.halfExtents.x*2, shape.halfExtents.y*2, shape.halfExtents.z*2);
    } else {
        // Cylinder
        geo = new THREE.CylinderGeometry(shape.radiusTop, shape.radiusBottom, shape.height, 16);
    }
    const mat  = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(px, py, pz);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = true;
    mesh.__arenaTag = true;
    scene.add(mesh);

    return { mesh, body, isDestructible: true, points: 0, destroyed: false, origY: py };
}

function addDecoration(scene, geo, mat, px, py, pz, rx=0, ry=0) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(px, py, pz);
    m.rotation.set(rx, ry, 0);
    m.castShadow = true;
    m.__arenaTag = true;
    scene.add(m);
    return m;
}

function addSky(scene, color) {
    scene.background = new THREE.Color(color);
    scene.fog = new THREE.FogExp2(color, 0.012);
}

// ====================================================================
// Arena 0 — Desert Dunes 🏜️
// ====================================================================
function buildDesert(scene, world) {
    addSky(scene, '#e8a050');

    const { groundMaterial } = makeGround(scene, world, 200, 0xc8843a);
    makeBoundaryWalls(scene, world, 60, 8);

    const objects = [];

    // Sand dune mounds (static rounded bumps using tall flat boxes)
    const duneColor = 0xd4924a;
    const dunePositions = [
        [10, 0, 15], [-15, 0, 20], [25, 0, 5], [-8, 0, -18], [18, 0, -25], [-28, 0, 8],
    ];
    dunePositions.forEach(([x,,z]) => {
        const r = 4 + Math.random() * 3;
        const h = 1.2 + Math.random() * 1.5;
        addStaticBox(scene, world, r, h, r, x, h, z, duneColor);
    });

    // Big launch ramp (centre)
    addRamp(scene, world, 4, 0.3, 7, 0, 3.2, 8, -0.42, 0xaa7733);
    addStaticBox(scene, world, 4, 3.5, 0.5, 0, 3.3, 15, 0xaa7733); // ramp back wall

    // Side ramp
    addRamp(scene, world, 3, 0.25, 5, -20, 2.2, 5, -0.40, 0xaa7733, 0.3);

    // Double-sided jump ramp
    addRamp(scene, world, 3.5, 0.25, 5, 22, 2.2, -10, -0.38, 0xbb8844);
    addRamp(scene, world, 3.5, 0.25, 5, 22, 2.2, -20,  0.38, 0xbb8844);

    // Stacked car wrecks  — 3 piles
    const carColor = [0x2244aa, 0xaa2222, 0x44aa22];
    [
        [-12, -15], [5, -20], [20, 10],
    ].forEach(([cx, cz], pi) => {
        for (let layer = 0; layer < 2 + (pi % 2); layer++) {
            const obj = addDynamic(scene, world,
                new CANNON.Box(new CANNON.Vec3(1.0, 0.45, 1.8)),
                200,
                cx + (Math.random()-0.5)*0.5, 0.5 + layer * 0.95, cz + (Math.random()-0.5)*0.5,
                carColor[pi % carColor.length],
                0, Math.random() * 0.3 - 0.15, 0
            );
            obj.points = 150;
            obj.label  = '🚗 CRUSHED!';
            objects.push(obj);
        }
    });

    // Oil barrels
    for (let i = 0; i < 10; i++) {
        const angle = (i / 10) * Math.PI * 2;
        const r = 18 + Math.random() * 8;
        const obj = addDynamic(scene, world,
            new CANNON.Cylinder(0.4, 0.4, 1.1, 12),
            80,
            Math.cos(angle) * r, 0.55, Math.sin(angle) * r,
            i % 2 === 0 ? 0xdd4400 : 0x222244
        );
        obj.points = 75;
        obj.label  = '💥 BARREL!';
        objects.push(obj);
    }

    // Tyre stacks
    for (let i = 0; i < 6; i++) {
        const x = (Math.random() - 0.5) * 60;
        const z = (Math.random() - 0.5) * 60;
        for (let t = 0; t < 3; t++) {
            const obj = addDynamic(scene, world,
                new CANNON.Cylinder(0.55, 0.55, 0.45, 12),
                40,
                x, 0.23 + t * 0.46, z,
                0x222222
            );
            obj.points = 40;
            obj.label  = '🔧 TYRE!';
            objects.push(obj);
        }
    }

    // Big arch (decorative static obstacle)
    addStaticBox(scene, world, 0.5, 4, 0.5, -5, 4, -5,  0xaa7733);
    addStaticBox(scene, world, 0.5, 4, 0.5,  5, 4, -5,  0xaa7733);
    addStaticBox(scene, world, 5.5, 0.5, 0.5, 0, 8, -5, 0xaa7733);

    // Lighting — warm sun
    const sun = new THREE.DirectionalLight(0xffcc88, 1.4);
    sun.position.set(30, 60, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.far = 200;
    sun.shadow.camera.left = sun.shadow.camera.bottom = -80;
    sun.shadow.camera.right = sun.shadow.camera.top = 80;
    sun.__arenaTag = true;
    scene.add(sun);

    const amb = new THREE.AmbientLight(0xff8844, 0.5);
    amb.__arenaTag = true;
    scene.add(amb);

    return { objects, spawnPos: new CANNON.Vec3(0, 4, 0) };
}

// ====================================================================
// Arena 1 — City Crusher 🏙️
// ====================================================================
function buildCity(scene, world) {
    addSky(scene, '#1a1a3a');
    makeGround(scene, world, 200, 0x333344);
    makeBoundaryWalls(scene, world, 65, 10);

    const objects = [];

    // Road markings (decorative flat boxes)
    for (let z = -40; z <= 40; z += 8) {
        addStaticBox(scene, world, 0.15, 0.02, 2, 0, 0.01, z, 0xffff00);
    }

    // Rows of parked cars (2 rows)
    const carColors = [0xcc2222, 0x2255cc, 0x22aa44, 0xeeaa00, 0x8822cc, 0xaa4400];
    [-28, 28].forEach(rowX => {
        for (let i = 0; i < 6; i++) {
            const cz = -25 + i * 9;
            const col = carColors[(i + (rowX > 0 ? 3 : 0)) % carColors.length];
            // Car body
            const body = addDynamic(scene, world,
                new CANNON.Box(new CANNON.Vec3(1.1, 0.55, 2.0)),
                250,
                rowX, 0.6, cz,
                col
            );
            body.points = 200;
            body.label  = '🚗 CAR CRUSHED!';
            objects.push(body);

            // Car roof
            const roof = addDynamic(scene, world,
                new CANNON.Box(new CANNON.Vec3(0.9, 0.35, 1.1)),
                60,
                rowX, 1.55, cz,
                col
            );
            roof.points = 0; // only score the car body
            objects.push(roof);
        }
    });

    // Building walls (static obstacles to drive around / into)
    const buildingData = [
        [-45, -30, 8, 12, 8],
        [ 45, -30, 8, 10, 8],
        [-45,  30, 8, 14, 8],
        [ 45,  30, 8, 12, 8],
        [  0, -48, 20, 8, 6],
        [  0,  48, 20, 8, 6],
    ];
    buildingData.forEach(([x, z, hw, hh, hl]) => {
        addStaticBox(scene, world, hw, hh, hl, x, hh, z, 0x445566);
        // Windows (emissive squares)
        addStaticBox(scene, world, hw*0.85, 0.3, 0.05, x, hh*1.2, z+hl+0.1, 0xffffaa);
    });

    // Concrete ramps
    addRamp(scene, world, 6, 0.3, 9,  15, 3.5, 0,  -0.38, 0x888899);
    addRamp(scene, world, 6, 0.3, 9, -15, 3.5, 0,  -0.38, 0x888899);
    addRamp(scene, world, 5, 0.3, 7,   0, 3.0, 30, -0.38, 0x888899);

    // Bus wreck (big dynamic obstacle)
    const bus = addDynamic(scene, world,
        new CANNON.Box(new CANNON.Vec3(1.3, 1.0, 4.2)),
        500,
        5, 1.1, 15,
        0xffcc00
    );
    bus.points = 500;
    bus.label  = '🚌 BUS BASHED!';
    objects.push(bus);

    // Dumpsters
    for (let i = 0; i < 5; i++) {
        const obj = addDynamic(scene, world,
            new CANNON.Box(new CANNON.Vec3(0.8, 0.7, 1.2)),
            120,
            -20 + i * 8, 0.7, -5,
            0x224422
        );
        obj.points = 100;
        obj.label  = '🗑️ SMASHED!';
        objects.push(obj);
    }

    // Traffic cones
    for (let i = 0; i < 12; i++) {
        const x = -15 + i * 3;
        const obj = addDynamic(scene, world,
            new CANNON.Cylinder(0.15, 0.3, 0.7, 8),
            15,
            x, 0.35, 10,
            0xff5500
        );
        obj.points = 25;
        obj.label  = '🚧 CONE!';
        objects.push(obj);
    }

    // Street lights (static)
    for (let i = -3; i <= 3; i++) {
        const col = i % 2 === 0 ? 0x777788 : 0x777788;
        addStaticBox(scene, world, 0.2, 4, 0.2, -10, 4, i * 15, col);
        addStaticBox(scene, world, 1.5, 0.15, 0.15, -8, 8.1, i * 15, col);
    }

    // Lighting — cool city night
    const streetLight = new THREE.PointLight(0xffeecc, 2, 40);
    streetLight.position.set(0, 12, 0);
    streetLight.__arenaTag = true;
    scene.add(streetLight);

    const moon = new THREE.DirectionalLight(0x8899cc, 0.8);
    moon.position.set(-20, 50, 10);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    moon.shadow.camera.far = 200;
    moon.shadow.camera.left = moon.shadow.camera.bottom = -80;
    moon.shadow.camera.right = moon.shadow.camera.top = 80;
    moon.__arenaTag = true;
    scene.add(moon);

    const amb = new THREE.AmbientLight(0x334466, 0.7);
    amb.__arenaTag = true;
    scene.add(amb);

    return { objects, spawnPos: new CANNON.Vec3(0, 3, -10) };
}

// ====================================================================
// Arena 2 — Stadium Slam 🏟️
// ====================================================================
function buildStadium(scene, world) {
    addSky(scene, '#6aaeee');
    makeGround(scene, world, 200, 0x7a4a1e); // dirt
    makeBoundaryWalls(scene, world, 55, 12);

    const objects = [];

    // Grass infield
    addStaticBox(scene, world, 22, 0.05, 30, 0, 0.04, 0, 0x3a8a2a);

    // Stadium stands (static decorative walls around perimeter)
    const standColor = 0x225599;
    [
        [0, 2, -58, 55, 8, 2],
        [0, 2,  58, 55, 8, 2],
        [-58, 2, 0, 2, 8, 55],
        [ 58, 2, 0, 2, 8, 55],
    ].forEach(([x, y, z, hw, hh, hl]) => {
        addStaticBox(scene, world, hw, hh, hl, x, hh, z, standColor);
        // Seats (colored strips)
        addStaticBox(scene, world, hw, 0.4, hl, x, hh*1.95, z, 0xcc3333);
    });

    // MAIN BIG RAMPS (the classic stadium pair)
    // Launch ramp — centre
    addRamp(scene, world, 7, 0.4, 11, 0, 5.5, 12, -0.48, 0x888888);
    addStaticBox(scene, world, 7, 5.8, 0.7, 0, 5.5, 23, 0x666666); // back wall

    // Landing mound
    addStaticBox(scene, world, 7, 1.0, 5, 0, 1.0, -10, 0x8a5a2a);

    // Side boosting ramps
    addRamp(scene, world, 5, 0.35, 8, -22, 4.2, 8,  -0.45, 0x999999);
    addRamp(scene, world, 5, 0.35, 8,  22, 4.2, 8,  -0.45, 0x999999);

    // Ski-jump style tall ramp
    addRamp(scene, world, 4, 0.3, 12, 0, 7, -20, -0.55, 0x777777);
    addStaticBox(scene, world, 4, 7.5, 0.6, 0, 7.5, -32, 0x666666);

    // Pyramid of cars — the classic monster truck target!
    const carCols = [0xcc2222, 0x2255cc, 0x22aa44, 0xeeaa00, 0x9933cc, 0xff6600];
    // Base layer: 4 cars
    [[-4.5,0],[-1.5,0],[1.5,0],[4.5,0]].forEach(([x,], i) => {
        const obj = addDynamic(scene, world,
            new CANNON.Box(new CANNON.Vec3(1.3, 0.5, 2.1)),
            220,
            x, 0.55, -20,
            carCols[i % carCols.length]
        );
        obj.points = 250;
        obj.label  = '🚗 PYRAMID HIT!';
        objects.push(obj);
    });
    // Layer 2: 3 cars
    [[-3,0],[0,0],[3,0]].forEach(([x,], i) => {
        const obj = addDynamic(scene, world,
            new CANNON.Box(new CANNON.Vec3(1.3, 0.5, 2.1)),
            220,
            x, 1.55, -20,
            carCols[(i+2) % carCols.length]
        );
        obj.points = 300;
        obj.label  = '🚗 COMBO HIT!';
        objects.push(obj);
    });
    // Top: 1 car
    const topCar = addDynamic(scene, world,
        new CANNON.Box(new CANNON.Vec3(1.3, 0.5, 2.1)),
        220,
        0, 2.55, -20,
        0xffdd00
    );
    topCar.points = 500;
    topCar.label  = '🏆 TOP CAR!';
    objects.push(topCar);

    // Tyre stacks as slalom
    for (let i = -2; i <= 2; i++) {
        const baseZ = i * 9;
        for (let t = 0; t < 4; t++) {
            const obj = addDynamic(scene, world,
                new CANNON.Cylinder(0.6, 0.6, 0.5, 12),
                50,
                i % 2 === 0 ? -15 : 15, 0.25 + t * 0.51, baseZ,
                0x222222
            );
            obj.points = 50;
            obj.label  = '🏁 TYRE SMASH!';
            objects.push(obj);
        }
    }

    // Barrels along inner edge
    for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const r = 18;
        const obj = addDynamic(scene, world,
            new CANNON.Cylinder(0.45, 0.45, 1.2, 12),
            90,
            Math.cos(a) * r, 0.6, Math.sin(a) * r,
            i % 2 === 0 ? 0xff3300 : 0x0033ff
        );
        obj.points = 75;
        obj.label  = '💥 BARREL BASH!';
        objects.push(obj);
    }

    // Big jump table (for sustained airtime)
    addStaticBox(scene, world, 5, 3.5, 4, -30, 3.6, -5,  0x888888);
    addRamp(scene, world, 5, 0.3, 5, -30, 5.3, -10, -0.6, 0x888888);
    addRamp(scene, world, 5, 0.3, 5, -30, 5.3,   0,  0.6, 0x888888);

    // Dirt mound obstacles mid-arena
    addStaticBox(scene, world, 3, 1.5, 3, 15, 1.5, -30, 0x7a4a1e);
    addStaticBox(scene, world, 4, 2.0, 4, -10, 2.0, 30, 0x7a4a1e);

    // Spotlights
    const createSpot = (x, y, z, tx, tz) => {
        const light = new THREE.SpotLight(0xffffff, 1.5, 120, Math.PI * 0.25, 0.4);
        light.position.set(x, y, z);
        light.target.position.set(tx, 0, tz);
        light.castShadow = true;
        light.__arenaTag = true;
        light.target.__arenaTag = true;
        scene.add(light);
        scene.add(light.target);
    };

    createSpot(-40, 30,  30,  0,  0);
    createSpot( 40, 30,  30,  0,  0);
    createSpot(-40, 30, -30,  0,  0);
    createSpot( 40, 30, -30,  0,  0);

    const amb = new THREE.AmbientLight(0x8899bb, 0.8);
    amb.__arenaTag = true;
    scene.add(amb);

    return { objects, spawnPos: new CANNON.Vec3(0, 3, 35) };
}
