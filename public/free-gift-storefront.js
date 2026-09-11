(function () {
  // This app replaces the theme's legacy Glaze auto-gift engine when both are installed.
  window.__glazeGiftSimpleLoaded = true;

  var appUrl = String(window.FreeGiftManagerAppUrl || "").trim();
  var shop = window.Shopify && Shopify.shop;
  var diagnostics = window.FreeGiftManagerDiagnostics = {
    version: "drawer-diagnostics-1",
    appUrl: appUrl,
    shop: shop || "",
    status: "starting",
    ruleCount: 0,
    matchedRuleIds: [],
    widgetMounted: false,
    error: ""
  };
  var state = {
    busy: false,
    pending: false,
    refreshing: false,
    config: null,
    lastCart: null,
    internalMutations: 0,
    directCheckoutBusy: false,
    failedGiftSignature: "",
    giftRetryAfter: 0
  };

  if (!appUrl || !shop) {
    diagnostics.status = "setup-error";
    diagnostics.error = !appUrl ? "App embed URL is missing" : "Shopify shop identity is missing";
    console.warn("[FreeGiftManager]", diagnostics.error);
    return;
  }

  init();

  function init() {
    loadConfig().then(function () {
      installGiftControlGuard();
      installDirectCheckoutHandler();
      checkCart();
      document.addEventListener("submit", onPossibleCartChange, true);
      document.addEventListener("click", onPossibleCartChange, true);
      document.addEventListener("change", onPossibleCartChange, true);
      document.addEventListener("input", onPossibleCartChange, true);
      document.addEventListener("click", onGiftChoiceClick, true);
      document.addEventListener("cart:refresh", checkCart);
      document.addEventListener("cart:updated", checkCart);
      hookCartRequests();
      setInterval(checkCart, 5000);
    }).catch(function (error) {
      diagnostics.status = "startup-error";
      diagnostics.error = error.message || String(error);
      console.warn("[FreeGiftManager] Startup failed", error);
    });
  }

  function onPossibleCartChange(event) {
    var target = event.target;
    var maybeCartAction = target && (
      target.closest && (
        target.closest('form[action*="/cart/add"]') ||
        target.closest('form[action*="/cart"]') ||
        target.closest('button[name="add"]') ||
        target.closest('[href*="/cart"]') ||
        target.closest('[name="updates[]"]') ||
        target.closest('[data-cart-update]') ||
        target.closest('[data-cart-quantity]') ||
        target.closest('quantity-input') ||
        target.closest('.quantity')
      )
    );
    if (maybeCartAction) scheduleCheck(250);
  }

  function installDirectCheckoutHandler() {
    if (window.__freeGiftManagerDirectCheckout) return;
    window.__freeGiftManagerDirectCheckout = true;
    document.addEventListener("click", onDirectCheckoutClick, true);
    document.addEventListener("submit", onDirectCheckoutSubmit, true);
  }

  function onDirectCheckoutClick(event) {
    if (!hasDirectCheckoutRules() || state.directCheckoutBusy) return;
    var trigger = findDirectCheckoutTrigger(event.target);
    if (!trigger) return;
    var form = findProductAddForm(trigger);
    if (!form) return;
    startDirectCheckout(event, form);
  }

  function onDirectCheckoutSubmit(event) {
    if (!hasDirectCheckoutRules() || state.directCheckoutBusy) return;
    var form = event.target;
    if (!isProductAddForm(form) || !isDirectCheckoutElement(event.submitter)) return;
    startDirectCheckout(event, form);
  }

  function startDirectCheckout(event, form) {
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    runDirectCheckout(form);
  }

  async function runDirectCheckout(form) {
    state.directCheckoutBusy = true;
    setDirectCheckoutBusy(form, true);
    var productAdded = false;

    try {
      var payload = cartAddPayloadFromForm(form);
      var addResponse = await cartMutationFetch("/cart/add.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload)
      });
      if (!addResponse.ok) throw await cartMutationError("Buy Now product add failed", addResponse);
      await addResponse.json().catch(function () { return {}; });
      productAdded = true;

      var cart = await getCart();
      state.lastCart = cart;
      var matchedRules = directCheckoutRules().filter(function (rule) { return matchesRule(rule, cart); });
      for (var index = 0; index < matchedRules.length; index += 1) {
        var changed = await ensureGift(cart, matchedRules[index]);
        if (changed) cart = await getCart();
      }

      window.location.href = "/checkout";
    } catch (error) {
      if (state.config.settings && state.config.settings.debugMode) console.warn("[FreeGiftManager] Buy Now gift failed", error);
      if (productAdded) {
        window.location.href = "/checkout";
        return;
      }
      alert("Buy Now could not be processed. Please try again.");
    } finally {
      state.directCheckoutBusy = false;
      setDirectCheckoutBusy(form, false);
    }
  }

  function hasDirectCheckoutRules() {
    return directCheckoutRules().length > 0;
  }

  function directCheckoutRules() {
    if (!state.config || !state.config.enabled) return [];
    return (state.config.rules || []).filter(function (rule) {
      return rule.autoAdd && rule.directCheckoutEnabled && !isChoiceGiftRule(rule);
    });
  }

  function findDirectCheckoutTrigger(target) {
    if (!target || !target.closest) return null;
    var trigger = target.closest([
      ".shopify-payment-button",
      ".shopify-payment-button__button",
      "[data-shopify='payment-button']",
      "[data-buy-now]",
      "[data-direct-checkout]",
      "[name='checkout']",
      "[formaction*='/checkout']",
      "a[href*='/checkout']",
      "button",
      "input[type='submit']"
    ].join(","));
    return isDirectCheckoutElement(trigger) ? trigger : null;
  }

  function isDirectCheckoutElement(element) {
    if (!element) return false;
    var selector = [
      ".shopify-payment-button",
      ".shopify-payment-button__button",
      "[data-shopify='payment-button']",
      "[data-buy-now]",
      "[data-direct-checkout]",
      "[name='checkout']",
      "[formaction*='/checkout']",
      "a[href*='/checkout']"
    ].join(",");
    if (element.matches && element.matches(selector)) return true;

    var label = [
      element.textContent,
      element.value,
      element.getAttribute && element.getAttribute("aria-label"),
      element.getAttribute && element.getAttribute("data-action")
    ].filter(Boolean).join(" ").toLowerCase();
    if (!label || /add\s+to\s+cart/.test(label)) return false;
    return /buy\s*now|buy\s+it\s+now|checkout/.test(label);
  }

  function findProductAddForm(trigger) {
    if (!trigger || !trigger.closest) return null;
    var form = trigger.closest('form[action*="/cart/add"]');
    if (isProductAddForm(form)) return form;

    var container = trigger.closest([
      "product-form",
      ".product-form",
      "[data-product-form]",
      ".productView",
      ".product__info-container",
      ".product-single",
      "[id*='ProductInfo']",
      "[id*='ProductSection']"
    ].join(","));
    if (!container || !container.querySelectorAll) return null;

    var forms = container.querySelectorAll('form[action*="/cart/add"]');
    for (var index = 0; index < forms.length; index += 1) {
      if (isProductAddForm(forms[index])) return forms[index];
    }
    return null;
  }

  function isProductAddForm(form) {
    if (!form || !form.getAttribute || !/\/cart\/add/.test(String(form.getAttribute("action") || ""))) return false;
    return !!getFormField(form, "id");
  }

  function cartAddPayloadFromForm(form) {
    var formData = new FormData(form);
    var variantId = normalizeFormFieldValue(formData.get("id")) || normalizeFormFieldValue(getFormField(form, "id"));
    if (!variantId) throw new Error("Product variant is missing");

    var payload = {
      id: Number(variantId),
      quantity: Math.max(1, Number.parseInt(normalizeFormFieldValue(formData.get("quantity")) || "1", 10))
    };
    var sellingPlan = normalizeFormFieldValue(formData.get("selling_plan"));
    if (sellingPlan) payload.selling_plan = sellingPlan;

    var properties = {};
    formData.forEach(function (value, key) {
      var match = String(key).match(/^properties\[(.+)\]$/);
      if (!match) return;
      var propertyValue = normalizeFormFieldValue(value);
      if (propertyValue) properties[match[1]] = propertyValue;
    });
    if (Object.keys(properties).length) payload.properties = properties;

    return payload;
  }

  function getFormField(form, name) {
    var field = form && form.querySelector && form.querySelector('[name="' + name + '"]');
    return field ? field.value : "";
  }

  function normalizeFormFieldValue(value) {
    if (value === undefined || value === null) return "";
    return String(value).trim();
  }

  function setDirectCheckoutBusy(form, busy) {
    if (!form || !form.querySelectorAll) return;
    form.querySelectorAll("button, input[type='submit']").forEach(function (button) {
      if (busy) {
        button.setAttribute("data-fgm-disabled", button.disabled ? "already" : "true");
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
      } else if (button.getAttribute("data-fgm-disabled")) {
        if (button.getAttribute("data-fgm-disabled") === "true") button.disabled = false;
        button.removeAttribute("data-fgm-disabled");
        button.removeAttribute("aria-busy");
      }
    });
  }

  async function loadConfig() {
    diagnostics.status = "loading-config";
    var res = await fetch(appUrl.replace(/\/$/, "") + "/apps/free-gifts/config?shop=" + encodeURIComponent(shop));
    if (!res.ok) throw new Error("Gift config request failed: " + res.status);
    state.config = await res.json();
    if (!Array.isArray(state.config.rules)) throw new Error("Gift config response has no rules list");
    diagnostics.ruleCount = state.config.rules.length;
    diagnostics.status = state.config.enabled ? "ready" : "disabled";
  }

  async function checkCart() {
    if (!state.config || !state.config.enabled) return;
    if (state.busy) {
      state.pending = true;
      return;
    }
    state.busy = true;
    state.pending = false;

    try {
      var cart = await getCart();
      var rules = state.config.rules || [];
      var unauthorizedGiftsRemoved = false;
      if (settingEnabled("blockManualGiftAdd")) {
        unauthorizedGiftsRemoved = await removeUnauthorizedGiftLines(cart, rules);
        if (unauthorizedGiftsRemoved) cart = await getCart();
      }
      state.lastCart = cart;
      applyGiftControlLocks(cart);
      var matchedRules = rules.filter(function (rule) { return matchesRule(rule, cart); });
      diagnostics.matchedRuleIds = matchedRules.map(function (rule) { return rule.id; });
      diagnostics.status = "cart-checked";
      diagnostics.error = "";
      var expectedGiftRules = matchedRules.filter(function (rule) {
        return rule.autoAdd && !isChoiceGiftRule(rule);
      });
      var messageRule = matchedRules.find(function (rule) {
        return isChoiceGiftRule(rule) && !findManagedGiftForRule(cart, rule);
      }) || matchedRules[0];
      renderMessage(messageRule, cart, rules[0]);

      if (expectedGiftRules.length) {
        var removedUnexpected = await removeUnexpectedGifts(cart, matchedRules);
        if (removedUnexpected) cart = await getCart();
        var giftChanged = false;
        for (var index = 0; index < expectedGiftRules.length; index += 1) {
          var currentGiftChanged = await ensureGift(cart, expectedGiftRules[index]);
          if (currentGiftChanged) {
            giftChanged = true;
            cart = await getCart();
          }
        }
        if (unauthorizedGiftsRemoved || removedUnexpected || giftChanged) refreshCartAfterMutation();
      } else if (matchedRules.length) {
        var removedMatchedUnexpected = await removeUnexpectedGifts(cart, matchedRules);
        if (unauthorizedGiftsRemoved || removedMatchedUnexpected) refreshCartAfterMutation();
      } else if (state.config.settings && state.config.settings.removeWhenIneligible) {
        var giftsRemoved = await removeManagedGifts(cart);
        if (unauthorizedGiftsRemoved || giftsRemoved) refreshCartAfterMutation();
      } else if (unauthorizedGiftsRemoved) {
        refreshCartAfterMutation();
      }
    } catch (error) {
      diagnostics.status = "cart-error";
      diagnostics.error = error.message || String(error);
      if (state.config.settings && state.config.settings.debugMode) console.warn("[FreeGiftManager]", error);
    } finally {
      state.busy = false;
      if (state.pending) scheduleCheck(150);
    }
  }

  function matchesRule(rule, cart) {
    if (rule.triggerType === "subtotal") return getEligibleSubtotal(cart) >= Number(rule.subtotalAmount || 0);
    if (rule.triggerType === "collection_subtotal") {
      return getCollectionSubtotal(cart, rule) >= Number(rule.subtotalAmount || 0);
    }
    if (rule.triggerType === "collection") {
      return getCollectionQuantity(cart, rule) >= Number(rule.triggerQuantity || 1);
    }
    if (rule.triggerType === "product") {
      var needle = String(rule.triggerValue || "").toLowerCase();
      if (!needle) return false;
      return cart.items.some(function (item) {
        if (isManagedGift(item)) return false;
        return String(item.handle || "").toLowerCase() === needle ||
          String(item.product_id) === needle ||
          String(item.variant_id) === needle;
      });
    }
    return false;
  }

  async function ensureGift(cart, rule) {
    var giftVariantId = String(rule.giftVariantId);
    if (!giftVariantId) return false;
    var expectedQuantity = Math.max(1, Number(rule.giftQuantity || 1));
    var attemptSignature = giftAttemptSignature(cart, rule);
    var giftProperties = {
      _free_gift_manager: "true",
      _free_gift_rule: String(rule.id),
      Gift: state.config.settings.giftLineLabel || "Free gift"
    };
    if (Number(rule.giftValue || 0) > 0) {
      giftProperties["Gift value"] = "\u20B9" + Number(rule.giftValue);
    }
    var gift = cart.items.find(function (item) {
      return String(item.variant_id) === giftVariantId &&
        isManagedGift(item) &&
        String(itemProperty(item, "_free_gift_rule")) === String(rule.id);
    });
    var propertiesMatch = gift &&
      String(itemProperty(gift, "Gift") || "") === String(giftProperties.Gift) &&
      String(itemProperty(gift, "Gift value") || "") === String(giftProperties["Gift value"] || "");
    var quantityMatches = !settingEnabled("lockGiftQuantity") || Number(gift && gift.quantity) === expectedQuantity;
    if (gift && quantityMatches && propertiesMatch) return false;
    if (isGiftAttemptBlocked(attemptSignature)) return false;

    try {
      if (gift) {
        var quantity = settingEnabled("lockGiftQuantity") ? expectedQuantity : Math.max(1, Number(gift.quantity || 1));
        await updateGiftLine(gift, quantity, giftProperties);
        clearGiftFailure();
        return true;
      }

      var response = await cartMutationFetch("/cart/add.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          id: Number(giftVariantId),
          quantity: expectedQuantity,
          properties: giftProperties
        })
      });
      if (!response.ok) throw await cartMutationError("Gift add failed", response);
      clearGiftFailure();
      return true;
    } catch (error) {
      rememberGiftFailure(attemptSignature, error);
      throw error;
    }
  }

  async function updateGiftLine(gift, quantity, properties) {
    var response = await cartMutationFetch("/cart/change.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ id: gift.key, quantity: quantity, properties: properties })
    });
    if (!response.ok) throw await cartMutationError("Gift line update failed", response);
    await response.json();
  }

  async function removeManagedGifts(cart) {
    var giftLines = cart.items.filter(function (item) {
      return isAnyManagedGift(item);
    });
    if (!giftLines.length) return false;
    await updateCartLines(giftLines, 0);
    return true;
  }

  async function removeUnauthorizedGiftLines(cart, rules) {
    var protectedVariantIds = [];
    (rules || []).forEach(function (rule) {
      protectedVariantIds = protectedVariantIds.concat(giftVariantIds(rule));
    });
    if (!protectedVariantIds.length) return false;

    var unauthorizedLines = (cart.items || []).filter(function (item) {
      return protectedVariantIds.indexOf(String(item.variant_id)) !== -1 && !isAnyManagedGift(item);
    });
    if (!unauthorizedLines.length) return false;
    await updateCartLines(unauthorizedLines, 0);
    return true;
  }

  async function removeUnexpectedGifts(cart, expectedRules) {
    var expectedRulesById = {};
    var expectedGiftFound = {};
    expectedRules.forEach(function (rule) {
      expectedRulesById[String(rule.id)] = giftVariantIds(rule);
    });
    var giftLines = cart.items.filter(function (item) {
      if (isLegacyManagedGift(item)) return true;
      if (!isManagedGift(item)) return false;
      var ruleId = String(itemProperty(item, "_free_gift_rule"));
      var isExpectedGift = (expectedRulesById[ruleId] || []).indexOf(String(item.variant_id)) !== -1;
      if (isExpectedGift && !expectedGiftFound[ruleId]) {
        expectedGiftFound[ruleId] = true;
        return false;
      }
      return true;
    });
    if (!giftLines.length) return false;
    await updateCartLines(giftLines, 0);
    return true;
  }

  async function updateCartLines(lines, quantity) {
    var updates = {};
    lines.forEach(function (item) {
      updates[item.key] = quantity;
    });
    var response = await cartMutationFetch("/cart/update.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ updates: updates })
    });
    if (!response.ok) throw await cartMutationError("Gift cart update failed", response);
    await response.json();
  }

  async function getCart() {
    var response = await fetch("/cart.js", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error("Cart check failed: " + response.status);
    return response.json();
  }

  async function onGiftChoiceClick(event) {
    var button = event.target && event.target.closest && event.target.closest("[data-fgm-add-choice]");
    if (!button || !state.config || state.busy) return;
    event.preventDefault();
    event.stopPropagation();

    var rule = (state.config.rules || []).find(function (item) {
      return String(item.id) === String(button.getAttribute("data-fgm-add-choice"));
    });
    if (!rule) return;

    var select = document.querySelector('[data-fgm-choice-select="' + escapeAttributeValue(rule.id) + '"]');
    var variantId = select ? select.value : "";
    if (!variantId) return;

    button.disabled = true;
    button.setAttribute("aria-busy", "true");

    try {
      var cart = state.lastCart || await getCart();
      var changed = await ensureGift(cart, Object.assign({}, rule, { giftVariantId: variantId }));
      if (changed) refreshCartAfterMutation();
      scheduleCheck(300);
    } catch (error) {
      if (state.config.settings && state.config.settings.debugMode) console.warn("[FreeGiftManager] Gift choice failed", error);
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  function renderMessage(matchedRule, cart, firstRule) {
    var host = getHost();
    if (!host) return;

    var box = document.querySelector("[data-free-gift-manager-box]");
    if (!box) {
      box = document.createElement("div");
      box.setAttribute("data-free-gift-manager-box", "true");
    }
    if (box.parentNode !== host) {
      host.prepend(box);
    }
    diagnostics.widgetMounted = box.parentNode === host;
    diagnostics.host = host.tagName || "unknown";

    var rule = matchedRule || firstRule;
    if (!rule) {
      box.innerHTML = "";
      return;
    }

    var locked = !matchedRule && (rule.triggerType === "subtotal" || rule.triggerType === "collection" || rule.triggerType === "collection_subtotal");
    var eligibleSubtotal = getEligibleSubtotal(cart);
    var collectionQuantity = getCollectionQuantity(cart, rule);
    var collectionSubtotal = getCollectionSubtotal(cart, rule);
    var remaining = 0;
    var percent = 100;
    var lockedDetailHtml = escapeHtml(giftDisplayTitle(rule));

    if (matchedRule && isChoiceGiftRule(rule)) {
      var choiceGift = findManagedGiftForRule(cart, rule);
      box.innerHTML = [
        '<div style="border:1px solid #ead1cc;background:#fff7f3;border-radius:8px;padding:12px;margin:12px 0;font-family:inherit;">',
        '<div style="font-weight:800;color:#8f1018;margin-bottom:4px;">' + escapeHtml(rule.messageUnlocked) + '</div>',
        choiceGift ? '<div style="font-size:13px;color:#4b3937;">' + escapeHtml(giftDisplayTitle(rule)) + '</div>' : giftChoiceHtml(rule),
        '<div style="height:7px;background:#efd8d4;border-radius:99px;overflow:hidden;margin-top:10px;"><span style="display:block;height:100%;width:100%;background:#8f1018;"></span></div>',
        '</div>'
      ].join("");
      return;
    }

    if (locked && rule.triggerType === "subtotal") {
      remaining = Math.max(0, Number(rule.subtotalAmount || 0) - eligibleSubtotal);
      percent = Math.min(100, Math.round((eligibleSubtotal / Number(rule.subtotalAmount || 1)) * 100));
      lockedDetailHtml = escapeHtml("Rs " + Math.ceil(remaining / 100) + " more to unlock " + rule.giftTitle + giftWorthSuffix(rule));
    } else if (locked && rule.triggerType === "collection_subtotal") {
      remaining = Math.max(0, Number(rule.subtotalAmount || 0) - collectionSubtotal);
      percent = Math.min(100, Math.round((collectionSubtotal / Number(rule.subtotalAmount || 1)) * 100));
      lockedDetailHtml = escapeHtml("Rs " + Math.ceil(remaining / 100) + " more from eligible collections to unlock " + rule.giftTitle + giftWorthSuffix(rule)) +
        collectionChipsHtml(rule);
    } else if (locked && rule.triggerType === "collection") {
      remaining = Math.max(0, Number(rule.triggerQuantity || 1) - collectionQuantity);
      percent = Math.min(100, Math.round((collectionQuantity / Number(rule.triggerQuantity || 1)) * 100));
      lockedDetailHtml = escapeHtml(remaining + " more " + (remaining === 1 ? "item" : "items") + " from eligible collections to unlock " + rule.giftTitle + giftWorthSuffix(rule)) +
        collectionChipsHtml(rule);
    }

    box.innerHTML = [
      '<div style="border:1px solid #ead1cc;background:#fff7f3;border-radius:8px;padding:12px;margin:12px 0;font-family:inherit;">',
      '<div style="font-weight:800;color:#8f1018;margin-bottom:4px;">' + escapeHtml(matchedRule ? rule.messageUnlocked : rule.messageLocked) + '</div>',
      '<div style="font-size:13px;color:#4b3937;">' + (matchedRule ? escapeHtml(giftDisplayTitle(rule)) : lockedDetailHtml) + '</div>',
      '<div style="height:7px;background:#efd8d4;border-radius:99px;overflow:hidden;margin-top:10px;"><span style="display:block;height:100%;width:' + percent + '%;background:#8f1018;"></span></div>',
      '</div>'
    ].join("");
  }

  function collectionChipsHtml(rule) {
    var source = rule.collectionTitle || rule.triggerValue || "";
    var labels = String(source)
      .split(/[,\r\n]+/)
      .map(function (entry) {
        var raw = entry.trim();
        var collectionMatch = raw.match(/\/collections\/([^/?#]+)/i);
        return humanizeCollectionLabel(collectionMatch ? collectionMatch[1] : raw);
      })
      .filter(Boolean);
    labels = labels.filter(function (label, index) {
      return labels.indexOf(label) === index;
    });
    if (!labels.length) return "";

    return '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">' + labels.map(function (label) {
      return '<span style="display:inline-flex;align-items:center;border:1px solid #e6c5bf;background:#fff;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700;line-height:1.25;color:#8f1018;">' + escapeHtml(label) + '</span>';
    }).join("") + '</div>';
  }

  function humanizeCollectionLabel(value) {
    var label = String(value || "")
      .replace(/^gid:\/\/shopify\/Collection\//i, "")
      .replace(/^https?:\/\/[^/]+\/collections\//i, "")
      .replace(/[?#].*$/, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!label || /^\d+$/.test(label)) return "";

    return label.replace(/\b\w/g, function (letter) {
      return letter.toUpperCase();
    }).replace(/\bIv\b/g, "IV");
  }

  function giftChoiceHtml(rule) {
    var variants = giftVariantOptions(rule);
    var enabledVariants = variants.filter(function (variant) { return variant.available !== false; });
    if (!enabledVariants.length) {
      return '<div style="font-size:13px;color:#4b3937;">' + escapeHtml(giftDisplayTitle(rule)) + '</div>';
    }

    return [
      '<div style="font-size:13px;color:#4b3937;margin-bottom:8px;">' + escapeHtml(giftDisplayTitle(rule)) + '</div>',
      '<div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;">',
      '<select data-fgm-choice-select="' + escapeAttributeValue(rule.id) + '" style="min-width:0;border:1px solid #e6c5bf;border-radius:6px;padding:8px;background:#fff;color:#4b3937;font:inherit;">',
      enabledVariants.map(function (variant) {
        return '<option value="' + escapeAttributeValue(variant.id) + '">' + escapeHtml(giftVariantLabel(variant)) + '</option>';
      }).join(""),
      '</select>',
      '<button data-fgm-add-choice="' + escapeAttributeValue(rule.id) + '" type="button" style="border:0;border-radius:6px;background:#8f1018;color:#fff;font-weight:800;padding:9px 12px;cursor:pointer;">Add free gift</button>',
      '</div>'
    ].join("");
  }

  function giftVariantOptions(rule) {
    return Array.isArray(rule.giftVariantOptions) ? rule.giftVariantOptions : [];
  }

  function giftVariantLabel(variant) {
    var title = String(variant.title || "").trim();
    return title && title.toLowerCase() !== "default title" ? title : "Default";
  }

  function isChoiceGiftRule(rule) {
    return rule && rule.giftSelectionMode === "choose_variant";
  }

  function giftVariantIds(rule) {
    var ids = [];
    if (rule && rule.giftVariantId) ids.push(String(rule.giftVariantId));
    giftVariantOptions(rule).forEach(function (variant) {
      if (variant && variant.id) ids.push(String(variant.id));
    });
    return ids.filter(function (id, index) {
      return id && ids.indexOf(id) === index;
    });
  }

  function findManagedGiftForRule(cart, rule) {
    var ids = giftVariantIds(rule);
    return (cart.items || []).find(function (item) {
      return ids.indexOf(String(item.variant_id)) !== -1 &&
        isManagedGift(item) &&
        String(itemProperty(item, "_free_gift_rule")) === String(rule.id);
    });
  }

  function getHost() {
    var selector = state.config.settings && state.config.settings.cartDrawerSelector;
    if (selector) {
      try {
        var customHost = document.querySelector(selector);
        if (customHost) return drawerContentHost(customHost);
      } catch (error) {
        console.warn("[FreeGiftManager] Invalid cart drawer selector", selector);
      }
    }
    var haloDrawerHost = document.querySelector("#halo-cart-sidebar .halo-sidebar-wrapper");
    if (haloDrawerHost && !document.body.classList.contains("template-cart")) return haloDrawerHost;
    var drawer = document.querySelector("cart-drawer-component") ||
      document.querySelector("cart-drawer") ||
      document.querySelector("#CartDrawer") ||
      document.querySelector(".cart-drawer");
    return drawer ? drawerContentHost(drawer) : document.querySelector("form[action='/cart']") ||
      document.body;
  }

  function drawerContentHost(drawer) {
    // Insert inside the visible panel, not alongside the drawer's overlay/dialog.
    return drawer.querySelector(".drawer__inner, .cart-drawer__inner, .cart-drawer__content, .halo-sidebar-wrapper, [role='dialog'], dialog") || drawer;
  }

  function refreshCartAfterMutation() {
    if (state.refreshing) return;
    state.refreshing = true;

    if (window.location.pathname.replace(/\/$/, "") === "/cart" || document.body.classList.contains("template-cart")) {
      window.setTimeout(function () { window.location.reload(); }, 120);
      return;
    }

    getCart().then(async function (cart) {
      var drawerUpdated = await refreshThemeCartDrawer(cart);
      if (!drawerUpdated) updateCartCount(cart);
      document.dispatchEvent(new CustomEvent("cart:updated", { detail: { source: "free-gift-manager", cart: cart } }));
      document.dispatchEvent(new CustomEvent("cart:refresh", { detail: { source: "free-gift-manager", cart: cart } }));
    }).catch(function (error) {
      console.warn("[FreeGiftManager] Drawer refresh failed", error);
    }).finally(function () {
      window.setTimeout(function () {
        state.refreshing = false;
        scheduleCheck(500);
      }, 500);
    });
  }

  async function refreshThemeCartDrawer(cart) {
    if (window.sharedFunctions && typeof window.sharedFunctions.updateSidebarCart === "function") {
      window.sharedFunctions.updateSidebarCart(cart);
      return true;
    }
    if (window.halo && typeof window.halo.updateSidebarCart === "function") {
      window.halo.updateSidebarCart(cart);
      return true;
    }
    var drawer = document.querySelector("cart-drawer");
    if (drawer && typeof drawer.renderContents === "function" && typeof drawer.getSectionsToRender === "function") {
      var sectionIds = drawer.getSectionsToRender().map(function (section) { return section.id; });
      var response = await fetch("/?sections=" + encodeURIComponent(sectionIds.join(",")), {
        credentials: "same-origin", cache: "no-store"
      });
      if (!response.ok) throw new Error("Cart sections failed: " + response.status);
      var sections = await response.json();
      if (sectionIds.some(function (id) { return typeof sections[id] !== "string"; })) {
        throw new Error("Cart sections unavailable");
      }
      drawer.renderContents({ sections: sections });
      return true;
    }
    return false;
  }

  function updateCartCount(cart) {
    document.querySelectorAll("[data-cart-count]").forEach(function (node) {
      node.textContent = cart.item_count < 100 ? cart.item_count : "99+";
    });
    document.querySelectorAll("[data-cart-text]").forEach(function (node) {
      node.textContent = cart.item_count === 1 ? "item" : "items";
    });
  }

  function installGiftControlGuard() {
    if (window.__freeGiftManagerControlGuard) return;
    window.__freeGiftManagerControlGuard = true;

    var style = document.createElement("style");
    style.setAttribute("data-free-gift-manager-lock-styles", "true");
    style.textContent = [
      '[data-fgm-gift-line="true"] quantity-input button,',
      '[data-fgm-gift-line="true"] .quantity button,',
      '[data-fgm-gift-line="true"] .previewCartItem-qty .btn-quantity,',
      '[data-fgm-gift-line="true"] .cart-item-qty .btn-quantity,',
      '[data-fgm-gift-line="true"] [data-minus-quantity-cart],',
      '[data-fgm-gift-line="true"] [data-plus-quantity-cart],',
      '[data-fgm-gift-line="true"] [data-cart-update],',
      '[data-fgm-gift-line="true"] [data-cart-remove],',
      '[data-fgm-gift-line="true"] .previewCartItem-remove { display:none !important; }',
      '[data-fgm-gift-line="true"] [name="updates[]"],',
      '[data-fgm-gift-line="true"] [data-cart-quantity] { pointer-events:none !important; }'
    ].join("\n");
    document.head.appendChild(style);

    document.addEventListener("click", blockProtectedGiftControl, true);
    document.addEventListener("change", blockProtectedGiftControl, true);
    document.addEventListener("input", blockProtectedGiftControl, true);

    if (window.MutationObserver) {
      var observer = new MutationObserver(function () {
        window.clearTimeout(state.controlTimer);
        state.controlTimer = window.setTimeout(function () {
          applyGiftControlLocks(state.lastCart);
        }, 50);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  function blockProtectedGiftControl(event) {
    if (!settingEnabled("lockGiftQuantity")) return;
    var target = event.target;
    var row = target && target.closest && target.closest('[data-fgm-gift-line="true"]');
    if (!row) return;
    var control = target.closest(
      '[data-cart-update], [data-cart-quantity], [data-cart-remove], [name="updates[]"], ' +
      'quantity-input button, .quantity button, .previewCartItem-qty .btn-quantity, ' +
      '.cart-item-qty .btn-quantity, [data-minus-quantity-cart], [data-plus-quantity-cart], ' +
      '.previewCartItem-remove'
    );
    if (!control) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    scheduleCheck(50);
  }

  function applyGiftControlLocks(cart) {
    document.querySelectorAll('[data-fgm-gift-line="true"]').forEach(function (row) {
      row.removeAttribute("data-fgm-gift-line");
    });
    if (!cart || !settingEnabled("lockGiftQuantity")) return;

    (cart.items || []).filter(isManagedGift).forEach(function (item) {
      findGiftLineRows(item).forEach(function (row) {
        row.setAttribute("data-fgm-gift-line", "true");
        row.querySelectorAll('[name="updates[]"], [data-cart-quantity]').forEach(function (input) {
          input.readOnly = true;
          input.setAttribute("aria-disabled", "true");
        });
      });
    });
  }

  function findGiftLineRows(item) {
    var anchors = [];
    var key = escapeAttributeValue(item.key || "");
    var variantId = escapeAttributeValue(item.variant_id || "");
    var selectors = [
      '[data-line="' + key + '"]',
      '[data-cart-item-key="' + key + '"]',
      '[data-cart-quantity-id="' + variantId + '"]'
    ];
    selectors.forEach(function (selector) {
      if (!key && selector.indexOf('data-cart-quantity-id') === -1) return;
      document.querySelectorAll(selector).forEach(function (node) { anchors.push(node); });
    });

    var rows = [];
    anchors.forEach(function (node) {
      var row = node.closest(
        '.previewCartItem, .cart-item, .cart__item, .mini-cart__item, ' +
        '[data-cart-item], [data-cart-item-key], tr'
      ) || node.parentElement;
      if (row && rows.indexOf(row) === -1) rows.push(row);
    });
    return rows;
  }

  function escapeAttributeValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function settingEnabled(name) {
    return !state.config.settings || state.config.settings[name] !== false;
  }

  function scheduleCheck(delay) {
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(checkCart, delay || 700);
  }

  function giftAttemptSignature(cart, rule) {
    var items = (cart.items || []).map(function (item) {
      return String(item.key || item.variant_id) + ":" + Number(item.quantity || 0);
    }).sort().join("|");
    return String(rule.id) + ":" + String(rule.giftVariantId) + ":" + items;
  }

  function isGiftAttemptBlocked(signature) {
    return state.failedGiftSignature === signature && Date.now() < state.giftRetryAfter;
  }

  function rememberGiftFailure(signature, error) {
    state.failedGiftSignature = signature;
    state.giftRetryAfter = Date.now() + (Number(error && error.status) === 429 ? 60000 : 15000);
  }

  function clearGiftFailure() {
    state.failedGiftSignature = "";
    state.giftRetryAfter = 0;
  }

  async function cartMutationFetch(url, options) {
    state.internalMutations += 1;
    try {
      return await fetch(url, options);
    } finally {
      state.internalMutations = Math.max(0, state.internalMutations - 1);
    }
  }

  async function cartMutationError(label, response) {
    var payload = await response.clone().json().catch(function () { return {}; });
    var message = payload.description || payload.message || response.status;
    var error = new Error(label + ": " + message);
    error.status = response.status;
    return error;
  }

  function isManagedGift(item) {
    return String(itemProperty(item, "_free_gift_manager")).toLowerCase() === "true";
  }

  function isLegacyManagedGift(item) {
    return Boolean(itemProperty(item, "_auto_free_gift") || itemProperty(item, "_auto_free_gift_sync"));
  }

  function isAnyManagedGift(item) {
    return isManagedGift(item) || isLegacyManagedGift(item);
  }

  function itemProperty(item, name) {
    var properties = item && item.properties ? item.properties : {};
    if (Array.isArray(properties)) {
      var property = properties.find(function (entry) {
        return entry && (entry.name === name || entry[0] === name);
      });
      return property ? (property.value !== undefined ? property.value : property[1]) : undefined;
    }
    return properties[name];
  }

  function getEligibleSubtotal(cart) {
    return (cart.items || []).reduce(function (sum, item) {
      return isAnyManagedGift(item) ? sum : sum + Number(item.final_line_price || item.line_price || 0);
    }, 0);
  }

  function getCollectionQuantity(cart, rule) {
    if (!isCollectionRule(rule)) return 0;
    var productIds = (rule.collectionProductIds || []).map(String);
    return (cart.items || []).reduce(function (sum, item) {
      if (isAnyManagedGift(item) || productIds.indexOf(String(item.product_id)) === -1) return sum;
      return sum + Number(item.quantity || 0);
    }, 0);
  }

  function getCollectionSubtotal(cart, rule) {
    if (!isCollectionRule(rule)) return 0;
    var productIds = (rule.collectionProductIds || []).map(String);
    return (cart.items || []).reduce(function (sum, item) {
      if (isAnyManagedGift(item) || productIds.indexOf(String(item.product_id)) === -1) return sum;
      return sum + Number(item.final_line_price || item.line_price || 0);
    }, 0);
  }

  function isCollectionRule(rule) {
    return !!rule && (rule.triggerType === "collection" || rule.triggerType === "collection_subtotal");
  }

  function giftDisplayTitle(rule) {
    return rule.giftTitle + (Number(rule.giftValue || 0) > 0 ? " - Worth \u20B9" + Number(rule.giftValue) : "");
  }

  function giftWorthSuffix(rule) {
    return Number(rule.giftValue || 0) > 0 ? " worth \u20B9" + Number(rule.giftValue) : "";
  }

  function hookCartRequests() {
    if (window.__freeGiftManagerCartHooks) return;
    window.__freeGiftManagerCartHooks = true;

    var originalFetch = window.fetch;
    if (originalFetch) {
      window.fetch = function () {
        var request = arguments[0];
        var url = typeof request === "string" ? request : request && request.url;
        var internalMutation = state.internalMutations > 0;
        var result = originalFetch.apply(this, arguments);
        if (!internalMutation && isCartMutation(url)) result.finally(function () { scheduleCheck(450); });
        return result;
      };
    }

    var originalOpen = XMLHttpRequest.prototype.open;
    var originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__freeGiftManagerCartUrl = url;
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      if (isCartMutation(this.__freeGiftManagerCartUrl)) {
        this.addEventListener("loadend", function () { scheduleCheck(450); });
      }
      return originalSend.apply(this, arguments);
    };
  }

  function isCartMutation(url) {
    return /\/cart\/(add|change|update|clear)(\.js)?/.test(String(url || ""));
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char];
    });
  }
})();
