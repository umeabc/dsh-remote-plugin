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
  var drawer = null;
  var scrim = null;
  var power = null;

  function isOpen() {
    return HTML.getAttribute('data-dshm-rail') === '1';
  }

  function dshToggle(open) {
    var button = document.querySelector('[aria-label="打开侧边栏"], [aria-label="收起侧边栏"]');
    if (button === null) return;
    var expanded = button.getAttribute('aria-label') === '收起侧边栏';
    if (expanded !== open) button.click();
  }

  function openDrawer() {
    dshToggle(true);
    window.setTimeout(function () {
      HTML.setAttribute('data-dshm-rail', '1');
      if (scrim !== null) scrim.style.display = 'block';
    }, 40);
  }

  function closeDrawer() {
    HTML.removeAttribute('data-dshm-rail');
    if (scrim !== null) scrim.style.display = 'none';
    dshToggle(false);
  }

  function toggleDrawer() {
    if (isOpen()) closeDrawer();
    else openDrawer();
  }

  function isAppOrigin() {
    return location.hostname === '127.0.0.1' || location.hostname === 'localhost';
  }

  function buildChrome() {
    if (scrim === null) {
      scrim = document.createElement('div');
      scrim.className = 'dshm-scrim';
      scrim.addEventListener('click', closeDrawer);
      document.body.appendChild(scrim);
    }
    if (drawer === null) {
      drawer = document.createElement('button');
      drawer.type = 'button';
      drawer.className = 'dshm-rail-button';
      drawer.setAttribute('aria-label', '会话列表');
      drawer.innerHTML =
        '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">'
        + '<path d="M4 7h16M4 12h16M4 17h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
        + '</svg>';
      drawer.addEventListener('click', toggleDrawer);
      document.body.appendChild(drawer);
    }
    if (isAppOrigin() && power === null) {
      power = document.createElement('button');
      power.type = 'button';
      power.className = 'dshm-power-button';
      power.setAttribute('aria-label', '断开连接');
      power.innerHTML =
        '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">'
        + '<path d="M12 3v9" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>'
        + '<path d="M6.6 6.6a8 8 0 1 0 10.8 0" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>'
        + '</svg>';
      power.addEventListener('click', function () {
        window.location.href = 'dshm://disconnect';
      });
      document.body.appendChild(power);
    }
  }

  function markSettings() {
    var navList = document.querySelector('[class*="navList"]');
    if (navList === null) return;
    var nav = navList.closest('nav') || navList.parentElement;
    var panel = nav === null ? null : nav.parentElement;
    navList.setAttribute('data-dshm-settings-navlist', '');
    if (nav !== null) nav.setAttribute('data-dshm-settings-nav', '');
    if (panel === null) return;
    panel.setAttribute('data-dshm-settings-panel', '');
    var content = Array.prototype.slice.call(panel.children).filter(function (child) {
      return child !== nav;
    })[0];
    if (content !== undefined) content.setAttribute('data-dshm-settings-content', '');
  }

  function mark() {
    if (HTML.getAttribute('data-dshm-mobile') !== '1') HTML.setAttribute('data-dshm-mobile', '1');
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
  }

  function onWorkspaceClick(event) {
    var target = event.target;
    if (target === null || typeof target.closest !== 'function') return;
    // Only a real session row dismisses the drawer; expanding a workspace
    // group keeps it open.
    if (target.closest('[class*="sessionRow"]') === null) return;
    window.setTimeout(closeDrawer, 160);
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
  }

  if (document.body === null) {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
