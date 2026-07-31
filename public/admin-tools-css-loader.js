"use strict";
(function(){
  if(document.querySelector('link[data-sirk-admin-tools-css]'))return;
  const link=document.createElement('link');
  link.rel='stylesheet';
  link.href='/admin-tools-ui.css';
  link.dataset.sirkAdminToolsCss='true';
  document.head.append(link);
}());
