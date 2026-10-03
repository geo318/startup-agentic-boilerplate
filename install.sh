#!/bin/sh
# Install the shared project-setup skill, with a Claude Code compatibility link.
#
#   ./install.sh --global [--link]        → ~/.agents/skills/project-setup (every project)
#   ./install.sh <project-dir> [--link]   → <project-dir>/.agents/skills/project-setup
#
# --link symlinks instead of copying, so edits in this repo apply immediately.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
source_dir="$here/project-setup"

case "${1:-}" in
  --global | -g) target="$HOME" ;;
  "" | -h | --help)
    sed -n '2,8p' "$0"
    exit 1
    ;;
  *)
    [ -d "$1" ] || { echo "not a directory: $1" >&2; exit 1; }
    target="$(cd "$1" && pwd)"
    ;;
esac

dest="$target/.agents/skills/project-setup"
claude_link="$target/.claude/skills/project-setup"
for path in "$dest" "$claude_link"; do
  if [ -e "$path" ] || [ -L "$path" ]; then
    echo "already installed: $path (move it aside first to reinstall)" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$dest")"
if [ "${2:-}" = "--link" ]; then
  ln -s "$source_dir" "$dest"
else
  cp -R "$source_dir" "$dest"
fi
mkdir -p "$(dirname "$claude_link")"
ln -s ../../.agents/skills/project-setup "$claude_link"
echo "installed → $dest"
echo "Claude Code link → $claude_link"
echo 'Invoke project-setup with your plan (Codex: $project-setup; Claude Code: /project-setup).'
