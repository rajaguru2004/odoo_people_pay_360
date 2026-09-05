-- Which court order is satisfied first when pay cannot cover them all.
--
-- Without it the ladder among competing orders fell back to insertion order,
-- which is not a total order: two orders served the same day allocated in
-- whatever sequence the index returned them, so the same data could produce
-- two different payslips. Defaulted, so every existing order keeps the same
-- rank and nothing already paid changes.
ALTER TABLE "garnishment_orders"
    ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 100;

ALTER TABLE "garnishment_orders" ADD CONSTRAINT "garnishment_order_priority_positive"
    CHECK ("priority" > 0);
