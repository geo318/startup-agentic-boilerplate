"""Offline regressions: no model calls, credentials, or benchmark evidence writes."""
import hashlib
import json
import pathlib
import subprocess
import tempfile
import unittest
import sys
import native_profile
from unittest.mock import patch

import broker
import grade
import harness


class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fp602-repair-")
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        harness.write_json(self.root / "native-profile.json", {
            "kind": "codex-cli", "model": "test-model", "provider": "test-provider", "reasoning_effort": "medium"})
        self.root_patch = patch.object(harness, "ROOT", self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.attempt = self.root / "01A"
        self.attempt.mkdir()
        (self.attempt / "calls").mkdir()
        (self.attempt / "state").mkdir()
        self.project = self.root / "project"
        self.project.mkdir()
        (self.project / "value.txt").write_text("original")
        protocol = self.root / "private-grader"
        protocol.mkdir()
        (protocol / "grading-protocol.md").write_text("Frozen criteria")

    def tokens(self, amount):
        harness.write_json(self.attempt / "calls/worker.usage.json",
                           {"tokens": {"total_tokens": amount}})

    def test_grading_has_fixed_incremental_allowance_after_overshoot(self):
        harness.start_phase(self.attempt, "workflow", 1200, 1_000_000)
        self.tokens(1_087_537)
        self.assertIn("token", harness.stop_reason(self.attempt))
        settings = harness.start_phase(self.attempt, "grading", 600, 200_000)
        self.assertEqual(settings["token_ceiling"], 1_287_537)
        self.assertIsNone(harness.stop_reason(self.attempt))
        self.tokens(1_287_537)
        self.assertIn("token", harness.stop_reason(self.attempt))
        workflow = json.loads((self.attempt / "workflow-settings.json").read_text())
        self.assertEqual(workflow["token_ceiling"], 1_000_000)

    def test_wall_guard_catches_suspend_and_backward_clock(self):
        with patch("harness.time.monotonic", return_value=100), patch("harness.time.time", return_value=1000):
            harness.start_phase(self.attempt, "workflow", 1200, 1_000_000)
        for monotonic, wall in [(101, 2300), (1301, 999)]:
            with patch("harness.time.monotonic", return_value=monotonic), patch("harness.time.time", return_value=wall):
                self.assertIn("wall-time", harness.stop_reason(self.attempt))

    def test_expired_command_never_spawns(self):
        harness.start_phase(self.attempt, "workflow", -1, 100)
        with patch("harness.subprocess.Popen") as spawn:
            with self.assertRaisesRegex(RuntimeError, "wall-time"):
                harness.command(self.attempt, ["never"], self.project, "probe")
            spawn.assert_not_called()

    def test_cumulative_usage_is_not_summed_per_event(self):
        session = self.root / "native.jsonl"
        session.write_text("\n".join(json.dumps({"payload": {"type": "token_count", "info": {
            "total_token_usage": {"input_tokens": count, "cached_input_tokens": 50,
                                  "output_tokens": 10, "total_tokens": count + 10}}}})
            for count in [100, 200]))
        self.assertEqual(harness.usage(session)["tokens"]["total_tokens"], 210)

    def test_native_usage_lookup_honors_configured_codex_home(self):
        home = self.root / "custom-codex"
        sessions = home / "sessions"
        sessions.mkdir(parents=True)
        session = sessions / "rollout-test-session.jsonl"
        session.write_text("{}")
        with patch.dict("os.environ", {"CODEX_HOME": str(home)}):
            self.assertEqual(harness.native_path("test-session"), session)

    def test_git_pointer_is_metadata_not_product(self):
        (self.project / ".git").write_text("gitdir: /missing/worktree")
        self.assertEqual(set(grade.fingerprint(self.project)), {"value.txt"})

    def test_fast_native_session_records_usage_and_allows_source_only_directory(self):
        harness.start_phase(self.attempt, "workflow", 60, 1000)
        native = self.root / "native.jsonl"
        native.write_text(json.dumps({"payload": {"type": "token_count", "info": {
            "total_token_usage": {"input_tokens": 80, "output_tokens": 20, "total_tokens": 100}}}}))
        class Finished:
            pid = 99999999
            def poll(self):
                return 0
            def wait(self):
                return 0
        def spawn(argv, **kwargs):
            self.assertIn("--skip-git-repo-check", argv)
            self.assertEqual(kwargs["cwd"], self.project)
            kwargs["stdout"].write(json.dumps({"type": "thread.started", "thread_id": "synthetic"}) + "\n")
            pathlib.Path(argv[argv.index("-o") + 1]).write_text("{}")
            return Finished()
        with patch("harness.subprocess.Popen", side_effect=spawn), patch("harness.native_path", return_value=native):
            reply, measured = harness.native_call(self.attempt, self.project, "probe", "Return JSON", readonly=True)
        self.assertEqual(reply, "{}")
        self.assertEqual(measured["tokens"]["total_tokens"], 100)
        self.assertEqual(harness.attempt_tokens(self.attempt), 100)
        self.assertEqual(list((self.attempt / "active-processes").iterdir()), [])

    def test_real_grading_git_history_preserves_candidate_edits_and_deletions(self):
        seed = self.root / "seed.git"
        seed.mkdir()
        def git(cwd, *args):
            return subprocess.run(["rtk", "proxy", "git", *args], cwd=cwd, check=True,
                                  text=True, capture_output=True).stdout.strip()
        git(seed, "init", "--quiet")
        (seed / "value.txt").write_text("baseline")
        (seed / "deleted.txt").write_text("gone in candidate")
        git(seed, "add", ".")
        git(seed, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
            "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fixture")
        base = git(seed, "rev-parse", "HEAD")
        (self.project / "new.txt").write_text("new")
        (self.project / ".git").write_text("gitdir: /missing")
        harness.start_phase(self.attempt, "grading", 60, 200_000)
        def command(attempt, argv, project, label):
            if label == "grading-dependencies":
                self.assertEqual(git(project, "rev-parse", "HEAD"), base)
                return 0, self.root / "install.log"
            return harness.command(attempt, argv, project, label)
        with patch.object(grade, "ROOT", self.root), patch.object(grade, "BASE", base), patch.object(grade, "command", side_effect=command):
            workspace = grade.prepare_candidate(self.attempt, self.project)
        self.assertEqual(grade.fingerprint(workspace), grade.fingerprint(self.project))
        status = git(workspace, "status", "--porcelain")
        self.assertIn("D deleted.txt", status)
        self.assertIn("M value.txt", status)
        self.assertIn("?? new.txt", status)

    def test_packet_call_uses_inspected_workspace_without_changing_model(self):
        harness.start_phase(self.attempt, "preparation", 60, 1000)
        workspace = self.root / 'packet-workspace'
        workspace.mkdir()
        harness.write_json(self.root / 'packet-context.json', {
            'workspace': str(workspace), 'overrides': ['project_doc_max_bytes=0']})
        native = self.root / 'native.jsonl'
        native.write_text(json.dumps({'payload': {'type': 'token_count', 'info': {
            'total_token_usage': {'input_tokens': 80, 'output_tokens': 20, 'total_tokens': 100}}}}))
        class Finished:
            pid = 99999999
            def poll(self): return 0
            def wait(self): return 0
        def spawn(argv, **kwargs):
            self.assertEqual(kwargs['cwd'], workspace)
            self.assertEqual(argv[argv.index('-C') + 1], str(workspace))
            self.assertEqual(argv[argv.index('-m') + 1], 'test-model')
            self.assertEqual(argv[argv.index('-s') + 1], 'read-only')
            self.assertIn('project_doc_max_bytes=0', argv)
            kwargs['stdout'].write(json.dumps({'type': 'thread.started', 'thread_id': 'fixture'}) + '\n')
            pathlib.Path(argv[argv.index('-o') + 1]).write_text('{}')
            return Finished()
        with patch('harness.subprocess.Popen', side_effect=spawn), patch('harness.native_path', return_value=native):
            harness.native_call(self.attempt, self.project, 'qualification', 'packet', readonly=True, packet_only=True)

    def test_native_profile_selects_model_provider_and_optional_settings(self):
        profile = {"kind": "codex-cli", "model": "another-model", "provider": "local", "reasoning_effort": "low"}
        harness.write_json(self.root / "native-profile.json", profile)
        args = native_profile.codex_args(native_profile.load_profile(self.root), self.project, self.root / "reply", True, None, "01A")
        self.assertEqual(args[args.index("-m") + 1], "another-model")
        self.assertIn('model_provider="local"', args)
        self.assertIn('model_reasoning_effort="low"', args)
        self.assertFalse(any("headroom" in arg for arg in args))
        changed = {**profile, "model": "next-model"}
        self.assertNotEqual(native_profile.profile_label(profile), native_profile.profile_label(changed))
        harness.write_json(self.root / "native-profile.frozen.json", profile)
        harness.write_json(self.root / "native-profile.json", changed)
        with self.assertRaisesRegex(RuntimeError, "changed during"):
            native_profile.load_profile(self.root)

    def test_missing_or_invalid_profile_never_selects_a_default(self):
        path = self.root / "native-profile.json"
        path.unlink()
        with self.assertRaisesRegex(RuntimeError, "no model is selected"):
            native_profile.load_profile(self.root)
        for invalid in [{"kind": "codex-cli", "model": "x"}, {"kind": "command", "model": "x", "provider": "y", "argv": ["tool"]}]:
            harness.write_json(path, invalid)
            with self.assertRaises(ValueError):
                native_profile.load_profile(self.root)

    def test_custom_native_adapter_round_trip_and_usage_without_codex(self):
        harness.start_phase(self.attempt, "workflow", 60, 1000)
        adapter = self.root / "bridge.py"
        adapter.write_text("""import json,pathlib,sys
request = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert request['model'] == 'vendor/model-v3'
assert request['provider'] == 'subscription-cli'
assert request['readonly'] is True
pathlib.Path(request['reply_path']).write_text('{"ok":true}')
usage = {'tokens': {'input_tokens': 80, 'cached_input_tokens': 50, 'output_tokens': 20, 'total_tokens': 100}, 'actual_billed_usd': None}
pathlib.Path(request['usage_path']).write_text(json.dumps(usage))
""")
        harness.write_json(self.root / "native-profile.json", {"kind": "command", "model": "vendor/model-v3", "provider": "subscription-cli", "argv": ["rtk", sys.executable, str(adapter), "{request}"]})
        reply, measured = harness.native_call(self.attempt, self.project, "custom", "Return JSON", readonly=True)
        self.assertEqual(json.loads(reply), {"ok": True})
        self.assertEqual(measured["tokens"]["total_tokens"], 100)
        self.assertEqual(harness.attempt_tokens(self.attempt), 100)
        # Missing usage must stop the attempt, rather than allowing unmetered sessions.
        adapter.write_text("import sys")
        with self.assertRaisesRegex(RuntimeError, "did not report native usage"):
            harness.native_call(self.attempt, self.project, "custom", "Return JSON", readonly=True)

    def passing_reply(self, *args, **kwargs):
        return json.dumps({"criteria": [{"number": n, "verdict": "PASS", "evidence": "synthetic"}
                                       for n in range(1, 12)], "regressions": [], "summary": "pass"}), {}

    def grade_with(self, gate_failure=False, mutate_source=False, prepare_failure=False):
        original = grade.fingerprint(self.project)
        def command(attempt, argv, project, label):
            self.assertNotEqual(project, self.project)
            self.assertFalse((project / ".git").exists())
            if label == "grading-git-clone":
                (attempt / "grading-workspace").mkdir()
                return 0, self.root / "clone.log"
            if label == "grading-git-baseline":
                return 0, self.root / "reset.log"
            if label == "grading-dependencies":
                self.assertEqual(argv, ["rtk", "bun", "install", "--frozen-lockfile"])
                if prepare_failure:
                    return 1, self.root / "install.log"
            else:
                (project / "apps/web").mkdir(parents=True, exist_ok=True)
                (project / "apps/web/next-env.d.ts").write_text("generated")
                (project / ".fallow").mkdir(exist_ok=True)
                (project / ".fallow/cache").write_text("generated")
                if mutate_source:
                    (project / "value.txt").write_text("changed by check")
            return int(gate_failure and label == "independent-grade-lint"), self.root / "check.log"
        with patch.object(grade, "ROOT", self.root), patch.object(grade, "command", side_effect=command), patch.object(grade, "native_call", side_effect=self.passing_reply) as native:
            result = grade.grade(self.attempt, self.project)
            if prepare_failure:
                native.assert_not_called()
        self.assertEqual(grade.fingerprint(self.project), original)
        return result

    def test_grading_isolated_generated_outputs_do_not_reject_candidate(self):
        self.assertTrue(self.grade_with()["correct"])

    def test_failed_gate_overrides_model_pass(self):
        self.assertFalse(self.grade_with(gate_failure=True)["correct"])

    def test_source_mutation_by_gate_is_still_rejected(self):
        result = self.grade_with(mutate_source=True)
        self.assertFalse(result["correct"])
        self.assertEqual(result["unexpected_source_changes"], ["value.txt"])

    def test_dependency_failure_is_preparation_not_product_regression(self):
        result = self.grade_with(prepare_failure=True)
        self.assertFalse(result["correct"])
        self.assertEqual(result["failure_kind"], "preparation")

    def test_real_cli_broker_round_trip_ignores_profile_dir(self):
        # Real runtime, six synthetic replies: exercise discovery through actual packet effects.
        agents = self.project / ".agents"
        agents.mkdir()
        harness.write_json(agents / "policy.json", {
            "schemaVersion": 1, "enabled": True, "protectedPaths": [],
            "egress": "hosted-allowed", "gates": [{"id": "unit", "argv": ["node", "--version"],
                                                      "timeoutMs": 1000, "discover": {"regex": "v([0-9]+)", "min": 1}}],
            "requiredGates": ["unit"]})
        unused = self.root / "wrong-exchange"
        harness.write_json(agents / "models.json", {
            "schemaVersion": 1, "execution": "handoff",
            "profiles": {"test": {"kind": "manual", "label": "synthetic", "dir": str(unused), "timeoutMs": 10000}},
            "roles": {"worker": "test"}})
        harness.start_phase(self.attempt, "workflow", 60, 1_000_000)
        def reply(attempt, project, label, prompt, **kwargs):
            if "File f.txt" in prompt:
                value = {"id": "p2", "kind": "edit", "edits": [{"kind": "replace", "path": "f.txt",
                    "expectHash": hashlib.sha256(b"alpha").hexdigest(), "find": "alpha", "replace": "beta"}]}
            else:
                value = {"id": "p1", "kind": "finish"}
            return json.dumps(value), {"tokens": {"input_tokens": 10, "output_tokens": 10}}
        with patch.object(broker, "native_call", side_effect=reply) as native:
            self.assertEqual(broker.serve(self.attempt, self.project, ["qualify", "test"]), 0)
            self.assertEqual(native.call_count, 6)
        qualification = json.loads((self.attempt / "state/qualifications.json").read_text())
        self.assertTrue(qualification[0]["passed"])
        self.assertFalse(unused.exists())
        self.assertEqual(len(list((self.attempt / "state/exchange").rglob("response-*.txt"))), 6)


if __name__ == "__main__":
    unittest.main()
