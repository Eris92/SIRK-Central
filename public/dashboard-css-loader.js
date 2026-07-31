"use strict";

(function () {
    if (document.querySelector('link[data-sirk-dashboard-style="true"]')) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/dashboard-ui.css";
    link.dataset.sirkDashboardStyle = "true";
    document.head.append(link);
}());
