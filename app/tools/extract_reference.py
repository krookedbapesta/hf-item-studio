"""Build the base-game reference library used by the Compare view.

Reads House Flipper's asset bundles with UnityPy and writes reference/base_items.json:
one record per shop item with its English name, price, category, tags and real
collider boxes (in the item's local space, metres).

Usage: python extract_reference.py <House Flipper install dir> <output json>
"""
import json
import math
import os
import struct
import sys
import time

import UnityPy

BUNDLES = ["CoreBundles/core_assets", "CoreBundles/full_assets"] + [
    f"AssetBundles/dlc_{d}_assets" for d in ("cyberpunk", "gardens", "hgtv", "luxury", "pets", "preppers")
]
RIG_SUFFIX = "ColliderRig"


def log(*a):
    print(*a, flush=True)


# ---------- localisation (I2 LanguageSource without type trees) ----------

def read_str(raw, pos):
    n = struct.unpack_from("<i", raw, pos)[0]
    if n < 0 or n > 100000 or pos + 4 + n > len(raw):
        return None, pos
    s = raw[pos + 4:pos + 4 + n]
    end = pos + 4 + n
    end += (-end) % 4
    try:
        return s.decode("utf-8"), end
    except UnicodeDecodeError:
        return None, pos


def load_localisation(game_dir):
    env = UnityPy.load(os.path.join(game_dir, "HouseFlipper_Data", "resources.assets"))
    names = {}
    marker = b"Items/name_"
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        raw = obj.get_raw_data()
        if marker not in raw:
            continue
        i = raw.find(marker)
        while i != -1:
            key, end = read_str(raw, i - 4)
            if key and key.startswith("Items/"):
                # term layout: Term, Description (empty string), Languages[] count, then English first
                desc, p = read_str(raw, end)
                if desc is not None:
                    count = struct.unpack_from("<i", raw, p)[0]
                    if 1 <= count <= 64:
                        en, _ = read_str(raw, p + 4)
                        if en:
                            names[key[len("Items/"):]] = en
            i = raw.find(marker, i + 1)
        if names:
            break
    return names


# ---------- transforms ----------

def qrot(q, v):
    x, y, z, w = q
    vx, vy, vz = v
    tx = 2 * (y * vz - z * vy)
    ty = 2 * (z * vx - x * vz)
    tz = 2 * (x * vy - y * vx)
    return (vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx))


def v3(d):
    return (d["x"], d["y"], d["z"])


def q4(d):
    return (d["x"], d["y"], d["z"], d["w"])


def chain_to_root(tr_tree, reader_by_id):
    """Return list of (pos, rot, scale) from this transform up to (excluding) the prefab root."""
    chain = []
    cur = tr_tree
    while True:
        father = cur["m_Father"]["m_PathID"]
        if father == 0:
            break  # cur is the root; root transform is ignored (item placed at its pivot)
        chain.append((v3(cur["m_LocalPosition"]), q4(cur["m_LocalRotation"]), v3(cur["m_LocalScale"])))
        cur = reader_by_id[father].read_typetree()
    return chain


def apply_chain(chain, p):
    for pos, rot, scl in chain:
        p = (p[0] * scl[0], p[1] * scl[1], p[2] * scl[2])
        p = qrot(rot, p)
        p = (p[0] + pos[0], p[1] + pos[1], p[2] + pos[2])
    return p


def obb_from_box(chain, center, size):
    """Return the 8 corners in item space for a BoxCollider."""
    cx, cy, cz = center
    sx, sy, sz = size
    return [apply_chain(chain, (cx + dx * sx / 2, cy + dy * sy / 2, cz + dz * sz / 2))
            for dx in (-1, 1) for dy in (-1, 1) for dz in (-1, 1)]


def rnd(v, n=4):
    return [round(x, n) for x in v]


# ---------- extraction ----------

def extract_bundle(path, loc, source):
    env = UnityPy.load(path)
    reader_by_id = {}
    for obj in env.objects:
        reader_by_id[obj.path_id] = obj

    name_cache = {}

    def asset_name(pptr):
        pid = pptr["m_PathID"]
        if pid == 0 or pptr["m_FileID"] != 0 or pid not in reader_by_id:
            return None
        if pid not in name_cache:
            try:
                raw = reader_by_id[pid].get_raw_data()
                # MonoBehaviour header: GameObject PPtr(12) Enabled(4 aligned) Script PPtr(12) then m_Name
                nm, _ = read_str(raw, 28)
                name_cache[pid] = nm
            except Exception:
                name_cache[pid] = None
        return name_cache[pid]

    items = []
    for cpath, obj in env.container.items():
        if not cpath.endswith(".prefab") or "/shopitems/" not in cpath:
            continue
        try:
            go = obj.read_typetree()
        except Exception:
            continue
        item_tt = None
        rig = None
        root_tr = None
        for comp in go["m_Component"]:
            r = reader_by_id.get(comp["component"]["m_PathID"])
            if r is None:
                continue
            if r.type.name == "Transform":
                root_tr = r
                continue
            if r.type.name != "MonoBehaviour":
                continue
            try:
                tt = r.read_typetree()
            except Exception:
                continue
            if "itemData" in tt:
                item_tt = tt
            elif "colliders" in tt and "x" in tt:
                rig = tt
        if item_tt is None:
            continue
        idata = item_tt["itemData"]
        key = idata.get("nameLocalizationKey", "")
        boxes = []
        collider_ids = [c["m_PathID"] for c in (rig or {}).get("colliders", [])]
        if not collider_ids and root_tr is not None:
            # fall back to every BoxCollider in the hierarchy
            stack = [root_tr]
            while stack:
                t = stack.pop()
                ttt = t.read_typetree()
                gor = reader_by_id.get(ttt["m_GameObject"]["m_PathID"])
                if gor:
                    for comp in gor.read_typetree()["m_Component"]:
                        cr = reader_by_id.get(comp["component"]["m_PathID"])
                        if cr is not None and cr.type.name == "BoxCollider":
                            collider_ids.append(cr.path_id)
                for ch in ttt["m_Children"]:
                    if ch["m_PathID"] in reader_by_id:
                        stack.append(reader_by_id[ch["m_PathID"]])
        for cid in collider_ids:
            cr = reader_by_id.get(cid)
            if cr is None or cr.type.name != "BoxCollider":
                continue
            try:
                bc = cr.read_typetree()
                gor = reader_by_id[bc["m_GameObject"]["m_PathID"]]
                trr = None
                for comp in gor.read_typetree()["m_Component"]:
                    x = reader_by_id.get(comp["component"]["m_PathID"])
                    if x is not None and x.type.name == "Transform":
                        trr = x
                        break
                chain = chain_to_root(trr.read_typetree(), reader_by_id) if trr else []
                corners = obb_from_box(chain, v3(bc["m_Center"]), v3(bc["m_Size"]))
                mn = [min(c[i] for c in corners) for i in range(3)]
                mx = [max(c[i] for c in corners) for i in range(3)]
                boxes.append({"min": rnd(mn), "max": rnd(mx)})
            except Exception:
                continue
        if boxes:
            mn = [min(b["min"][i] for b in boxes) for i in range(3)]
            mx = [max(b["max"][i] for b in boxes) for i in range(3)]
        elif rig:
            sx, sy, sz = rig["x"], rig["y"], rig["z"]
            off = v3(rig.get("offset", {"x": 0, "y": 0, "z": 0}))
            mn = [off[0] - sx / 2, off[1], off[2] - sz / 2]
            mx = [off[0] + sx / 2, off[1] + sy, off[2] + sz / 2]
        else:
            continue
        tags = [asset_name(t) for t in idata.get("itemTags", [])]
        rel = cpath.split("/shopitems/", 1)[1]
        folder = "/".join(rel.split("/")[:-1])
        items.append({
            "id": idata.get("prefabGuid") or cpath,
            "name": loc.get(key) or os.path.splitext(os.path.basename(cpath))[0],
            "key": key,
            "price": idata.get("price"),
            "category": asset_name(idata.get("categoryAsset", {"m_FileID": 1, "m_PathID": 0})),
            "tags": [t for t in tags if t],
            "folder": folder,
            "source": source,
            "min": rnd(mn),
            "max": rnd(mx),
            "size": rnd([mx[i] - mn[i] for i in range(3)]),
            "boxes": boxes[:24],
        })
    return items


def main():
    game_dir = sys.argv[1]
    out = sys.argv[2]
    t0 = time.time()
    loc = load_localisation(game_dir)
    log(f"localisation: {len(loc)} item names ({time.time() - t0:.1f}s)")
    all_items = []
    for b in BUNDLES:
        p = os.path.join(game_dir, b)
        if not os.path.exists(p):
            continue
        t = time.time()
        source = os.path.basename(b).replace("_assets", "")
        items = extract_bundle(p, loc, source)
        log(f"{b}: {len(items)} items ({time.time() - t:.1f}s)")
        all_items.extend(items)
    seen = set()
    uniq = []
    for it in all_items:
        if it["id"] in seen:
            continue
        seen.add(it["id"])
        uniq.append(it)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"generated": time.strftime("%Y-%m-%d"), "count": len(uniq), "items": uniq}, f, ensure_ascii=False)
    log(f"wrote {len(uniq)} items to {out} in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
