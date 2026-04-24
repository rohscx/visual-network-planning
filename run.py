"""Entrypoint: `python run.py` — serves the app on http://localhost:5000."""

from __future__ import annotations

import os
import threading
import webbrowser

from app import create_app

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "5000"))
OPEN_BROWSER = os.environ.get("NO_BROWSER") != "1"


def _open_browser_later(url: str) -> None:
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()


def main() -> None:
    app = create_app()
    url = f"http://{HOST}:{PORT}"
    if OPEN_BROWSER and not os.environ.get("WERKZEUG_RUN_MAIN"):
        _open_browser_later(url)
    app.run(host=HOST, port=PORT, debug=True)


if __name__ == "__main__":
    main()
