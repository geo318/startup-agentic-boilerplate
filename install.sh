#!/bin/sh
# Install the project-setup skill for Claude Code.
#
#   ./install.sh --global [--link]        → ~/.claude/skills/project-setup (every project)
#   ./install.sh <project-dir> [--link]   → <project-dir>/.claude/skills/project-setup
#
# --link symlinks instead of copying, so edits in this repo apply immediately.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
source_dir="$here/project-setup"

case "${1:-}" in
  --global | -g) dest="$HOME/.claude/skills/project-setup" ;;
  "" | -h | --help)
    sed -n '2,8p' "$0"
    exit 1
    ;;
  *)
    [ -d "$1" ] || { echo "not a directory: $1" >&2; exit 1; }
    dest="$(cd "$1" && pwd)/.claude/skills/project-setup"
    ;;
esac

if [ -e "$dest" ] || [ -L "$dest" ]; then
  echo "already installed: $dest (remove it first to reinstall)" >&2
  exit 1
fi

mkdir -p "$(dirname "$dest")"
if [ "${2:-}" = "--link" ]; then
  ln -s "$source_dir" "$dest"
else
  cp -R "$source_dir" "$dest"
fi
echo "installed → $dest"
echo "In Claude Code, from the new project's directory: /project-setup path/to/plan.md"
