#!/usr/bin/env bash
# Build vnp-deps.tar.gz — an offline-installable bundle of every Python
# dependency vnp needs (Flask, Werkzeug, Jinja2, MarkupSafe, click,
# blinker, itsdangerous, pytest …). Re-run after editing requirements.txt.
#
# Output is a *combined* wheelhouse that works on both macOS arm64 and
# Linux x86_64, across a few common Python versions. pip on each target
# host will pick the matching wheel and ignore the rest. The other
# dependencies are pure-Python and platform-agnostic, so they appear
# only once in the bundle.
#
# Usage:
#   ./scripts/build-wheelhouse.sh                 # default ./vnp-deps.tar.gz
#   ./scripts/build-wheelhouse.sh /tmp/foo.tar.gz # custom output
#
# To extend to other platforms (e.g. ARM Linux servers, Windows), add to
# PLATFORMS below.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-${ROOT}/vnp-deps.tar.gz}"
WHEELHOUSE="${ROOT}/wheelhouse"

# Python versions and platforms to fetch wheels for. Pure-Python deps
# (Flask, Werkzeug, Jinja2, click, …) are independent of these — they
# get downloaded once during the first pass and reused. Only MarkupSafe
# has compiled wheels and therefore costs ~one wheel per (platform,
# Python-version) cell.
PLATFORMS=(
  "macosx_11_0_arm64"
  "manylinux2014_x86_64"
)
PYVERS=(3.10 3.11 3.12 3.13 3.14)

# Prefer the project's venv pip so the script honours whatever Python
# the user actually develops with; fall back to system pip if no venv
# has been created yet.
if [ -x "${ROOT}/.venv/bin/pip" ]; then
  PIP="${ROOT}/.venv/bin/pip"
else
  PIP="$(command -v pip3 || command -v pip || true)"
  if [ -z "${PIP}" ]; then
    echo "✕ no pip on PATH and no .venv at ${ROOT}/.venv" >&2
    exit 1
  fi
fi

echo "→ Resolving dependencies into ${WHEELHOUSE}"
rm -rf "${WHEELHOUSE}"
mkdir -p "${WHEELHOUSE}"

for plat in "${PLATFORMS[@]}"; do
  for pyver in "${PYVERS[@]}"; do
    echo "  · ${plat} · python ${pyver}"
    "${PIP}" download \
      --quiet \
      --dest "${WHEELHOUSE}" \
      --requirement "${ROOT}/requirements.txt" \
      --platform "${plat}" \
      --python-version "${pyver}" \
      --only-binary ":all:"
  done
done

# pip evaluates environment markers against the *build host's* Python,
# not the --python-version target, so deps gated on `python_version <
# "3.11"` are silently skipped. Pull them explicitly for 3.10 on every
# platform. pytest's known marker-gated deps:
#   - tomli >= 1            (replaced by stdlib tomllib in 3.11+)
#   - exceptiongroup >= 1   (built into language in 3.11+)
# pip resolves these to pure-Python "py3-none-any" wheels which work on
# every target; pip on 3.11+ ignores them at install time anyway.
for plat in "${PLATFORMS[@]}"; do
  for pkg in tomli exceptiongroup typing-extensions; do
    echo "  · marker-gated ${pkg} for python 3.10 · ${plat}"
    "${PIP}" download \
      --quiet \
      --dest "${WHEELHOUSE}" \
      --no-deps \
      --platform "${plat}" \
      --python-version 3.10 \
      --only-binary ":all:" \
      "${pkg}"
  done
done

echo "→ Tarring → ${OUTPUT}"
# Build the tarball with Python's stdlib `tarfile` instead of bsdtar.
# bsdtar on macOS encodes xattrs into pax extended headers no matter
# what flag combo we throw at it (--no-mac-metadata, --no-xattrs,
# COPYFILE_DISABLE=1, xattr -cr beforehand — all tested, all leaked
# `LIBARCHIVE.xattr.com.apple.provenance` warnings into GNU tar on
# Linux). Python's tarfile in default USTAR format simply doesn't
# write xattrs, so the archive comes out clean.
python3 - <<PYTAR
import tarfile, os
src = "${WHEELHOUSE}"
dst = "${OUTPUT}"
os.chdir("${ROOT}")
with tarfile.open(dst, "w:gz", format=tarfile.USTAR_FORMAT) as tf:
    tf.add("wheelhouse")
PYTAR

# Tarred — drop the loose wheelhouse so a Ctrl-C during a re-run can't
# blend stale wheels with fresh ones.
rm -rf "${WHEELHOUSE}"

SIZE="$(du -h "${OUTPUT}" | awk '{print $1}')"
COUNT="$(tar -tzf "${OUTPUT}" | grep -c '\.whl$' || true)"
echo "✓ ${OUTPUT}  (${SIZE}, ${COUNT} wheels)"
echo
echo "To install offline on a target host:"
echo "  tar -xzf $(basename "${OUTPUT}")"
echo "  python3 -m venv .venv"
echo "  .venv/bin/pip install --no-index --find-links wheelhouse/ -r requirements.txt"
