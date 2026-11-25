-- Additive only: NULL means unavailable on historical reports. No backfill.
ALTER TABLE visits ADD reporting_week integer CHECK (reporting_week IS NULL OR (typeof(reporting_week) = 'integer' AND reporting_week BETWEEN 1 AND 4));
ALTER TABLE visits ADD reporting_month integer CHECK (reporting_month IS NULL OR (typeof(reporting_month) = 'integer' AND reporting_month BETWEEN 1 AND 12));
ALTER TABLE visits ADD reporting_year integer CHECK (reporting_year IS NULL OR (typeof(reporting_year) = 'integer' AND reporting_year BETWEEN 1 AND 9999));
ALTER TABLE visits ADD digipos_balance integer CHECK (digipos_balance IS NULL OR (typeof(digipos_balance) = 'integer' AND digipos_balance BETWEEN 0 AND 9007199254740991));
ALTER TABLE visits ADD perdana_sa_stock integer CHECK (perdana_sa_stock IS NULL OR (typeof(perdana_sa_stock) = 'integer' AND perdana_sa_stock BETWEEN 0 AND 9007199254740991));
ALTER TABLE visits ADD perdana_sa_selling integer CHECK (perdana_sa_selling IS NULL OR (typeof(perdana_sa_selling) = 'integer' AND perdana_sa_selling BETWEEN 0 AND 9007199254740991));
ALTER TABLE visits ADD perdana_sa_sellout integer CHECK (perdana_sa_sellout IS NULL OR (typeof(perdana_sa_sellout) = 'integer' AND perdana_sa_sellout BETWEEN 0 AND 9007199254740991));
ALTER TABLE visits ADD vf_data_stock integer CHECK (vf_data_stock IS NULL OR (typeof(vf_data_stock) = 'integer' AND vf_data_stock BETWEEN 0 AND 9007199254740991));
ALTER TABLE visits ADD vf_data_selling integer CHECK (vf_data_selling IS NULL OR (typeof(vf_data_selling) = 'integer' AND vf_data_selling BETWEEN 0 AND 9007199254740991));
ALTER TABLE visits ADD vf_data_sellout integer CHECK (vf_data_sellout IS NULL OR (typeof(vf_data_sellout) = 'integer' AND vf_data_sellout BETWEEN 0 AND 9007199254740991));
ALTER TABLE visits ADD vf_voice_stock integer CHECK (vf_voice_stock IS NULL OR (typeof(vf_voice_stock) = 'integer' AND vf_voice_stock BETWEEN 0 AND 9007199254740991));
ALTER TABLE visits ADD vf_voice_selling integer CHECK (vf_voice_selling IS NULL OR (typeof(vf_voice_selling) = 'integer' AND vf_voice_selling BETWEEN 0 AND 9007199254740991));
ALTER TABLE visits ADD vf_voice_sellout integer CHECK (vf_voice_sellout IS NULL OR (typeof(vf_voice_sellout) = 'integer' AND vf_voice_sellout BETWEEN 0 AND 9007199254740991));
ALTER TABLE visits ADD is_cvm_active integer CHECK (is_cvm_active IS NULL OR is_cvm_active IN (0, 1));
ALTER TABLE visits ADD is_voice_active integer CHECK (is_voice_active IS NULL OR is_voice_active IN (0, 1));
ALTER TABLE visits ADD is_digital_active integer CHECK (is_digital_active IS NULL OR is_digital_active IN (0, 1));
ALTER TABLE visits ADD total_purchase integer CHECK (total_purchase IS NULL OR (typeof(total_purchase) = 'integer' AND total_purchase BETWEEN 0 AND 9007199254740991));
