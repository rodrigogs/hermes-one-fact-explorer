"""Run the JavaScript test suites, so they cannot rot unnoticed.

pytest collects `test_*.py`; the two JS suites here are invoked by hand, which
means they are invoked when someone remembers. That is 60 assertions covering
console.html's rendering and the touch contract, and none of them were reached
by `pytest -q`, which reported 21 passed and gave no hint that a third of the
plugin's tests had not run. The sibling delegate-profile plugin learned this the
expensive way: a suite sat 4/4 failing on disk and on the deployed box, green in
every report, because nothing executed it.

Discovery is by glob rather than by list, so a new suite is picked up without an
edit here - the failure mode being avoided is precisely a suite that exists and
is never executed.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest


TESTS = Path(__file__).resolve().parent
SUITES = sorted(TESTS.glob("test_*.js"))


def test_javascript_suites_are_discovered():
    """A guard on the guard: if the glob finds nothing, this file is theatre."""
    assert SUITES, f"no JavaScript suites found in {TESTS}"


@pytest.mark.parametrize("suite", SUITES, ids=lambda p: p.name)
def test_javascript_suite_passes(suite: Path):
    node = shutil.which("node")
    if node is None:  # pragma: no cover - node is present in this deployment
        pytest.skip("node is not installed")

    # cwd is the plugin root: the suites read their subject with paths relative
    # to it (e.g. 'webui_extension/hermes-one-fact-explorer/console.html').
    result = subprocess.run(
        [node, "--test", str(suite)],
        cwd=TESTS.parent,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, (
        f"{suite.name} failed:\n{result.stdout[-4000:]}\n{result.stderr[-2000:]}"
    )
