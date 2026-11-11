/**
 * Pure JavaScript GDSII Binary Stream Parser & Writer
 * Supports BOUNDARY, BOX, PATH, SREF flattening, and IBM-370 8-byte float UNITS decoding.
 */

function decodeIBMFloat64(view, byteOffset) {
  const b0 = view.getUint8(byteOffset);
  const sign = b0 & 0x80 ? -1.0 : 1.0;
  const exp = (b0 & 0x7f) - 64;
  let mant = 0.0;
  for (let i = 1; i < 8; i++) {
    mant = mant * 256.0 + view.getUint8(byteOffset + i);
  }
  if (mant === 0.0) return 0.0;
  // mant is 56-bit integer; divide by 2^56 (72057594037927936)
  return sign * (mant / 72057594037927936.0) * Math.pow(16.0, exp);
}

function encodeIBMFloat64(val) {
  const out = new Uint8Array(8);
  if (val === 0) return out;
  const sign = val < 0 ? 0x80 : 0x00;
  let absVal = Math.abs(val);
  let exp = 0;
  while (absVal >= 1.0) {
    absVal /= 16.0;
    exp++;
  }
  while (absVal < 1.0 / 16.0) {
    absVal *= 16.0;
    exp--;
  }
  out[0] = sign | ((exp + 64) & 0x7f);
  let rem = absVal;
  for (let i = 1; i < 8; i++) {
    rem *= 256.0;
    const byte = Math.floor(rem);
    out[i] = byte & 0xff;
    rem -= byte;
  }
  return out;
}

function expandPathToPolygon(pts, width) {
  if (pts.length < 2 || width <= 0) return pts;
  const half = width * 0.5;
  const left = [];
  const right = [];
  for (let i = 0; i < pts.length; i++) {
    let dx, dy;
    if (i === 0) {
      dx = pts[1][0] - pts[0][0];
      dy = pts[1][1] - pts[0][1];
    } else if (i === pts.length - 1) {
      dx = pts[i][0] - pts[i - 1][0];
      dy = pts[i][1] - pts[i - 1][1];
    } else {
      dx = pts[i + 1][0] - pts[i - 1][0];
      dy = pts[i + 1][1] - pts[i - 1][1];
    }
    const len = Math.hypot(dx, dy) || 1.0;
    const nx = -dy / len;
    const ny = dx / len;
    left.push([pts[i][0] + nx * half, pts[i][1] + ny * half]);
    right.push([pts[i][0] - nx * half, pts[i][1] - ny * half]);
  }
  right.reverse();
  return left.concat(right);
}

export function parseGdsBinary(uint8Array, targetLayer = 1, unitsMode = "nm") {
  const view = new DataView(uint8Array.buffer, uint8Array.byteOffset, uint8Array.byteLength);
  let offset = 0;

  let userUnitPerDb = 0.001; // default: 1 db unit = 0.001 user units
  let dbUnitInMeters = 1e-9; // default: 1 db unit = 1 nm

  const cells = new Map();
  const referencedCells = new Set();
  let currentCell = null;
  let currentElem = null;

  while (offset + 4 <= view.byteLength) {
    const recLen = view.getUint16(offset, false);
    if (recLen < 4 || offset + recLen > view.byteLength) break;
    const recType = view.getUint8(offset + 2);
    const payloadOffset = offset + 4;
    const payloadLen = recLen - 4;

    switch (recType) {
      case 0x03: // UNITS
        if (payloadLen >= 16) {
          userUnitPerDb = decodeIBMFloat64(view, payloadOffset);
          dbUnitInMeters = decodeIBMFloat64(view, payloadOffset + 8);
        }
        break;

      case 0x05: // BGNSTR
        currentCell = { name: "CELL", polygons: [], refs: [] };
        break;

      case 0x06: // STRNAME
        if (currentCell) {
          let name = "";
          for (let i = 0; i < payloadLen; i++) {
            const ch = view.getUint8(payloadOffset + i);
            if (ch !== 0) name += String.fromCharCode(ch);
          }
          currentCell.name = name;
          cells.set(name, currentCell);
        }
        break;

      case 0x07: // ENDSTR
        currentCell = null;
        break;

      case 0x08: // BOUNDARY
      case 0x2d: // BOX
        currentElem = { kind: "POLY", layer: 0, datatype: 0, xy: [] };
        break;

      case 0x09: // PATH
        currentElem = { kind: "PATH", layer: 0, datatype: 0, width: 0, xy: [] };
        break;

      case 0x0a: // SREF
        currentElem = { kind: "SREF", sname: "", xy: [], angle: 0, mag: 1.0, reflectX: false };
        break;

      case 0x0d: // LAYER
        if (currentElem && payloadLen >= 2) {
          currentElem.layer = view.getInt16(payloadOffset, false);
        }
        break;

      case 0x0f: // WIDTH
        if (currentElem && payloadLen >= 4) {
          currentElem.width = Math.abs(view.getInt32(payloadOffset, false));
        }
        break;

      case 0x12: // SNAME
        if (currentElem) {
          let sname = "";
          for (let i = 0; i < payloadLen; i++) {
            const ch = view.getUint8(payloadOffset + i);
            if (ch !== 0) sname += String.fromCharCode(ch);
          }
          currentElem.sname = sname;
          referencedCells.add(sname);
        }
        break;

      case 0x1a: // STRANS
        if (currentElem && payloadLen >= 2) {
          const flags = view.getUint16(payloadOffset, false);
          currentElem.reflectX = Boolean(flags & 0x8000);
        }
        break;

      case 0x1b: // MAG
        if (currentElem && payloadLen >= 8) {
          currentElem.mag = decodeIBMFloat64(view, payloadOffset);
        }
        break;

      case 0x1c: // ANGLE
        if (currentElem && payloadLen >= 8) {
          currentElem.angle = decodeIBMFloat64(view, payloadOffset);
        }
        break;

      case 0x10: // XY
        if (currentElem) {
          const nPts = Math.floor(payloadLen / 8);
          const pts = [];
          for (let i = 0; i < nPts; i++) {
            const x = view.getInt32(payloadOffset + i * 8, false);
            const y = view.getInt32(payloadOffset + i * 8 + 4, false);
            pts.push([x, y]);
          }
          currentElem.xy = pts;
        }
        break;

      case 0x11: // ENDEL
        if (currentCell && currentElem) {
          if (currentElem.kind === "POLY" && currentElem.xy.length >= 3) {
            currentCell.polygons.push({
              layer: currentElem.layer,
              pts: currentElem.xy,
            });
          } else if (currentElem.kind === "PATH" && currentElem.xy.length >= 2) {
            currentCell.polygons.push({
              layer: currentElem.layer,
              pts: expandPathToPolygon(currentElem.xy, currentElem.width),
            });
          } else if (currentElem.kind === "SREF" && currentElem.sname && currentElem.xy.length >= 1) {
            currentCell.refs.push(currentElem);
          }
        }
        currentElem = null;
        break;

      default:
        break;
    }

    offset += recLen;
  }

  // Determine top-level cell
  let topCell = null;
  for (const [name, cell] of cells.entries()) {
    if (!referencedCells.has(name)) {
      topCell = cell;
      break;
    }
  }
  if (!topCell && cells.size > 0) {
    topCell = cells.values().next().value;
  }
  if (!topCell) return { polygons: [], availableLayers: [] };

  // Convert database integer coordinates -> GDS user units -> nm
  const scaleToUserUnits = userUnitPerDb > 0 ? userUnitPerDb : 0.001;
  const userUnitToNm = unitsMode === "um" ? 1000.0 : 1.0;
  const totalScale = scaleToUserUnits * userUnitToNm;

  const availableLayersSet = new Set();
  const collected = [];

  function collectCell(cell, ox = 0, oy = 0, rotDeg = 0, mag = 1.0, reflectX = false, depth = 0) {
    if (!cell || depth > 12) return;
    const rad = (rotDeg * Math.PI) / 180.0;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);

    for (const p of cell.polygons) {
      availableLayersSet.add(p.layer);
      if (p.layer !== targetLayer) continue;

      const transformed = [];
      for (let i = 0; i < p.pts.length; i++) {
        let px = p.pts[i][0] * mag;
        let py = p.pts[i][1] * (reflectX ? -mag : mag);
        const rx = px * cosA - py * sinA + ox;
        const ry = px * sinA + py * cosA + oy;
        transformed.push([rx * totalScale, ry * totalScale]);
      }
      // Remove duplicate closing vertex if present
      if (
        transformed.length > 3 &&
        Math.hypot(
          transformed[0][0] - transformed[transformed.length - 1][0],
          transformed[0][1] - transformed[transformed.length - 1][1]
        ) < 1e-6
      ) {
        transformed.pop();
      }
      if (transformed.length >= 3) {
        collected.push(transformed);
      }
    }

    for (const ref of cell.refs) {
      const sub = cells.get(ref.sname);
      if (sub) {
        const refPt = ref.xy[0];
        let rx = refPt[0] * mag;
        let ry = refPt[1] * (reflectX ? -mag : mag);
        const nx = rx * cosA - ry * sinA + ox;
        const ny = rx * sinA + ry * cosA + oy;
        collectCell(
          sub,
          nx,
          ny,
          rotDeg + (ref.angle || 0),
          mag * (ref.mag || 1.0),
          reflectX !== Boolean(ref.reflectX),
          depth + 1
        );
      }
    }
  }

  collectCell(topCell);

  return {
    polygons: collected,
    availableLayers: Array.from(availableLayersSet).sort((a, b) => a - b),
  };
}

export function writeGdsBinary(cellName, polygons, layer = 1) {
  const chunks = [];

  function pushRecord(recType, dataType, payloadBytes = new Uint8Array(0)) {
    let len = payloadBytes.length;
    const paddedLen = len % 2 === 1 ? len + 1 : len;
    const buf = new Uint8Array(4 + paddedLen);
    const dv = new DataView(buf.buffer);
    dv.setUint16(0, 4 + paddedLen, false);
    dv.setUint8(2, recType);
    dv.setUint8(3, dataType);
    buf.set(payloadBytes, 4);
    chunks.push(buf);
  }

  function pushInt16Record(recType, values) {
    const buf = new Uint8Array(values.length * 2);
    const dv = new DataView(buf.buffer);
    values.forEach((v, i) => dv.setInt16(i * 2, v, false));
    pushRecord(recType, 0x02, buf);
  }

  function pushAsciiRecord(recType, str) {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0x7f;
    pushRecord(recType, 0x06, bytes);
  }

  // HEADER (version 600)
  pushInt16Record(0x00, [600]);
  // BGNLIB (12 int16 timestamps)
  pushInt16Record(0x01, [2026, 11, 11, 12, 0, 0, 2026, 11, 11, 12, 0, 0]);
  // LIBNAME
  pushAsciiRecord(0x02, "MANHATTAN_LIB");
  // UNITS: user unit = 1e-3, db unit = 1e-9 m (so 1 user unit = 1 nm when scaled by 1000 db/unit)
  const unitsBuf = new Uint8Array(16);
  unitsBuf.set(encodeIBMFloat64(0.001), 0);
  unitsBuf.set(encodeIBMFloat64(1e-9), 8);
  pushRecord(0x03, 0x05, unitsBuf);

  // BGNSTR
  pushInt16Record(0x05, [2026, 11, 11, 12, 0, 0, 2026, 11, 11, 12, 0, 0]);
  pushAsciiRecord(0x06, cellName);

  for (const poly of polygons) {
    if (poly.length < 3) continue;
    // BOUNDARY
    pushRecord(0x08, 0x00);
    // LAYER
    pushInt16Record(0x0d, [layer]);
    // DATATYPE
    pushInt16Record(0x0e, [0]);
    // XY (closed loop in db units = round(nm * 1000))
    const closed = poly.concat([poly[0]]);
    const xyBuf = new Uint8Array(closed.length * 8);
    const dv = new DataView(xyBuf.buffer);
    closed.forEach((pt, idx) => {
      dv.setInt32(idx * 8, Math.round(pt[0] * 1000.0), false);
      dv.setInt32(idx * 8 + 4, Math.round(pt[1] * 1000.0), false);
    });
    pushRecord(0x10, 0x03, xyBuf);
    // ENDEL
    pushRecord(0x11, 0x00);
  }

  // ENDSTR & ENDLIB
  pushRecord(0x07, 0x00);
  pushRecord(0x04, 0x00);

  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
