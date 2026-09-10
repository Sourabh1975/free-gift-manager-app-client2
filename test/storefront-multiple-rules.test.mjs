import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("storefront converges when two gift rules are eligible", async () => {
  const source = await readFile(
    new URL("../extensions/free-gift-manager/assets/free-gift-storefront.js", import.meta.url),
    "utf8"
  );
  const rules = [giftRule(1, 9001), giftRule(2, 9002)];
  const cart = {
    item_count: 2,
    items: [{ key: "paid:1", product_id: 100, variant_id: 101, quantity: 2, final_line_price: 120000 }]
  };
  let mutationCount = 0;

  const document = fakeDocument();
  const context = {
    console,
    URL,
    document,
    CustomEvent: class CustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options && options.detail;
      }
    },
    XMLHttpRequest: fakeXmlHttpRequest(),
    MutationObserver: undefined,
    Shopify: { shop: "example.myshopify.com" },
    FreeGiftManagerAppUrl: "https://app.example",
    location: { pathname: "/products/example" },
    setTimeout,
    clearTimeout,
    setInterval() {},
    clearInterval() {},
    fetch: async (url, options = {}) => {
      if (String(url).includes("/apps/free-gifts/config")) {
        return response({
          enabled: true,
          settings: {
            removeWhenIneligible: true,
            lockGiftQuantity: true,
            blockManualGiftAdd: true,
            giftLineLabel: "Free gift"
          },
          rules
        });
      }
      if (url === "/cart.js") return response(cartSnapshot(cart));
      if (url === "/cart/add.js") {
        mutationCount += 1;
        const body = JSON.parse(options.body);
        cart.items.push({
          key: `${body.id}:${body.properties._free_gift_rule}`,
          product_id: body.id,
          variant_id: body.id,
          quantity: body.quantity,
          final_line_price: 0,
          properties: body.properties
        });
        cart.item_count += body.quantity;
        return response(cartSnapshot(cart));
      }
      if (url === "/cart/update.js" || url === "/cart/change.js") {
        mutationCount += 1;
        return response(cartSnapshot(cart));
      }
      throw new Error(`Unexpected request: ${url}`);
    }
  };
  context.window = context;

  vm.runInNewContext(source, context);
  await wait(900);

  assert.deepEqual(
    cart.items.filter((item) => item.properties?._free_gift_manager === "true").map((item) => item.variant_id),
    [9001, 9002]
  );
  assert.equal(mutationCount, 2);

  await wait(700);
  assert.equal(mutationCount, 2, "a settled cart must not start another gift mutation cycle");
});

function giftRule(id, giftVariantId) {
  return {
    id,
    triggerType: "collection",
    triggerQuantity: 2,
    collectionProductIds: ["100"],
    giftVariantId: String(giftVariantId),
    giftQuantity: 1,
    giftTitle: `Gift ${id}`,
    giftValue: 299,
    autoAdd: true,
    messageUnlocked: "Unlocked",
    messageLocked: "Locked"
  };
}

function cartSnapshot(cart) {
  return JSON.parse(JSON.stringify(cart));
}

function response(payload) {
  return {
    ok: true,
    status: 200,
    async json() { return cartSnapshot(payload); },
    clone() { return response(payload); }
  };
}

function fakeDocument() {
  const body = element();
  body.classList = { contains() { return false; } };
  body.prepend = (child) => { child.parentNode = body; };
  return {
    body,
    head: { appendChild() {} },
    documentElement: {},
    createElement: element,
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    dispatchEvent() {}
  };
}

function element() {
  return {
    parentNode: null,
    innerHTML: "",
    style: {},
    setAttribute() {},
    removeAttribute() {},
    querySelectorAll() { return []; },
    closest() { return null; }
  };
}

function fakeXmlHttpRequest() {
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function () {};
  XMLHttpRequest.prototype.send = function () {};
  XMLHttpRequest.prototype.addEventListener = function () {};
  return XMLHttpRequest;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
