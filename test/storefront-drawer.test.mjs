import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/free-gift-storefront.js", import.meta.url), "utf8");

function harness(document, fetch = async () => { throw new Error("Unexpected fetch"); }) {
  const context = {
    document, fetch, console,
    Shopify: { shop: "test.myshopify.com" },
    FreeGiftManagerAppUrl: "https://app.example"
  };
  context.window = context;
  vm.runInNewContext(source.replace("  init();", "  window.testApi = { state, getHost, renderMessage, refreshThemeCartDrawer, installGiftControlGuard };"), context);
  context.testApi.state.config = { settings: {} };
  return context.testApi;
}

for (const theme of ["Dawn", "Horizon", "custom selector"]) {
  test(`${theme}: gift size selector mounts inside the visible drawer panel`, () => {
    const panel = { prepend(box) { box.parentNode = this; this.box = box; } };
    const drawer = { querySelector() { return panel; } };
    const document = {
      body: { classList: { contains() { return false; } } },
      querySelector(selector) {
        const target = theme === "Horizon" ? "cart-drawer-component" : theme === "custom selector" ? "#CartDrawer" : "cart-drawer";
        return selector === target ? drawer : null;
      },
      createElement() { return { setAttribute() {}, innerHTML: "" }; }
    };
    const api = harness(document);
    if (theme === "custom selector") api.state.config.settings.cartDrawerSelector = "#CartDrawer";
    const rule = {
      id: 2, giftSelectionMode: "choose_variant", giftProductId: "100",
      giftTitle: "T-shirt", giftImage: "https://cdn.shopify.com/s/files/gift.jpg", messageUnlocked: "Unlocked",
      giftVariantOptions: [{ id: "201", title: "M", available: true }]
    };
    api.renderMessage(rule, { items: [] }, rule);
    assert.equal(api.getHost(), panel);
    assert.match(panel.box.innerHTML, /gift\.jpg/);
    assert.match(panel.box.innerHTML, /data-fgm-choice-select/);
    assert.match(panel.box.innerHTML, /value="201">M/);
  });
}

test("gift card skips placeholder image URLs", () => {
  const panel = { prepend(box) { box.parentNode = this; this.box = box; } };
  const document = {
    body: { classList: { contains() { return false; } } },
    querySelector(selector) {
      return selector === "cart-drawer" ? { querySelector() { return panel; } } : null;
    },
    createElement() { return { setAttribute() {}, innerHTML: "" }; }
  };
  const api = harness(document);
  const rule = {
    id: 2, giftTitle: "T-shirt", giftImage: "https://cdn.shopify.com/...",
    messageUnlocked: "Unlocked", giftSelectionMode: "auto"
  };
  api.renderMessage(rule, { items: [] }, rule);
  assert.doesNotMatch(panel.box.innerHTML, /<img/);
});

test("gift control guard leaves gift remove buttons available for size changes", () => {
  const document = {
    head: { appended: null, appendChild(node) { this.appended = node; } },
    body: { classList: { contains() { return false; } } },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() {
      return { setAttribute() {}, textContent: "" };
    }
  };
  const api = harness(document);
  api.state.config.settings.lockGiftQuantity = true;
  api.state.config.enabled = true;
  api.state.config.settings = { lockGiftQuantity: true };
  api.installGiftControlGuard();
  assert.doesNotMatch(document.head.appended.textContent, /cart-remove-button|previewCartItem-remove|data-cart-remove\]/);
});

test("Dawn: gift mutation refreshes drawer sections without reloading the page", async () => {
  let rendered;
  let requests = 0;
  const drawer = {
    getSectionsToRender() { return [{ id: "cart-drawer" }, { id: "cart-icon-bubble" }]; },
    renderContents(payload) { rendered = payload; }
  };
  const sections = { "cart-drawer": "<div>Gift M</div>", "cart-icon-bubble": "2" };
  const api = harness({ querySelector() { return drawer; } }, async (url) => {
    requests++;
    assert.equal(url, "/?sections=cart-drawer%2Ccart-icon-bubble");
    return { ok: true, json: async () => sections };
  });
  assert.equal(await api.refreshThemeCartDrawer({ item_count: 2 }), true);
  assert.equal(requests, 1);
  assert.equal(rendered.sections, sections);
});

test("public and extension storefront scripts stay identical", async () => {
  assert.equal(await readFile(new URL("../extensions/free-gift-manager/assets/free-gift-storefront.js", import.meta.url), "utf8"), source);
});

test("startup exposes missing embed configuration without a silent exit", () => {
  const context = { console: { warn() {} } };
  context.window = context;
  vm.runInNewContext(source, context);
  assert.equal(context.FreeGiftManagerDiagnostics.status, "setup-error");
  assert.equal(context.FreeGiftManagerDiagnostics.error, "App embed URL is missing");
});

test("startup reports a failed config response instead of silently losing all cart features", async () => {
  const context = {
    console: { warn() {} },
    Shopify: { shop: "test.myshopify.com" },
    FreeGiftManagerAppUrl: " https://app.example ",
    fetch: async () => ({ ok: false, status: 503 })
  };
  context.window = context;
  vm.runInNewContext(source, context);
  await new Promise(setImmediate);
  assert.equal(context.FreeGiftManagerDiagnostics.appUrl, "https://app.example");
  assert.equal(context.FreeGiftManagerDiagnostics.status, "startup-error");
  assert.match(context.FreeGiftManagerDiagnostics.error, /503/);
});
