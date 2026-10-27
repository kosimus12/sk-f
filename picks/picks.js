
(function(){
  var T={"de": "skfinb-21", "com": "", "uk": ""};
  var l=(navigator.languages&&navigator.languages[0])||navigator.language||"en-US";l=l.toLowerCase();
  var m=l.indexOf("de")===0?"de":(l==="en-gb"?"uk":"com");
  var host={de:"www.amazon.de",uk:"www.amazon.co.uk",com:"www.amazon.com"}[m];
  document.querySelectorAll("a[data-q]").forEach(function(a){
    var u="https://"+host+"/s?k="+encodeURIComponent(a.getAttribute("data-q"));
    if(T[m]) u+="&tag="+encodeURIComponent(T[m]);
    a.href=u;
  });
})();
