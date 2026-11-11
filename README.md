# 3D WebGL Manhattan Shadow Evaporation Simulator (Electron + Three.js)

Cross-platform desktop application (**Windows `.exe`** & **Linux `.AppImage` / `.deb`**) for simulating multi-angle planetary shadow evaporation of Manhattan Josephson junctions (with and without bandages), rendered natively in 3D via **WebGL (Three.js)**.

## Features
- **Embedded Hardware-Accelerated 3D WebGL Viewport (`Three.js`)**:
  - Real-time 60 FPS 3D inspection with `OrbitControls`, camera presets (`3D Iso`, `Top XY`, `Front XZ`, `Side YZ`, `Zoom JJ`), translucent top resist mask toggle, undercut cavity outline, wireframe toggle, and vertical $Z$-exaggeration (`1×`, `2×`, `3×`).
- **Flush Conformal 3D Layer Stacking & Polycrystalline Al Grain Physics (`@ 1 nm/s`)**:
  - Exact 2D polygonal boolean partitioning (`polygon-clipping`) ensures stacked layers (`Electrode 1`, `Electrode 2`, `Bandage`, and `AlOx` barrier) sit flush at `z_bot` directly on top of underlying layers with zero gaps or diagonal grid-aliasing spikes.
  - Procedural polycrystalline Voronoi Aluminum grain bump/roughness textures & top-surface micro-relief scaled to nominal grain size (default $5.0\text{ nm}$ at $1\text{ nm/s}$).
- **Unlimited Planetary Evaporation Steps & Bidirectional ($0^\circ/180^\circ$) Pairs**:
  - Add, edit, reorder, or remove arbitrary steps; one-click `+ Add 0°/180° Pair` and built-in presets (`2-Step`, `4-Step Bi`, `6-Step Bi + Bandage`).
- **Native Binary `.gds` Parser & Generator**:
  - Load custom `.gds` files (in `nm` or `µm`) or generate/export test Manhattan `.gds` layouts.
- **Live 2D Footprint & Vertical Cross-Section Profile $Z(s)$**:
  - Interactive line cuts along `X (y = 0)`, `Y (x = 0)`, `Bandage 1 (x = 2900 nm)`, and `Bandage 2 (y = 2150 nm)`.

## Running Locally (Windows, Linux, macOS)
```bash
npm install
npm start
```

## Building Standalone Desktop Binaries
- **Windows (`.exe`)**: `npm run dist:win`
- **Linux (`.AppImage` & `.deb`)**: `npm run dist:linux`
