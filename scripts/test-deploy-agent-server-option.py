#!/usr/bin/env python3
"""Exercise deploy.sh in a disposable checkout with controlled build tools."""

import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent


class DeployOptionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name) / "repo"
        self.root.mkdir()
        shutil.copy2(ROOT / "deploy.sh", self.root / "deploy.sh")
        (self.root / "scripts").mkdir()
        (self.root / ".gitignore").write_text("packages/coding-agent/binaries/\n")
        self.log = self.root.parent / "commands"
        self.install = self.root.parent / "installed"
        self.bin = self.root.parent / "bin"
        self.bin.mkdir()
        self.env = dict(
            os.environ,
            PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
            TEST_LOG=str(self.log),
            PI_DEPLOY_INSTALL_DIR=str(self.install),
            PI_DEPLOY_BIN_DIR=str(self.bin),
            PI_DEPLOY_CONFIGURE_RESIDENT_SERVICES="skip",
        )
        self.program(
            self.bin / "npm",
            "import os,sys\nwith open(os.environ['TEST_LOG'],'a') as f: f.write('npm '+ ' '.join(sys.argv[1:])+'\\n')\n",
        )
        self.program(
            self.bin / "uname",
            "import sys\nprint('Linux' if sys.argv[1]=='-s' else 'x86_64')\n",
        )
        self.program(
            self.root / "scripts/build-binaries.sh",
            "import pathlib,sys\np=pathlib.Path(sys.argv[sys.argv.index('--out')+1])/'linux-x64'\np.mkdir(parents=True, exist_ok=True)\nb=p/'pi'\nb.write_text('#!/usr/bin/env python3\\nprint(\\\"1.2.3\\\")\\n')\nb.chmod(0o755)\n",
        )
        self.program(
            self.root / "scripts/deploy-agent-server-runtime.py",
            "import os,pathlib,sys\nassert (pathlib.Path(sys.argv[1])/'pi').is_file()\nwith open(os.environ['TEST_LOG'],'a') as f: f.write('ship '+sys.argv[1]+'\\n')\n",
        )
        subprocess.run(
            ["git", "init", "-q", str(self.root)], check=True, capture_output=True
        )
        subprocess.run(
            ["git", "-C", str(self.root), "add", "."], check=True, capture_output=True
        )
        subprocess.run(
            [
                "git",
                "-C",
                str(self.root),
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-qm",
                "fixture",
            ],
            check=True,
            capture_output=True,
        )

    def program(self, path, body):
        path.write_text("#!/usr/bin/env python3\n" + body)
        path.chmod(0o755)

    def deploy(self, *args):
        return subprocess.run(
            [str(self.root / "deploy.sh"), *args],
            env=self.env,
            cwd=self.root,
            text=True,
            capture_output=True,
            timeout=30,
        )

    def test_unrelated_untracked_file_allows_local_install_without_shipping(self):
        unrelated = self.root / "unrelated-notes.txt"
        unrelated.write_text("unowned work\n")
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.install / "pi").is_file())
        self.assertNotIn("ship ", self.log.read_text())
        self.assertEqual(unrelated.read_text(), "unowned work\n")
        self.assertEqual(self.log.read_text().count("npm run check\n"), 1)

    def test_unrelated_untracked_file_allows_local_and_agent_server_install(self):
        unrelated = self.root / "unrelated-notes.txt"
        unrelated.write_text("unowned work\n")
        result = self.deploy("--agent-server")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.install / "pi").is_file())
        self.assertIn("ship " + str(self.install) + "\n", self.log.read_text())
        self.assertEqual(unrelated.read_text(), "unowned work\n")
        self.assertEqual(self.log.read_text().count("npm run check\n"), 1)
        self.assertEqual(
            self.log.read_text().count(
                "npm --prefix packages/coding-agent run build\n"
            ),
            1,
        )

    def test_unknown_option_stops_before_build(self):
        result = self.deploy("--other")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.log.exists())


if __name__ == "__main__":
    unittest.main()
