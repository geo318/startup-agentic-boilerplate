"""Offline launch regression: retained inputs, complete qualification allowance, no chat loop."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import harness
import packet_context
import pilot


class PilotTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def test_prepare_reuses_approved_inputs_without_resetting_old_evidence(self):
        source, target = self.root / 'source', self.root / 'new'
        source.mkdir()
        seed = self.root / 'fixture-repo'
        pilot.git('init', seed)
        (seed / 'value.txt').write_text('baseline')
        pilot.git('-C', seed, 'add', '.')
        pilot.git('-C', seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture')
        baseline = pilot.git('-C', seed, 'rev-parse', 'HEAD')
        pilot.git('clone', '--bare', seed, source / 'seed.git')
        harness.write_json(source / 'frozen-configuration.json', {
            'baseline': baseline, 'mode': 'quick-pilot-v1', 'workflow_protocol': 'shared-contract-v1',
            'trial_order': {'paired_orders': [['A', 'B']]},
            'limits': {'preparation_tokens': 35568, 'preparation_seconds': 177}})
        harness.write_json(source / 'native-profile.json', {'kind': 'codex-cli', 'model': 'fixture', 'provider': 'fixture'})
        harness.write_json(source / 'shared-contract.json', {
            'contract': {'id': 'fixture', 'plan': 'approved'},
            'approved_plan_sha256': hashlib.sha256(b'approved').hexdigest(),
            'accept_when_verified': False, 'preparation_native_tokens': 164432})
        (source / 'worker-ticket.md').write_text('full task')
        (source / 'private-grader').mkdir()
        (source / 'private-grader/grading-protocol.md').write_text('full criteria')
        (source / 'report.md').write_text('historical failure')
        original = (source / 'frozen-configuration.json').read_bytes()
        pilot.prepare(source, target)
        limits = json.loads((target / 'frozen-configuration.json').read_text())['limits']
        self.assertEqual(limits, pilot.PILOT_LIMITS)
        self.assertEqual((source / 'frozen-configuration.json').read_bytes(), original)
        self.assertEqual((source / 'report.md').read_text(), 'historical failure')
        self.assertFalse((target / 'report.md').exists())
        self.assertEqual((source / 'shared-contract.json').read_bytes(), (target / 'shared-contract.json').read_bytes())
        self.assertEqual(pilot.git('-C', target / 'baseline', 'rev-parse', 'HEAD'), baseline)
        with self.assertRaisesRegex(ValueError, 'refusing to reuse'):
            pilot.prepare(source, target)

    def test_report_includes_grading_and_qualification_without_inference(self):
        harness.write_json(self.root / 'results.json', [{'arm': 'B', 'workflow_native_tokens': 100,
            'qualification_native_tokens': 30, 'all_native_tokens_including_grading': 120,
            'grading': {'correct': False}}])
        with patch('subprocess.Popen') as spawn:
            pilot.report(self.root, 0)
            spawn.assert_not_called()
        text = (self.root / 'report.md').read_text()
        self.assertIn('| B | False | 100 | 30 | 20 |', text)
        self.assertIn('additional chat overhead is unknown', text)

    def test_packet_inspection_disables_discovered_skills_and_plugins_locally(self):
        before = '- `r0` = `/skills`\n- example (file: r0/example/SKILL.md)'
        class Result:
            returncode, stderr = 0, ''
            def __init__(self, text):
                self.stdout = json.dumps([{'role': 'developer', 'content': [{'text': text}]}])
        with patch.object(packet_context.subprocess, 'check_output', return_value='{"plugins":["example@local"],"mcp_servers":["example"]}'), \
             patch.object(packet_context.subprocess, 'run', side_effect=[Result(before), Result('permissions')]) as run:
            result = packet_context.prepare(self.root)
        args = run.call_args.args[0]
        self.assertIn('plugins.example@local.enabled=false', args)
        self.assertIn('mcp_servers.example.enabled=false', args)
        self.assertIn('skills.config=[{path="/skills/example/SKILL.md",enabled=false}]', args)
        self.assertEqual(result['model_calls'], 0)
        self.assertLess(result['ambient_message_bytes_after'], result['ambient_message_bytes_before'])

    def test_remaining_ambient_skills_refuse_live_continuation(self):
        class Result:
            returncode, stderr = 0, ''
            stdout = json.dumps([{'content': [{'text': '<skills_instructions>still loaded'}]}])
        with patch.object(packet_context.subprocess, 'check_output', return_value='{}'), \
             patch.object(packet_context.subprocess, 'run', return_value=Result()):
            with self.assertRaisesRegex(RuntimeError, 'still contains'):
                packet_context.prepare(self.root)
        self.assertFalse((self.root / 'packet-context.json').exists())


if __name__ == '__main__':
    unittest.main()
