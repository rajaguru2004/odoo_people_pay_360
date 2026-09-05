-- CreateTable
CREATE TABLE "appraisal_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "period_label" VARCHAR(100),
    "branch_id" UUID,
    "scope_json" JSONB,
    "created_by_id" UUID NOT NULL,
    "model" VARCHAR(150),
    "tool_plan_json" JSONB,
    "weights_json" JSONB,
    "executive_summary" TEXT,
    "org_insights_json" JSONB,
    "total_employees" INTEGER NOT NULL DEFAULT 0,
    "completed_employees" INTEGER NOT NULL DEFAULT 0,
    "tool_call_count" INTEGER NOT NULL DEFAULT 0,
    "current_phase" VARCHAR(30),
    "error" TEXT,
    "started_at" TIMESTAMP(6),
    "completed_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appraisal_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appraisal_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "employee_id" UUID,
    "employee_code" VARCHAR(50) NOT NULL,
    "employee_name" VARCHAR(255) NOT NULL,
    "position" VARCHAR(100),
    "department_id" UUID,
    "department_name" VARCHAR(255),
    "scores_json" JSONB,
    "strengths_json" JSONB,
    "improvements_json" JSONB,
    "risks_json" JSONB,
    "summary" TEXT,
    "recommendation" VARCHAR(30),
    "rank_overall" INTEGER,
    "rank_department" INTEGER,
    "metrics_json" JSONB,
    "tool_call_count" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appraisal_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appraisal_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appraisal_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "appraisal_runs_branch_id_created_at_idx" ON "appraisal_runs"("branch_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "appraisal_runs_status_idx" ON "appraisal_runs"("status");

-- CreateIndex
CREATE INDEX "appraisal_results_run_id_rank_overall_idx" ON "appraisal_results"("run_id", "rank_overall");

-- CreateIndex
CREATE UNIQUE INDEX "appraisal_results_run_id_employee_id_key" ON "appraisal_results"("run_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "appraisal_events_run_id_seq_key" ON "appraisal_events"("run_id", "seq");

-- AddForeignKey
ALTER TABLE "appraisal_results" ADD CONSTRAINT "appraisal_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "appraisal_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appraisal_events" ADD CONSTRAINT "appraisal_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "appraisal_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

