"""Read-only readiness checks and fixed quick-pilot limits. Never invokes a model."""
import json
import subprocess
import tempfile
from pathlib import Path
from harness import BASE, NODE, RUNTIME
from native_profile import load_profile
from shared_contract import validate

PILOT_LIMITS = {'workflow_seconds': 600, 'workflow_tokens': 250_000,
                'grading_seconds': 180, 'grading_tokens': 25_000,
                'preparation_seconds': 300, 'preparation_tokens': 200_000}


def settings(root):
    config = json.loads((root / 'frozen-configuration.json').read_text())
    mode = config.get('mode', 'benchmark-v1')
    if mode not in ('benchmark-v1', 'quick-pilot-v1'):
        raise ValueError('unknown experiment mode')
    orders = config['trial_order']['paired_orders']
    if not isinstance(orders, list) or not orders or any(o not in (['A', 'B'], ['B', 'A']) for o in orders):
        raise ValueError('every pair must contain A and B exactly once')
    pilot = mode == 'quick-pilot-v1'
    protocol = config.get('workflow_protocol', 'discovery-v1')
    if protocol not in ('discovery-v1', 'shared-contract-v1'):
        raise ValueError('unknown workflow protocol')
    if pilot and (len(orders) != 1 or protocol != 'shared-contract-v1'):
        raise ValueError('quick pilot requires exactly one shared-contract pair')
    defaults = PILOT_LIMITS if pilot else {**PILOT_LIMITS, 'workflow_seconds': 1200,
                                         'workflow_tokens': 1_000_000, 'grading_seconds': 600,
                                         'grading_tokens': 200_000}
    overrides = config.get('limits', {})
    if not isinstance(overrides, dict) or set(overrides) - defaults.keys():
        raise ValueError('unknown experiment limit')
    limits = {**defaults, **overrides}
    for key, value in limits.items():
        if type(value) is not int or value <= 0 or value > defaults[key]:
            raise ValueError(f'{key} must be a positive integer at most {defaults[key]}')
    if config.get('baseline', BASE) != BASE:
        raise ValueError('this FP-602 grader requires the frozen baseline ' + BASE)
    # This runner has no calibrated Jev wiring. Refuse claims that enabling a JSON flag tests Jev.
    jev = config.get('jev', {})
    if jev and (not isinstance(jev, dict) or jev.get('configured') != 'disabled' or jev.get('actual') != 'inactive'):
        raise ValueError('this runner supports only Jev disabled/inactive; it cannot measure an active-Jev treatment')
    return {**config, 'mode': mode, 'workflow_protocol': protocol, 'limits': limits}


def preflight(root):
    if any((root / name).exists() for name in ('attempts', 'results.json', 'preparation', 'report.md',
                                              'preparation-usage.json', 'native-profile.frozen.json',
                                              'shared-contract.frozen.json', 'execution-settings.json')):
        raise ValueError('experiment already contains evidence; use a NEW prepared directory')
    config = settings(root)
    load_profile(root)
    if not RUNTIME.is_file():
        raise ValueError('run this script from the tooling checkout; copied runner has no runtime')
    for name in ('seed.git', 'baseline', 'worker-ticket.md', 'private-grader/grading-protocol.md'):
        if not (root / name).exists():
            raise ValueError('missing prepared input: ' + name)
    check = subprocess.run(['rtk', 'git', '--git-dir=' + str(root / 'seed.git'),
                            'cat-file', '-e', BASE + '^{commit}'], capture_output=True, text=True)
    if check.returncode:
        raise ValueError('seed does not contain the required baseline')
    if config['workflow_protocol'] == 'shared-contract-v1':
        shared = validate(json.loads((root / 'shared-contract.json').read_text()))
        if config['mode'] == 'quick-pilot-v1' and shared['approved_plan_sha256'] is None:
            raise ValueError('freeze the approved shared plan before spending on qualification')
        with tempfile.TemporaryDirectory(prefix='fp602-preflight-') as directory:
            contract = Path(directory) / 'contract.json'
            contract.write_text(json.dumps(shared['contract']))
            check = subprocess.run(['rtk', NODE, str(RUNTIME), 'validate', str(contract),
                                    '--project', str(root / 'baseline')], capture_output=True, text=True)
            if check.returncode:
                raise ValueError('contract/config validation failed: ' + check.stdout + check.stderr)
    return config
