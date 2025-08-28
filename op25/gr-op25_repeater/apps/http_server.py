# Copyright 2017, 2018 Max H. Parke KA1RBI
# 
# This file is part of OP25
# 
# OP25 is free software; you can redistribute it and/or modify it
# under the terms of the GNU General Public License as published by
# the Free Software Foundation; either version 3, or (at your option)
# any later version.
# 
# OP25 is distributed in the hope that it will be useful, but WITHOUT
# ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
# or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
# License for more details.
# 
# You should have received a copy of the GNU General Public License
# along with OP25; see the file COPYING. If not, write to the Free
# Software Foundation, Inc., 51 Franklin Street, Boston, MA
# 02110-1301, USA.

import sys
import os
import time
import re
import json
import socket
import traceback
import threading
import mimetypes
from collections import deque

from urllib.parse import unquote
from gnuradio import gr
from waitress.server import create_server
from typing import Any, Dict, List

import gnuradio.op25_repeater as op25_repeater

# ----- Debug / instrumentation -----
OP25_DEBUG = os.environ.get("OP25_DEBUG", "0") == "1"

def _dbg(s):
    if OP25_DEBUG:
        try:
            sys.stderr.write(s + "\n")
        except Exception:
            pass

_type_counts = {}                 # msg.type() → count
_raw_ring = deque(maxlen=100)     # last ~100 raw payloads (truncated)
_last_seen_ts = 0.0               # last time we saw any msg
_last_json_ok = 0                 # parsed as JSON ok
_last_json_fail = 0               # JSON parse failed
_last_msg_type = None             # last msg.type()

# --- read-only live "now" snapshot for public polling (no files) ---
_LIVE_IDLE_SEC = 6.0          # consider idle if no update for N seconds
_live_now = {"ts": 0, "tgid":"", "name":"", "freq":"", "source":"", "enc":""}

def _hz_to_mhz_str(v):
    try:
        x = float(v)
        if x > 1e5: x /= 1e6
        return f"{x:.6f}"
    except Exception:
        return str(v or "")

# --- Public export helpers (writes files for the read-only site) ---
OP25_PUBLIC_DATA_DIR = os.environ.get("OP25_PUBLIC_DATA_DIR", "/tmp/op25_ro_data")
OP25_PUBLIC_HIST_LIMIT = int(os.environ.get("OP25_PUBLIC_HIST_LIMIT", "2000"))
os.makedirs(OP25_PUBLIC_DATA_DIR, exist_ok=True)
NOW_PATH = os.path.join(OP25_PUBLIC_DATA_DIR, "now.json")
HIST_PATH = os.path.join(OP25_PUBLIC_DATA_DIR, "history.json")

def _atomic_write(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)

def export_now_public(*args, **kwargs):
    # Disabled: no-op
    pass
# --- end helpers ---


my_input_q = None
my_output_q = None
my_recv_q = None
my_port = None

_last_export_key = None

# instrumentation
_live_updates = 0
_last_msg_type = ""
_last_now = {}
_last_seen_ts = 0.0

"""
fake http and ajax server module
TODO: make less fake - working on it.
"""

# Optional: restrict which extensions you want to serve
ALLOWED_EXTS = {
    'html', 'css', 'js', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'svg', 'webp',
    'txt', 'json', 'map', 'woff', 'woff2', 'ttf', 'eot'
}

def static_file(environ, start_response):
    """
    Improved static file serving function.
    Better error handling and logging.
    More secure file access controls.
    Returns: (status, content_type, output_bytes)
    """

    # Resolve the base directory safely (adjust to your layout)
    base_dir = os.path.realpath(
        os.path.join(os.path.dirname(__file__), '..', 'www', 'www-static')
    )

    # 1) Parse and normalize the requested path
    req_path = unquote(environ.get('PATH_INFO', '/')) or '/'
    if req_path.endswith('/'):
        # Serve index.html for directory requests
        req_path = req_path + 'index.html'
    # Remove any leading slash to make it a relative path
    rel_path = req_path.lstrip('/')

    # 2) Build an absolute path and ensure it stays inside base_dir (no traversal)
    abs_path = os.path.realpath(os.path.join(base_dir, rel_path))
    if not abs_path.startswith(base_dir + os.sep) and abs_path != base_dir:
        # Attempted escape
        sys.stderr.write(f'403 {abs_path}\n')
        return ('403 FORBIDDEN', 'text/plain', b'Forbidden')

    # 3) If the path is a directory, try index.html within it (extra safety)
    if os.path.isdir(abs_path):
        abs_path = os.path.join(abs_path, 'index.html')

    # 4) Check existence & readability
    if not (os.path.exists(abs_path) and os.path.isfile(abs_path) and os.access(abs_path, os.R_OK)):
        sys.stderr.write(f'404 {abs_path}\n')
        return ('404 NOT FOUND', 'text/plain', b'Not found')

    # 5) Enforce allowed extensions (optional but safer)
    _, ext = os.path.splitext(abs_path)
    ext = ext.lower().lstrip('.')
    if ALLOWED_EXTS and ext not in ALLOWED_EXTS:
        sys.stderr.write(f'415 {abs_path}\n')
        return ('415 UNSUPPORTED MEDIA TYPE', 'text/plain', b'Unsupported file type')

    # 6) Guess content type; default to octet-stream if unknown
    content_type = mimetypes.guess_type(abs_path)[0] or 'application/octet-stream'

    # 7) Read and return bytes (simple; can be switched to streaming if needed)
    try:
        with open(abs_path, 'rb') as f:
            data = f.read()
    except Exception as e:
        sys.stderr.write(f'500 {abs_path} ({e})\n')
        return ('500 INTERNAL SERVER ERROR', 'text/plain', b'Internal server error')

    return ('200 OK', content_type, data)

# Tunables
RESP_WAIT_S = 0.5          # total time to wait for replies
RESP_POLL_S = 0.01         # polling interval
MAX_COMMANDS = 100         # guard against huge payloads
ALLOWED_COMMANDS = None    # e.g., {'set_freq', 'set_gain'} (None = allow all)

def _to_int(v: Any, name: str, lo: int = -2**31, hi: int = 2**31 - 1) -> int:
    try:
        iv = int(v)
    except Exception:
        raise ValueError(f"'{name}' must be an integer")
    if not (lo <= iv <= hi):
        raise ValueError(f"'{name}' out of range")
    return iv

def post_req(environ, start_response, postdata):
    """
    Safer POST bridge: parse JSON commands, send to GNU Radio, collect replies.

    Returns (status: str, content_type: str, output: bytes)
    """
    global my_input_q, my_output_q, my_recv_q, my_port

    # ---------- Parse & validate input ----------
    try:
        data = json.loads(postdata)
        if not isinstance(data, list):
            raise ValueError("Top-level JSON must be a list of command objects")
        if len(data) > MAX_COMMANDS:
            raise ValueError(f"Too many commands; max {MAX_COMMANDS}")

        prepared: List[Dict[str, Any]] = []
        for i, d in enumerate(data):
            if not isinstance(d, dict):
                raise ValueError(f"Item {i} must be an object")

            # Required fields
            if 'command' not in d:
                raise ValueError(f"Item {i} missing 'command'")
            cmd = str(d['command'])

            if ALLOWED_COMMANDS is not None and cmd not in ALLOWED_COMMANDS:
                raise ValueError(f"Command '{cmd}' is not allowed")

            # Optional args default to 0; coerce to int and bound if needed
            a1 = _to_int(d.get('arg1', 0), 'arg1')
            a2 = _to_int(d.get('arg2', 0), 'arg2')

            prepared.append({'command': cmd, 'arg1': a1, 'arg2': a2})

        valid_req = True
    except json.JSONDecodeError as e:
        sys.stderr.write(f'post_req: JSON decode error: {e}\n')
        return ('400 BAD REQUEST', 'application/json', json.dumps({"error": "invalid JSON"}).encode('utf-8'))
    except ValueError as e:
        sys.stderr.write(f'post_req: validation error: {e}\n')
        return ('400 BAD REQUEST', 'application/json', json.dumps({"error": str(e)}).encode('utf-8'))
    except Exception:
        sys.stderr.write('post_req: unexpected error parsing input:\n' + traceback.format_exc())
        return ('500 INTERNAL SERVER ERROR', 'application/json', json.dumps({"error": "server error"}).encode('utf-8'))

    # ---------- Enqueue commands with basic backpressure handling ----------
    dropped = 0
    try:
        for d in prepared:
            msg = gr.message().make_from_string(d['command'], -2, d['arg1'], d['arg2'])
            if not my_output_q.full_p():
                my_output_q.insert_tail(msg)
            else:
                dropped += 1
    except Exception:
        sys.stderr.write('post_req: error enqueuing to my_output_q\n' + traceback.format_exc())
        return ('500 INTERNAL SERVER ERROR', 'application/json', json.dumps({"error": "enqueue failed"}).encode('utf-8'))

    # ---------- Collect replies for up to RESP_WAIT_S ----------
    resp_msg: List[Any] = []
    deadline = time.monotonic() + RESP_WAIT_S
    try:
        while True:
            # Drain all currently available replies
            any_got = False
            while not my_recv_q.empty_p():
                any_got = True
                msg = my_recv_q.delete_head()
                if msg.type() == -4:
                    try:
                        resp_msg.append(json.loads(msg.to_string()))
                    except Exception:
                        # If downstream sent non-JSON, return raw string
                        resp_msg.append({"raw": msg.to_string()})
            if any_got:
                # If we got something, loop once more quickly for any bursty follow-ups
                if time.monotonic() >= deadline:
                    break
                time.sleep(RESP_POLL_S)
            else:
                # Nothing available; wait briefly or exit on timeout
                if time.monotonic() >= deadline:
                    break
                time.sleep(RESP_POLL_S)
    except Exception:
        sys.stderr.write('post_req: error reading my_recv_q\n' + traceback.format_exc())
        return ('500 INTERNAL SERVER ERROR', 'application/json', json.dumps({"error": "dequeue failed"}).encode('utf-8'))

    # Include a small meta if anything was dropped
    if dropped:
        resp_msg.append({"warning": f"dropped {dropped} command(s): output queue full"})

    # ---------- Return ----------
    status = '200 OK'
    content_type = 'application/json'
    output = json.dumps(resp_msg).encode('utf-8')
    return status, content_type, output

def http_request(environ, start_response):
    # Normalize once
    path   = environ.get('PATH_INFO') or '/'
    method = (environ.get('REQUEST_METHOD') or 'GET').upper()

    # ---- Tiny JSON API endpoints (must be before static/POST paths) ----

    # /ro-ping
    if method == 'GET' and path == '/ro-ping':
        out = b'{"ok":true,"pong":"op25-http v1"}'
        start_response('200 OK', [
            ('Content-Type','application/json'),
            ('Content-Length', str(len(out))),
            ('Cache-Control','no-store')
        ])
        return [out]

    # /ro-now
    if method == 'GET' and path == '/ro-now':
        idle = (time.time() - _live_now["ts"]) > _LIVE_IDLE_SEC
        out = json.dumps({"ok": True, "idle": idle, "now": _live_now}).encode('utf-8')
        start_response('200 OK', [
            ('Content-Type','application/json'),
            ('Content-Length', str(len(out))),
            ('Cache-Control','no-store')
        ])
        return [out]

    # /ro-stats (richer)
    if method == 'GET' and path == '/ro-stats':
        age = round(time.time() - _last_seen_ts, 2) if _last_seen_ts else None
        body = {
            "msg_counts": _type_counts,
            "last_msg_type": _last_msg_type,
            "last_seen_age_s": age,
            "json_ok": _last_json_ok,
            "json_fail": _last_json_fail,
            "ring_size": len(_raw_ring),
            "updates": _live_updates,
            "last_now": _last_now
        }
        out = json.dumps(body).encode('utf-8')
        start_response('200 OK', [
            ('Content-Type','application/json'),
            ('Content-Length', str(len(out))),
            ('Cache-Control','no-store')
        ])
        return [out]

    # /ro-dump (always returns an array, even if empty)
    if method == 'GET' and path == '/ro-dump':
        out = json.dumps(list(_raw_ring), ensure_ascii=False).encode('utf-8')
        start_response('200 OK', [
            ('Content-Type','application/json'),
            ('Content-Length', str(len(out))),
            ('Cache-Control','no-store')
        ])
        return [out]

    # ---- Legacy/static handling ----
    if method == 'GET' or method == 'HEAD':
        status, content_type, output = static_file(environ, start_response)
    elif method == 'POST':
        postdata = environ['wsgi.input'].read()
        status, content_type, output = post_req(environ, start_response, postdata)
    else:
        status, content_type, output = '405 METHOD NOT ALLOWED', 'text/plain', b'Method not allowed'
        sys.stderr.write('http_request: unexpected method %s on %s\n' % (method, path))

    # ---- Send response ----
    headers = [('Content-Type', content_type),
               ('Content-Length', str(len(output)))]
    start_response(status, headers)

    if isinstance(output, str):
        output = output.encode('utf-8')

    return [output]

def application(environ, start_response):
    failed = False
    try:
        result = http_request(environ, start_response)
    except:
        failed = True
        sys.stderr.write('application: request failed:\n%s\n' % traceback.format_exc())
        sys.exit(1)
    return result

def process_qmsg(msg):
    global _live_updates, _last_msg_type, _last_now, _last_seen_ts
    global _last_json_ok, _last_json_fail

    # ---- keep original forwarding behavior ----
    if my_recv_q.full_p():
        my_recv_q.delete_head_nowait()
    if my_recv_q.full_p():
        return
    my_recv_q.insert_tail(msg)

    # ---- instrumentation common to all messages ----
    try:
        t = msg.type()
    except Exception:
        t = None
    _type_counts[t] = _type_counts.get(t, 0) + 1
    _last_msg_type = t
    _last_seen_ts = time.time()

    # ---- get raw payload (bytes or str) and normalize to UTF-8 text ----
    try:
        raw = msg.to_string() if hasattr(msg, "to_string") else None
    except Exception:
        raw = None

    if isinstance(raw, (bytes, bytearray)):
        try:
            raw_text = raw.decode('utf-8', errors='replace')
        except Exception:
            raw_text = str(raw)
    else:
        raw_text = raw if isinstance(raw, str) else None

    # add to ring buffer (truncated)
    rshow = (raw_text[:500] + "...") if isinstance(raw_text, str) and len(raw_text) > 500 else (raw_text or "<no-string>")
    _raw_ring.append(rshow)

    if not raw_text:
        return

    # ---- parse strategy: whole → lines → {...} extraction ----
    records = []

    def _maybe_add(obj):
        if isinstance(obj, dict):
            records.append(obj)
        elif isinstance(obj, list):
            for it in obj:
                if isinstance(it, dict):
                    records.append(it)

    # 1) whole
    try:
        obj = json.loads(raw_text)
        _last_json_ok += 1
        _maybe_add(obj)
    except Exception:
        _last_json_fail += 1
        # 2) per line
        for ln in raw_text.splitlines():
            ln = ln.strip()
            if not ln:
                continue
            try:
                o = json.loads(ln)
                _last_json_ok += 1
                _maybe_add(o)
            except Exception:
                _last_json_fail += 1
                # 3) first {...} blob
                import re as _re
                m = _re.search(r'\{.*\}', ln)
                if m:
                    try:
                        o2 = json.loads(m.group(0))
                        _last_json_ok += 1
                        _maybe_add(o2)
                    except Exception:
                        _last_json_fail += 1

    if not records:
        return

    # ---- helper: flatten common nesting keys ----
    def _flatten(d):
        for k in ("event", "data", "payload", "message"):
            v = d.get(k)
            if isinstance(v, dict):
                out = dict(d); out.update(v); return out
        return d

    # === FAST PATH: prefer clean call_log entries ===
    for rec in records:
        try:
            if not isinstance(rec, dict):
                continue
            jt = (rec.get("json_type") or rec.get("type") or "").lower()
            if jt != "call_log":
                continue
            log = rec.get("log") or []
            if not isinstance(log, list) or not log:
                continue

            e = log[-1]  # most recent call
            tgid   = e.get("tgid")
            name   = e.get("tgtag") or e.get("alpha") or e.get("name")
            freq   = e.get("freq")        # Hz or MHz
            rid    = e.get("rid") or e.get("src") or e.get("source") or e.get("srcaddr")
            enc    = e.get("encrypted") or e.get("enc") or e.get("encr")

            # freq sanity (convert to MHz if >100k)
            mhz = 0.0
            try:
                mhz = float(freq)
                if mhz > 1e5: mhz /= 1e6
            except Exception:
                pass

            have = {
                "tgid":  str(tgid or "").strip() != "",
                "freq":  30.0 <= mhz <= 1300.0,
                "src":   str(rid  or "").strip() != "",
                "name":  str(name or "").strip() != ""
            }
            if not (have["tgid"] or have["freq"] or have["src"] or have["name"]):
                continue

            enc_str = ("Y" if str(enc).strip().upper() in ("1","Y","TRUE")
                       else ("N" if str(enc).strip().upper() in ("0","N","FALSE") else ""))

            _live_now.update({
                "ts": time.time(),
                "tgid": str(tgid or ""),
                "name": str(name or ""),
                "freq": f"{mhz:.6f}" if have["freq"] else "",
                "source": str(rid or ""),
                "enc": enc_str
            })
            _live_updates += 1
            _last_now = dict(_live_now)
            _last_msg_type = "call_log"
            _last_seen_ts = _live_now["ts"]
            return  # handled
        except Exception:
            # keep going; fall back to generic handling
            pass

    # === FALLBACK: any record with enough call-like fields ===
    for rec in records:
        p = _flatten(rec)

        tgid   = p.get("tgid") or p.get("talkgroup") or p.get("tg_id")
        name   = p.get("tag")  or p.get("alpha") or p.get("name") or p.get("tg_tag")
        freq   = p.get("freq") or p.get("frequency")
        source = p.get("srcaddr") or p.get("src") or p.get("source") or p.get("unit")
        enc    = p.get("encrypted") or p.get("enc") or p.get("encr")

        try:
            mhz = float(freq)
            if mhz > 1e5: mhz /= 1e6
        except Exception:
            mhz = 0.0

        have_tgid = str(tgid or "").strip() != ""
        have_freq = 30.0 <= mhz <= 1300.0
        have_src  = str(source or "").strip() != ""
        have_name = str(name or "").strip() != ""
        if not (have_tgid or have_freq or have_src or have_name):
            continue

        enc_str = ("Y" if str(enc).strip().upper() in ("1","Y","TRUE")
                   else ("N" if str(enc).strip().upper() in ("0","N","FALSE") else ""))

        _live_now.update({
            "ts": time.time(),
            "tgid": str(tgid or ""),
            "name": str(name or ""),
            "freq": f"{mhz:.6f}" if have_freq else "",
            "source": str(source or ""),
            "enc": enc_str
        })
        _live_updates += 1
        _last_now = dict(_live_now)
        _last_msg_type = (p.get("json_type") or p.get("type") or "generic").lower()
        _last_seen_ts = _live_now["ts"]
        break

class http_server(object):
    def __init__(self, input_q, output_q, endpoint, **kwds):
        global my_input_q, my_output_q, my_recv_q, my_port
        host, port = endpoint.split(':')
        if my_port is not None:
            raise AssertionError('this server is already active on port %s' % my_port)
        my_input_q = input_q
        my_output_q = output_q
        my_port = int(port)

        my_recv_q = gr.msg_queue(10)
        self.q_watcher = queue_watcher(my_input_q, process_qmsg)

        try:
            self.server = create_server(application, host=host, port=my_port, threads=6)
        except:
            sys.stderr.write('Failed to create http terminal server\n%s\n' % traceback.format_exc())
            sys.exit(1)

    def run(self):
        self.server.run()

class queue_watcher(threading.Thread):
    def __init__(self, msgq,  callback, **kwds):
        threading.Thread.__init__ (self, **kwds)
        self.setDaemon(1)
        self.msgq = msgq
        self.callback = callback
        self.keep_running = True
        self.start()

    def run(self):
        while(self.keep_running):
            if not self.msgq.empty_p(): # check queue before trying to read a message to avoid deadlock at startup
                msg = self.msgq.delete_head()
                if msg is not None:
                    self.callback(msg)
                else:
                    self.keep_running = False
            else: # empty queue
                time.sleep(0.01)
