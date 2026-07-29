"use strict";

(function () {
  const link = document.getElementById("microsoftLoginLink");
  if (!link) return;

  link.setAttribute("target", "_self");
  link.addEventListener("click", (event) => {
    event.preventDefault();
    window.location.assign(link.href);
  });
})();
