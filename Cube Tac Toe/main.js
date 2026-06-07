import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CUBIE_SIZE = 0.96;     // slightly less than 1 so there are visible gaps
const STICKER_SIZE = 0.82;   // white sticker square
const STICKER_OFFSET = 0.5;  // half of unit cell -> sticker sits on cubie face
const MARK_OFFSET = 0.002;   // lift mark above sticker to avoid z-fighting
const TURN_DURATION = 260;   // ms per 90deg layer turn
const CLICK_THRESHOLD = 6;   // px of pointer travel still counted as a "click"

// The 6 face normals (outward directions for stickers).
const FACE_NORMALS = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
];

// Standard move definitions: which axis, which layer (coord), and direction.
// `dir` is the sign of rotation about the axis for a clockwise face turn
// (looking at that face from outside). Primed (') moves invert it.
const MOVES = {
  U: { axis: "y", layer: 1, dir: -1 },
  D: { axis: "y", layer: -1, dir: 1 },
  R: { axis: "x", layer: 1, dir: -1 },
  L: { axis: "x", layer: -1, dir: 1 },
  F: { axis: "z", layer: 1, dir: -1 },
  B: { axis: "z", layer: -1, dir: 1 },
};

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const state = {
  phase: "PLACE",      // "PLACE" | "MOVE" | "OVER"
  player: 1,           // 1 = X, 2 = O
  animating: false,
};

// ---------------------------------------------------------------------------
// Three.js setup
// ---------------------------------------------------------------------------
const stage = document.getElementById("stage");
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(4.5, 4.0, 5.5);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
stage.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
controls.enableZoom = true;
controls.minDistance = 4;
controls.maxDistance = 14;
controls.rotateSpeed = 0.9;

// Lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.85));
const dir1 = new THREE.DirectionalLight(0xffffff, 0.6);
dir1.position.set(5, 8, 6);
scene.add(dir1);
const dir2 = new THREE.DirectionalLight(0xffffff, 0.35);
dir2.position.set(-6, -4, -5);
scene.add(dir2);

// Root group holding all cubies.
let cubeRoot = new THREE.Group();
scene.add(cubeRoot);

// Shared materials / geometry.
const bodyMaterial = new THREE.MeshStandardMaterial({
  color: 0x0a0a0a,
  roughness: 0.55,
  metalness: 0.1,
});
const stickerMaterial = new THREE.MeshStandardMaterial({
  color: 0xf7f7f7,
  roughness: 0.5,
  metalness: 0.0,
});
const cubieGeometry = new THREE.BoxGeometry(CUBIE_SIZE, CUBIE_SIZE, CUBIE_SIZE);
const stickerGeometry = new THREE.PlaneGeometry(STICKER_SIZE, STICKER_SIZE);

// All sticker meshes (for raycasting + win detection).
let stickers = [];

// ---------------------------------------------------------------------------
// Cube construction
// ---------------------------------------------------------------------------
function buildCube() {
  // Clear any previous cube.
  scene.remove(cubeRoot);
  cubeRoot = new THREE.Group();
  scene.add(cubeRoot);
  stickers = [];

  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        if (x === 0 && y === 0 && z === 0) continue; // hidden center

        const cubie = new THREE.Group();
        cubie.position.set(x, y, z);

        const body = new THREE.Mesh(cubieGeometry, bodyMaterial);
        cubie.add(body);

        // Add a white sticker on each outward-facing side.
        const coords = { x, y, z };
        for (const normal of FACE_NORMALS) {
          const axis = normal.x !== 0 ? "x" : normal.y !== 0 ? "y" : "z";
          const sign = normal.x + normal.y + normal.z; // +1 or -1
          if (coords[axis] !== sign) continue; // not an outward face

          const sticker = makeSticker(normal);
          cubie.add(sticker);
          stickers.push(sticker);
        }

        cubeRoot.add(cubie);
      }
    }
  }
}

function makeSticker(normal) {
  const sticker = new THREE.Mesh(stickerGeometry, stickerMaterial);

  // Position the sticker plane on the cubie face and orient it outward.
  sticker.position.copy(normal).multiplyScalar(STICKER_OFFSET);
  orientPlaneToNormal(sticker, normal);

  sticker.userData.mark = null; // 1 (X), 2 (O), or null
  sticker.userData.markMesh = null;
  return sticker;
}

// A PlaneGeometry faces +Z by default; rotate so it faces the given normal.
function orientPlaneToNormal(mesh, normal) {
  const from = new THREE.Vector3(0, 0, 1);
  const quat = new THREE.Quaternion().setFromUnitVectors(from, normal);
  mesh.quaternion.copy(quat);
}

// ---------------------------------------------------------------------------
// Mark textures (X = red, O = blue) drawn on a canvas.
// ---------------------------------------------------------------------------
const markTextures = { 1: makeMarkTexture("X", "#e2362c"), 2: makeMarkTexture("O", "#2f6fe0") };

function makeMarkTexture(glyph, color) {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  ctx.lineWidth = size * 0.14;
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  const m = size * 0.26; // margin
  if (glyph === "X") {
    ctx.beginPath();
    ctx.moveTo(m, m);
    ctx.lineTo(size - m, size - m);
    ctx.moveTo(size - m, m);
    ctx.lineTo(m, size - m);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - m, 0, Math.PI * 2);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

function placeMark(sticker, player) {
  sticker.userData.mark = player;
  const mat = new THREE.MeshBasicMaterial({
    map: markTextures[player],
    transparent: true,
  });
  const mesh = new THREE.Mesh(stickerGeometry, mat);
  // Slightly in front of the sticker, sharing its orientation (child of sticker).
  mesh.position.set(0, 0, MARK_OFFSET);
  sticker.add(mesh);
  sticker.userData.markMesh = mesh;
}

// ---------------------------------------------------------------------------
// Raycasting for mark placement
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDownPos = null;

renderer.domElement.addEventListener("pointerdown", (e) => {
  pointerDownPos = { x: e.clientX, y: e.clientY };
});

renderer.domElement.addEventListener("pointerup", (e) => {
  if (!pointerDownPos) return;
  const dx = e.clientX - pointerDownPos.x;
  const dy = e.clientY - pointerDownPos.y;
  const moved = Math.hypot(dx, dy);
  pointerDownPos = null;
  if (moved > CLICK_THRESHOLD) return; // a drag (handled by OrbitControls)
  handleClick(e);
});

function handleClick(e) {
  if (state.phase !== "PLACE" || state.animating) return;

  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(stickers, false);
  if (hits.length === 0) return;

  // Use the nearest sticker that faces the camera (front-most hit).
  const sticker = hits[0].object;
  if (sticker.userData.mark !== null) return; // occupied

  placeMark(sticker, state.player);
  state.phase = "MOVE";
  updateUI();
}

// ---------------------------------------------------------------------------
// Layer moves (animated turn + bake)
// ---------------------------------------------------------------------------
function performMove(notation) {
  if (state.phase !== "MOVE" || state.animating) return;

  const prime = notation.includes("'");
  const base = notation.replace("'", "");
  const def = MOVES[base];
  if (!def) return;

  const axisVec = new THREE.Vector3(
    def.axis === "x" ? 1 : 0,
    def.axis === "y" ? 1 : 0,
    def.axis === "z" ? 1 : 0
  );
  const angle = (Math.PI / 2) * def.dir * (prime ? -1 : 1);

  // Collect cubies in the target layer and reparent them under a pivot,
  // using attach() to preserve their world transforms.
  const pivot = new THREE.Group();
  cubeRoot.add(pivot);
  const layerCubies = [];
  for (const cubie of [...cubeRoot.children]) {
    if (cubie === pivot) continue;
    const coord = Math.round(cubie.position[def.axis]);
    if (coord === def.layer) {
      layerCubies.push(cubie);
      pivot.attach(cubie);
    }
  }

  state.animating = true;
  updateUI();

  const start = performance.now();
  function animateTurn(now) {
    const t = Math.min((now - start) / TURN_DURATION, 1);
    const eased = easeInOut(t);
    pivot.setRotationFromAxisAngle(axisVec, angle * eased);
    if (t < 1) {
      requestAnimationFrame(animateTurn);
    } else {
      // Bake: reparent cubies back to root preserving world transform,
      // then snap positions to the integer grid.
      for (const cubie of layerCubies) {
        cubeRoot.attach(cubie);
        cubie.position.set(
          Math.round(cubie.position.x),
          Math.round(cubie.position.y),
          Math.round(cubie.position.z)
        );
      }
      cubeRoot.remove(pivot);
      state.animating = false;
      finishTurn();
    }
  }
  requestAnimationFrame(animateTurn);
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// ---------------------------------------------------------------------------
// Turn resolution + win detection
// ---------------------------------------------------------------------------
function finishTurn() {
  const winner = checkWin();
  if (winner) {
    state.phase = "OVER";
    showBanner(winner);
    updateUI();
    return;
  }
  state.player = state.player === 1 ? 2 : 1;
  state.phase = "PLACE";
  updateUI();
}

// Read all stickers' world positions/normals, group into 6 faces, build a
// 3x3 grid per face, and check the 8 tic-tac-toe lines.
function checkWin() {
  cubeRoot.updateWorldMatrix(true, true);

  // Bucket stickers by their (rounded) world-space outward normal.
  const faces = new Map(); // key: normal string -> array of {sticker, pos}
  const tmpPos = new THREE.Vector3();
  const tmpNorm = new THREE.Vector3();

  for (const sticker of stickers) {
    sticker.getWorldPosition(tmpPos);
    // Outward normal = local +Z transformed to world.
    tmpNorm.set(0, 0, 1).applyQuaternion(sticker.getWorldQuaternion(new THREE.Quaternion()));
    const nx = Math.round(tmpNorm.x);
    const ny = Math.round(tmpNorm.y);
    const nz = Math.round(tmpNorm.z);
    const key = `${nx},${ny},${nz}`;
    if (!faces.has(key)) faces.set(key, []);
    faces.get(key).push({
      mark: sticker.userData.mark,
      pos: tmpPos.clone(),
      n: { nx, ny, nz },
    });
  }

  for (const [, items] of faces) {
    if (items.length !== 9) continue;
    const grid = toGrid(items);
    const winner = checkGridLines(grid);
    if (winner) return winner;
  }
  return null;
}

// Arrange 9 face stickers into a row-major 3x3 grid of marks using the two
// in-plane axes for the face.
function toGrid(items) {
  const { nx, ny, nz } = items[0].n;
  // Choose the two in-plane axes (the ones that aren't the normal axis).
  let uAxis, vAxis;
  if (nx !== 0) {
    uAxis = "z";
    vAxis = "y";
  } else if (ny !== 0) {
    uAxis = "x";
    vAxis = "z";
  } else {
    uAxis = "x";
    vAxis = "y";
  }

  // Map continuous coords (~ -1.5..1.5) to grid indices 0..2.
  const toIdx = (v) => (v > 0.5 ? 2 : v < -0.5 ? 0 : 1);

  const grid = [
    [null, null, null],
    [null, null, null],
    [null, null, null],
  ];
  for (const it of items) {
    const col = toIdx(it.pos[uAxis]);
    const row = toIdx(it.pos[vAxis]);
    grid[row][col] = it.mark;
  }
  return grid;
}

function checkGridLines(g) {
  const lines = [
    // rows
    [g[0][0], g[0][1], g[0][2]],
    [g[1][0], g[1][1], g[1][2]],
    [g[2][0], g[2][1], g[2][2]],
    // cols
    [g[0][0], g[1][0], g[2][0]],
    [g[0][1], g[1][1], g[2][1]],
    [g[0][2], g[1][2], g[2][2]],
    // diagonals
    [g[0][0], g[1][1], g[2][2]],
    [g[0][2], g[1][1], g[2][0]],
  ];

  let foundActive = null;
  let foundOther = null;
  for (const [a, b, c] of lines) {
    if (a !== null && a === b && b === c) {
      if (a === state.player) foundActive = a;
      else foundOther = a;
    }
  }
  // Tiebreak: the player who just moved (active player) wins if both lines form.
  return foundActive || foundOther || null;
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
const statusEl = document.getElementById("status");
const moveButtons = [...document.querySelectorAll(".move-btn")];
const bannerEl = document.getElementById("banner");
const bannerTextEl = document.getElementById("banner-text");

function updateUI() {
  const mark = state.player === 1 ? "X" : "O";
  const who = `Player ${state.player} (${mark})`;

  if (state.phase === "PLACE") {
    statusEl.textContent = `${who}: place your mark`;
  } else if (state.phase === "MOVE") {
    statusEl.textContent = state.animating
      ? `${who}: turning…`
      : `${who}: make a move`;
  } else if (state.phase === "OVER") {
    statusEl.textContent = "Game over";
  }

  statusEl.classList.toggle("turn-x", state.player === 1 && state.phase !== "OVER");
  statusEl.classList.toggle("turn-o", state.player === 2 && state.phase !== "OVER");

  const movesEnabled = state.phase === "MOVE" && !state.animating;
  for (const btn of moveButtons) btn.disabled = !movesEnabled;
}

for (const btn of moveButtons) {
  btn.addEventListener("click", () => performMove(btn.dataset.move));
}

function showBanner(winner) {
  const mark = winner === 1 ? "X" : "O";
  bannerTextEl.textContent = `Player ${winner} (${mark}) wins!`;
  bannerEl.classList.remove("hidden");
}

function newGame() {
  bannerEl.classList.add("hidden");
  buildCube();
  state.phase = "PLACE";
  state.player = 1;
  state.animating = false;
  updateUI();
}

document.getElementById("new-game").addEventListener("click", newGame);
document.getElementById("banner-new-game").addEventListener("click", newGame);

// ---------------------------------------------------------------------------
// Resize + render loop
// ---------------------------------------------------------------------------
function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);

function render() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
buildCube();
resize();
updateUI();
render();
