#!/usr/bin/env python3
"""
Validates all Harbor fixtures against official Harbor 0.1.2 Pydantic models
and executes a genuine end-to-end Harbor 0.1.2 Job.run() round-trip in an isolated sandbox.
"""
import asyncio
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
import yaml

EXPECTED_HARBOR_WHEEL_SHA256 = (
    "1478347edbfcc1ced2122815a67392dada4a40d715972a2e5a280858d457b7a5"
)

# 1. Add official Harbor vendored wheel to path after verifying SHA-256 integrity
vendored_wheel = Path(__file__).resolve().parent / "fixtures" / "harbor" / "vendor" / "harbor-0.1.2-py3-none-any.whl"
if not vendored_wheel.exists():
    raise FileNotFoundError(f"Vendored Harbor wheel not found at {vendored_wheel}")

with open(vendored_wheel, "rb") as f:
    wheel_hash = hashlib.sha256(f.read()).hexdigest()

assert wheel_hash == EXPECTED_HARBOR_WHEEL_SHA256, (
    f"Vendored wheel SHA-256 integrity failure: expected {EXPECTED_HARBOR_WHEEL_SHA256}, got {wheel_hash}"
)

if str(vendored_wheel) not in sys.path:
    sys.path.insert(0, str(vendored_wheel))

from harbor.models.task.task import Task
from harbor.models.task.id import LocalTaskId
from harbor.models.job.config import JobConfig
from harbor.models.job.result import JobResult
from harbor.models.trial.config import TrialConfig
from harbor.models.trial.result import TrialResult
from harbor.job import Job


def validate_static_fixtures(root: Path) -> Task:
    """Validates on-disk static fixtures against official Pydantic models with cross-link integrity."""
    # 1. Validate real executable oracle-task
    task_dir = root / "oracle-task"
    if not task_dir.exists():
        raise FileNotFoundError(f"Missing oracle-task directory at {task_dir}")
    task = Task(task_dir)
    assert task.paths.is_valid(), "oracle-task TaskPaths.is_valid() returned False"
    assert task.name == "oracle-task", f"Unexpected task name: {task.name}"
    assert len(task.checksum) == 64, f"Task checksum invalid length: {task.checksum}"

    # 2. Validate job-config.yaml
    yaml_path = root / "job-config.yaml"
    with open(yaml_path, "r", encoding="utf-8") as f:
        yaml_data = yaml.safe_load(f)
    job_cfg_from_yaml = JobConfig.model_validate(yaml_data)
    assert job_cfg_from_yaml.orchestrator.n_concurrent_trials == 1, (
        f"Resolved orchestrator concurrency must be 1, got {job_cfg_from_yaml.orchestrator.n_concurrent_trials}"
    )

    # 3. Validate jobs/oracle-job/config.json
    job_cfg_path = root / "jobs" / "oracle-job" / "config.json"
    with open(job_cfg_path, "r", encoding="utf-8") as f:
        job_cfg_data = json.load(f)
    job_cfg = JobConfig.model_validate(job_cfg_data)
    assert job_cfg.job_name == "oracle-job"
    assert job_cfg.orchestrator.n_concurrent_trials == 1

    # 4. Validate jobs/oracle-job/result.json
    job_res_path = root / "jobs" / "oracle-job" / "result.json"
    with open(job_res_path, "r", encoding="utf-8") as f:
        job_res_data = json.load(f)
    job_res = JobResult.model_validate(job_res_data)
    assert job_res.n_total_trials == 1
    assert job_res.stats.n_trials == 1
    assert job_res.stats.n_errors == 0

    # 5. Validate jobs/oracle-job/oracle-task__fixture/config.json
    trial_cfg_path = root / "jobs" / "oracle-job" / "oracle-task__fixture" / "config.json"
    with open(trial_cfg_path, "r", encoding="utf-8") as f:
        trial_cfg_data = json.load(f)
    trial_cfg = TrialConfig.model_validate(trial_cfg_data)
    assert trial_cfg.trial_name == "oracle-task__fixture"
    assert str(trial_cfg.trials_dir) == "jobs/oracle-job", (
        f"trials_dir must be portable relative path jobs/oracle-job, got {trial_cfg.trials_dir}"
    )
    # Cross-link validation: trial config job_id must equal job result id
    assert trial_cfg.job_id == job_res.id, (
        f"Cross-link failure: trial_cfg.job_id {trial_cfg.job_id} != job_res.id {job_res.id}"
    )

    # 6. Validate jobs/oracle-job/oracle-task__fixture/result.json
    trial_res_path = root / "jobs" / "oracle-job" / "oracle-task__fixture" / "result.json"
    with open(trial_res_path, "r", encoding="utf-8") as f:
        trial_res_data = json.load(f)
    trial_res = TrialResult.model_validate(trial_res_data)
    assert isinstance(trial_res.task_id, LocalTaskId), f"task_id must be LocalTaskId, got {type(trial_res.task_id)}"
    assert trial_res.verifier_result is not None, "verifier_result must not be None"
    assert trial_res.verifier_result.rewards["reward"] == 1.0

    # Cross-link validation: trial config job_id in trial result must match job result id
    assert trial_res.config.job_id == job_res.id, (
        f"Cross-link failure: trial_res.config.job_id {trial_res.config.job_id} != job_res.id {job_res.id}"
    )

    # Cross-link validation: trial_uri must end with trial_name
    assert trial_res.trial_uri.endswith(trial_res.trial_name), (
        f"Cross-link failure: trial_uri {trial_res.trial_uri} must end with {trial_res.trial_name}"
    )

    # Cross-link validation: trial_res.task_checksum must match on-disk task checksum
    assert task.checksum == trial_res.task_checksum, (
        f"Task checksum mismatch: Task dir computed {task.checksum} vs TrialResult {trial_res.task_checksum}"
    )

    # Phase timings from genuine trial execution
    assert trial_res.environment_setup is not None, "environment_setup timing must not be None"
    assert trial_res.environment_setup.started_at is not None and trial_res.environment_setup.finished_at is not None
    assert trial_res.environment_setup.started_at <= trial_res.environment_setup.finished_at

    assert trial_res.agent_setup is not None, "agent_setup timing must not be None"
    assert trial_res.agent_setup.started_at is not None and trial_res.agent_setup.finished_at is not None
    assert trial_res.agent_setup.started_at <= trial_res.agent_setup.finished_at

    assert trial_res.agent_execution is not None, "agent_execution timing must not be None"
    assert trial_res.agent_execution.started_at is not None and trial_res.agent_execution.finished_at is not None
    assert trial_res.agent_execution.started_at <= trial_res.agent_execution.finished_at

    assert trial_res.verifier is not None, "verifier timing must not be None"
    assert trial_res.verifier.started_at is not None and trial_res.verifier.finished_at is not None
    assert trial_res.verifier.started_at <= trial_res.verifier.finished_at

    # Oracle agent must have non-null AgentContext with null/empty token metrics
    assert trial_res.agent_result is not None, "agent_result must not be None (AgentContext expected)"
    assert trial_res.agent_result.is_empty(), (
        f"Oracle agent must have empty token counts: {trial_res.agent_result}"
    )

    return task


def run_genuine_harbor_roundtrip(root: Path, task: Task) -> None:
    """Executes a genuine Harbor 0.1.2 Job.run() end-to-end inside an isolated sandbox with teardown."""
    with tempfile.TemporaryDirectory(prefix="harbor-roundtrip-") as temp_dir:
        temp_root = Path(temp_dir)
        bin_dir = temp_root / "bin"
        bin_dir.mkdir()
        container_dir = temp_root / "container"
        container_dir.mkdir()
        (container_dir / "app").mkdir()
        (container_dir / "logs" / "agent").mkdir(parents=True)
        (container_dir / "logs" / "verifier").mkdir(parents=True)
        (container_dir / "solution").mkdir()
        (container_dir / "tests").mkdir()

        # Build lightweight container runner shim for docker compose
        mock_docker = bin_dir / "docker"
        mock_docker.write_text(f"""#!/usr/bin/env python3
import sys, os, shutil, subprocess
from pathlib import Path

container = Path('{container_dir}')
args = sys.argv[1:]

if 'build' in args or 'up' in args or 'down' in args:
    sys.exit(0)

if 'cp' in args:
    cp_idx = args.index('cp')
    src = args[cp_idx + 1]
    dst = args[cp_idx + 2]
    if src.startswith('main:'):
        rel = src[5:].lstrip('/')
        src_path = container / rel
        dst_path = Path(dst)
        if src_path.is_dir():
            shutil.copytree(src_path, dst_path, dirs_exist_ok=True)
        elif src_path.exists():
            dst_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_path, dst_path)
    elif dst.startswith('main:'):
        rel = dst[5:].lstrip('/')
        dst_path = container / rel
        src_path = Path(src)
        if src_path.is_dir():
            shutil.copytree(src_path, dst_path, dirs_exist_ok=True)
        elif src_path.exists():
            dst_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_path, dst_path)
    sys.exit(0)

if 'exec' in args:
    main_idx = args.index('main')
    cmd = args[main_idx + 1:]
    bwrap_cmd = [
        'bwrap',
        '--tmpfs', '/',
        '--ro-bind', '/usr', '/usr',
        '--symlink', 'usr/lib', '/lib',
        '--symlink', 'usr/lib64', '/lib64',
        '--symlink', 'usr/bin', '/bin',
        '--symlink', 'usr/sbin', '/sbin',
        '--ro-bind', '/etc', '/etc',
        '--dev', '/dev',
        '--proc', '/proc',
        '--tmpfs', '/tmp',
        '--dir', '/app',
        '--bind', str(container / 'app'), '/app',
        '--dir', '/logs',
        '--bind', str(container / 'logs'), '/logs',
        '--dir', '/solution',
        '--bind', str(container / 'solution'), '/solution',
        '--dir', '/tests',
        '--bind', str(container / 'tests'), '/tests',
        *cmd
    ]
    proc = subprocess.run(bwrap_cmd, capture_output=True, text=True)
    sys.stdout.write(proc.stdout)
    sys.stderr.write(proc.stderr)
    sys.exit(proc.returncode)

sys.exit(0)
""")
        mock_docker.chmod(mock_docker.stat().st_mode | stat.S_IEXEC)

        old_path = os.environ.get("PATH", "")
        try:
            os.environ["PATH"] = f"{bin_dir}:{old_path}"

            yaml_path = root / "job-config.yaml"
            with open(yaml_path, "r", encoding="utf-8") as f:
                cfg_data = yaml.safe_load(f)

            cfg_data["jobs_dir"] = str(temp_root / "jobs")
            cfg_data["tasks"] = [{"path": str((root / "oracle-task").resolve())}]

            job_cfg = JobConfig.model_validate(cfg_data)
            job = Job(job_cfg)

            # Execute real Job.run()
            live_job_result = asyncio.run(job.run())

            # Validate live JobResult
            assert live_job_result.stats.n_trials == 1, (
                f"Live run n_trials expected 1, got {live_job_result.stats.n_trials}"
            )
            assert live_job_result.stats.n_errors == 0, (
                f"Live run n_errors expected 0, got {live_job_result.stats.n_errors}"
            )

            # Inspect generated trial output in sandbox
            live_job_dir = temp_root / "jobs" / "oracle-job"
            trial_subdirs = [d for d in live_job_dir.iterdir() if d.is_dir()]
            assert len(trial_subdirs) == 1, f"Expected 1 trial directory, got {len(trial_subdirs)}"
            live_trial_dir = trial_subdirs[0]

            live_trial_res_file = live_trial_dir / "result.json"
            assert live_trial_res_file.exists(), f"Missing result.json in live trial dir {live_trial_dir}"

            with open(live_trial_res_file, "r", encoding="utf-8") as f:
                live_trial_data = json.load(f)

            live_trial_res = TrialResult.model_validate(live_trial_data)

            # Strict cross-link validations on genuine execution outputs
            assert live_trial_res.config.job_id == live_job_result.id, (
                f"Live cross-link failure: trial job_id {live_trial_res.config.job_id} != {live_job_result.id}"
            )
            assert live_trial_res.task_checksum == task.checksum, (
                f"Live task checksum mismatch: {live_trial_res.task_checksum} != {task.checksum}"
            )
            assert live_trial_res.verifier_result.rewards["reward"] == 1.0, (
                f"Live verifier reward must be 1.0, got {live_trial_res.verifier_result.rewards}"
            )
            assert live_trial_res.agent_result is not None, "Live agent_result must not be None"
            assert live_trial_res.agent_result.is_empty(), "Live agent_result must have empty token counts"

            # Check that genuine timings were recorded and monotonically ordered
            assert live_trial_res.environment_setup.started_at < live_trial_res.environment_setup.finished_at
            assert live_trial_res.agent_execution.started_at < live_trial_res.agent_execution.finished_at
            assert live_trial_res.verifier.started_at < live_trial_res.verifier.finished_at

        finally:
            os.environ["PATH"] = old_path
        # Sandbox directory temp_root is guaranteed to be deleted here by TemporaryDirectory context manager


def main():
    root = Path(__file__).resolve().parent / "fixtures" / "harbor"
    task = validate_static_fixtures(root)
    run_genuine_harbor_roundtrip(root, task)
    print("ALL_OFFICIAL_HARBOR_FIXTURES_AND_ROUNDTRIP_VALIDATED_SUCCESSFULLY")


if __name__ == "__main__":
    main()

