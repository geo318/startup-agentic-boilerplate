"""Native Codex sessions and attempt-wide watchdogs; no API billing estimates."""
import datetime
import json
import os
import pathlib
import signal
import shutil
import subprocess
import time
import uuid
from native_profile import load_profile, codex_args, command_args, validate_command_usage

ROOT = pathlib.Path(os.environ.get('BENCHMARK_ROOT', '.')).resolve()
NODE = shutil.which('node') or 'node'
RUNTIME = pathlib.Path(__file__).resolve().parents[2] / 'packages/agent-runtime/src/cli/main.ts'
BASE = 'e406ab40c00566a0f73f2e751bd0df3b2668375a'


def start_phase(attempt, phase, seconds, token_allowance):
    """A fixed incremental allowance, including settled cached input, per phase."""
    settings = {'phase': phase, 'started_monotonic': time.monotonic(),
                'started_utc_seconds': time.time(), 'seconds': seconds,
                'token_start': attempt_tokens(attempt), 'token_allowance': token_allowance}
    settings['deadline_monotonic'] = settings['started_monotonic'] + seconds
    settings['deadline_utc_seconds'] = settings['started_utc_seconds'] + seconds
    settings['token_ceiling'] = settings['token_start'] + token_allowance
    # Retain immutable phase limits separately from the active watchdog settings.
    phase_path = attempt / (phase + '-settings.json')
    with phase_path.open('x') as stream:
        json.dump(settings, stream, indent=2)
    write_json(attempt / 'settings.json', settings)
    return settings


def write_json(path, value):
    path = pathlib.Path(path)
    temporary = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def log(attempt, kind, **fields):
    row = {'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'monotonic': time.monotonic(), 'kind': kind, **fields}
    with (attempt / 'events.jsonl').open('a') as stream:
        stream.write(json.dumps(row) + '\n')


def clean_env(attempt):
    env = dict(os.environ)
    for key in ('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'JEV_API_KEY',
                'GOOGLE_API_KEY', 'GEMINI_API_KEY'):
        env.pop(key, None)
    env['AGENTIC_HOME'] = str(attempt / 'state')
    env['PATH'] = str(pathlib.Path(NODE).parent) + ':' + env['PATH']
    env['API_URL'] = 'http://localhost:' + str(3301 + int(attempt.name[:2]) * 10)
    env['BENCHMARK_ATTEMPT'] = str(attempt)
    return env


def usage(path):
    total = None
    rates = None
    context = None
    calls = 0
    for line in path.read_text().splitlines() if path.exists() else []:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        payload = row.get('payload', {})
        if row.get('type') == 'turn_context':
            context = {key: payload.get(key) for key in ('model', 'effort', 'model_provider')}
        if payload.get('type') == 'token_count':
            if (payload.get('info') or {}).get('total_token_usage'):
                total = payload['info']['total_token_usage']
                calls += 1
            rates = payload.get('rate_limits') or rates
    return {'tokens': total, 'rate_limits': rates, 'turn_context': context,
            'token_count_events': calls, 'actual_billed_usd': None}


def native_path(session_id):
    codex_home = pathlib.Path(os.environ.get('CODEX_HOME', pathlib.Path.home() / '.codex'))
    files = list((codex_home / 'sessions').glob('**/*' + session_id + '*.jsonl'))
    return files[0] if len(files) == 1 else None


def attempt_tokens(attempt):
    total = 0
    for path in (attempt / 'calls').glob('*.usage.json'):
        value = json.loads(path.read_text()).get('tokens')
        if value:
            total += value.get('total_tokens', value.get('input_tokens', 0) + value.get('output_tokens', 0))
    return total


def stop_reason(attempt):
    settings = json.loads((attempt / 'settings.json').read_text())
    if (time.monotonic() >= settings['deadline_monotonic'] or
            time.time() >= settings.get('deadline_utc_seconds', float('inf'))):
        return 'external wall-time ceiling reached'
    if attempt_tokens(attempt) >= settings['token_ceiling']:
        return 'external aggregate native-token ceiling reached'
    for path in (attempt / 'calls').glob('*.usage.json'):
        rates = json.loads(path.read_text()).get('rate_limits') or {}
        credits = rates.get('credits') or {}
        if credits.get('has_credits') or credits.get('unlimited'):
            return 'paid-credit state changed; stop before using paid allowance'
        if rates.get('spend_control_reached') or rates.get('rate_limit_reached_type'):
            return 'native subscription quota exhausted'
    return None


def terminate(child):
    if child.poll() is None:
        # Every supervised process is its own group; stop its shell/job descendants too.
        os.killpg(child.pid, signal.SIGINT)
        try:
            child.wait(timeout=4)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()


def register_process(attempt, child):
    directory = attempt / 'active-processes'
    directory.mkdir(exist_ok=True)
    path = directory / (str(child.pid) + '.json')
    write_json(path, {'pid': child.pid, 'registered_monotonic': time.monotonic()})
    return path


def stop_remaining_processes(attempt):
    for path in (attempt / 'active-processes').glob('*.json'):
        pid = json.loads(path.read_text())['pid']
        try:
            if os.getpgid(pid) == pid:
                os.killpg(pid, signal.SIGINT)
        except ProcessLookupError:
            pass
    time.sleep(1)
    for path in (attempt / 'active-processes').glob('*.json'):
        pid = json.loads(path.read_text())['pid']
        try:
            if os.getpgid(pid) == pid:
                os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        path.unlink(missing_ok=True)


def native_call(attempt, project, label, prompt, readonly=False, schema=None):
    reason = stop_reason(attempt)
    if reason:
        raise RuntimeError(reason)
    calls = attempt / 'calls'
    calls.mkdir(exist_ok=True)
    identity = label + '-' + uuid.uuid4().hex[:8]
    prefix = calls / identity
    prompt_path = prefix.with_suffix('.prompt.txt')
    prompt_path.write_text(prompt)
    profile = load_profile(ROOT)
    args = (codex_args(profile, project, prefix, readonly, schema, attempt.name)
            if profile["kind"] == "codex-cli" else
            command_args(profile, project, prefix, prompt, readonly, schema))
    started = time.monotonic()
    log(attempt, 'native_call_started', identity=identity, label=label,
        requested_model=profile["model"], requested_effort=profile.get("reasoning_effort"),
        requested_provider=profile["provider"], adapter=profile["kind"], argv=args)
    session_id = None
    native = None
    reason = None
    with prompt_path.open() as input_stream, prefix.with_suffix('.exec.jsonl').open('w') as output, prefix.with_suffix('.stderr.log').open('w') as errors:
        child = subprocess.Popen(args, stdin=input_stream, stdout=output, stderr=errors,
                                 env=clean_env(attempt), cwd=project, start_new_session=True)
        registration = register_process(attempt, child)
        try:
            while child.poll() is None:
                if profile["kind"] == "codex-cli" and session_id is None:
                    for line in prefix.with_suffix('.exec.jsonl').read_text().splitlines():
                        try:
                            event = json.loads(line)
                        except ValueError:
                            continue
                        if event.get('type') == 'thread.started':
                            session_id = event['thread_id']
                            break
                if session_id and native is None:
                    native = native_path(session_id)
                if native:
                    write_json(prefix.with_suffix('.usage.json'), usage(native))
                if profile['kind'] == 'command' and prefix.with_suffix('.usage.json').exists():
                    validate_command_usage(prefix.with_suffix('.usage.json'))
                reason = stop_reason(attempt)
                if reason:
                    terminate(child)
                    break
                time.sleep(0.5)
            code = child.wait()
        except (RuntimeError, ValueError) as error:
            reason = str(error)
        finally:
            terminate(child)
            code = child.wait()
            registration.unlink(missing_ok=True)
    # A short process may finish before the first polling iteration discovers its session.
    if profile["kind"] == "codex-cli" and native is None:
        for line in prefix.with_suffix('.exec.jsonl').read_text().splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get('type') == 'thread.started':
                session_id = event['thread_id']
                native = native_path(session_id)
                break
    if native:
        prefix.with_suffix('.native.jsonl').write_bytes(native.read_bytes())
        write_json(prefix.with_suffix('.usage.json'), usage(native))
    elif profile["kind"] == "codex-cli":
        write_json(prefix.with_suffix('.usage.json'), {'tokens': None, 'actual_billed_usd': None,
                   'native_session_unavailable': True})
        if code == 0:
            reason = reason or 'native session usage unavailable; refusing unmetered continuation'
    if profile['kind'] == 'command':
        try:
            validate_command_usage(prefix.with_suffix('.usage.json'))
        except (RuntimeError, ValueError) as error:
            reason = reason or str(error)
    reason = reason or stop_reason(attempt)
    reply_path = prefix.with_suffix('.reply.txt')
    reply = reply_path.read_text() if reply_path.exists() else ''
    log(attempt, 'native_call_finished', identity=identity, label=label, session_id=session_id,
        exit_code=code, reason=reason, wall_seconds=time.monotonic() - started,
        evidence=str(prefix))
    if reason or code != 0:
        raise RuntimeError(reason or 'native harness failed with exit code ' + str(code))
    return reply, json.loads(prefix.with_suffix('.usage.json').read_text())


def command(attempt, argv, project, label):
    reason = stop_reason(attempt)
    if reason:
        raise RuntimeError(reason)
    started = time.monotonic()
    output = attempt / (label + '-' + uuid.uuid4().hex[:6] + '.log')
    log(attempt, 'command_started', label=label, argv=argv, evidence=str(output))
    with output.open('w') as stream:
        child = subprocess.Popen(argv, cwd=project, env=clean_env(attempt), stdout=stream,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        registration = register_process(attempt, child)
        try:
            while child.poll() is None:
                reason = stop_reason(attempt)
                if reason:
                    raise RuntimeError(reason)
                time.sleep(0.5)
            code = child.wait()
        finally:
            terminate(child)
            registration.unlink(missing_ok=True)
    log(attempt, 'command_finished', label=label, exit_code=code,
        wall_seconds=time.monotonic() - started, evidence=str(output))
    return code, output
