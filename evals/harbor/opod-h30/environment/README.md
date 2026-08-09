# Prebuilt evaluation environment

This task intentionally has no task-local Dockerfile. Harbor v0.20.0 requires
the `environment/` directory when discovering a local task, while
`[environment].docker_image` in `task.toml` selects the prebuilt
`opod-agent-eval:local` image.

Build that image from the repository root before running this task:

```bash
docker build -f docker/Dockerfile.eval -t opod-agent-eval:local .
```
