"""Fail-closed preparation launch guard; no inference or credentials of its own."""
import argparse
import datetime
import json
import pathlib
import subprocess
import time

from harness import terminate, write_json


def records(path):
    lines = pathlib.Path(path).read_text().splitlines(keepends=True)
    rows = []
    for index, line in enumerate(lines):
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            if index != len(lines) - 1 or line.endswith("\n"):
                raise ValueError("invalid settled session record")
    return rows


def counters(value):
    keys = ("input_tokens", "cached_input_tokens", "output_tokens", "total_tokens")
    if not isinstance(value, dict) or any(type(value.get(k)) is not int or value[k] < 0 for k in keys):
        raise ValueError("missing or invalid native accounting")
    if value["total_tokens"] != value["input_tokens"] + value["output_tokens"]:
        raise ValueError("aggregate must include cached input exactly once")
    if value["cached_input_tokens"] > value["input_tokens"]:
        raise ValueError("cached input exceeds input")
    return {k: value[k] for k in keys}


def session_usage(path, boundary):
    baseline = latest = None
    found = False
    for row in records(path):
        payload = row.get("payload", {})
        if row.get("timestamp") == boundary:
            if row.get("type") != "response_item" or payload.get("role") != "user":
                raise ValueError("boundary must identify an exact user response_item")
            if found:
                raise ValueError("ambiguous boundary")
            baseline, found = latest, True
        if payload.get("type") == "token_count":
            value = counters((payload.get("info") or {}).get("total_token_usage"))
            if latest and any(value[k] < latest[k] for k in value):
                raise ValueError("native counters rolled back")
            latest = value
    if not found or baseline is None or latest is None:
        raise ValueError("boundary or baseline accounting unavailable")
    return baseline, latest


def create(directory, session, boundary, seconds=300, tokens=200000):
    directory = pathlib.Path(directory)
    if directory.exists():
        raise ValueError("refusing preparation reset; use a newly authorized experiment")
    if seconds <= 0 or tokens <= 0:
        raise ValueError("limits must be positive")
    baseline, latest = session_usage(session, boundary)
    started = datetime.datetime.fromisoformat(boundary.replace("Z", "+00:00")).timestamp()
    elapsed = max(0, time.time() - started)
    directory.mkdir(parents=True)
    config = {"session": str(pathlib.Path(session).resolve()), "boundary": boundary,
              "baseline": baseline, "seconds": seconds, "tokens": tokens,
              "deadline_utc": started + seconds,
              "deadline_monotonic": time.monotonic() + max(0, seconds - elapsed)}
    write_json(directory / "configuration.json", config)
    return check(directory)


def check(directory, reserve=0, additional_receipts=()):
    directory = pathlib.Path(directory)
    if type(reserve) is not int or reserve < 0:
        raise ValueError("reserve must be a nonnegative integer")
    stopped = directory / "stopped.json"
    if stopped.exists():
        return json.loads(stopped.read_text())
    config = json.loads((directory / "configuration.json").read_text())
    try:
        baseline, latest = session_usage(config["session"], config["boundary"])
        if baseline != config["baseline"]:
            raise ValueError("baseline changed")
        delta = {k: latest[k] - baseline[k] for k in latest}
        seen = set()
        for path in additional_receipts:
            path = pathlib.Path(path).resolve()
            if path in seen or path == pathlib.Path(config["session"]):
                raise ValueError("duplicate accounting source")
            seen.add(path)
            extra = counters(json.loads(path.read_text()).get("tokens"))
            delta = {k: delta[k] + extra[k] for k in delta}
        delta["uncached_input_tokens"] = delta["input_tokens"] - delta["cached_input_tokens"]
        previous_path = directory / "latest-check.json"
        if previous_path.exists():
            previous = json.loads(previous_path.read_text())
            if not set(previous.get("additional_receipts", [])).issubset({str(p) for p in seen}):
                raise ValueError("previously counted receipt omitted")
            if any(delta[k] < previous["tokens"][k] for k in delta):
                raise ValueError("aggregate counters rolled back")
        reason = None
        if time.time() >= config["deadline_utc"] or time.monotonic() >= config["deadline_monotonic"]:
            reason = "preparation wall-time ceiling reached"
        elif delta["total_tokens"] >= config["tokens"]:
            reason = "preparation token ceiling reached"
        elif delta["total_tokens"] + reserve > config["tokens"]:
            reason = "insufficient reserved headroom for another call"
        result = {"allowed": reason is None, "reason": reason, "tokens": delta,
                  "reserve": reserve, "additional_receipts": sorted(str(p) for p in seen)}
    except (ValueError, OSError, KeyError, TypeError) as error:
        result = {"allowed": False, "reason": "accounting unavailable: " + str(error)}
    write_json(directory / "latest-check.json", result)
    if not result["allowed"]:
        write_json(stopped, result)
    return result


def supervise(directory, argv, reserve, receipt_paths=(), poll_seconds=0.1):
    """Caller supplies every separate qualification/Jev receipt, never the controller twice."""
    receipt_paths = tuple(pathlib.Path(p) for p in receipt_paths)
    # Receipts may not exist before a new process. Absence after spawning fails closed.
    existing = [p for p in receipt_paths if p.exists()]
    result = check(directory, reserve, existing)
    if not result["allowed"]:
        return result
    child = subprocess.Popen(argv, start_new_session=True)
    try:
        while child.poll() is None:
            result = check(directory, 0, receipt_paths)
            if not result["allowed"]:
                terminate(child)
                return result
            time.sleep(poll_seconds)
        result = check(directory, 0, receipt_paths)
        return {**result, "exit_code": child.wait()}
    finally:
        terminate(child)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    parser.add_argument("--session", type=pathlib.Path)
    parser.add_argument("--boundary")
    parser.add_argument("--reserve", type=int, default=0)
    parser.add_argument("--receipt", action="append", default=[])
    parser.add_argument("--run", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if args.session or args.boundary:
        if not args.session or not args.boundary:
            parser.error("initialization needs both --session and --boundary")
        create(args.directory, args.session, args.boundary)
    result = (supervise(args.directory, args.run, args.reserve, args.receipt) if args.run else
              check(args.directory, args.reserve, args.receipt))
    print(json.dumps(result, indent=2))
    code = result.get("exit_code", 0)
    return (code if code >= 0 else 128 - code) if result["allowed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
