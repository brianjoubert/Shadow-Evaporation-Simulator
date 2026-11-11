# 3D Manhattan Shadow Evaporation Simulator

Interactive 3D simulator for multi-angle planetary shadow evaporation of Manhattan Josephson junctions (with and without bandages), including polycrystalline Aluminum grain morphology and conformal step coverage.

## Features
- **Manhattan GDS Layout Support**: Load custom `.gds` files (in `nm` or `µm`) or generate test Manhattan geometries (2-angle without bandages or 3-angle with $45^\circ$ bandages).
- **Bilayer Resist & Trench Wall Shadowing**: Models both bottom undercut height (`h_bot`), top resist thickness (`t_top`), and lateral undercut cavity expansion.
- **Unlimited Planetary Evaporation Steps**: Supports arbitrary step sequences, bidirectional pairs ($0^\circ + 180^\circ$, $90^\circ + 270^\circ$, $45^\circ + 225^\circ$), per-step deposition rates, and inter-step oxidation ($\text{AlO}_x$).
- **Polycrystalline Al Grain Topography & Conformal 3D Stack**: Models rate- and thickness-dependent Al grain size (default $5\text{ nm}$ at $1\text{ nm/s}$) with flush 3D layer stacking, AFM hillshaded top-down view, interactive 3D stack view, vertical cross-section line cuts, and a full-screen Three.js WebGL 3D browser viewer.
- **Automated Windows `.exe` Build**: GitHub Actions automatically builds `Shadow_Evaporation_Simulator.exe` on every push and publishes it to the repository's **Actions** artifacts and **Releases** page.

## Running from Source
```bash
pip install -r requirements.txt
python Shadow_Evaporation_Simulator.py
```
