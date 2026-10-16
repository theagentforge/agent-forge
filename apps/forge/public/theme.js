// Applies a saved theme choice before first paint. Default: dark, whatever the operating system says.
(function(){try{var t=localStorage.getItem("forge-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}})();
