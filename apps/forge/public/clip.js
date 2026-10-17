// The clip view (/arena/run/<id>/clip): play the beats once, after the fonts load, unless the viewer prefers reduced
// motion. Without this script the page is the finished, static frame. The clips recorder reads data-clip-started.
(function () {
  var root = document.documentElement;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var start = function () {
    root.classList.add("clip-play");
    root.setAttribute("data-clip-started", String(Date.now()));
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(start, start);
  else start();
})();
