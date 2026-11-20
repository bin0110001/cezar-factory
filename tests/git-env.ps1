# Isolates the test suite from an inherited git environment (issue #758). The promoter runs the suite in a detached
# worktree inside the Cezar container, where a different user/HOME, GIT_* variables or an untrusted-owner worktree
# make git exit 128 for check-ignore and for nested fixture repositories. Dot-source this before running any git.
foreach ($name in 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM') {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}
# safe.directory is only honoured from protected scopes; command-line config (GIT_CONFIG_COUNT) is one, and it is
# inherited by every fixture repository the suite creates.
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'safe.directory'
$env:GIT_CONFIG_VALUE_0 = '*'
