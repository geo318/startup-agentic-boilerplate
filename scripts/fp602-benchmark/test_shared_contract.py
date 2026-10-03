"""Deterministic workflow regressions; no live model use."""
import hashlib
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import broker
import harness
import shared_contract


class SharedContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='shared-contract-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.attempt = self.root / '01B'
        self.attempt.mkdir()
        (self.attempt / 'calls').mkdir()
        (self.attempt / 'state').mkdir()
        self.project = self.root / 'project'
        self.project.mkdir()
        self.plan = 'Replace bad with good and run the protected unit check.'
        self.value = {
            'contract': {'schemaVersion': 1, 'id': 'fix-value', 'goal': 'make value.txt say good',
                         'acceptance': ['protected unit check passes'], 'files': ['value.txt'],
                         'riskTier': 'R2', 'budget': 'standard', 'plan': self.plan},
            'approved_plan_sha256': hashlib.sha256(self.plan.encode()).hexdigest(),
            'accept_when_verified': True, 'preparation_native_tokens': None}

    def fixture(self, failing_gate=False):
        agents = self.project / '.agents'
        agents.mkdir()
        (self.project / 'value.txt').write_text('bad')
        (self.project / 'check.mjs').write_text(
            "import {readFileSync} from 'node:fs'; console.log('tests 1'); "
            "process.exit(readFileSync('value.txt','utf8')==='good'?0:1)")
        harness.write_json(agents / 'policy.json', {
            'schemaVersion': 1, 'enabled': True, 'baseline': 'off',
            'protectedPaths': ['check.mjs', '.agents'], 'egress': 'local-only',
            'gates': [{'id': 'unit', 'argv': ['node', 'check.mjs'] if not failing_gate else ['node', '-e', 'process.exit(1)'],
                       'timeoutMs': 3000, 'discover': {'regex': 'tests (\\d+)', 'min': 1}}],
            'requiredGates': ['unit']})
        worker = json.dumps({'id': 'edit', 'kind': 'edit_and_finish', 'edits': [{
            'kind': 'replace', 'path': 'value.txt', 'expectHash': hashlib.sha256(b'bad').hexdigest(),
            'find': 'bad', 'replace': 'good'}]})
        harness.write_json(self.project / 'worker.json', [worker])
        harness.write_json(self.project / 'reviewer.json', [json.dumps({'findings': []})])
        harness.write_json(agents / 'models.json', {
            'schemaVersion': 1,
            'profiles': {r: {'kind': 'replay', 'file': r + '.json'} for r in ['worker', 'reviewer']},
            'roles': {'worker': 'worker', 'reviewer': 'reviewer'}})
        harness.write_json(self.attempt / 'state/qualifications.json', [
            {'profileId': 'mock/replay:' + role + '.json', 'family': family,
             'source': 'eval', 'passed': True, 'detail': {'scope': 'offline fixture'}, 'at': 'test'}
            for role, family in [('worker', 'action-protocol'), ('reviewer', 'review')]])
        harness.start_phase(self.attempt, 'workflow', 60, 100_000)

    def test_real_controller_from_frozen_plan_requires_no_coordinator_or_architect(self):
        self.fixture()
        with patch.object(broker, 'native_call') as native:
            result = shared_contract.run_managed(self.attempt, self.project, self.value)
            native.assert_not_called()  # replay workers/reviewer; no outer native coordinator
        self.assertIn('ACCEPTED', result)
        task = self.attempt / 'state/tasks/fix-value'
        self.assertEqual((task / 'candidate/value.txt').read_text(), 'good')
        self.assertEqual((self.project / 'value.txt').read_text(), 'bad')
        self.assertTrue((task / 'changes.patch').exists())
        events = [json.loads(line) for line in (task / 'state/events.jsonl').read_text().splitlines()]
        self.assertEqual(len([e for e in events if e['type'] == 'model_call']), 2)
        self.assertEqual(len([e for e in events if e['type'] == 'review']), 1)
        self.assertIn(self.plan, shared_contract.unmanaged_prompt(self.value))

    def test_missing_approval_pauses_with_no_product_edit(self):
        self.fixture()
        self.value['approved_plan_sha256'] = None
        with self.assertRaisesRegex(RuntimeError, 'requires operator approval'):
            shared_contract.run_managed(self.attempt, self.project, self.value)
        task = self.attempt / 'state/tasks/fix-value'
        self.assertEqual((task / 'candidate/value.txt').read_text(), 'bad')
        self.assertFalse((task / 'changes.patch').exists())

    def test_failed_gates_never_accept_or_export(self):
        self.fixture(failing_gate=True)
        with self.assertRaisesRegex(RuntimeError, 'execution stopped'):
            shared_contract.run_managed(self.attempt, self.project, self.value)
        self.assertFalse((self.attempt / 'state/tasks/fix-value/changes.patch').exists())

    def test_plan_and_accounting_are_frozen_and_changes_refused(self):
        harness.write_json(self.root / 'shared-contract.json', self.value)
        shared_contract.freeze(self.root)
        self.assertEqual(shared_contract.load(self.root), self.value)
        self.value['contract']['plan'] += ' different'
        harness.write_json(self.root / 'shared-contract.json', self.value)
        with self.assertRaisesRegex(RuntimeError, 'changed during'):
            shared_contract.load(self.root)
        with self.assertRaisesRegex(ValueError, 'approval must match'):
            shared_contract.validate(self.value)
        self.value['approved_plan_sha256'] = None
        self.value['preparation_native_tokens'] = -1
        with self.assertRaisesRegex(ValueError, 'measured nonnegative'):
            shared_contract.validate(self.value)


if __name__ == '__main__':
    unittest.main()
