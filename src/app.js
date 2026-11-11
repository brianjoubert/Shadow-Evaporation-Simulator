import * as THREE from "./vendor/three.module.min.js";
import { OrbitControls } from "./vendor/OrbitControls.js";
import ClipperLib from "./vendor/clipper.esm.js";
import { parseGdsBinary, writeGdsBinary } from "./gds.js";

const CLIP_SCALE = 100.0;

function multiPolyToPaths(mp) {
  const paths = [];
  if (!mp) return paths;
  for (const poly of mp) {
    for (let r = 0; r < poly.length; r++) {
      const ring = poly[r];
      if (!ring || ring.length < 3) continue;
      const path = ring.map(([x, y]) => ({
        X: Math.round(x * CLIP_SCALE),
        Y: Math.round(y * CLIP_SCALE),
      }));
      const orient = ClipperLib.Clipper.Orientation(path);
      if (r === 0 && !orient) path.reverse();
      if (r > 0 && orient) path.reverse();
      paths.push(path);
    }
  }
  return paths;
}

function polyTreeToMultiPoly(polyTree) {
  const result = [];
  function visitNode(node) {
    const contour = node.Contour ? node.Contour() : [];
    if (contour.length >= 3 && !node.IsHole()) {
      const outer = contour.map((pt) => [pt.X / CLIP_SCALE, pt.Y / CLIP_SCALE]);
      const poly = [outer];
      const children = node.Childs();
      for (let i = 0; i < children.length; i++) {
        const holeNode = children[i];
        const hContour = holeNode.Contour();
        if (hContour.length >= 3) {
          poly.push(hContour.map((pt) => [pt.X / CLIP_SCALE, pt.Y / CLIP_SCALE]));
        }
        const grandChildren = holeNode.Childs();
        for (let j = 0; j < grandChildren.length; j++) {
          visitNode(grandChildren[j]);
        }
      }
      result.push(poly);
    } else {
      const children = node.Childs();
      for (let i = 0; i < children.length; i++) {
        visitNode(children[i]);
      }
    }
  }
  visitNode(polyTree);
  return result;
}

function clipOp(clipType, subjMP, clipMP = null) {
  const c = new ClipperLib.Clipper();
  const sPaths = multiPolyToPaths(subjMP);
  if (sPaths.length === 0) return [];
  c.AddPaths(sPaths, ClipperLib.PolyType.ptSubject, true);
  if (clipMP) {
    const cPaths = multiPolyToPaths(clipMP);
    if (cPaths.length === 0) {
      return clipType === ClipperLib.ClipType.ctIntersection ? [] : subjMP;
    }
    c.AddPaths(cPaths, ClipperLib.PolyType.ptClip, true);
  }
  const tree = new ClipperLib.PolyTree();
  c.Execute(
    clipType,
    tree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero
  );
  return polyTreeToMultiPoly(tree);
}

const polygonClipping = {
  union: (...mps) => {
    const combined = [];
    for (const mp of mps) {
      if (mp && mp.length > 0) combined.push(...mp);
    }
    return clipOp(ClipperLib.ClipType.ctUnion, combined, null);
  },
  intersection: (a, b) => clipOp(ClipperLib.ClipType.ctIntersection, a, b),
  difference: (a, b) => clipOp(ClipperLib.ClipType.ctDifference, a, b),
};

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
  rawPolygons: [],
  steps: [],
  selectedStepIdx: 0,
  lastSim: null,
};

// ==================== 2D Polygon & Analytic Signed-Distance Helpers ====================

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

function expandMultiPolygon(multiPoly, radius) {
  if (radius <= 0 || !multiPoly || multiPoly.length === 0) return multiPoly;
  const co = new ClipperLib.ClipperOffset(2.0, 4.0 * CLIP_SCALE);
  const paths = multiPolyToPaths(multiPoly);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const tree = new ClipperLib.PolyTree();
  co.Execute(tree, radius * CLIP_SCALE);
  return polyTreeToMultiPoly(tree);
}

function erodeMultiPolygon(multiPoly, radius) {
  if (radius <= 0 || !multiPoly || multiPoly.length === 0) return multiPoly;
  const co = new ClipperLib.ClipperOffset(2.0, 4.0 * CLIP_SCALE);
  const paths = multiPolyToPaths(multiPoly);
  co.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const tree = new ClipperLib.PolyTree();
  co.Execute(tree, -radius * CLIP_SCALE);
  return polyTreeToMultiPoly(tree);
}

/**
 * Computes line-of-sight shadow footprint through finite-thickness top resist [hBot, hBot + tTop]
 * intersected with the undercut cavity, filtering out tiny corner-leakage specks (< 3500 nm²).
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
  const raw = polygonClipping.intersection(beam, cavity);
  // Remove tiny parasitic corner specks (< 3500 nm²)
  return raw.filter((poly) => poly.length > 0 && Math.abs(ringSignedArea(poly[0])) >= 3500);
}

/**
 * Exact signed Euclidean distance from (px, py) to a single polygon (outer ring + optional holes).
 * Positive inside the polygon, negative outside.
 */
function signedDistToRing(px, py, ring) {
  let inside = false;
  let minDistSq = Infinity;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const x1 = ring[j][0], y1 = ring[j][1];
    const x2 = ring[i][0], y2 = ring[i][1];
    if (y2 > py !== y1 > py && px < ((x1 - x2) * (py - y2)) / (y1 - y2 + 1e-12) + x2) {
      inside = !inside;
    }
    const dx = x2 - x1;
    const dy = y2 - y1;
    const l2 = dx * dx + dy * dy || 1.0;
    let t = ((px - x1) * dx + (py - y1) * dy) / l2;
    if (t < 0.0) t = 0.0;
    else if (t > 1.0) t = 1.0;
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    const dSq = (px - projX) * (px - projX) + (py - projY) * (py - projY);
    if (dSq < minDistSq) minDistSq = dSq;
  }
  const d = Math.sqrt(minDistSq);
  return inside ? d : -d;
}

function signedDistToMultiPoly(px, py, multiPoly) {
  let maxDist = -Infinity;
  for (let p = 0; p < multiPoly.length; p++) {
    const poly = multiPoly[p];
    if (!poly || poly.length === 0) continue;
    let dPoly = signedDistToRing(px, py, poly[0]);
    for (let h = 1; h < poly.length; h++) {
      const dHole = signedDistToRing(px, py, poly[h]);
      if (-dHole < dPoly) dPoly = -dHole;
    }
    if (dPoly > maxDist) maxDist = dPoly;
  }
  return maxDist;
}

/**
 * C2-continuous quintic smoothstep S-curve ramp over [-0.5 * slopeW, +0.5 * slopeW].
 * Models physical shadow penumbra + adatom surface diffusion slope so step edges
 * and layer climbs are smooth curves instead of vertical Minecraft blocks.
 */
function smoothStepRamp(signedDist, slopeW) {
  const half = 0.5 * slopeW;
  if (signedDist <= -half) return 0.0;
  if (signedDist >= half) return 1.0;
  const t = (signedDist + half) / slopeW;
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

// ==================== Deterministic PRNG & Al Grain Textures ====================

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

/**
 * Continuous spatial grain height modulation at (x, y) with characteristic wavelength ~ effGrainNm
 */
function spatialGrainRelief(x, y, effGrainNm, seed) {
  const k = (2.0 * Math.PI) / Math.max(4.0, effGrainNm * 2.2);
  const p1 = seed * 0.17;
  const p2 = seed * 0.31;
  const g1 = Math.sin(x * k + p1) * Math.cos(y * k - p2);
  const g2 = Math.sin((x * 0.866 + y * 0.5) * k * 1.35 - p1) * Math.cos((-x * 0.5 + y * 0.866) * k * 1.35 + p2);
  const g3 = Math.cos((x * 0.5 - y * 0.866) * k * 1.7 + p2);
  return 0.45 * g1 + 0.35 * g2 + 0.2 * g3;
}

function createAlGrainTexture(grainSizeNm, seed = 42) {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  const rng = mulberry32(seed);

  // Dense Voronoi polycrystalline Al grain domes
  const nSeeds = 95;
  const pts = [];
  for (let i = 0; i < nSeeds; i++) {
    pts.push({
      x: rng() * size,
      y: rng() * size,
      facet: 0.82 + 0.36 * rng(),
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
        const d = dx * dx + dy * dy;
        if (d < d1) {
          d2 = d1;
          d1 = d;
          f1 = pts[i].facet;
        } else if (d < d2) {
          d2 = d;
        }
      }
      const ridge = 0.5 * (Math.sqrt(d2) - Math.sqrt(d1));
      const dome = (1.0 - Math.exp(-ridge / 3.2)) * f1;
      const val = Math.max(0, Math.min(255, Math.floor(dome * 240)));
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
  return tex;
}

// ==================== Three.js WebGL Viewport Setup ====================

const container = document.getElementById("webglContainer");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);

const camera = new THREE.PerspectiveCamera(40, 1, 5, 50000);
camera.up.set(0, 0, 1);
camera.position.set(1600, -2400, 1800);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(600, 400, 30);

const hemiLight = new THREE.HemisphereLight(0xe2e8f0, 0x1e293b, 1.0);
hemiLight.position.set(0, 0, 3000);
scene.add(hemiLight);

const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.45);
dirLight1.position.set(2200, -1800, 2800);
dirLight1.castShadow = true;
scene.add(dirLight1);

const dirLight2 = new THREE.DirectionalLight(0x93c5fd, 0.7);
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

// ==================== Smooth Sloped Topographic Surface & 3D Al Grain Builder ====================

function evalStepSmoothDz(px, py, stepObj, slopeW) {
  const d = signedDistToMultiPoly(px, py, stepObj.footprint);
  return stepObj.thick * smoothStepRamp(d, slopeW);
}

function evalPriorGroupsHeight(px, py, priorSteps, slopeW) {
  let z = 0.0;
  for (let i = 0; i < priorSteps.length; i++) {
    z += evalStepSmoothDz(px, py, priorSteps[i], slopeW);
  }
  return z;
}

function evalGroupDz(px, py, groupSteps, slopeW) {
  let dz = 0.0;
  for (let i = 0; i < groupSteps.length; i++) {
    dz += evalStepSmoothDz(px, py, groupSteps[i], slopeW);
  }
  return dz;
}

/**
 * Builds a smooth, angle-aligned 3D topographic surface mesh + 3D Instanced Al nanograins
 * for a single layer group. Eliminates vertical 90° Minecraft walls in favor of realistic
 * C2-smooth sloped edges, smooth conformal step climbs, and visible 3D Al grains.
 */
function buildSmoothGroupMeshes(
  groupName,
  groupRec,
  priorSteps,
  slopeW,
  roughness,
  wireframe,
  seed
) {
  const meshes = [];
  const pal = GROUP_PALETTE[groupName] || GROUP_PALETTE["Custom"];
  const effGrainNm =
    groupRec.grainSizes.reduce((a, b) => a + b, 0) / Math.max(1, groupRec.grainSizes.length);
  const grainTex = createAlGrainTexture(effGrainNm, seed);

  // Dominant orientation angle of this group (e.g. 0° for Electrode 1, 90° for Electrode 2, 45° for Bandage)
  const domAngleDeg = groupRec.steps.length > 0 ? groupRec.steps[0].rot : 0.0;
  const rad = (domAngleDeg * Math.PI) / 180.0;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);

  const grainPositions = [];
  const grainNormals = [];

  // Build an angle-aligned smooth surface mesh for each connected polygon in geomUnion
  for (let pIdx = 0; pIdx < groupRec.geomUnion.length; pIdx++) {
    const poly = groupRec.geomUnion[pIdx];
    if (!poly || poly.length === 0) continue;

    // Find tight bounding box in rotated local coordinates (u, v)
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const [x, y] of poly[0]) {
      const u = x * cosA + y * sinA;
      const v = -x * sinA + y * cosA;
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    const margin = slopeW * 0.65 + 8.0;
    uMin -= margin;
    uMax += margin;
    vMin -= margin;
    vMax += margin;

    const spanU = uMax - uMin;
    const spanV = vMax - vMin;
    // Fine grid spacing: ~9 nm along length, ~5 nm across width for silky-smooth sloped ramps
    const nu = Math.max(32, Math.min(340, Math.ceil(spanU / 9.0)));
    const nv = Math.max(28, Math.min(200, Math.ceil(spanV / 5.0)));
    const du = spanU / (nu - 1);
    const dv = spanV / (nv - 1);

    const nVerts = nu * nv;
    const positions = new Float32Array(nVerts * 3);
    const uvs = new Float32Array(nVerts * 2);
    const dzGrid = new Float32Array(nVerts);
    const zTopGrid = new Float32Array(nVerts);

    const uvRepeatScale = 1.0 / Math.max(22.0, effGrainNm * 6.5);
    const grainAmp = roughness * effGrainNm * 0.75;

    for (let i = 0; i < nu; i++) {
      const u = uMin + i * du;
      for (let j = 0; j < nv; j++) {
        const v = vMin + j * dv;
        const x = u * cosA - v * sinA;
        const y = u * sinA + v * cosA;
        const idx = i * nv + j;

        const zBot = evalPriorGroupsHeight(x, y, priorSteps, slopeW);
        const dz = evalGroupDz(x, y, groupRec.stepObjs, slopeW);
        dzGrid[idx] = dz;

        // Attenuate grain ripple smoothly to 0 at the bottom toe so the film edge seals flush onto zBot
        const env = Math.min(1.0, dz / 5.0);
        const gRipple = grainAmp * env * spatialGrainRelief(x, y, effGrainNm, seed + pIdx * 19);
        const zTop = dz > 0.03 ? zBot + dz + gRipple : Math.max(0.0, zBot - 0.12);
        zTopGrid[idx] = zTop;

        positions[idx * 3] = x;
        positions[idx * 3 + 1] = y;
        positions[idx * 3 + 2] = zTop;

        uvs[idx * 2] = u * uvRepeatScale;
        uvs[idx * 2 + 1] = v * uvRepeatScale;
      }
    }

    // Emit triangles for all active cells
    const indices = [];
    for (let i = 0; i < nu - 1; i++) {
      for (let j = 0; j < nv - 1; j++) {
        const i00 = i * nv + j;
        const i10 = (i + 1) * nv + j;
        const i01 = i * nv + (j + 1);
        const i11 = (i + 1) * nv + (j + 1);

        if (
          dzGrid[i00] > 0.06 ||
          dzGrid[i10] > 0.06 ||
          dzGrid[i01] > 0.06 ||
          dzGrid[i11] > 0.06
        ) {
          indices.push(i00, i10, i11);
          indices.push(i00, i11, i01);
        }
      }
    }

    if (indices.length === 0) continue;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: pal.hex,
      metalness: 0.58,
      roughness: 0.42,
      bumpMap: grainTex,
      bumpScale: Math.max(0.35, roughness * effGrainNm * 0.42),
      wireframe,
      side: THREE.DoubleSide,
    });

    const surfMesh = new THREE.Mesh(geom, mat);
    surfMesh.castShadow = true;
    surfMesh.receiveShadow = true;
    meshes.push(surfMesh);

    // Uniform jittered lattice sampling for tightly-packed, subtle 3D Al nanograins (no sparse droplet look)
    const normalsAttr = geom.attributes.normal;
    const rng = mulberry32(seed + pIdx * 71);
    const stepI = Math.max(1, Math.round(11.0 / du));
    const stepJ = Math.max(1, Math.round(11.0 / dv));
    for (let i = 1; i < nu - 1; i += stepI) {
      for (let j = 1; j < nv - 1; j += stepJ) {
        const vIdx = i * nv + j;
        if (dzGrid[vIdx] > 1.2) {
          grainPositions.push(
            positions[vIdx * 3] + (rng() - 0.5) * du * 0.85,
            positions[vIdx * 3 + 1] + (rng() - 0.5) * dv * 0.85,
            positions[vIdx * 3 + 2] - 0.25
          );
          grainNormals.push(
            normalsAttr.getX(vIdx),
            normalsAttr.getY(vIdx),
            normalsAttr.getZ(vIdx)
          );
        }
      }
    }
  }

  // Create subtle, tightly-packed 3D Instanced Aluminum Nanograins across the sloped film surface
  if (!wireframe && grainPositions.length > 0) {
    const nGrains = grainPositions.length / 3;
    const xyRadius = Math.max(4.5, effGrainNm * 1.05);
    const zRadius = Math.max(0.9, effGrainNm * (0.16 + 0.22 * roughness));

    const pebbleGeom = new THREE.IcosahedronGeometry(1.0, 1);
    pebbleGeom.scale(xyRadius, xyRadius, zRadius);

    const pebbleMat = new THREE.MeshStandardMaterial({
      color: pal.hex,
      metalness: 0.62,
      roughness: 0.38,
    });

    const instMesh = new THREE.InstancedMesh(pebbleGeom, pebbleMat, nGrains);
    instMesh.castShadow = false;
    instMesh.receiveShadow = true;

    const dummy = new THREE.Object3D();
    const upVec = new THREE.Vector3(0, 0, 1);
    const normVec = new THREE.Vector3();
    const baseColor = new THREE.Color(pal.hex);
    const instColor = new THREE.Color();
    const rng = mulberry32(seed + 999);

    for (let k = 0; k < nGrains; k++) {
      const gx = grainPositions[k * 3];
      const gy = grainPositions[k * 3 + 1];
      const gz = grainPositions[k * 3 + 2];

      normVec.set(
        grainNormals[k * 3],
        grainNormals[k * 3 + 1],
        Math.max(0.25, grainNormals[k * 3 + 2])
      ).normalize();

      dummy.position.set(gx, gy, gz);
      dummy.quaternion.setFromUnitVectors(upVec, normVec);
      dummy.rotateZ(rng() * Math.PI * 2);
      const sxy = 0.82 + 0.38 * rng();
      const sz = 0.8 + 0.4 * rng();
      dummy.scale.set(sxy, sxy, sz);
      dummy.updateMatrix();
      instMesh.setMatrixAt(k, dummy.matrix);

      const shade = 0.94 + 0.12 * rng();
      instColor.copy(baseColor).multiplyScalar(shade);
      instMesh.setColorAt(k, instColor);
    }
    instMesh.instanceMatrix.needsUpdate = true;
    if (instMesh.instanceColor) instMesh.instanceColor.needsUpdate = true;
    meshes.push(instMesh);
  }

  return meshes;
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

  // Physical penumbra & adatom diffusion slope width (nm) for smooth sloped edges
  const slopeW = 46.0;

  // 1. Union input GDS polygons into topMask
  const inputPolys = state.rawPolygons.map((ring) => [[ring]]);
  const topMask = polygonClipping.union(...inputPolys);
  const cavity = expandMultiPolygon(topMask, undercut);

  const bounds = multiPolyBounds(cavity);
  const pad = 250;
  const subMinX = bounds.minX - pad;
  const subMinY = bounds.minY - pad;
  const subMaxX = bounds.maxX + pad;
  const subMaxY = bounds.maxY + pad;
  const substrateMultiPoly = [[makeBoxRing(subMinX, subMinY, subMaxX, subMaxY)]];

  let effectiveMask = topMask;
  const groupOrder = [];
  const groupRecords = {};
  const allStepObjs = [];

  state.steps.forEach((step, sIdx) => {
    const thick = parseFloat(step.thick) || 0;
    if (thick <= 0) return;
    const grp = step.group || "Custom";
    const tilt = parseFloat(step.tilt) || 0;
    const rot = parseFloat(step.rot) || 0;
    const rate = Math.max(0.05, parseFloat(step.rate) || 1.0);

    const effGrainNm = d0Grain * Math.pow(thick / 30.0, 0.3) * Math.pow(1.0 / rate, 0.2);
    const footprint = computeStepShadowFootprint(effectiveMask, cavity, hBot, tTop, tilt, rot, 9);
    if (!footprint || footprint.length === 0) return;

    const stepObj = {
      group: grp,
      tilt,
      rot,
      thick,
      rate,
      oxidize: Boolean(step.oxidize),
      effGrainNm,
      footprint,
      seed: 300 + sIdx * 53,
    };
    allStepObjs.push(stepObj);

    if (!groupRecords[grp]) {
      groupOrder.push(grp);
      groupRecords[grp] = {
        geomUnion: footprint,
        grainSizes: [effGrainNm],
        steps: [step],
        stepObjs: [stepObj],
      };
    } else {
      groupRecords[grp].geomUnion = polygonClipping.union(groupRecords[grp].geomUnion, footprint);
      groupRecords[grp].grainSizes.push(effGrainNm);
      groupRecords[grp].steps.push(step);
      groupRecords[grp].stepObjs.push(stepObj);
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
    slopeW,
    allStepObjs,
    groupOrder,
    groupRecords,
  };

  rebuildWebGLScene();
  draw2DAndCutCanvases();
  updateMetricsBox();
}

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
    slopeW,
    groupOrder,
    groupRecords,
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
    color: 0x181d24,
    metalness: 0.18,
    roughness: 0.78,
    wireframe,
  });
  const subMesh = new THREE.Mesh(subGeom, subMat);
  subMesh.receiveShadow = true;
  simGroup.add(subMesh);

  // Subtle substrate grid
  const cx = 0.5 * (substrateBounds.minX + substrateBounds.maxX);
  const cy = 0.5 * (substrateBounds.minY + substrateBounds.maxY);
  const span = Math.max(substrateBounds.maxX - substrateBounds.minX, substrateBounds.maxY - substrateBounds.minY);
  const grid = new THREE.GridHelper(span, 20, 0x2a3038, 0x1d222a);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(cx, cy, 0.1);
  simGroup.add(grid);

  // 2. Smooth Sloped Conformal Aluminum Layers + 3D Instanced Al Nanograins
  const priorSteps = [];
  groupOrder.forEach((grp, gIdx) => {
    const rec = groupRecords[grp];
    const gMeshes = buildSmoothGroupMeshes(
      grp,
      rec,
      priorSteps,
      slopeW,
      roughness,
      wireframe,
      400 + gIdx * 131
    );
    for (const m of gMeshes) simGroup.add(m);
    priorSteps.push(...rec.stepObjs);
  });

  // 3. Undercut Cavity Outline on Substrate
  if (showCavity) {
    for (const poly of cavity) {
      for (const ring of poly) {
        const pts = ring.map(([x, y]) => new THREE.Vector3(x, y, 0.6));
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

  // 4. Optional Translucent Top Resist Mask at [hBot, hBot + tTop]
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

// ==================== 2D Top-Down & Smooth Cross-Section Canvas Renderers ====================

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

  ctx.save();
  ctx.setLineDash([4, 3]);
  traceMultiPoly(cavity);
  ctx.strokeStyle = "#8b949e";
  ctx.lineWidth = 1.0;
  ctx.stroke();
  ctx.restore();

  traceMultiPoly(topMask);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = 1.1;
  ctx.stroke();

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

  const { substrateBounds, groupOrder, groupRecords, slopeW, roughness } = state.lastSim;
  const cutAxis = document.getElementById("selCutAxis").value;

  const nSamples = 360;
  let sMin, sMax;
  if (cutAxis === "X" || cutAxis === "B2") {
    sMin = substrateBounds.minX;
    sMax = substrateBounds.maxX;
  } else {
    sMin = substrateBounds.minY;
    sMax = substrateBounds.maxY;
  }

  // Evaluate smooth cumulative profiles along the cut line
  const sArr = new Float32Array(nSamples);
  const zCumulative = new Float32Array(nSamples);
  const groupProfiles = [];

  for (let i = 0; i < nSamples; i++) {
    sArr[i] = sMin + ((sMax - sMin) * i) / (nSamples - 1);
  }

  let maxZ = 60.0;
  groupOrder.forEach((grp, gIdx) => {
    const rec = groupRecords[grp];
    const effG = rec.grainSizes.reduce((a, b) => a + b, 0) / Math.max(1, rec.grainSizes.length);
    const amp = roughness * effG * 0.9;
    const zBotArr = new Float32Array(zCumulative);
    const zTopArr = new Float32Array(nSamples);
    const dzArr = new Float32Array(nSamples);

    for (let i = 0; i < nSamples; i++) {
      const s = sArr[i];
      let px = 0, py = 0;
      if (cutAxis === "X") { px = s; py = 0; }
      else if (cutAxis === "Y") { px = 0; py = s; }
      else if (cutAxis === "B1") { px = 2900; py = s; }
      else { px = s; py = 2150; }

      const dz = evalGroupDz(px, py, rec.stepObjs, slopeW);
      dzArr[i] = dz;
      const env = Math.min(1.0, dz / 4.0);
      const gRipple = amp * env * spatialGrainRelief(px, py, effG, 500 + gIdx * 37);
      const zt = zBotArr[i] + dz + (dz > 0.05 ? gRipple : 0.0);
      zTopArr[i] = zt;
      zCumulative[i] = zt;
      if (zt > maxZ) maxZ = zt;
    }
    groupProfiles.push({ grp, zBotArr, zTopArr, dzArr });
  });

  maxZ *= 1.25;
  const padL = 42, padR = 16, padT = 14, padB = 26;
  const plotW = Math.max(50, w - padL - padR);
  const plotH = Math.max(40, h - padT - padB);

  const toX = (s) => padL + ((s - sMin) / (sMax - sMin || 1)) * plotW;
  const toY = (z) => padT + plotH - (z / maxZ) * plotH;

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

  for (const prof of groupProfiles) {
    const pal = GROUP_PALETTE[prof.grp] || GROUP_PALETTE["Custom"];
    let inSeg = false;
    let topPts = [];
    let botPts = [];

    const flush = () => {
      if (topPts.length < 2) {
        topPts = [];
        botPts = [];
        return;
      }
      ctx.beginPath();
      topPts.forEach(([sx, sy], idx) => {
        if (idx === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      for (let i = botPts.length - 1; i >= 0; i--) {
        ctx.lineTo(botPts[i][0], botPts[i][1]);
      }
      ctx.closePath();
      ctx.fillStyle = pal.rgba;
      ctx.fill();
      ctx.strokeStyle = pal.css;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      topPts = [];
      botPts = [];
    };

    for (let i = 0; i < nSamples; i++) {
      if (prof.dzArr[i] > 0.08) {
        topPts.push([toX(sArr[i]), toY(prof.zTopArr[i])]);
        botPts.push([toX(sArr[i]), toY(prof.zBotArr[i])]);
        inSeg = true;
      } else if (inSeg) {
        flush();
        inSeg = false;
      }
    }
    if (inSeg) flush();
  }

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
