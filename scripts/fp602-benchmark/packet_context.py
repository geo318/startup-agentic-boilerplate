"""Inspect and trim ambient context for self-contained runtime packets, without inference."""
import json
import os
from pathlib import Path
import re
import subprocess


def messages(rows):
    return '\n'.join(item.get('text', '') for row in rows for item in row.get('content', []))


def skill_paths(text):
    roots = dict(re.findall(r'- `(r\d+)` = `([^`]+)`', text))
    paths = []
    for name in re.findall(r'\(file: ([^\n)]+)\)', text):
        alias, _, rest = name.partition('/')
        paths.append(str(Path(roots[alias]) / rest) if alias in roots else name)
    return sorted(set(paths))


def prepare(root):
    workspace = root / 'packet-workspace'
    workspace.mkdir(exist_ok=True)
    config = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'config.toml'
    # Only names are extracted. Provider settings and credentials stay in the native CLI.
    script = ('const p=process.argv[1]; const f=Bun.file(p); '
              'const c=await f.exists()?Bun.TOML.parse(await f.text()):{}; '
              'console.log(JSON.stringify({plugins:Object.keys(c.plugins??{}),'
              'mcp_servers:Object.keys(c.mcp_servers??{})}));')
    keys = json.loads(subprocess.check_output(['rtk', 'proxy', 'bun', '-e', script, str(config)], text=True))
    overrides = ['project_doc_max_bytes=0', 'features.apps=false', 'features.memories=false',
                 'web_search="disabled"']
    for section, names in keys.items():
        for name in names:
            if '.' in name or '=' in name:
                raise ValueError('cannot safely override native configuration key: ' + section + '.' + name)
            overrides.append(section + '.' + name + '.enabled=false')

    def inspect():
        argv = ['rtk', 'proxy', 'codex', '-C', str(workspace), 'debug', 'prompt-input']
        for override in overrides:
            argv += ['-c', override]
        result = subprocess.run(argv + ['Return only the supplied packet JSON.'], capture_output=True,
                                text=True, timeout=30)
        if result.returncode:
            raise RuntimeError('offline packet inspection failed: ' + result.stderr[-2000:])
        return messages(json.loads(result.stdout))

    before = inspect()
    paths = skill_paths(before)
    overrides.append('skills.config=[' + ','.join('{path=' + json.dumps(p) + ',enabled=false}'
                                                for p in paths) + ']')
    after = inspect()
    if '<skills_instructions>' in after or 'AGENTS.md instructions for ' in after:
        raise RuntimeError('offline packet inspection still contains skills or repository instructions')
    result = {'version': 1, 'workspace': str(workspace), 'overrides': overrides,
              'ambient_message_bytes_before': len(before.encode()),
              'ambient_message_bytes_after': len(after.encode()), 'model_calls': 0,
              'note': 'Message bytes only; excludes native base instructions and tool schemas. Not token usage.'}
    (root / 'packet-context.json').write_text(json.dumps(result, indent=2) + '\n')
    return result
