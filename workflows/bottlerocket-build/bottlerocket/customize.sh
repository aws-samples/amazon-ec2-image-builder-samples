#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Wires the aws-ecs-2-custom variant from variants/ into the build: adds it to
# the Cargo workspace and lets it reuse aws-ecs-2's settings packages. Runs
# from the root of a fresh bottlerocket-os/bottlerocket checkout, after the
# rest of this directory has been copied over it.
set -euo pipefail
BASE=aws-ecs-2
NEW=aws-ecs-2-custom

test -f "variants/${NEW}/Cargo.toml" || { echo "variants/${NEW}/Cargo.toml is missing"; exit 1; }
if grep -q "\"variants/${NEW}\"" Cargo.toml; then
  echo "${NEW} is already wired in - expected a fresh checkout"
  exit 1
fi

python3 - "$BASE" "$NEW" <<'PY'
import sys
base, new = sys.argv[1], sys.argv[2]

def edit(path, *pairs):
    # Every replacement must apply exactly once - a format change upstream
    # fails the build instead of silently dropping the variant's wiring.
    with open(path) as f:
        s = f.read()
    for old, repl in pairs:
        if s.count(old) != 1:
            sys.exit(f"{path}: expected exactly one match for {old!r}")
        s = s.replace(old, repl)
    with open(path, "w") as f:
        f.write(s)

# Register the variant crate in the top-level Cargo workspace.
edit("Cargo.toml",
     (f'    "variants/{base}",\n', f'    "variants/{base}",\n    "variants/{new}",\n'))

# The image build resolves the settings packages by variant name - reuse the
# base variant's defaults and plugins.
for spec, kind in (("packages/settings-defaults/settings-defaults.spec", "settings-defaults"),
                   ("packages/settings-plugins/settings-plugins.spec", "settings-plugin")):
    edit(spec,
         (f"%{{_cross_os}}variant({base}) or\n",
          f"%{{_cross_os}}variant({base}) or\n           %{{_cross_os}}variant({new}) or\n"),
         (f"Provides: %{{_cross_os}}{kind}({base})\n",
          f"Provides: %{{_cross_os}}{kind}({base})\nProvides: %{{_cross_os}}{kind}({new})\n"))
PY
echo "wired variant ${NEW}"
