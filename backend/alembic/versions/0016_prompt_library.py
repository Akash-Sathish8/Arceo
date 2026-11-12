"""Prompt library (HackThePrompt): prompts, versions, QA runs, workflows, battles.

Tenant isolation is the same `org_isolation` policy as every table (0002/0014).
The library is also a COMMUNITY, so a few tables get one extra, deliberately
narrow, SELECT-only policy that lets any org read rows that were published to
everyone. Postgres ORs permissive policies, so a row is visible when it is the
caller's own OR it matches the public predicate. Writes stay own-org only:
no public policy carries WITH CHECK, and none applies to INSERT/UPDATE/DELETE.

  prompts            public_read: visibility = 'public' AND status = 'published'
  prompt_versions    public_read: the version belongs to a public published prompt
                     and is at or below that prompt's published version
  prompt_workflows   public_read: same rule as prompts
  battles / battle_entries / battle_votes
                     public_read: battles are community by construction, and Elo
                     is computed from the votes on read, so ranking never needs
                     a cross-org WRITE

QA outputs can carry a customer's pasted content, so qa_runs.output has an
_enc twin registered in encryption.ENCRYPTED_COLUMNS.

Revision ID: 0016_prompt_library
Revises: 0015_webhook_url_enc
Create Date: 2026-10-20
"""
from alembic import op
import sqlalchemy as sa

revision = "0016_prompt_library"
down_revision = "0015_webhook_url_enc"
branch_labels = None
depends_on = None

_ORG_PRED = ("current_setting('app.current_org', true) IS NULL "
             "OR current_setting('app.current_org', true) = 'system' "
             "OR org_id = current_setting('app.current_org', true)")

_TABLES = ["prompts", "prompt_versions", "qa_runs", "prompt_workflows",
           "battles", "battle_entries", "battle_votes"]

_PUBLIC_READ = {
    "prompts": "visibility = 'public' AND status = 'published'",
    "prompt_workflows": "visibility = 'public' AND status = 'published'",
    "prompt_versions": (
        "EXISTS (SELECT 1 FROM prompts p WHERE p.id = prompt_versions.prompt_id "
        "AND p.visibility = 'public' AND p.status = 'published' "
        "AND prompt_versions.version <= p.published_version)"
    ),
    "battles": "true",
    "battle_entries": "true",
    "battle_votes": "true",
}


def _now_col():
    return sa.Column("created_at", sa.Text, nullable=False)


def upgrade() -> None:
    op.create_table(
        "prompts",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("org_id", sa.Text, nullable=False, server_default="default"),
        sa.Column("author_id", sa.Text),
        sa.Column("author_name", sa.Text),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("use_case", sa.Text),
        sa.Column("body", sa.Text, nullable=False),               # working draft
        sa.Column("variables", sa.Text),                          # JSON {name: VariableSpec}
        sa.Column("tools", sa.Text),                              # JSON [str]
        sa.Column("expected_output_tokens", sa.Integer),
        sa.Column("tests", sa.Text),                              # JSON QA suite
        sa.Column("visibility", sa.Text, nullable=False, server_default="private"),  # private|org|public
        sa.Column("status", sa.Text, nullable=False, server_default="draft"),        # draft|published
        sa.Column("published_version", sa.Integer, nullable=False, server_default="0"),
        sa.Column("parent_id", sa.Text),                          # fork lineage
        sa.Column("cost_summary", sa.Text),                       # JSON, of the draft
        sa.Column("danger_summary", sa.Text),                     # JSON, of the draft
        sa.Column("reliability", sa.Float),                       # last QA pass rate
        _now_col(),
        sa.Column("updated_at", sa.Text, nullable=False),
    )
    op.create_index("ix_prompts_org_id", "prompts", ["org_id"])
    op.create_index("ix_prompts_public", "prompts", ["visibility", "status"])
    op.create_index("ix_prompts_parent_id", "prompts", ["parent_id"])

    op.create_table(
        "prompt_versions",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("org_id", sa.Text, nullable=False, server_default="default"),
        sa.Column("prompt_id", sa.Text, nullable=False),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("body", sa.Text, nullable=False),
        sa.Column("variables", sa.Text),
        sa.Column("tools", sa.Text),
        sa.Column("expected_output_tokens", sa.Integer),
        sa.Column("cost", sa.Text),                               # JSON score of THIS text
        sa.Column("danger", sa.Text),
        sa.Column("reliability", sa.Float),
        _now_col(),
        sa.UniqueConstraint("prompt_id", "version", name="uq_prompt_versions_prompt_version"),
    )
    op.create_index("ix_prompt_versions_org_id", "prompt_versions", ["org_id"])
    op.create_index("ix_prompt_versions_prompt_id", "prompt_versions", ["prompt_id"])

    op.create_table(
        "qa_runs",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("org_id", sa.Text, nullable=False, server_default="default"),
        sa.Column("prompt_id", sa.Text, nullable=False),
        sa.Column("run_group", sa.Text, nullable=False),          # one QA invocation
        sa.Column("kind", sa.Text, nullable=False),               # test | probe
        sa.Column("probe_type", sa.Text),
        sa.Column("model", sa.Text, nullable=False),
        sa.Column("input_label", sa.Text),
        sa.Column("output", sa.Text),
        sa.Column("output_enc", sa.LargeBinary),
        sa.Column("input_tokens", sa.Integer),
        sa.Column("output_tokens", sa.Integer),
        sa.Column("latency_ms", sa.Integer),
        sa.Column("usd", sa.Float),
        sa.Column("passed", sa.Boolean),
        sa.Column("checks", sa.Text),                             # JSON per-check results
        sa.Column("error", sa.Text),
        _now_col(),
    )
    op.create_index("ix_qa_runs_org_id", "qa_runs", ["org_id"])
    op.create_index("ix_qa_runs_prompt_group", "qa_runs", ["prompt_id", "run_group"])

    op.create_table(
        "prompt_workflows",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("org_id", sa.Text, nullable=False, server_default="default"),
        sa.Column("author_id", sa.Text),
        sa.Column("author_name", sa.Text),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("steps", sa.Text, nullable=False),              # JSON [{prompt_id, input_map}]
        sa.Column("visibility", sa.Text, nullable=False, server_default="private"),
        sa.Column("status", sa.Text, nullable=False, server_default="draft"),
        sa.Column("cost_summary", sa.Text),
        sa.Column("danger_summary", sa.Text),
        _now_col(),
        sa.Column("updated_at", sa.Text, nullable=False),
    )
    op.create_index("ix_prompt_workflows_org_id", "prompt_workflows", ["org_id"])

    op.create_table(
        "battles",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("org_id", sa.Text, nullable=False, server_default="default"),
        sa.Column("created_by", sa.Text),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("task", sa.Text, nullable=False),
        sa.Column("model", sa.Text, nullable=False),
        sa.Column("inputs", sa.Text, nullable=False),             # JSON [{label, values}]
        sa.Column("status", sa.Text, nullable=False, server_default="open"),  # open|closed
        sa.Column("closes_at", sa.Text),
        _now_col(),
    )
    op.create_index("ix_battles_org_id", "battles", ["org_id"])

    op.create_table(
        "battle_entries",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("org_id", sa.Text, nullable=False, server_default="default"),
        sa.Column("battle_id", sa.Text, nullable=False),
        sa.Column("author_id", sa.Text),
        sa.Column("author_name", sa.Text),
        sa.Column("prompt_id", sa.Text),
        sa.Column("body", sa.Text, nullable=False),
        sa.Column("outputs", sa.Text),                            # JSON [str] per battle input
        sa.Column("cost", sa.Text),
        sa.Column("danger", sa.Text),
        _now_col(),
        sa.UniqueConstraint("battle_id", "author_id", name="uq_battle_entries_one_per_author"),
    )
    op.create_index("ix_battle_entries_battle_id", "battle_entries", ["battle_id"])

    op.create_table(
        "battle_votes",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("org_id", sa.Text, nullable=False, server_default="default"),
        sa.Column("battle_id", sa.Text, nullable=False),
        sa.Column("voter_id", sa.Text, nullable=False),
        sa.Column("entry_a", sa.Text, nullable=False),
        sa.Column("entry_b", sa.Text, nullable=False),
        sa.Column("input_index", sa.Integer, nullable=False),
        sa.Column("winner", sa.Text, nullable=False),             # entry id, or 'tie'
        _now_col(),
        sa.UniqueConstraint("battle_id", "voter_id", "entry_a", "entry_b", "input_index",
                            name="uq_battle_votes_once"),
    )
    op.create_index("ix_battle_votes_battle_id", "battle_votes", ["battle_id"])

    for t in _TABLES:
        op.execute(f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {t} FORCE ROW LEVEL SECURITY")
        op.execute(f"CREATE POLICY org_isolation ON {t} USING ({_ORG_PRED}) WITH CHECK ({_ORG_PRED})")
    for t, pred in _PUBLIC_READ.items():
        op.execute(f"CREATE POLICY public_read ON {t} FOR SELECT USING ({pred})")


def downgrade() -> None:
    for t in reversed(_TABLES):
        op.execute(f"DROP POLICY IF EXISTS public_read ON {t}")
        op.execute(f"DROP POLICY IF EXISTS org_isolation ON {t}")
        op.drop_table(t)
