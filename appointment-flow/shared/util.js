// Small time, money and HTML helpers shared by both apps. Times of day are
// minutes since midnight; dates are local "YYYY-MM-DD" strings.

export const MIN = 60000;
export const HOUR = 60 * MIN;

const pad = n => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function ymd(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dayStart(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

export function at(date, minutes) {
  return dayStart(date) + minutes * MIN;
}

export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return ymd(new Date(y, m - 1, d + n).getTime());
}

export function minOfDay(ms) {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

export function t12(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = Math.round(minutes % 60);
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

export function tms(ms) {
  return t12(minOfDay(ms));
}

export function dateLabel(date, today) {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  const d = new Date(dayStart(date));
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function shortDate(date) {
  const d = new Date(dayStart(date));
  return { dow: DAYS[d.getDay()], day: d.getDate(), month: MONTHS[d.getMonth()] };
}

export function rupees(n) {
  return `₹${Number(n).toLocaleString("en-IN")}`;
}

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function round5(minutes) {
  return Math.max(0, Math.round(minutes / 5) * 5);
}

export function inFrame() {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}
