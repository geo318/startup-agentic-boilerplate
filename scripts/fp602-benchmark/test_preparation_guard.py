import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

import preparation_guard as guard


class PreparationGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.session = self.root / "session.jsonl"
        self.state = self.root / "guard"
        self.boundary = "2026-10-03T08:00:00Z"
        self.rows = []
        self.usage(100, 80, 10)
        self.rows.append({"type": "response_item", "timestamp": self.boundary,
                          "payload": {"type": "message", "role": "user",
                                      "content": [{"type": "input_text", "text": "goahead"}]}})
        self.usage(200, 160, 20)
        self.flush()
        self.wall = patch("preparation_guard.time.time", return_value=1791014401)
        self.mono = patch("preparation_guard.time.monotonic", return_value=100)
        self.wall.start(); self.mono.start()
        self.addCleanup(self.wall.stop); self.addCleanup(self.mono.stop)

    def usage(self, input_tokens, cached, output):
        self.rows.append({"type": "event_msg", "payload": {"type": "token_count", "info": {
            "total_token_usage": {"input_tokens": input_tokens, "cached_input_tokens": cached,
                                  "output_tokens": output, "total_tokens": input_tokens + output}}}})

    def flush(self):
        self.session.write_text("".join(json.dumps(r) + "\n" for r in self.rows))

    def start(self, tokens=200000):
        return guard.create(self.state, self.session, self.boundary, tokens=tokens)

    def test_actual_response_item_boundary_and_cached_subset(self):
        result = self.start()
        self.assertEqual(result["tokens"], {"input_tokens": 100, "cached_input_tokens": 80,
                         "output_tokens": 10, "total_tokens": 110, "uncached_input_tokens": 20})
        self.assertTrue(result["allowed"])

    def test_reserve_refuses_spawn_and_stop_cannot_reset(self):
        self.start(tokens=150)
        with patch("preparation_guard.subprocess.Popen") as spawn:
            result = guard.supervise(self.state, ["never"], 41)
            spawn.assert_not_called()
        self.assertFalse(result["allowed"])
        self.assertFalse(guard.check(self.state)["allowed"])
        with self.assertRaisesRegex(ValueError, "reset"):
            self.start()

    def test_threshold_stops_running_process(self):
        self.start(tokens=150)
        self.usage(240, 190, 20); self.flush()
        self.assertFalse(guard.check(self.state)["allowed"])

    def test_supervisor_terminates_child_when_usage_reaches_limit(self):
        self.start(tokens=150)
        class Child:
            def poll(inner):
                self.usage(240, 190, 20); self.flush()
                return None
        child = Child()
        with patch("preparation_guard.subprocess.Popen", return_value=child), patch("preparation_guard.terminate") as stop:
            result = guard.supervise(self.state, ["synthetic"], 10)
        self.assertFalse(result["allowed"])
        stop.assert_called_with(child)

    def test_wall_and_monotonic_deadlines(self):
        self.start()
        with patch("preparation_guard.time.monotonic", return_value=400):
            self.assertFalse(guard.check(self.state)["allowed"])

    def test_cli_propagates_child_failure(self):
        self.start()
        with patch("builtins.print"):
            code = guard.main([str(self.state), "--run", sys.executable, "-c", "raise SystemExit(7)"])
        self.assertEqual(code, 7)

    def test_forward_wall_jump_stops_without_monotonic_expiry(self):
        self.start()
        with patch("preparation_guard.time.time", return_value=1791014800):
            self.assertFalse(guard.check(self.state)["allowed"])

    def test_absent_baseline_and_wrong_boundary_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "unavailable"):
            guard.session_usage(self.session, "missing")
        self.rows = self.rows[1:]; self.flush()
        with self.assertRaisesRegex(ValueError, "unavailable"):
            guard.session_usage(self.session, self.boundary)

    def test_partial_tail_is_ignored_but_settled_corruption_stops(self):
        self.start()
        with self.session.open("a") as stream: stream.write('{"partial"')
        self.assertTrue(guard.check(self.state)["allowed"])
        with self.session.open("a") as stream: stream.write("\n")
        self.assertFalse(guard.check(self.state)["allowed"])

    def test_missing_accounting_and_rollback_fail_closed(self):
        self.start()
        self.usage(199, 160, 20); self.flush()
        self.assertFalse(guard.check(self.state)["allowed"])

    def test_additional_usage_counted_once_and_duplicate_rejected(self):
        self.start()
        receipt = self.root / "qualification.json"
        receipt.write_text(json.dumps({"tokens": {"input_tokens": 50, "cached_input_tokens": 30,
                            "output_tokens": 5, "total_tokens": 55}}))
        self.assertEqual(guard.check(self.state, additional_receipts=[receipt])["tokens"]["total_tokens"], 165)
        self.assertFalse(guard.check(self.state, additional_receipts=[receipt, receipt])["allowed"])

    def test_missing_receipt_and_invalid_aggregate_fail_closed(self):
        self.start()
        self.assertFalse(guard.check(self.state, additional_receipts=[self.root / "missing"])["allowed"])

    def test_previously_counted_receipt_cannot_be_omitted(self):
        self.start()
        receipt = self.root / "qualification.json"
        receipt.write_text(json.dumps({"tokens": {"input_tokens": 50, "cached_input_tokens": 30,
                            "output_tokens": 5, "total_tokens": 55}}))
        self.assertTrue(guard.check(self.state, additional_receipts=[receipt])["allowed"])
        self.assertFalse(guard.check(self.state)["allowed"])

    def test_invalid_cached_or_total_counters_are_rejected(self):
        for value in [dict(input_tokens=10, cached_input_tokens=11, output_tokens=1, total_tokens=11),
                      dict(input_tokens=10, cached_input_tokens=5, output_tokens=1, total_tokens=16)]:
            with self.assertRaises(ValueError): guard.counters(value)


if __name__ == "__main__":
    unittest.main()
