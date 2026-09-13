#!/usr/bin/env python3
"""Executable witness for bridge/shokunin_intercept_agent.py (R7 item 6).

Runs the REAL ShokuninInterceptAgent.run() with a fake inner agent and a
fake Harbor environment. Only the EXTERNAL processes are stubbed
(`docker ...` subprocess calls); every bridge line under test executes for
real: single inner invocation, outcome/claim files, live-identity parsing,
digest pin, awaited workspace export, gate handshake, BLOCK raise.

The test must NEVER fabricate claim.json, workspace-snapshot/,
export-manifest.json or container-identity.json — the bridge produces them.

Usage:
    python3 bridge-witness.py --scenario clean-pass|block|timeout|error|digest-mismatch --trial-dir DIR --job-id UUID

Prints a JSON summary to stdout; exit 0 on scenario success, 1 with
{"witnessFailed": <reason>} on unexpected behavior.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

BRIDGE_DIR = Path(__file__).resolve().parent.parent.parent / "bridge"
sys.path.insert(0, str(BRIDGE_DIR))

CONTAINER_ID = "container-aaa111"
IMAGE_ID = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
PODMAN_IMAGE_ID = IMAGE_ID.removeprefix("sha256:")
IMAGE_REF = "oracle-task:latest"
REPO_DIGEST = (
    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
)


class FakeInnerAgent:
    """Counts run() invocations (double-run sentinel); scripted behavior."""

    def __init__(self, behavior: str):
        self.behavior = behavior
        self.run_calls = 0
        self.instructions: list[str] = []

    def to_agent_info(self):
        return {"name": "oracle", "version": "1.0.0", "model_info": None}

    async def setup(self, environment) -> None:
        return None

    async def run(self, instruction, environment, context) -> None:
        self.run_calls += 1
        self.instructions.append(instruction)
        if self.behavior == "timeout":
            raise asyncio.CancelledError()
        if self.behavior == "error":
            raise RuntimeError("simulated inner agent failure")


class FakeExecResult:
    """Mirrors subprocess.CompletedProcess attribute names (returncode)."""

    def __init__(self, returncode: int = 0, stdout: str = ""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = ""


class HarborExecResult:
    """Mirrors Harbor's ExecResult attribute names (return_code)."""

    def __init__(self, return_code: int = 0, stdout: str = ""):
        self.return_code = return_code
        self.stdout = stdout
        self.stderr = ""


class FakeEnvironment:
    """Records download_dir calls and materializes live container bytes."""

    def __init__(self):
        self.download_calls: list[tuple[str, str]] = []
        self.exec_calls: list[str] = []

    async def exec(self, command: str, timeout_sec=None) -> HarborExecResult:
        self.exec_calls.append(command)
        return HarborExecResult(0, "")

    async def download_dir(self, source_dir: str, target_dir: str) -> None:
        self.download_calls.append((source_dir, target_dir))
        target = Path(target_dir)
        target.mkdir(parents=True, exist_ok=True)
        # Live bytes only the container could provide.
        (target / "solve-output.txt").write_text(f"LIVE-BYTES-FROM:{source_dir}\n")


def stub_docker(monkey_state: dict):
    """Stub subprocess.run for `docker ...` only; record every invocation."""
    real_run = subprocess.run

    def fake_run(args, **kwargs):
        argv = list(args) if isinstance(args, (list, tuple)) else [args]
        monkey_state.setdefault("docker_calls", []).append(argv)
        if argv[:2] == ["docker", "ps"]:
            return FakeExecResult(0, "trial-x-main-1\n")
        if argv[:2] == ["docker", "inspect"] and len(argv) == 3:
            target = argv[2]
            if target == "trial-x-main-1":
                return FakeExecResult(
                    0,
                    json.dumps(
                        [
                            {
                                "Id": CONTAINER_ID,
                                "Config": {"Image": IMAGE_REF},
                                "Image": PODMAN_IMAGE_ID,
                            }
                        ]
                    ),
                )
            return FakeExecResult(
                0,
                json.dumps([{"Id": PODMAN_IMAGE_ID, "RepoDigests": [REPO_DIGEST]}]),
            )
        return real_run(args, **kwargs)

    return fake_run


def write_verdict_on_request(trial_dir: Path, verdict: str, stop: threading.Event):
    """Gate controller thread: answer the live handshake like production."""
    deadline = time.monotonic() + 15
    requests_seen = 0
    while time.monotonic() < deadline and not stop.is_set():
        request_path = trial_dir / "gate-request.json"
        verdict_path = trial_dir / "gate-verdict.json"
        if request_path.exists() and not verdict_path.exists():
            request = json.loads(request_path.read_text())
            requests_seen += 1
            selected_verdict = verdict
            if verdict == "A3_BLOCK_THEN_PASS":
                selected_verdict = "BLOCK" if requests_seen <= 3 else "PASS"
            snapshot_hash = "na-witness"
            verdict_path.write_text(
                json.dumps(
                    {
                        "verdict": selected_verdict,
                        "failureReasons": [] if selected_verdict == "PASS" else ["witness block", "fix attempt"],
                        "evaluatedAt": datetime.now(timezone.utc).isoformat(),
                        "gateId": "witness-gate",
                        "snapshotHash": snapshot_hash,
                    }
                )
            )
            if verdict != "A3_BLOCK_THEN_PASS" or selected_verdict == "PASS":
                return True
        time.sleep(0.05)
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", required=True,
                        choices=["clean-pass", "block", "a3-recovery", "timeout", "error", "digest-mismatch"])
    parser.add_argument("--trial-dir", required=True)
    parser.add_argument("--job-id", default="11111111-1111-4111-8111-111111111111")
    args = parser.parse_args()

    import shokunin_intercept_agent as bridge

    trial_dir = Path(args.trial_dir)
    trial_dir.mkdir(parents=True, exist_ok=True)
    (trial_dir / "config.json").write_text(
        json.dumps({"job_id": args.job_id, "task": {"path": "oracle-task"}})
    )

    monkey_state: dict = {}
    subprocess.run = stub_docker(monkey_state)  # type: ignore[assignment]

    kwargs = {
        "shokunin_inner_agent": "oracle",
        "shokunin_arm": ("A2_blocking" if args.scenario == "block" else
                          "A3_recovering" if args.scenario == "a3-recovery" else "A1_observing"),
        "shokunin_expected_digest": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        if args.scenario == "digest-mismatch"
        else IMAGE_ID,
        "shokunin_verdict_timeout_sec": 20,
    }
    agent = bridge.ShokuninInterceptAgent(
        logs_dir=str(trial_dir / "agent"), model_name="oracle-v1", **kwargs
    )
    inner_behavior = {
        "clean-pass": "clean", "block": "clean", "a3-recovery": "clean", "digest-mismatch": "clean",
        "timeout": "timeout", "error": "error",
    }[args.scenario]
    inner = FakeInnerAgent(inner_behavior)
    agent._inner = inner
    env = FakeEnvironment()

    stop = threading.Event()
    controller = None
    if args.scenario in ("clean-pass", "block", "a3-recovery"):
        controller = threading.Thread(
            target=write_verdict_on_request,
            args=(trial_dir, "BLOCK" if args.scenario == "block" else "A3_BLOCK_THEN_PASS" if args.scenario == "a3-recovery" else "PASS", stop),
            daemon=True,
        )
        controller.start()

    raised: str | None = None
    try:
        asyncio.run(agent.run(instruction="do it", environment=env, context={}))
    except asyncio.CancelledError:
        raised = "CancelledError"
    except Exception as exc:  # noqa: BLE001 - witness records everything
        raised = type(exc).__name__
    finally:
        stop.set()
        if controller is not None:
            controller.join(timeout=5)

    def read_json(name: str):
        path = trial_dir / name
        if not path.exists():
            return None
        return json.loads(path.read_text())

    claim = read_json("claim.json")
    outcome = read_json("agent-outcome.json")
    identity = read_json("container-identity.json")
    export_manifest = read_json("export-manifest.json")
    snapshot_files: list[str] = []
    snapshot_dir = trial_dir / "workspace-snapshot"
    if snapshot_dir.exists():
        snapshot_files = sorted(
            str(p.relative_to(snapshot_dir)) for p in snapshot_dir.rglob("*") if p.is_file()
        )
    marker_ok = False
    for rel in snapshot_files:
        try:
            content = (snapshot_dir / rel).read_text()
        except OSError:
            continue
        if content.startswith("LIVE-BYTES-FROM:"):
            marker_ok = True
            break

    summary = {
        "scenario": args.scenario,
        "innerRunCalls": inner.run_calls,
        "instructions": inner.instructions,
        "downloadCalls": [[s, d] for s, d in env.download_calls],
        "raised": raised,
        "claim": claim,
        "outcome": outcome,
        "identity": identity,
        "containerIdDistinctFromImageId": (
            (identity or {}).get("containerId") != (identity or {}).get("imageId")
            if identity else False
        ),
        "exportManifest": export_manifest,
        "snapshotFiles": snapshot_files,
        "snapshotHasLiveBytes": marker_ok,
        "gateRequestExists": (trial_dir / "gate-request.json").exists(),
        "gateBlockedExists": (trial_dir / "gate-blocked.json").exists(),
        "recoveryEvents": read_json("recovery-events.json"),
        "dockerCalls": monkey_state.get("docker_calls", []),
    }
    print(json.dumps(summary, indent=2, sort_keys=True))

    # Scenario verdicts (fail loudly on any deviation from the plan).
    failures: list[str] = []
    if args.scenario != "a3-recovery" and inner.run_calls != 1:
        failures.append(f"inner.run() invoked {inner.run_calls}x, expected exactly 1")
    if args.scenario in ("clean-pass", "block", "a3-recovery"):
        if not env.download_calls:
            failures.append("download_dir() never executed: no live export")
        if not marker_ok:
            failures.append("snapshot lacks live container bytes")
        if not claim or claim.get("declaredDone") is not True:
            failures.append("clean return produced no claim.json")
        if not identity:
            failures.append("container-identity.json missing")
        elif not summary["containerIdDistinctFromImageId"]:
            failures.append("containerId conflated with imageId")
        elif identity.get("imageId") != IMAGE_ID:
            failures.append(f"imageId {identity.get('imageId')} is not the Image field")
        if not export_manifest or not export_manifest.get("exported"):
            failures.append("export-manifest.json missing or empty")
    if args.scenario == "clean-pass" and raised is not None:
        failures.append(f"clean run raised {raised}")
    if args.scenario == "block":
        if raised != "ShokuninGateBlocked":
            failures.append(f"expected ShokuninGateBlocked, got {raised}")
        if not (trial_dir / "gate-blocked.json").exists():
            failures.append("gate-blocked.json marker missing")
    if args.scenario == "a3-recovery":
        events = read_json("recovery-events.json")
        if inner.run_calls != 4:
            failures.append(f"A3 expected initial attempt plus three retries, got {inner.run_calls}")
        if not isinstance(events, list) or len(events) != 4:
            failures.append("A3 recovery history must contain four ordered events")
        elif [(e.get("attempt"), e.get("gateVerdict"), e.get("action")) for e in events] != [
            (1, "BLOCK", "retry"), (2, "BLOCK", "retry"),
            (3, "BLOCK", "retry"), (4, "PASS", "continue")
        ]:
            failures.append(f"unexpected A3 recovery history: {events}")
        if len(inner.instructions) != 4 or not all("witness block" in text for text in inner.instructions[1:]):
            failures.append("A3 retries must receive gate failure diagnostics")
        if raised is not None:
            failures.append(f"A3 recovery should continue after terminal PASS, got {raised}")
    if args.scenario == "timeout":
        if raised != "CancelledError":
            failures.append(f"expected CancelledError, got {raised}")
        if not outcome or outcome.get("reason") != "agent_timeout":
            failures.append("agent-outcome.json timeout marker missing")
        if claim is not None:
            failures.append("timeout must not produce claim.json")
    if args.scenario == "error":
        if raised != "RuntimeError":
            failures.append(f"expected RuntimeError, got {raised}")
        if not outcome or outcome.get("reason") != "agent_error":
            failures.append("agent-outcome.json error marker missing")
        if claim is not None:
            failures.append("error must not produce claim.json")
    if args.scenario == "digest-mismatch":
        if raised != "ShokuninDigestMismatch":
            failures.append(f"expected ShokuninDigestMismatch, got {raised}")

    if failures:
        print(json.dumps({"witnessFailed": failures}, indent=2))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
