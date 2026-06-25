/* =============================================================================
   Client-JS - Progressive Enhancement.
   Die Seite funktioniert auch ohne JavaScript; dieses Skript ergänzt:
   - mobile Navigation
   - aktiven Navigationspunkt markieren
   - DSGVO-Cookie-Consent (Speicherung der Auswahl)
   - Laden von Calendly & Social-Embeds erst nach Zustimmung
   ============================================================================= */
(function () {
  "use strict";

  // Konfiguration aus data-Attributen am <html> lesen (kein Inline-Script -> CSP-fest).
  if (!window.SK_CONFIG) {
    var ds = (document.documentElement && document.documentElement.dataset) || {};
    window.SK_CONFIG = {
      gaId: ds.gaId || "",
      consentVersion: parseInt(ds.consentVersion, 10) || 2,
      brand: ds.brand || "sk",
    };
  }

  // Markiert, dass JS aktiv ist (steuert die Scroll-Reveal-Animationen).
  document.documentElement.classList.add("js");

  /* ---------- Sanftes Einblenden beim Scrollen ---------- */
  function initReveal() {
    var els = document.querySelectorAll(".reveal");
    if (!els.length) return;
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !("IntersectionObserver" in window)) {
      els.forEach(function (el) { el.classList.add("is-visible"); });
      return;
    }
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );
    els.forEach(function (el) { io.observe(el); });
  }

  var CONSENT_KEY = "sk_consent_v2";
  var CONSENT_LOG_KEY = "sk_consent_log";
  var CONSENT_VERSION = (window.SK_CONFIG && window.SK_CONFIG.consentVersion) || 2;

  /* ---------- Mobile-Navigation ---------- */
  function initNav() {
    var toggle = document.querySelector(".nav-toggle");
    var nav = document.getElementById("primary-nav");
    if (!toggle || !nav) return;

    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "Menü schließen" : "Menü öffnen");
    });

    // Bei Klick auf einen Link das Menü schließen (mobil)
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a") && nav.classList.contains("is-open")) {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---------- Aktiven Navigationspunkt markieren ---------- */
  function initActiveLink() {
    var path = window.location.pathname;
    var links = document.querySelectorAll(".nav__link");
    links.forEach(function (link) {
      var href = link.getAttribute("data-path");
      if (!href) return;
      var isActive = href === "/" ? path === "/" : path.indexOf(href) === 0;
      if (isActive) link.setAttribute("aria-current", "page");
    });
  }

  /* ---------- Consent-Speicher ---------- */
  function getConsent() {
    try {
      return JSON.parse(localStorage.getItem(CONSENT_KEY) || "null");
    } catch (e) {
      return null;
    }
  }
  function setConsent(value) {
    try {
      localStorage.setItem(CONSENT_KEY, JSON.stringify(value));
    } catch (e) {
      /* localStorage evtl. blockiert - dann nur für diese Sitzung */
    }
  }

  /* ---------- Consent-Log (Dokumentation der Einwilligung, DSGVO Art. 7 Abs. 1) ---------- */
  function logConsent(record) {
    // 1) Lokal nachvollziehbar speichern (Nachweis im Browser des Nutzers).
    try {
      var log = JSON.parse(localStorage.getItem(CONSENT_LOG_KEY) || "[]");
      log.push(record);
      if (log.length > 50) log = log.slice(-50); // begrenzen
      localStorage.setItem(CONSENT_LOG_KEY, JSON.stringify(log));
    } catch (e) {
      /* ignorieren */
    }
    // 2) Optional serverseitig dokumentieren, falls ein Endpoint konfiguriert ist.
    var cfg = window.SK_CONFIG || {};
    if (cfg.consentLogEndpoint && navigator.sendBeacon) {
      try {
        navigator.sendBeacon(cfg.consentLogEndpoint, JSON.stringify(record));
      } catch (e) {
        /* still ok */
      }
    }
  }

  /* Auswahl anwenden + dokumentieren. choice = {analyse, marketing} */
  function applyConsent(choice, source) {
    var record = {
      necessary: true,
      analyse: !!choice.analyse,
      marketing: !!choice.marketing,
      version: CONSENT_VERSION,
      ts: Date.now(),
      iso: new Date().toISOString(),
      brand: (window.SK_CONFIG && window.SK_CONFIG.brand) || "sk",
      source: source || "banner",
      path: window.location.pathname,
    };
    setConsent(record);
    logConsent(record);
    loadConsentedContent(record);
    return record;
  }

  /* ---------- Cookie-Banner + Einstellungen ---------- */
  function initCookieBanner() {
    var root = document.getElementById("cookie-consent");
    if (!root) return;
    var banner = document.getElementById("cookie-banner");
    var modal = document.getElementById("cookie-modal");
    var consent = getConsent();

    function showBanner() {
      root.hidden = false;
      if (banner) banner.hidden = false;
      if (modal) modal.hidden = true;
    }
    function showModal(prefill) {
      root.hidden = false;
      if (banner) banner.hidden = true;
      if (modal) {
        modal.hidden = false;
        // Schalter mit aktueller/voriger Auswahl vorbelegen (Opt-in: Default aus = false)
        var p = prefill || {};
        root.querySelectorAll("[data-cat]").forEach(function (input) {
          var cat = input.getAttribute("data-cat");
          input.checked = !!p[cat];
        });
        var firstFocus = modal.querySelector(".cookie-modal__close");
        if (firstFocus) firstFocus.focus();
      }
    }
    function hideAll() {
      root.hidden = true;
      if (banner) banner.hidden = true;
      if (modal) modal.hidden = true;
    }

    // Erstbesuch: Banner zeigen. Sonst: gespeicherte Auswahl direkt anwenden.
    if (!consent || consent.version !== CONSENT_VERSION) {
      showBanner();
    } else {
      loadConsentedContent(consent);
    }

    // Footer-Trigger "Cookie-Einstellungen" (kann außerhalb des Banners liegen)
    document.addEventListener("click", function (e) {
      var trigger = e.target.closest('[data-cookie="settings"]');
      if (trigger && !root.contains(trigger)) {
        e.preventDefault();
        showModal(getConsent() || {});
      }
    });

    root.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-cookie]");
      if (!btn) return;
      var action = btn.getAttribute("data-cookie");

      if (action === "accept") {
        applyConsent({ analyse: true, marketing: true }, modal && !modal.hidden ? "modal" : "banner");
        hideAll();
      } else if (action === "reject") {
        applyConsent({ analyse: false, marketing: false }, modal && !modal.hidden ? "modal" : "banner");
        hideAll();
      } else if (action === "settings") {
        showModal(getConsent() || {});
      } else if (action === "save") {
        var choice = {};
        root.querySelectorAll("[data-cat]").forEach(function (input) {
          choice[input.getAttribute("data-cat")] = input.checked;
        });
        applyConsent(choice, "modal");
        hideAll();
      } else if (action === "close") {
        // Schließen ohne neue Einwilligung: nur zurück, wenn schon eine Auswahl existiert.
        if (getConsent()) hideAll();
        else showBanner();
      }
    });

    // ESC schließt das Einstellungen-Panel (zurück zum Banner, falls noch keine Wahl).
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && modal && !modal.hidden) {
        if (getConsent()) hideAll();
        else showBanner();
      }
    });
  }

  /* ---------- Calendly nach Zustimmung laden ---------- */
  function loadCalendly() {
    var widget = document.querySelector(".booking__widget[data-calendly]");
    if (!widget) return;
    var url = widget.getAttribute("data-calendly");
    if (!url) return; // kein Link konfiguriert -> Fallback bleibt sichtbar
    if (widget.dataset.loaded === "true") return;

    var inline = document.createElement("div");
    inline.className = "calendly-inline-widget";
    inline.setAttribute("data-url", url);
    inline.style.minWidth = "320px";
    inline.style.height = "680px";
    widget.innerHTML = "";
    widget.appendChild(inline);

    var script = document.createElement("script");
    script.src = "https://assets.calendly.com/assets/external/widget.js";
    script.async = true;
    script.onerror = function () {
      widget.innerHTML =
        '<p class="booking__fallback">Die Terminbuchung konnte nicht geladen werden. ' +
        'Bitte <a href="' + url + '" target="_blank" rel="noopener">oeffne den Kalender direkt</a> ' +
        "oder kontaktiere uns telefonisch.</p>";
    };
    document.body.appendChild(script);
    widget.dataset.loaded = "true";
  }

  /* ---------- Social-Embeds nach Zustimmung ---------- */
  function loadSocialEmbeds() {
    // Ohne API-Keys bleiben die statischen Profil-Karten bestehen (Fallback).
    // Mit konfigurierten Embeds koennte hier z. B. ein YouTube-/TikTok-iframe
    // dynamisch nachgeladen werden. Die Karten verlinken bereits aufs Profil.
    document.querySelectorAll(".social-card[data-embed]").forEach(function (card) {
      card.dataset.consented = "true";
    });
  }

  /* ---------- Google Analytics 4 nach Zustimmung ---------- */
  function loadAnalytics() {
    var cfg = window.SK_CONFIG || {};
    if (!cfg.gaId) return; // keine Mess-ID gesetzt
    if (window.__gaLoaded) return;
    window.__gaLoaded = true;

    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(cfg.gaId);
    document.head.appendChild(s);

    window.dataLayer = window.dataLayer || [];
    function gtag() {
      window.dataLayer.push(arguments);
    }
    window.gtag = gtag;
    gtag("js", new Date());
    // IP-Anonymisierung aktiv, datensparsam
    gtag("config", cfg.gaId, { anonymize_ip: true });
  }

  function loadConsentedContent(consent) {
    consent = consent || getConsent() || {};
    // Analyse-Kategorie -> Google Analytics
    if (consent.analyse) loadAnalytics();
    // Marketing-Kategorie -> externe Einbettungen (Terminbuchung, Social Media)
    if (consent.marketing) {
      loadCalendly();
      loadSocialEmbeds();
    }
  }

  /* ---------- Init ---------- */
  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  /* ---------- Studien-Slider (mit Pfeilen) ---------- */
  function initStudySlider() {
    document.querySelectorAll("[data-study-slider]").forEach(function (s) {
      var track = s.querySelector(".study-track");
      var slides = s.querySelectorAll(".study-card");
      var dots = s.querySelectorAll(".study-dot");
      var prev = s.querySelector("[data-study-prev]");
      var next = s.querySelector("[data-study-next]");
      if (!track || slides.length < 2) return;
      var i = 0;
      var n = slides.length;
      function go(idx) {
        i = (idx + n) % n;
        track.style.transform = "translateX(-" + i * 100 + "%)";
        dots.forEach(function (d, j) {
          d.setAttribute("aria-current", j === i ? "true" : "false");
        });
      }
      if (prev) prev.addEventListener("click", function () { go(i - 1); });
      if (next) next.addEventListener("click", function () { go(i + 1); });
      dots.forEach(function (d) {
        d.addEventListener("click", function () {
          go(parseInt(d.getAttribute("data-slide"), 10) || 0);
        });
      });
      go(0);
    });
  }

  ready(function () {
    initNav();
    initActiveLink();
    initCookieBanner();
    initReveal();
    initStudySlider();
  });
})();
