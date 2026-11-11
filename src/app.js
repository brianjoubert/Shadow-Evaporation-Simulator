import * as THREE from "./vendor/three.module.min.js";
import { OrbitControls } from "./vendor/OrbitControls.js";
import polygonClipping from "./vendor/polygon-clipping.esm.js";
import { parseGdsBinary, writeGdsBinary } from "./gds.js";

// Color palette per group
const GROUP_PALETTE = {
  "Electrode 1": { hex: 0x4191ff, css: "#4191ff", rgba: "rgba(65, 145, 255, 0.58)" },
  "Electrode 2": { hex: 0xf05050, css: "#f05050", rgba: "rgba(240, 80, 80, 0.58)" },
  "Bandage":     { hex: 0x37c369, css: "#37c369", rgba: "rgba(55, 195, 105, 0.58)" },
  "Custom":      { hex: 0xe6af37, css: "#e6af37", rgba: "rgba(230, 175, 55, 0.58)" },
};

// Application State
const state = {
  rawGdsBytes: null,
  gdsName: "test_manhattan_bandage.gds",
  rawPolygons: [], // Array of simple rings [[x,y], ...]
  steps: [],
  selectedStepIdx: 0,
  lastSim: null,
};

// ==================== 2D Polygon Geometry Helpers ====================

function makeBoxRing(minX, minY, maxX, maxY) {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

function rotateTranslateRing(ring, angleDeg, dx = 0, dy = 0) {
  const rad = (angleDeg * Math.PI) / 180.0;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return ring.map(([x, y]) => [x * c - y * s + dx, x * s + y * c + dy]);
}

function translateMultiPoly(multiPoly, dx, dy) {
  return multiPoly.map((poly) =>
    poly.map((ring) => ring.map(([x, y]) => [x + dx, y + dy]))
  );
}

function ringSignedArea(ring) {
  let area = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }
  return 0.5 * area;
}

function multiPolyArea(multiPoly) {
  if (!multiPoly || multiPoly.length === 0) return 0;
  let total = 0;
  for (const poly of multiPoly) {
    if (poly.length === 0) continue;
    total += Math.abs(ringSignedArea(poly[0]));
    for (let h = 1; h < poly.length; h++) {
      total -= Math.abs(ringSignedArea(poly[h]));
    }
  }
  return Math.max(0, total);
}

function multiPolyBounds(multiPoly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of multiPoly) {
    for (const ring of poly) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!isFinite(minX)) return { minX: -1500, minY: -1500, maxX: 1500, maxY: 1500 };
  return { minX, minY, maxX, maxY };
}

/**
 * Positive buffer (expansion) of a MultiPolygon by `radius` nm using Minkowski sum
 * of edges (rectangles) and vertices (12-gon disks), merged via polygonClipping.union.
 */
function expandMultiPolygon(multiPoly, radius) {
  if (radius <= 0 || !multiPoly || multiPoly.length === 0) return multiPoly;
  const pieces = [...multiPoly.map((p) => [p[0]])];
  const nArc = 12;

  for (const poly of multiPoly) {
    const ring = poly[0];
    if (!ring || ring.length < 3) continue;
    // Strip duplicate closing vertex if present
    const pts =
      Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 1e-6
        ? ring.slice(0, -1)
        : ring;

    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len > 1e-6) {
        const nx = (-dy / len) * radius;
        const ny = (dx / len) * radius;
        pieces.push([
          [
            [x1 + nx, y1 + ny],
            [x2 + nx, y2 + ny],
            [x2 - nx, y2 - ny],
            [x1 - nx, y1 - ny],
          ],
        ]);
      }
      const disk = [];
      for (let k = 0; k < nArc; k++) {
        const ang = (2 * Math.PI * k) / nArc;
        disk.push([x1 + radius * Math.cos(ang), y1 + radius * Math.sin(ang)]);
      }
      pieces.push([disk]);
    }
  }
  return polygonClipping.union(...pieces);
}

/**
 * Negative buffer (erosion / mask clogging) by `radius` nm.
 */
function erodeMultiPolygon(multiPoly, radius) {
  if (radius <= 0 || !multiPoly || multiPoly.length === 0) return multiPoly;
  const b = multiPolyBounds(multiPoly);
  const pad = radius * 4 + 500;
  const outer = [[makeBoxRing(b.minX - pad, b.minY - pad, b.maxX + pad, b.maxY + pad)]];
  const complement = polygonClipping.difference(outer, multiPoly);
  const expandedComp = expandMultiPolygon(complement, radius);
  return polygonClipping.difference(multiPoly, expandedComp);
}

/**
 * Computes line-of-sight shadow footprint through finite-thickness top resist [hBot, hBot + tTop]
 * intersected with the undercut cavity.
 */
function computeStepShadowFootprint(effectiveMask, cavity, hBot, tTop, tiltDeg, rotDeg, nSlices = 9) {
  const tiltRad = (tiltDeg * Math.PI) / 180.0;
  const rotRad = (rotDeg * Math.PI) / 180.0;
  const tanT = Math.tan(tiltRad);
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);

  const count = tTop > 0 ? nSlices : 1;
  let beam = null;
  for (let i = 0; i < count; i++) {
    const z = count === 1 ? hBot : hBot + (tTop * i) / (count - 1);
    const dx = z * tanT * cosR;
    const dy = z * tanT * sinR;
    const shifted = translateMultiPoly(effectiveMask, dx, dy);
    beam = beam === null ? shifted : polygonClipping.intersection(beam, shifted);
    if (!beam || beam.length === 0) return [];
  }
  return polygonClipping.intersection(beam, cavity);
}

function pointInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInMultiPoly(px, py, multiPoly) {
  for (const poly of multiPoly) {
    if (poly.length === 0) continue;
    if (pointInRing(px, py, poly[0])) {
      let inHole = false;
      for (let h = 1; h < poly.length; h++) {
        if (pointInRing(px, py, poly[h])) {
          inHole = true;
          break;
        }
      }
      if (!inHole) return true;
    }
  }
  return false;
}

// ==================== Deterministic PRNG & Al Grain Bump Map ====================

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createAlGrainTexture(grainSizeNm, seed = 42) {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  const rng = mulberry32(seed);

  // Tileable Voronoi grain centers for realistic polycrystalline Al domes
  const nSeeds = 36;
  const pts = [];
  for (let i = 0; i < nSeeds; i++) {
    pts.push({
      x: rng() * size,
      y: rng() * size,
      facet: 0.85 + 0.3 * rng(),
    });
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let d1 = 1e9, d2 = 1e9, f1 = 1.0;
      for (let i = 0; i < nSeeds; i++) {
        let dx = Math.abs(x - pts[i].x);
        let dy = Math.abs(y - pts[i].y);
        if (dx > size * 0.5) dx = size - dx;
        if (dy > size * 0.5) dy = size - dy;
        const d = Math.hypot(dx, dy);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          f1 = pts[i].facet;
        } else if (d < d2) {
          d2 = d;
        }
      }
      const ridge = 0.5 * (d2 - d1);
      const dome = (1.0 - Math.exp(-ridge / 4.2)) * f1;
      const val = Math.max(0, Math.min(255, Math.floor(dome * 235)));
      const idx = (y * size + x) * 4;
      img.data[idx] = val;
      img.data[idx + 1] = val;
      img.data[idx + 2] = val;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // Repeat in world space (nm): 6 grains per tile of size (6 * grainSizeNm)
  const tileWorldNm = Math.max(12.0, 6.0 * grainSizeNm);
  tex.repeat.set(1.0 / tileWorldNm, 1.0 / tileWorldNm);
  return tex;
}

// ==================== Three.js WebGL Viewport Setup ====================

const container = document.getElementById("webglContainer");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);

const camera = new THREE.PerspectiveCamera(42, 1, 5, 50000);
camera.up.set(0, 0, 1); // Z is vertical film height (nm)
camera.position.set(1600, -2400, 1800);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(600, 400, 30);

// Studio Lighting for Metallic Aluminum Grains
const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 0.95);
hemiLight.position.set(0, 0, 3000);
scene.add(hemiLight);

const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.35);
dirLight1.position.set(2200, -1800, 2800);
dirLight1.castShadow = true;
scene.add(dirLight1);

const dirLight2 = new THREE.DirectionalLight(0x93c5fd, 0.65);
dirLight2.position.set(-2000, 2200, 1600);
scene.add(dirLight2);

const simGroup = new THREE.Group();
scene.add(simGroup);

function resizeWebGL() {
  const w = container.clientWidth || 800;
  const h = container.clientHeight || 500;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  draw2DAndCutCanvases();
}
window.addEventListener("resize", resizeWebGL);

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// ==================== 3D Mesh Builders ====================

function multiPolyToThreeShapes(multiPoly) {
  const shapes = [];
  for (const poly of multiPoly) {
    if (!poly || poly.length === 0 || poly[0].length < 3) continue;
    const outer = poly[0];
    const shape = new THREE.Shape();
    shape.moveTo(outer[0][0], outer[0][1]);
    for (let i = 1; i < outer.length; i++) {
      shape.lineTo(outer[i][0], outer[i][1]);
    }
    shape.closePath();

    for (let h = 1; h < poly.length; h++) {
      const holeRing = poly[h];
      if (holeRing.length < 3) continue;
      const holePath = new THREE.Path();
      holePath.moveTo(holeRing[0][0], holeRing[0][1]);
      for (let i = 1; i < holeRing.length; i++) {
        holePath.lineTo(holeRing[i][0], holeRing[i][1]);
      }
      holePath.closePath();
      shape.holes.push(holePath);
    }
    shapes.push(shape);
  }
  return shapes;
}

function buildConformalBlockMesh(multiPoly, zBot, zTop, groupName, effGrainNm, roughnessFactor, seed, wireframe) {
  const height = zTop - zBot;
  if (height <= 0.05) return null;
  const shapes = multiPolyToThreeShapes(multiPoly);
  if (shapes.length === 0) return null;

  const geom = new THREE.ExtrudeGeometry(shapes, {
    depth: height,
    bevelEnabled: false,
    steps: 1,
  });

  // Displace top-face vertices slightly with grain relief while keeping bottom face strictly flush at zBot
  const pos = geom.attributes.position;
  const rng = mulberry32(seed);
  const amp = roughnessFactor * effGrainNm;
  for (let i = 0; i < pos.count; i++) {
    const zLocal = pos.getZ(i);
    if (Math.abs(zLocal - height) < 0.05) {
      const dz = (rng() - 0.5) * amp;
      pos.setZ(i, zBot + height + dz);
    } else {
      pos.setZ(i, zBot + zLocal);
    }
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();

  const pal = GROUP_PALETTE[groupName] || GROUP_PALETTE["Custom"];
  const grainTex = createAlGrainTexture(effGrainNm, seed);

  const mat = new THREE.MeshStandardMaterial({
    color: pal.hex,
    metalness: 0.62,
    roughness: 0.34,
    bumpMap: grainTex,
    bumpScale: Math.max(0.3, roughnessFactor * effGrainNm * 0.45),
    wireframe: wireframe,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // Crisp subtle edge lines so individual step terraces and junction overlaps are clearly delineated
  if (!wireframe) {
    const edgesGeom = new THREE.EdgesGeometry(geom, 28);
    const edgesMat = new THREE.LineBasicMaterial({
      color: 0x0b0f19,
      transparent: true,
      opacity: 0.38,
    });
    mesh.add(new THREE.LineSegments(edgesGeom, edgesMat));
  }

  return mesh;
}

// ==================== Main Simulation Engine ====================

function runSimulation() {
  if (!state.rawPolygons || state.rawPolygons.length === 0) return;

  const hBot = Math.max(10, parseFloat(document.getElementById("inpHBot").value) || 400);
  const tTop = Math.max(0, parseFloat(document.getElementById("inpTTop").value) || 280);
  const undercut = Math.max(0, parseFloat(document.getElementById("inpUndercut").value) || 200);
  const d0Grain = Math.max(1.0, parseFloat(document.getElementById("inpGrainSize").value) || 5.0);
  const roughness = Math.max(0.0, Math.min(0.8, parseFloat(document.getElementById("inpRoughness").value) || 0.25));
  const clogging = document.getElementById("chkClogging").checked;

  // 1. Union input GDS polygons into topMask
  const inputPolys = state.rawPolygons.map((ring) => [ring]);
  const topMask = polygonClipping.union(...inputPolys);
  const cavity = expandMultiPolygon(topMask, undercut);

  const bounds = multiPolyBounds(cavity);
  const pad = 250;
  const subMinX = bounds.minX - pad;
  const subMinY = bounds.minY - pad;
  const subMaxX = bounds.maxX + pad;
  const subMaxY = bounds.maxY + pad;
  const substrateMultiPoly = [[makeBoxRing(subMinX, subMinY, subMaxX, subMaxY)]];

  // 2. Exact Polygonal Conformal Stacking
  let heightRegions = [{ geom: substrateMultiPoly, zCurr: 0.0 }];
  let effectiveMask = topMask;

  const conformalBlocks = [];
  const oxideBlocks = [];
  const groupOrder = [];
  const groupRecords = {};

  state.steps.forEach((step, sIdx) => {
    const thick = parseFloat(step.thick) || 0;
    if (thick <= 0) return;
    const grp = step.group || "Custom";
    const tilt = parseFloat(step.tilt) || 0;
    const rot = parseFloat(step.rot) || 0;
    const rate = Math.max(0.05, parseFloat(step.rate) || 1.0);

    // Effective Al grain size scales around nominal grain size @ 1 nm/s, 30 nm thickness
    const effGrainNm = d0Grain * Math.pow(thick / 30.0, 0.3) * Math.pow(1.0 / rate, 0.2);

    const footprint = computeStepShadowFootprint(effectiveMask, cavity, hBot, tTop, tilt, rot, 9);
    if (!footprint || footprint.length === 0) return;

    const oxAdd = step.oxidize ? 1.5 : 0.0;
    const nextRegions = [];

    for (const reg of heightRegions) {
      const hit = polygonClipping.intersection(reg.geom, footprint);
      const miss = polygonClipping.difference(reg.geom, footprint);

      if (hit && hit.length > 0 && multiPolyArea(hit) > 0.5) {
        conformalBlocks.push({
          group: grp,
          geom: hit,
          zBot: reg.zCurr,
          zTop: reg.zCurr + thick,
          effGrainNm,
          seed: 300 + sIdx * 53,
        });
        if (step.oxidize) {
          oxideBlocks.push({
            geom: hit,
            zBot: reg.zCurr + thick,
            zTop: reg.zCurr + thick + oxAdd,
          });
        }
        nextRegions.push({ geom: hit, zCurr: reg.zCurr + thick + oxAdd });
      }
      if (miss && miss.length > 0 && multiPolyArea(miss) > 0.5) {
        nextRegions.push({ geom: miss, zCurr: reg.zCurr });
      }
    }
    heightRegions = nextRegions;

    if (!groupRecords[grp]) {
      groupOrder.push(grp);
      groupRecords[grp] = {
        geomUnion: footprint,
        grainSizes: [effGrainNm],
        steps: [step],
      };
    } else {
      groupRecords[grp].geomUnion = polygonClipping.union(groupRecords[grp].geomUnion, footprint);
      groupRecords[grp].grainSizes.push(effGrainNm);
      groupRecords[grp].steps.push(step);
    }

    if (clogging) {
      const clogNm = 0.25 * thick * Math.sin((Math.abs(tilt) * Math.PI) / 180.0);
      if (clogNm > 0.2) {
        const eroded = erodeMultiPolygon(effectiveMask, clogNm);
        if (eroded && eroded.length > 0) effectiveMask = eroded;
      }
    }
  });

  state.lastSim = {
    topMask,
    cavity,
    substrateBounds: { minX: subMinX, minY: subMinY, maxX: subMaxX, maxY: subMaxY },
    substrateMultiPoly,
    hBot,
    tTop,
    roughness,
    conformalBlocks,
    oxideBlocks,
    groupOrder,
    groupRecords,
  };

  rebuildWebGLScene();
  draw2DAndCutCanvases();
  updateMetricsBox();
}

function rebuildWebGLScene() {
  while (simGroup.children.length > 0) {
    const child = simGroup.children.pop();
    if (child.geometry) child.geometry.dispose();
  }
  if (!state.lastSim) return;

  const {
    topMask,
    cavity,
    substrateMultiPoly,
    substrateBounds,
    hBot,
    tTop,
    roughness,
    conformalBlocks,
    oxideBlocks,
  } = state.lastSim;

  const showResist = document.getElementById("chkShowResist").checked;
  const showCavity = document.getElementById("chkShowCavity").checked;
  const wireframe = document.getElementById("chkWireframe").checked;
  const zScale = parseFloat(document.getElementById("selZScale").value) || 1.0;

  simGroup.scale.set(1, 1, zScale);

  // 1. Silicon / Sapphire Substrate Slab
  const subShapes = multiPolyToThreeShapes(substrateMultiPoly);
  const subGeom = new THREE.ExtrudeGeometry(subShapes, { depth: 18, bevelEnabled: false });
  subGeom.translate(0, 0, -18);
  const subMat = new THREE.MeshStandardMaterial({
    color: 0x1e242c,
    metalness: 0.2,
    roughness: 0.75,
    wireframe,
  });
  const subMesh = new THREE.Mesh(subGeom, subMat);
  subMesh.receiveShadow = true;
  simGroup.add(subMesh);

  // Subtle substrate grid
  const cx = 0.5 * (substrateBounds.minX + substrateBounds.maxX);
  const cy = 0.5 * (substrateBounds.minY + substrateBounds.maxY);
  const span = Math.max(substrateBounds.maxX - substrateBounds.minX, substrateBounds.maxY - substrateBounds.minY);
  const grid = new THREE.GridHelper(span, 20, 0x30363d, 0x21262d);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(cx, cy, 0.2);
  simGroup.add(grid);

  // 2. Conformal Aluminum Layer Blocks (Flush zBot -> zTop)
  for (const blk of conformalBlocks) {
    const mesh = buildConformalBlockMesh(
      blk.geom,
      blk.zBot,
      blk.zTop,
      blk.group,
      blk.effGrainNm,
      roughness,
      blk.seed,
      wireframe
    );
    if (mesh) simGroup.add(mesh);
  }

  // 3. AlOx Oxide Barrier Layers
  for (const ox of oxideBlocks) {
    const oxShapes = multiPolyToThreeShapes(ox.geom);
    if (oxShapes.length === 0) continue;
    const oxGeom = new THREE.ExtrudeGeometry(oxShapes, {
      depth: ox.zTop - ox.zBot,
      bevelEnabled: false,
    });
    oxGeom.translate(0, 0, ox.zBot);
    const oxMat = new THREE.MeshStandardMaterial({
      color: 0xf2cc60,
      transparent: true,
      opacity: 0.75,
      roughness: 0.4,
      metalness: 0.1,
    });
    simGroup.add(new THREE.Mesh(oxGeom, oxMat));
  }

  // 4. Undercut Cavity Outline on Substrate
  if (showCavity) {
    for (const poly of cavity) {
      for (const ring of poly) {
        const pts = ring.map(([x, y]) => new THREE.Vector3(x, y, 0.8));
        pts.push(pts[0].clone());
        const lineGeom = new THREE.BufferGeometry().setFromPoints(pts);
        const lineMat = new THREE.LineDashedMaterial({
          color: 0x8b949e,
          dashSize: 35,
          gapSize: 20,
        });
        const line = new THREE.Line(lineGeom, lineMat);
        line.computeLineDistances();
        simGroup.add(line);
      }
    }
  }

  // 5. Optional Translucent Top Resist Mask at [hBot, hBot + tTop]
  if (showResist && tTop > 0) {
    const resistMultiPoly = polygonClipping.difference(substrateMultiPoly, topMask);
    const resShapes = multiPolyToThreeShapes(resistMultiPoly);
    if (resShapes.length > 0) {
      const resGeom = new THREE.ExtrudeGeometry(resShapes, { depth: tTop, bevelEnabled: false });
      resGeom.translate(0, 0, hBot);
      const resMat = new THREE.MeshPhysicalMaterial({
        color: 0xfbbf24,
        transparent: true,
        opacity: 0.22,
        roughness: 0.25,
        depthWrite: false,
      });
      simGroup.add(new THREE.Mesh(resGeom, resMat));
    }
  }
}

// ==================== 2D Top-Down & Cross-Section Canvas Renderers ====================

function draw2DAndCutCanvases() {
  if (!state.lastSim) return;
  draw2DCanvas();
  drawCutCanvas();
}

function draw2DCanvas() {
  const canvas = document.getElementById("canvas2D");
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(100, Math.floor(rect.width * dpr));
  canvas.height = Math.max(100, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, w, h);

  const { topMask, cavity, substrateBounds, groupOrder, groupRecords } = state.lastSim;
  const margin = 24;
  const spanX = substrateBounds.maxX - substrateBounds.minX || 1;
  const spanY = substrateBounds.maxY - substrateBounds.minY || 1;
  const scale = Math.min((w - 2 * margin) / spanX, (h - 2 * margin) / spanY);
  const cx = 0.5 * (substrateBounds.minX + substrateBounds.maxX);
  const cy = 0.5 * (substrateBounds.minY + substrateBounds.maxY);

  const toScreen = (x, y) => [w * 0.5 + (x - cx) * scale, h * 0.5 - (y - cy) * scale];

  function traceMultiPoly(mp) {
    ctx.beginPath();
    for (const poly of mp) {
      for (const ring of poly) {
        ring.forEach(([x, y], i) => {
          const [sx, sy] = toScreen(x, y);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        });
        ctx.closePath();
      }
    }
  }

  // Draw deposited groups
  for (const grp of groupOrder) {
    const rec = groupRecords[grp];
    const pal = GROUP_PALETTE[grp] || GROUP_PALETTE["Custom"];
    traceMultiPoly(rec.geomUnion);
    ctx.fillStyle = pal.rgba;
    ctx.fill("evenodd");
    ctx.strokeStyle = pal.css;
    ctx.lineWidth = 1.1;
    ctx.stroke();
  }

  // Draw undercut cavity (dashed)
  ctx.save();
  ctx.setLineDash([4, 3]);
  traceMultiPoly(cavity);
  ctx.strokeStyle = "#8b949e";
  ctx.lineWidth = 1.0;
  ctx.stroke();
  ctx.restore();

  // Draw top mask opening (crisp white)
  traceMultiPoly(topMask);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = 1.1;
  ctx.stroke();

  // Draw yellow cross-section line cut indicator
  const cutAxis = document.getElementById("selCutAxis").value;
  ctx.save();
  ctx.setLineDash([6, 3]);
  ctx.strokeStyle = "#ffea00";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  if (cutAxis === "X") {
    const [x0, y0] = toScreen(substrateBounds.minX, 0);
    const [x1, y1] = toScreen(substrateBounds.maxX, 0);
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
  } else if (cutAxis === "Y") {
    const [x0, y0] = toScreen(0, substrateBounds.minY);
    const [x1, y1] = toScreen(0, substrateBounds.maxY);
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
  } else if (cutAxis === "B1") {
    const [x0, y0] = toScreen(2900, substrateBounds.minY);
    const [x1, y1] = toScreen(2900, substrateBounds.maxY);
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
  } else if (cutAxis === "B2") {
    const [x0, y0] = toScreen(substrateBounds.minX, 2150);
    const [x1, y1] = toScreen(substrateBounds.maxX, 2150);
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
  }
  ctx.stroke();
  ctx.restore();
}

function drawCutCanvas() {
  const canvas = document.getElementById("canvasCut");
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(100, Math.floor(rect.width * dpr));
  canvas.height = Math.max(100, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, w, h);

  const { substrateBounds, conformalBlocks, roughness, groupOrder } = state.lastSim;
  const cutAxis = document.getElementById("selCutAxis").value;

  const nSamples = 320;
  let sMin, sMax;
  if (cutAxis === "X" || cutAxis === "B2") {
    sMin = substrateBounds.minX;
    sMax = substrateBounds.maxX;
  } else {
    sMin = substrateBounds.minY;
    sMax = substrateBounds.maxY;
  }

  let maxZ = 60.0;
  for (const b of conformalBlocks) {
    if (b.zTop > maxZ) maxZ = b.zTop;
  }
  maxZ *= 1.25;

  const padL = 42, padR = 16, padT = 14, padB = 26;
  const plotW = Math.max(50, w - padL - padR);
  const plotH = Math.max(40, h - padT - padB);

  const toX = (s) => padL + ((s - sMin) / (sMax - sMin || 1)) * plotW;
  const toY = (z) => padT + plotH - (z / maxZ) * plotH;

  // Grid lines & axes
  ctx.strokeStyle = "#21262d";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#8b949e";
  ctx.font = "10px sans-serif";
  for (let k = 0; k <= 4; k++) {
    const zVal = (maxZ * k) / 4;
    const py = toY(zVal);
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(padL + plotW, py);
    ctx.stroke();
    ctx.fillText(`${Math.round(zVal)}`, 8, py + 3);
  }

  // Sample conformal blocks along cut line
  for (const blk of conformalBlocks) {
    const pal = GROUP_PALETTE[blk.group] || GROUP_PALETTE["Custom"];
    const rng = mulberry32(blk.seed + 17);
    const amp = roughness * blk.effGrainNm;

    let inSeg = false;
    let segPtsTop = [];
    let segPtsBot = [];

    const flushSegment = () => {
      if (segPtsTop.length < 2) {
        segPtsTop = [];
        segPtsBot = [];
        return;
      }
      ctx.beginPath();
      segPtsTop.forEach(([sx, sy], idx) => {
        if (idx === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      for (let i = segPtsBot.length - 1; i >= 0; i--) {
        ctx.lineTo(segPtsBot[i][0], segPtsBot[i][1]);
      }
      ctx.closePath();
      ctx.fillStyle = pal.rgba;
      ctx.fill();
      ctx.strokeStyle = pal.css;
      ctx.lineWidth = 1.3;
      ctx.stroke();
      segPtsTop = [];
      segPtsBot = [];
    };

    for (let i = 0; i < nSamples; i++) {
      const s = sMin + ((sMax - sMin) * i) / (nSamples - 1);
      let px = 0, py = 0;
      if (cutAxis === "X") { px = s; py = 0; }
      else if (cutAxis === "Y") { px = 0; py = s; }
      else if (cutAxis === "B1") { px = 2900; py = s; }
      else { px = s; py = 2150; }

      if (pointInMultiPoly(px, py, blk.geom)) {
        const dzGrain = (rng() - 0.5) * amp;
        segPtsTop.push([toX(s), toY(blk.zTop + dzGrain)]);
        segPtsBot.push([toX(s), toY(blk.zBot)]);
        inSeg = true;
      } else if (inSeg) {
        flushSegment();
        inSeg = false;
      }
    }
    if (inSeg) flushSegment();
  }

  // X-axis ticks
  const nTicks = 5;
  for (let k = 0; k <= nTicks; k++) {
    const sVal = sMin + ((sMax - sMin) * k) / nTicks;
    const px = toX(sVal);
    ctx.fillText(`${Math.round(sVal)} nm`, px - 18, h - 6);
  }
}

// ==================== Metrics Summary ====================

function updateMetricsBox() {
  const boxEl = document.getElementById("metricsBox");
  if (!state.lastSim) return;
  const { groupOrder, groupRecords, roughness } = state.lastSim;
  const lines = [];

  for (const grp of groupOrder) {
    const rec = groupRecords[grp];
    const areaNm2 = multiPolyArea(rec.geomUnion);
    const meanGrain = rec.grainSizes.reduce((a, b) => a + b, 0) / rec.grainSizes.length;
    const rmsRough = 0.29 * roughness * meanGrain;
    const angles = rec.steps.map((s) => `(${s.tilt}°,${s.rot}°)`).join(", ");
    lines.push(
      `${grp} [${rec.steps.length} step(s): ${angles}]:\n` +
        `  Area=${Math.round(areaNm2).toLocaleString()} nm² (${(areaNm2 / 1e6).toFixed(4)} µm²) | ` +
        `Grain D≈${meanGrain.toFixed(1)} nm | RMS σ_z≈${rmsRough.toFixed(2)} nm`
    );
  }

  if (groupRecords["Electrode 1"] && groupRecords["Electrode 2"]) {
    const jjOv = polygonClipping.intersection(
      groupRecords["Electrode 1"].geomUnion,
      groupRecords["Electrode 2"].geomUnion
    );
    const jjArea = multiPolyArea(jjOv);
    lines.push("----------------------------------------------------");
    lines.push(
      `JJ Overlap (Electrode 1 ∩ Electrode 2): ${Math.round(jjArea).toLocaleString()} nm² (${(jjArea / 1e6).toFixed(5)} µm²)`
    );
  }

  if (groupRecords["Bandage"]) {
    for (const target of ["Electrode 1", "Electrode 2"]) {
      if (groupRecords[target]) {
        const bOv = polygonClipping.intersection(
          groupRecords["Bandage"].geomUnion,
          groupRecords[target].geomUnion
        );
        const bArea = multiPolyArea(bOv);
        lines.push(
          `Bandage ∩ ${target}: ${Math.round(bArea).toLocaleString()} nm² (${(bArea / 1e6).toFixed(5)} µm²)`
        );
      }
    }
  }

  boxEl.textContent = lines.join("\n");
}

// ==================== Manhattan GDS Generators & Loaders ====================

function generateManhattanLayout(withBandages = true) {
  const rings = [];
  if (withBandages) {
    // Extended orthogonal Manhattan fingers + 2000 nm 45-deg bandage channels at lead ends
    rings.push(makeBoxRing(-1100, -80, 3300, 80));
    rings.push(makeBoxRing(-80, -1100, 80, 2600));
    const bSlot = makeBoxRing(-1000, -80, 1000, 80);
    rings.push(rotateTranslateRing(bSlot, 45, 2900, 0));
    rings.push(rotateTranslateRing(bSlot, 45, 0, 2150));
    state.gdsName = "test_manhattan_bandage.gds";
  } else {
    rings.push(makeBoxRing(-1100, -80, 1100, 80));
    rings.push(makeBoxRing(-80, -1100, 80, 1100));
    state.gdsName = "test_manhattan_2angle.gds";
  }

  const cellName = withBandages ? "MANHATTAN_BANDAGE" : "MANHATTAN_2ANGLE";
  state.rawGdsBytes = writeGdsBinary(cellName, rings, 1);
  state.rawPolygons = rings;

  document.getElementById("lblGdsName").textContent = state.gdsName;
  document.getElementById("inpLayer").value = "1";
  document.getElementById("selUnits").value = "nm";

  runSimulation();
  resetCameraToScene();
}

function loadGdsFromBytes(bytes, fileName) {
  state.rawGdsBytes = bytes;
  state.gdsName = fileName;
  document.getElementById("lblGdsName").textContent = fileName;
  reparseLoadedGds();
  resetCameraToScene();
}

function reparseLoadedGds() {
  if (!state.rawGdsBytes) return;
  const targetLayer = parseInt(document.getElementById("inpLayer").value, 10) || 1;
  const unitsMode = document.getElementById("selUnits").value;
  const parsed = parseGdsBinary(state.rawGdsBytes, targetLayer, unitsMode);
  if (parsed.polygons.length === 0 && parsed.availableLayers.length > 0) {
    const fallbackLayer = parsed.availableLayers[0];
    document.getElementById("inpLayer").value = String(fallbackLayer);
    const retry = parseGdsBinary(state.rawGdsBytes, fallbackLayer, unitsMode);
    state.rawPolygons = retry.polygons;
  } else {
    state.rawPolygons = parsed.polygons;
  }
  runSimulation();
}

// ==================== Step Table & Presets UI ====================

function loadPreset(presetName) {
  if (presetName === "2step") {
    state.steps = [
      { group: "Electrode 1", tilt: 45, rot: 0,   thick: 30, rate: 1.0, oxidize: true },
      { group: "Electrode 2", tilt: 45, rot: 90,  thick: 45, rate: 1.0, oxidize: false },
    ];
  } else if (presetName === "4step_bi") {
    state.steps = [
      { group: "Electrode 1", tilt: 45, rot: 0,   thick: 15, rate: 1.0, oxidize: false },
      { group: "Electrode 1", tilt: 45, rot: 180, thick: 15, rate: 1.0, oxidize: true },
      { group: "Electrode 2", tilt: 45, rot: 90,  thick: 22, rate: 1.0, oxidize: false },
      { group: "Electrode 2", tilt: 45, rot: 270, thick: 22, rate: 1.0, oxidize: false },
    ];
  } else if (presetName === "6step_bi_bandage") {
    state.steps = [
      { group: "Electrode 1", tilt: 45, rot: 0,   thick: 15, rate: 1.0, oxidize: false },
      { group: "Electrode 1", tilt: 45, rot: 180, thick: 15, rate: 1.0, oxidize: true },
      { group: "Electrode 2", tilt: 45, rot: 90,  thick: 22, rate: 1.0, oxidize: false },
      { group: "Electrode 2", tilt: 45, rot: 270, thick: 22, rate: 1.0, oxidize: true },
      { group: "Bandage",     tilt: 45, rot: 45,  thick: 35, rate: 1.0, oxidize: false },
      { group: "Bandage",     tilt: 45, rot: 225, thick: 35, rate: 1.0, oxidize: false },
    ];
  }
  state.selectedStepIdx = 0;
  renderStepsTable();
  runSimulation();
}

function renderStepsTable() {
  const tbody = document.getElementById("stepsTbody");
  tbody.innerHTML = "";
  state.steps.forEach((s, idx) => {
    const tr = document.createElement("tr");
    if (idx === state.selectedStepIdx) tr.classList.add("selected");
    const pal = GROUP_PALETTE[s.group] || GROUP_PALETTE["Custom"];
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td style="color:${pal.css}; font-weight:600;">${s.group}</td>
      <td>${Number(s.tilt).toFixed(1)}</td>
      <td>${Number(s.rot).toFixed(1)}</td>
      <td>${Number(s.thick).toFixed(1)}</td>
      <td>${Number(s.rate).toFixed(2)}</td>
      <td>${s.oxidize ? "Yes" : "No"}</td>
    `;
    tr.addEventListener("click", () => {
      state.selectedStepIdx = idx;
      document.getElementById("edGroup").value = s.group;
      document.getElementById("edTilt").value = s.tilt;
      document.getElementById("edRot").value = s.rot;
      document.getElementById("edThick").value = s.thick;
      document.getElementById("edRate").value = s.rate;
      document.getElementById("edOx").checked = Boolean(s.oxidize);
      renderStepsTable();
    });
    tbody.appendChild(tr);
  });
}

function readStepEditor() {
  return {
    group: document.getElementById("edGroup").value,
    tilt: parseFloat(document.getElementById("edTilt").value) || 0,
    rot: parseFloat(document.getElementById("edRot").value) || 0,
    thick: Math.max(0.5, parseFloat(document.getElementById("edThick").value) || 15),
    rate: Math.max(0.05, parseFloat(document.getElementById("edRate").value) || 1.0),
    oxidize: document.getElementById("edOx").checked,
  };
}

// ==================== Camera Presets ====================

function resetCameraToScene() {
  if (!state.lastSim) return;
  const b = state.lastSim.substrateBounds;
  const cx = 0.5 * (b.minX + b.maxX);
  const cy = 0.5 * (b.minY + b.maxY);
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  controls.target.set(cx, cy, 35);
  camera.position.set(cx + span * 0.45, cy - span * 0.68, span * 0.52);
  controls.update();
}

document.getElementById("camIso").addEventListener("click", resetCameraToScene);
document.getElementById("camTop").addEventListener("click", () => {
  if (!state.lastSim) return;
  const b = state.lastSim.substrateBounds;
  const cx = 0.5 * (b.minX + b.maxX);
  const cy = 0.5 * (b.minY + b.maxY);
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  controls.target.set(cx, cy, 0);
  camera.position.set(cx, cy - 1, span * 1.15);
  controls.update();
});
document.getElementById("camFront").addEventListener("click", () => {
  if (!state.lastSim) return;
  const b = state.lastSim.substrateBounds;
  const cx = 0.5 * (b.minX + b.maxX);
  const cy = 0.5 * (b.minY + b.maxY);
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  controls.target.set(cx, cy, 40);
  camera.position.set(cx, cy - span * 0.85, 120);
  controls.update();
});
document.getElementById("camSide").addEventListener("click", () => {
  if (!state.lastSim) return;
  const b = state.lastSim.substrateBounds;
  const cx = 0.5 * (b.minX + b.maxX);
  const cy = 0.5 * (b.minY + b.maxY);
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  controls.target.set(cx, cy, 40);
  camera.position.set(cx + span * 0.85, cy, 120);
  controls.update();
});
document.getElementById("camZoomJJ").addEventListener("click", () => {
  controls.target.set(250, 250, 40);
  camera.position.set(650, -450, 480);
  controls.update();
});

// ==================== Event Listeners ====================

document.querySelectorAll("[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => loadPreset(btn.dataset.preset));
});

document.getElementById("btnAddStep").addEventListener("click", () => {
  state.steps.push(readStepEditor());
  state.selectedStepIdx = state.steps.length - 1;
  renderStepsTable();
  runSimulation();
});

document.getElementById("btnAddBiPair").addEventListener("click", () => {
  const s = readStepEditor();
  const rot1 = ((s.rot % 360) + 360) % 360;
  const rot2 = (rot1 + 180) % 360;
  state.steps.push({ ...s, rot: rot1, oxidize: false });
  state.steps.push({ ...s, rot: rot2, oxidize: s.oxidize });
  state.selectedStepIdx = state.steps.length - 1;
  renderStepsTable();
  runSimulation();
});

document.getElementById("btnUpdateStep").addEventListener("click", () => {
  if (state.selectedStepIdx >= 0 && state.selectedStepIdx < state.steps.length) {
    state.steps[state.selectedStepIdx] = readStepEditor();
    renderStepsTable();
    runSimulation();
  }
});

document.getElementById("btnRemoveStep").addEventListener("click", () => {
  if (state.selectedStepIdx >= 0 && state.selectedStepIdx < state.steps.length) {
    state.steps.splice(state.selectedStepIdx, 1);
    state.selectedStepIdx = Math.max(0, state.steps.length - 1);
    renderStepsTable();
    runSimulation();
  }
});

document.getElementById("btnMoveUp").addEventListener("click", () => {
  const i = state.selectedStepIdx;
  if (i > 0 && i < state.steps.length) {
    [state.steps[i - 1], state.steps[i]] = [state.steps[i], state.steps[i - 1]];
    state.selectedStepIdx = i - 1;
    renderStepsTable();
    runSimulation();
  }
});

document.getElementById("btnMoveDown").addEventListener("click", () => {
  const i = state.selectedStepIdx;
  if (i >= 0 && i < state.steps.length - 1) {
    [state.steps[i + 1], state.steps[i]] = [state.steps[i], state.steps[i + 1]];
    state.selectedStepIdx = i + 1;
    renderStepsTable();
    runSimulation();
  }
});

document.getElementById("btnClearSteps").addEventListener("click", () => {
  state.steps = [];
  state.selectedStepIdx = -1;
  renderStepsTable();
});

document.getElementById("btnRunSim").addEventListener("click", runSimulation);
document.getElementById("btnGenNoBandage").addEventListener("click", () => generateManhattanLayout(false));
document.getElementById("btnGenBandage").addEventListener("click", () => generateManhattanLayout(true));

document.getElementById("inpLayer").addEventListener("change", reparseLoadedGds);
document.getElementById("selUnits").addEventListener("change", reparseLoadedGds);
document.getElementById("selCutAxis").addEventListener("change", draw2DAndCutCanvases);

["chkShowResist", "chkShowCavity", "chkWireframe", "selZScale"].forEach((id) => {
  document.getElementById(id).addEventListener("change", rebuildWebGLScene);
});

// File Browse (Electron native dialog or fallback HTML5 file input)
document.getElementById("btnBrowseGds").addEventListener("click", async () => {
  if (window.electronAPI && window.electronAPI.openGdsDialog) {
    const res = await window.electronAPI.openGdsDialog();
    if (res && res.bytes) {
      loadGdsFromBytes(res.bytes, res.name);
    }
  } else {
    document.getElementById("fileInputGds").click();
  }
});

document.getElementById("fileInputGds").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  loadGdsFromBytes(new Uint8Array(buf), file.name);
});

document.getElementById("btnSaveGds").addEventListener("click", async () => {
  if (!state.rawGdsBytes) return;
  if (window.electronAPI && window.electronAPI.saveGdsDialog) {
    await window.electronAPI.saveGdsDialog({
      defaultName: state.gdsName,
      bytes: state.rawGdsBytes,
    });
  } else {
    const blob = new Blob([state.rawGdsBytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = state.gdsName || "manhattan_layout.gds";
    a.click();
    URL.revokeObjectURL(url);
  }
});

// Initialize default 6-step bidirectional recipe & Manhattan layout with bandages
setTimeout(() => {
  resizeWebGL();
  loadPreset("6step_bi_bandage");
  generateManhattanLayout(true);
}, 50);
