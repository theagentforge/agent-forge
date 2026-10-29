// The buyer data room (ADR 0095, ADR 0098): a link is /data-room#<code>. The code is in the fragment, so it never
// reaches the server in a URL (logs, history of other tools); this posts it in a form body and clears it from the bar.
const m = /^#([A-Za-z0-9_-]{43})$/.exec(location.hash);
const form = document.getElementById("dr-open");
if (m && form) {
  history.replaceState(null, "", location.pathname);
  form.elements.namedItem("code").value = m[1];
  form.submit();
}
