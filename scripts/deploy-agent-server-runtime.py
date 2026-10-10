#!/usr/bin/env python3
"""Ship a public runtime to agent-server or install it fresh for the current user."""

import ctypes
import fcntl
import os
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

HOST = "osso@agent-server"
SHARE = Path("/home/osso/.local/share")
INSTALL = SHARE / "pi"
SSH = [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=3",
]
PUBLIC_ENTRIES = {
    "pi",
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "photon_rs_bg.wasm",
    "fs-worker.cjs",
    "theme",
    "assets",
    "export-html",
    "docs",
    "examples",
    "node_modules",
    "native",
}
PRIVATE_ENTRIES = {
    ".pi",
    ".ssh",
    ".aws",
    ".config",
    "auth.json",
    "settings.json",
    "sessions",
    "credentials",
    ".env",
}


def validate_public_runtime(runtime):
    if runtime.is_symlink() or not runtime.is_dir():
        raise RuntimeError(f"public runtime must be a real directory: {runtime}")
    unexpected = {entry.name for entry in runtime.iterdir()} - PUBLIC_ENTRIES
    if unexpected:
        raise RuntimeError(
            f"not a public runtime: unexpected entries {sorted(unexpected)}"
        )
    for entry in runtime.rglob("*"):
        if entry.is_symlink():
            raise RuntimeError(f"public runtime contains symlink: {entry}")
        if entry.name in PRIVATE_ENTRIES or entry.name.startswith(".env."):
            raise RuntimeError(f"not a public runtime: private entry {entry}")
    if not (runtime / "pi").is_file():
        raise RuntimeError(f"public runtime executable missing: {runtime / 'pi'}")


def validate_version(runtime):
    try:
        result = subprocess.run(
            [str(runtime / "pi"), "--version"],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError(
            f"runtime validation failed at {runtime}: {error}"
        ) from error
    version = result.stdout.strip()
    if not version:
        raise RuntimeError(f"runtime validation returned empty version at {runtime}")
    return version


def rename_directories(left, right, flags):
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(left), -100, os.fsencode(right), flags) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(right))


def exchange_directories(left, right):
    # Linux renameat2 exchange keeps the installed path present throughout activation.
    rename_directories(left, right, 2)


def install_local(runtime):
    home = Path.home()
    install = home / ".local/share/pi"
    launcher = home / ".local/bin/pi"
    for target in (install, launcher):
        if target.exists() or target.is_symlink():
            raise RuntimeError(f"fresh installation target already exists: {target}")
    validate_public_runtime(runtime)
    install.parent.mkdir(parents=True, exist_ok=True)
    launcher.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".pi-runtime-", dir=install.parent
    ) as workspace:
        stage = Path(workspace) / "runtime"
        shutil.copytree(runtime, stage, symlinks=True)
        validate_public_runtime(stage)
        expected_version = validate_version(stage)
        # RENAME_NOREPLACE refuses even a target created during staging validation.
        rename_directories(stage, install, 1)
        try:
            if validate_version(install) != expected_version:
                raise RuntimeError(
                    f"activation validation version changed at {install}"
                )
            launcher.symlink_to(install / "pi")
        except BaseException:
            shutil.rmtree(install)
            raise


def activate(stage, install):
    if install.is_symlink() or not install.is_dir():
        raise RuntimeError(f"requires existing real installation: {install}")
    validate_public_runtime(stage)
    expected_version = validate_version(stage)
    exchange_directories(stage, install)
    try:
        if validate_version(install) != expected_version:
            raise RuntimeError(f"activation validation version changed at {install}")
    except BaseException:
        exchange_directories(stage, install)
        raise
    shutil.rmtree(stage)


def run_transport(command, timeout, retry_codes=()):
    for attempt in range(3):
        try:
            result = subprocess.run(
                command, timeout=timeout, capture_output=True, text=True
            )
        except subprocess.TimeoutExpired as error:
            if not retry_codes or attempt == 2:
                raise RuntimeError(f"transport timed out: {command[0]}") from error
        else:
            if result.returncode == 0:
                return
            if result.returncode not in retry_codes or attempt == 2:
                raise RuntimeError(
                    f"{command[0]} failed ({result.returncode}): {result.stderr.strip()}"
                )
        time.sleep(2**attempt + random.uniform(0, 0.25))


def ship(runtime):
    runtime = runtime.resolve(strict=True)
    validate_public_runtime(runtime)
    token = ".pi-runtime-" + uuid.uuid4().hex
    workspace = SHARE / token
    remote_script = workspace / "deploy.py"
    rsync = ["rsync", "-a", "--timeout=60", "-e", " ".join(SSH)]
    try:
        run_transport(SSH + [HOST, f"mkdir -m 700 -p {workspace}/runtime"], 60, (255,))
        run_transport(
            rsync + [str(runtime) + "/", f"{HOST}:{workspace}/runtime/"],
            300,
            (10, 12, 30, 35),
        )
        run_transport(
            rsync + [str(Path(__file__).resolve()), f"{HOST}:{remote_script}"],
            60,
            (10, 12, 30, 35),
        )
        # Activation is not retried: a lost connection may hide a successful exchange.
        run_transport(SSH + [HOST, f"python3 {remote_script} --activate {token}"], 120)
    except RuntimeError as error:
        raise RuntimeError(
            f"{error}; inspect remote staging directory {workspace}"
        ) from error


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--install-local":
        install_local(Path(sys.argv[2]))
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--activate":
        token = sys.argv[2]
        if not re.fullmatch(r"\.pi-runtime-[0-9a-f]{32}", token):
            raise RuntimeError("invalid runtime staging directory")
        workspace = SHARE / token
        if workspace.is_symlink():
            raise RuntimeError("runtime staging directory cannot be a symlink")
        with (SHARE / ".pi-runtime.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise RuntimeError(
                    "another runtime activation is in progress"
                ) from error
            activate(workspace / "runtime", INSTALL)
            shutil.rmtree(workspace)
        return
    if len(sys.argv) != 2:
        raise RuntimeError(
            "usage: deploy-agent-server-runtime.py INSTALLED_RUNTIME "
            "| --install-local PUBLIC_RUNTIME"
        )
    ship(Path(sys.argv[1]))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError) as error:
        print(f"agent-server runtime deployment failed: {error}", file=sys.stderr)
        sys.exit(1)
