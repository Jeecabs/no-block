import { describe, expect, it } from "vitest";
import { recognizePython } from "./python-command";

describe("Python command presentation", () => {
  it.each([
    ["python3 -c 'print(1 + 2)'", "print(1 + 2)"],
    [".venv/bin/python -c 'print(1)'", "print(1)"],
    ["./.venv/bin/python3 -u -c 'print(1)'", "print(1)"],
    ["'/tmp/project space/.venv/bin/python' -c 'print(1)'", "print(1)"],
    [".venv/bin/python - <<'PY'\nprint(1)\nPY", "print(1)"],
    ['python -u -c "print(1 + 2)"', "print(1 + 2)"],
    ["/opt/venv/bin/python3.12 -B -c 'print(1)'", "print(1)"],
    ["python3 - <<'PY'\nprint('$HOME')\nPY", "print('$HOME')"],
    ['python3 <<"PY"\nprint(1)\nPY\n', "print(1)"],
  ])(
    "extracts literal source without shell evaluation: %s",
    (command, source) => {
      expect(recognizePython(command)).toEqual({ kind: "inline", source });
    },
  );

  it("keeps a script path without reading or copying the file", () => {
    expect(recognizePython("python3 '/tmp/bulk rename.py' --dry-run")).toEqual({
      kind: "file",
      path: "/tmp/bulk rename.py",
    });
  });

  it.each([
    "echo python3",
    "uv run python3 -c 'print(1)'",
    "python3 -m pytest",
    "python3 -c 'print(1)' && rm /tmp/file",
    "python3 script.py | cat",
    "python3 script.py > /tmp/output",
    "! python3 script.py",
    "python3 script.py &",
    "X=$(touch /tmp/file) python3 script.py",
    'python3 -c "print($VALUE)"',
    'python3 -c "$(touch /tmp/file)"',
    "python3 -c $'print(1)'",
    "python3 *.py",
    "python3 <<PY\nprint('$HOME')\nPY",
    "python3 - <<'PY'\nprint(1)\nPY\nrm /tmp/file",
    "python3 - <<'PY'\nprint(1)\nPY\necho other\nPY",
    "python3 - <<'PY'\nprint(1)\nPY; echo other",
    "python3 - <<'PY'\nprint(1)\nPY ",
    "source .venv/bin/activate && python3 script.py",
    "python3 -c 'unfinished",
    "python3 -i script.py",
    "python3 -c",
    "python3",
  ])("keeps the Bash view for ambiguous or compound input: %s", (command) => {
    expect(recognizePython(command)).toBeUndefined();
  });
});
