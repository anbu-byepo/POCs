// Bits of UI both apps share: payment and status badges, toasts, and the
// demo-controls strip (simulated clock + scenarios), which isn't part of
// either app's design.

import { getState, update, loadScenario, subscribe } from "./store.js";
import { SCENARIOS } from "./seed.js";
import { MIN, esc, rupees, tms, dateLabel, ymd, addDays, at } from "./util.js";

export function paymentBadge(a) {
  const p = a.payment;
  if (p.refund && p.refund.status !== "processed") {
    const label = { requested: "Refund queued", processing: "Refunding", counter: "Refund due at counter", error: "Refund failed" }[p.refund.status];
    return `<span class="badge ${p.refund.status === "error" ? "red" : "amber"}">${label} ${rupees(p.refund.amount)}</span>`;
  }
  if (p.status === "refunded") return `<span class="badge info">Refunded ${rupees(p.refund?.amount ?? p.amount)}</span>`;
  if (p.status === "paid") return `<span class="badge ok">Paid ${rupees(p.amount)}</span>`;
  if (p.status === "failed") return `<span class="badge red">Payment failed</span>`;
  if (p.mode === "link") return `<span class="badge amber">Link sent ${rupees(p.amount)}</span>`;
  if (p.mode === "online") return `<span class="badge amber">Payment pending</span>`;
  return `<span class="badge amber">Pay at clinic ${rupees(p.amount)}</span>`;
}

let toastBox = null;
export function toast(title, body = "") {
  toastBox ??= Object.assign(document.body.appendChild(document.createElement("div")), { className: "toasts" });
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<b>${esc(title)}</b>${esc(body)}`;
  toastBox.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

// ---------- demo controls ----------

let autoTimer = null;

export function advance(minutes) {
  update(s => {
    s.clock.nowMs += minutes * MIN;
  });
}

function jumpNextDay() {
  update(s => {
    s.clock.nowMs = at(addDays(ymd(s.clock.nowMs), 1), 8 * 60 + 30);
  });
}

function toggleAuto() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  } else {
    autoTimer = setInterval(() => advance(1), 1000);
  }
}

export function mountSimBar(el, { extra = "" } = {}) {
  const render = () => {
    const s = getState();
    el.innerHTML = `
      <span class="lbl">DEMO CLOCK</span>
      <span class="clock">${dateLabel(ymd(s.clock.nowMs), ymd(Date.now()))} ${tms(s.clock.nowMs)}</span>
      <button data-sim="1">+1 min</button><button data-sim="5">+5</button><button data-sim="15">+15</button><button data-sim="60">+1 h</button>
      <button data-sim="day">Next day 8:30</button>
      <button data-sim="auto" class="${autoTimer ? "on" : ""}">${autoTimer ? "■ Stop" : "▶ Run"} (1 s = 1 min)</button>
      <span class="sp"></span>
      <select data-sim="scenario" aria-label="Load scenario">
        <option value="">Load scenario…</option>
        ${Object.entries(SCENARIOS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("")}
      </select>
      ${extra}`;
  };
  el.classList.add("simbar");
  el.addEventListener("click", event => {
    const v = event.target.closest("button[data-sim]")?.dataset.sim;
    if (!v) return;
    if (v === "auto") toggleAuto();
    else if (v === "day") jumpNextDay();
    else advance(Number(v));
    render();
  });
  el.addEventListener("change", event => {
    if (event.target.dataset.sim === "scenario" && event.target.value) loadScenario(event.target.value);
  });
  subscribe(render);
  render();
}
