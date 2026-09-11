const params = new URLSearchParams(location.search);
const shop = params.get("shop") || localStorage.getItem("fgm_shop") || "";
if (shop) localStorage.setItem("fgm_shop", shop);

const state = {
  rules: [],
  editing: null,
  collections: null,
  selectedCollectionHandles: new Set(),
  pickerSelection: new Set()
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

init();

function init() {
  $("#shopLabel").textContent = shop ? `Connected store: ${shop}` : "Add ?shop=your-store.myshopify.com to connect.";
  $("#installButton").addEventListener("click", () => {
    const targetShop = shop || prompt("Enter shop domain, e.g. brownanatomy.myshopify.com");
    if (targetShop) location.href = `/auth?shop=${encodeURIComponent(targetShop)}`;
  });

  $$(".nav-item").forEach((button) => button.addEventListener("click", () => showTab(button.dataset.tab)));
  $$("[data-tab-jump]").forEach((button) => button.addEventListener("click", () => showTab(button.dataset.tabJump)));

  $("#triggerType").addEventListener("change", updateTriggerFields);
  $("#openCollectionPicker").addEventListener("click", openCollectionPicker);
  $("#addManualCollection").addEventListener("click", addManualCollection);
  $("#manualCollectionValue").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addManualCollection();
    }
  });
  $("#closeCollectionPicker").addEventListener("click", closeCollectionPicker);
  $("#cancelCollectionPicker").addEventListener("click", closeCollectionPicker);
  $("#applyCollections").addEventListener("click", applyCollectionSelection);
  $("#refreshCollections").addEventListener("click", () => loadCollections(true));
  $("#collectionSearch").addEventListener("input", renderCollectionOptions);
  $("#collectionPickerModal").addEventListener("click", (event) => {
    if (event.target === $("#collectionPickerModal")) closeCollectionPicker();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#collectionPickerModal").classList.contains("hidden")) closeCollectionPicker();
  });
  $("#giftTitle").addEventListener("input", updateGiftPreview);
  $("#giftValue").addEventListener("input", updateGiftPreview);
  $("#giftSelectionMode").addEventListener("change", updateGiftPreview);
  $("#messageUnlocked").addEventListener("input", () => $("#previewMessage").textContent = $("#messageUnlocked").value || "You unlocked a free gift");
  $("#ruleForm").addEventListener("submit", saveRule);
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#resetForm").addEventListener("click", resetForm);

  updateTriggerFields();
  loadRules();
  loadSettings();
}

function api(path) {
  if (!shop) throw new Error("Missing shop");
  const joiner = path.includes("?") ? "&" : "?";
  return `${path}${joiner}shop=${encodeURIComponent(shop)}`;
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  return fetch(api(path), { ...options, headers });
}

function showTab(tab) {
  $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === tab));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
}

function updateTriggerFields() {
  const type = $("#triggerType").value;
  const usesCollection = type === "collection" || type === "collection_subtotal";
  $("#triggerValueWrap").classList.toggle("hidden", type !== "product");
  $("#collectionValueWrap").classList.toggle("hidden", !usesCollection);
  $("#collectionQuantityWrap").classList.toggle("hidden", type !== "collection");
  $("#subtotalWrap").classList.toggle("hidden", type !== "subtotal" && type !== "collection_subtotal");
}

async function openCollectionPicker() {
  state.pickerSelection = new Set(state.selectedCollectionHandles);
  $("#collectionSearch").value = "";
  $("#collectionPickerModal").classList.remove("hidden");
  renderCollectionOptions();
  updateCollectionSelectionCount();
  if (!state.collections) await loadCollections();
}

function closeCollectionPicker() {
  $("#collectionPickerModal").classList.add("hidden");
}

async function loadCollections(forceRefresh = false) {
  const status = $("#collectionPickerStatus");
  status.classList.remove("error");
  status.textContent = "Loading collections...";
  $("#refreshCollections").disabled = true;

  try {
    const res = await request(`/api/collections${forceRefresh ? "?refresh=1" : ""}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not load collections");

    state.collections = data.collections || [];
    state.selectedCollectionHandles = normalizeCollectionSelection(state.selectedCollectionHandles);
    state.pickerSelection = normalizeCollectionSelection(state.pickerSelection);
    renderSelectedCollections();
    renderCollectionOptions();
    status.classList.toggle("warning", !!data.warning);
    status.textContent = `${state.collections.length} collections available${data.warning ? `. ${data.warning}` : ""}`;
  } catch (error) {
    state.collections = [];
    status.classList.remove("warning");
    status.classList.add("error");
    status.textContent = `${error.message}. You can still add a collection URL or handle manually.`;
    renderCollectionOptions();
  } finally {
    $("#refreshCollections").disabled = false;
  }
}

function normalizeCollectionSelection(selection) {
  return new Set([...selection].map((token) => {
    const collection = findCollection(token);
    return collection ? collection.handle : token;
  }).filter(Boolean));
}

function findCollection(token) {
  return (state.collections || []).find((collection) =>
    collection.handle === token || collection.id === token || collection.gid === token
  );
}

function parseCollectionSelection(value) {
  return String(value || "")
    .split(/[,\r\n]+/)
    .map((entry) => {
      const raw = entry.trim();
      const match = raw.match(/\/collections\/([^/?#]+)/i);
      return match ? match[1] : raw;
    })
    .filter(Boolean);
}

function setSelectedCollections(handles) {
  state.selectedCollectionHandles = new Set(handles);
  $("#collectionValue").value = [...state.selectedCollectionHandles].join(",");
  renderSelectedCollections();
}

async function addManualCollection() {
  const input = $("#manualCollectionValue");
  const tokens = parseCollectionSelection(input.value);
  if (!tokens.length) {
    alert("Enter a collection URL, handle, or ID");
    return;
  }

  if (!state.collections) await loadCollections();
  const resolvedTokens = tokens.map((token) => findCollection(token)?.handle || token);
  setSelectedCollections(new Set([...state.selectedCollectionHandles, ...resolvedTokens]));
  input.value = "";
}

function renderSelectedCollections() {
  const container = $("#selectedCollections");
  const handles = [...state.selectedCollectionHandles];

  if (!handles.length) {
    container.innerHTML = '<span class="empty-selection">No collections selected</span>';
    return;
  }

  container.innerHTML = handles.map((handle) => {
    const collection = findCollection(handle);
    const title = collection?.title || handle;
    return `<span class="collection-chip"><span title="${escapeHtml(title)}">${escapeHtml(title)}</span><button type="button" data-remove-collection="${encodeURIComponent(handle)}" title="Remove" aria-label="Remove ${escapeHtml(title)}">&#215;</button></span>`;
  }).join("");

  $$('[data-remove-collection]').forEach((button) => button.addEventListener("click", () => {
    const handle = decodeURIComponent(button.dataset.removeCollection);
    const nextSelection = new Set(state.selectedCollectionHandles);
    nextSelection.delete(handle);
    setSelectedCollections(nextSelection);
  }));
}

function renderCollectionOptions() {
  const container = $("#collectionOptions");
  const query = $("#collectionSearch").value.trim().toLowerCase();
  const collections = (state.collections || []).filter((collection) =>
    !query || collection.title.toLowerCase().includes(query) || collection.handle.toLowerCase().includes(query)
  );

  if (!state.collections) {
    container.innerHTML = "";
    return;
  }

  if (!collections.length) {
    container.innerHTML = '<div class="empty-state">No matching collections</div>';
    return;
  }

  container.innerHTML = collections.map((collection) => `
    <label class="collection-option">
      <input type="checkbox" data-collection-option="${escapeHtml(collection.handle)}"${state.pickerSelection.has(collection.handle) ? " checked" : ""}>
      <span><strong>${escapeHtml(collection.title)}</strong><small>${escapeHtml(collection.handle)}</small></span>
    </label>
  `).join("");

  $$('[data-collection-option]').forEach((input) => input.addEventListener("change", () => {
    if (input.checked) state.pickerSelection.add(input.dataset.collectionOption);
    else state.pickerSelection.delete(input.dataset.collectionOption);
    updateCollectionSelectionCount();
  }));
}

function updateCollectionSelectionCount() {
  const count = state.pickerSelection.size;
  $("#collectionSelectionCount").textContent = `${count} selected`;
}

function applyCollectionSelection() {
  setSelectedCollections(state.pickerSelection);
  closeCollectionPicker();
}

async function loadRules() {
  if (!shop) {
    renderRules([]);
    return;
  }

  const res = await request("/api/rules");
  const data = await res.json();
  state.rules = data.rules || [];
  renderRules(state.rules);
}

function renderRules(rules) {
  $("#metricActive").textContent = rules.filter((rule) => rule.status === "active").length;
  $("#emptyRules").classList.toggle("hidden", rules.length > 0);
  $("#rulesTable").innerHTML = rules.map((rule) => `
    <tr>
      <td><strong>${escapeHtml(rule.name)}</strong></td>
      <td>${triggerLabel(rule)}</td>
      <td>${escapeHtml(rule.giftTitle)}${rule.giftValue > 0 ? `<br><small>Worth \u20B9${rule.giftValue}</small>` : ""}<br><small>${rule.giftSelectionMode === "choose_variant" ? "Customer chooses variant" : "Auto gift"}</small><br><small>Variant: ${escapeHtml(rule.giftVariantId)}</small>${rule.giftProductId ? `<br><small>Product: ${escapeHtml(rule.giftProductId)}</small>` : ""}${rule.directCheckoutEnabled ? "<br><small>Buy Now enabled</small>" : ""}</td>
      <td><span class="badge ${rule.status === "active" ? "success" : "draft"}">${rule.status}</span></td>
      <td>${rule.priority}</td>
      <td>
        <div class="row-actions">
          <button class="link-button" data-edit="${rule.id}">Edit</button>
          <button class="link-button" data-duplicate="${rule.id}">Duplicate</button>
          <button class="link-button" data-delete="${rule.id}">Delete</button>
        </div>
      </td>
    </tr>
  `).join("");

  $$("[data-edit]").forEach((button) => button.addEventListener("click", () => editRule(Number(button.dataset.edit))));
  $$("[data-duplicate]").forEach((button) => button.addEventListener("click", () => duplicateRule(Number(button.dataset.duplicate))));
  $$("[data-delete]").forEach((button) => button.addEventListener("click", () => deleteRule(Number(button.dataset.delete))));
}

function triggerLabel(rule) {
  if (rule.triggerType === "subtotal") return `Cart subtotal >= Rs ${(rule.subtotalAmount / 100).toFixed(0)}`;
  if (rule.triggerType === "collection_subtotal") {
    return `${escapeHtml(rule.collectionTitle || rule.triggerValue || "Collection")} subtotal >= Rs ${(rule.subtotalAmount / 100).toFixed(0)}`;
  }
  if (rule.triggerType === "collection") {
    return `${rule.triggerQuantity || 1}+ items from ${escapeHtml(rule.collectionTitle || rule.triggerValue || "collection")}`;
  }
  return `Product is ${escapeHtml(rule.triggerValue || "not set")}`;
}

function editRule(id) {
  const rule = state.rules.find((item) => item.id === id);
  if (!rule) return;
  fillForm(rule);
  showTab("create");
}

function duplicateRule(id) {
  const rule = state.rules.find((item) => item.id === id);
  if (!rule) return;
  fillForm({ ...rule, id: "", name: `${rule.name} copy`, status: "draft" });
  showTab("create");
}

async function deleteRule(id) {
  if (!confirm("Delete this gift rule?")) return;
  await request(`/api/rules/${id}`, { method: "DELETE" });
  await loadRules();
}

function fillForm(rule) {
  const usesCollection = rule.triggerType === "collection" || rule.triggerType === "collection_subtotal";
  $("#formTitle").textContent = rule.id ? "Edit gift rule" : "Create gift rule";
  $("#ruleId").value = rule.id || "";
  $("#name").value = rule.name || "";
  $("#status").value = rule.status || "draft";
  $("#triggerType").value = rule.triggerType || "product";
  $("#triggerValue").value = rule.triggerType === "product" ? (rule.triggerValue || "") : "";
  setSelectedCollections(usesCollection ? parseCollectionSelection(rule.triggerValue) : []);
  $("#triggerQuantity").value = rule.triggerQuantity || 1;
  $("#subtotalAmount").value = rule.subtotalAmount || 0;
  $("#giftVariantId").value = rule.giftVariantId || "";
  $("#giftSelectionMode").value = rule.giftSelectionMode || "auto";
  $("#giftProductId").value = rule.giftProductId || "";
  $("#giftTitle").value = rule.giftTitle || "";
  $("#giftValue").value = rule.giftValue || 0;
  $("#giftImage").value = rule.giftImage || "";
  $("#giftQuantity").value = rule.giftQuantity || 1;
  $("#autoAdd").checked = rule.autoAdd !== false;
  $("#directCheckoutEnabled").checked = rule.directCheckoutEnabled === true;
  $("#limitOnePerOrder").checked = rule.limitOnePerOrder !== false;
  $("#messageUnlocked").value = rule.messageUnlocked || "You unlocked a free gift";
  $("#messageLocked").value = rule.messageLocked || "Add more to unlock your free gift";
  $("#priority").value = rule.priority || 1;
  updateGiftPreview();
  $("#previewMessage").textContent = $("#messageUnlocked").value || "You unlocked a free gift";
  updateTriggerFields();
}

function resetForm() {
  $("#ruleForm").reset();
  $("#ruleId").value = "";
  $("#formTitle").textContent = "Create gift rule";
  $("#status").value = "active";
  $("#triggerType").value = "product";
  $("#triggerQuantity").value = 2;
  $("#giftValue").value = 299;
  $("#giftQuantity").value = 1;
  $("#priority").value = 1;
  $("#autoAdd").checked = true;
  $("#giftSelectionMode").value = "auto";
  $("#directCheckoutEnabled").checked = false;
  $("#limitOnePerOrder").checked = true;
  setSelectedCollections([]);
  updateTriggerFields();
  updateGiftPreview();
}

async function saveRule(event) {
  event.preventDefault();
  if (!shop) {
    alert("Shop is missing. Open the app with ?shop=your-store.myshopify.com");
    return;
  }

  const id = $("#ruleId").value;
  const payload = formRule();
  if ((payload.triggerType === "collection" || payload.triggerType === "collection_subtotal") && !payload.triggerValue.trim()) {
    alert("Select at least one collection");
    return;
  }
  if (!payload.giftVariantId.trim() && !payload.giftProductId.trim()) {
    alert("Enter a gift variant ID or gift product ID");
    return;
  }
  const res = await request(id ? `/api/rules/${id}` : "/api/rules", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "Could not save rule");
    return;
  }
  $("#saveNotice").textContent = "Saved";
  setTimeout(() => $("#saveNotice").textContent = "", 1800);
  await loadRules();
  showTab("rules");
}

function formRule() {
  const triggerType = $("#triggerType").value;
  const usesCollection = triggerType === "collection" || triggerType === "collection_subtotal";
  return {
    name: $("#name").value,
    status: $("#status").value,
    triggerType,
    triggerValue: usesCollection ? $("#collectionValue").value : $("#triggerValue").value,
    subtotalAmount: Number($("#subtotalAmount").value || 0),
    triggerQuantity: Number($("#triggerQuantity").value || 1),
    giftVariantId: $("#giftVariantId").value,
    giftSelectionMode: $("#giftSelectionMode").value,
    giftProductId: $("#giftProductId").value,
    giftTitle: $("#giftTitle").value,
    giftValue: Number($("#giftValue").value || 0),
    giftImage: $("#giftImage").value,
    giftQuantity: Number($("#giftQuantity").value || 1),
    autoAdd: $("#autoAdd").checked,
    directCheckoutEnabled: $("#directCheckoutEnabled").checked,
    limitOnePerOrder: $("#limitOnePerOrder").checked,
    messageUnlocked: $("#messageUnlocked").value,
    messageLocked: $("#messageLocked").value,
    priority: Number($("#priority").value || 1)
  };
}

function updateGiftPreview() {
  const value = Number($("#giftValue").value || 0);
  $("#previewGiftTitle").textContent = $("#giftTitle").value || "Free gift";
  $("#previewGiftValue").textContent = value > 0 ? ` - Worth \u20B9${value}` : "";
  $("#previewGiftButton").textContent = $("#giftSelectionMode").value === "choose_variant" ? "Choose gift size" : "Added automatically";
}

async function loadSettings() {
  if (!shop) return;
  const res = await request("/api/settings");
  const data = await res.json();
  const settings = data.settings || {};
  $("#enabled").checked = settings.enabled !== false;
  $("#removeWhenIneligible").checked = settings.removeWhenIneligible !== false;
  $("#lockGiftQuantity").checked = settings.lockGiftQuantity !== false;
  $("#blockManualGiftAdd").checked = settings.blockManualGiftAdd !== false;
  $("#debugMode").checked = settings.debugMode === true;
  $("#giftLineLabel").value = settings.giftLineLabel || "Free gift";
  $("#cartDrawerSelector").value = settings.cartDrawerSelector || "";
  $("#appStatus").textContent = settings.enabled === false ? "Disabled" : "Active";
}

async function saveSettings(event) {
  event.preventDefault();
  if (!shop) {
    alert("Shop is missing. Open the app with ?shop=your-store.myshopify.com");
    return;
  }
  await request("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enabled: $("#enabled").checked,
      removeWhenIneligible: $("#removeWhenIneligible").checked,
      lockGiftQuantity: $("#lockGiftQuantity").checked,
      blockManualGiftAdd: $("#blockManualGiftAdd").checked,
      debugMode: $("#debugMode").checked,
      giftLineLabel: $("#giftLineLabel").value,
      cartDrawerSelector: $("#cartDrawerSelector").value
    })
  });
  $("#settingsNotice").textContent = "Saved";
  $("#appStatus").textContent = $("#enabled").checked ? "Active" : "Disabled";
  setTimeout(() => $("#settingsNotice").textContent = "", 1800);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}
