CREATE TABLE IF NOT EXISTS shop_sessions (
  shop TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  scope TEXT,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gift_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  trigger_type TEXT NOT NULL,
  trigger_value TEXT,
  subtotal_amount INTEGER DEFAULT 0,
  trigger_quantity INTEGER NOT NULL DEFAULT 1,
  gift_variant_id TEXT NOT NULL,
  gift_product_id TEXT NOT NULL DEFAULT '',
  gift_title TEXT NOT NULL,
  gift_value INTEGER NOT NULL DEFAULT 0,
  gift_image TEXT,
  gift_quantity INTEGER NOT NULL DEFAULT 1,
  gift_selection_mode TEXT NOT NULL DEFAULT 'auto',
  gift_variant_options TEXT NOT NULL DEFAULT '[]',
  auto_add INTEGER NOT NULL DEFAULT 1,
  direct_checkout_enabled INTEGER NOT NULL DEFAULT 0,
  limit_one_per_order INTEGER NOT NULL DEFAULT 1,
  message_unlocked TEXT NOT NULL DEFAULT 'You unlocked a free gift',
  message_locked TEXT NOT NULL DEFAULT 'Add more to unlock your free gift',
  placement TEXT NOT NULL DEFAULT 'cart',
  priority INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  shop TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  remove_when_ineligible INTEGER NOT NULL DEFAULT 1,
  lock_gift_quantity INTEGER NOT NULL DEFAULT 1,
  block_manual_gift_add INTEGER NOT NULL DEFAULT 1,
  debug_mode INTEGER NOT NULL DEFAULT 0,
  gift_line_label TEXT NOT NULL DEFAULT 'Free gift',
  cart_drawer_selector TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gift_rules_shop_status
ON gift_rules (shop, status, priority);
