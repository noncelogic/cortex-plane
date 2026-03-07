-- Prevent duplicate channel configs with the same type + name.
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_config_type_name
  ON channel_config (type, name);
