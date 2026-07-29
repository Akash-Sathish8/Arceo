"""users.disabled_at for admin deprovisioning (MED-001).

Before this, the only way to remove someone's access was to delete their `users`
row — which broke audit_log attribution for everything they had ever done, and
didn't even work, because get_current_user treated a missing row as "no
revocation to apply" and let the departed user's unexpired JWT keep working.

Disabling instead of deleting keeps the row (so the audit trail stays attributed)
while closing access at both ends: the deprovision endpoint bumps token_version
to kill live sessions instantly, and login_user refuses a disabled account so a
new one can't be started. NULL means active, which is every existing row.

Revision ID: 0013_users_disabled_at
Revises: 0012_org_token_expiry
Create Date: 2026-07-29
"""
from alembic import op
import sqlalchemy as sa

revision = "0013_users_disabled_at"
down_revision = "0012_org_token_expiry"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("disabled_at", sa.Text, nullable=True))


def downgrade() -> None:
    op.drop_column("users", "disabled_at")
