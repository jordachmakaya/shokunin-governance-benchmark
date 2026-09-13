#!/usr/bin/env python3
"""Shokunin pre-verifier interception bridge for Harbor 0.1.2.

Lab-owned, auditable extension loaded by Harbor via the job manifest agent
``import_path`` (``shokunin_intercept_agent:ShokuninInterceptAgent``). It wraps
the experiment agent (default: ``oracle``) and executes, INSIDE the agent
phase while the container is still alive and BEFORE Harbor starts the
verifier:

1. run the inner agent and observe its NATIVE outcome (clean return vs
   timeout vs error) - never coerced from a timestamp;
2. on clean return, write ``claim.json`` (native completion event);
   on timeout/error, write ``agent-outcome.json`` (unclaimed) and re-raise so
   Harbor records its own semantics (verifier still runs after timeouts);
3. resolve the LIVE container identity (``docker inspect``) and enforce the
   lab-pinned image digest when provided;
4. export the container workspace paths to ``workspace-snapshot/`` with an
   export manifest (the gate/verifier state, pre-verifier);
5. for arms A1/A2, write ``gate-request.json`` and block until the external
   gate controller writes ``gate-verdict.json``; on A2+BLOCK raise
   :class:`ShokuninGateBlocked` so Harbor NEVER starts the verifier
   (``TrialResult.verifier`` stays ``None`` - the prevention proof).

Only the Python standard library is imported at module top level so that
``--help`` works without Harbor installed. Harbor modules are imported lazily
inside functions.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


BRIDGE_NAME = "shokunin-intercept"
BRIDGE_VERSION = "1.0.0-r8.3"

CLAIM_FILENAME = "claim.json"
AGENT_OUTCOME_FILENAME = "agent-outcome.json"
CONTAINER_IDENTITY_FILENAME = "container-identity.json"
EXPORT_MANIFEST_FILENAME = "export-manifest.json"
WORKSPACE_SNAPSHOT_DIRNAME = "workspace-snapshot"
GATE_REQUEST_FILENAME = "gate-request.json"
GATE_VERDICT_FILENAME = "gate-verdict.json"
GATE_SKIPPED_FILENAME = "gate-skipped.json"
GATE_BLOCKED_FILENAME = "gate-blocked.json"
RECOVERY_EVENTS_FILENAME = "recovery-events.json"
SERVICE_PROBE_FILENAME = ".shokunin-h1-service-probe.json"
# Three retries after the initial attempt (four total attempts).
MAX_RECOVERY_RETRIES = 3
HARBOR_VERSION_FILENAME = "harbor-version.json"

# Container paths exported pre-verifier when present. The union actually
# exported is recorded per trial in export-manifest.json; nothing outside
# this declared set is ever copied.
EXPORT_CANDIDATE_PATHS = (
    "/solution",
    "/app",
    "/workspace",
    "/home/agent",
    "/root/workspace",
    "/task",
)

DEFAULT_VERDICT_TIMEOUT_SEC = 120.0
VERDICT_POLL_INTERVAL_SEC = 0.5


class ShokuninGateBlocked(Exception):
    """Raised inside the agent phase when the A2 gate blocks the trial.

    Harbor's ``Trial.run`` does not catch it in the agent section, so
    ``_run_verification`` is never invoked: ``TrialResult.verifier`` stays
    ``None``. That absence IS the proof the verifier never started.
    """


class ShokuninGateVerdictTimeout(Exception):
    """No gate verdict arrived before the deadline (fail-closed)."""


class ShokuninDigestMismatch(Exception):
    """Live container digest differs from the lab-pinned digest."""


class ShokuninBridgeError(Exception):
    """Bridge infrastructure failure (fail-closed: verifier never runs cleanly)."""


def _utcnow_iso() -> str:
    # Emit the canonical UTC form required by the strict TypeScript sidecar
    # schemas. Python's default `+00:00` is valid ISO 8601 but is rejected by
    # z.iso.datetime() unless offset mode is enabled.
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def _read_trial_config(trial_dir: Path) -> dict:
    config_path = trial_dir / "config.json"
    try:
        return json.loads(config_path.read_text())
    except Exception as exc:
        raise ShokuninBridgeError(
            f"Bridge cannot read trial config at {config_path}: {exc}"
        ) from exc


class ShokuninInterceptAgent:
    """Harbor agent wrapper performing pre-verifier interception."""

    @staticmethod
    def name() -> str:
        return BRIDGE_NAME

    def version(self) -> str | None:
        return BRIDGE_VERSION

    def __init__(self, logs_dir, model_name=None, **kwargs):
        from pathlib import Path as _Path

        self.logs_dir = _Path(logs_dir)
        self.model_name = model_name
        self._kwargs = dict(kwargs)
        self._inner = None

    # -- identity transparency: the trial records the INNER agent ------------
    def to_agent_info(self):
        inner = self._ensure_inner()
        return inner.to_agent_info()

    def _trial_dir(self) -> Path:
        return Path(self.logs_dir).parent

    def _ensure_inner(self):
        if self._inner is not None:
            return self._inner
        # Local imports: Harbor is only available inside its runtime env.
        from harbor.agents.factory import AgentFactory
        from harbor.models.agent.name import AgentName
        from harbor.models.task.paths import TaskPaths
        from harbor.models.trial.paths import TrialPaths

        trial_dir = self._trial_dir()
        inner_name = str(self._kwargs.get("shokunin_inner_agent", "oracle"))
        trial_paths = TrialPaths(trial_dir)
        if inner_name == AgentName.ORACLE.value:
            # Mirror Harbor's oracle special-casing (task_dir + trial_paths).
            task_path = _read_trial_config(trial_dir)["task"]["path"]
            from harbor.agents.oracle import OracleAgent

            self._inner = OracleAgent(
                logs_dir=Path(self.logs_dir),
                model_name=self.model_name,
                task_dir=Path(task_path).expanduser(),
                trial_paths=trial_paths,
            )
        else:
            self._inner = AgentFactory.create_agent_from_name(
                AgentName(inner_name),
                logs_dir=Path(self.logs_dir),
                model_name=self.model_name,
            )
        return self._inner

    async def setup(self, environment) -> None:
        inner = self._ensure_inner()
        await inner.setup(environment=environment)
        # Record the REAL loaded Harbor version (importlib of this env).
        try:
            from importlib import metadata as _metadata

            version = _metadata.version("harbor")
        except Exception:
            version = None
        trial_dir = self._trial_dir()
        version_path = trial_dir.parent / HARBOR_VERSION_FILENAME
        if not version_path.exists():
            _write_json(
                version_path,
                {
                    "version": version,
                    "source": "importlib" if version else "unresolved",
                    "recordedAt": _utcnow_iso(),
                },
            )

    async def run(self, instruction: str, environment, context) -> None:
        """Single agent invocation with pre-verifier interception.

        A0-A2 run the inner agent EXACTLY ONCE (an independent counter in the
        R7 witness test observes this). A3 is the explicit bounded-recovery
        exception: it may run at most three attempts, with every retry
        persisted in recovery-events.json. Its native outcome selects the path:
        clean return -> claim.json; timeout -> agent-outcome.json (re-raise,
        Harbor still verifies); error -> agent-outcome.json (re-raise after
        capture, Harbor skips verification). Identity, digest pin and
        workspace export (AWAITED) happen for every outcome while the
        container is alive; only clean returns proceed to the gate handshake.
        """
        inner = self._ensure_inner()
        trial_dir = self._trial_dir()
        trial_name = trial_dir.name

        outcome_kind = "clean"
        outcome_error = None
        try:
            await inner.run(
                instruction=instruction, environment=environment, context=context
            )
        except asyncio.CancelledError:
            # Agent phase timed out (Harbor converts to AgentTimeoutError and
            # still runs the verifier): unclaimed. Fall through to identity
            # and snapshot capture, then re-raise to preserve Harbor semantics.
            outcome_kind = "timeout"
            _write_json(
                trial_dir / AGENT_OUTCOME_FILENAME,
                {
                    "declaredDone": False,
                    "reason": "agent_timeout",
                    "observedAt": _utcnow_iso(),
                    "trialName": trial_name,
                },
            )
        except Exception as exc:
            outcome_kind = "error"
            outcome_error = exc
            _write_json(
                trial_dir / AGENT_OUTCOME_FILENAME,
                {
                    "declaredDone": False,
                    "reason": "agent_error",
                    "message": str(exc)[:500],
                    "observedAt": _utcnow_iso(),
                    "trialName": trial_name,
                },
            )
        else:
            # Native completion event (observed clean return - never a coerced
            # timestamp: timeout/error paths above never reach this line).
            _write_json(
                trial_dir / CLAIM_FILENAME,
                {
                    "declaredDone": True,
                    "observedAt": _utcnow_iso(),
                    "trialName": trial_name,
                },
            )

        # Live container identity (docker only; fail-closed otherwise).
        identity = self._inspect_live_container(trial_name)
        _write_json(trial_dir / CONTAINER_IDENTITY_FILENAME, identity)

        # Lab-pinned digest enforcement (when the manifest pins one).
        expected = self._kwargs.get("shokunin_expected_digest")
        if expected:
            candidates = {identity.get("imageId")}
            candidates.update(identity.get("repoDigests") or [])
            if str(expected).lower() not in {str(c).lower() for c in candidates if c}:
                raise ShokuninDigestMismatch(
                    f"Live container digest {[c for c in candidates if c]} "
                    f"does not match lab-pinned {expected} for trial {trial_name}"
                )

        # Pre-verifier workspace export from the LIVE container (AWAITED:
        # without await nothing is exported and the gate would judge nothing).
        await self._run_declared_probe(environment, trial_dir)
        await self._export_workspace(environment, trial_dir)

        if outcome_kind == "timeout":
            # No claim to adjudicate; Harbor runs the verifier on the partial
            # work per its own semantics. Re-raise the cancellation.
            raise asyncio.CancelledError()
        if outcome_kind == "error":
            assert outcome_error is not None
            raise outcome_error

        # Gate handshake (A1/A2/A3) or skip marker (A0). A3 retries the
        # *inner* agent from the same Harbor trial after a BLOCK, bounded by
        # exactly three attempts. Every decision is persisted before the next
        # attempt; the native verifier runs only after a PASS.
        arm = str(self._kwargs.get("shokunin_arm", "A0_baseline"))
        if arm not in ("A1_observing", "A2_blocking", "A3_recovering"):
            _write_json(
                trial_dir / GATE_SKIPPED_FILENAME,
                {"arm": arm, "reason": "baseline-no-treatment", "at": _utcnow_iso()},
            )
            return

        snapshot_dir = trial_dir / WORKSPACE_SNAPSHOT_DIRNAME
        recovery_events: list[dict] = []
        for attempt in range(1, MAX_RECOVERY_RETRIES + 2):
            _write_json(
                trial_dir / GATE_REQUEST_FILENAME,
                {"trialName": trial_name, "arm": arm, "snapshotDir": str(snapshot_dir), "createdAt": _utcnow_iso()},
            )
            verdict = await self._await_verdict(trial_dir)
            is_block = verdict.get("verdict") == "BLOCK"
            if arm != "A3_recovering" or not is_block:
                if arm == "A3_recovering":
                    recovery_events.append({"attempt": attempt, "gateVerdict": "PASS", "action": "continue", "at": _utcnow_iso()})
                    _write_json(trial_dir / RECOVERY_EVENTS_FILENAME, recovery_events)
                break
            action = "retry" if attempt <= MAX_RECOVERY_RETRIES else "exhausted"
            recovery_events.append({"attempt": attempt, "gateVerdict": "BLOCK", "action": action, "at": _utcnow_iso()})
            _write_json(trial_dir / RECOVERY_EVENTS_FILENAME, recovery_events)
            if attempt > MAX_RECOVERY_RETRIES:
                _write_json(
                    trial_dir / GATE_BLOCKED_FILENAME,
                    {"trialName": trial_name, "at": _utcnow_iso(), "verdict": verdict},
                )
                raise ShokuninGateBlocked(
                    f"A3 gate BLOCKED trial {trial_name} after {MAX_RECOVERY_RETRIES} retries"
                )
            # Prepare a fresh attempt. The old handshake is removed so the
            # controller cannot mistake a prior verdict for the new snapshot.
            for stale in (trial_dir / CLAIM_FILENAME, trial_dir / GATE_REQUEST_FILENAME, trial_dir / GATE_VERDICT_FILENAME):
                try:
                    stale.unlink()
                except FileNotFoundError:
                    pass
            retry_instruction = instruction + "\n\nThe completion gate blocked the previous attempt. Correct these diagnostics before retrying:\n" + json.dumps(verdict.get("failureReasons", []), sort_keys=True)
            try:
                await inner.run(instruction=retry_instruction, environment=environment, context=context)
            except Exception as exc:
                _write_json(trial_dir / AGENT_OUTCOME_FILENAME, {"declaredDone": False, "reason": "agent_error", "message": str(exc)[:500], "observedAt": _utcnow_iso(), "trialName": trial_name})
                raise
            _write_json(trial_dir / CLAIM_FILENAME, {"declaredDone": True, "observedAt": _utcnow_iso(), "trialName": trial_name})
            await self._run_declared_probe(environment, trial_dir)
            await self._export_workspace(environment, trial_dir)
        if arm == "A2_blocking" and verdict.get("verdict") == "BLOCK":
            _write_json(
                trial_dir / GATE_BLOCKED_FILENAME,
                {"trialName": trial_name, "at": _utcnow_iso(), "verdict": verdict},
            )
            raise ShokuninGateBlocked(
                f"A2 gate BLOCKED trial {trial_name}; verifier will not start"
            )
        # A1 (observe) or PASS: verifier proceeds; the transcript persists.

    # -- live container inspection -------------------------------------------
    async def _run_declared_probe(self, environment, trial_dir: Path) -> None:
        """Run only an explicitly declared, fixed H1 service probe in-container."""
        if self._kwargs.get("shokunin_probe_kind") != "pypi-server":
            return
        probe_script = r'''import json, pathlib, subprocess, sys, tempfile, urllib.request
out = {"kind": "pypi-server", "endpointPassed": False, "installPassed": False}
try:
    with urllib.request.urlopen("http://127.0.0.1:8080/simple/vectorops/", timeout=5) as response:
        out["endpointPassed"] = response.status == 200
except Exception as exc:
    out["endpointError"] = type(exc).__name__
try:
    with tempfile.TemporaryDirectory(prefix="shokunin-h1-pypi-") as target:
        result = subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-deps", "--target", target, "--index-url", "http://127.0.0.1:8080/simple", "vectorops==0.1.0"], capture_output=True, text=True, timeout=20)
        out["installPassed"] = result.returncode == 0
        if result.returncode != 0: out["installError"] = (result.stderr or result.stdout)[-500:]
except Exception as exc:
    out["installError"] = type(exc).__name__
pathlib.Path("/app/.shokunin-h1-service-probe.json").write_text(json.dumps(out, sort_keys=True) + "\n", encoding="utf-8")
print(json.dumps(out, sort_keys=True))'''
        encoded = base64.b64encode(probe_script.encode("utf-8")).decode("ascii")
        result = await environment.exec(
            command=f"python3 -B -c \"import base64; exec(base64.b64decode('{encoded}'))\"",
            timeout_sec=35,
        )
        if result.return_code != 0:
            raise ShokuninBridgeError(
                f"Declared pypi-server probe failed to execute: {(getattr(result, 'stderr', '') or '')[-500:]}"
            )
        try:
            payload = json.loads((getattr(result, "stdout", "") or "").strip().splitlines()[-1])
        except Exception as exc:
            raise ShokuninBridgeError("Declared pypi-server probe returned malformed evidence") from exc
        _write_json(trial_dir / SERVICE_PROBE_FILENAME, payload)

    def _container_name(self, trial_name: str) -> str:
        project = trial_name.lower().replace(".", "-")
        return f"{project}-main-1"

    def _inspect_live_container(self, trial_name: str) -> dict:
        wanted = self._container_name(trial_name)
        project = trial_name.lower().replace(".", "-")
        podman_compose_name = f"{project}_main_1"
        try:
            listed = subprocess.run(
                ["docker", "ps", "--format", "{{.Names}}"],
                capture_output=True,
                text=True,
                timeout=30,
            )
        except Exception as exc:
            raise ShokuninBridgeError(
                f"Bridge requires a docker CLI for live inspection: {exc}"
            ) from exc
        if listed.returncode != 0:
            raise ShokuninBridgeError(
                f"`docker ps` failed: {(listed.stderr or listed.stdout or '')[:300]}"
            )
        names = [line.strip() for line in (listed.stdout or "").splitlines() if line.strip()]
        container = wanted if wanted in names else (
            podman_compose_name if podman_compose_name in names else None
        )
        if container is None:
            # Fall back to any same-project main container.
            for candidate in names:
                if candidate.startswith(project) and (
                    "-main-" in candidate or "_main_" in candidate
                ):
                    container = candidate
                    break
        if container is None:
            raise ShokuninBridgeError(
                f"Live container for trial {trial_name} not found "
                f"(wanted {wanted} or {podman_compose_name}; visible: {names[:10]})"
            )
        try:
            inspected = subprocess.run(
                ["docker", "inspect", container],
                capture_output=True,
                text=True,
                timeout=30,
            )
        except Exception as exc:
            raise ShokuninBridgeError(
                f"`docker inspect {container}` failed: {exc}"
            ) from exc
        if inspected.returncode != 0:
            raise ShokuninBridgeError(
                f"`docker inspect {container}` failed: "
                f"{(inspected.stderr or inspected.stdout or '')[:300]}"
            )
        try:
            data = json.loads(inspected.stdout or "[]")[0]
        except Exception as exc:
            raise ShokuninBridgeError(
                f"Unparseable `docker inspect` output for {container}: {exc}"
            ) from exc
        # Container inspect semantics (docker): data["Id"] is the CONTAINER
        # ID; the immutable executed image lives in data["Image"]. The two
        # identities are recorded separately and never conflated (R7 item 3).
        container_id = data.get("Id")
        image_id = data.get("Image")
        # Docker returns sha256:<hex>; Podman inspect may return the same
        # immutable image ID as bare 64-hex. Normalize before authority
        # comparison and before emitting the strict OCI sidecar contract.
        if isinstance(image_id, str) and re.fullmatch(r"[0-9a-fA-F]{64}", image_id):
            image_id = f"sha256:{image_id.lower()}"
        image_ref = (data.get("Config") or {}).get("Image")
        repo_digests: list[str] = []
        if image_id:
            try:
                image_inspected = subprocess.run(
                    ["docker", "inspect", image_id],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                if image_inspected.returncode == 0:
                    image_data = json.loads(image_inspected.stdout or "[]")[0]
                    repo_digests = [
                        str(d)
                        for d in (image_data.get("RepoDigests") or [])
                        if isinstance(d, str)
                    ]
            except Exception:
                repo_digests = []
        if not container_id:
            raise ShokuninBridgeError(
                f"Live container {container} has no container ID in inspect output"
            )
        if not image_id:
            raise ShokuninBridgeError(
                f"Live container {container} has no image ID in inspect output"
            )
        return {
            "containerId": container_id,
            "containerName": container,
            "imageId": image_id,
            "imageRef": image_ref,
            "repoDigests": repo_digests,
            "inspectedAt": _utcnow_iso(),
        }

    # -- workspace export ------------------------------------------------------
    async def _remote_is_dir(self, environment, remote_path: str) -> bool:
        try:
            result = await environment.exec(
                command=f"test -d {remote_path}", timeout_sec=30
            )
            return result.return_code == 0
        except Exception:
            return False

    async def _export_workspace(self, environment, trial_dir: Path) -> None:
        snapshot_root = trial_dir / WORKSPACE_SNAPSHOT_DIRNAME
        # Docker Compose creates missing destination parents during `cp`,
        # while Podman requires the host parent to exist. Make the export
        # contract explicit and runtime-independent.
        if snapshot_root.exists():
            shutil.rmtree(snapshot_root)
        snapshot_root.mkdir(parents=True, exist_ok=True)
        exported: list[str] = []
        missing: list[str] = []
        override = self._kwargs.get("shokunin_export_paths")
        candidates = list(override) if isinstance(override, list) and override else list(EXPORT_CANDIDATE_PATHS)
        for remote_path in candidates:
            if await self._remote_is_dir(environment, remote_path):
                target = snapshot_root / Path(remote_path).name
                await environment.download_dir(
                    source_dir=remote_path, target_dir=str(target)
                )
                exported.append(remote_path)
            else:
                missing.append(remote_path)
        _write_json(
            trial_dir / EXPORT_MANIFEST_FILENAME,
            {"exported": exported, "missing": missing, "at": _utcnow_iso()},
        )
        if not exported:
            raise ShokuninBridgeError(
                "Bridge exported zero workspace paths from the live container; "
                "nothing exists to gate or verify."
            )

    # -- gate handshake --------------------------------------------------------
    async def _await_verdict(self, trial_dir: Path) -> dict:
        try:
            timeout = float(self._kwargs.get("shokunin_verdict_timeout_sec", DEFAULT_VERDICT_TIMEOUT_SEC))
        except (TypeError, ValueError):
            timeout = DEFAULT_VERDICT_TIMEOUT_SEC
        verdict_path = trial_dir / GATE_VERDICT_FILENAME
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if verdict_path.exists():
                try:
                    verdict = json.loads(verdict_path.read_text())
                except Exception as exc:
                    raise ShokuninBridgeError(
                        f"Gate verdict at {verdict_path} is not valid JSON: {exc}"
                    ) from exc
                if verdict.get("verdict") not in ("PASS", "BLOCK"):
                    raise ShokuninBridgeError(
                        f"Gate verdict must be PASS or BLOCK, got: {verdict!r:.200}"
                    )
                return verdict
            await asyncio.sleep(VERDICT_POLL_INTERVAL_SEC)
        raise ShokuninGateVerdictTimeout(
            f"No gate verdict for trial {trial_dir.name} within {timeout}s (fail-closed)"
        )


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="shokunin_intercept_agent",
        description=(
            "Shokunin pre-verifier interception bridge for Harbor 0.1.2 "
            "(lab-owned, auditable). Loaded by Harbor via the job manifest agent "
            "import_path; wraps the experiment agent and intercepts between "
            "agent completion and verifier start inside the live trial."
        ),
    )
    parser.add_argument(
        "--help-protocol",
        action="store_true",
        help="Print the trial-sidecar protocol (filenames and handshake) and exit.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_arg_parser()
    args = parser.parse_args(argv)
    if args.help_protocol:
        print(
            json.dumps(
                {
                    "claim": CLAIM_FILENAME,
                    "agentOutcome": AGENT_OUTCOME_FILENAME,
                    "containerIdentity": CONTAINER_IDENTITY_FILENAME,
                    "exportManifest": EXPORT_MANIFEST_FILENAME,
                    "workspaceSnapshot": WORKSPACE_SNAPSHOT_DIRNAME,
                    "gateRequest": GATE_REQUEST_FILENAME,
                    "gateVerdict": GATE_VERDICT_FILENAME,
                    "gateSkipped": GATE_SKIPPED_FILENAME,
                    "gateBlocked": GATE_BLOCKED_FILENAME,
                    "recoveryEvents": RECOVERY_EVENTS_FILENAME,
                    "harborVersion": HARBOR_VERSION_FILENAME,
                    "blockedException": "ShokuninGateBlocked",
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 0
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
