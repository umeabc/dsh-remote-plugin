/**
 * Phone layout for the DSH web shell.
 *
 * The desktop frame is a three-column grid (icon rail, conversation, right
 * panel). On a phone the rail costs a sixth of the width, and DSH's own narrow
 * mode splits the screen 280/110 when expanded. This script turns the sidebar
 * into a proper overlay drawer instead: the conversation always owns the full
 * viewport, and a floating button opens the session list over it.
 */
(function () {
  'use strict';

  var HTML = document.documentElement;
  var scrim = null;

  function isOpen() {
    return HTML.getAttribute('data-dshm-rail') === '1';
  }

  function dshToggle(open) {
    var button = document.querySelector('[aria-label="打开侧边栏"], [aria-label="收起侧边栏"]');
    if (button === null) return;
    var expanded = button.getAttribute('aria-label') === '收起侧边栏';
    if (expanded !== open) button.click();
  }

  function closeDrawer() {
    HTML.removeAttribute('data-dshm-rail');
    if (scrim !== null) scrim.style.display = 'none';
    dshToggle(false);
  }

  /** True while DSH's own sidebar is expanded (its toggle offers "collapse"). */
  function dshExpanded() {
    var button = document.querySelector('[aria-label="收起侧边栏"], [aria-label="Collapse sidebar"]');
    return button !== null;
  }

  /**
   * Follow DSH instead of guessing from the click target.
   *
   * Any sidebar action that is not a session row - the "new session" button,
   * a project row, a shortcut - closes the sidebar inside the app itself while
   * our marker kept saying "drawer open": the scrim stayed over the page and
   * both floating buttons stayed hidden. Reading the real state every time it
   * can change keeps our layer and the app's in step.
   */
  function syncDrawer() {
    var expanded = dshExpanded();
    if (expanded === isOpen()) return;
    if (expanded) {
      HTML.setAttribute('data-dshm-rail', '1');
      if (scrim !== null) scrim.style.display = 'block';
    } else {
      HTML.removeAttribute('data-dshm-rail');
      if (scrim !== null) scrim.style.display = 'none';
    }
  }

  function buildChrome() {
    if (scrim === null) {
      scrim = document.createElement('div');
      scrim.className = 'dshm-scrim';
      scrim.addEventListener('click', closeDrawer);
      document.body.appendChild(scrim);
    }
    // No floating buttons of our own any more: the shell already draws a
    // sidebar toggle in the top-left leading seat, and the app's own top bar
    // carries the disconnect action next to refresh.
  }

  /**
   * "13 轮 755 步 · 175 tok/s" is three pieces of information in one pill; on a
   * phone the turn and step counts are noise, the speed is not. Rewrite the
   * label down to the speed, and drop the separator that would trail it.
   */
  function trimActivityLabels() {
    var labels = document.querySelectorAll('[data-composer-stat="activity"] [class*="_label"]');
    Array.prototype.forEach.call(labels, function (label) {
      var separator = label.querySelector('[class*="_sep"]');
      if (separator === null) return;
      var node = label.firstChild;
      while (node !== null && node !== separator) {
        var next = node.nextSibling;
        label.removeChild(node);
        node = next;
      }
      label.removeChild(separator);
    });
  }

  /**
   * Old DSH builds render the settings dialog as an 800px grid with a 188px nav
   * column even on a phone, which leaves ~150px of content. From 0.2.2 the
   * dialog styles itself for narrow screens (full-bleed, nav as a horizontal
   * strip), and forcing our own column layout on top of that grid strands the
   * title in a stretched cell. So only mark the panel when it is still the
   * desktop-sized dialog.
   */
  function markSettings() {
    var navList = document.querySelector('[class*="navList"]');
    if (navList === null) return;
    var nav = navList.closest('nav') || navList.parentElement;
    var panel = nav === null ? null : nav.parentElement;
    if (panel === null) return;
    // Zero width means the dialog is still hidden or animating in; measuring
    // then would mark it and never re-check. Wait for a real frame.
    var width = panel.getBoundingClientRect().width;
    if (width === 0) return;
    if (width >= window.innerWidth - 8) {
      panel.removeAttribute('data-dshm-settings-panel');
      nav.removeAttribute('data-dshm-settings-nav');
      navList.removeAttribute('data-dshm-settings-navlist');
      return;
    }
    navList.setAttribute('data-dshm-settings-navlist', '');
    nav.setAttribute('data-dshm-settings-nav', '');
    panel.setAttribute('data-dshm-settings-panel', '');
    var content = Array.prototype.slice.call(panel.children).filter(function (child) {
      return child !== nav;
    })[0];
    if (content !== undefined) content.setAttribute('data-dshm-settings-content', '');
  }

  function mark() {
    if (HTML.getAttribute('data-dshm-mobile') !== '1') HTML.setAttribute('data-dshm-mobile', '1');
    syncDrawer();
    trimActivityLabels();
    markSettings();

    var sidebar = document.querySelector('[class*="sidebarCol"]');
    if (sidebar !== null) {
      var frame = sidebar.parentElement;
      if (frame !== null) frame.setAttribute('data-dshm-frame', '');
    }
    var rightbar = document.querySelector('[class*="rightbarCol"]');
    if (rightbar !== null) rightbar.setAttribute('data-dshm-hide', '');

    document
      .querySelectorAll('button[aria-label="打开右侧边栏"], button[aria-label="Open right sidebar"]')
      .forEach(function (button) {
        button.setAttribute('data-dshm-hide', '');
      });

    buildChrome();
    watchBoot();
  }

  /**
   * Tell the native shell when the sidebar data has landed, so it can keep a
   * loading cover over the half-rendered frame instead of flashing it.
   */
  function watchBoot() {
    var root = document.documentElement;
    if (root.getAttribute('data-dshm-boot') === 'ready') return;
    root.setAttribute('data-dshm-boot', 'pending');
    var started = Date.now();
    function check() {
      var sidebar = document.querySelector('[class*="sidebarCol"]');
      var ready = false;
      if (sidebar !== null) {
        var rows = sidebar.querySelectorAll('[class*="session"], [class*="Session"]');
        ready = rows.length > 0 || sidebar.textContent.trim().length >= 8;
      }
      if (!ready && document.body !== null && document.body.textContent.trim().length > 240) {
        ready = true;
      }
      if (ready) {
        root.setAttribute('data-dshm-boot', 'ready');
        return;
      }
      if (Date.now() - started > 20000) {
        root.setAttribute('data-dshm-boot', 'timeout');
        return;
      }
      setTimeout(check, 200);
    }
    check();
  }

  function onWorkspaceClick(event) {
    var target = event.target;
    if (target === null || typeof target.closest !== 'function') return;
    // Only a real session row dismisses the drawer immediately; expanding a
    // workspace group keeps it open. Everything else still has to be watched:
    // DSH closes the sidebar on its own for other actions (new session, project
    // switch), so re-read its state right after any click settles.
    if (target.closest('[class*="sessionRow"]') !== null) {
      window.setTimeout(closeDrawer, 160);
    }
    window.setTimeout(syncDrawer, 60);
    window.setTimeout(syncDrawer, 220);
    window.setTimeout(syncDrawer, 600);
  }

  function start() {
    mark();
    document.addEventListener('click', onWorkspaceClick, true);
    var observer = new MutationObserver(mark);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', mark);
    window.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && isOpen()) closeDrawer();
    });
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      mark();
      if (tries > 20) clearInterval(timer);
    }, 500);
    // Long-lived pages still change the sidebar without a click (shortcut,
    // deep link, the app reopening a session), so keep a slow reconciliation.
    setInterval(syncDrawer, 800);
  }

  if (document.body === null) {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
