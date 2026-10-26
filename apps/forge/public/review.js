// Lab #6 review console (admin only): keyboard shortcuts. The forms work without this file.
// Keys: the letter or number shown on a choice picks it; Enter saves; ←/→ move without saving; N goes to the note;
// J/K jump between highlighted lines; C/F mark the next open rule as correct / false positive.
const form = document.querySelector("form[data-review]");
const typing = (el) => el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && (el.type === "text" || el.type === "search" || !el.type)) || el.isContentEditable);

// Ticking "none" clears the traps and a trap clears "none".
if (form) {
  const none = form.querySelector("[data-none]");
  form.addEventListener("change", (e) => {
    const el = e.target;
    if (!none || el.name !== "trap") return;
    if (el === none && none.checked) form.querySelectorAll('input[name="trap"]').forEach((x) => { if (x !== none) x.checked = false; });
    else if (el !== none && el.checked) none.checked = false;
  });
  // Opening the public replay is recorded, because it shows the referee's verdict.
  // A middle-click opens it too (auxclick), and so does the keyboard (Enter fires click).
  const saw = () => {
    const box = form.querySelector("[data-saw-replay]");
    if (box) box.checked = true;
  };
  document.querySelectorAll("[data-unblind]").forEach((a) => ["click", "auxclick"].forEach((ev) => a.addEventListener(ev, saw)));
}

const hls = [...document.querySelectorAll("[data-hl]")];
let at = -1;
function jump(step) {
  if (!hls.length) return;
  at = (at + step + hls.length) % hls.length;
  hls[at].scrollIntoView({ block: "center" });
  hls.forEach((h, i) => h.classList.toggle("rv-at", i === at));
}

function markRule(value) {
  const open = [...document.querySelectorAll("[data-rule]")].find((f) => !f.querySelector("input:checked"));
  const input = open && open.querySelector(`input[value="${value}"]`);
  if (input) { input.checked = true; input.focus(); }
}

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (typing(e.target)) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const a = document.querySelector(`a[data-key="${key}"]`);
    if (a) { e.preventDefault(); location.href = a.href; }
    return;
  }
  if (key === "j" || key === "k") { e.preventDefault(); jump(key === "j" ? 1 : -1); return; }
  if (!form) return;
  if (key === "Enter") { e.preventDefault(); form.requestSubmit(); return; }
  if (form.dataset.review === "scanner-rules" && (key === "c" || key === "f")) { e.preventDefault(); markRule(key === "c" ? "correct" : "fp"); return; }
  const el = form.querySelector(`[data-key="${key}"]`);
  if (!el) return;
  e.preventDefault();
  if (el.type === "radio") el.checked = true;
  else if (el.type === "checkbox") { el.checked = !el.checked; el.dispatchEvent(new Event("change", { bubbles: true })); }
  else el.focus();
});
