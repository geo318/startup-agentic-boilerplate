"""Frozen independent grading algorithm; implementation adapters may vary, criteria may not."""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import time
from harness import BASE, ROOT, command, log, native_call, start_phase, write_json

CHECKS = [
    ('lint', ['rtk', 'bun', 'run', 'lint']),
    ('typecheck', ['rtk', 'bun', 'run', 'typecheck']),
    ('unit', ['rtk', 'bunx', 'vitest', 'run', '--project', 'unit']),
    ('e2e', ['rtk', 'bun', 'run', 'test:e2e']),
    ('fallow', ['rtk', 'bun', 'run', 'fallow']),
    ('docs', ['rtk', 'bun', 'scripts/checks/docs-check.mjs']),
]


def fingerprint(project):
    import os
    excluded = {'.git', 'node_modules', '.next', '.turbo', '__pycache__', 'dist', 'coverage',
                'test-results', 'playwright-report', '.expo'}
    result = {}
    for current, directories, files in os.walk(project):
        directories[:] = [name for name in directories if name not in excluded]
        for name in files:
            path = pathlib.Path(current) / name
            if name != '.git' and path.is_file() and not name.endswith('.tsbuildinfo'):
                result[str(path.relative_to(project))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def generated(name):
    # Explicit outputs observed in the original run; do not ignore arbitrary source.
    return (name.startswith(('.fallow/', 'temp/playwright/')) or
            name == 'apps/web/next-env.d.ts')


def prepare_candidate(attempt, candidate):
    project = attempt / 'grading-workspace'
    # Keep baseline history for git-aware checks without reusing the worker's Git pointer.
    code, evidence = command(attempt, ['rtk', 'git', 'clone', '--no-local', '--no-checkout',
                                      str(ROOT / 'seed.git'), str(project)], attempt, 'grading-git-clone')
    if code:
        raise RuntimeError('grading Git preparation failed: ' + str(evidence))
    code, evidence = command(attempt, ['rtk', 'git', 'reset', '--mixed', BASE], project, 'grading-git-baseline')
    if code:
        raise RuntimeError('grading baseline preparation failed: ' + str(evidence))
    shutil.copytree(candidate, project, symlinks=True,
                    dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('.git', 'node_modules', '.next', '.turbo',
                                                 '.fallow', 'coverage', '__pycache__'))
    code, evidence = command(attempt, ['rtk', 'bun', 'install', '--frozen-lockfile'],
                             project, 'grading-dependencies')
    if code:
        raise RuntimeError('grading dependency preparation failed: ' + str(evidence))
    return project


def grade(attempt, candidate, *, seconds=600, token_allowance=200_000):
    start_phase(attempt, 'grading', seconds, token_allowance)
    start = time.monotonic()
    retained = fingerprint(candidate)
    try:
        project = prepare_candidate(attempt, candidate)
    except Exception as error:
        result = {'correct': False, 'grading_error': str(error), 'criteria': [],
                  'failure_kind': 'preparation', 'actual_candidate': str(candidate),
                  'wall_seconds': time.monotonic() - start}
        write_json(attempt / 'grading.json', result)
        log(attempt, 'independent_grading_finished', correct=False, evidence=str(attempt / 'grading.json'))
        return result
    before = fingerprint(project)
    preparation_changes = [name for name in retained.keys() | before.keys()
                           if retained.get(name) != before.get(name) and not generated(name)]
    gate_results = []
    for name, argv in CHECKS:
        try:
            code, evidence = command(attempt, argv, project, 'independent-grade-' + name)
            gate_results.append({'gate': name, 'exit_code': code, 'evidence': str(evidence)})
        except RuntimeError as error:
            gate_results.append({'gate': name, 'exit_code': None, 'reason': str(error)})
            break
    prompt = (ROOT / 'private-grader/grading-protocol.md').read_text()
    prompt += ('\n\nYou are the independent grader, not the implementer. This is the actual final '
               'candidate in your working directory. Grade only this candidate against the frozen '
               'protocol. Do not inspect worker plans outside the candidate, transcripts, other '
               'attempts, or controller task history. You may inspect actual source and the '
               'independent command logs listed below. Do not edit the candidate or repair it. '
               'Do not infer correctness from passing gates. Use synthetic data only, never '
               'contact real providers or mutate shared databases. If a required connected '
               'path is absent, fail that criterion with source evidence. If runtime behavior '
               'cannot be demonstrated, mark UNVERIFIED. Follow the frozen cases; adaptations '
               'to public interfaces may not change cases or acceptance. Return JSON with '
               'criteria (number 1 through 11, verdict PASS/FAIL/UNVERIFIED, evidence), '
               'regressions (strings), and summary (string). Include every criterion.\n\n'
               'INDEPENDENT CHECKS:\n' + json.dumps(gate_results))
    try:
        reply, _ = native_call(attempt, project, 'independent-grader', prompt, readonly=True)
        result = json.loads(reply)
        criteria = result['criteria']
        assert sorted(value['number'] for value in criteria) == list(range(1, 12))
        assert all(value['verdict'] in ('PASS', 'FAIL', 'UNVERIFIED') and value['evidence'] for value in criteria)
        result['correct'] = all(value['verdict'] == 'PASS' for value in criteria) and not result['regressions']
    except Exception as error:
        result = {'correct': False, 'grading_error': str(error), 'criteria': [],
                  'summary': 'Independent grading incomplete; cannot count a correct completion.'}
    after = fingerprint(project)
    changed = sorted(name for name in before.keys() | after.keys()
                     if before.get(name) != after.get(name))
    unexpected = [name for name in changed if not generated(name)]
    # Passing model prose cannot override a failed or incomplete required gate.
    if len(gate_results) != len(CHECKS) or any(g['exit_code'] != 0 for g in gate_results):
        result['correct'] = False
    if unexpected or preparation_changes or retained != fingerprint(candidate):
        result['correct'] = False
        result['candidate_mutated_during_grading'] = True
    result['grading_workspace_changes'] = changed
    result['unexpected_source_changes'] = unexpected
    result['preparation_source_changes'] = preparation_changes
    result.update({'gate_results': gate_results, 'wall_seconds': time.monotonic() - start,
                   'actual_candidate': str(candidate), 'grading_workspace': str(project),
                   'actual_billed_usd': None})
    write_json(attempt / 'grading.json', result)
    log(attempt, 'independent_grading_finished', correct=result['correct'], evidence=str(attempt / 'grading.json'))
    return result


if __name__ == '__main__':
    print(json.dumps(grade(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))))
