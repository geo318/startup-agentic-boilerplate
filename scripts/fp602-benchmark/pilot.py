"""Prepare and run one pair from retained inputs, with no model-driven orchestration."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from experiment import PILOT_LIMITS
from native_profile import load_profile
from shared_contract import validate


def git(*args):
    result = subprocess.run(['rtk', 'proxy', 'git', *map(str, args)], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def prepare(source, target):
    if target.exists():
        raise ValueError('refusing to reuse an experiment directory: ' + str(target))
    config = json.loads((source / 'frozen-configuration.json').read_text())
    profile = load_profile(source)
    contract = validate(json.loads((source / 'shared-contract.json').read_text()))
    baseline = config['baseline']
    if len(baseline) != 40 or any(c not in '0123456789abcdef' for c in baseline):
        raise ValueError('source must freeze a full baseline commit hash')
    if config.get('mode') != 'quick-pilot-v1' or config.get('workflow_protocol') != 'shared-contract-v1':
        raise ValueError('source must already contain a prepared shared-contract quick pilot')
    if contract['approved_plan_sha256'] is None:
        raise ValueError('source has no approved shared plan')
    git('--git-dir=' + str(source / 'seed.git'), 'cat-file', '-e', baseline + '^{commit}')
    target.mkdir(parents=True)
    # New experiment, full runner-owned allowances. Chat usage is reported separately,
    # never silently deducted from qualification and never declared to be zero.
    config['limits'] = dict(PILOT_LIMITS)
    (target / 'frozen-configuration.json').write_text(json.dumps(config, indent=2) + '\n')
    (target / 'native-profile.json').write_text(json.dumps(profile, indent=2) + '\n')
    (target / 'shared-contract.json').write_bytes((source / 'shared-contract.json').read_bytes())
    shutil.copyfile(source / 'worker-ticket.md', target / 'worker-ticket.md')
    (target / 'private-grader').mkdir()
    shutil.copyfile(source / 'private-grader/grading-protocol.md', target / 'private-grader/grading-protocol.md')
    git('clone', '--bare', '--no-hardlinks', source / 'seed.git', target / 'seed.git')
    git('clone', '--no-hardlinks', '--no-checkout', target / 'seed.git', target / 'baseline')
    git('-C', target / 'baseline', 'checkout', '--detach', baseline)
    inputs = ['frozen-configuration.json', 'native-profile.json', 'shared-contract.json',
              'worker-ticket.md', 'private-grader/grading-protocol.md']
    provenance = {'source': str(source), 'baseline': baseline, 'model_calls_for_preparation': 0,
                  'chat_overhead_native_tokens': None,
                  'note': 'Historical plan usage remains in shared-contract.json. Current chat usage is separate/unknown.',
                  'inputs_sha256': {name: hashlib.sha256((target / name).read_bytes()).hexdigest() for name in inputs},
                  'runner_sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                    for p in Path(__file__).parent.glob('*.py')}}
    (target / 'launch-provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')


def report(target, exit_code):
    def read(name, default):
        path = target / name
        return json.loads(path.read_text()) if path.exists() else default
    results = read('results.json', [])
    preparation = read('preparation/result.json', {})
    lines = ['# FP-602 paired pilot', '', f'Runner exit: {exit_code}. Coding arms recorded: {len(results)}/2.', '',
             '| Arm | Correct | Workflow tokens | Qualification tokens | Grading tokens | Failure |',
             '| --- | --- | --- | --- | --- | --- |']
    for result in results:
        failure = str(result.get('failure_reason') or result.get('grading', {}).get('grading_error') or 'none')
        total = result.get('all_native_tokens_including_grading')
        grading = total - result['workflow_native_tokens'] if total is not None else 'unknown'
        lines.append('| ' + ' | '.join(str(x).replace('|', '/').replace('\n', ' ') for x in (
            result['arm'], result.get('grading', {}).get('correct', False),
            result.get('workflow_native_tokens', 'unknown'), result.get('qualification_native_tokens', 0),
            grading, failure)) + ' |')
    lines += ['', 'Qualification receipt: ' + json.dumps(preparation), '',
              'Add qualification to B’s workflow tokens for cold-start execution. Grading is separate.',
              'Historical plan preparation is retained in shared-contract.json; additional chat overhead is unknown.',
              'This report is generated locally without inference. Jev is inactive. No savings claim is made;',
              'compare only equally correct completed candidates and include all preparation overhead.',
              'See execution.log, results.json and preparation/result.json for retained evidence.', '']
    (target / 'report.md').write_text('\n'.join(lines))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from', dest='source', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--preflight', action='store_true')
    mode.add_argument('--execute', action='store_true')
    args = parser.parse_args(argv)
    source = args.source.resolve()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    target = (args.output or source.parent / ('fp-602-paired-pilot-' + stamp)).resolve()
    prepare(source, target)
    env = {**os.environ, 'BENCHMARK_ROOT': str(target)}
    runner = Path(__file__).with_name('run-benchmark.py')
    command = ['rtk', sys.executable, str(runner)]
    subprocess.run(command + ['--preflight'], env=env, check=True)
    if args.preflight:
        from packet_context import prepare as inspect_packets
        if load_profile(target)['kind'] == 'codex-cli':
            inspect_packets(target)
        print('Prepared without inference: ' + str(target))
        return 0
    print('Running one pair; log: ' + str(target / 'execution.log'), flush=True)
    with (target / 'execution.log').open('w') as stream:
        result = subprocess.run(command + ['--execute'], env=env, stdout=stream, stderr=subprocess.STDOUT)
    report(target, result.returncode)
    print('Report: ' + str(target / 'report.md'), flush=True)
    return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
