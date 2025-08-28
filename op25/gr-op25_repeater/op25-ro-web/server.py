#!/usr/bin/env python3
from flask import Flask, jsonify, render_template, request, send_from_directory, abort, Response
from flask import stream_with_context
import os, json, time, requests

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
    # optional cache-buster from client
    _ = request.args.get("nocache")

    sess = requests.Session()
    try:
        # Ask Icecast for RAW audio only (no interleaved ICY metadata)
        upstream = sess.get(
            f"{ICECAST_BASE}{ICECAST_MOUNT}",
            headers={"Icy-MetaData": "0"},
            stream=True,
            timeout=(3.05, None)  # connect timeout, no read timeout
        )
        upstream.raise_for_status()

        def gen():
            try:
                for chunk in upstream.iter_content(chunk_size=16384):
                    if chunk:
                        # IMPORTANT: don't transform, just pass bytes through
                        yield chunk
            except GeneratorExit:
                pass
            finally:
                try: upstream.close()
                finally: sess.close()

        # Friendlier caching (drop "no-store"), keep no-cache; enable CORS; avoid ranges
        headers = {
            "Content-Type": upstream.headers.get("Content-Type", "audio/mpeg"),
            "Cache-Control": "no-cache, must-revalidate, no-transform",
            "Pragma": "no-cache",
            "Expires": "0",
            "Accept-Ranges": "none",
            "Connection": "keep-alive",
            # Let the VU meter sample across origins if you hit this via a domain
            "Access-Control-Allow-Origin": "*",
            "Timing-Allow-Origin": "*",
        }

        # Do NOT forward icy-metaint (we asked upstream not to send it anyway)
        return Response(
            stream_with_context(gen()),
            headers=headers,
            status=200,
            direct_passthrough=True  # ensure Werkzeug treats this as a real stream
        )

    except Exception as e:
        try: sess.close()
        except: pass
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
        r = requests.get("http://127.0.0.1:8080/ro-now", timeout=2.0)
        r.raise_for_status()
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

if __name__ == "__main__":
    app.run(host=LISTEN_ADDR, port=LISTEN_PORT)
