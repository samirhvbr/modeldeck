# >>> ModelDeck Claude identity switching >>>
_modeldeck_claude_env="${MODELDECK_CLAUDE_SHELL_ENV_FILE:-$HOME/Library/Application Support/ModelDeck/claude-env.sh}"
if [ -f "$_modeldeck_claude_env" ]; then
  . "$_modeldeck_claude_env"
fi
unset _modeldeck_claude_env
# <<< ModelDeck Claude identity switching <<<

# >>> ModelDeck Codex identity switching >>>
if [ -z "${CODEX_HOME:-}" ]; then
  _modeldeck_codex_home="$(readlink ~/.codex 2>/dev/null || true)"
  if [ -n "$_modeldeck_codex_home" ]; then
    case "$_modeldeck_codex_home" in
      /*) ;;
      *) _modeldeck_codex_home="$HOME/$_modeldeck_codex_home" ;;
    esac
    export CODEX_HOME="$_modeldeck_codex_home"
  fi
  unset _modeldeck_codex_home
fi
# <<< ModelDeck Codex identity switching <<<
