// Keyboard shortcuts and small helpers. Everything here is optional; pages work without it.
(() => {
  let selectedId = null;
  let selectedPath = null;

  const rows = () => [...document.querySelectorAll('[data-list] [data-row]')];
  const typing = (el) => el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable);

  function select(index, scroll = true) {
    const all = rows();
    if (!all.length) return;
    const i = Math.max(0, Math.min(all.length - 1, index));
    all.forEach((r) => {
      r.classList.remove('selected');
      r.removeAttribute('aria-current');
    });
    all[i].classList.add('selected');
    all[i].setAttribute('aria-current', 'true');
    if (scroll) all[i].scrollIntoView({ block: 'nearest' });
    selectedId = all[i].dataset.row;
    selectedPath = location.pathname;
  }

  // Ticket and incident rows share numeric ids, so a selection only applies to the page it was made on.
  function currentIndex() {
    if (selectedPath !== location.pathname) return -1;
    return rows().findIndex((r) => r.dataset.row === selectedId);
  }

  // ---------- live refresh ----------
  // The server pushes the topics that changed over /events (Server-Sent Events). Each container whose data-live lists
  // one of them is re-fetched. A refresh is held while the user is typing, has a compose panel open, or is tabbing
  // inside the container, and runs as soon as they leave, so a swap never eats input, closes a panel, or drops focus.
  const liveElements = () => [...document.querySelectorAll('[data-live]')];
  // A choice made but not yet submitted, such as a Simulate dropdown, would be reset by a swap. Pressing its button
  // moves focus first, so focus alone is not enough to protect it.
  const changed = (c) =>
    c.type === 'checkbox' || c.type === 'radio'
      ? c.checked !== c.defaultChecked
      : c.tagName === 'SELECT'
        ? c.selectedIndex !== Math.max(0, [...c.options].findIndex((o) => o.defaultSelected))
        : c.value !== c.defaultValue;
  const dirty = (elt) => [...elt.querySelectorAll('input:not([type=hidden]), select, textarea')].some(changed);
  const held = (elt) => {
    const active = document.activeElement;
    if (typing(active) || document.querySelector('details[open][data-hold-refresh]') || dirty(elt)) return true;
    return !!active && active !== document.body && elt.contains(active) && active.matches(':focus-visible');
  };
  const pending = new Set();
  const queued = new Set();
  let flushTimer = null;

  function refresh(topics) {
    for (const el of liveElements()) {
      if (!topics || el.dataset.live.split(' ').some((t) => topics.includes(t))) queued.add(el.id);
    }
    // Coalesces a burst (a triage run writes several tables) into one request per container.
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      for (const id of queued) {
        const el = document.getElementById(id);
        if (el) htmx.trigger(el, 'live');
      }
      queued.clear();
    }, 150);
  }

  function release() {
    for (const id of [...pending]) {
      const el = document.getElementById(id);
      if (!el || !held(el)) {
        pending.delete(id);
        if (el) htmx.trigger(el, 'live');
      }
    }
  }
  // Focus has moved by the time a zero-delay timeout runs; toggle does not bubble, so listen in the capture phase.
  document.addEventListener('focusout', () => setTimeout(release, 0));
  document.addEventListener('toggle', release, true);
  document.addEventListener('change', () => setTimeout(release, 0));

  // Applies to pushed refreshes and to the 60 s fallback alike.
  document.addEventListener('htmx:beforeRequest', (e) => {
    const elt = e.detail.elt;
    if (elt.hasAttribute('data-live') && held(elt)) {
      e.preventDefault();
      pending.add(elt.id);
    }
  });
  // A response already in flight when the user started typing or opened a panel must not land on top of it.
  document.addEventListener('htmx:beforeSwap', (e) => {
    const elt = e.detail.elt;
    if (elt.hasAttribute('data-live') && held(elt)) {
      e.detail.shouldSwap = false;
      pending.add(elt.id);
    }
  });

  let source = null;
  function connect() {
    if (source || document.hidden || !window.EventSource) return;
    source = new EventSource('/events');
    source.addEventListener('change', (e) => refresh(e.data.split(' ')));
    // The server starts counting changes when the stream opens, so anything written between rendering this page and
    // connecting (or during a reconnect) would be missed without one full refresh here.
    source.addEventListener('ready', () => refresh(null));
    // EventSource retries a dropped connection itself, but gives up for good on an HTTP error (the connection cap,
    // or a proxy error during a restart).
    source.addEventListener('error', () => {
      if (source?.readyState !== EventSource.CLOSED) return;
      source = null;
      setTimeout(connect, 5000);
    });
  }
  // Browsers allow six connections per site, so a hidden tab gives its stream back and catches up when shown again.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      source?.close();
      source = null;
    } else {
      connect();
      refresh(null);
    }
  });
  connect();
  // Some embedded browsers report a page hidden while it loads and never send visibilitychange afterwards.
  window.addEventListener('focus', connect);
  window.addEventListener('pageshow', connect);
  document.addEventListener('pointerdown', connect, { once: true });

  // Capture phase: htmx sends boosted forms from a listener on the form itself, which runs before a bubbling
  // listener here could cancel.
  document.addEventListener(
    'submit',
    (e) => {
      const form = e.target.closest('form[data-confirm]');
      if (form && !window.confirm(form.dataset.confirm)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );

  // Arrow keys fire change on a closed select in some browsers, so keyboard changes submit when focus leaves.
  let keyboardChange = false;
  document.addEventListener('keydown', (e) => {
    if (e.target.matches?.('select[data-autosubmit]')) keyboardChange = e.key !== 'Enter';
  }, true);
  document.addEventListener('pointerdown', () => (keyboardChange = false), true);
  document.addEventListener('change', (e) => {
    if (!e.target.matches('select[data-autosubmit]')) return;
    if (keyboardChange) e.target.dataset.dirty = '1';
    else e.target.form.requestSubmit();
  });
  document.addEventListener('focusout', (e) => {
    if (e.target.matches?.('select[data-autosubmit][data-dirty]')) e.target.form.requestSubmit();
  });

  // Keep the selection when the polled list is swapped, without scrolling the user back to it.
  document.addEventListener('htmx:afterSwap', () => {
    const i = currentIndex();
    if (i >= 0) select(i, false);
  });

  // Back links return to the page you came from. The stack lives in sessionStorage because live refreshes and
  // post-redirects reload the same page, so the Referer header loses the real previous view.
  // Back links need hx-boost="false": htmx reads a boosted link's href once, so rewriting it here would be ignored.
  const NAV_KEY = 'zoltar-nav';
  function navStack() {
    try {
      return JSON.parse(sessionStorage.getItem(NAV_KEY)) || [];
    } catch {
      return [];
    }
  }
  function syncNav() {
    // A flash message is for the moment it was shown, not for Back links or a reload.
    const url = new URL(location.href);
    if (url.searchParams.has('flash')) {
      url.searchParams.delete('flash');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    }
    const here = { url: location.pathname + location.search, path: location.pathname, title: document.title.replace(/ \| Zoltar$/, '') };
    const stack = navStack();
    const top = stack.at(-1);
    if (top && top.path === here.path) stack[stack.length - 1] = here; // same page: refresh, poll, post-redirect, or tab change
    else if (stack.at(-2)?.path === here.path) stack.pop(); // went back
    else stack.push(here);
    sessionStorage.setItem(NAV_KEY, JSON.stringify(stack.slice(-20)));

    const prev = stack.at(-2);
    for (const a of document.querySelectorAll('a[data-back]')) {
      if (!prev) continue;
      a.href = prev.url;
      a.textContent = `← Back to ${prev.title}`;
      a.title = prev.title;
    }
  }
  syncNav();
  document.addEventListener('htmx:afterSettle', syncNav);
  document.addEventListener('htmx:historyRestore', syncNav);
  document.addEventListener('htmx:historyRestore', () => refresh(null));

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (typing(document.activeElement)) {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }
    const click = (sel) => document.querySelector(sel)?.click();
    switch (e.key) {
      case 'j':
        select(currentIndex() + 1);
        break;
      case 'k':
        select(currentIndex() < 0 ? 0 : currentIndex() - 1);
        break;
      case 'Enter': {
        // A focused button or link handles Enter itself.
        if (document.activeElement?.closest('a, button, summary')) return;
        const row = rows()[currentIndex()];
        if (row) row.click();
        break;
      }
      case 'a':
        click('[data-key="approve"]');
        break;
      case 'r':
        click('[data-key="reject"]');
        break;
      case 'e': {
        const t = document.querySelector('[data-draft]');
        if (t) {
          e.preventDefault();
          t.focus();
        }
        break;
      }
      case 'n':
        click('[data-key="next"]');
        break;
      default:
        return;
    }
  });

  document.addEventListener('click', (e) => {
    const opener = e.target.closest('a[data-open]');
    if (opener) {
      const target = document.querySelector(opener.getAttribute('href'));
      if (target && target.tagName === 'DETAILS') {
        e.preventDefault();
        target.open = true;
        target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    }
    const macro = e.target.closest('[data-insert-macro]');
    if (macro) {
      const t = document.querySelector('[data-draft]');
      if (t) {
        t.value = macro.dataset.insertMacro;
        t.focus();
      }
    }
    const copy = e.target.closest('[data-copy]');
    if (copy && navigator.clipboard) {
      navigator.clipboard.writeText(copy.dataset.copy).then(() => {
        const label = copy.textContent;
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = label), 1200);
      });
    }
  });
})();
