#!/usr/bin/env python3
"""Focused filesystem tests; never connects to agent-server."""

import importlib.util
import json
import pathlib
import os
import tempfile
import subprocess
import sys
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
    module.ACCOUNTS = ()
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


class LocalRuntimeInstallationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = pathlib.Path(self.temp.name)
        self.home = root / "allison"
        self.home.mkdir()
        self.install = self.home / ".local/share/pi"
        self.launcher = self.home / ".local/bin/pi"
        self.runtime = root / "public-runtime"
        self.runtime.mkdir()
        self.preserved = {}
        for home in (self.home, root / "osso"):
            for name in (
                ".pi/agent/auth.json",
                ".pi/agent/settings.json",
                ".pi/agent/sessions/session.jsonl",
                ".config/systemd/user/pi.service",
                ".profile",
                ".local/bin/pi-dev",
            ):
                self.preserve(home / name)
        self.preserve(root / "osso/.local/share/pi/pi")
        self.preserve(root / "osso/.local/bin/pi")
        self.executable("print('1.2.3')\n")

    def preserve(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(str(path))
        self.preserved[path] = (path.read_bytes(), path.stat().st_ino)

    def executable(self, body):
        path = self.runtime / "pi"
        path.write_text("#!/usr/bin/env python3\n" + body)
        path.chmod(0o755)

    def invoke(self):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--install-local", str(self.runtime)],
            env={**os.environ, "HOME": str(self.home)},
            capture_output=True,
            text=True,
            timeout=30,
        )

    def assert_preserved(self):
        for path, expected in self.preserved.items():
            self.assertEqual((path.read_bytes(), path.stat().st_ino), expected)

    def assert_rejected(self, message):
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)
        self.assert_preserved()

    def test_fresh_cli_install_runs_linked_executable_and_preserves_accounts(self):
        trace = self.home / "validation.log"
        self.executable(
            "import os,pathlib,stat\n"
            "runtime = pathlib.Path(__file__).resolve().parent\n"
            "assert runtime.stat().st_uid == os.getuid()\n"
            "if runtime.name != 'pi':\n"
            "    assert stat.S_IMODE(runtime.parent.stat().st_mode) == 0o700\n"
            f"with pathlib.Path({str(trace)!r}).open('a') as log:\n"
            "    log.write(str(runtime) + '\\n')\n"
            "print('1.2.3')\n"
        )
        (self.runtime / "theme").mkdir()
        (self.runtime / "theme/dark.json").write_text('{"name":"dark"}')
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        validations = trace.read_text().splitlines()
        self.assertEqual(len(validations), 2)
        self.assertNotEqual(pathlib.Path(validations[0]), self.runtime)
        self.assertEqual(pathlib.Path(validations[1]), self.install)
        self.assertFalse(pathlib.Path(validations[0]).exists())
        self.assertTrue(self.launcher.is_symlink())
        self.assertEqual(self.launcher.resolve(), self.install / "pi")
        version = subprocess.run(
            [str(self.launcher), "--version"],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(version.stdout.strip(), "1.2.3")
        self.assertEqual(
            (self.install / "theme/dark.json").read_text(), '{"name":"dark"}'
        )
        self.assertEqual(
            (self.runtime / "theme/dark.json").read_text(), '{"name":"dark"}'
        )
        self.assert_preserved()

    def test_rejects_private_entries_and_symlinks_without_installing(self):
        for name in ("auth.json", "docs/settings.json", "docs/.env.secret"):
            with self.subTest(name=name):
                entry = self.runtime / name
                entry.parent.mkdir(parents=True, exist_ok=True)
                entry.write_text("private")
                try:
                    self.assert_rejected("public runtime")
                finally:
                    entry.unlink()
                self.assertFalse(self.install.exists())
                self.assertFalse(self.launcher.exists())
        link = self.runtime / "README.md"
        link.symlink_to(self.home / ".pi/agent/auth.json")
        self.assert_rejected("symlink")
        self.assertFalse(self.install.exists())

    def test_rejects_existing_target_or_launcher_including_dangling_links(self):
        for target in (self.install, self.launcher):
            target.parent.mkdir(parents=True, exist_ok=True)
            for kind in ("file", "directory", "symlink"):
                with self.subTest(target=target, kind=kind):
                    if kind == "file":
                        target.write_text("existing")
                    elif kind == "directory":
                        target.mkdir()
                    else:
                        target.symlink_to(self.home / "missing")
                    inode = target.lstat().st_ino
                    try:
                        self.assert_rejected("already exists")
                        self.assertEqual(target.lstat().st_ino, inode)
                    finally:
                        if kind == "directory":
                            target.rmdir()
                        else:
                            target.unlink()

    def test_validation_failure_leaves_no_install_or_launcher(self):
        for body in (
            "raise SystemExit(7)\n",
            "pass\n",
            "import pathlib\n"
            "if pathlib.Path(__file__).parent.name == 'pi':\n"
            "    raise SystemExit(9)\n"
            "print('1.2.3')\n",
            "import pathlib\n"
            "print('2.0.0' if pathlib.Path(__file__).parent.name == 'pi' else '1.2.3')\n",
        ):
            with self.subTest(body=body):
                self.executable(body)
                self.assert_rejected("validation")
                self.assertFalse(self.install.exists())
                self.assertFalse(self.launcher.exists())
                self.assertFalse(list(self.install.parent.glob(".pi-runtime-*")))


class LocalRuntimeUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = pathlib.Path(self.temp.name)
        self.home = root / "allison"
        self.install = self.home / ".local/share/pi"
        self.launcher = self.home / ".local/bin/pi"
        self.install.mkdir(parents=True)
        self.launcher.parent.mkdir(parents=True)
        self.launcher.symlink_to(self.install / "pi")
        (self.install / "pi").write_text("old executable")
        (self.install / "old-only").write_text("old runtime")
        self.runtime = root / "public-runtime"
        self.runtime.mkdir()
        self.preserved = {}
        for home in (self.home, root / "osso"):
            for name in (
                ".pi/agent/auth.json",
                ".pi/agent/settings.json",
                ".pi/agent/sessions/session.jsonl",
                ".local/bin/pi-dev",
            ):
                path = home / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(str(path))
                self.preserved[path] = (path.read_bytes(), path.stat().st_ino)
        self.wrapper = root / "invoke.py"
        self.wrapper.write_text(
            "import pwd,runpy,sys\n"
            "from types import SimpleNamespace\n"
            "from unittest.mock import patch\n"
            f"sys.argv = [{str(SCRIPT)!r}, '--update-local', {str(self.runtime)!r}]\n"
            f"with patch.object(pwd, 'getpwuid', return_value=SimpleNamespace(pw_dir={str(self.home)!r})):\n"
            f"    runpy.run_path({str(SCRIPT)!r}, run_name='__main__')\n"
        )
        self.executable("print('1.2.3')\n")

    def executable(self, body):
        path = self.runtime / "pi"
        path.write_text("#!/usr/bin/env python3\n" + body)
        path.chmod(0o755)

    def invoke(self):
        return subprocess.run(
            [sys.executable, str(self.wrapper)],
            env={**os.environ, "HOME": str(self.home.parent / "osso")},
            capture_output=True,
            text=True,
            timeout=30,
        )

    def assert_preserved(self):
        for path, expected in self.preserved.items():
            self.assertEqual((path.read_bytes(), path.stat().st_ino), expected)

    def assert_rejected(self, message):
        old_inode = self.install.lstat().st_ino if self.install.exists() else None
        launcher_inode = self.launcher.lstat().st_ino
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)
        if old_inode is not None:
            self.assertEqual(self.install.lstat().st_ino, old_inode)
        self.assertEqual(self.launcher.lstat().st_ino, launcher_inode)
        self.assertFalse(list(self.install.parent.glob(".pi-runtime-*")))
        self.assert_preserved()

    def test_update_uses_effective_account_and_preserves_launcher_and_private_state(
        self,
    ):
        launcher_stat = self.launcher.lstat()
        old_inode = self.install.stat().st_ino
        trace = self.home / "validation.log"
        self.executable(
            "import os,pathlib,stat\n"
            "runtime = pathlib.Path(__file__).resolve().parent\n"
            "assert runtime.stat().st_uid == os.geteuid()\n"
            "if runtime.name != 'pi':\n"
            "    assert stat.S_IMODE(runtime.parent.stat().st_mode) == 0o700\n"
            f"with pathlib.Path({str(trace)!r}).open('a') as log:\n"
            "    log.write(str(runtime) + '\\n')\n"
            "print('1.2.3')\n"
        )
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        validations = [pathlib.Path(path) for path in trace.read_text().splitlines()]
        self.assertEqual(len(validations), 2)
        self.assertEqual(validations[0].parent.parent, self.install.parent)
        self.assertEqual(validations[1], self.install)
        self.assertFalse(validations[0].exists())
        self.assertNotEqual(self.install.stat().st_ino, old_inode)
        self.assertEqual(self.install.stat().st_uid, os.geteuid())
        self.assertFalse((self.install / "old-only").exists())
        self.assertEqual(self.launcher.lstat().st_ino, launcher_stat.st_ino)
        self.assertEqual(self.launcher.lstat().st_uid, launcher_stat.st_uid)
        self.assertEqual(self.launcher.readlink(), self.install / "pi")
        version = subprocess.run(
            [str(self.launcher), "--version"],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(version.stdout.strip(), "1.2.3")
        self.assertTrue((self.runtime / "pi").exists())
        self.assert_preserved()

    def test_update_rejects_missing_or_symlink_installation(self):
        self.install.rename(self.install.with_name("original"))
        self.assert_rejected("existing real installation")
        self.install.symlink_to(self.install.with_name("original"))
        self.assert_rejected("existing real installation")

    def test_update_rejects_wrong_regular_or_dangling_launcher(self):
        for kind in ("wrong", "regular", "dangling"):
            with self.subTest(kind=kind):
                self.launcher.unlink()
                if kind == "regular":
                    self.launcher.write_text("custom launcher")
                else:
                    target = (
                        self.runtime / "pi"
                        if kind == "wrong"
                        else self.home / "missing"
                    )
                    self.launcher.symlink_to(target)
                self.assert_rejected("launcher")
        self.launcher.unlink()
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("launcher", result.stderr)
        self.assertEqual((self.install / "old-only").read_text(), "old runtime")

    def test_update_rejects_private_runtime_and_symlinks(self):
        secret = self.runtime / "auth.json"
        secret.write_text("private")
        self.assert_rejected("public runtime")
        secret.unlink()
        (self.runtime / "README.md").symlink_to(self.home / ".pi/agent/auth.json")
        self.assert_rejected("symlink")

    def test_update_validation_failure_preserves_or_rolls_back_installation(self):
        for body in (
            "raise SystemExit(7)\n",
            "pass\n",
            "import pathlib\n"
            "if pathlib.Path(__file__).parent.name == 'pi':\n"
            "    raise SystemExit(9)\n"
            "print('1.2.3')\n",
            "import pathlib\n"
            "print('2.0.0' if pathlib.Path(__file__).parent.name == 'pi' else '1.2.3')\n",
        ):
            with self.subTest(body=body):
                self.executable(body)
                self.assert_rejected("validation")
                self.assertEqual((self.install / "old-only").read_text(), "old runtime")


class AccountRuntimeUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = pathlib.Path(self.temp.name)
        self.install = root / "osso/.local/share/pi"
        self.install.mkdir(parents=True)
        (self.install / "pi").write_text("installed executable")
        (self.install / "theme").mkdir()
        (self.install / "theme/dark.json").write_text('{"name":"dark"}')
        self.bin = root / "bin"
        self.bin.mkdir()
        self.trace = root / "authsudo.log"
        spec = importlib.util.spec_from_file_location("runtime_deploy", SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.account = patch.object(
            self.module.pwd,
            "getpwnam",
            return_value=type("Account", (), {"pw_dir": "/home/allison"})(),
        )
        self.account.start()
        self.addCleanup(self.account.stop)

    def authsudo(self, status):
        # Records what the account-side command would see, then exits like authsudo.
        path = self.bin / "authsudo"
        path.write_text(
            "#!/usr/bin/env python3\n"
            "import json,os,pathlib,stat,sys\n"
            "argv = sys.argv[1:]\n"
            "runtime = pathlib.Path(argv[argv.index('--update-local') + 1])\n"
            "stage = runtime.parent\n"
            "record = {'argv': argv, 'cwd': os.getcwd(),\n"
            "  'stageMode': stat.S_IMODE(stage.stat().st_mode),\n"
            "  'helper': (stage / 'deploy.py').read_text() == pathlib.Path(argv[argv.index('--update-local') - 1]).read_text(),\n"
            "  'files': sorted(str(p.relative_to(runtime)) for p in runtime.rglob('*')),\n"
            "  'theme': (runtime / 'theme/dark.json').read_text()}\n"
            f"pathlib.Path({str(self.trace)!r}).write_text(json.dumps(record))\n"
            f"print('update failed for test', file=sys.stderr) if {status} else None\n"
            f"sys.exit({status})\n"
        )
        path.chmod(0o755)

    def update(self):
        with patch.dict(
            os.environ, {"PATH": str(self.bin) + os.pathsep + os.environ["PATH"]}
        ):
            self.module.update_account("allison", self.install)

    def test_account_update_runs_as_account_from_readable_public_stage(self):
        self.authsudo(0)
        self.update()
        record = json.loads(self.trace.read_text())
        runtime = record["argv"][record["argv"].index("--update-local") + 1]
        self.assertEqual(
            record["argv"][:7],
            [
                "-u",
                "allison",
                "env",
                "-i",
                "HOME=/home/allison",
                "PATH=/usr/local/bin:/usr/bin:/bin",
                sys.executable,
            ],
        )
        self.assertEqual(record["cwd"], "/")
        self.assertEqual(record["stageMode"], 0o755)
        self.assertTrue(record["helper"])
        self.assertEqual(record["files"], ["pi", "theme", "theme/dark.json"])
        self.assertEqual(record["theme"], '{"name":"dark"}')
        self.assertFalse(pathlib.Path(runtime).exists())

    def test_account_update_failure_names_account_and_removes_stage(self):
        self.authsudo(3)
        with self.assertRaisesRegex(
            RuntimeError, "allison runtime update failed: update failed for test"
        ):
            self.update()
        record = json.loads(self.trace.read_text())
        runtime = record["argv"][record["argv"].index("--update-local") + 1]
        self.assertFalse(pathlib.Path(runtime).parent.exists())

    def test_activation_updates_own_install_before_each_account(self):
        share = pathlib.Path(self.temp.name) / "share"
        token = ".pi-runtime-" + "a" * 32
        (share / token / "runtime").mkdir(parents=True)
        calls = []
        with (
            patch.object(self.module, "SHARE", share),
            patch.object(self.module, "INSTALL", self.install),
            patch.object(
                self.module,
                "activate",
                lambda stage, install: calls.append(("activate", stage, install)),
            ),
            patch.object(
                self.module,
                "update_account",
                lambda account, runtime: calls.append(("account", account, runtime)),
            ),
            patch.object(sys, "argv", ["deploy.py", "--activate", token]),
        ):
            self.module.main()
        self.assertEqual(
            calls,
            [
                ("activate", share / token / "runtime", self.install),
                ("account", "allison", self.install),
            ],
        )
        self.assertFalse((share / token).exists())


if __name__ == "__main__":
    unittest.main()
