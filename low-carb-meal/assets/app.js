// ==================== 1. 食譜資料（由 data/recipes.json 載入） ====================
let CORE_RECIPES = [];
let HIDDEN_RECIPES = [];

async function loadRecipeData() {
  const res = await fetch("data/recipes.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  CORE_RECIPES = Array.isArray(data.core) ? data.core : [];
  HIDDEN_RECIPES = Array.isArray(data.hidden) ? data.hidden : [];
}

const DAYS = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"];
const STORAGE_KEY = "lowcarb_icebrick_planner_v1";
// 主食：每份約 15g 碳水（一般食物代換表的粗略換算，僅供參考，實際請依營養師建議）
const STAPLES = {
  brown_rice:   { name: "糙米飯", kind: "rice",   cooked: 50, dry: 20, shopName: "糙米（乾）" },
  multigrain:   { name: "五穀飯", kind: "rice",   cooked: 50, dry: 20, shopName: "五穀米（乾）" },
  sweet_potato: { name: "地瓜",   kind: "potato", raw: 55,               shopName: "地瓜（主食用）" }
};
const STAPLE_ROTATION = ["brown_rice", "sweet_potato", "multigrain"];
const MEAL_TYPE_MAP = { breakfast: "breakfast", lunch: "lunch_bento", dinner: "dinner" };
const SLOT_LABEL = { breakfast: "🌅 早餐", lunch: "🍱 午餐便當", dinner: "🌙 晚餐" };
const MEAL_TYPE_LABEL = { breakfast: "早餐", lunch_bento: "午餐便當", dinner: "晚餐" };
const CATEGORY_ORDER = ["主食", "肉蛋魚豆", "葉菜與花椰", "根莖瓜果", "菇類與常備", "冷藏乳品", "臨時加買"];

// ==================== 3. 狀態管理與排程核心 ====================
let state = {
  mealMode: "lunch_dinner",
  cookware: "all",
  staple: "rotate",
  stapleServings: 1,
  servings: 1,
  extraRecipes: [],   // 已解鎖 + 匯入的食譜（核心食譜不存檔）
  unlockedIds: [],
  schedule: [],
  checkedItems: {},
  qtyAdjust: {},
  customItems: []
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function allRecipes() { return [...CORE_RECIPES, ...state.extraRecipes]; }
function getRecipe(id) { return allRecipes().find(r => r.id === id); }

function activeSlots() {
  if (state.mealMode === "dinner_only") return ["dinner"];
  if (state.mealMode === "three_meals") return ["breakfast", "lunch", "dinner"];
  return ["lunch", "dinner"];
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      Object.keys(state).forEach(k => { if (parsed[k] !== undefined) state[k] = parsed[k]; });
    } catch (e) {
      console.error("讀取存檔失敗", e);
    }
  }
  if (!Array.isArray(state.schedule) || state.schedule.length !== 7) {
    generateSchedule(false);
  }
  document.getElementById("mealModeSelect").value = state.mealMode;
  document.getElementById("cookwareSelect").value = state.cookware;
  document.getElementById("stapleSelect").value = state.staple;
  document.getElementById("stapleServingsSelect").value = String(state.stapleServings);
  document.getElementById("servingsSelect").value = String(state.servings);
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

function cookwareMatch(r) {
  if (state.cookware === "all") return true;
  const c = r.cookware || "";
  if (state.cookware === "iron") return /鐵鍋|湯鍋/.test(c);
  return c === state.cookware;
}

function pickRandomRecipe(type, excludeIds = []) {
  const all = allRecipes();
  const ofType = all.filter(r => r.mealType.includes(type));
  // 優先符合器具篩選；若該餐別沒有符合的食譜，退回該餐別全部食譜
  let base = ofType.filter(cookwareMatch);
  if (base.length === 0) base = ofType;
  let pool = base.filter(r => !excludeIds.includes(r.id));
  if (pool.length === 0) pool = base;
  if (pool.length === 0) return "EATING_OUT";
  return pool[Math.floor(Math.random() * pool.length)].id;
}

function generateSchedule(notify = true) {
  const usedLunch = [];
  const usedDinner = [];
  const usedBf = [];
  const newSchedule = [];
  for (let i = 0; i < 7; i++) {
    const bfId = pickRandomRecipe("breakfast", usedBf.slice(-1));
    usedBf.push(bfId);
    const lunchId = (i === 2) ? "EATING_OUT" : pickRandomRecipe("lunch_bento", usedLunch.slice(-3));
    if (lunchId !== "EATING_OUT") usedLunch.push(lunchId);
    const dinnerId = (i === 4) ? "EATING_OUT" : pickRandomRecipe("dinner", usedDinner.slice(-3));
    if (dinnerId !== "EATING_OUT") usedDinner.push(dinnerId);
    newSchedule.push({ dayIndex: i, breakfast: bfId, lunch: lunchId, dinner: dinnerId });
  }
  state.schedule = newSchedule;
  state.checkedItems = {};
  state.qtyAdjust = {};
  saveState();
  if (notify) {
    renderAll();
    showToast("🔄 已重新輪替本週低碳菜單（保留 2 餐外食）！");
  }
}

function regenerateWeek() { generateSchedule(true); }

function swapSingleMeal(dayIndex, slotKey) {
  const currentId = state.schedule[dayIndex][slotKey];
  state.schedule[dayIndex][slotKey] = pickRandomRecipe(MEAL_TYPE_MAP[slotKey], [currentId]);
  saveState();
  renderAll();
  showToast("已抽換該餐菜色，採買清單已同步更新！");
}

function toggleEatingOut(dayIndex, slotKey) {
  if (state.schedule[dayIndex][slotKey] === "EATING_OUT") {
    state.schedule[dayIndex][slotKey] = pickRandomRecipe(MEAL_TYPE_MAP[slotKey]);
    showToast("已切回自煮冰磚餐，食材已加入採買清單");
  } else {
    state.schedule[dayIndex][slotKey] = "EATING_OUT";
    showToast("已設為外食放鬆餐，該餐食材已自動扣除");
  }
  saveState();
  renderAll();
}

function changeMealMode() {
  state.mealMode = document.getElementById("mealModeSelect").value;
  saveState();
  renderAll();
}

function toggleSettings() {
  const bar = document.querySelector(".controls-bar");
  const open = bar.classList.toggle("open");
  const btn = document.getElementById("settingsToggle");
  btn.setAttribute("aria-expanded", String(open));
  btn.textContent = open ? "✖ 收起設定" : "⚙️ 設定";
}

function changeStaple() {
  state.staple = document.getElementById("stapleSelect").value;
  state.stapleServings = Number(document.getElementById("stapleServingsSelect").value);
  saveState();
  renderAll();
}

// 回傳某一餐需要額外加的主食；食譜已含定量地瓜者，視為已有 1 份
function stapleFor(dayIndex, slotKey, recipe) {
  if (slotKey !== "lunch" && slotKey !== "dinner") return null;
  if (state.stapleServings <= 0 || !recipe) return null;
  const builtIn = (recipe.extraBricks || []).some(b => /地瓜/.test(b)) ? 1 : 0;
  const need = Math.max(0, state.stapleServings - builtIn);
  const key = state.staple === "rotate"
    ? STAPLE_ROTATION[(dayIndex * 2 + (slotKey === "lunch" ? 0 : 1)) % STAPLE_ROTATION.length]
    : state.staple;
  return { key, def: STAPLES[key], total: state.stapleServings, builtIn, need };
}

function stapleLineHtml(dayIndex, slotKey, recipe) {
  const st = stapleFor(dayIndex, slotKey, recipe);
  if (!st) return "";
  const style = 'style="margin-top:6px; border-left-color:var(--accent);"';
  if (st.need === 0) {
    return `<div class="reheat-box" ${style}>🍠 主食：已含定量地瓜（約 ${st.builtIn} 份），不另加</div>`;
  }
  const amount = st.def.kind === "rice" ? `熟 ${st.need * st.def.cooked}g` : `約 ${st.need * st.def.raw}g`;
  const extra = st.builtIn ? `（加上食譜內的地瓜，共 ${st.total} 份）` : "";
  return `<div class="reheat-box" ${style}>🍚 主食：${esc(st.def.name)} ${amount}（${st.need} 份）${extra}，與主菜同盒微波</div>`;
}

// 本週各主食的總份數（含人數）
function stapleTotals() {
  const totals = {};
  state.schedule.forEach((day, i) => {
    ["lunch", "dinner"].forEach(slotKey => {
      if (!activeSlots().includes(slotKey)) return;
      const id = day[slotKey];
      if (!id || id === "EATING_OUT") return;
      const st = stapleFor(i, slotKey, getRecipe(id));
      if (!st || st.need === 0) return;
      totals[st.key] = (totals[st.key] || 0) + st.need * state.servings;
    });
  });
  return totals;
}

function changeCookware() {
  state.cookware = document.getElementById("cookwareSelect").value;
  generateSchedule(false);
  renderAll();
  showToast("已依料理器具重新排程");
}

function changeServings() {
  state.servings = Number(document.getElementById("servingsSelect").value);
  saveState();
  renderAll();
}

function switchTab(name, btn) {
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");
  if (btn) btn.classList.add("active");
}

function microwaveTime(recipe) {
  const t = recipe.lunchReheat || recipe.reheatNote || "";
  const m = t.match(/微波\s*(?:約\s*)?(\d+(?:～\d+)?)\s*分(鐘|半)?/);
  if (!m) return "";
  return `${m[1]} ${m[2] === "半" ? "分半" : "分鐘"}`;
}

function reheatHtml(recipe, slotKey) {
  if (slotKey === "lunch") {
    let t = recipe.lunchReheat || recipe.reheatNote || "";
    if (!/微波/.test(t)) t += "（便當一律以微波復熱，請自行確認時間）";
    return "🔥 微波復熱：" + esc(t);
  }
  return "🔥 復熱：" + esc(recipe.reheatNote || "");
}

// ==================== 4. 渲染：本週菜單 ====================
function renderPlan() {
  const slots = activeSlots();
  const html = state.schedule.map((day, i) => {
    const slotsHtml = slots.map(slotKey => {
      let id = day[slotKey];
      let recipe = id === "EATING_OUT" ? null : getRecipe(id);
      if (id !== "EATING_OUT" && !recipe) {
        // 食譜已不存在，自動補一道
        id = pickRandomRecipe(MEAL_TYPE_MAP[slotKey]);
        day[slotKey] = id;
        recipe = id === "EATING_OUT" ? null : getRecipe(id);
      }
      const label = SLOT_LABEL[slotKey];
      if (!recipe) {
        return `
          <div class="meal-slot eating-out">
            <div class="slot-top">
              <span class="slot-label">${label}</span>
              <div class="slot-actions">
                <button class="btn btn-outline" onclick="toggleEatingOut(${i},'${slotKey}')">改自煮</button>
              </div>
            </div>
            <div class="meal-name">🍽️ 外食放鬆餐</div>
            <div class="reheat-box">建議：選擇原型食物（燒烤、滷味、火鍋肉盤），主食減半、先吃菜與蛋白質。</div>
          </div>`;
      }
      const tags = [`<span class="badge badge-green">${esc(recipe.brickSpec.size)} ×${recipe.brickSpec.count}</span>`]
        .concat(slotKey === "lunch" ? [`<span class="badge badge-amber">備料：${esc(recipe.cookware || "")}</span>`] : [])
        .concat((recipe.extraBricks || []).map(b => `<span class="badge badge-gray">${esc(b)}</span>`))
        .join("");
      return `
        <div class="meal-slot">
          <div class="slot-top">
            <span class="slot-label">${slotKey === "lunch" ? `${label}・微波 ${esc(microwaveTime(recipe) || "復熱")}` : `${label}・備料：${esc(recipe.cookware || "")}`}</span>
            <div class="slot-actions">
              <button class="btn btn-outline" onclick="swapSingleMeal(${i},'${slotKey}')">換一道</button>
              <button class="btn btn-outline" onclick="toggleEatingOut(${i},'${slotKey}')">外食</button>
            </div>
          </div>
          <div class="meal-name">${esc(recipe.name)}</div>
          <div class="brick-tags">${tags}</div>
          <div class="reheat-box">${reheatHtml(recipe, slotKey)}</div>
          ${stapleLineHtml(i, slotKey, recipe)}
        </div>`;
    }).join("");

    const bfNote = state.mealMode === "three_meals" ? "" : `
      <div class="meal-slot">
        <div class="slot-label">🌅 早餐</div>
        <div class="meal-name" style="font-size:0.88rem;">固定：生菜＋蛋＋肉（不列入採買）</div>
      </div>`;

    return `
      <div class="day-card">
        <div class="day-header">
          <span class="day-title">${DAYS[i]}</span>
          <span class="badge badge-gray">${slots.length} 餐規劃</span>
        </div>
        ${bfNote}${slotsHtml}
      </div>`;
  }).join("");
  document.getElementById("weekGrid").innerHTML = html;
}

// ==================== 5. 採買清單 ====================
function formatQty(n, unit) {
  return unit === "g" ? `${n}g` : `${n}${unit}`;
}

function buildShopping() {
  const slots = activeSlots();
  const map = {};
  state.schedule.forEach(day => {
    slots.forEach(slotKey => {
      const id = day[slotKey];
      if (!id || id === "EATING_OUT") return;
      const recipe = getRecipe(id);
      if (!recipe) return;
      (recipe.ingredients || []).forEach(ing => {
        const cat = ing.category || "菇類與常備";
        const key = `${cat}|${ing.item}|${ing.unit}`;
        if (!map[key]) {
          map[key] = { key, cat, name: ing.item, unit: ing.unit, base: 0, alt: ing.alt || "" };
        }
        map[key].base += Number(ing.amount) || 0;
      });
    });
  });
  // 主食（每人份基準，顯示時再乘人數）
  state.schedule.forEach((day, i) => {
    ["lunch", "dinner"].forEach(slotKey => {
      if (!activeSlots().includes(slotKey)) return;
      const id = day[slotKey];
      if (!id || id === "EATING_OUT") return;
      const st = stapleFor(i, slotKey, getRecipe(id));
      if (!st || st.need === 0) return;
      const d = st.def;
      const key = `主食|${d.shopName}|g`;
      if (!map[key]) {
        map[key] = { key, cat: "主食", name: d.shopName, unit: "g", base: 0,
          alt: d.kind === "rice" ? "乾米煮熟後約 2.5 倍重；可改買其他米種" : "可改蒸南瓜或芋頭（份量請參考食物代換表）" };
      }
      map[key].base += st.need * (d.kind === "rice" ? d.dry : d.raw);
    });
  });
  const grouped = {};
  Object.values(map).forEach(it => {
    (grouped[it.cat] = grouped[it.cat] || []).push(it);
  });
  return grouped;
}

function renderShopping() {
  const grouped = buildShopping();
  const cats = [...CATEGORY_ORDER.filter(c => grouped[c]), ...Object.keys(grouped).filter(c => !CATEGORY_ORDER.includes(c))];
  let html = cats.map(cat => {
    const items = grouped[cat].map(it => {
      const step = it.unit === "g" ? 50 : 1;
      const adj = state.qtyAdjust[it.key] || 0;
      const qty = Math.max(0, it.base * state.servings + adj * step);
      const checked = !!state.checkedItems[it.key];
      return `
        <div class="shop-item ${checked ? "checked" : ""}">
          <label class="item-left">
            <input type="checkbox" ${checked ? "checked" : ""} data-key="${esc(it.key)}" onchange="toggleCheck(this.dataset.key)" />
            <span class="item-main">${esc(it.name)}
              ${it.alt ? `<span class="alt-hint">可替代：${esc(it.alt)}</span>` : ""}
            </span>
          </label>
          <div class="qty-ctrl">
            <button class="qty-btn" data-key="${esc(it.key)}" onclick="adjustQty(this.dataset.key,-1)">－</button>
            <span class="qty-val">${formatQty(qty, it.unit)}</span>
            <button class="qty-btn" data-key="${esc(it.key)}" onclick="adjustQty(this.dataset.key,1)">＋</button>
          </div>
        </div>`;
    }).join("");
    return `<div class="shop-category"><div class="shop-cat-title">${esc(cat)}</div>${items}</div>`;
  }).join("");

  if (!cats.length) {
    html = `<p style="color:var(--muted);">本週沒有自煮餐，無需採買。</p>`;
  }

  if (state.customItems.length) {
    const custom = state.customItems.map((c, idx) => {
      const key = "custom:" + c.id;
      const checked = !!state.checkedItems[key];
      return `
        <div class="shop-item ${checked ? "checked" : ""}">
          <label class="item-left">
            <input type="checkbox" ${checked ? "checked" : ""} data-key="${esc(key)}" onchange="toggleCheck(this.dataset.key)" />
            <span class="item-main">${esc(c.text)}</span>
          </label>
          <button class="btn btn-outline" onclick="removeCustomItem(${idx})">刪除</button>
        </div>`;
    }).join("");
    html += `<div class="shop-category"><div class="shop-cat-title">臨時加買</div>${custom}</div>`;
  }
  document.getElementById("shoppingContainer").innerHTML = html;
}

function toggleCheck(key) {
  state.checkedItems[key] = !state.checkedItems[key];
  saveState();
  renderShopping();
}

function adjustQty(key, dir) {
  state.qtyAdjust[key] = (state.qtyAdjust[key] || 0) + dir;
  saveState();
  renderShopping();
}

function addCustomItem() {
  const input = document.getElementById("customItemInput");
  const text = input.value.trim();
  if (!text) return;
  state.customItems.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text });
  input.value = "";
  saveState();
  renderShopping();
}

function removeCustomItem(idx) {
  state.customItems.splice(idx, 1);
  saveState();
  renderShopping();
}

function clearCheckedItems() {
  state.checkedItems = {};
  saveState();
  renderShopping();
  showToast("已清除勾選狀態");
}

function resetAdjustments() {
  state.qtyAdjust = {};
  saveState();
  renderShopping();
  showToast("已重設數量微調");
}

// ==================== 6. 備料與冰磚盒統計 ====================
function renderContainers() {
  const slots = activeSlots();
  const sizes = { "250ml大格": 0, "150ml中格": 0, "30ml小格": 0 };
  const extras = {};
  state.schedule.forEach(day => {
    slots.forEach(slotKey => {
      const id = day[slotKey];
      if (!id || id === "EATING_OUT") return;
      const r = getRecipe(id);
      if (!r) return;
      if (sizes[r.brickSpec.size] !== undefined) sizes[r.brickSpec.size] += r.brickSpec.count * state.servings;
      (r.extraBricks || []).forEach(b => {
        const name = b.replace(/\s*×\s*\d+\s*$/, "");
        extras[name] = (extras[name] || 0) + state.servings;
        if (name.startsWith("[中格]")) sizes["150ml中格"] += state.servings;
        else if (name.startsWith("[小格]")) sizes["30ml小格"] += state.servings;
      });
    });
  });
  Object.entries(stapleTotals()).forEach(([key, n]) => {
    const d = STAPLES[key];
    if (d.kind === "rice") {
      sizes["150ml中格"] += n;
      extras[`[主食] ${d.name}磚（約 ${d.cooked}g 熟飯／格，約半滿）`] = n;
    } else {
      extras[`[主食] 熟凍地瓜塊 ${d.raw}g`] = n;
    }
  });
  const boxes = Object.entries(sizes).map(([size, n]) => `
    <div class="container-box">
      <div class="container-size">${size}</div>
      <div class="container-count">${n} 格</div>
    </div>`).join("");
  const extraList = Object.entries(extras).map(([name, n]) =>
    `<li>${esc(name)} ×${n}</li>`).join("");
  document.getElementById("containerSummary").innerHTML = boxes + `
    <div class="container-box" style="grid-column:1/-1;">
      <div class="container-size">配菜與常備明細</div>
      <ul style="margin:6px 0 0; padding-left:18px; font-size:0.86rem;">${extraList || "<li>無</li>"}</ul>
    </div>`;
}

// ==================== 6b. 本週備料（依器具分組） ====================
function renderSop() {
  const slots = activeSlots();
  const byCookware = {};
  state.schedule.forEach(day => {
    slots.forEach(slotKey => {
      const id = day[slotKey];
      if (!id || id === "EATING_OUT") return;
      const r = getRecipe(id);
      if (!r) return;
      const cw = r.cookware || "其他";
      const group = byCookware[cw] = byCookware[cw] || {};
      group[r.id] = group[r.id] || { recipe: r, meals: 0 };
      group[r.id].meals += 1;
    });
  });
  const stapleRows = Object.entries(stapleTotals()).map(([key, n]) => {
    const d = STAPLES[key];
    const detail = d.kind === "rice"
      ? `乾米約 ${n * d.dry}g（煮熟約 ${n * d.cooked}g）`
      : `約 ${n * d.raw}g（去皮生重，蒸熟分裝）`;
    return `<li>${esc(d.name)}：${n} 份，${detail}</li>`;
  }).join("");
  const stapleBlock = stapleRows
    ? `<div class="shop-category"><div class="shop-cat-title">🍚 主食</div><ul style="margin:0; padding-left:18px; font-size:0.88rem;">${stapleRows}</ul></div>`
    : "";
  const cws = Object.keys(byCookware);
  if (!cws.length) {
    document.getElementById("sopDynamic").innerHTML = `<p style="color:var(--muted);">本週沒有自煮餐。</p>`;
    return;
  }
  document.getElementById("sopDynamic").innerHTML = stapleBlock + cws.map(cw => {
    const items = Object.values(byCookware[cw]).map(({ recipe, meals }) => `
      <div class="meal-slot">
        <div class="slot-top">
          <span class="meal-name" style="margin:0;">${esc(recipe.name)}</span>
          <span class="badge badge-green">本週 ${meals} 餐 × ${state.servings} 人份</span>
        </div>
        <div style="font-size:0.84rem; white-space:pre-line;">${esc(recipe.prepNote || "（無備料說明）")}</div>
      </div>`).join("");
    return `<div class="shop-category"><div class="shop-cat-title">🔧 ${esc(cw)}</div>${items}</div>`;
  }).join("");
}

// ==================== 7. 菜色庫、解鎖、匯入匯出 ====================
function renderRecipeList() {
  document.getElementById("recipeCount").textContent = allRecipes().length;
  const extraIds = new Set(state.extraRecipes.map(r => r.id));
  document.getElementById("recipeListView").innerHTML = allRecipes().map(r => `
    <div class="meal-slot">
      <div class="slot-top">
        <span class="meal-name" style="margin:0;">${esc(r.name)}</span>
        <span class="badge ${extraIds.has(r.id) ? "badge-amber" : "badge-green"}">${extraIds.has(r.id) ? "新增" : "內建"}</span>
        ${extraIds.has(r.id) ? `<button class="btn btn-outline" style="color:var(--danger);" data-id="${esc(r.id)}" onclick="deleteRecipe(this.dataset.id)">刪除</button>` : ""}
      </div>
      <div class="brick-tags">
        ${r.mealType.map(t => `<span class="badge badge-gray">${esc(MEAL_TYPE_LABEL[t] || t)}</span>`).join("")}
        <span class="badge badge-gray">${esc(r.brickSpec.size)} ×${r.brickSpec.count}</span>
        <span class="badge badge-amber">${esc(r.cookware || "")}</span>
      </div>
      <div style="font-size:0.82rem; color:var(--muted);">
        食材：${r.ingredients.map(i => esc(i.item)).join("、")}
      </div>
    </div>`).join("");
}

function deleteRecipe(id) {
  const r = state.extraRecipes.find(x => x.id === id);
  if (!r) return; // 內建食譜不可刪除
  if (!confirm(`確定刪除「${r.name}」？\n本週菜單中用到它的餐點會自動換成其他菜色。`)) return;
  state.extraRecipes = state.extraRecipes.filter(x => x.id !== id);
  state.unlockedIds = state.unlockedIds.filter(x => x !== id);
  state.schedule.forEach(day => {
    ["breakfast", "lunch", "dinner"].forEach(slot => {
      if (day[slot] === id) day[slot] = pickRandomRecipe(MEAL_TYPE_MAP[slot]);
    });
  });
  saveState();
  renderAll();
  showToast(`已刪除：${r.name}`);
}

function unlockMoreRecipes() {
  const locked = HIDDEN_RECIPES.filter(r => !state.unlockedIds.includes(r.id));
  if (!locked.length) {
    showToast("所有隱藏食譜皆已解鎖完畢！");
    return;
  }
  const batch = locked.slice(0, 3);
  batch.forEach(r => {
    state.unlockedIds.push(r.id);
    state.extraRecipes.push(r);
  });
  saveState();
  renderAll();
  showToast(`✨ 已解鎖 ${batch.length} 道新菜色：${batch.map(r => r.name).join("、")}`);
}

function openImportModal() { document.getElementById("importModal").classList.add("open"); }
function closeImportModal() { document.getElementById("importModal").classList.remove("open"); }

function normalizeRecipe(r) {
  if (!r || typeof r !== "object") return null;
  if (!r.name || !Array.isArray(r.mealType) || !r.brickSpec || !r.brickSpec.size) return null;
  if (!Array.isArray(r.ingredients)) return null;
  return {
    id: r.id || "import_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: String(r.name),
    mealType: r.mealType,
    cookware: r.cookware || "22cm鐵鍋",
    brickSpec: { size: r.brickSpec.size, count: Number(r.brickSpec.count) || 1 },
    extraBricks: Array.isArray(r.extraBricks) ? r.extraBricks : [],
    ingredients: r.ingredients.map(i => ({
      item: String(i.item || ""),
      amount: Number(i.amount) || 0,
      unit: i.unit || "g",
      category: i.category || "菇類與常備",
      alt: i.alt || ""
    })),
    prepNote: r.prepNote || "",
    reheatNote: r.reheatNote || ""
  };
}

// ---------- Mealie 轉換 ----------
function isMealieRecipe(r) {
  return r && typeof r === "object" && (Array.isArray(r.recipeIngredient) || "recipeInstructions" in r);
}

function normalizeUnit(u) {
  const s = String(u || "").trim().toLowerCase();
  if (!s) return "份";
  if (["g", "gram", "grams", "公克", "克"].includes(s)) return "g";
  if (["kg", "公斤"].includes(s)) return "kg";
  return String(u).trim();
}

function guessCategory(name) {
  const n = String(name);
  if (/四季豆|青豆|豌豆|玉米|番茄|tomato|洋蔥|onion|地瓜|薑|蘿蔔|芋|南瓜|瓜|蒜|椒|potato/i.test(n)) return "根莖瓜果";
  if (/菜|花椰|高麗|青江|菠菜|蔥|九層塔|萵苣|芥藍|地瓜葉|lettuce|spinach|cabbage|broccoli/i.test(n)) return "葉菜與花椰";
  if (/起司|乳酪|奶油|牛奶|優格|cheese|butter|milk|yogurt/i.test(n)) return "冷藏乳品";
  if (/肉|豬|牛|雞|鴨|蛋|魚|蝦|蚵|豆腐|豆|培根|火腿|鮭|鯖|chicken|pork|beef|egg|fish|shrimp|tofu|bacon/i.test(n)) return "肉蛋魚豆";
  return "菇類與常備";
}

function mealieIngredient(ing) {
  if (typeof ing === "string") {
    return { item: ing.trim(), amount: 1, unit: "份", category: guessCategory(ing), alt: "" };
  }
  const item = (ing.food && ing.food.name) || ing.note || ing.display || ing.originalText || "";
  const qty = Number(ing.quantity);
  return {
    item: String(item).trim(),
    amount: qty > 0 ? qty : 1,
    unit: qty > 0 ? normalizeUnit(ing.unit && ing.unit.name) : "份",
    category: guessCategory(item),
    alt: ""
  };
}

function convertMealie(r) {
  const tagText = []
    .concat((r.recipeCategory || []).map(c => (typeof c === "string" ? c : c.name)))
    .concat((r.tags || []).map(t => (typeof t === "string" ? t : t.name)))
    .join(" ");
  const types = [];
  if (/早餐|breakfast/i.test(tagText)) types.push("breakfast");
  if (/午餐|便當|lunch|bento/i.test(tagText)) types.push("lunch_bento");
  if (/晚餐|dinner|supper/i.test(tagText)) types.push("dinner");
  if (!types.length) types.push("lunch_bento", "dinner");

  const steps = (r.recipeInstructions || [])
    .map(s => (typeof s === "string" ? s : (s.text || s.title || "")))
    .filter(Boolean);
  const desc = r.description ? String(r.description) : "";
  const ingredients = (r.recipeIngredient || [])
    .map(mealieIngredient)
    .filter(i => i.item);

  return {
    id: "mealie_" + (r.slug || r.id || Date.now().toString(36)),
    name: r.name,
    mealType: types,
    cookware: "22cm鐵鍋",
    brickSpec: { size: document.getElementById("mealieBrickSize").value, count: 1 },
    extraBricks: [],
    ingredients,
    prepNote: [desc, ...steps.map((s, i) => `${i + 1}. ${s}`)].filter(Boolean).join("\n"),
    reheatNote: "依食譜步驟加熱（可於匯入後自行調整）"
  };
}

function extractRecipeList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.recipes)) return data.recipes;
  return [data];
}

function importRecipes(rawList) {
  const existing = new Set(allRecipes().map(r => r.id));
  let added = 0, skipped = 0;
  rawList.forEach(raw => {
    const r = normalizeRecipe(isMealieRecipe(raw) ? convertMealie(raw) : raw);
    if (!r || !r.ingredients.length || existing.has(r.id)) { skipped++; return; }
    existing.add(r.id);
    state.extraRecipes.push(r);
    added++;
  });
  saveState();
  renderAll();
  return { added, skipped };
}

function confirmImportJson() {
  const text = document.getElementById("importTextarea").value.trim();
  if (!text) return;
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    showToast("JSON 格式錯誤，請檢查後再試");
    return;
  }
  const { added, skipped } = importRecipes(extractRecipeList(data));
  if (added) {
    document.getElementById("importTextarea").value = "";
    closeImportModal();
  }
  showToast(`匯入完成：新增 ${added} 道，略過 ${skipped} 道（重複或缺食材）`);
}

function toRawUrl(url) {
  const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  const g = url.match(/^https?:\/\/gist\.github\.com\/([^/]+)\/([0-9a-f]+)\/?$/i);
  if (g) return `https://gist.githubusercontent.com/${g[1]}/${g[2]}/raw`;
  return url;
}

async function fetchFromUrl() {
  const input = document.getElementById("jsonUrl").value.trim();
  if (!/^https?:\/\//i.test(input)) {
    showToast("請輸入完整網址（含 http:// 或 https://）");
    return;
  }
  const url = toRawUrl(input);
  try {
    showToast("下載中…");
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = JSON.parse(await res.text());
    const { added, skipped } = importRecipes(extractRecipeList(data));
    if (added) closeImportModal();
    showToast(`匯入完成：新增 ${added} 道，略過 ${skipped} 道（重複或缺食材）`);
  } catch (e) {
    console.error(e);
    showToast("下載或解析失敗：請確認網址是 JSON 檔，且伺服器允許跨來源存取");
  }
}

async function fetchFromMealie() {
  const base = document.getElementById("mealieUrl").value.trim().replace(/\/+$/, "");
  const token = document.getElementById("mealieToken").value.trim();
  if (!/^https?:\/\//i.test(base)) {
    showToast("請輸入完整的 Mealie 網址（含 http:// 或 https://）");
    return;
  }
  const headers = token ? { Authorization: "Bearer " + token } : {};
  const getJson = async url => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  };
  try {
    showToast("正在從 Mealie 取得食譜清單…");
    const list = await getJson(`${base}/api/recipes?page=1&perPage=100`);
    const slugs = (list.items || []).map(i => i.slug).filter(Boolean);
    if (!slugs.length) {
      showToast("Mealie 沒有可匯入的食譜（或需要 API Token）");
      return;
    }
    const details = [];
    for (let i = 0; i < slugs.length; i++) {
      details.push(await getJson(`${base}/api/recipes/${encodeURIComponent(slugs[i])}`));
    }
    const { added, skipped } = importRecipes(details);
    if (added) closeImportModal();
    showToast(`Mealie 匯入完成：新增 ${added} 道，略過 ${skipped} 道`);
  } catch (e) {
    console.error(e);
    showToast("抓取失敗（網址、Token 或 CORS 被擋），請改用貼上 JSON");
  }
}

function exportRecipesJson() {
  const blob = new Blob([JSON.stringify(allRecipes(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "lowcarb_recipes_backup.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function resetAllData() {
  if (!confirm("確定要清除所有設定、匯入食譜與勾選狀態，並回到初始預設值嗎？")) return;
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

// ==================== 8. 總渲染與初始化 ====================
function renderAll() {
  const title = `${state.servings} 人份`;
  document.getElementById("shopServingTitle").textContent = title;
  document.getElementById("sopServingTitle").textContent = title;
  document.getElementById("stapleHint").textContent = state.stapleServings > 0
    ? `🍚 午餐與晚餐各固定 ${state.stapleServings} 份主食（約 ${state.stapleServings * 15}g 碳水／餐，為估算值），其餘碳水額度留給點心。`
    : "目前未安排主食。";
  renderPlan();
  renderShopping();
  renderContainers();
  renderSop();
  renderRecipeList();
}

async function init() {
  try {
    await loadRecipeData();
  } catch (e) {
    console.error(e);
    const box = document.getElementById("loadError");
    if (box) box.style.display = "block";
    return;
  }
  loadState();
  renderAll();
}

init();
