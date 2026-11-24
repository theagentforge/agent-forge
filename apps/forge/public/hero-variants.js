// The home hero's variants (ADR 0156 am. 3): a classic script right after the hero, so one variant is picked at random
// before the first paint; the hero already reserves the tallest variant's space. A button steps to the next. No timers.
(function () {
  var root = document.querySelector("[data-hero-variants]");
  if (!root) return;
  var items = root.querySelectorAll("[data-variant]");
  var n = items.length;
  if (n < 2) return;
  var h1 = root.querySelector("[data-variant-h1]");
  var status = root.querySelector("[data-variant-status]");
  var btn = root.querySelector("[data-variant-next]");
  var cur = 0;
  function show(i, say) {
    var was = items[cur], el = items[i];
    was.classList.add("hero-size");
    was.setAttribute("aria-hidden", "true");
    was.inert = true;
    el.classList.remove("hero-size");
    el.removeAttribute("aria-hidden");
    el.inert = false;
    h1.textContent = el.getAttribute("data-h1");
    h1.setAttribute("data-trap", el.getAttribute("data-trap"));
    cur = i;
    if (say && status) status.textContent = h1.textContent;
  }
  var pick = crypto.getRandomValues(new Uint32Array(1))[0] % n;
  if (pick) show(pick, false);
  if (btn) {
    btn.hidden = false;
    btn.addEventListener("click", function () { show((cur + 1) % n, true); });
  }
})();
