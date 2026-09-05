-- CreateEnum
CREATE TYPE "ApprovalRequestType" AS ENUM ('LEAVE', 'OVERTIME');

-- CreateEnum
CREATE TYPE "ApproverType" AS ENUM ('SUPERVISOR', 'MANAGER', 'HR_MANAGER', 'ADMIN');

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "supervisor_id" UUID;

-- CreateTable
CREATE TABLE "approval_workflows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_type" "ApprovalRequestType" NOT NULL,
    "name" VARCHAR(150),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workflow_id" UUID NOT NULL,
    "step_order" INTEGER NOT NULL,
    "approver_type" "ApproverType" NOT NULL,

    CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_type" "ApprovalRequestType" NOT NULL,
    "request_id" UUID NOT NULL,
    "step_order" INTEGER NOT NULL,
    "approver_type" "ApproverType" NOT NULL,
    "resolved_approver_id" UUID,
    "status" VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    "comment" TEXT,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approval_workflows_request_type_idx" ON "approval_workflows"("request_type");

-- One active workflow per request type (partial unique index).
CREATE UNIQUE INDEX "approval_workflows_request_type_active_key" ON "approval_workflows"("request_type") WHERE "is_active";

-- CreateIndex
CREATE INDEX "approval_steps_workflow_id_idx" ON "approval_steps"("workflow_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_steps_workflow_id_step_order_key" ON "approval_steps"("workflow_id", "step_order");

-- CreateIndex
CREATE INDEX "request_approvals_request_type_request_id_idx" ON "request_approvals"("request_type", "request_id");

-- CreateIndex
CREATE INDEX "request_approvals_resolved_approver_id_idx" ON "request_approvals"("resolved_approver_id");

-- CreateIndex
CREATE INDEX "employees_supervisor_id_idx" ON "employees"("supervisor_id");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_supervisor_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "approval_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
