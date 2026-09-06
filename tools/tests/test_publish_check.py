"""Exercise the real command against disposable Git repositories and staged blobs."""

from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[1]


class PublishCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        (self.root / "tools").mkdir()
        for name in ("publish-check.sh", "publish_check.py"):
            shutil.copyfile(SOURCE / name, self.root / "tools" / name)
        self.write(".gitignore", "tools/publish-denylist.txt\n")
        self.write("README.md", "Generic public guidance.\n")
        # Synthetic term assembled here so fixtures cannot match the test's own source.
        self.term = "sample" + "-private-label"
        self.write("tools/publish-denylist.txt", "# local terms\n\n" + self.term + "\n")
        self.git("add", ".")

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def check(self, expected, *args):
        result = subprocess.run(["bash", "tools/publish-check.sh", *args], cwd=self.root,
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertEqual(expected, result.returncode, result.stdout)
        self.assertNotIn(self.term, result.stdout.casefold())
        return result.stdout

    def test_clean_tree_and_index_include_checker(self):
        self.assertIn("4 files scanned", self.check(0))
        self.assertIn("4 files scanned", self.check(0, "--staged"))

    def test_extensionless_and_untracked_files_with_spaces(self):
        self.write("notes with spaces", self.term.upper())
        self.assertIn("private denylist term", self.check(1))

    def test_private_directory_is_redacted_even_with_newline(self):
        self.write(self.term + "/notes\nextra.txt", "generic")
        self.assertIn("[redacted path]: path:", self.check(1))

    def test_checker_cannot_exclude_itself(self):
        for name in ("publish-check.sh", "publish_check.py"):
            path = self.root / "tools" / name
            original = path.read_text()
            path.write_text(original + "\n# " + self.term + "\n")
            self.assertIn("private denylist term", self.check(1))
            path.write_text(original)

    def test_index_leak_is_not_hidden_by_clean_worktree(self):
        self.write("README.md", self.term)
        self.git("add", "README.md")
        self.write("README.md", "clean")
        self.check(0)
        self.check(1, "--staged")

    def test_unstaged_leak_does_not_change_index_scan(self):
        self.write("README.md", self.term)
        self.check(1)
        self.check(0, "--staged")

    def test_staged_mode_includes_unchanged_committed_files(self):
        self.write("README.md", self.term)
        self.git("add", "README.md")
        self.git("-c", "user.name=Test", "-c", "user.email=test", "commit", "-qm", "Fixture")
        self.check(1, "--staged")

    def test_forced_tracking_of_local_denylist_is_refused(self):
        self.git("add", "-f", "tools/publish-denylist.txt")
        self.assertIn("must never be tracked", self.check(1))
        self.check(1, "--staged")

    def test_binary_symlink_and_missing_file_are_not_clean(self):
        target = self.root / "README.md"
        target.write_bytes(b"\x00\xff")
        self.assertIn("non-text content", self.check(1))
        self.git("add", "README.md")
        self.check(1, "--staged")
        target.unlink()
        target.symlink_to(".gitignore")
        self.assertIn("non-regular entry", self.check(1))
        self.git("add", "README.md")
        self.assertIn("unsupported Git entry", self.check(1, "--staged"))
        target.unlink()
        self.check(1)

    def test_generic_patterns_and_schema_exception(self):
        samples = [
            "ghp_" + "a" * 30,
            "person" + "@" + "example.com",
            "https" + "://example.com/private",
            "/" + "Users" + "/sample/work",
            "C:" + "\\" + "sample" + "\\" + "work",
            "10" + ".20.30.40",
            "service" + ".internal",
            "TASK" + "-1234",
            "@" + "sample-account",
            '"api_key": "' + "x" * 25 + '"',
        ]
        for content in samples:
            self.write("sample.txt", content)
            self.check(1)
        self.write("sample.txt", "https" + "://json-schema.org/draft/2020-12/schema")
        self.check(0)
        self.write("sample.txt", "https" + "://json-schema.org.example.com/private")
        self.check(1)

    def test_invalid_usage_or_git_failure_is_an_error(self):
        self.check(2, "--unknown")
        shutil.rmtree(self.root / ".git")
        self.assertIn("scan incomplete", self.check(2))

    def test_missing_denylist_is_reported(self):
        (self.root / "tools/publish-denylist.txt").unlink()
        self.assertIn("no local denylist", self.check(0))


if __name__ == "__main__":
    unittest.main()
