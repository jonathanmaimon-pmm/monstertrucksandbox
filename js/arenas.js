import * as THREE  from 'three';
import * as CANNON from 'cannon-es';

/**
 * Arena builder — returns { objects, spawnPos }.
 * objects: array of { mesh, body, isDestructible, points, label, destroyed, origY }
 *
 * Terrain approach: a bumpy ground is created by combining a flat physics plane
 * with many partially-buried static "bump" boxes that protrude slightly.
 * This gives real physical bumps without the complexity of a heightfield.
 */

export function buildArena(index, scene, world) {
    cleanupArena(scene, world);
    return [buildDesert, buildCity, buildStadium][index % 3](scene, world);
}

// ---- Tag helpers ---------------------------------------------------
const TAG = '__arena';
function tagBody(b) { b[TAG] = true; return b; }
function tagMesh(m) { m.__arenaTag = true; return m; }
function addToScene(scene, mesh) { tagMesh(mesh); scene.add(mesh); return mesh; }

export function cleanupArena(scene, world) {
    world.bodies.filter(b => b[TAG]).forEach(b => world.removeBody(b));
    scene.children.filter(c => c.__arenaTag).forEach(c => scene.remove(c));
}

// ====================================================================
// Shared geometry helpers
// ====================================================================

function setSky(scene, color, fogDensity = 0.010) {
    scene.background = new THREE.Color(color);
    scene.fog = new THREE.FogExp2(color, fogDensity);
}

/** Flat infinite ground plane + large visible disc */
function makeGround(scene, world, color, size = 240) {
    const body = new CANNON.Body({ mass: 0 });
    body.addShape(new CANNON.Plane());
    body.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    tagBody(body);
    world.addBody(body);

    const geo  = new THREE.PlaneGeometry(size, size, 48, 48);
    const mat  = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    addToScene(scene, mesh);
}

/** Invisible boundary walls keep the truck in the arena */
function makeBounds(scene, world, half, wallH = 10) {
    [
        { p:[  0, wallH/2, -half], hl:[half,  wallH/2, 0.5] },
        { p:[  0, wallH/2,  half], hl:[half,  wallH/2, 0.5] },
        { p:[-half, wallH/2, 0],  hl:[0.5,  wallH/2, half] },
        { p:[ half, wallH/2, 0],  hl:[0.5,  wallH/2, half] },
    ].forEach(({ p, hl }) => {
        const b = new CANNON.Body({ mass: 0 });
        b.addShape(new CANNON.Box(new CANNON.Vec3(...hl)));
        b.position.set(...p);
        tagBody(b);
        world.addBody(b);
    });
}

/** Static box — physics + visual */
function staticBox(scene, world, hw, hh, hl, x, y, z, color, rx=0, ry=0, rz=0) {
    const body = new CANNON.Body({ mass: 0 });
    body.addShape(new CANNON.Box(new CANNON.Vec3(hw, hh, hl)));
    body.position.set(x, y, z);
    if (rx||ry||rz) {
        const q = new CANNON.Quaternion(); q.setFromEuler(rx, ry, rz);
        body.quaternion.copy(q);
    }
    tagBody(body);
    world.addBody(body);

    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(hw*2, hh*2, hl*2),
        new THREE.MeshLambertMaterial({ color })
    );
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = mesh.receiveShadow = true;
    addToScene(scene, mesh);
    return { mesh, body };
}

/** Tilted ramp (static box at angle) */
function ramp(scene, world, hw, hh, hl, x, y, z, pitch, yaw, color) {
    const body = new CANNON.Body({ mass: 0 });
    body.addShape(new CANNON.Box(new CANNON.Vec3(hw, hh, hl)));
    body.position.set(x, y, z);
    const q = new CANNON.Quaternion(); q.setFromEuler(pitch, yaw, 0);
    body.quaternion.copy(q);
    tagBody(body);
    world.addBody(body);

    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(hw*2, hh*2, hl*2),
        new THREE.MeshLambertMaterial({ color })
    );
    mesh.position.set(x, y, z);
    mesh.rotation.set(pitch, yaw, 0);
    mesh.castShadow = mesh.receiveShadow = true;
    addToScene(scene, mesh);
    return { mesh, body };
}

/** Dynamic crushable object — box or cylinder */
function dynBox(scene, world, hw, hh, hl, x, y, z, color, mass, ry=0) {
    const body = new CANNON.Body({ mass });
    body.addShape(new CANNON.Box(new CANNON.Vec3(hw, hh, hl)));
    body.position.set(x, y, z);
    if (ry) { const q = new CANNON.Quaternion(); q.setFromEuler(0,ry,0); body.quaternion.copy(q); }
    body.linearDamping = 0.25; body.angularDamping = 0.35;
    tagBody(body);
    world.addBody(body);

    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(hw*2, hh*2, hl*2),
        new THREE.MeshLambertMaterial({ color })
    );
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry;
    mesh.castShadow = true;
    addToScene(scene, mesh);
    return { mesh, body, isDestructible:true, destroyed:false, points:0, label:'💥', origY:y };
}

function dynCyl(scene, world, r, h, x, y, z, color, mass) {
    const body = new CANNON.Body({ mass });
    body.addShape(new CANNON.Cylinder(r, r, h, 12));
    body.position.set(x, y, z);
    body.linearDamping = 0.25; body.angularDamping = 0.35;
    tagBody(body);
    world.addBody(body);

    const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r, h, 14),
        new THREE.MeshLambertMaterial({ color })
    );
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    addToScene(scene, mesh);
    return { mesh, body, isDestructible:true, destroyed:false, points:0, label:'💥', origY:y };
}

/**
 * Scatter terrain bumps — partially buried boxes that protrude slightly.
 * Seed format: [x, z, halfW, halfL, fullHeight, color]
 * fullHeight is the TOTAL visible height above ground (0.3 – 2.0 m is sensible).
 * staticBox takes half-extents, so we divide by 2 internally.
 */
function scatterBumps(scene, world, defs) {
    defs.forEach(([x, z, hw, hl, fullH, color]) => {
        const hh = fullH * 0.5;          // half-height for staticBox
        const cy = fullH * 0.10;         // centre Y: 80% buried, 20% sticking out
        staticBox(scene, world, hw, hh, hl, x, cy, z, color);
    });
}

/** Add directional sun/moon light with shadows */
function sunLight(scene, color, intensity, x, y, z, shadowRange = 90) {
    const l = new THREE.DirectionalLight(color, intensity);
    l.position.set(x, y, z);
    l.castShadow = true;
    l.shadow.mapSize.set(2048, 2048);
    l.shadow.camera.left   = -shadowRange;
    l.shadow.camera.right  =  shadowRange;
    l.shadow.camera.top    =  shadowRange;
    l.shadow.camera.bottom = -shadowRange;
    l.shadow.camera.far    = 300;
    tagMesh(l);
    scene.add(l);
    return l;
}

function ambLight(scene, color, intensity) {
    const a = new THREE.AmbientLight(color, intensity);
    tagMesh(a);
    scene.add(a);
    return a;
}

// ====================================================================
// Arena 0 — Desert Dunes 🏜️
// ====================================================================
function buildDesert(scene, world) {
    setSky(scene, '#d4783a', 0.009);
    makeGround(scene, world, 0xc47a35);
    makeBounds(scene, world, 68);

    const objects = [];
    const sand = 0xb87530, rock = 0x9a6520, rust = 0x8b3a1a;

    // ---- Terrain bumps — scattered across whole arena ----
    const bumps = [];
    const bumpSeeds = [
        [ 12, 18, 3.5, 4, 1.4], [-16, 22, 5, 3, 1.8], [ 28, 8, 4, 5, 2.2],
        [ -8,-20, 6, 4, 1.6], [ 20,-28, 3, 5, 1.2], [-30,  6, 5, 6, 2.5],
        [-18,-10, 4, 3, 1.0], [ 35,-18, 3, 4, 1.5], [-12, 35, 5, 3, 1.1],
        [  5,-35, 6, 5, 2.0], [ 42, 20, 3, 3, 0.9], [-42,-12, 4, 5, 1.8],
        [ 15,-12, 3, 3, 1.0], [-25,-30, 4, 4, 1.4], [ 50, -5, 3, 3, 0.8],
        [-50, 15, 5, 3, 1.6], [  0, 45, 4, 6, 2.0], [ 30, 40, 3, 4, 1.2],
    ];
    bumpSeeds.forEach(([x,z,rx,rz,h]) => bumps.push([x, z, rx, rz, h, sand]));
    scatterBumps(scene, world, bumps);

    // Rocky outcrops (taller, hard obstacles)
    [[-35, 30], [38, -22], [-20, -42], [45, 35]].forEach(([x,z]) =>
        staticBox(scene, world, 2.5, 3.5, 2, x, 3.5, z, rock));

    // ---- Ramps ----
    // Big centre launch ramp (wide, tall)
    ramp(scene, world,  6, 0.4, 10,   0, 4.8,  14, -0.46, 0, sand);
    staticBox(scene, world, 6, 5.0, 0.8,  0, 4.8,  24, sand); // back wall
    staticBox(scene, world, 6, 0.5, 10,   0, 0.0,  14, sand); // ramp floor visible

    // Side ramp L
    ramp(scene, world,  4.5, 0.3, 8, -22, 3.5,  8, -0.44, 0.25, sand);
    // Side ramp R
    ramp(scene, world,  4.5, 0.3, 8,  22, 3.5,  8, -0.44,-0.25, sand);

    // Double-sided jump (facing each other)
    ramp(scene, world,  4, 0.3, 7, -5, 3.2, -16, -0.42, 0, rock);
    ramp(scene, world,  4, 0.3, 7, -5, 3.2, -26,  0.42, 0, rock);

    // Kicker (very steep, short)
    ramp(scene, world,  3, 0.3, 4, 30, 3.0, -10, -0.65, 0, sand);
    staticBox(scene, world, 3, 3.2, 0.5, 30, 3.0, -14, sand);

    // Table-top (flat top)
    staticBox(scene, world, 5, 2.0, 5, -38, 2.0, -20, sand);
    ramp(scene, world, 5, 0.25, 4, -38, 3.0, -25, -0.55, 0, sand);
    ramp(scene, world, 5, 0.25, 4, -38, 3.0, -15,  0.55, 0, sand);

    // ---- Car wrecks — 6 piles ----
    const carCols = [0x1a44aa, 0xaa1a1a, 0x1aaa44, 0xddaa00, 0x883388, 0xee6600];
    [
        [ -12, -16, 2], [  6, -22, 3], [ 20,  12, 2],
        [ -30, -30, 2], [ 40, -10, 2], [ -5,  40, 3],
    ].forEach(([cx, cz, layers], pi) => {
        for (let l = 0; l < layers; l++) {
            const obj = dynBox(scene, world,
                1.05, 0.45, 1.85,
                cx + (Math.random()-.5)*0.4, 0.5 + l*0.95, cz + (Math.random()-.5)*0.4,
                carCols[pi % carCols.length], 200,
                (Math.random()-.5) * 0.4
            );
            obj.points = 150 + l * 50; obj.label = '🚗 CRUSHED!';
            objects.push(obj);
        }
    });

    // ---- Oil drums ----
    for (let i = 0; i < 14; i++) {
        const a = (i/14)*Math.PI*2;
        const r = 20 + (i%3)*6;
        const obj = dynCyl(scene, world, 0.4, 1.1,
            Math.cos(a)*r, 0.55, Math.sin(a)*r,
            i%2===0 ? 0xdd3300 : 0x223355, 80);
        obj.points = 80; obj.label = '🛢️ BARREL!';
        objects.push(obj);
    }

    // ---- Tyre stacks — 8 stacks ----
    const tyrePos = [[-28,12],[18,-8],[8,28],[-5,-38],[30,25],[-38,35],[42,5],[-15,52]];
    tyrePos.forEach(([tx,tz]) => {
        for (let t = 0; t < 4; t++) {
            const obj = dynCyl(scene, world, 0.55, 0.48, tx, 0.24+t*0.49, tz, 0x222222, 45);
            obj.points = 45; obj.label = '🔧 TYRE!';
            objects.push(obj);
        }
    });

    // ---- Buried bus wreck (static but dramatic) ----
    staticBox(scene, world, 1.4, 1.0, 4.5, 15, 0.6, -32, 0xddaa00);

    // ---- Arch gate ----
    staticBox(scene, world, 0.6, 4, 0.6, -6, 4, -6, rock);
    staticBox(scene, world, 0.6, 4, 0.6,  6, 4, -6, rock);
    staticBox(scene, world, 6.6, 0.6, 0.6, 0, 8, -6, rock);

    // ---- Lighting ----
    sunLight(scene, 0xffcc88, 1.5, 40, 70, 30);
    ambLight(scene, 0xff8844, 0.55);

    return { objects, spawnPos: new CANNON.Vec3(0, 4, 0) };
}

// ====================================================================
// Arena 1 — City Crusher 🏙️
// ====================================================================
function buildCity(scene, world) {
    setSky(scene, '#1a1a3a', 0.012);
    makeGround(scene, world, 0x2d2d3e);
    makeBounds(scene, world, 70);

    const objects = [];
    const asphalt = 0x3a3a50, concrete = 0x7a7a8a, yellow = 0xeecc00;

    // Road stripes
    for (let z = -55; z <= 55; z += 10)
        staticBox(scene, world, 0.18, 0.01, 2.5, 0, 0.01, z, yellow);
    for (let x = -55; x <= 55; x += 10)
        staticBox(scene, world, 2.5, 0.01, 0.18, x, 0.01, 0, yellow);

    // ---- Terrain bumps — potholes / rubble piles ----
    const rubble = 0x4a4a5a;
    const cityBumps = [
        [  8, 12, 2.5, 2, 0.7], [-12, -8, 3, 2, 0.9], [ 22,-20, 2, 3, 0.6],
        [-22, 20, 2.5,2.5,0.8], [ 15, 30, 3, 2, 1.0], [-35,  5, 2, 4, 0.7],
        [ 35,-35, 3, 2, 0.8],   [-15,-35, 2, 3, 0.5], [ 45, 15, 2, 2, 0.6],
        [-45,-20, 3, 2, 0.9],   [  0,-50, 4, 3, 1.2], [  0, 50, 4, 3, 1.2],
    ];
    scatterBumps(scene, world, cityBumps.map(([x,z,rx,rz,h]) => [x,z,rx,rz,h,rubble]));

    // ---- Buildings ----
    const buildingDefs = [
        [-50,-35, 9, 15, 9], [ 50,-35, 9, 12, 9], [-50, 35, 9, 18, 9], [ 50, 35, 9, 14, 9],
        [  0,-58, 22, 9, 7], [  0, 58, 22, 9, 7], [-58,  0, 7,  9,22], [ 58,  0, 7,  9,22],
    ];
    buildingDefs.forEach(([x,z,hw,hh,hl]) => {
        staticBox(scene, world, hw, hh, hl, x, hh, z, 0x445566);
        // Window ledge emissive strip
        staticBox(scene, world, hw*0.85, 0.25, 0.05, x, hh*1.8, z+hl+0.1, 0xffffaa);
    });

    // ---- Parked cars — 4 rows ----
    const carPalette = [0xcc2222, 0x2255cc, 0x22aa44, 0xeeaa00, 0x8822cc, 0xaa4400, 0x22aacc, 0xee2266];
    [-30, 30].forEach((rowX, ri) => {
        for (let i = 0; i < 8; i++) {
            const cz  = -35 + i * 10;
            const col = carPalette[(i + ri * 3) % carPalette.length];
            const obj = dynBox(scene, world, 1.15, 0.55, 2.1, rowX, 0.6, cz, col, 250);
            obj.points = 200; obj.label = '🚗 CAR CRUSHED!';
            objects.push(obj);
            // Car roof (linked visually, separate physics)
            const roof = dynBox(scene, world, 0.9, 0.35, 1.1, rowX, 1.55, cz, col, 50);
            roof.points = 0; objects.push(roof);
        }
    });

    // ---- Bus ----
    const bus = dynBox(scene, world, 1.35, 1.05, 4.5, 8, 1.1, 18, 0xffcc00, 500);
    bus.points = 600; bus.label = '🚌 BUS BASHED!';
    objects.push(bus);

    // ---- Lorry / truck ----
    const lorry = dynBox(scene, world, 1.5, 1.2, 5.5, -10, 1.2, -20, 0x994400, 700);
    lorry.points = 700; lorry.label = '🚛 LORRY LAUNCH!';
    objects.push(lorry);

    // ---- Dumpsters ----
    for (let i = 0; i < 8; i++) {
        const x = -18 + i * 5.5;
        const obj = dynBox(scene, world, 0.85, 0.75, 1.3, x, 0.75, -5, 0x224422, 130);
        obj.points = 120; obj.label = '🗑️ SMASHED!';
        objects.push(obj);
    }

    // ---- Traffic cones ----
    for (let i = 0; i < 16; i++) {
        const x = -18 + i * 2.5;
        const obj = dynCyl(scene, world, 0.18, 0.72, x, 0.36, 12, 0xff5500, 12);
        obj.points = 30; obj.label = '🚧 CONE!';
        objects.push(obj);
    }

    // ---- Jersey barriers ----
    for (let i = 0; i < 5; i++) {
        const obj = dynBox(scene, world, 0.4, 0.8, 1.5, -10+i*5, 0.8, 30, concrete, 180);
        obj.points = 60; obj.label = '🧱 BARRIER!';
        objects.push(obj);
    }

    // ---- Concrete ramps ----
    ramp(scene, world,  7, 0.4, 11,  18, 4.5,  5, -0.40, 0, concrete);
    staticBox(scene, world, 7, 4.7, 0.8, 18, 4.5, 16, concrete);
    ramp(scene, world,  7, 0.4, 11, -18, 4.5,  5, -0.40, 0, concrete);
    staticBox(scene, world, 7, 4.7, 0.8,-18, 4.5, 16, concrete);
    ramp(scene, world,  6, 0.35, 9,  0,  3.8, -35, -0.42, 0, concrete);

    // Overpass (high ramp over road)
    staticBox(scene, world, 4, 5.5, 0.5, 0, 5.5, 5, concrete);
    ramp(scene, world, 4, 0.3, 8, 0, 5.5, -4,  -0.55, 0, concrete);
    ramp(scene, world, 4, 0.3, 8, 0, 5.5, 14,   0.55, 0, concrete);

    // ---- Street lights ----
    for (let i = -4; i <= 4; i++) {
        staticBox(scene, world, 0.18, 4.2, 0.18, -12, 4.2, i*14, 0x667788);
        staticBox(scene, world, 1.6, 0.14, 0.14, -10.4, 8.35, i*14, 0x667788);
        // Globe
        const globe = new THREE.Mesh(
            new THREE.SphereGeometry(0.28, 8, 8),
            new THREE.MeshLambertMaterial({ color: 0xffffee, emissive: 0xffffee, emissiveIntensity: 0.9 })
        );
        globe.position.set(-9.2, 8.4, i*14);
        addToScene(scene, globe);
    }

    // ---- Lighting ----
    sunLight(scene, 0x8899cc, 0.8, -20, 55, 10);
    const pt = new THREE.PointLight(0xffeecc, 1.8, 50);
    pt.position.set(0, 14, 0);
    tagMesh(pt); scene.add(pt);
    ambLight(scene, 0x334466, 0.75);

    return { objects, spawnPos: new CANNON.Vec3(0, 3, -12) };
}

// ====================================================================
// Arena 2 — Stadium Slam 🏟️
// ====================================================================
function buildStadium(scene, world) {
    setSky(scene, '#6ab0e8', 0.007);
    makeGround(scene, world, 0x7a4820);  // dirt
    makeBounds(scene, world, 62, 14);

    const objects = [];
    const dirt = 0x8a5228, grey = 0x888898, green = 0x3a8a2a;

    // Grass infield patches
    staticBox(scene, world, 24, 0.04, 32, 0, 0.02, 0, green);

    // Stadium stands (decorative)
    [
        [0, 2, -62, 60, 9, 2], [0, 2,  62, 60, 9, 2],
        [-62, 2, 0, 2, 9, 60], [62, 2, 0, 2, 9, 60],
    ].forEach(([x,y,z,hw,hh,hl]) => {
        staticBox(scene, world, hw, hh, hl, x, hh, z, 0x225599);
        staticBox(scene, world, hw, 0.35, hl, x, hh*1.95, z, 0xcc3333);
    });

    // ---- Terrain bumps — dirt mounds across the floor ----
    const mounds = [
        [ 18,-12, 3.5,3, 1.8], [-18, 12, 4,3.5,2.0], [ 8, 30, 3,4, 1.4],
        [-28,-25, 5, 4, 2.5], [ 35, 18, 3,3.5,1.6], [-35,-15, 4, 5, 2.2],
        [  0,-40, 5, 3, 1.5], [ 40,-35, 3, 3, 1.2], [-10, 50, 4, 4, 1.8],
        [ 45,  5, 3, 3, 1.0], [-45, 30, 4, 3, 1.5], [ 25,-45, 3, 5, 2.0],
    ];
    scatterBumps(scene, world, mounds.map(([x,z,rx,rz,h]) => [x,z,rx,rz,h,dirt]));

    // ---- Big launch ramp (centre stage) ----
    ramp(scene, world,  8, 0.45, 13,   0, 6.5,  16, -0.48, 0, grey);
    staticBox(scene, world, 8, 6.8, 0.9,  0, 6.5,  29, grey);
    staticBox(scene, world, 8, 0.5, 13,   0, 0.0,  16, grey);  // ramp underside

    // Landing zone bump
    staticBox(scene, world, 8, 1.0, 6, 0, 1.0, -14, dirt);

    // ---- Side angled ramps ----
    ramp(scene, world,  5.5, 0.38, 10, -25, 5.0,  10, -0.48, 0, grey);
    staticBox(scene, world, 5.5, 5.2, 0.7, -25, 5.0, 20, grey);
    ramp(scene, world,  5.5, 0.38, 10,  25, 5.0,  10, -0.48, 0, grey);
    staticBox(scene, world, 5.5, 5.2, 0.7,  25, 5.0, 20, grey);

    // ---- Ski-jump ----
    ramp(scene, world,  5, 0.35, 14,  0, 8.0, -26, -0.56, 0, grey);
    staticBox(scene, world, 5, 8.4, 0.8, 0, 8.0, -40, grey);

    // ---- Table-top platform ----
    staticBox(scene, world, 6, 3.5, 5.5, -35, 3.5,  -8, grey);
    ramp(scene, world, 6, 0.3, 5, -35, 4.8, -14, -0.60, 0, grey);
    ramp(scene, world, 6, 0.3, 5, -35, 4.8,  -2,  0.60, 0, grey);

    // ---- Loop-de-loop section (angled walls as partial loop) ----
    ramp(scene, world, 4, 0.35, 5, 38, 5.0, -18, -0.70, 0, grey);
    ramp(scene, world, 4, 0.35, 5, 38, 5.0, -10,  0.70, 0, grey);
    ramp(scene, world, 4, 0.35, 5, 38, 6.5, -14, 0, 0, grey);  // flat top

    // ---- Car pyramid — the centrepiece ----
    const carCols = [0xcc2222, 0x2255cc, 0x22aa44, 0xeeaa00, 0x9933cc, 0xff6600];
    // Base 5
    [-6,-3,0,3,6].forEach((x,i) => {
        const o = dynBox(scene, world, 1.35, 0.52, 2.2, x, 0.55, -22, carCols[i%carCols.length], 220);
        o.points = 250; o.label = '🚗 BASE SMASH!'; objects.push(o);
    });
    // Layer 2 — 4 cars
    [-4.5,-1.5,1.5,4.5].forEach((x,i) => {
        const o = dynBox(scene, world, 1.35, 0.52, 2.2, x, 1.57, -22, carCols[(i+2)%carCols.length], 220);
        o.points = 325; o.label = '🚗 LAYER HIT!'; objects.push(o);
    });
    // Layer 3 — 3 cars
    [-3,0,3].forEach((x,i) => {
        const o = dynBox(scene, world, 1.35, 0.52, 2.2, x, 2.60, -22, carCols[(i+4)%carCols.length], 220);
        o.points = 400; o.label = '🏆 COMBO HIT!'; objects.push(o);
    });
    // Top — golden car
    const topCar = dynBox(scene, world, 1.35, 0.52, 2.2, 0, 3.64, -22, 0xffdd00, 200);
    topCar.points = 750; topCar.label = '👑 TOP CAR!'; objects.push(topCar);

    // ---- Tyre slalom stacks ----
    for (let col = -2; col <= 2; col++) {
        const sx = (col % 2 === 0) ? -18 : 18;
        const sz = col * 11;
        for (let t = 0; t < 5; t++) {
            const o = dynCyl(scene, world, 0.62, 0.52, sx, 0.26+t*0.53, sz, 0x222222, 55);
            o.points = 55; o.label = '🏁 TYRE SMASH!'; objects.push(o);
        }
    }

    // ---- Red barrels around perimeter ----
    for (let i = 0; i < 10; i++) {
        const a = (i/10)*Math.PI*2, r = 20;
        const o = dynCyl(scene, world, 0.45, 1.2,
            Math.cos(a)*r, 0.6, Math.sin(a)*r,
            i%2===0 ? 0xff2200 : 0x0044ff, 90);
        o.points = 85; o.label = '💥 BARREL BASH!'; objects.push(o);
    }

    // ---- Destructible fence posts ----
    for (let i = -5; i <= 5; i++) {
        const o = dynCyl(scene, world, 0.15, 1.5, i*6, 0.75, 35, 0xdddddd, 20);
        o.points = 20; o.label = '🏚️ FENCE DOWN!'; objects.push(o);
    }

    // ---- Spotlights ----
    const spotDefs = [[-45,35,40],[45,35,40],[-45,35,-40],[45,35,-40]];
    spotDefs.forEach(([x,y,z]) => {
        const spot = new THREE.SpotLight(0xffffff, 1.6, 140, Math.PI*0.24, 0.38);
        spot.position.set(x, y, z);
        spot.target.position.set(0, 0, 0);
        spot.castShadow = true;
        tagMesh(spot); tagMesh(spot.target);
        scene.add(spot); scene.add(spot.target);
    });
    ambLight(scene, 0x99aacc, 0.85);

    return { objects, spawnPos: new CANNON.Vec3(0, 3, 38) };
}
