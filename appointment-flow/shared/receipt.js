// Payment receipt with GST, shared by the clinic and patient apps. The fee is
// GST-inclusive: the patient pays the doctor's fee and the receipt splits it
// into taxable value + CGST + SGST (intra-state). At 0% the clinic issues a
// bill of supply instead (healthcare by a clinical establishment, SAC 9993,
// is usually exempt). Tax details are frozen on the payment when it's marked
// paid, so later settings changes don't rewrite old receipts.

import { esc, rupees, tms, ymd, shortDate } from "./util.js";
import { apptMs, doctorOf, patientOf, slotLabel, taxSnapshot } from "./flow.js";

export const GST_RATES = [0, 5, 12, 18];

const r2 = n => Math.round(n * 100) / 100;

export function gstBreakdown(total, rate) {
  if (!rate) return { taxable: total, cgst: 0, sgst: 0, tax: 0, total };
  const taxable = r2(total / (1 + rate / 100));
  const cgst = r2((total - taxable) / 2);
  const sgst = r2(total - taxable - cgst);
  return { taxable, cgst, sgst, tax: r2(cgst + sgst), total };
}

const paise = n => `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function words(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${words(n % 100)}` : ""}`;
  if (n < 100000) return `${words(Math.floor(n / 1000))} Thousand${n % 1000 ? ` ${words(n % 1000)}` : ""}`;
  return `${words(Math.floor(n / 100000))} Lakh${n % 100000 ? ` ${words(n % 100000)}` : ""}`;
}
export function amountInWords(n) {
  const r = Math.floor(n);
  const p = Math.round((n - r) * 100);
  return `Rupees ${r ? words(r) : "Zero"}${p ? ` and ${words(p)} Paise` : ""} Only`;
}

function dateTime(ms, time = tms(ms)) {
  const { day, month } = shortDate(ymd(ms));
  return `${day} ${month} ${new Date(ms).getFullYear()}, ${esc(time)}`;
}

// Receipt body for a paid appointment, or "" if there's nothing to show.
export function receiptHtml(s, a) {
  const p = a?.payment;
  if (!p?.receiptNo) return "";
  const d = doctorOf(s, a);
  const pt = patientOf(s, a);
  const tax = p.tax ?? taxSnapshot(s);
  const b = gstBreakdown(p.amount, tax.rate);
  const half = tax.rate / 2;
  const refund = p.refund;
  const title = tax.rate ? "Tax invoice / receipt" : "Bill of supply / receipt";
  return `<div class="receipt" id="receipt">
      <div class="center">
        <div class="name">${esc(s.clinic.name)}</div>
        <div class="sub">${esc(s.clinic.address)}</div>
        ${tax.gstin ? `<div class="sub">GSTIN <span class="mono">${esc(tax.gstin)}</span>${tax.state ? ` · ${esc(tax.state)}` : ""}</div>` : ""}
      </div>
      <div class="receipt-amt center">
        <div class="section-label">${title}</div>
        <div class="amt">${rupees(p.amount)}</div>
        <span class="badge ok">Paid</span>
      </div>
      <div>
        <div class="kv"><span class="k">Receipt no.</span><span class="v mono">${esc(p.receiptNo)}</span></div>
        <div class="kv"><span class="k">Date</span><span class="v">${dateTime(p.paidAt)}</span></div>
        <div class="kv"><span class="k">Billed to</span><span class="v">${esc(pt.name)}<br><span class="sub">${esc(pt.phone)}</span></span></div>
        ${tax.state ? `<div class="kv"><span class="k">Place of supply</span><span class="v">${esc(tax.state)}</span></div>` : ""}
      </div>
      <div>
        <div class="section-label">Details</div>
        <div class="kv"><span class="k">Consultation, ${esc(d.name)}<br><span class="sub">${esc(d.specialty)} · ${dateTime(apptMs(a), slotLabel(s, a))}<br>SAC ${esc(tax.sac)}</span></span><span class="v">${paise(b.taxable)}</span></div>
        ${tax.rate ? `<div class="kv"><span class="k">Taxable value</span><span class="v">${paise(b.taxable)}</span></div>
        <div class="kv"><span class="k">CGST @ ${half}%</span><span class="v">${paise(b.cgst)}</span></div>
        <div class="kv"><span class="k">SGST @ ${half}%</span><span class="v">${paise(b.sgst)}</span></div>`
        : `<div class="kv"><span class="k">GST</span><span class="v">Exempt</span></div>`}
        <div class="kv total"><span class="k">Total paid</span><span class="v">${paise(b.total)}</span></div>
        <div class="sub">${amountInWords(b.total)}</div>
      </div>
      <div>
        <div class="section-label">Payment</div>
        <div class="kv"><span class="k">Method</span><span class="v">${esc(p.method ?? "online")}</span></div>
        ${p.paymentId ? `<div class="kv"><span class="k">Payment ID</span><span class="v mono">${esc(p.paymentId)}</span></div>` : ""}
        ${p.orderId ? `<div class="kv"><span class="k">Order ID</span><span class="v mono">${esc(p.orderId)}</span></div>` : ""}
        <div class="kv"><span class="k">Booking ref.</span><span class="v mono">${esc(a.id)}</span></div>
      </div>
      ${refund ? `<div class="note">Refund of ${rupees(refund.amount)} (${refund.pct}%): ${esc(refund.status === "processed" ? "processed" : refund.status === "counter" ? "due at the counter" : "in progress")}. A credit note is issued against this receipt.</div>` : ""}
      <div class="sub center">${tax.rate ? "Amount is inclusive of GST. " : "Healthcare services exempt from GST. "}This is a computer-generated receipt and needs no signature.</div>
    </div>`;
}
