# HF Item Studio

**DISCLAIMER! AI was used for the creation of this tool!**

A desktop app for making custom House Flipper items without opening Unity. It reads and
writes the game's `.hfcontent` format directly, so you can go from a 3D model to a
Workshop upload in one place.

## Install

Download from the repo's **Releases** page:

- `HF-Item-Studio-Setup-<version>.exe`: a normal installer with a Start menu entry and a
  desktop icon.
- `HF-Item-Studio-Portable-<version>.exe`: a single file that runs without installing.

Windows SmartScreen may warn because the build isn't code-signed. Click *More info → Run
anyway*.

Requirements:
- House Flipper with its Content Creator files, which ship with the game on Steam.
- Python 3 from python.org, for Steam upload and the one-time setup below.
- Steam running, for uploads.

**One-time setup.** The app ships no game data. On first start, Home offers to *Build* the
base-game library. That reads item sizes, names and prices from your own House Flipper
install, takes about 30 seconds, and installs the `UnityPy` Python package if needed. The
tag and category lists are read from the Content Creator files automatically.

## Run from source

```
cd app
npm install
npm run setup     # downloads the Electron runtime once
npm start
```

Or double-click `Start HF Item Studio.cmd`, which does the same. To build the installers,
run `npm run dist` (output goes to `app/dist/`).

## What it does

**Import.** GLB/glTF, FBX, OBJ (+MTL), DAE, STL, PLY, 3DS and 3MF. Textures next to the
model are picked up automatically. Centimetre and millimetre models are rescaled, parts are
merged per material, and the pivot is set the way the game expects:

| Placement | Pivot |
|---|---|
| Floor | bottom centre, resting on y = 0 |
| Wall | middle of the back face, back on z = 0, item sticks out along +Z |
| Ceiling | top centre, hanging from y = 0 |

These rules come from measuring all 4,158 workshop items installed on this PC.

**Hanging items without fiddling.** Wall items are auto-oriented: thinnest side against the
wall, flat back facing it. The model stays flush with the wall, but the colliders start a
few millimetres in front of it (5 mm by default). The game treats a collider that touches
the wall as a collision; that is why roughly a third of workshop creators nudge theirs out
by hand. Ceiling items get the same treatment. You can change the gap and add a side inset
for tight corners.

**Colliders.**
- *Smart fit:* voxelises the model and merges it into a few boxes, so table legs, shelves
  and L-shaped sofas get real collision instead of one big box.
- *Per part* and *one box* modes.
- Exposed flat tops can be marked as surfaces other items stand on.
- Edit boxes by number or with a 3D gizmo.

**See collision and how it looks in a house.**
- *Collision* view shows every collider over the model.
- *In a room* puts the item in a furnished room: floor, walls, door, window, baseboards and
  a 1.80 m person. Drag the item along the floor, wall or ceiling. Colliders turn red when
  they overlap something or sit flush against the wall or ceiling it hangs from.
- You can furnish the room with base-game items (shown at their real collider sizes) or
  with real workshop models.

**Compare with the base game.** 10,812 base-game items (core game plus all six DLCs) were
read from your game's asset bundles with their real collider sizes, prices and tags. Compare
lines your item up next to any of them, or overlays them. It also shows a size table with
percentage differences, suggests similar items and suggests a price.

**Game limits handled for you.**
- Meshes over 64,000 vertices or triangles are split automatically. The game's loader
  rejects anything bigger with "Invalid vertex count in the mesh data".
- Textures over the size limit are downscaled.
- Normal, metal/roughness, AO and emission maps are repacked into Unity's channel layout.
- The checks panel lists everything that would stop an item working, with one-click fixes.

**Batch import.** Queue a folder of models, set shared options or a template, edit names,
prices, placement and category per row (or round-trip them through CSV), then process them
all.

**Templates and variants.**
- Save category, tags, price, placement and collider presets as templates.
- Turn one item into colour variants, with matching `Colors/...` tags, in one step.

**Library.**
- Your projects.
- Every installed workshop item: search, sort, open as is, or "remix" as your own copy.
- Your own Steam uploads.

**Workshop health.** Decodes every mesh of every subscribed item exactly like the game
does and lists the broken ones. On this PC it found 9, for example *Gjora Bed* and
*Wardrobe_Whyte*, whose triangles point past their vertex lists. "Repair copy" opens them
with the bad triangles dropped.

**Game log.** Shows custom-item errors from `Player.log`, with plain explanations.

**Publish.** Uploads to the Steam Workshop through the Content Creator's own Steam API.
Publish as Private first, test it in game, then make it Public. Updates keep the same
Workshop id. "Install locally" swaps your installed copy for quick testing.

## Where things are saved

- Projects: `Documents\HF Item Studio\Projects\<item name>\` holds `<item>.hfcontent`,
  `project.json` and `thumbnail.png`. You can change this in Settings.
- App data (workshop index, health cache, settings):
  `%APPDATA%\HF Item Studio`.

## For developers

```
app/
  main/        Electron main process, file/Steam handlers, steam_helper.py (ctypes)
  renderer/    index.html + styles
  src/core/    .hfcontent reader/writer, mesh codec, PNG codec, game constants
  src/three/   three.js: import, export, colliders, viewport, room, thumbnails
  src/ui/      app shell and views
  tools/       extract_reference.py (builds the base-game library with UnityPy), make_icon.mjs
  build/       installer icon
  test/        node --test suites (codec, pipeline, headless UI)
  dev/         browser dev server (same handlers over HTTP)
```

Run the tests with `npm test` inside `app/`. The format details are documented at the top of
`src/core/meshcodec.js` and `src/core/constants.js`. They were taken from
`HFContentCreatorLib.dll`, the official kit's library.
