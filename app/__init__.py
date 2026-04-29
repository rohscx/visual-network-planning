from __future__ import annotations

import os
import secrets
from pathlib import Path

from flask import Flask


def create_app(plans_dir: Path | str | None = None) -> Flask:
    app = Flask(__name__)
    # Only used to sign Flask flash cookies for a single local user. An
    # explicit env var wins; otherwise we generate a fresh random key per
    # process (flashes don't persist across restarts, which is fine).
    app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
    # Cap CSV uploads at 16 MB. Real Infoblox exports are KB–MB scale.
    app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024

    if plans_dir is None:
        plans_dir = Path(__file__).resolve().parent.parent / "plans"
    app.config["PLANS_DIR"] = Path(plans_dir)
    app.config["PLANS_DIR"].mkdir(parents=True, exist_ok=True)

    from . import routes
    app.register_blueprint(routes.bp)
    return app
