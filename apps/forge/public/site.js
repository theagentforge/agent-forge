// Small progressive enhancements. Every page works without this file.
(function () {
  var root = document.documentElement;
  var toggle = document.querySelector("[data-theme-toggle]");
  function current() {
    return root.dataset.theme === "light" ? "light" : "dark"; // dark is the default for everyone
  }
  function label() {
    if (toggle) toggle.textContent = current() === "dark" ? "Theme: dark" : "Theme: light";
  }
  if (toggle) {
    toggle.hidden = false;
    label();
    toggle.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try { localStorage.setItem("forge-theme", next); } catch (e) {}
      label();
    });
  }
  // "/" focuses the check box (BRAND §8.0, keyboard first).
  document.addEventListener("keydown", function (e) {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    var input = document.getElementById("check-input");
    if (input) { e.preventDefault(); input.focus(); }
  });
  // Copy buttons next to commands.
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.hidden = false;
    btn.addEventListener("click", function () {
      var el = document.getElementById(btn.getAttribute("data-copy"));
      if (!el || !navigator.clipboard) return;
      navigator.clipboard.writeText(el.textContent.trim()).then(function () {
        // Trap card copies are counted as a daily total (no visitor data): ADR 0017.
        if (btn.getAttribute("data-copy") === "trap-card-text" && navigator.sendBeacon) navigator.sendBeacon("/trap-card/copied");
        var old = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = old; }, 1500);
      });
    });
  });
})();
// The Forge Arena. Now Playing: everyone sees the same moment, because the position comes from the clock (no
// streaming server). Replays: reveal the referee's frames over a condensed running time.
(function () {
  var np = document.querySelector("[data-playlist]");
  if (np) {
    var list = [];
    try { list = JSON.parse(np.getAttribute("data-playlist") || "[]"); } catch (e) {}
    var total = list.reduce(function (s, x) { return s + x.seconds; }, 0);
    var title = np.querySelector("[data-np-title]"), bar = np.querySelector("[data-np-bar]");
    var label = np.querySelector("[data-np-label]"), next = np.querySelector("[data-np-next]");
    var tick = function () {
      if (!total || !title) return;
      var pos = Math.floor(Date.now() / 1000) % total, i = 0;
      while (pos >= list[i].seconds) { pos -= list[i].seconds; i++; }
      var item = list[i], after = list[(i + 1) % list.length];
      title.innerHTML = "";
      var a = document.createElement("a");
      a.href = "/arena/run/" + item.id;
      a.textContent = item.model + " · " + item.task + (item.passed ? " ✓" : " ✕");
      title.appendChild(a);
      var fresh = Date.now() - item.recorded < 86400000;
      if (label) label.textContent = (item.kind === "practice" ? "Practice · " : "") + (fresh ? "Premiere" : "Replay · recorded " + new Date(item.recorded).toISOString().slice(0, 10));
      if (bar) bar.value = pos / item.seconds;
      if (next && after) next.textContent = "Next: " + after.model + " · " + after.task;
    };
    tick();
    setInterval(tick, 1000);
  }
  var replay = document.querySelector("[data-replay]");
  if (replay) {
    var play = replay.querySelector("[data-play]"), list2 = replay.querySelector(".frames");
    var frames = list2 ? Array.prototype.slice.call(list2.children) : [];
    var pBar = replay.querySelector("[data-bar-progress]"), sBar = replay.querySelector("[data-bar-stamina]");
    if (play && frames.length) {
      play.hidden = false;
      play.addEventListener("click", function () {
        var secs = Number(replay.getAttribute("data-seconds")) || 30, i = 0;
        list2.classList.add("playing");
        frames.forEach(function (f) { f.classList.remove("shown"); });
        play.disabled = true;
        var step = function () {
          var f = frames[i];
          f.classList.add("shown");
          if (pBar) pBar.value = Number(f.getAttribute("data-progress"));
          if (sBar) sBar.value = Number(f.getAttribute("data-stamina"));
          f.scrollIntoView({ block: "nearest" });
          i++;
          if (i < frames.length) setTimeout(step, (secs * 1000) / frames.length);
          else { list2.classList.remove("playing"); play.disabled = false; }
        };
        step();
      });
    }
  }
})();
// "Call it": picks stay on this device; only anonymous totals go to the server. Points and streaks only.
(function () {
  var box = document.querySelector("[data-call-it]");
  if (!box) return;
  var KEY = "forge-picks";
  var load = function () { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { return {}; } };
  var save = function (v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} };
  var picks = load();
  var row = box.querySelector("[data-fixture]"), status = box.querySelector("[data-pick-status]");
  if (row) {
    var id = row.getAttribute("data-fixture");
    var show = function () { if (picks[id] && status) status.textContent = "Your pick is in. Come back after the premiere."; };
    show();
    row.querySelectorAll("[data-pick]").forEach(function (b) {
      if (picks[id]) b.disabled = true;
      b.addEventListener("click", function () {
        var option = b.getAttribute("data-pick");
        picks[id] = { pick: option, at: Date.now() };
        save(picks);
        row.querySelectorAll("[data-pick]").forEach(function (x) { x.disabled = true; });
        fetch("/api/v1/arena/picks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fixture: id, option: option }) }).catch(function () {});
        show();
      });
    });
  }
  // Streak: consecutive correct calls, newest first, from results shown on the page.
  var results = Array.prototype.slice.call(document.querySelectorAll("[data-result]"));
  var grid = [], streak = 0, counting = true;
  results.forEach(function (li) {
    var p = picks[li.getAttribute("data-result")], outcome = li.getAttribute("data-outcome");
    if (!p || !outcome) { grid.push("⬜"); counting = false; return; }
    var right = p.pick === outcome;
    grid.push(right ? "🟩" : "🟥");
    if (counting && right) streak++; else counting = false;
  });
  var s = document.querySelector("[data-streak]"), share = document.querySelector("[data-share]");
  if (s && grid.some(function (g) { return g !== "⬜"; })) {
    s.textContent = "Streak: " + streak + ". Last " + grid.length + ": " + grid.slice().reverse().join("");
    if (share && navigator.clipboard) {
      share.hidden = false;
      share.addEventListener("click", function () {
        navigator.clipboard.writeText("Forge Arena · Call it " + grid.slice().reverse().join("") + " streak " + streak + "\nhttps://theagentforge.io/arena/call-it");
        share.textContent = "Copied";
      });
    }
  }
})();
// The Arena duel (ADR 0016, 0019). The server renders the first duel's finished box score; this plays the duels.
// Home: cycles through the day's pool (each ~14 s, the result card held 3 s). /arena: a clock-synced channel, so
// everyone sees the same moment. Each corner's action feed fills in with the bars; FOUL / TRAP CAUGHT stamps land
// at the result; "Who falls for it?" picks stay on this device. Pause comes first; it pauses when scrolled out of
// view. With reduced motion nothing animates: finished box scores change every 10 s (still pausable).
(function () {
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.querySelectorAll("[data-duel]").forEach(function (fig) {
    var duels;
    try { duels = JSON.parse(fig.getAttribute("data-duel") || "null"); } catch (e) { return; }
    if (!duels) return;
    if (!Array.isArray(duels)) duels = [duels];
    if (!duels.length || (reduce && duels.length < 2)) return;
    var channel = fig.getAttribute("data-mode") === "channel", HOLD = 3, STILL = 10;
    var q = function (sel) { return fig.querySelector(sel); };
    var btn = q("[data-duel-pause]"), caps = q("[data-captions]"), clockEl = q("[data-bug-clock]");
    var predict = q("[data-predict]"), pickResult = q("[data-pick-result]"), dots = q("[data-dots]"), nextEl = q("[data-next]");
    var st = { i: 0, t: 0, playing: true, userPaused: false, autoPaused: false, shown: -1, lines: [-1, -1], pick: null };
    var slot = function (d) { return reduce ? STILL : d.seconds + HOLD; };
    var total = duels.reduce(function (s, d) { return s + slot(d); }, 0);
    var text = function (sel, v) { var el = q(sel); if (el) el.textContent = v; };
    var mmss = function (s) { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60); };
    var stamp = function (s) { return s.fell ? ["FOUL", "stamp-foul"] : s.caught ? ["TRAP CAUGHT", "stamp-caught"] : s.verdict === "PASS" ? ["PASS", "stamp-caught"] : [s.verdict, "stamp-foul"]; };
    function fill(d) {
      text("[data-bug-title]", d.title); text("[data-bug-round]", d.round); text("[data-bug-rounds]", d.rounds);
      text("[data-duel-label]", (d.practice ? "Practice replay" : "Replay") + " · " + new Date(d.recordedAt).toISOString().slice(0, 10));
      ["a", "b"].forEach(function (k) {
        var s = d[k], box = q('[data-side="' + k + '"]');
        if (!box) return;
        box.className = "contender house-" + s.house;
        box.querySelector("[data-name]").textContent = s.name;
        var sp = stamp(s), se = box.querySelector("[data-stamp]");
        se.textContent = sp[0]; se.className = "stamp " + sp[1];
        var v = box.querySelector("[data-verdict]");
        v.textContent = s.verdict; v.className = "verdict chamfer " + (s.verdict === "PASS" ? "v-clear" : "v-flagged");
        box.querySelector("[data-claim]").textContent = s.claim + " · " + s.check;
        var sc = box.querySelector("[data-said-checked]");
        if (sc) {
          sc.children[0].textContent = s.claim;
          sc.children[1].textContent = s.check.replace("Checked: ", "Referee: ");
          sc.children[1].className = "checked " + (s.verdict === "PASS" ? "ok" : "bad");
        }
        var feed = box.querySelector("[data-feed]");
        feed.innerHTML = "";
        s.feed.forEach(function (l) { var li = document.createElement("li"); li.className = "fl-" + l.kind; li.textContent = l.text; li.hidden = true; feed.appendChild(li); });
      });
      var stakesEl = q("[data-stakes]");
      if (stakesEl) { stakesEl.textContent = d.stakes || ""; stakesEl.hidden = !d.stakes; }
      if (caps) {
        caps.innerHTML = "";
        d.captions.forEach(function (c) { var li = document.createElement("li"); li.textContent = c; caps.appendChild(li); });
      }
      if (predict) {
        predict.querySelectorAll("[data-pick]").forEach(function (b) { b.textContent = d[b.getAttribute("data-pick")].name; b.disabled = false; });
        if (pickResult) pickResult.textContent = "";
      }
      if (dots) Array.prototype.forEach.call(dots.children, function (dot, j) { dot.classList.toggle("on", j === st.i); });
      st.shown = -1; st.lines = [-1, -1]; st.pick = null;
    }
    function at(xs, f) {
      var x = f * (xs.length - 1), lo = Math.floor(x), hi = Math.min(xs.length - 1, lo + 1);
      return xs[lo] + (xs[hi] - xs[lo]) * (x - lo);
    }
    function render() {
      var d = duels[st.i], secs = d.seconds, beat = (secs - 2) / d.captions.length, t = reduce ? secs : st.t;
      var final = t >= secs - 2, f = Math.max(0, Math.min(1, (t - 1) / (secs - 4)));
      fig.classList.toggle("is-final", final);
      // The hook first ("watch who falls for it"), then the result in one line once the referee has checked.
      var head = q("[data-headline]");
      if (head) { var want = final && d.headline ? d.headline : head.getAttribute("data-tease"); if (head.textContent !== want) head.textContent = want; }
      ["a", "b"].forEach(function (k, n) {
        var box = q('[data-side="' + k + '"]');
        if (!box) return;
        box.querySelector("[data-progress]").value = at(d[k].progress, f);
        box.querySelector("[data-stamina]").value = at(d[k].stamina, f);
        var lines = box.querySelector("[data-feed]").children, upto = -1;
        for (var j = 0; j < lines.length; j++) if (d[k].feed[j].at <= (final ? 1 : f) && (d[k].feed[j].kind !== "foul" && d[k].feed[j].kind !== "caught" || final)) upto = j;
        if (upto !== st.lines[n]) {
          for (var m = 0; m < lines.length; m++) lines[m].hidden = m > upto;
          var feedEl = box.querySelector("[data-feed]");
          feedEl.scrollTop = feedEl.scrollHeight;
          st.lines[n] = upto;
        }
      });
      var n = Math.min(d.captions.length - 1, Math.floor(t / beat));
      if (caps && n !== st.shown) {
        Array.prototype.forEach.call(caps.children, function (li, j) { li.classList.toggle("current", j === n); });
        st.shown = n;
      }
      if (predict) predict.hidden = !(n === 1 && !final) && !(st.pick && !final);
      if (final && st.pick && pickResult && !pickResult.textContent) {
        var fellA = d.a.fell || d.a.verdict !== "PASS", fellB = d.b.fell || d.b.verdict !== "PASS";
        var right = (st.pick === "a" && fellA && !fellB) || (st.pick === "b" && fellB && !fellA);
        pickResult.textContent = right ? "✓ You called it" : "✗ Missed this one";
      }
      if (clockEl) clockEl.textContent = mmss(Math.min(t, secs));
      if (nextEl) nextEl.textContent = duels.length > 1 && final ? "Next bout in " + Math.max(1, Math.ceil(slot(d) - st.t)) + "…" : "";
    }
    function syncClock() {
      var pos = (Date.now() / 1000) % total, i = 0;
      while (pos >= slot(duels[i])) { pos -= slot(duels[i]); i++; }
      if (i !== st.i || st.shown === -1) { st.i = i; fill(duels[i]); }
      st.t = reduce ? pos : Math.min(pos, duels[i].seconds);
    }
    function label() { if (btn) { btn.textContent = st.playing ? "Pause" : "Play"; btn.setAttribute("aria-pressed", String(!st.playing)); } }
    function tick() {
      if (!st.playing) return;
      if (channel) syncClock();
      else {
        st.t += 0.1;
        if (st.t >= slot(duels[st.i])) { st.i = (st.i + 1) % duels.length; st.t = 0; fill(duels[st.i]); }
      }
      render();
    }
    fig.classList.add("is-playing");
    if (channel) syncClock(); else fill(duels[0]);
    render();
    if (predict) predict.querySelectorAll("[data-pick]").forEach(function (b) {
      b.addEventListener("click", function () {
        st.pick = b.getAttribute("data-pick");
        predict.querySelectorAll("[data-pick]").forEach(function (x) { x.disabled = true; });
        if (pickResult) pickResult.textContent = "";
        b.blur();
      });
    });
    if (btn) {
      btn.hidden = false;
      btn.addEventListener("click", function () { st.playing = !st.playing; st.userPaused = !st.playing; label(); render(); });
    }
    label();
    setInterval(tick, 100);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (!e.isIntersecting && st.playing) { st.playing = false; st.autoPaused = true; label(); }
          else if (e.isIntersecting && st.autoPaused && !st.userPaused) { st.playing = true; st.autoPaused = false; label(); }
        });
      }).observe(fig);
    }
  });
})();
// /connect "pick your app" (ADR 0017 §4). Without JS every app's section is shown; with it, one tab at a time,
// starting from the app the server guessed. The "Test it" step ticks when a check for the page's code arrives.
(function () {
  var box = document.querySelector("[data-connect]");
  if (!box) return;
  var tabs = Array.prototype.slice.call(box.querySelectorAll("[data-tab]"));
  var tiles = Array.prototype.slice.call(box.querySelectorAll("[data-tile]"));
  var steps = box.querySelectorAll(".checklist li"), label = box.querySelector("[data-progress-label]");
  var done = 1;
  function progress(n) {
    if (n <= done) return;
    done = n;
    for (var i = 0; i < done && i < steps.length; i++) steps[i].classList.add("done");
    if (label) label.textContent = done + " of 3 done.";
  }
  function show(id) {
    tabs.forEach(function (t) { t.hidden = t.getAttribute("data-tab") !== id; });
    tiles.forEach(function (t) { var on = t.getAttribute("data-tile") === id; t.classList.toggle("active", on); if (on) t.setAttribute("aria-current", "true"); else t.removeAttribute("aria-current"); });
  }
  var start = (location.hash || "").replace("#tab-", "");
  show(tiles.some(function (t) { return t.getAttribute("data-tile") === start; }) ? start : box.getAttribute("data-default-tab"));
  tiles.forEach(function (t) {
    t.addEventListener("click", function (e) {
      e.preventDefault();
      var id = t.getAttribute("data-tile");
      show(id);
      try { history.replaceState(null, "", "#tab-" + id); } catch (err) {}
    });
  });
  tabs.forEach(function (t) {
    t.querySelectorAll(".btn.primary, .btn").forEach(function (b) { b.addEventListener("click", function () { progress(2); }); });
  });
  var code = box.getAttribute("data-test-code"), status = box.querySelector("[data-test-status]"), tries = 0;
  if (!code || !status || !window.fetch) return;
  var poll = setInterval(function () {
    if (++tries > 200) { clearInterval(poll); return; }
    fetch("/api/v1/connect-test/" + code, { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.seen) return;
      clearInterval(poll);
      status.textContent = "✓ First check received. Your AI is connected to The Forge.";
      status.classList.add("ok");
      progress(3);
    }).catch(function () {});
  }, 3000);
})();

// /teams (ADR 0023 §7): turn the intake form into a prefilled email. Nothing is sent to or stored by the Forge.
(function () {
  document.querySelectorAll("[data-print]").forEach(function (b) {
    b.hidden = false;
    b.addEventListener("click", function () { window.print(); });
  });
  var f = document.querySelector("[data-teams-form]");
  if (!f) return;
  f.addEventListener("submit", function (e) {
    e.preventDefault();
    var val = function (n) { var el = f.querySelector("[name='" + n + "']"); return el ? String(el.value || "").trim() : ""; };
    var mcp = f.querySelector("input[name='mcp']:checked");
    var body = "Contact email: " + val("email") + "\nAgent framework: " + val("framework") +
      "\nCan it connect over MCP? " + (mcp ? mcp.value : "") + "\nWhat does your agent do? " + val("what") + "\n";
    window.location.href = "mailto:" + f.getAttribute("data-mailto") + "?subject=" + encodeURIComponent(f.getAttribute("data-subject") || "") + "&body=" + encodeURIComponent(body);
    var s = f.querySelector("[data-teams-status]");
    if (s) s.textContent = "Your email app should open with this filled in. Nothing is sent until you press send.";
  });
})();

// Home (ADR 0029): "I'm a human / I'm an agent". Without JavaScript both panels show; with it, one at a time.
(function () {
  var tabs = document.querySelector(".who-tabs");
  if (!tabs) return;
  var hero = tabs.closest(".hero2-copy");
  tabs.hidden = false;
  if (hero) hero.classList.add("has-who");
  var show = function (who) {
    tabs.querySelectorAll("[data-who]").forEach(function (b) { b.setAttribute("aria-selected", String(b.getAttribute("data-who") === who)); });
    document.querySelectorAll("[data-panel]").forEach(function (p) { p.hidden = p.getAttribute("data-panel") !== who; });
  };
  tabs.querySelectorAll("[data-who]").forEach(function (b) { b.addEventListener("click", function () { show(b.getAttribute("data-who")); }); });
  show("human");
})();
