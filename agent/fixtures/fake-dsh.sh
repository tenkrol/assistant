#!/bin/sh
# Run the fake dsh under the Node the test suite uses.
#
# The runner spawns its command directly (no shell), so this wrapper keeps the
# fixture usable as a stand-alone executable: FAKE_DSH_NODE holds the interpreter.
exec "${FAKE_DSH_NODE:-node}" "$(dirname "$0")/fake-dsh.mjs" "$@"
