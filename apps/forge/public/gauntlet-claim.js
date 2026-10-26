// The claim page (ADR 0055). The claim key arrives in the link's #fragment, which browsers never send to the server.
// It's kept in this tab's sessionStorage across the GitHub sign-in, then filled into the claim form, which posts to the
// Worker like any form (no database access from the browser). After "Sign in and claim", the claim goes through on
// return without another click when there's no agent to choose.
const KEY = /^gck_[A-Za-z0-9_-]{43}$/;
const STORE = "forge-claim";
const read = () => {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) || "null");
  } catch {
    return null;
  }
};
const write = (v) => {
  try {
    if (v) sessionStorage.setItem(STORE, JSON.stringify(v));
    else sessionStorage.removeItem(STORE);
  } catch {}
};
const root = document.querySelector("[data-claim-run]");
if (root) {
  const run = root.dataset.claimRun;
  const input = document.getElementById("claim-key");
  let saved = read();
  if (saved && saved.run !== run) saved = null;
  let hash = "";
  try {
    hash = decodeURIComponent(location.hash.slice(1));
  } catch {} // a mangled fragment (a stray "%") isn't a key; the page still works with a pasted one
  if (KEY.test(hash)) {
    saved = { ...(saved || {}), run, key: hash };
    write(saved);
    // Off the address bar and history once it's kept.
    history.replaceState(null, "", location.pathname + location.search);
  }
  if (input && saved && saved.key && !input.value) input.value = saved.key;
  for (const a of document.querySelectorAll("a[data-claim-signin]")) {
    a.addEventListener("click", () => {
      const key = (input && input.value.trim()) || (saved && saved.key) || "";
      write({ run, key, season: a.dataset.claimSignin === "1", auto: true });
    });
  }
  const form = document.getElementById("claim-form");
  if (form && saved && saved.auto && saved.key && form.dataset.auto === "1") {
    write({ ...saved, auto: false });
    const btn = form.querySelector(`button[name="season"][value="${saved.season ? "1" : "0"}"]`) || form.querySelector('button[name="season"]');
    if (form.requestSubmit) form.requestSubmit(btn || undefined);
  }
  if (root.dataset.claimDone === "1") write(null);
}
