import os
import webbrowser
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
import numpy as np
from scipy.spatial import cKDTree
from scipy.ndimage import gaussian_filter
from shapely.geometry import Polygon, box
from shapely.ops import unary_union
from shapely import affinity
from matplotlib.path import Path as MplPath
import trimesh
from trimesh.viewer import scene_to_html

import matplotlib
matplotlib.use("TkAgg")
from matplotlib.figure import Figure
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg, NavigationToolbar2Tk
from matplotlib.colors import LightSource
from mpl_toolkits.mplot3d.art3d import Poly3DCollection

try:
    import gdspy
    GDS_BACKEND = "gdspy"
except ImportError:
    import gdstk
    GDS_BACKEND = "gdstk"


GROUP_PALETTE = {
    "Electrode 1": {"rgb": np.array([65, 145, 255], dtype=float), "hex": "#4191ff"},
    "Electrode 2": {"rgb": np.array([240, 80, 80], dtype=float), "hex": "#f05050"},
    "Bandage":     {"rgb": np.array([55, 195, 105], dtype=float), "hex": "#37c369"},
    "Custom":      {"rgb": np.array([230, 175, 55], dtype=float), "hex": "#e6af37"},
}


class EvaporationSimulator(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("3D Conformal & Grain Manhattan Evaporation Simulator")
        self.geometry("1420x860")
        self.minsize(1180, 740)

        # 1. GDS & Resist parameters
        self.gds_path = tk.StringVar(value="")
        self.layer = tk.IntVar(value=1)
        self.gds_units = tk.StringVar(value="nm")

        self.bottom_resist_height = tk.DoubleVar(value=400.0)  # nm
        self.top_resist_thickness = tk.DoubleVar(value=280.0)  # nm
        self.undercut = tk.DoubleVar(value=200.0)              # nm

        # 2. Al Grain & Deposition Physics parameters (Default grain size = 5.0 nm)
        self.base_grain_size = tk.DoubleVar(value=5.0)         # nm (nominal Al grain size @ 1 nm/s)
        self.grain_roughness = tk.DoubleVar(value=0.25)        # dome height as fraction of grain size
        self.grid_res_nm = tk.DoubleVar(value=8.0)             # spatial grid resolution (nm/pixel)
        self.enable_clogging = tk.BooleanVar(value=False)      # mask aperture narrowing during deposition
        self.cross_section_axis = tk.StringVar(value="X (y=0)")

        # 3. Dynamic Step Editor Variables
        self.edit_group = tk.StringVar(value="Electrode 1")
        self.edit_tilt = tk.DoubleVar(value=45.0)
        self.edit_rot = tk.DoubleVar(value=0.0)
        self.edit_thick = tk.DoubleVar(value=15.0)
        self.edit_rate = tk.DoubleVar(value=1.0)
        self.edit_oxidize = tk.BooleanVar(value=False)

        # List of step dicts: {"group", "tilt", "rot", "thick", "rate", "oxidize"}
        self.steps = []
        self.last_scene = None

        self._build_gui()
        # Load default 6-step bidirectional (0/180, 90/270, 45/225) recipe & Manhattan GDS
        self.load_preset("6step_bi_bandage", run_after=False)
        self.after(150, lambda: self.generate_manhattan_gds(with_bandages=True, silent=True))

    def _build_gui(self):
        pad = {"padx": 6, "pady": 3}

        main_pane = ttk.PanedWindow(self, orient=tk.HORIZONTAL)
        main_pane.pack(fill=tk.BOTH, expand=True, padx=6, pady=6)

        left_frame = ttk.Frame(main_pane, width=490)
        right_frame = ttk.Frame(main_pane)
        main_pane.add(left_frame, weight=0)
        main_pane.add(right_frame, weight=1)

        # === SECTION 1: Mask Geometry (GDS) ===
        frame_file = ttk.LabelFrame(left_frame, text="1. Manhattan Mask Geometry (GDS)")
        frame_file.pack(fill="x", **pad)

        row0 = ttk.Frame(frame_file)
        row0.pack(fill="x", padx=6, pady=2)
        ttk.Button(row0, text="Browse GDS...", command=self.load_gds).pack(side=tk.LEFT, padx=(0, 6))
        ttk.Label(row0, textvariable=self.gds_path, foreground="#0055aa", width=26, anchor="w").pack(
            side=tk.LEFT, fill="x", expand=True
        )
        ttk.Label(row0, text="Layer:").pack(side=tk.LEFT, padx=(4, 2))
        ttk.Entry(row0, textvariable=self.layer, width=4).pack(side=tk.LEFT)
        ttk.Label(row0, text="Units:").pack(side=tk.LEFT, padx=(6, 2))
        ttk.Combobox(row0, textvariable=self.gds_units, values=["nm", "um"], width=4, state="readonly").pack(
            side=tk.LEFT
        )

        row1 = ttk.Frame(frame_file)
        row1.pack(fill="x", padx=6, pady=2)
        ttk.Button(
            row1,
            text="Generate Manhattan (No Bandages)",
            command=lambda: self.generate_manhattan_gds(with_bandages=False),
        ).pack(side=tk.LEFT, fill="x", expand=True, padx=(0, 3))
        ttk.Button(
            row1,
            text="Generate Manhattan (With Bandages)",
            command=lambda: self.generate_manhattan_gds(with_bandages=True),
        ).pack(side=tk.LEFT, fill="x", expand=True, padx=(3, 0))

        # === SECTION 2: Resist & Al Grain Physics ===
        frame_phys = ttk.LabelFrame(left_frame, text="2. Resist Profile & Al Grain Physics (@ 1 nm/s)")
        frame_phys.pack(fill="x", **pad)

        g = ttk.Frame(frame_phys)
        g.pack(fill="x", padx=6, pady=2)
        ttk.Label(g, text="Bottom Undercut Height (nm):").grid(row=0, column=0, sticky="e", padx=3, pady=2)
        ttk.Entry(g, textvariable=self.bottom_resist_height, width=7).grid(row=0, column=1, sticky="w", padx=3)
        ttk.Label(g, text="Nominal Grain Size @1nm/s:").grid(row=0, column=2, sticky="e", padx=6, pady=2)
        ttk.Entry(g, textvariable=self.base_grain_size, width=7).grid(row=0, column=3, sticky="w", padx=3)

        ttk.Label(g, text="Top Mask Thickness (nm):").grid(row=1, column=0, sticky="e", padx=3, pady=2)
        ttk.Entry(g, textvariable=self.top_resist_thickness, width=7).grid(row=1, column=1, sticky="w", padx=3)
        ttk.Label(g, text="Grain Dome Roughness:").grid(row=1, column=2, sticky="e", padx=6, pady=2)
        ttk.Entry(g, textvariable=self.grain_roughness, width=7).grid(row=1, column=3, sticky="w", padx=3)

        ttk.Label(g, text="Lateral Undercut (nm):").grid(row=2, column=0, sticky="e", padx=3, pady=2)
        ttk.Entry(g, textvariable=self.undercut, width=7).grid(row=2, column=1, sticky="w", padx=3)
        ttk.Label(g, text="2D Grid Resolution (nm):").grid(row=2, column=2, sticky="e", padx=6, pady=2)
        ttk.Entry(g, textvariable=self.grid_res_nm, width=7).grid(row=2, column=3, sticky="w", padx=3)

        ttk.Checkbutton(
            frame_phys,
            text="Simulate mask aperture closing (Al buildup on resist sidewalls)",
            variable=self.enable_clogging,
        ).pack(anchor="w", padx=8, pady=(0, 3))

        # === SECTION 3: Multi-Step Planetary Evaporation Recipe ===
        frame_evap = ttk.LabelFrame(left_frame, text="3. Multi-Step Planetary Recipe (Unlimited Steps)")
        frame_evap.pack(fill="both", expand=True, **pad)

        preset_row = ttk.Frame(frame_evap)
        preset_row.pack(fill="x", padx=6, pady=2)
        ttk.Label(preset_row, text="Presets:").pack(side=tk.LEFT, padx=(0, 4))
        ttk.Button(
            preset_row, text="2-Step (0°/90°)", command=lambda: self.load_preset("2step")
        ).pack(side=tk.LEFT, padx=2)
        ttk.Button(
            preset_row, text="4-Step Bi (0°+180° / 90°+270°)", command=lambda: self.load_preset("4step_bi")
        ).pack(side=tk.LEFT, padx=2)
        ttk.Button(
            preset_row, text="6-Step Bi + Bandage", command=lambda: self.load_preset("6step_bi_bandage")
        ).pack(side=tk.LEFT, padx=2)

        tree_frame = ttk.Frame(frame_evap)
        tree_frame.pack(fill="both", expand=True, padx=6, pady=3)

        cols = ("idx", "group", "tilt", "rot", "thick", "rate", "ox")
        self.tree = ttk.Treeview(tree_frame, columns=cols, show="headings", height=6, selectmode="browse")
        self.tree.heading("idx", text="#")
        self.tree.heading("group", text="Layer Group")
        self.tree.heading("tilt", text="Tilt (°)")
        self.tree.heading("rot", text="Rot (°)")
        self.tree.heading("thick", text="Thick (nm)")
        self.tree.heading("rate", text="Rate (nm/s)")
        self.tree.heading("ox", text="Oxide")

        self.tree.column("idx", width=28, anchor="center")
        self.tree.column("group", width=95, anchor="w")
        self.tree.column("tilt", width=55, anchor="center")
        self.tree.column("rot", width=58, anchor="center")
        self.tree.column("thick", width=68, anchor="center")
        self.tree.column("rate", width=72, anchor="center")
        self.tree.column("ox", width=48, anchor="center")

        vsb = ttk.Scrollbar(tree_frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.pack(side=tk.LEFT, fill="both", expand=True)
        vsb.pack(side=tk.RIGHT, fill="y")
        self.tree.bind("<<TreeviewSelect>>", self._on_tree_select)

        edit_box = ttk.Frame(frame_evap)
        edit_box.pack(fill="x", padx=6, pady=2)

        ttk.Label(edit_box, text="Group:").grid(row=0, column=0, sticky="w")
        ttk.Combobox(
            edit_box,
            textvariable=self.edit_group,
            values=["Electrode 1", "Electrode 2", "Bandage", "Custom"],
            width=11,
            state="readonly",
        ).grid(row=1, column=0, padx=2)

        ttk.Label(edit_box, text="Tilt (°):").grid(row=0, column=1)
        ttk.Entry(edit_box, textvariable=self.edit_tilt, width=6).grid(row=1, column=1, padx=2)

        ttk.Label(edit_box, text="Rot (°):").grid(row=0, column=2)
        ttk.Entry(edit_box, textvariable=self.edit_rot, width=6).grid(row=1, column=2, padx=2)

        ttk.Label(edit_box, text="Thick (nm):").grid(row=0, column=3)
        ttk.Entry(edit_box, textvariable=self.edit_thick, width=7).grid(row=1, column=3, padx=2)

        ttk.Label(edit_box, text="Rate (nm/s):").grid(row=0, column=4)
        ttk.Entry(edit_box, textvariable=self.edit_rate, width=7).grid(row=1, column=4, padx=2)

        ttk.Checkbutton(edit_box, text="Oxidize", variable=self.edit_oxidize).grid(row=1, column=5, padx=4)

        btn_box = ttk.Frame(frame_evap)
        btn_box.pack(fill="x", padx=6, pady=3)
        ttk.Button(btn_box, text="+ Add Step", command=self.add_step).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_box, text="+ Add 0°/180° Pair", command=self.add_bidirectional_pair).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_box, text="Update Selected", command=self.update_selected_step).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_box, text="- Remove", command=self.remove_selected_step).pack(side=tk.LEFT, padx=2)
        ttk.Button(btn_box, text="↑", width=3, command=lambda: self.move_step(-1)).pack(side=tk.LEFT, padx=1)
        ttk.Button(btn_box, text="↓", width=3, command=lambda: self.move_step(1)).pack(side=tk.LEFT, padx=1)
        ttk.Button(btn_box, text="Clear", command=self.clear_steps).pack(side=tk.LEFT, padx=2)

        # === SECTION 4: Run & 3D Viewers ===
        frame_act = ttk.LabelFrame(left_frame, text="4. Simulate & Inspect")
        frame_act.pack(fill="x", **pad)

        act_row = ttk.Frame(frame_act)
        act_row.pack(fill="x", padx=6, pady=4)
        ttk.Button(
            act_row, text="Run 3D Grain Simulation", command=self.run_simulation
        ).pack(side=tk.LEFT, fill="x", expand=True, padx=(0, 3))
        ttk.Button(
            act_row, text="Open Fullscreen 3D WebGL Viewer (Browser)", command=self.open_browser_viewer
        ).pack(side=tk.LEFT, fill="x", expand=True, padx=(3, 0))

        cut_row = ttk.Frame(frame_act)
        cut_row.pack(fill="x", padx=6, pady=(0, 4))
        ttk.Label(cut_row, text="Cross-Section Line Cut:").pack(side=tk.LEFT)
        cb_cut = ttk.Combobox(
            cut_row,
            textvariable=self.cross_section_axis,
            values=["X (y=0)", "Y (x=0)", "Bandage 1 (x=2900)", "Bandage 2 (y=2150)"],
            width=18,
            state="readonly",
        )
        cb_cut.pack(side=tk.LEFT, padx=6)
        cb_cut.bind("<<ComboboxSelected>>", lambda _e: self.run_simulation())

        # === SECTION 5: Metrics Readout ===
        frame_metrics = ttk.LabelFrame(left_frame, text="5. Grain & Junction Metrics")
        frame_metrics.pack(fill="x", **pad)
        self.metrics_text = tk.Text(
            frame_metrics, height=8, width=48, font=("Consolas", 8), state="disabled", bg="#f8f9fa"
        )
        self.metrics_text.pack(fill="x", padx=6, pady=4)

        # === Right Panel: 3-Panel Visualization ===
        self.fig = Figure(figsize=(9.2, 7.6), dpi=100)
        gs = self.fig.add_gridspec(2, 2, height_ratios=[1.35, 1.0], hspace=0.28, wspace=0.22)
        self.ax_afm = self.fig.add_subplot(gs[0, 0])
        self.ax_3d = self.fig.add_subplot(gs[0, 1], projection="3d")
        self.ax_cut = self.fig.add_subplot(gs[1, :])
        self.fig.subplots_adjust(left=0.07, right=0.98, top=0.94, bottom=0.07)

        self.canvas = FigureCanvasTkAgg(self.fig, master=right_frame)
        toolbar = NavigationToolbar2Tk(self.canvas, right_frame)
        toolbar.update()
        self.canvas.get_tk_widget().pack(fill=tk.BOTH, expand=True)

    # ---------------- Step Table Management ----------------
    def _refresh_tree(self):
        for item in self.tree.get_children():
            self.tree.delete(item)
        for idx, s in enumerate(self.steps, start=1):
            ox_str = "Yes" if s["oxidize"] else "No"
            self.tree.insert(
                "",
                tk.END,
                iid=str(idx - 1),
                values=(
                    idx,
                    s["group"],
                    f"{s['tilt']:.1f}",
                    f"{s['rot']:.1f}",
                    f"{s['thick']:.1f}",
                    f"{s['rate']:.2f}",
                    ox_str,
                ),
            )

    def _on_tree_select(self, _event=None):
        sel = self.tree.selection()
        if not sel:
            return
        idx = int(sel[0])
        if 0 <= idx < len(self.steps):
            s = self.steps[idx]
            self.edit_group.set(s["group"])
            self.edit_tilt.set(s["tilt"])
            self.edit_rot.set(s["rot"])
            self.edit_thick.set(s["thick"])
            self.edit_rate.set(s["rate"])
            self.edit_oxidize.set(s["oxidize"])

    def add_step(self):
        self.steps.append({
            "group": self.edit_group.get(),
            "tilt": float(self.edit_tilt.get()),
            "rot": float(self.edit_rot.get()),
            "thick": float(self.edit_thick.get()),
            "rate": max(0.05, float(self.edit_rate.get())),
            "oxidize": bool(self.edit_oxidize.get()),
        })
        self._refresh_tree()

    def add_bidirectional_pair(self):
        base_rot = float(self.edit_rot.get()) % 360.0
        opp_rot = (base_rot + 180.0) % 360.0
        grp = self.edit_group.get()
        tilt = float(self.edit_tilt.get())
        thick = float(self.edit_thick.get())
        rate = max(0.05, float(self.edit_rate.get()))
        ox = bool(self.edit_oxidize.get())

        self.steps.append({
            "group": grp, "tilt": tilt, "rot": base_rot, "thick": thick, "rate": rate, "oxidize": False
        })
        self.steps.append({
            "group": grp, "tilt": tilt, "rot": opp_rot, "thick": thick, "rate": rate, "oxidize": ox
        })
        self._refresh_tree()

    def update_selected_step(self):
        sel = self.tree.selection()
        if not sel:
            return
        idx = int(sel[0])
        if 0 <= idx < len(self.steps):
            self.steps[idx] = {
                "group": self.edit_group.get(),
                "tilt": float(self.edit_tilt.get()),
                "rot": float(self.edit_rot.get()),
                "thick": float(self.edit_thick.get()),
                "rate": max(0.05, float(self.edit_rate.get())),
                "oxidize": bool(self.edit_oxidize.get()),
            }
            self._refresh_tree()
            self.tree.selection_set(str(idx))

    def remove_selected_step(self):
        sel = self.tree.selection()
        if not sel:
            return
        idx = int(sel[0])
        if 0 <= idx < len(self.steps):
            self.steps.pop(idx)
            self._refresh_tree()

    def move_step(self, direction):
        sel = self.tree.selection()
        if not sel:
            return
        idx = int(sel[0])
        new_idx = idx + direction
        if 0 <= new_idx < len(self.steps):
            self.steps[idx], self.steps[new_idx] = self.steps[new_idx], self.steps[idx]
            self._refresh_tree()
            self.tree.selection_set(str(new_idx))

    def clear_steps(self):
        self.steps.clear()
        self._refresh_tree()

    def load_preset(self, preset_name, run_after=True):
        if preset_name == "2step":
            self.steps = [
                {"group": "Electrode 1", "tilt": 45.0, "rot": 0.0,   "thick": 30.0, "rate": 1.0, "oxidize": True},
                {"group": "Electrode 2", "tilt": 45.0, "rot": 90.0,  "thick": 45.0, "rate": 1.0, "oxidize": False},
            ]
        elif preset_name == "4step_bi":
            self.steps = [
                {"group": "Electrode 1", "tilt": 45.0, "rot": 0.0,   "thick": 15.0, "rate": 1.0, "oxidize": False},
                {"group": "Electrode 1", "tilt": 45.0, "rot": 180.0, "thick": 15.0, "rate": 1.0, "oxidize": True},
                {"group": "Electrode 2", "tilt": 45.0, "rot": 90.0,  "thick": 25.0, "rate": 1.0, "oxidize": False},
                {"group": "Electrode 2", "tilt": 45.0, "rot": 270.0, "thick": 25.0, "rate": 1.0, "oxidize": False},
            ]
        elif preset_name == "6step_bi_bandage":
            self.steps = [
                {"group": "Electrode 1", "tilt": 45.0, "rot": 0.0,   "thick": 15.0, "rate": 1.0, "oxidize": False},
                {"group": "Electrode 1", "tilt": 45.0, "rot": 180.0, "thick": 15.0, "rate": 1.0, "oxidize": True},
                {"group": "Electrode 2", "tilt": 45.0, "rot": 90.0,  "thick": 22.0, "rate": 1.0, "oxidize": False},
                {"group": "Electrode 2", "tilt": 45.0, "rot": 270.0, "thick": 22.0, "rate": 1.0, "oxidize": True},
                {"group": "Bandage",     "tilt": 45.0, "rot": 45.0,  "thick": 35.0, "rate": 1.0, "oxidize": False},
                {"group": "Bandage",     "tilt": 45.0, "rot": 225.0, "thick": 35.0, "rate": 1.0, "oxidize": False},
            ]
        self._refresh_tree()
        if run_after and self.gds_path.get():
            self.run_simulation()

    # ---------------- GDS Loading & Generation ----------------
    def load_gds(self):
        filepath = filedialog.askopenfilename(filetypes=[("GDSII files", "*.gds")])
        if filepath:
            self.gds_path.set(filepath)
            self.run_simulation()

    def generate_manhattan_gds(self, with_bandages=True, silent=False):
        test_path = "test_manhattan_bandage.gds" if with_bandages else "test_manhattan_2angle.gds"

        if with_bandages:
            h_finger = box(-1100, -80, 3300, 80)
            v_finger = box(-80, -1100, 80, 2600)
            b_slot = box(-1000, -80, 1000, 80)
            b1 = affinity.translate(affinity.rotate(b_slot, 45), xoff=2900, yoff=0)
            b2 = affinity.translate(affinity.rotate(b_slot, 45), xoff=0, yoff=2150)
            geoms = [h_finger, v_finger, b1, b2]
        else:
            h_finger = box(-1100, -80, 1100, 80)
            v_finger = box(-80, -1100, 80, 1100)
            geoms = [h_finger, v_finger]

        cell_name = "MANHATTAN_BANDAGE" if with_bandages else "MANHATTAN_2ANGLE"
        if GDS_BACKEND == "gdspy":
            lib = gdspy.GdsLibrary()
            cell = lib.new_cell(cell_name)
            for g in geoms:
                pts = np.asarray(g.exterior.coords)[:-1]
                cell.add(gdspy.Polygon(pts, layer=1))
            lib.write_gds(test_path)
        else:
            lib = gdstk.Library()
            cell = lib.new_cell(cell_name)
            for g in geoms:
                pts = np.asarray(g.exterior.coords)[:-1]
                cell.add(gdstk.Polygon(pts, layer=1))
            lib.write_gds(test_path)

        self.gds_path.set(test_path)
        self.layer.set(1)
        self.gds_units.set("nm")
        self.run_simulation()

        if not silent:
            messagebox.showinfo("Generated Manhattan GDS", f"Saved {test_path}")

    def _extract_gds_polygons(self, path, target_layer_num):
        scale = 1000.0 if self.gds_units.get() == "um" else 1.0
        if GDS_BACKEND == "gdspy":
            lib = gdspy.GdsLibrary(infile=path)
            top_cell = lib.top_level()[0]
            polygons_dict = top_cell.get_polygons(by_spec=True)
            target_layer = (target_layer_num, 0)
            if target_layer not in polygons_dict:
                shapes = []
                for (l, _d), p_list in polygons_dict.items():
                    if l == target_layer_num:
                        shapes.extend(p_list)
            else:
                shapes = polygons_dict[target_layer]
            return [pts * scale for pts in shapes]
        else:
            lib = gdstk.read_gds(path)
            top_cell = lib.top_level()[0]
            flat_cell = top_cell.copy(name=top_cell.name + "_flat")
            flat_cell.flatten()
            polys = flat_cell.get_polygons(layer=target_layer_num, datatype=0)
            if not polys:
                polys = [p for p in flat_cell.get_polygons() if p.layer == target_layer_num]
            return [p.points * scale for p in polys]

    @staticmethod
    def _iter_polygons(geom):
        if geom is None or geom.is_empty:
            return []
        if geom.geom_type == "Polygon":
            return [geom]
        if geom.geom_type in ("MultiPolygon", "GeometryCollection"):
            return [g for g in geom.geoms if g.geom_type == "Polygon" and not g.is_empty]
        return []

    def _rasterize_polygon(self, geom, X, Y):
        mask = np.zeros(X.shape, dtype=bool)
        pts = np.column_stack([X.ravel(), Y.ravel()])
        for poly in self._iter_polygons(geom):
            ext_path = MplPath(np.asarray(poly.exterior.coords))
            inside = ext_path.contains_points(pts)
            for interior in poly.interiors:
                hole_path = MplPath(np.asarray(interior.coords))
                inside &= ~hole_path.contains_points(pts)
            mask |= inside.reshape(X.shape)
        return mask

    # ---------------- 3D Polycrystalline Al Grain & Conformal Stacking Engine ----------------
    def _generate_al_grain_field(self, nx, ny, dx, grain_size_nm, seed):
        """
        Generates a 2D polycrystalline grain relief field G(x, y) in [-0.5, +0.5].
        Works accurately even when grain_size_nm (e.g. 5 nm) is comparable to or smaller than dx.
        """
        rng = np.random.default_rng(seed)
        if grain_size_nm >= dx * 1.5:
            domain_area = (nx * dx) * (ny * dx)
            n_seeds = max(16, int(domain_area / (grain_size_nm ** 2)))
            sx = rng.uniform(0, nx - 1, size=n_seeds)
            sy = rng.uniform(0, ny - 1, size=n_seeds)

            tree = cKDTree(np.column_stack([sx, sy]))
            gx, gy = np.meshgrid(np.arange(nx), np.arange(ny), indexing="ij")
            d2, labels = tree.query(np.column_stack([gx.ravel(), gy.ravel()]), k=2)
            labels0 = labels[:, 0].reshape(nx, ny)

            ridge_dist = 0.5 * (d2[:, 1] - d2[:, 0]).reshape(nx, ny) * dx
            dome = 1.0 - np.exp(-ridge_dist / (0.28 * grain_size_nm))
            grain_facet = rng.normal(1.0, 0.12, size=n_seeds)[labels0]
            field = dome * grain_facet
            field = gaussian_filter(field, sigma=0.5)
        else:
            # Fine-grain regime (e.g. 5 nm grains): isotropic correlated Gaussian grain texture
            raw = rng.normal(0.0, 1.0, size=(nx, ny))
            sigma_px = max(0.45, (0.5 * grain_size_nm) / dx)
            field = gaussian_filter(raw, sigma=sigma_px)

        f_min, f_max = field.min(), field.max()
        if f_max > f_min:
            field = (field - f_min) / (f_max - f_min) - 0.5
        return field

    def compute_step_shadow_geom(self, effective_mask, cavity, h_bot, t_top, tilt_deg, rot_deg, n_slices=11):
        tilt_rad = np.radians(tilt_deg)
        rot_rad = np.radians(rot_deg)

        zs = np.linspace(h_bot, h_bot + max(0.0, t_top), n_slices) if t_top > 0 else [h_bot]
        beam = None
        for z in zs:
            dx = z * np.tan(tilt_rad) * np.cos(rot_rad)
            dy = z * np.tan(tilt_rad) * np.sin(rot_rad)
            shifted = affinity.translate(effective_mask, xoff=dx, yoff=dy)
            beam = shifted if beam is None else beam.intersection(shifted)
        return beam.intersection(cavity)

    def _extrude_conformal_block(self, geom, z_bot, z_top, base_rgb, grain_size_nm, roughness_factor, seed):
        """
        Extrudes an exact 2D Shapely polygon from exact bottom height z_bot to z_top
        (so stacked layers touch flush at z_bot with zero gap and zero diagonal grid spikes),
        and applies polycrystalline Al grain shading on the vertices.
        """
        meshes = []
        height = z_top - z_bot
        if height <= 0.05:
            return meshes

        rng = np.random.default_rng(seed)
        for poly in self._iter_polygons(geom):
            if poly.area < 1.0:
                continue
            try:
                mesh = trimesh.creation.extrude_polygon(poly, height)
                mesh.apply_translation([0.0, 0.0, z_bot])

                # Apply subtle grain height perturbation to top-face vertices only
                # while keeping bottom face strictly flush at z_bot so layers touch with zero gap
                verts = mesh.vertices.copy()
                top_mask_v = np.isclose(verts[:, 2], z_top, atol=0.1)
                amp_nm = roughness_factor * grain_size_nm
                dz_v = rng.uniform(-0.5 * amp_nm, 0.5 * amp_nm, size=len(verts))
                verts[top_mask_v, 2] += dz_v[top_mask_v]
                mesh.vertices = verts

                # Per-face grain shading
                n_faces = len(mesh.faces)
                f_shade = rng.uniform(0.88, 1.08, size=(n_faces, 1))
                f_rgb = np.clip(base_rgb[None, :] * f_shade, 0, 255).astype(np.uint8)
                f_rgba = np.column_stack([f_rgb, np.full(n_faces, 255, dtype=np.uint8)])
                mesh.visual.face_colors = f_rgba
                meshes.append(mesh)
            except Exception as e:
                print(f"Skipped polygon block extrusion: {e}")
        return meshes

    def run_simulation(self):
        path = self.gds_path.get()
        if not path or not os.path.exists(path):
            messagebox.showerror("Error", "Please select or generate a valid GDS file.")
            return
        if not self.steps:
            messagebox.showerror("Error", "Please add at least one evaporation step.")
            return

        try:
            shapes = self._extract_gds_polygons(path, self.layer.get())
            if not shapes:
                messagebox.showerror("Error", f"No polygons found on layer {self.layer.get()}.")
                return

            shapely_polys = [Polygon(pts) for pts in shapes if len(pts) >= 3]
            top_mask = unary_union(shapely_polys)
            cavity = top_mask.buffer(self.undercut.get())

            h_bot = float(self.bottom_resist_height.get())
            t_top = float(self.top_resist_thickness.get())
            d0_grain = max(1.0, float(self.base_grain_size.get()))
            roughness_factor = np.clip(float(self.grain_roughness.get()), 0.0, 0.8)
            dx_target = max(4.0, float(self.grid_res_nm.get()))

            minx, miny, maxx, maxy = cavity.bounds
            pad = 150.0
            gx_min, gx_max = minx - pad, maxx + pad
            gy_min, gy_max = miny - pad, maxy + pad

            nx = int(np.clip((gx_max - gx_min) / dx_target, 100, 360))
            ny = int(np.clip((gy_max - gy_min) / dx_target, 100, 360))
            x = np.linspace(gx_min, gx_max, nx)
            y = np.linspace(gy_min, gy_max, ny)
            dx = x[1] - x[0]
            X, Y = np.meshgrid(x, y, indexing="ij")

            # 1. Exact Polygonal Conformal Stacking (for watertight, gap-free 3D meshes)
            substrate_box = box(gx_min, gy_min, gx_max, gy_max)
            height_regions = [(substrate_box, 0.0)]
            conformal_blocks = []  # list of dicts: {"group", "poly", "z_bot", "z_top", "grain_nm", "seed"}

            # 2. 2D Grid Heightmap Tracking (for AFM Hillshade & Cross-Section Line Cuts)
            Z_total = np.zeros((nx, ny), dtype=float)
            effective_mask = top_mask

            group_order = []
            group_records = {}

            for s_idx, step in enumerate(self.steps):
                thick = step["thick"]
                if thick <= 0:
                    continue
                grp = step["group"]
                tilt = step["tilt"]
                rot = step["rot"]
                rate = max(0.05, step["rate"])

                # Effective Al grain size scales around nominal grain size @ 1 nm/s, 30 nm thickness
                eff_grain_nm = d0_grain * ((thick / 30.0) ** 0.30) * ((1.0 / rate) ** 0.20)

                footprint_geom = self.compute_step_shadow_geom(
                    effective_mask, cavity, h_bot, t_top, tilt, rot
                )

                # Update exact polygonal conformal height regions
                new_regions = []
                ox_add = 1.5 if step["oxidize"] else 0.0
                for reg_geom, z_curr in height_regions:
                    hit = reg_geom.intersection(footprint_geom)
                    miss = reg_geom.difference(footprint_geom)
                    if not hit.is_empty and hit.area > 1e-1:
                        conformal_blocks.append({
                            "group": grp,
                            "poly": hit,
                            "z_bot": z_curr,
                            "z_top": z_curr + thick,
                            "grain_nm": eff_grain_nm,
                            "seed": 200 + s_idx * 41,
                        })
                        new_regions.append((hit, z_curr + thick + ox_add))
                    if not miss.is_empty and miss.area > 1e-1:
                        new_regions.append((miss, z_curr))
                height_regions = new_regions

                # Update 2D grid heightmap with grain surface roughness proportional to grain size (NOT film thickness!)
                mask_2d = self._rasterize_polygon(footprint_geom, X, Y)
                grain_field = self._generate_al_grain_field(nx, ny, dx, eff_grain_nm, seed=100 + s_idx * 37)
                grain_dz_nm = roughness_factor * eff_grain_nm * grain_field
                step_dZ = np.where(mask_2d, np.maximum(0.5, thick + grain_dz_nm), 0.0)

                if grp not in group_records:
                    group_order.append(grp)
                    group_records[grp] = {
                        "Z_bot": Z_total.copy(),
                        "dZ": np.zeros((nx, ny), dtype=float),
                        "geom_union": footprint_geom,
                        "grain_sizes": [eff_grain_nm],
                        "steps": [step],
                        "meshes": [],
                    }
                else:
                    rec = group_records[grp]
                    rec["geom_union"] = unary_union([rec["geom_union"], footprint_geom])
                    rec["grain_sizes"].append(eff_grain_nm)
                    rec["steps"].append(step)

                # Record exact bottom height where this group is newly deposited
                newly_covered = (group_records[grp]["dZ"] == 0) & mask_2d
                group_records[grp]["Z_bot"] = np.where(newly_covered, Z_total, group_records[grp]["Z_bot"])

                group_records[grp]["dZ"] += step_dZ
                Z_total += step_dZ
                group_records[grp]["Z_top"] = group_records[grp]["Z_bot"] + group_records[grp]["dZ"]

                if step["oxidize"]:
                    Z_total += np.where(mask_2d, 1.5, 0.0)

                if self.enable_clogging.get():
                    clog_nm = 0.25 * thick * np.sin(np.radians(abs(tilt)))
                    if clog_nm > 0.2:
                        shrunk = effective_mask.buffer(-clog_nm)
                        if not shrunk.is_empty:
                            effective_mask = shrunk

            # Build watertight 3D trimesh scene from conformal blocks
            scene_meshes = []
            sub_mesh = trimesh.creation.extrude_polygon(substrate_box, 12.0)
            sub_mesh.visual.face_colors = [48, 52, 60, 255]
            sub_mesh.apply_translation([0, 0, -12.0])
            scene_meshes.append(sub_mesh)

            for blk in conformal_blocks:
                grp = blk["group"]
                rgb = GROUP_PALETTE.get(grp, GROUP_PALETTE["Custom"])["rgb"]
                b_meshes = self._extrude_conformal_block(
                    blk["poly"],
                    blk["z_bot"],
                    blk["z_top"],
                    rgb,
                    blk["grain_nm"],
                    roughness_factor,
                    blk["seed"],
                )
                group_records[grp]["meshes"].extend(b_meshes)
                scene_meshes.extend(b_meshes)

            self.last_scene = trimesh.Scene(scene_meshes)

            self._update_plots(x, y, X, Y, Z_total, top_mask, cavity, group_order, group_records)
            self._update_metrics(group_order, group_records, dx)

        except Exception as e:
            messagebox.showerror("Simulation Error", str(e))

    def _update_plots(self, x, y, X, Y, Z_total, top_mask, cavity, group_order, group_records):
        self.ax_afm.clear()
        self.ax_3d.clear()
        self.ax_cut.clear()

        # --- Panel 1: 2D AFM Hillshaded Grain Topography ---
        ls = LightSource(azdeg=315, altdeg=45)
        rgb_canvas = np.full((X.shape[0], X.shape[1], 3), 0.16, dtype=float)

        for grp in group_order:
            rec = group_records[grp]
            active = rec["dZ"] > 0.5
            base_rgb = GROUP_PALETTE.get(grp, GROUP_PALETTE["Custom"])["rgb"] / 255.0
            rgb_canvas[active] = base_rgb

        dx = x[1] - x[0]
        shaded = ls.shade_rgb(rgb_canvas, Z_total, blend_mode="overlay", vert_exag=4.0, dx=dx, dy=dx)
        self.ax_afm.imshow(
            np.transpose(shaded, (1, 0, 2)),
            extent=[x[0], x[-1], y[0], y[-1]],
            origin="lower",
            interpolation="nearest",
        )

        for poly in self._iter_polygons(cavity):
            px, py = poly.exterior.xy
            self.ax_afm.plot(px, py, "--", color="#aaaaaa", linewidth=0.8)
        for poly in self._iter_polygons(top_mask):
            px, py = poly.exterior.xy
            self.ax_afm.plot(px, py, "-", color="#ffffff", linewidth=0.9, alpha=0.85)

        cut_mode = self.cross_section_axis.get()
        if cut_mode.startswith("X"):
            self.ax_afm.axhline(0, color="#ffea00", linestyle="-.", linewidth=1.2)
        elif cut_mode.startswith("Y"):
            self.ax_afm.axvline(0, color="#ffea00", linestyle="-.", linewidth=1.2)
        elif "Bandage 1" in cut_mode:
            self.ax_afm.axvline(2900, color="#ffea00", linestyle="-.", linewidth=1.2)
        elif "Bandage 2" in cut_mode:
            self.ax_afm.axhline(2150, color="#ffea00", linestyle="-.", linewidth=1.2)

        self.ax_afm.set_title("AFM Top-Down Grain Topography", fontsize=9.5, fontweight="bold")
        self.ax_afm.set_xlabel("X (nm)")
        self.ax_afm.set_ylabel("Y (nm)")

        # --- Panel 2: Interactive 3D Conformal Solid Mesh View ---
        # Render exact conformal extruded blocks (no NaN grid gaps or diagonal spikes!)
        max_z = max(float(Z_total.max()), 50.0)
        for grp in group_order:
            rec = group_records[grp]
            rgb_norm = (GROUP_PALETTE.get(grp, GROUP_PALETTE["Custom"])["rgb"] / 255.0).tolist()
            rgba_face = rgb_norm + [0.90]
            for mesh in rec["meshes"]:
                tris = mesh.vertices[mesh.faces]
                col = Poly3DCollection(
                    tris,
                    facecolors=[rgba_face],
                    edgecolors=(0.12, 0.12, 0.12, 0.22),
                    linewidths=0.25,
                )
                self.ax_3d.add_collection3d(col)

        self.ax_3d.set_xlim(x[0], x[-1])
        self.ax_3d.set_ylim(y[0], y[-1])
        self.ax_3d.set_zlim(0, max_z * 1.35)
        self.ax_3d.set_title("3D Conformal Al Stack (Flush Layers, No Gaps)", fontsize=9.5, fontweight="bold")
        self.ax_3d.set_xlabel("X (nm)")
        self.ax_3d.set_ylabel("Y (nm)")
        self.ax_3d.set_zlabel("Z (nm)")
        self.ax_3d.view_init(elev=30, azim=-55)

        # --- Panel 3: Cross-Section Profile Z(s) ---
        if cut_mode.startswith("X"):
            j_idx = int(np.argmin(np.abs(y - 0.0)))
            s_coord = x
            s_label = "Position along X at Y = 0 (nm)"
            idx_slice = (slice(None), j_idx)
        elif cut_mode.startswith("Y"):
            i_idx = int(np.argmin(np.abs(x - 0.0)))
            s_coord = y
            s_label = "Position along Y at X = 0 (nm)"
            idx_slice = (i_idx, slice(None))
        elif "Bandage 1" in cut_mode:
            i_idx = int(np.argmin(np.abs(x - 2900.0)))
            s_coord = y
            s_label = "Position along Y across Bandage 1 at X = 2900 nm"
            idx_slice = (i_idx, slice(None))
        else:
            j_idx = int(np.argmin(np.abs(y - 2150.0)))
            s_coord = x
            s_label = "Position along X across Bandage 2 at Y = 2150 nm"
            idx_slice = (slice(None), j_idx)

        for grp in group_order:
            rec = group_records[grp]
            z_b = rec["Z_bot"][idx_slice]
            z_t = rec["Z_top"][idx_slice]
            dz_s = rec["dZ"][idx_slice]
            hex_c = GROUP_PALETTE.get(grp, GROUP_PALETTE["Custom"])["hex"]
            active = dz_s > 0.5
            if np.any(active):
                self.ax_cut.fill_between(
                    s_coord, z_b, z_t, where=active, color=hex_c, alpha=0.78, step="mid", label=f"{grp}"
                )
                self.ax_cut.step(s_coord, np.where(active, z_t, np.nan), where="mid", color="#111111", linewidth=0.9)

        self.ax_cut.set_title(
            f"Vertical Cross-Section Profile ({cut_mode}) — Flush Conformal Layer Stack",
            fontsize=9.5,
            fontweight="bold",
        )
        self.ax_cut.set_xlabel(s_label)
        self.ax_cut.set_ylabel("Height Z (nm)")
        self.ax_cut.set_ylim(0, max_z * 1.25)
        self.ax_cut.grid(True, linestyle=":", alpha=0.6)
        self.ax_cut.legend(loc="upper right", fontsize=8)

        self.canvas.draw_idle()

    def _update_metrics(self, group_order, group_records, dx):
        lines = []
        for grp in group_order:
            rec = group_records[grp]
            active_mask = rec["dZ"] > 1.0
            plateau_mask = rec["dZ"] > (0.85 * float(np.max(rec["dZ"]))) if np.any(active_mask) else active_mask
            area_nm2 = rec["geom_union"].area
            mean_g = float(np.mean(rec["grain_sizes"]))
            rms_rough = float(np.std(rec["dZ"][plateau_mask])) if np.any(plateau_mask) else 0.0
            angles_str = ", ".join(f"({s['tilt']:.0f}°,{s['rot']:.0f}°)" for s in rec["steps"])
            lines.append(
                f"{grp} [{len(rec['steps'])} step(s): {angles_str}]:\n"
                f"  Area={area_nm2:,.0f} nm² ({area_nm2/1e6:.4f} µm²) | "
                f"Grain D≈{mean_g:.1f} nm | RMS σ_z≈{rms_rough:.2f} nm"
            )

        if "Electrode 1" in group_records and "Electrode 2" in group_records:
            jj_poly = group_records["Electrode 1"]["geom_union"].intersection(
                group_records["Electrode 2"]["geom_union"]
            )
            jj_area = jj_poly.area
            lines.append("-" * 52)
            lines.append(f"JJ Overlap (Electrode 1 ∩ Electrode 2): {jj_area:,.0f} nm² ({jj_area/1e6:.5f} µm²)")

        if "Bandage" in group_records:
            b_poly = group_records["Bandage"]["geom_union"]
            for target in ("Electrode 1", "Electrode 2"):
                if target in group_records:
                    t_poly = group_records[target]["geom_union"]
                    ov = b_poly.intersection(t_poly).area
                    lines.append(f"Bandage ∩ {target}: {ov:,.0f} nm² ({ov/1e6:.5f} µm²)")

        self.metrics_text.configure(state="normal")
        self.metrics_text.delete("1.0", tk.END)
        self.metrics_text.insert(tk.END, "\n".join(lines))
        self.metrics_text.configure(state="disabled")

    def open_browser_viewer(self):
        if self.last_scene is None:
            self.run_simulation()
        if self.last_scene is None:
            return
        try:
            html_content = scene_to_html(self.last_scene)
            out_html = os.path.abspath("manhattan_evaporation_3d.html")
            with open(out_html, "w", encoding="utf-8") as f:
                f.write(html_content)
            webbrowser.open(f"file:///{out_html.replace(os.sep, '/')}")
        except Exception as e:
            messagebox.showerror("3D Viewer Error", f"Failed to open browser 3D viewer:\n{e}")


if __name__ == "__main__":
    app = EvaporationSimulator()
    app.mainloop()
