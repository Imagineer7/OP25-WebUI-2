#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Modernized lightweight HTTP server for OP25 control + static assets.

- No module-level globals; everything is encapsulated in OP25WebServer.
- Safer, simpler static file handling with Pathlib and traversal guards.
- Clear routing: GET (static) and POST /api/commands (JSON).
- Structured logging; tracebacks only when needed.
- Type hints and docstrings for maintainability.
- Graceful handling of queue backpressure and malformed JSON.
- Optional CORS (disabled by default, flip a flag if you need it).

Retains the original behavior:
- POST a JSON array of {command, arg1, arg2} → sends to output queue.
- Collects any -4 type responses from the input queue and returns JSON.
- Serves index.html at "/" and other assets from configured directories.

Copyright © 2017–2025
License: GPLv3 (same as OP25)
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import sys
import threading
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, List, Tuple, Optional, Dict, Any

from gnuradio import gr
from waitress import serve as waitress_serve  # waitress.server.create_server is fine too

# OP25 repeater import kept for compatibility even if not used directly here.
import gnuradio.op25_repeater as op25_repeater  # noqa: F401


# ---------- Utilities ----------

def _bytes(s: Any) -> bytes:
    """Coerce str/bytes/JSON-able into bytes for WSGI."""
    if isinstance(s, bytes):
        return s
    if isinstance(s, (dict, list)):
        return json.dumps(s, separators=(",", ":")).encode("utf-8")
    if isinstance(s, str):
        return s.encode("utf-8")
    return str(s).encode("utf-8")


def _now_ms() -> int:
    return int(time.time() * 1000)


# ---------- Queue Watcher ----------

class QueueWatcher(threading.Thread):
    """
    Background thread that watches a GNU Radio msg_queue and invokes a callback
    for each message received. Safe to stop via keep_running flag.
    """
    def __init__(self, msgq: gr.msg_queue, callback: Callable[[gr.message], None], *, name: str = "queue-watcher"):
        super().__init__(name=name, daemon=True)
        self.msgq = msgq
        self.callback = callback
        self.keep_running = True

    def run(self) -> None:
        # Avoid startup deadlock by polling before blocking
        while self.keep_running:
            try:
                if not self.msgq.empty_p():
                    msg = self.msgq.delete_head()
                    if msg is None:
                        self.keep_running = False
                        break
                    self.callback(msg)
                else:
                    time.sleep(0.01)
            except Exception:
                logging.exception("QueueWatcher encountered an error")
                time.sleep(0.05)


# ---------- Core Server ----------

@dataclass
class StaticRoots:
    """Locations for static assets."""
    web_root: Path = Path("../www/www-static").resolve()
    image_root: Path = Path("../www/images").resolve()


class OP25WebServer:
    """
    Minimal WSGI app with static file serving + a JSON command endpoint that
    pushes commands to OP25 and returns queued responses.
    """

    # limit how many messages we buffer for UI responses
    RECV_DEPTH: int = 10

    # Allowed filename pattern (mirrors original)
    SAFE_NAME = re.compile(r"^[a-zA-Z0-9_.\-]+$")

    def __init__(
        self,
        input_q: gr.msg_queue,
        output_q: gr.msg_queue,
        endpoint: str,
        *,
        static_roots: Optional[StaticRoots] = None,
        enable_cors: bool = False,
        threads: int = 6,
    ) -> None:
        """
        :param input_q: messages coming *from* the radio/OP25 (we will read)
        :param output_q: messages going *to* OP25 (we will write)
        :param endpoint: "host:port"
        :param static_roots: where to serve static/images
        :param enable_cors: set True if you need cross-origin access (e.g., separate UI host)
        :param threads: waitress threads (if using waitress_serve)
        """
        self.input_q = input_q
        self.output_q = output_q
        self.enable_cors = enable_cors
        self.threads = threads

        host, port_str = endpoint.split(":")
        self.host = host
        self.port = int(port_str)

        self.static = static_roots or StaticRoots()
        self.recv_q: gr.msg_queue = gr.msg_queue(self.RECV_DEPTH)

        # start watching input queue and copy messages into our recv buffer
        self.q_watcher = QueueWatcher(self.input_q, self._on_input_msg, name="op25-input-watcher")
        self.q_watcher.start()

        # Prepare a single WSGI app callable bound to this instance
        self.wsgi_app = self._make_wsgi_app()

        # Set up logging
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        )
        logging.info("OP25WebServer initialized on %s:%d", self.host, self.port)
        logging.info("Static web root:  %s", self.static.web_root)
        logging.info("Static image dir: %s", self.static.image_root)

        # make sure common types are known
        mimetypes.init()

    # --------- Message Handling ---------

    def _on_input_msg(self, msg: gr.message) -> None:
        """Copy messages into recv_q with backpressure handling."""
        try:
            if self.recv_q.full_p():
                # drop oldest to make room
                self.recv_q.delete_head_nowait()
            if not self.recv_q.full_p():
                self.recv_q.insert_tail(msg)
        except Exception:
            logging.exception("Failed to buffer incoming message")

    def _dequeue_replies(self) -> List[Dict[str, Any]]:
        """Drain -4 (JSON) messages and return as list."""
        replies: List[Dict[str, Any]] = []
        try:
            while not self.recv_q.empty_p():
                msg: gr.message = self.recv_q.delete_head()
                if msg and msg.type() == -4:
                    try:
                        payload = msg.to_string()
                        # Ensure bytes→str for json
                        if isinstance(payload, bytes):
                            payload = payload.decode("utf-8", errors="replace")
                        replies.append(json.loads(payload))
                    except Exception:
                        logging.exception("Malformed JSON in -4 message")
                # Ignore other message types silently (compat with original)
        except Exception:
            logging.exception("Error while draining replies")
        return replies

    # --------- Static Files ---------

    def _safe_join(self, base: Path, name: str) -> Optional[Path]:
        """
        Join and resolve within base. Returns None if unsafe (traversal).
        Only allows SAFE_NAME pattern (keeps behavior from original).
        """
        if name == "":
            return (base / "index.html").resolve()
        if not self.SAFE_NAME.match(name):
            return None
        p = (base / name).resolve()
        try:
            p.relative_to(base)
        except Exception:
            return None
        return p

    def _guess_content_type(self, path: Path) -> str:
        ctype, _ = mimetypes.guess_type(str(path))
        # fallbacks similar to the original
        if not ctype:
            suf = path.suffix.lower().lstrip(".")
            return {
                "css": "text/css",
                "js": "application/javascript",
                "ico": "image/x-icon",
                "html": "text/html",
            }.get(suf, "application/octet-stream")
        return ctype

    def _serve_static(self, path_info: str) -> Tuple[str, List[Tuple[str, str]], bytes]:
        """
        Serve static files.
        - "/" → index.html from web_root
        - Otherwise try web_root first; if extension is image, try image_root.
        """
        name = "index.html" if path_info == "/" else path_info.lstrip("/")
        # Original logic preferred an image directory by extension
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        is_img = ext in {"png", "jpg", "jpeg", "gif", "webp", "svg"}

        roots = [self.static.web_root]
        if is_img:
            roots.insert(0, self.static.image_root)

        for base in roots:
            candidate = self._safe_join(base, name if name else "index.html")
            if candidate and candidate.exists() and candidate.is_file():
                try:
                    body = candidate.read_bytes()
                    headers = [
                        ("Content-Type", self._guess_content_type(candidate)),
                        ("Content-Length", str(len(body))),
                        ("Cache-Control", "public, max-age=300"),
                    ]
                    return "200 OK", headers, body
                except Exception:
                    logging.exception("Error reading static file %s", candidate)
                    break

        # Not found
        msg = f"404 NOT FOUND: {name}"
        logging.warning(msg)
        body = _bytes(msg)
        return "404 NOT FOUND", [
            ("Content-Type", "text/plain; charset=utf-8"),
            ("Content-Length", str(len(body))),
        ], body

    # --------- API ---------

    def _handle_post_commands(self, environ) -> Tuple[str, List[Tuple[str, str]], bytes]:
        """
        Accepts a JSON array of command dicts:
        [{"command": "...", "arg1": int, "arg2": int}, ...]
        Sends each to OP25 via output_q, then returns any queued -4 JSON messages.
        """
        try:
            length = int(environ.get("CONTENT_LENGTH") or "0")
        except ValueError:
            length = 0

        raw = environ["wsgi.input"].read(length) if length > 0 else b""
        try:
            payload = raw.decode("utf-8", errors="replace")
            data = json.loads(payload)
            if not isinstance(data, list):
                raise ValueError("Expected a JSON array")

            sent = 0
            for d in data:
                if not isinstance(d, dict):
                    continue
                cmd = str(d.get("command", ""))
                arg1 = int(d.get("arg1", 0))
                arg2 = int(d.get("arg2", 0))
                # -2 message type preserved from original
                msg = gr.message().make_from_string(cmd, -2, arg1, arg2)
                if not self.output_q.full_p():
                    self.output_q.insert_tail(msg)
                    sent += 1

            # Allow a brief moment for responses to queue up (same spirit as original sleep)
            time.sleep(0.2)
            replies = self._dequeue_replies()

            body = _bytes(replies)
            headers = [
                ("Content-Type", "application/json; charset=utf-8"),
                ("Content-Length", str(len(body))),
            ]
            return "200 OK", headers, body
        except json.JSONDecodeError:
            logging.warning("Bad JSON in POST body")
            body = _bytes({"error": "invalid_json"})
            return "400 BAD REQUEST", [("Content-Type", "application/json"), ("Content-Length", str(len(body)))], body
        except Exception:
            logging.exception("POST /api/commands failed")
            body = _bytes({"error": "internal_error"})
            return "500 INTERNAL SERVER ERROR", [("Content-Type", "application/json"), ("Content-Length", str(len(body)))], body

    # --------- WSGI App ---------

    def _make_wsgi_app(self) -> Callable:
        """
        Returns a WSGI application bound to this instance.
        Routes:
          GET  /*                 → static files (index at "/")
          POST /api/commands      → JSON commands to OP25
          OPTIONS /api/commands   → CORS preflight (if enabled)
        """
        def app(environ, start_response):
            try:
                method = environ.get("REQUEST_METHOD", "GET").upper()
                path = environ.get("PATH_INFO", "/")

                # CORS preflight (optional)
                cors_headers: List[Tuple[str, str]] = []
                if self.enable_cors:
                    cors_headers = [
                        ("Access-Control-Allow-Origin", "*"),
                        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
                        ("Access-Control-Allow-Headers", "Content-Type"),
                    ]
                    if method == "OPTIONS" and path == "/api/commands":
                        start_response("204 No Content", cors_headers)
                        return [b""]

                if method == "POST" and path == "/api/commands":
                    status, headers, body = self._handle_post_commands(environ)
                    start_response(status, headers + cors_headers)
                    return [body]

                if method == "GET":
                    status, headers, body = self._serve_static(path)
                    start_response(status, headers + cors_headers)
                    return [body]

                # Fallback
                body = _bytes("405 METHOD NOT ALLOWED")
                start_response("405 METHOD NOT ALLOWED",
                               [("Content-Type", "text/plain; charset=utf-8"),
                                ("Content-Length", str(len(body)))] + cors_headers)
                return [body]
            except Exception:
                logging.error("WSGI application error:\n%s", traceback.format_exc())
                body = _bytes("500 INTERNAL SERVER ERROR")
                start_response("500 INTERNAL SERVER ERROR",
                               [("Content-Type", "text/plain; charset=utf-8"),
                                ("Content-Length", str(len(body)))])
                return [body]

        return app

    # --------- Run ---------

    def run(self) -> None:
        """
        Start waitress in the foreground (systemd or supervisord should daemonize if needed).
        """
        logging.info("Starting OP25WebServer on %s:%d", self.host, self.port)
        # waitress.serve accepts a WSGI callable directly
        waitress_serve(self.wsgi_app, host=self.host, port=self.port, threads=self.threads)


# ---------- Example wiring ----------
# Keep your existing hookup logic; this is a minimal example.

def main():
    """
    Example entry point. The surrounding OP25 app typically constructs the
    GNU Radio queues and instantiates this server with them.
    """
    # These queues should be created/owned by the OP25 app; placeholders here:
    input_q = gr.msg_queue(50)   # Messages FROM OP25 (we read)
    output_q = gr.msg_queue(50)  # Messages TO OP25 (we write)

    server = OP25WebServer(
        input_q=input_q,
        output_q=output_q,
        endpoint="0.0.0.0:8080",
        static_roots=StaticRoots(
            web_root=Path("../www/www-static").resolve(),
            image_root=Path("../www/images").resolve(),
        ),
        enable_cors=False,  # flip to True if you front this from a different host
        threads=8,
    )
    server.run()


if __name__ == "__main__":
    main()
