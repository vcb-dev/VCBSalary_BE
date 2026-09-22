CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "notification_type" VARCHAR(80) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "message" TEXT NOT NULL,
    "reference_entity_type" VARCHAR(80),
    "reference_entity_id" VARCHAR(100),
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_logs_actor_user_id_created_at_idx"
    ON "audit_logs"("actor_user_id", "created_at" DESC);
CREATE INDEX "audit_logs_target_employee_id_created_at_idx"
    ON "audit_logs"("target_employee_id", "created_at" DESC);
CREATE INDEX "audit_logs_payroll_period_id_created_at_idx"
    ON "audit_logs"("payroll_period_id", "created_at" DESC);
CREATE INDEX "audit_logs_action_created_at_idx"
    ON "audit_logs"("action", "created_at" DESC);
CREATE INDEX "notifications_recipient_user_id_is_read_created_at_idx"
    ON "notifications"("recipient_user_id", "is_read", "created_at" DESC);
CREATE INDEX "notifications_recipient_user_id_created_at_idx"
    ON "notifications"("recipient_user_id", "created_at" DESC);

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_fkey"
    FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
