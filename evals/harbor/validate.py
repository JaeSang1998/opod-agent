"""Pinned Harbor contract check for the local H30 task and generated ATIF files."""

from __future__ import annotations

import argparse
from pathlib import Path

from harbor.models.task.task import Task
from harbor.models.trajectories.trajectory import Trajectory


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", default="evals/harbor/opod-h30")
    parser.add_argument("--atif", action="append", default=[])
    args = parser.parse_args()

    task_path = Path(args.task)
    if not Task.is_valid_dir(task_path):
        raise SystemExit(f"invalid Harbor task directory: {task_path}")
    task = Task(task_path)
    if task.config.environment.docker_image != "opod-agent-eval:local":
        raise SystemExit("unexpected Harbor evaluation image")
    if task.config.artifacts:
        raise SystemExit("verifier-driven wrapper must not claim agent-phase artifacts")

    for raw_path in args.atif:
        path = Path(raw_path)
        Trajectory.model_validate_json(path.read_bytes())
        print(f"ATIF v1.7 valid: {path}")

    print(f"Harbor 0.20.0 task valid: {task_path}")


if __name__ == "__main__":
    main()
