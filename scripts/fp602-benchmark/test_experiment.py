"""Quick-pilot guards are exercised offline, including real child-process cancellation."""
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch
import experiment
import harness

spec = importlib.util.spec_from_file_location('benchmark_runner', pathlib.Path(__file__).with_name('run-benchmark.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class ExperimentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fp602-pilot-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.config = {'mode': 'quick-pilot-v1', 'workflow_protocol': 'shared-contract-v1',
                       'trial_order': {'paired_orders': [['B', 'A']]}}
        self.save()

    def save(self):
        harness.write_json(self.root / 'frozen-configuration.json', self.config)

    def test_pilot_limits_are_explicit_and_cannot_silently_become_full_benchmark(self):
        self.assertEqual(experiment.settings(self.root)['limits'], experiment.PILOT_LIMITS)
        for field, value in [('workflow_tokens', 1_000_000), ('grading_seconds', 600),
                             ('preparation_seconds', 0), ('grading_tokens', True), ('typo', 1)]:
            self.config['limits'] = {field: value}
            self.save()
            with self.assertRaises(ValueError):
                experiment.settings(self.root)
        self.config.pop('limits')
        self.config['trial_order']['paired_orders'] *= 5
        self.save()
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            experiment.settings(self.root)

    def test_active_jev_claim_is_refused_before_spending(self):
        self.config['jev'] = {'configured': 'enabled', 'actual': 'active'}
        self.save()
        with self.assertRaisesRegex(ValueError, 'cannot measure'):
            experiment.settings(self.root)

    def test_failed_preparation_directory_cannot_be_reused(self):
        (self.root / 'report.md').write_text('Existing failed experiment')
        with self.assertRaisesRegex(ValueError, 'NEW'):
            experiment.preflight(self.root)

    def test_default_invocation_never_launches(self):
        with patch.object(runner, 'preflight') as preflight, patch.object(runner, 'prepare_qualifications') as prepare:
            with self.assertRaisesRegex(ValueError, 'no implicit launch'):
                runner.main([])
            preflight.assert_not_called()
            prepare.assert_not_called()

    def test_preflight_mode_never_freezes_or_launches_inference(self):
        with patch.object(runner, 'preflight', return_value=experiment.settings(self.root)), \
             patch.object(runner, 'prepare_qualifications') as prepare, \
             patch.object(runner, 'run_one') as run:
            runner.main(['--preflight'])
            prepare.assert_not_called()
            run.assert_not_called()
        self.assertFalse((self.root / 'attempts').exists())

    def test_supervised_preparation_installs_limits_before_work_and_records_failure(self):
        config = experiment.settings(self.root)
        def fail(attempt, project, arm):
            settings = json.loads((attempt / 'settings.json').read_text())
            self.assertEqual(settings['phase'], 'preparation')
            self.assertEqual(settings['token_ceiling'], 200_000)
            self.assertEqual(settings['seconds'], 300)
            raise RuntimeError('fixture preparation failure')
        with patch.object(runner, 'ROOT', self.root), patch.object(runner, 'setup', side_effect=fail), \
             patch.object(runner, 'stop_remaining_processes'):
            with self.assertRaisesRegex(RuntimeError, 'no arms launched'):
                runner.prepare_qualifications(config)
        result = json.loads((self.root / 'preparation/result.json').read_text())
        self.assertEqual(result['tokens'], 0)
        self.assertIn('fixture', result['failure'])
        self.assertFalse((self.root / 'attempts').exists())

    def test_preparation_failure_prevents_both_arms_in_execute_mode(self):
        config = experiment.settings(self.root)
        with patch.object(runner, 'ROOT', self.root), patch.object(runner, 'preflight', return_value=config), \
             patch.object(runner, 'load_profile', return_value={}), patch.object(runner.shared_contract, 'freeze'), \
             patch.object(runner, 'prepare_qualifications', side_effect=RuntimeError('ceiling')), \
             patch.object(runner, 'run_one') as run:
            with self.assertRaisesRegex(RuntimeError, 'ceiling'):
                runner.main(['--execute'])
            run.assert_not_called()

    def test_live_watchdog_kills_synthetic_preparation_child_and_refuses_next_call(self):
        attempt = self.root / '00P'
        attempt.mkdir()
        (attempt / 'calls').mkdir()
        (attempt / 'state').mkdir()
        bridge = self.root / 'bridge.py'
        bridge.write_text("""import json,pathlib,sys,time
r=json.loads(pathlib.Path(sys.argv[1]).read_text())
p=pathlib.Path(r['usage_path'])
t=p.with_suffix('.tmp')
t.write_text(json.dumps({'tokens':{'input_tokens':101,'output_tokens':0,'total_tokens':101}}))
t.replace(p)
time.sleep(30)
""")
        harness.write_json(self.root / 'native-profile.json', {'kind': 'command', 'model': 'synthetic',
            'provider': 'offline', 'argv': ['rtk', sys.executable, str(bridge), '{request}']})
        harness.start_phase(attempt, 'preparation', 10, 100)
        with patch.object(harness, 'ROOT', self.root):
            with self.assertRaisesRegex(RuntimeError, 'token ceiling'):
                harness.native_call(attempt, self.root, 'qualification', 'fixture', readonly=True)
            with patch.object(harness.subprocess, 'Popen') as spawn:
                with self.assertRaisesRegex(RuntimeError, 'token ceiling'):
                    harness.native_call(attempt, self.root, 'next', 'must not launch')
                spawn.assert_not_called()
        self.assertEqual(harness.attempt_tokens(attempt), 101)
        self.assertEqual(list((attempt / 'active-processes').iterdir()), [])

    def test_prepared_pilot_launches_exactly_one_pair_with_one_qualification_stage(self):
        config = experiment.settings(self.root)
        preparation = {'tokens': 100, 'wall_seconds': 1, 'qualification_file': self.root / 'qualifications.json'}
        with patch.object(runner, 'ROOT', self.root), patch.object(runner, 'preflight', return_value=config), \
             patch.object(runner, 'load_profile', return_value={}), patch.object(runner.shared_contract, 'freeze'), \
             patch.object(runner, 'prepare_qualifications', return_value=preparation) as prepare, \
             patch.object(runner, 'run_one', return_value={'fixture': True}) as run:
            runner.main(['--execute'])
            prepare.assert_called_once_with(config)
            self.assertEqual([call.args[2] for call in run.call_args_list], ['B', 'A'])
            for call in run.call_args_list:
                self.assertEqual(call.args[4]['limits'], experiment.PILOT_LIMITS)
                self.assertIs(call.args[5], preparation)

    def test_runtime_contract_validation_precedes_any_inference(self):
        for name in ['seed.git', 'baseline', 'private-grader']:
            (self.root / name).mkdir()
        (self.root / 'worker-ticket.md').write_text('fixture')
        (self.root / 'private-grader/grading-protocol.md').write_text('fixture')
        harness.write_json(self.root / 'native-profile.json', {'kind': 'codex-cli', 'model': 'fixture', 'provider': 'fixture'})
        harness.write_json(self.root / 'shared-contract.json', {'contract': {'id': 'fixture', 'plan': 'approved plan'},
            'approved_plan_sha256': None, 'accept_when_verified': False, 'preparation_native_tokens': None})
        with patch.object(experiment.subprocess, 'run') as command:
            command.return_value.returncode = 0
            with self.assertRaisesRegex(ValueError, 'approved shared plan'):
                experiment.preflight(self.root)
            self.assertEqual(command.call_count, 1)  # Git inspection only, no native/model process

    def test_native_usage_does_not_depend_on_user_message_record_format(self):
        for row in [ {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'goahead'}},
                     {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user',
                         'content': [{'type': 'input_text', 'text': 'goahead'}]}} ]:
            path = self.root / 'native.jsonl'
            tokens = {'input_tokens': 100, 'cached_input_tokens': 90, 'output_tokens': 3, 'total_tokens': 103}
            path.write_text(json.dumps(row) + '\n' + json.dumps({'type': 'event_msg', 'payload': {
                'type': 'token_count', 'info': {'total_token_usage': tokens}}}))
            self.assertEqual(harness.usage(path)['tokens'], tokens)


if __name__ == '__main__':
    unittest.main()
