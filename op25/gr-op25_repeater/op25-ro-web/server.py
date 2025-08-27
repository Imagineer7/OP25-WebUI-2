#!/usr/bin/env python3
from flask import Flask, jsonify, render_template, send_from_directory
from flask import request
import os, requests

# ---- Config via env or .env (see below) ----
OP25_BASE      = os.getenv("OP25_BASE",      "http://127.0.0.1:8080")   # your OP25 UI origin
OP25_UPDATE    = os.getenv("OP25_UPDATE",    "/update")                 # OP25 update endpoint (read-only)
ICECAST_BASE   = os.getenv("ICECAST_BASE",   "http://127.0.0.1:8000")   # your Icecast
ICECAST_MOUNT  = os.getenv("ICECAST_MOUNT",  "/scanner.mp3")            # your mount path
LISTEN_ADDR    = os.getenv("LISTEN_ADDR",    "0.0.0.0")
LISTEN_PORT    = int(os.getenv("LISTEN_PORT", "9090"))
TIMEOUT        = float(os.getenv("TIMEOUT",   "2.5"))

app = Flask(__name__, static_folder="static", template_folder="templates")

# ---------- Web UI ----------
@app.route("/")
def home():
    return render_template("index.html")

@app.route("/robots.txt")
def robots():
    return "User-agent: *\nDisallow: /\n", 200, {"Content-Type": "text/plain"}

# ---------- Read-only API ----------
@app.route("/api/icecast")
def api_icecast():
    """Pass-through to Icecast JSON stats (read only)."""
    try:
        r = requests.get(f"{ICECAST_BASE}/status-json.xsl", timeout=TIMEOUT)  # official stats endpoint
        r.raise_for_status()
        js = r.json()
        return jsonify({"ok": True, "data": js, "mount": ICECAST_MOUNT})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502

@app.route("/api/now")
def api_now():
    """
    Minimal 'now talking' derived from Icecast metadata 'title'.
    Your OP25 is already capable of pushing TG text to Icecast metadata.
    """
    try:
        r = requests.get(f"{ICECAST_BASE}/status-json.xsl", timeout=TIMEOUT)
        r.raise_for_status()
        js = r.json()
        src = js.get("icestats", {}).get("source", [])
        if not isinstance(src, list): src = [src]
        mount = next((s for s in src if ICECAST_MOUNT in (s.get("listenurl","") or "")), None)
        title = (mount or {}).get("title", "") or ""
        return jsonify({"ok": True, "title": title, "listeners": (mount or {}).get("listeners", 0)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502

@app.route("/api/op25")
def api_op25():
    """
    Read-only pass-through to OP25 update stream.
    We DO NOT forward control commands.
    NOTE: OP25’s web UI periodically calls an 'update' endpoint that returns
    'channel_update' and related messages; we just fetch and return it raw.
    """
    try:
        # Forward any query params OP25 expects (if any)
        q = request.query_string.decode()  # optional
        url = f"{OP25_BASE}{OP25_UPDATE}"
        if q: url += f"?{q}"
        r = requests.get(url, timeout=TIMEOUT)
        r.raise_for_status()
        # The response is JSON (list of messages). Return as-is.
        return jsonify({"ok": True, "data": r.json()})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502

if __name__ == "__main__":
    app.run(host=LISTEN_ADDR, port=LISTEN_PORT)
