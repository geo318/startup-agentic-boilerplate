"""Sequential paired attempts on the frozen baseline; preserve every result."""
import hashlib
import json
import pathlib
import os
import subprocess
import sys
import time
from harness import BASE, NODE, ROOT, RUNTIME, attempt_tokens, clean_env, command, log, native_call, start_phase, stop_reason, stop_remaining_processes, write_json
from broker import serve
from native_profile import load_profile, profile_label
from grade import grade
import shared_contract
import packet_context
from experiment import preflight, settings

PROFILE = 'benchmark-native'


def model_label():
    return profile_label(load_profile(ROOT))

PROBES = {
    'architecture': '''You are a read-only software architect. Return JSON containing arrays
decisions, assumptions, interfaces, failureModes, steps. Plan a contact-directory GET route
under /households/:householdId/contacts for a signed-in adult. Requirements: route parameters
must be validated by the contracts schema; session actor and current per-resource grants
must be checked by a core use case; reads must use actor-selected household scope in the
repository query; GET never mutates; private contact data never enters logs/errors. Explain
the layer ordering, permission/revocation failures, and testing. No file edits or tools.''',
    'review': '''You are an independent read-only reviewer. Return JSON {"findings":[]}.
Every finding has severity, criterion, location, evidence, consequence. Criteria:
authorization: household-owned child data requires a live session actor and current grants.
privacy: child names must never enter logs. Inspect this synthetic candidate:
function getChildren(req, repository) {
  const rows = repository.children(req.query.householdId);
  for (const row of rows) console.log(row.childName);
  return rows;
}
This is a public HTTP handler; there is no middleware or authorization elsewhere.
Report concrete blocking violations. Do not edit files or run tools.''',
}


def capability_evals(attempt, project):
    results = []
    for family, prompt in PROBES.items():
        reply, measured = native_call(attempt, project, 'qualification-' + family, prompt, readonly=True, packet_only=True)
        value = json.loads(reply)
        if family == 'architecture':
            assert all(isinstance(value.get(key), list) and value[key] for key in
                       ('decisions', 'interfaces', 'failureModes', 'steps'))
            text = json.dumps(value).lower()
            assert all(term in text for term in ('actor', 'grant', 'household', 'schema'))
        else:
            findings = value['findings']
            assert all(isinstance(finding.get(key), str) and finding[key] for finding in findings
                       for key in ('severity', 'criterion', 'location', 'evidence', 'consequence'))
            assert all(any(finding['severity'] == 'blocking' and finding['criterion'] == criterion
                           for finding in findings) for criterion in ('authorization', 'privacy'))
        evidence = attempt / ('qualification-eval-' + family + '.json')
        write_json(evidence, {'family': family, 'passed': True, 'response': value,
                            'usage': measured, 'limited_fixture': True})
        # Trusted evaluation records an actual passing probe, never an owner declaration.
        module = RUNTIME.parent.parent / 'qualify.ts'
        code = ('import { QualStore } from ' + json.dumps(str(module)) + ';'
                'new QualStore(' + json.dumps(str(attempt / 'state/qualifications.json')) + ').record(' +
                json.dumps({'profileId': 'manual/' + model_label(), 'family': family, 'source': 'eval',
                            'passed': True, 'detail': {'evidence': str(evidence),
                            'scope': 'frozen synthetic fixture; not general correctness'},
                            'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}) + ');')
        code_status, _ = command(attempt, ['rtk', NODE, '--input-type=module', '-e', code], project,
                                 'record-evaluated-' + family)
        assert code_status == 0
        results.append(str(evidence))
    return results


def setup(attempt, project, arm, qualification_file=None):
    code, _ = command(attempt, ['rtk', 'git', '--git-dir=' + str(ROOT / 'seed.git'),
                      'worktree', 'add', '--detach', str(project), BASE], ROOT, 'fresh-worktree')
    if code:
        raise RuntimeError('worktree preparation failed')
    policy = json.loads((project / '.agents/policy.json').read_text())
    policy['enabled'] = arm == 'B'
    policy['sessionChecks'] = False
    policy['jev'] = {'auto': False, 'modes': {'workflow-select': 'disabled',
                     'skill-select': 'disabled', 'retrieval-rerank': 'disabled'}, 'allowSource': False}
    write_json(project / '.agents/policy.json', policy)
    models = {'schemaVersion': 1, 'execution': 'handoff',
              'profiles': {PROFILE: {'kind': 'manual', 'dir': str(attempt / 'exchange'),
                                    'label': model_label(), 'timeoutMs': 600000}},
              'roles': {role: PROFILE for role in ('worker', 'workerStrong', 'architect', 'reviewer')}}
    write_json(project / '.agents/models.json', models)
    code, _ = command(attempt, ['rtk', NODE, str(RUNTIME), 'pin', '--project', str(project)], project, 'pin-runtime')
    if code:
        raise RuntimeError('runtime pin preparation failed')
    code, _ = command(attempt, ['rtk', 'bun', 'install', '--frozen-lockfile'], project, 'dependency-preparation')
    if code:
        raise RuntimeError('dependency installation failed')
    # Tracked setup overlays are identical except the managed enabled boolean.
    (attempt / 'setup-policy.json').write_bytes((project / '.agents/policy.json').read_bytes())
    (attempt / 'setup-models.json').write_bytes((project / '.agents/models.json').read_bytes())
    (attempt / 'setup-pin.json').write_bytes((project / '.agents/runtime.json').read_bytes())
    code, doctor = command(attempt, ['rtk', NODE, str(RUNTIME), 'doctor', '--project', str(project)], project, 'doctor')
    text = doctor.read_text()
    assert code == 0 and ('workflow             ON' if arm == 'B' else 'workflow             OFF') in text
    code, _ = command(attempt, ['rtk', NODE, str(RUNTIME), 'jev', 'status', '--project', str(project)], project, 'jev-state')
    assert code == 0
    if arm == 'B' and qualification_file:
        (attempt / 'state/qualifications.json').write_bytes(qualification_file.read_bytes())
    if arm == 'B' and not qualification_file:
        code = serve(attempt, project, ['qualify', PROFILE])
        if code:
            raise RuntimeError('managed worker action-protocol qualification failed')
        capability_evals(attempt, project)
    log(attempt, 'arm_setup_ready', arm=arm, qualifications=('prepared evaluated probes' if qualification_file else 'fresh evaluated probes') if arm == 'B' else 'not needed')


def final_candidate(attempt, project, arm):
    if arm == 'B':
        candidates = sorted((attempt / 'state/tasks').glob('*/candidate'))
        if candidates:
            return candidates[-1]
        for meta in (attempt / 'state/tasks').glob('*/meta.json'):
            value = json.loads(meta.read_text())
            candidate = pathlib.Path(value.get('candidate', ''))
            if candidate.is_absolute() and candidate.exists():
                return candidate
    return project


def patch(attempt, candidate):
    # Runtime candidates may have no .git; emit exact file diffs against frozen sources.
    # RTK proxy is necessary here: condensed diffs are unusable as patch artifacts.
    from grade import fingerprint
    target = attempt / 'final.patch'
    original = ROOT / 'baseline'
    before = fingerprint(original)
    after = fingerprint(candidate)
    with target.open('wb') as stream:
        for name in sorted(set(before) | set(after)):
            if before.get(name) != after.get(name) and not name.startswith('.agents/'):
                left = str(original / name) if name in before else '/dev/null'
                right = str(candidate / name) if name in after else '/dev/null'
                subprocess.run(['rtk', 'proxy', 'git', 'diff', '--no-index', '--binary', left, right],
                               stdout=stream, stderr=subprocess.STDOUT)


def run_one(index, trial, arm, protocol="discovery-v1", config=None, preparation=None):
    config = config or settings(ROOT)
    limits = config["limits"]
    shared = shared_contract.load(ROOT) if protocol == "shared-contract-v1" else None
    attempt = ROOT / 'attempts' / (f'{index:02d}' + arm)
    attempt.mkdir()
    (attempt / 'state').mkdir()
    (attempt / 'calls').mkdir()
    project = attempt / 'worktree'
    started = time.monotonic()
    start_phase(attempt, 'workflow', limits['workflow_seconds'], limits['workflow_tokens'])
    log(attempt, 'attempt_started', trial=trial, arm=arm)
    print(f'START pair {trial} arm {arm}: {attempt}', flush=True)
    failure = None
    try:
        setup(attempt, project, arm, preparation["qualification_file"] if preparation and arm == "B" else None)
        common = (ROOT / 'worker-ticket.md').read_text()
        common += ('\n\nCoordinator authorization: resolve routine implementation choices from the '
                   'frozen requirements and project rules; save a concrete blueprint before code. '
                   'This benchmark authorizes compatible implementation plans and the explicit '
                   'approval/acceptance commands. Stop on genuine unresolved requirements or '
                   'refused protected changes; do not bypass them. Never purchase credits, switch '
                   'models/providers, invoke another model, or use an API key. Use your assigned '
                   'native session only. No subagents. Do not inspect benchmark scripts other than '
                   'the broker usage below, other attempt directories, native session stores or '
                   'memory from previous work. No shared database mutations or real notifications. '
                   'Use dedicated synthetic local fixtures and ports, not the original repo servers. '
                   f"External attempt ceilings including setup are {limits['workflow_seconds']} seconds and "
                   f"{limits['workflow_tokens']} aggregate native tokens. Required relevant checks stay unchanged. No task-budget resets. "
                   'Keep every incomplete candidate and report it honestly.\n')
        if arm == 'A':
            common += 'Arm A: managed execution is OFF. Implement through normal direct development and ordinary project skills/checks.\n'
        else:
            common += ('Arm B: managed execution is ON. Use normal task create, preflight, '
                       'run, plan approval, independent review, verification, acceptance and export. '
                       'Same-model fresh capabilities have been evaluated; do not declare new ones. '
                       'The normal manual packet exchange is served by this automation: prefix '
                       'runtime commands that wait for model packets with `rtk python3 ' + str(pathlib.Path(__file__).with_name('broker.py')) +
                       '`, followed by ordinary command arguments, such as `task run <id>`. '
                       'This invokes the pinned CLI and serves packets; it does not change the '
                       'workflow. Non-waiting commands may use `rtk node scripts/agentic.mjs`. '
                       'Put contracts outside the source tree under your AGENTIC_HOME. '
                       'Use an agreed concrete contract plan to avoid redundant architect generation '
                       'when normal guidance permits. Keep all acceptance criteria. You may select '
                       'an initial contract token budget within the external attempt ceiling; '
                       'native chat/qualification overhead also counts externally. Do not implement '
                       'source code directly when a managed task refuses.\n')
        if shared and arm == 'B':
            reply = shared_contract.run_managed(attempt, project, shared)
        else:
            if shared:
                common += shared_contract.unmanaged_prompt(shared)
            reply, _ = native_call(attempt, project, 'coordinator-worker', common)
        (attempt / 'worker-final.txt').write_text(reply)
    except Exception as error:
        failure = str(error)
        log(attempt, 'attempt_failed', reason=failure)
    stop_remaining_processes(attempt)
    ready = time.monotonic()
    tokens = attempt_tokens(attempt)
    candidate = final_candidate(attempt, project, arm) if project.exists() else None
    result = {'trial': trial, 'arm': arm, 'index': index, 'workflow_protocol': protocol,
              'shared_preparation_native_tokens': shared['preparation_native_tokens'] if shared else None,
              'qualification_native_tokens': preparation['tokens'] if preparation and arm == 'B' else 0,
              'qualification_wall_seconds': preparation['wall_seconds'] if preparation and arm == 'B' else 0,
              'wall_seconds': ready - started, 'workflow_native_tokens': tokens,
              'actual_billed_usd': None, 'failure_reason': failure,
              'actual_candidate': str(candidate) if candidate else None,
              'human_intervention_count': 0, 'human_active_seconds': None,
              'status': 'failed' if failure else 'candidate_ready'}
    log(attempt, 'candidate_ready_for_grading', **result)
    write_json(attempt / 'result.json', result)
    if candidate:
        try:
            patch(attempt, candidate)
            result['grading'] = grade(attempt, candidate, seconds=limits['grading_seconds'], token_allowance=limits['grading_tokens'])
        except Exception as error:
            result['grading'] = {'correct': False, 'grading_error': str(error)}
        stop_remaining_processes(attempt)
        result['all_native_tokens_including_grading'] = attempt_tokens(attempt)
    write_json(attempt / 'result.json', result)
    print(f'END pair {trial} arm {arm}: correct={result.get("grading", {}).get("correct")} wall={result["wall_seconds"]:.1f}s failure={failure}', flush=True)
    return result


def prepare_qualifications(config):
    # This process, not a chat's retrospective transcript scan, owns every billable preparation call.
    directory = ROOT / 'preparation'
    directory.mkdir()
    attempt = directory / '00P'
    attempt.mkdir()
    (attempt / 'state').mkdir()
    (attempt / 'calls').mkdir()
    limits = config['limits']
    start_phase(attempt, 'preparation', limits['preparation_seconds'], limits['preparation_tokens'])
    started = time.monotonic()
    failure = None
    try:
        setup(attempt, attempt / 'worktree', 'B')
        reason = stop_reason(attempt)
        if reason:
            raise RuntimeError(reason)
    except Exception as error:
        failure = str(error)
    finally:
        stop_remaining_processes(attempt)
    result = {'tokens': attempt_tokens(attempt), 'wall_seconds': time.monotonic() - started,
              'failure': failure, 'qualification_file': str(attempt / 'state/qualifications.json')}
    write_json(directory / 'result.json', result)
    if failure:
        raise RuntimeError('supervised qualification preparation failed; no arms launched: ' + failure)
    return {**result, 'qualification_file': pathlib.Path(result['qualification_file'])}


def main(argv):
    if argv not in (['--preflight'], ['--execute']):
        raise ValueError('Use --preflight (no inference) or --execute (live inference); no implicit launch')
    config = preflight(ROOT)
    if argv == ['--preflight']:
        print(json.dumps({'ready': True, 'mode': config['mode'], 'limits': config['limits'],
                          'pairs': len(config['trial_order']['paired_orders']),
                          'jev': 'disabled/inactive', 'model_calls': 0}, indent=2))
        return
    profile = load_profile(ROOT)
    if profile['kind'] == 'codex-cli':
        packet_context.prepare(ROOT)
    with (ROOT / 'native-profile.frozen.json').open('x') as stream:
        json.dump(profile, stream, indent=2)
    # All execution limits are resolved once; workers cannot change them midway.
    write_json(ROOT / 'execution-settings.json', config)
    protocol = config['workflow_protocol']
    if protocol == 'shared-contract-v1':
        shared_contract.freeze(ROOT)
    preparation = prepare_qualifications(config) if config['mode'] == 'quick-pilot-v1' else None
    (ROOT / 'attempts').mkdir()
    results = []
    index = 0
    for trial, order in enumerate(config['trial_order']['paired_orders'], 1):
        for arm in order:
            index += 1
            results.append(run_one(index, trial, arm, protocol, config, preparation))
            write_json(ROOT / 'results.json', results)
    print(f'ALL {len(results)} ATTEMPTS RECORDED', flush=True)


if __name__ == '__main__':
    if not os.environ.get('BENCHMARK_ROOT'):
        raise SystemExit('Set BENCHMARK_ROOT to a NEW prepared experiment directory; never reuse evidence.')
    try:
        main(sys.argv[1:])
    except (ValueError, RuntimeError, OSError, KeyError) as error:
        raise SystemExit(str(error))
