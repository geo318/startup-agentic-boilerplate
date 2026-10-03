"""Opt-in comparison from one frozen contract; deterministic orchestration, no coordinator model."""
import hashlib
import json
import re
from harness import NODE, RUNTIME, command, log, write_json
from broker import serve


def validate(value):
    if not isinstance(value, dict) or set(value) != {
            'contract', 'approved_plan_sha256', 'accept_when_verified', 'preparation_native_tokens'}:
        raise ValueError('shared-contract.json requires contract, approved_plan_sha256, accept_when_verified, preparation_native_tokens')
    contract = value['contract']
    if not isinstance(contract, dict) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{2,40}', str(contract.get('id', ''))):
        raise ValueError('invalid shared contract id')
    if not isinstance(contract.get('plan'), str) or not contract['plan'].strip():
        raise ValueError('shared contract must include the concrete plan supplied to both arms')
    approved = value['approved_plan_sha256']
    if approved is not None and approved != hashlib.sha256(contract['plan'].encode()).hexdigest():
        raise ValueError('approval must match the exact shared plan SHA-256, or be null')
    if not isinstance(value['accept_when_verified'], bool):
        raise ValueError('accept_when_verified must be an explicit boolean')
    tokens = value['preparation_native_tokens']
    if tokens is not None and (type(tokens) is not int or tokens < 0):
        raise ValueError('preparation_native_tokens must be a measured nonnegative integer, or null for unknown')
    return value


def freeze(root):
    value = validate(json.loads((root / 'shared-contract.json').read_text()))
    with (root / 'shared-contract.frozen.json').open('x') as stream:
        json.dump(value, stream, indent=2)
    return value


def load(root):
    frozen = validate(json.loads((root / 'shared-contract.frozen.json').read_text()))
    if json.loads((root / 'shared-contract.json').read_text()) != frozen:
        raise RuntimeError('shared contract changed during the experiment')
    return frozen


def unmanaged_prompt(value):
    return ('\nShared frozen contract (same goal, acceptance, context files, scope and concrete plan as arm B). '
            'Follow this plan without regenerating it. Keep the ticket and all project requirements. '
            'Use ordinary direct development within this scope.\n' + json.dumps(value['contract'], indent=2))


def run_managed(attempt, project, value):
    """Only advance well-defined states. Never generate/approve a replacement plan or reset budgets."""
    value = validate(value)
    contract = value['contract']
    task_id = contract['id']
    contract_file = attempt / 'shared-task-contract.json'
    write_json(contract_file, contract)

    def cli(args, label):
        code, output = command(attempt, ['rtk', NODE, str(RUNTIME), *args, '--project', str(project)], project, label)
        if code:
            raise RuntimeError(f'{label} failed ({code}); see {output}')
        return output

    def status():
        return json.loads(cli(['task', 'status', task_id], 'managed-status').read_text())['state']

    code = serve(attempt, project, ['task', 'start', str(contract_file)])
    if code not in (0, 2):
        raise RuntimeError(f'managed task start failed ({code})')
    state = status()
    if state == 'AWAITING_PLAN_APPROVAL':
        saved = json.loads((attempt / 'state/tasks' / task_id / 'plan.json').read_text())
        approved = value['approved_plan_sha256']
        if approved is None:
            raise RuntimeError('shared plan requires operator approval; no approval was frozen')
        if saved['text'] != contract['plan'] or saved['hash'] != approved:
            raise RuntimeError('runtime plan differs from the frozen approved plan')
        cli(['task', 'approve', task_id], 'managed-plan-approval')
        code = serve(attempt, project, ['task', 'run', task_id])
        if code != 0:
            raise RuntimeError(f'managed execution stopped ({code}): {status()}')
        state = status()
    if state != 'AWAITING_ACCEPTANCE':
        raise RuntimeError(f'managed task stopped: {state}')
    # Required gates and independent review are already part of task run. The separate
    # grader checks the exact candidate again; do not add a redundant verification here.
    if value['accept_when_verified']:
        cli(['task', 'accept', task_id], 'managed-acceptance')
        state = status()
        if state != 'ACCEPTED':
            raise RuntimeError(f'managed acceptance stopped: {state}')
    cli(['task', 'export', task_id], 'managed-export')
    log(attempt, 'deterministic_workflow_finished', state=state, coordinator_model_calls=0)
    return f'Deterministic managed workflow finished: {state}. Independent grading follows.'
