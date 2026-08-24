const SHOP_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
const COLLECTION_CACHE_TTL = 5 * 60 * 1000;
const collectionCache = new Map();
const collectionListCache = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/health") return json({ ok: true });
      if (url.pathname === "/auth") return await handleAuth(request, env);
      if (url.pathname === "/auth/callback") return await handleCallback(request, env);
      if (url.pathname === "/apps/free-gifts/config") return await storefrontConfig(request, env);
      if (url.pathname.startsWith("/api/")) requireAdminToken(request, env);
      if (url.pathname === "/api/collections" && request.method === "GET") return await listCollections(request, env);
      if (url.pathname === "/api/rules" && request.method === "GET") return await listRules(request, env);
      if (url.pathname === "/api/rules" && request.method === "POST") return await createRule(request, env);
      if (url.pathname.startsWith("/api/rules/") && request.method === "PUT") return await updateRule(request, env);
      if (url.pathname.startsWith("/api/rules/") && request.method === "DELETE") return await deleteRule(request, env);
      if (url.pathname === "/api/settings" && request.method === "GET") return await getSettings(request, env);
      if (url.pathname === "/api/settings" && request.method === "POST") return await saveSettings(request, env);

      return await env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error.message || "Server error" }, error.status || 500);
    }
  }
};

async function ensureSchema(env) {
  if (!env.DB) throw new Error("D1 binding DB is missing");
  const statements = [
    `CREATE TABLE IF NOT EXISTS shop_sessions (
      shop TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      scope TEXT,
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS gift_rules (
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
      auto_add INTEGER NOT NULL DEFAULT 1,
      limit_one_per_order INTEGER NOT NULL DEFAULT 1,
      message_unlocked TEXT NOT NULL DEFAULT 'You unlocked a free gift',
      message_locked TEXT NOT NULL DEFAULT 'Add more to unlock your free gift',
      placement TEXT NOT NULL DEFAULT 'cart',
      priority INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS app_settings (
      shop TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      remove_when_ineligible INTEGER NOT NULL DEFAULT 1,
      lock_gift_quantity INTEGER NOT NULL DEFAULT 1,
      block_manual_gift_add INTEGER NOT NULL DEFAULT 1,
      debug_mode INTEGER NOT NULL DEFAULT 0,
      gift_line_label TEXT NOT NULL DEFAULT 'Free gift',
      cart_drawer_selector TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    )`
  ];
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
  await ensureColumn(env, "gift_rules", "trigger_quantity", "INTEGER NOT NULL DEFAULT 1");
  await ensureColumn(env, "gift_rules", "gift_value", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(env, "gift_rules", "gift_product_id", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(env, "app_settings", "lock_gift_quantity", "INTEGER NOT NULL DEFAULT 1");
  await ensureColumn(env, "app_settings", "block_manual_gift_add", "INTEGER NOT NULL DEFAULT 1");
}

async function ensureColumn(env, table, column, definition) {
  const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.results.some((item) => item.name === column)) {
    await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

async function handleAuth(request, env) {
  const url = new URL(request.url);
  const shop = normalizeShop(url.searchParams.get("shop"));
  if (!shop) return html("Missing or invalid shop param", 400);

  const apiKey = env.SHOPIFY_API_KEY;
  const scopes = env.SHOPIFY_SCOPES || "read_products";
  const appUrl = env.APP_URL || url.origin;
  if (!apiKey) return html("SHOPIFY_API_KEY is missing", 500);

  const state = crypto.randomUUID();
  const redirectUri = `${appUrl}/auth/callback`;
  const installUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  installUrl.searchParams.set("client_id", apiKey);
  installUrl.searchParams.set("scope", scopes);
  installUrl.searchParams.set("redirect_uri", redirectUri);
  installUrl.searchParams.set("state", state);

  return redirect(installUrl.toString(), {
    "Set-Cookie": `fgm_state=${state}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=600`
  });
}

async function handleCallback(request, env) {
  await ensureSchema(env);
  const url = new URL(request.url);
  const shop = normalizeShop(url.searchParams.get("shop"));
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = getCookie(request, "fgm_state");

  if (!shop || !code) return html("Invalid callback", 400);
  if (!state || state !== cookieState) return html("Invalid OAuth state", 400);
  if (!(await verifyShopifyHmac(url.searchParams, env.SHOPIFY_API_SECRET))) {
    return html("Invalid Shopify HMAC", 401);
  }

  const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.SHOPIFY_API_KEY,
      client_secret: env.SHOPIFY_API_SECRET,
      code
    })
  });

  if (!tokenResponse.ok) {
    const body = await tokenResponse.text();
    return html(`Token exchange failed: ${body}`, 502);
  }

  const tokenData = await tokenResponse.json();
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO shop_sessions (shop, access_token, scope, installed_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(shop) DO UPDATE SET
      access_token = excluded.access_token,
      scope = excluded.scope,
      updated_at = excluded.updated_at
  `).bind(shop, tokenData.access_token, tokenData.scope || "", now, now).run();

  await env.DB.prepare(`
    INSERT INTO app_settings (shop, updated_at)
    VALUES (?, ?)
    ON CONFLICT(shop) DO NOTHING
  `).bind(shop, now).run();

  return redirect(`/?shop=${encodeURIComponent(shop)}`, {
    "Set-Cookie": "fgm_state=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0"
  });
}

async function listRules(request, env) {
  await ensureSchema(env);
  const shop = requireShop(request);
  const rows = await env.DB.prepare(`
    SELECT * FROM gift_rules
    WHERE shop = ?
    ORDER BY priority ASC, id DESC
  `).bind(shop).all();
  return json({ rules: rows.results.map(ruleFromRow) });
}

async function listCollections(request, env) {
  await ensureSchema(env);
  const shop = requireShop(request);
  const url = new URL(request.url);
  const cached = collectionListCache.get(shop);

  if (url.searchParams.get("refresh") !== "1" && cached && Date.now() - cached.storedAt < COLLECTION_CACHE_TTL) {
    return json({ collections: cached.collections, source: cached.source, warning: cached.warning || "", cached: true });
  }

  const session = await env.DB.prepare("SELECT access_token FROM shop_sessions WHERE shop = ?").bind(shop).first();
  let collections;
  let source = "admin";
  let warning = "";

  if (session?.access_token) {
    try {
      collections = await getAdminCollectionList(shop, session.access_token);
    } catch (error) {
      collections = await getPublicCollectionList(shop);
      source = "storefront";
      warning = "Showing published collections because Shopify Admin access needs reconnection.";
    }
  } else {
    collections = await getPublicCollectionList(shop);
    source = "storefront";
    warning = "Showing published collections. Reconnect the app to include unpublished collections and enable numeric collection IDs.";
  }

  collectionListCache.set(shop, { collections, source, warning, storedAt: Date.now() });
  return json({ collections, source, warning, cached: false });
}

async function getAdminCollectionList(shop, accessToken) {
  const collections = [];
  let cursor = null;

  do {
    const query = `
      query GiftManagerCollections($cursor: String) {
        collections(first: 100, after: $cursor, sortKey: TITLE) {
          nodes { id title handle }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const response = await fetch(`https://${shop}/admin/api/2026-07/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken
      },
      body: JSON.stringify({ query, variables: { cursor } })
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) throw new Error(`Collection list failed (${response.status})`);
    if (payload.errors?.length) throw new Error(payload.errors[0].message || "Collection list failed");

    const connection = payload.data?.collections;
    if (!connection) throw new Error("Shopify returned no collections");

    collections.push(...connection.nodes.map((collection) => ({
      id: String(collection.id).split("/").pop(),
      gid: collection.id,
      title: collection.title,
      handle: collection.handle
    })));
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor && collections.length < 5000);

  return collections;
}

async function getPublicCollectionList(shop) {
  const collections = [];
  let page = 1;

  while (page <= 20) {
    const response = await fetch(`https://${shop}/collections.json?limit=250&page=${page}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; FreeGiftManager/1.0)"
      }
    });
    if (!response.ok) throw new Error(`Published collection list failed (${response.status})`);

    const payload = await response.json();
    const pageCollections = Array.isArray(payload.collections) ? payload.collections : [];
    collections.push(...pageCollections.map((collection) => ({
      id: String(collection.id || ""),
      gid: collection.admin_graphql_api_id || "",
      title: collection.title,
      handle: collection.handle
    })));
    if (pageCollections.length < 250) break;
    page += 1;
  }

  return collections;
}

async function createRule(request, env) {
  await ensureSchema(env);
  const shop = requireShop(request);
  const body = await request.json();
  const rule = await resolveGiftVariant(env, shop, cleanRule(body));
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`
    INSERT INTO gift_rules (
      shop, name, status, trigger_type, trigger_value, subtotal_amount, trigger_quantity,
      gift_variant_id, gift_product_id, gift_title, gift_value, gift_image, gift_quantity, auto_add,
      limit_one_per_order, message_unlocked, message_locked, placement,
      priority, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    shop, rule.name, rule.status, rule.triggerType, rule.triggerValue,
    rule.subtotalAmount, rule.triggerQuantity, rule.giftVariantId, rule.giftProductId,
    rule.giftTitle, rule.giftValue, rule.giftImage,
    rule.giftQuantity, rule.autoAdd ? 1 : 0, rule.limitOnePerOrder ? 1 : 0,
    rule.messageUnlocked, rule.messageLocked, rule.placement,
    rule.priority, now, now
  ).run();
  return json({ id: result.meta.last_row_id, giftVariantId: rule.giftVariantId, ok: true }, 201);
}

async function updateRule(request, env) {
  await ensureSchema(env);
  const shop = requireShop(request);
  const id = getId(request);
  const body = await request.json();
  const rule = await resolveGiftVariant(env, shop, cleanRule(body));
  const now = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE gift_rules SET
      name = ?, status = ?, trigger_type = ?, trigger_value = ?,
      subtotal_amount = ?, trigger_quantity = ?, gift_variant_id = ?, gift_product_id = ?, gift_title = ?,
      gift_value = ?, gift_image = ?, gift_quantity = ?, auto_add = ?, limit_one_per_order = ?,
      message_unlocked = ?, message_locked = ?, placement = ?,
      priority = ?, updated_at = ?
    WHERE id = ? AND shop = ?
  `).bind(
    rule.name, rule.status, rule.triggerType, rule.triggerValue,
    rule.subtotalAmount, rule.triggerQuantity, rule.giftVariantId, rule.giftProductId,
    rule.giftTitle, rule.giftValue, rule.giftImage,
    rule.giftQuantity, rule.autoAdd ? 1 : 0, rule.limitOnePerOrder ? 1 : 0,
    rule.messageUnlocked, rule.messageLocked, rule.placement,
    rule.priority, now, id, shop
  ).run();
  return json({ giftVariantId: rule.giftVariantId, ok: true });
}

async function deleteRule(request, env) {
  await ensureSchema(env);
  const shop = requireShop(request);
  const id = getId(request);
  await env.DB.prepare("DELETE FROM gift_rules WHERE id = ? AND shop = ?").bind(id, shop).run();
  return json({ ok: true });
}

async function getSettings(request, env) {
  await ensureSchema(env);
  const shop = requireShop(request);
  await env.DB.prepare(`
    INSERT INTO app_settings (shop, updated_at)
    VALUES (?, ?)
    ON CONFLICT(shop) DO NOTHING
  `).bind(shop, new Date().toISOString()).run();
  const row = await env.DB.prepare("SELECT * FROM app_settings WHERE shop = ?").bind(shop).first();
  return json({ settings: settingsFromRow(row) });
}

async function saveSettings(request, env) {
  await ensureSchema(env);
  const shop = requireShop(request);
  const body = await request.json();
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO app_settings (
      shop, enabled, remove_when_ineligible, lock_gift_quantity,
      block_manual_gift_add, debug_mode, gift_line_label, cart_drawer_selector,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop) DO UPDATE SET
      enabled = excluded.enabled,
      remove_when_ineligible = excluded.remove_when_ineligible,
      lock_gift_quantity = excluded.lock_gift_quantity,
      block_manual_gift_add = excluded.block_manual_gift_add,
      debug_mode = excluded.debug_mode,
      gift_line_label = excluded.gift_line_label,
      cart_drawer_selector = excluded.cart_drawer_selector,
      updated_at = excluded.updated_at
  `).bind(
    shop,
    boolInt(body.enabled, true),
    boolInt(body.removeWhenIneligible, true),
    boolInt(body.lockGiftQuantity, true),
    boolInt(body.blockManualGiftAdd, true),
    boolInt(body.debugMode, false),
    String(body.giftLineLabel || "Free gift").slice(0, 80),
    String(body.cartDrawerSelector || "").slice(0, 120),
    now
  ).run();
  return json({ ok: true });
}

async function storefrontConfig(request, env) {
  await ensureSchema(env);
  const url = new URL(request.url);
  const shop = normalizeShop(url.searchParams.get("shop"));
  if (!shop) return json({ enabled: false, rules: [] }, 400);

  const settingsRow = await env.DB.prepare("SELECT * FROM app_settings WHERE shop = ?").bind(shop).first();
  const settings = settingsFromRow(settingsRow);

  if (!settings.enabled) {
    return json({ enabled: false, rules: [], settings }, 200, corsHeaders());
  }

  const rows = await env.DB.prepare(`
    SELECT * FROM gift_rules
    WHERE shop = ? AND status = 'active'
    ORDER BY priority ASC, id DESC
  `).bind(shop).all();

  const rules = await hydrateCollectionRules(env, shop, rows.results.map(ruleFromRow));

  return json({
    enabled: true,
    settings,
    rules
  }, 200, corsHeaders());
}

function cleanRule(body) {
  const triggerType = String(body.triggerType || "product").toLowerCase();
  if (!["product", "subtotal", "collection", "collection_subtotal"].includes(triggerType)) {
    throw new Error("Unsupported trigger type");
  }
  const giftVariantId = String(body.giftVariantId || "").trim();
  const giftProductId = normalizeProductId(body.giftProductId);
  if (!giftVariantId && !giftProductId) {
    throw new Error("Gift variant ID or gift product ID is required");
  }

  const triggerValue = normalizeTriggerValue(body.triggerValue, triggerType);
  if ((triggerType === "collection" || triggerType === "collection_subtotal") && !triggerValue) {
    throw new Error("Collection handle or ID is required");
  }

  return {
    name: String(body.name || "Free gift rule").slice(0, 120),
    status: body.status === "active" ? "active" : "draft",
    triggerType,
    triggerValue,
    subtotalAmount: Math.max(0, Number.parseInt(body.subtotalAmount || 0, 10)),
    triggerQuantity: Math.max(1, Number.parseInt(body.triggerQuantity || 1, 10)),
    giftVariantId,
    giftProductId,
    giftTitle: String(body.giftTitle || "Free gift").slice(0, 120),
    giftValue: Math.max(0, Number.parseInt(body.giftValue || 0, 10)),
    giftImage: String(body.giftImage || "").slice(0, 500),
    giftQuantity: Math.max(1, Number.parseInt(body.giftQuantity || 1, 10)),
    autoAdd: body.autoAdd !== false,
    limitOnePerOrder: body.limitOnePerOrder !== false,
    messageUnlocked: String(body.messageUnlocked || "You unlocked a free gift").slice(0, 160),
    messageLocked: String(body.messageLocked || "Add more to unlock your free gift").slice(0, 160),
    placement: String(body.placement || "cart").slice(0, 40),
    priority: Math.max(1, Number.parseInt(body.priority || 1, 10))
  };
}

function ruleFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    triggerType: row.trigger_type,
    triggerValue: row.trigger_value || "",
    subtotalAmount: row.subtotal_amount || 0,
    triggerQuantity: row.trigger_quantity || 1,
    giftVariantId: row.gift_variant_id,
    giftProductId: row.gift_product_id || "",
    giftTitle: row.gift_title,
    giftValue: row.gift_value || 0,
    giftImage: row.gift_image || "",
    giftQuantity: row.gift_quantity || 1,
    autoAdd: row.auto_add === 1,
    limitOnePerOrder: row.limit_one_per_order === 1,
    messageUnlocked: row.message_unlocked,
    messageLocked: row.message_locked,
    placement: row.placement,
    priority: row.priority
  };
}

function normalizeTriggerValue(value, triggerType = "product") {
  const raw = String(value || "").trim();
  if (triggerType !== "collection" && triggerType !== "collection_subtotal") {
    return raw.slice(0, 120);
  }

  return parseCollectionIdentifiers(raw).join(",").slice(0, 2000);
}

function parseCollectionIdentifiers(value) {
  const identifiers = String(value || "")
    .split(/[,\r\n]+/)
    .map((entry) => {
      const raw = entry.trim();
      const collectionMatch = raw.match(/\/collections\/([^/?#]+)/i);
      return (collectionMatch ? collectionMatch[1] : raw).slice(0, 160);
    })
    .filter(Boolean);

  return [...new Set(identifiers)].slice(0, 20);
}

function normalizeProductId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const productUrlMatch = raw.match(/\/products\/(\d+)/i);
  const productGidMatch = raw.match(/^gid:\/\/shopify\/Product\/(\d+)$/i);
  const productId = productUrlMatch?.[1] || productGidMatch?.[1] || (/^\d+$/.test(raw) ? raw : "");
  if (!productId) throw new Error("Gift product ID must be a numeric ID or Shopify product URL");
  return productId;
}

async function resolveGiftVariant(env, shop, rule) {
  if (rule.giftVariantId) return rule;

  const session = await env.DB.prepare("SELECT access_token FROM shop_sessions WHERE shop = ?").bind(shop).first();
  let variantId = "";

  if (session?.access_token) {
    try {
      variantId = await getAdminProductVariant(shop, session.access_token, rule.giftProductId);
    } catch (error) {
      console.warn("Admin product lookup failed; trying published product catalog", error.message);
    }
  }

  if (!variantId) variantId = await getPublicProductVariant(shop, rule.giftProductId);
  return { ...rule, giftVariantId: variantId };
}

async function getAdminProductVariant(shop, accessToken, productId) {
  const query = `
    query GiftProduct($id: ID!) {
      product(id: $id) {
        variants(first: 100) {
          nodes { id availableForSale }
        }
      }
    }
  `;
  const response = await fetch(`https://${shop}/admin/api/2026-07/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken
    },
    body: JSON.stringify({
      query,
      variables: { id: `gid://shopify/Product/${productId}` }
    })
  });
  if (!response.ok) throw new Error(`Gift product lookup failed (${response.status})`);

  const payload = await response.json();
  if (payload.errors?.length) throw new Error(payload.errors[0].message || "Gift product lookup failed");
  const variants = payload.data?.product?.variants?.nodes || [];
  const variant = variants.find((item) => item.availableForSale) || variants[0];
  if (!variant?.id) throw new Error("Gift product has no variants");
  return String(variant.id).split("/").pop();
}

async function getPublicProductVariant(shop, productId) {
  let page = 1;

  while (page <= 20) {
    const response = await fetch(`https://${shop}/products.json?limit=250&page=${page}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; FreeGiftManager/1.0)"
      }
    });
    if (!response.ok) throw new Error(`Published product lookup failed (${response.status})`);

    const payload = await response.json();
    const products = Array.isArray(payload.products) ? payload.products : [];
    const product = products.find((item) => String(item.id) === productId);
    if (product) {
      const variants = Array.isArray(product.variants) ? product.variants : [];
      const variant = variants.find((item) => item.available !== false) || variants[0];
      if (!variant?.id) throw new Error("Gift product has no variants");
      return String(variant.id);
    }
    if (products.length < 250) break;
    page += 1;
  }

  throw new Error("Gift product not found. Publish it to Online Store, reconnect the app, or enter a variant ID");
}

async function hydrateCollectionRules(env, shop, rules) {
  const isCollectionRule = (rule) => rule.triggerType === "collection" || rule.triggerType === "collection_subtotal";
  if (!rules.some(isCollectionRule)) return rules;

  const session = await env.DB.prepare("SELECT access_token FROM shop_sessions WHERE shop = ?").bind(shop).first();

  return Promise.all(rules.map(async (rule) => {
    if (!isCollectionRule(rule)) return rule;
    const identifiers = parseCollectionIdentifiers(rule.triggerValue);
    const collections = await Promise.all(identifiers.map(async (identifier) => {
      try {
        return await getCollectionProducts(shop, session?.access_token || "", identifier);
      } catch (error) {
        return { error: error.message, identifier };
      }
    }));
    const validCollections = collections.filter((collection) => !collection.error);
    const errors = collections.filter((collection) => collection.error);

    return {
      ...rule,
      collectionTitle: validCollections.map((collection) => collection.title).join(", ") || identifiers.join(", "),
      collectionProductIds: [...new Set(validCollections.flatMap((collection) => collection.productIds))],
      ...(errors.length ? { collectionError: errors.map((entry) => `${entry.identifier}: ${entry.error}`).join("; ") } : {})
    };
  }));
}

async function getCollectionProducts(shop, accessToken, identifier) {
  const cacheKey = `${shop}:${identifier}`;
  const cached = collectionCache.get(cacheKey);
  if (cached && Date.now() - cached.storedAt < COLLECTION_CACHE_TTL) return cached.value;

  const isId = /^\d+$/.test(identifier) || identifier.startsWith("gid://shopify/Collection/");
  if (!accessToken) {
    if (isId) throw new Error("Reconnect the app or use a published collection handle");
    const publicCollection = await getPublicCollectionProducts(shop, identifier);
    storeCollectionCache(cacheKey, publicCollection);
    return publicCollection;
  }

  const collectionId = identifier.startsWith("gid://") ? identifier : `gid://shopify/Collection/${identifier}`;
  const productIds = [];
  let cursor = null;
  let title = "";

  do {
    const query = isId ? `
      query CollectionProducts($id: ID!, $cursor: String) {
        collection(id: $id) {
          title
          products(first: 250, after: $cursor) {
            nodes { id }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    ` : `
      query CollectionProducts($handle: String!, $cursor: String) {
        collectionByHandle(handle: $handle) {
          title
          products(first: 250, after: $cursor) {
            nodes { id }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `;
    const variables = isId ? { id: collectionId, cursor } : { handle: identifier, cursor };
    const response = await fetch(`https://${shop}/admin/api/2026-07/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken
      },
      body: JSON.stringify({ query, variables })
    });
    if (!response.ok) throw new Error(`Collection lookup failed (${response.status})`);

    const payload = await response.json();
    if (payload.errors?.length) throw new Error(payload.errors[0].message || "Collection lookup failed");
    const collection = isId ? payload.data?.collection : payload.data?.collectionByHandle;
    if (!collection) throw new Error("Collection not found");

    title = collection.title;
    productIds.push(...collection.products.nodes.map((product) => String(product.id).split("/").pop()));
    cursor = collection.products.pageInfo.hasNextPage ? collection.products.pageInfo.endCursor : null;
  } while (cursor && productIds.length < 5000);

  const value = { title, productIds };
  storeCollectionCache(cacheKey, value);
  return value;
}

async function getPublicCollectionProducts(shop, handle) {
  const productIds = [];
  let page = 1;

  while (page <= 20) {
    const response = await fetch(`https://${shop}/collections/${encodeURIComponent(handle)}/products.json?limit=250&page=${page}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; FreeGiftManager/1.0)"
      }
    });
    if (!response.ok) throw new Error(`Published collection lookup failed (${response.status})`);
    const payload = await response.json();
    const products = Array.isArray(payload.products) ? payload.products : [];
    productIds.push(...products.map((product) => String(product.id)));
    if (products.length < 250) break;
    page += 1;
  }

  if (!productIds.length) throw new Error("Published collection not found or empty");
  return { title: handle, productIds };
}

function storeCollectionCache(cacheKey, value) {
  if (collectionCache.size > 100) collectionCache.clear();
  collectionCache.set(cacheKey, { storedAt: Date.now(), value });
}

function settingsFromRow(row) {
  return {
    enabled: !row || row.enabled === 1,
    removeWhenIneligible: !row || row.remove_when_ineligible === 1,
    lockGiftQuantity: !row || row.lock_gift_quantity === 1,
    blockManualGiftAdd: !row || row.block_manual_gift_add === 1,
    debugMode: !!row && row.debug_mode === 1,
    giftLineLabel: row?.gift_line_label || "Free gift",
    cartDrawerSelector: row?.cart_drawer_selector || ""
  };
}

function requireShop(request) {
  const url = new URL(request.url);
  const shop = normalizeShop(url.searchParams.get("shop"));
  if (!shop) throw new Error("Missing or invalid shop");
  return shop;
}

function requireAdminToken(request, env) {
  if (!env.ADMIN_TOKEN) return;
  const token = (request.headers.get("X-Admin-Token") || "").trim();
  const expected = String(env.ADMIN_TOKEN || "").trim();
  if (!timingSafeEqual(token, expected)) {
    const error = new Error("Unauthorized admin request");
    error.status = 401;
    throw error;
  }
}

function normalizeShop(shop) {
  if (!shop) return "";
  const clean = String(shop).trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  return SHOP_RE.test(clean) ? clean : "";
}

function getId(request) {
  const id = Number.parseInt(new URL(request.url).pathname.split("/").pop(), 10);
  if (!Number.isFinite(id)) throw new Error("Invalid rule ID");
  return id;
}

async function verifyShopifyHmac(params, secret) {
  if (!secret) throw new Error("SHOPIFY_API_SECRET is missing");
  const hmac = params.get("hmac");
  if (!hmac) return false;
  const message = [...params.entries()]
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return timingSafeEqual(hmac, [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join(""));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  return cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.split("=")[1] || "";
}

function boolInt(value, fallback) {
  if (value === undefined) return fallback ? 1 : 0;
  return value ? 1 : 0;
}

function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { Location: location, ...headers } });
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
