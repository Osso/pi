#!/usr/bin/env python3
"""Focused filesystem tests; never connects to agent-server."""

import importlib.util
import pathlib
import os
import tempfile
from unittest.mock import patch
import unittest

SCRIPT = pathlib.Path(__file__).with_name("deploy-agent-server-runtime.py")


class RuntimeDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = pathlib.Path(self.temp.name)
        self.install = self.home / ".local/share/pi"
        self.stage = self.home / ".local/share/.test-input/runtime"
        self.install.mkdir(parents=True)
        self.stage.mkdir(parents=True)
        (self.install / "old-only").write_text("old runtime")
        self.preserved = {}
        for name in (
            ".local/bin/pi",
            ".pi/agent/auth.json",
            ".pi/agent/settings.json",
            ".pi/agent/sessions/session.jsonl",
            ".config/systemd/user/pi.service",
            ".local/bin/pi-dev",
        ):
            path = self.home / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name)
            self.preserved[path] = (path.read_bytes(), path.stat().st_ino)
        self.assertTrue(SCRIPT.exists(), "runtime shipping helper is missing")
        spec = importlib.util.spec_from_file_location("runtime_deploy", SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def executable(self, body):
        path = self.stage / "pi"
        path.write_text("#!/usr/bin/env python3\n" + body)
        path.chmod(0o755)

    def assert_preserved(self):
        for path, expected in self.preserved.items():
            self.assertEqual((path.read_bytes(), path.stat().st_ino), expected)

    def test_swap_ships_exact_runtime_and_preserves_other_paths(self):
        self.executable("print('1.2.3')\n")
        (self.stage / "theme").mkdir()
        (self.stage / "theme/dark.json").write_text('{"name":"dark"}')
        new_inode = self.stage.stat().st_ino
        self.module.activate(self.stage, self.install)
        self.assertEqual(self.install.stat().st_ino, new_inode)
        self.assertEqual(
            (self.install / "theme/dark.json").read_text(), '{"name":"dark"}'
        )
        self.assertFalse((self.install / "old-only").exists())
        self.assertFalse(self.stage.exists())
        self.assert_preserved()

    def test_failed_staging_validation_never_replaces_installation(self):
        self.executable("raise SystemExit(7)\n")
        old_inode = self.install.stat().st_ino
        with self.assertRaisesRegex(RuntimeError, "validation"):
            self.module.activate(self.stage, self.install)
        self.assertEqual(self.install.stat().st_ino, old_inode)
        self.assertEqual((self.install / "old-only").read_text(), "old runtime")
        self.assert_preserved()

    def test_failed_activation_validation_rolls_back_atomic_exchange(self):
        trace = self.home / "validation-locations.log"
        self.executable(
            "import pathlib\n"
            "location = pathlib.Path(__file__).parent.name\n"
            f"with pathlib.Path({str(trace)!r}).open('a') as log:\n"
            "    log.write(location + '\\n')\n"
            "if location == 'pi':\n"
            "    raise SystemExit(9)\n"
            "print('1.2.3')\n"
        )
        old_inode = self.install.stat().st_ino
        with self.assertRaisesRegex(RuntimeError, "validation"):
            self.module.activate(self.stage, self.install)
        self.assertEqual(trace.read_text().splitlines(), ["runtime", "pi"])
        self.assertEqual(self.install.stat().st_ino, old_inode)
        self.assertEqual((self.install / "old-only").read_text(), "old runtime")
        self.assert_preserved()

    def test_validation_requires_nonempty_version(self):
        self.executable("pass\n")
        with self.assertRaisesRegex(RuntimeError, "validation"):
            self.module.activate(self.stage, self.install)
        self.assertTrue((self.install / "old-only").exists())

    def test_rejects_credentials_and_outside_symlinks_before_activation(self):
        self.executable("print('1.2.3')\n")
        for name in ("auth.json", ".ssh", "sessions", "settings.json"):
            with self.subTest(name=name):
                secret = self.stage / name
                secret.write_text("private")
                with self.assertRaisesRegex(RuntimeError, "public runtime"):
                    self.module.activate(self.stage, self.install)
                secret.unlink()
        link = self.stage / "README.md"
        link.symlink_to(self.home / ".pi/agent/auth.json")
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            self.module.activate(self.stage, self.install)
        self.assertTrue((self.install / "old-only").exists())

    def transport_tools(self):
        tools = self.home / "tools"
        tools.mkdir()
        log = self.home / "transport.log"
        common = """import os,pathlib,sys
home = pathlib.Path(os.environ['TEST_REMOTE_HOME'])
with open(home/'transport.log', 'a') as log:
    log.write(pathlib.Path(sys.argv[0]).name+'\\n')
def remote(path):
    return pathlib.Path(path.replace('/home/osso', str(home), 1))
"""
        ssh_body = """import importlib.util
assert sys.argv[-2] == 'osso@agent-server'
command = sys.argv[-1].split()
if command[0] == 'mkdir':
    remote(command[-1]).mkdir(parents=True, exist_ok=True)
else:
    assert command[0] == 'python3'
    path = remote(command[1])
    spec = importlib.util.spec_from_file_location('remote_deploy', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.SHARE = home/'.local/share'
    module.INSTALL = module.SHARE/'pi'
    sys.argv = [str(path), *command[2:]]
    module.main()
"""
        rsync_body = """import shutil
assert '--delete' not in sys.argv
assert sys.argv[-1].startswith('osso@agent-server:/home/osso/.local/share/.pi-runtime-')
if os.environ.get('TEST_TRANSFER_FAIL'):
    raise SystemExit(30)
source = pathlib.Path(sys.argv[-2])
destination = remote(sys.argv[-1].split(':', 1)[1])
if source.is_dir():
    shutil.copytree(source, destination, dirs_exist_ok=True)
else:
    shutil.copy2(source, destination)
"""
        for name, body in (("ssh", ssh_body), ("rsync", rsync_body)):
            program = tools / name
            program.write_text("#!/usr/bin/env python3\n" + common + body)
            program.chmod(0o755)
        return {
            "PATH": str(tools) + os.pathsep + os.environ["PATH"],
            "TEST_REMOTE_HOME": str(self.home),
        }, log

    def test_shipping_runs_staged_remote_script_and_preserves_wrapper(self):
        self.executable("print('1.2.3')\n")
        (self.stage / "README.md").write_text("public runtime")
        env, log = self.transport_tools()
        with patch.dict(os.environ, env):
            self.module.ship(self.stage)
        self.assertEqual((self.install / "README.md").read_text(), "public runtime")
        self.assertFalse((self.install / "old-only").exists())
        self.assertEqual(log.read_text().splitlines(), ["ssh", "rsync", "rsync", "ssh"])
        self.assertFalse(list(self.install.parent.glob(".pi-runtime-*")))
        self.assert_preserved()

    def test_remote_validation_failure_is_not_retried_and_preserves_install(self):
        self.executable("raise SystemExit(7)\n")
        env, log = self.transport_tools()
        with patch.dict(os.environ, env):
            with self.assertRaisesRegex(RuntimeError, "validation failed"):
                self.module.ship(self.stage)
        self.assertEqual(log.read_text().splitlines(), ["ssh", "rsync", "rsync", "ssh"])
        self.assertTrue((self.install / "old-only").exists())
        self.assert_preserved()

    def test_failed_transfer_has_bounded_retries_and_never_activates(self):
        self.executable("print('1.2.3')\n")
        env, log = self.transport_tools()
        env["TEST_TRANSFER_FAIL"] = "1"
        with patch.dict(os.environ, env):
            with self.assertRaisesRegex(RuntimeError, "inspect remote staging"):
                self.module.ship(self.stage)
        self.assertEqual(
            log.read_text().splitlines(), ["ssh", "rsync", "rsync", "rsync"]
        )
        self.assertTrue((self.install / "old-only").exists())
        self.assert_preserved()

    def test_requires_existing_real_installation(self):
        self.executable("print('1.2.3')\n")
        missing = self.install.with_name("missing")
        with self.assertRaisesRegex(RuntimeError, "existing"):
            self.module.activate(self.stage, missing)
        self.assertFalse(missing.exists())


if __name__ == "__main__":
    unittest.main()
