-- Provenance receipts for the operator-only synthetic fixture reconciler.
-- No business rows are changed by this migration.
CREATE TABLE demo_fixture_state (
  table_name text NOT NULL CHECK (table_name IN ('users','sales_force','sales_force_supervisors','outlets','products','visit_schedules','visits','stock_reports','stock_report_items')),
  record_key text NOT NULL,
  record_json text NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (table_name, record_key)
);
