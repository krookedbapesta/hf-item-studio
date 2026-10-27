"""Steam Workshop bridge for HF Item Studio.

Talks to the steam_api64.dll that ships with the House Flipper Content Creator, so items can
be published without opening Unity. Run as:

    python steam_helper.py <command> <json-args>

and it prints one JSON object per line: {"event": "progress", ...} while working and a final
{"event": "result", ...} or {"event": "error", "message": ...}.

Commands: status, publish, subscribe, installinfo, myitems
"""
import ctypes as C
import json
import os
import sys
import time

WORKSHOP_APP = 613100
CREATOR_APP = 1471280

CALLBACK_CREATE_ITEM = 3403
CALLBACK_SUBMIT_UPDATE = 3404
CALLBACK_SUBSCRIBE = 1313
CALLBACK_QUERY_COMPLETED = 3401

UPDATE_STATUS = {0: "Invalid", 1: "Preparing config", 2: "Preparing content", 3: "Uploading content", 4: "Uploading preview", 5: "Committing changes"}
RESULTS = {
    1: "OK", 2: "Failure", 8: "Invalid parameter", 9: "File not found", 14: "Duplicate name",
    15: "Access denied", 16: "Timeout", 17: "Banned", 20: "Service unavailable", 21: "Not logged on",
    25: "Limit exceeded (Steam Cloud quota or preview too large)", 29: "Duplicate request", 33: "Lock failed",
    44: "Account recently changed password/email",
}


def emit(**kw):
    sys.stdout.write(json.dumps(kw) + "\n")
    sys.stdout.flush()


class CreateItemResult(C.Structure):
    _pack_ = 8
    _fields_ = [("result", C.c_int32), ("file_id", C.c_uint64), ("needs_legal", C.c_bool)]


class SubmitItemUpdateResult(C.Structure):
    _pack_ = 8
    _fields_ = [("result", C.c_int32), ("needs_legal", C.c_bool), ("file_id", C.c_uint64)]


class SubscribeResult(C.Structure):
    _pack_ = 8
    _fields_ = [("result", C.c_int32), ("file_id", C.c_uint64)]


class QueryCompleted(C.Structure):
    _pack_ = 8
    _fields_ = [("handle", C.c_uint64), ("result", C.c_int32), ("returned", C.c_uint32), ("total", C.c_uint32), ("cached", C.c_bool), ("cursor", C.c_char * 256)]


class ParamStringArray(C.Structure):
    _fields_ = [("strings", C.POINTER(C.c_char_p)), ("count", C.c_int32)]


class Steam:
    def __init__(self, dll_path, app_id=CREATOR_APP):
        os.environ["SteamAppId"] = str(app_id)
        os.environ["SteamGameId"] = str(app_id)
        self.dll = C.CDLL(dll_path)
        d = self.dll
        d.SteamAPI_Init.restype = C.c_bool
        if not d.SteamAPI_Init():
            raise RuntimeError("Steam API failed to start. Make sure Steam is running, you are logged in, and you own House Flipper.")
        for attr, name in (("ugc", "SteamUGC_v014"), ("utils", "SteamUtils_v009"), ("friends", "SteamFriends_v017"), ("user_ptr", "SteamUser_v020")):
            f = getattr(d, f"SteamAPI_{name}")
            f.restype = C.c_void_p
            setattr(self, attr, f())
        self.app_id = app_id
        sig = {
            "ISteamUGC_CreateItem": (C.c_uint64, [C.c_void_p, C.c_uint32, C.c_int]),
            "ISteamUGC_StartItemUpdate": (C.c_uint64, [C.c_void_p, C.c_uint32, C.c_uint64]),
            "ISteamUGC_SetItemTitle": (C.c_bool, [C.c_void_p, C.c_uint64, C.c_char_p]),
            "ISteamUGC_SetItemDescription": (C.c_bool, [C.c_void_p, C.c_uint64, C.c_char_p]),
            "ISteamUGC_SetItemUpdateLanguage": (C.c_bool, [C.c_void_p, C.c_uint64, C.c_char_p]),
            "ISteamUGC_SetItemVisibility": (C.c_bool, [C.c_void_p, C.c_uint64, C.c_int]),
            "ISteamUGC_SetItemTags": (C.c_bool, [C.c_void_p, C.c_uint64, C.POINTER(ParamStringArray)]),
            "ISteamUGC_SetItemContent": (C.c_bool, [C.c_void_p, C.c_uint64, C.c_char_p]),
            "ISteamUGC_SetItemPreview": (C.c_bool, [C.c_void_p, C.c_uint64, C.c_char_p]),
            "ISteamUGC_SubmitItemUpdate": (C.c_uint64, [C.c_void_p, C.c_uint64, C.c_char_p]),
            "ISteamUGC_GetItemUpdateProgress": (C.c_int, [C.c_void_p, C.c_uint64, C.POINTER(C.c_uint64), C.POINTER(C.c_uint64)]),
            "ISteamUGC_SubscribeItem": (C.c_uint64, [C.c_void_p, C.c_uint64]),
            "ISteamUGC_GetItemInstallInfo": (C.c_bool, [C.c_void_p, C.c_uint64, C.POINTER(C.c_uint64), C.c_char_p, C.c_uint32, C.POINTER(C.c_uint32)]),
            "ISteamUGC_GetItemState": (C.c_uint32, [C.c_void_p, C.c_uint64]),
            "ISteamUGC_CreateQueryUserUGCRequest": (C.c_uint64, [C.c_void_p, C.c_uint32, C.c_int, C.c_int, C.c_int, C.c_uint32, C.c_uint32, C.c_uint32]),
            "ISteamUGC_SendQueryUGCRequest": (C.c_uint64, [C.c_void_p, C.c_uint64]),
            "ISteamUGC_GetQueryUGCResult": (C.c_bool, [C.c_void_p, C.c_uint64, C.c_uint32, C.c_void_p]),
            "ISteamUGC_ReleaseQueryUGCRequest": (C.c_bool, [C.c_void_p, C.c_uint64]),
            "ISteamUtils_IsAPICallCompleted": (C.c_bool, [C.c_void_p, C.c_uint64, C.POINTER(C.c_bool)]),
            "ISteamUtils_GetAPICallResult": (C.c_bool, [C.c_void_p, C.c_uint64, C.c_void_p, C.c_int, C.c_int, C.POINTER(C.c_bool)]),
            "ISteamFriends_GetPersonaName": (C.c_char_p, [C.c_void_p]),
            "ISteamUser_GetSteamID": (C.c_uint64, [C.c_void_p]),
        }
        for name, (res, args) in sig.items():
            try:
                f = getattr(d, "SteamAPI_" + name)
            except AttributeError:
                continue
            f.restype = res
            f.argtypes = args
        d.SteamAPI_RunCallbacks.restype = None
        d.SteamAPI_Shutdown.restype = None

    def call(self, name, *args):
        return getattr(self.dll, "SteamAPI_" + name)(*args)

    def wait(self, handle, struct, callback_id, timeout=120, on_tick=None):
        failed = C.c_bool(False)
        start = time.time()
        while not self.call("ISteamUtils_IsAPICallCompleted", self.utils, handle, C.byref(failed)):
            self.dll.SteamAPI_RunCallbacks()
            if on_tick:
                on_tick()
            if time.time() - start > timeout:
                raise RuntimeError("Steam did not answer in time")
            time.sleep(0.1)
        out = struct()
        ok = self.call("ISteamUtils_GetAPICallResult", self.utils, handle, C.byref(out), C.sizeof(out), callback_id, C.byref(failed))
        if not ok or failed.value:
            raise RuntimeError("Steam call failed (I/O failure)")
        return out

    def user(self):
        name = self.call("ISteamFriends_GetPersonaName", self.friends)
        return {"name": name.decode("utf-8", "replace") if name else "", "steamId": str(self.call("ISteamUser_GetSteamID", self.user_ptr))}

    def shutdown(self):
        try:
            self.dll.SteamAPI_Shutdown()
        except Exception:
            pass


def result_text(code):
    return RESULTS.get(code, f"Steam error {code}")


def open_steam(args):
    dll = args.get("dll")
    if not dll or not os.path.exists(dll):
        raise RuntimeError(f"steam_api64.dll not found at {dll}")
    errors = []
    for app in (args.get("appId") or CREATOR_APP, WORKSHOP_APP):
        try:
            return Steam(dll, app)
        except RuntimeError as e:
            errors.append(f"app {app}: {e}")
        except OSError as e:
            raise RuntimeError(f"Could not load {dll}: {e}")
    raise RuntimeError("; ".join(errors))


def cmd_status(args):
    s = open_steam(args)
    try:
        u = s.user()
        return {"ok": True, "user": u["name"], "steamId": u["steamId"], "appId": s.app_id}
    finally:
        s.shutdown()


def cmd_publish(args):
    """args: dll, fileId (optional), title, description, visibility, tags[], contentDir, preview, changeNote, language"""
    s = open_steam(args)
    try:
        file_id = int(args.get("fileId") or 0)
        if not file_id:
            emit(event="progress", stage="Creating workshop item", percent=0)
            res = s.wait(s.call("ISteamUGC_CreateItem", s.ugc, WORKSHOP_APP, 0), CreateItemResult, CALLBACK_CREATE_ITEM)
            if res.result != 1:
                raise RuntimeError(f"Could not create the item: {result_text(res.result)}")
            file_id = res.file_id
            emit(event="created", fileId=str(file_id), needsLegal=bool(res.needs_legal))
            if args.get("createOnly"):
                return {"fileId": str(file_id), "needsLegal": bool(res.needs_legal), "created": True}
        h = s.call("ISteamUGC_StartItemUpdate", s.ugc, WORKSHOP_APP, file_id)
        enc = lambda v: (v or "").encode("utf-8")
        if args.get("title") is not None:
            s.call("ISteamUGC_SetItemTitle", s.ugc, h, enc(args["title"][:128]))
        if args.get("description") is not None:
            s.call("ISteamUGC_SetItemDescription", s.ugc, h, enc(args["description"][:8000]))
        if args.get("language"):
            s.call("ISteamUGC_SetItemUpdateLanguage", s.ugc, h, enc(args["language"]))
        if args.get("visibility") is not None:
            s.call("ISteamUGC_SetItemVisibility", s.ugc, h, int(args["visibility"]))
        tags = [t for t in (args.get("tags") or []) if t][:20]
        if tags:
            arr = (C.c_char_p * len(tags))(*[enc(t)[:255] for t in tags])
            psa = ParamStringArray(arr, len(tags))
            s.call("ISteamUGC_SetItemTags", s.ugc, h, C.byref(psa))
        if args.get("contentDir"):
            if not s.call("ISteamUGC_SetItemContent", s.ugc, h, os.path.abspath(args["contentDir"]).encode("utf-8")):
                raise RuntimeError("Steam rejected the content folder")
        if args.get("preview"):
            if not s.call("ISteamUGC_SetItemPreview", s.ugc, h, os.path.abspath(args["preview"]).encode("utf-8")):
                raise RuntimeError("Steam rejected the preview image")
        processed, total = C.c_uint64(0), C.c_uint64(0)
        last = [None]

        def tick():
            st = s.call("ISteamUGC_GetItemUpdateProgress", s.ugc, h, C.byref(processed), C.byref(total))
            pct = int(processed.value * 100 / total.value) if total.value else 0
            key = (st, pct)
            if key != last[0]:
                last[0] = key
                emit(event="progress", stage=UPDATE_STATUS.get(st, str(st)), percent=pct, bytes=processed.value, total=total.value)

        call = s.call("ISteamUGC_SubmitItemUpdate", s.ugc, h, enc(args.get("changeNote") or ""))
        res = s.wait(call, SubmitItemUpdateResult, CALLBACK_SUBMIT_UPDATE, timeout=1800, on_tick=tick)
        if res.result != 1:
            raise RuntimeError(f"Upload failed: {result_text(res.result)}")
        if args.get("subscribe", True):
            try:
                s.wait(s.call("ISteamUGC_SubscribeItem", s.ugc, file_id), SubscribeResult, CALLBACK_SUBSCRIBE, timeout=30)
            except RuntimeError:
                pass
        return {"fileId": str(file_id), "needsLegal": bool(res.needs_legal), "url": f"https://steamcommunity.com/sharedfiles/filedetails/?id={file_id}"}
    finally:
        s.shutdown()


def cmd_subscribe(args):
    s = open_steam(args)
    try:
        res = s.wait(s.call("ISteamUGC_SubscribeItem", s.ugc, int(args["fileId"])), SubscribeResult, CALLBACK_SUBSCRIBE, timeout=30)
        return {"ok": res.result == 1, "result": result_text(res.result)}
    finally:
        s.shutdown()


def cmd_installinfo(args):
    s = open_steam(args)
    try:
        size, ts = C.c_uint64(0), C.c_uint32(0)
        buf = C.create_string_buffer(1024)
        ok = s.call("ISteamUGC_GetItemInstallInfo", s.ugc, int(args["fileId"]), C.byref(size), buf, 1024, C.byref(ts))
        state = s.call("ISteamUGC_GetItemState", s.ugc, int(args["fileId"]))
        return {"installed": bool(ok), "folder": buf.value.decode("utf-8", "replace"), "size": size.value, "timestamp": ts.value, "state": state}
    finally:
        s.shutdown()


def cmd_myitems(args):
    """Items the logged-in user published for House Flipper."""
    s = open_steam(args)
    try:
        account = s.call("ISteamUser_GetSteamID", s.user_ptr) & 0xFFFFFFFF
        out = []
        page = 1
        while page <= 10:
            # list type 0 = Published, matching type 0 = Items, sort 0 = creation order desc
            q = s.call("ISteamUGC_CreateQueryUserUGCRequest", s.ugc, account, 0, 0, 0, s.app_id, WORKSHOP_APP, page)
            res = s.wait(s.call("ISteamUGC_SendQueryUGCRequest", s.ugc, q), QueryCompleted, CALLBACK_QUERY_COMPLETED, timeout=60)
            if res.result != 1:
                s.call("ISteamUGC_ReleaseQueryUGCRequest", s.ugc, q)
                raise RuntimeError(f"Query failed: {result_text(res.result)}")
            buf = C.create_string_buffer(10240)
            for i in range(res.returned):
                if not s.call("ISteamUGC_GetQueryUGCResult", s.ugc, q, i, buf):
                    continue
                raw = buf.raw
                fid = int.from_bytes(raw[0:8], "little")
                title = raw[24:24 + 129].split(b"\0", 1)[0].decode("utf-8", "replace")
                t_created = int.from_bytes(raw[8168:8172], "little")
                t_updated = int.from_bytes(raw[8172:8176], "little")
                vis = int.from_bytes(raw[8180:8184], "little")
                tags = raw[8187:8187 + 1025].split(b"\0", 1)[0].decode("utf-8", "replace")
                out.append({"fileId": str(fid), "title": title, "created": t_created, "updated": t_updated, "visibility": vis, "tags": tags.split(",") if tags else []})
            s.call("ISteamUGC_ReleaseQueryUGCRequest", s.ugc, q)
            if res.returned < 50:
                break
            page += 1
        return {"items": out}
    finally:
        s.shutdown()


def main():
    if len(sys.argv) < 2:
        emit(event="error", message="usage: steam_helper.py <command> <json>")
        return 2
    cmd = sys.argv[1]
    try:
        args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as e:
        emit(event="error", message=f"bad arguments: {e}")
        return 2
    fn = {"status": cmd_status, "publish": cmd_publish, "subscribe": cmd_subscribe, "installinfo": cmd_installinfo, "myitems": cmd_myitems}.get(cmd)
    if not fn:
        emit(event="error", message=f"unknown command {cmd}")
        return 2
    try:
        emit(event="result", **fn(args))
        return 0
    except Exception as e:  # report every failure to the app instead of a traceback
        emit(event="error", message=str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())
