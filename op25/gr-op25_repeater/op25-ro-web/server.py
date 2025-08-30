#!/usr/bin/env python3
from flask import Flask, jsonify, render_template, request, send_from_directory, abort, Response
from flask import stream_with_context
import os, json, time, requests
import threading
import random

ICECAST_BASE   = os.getenv("ICECAST_BASE",   "http://127.0.0.1:8000")
ICECAST_MOUNT  = os.getenv("ICECAST_MOUNT",  "/op25.mp3")  # set to your mount
LISTEN_ADDR    = os.getenv("LISTEN_ADDR",    "0.0.0.0")
LISTEN_PORT    = int(os.getenv("LISTEN_PORT", "9090"))
TIMEOUT        = float(os.getenv("TIMEOUT",   "2.5"))

DATA_DIR       = os.getenv("DATA_DIR",        "/tmp/op25_ro_data")
os.makedirs(DATA_DIR, exist_ok=True)
NOW_PATH       = os.path.join(DATA_DIR, "now.json")
HIST_PATH      = os.path.join(DATA_DIR, "history.json")
HIST_LIMIT     = 2000

app = Flask(__name__, static_folder="static", template_folder="templates")

@app.route("/")
def home():
    return render_template("index.html")

@app.route("/robots.txt")
def robots():
    return "User-agent: *\nDisallow: /\n", 200, {"Content-Type": "text/plain"}

# ---- CSP-safe config (single definition) ----
@app.route("/config.js")
def config_js():
    pub = os.getenv("ICECAST_PUBLIC", "http://192.168.222.125:8000")  # change if needed
    payload = {
        "mountHint": ICECAST_MOUNT,
        "streamUrl": f"{pub}{ICECAST_MOUNT}",
        "hasHistory": True
    }
    js = "window.ROCFG = " + json.dumps(payload) + ";"
    return (js, 200, {"Content-Type": "application/javascript", "Cache-Control": "no-store"})

# ---- Optional: Icecast status passthrough ----
@app.route("/api/icecast")
def api_icecast():
    try:
        r = requests.get(f"{ICECAST_BASE}/status-json.xsl", timeout=TIMEOUT)
        r.raise_for_status()
        js = r.json()
        return jsonify({"ok": True, "data": js, "mount": ICECAST_MOUNT})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502

# ---- Same-origin audio proxy (avoids localhost/mixed-content) ----
@app.route("/stream")
def stream():
    # Optional cache-buster; not used, just varies URL for caches
    _ = request.args.get("nocache")

    sess = requests.Session()
    try:
        # Ask Icecast for RAW audio (no interleaved ICY metadata) and no compression
        upstream = sess.get(
            f"{ICECAST_BASE}{ICECAST_MOUNT}",
            headers={
                "Icy-MetaData": "0",
                "Accept": "audio/mpeg,*/*;q=0.1",
                "Accept-Encoding": "identity",
                "Connection": "keep-alive",
                # Some Icecast builds behave better if we also send a UA:
                "User-Agent": "op25-proxy/1.0"
            },
            stream=True,
            timeout=(3.05, None),   # (connect timeout, read timeout None = unlimited)
            allow_redirects=True
        )
        upstream.raise_for_status()

        def gen():
            try:
                for chunk in upstream.iter_content(chunk_size=16 * 1024):
                    if chunk:
                        # Pass bytes as-is. No transforms, no buffering.
                        yield chunk
            finally:
                try:
                    upstream.close()
                finally:
                    sess.close()

        # Build response headers. IMPORTANT: avoid `no-store`.
        headers = {
            # Trust upstream type if present; default to MP3
            "Content-Type": upstream.headers.get("Content-Type", "audio/mpeg"),

            # Allow a tiny rolling buffer (Firefox needs this). No `no-store`.
            "Cache-Control": "no-cache, must-revalidate, no-transform",
            "Pragma": "no-cache",
            "Expires": "0",

            # Streaming/transport hints
            "Accept-Ranges": "none",
            "Connection": "keep-alive",
            "Keep-Alive": "timeout=60, max=1000",

            # Disable reverse-proxy buffering (Nginx)
            "X-Accel-Buffering": "no",

            # CORS so WebAudio analyser can read samples across origins
            "Access-Control-Allow-Origin": "*",
            "Timing-Allow-Origin": "*",

            # Be explicit for old sniffers
            "X-Content-Type-Options": "nosniff",
        }

        # Do NOT forward `icy-metaint` (we requested none).

        return Response(
            stream_with_context(gen()),
            status=200,
            headers=headers,
            direct_passthrough=True  # ensure Werkzeug does not buffer
        )

    except Exception as e:
        try:
            sess.close()
        except Exception:
            pass
        return jsonify({"ok": False, "error": str(e)}), 502
    
@app.route("/stream-direct")
def stream_direct():
    return "", 302, {"Location": f"{ICECAST_BASE}{ICECAST_MOUNT}"}

# ---- Read-only JSON for the public page ----
@app.route("/data/<path:name>")
def serve_data(name):
    if name not in ("now.json","history.json"):
        abort(404)
    return send_from_directory(DATA_DIR, name, max_age=0)

@app.route("/api/live")
def api_live():
    try:
        # Check for test call override
        with testcall_lock:
            override = testcall_override["data"]
            expires = testcall_override["expires"]

        # Fetch real data
        r = requests.get("http://127.0.0.1:8080/ro-now", timeout=2.0)
        r.raise_for_status()
        real_data = r.json()

        # If override is active and not expired, and real data is idle, serve override
        now_time = time.time()
        is_real_idle = real_data.get("idle", True) or not real_data.get("now", {}).get("name")
        if override and expires > now_time and is_real_idle:
            # Copy override and update ts to current time
            test_now = dict(override)
            test_now["ts"] = time.time()
            return (json.dumps({
                "ok": True,
                "idle": False,
                "now": test_now
            }), 200, {
                "Content-Type":"application/json",
                "Cache-Control":"no-store, no-cache, must-revalidate, max-age=0",
                "Pragma":"no-cache",
                "Expires":"0"
            })
        # If a real call comes in, clear the override
        if override and not is_real_idle:
            with testcall_lock:
                testcall_override["data"] = None
                testcall_override["expires"] = 0

        # Otherwise, serve real data
        return (r.content, 200, {
            "Content-Type":"application/json",
            "Cache-Control":"no-store, no-cache, must-revalidate, max-age=0",
            "Pragma":"no-cache",
            "Expires":"0"
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502

# ---- Local-only ingest from your main OP25 UI ----
@app.route("/ingest/now", methods=["POST"])
def ingest_now():
    # Only allow requests from localhost (must SSH into host to use)
    if request.remote_addr not in ("127.0.0.1", "::1"):
        abort(403)
    try:
        rec = request.get_json(force=True) or {}
        t = int(time.time())
        now = {
            "ts": t,
            "tgid":  str(rec.get("tgid","")),
            "name":  str(rec.get("name","")),
            "freq":  str(rec.get("freq","")),
            "source":str(rec.get("source","")),
            "enc":   str(rec.get("enc","")),
        }
        with open(NOW_PATH, "w") as f: json.dump(now, f)

        # history (most recent first)
        hist = []
        if os.path.exists(HIST_PATH):
            try: hist = json.load(open(HIST_PATH)) or []
            except: hist = []
        row = {
            "time": time.strftime("%H:%M:%S"),
            "tgid": now["tgid"], "name": now["name"], "freq": now["freq"],
            "source": now["source"], "enc": now["enc"]
        }
        if not hist or row != hist[0]:
            hist.insert(0, row)
            hist = hist[:HIST_LIMIT]
            with open(HIST_PATH, "w") as f: json.dump(hist, f)

        # optional: update Icecast title for players
        if rec.get("update_icecast"):
            try:
                user = os.getenv("ICECAST_USER", "source")
                pw   = os.getenv("ICECAST_PASS", "hackme")
                title = rec.get("title") or f"TG {now['tgid']} ({now['name']}) ID:{now['source']} F:{now['freq']} ENC:{now['enc']}"
                requests.get(f"{ICECAST_BASE}/admin/metadata",
                             params={"mode":"updinfo","mount":ICECAST_MOUNT,"song":title},
                             timeout=2.0, auth=(user, pw))
            except Exception:
                pass

        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400

@app.route("/simulate/testcall", methods=["POST"])
def simulate_test_call():
    """Simulate a fake call for frontend testing (local/private use only)."""
    if request.remote_addr not in ("127.0.0.1", "::1"):
        abort(403)
    try:
        # Random duration between 3 and 12 seconds
        duration = random.randint(3, 12)
        t = int(time.time())
        now = {
            "ts": t,
            "tgid":  "99999",
            "name":  "TEST CALL",
            "freq":  "123.456789",
            "source":"SIM",
            "enc":   "",
        }
        # Write active call
        with open(NOW_PATH, "w") as f: json.dump(now, f)
        # Add to history
        hist = []
        if os.path.exists(HIST_PATH):
            try: hist = json.load(open(HIST_PATH)) or []
            except: hist = []
        row = {
            "time": time.strftime("%H:%M:%S"),
            "tgid": now["tgid"], "name": now["name"], "freq": now["freq"],
            "source": now["source"], "enc": now["enc"]
        }
        if not hist or row != hist[0]:
            hist.insert(0, row)
            hist = hist[:HIST_LIMIT]
            with open(HIST_PATH, "w") as f: json.dump(hist, f)

        # Set override for /api/live
        with testcall_lock:
            testcall_override["data"] = now
            testcall_override["expires"] = time.time() + duration

        # After duration, clear override and set idle
        def set_idle():
            idle_now = now.copy()
            idle_now["name"] = ""
            idle_now["source"] = ""
            idle_now["enc"] = ""
            idle_now["freq"] = ""
            idle_now["tgid"] = ""
            idle_now["ts"] = int(time.time())  # Make sure this is the current time!
            with open(NOW_PATH, "w") as f: json.dump(idle_now, f)
            with testcall_lock:
                testcall_override["data"] = None
                testcall_override["expires"] = 0
        threading.Timer(duration, set_idle).start()

        return jsonify({"ok": True, "duration": duration})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400

testcall_override = {
    "data": None,
    "expires": 0
}
testcall_lock = threading.Lock()

if __name__ == "__main__":
    app.run(host=LISTEN_ADDR, port=LISTEN_PORT)
