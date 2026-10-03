"""Explicit native-session configuration. Model names never select a transport."""
import hashlib
import json
import pathlib
import re


def load_profile(root):
    path = root / "native-profile.json"
    if not path.exists():
        raise RuntimeError("Create native-profile.json with an explicit adapter, model and provider; no model is selected by default")
    profile = json.loads(path.read_text())
    if not isinstance(profile, dict):
        raise ValueError("native profile must be an object")
    kind = profile.get("kind")
    common = {"kind", "model", "provider", "reasoning_effort"}
    allowed = common | ({"namespace_headers"} if kind == "codex-cli" else {"argv"})
    if kind not in ("codex-cli", "command") or set(profile) - allowed:
        raise ValueError("native profile must select codex-cli or command with supported fields")
    for field in ("model", "provider"):
        if not isinstance(profile.get(field), str) or not profile[field].strip():
            raise ValueError("native profile requires an explicit " + field)
    if "reasoning_effort" in profile and (not isinstance(profile["reasoning_effort"], str) or not profile["reasoning_effort"]):
        raise ValueError("reasoning_effort must be a nonempty string when supplied")
    if kind == "codex-cli":
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", profile["provider"]):
            raise ValueError("invalid Codex provider configuration key")
        if "namespace_headers" in profile and not isinstance(profile["namespace_headers"], bool):
            raise ValueError("namespace_headers must be boolean")
    else:
        argv = profile.get("argv")
        if not isinstance(argv, list) or not argv or not all(isinstance(v, str) and v for v in argv):
            raise ValueError("command adapter requires an argv array")
        if not any("{request}" in arg for arg in argv):
            raise ValueError("command argv must include {request}")
    frozen = root / "native-profile.frozen.json"
    if frozen.exists() and json.loads(frozen.read_text()) != profile:
        raise RuntimeError("native profile changed during the experiment; start a new experiment")
    return profile


def profile_label(profile):
    digest = hashlib.sha256(json.dumps(profile, sort_keys=True).encode()).hexdigest()[:16]
    return profile["kind"] + "/" + profile["model"] + "/" + digest


def codex_args(profile, project, prefix, readonly, schema, attempt_name):
    args = ["rtk", "codex", "exec", "--json", "--skip-git-repo-check", "--color", "never",
            "-m", profile["model"], "-c", "model_provider=" + json.dumps(profile["provider"]),
            "-c", "features.memories=false", "-c", 'approval_policy="never"']
    if profile.get("reasoning_effort"):
        args += ["-c", "model_reasoning_effort=" + json.dumps(profile["reasoning_effort"])]
    if profile.get("namespace_headers"):
        namespace = json.dumps("fp602-" + attempt_name)
        headers = '{"x-headroom-project-id"=' + namespace + ',"x-headroom-user-id"=' + namespace + '}'
        args += ["-c", "model_providers." + profile["provider"] + ".http_headers=" + headers]
    args += ["-s", "read-only" if readonly else "danger-full-access", "-C", str(project),
             "-o", str(prefix.with_suffix(".reply.txt"))]
    if schema:
        args += ["--output-schema", str(schema)]
    return args + ["-"]


def command_args(profile, project, prefix, prompt, readonly, schema):
    request = prefix.with_suffix(".request.json")
    request.write_text(json.dumps({
        "model": profile["model"], "provider": profile["provider"],
        "reasoning_effort": profile.get("reasoning_effort"),
        "project": str(project), "prompt": prompt, "readonly": readonly,
        "session_namespace": "fp602-" + prefix.parent.parent.name,
        "schema": json.loads(pathlib.Path(schema).read_text()) if schema else None,
        "reply_path": str(prefix.with_suffix(".reply.txt")),
        "usage_path": str(prefix.with_suffix(".usage.json")),
    }, indent=2))
    return [arg.replace("{request}", str(request)) for arg in profile["argv"]]


def validate_command_usage(path):
    if not path.exists():
        raise RuntimeError("command adapter did not report native usage; refusing unmetered continuation")
    receipt = json.loads(path.read_text())
    tokens = receipt.get("tokens") or {}
    for key in ("input_tokens", "output_tokens", "total_tokens"):
        if type(tokens.get(key)) is not int or tokens[key] < 0:
            raise RuntimeError("command adapter must report nonnegative integer " + key)
    if tokens["total_tokens"] != tokens["input_tokens"] + tokens["output_tokens"]:
        raise RuntimeError("command adapter total must include all input (including cached) plus output")
    return receipt
