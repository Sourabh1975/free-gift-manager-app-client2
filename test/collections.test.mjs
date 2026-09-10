import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

function createDb(accessToken) {
  return {
    prepare(sql) {
      return {
        bind() {
          return this;
        },
        async run() {
          return { success: true };
        },
        async all() {
          if (sql.startsWith("PRAGMA table_info")) {
            return {
              results: [
                { name: "trigger_quantity" },
                { name: "gift_value" },
                { name: "gift_product_id" }
              ]
            };
          }
          return { results: [] };
        },
        async first() {
          if (sql.includes("SELECT access_token FROM shop_sessions")) {
            return accessToken ? { access_token: accessToken } : null;
          }
          return null;
        }
      };
    }
  };
}

test("collection picker lists, caches, and refreshes Shopify collections", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  globalThis.fetch = async () => {
    fetchCalls += 1;
    const suffix = fetchCalls === 1 ? "one" : "two";
    return Response.json({
      data: {
        collections: {
          nodes: [{
            id: `gid://shopify/Collection/${fetchCalls}`,
            title: `Collection ${suffix}`,
            handle: `collection-${suffix}`
          }],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    });
  };

  try {
    const env = { DB: createDb("shopify-token") };
    const baseUrl = "https://app.example/api/collections?shop=picker-test.myshopify.com";
    const first = await worker.fetch(new Request(baseUrl), env);
    const firstData = await first.json();
    assert.equal(first.status, 200);
    assert.equal(firstData.collections[0].handle, "collection-one");
    assert.equal(firstData.source, "admin");

    const cached = await worker.fetch(new Request(baseUrl), env);
    const cachedData = await cached.json();
    assert.equal(cachedData.cached, true);
    assert.equal(fetchCalls, 1);

    const refreshed = await worker.fetch(new Request(`${baseUrl}&refresh=1`), env);
    const refreshedData = await refreshed.json();
    assert.equal(refreshedData.collections[0].handle, "collection-two");
    assert.equal(fetchCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("collection picker falls back to published collections without an OAuth session", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /collections\.json/);
    return Response.json({
      collections: [{
        id: 91,
        title: "Published collection",
        handle: "published-collection"
      }]
    });
  };

  try {
    const response = await worker.fetch(
      new Request("https://app.example/api/collections?shop=no-session.myshopify.com"),
      { DB: createDb("") }
    );
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.source, "storefront");
    assert.equal(data.collections[0].handle, "published-collection");
    assert.match(data.warning, /published collections/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
