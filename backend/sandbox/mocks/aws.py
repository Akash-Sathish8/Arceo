"""Mock AWS API — EC2, ECS, security groups, snapshots."""

from sandbox.mocks.registry import register_mock, MockState, _gen_id


@register_mock("aws", "list_instances")
def list_instances(params: dict, state: MockState) -> dict:
    return {"instances": list(state.instances.values()), "total": len(state.instances)}


@register_mock("aws", "start_instance")
def start_instance(params: dict, state: MockState) -> dict:
    iid = params.get("instance_id", "i-staging")
    inst = state.instances.get(iid)
    if not inst:
        return {"error": f"Instance {iid} not found"}
    inst["state"] = "running"
    return {"instance": inst, "previous_state": "stopped"}


@register_mock("aws", "stop_instance")
def stop_instance(params: dict, state: MockState) -> dict:
    iid = params.get("instance_id", "i-0a1b2c3d")
    inst = state.instances.get(iid)
    if not inst:
        return {"error": f"Instance {iid} not found"}
    prev = inst["state"]
    inst["state"] = "stopped"
    return {"instance": inst, "previous_state": prev}


@register_mock("aws", "terminate_instance")
def terminate_instance(params: dict, state: MockState) -> dict:
    iid = params.get("instance_id")
    inst = state.instances.pop(iid, None)
    if inst:
        state.deleted_items.append({"type": "ec2_instance", "id": iid, "data": inst})
    return {"terminated": True, "instance_id": iid}


@register_mock("aws", "scale_service")
def scale_service(params: dict, state: MockState) -> dict:
    return {
        "service": params.get("service", "api-prod"),
        "desired_count": params.get("count", 4),
        "previous_count": 2,
        "status": "scaling",
    }


@register_mock("aws", "get_logs")
def get_logs(params: dict, state: MockState) -> dict:
    return {
        "log_group": params.get("log_group", "/ecs/api-prod"),
        "events": [
            {"timestamp": "2026-03-25T11:59:50Z", "message": "INFO: Request processed in 45ms"},
            {"timestamp": "2026-03-25T11:59:51Z", "message": "WARN: Slow query detected (1200ms)"},
            {"timestamp": "2026-03-25T11:59:52Z", "message": "ERROR: Connection timeout to db-replica-2"},
        ],
    }


@register_mock("aws", "update_security_group")
def update_security_group(params: dict, state: MockState) -> dict:
    return {
        "security_group": params.get("security_group_id", "sg-0a1b2c3d"),
        "rule_added": {
            "protocol": params.get("protocol", "tcp"),
            "port": params.get("port", 443),
            "source": params.get("source", "0.0.0.0/0"),
        },
        "status": "applied",
    }


@register_mock("aws", "create_snapshot")
def create_snapshot(params: dict, state: MockState) -> dict:
    return {
        "snapshot": {
            "id": _gen_id("snap-"),
            "volume_id": params.get("volume_id", "vol-001"),
            "status": "pending",
            "size_gb": 100,
        }
    }


@register_mock("aws", "delete_snapshot")
def delete_snapshot(params: dict, state: MockState) -> dict:
    sid = params.get("snapshot_id", "snap-old")
    state.deleted_items.append({"type": "ebs_snapshot", "id": sid})
    return {"deleted": True, "snapshot_id": sid}


@register_mock("aws", "update_env_vars")
def update_env_vars(params: dict, state: MockState) -> dict:
    return {
        "service": params.get("service", "api-prod"),
        "updated_vars": params.get("vars", {"API_KEY": "***", "DEBUG": "false"}),
        "status": "deployed",
        "restart_required": True,
    }
