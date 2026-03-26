"""Mock GitHub API — repos, PRs, CI/CD, releases."""

from sandbox.mocks.registry import register_mock, MockState, _gen_id


@register_mock("github", "list_repos")
def list_repos(params: dict, state: MockState) -> dict:
    return {
        "repos": [
            {"name": "api-service", "language": "Python", "default_branch": "main", "open_prs": 2},
            {"name": "frontend", "language": "TypeScript", "default_branch": "main", "open_prs": 1},
            {"name": "infra", "language": "HCL", "default_branch": "main", "open_prs": 0},
        ]
    }


@register_mock("github", "get_pull_request")
def get_pull_request(params: dict, state: MockState) -> dict:
    pr_id = str(params.get("pr_number", "287"))
    pr = state.pull_requests.get(pr_id)
    if not pr:
        return {"error": f"PR #{pr_id} not found"}
    return {"pull_request": pr}


@register_mock("github", "merge_pull_request")
def merge_pull_request(params: dict, state: MockState) -> dict:
    pr_id = str(params.get("pr_number", "287"))
    pr = state.pull_requests.get(pr_id)
    if not pr:
        return {"error": f"PR #{pr_id} not found"}
    pr["state"] = "merged"
    return {"merged": True, "sha": _gen_id(), "pr": pr}


@register_mock("github", "create_branch")
def create_branch(params: dict, state: MockState) -> dict:
    return {
        "branch": params.get("branch_name", "feature/new"),
        "base": params.get("base", "main"),
        "created": True,
    }


@register_mock("github", "delete_branch")
def delete_branch(params: dict, state: MockState) -> dict:
    branch = params.get("branch_name", "feature/old")
    state.deleted_items.append({"type": "branch", "id": branch})
    return {"deleted": True, "branch": branch}


@register_mock("github", "trigger_workflow")
def trigger_workflow(params: dict, state: MockState) -> dict:
    return {
        "run_id": _gen_id("run_"),
        "workflow": params.get("workflow", "deploy.yml"),
        "status": "queued",
        "triggered_by": "actiongate-agent",
    }


@register_mock("github", "get_workflow_status")
def get_workflow_status(params: dict, state: MockState) -> dict:
    return {
        "run_id": params.get("run_id", "run_001"),
        "workflow": "deploy.yml",
        "status": "completed",
        "conclusion": "success",
        "duration": "3m 42s",
    }


@register_mock("github", "create_release")
def create_release(params: dict, state: MockState) -> dict:
    return {
        "release": {
            "id": _gen_id("rel_"),
            "tag": params.get("tag", "v1.2.3"),
            "name": params.get("name", "Release v1.2.3"),
            "draft": False, "prerelease": False,
        }
    }


@register_mock("github", "rollback_release")
def rollback_release(params: dict, state: MockState) -> dict:
    return {
        "rollback": {
            "from_tag": params.get("current_tag", "v1.2.3"),
            "to_tag": params.get("target_tag", "v1.2.2"),
            "status": "completed",
        }
    }
