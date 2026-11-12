// @ts-check
(function () {
  // @ts-ignore acquireVsCodeApi is injected by VS Code
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

  const filterEl = /** @type {HTMLInputElement} */ ($('filter'));
  const autoEl = /** @type {HTMLInputElement} */ ($('auto'));
  const hideAppsEl = /** @type {HTMLInputElement} */ ($('hide-apps'));
  const workspaceEl = /** @type {HTMLInputElement} */ ($('workspace-only'));
  const workspaceToggleEl = $('workspace-toggle');
  const selectAllEl = /** @type {HTMLInputElement} */ ($('select-all'));
  const killSelectedEl = /** @type {HTMLButtonElement} */ ($('kill-selected'));
  const hiddenNoteEl = $('hidden-note');
  const rowsEl = $('rows');
  const statusEl = $('status');
  const errorEl = $('error');
  const emptyEl = $('empty');

  /** @type {any} */
  let data = { entries: [], protectedPids: [], workspaceRoots: [], labels: {}, loading: true };
  const saved = vscode.getState() || {};
  filterEl.value = saved.filter || '';

  /** Rows the user ticked, keyed "port:pid". */
  const selected = new Set();
  /** Rows currently visible and killable (what "select all" selects). */
  /** @type {any[]} */
  let selectable = [];
  const keyOf = (/** @type {any} */ e) => `${e.port}:${e.pid}`;

  // ---------- sorting ----------

  /** Columns that make more sense biggest/oldest first on the first click. */
  const DESC_FIRST = new Set(['memory', 'uptime']);
  /** @type {{ key: string, dir: 1 | -1 }} */
  let sort = saved.sort && saved.sort.key ? saved.sort : { key: 'port', dir: 1 };
  const headers = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('th[data-sort]')]);
  for (const th of headers) {
    th.querySelector('button')?.addEventListener('click', () => {
      const key = /** @type {string} */ (th.dataset.sort);
      sort = sort.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: DESC_FIRST.has(key) ? -1 : 1 };
      vscode.setState({ ...vscode.getState(), sort });
      render();
    });
  }

  // Missing values always sort last, whatever the direction.
  const MISSING = Symbol('missing');
  /** @type {Record<string, (e: any) => any>} */
  const sortValue = {
    port: (e) => e.port,
    process: (e) => (e.container ? e.container.composeService || e.container.name : e.processName).toLowerCase(),
    pid: (e) => e.pid || MISSING,
    // localhost first, then all interfaces, then specific addresses
    addr: (e) => ({ localhost: 0, 'all interfaces': 1 })[describeAddresses(e.addresses || []).text] ?? 2,
    uptime: (e) => (e.startedAt ? Date.now() - e.startedAt : MISSING),
    memory: (e) => e.memoryKB ?? MISSING,
    where: (e) => (e.cwd || e.command || MISSING).toLowerCase?.() ?? MISSING,
  };

  /** @param {any[]} list */
  function sortEntries(list) {
    const get = sortValue[sort.key] || sortValue.port;
    return [...list].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      let c;
      if (va === MISSING || vb === MISSING) c = va === vb ? 0 : va === MISSING ? 1 : -1;
      else c = (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))) * sort.dir;
      // Ties: by port, then pid, always ascending, so the order is stable between refreshes.
      return c || a.port - b.port || (a.pid || 0) - (b.pid || 0);
    });
  }

  function renderHeaders() {
    for (const th of headers) {
      const active = th.dataset.sort === sort.key;
      th.setAttribute('aria-sort', active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none');
      th.classList.toggle('sorted', active);
    }
  }

  // ---------- toolbar ----------

  filterEl.addEventListener('input', () => {
    vscode.setState({ ...vscode.getState(), filter: filterEl.value });
    render();
  });
  filterEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      filterEl.value = '';
      filterEl.dispatchEvent(new Event('input'));
    }
  });
  const setFilter = (/** @type {string} */ key, /** @type {boolean} */ value) => vscode.postMessage({ type: 'setFilter', key, value });
  hideAppsEl.addEventListener('change', () => setFilter('hideAppsAndSystem', hideAppsEl.checked));
  workspaceEl.addEventListener('change', () => setFilter('workspaceOnly', workspaceEl.checked));
  autoEl.addEventListener('change', () => vscode.postMessage({ type: 'pause', paused: !autoEl.checked }));

  selectAllEl.addEventListener('change', () => {
    if (selectAllEl.checked) for (const e of selectable) selected.add(keyOf(e));
    else for (const e of selectable) selected.delete(keyOf(e));
    render();
  });
  killSelectedEl.addEventListener('click', (ev) => {
    const items = selectable.filter((e) => selected.has(keyOf(e))).map((e) => ({ pid: e.pid, port: e.port }));
    if (items.length) vscode.postMessage({ type: 'killMany', items, force: ev.shiftKey });
  });

  window.addEventListener('message', (ev) => {
    if (ev.data?.type === 'filter') {
      filterEl.value = ev.data.text;
      filterEl.dispatchEvent(new Event('input'));
      filterEl.focus();
      return;
    }
    if (ev.data?.type !== 'data') return;
    data = ev.data;
    // Forget selections for ports that are gone (e.g. just killed).
    const alive = new Set((data.entries || []).map(keyOf));
    for (const k of [...selected]) if (!alive.has(k)) selected.delete(k);
    render();
  });

  // ---------- formatting ----------

  const sep = () => (data.platform === 'win32' ? '\\' : '/');

  /** @param {string} p */
  function tildify(p) {
    if (data.home && data.platform !== 'win32' && (p === data.home || p.startsWith(data.home + '/'))) return '~' + p.slice(data.home.length);
    return p;
  }

  /** @param {string | undefined} cwd */
  function workspaceOf(cwd) {
    if (!cwd) return undefined;
    const norm = (/** @type {string} */ s) => (data.platform === 'win32' ? s.toLowerCase() : s);
    return (data.workspaceRoots || []).find((/** @type {string} */ r) => norm(cwd) === norm(r) || norm(cwd).startsWith(norm(r) + sep()));
  }

  /** @param {string[]} addrs */
  function describeAddresses(addrs) {
    const all = addrs.some((a) => a === '*' || a === '0.0.0.0' || a === '[::]' || a === '::');
    if (all) return { text: 'all interfaces', title: addrs.join(', ') };
    const local = addrs.every((a) => a.startsWith('127.') || a === '[::1]' || a === 'localhost');
    if (local) return { text: 'localhost', title: addrs.join(', ') };
    return { text: addrs.join(', '), title: addrs.join(', ') };
  }

  /** "45s", "12m", "3h 5m", "2d 4h" @param {number} ms */
  function formatDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
  }

  /** @param {number} kb */
  function formatMemory(kb) {
    if (kb < 1024) return `${kb} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
    return `${(mb / 1024).toFixed(1)} GB`;
  }

  /**
   * @param {string} tag
   * @param {Record<string, any>} [props]
   * @param {(Node | string | undefined | false)[]} [children]
   */
  function h(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'checked') /** @type {HTMLInputElement} */ (el).checked = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children) if (c) el.append(c);
    return el;
  }

  /** ☆ / ★ toggle for watching a port. @param {number} port @param {boolean} on */
  function starButton(port, on) {
    return h('button', {
      class: 'icon star' + (on ? ' on' : ''),
      text: on ? '★' : '☆',
      title: on ? 'Watched: you are notified when it stops or starts. Click to stop watching.' : 'Watch this port: get notified when it stops or starts',
      'aria-label': on ? `Stop watching port ${port}` : `Watch port ${port}`,
      'aria-pressed': on ? 'true' : 'false',
      onclick: () => vscode.postMessage({ type: 'toggleWatch', port }),
    });
  }

  // ---------- render ----------

  function render() {
    const q = filterEl.value.trim().toLowerCase();
    const labels = data.labels || {};
    const protectedPids = new Set(data.protectedPids || []);
    const filters = data.filters || { hideApps: true, workspaceOnly: false, hasWorkspace: false };
    const pool = data.entries || []; // already narrowed by the extension (Hide apps & system, This workspace)
    const exactPort = /^:(\d+)$/.exec(q); // ":3000" means exactly port 3000
    renderHeaders();
    const filtered = pool.filter((/** @type {any} */ e) => {
      if (!q) return true;
      if (exactPort) return e.port === Number(exactPort[1]);
      const c = e.container || {};
      return [String(e.port), labels[e.port] || '', e.processName, String(e.pid), e.command || '', e.cwd || '', c.name || '', c.image || '', c.composeProject || '']
        .some((s) => s.toLowerCase().includes(q));
    });
    const entries = sortEntries(filtered);

    const canKill = (/** @type {any} */ e) => !e.isContainerRuntime && (e.container || (e.pid && !protectedPids.has(e.pid)));
    selectable = entries.filter(canKill);
    const selectedVisible = selectable.filter((e) => selected.has(keyOf(e))).length;

    autoEl.checked = !data.paused;
    hideAppsEl.checked = !!filters.hideApps;
    workspaceEl.checked = !!filters.workspaceOnly;
    workspaceEl.disabled = !filters.hasWorkspace;
    workspaceToggleEl.title = filters.hasWorkspace ? 'Only servers started from the folder open in this window' : 'Open a folder to use this';
    errorEl.hidden = !data.error;
    errorEl.textContent = data.error || '';

    selectAllEl.checked = selectable.length > 0 && selectedVisible === selectable.length;
    selectAllEl.indeterminate = selectedVisible > 0 && selectedVisible < selectable.length;
    selectAllEl.disabled = selectable.length === 0;
    killSelectedEl.hidden = selectedVisible === 0;
    killSelectedEl.textContent = `Kill ${selectedVisible} selected`;

    const total = pool.length;
    statusEl.textContent = (data.loading && !data.updatedAt
      ? 'Loading…'
      : q ? `${entries.length} of ${total}` : `${total} port${total === 1 ? '' : 's'}`) + (data.host ? ` · ${data.host}` : '');
    statusEl.title = data.host ? `Showing ports in ${data.host} (where this window's workspace runs)` : '';
    statusEl.classList.toggle('busy', !!data.loading);

    const watchedSet = new Set((data.watched || []).map((/** @type {any} */ w) => w.port));
    // Watched ports that are not listening: shown as greyed rows so the expected setup stays visible.
    const ghosts = (data.watched || []).filter((/** @type {any} */ w) => {
      if (w.listening) return false;
      if (!q) return true;
      if (exactPort) return w.port === Number(exactPort[1]);
      return String(w.port).includes(q) || (labels[w.port] || '').toLowerCase().includes(q);
    });

    rowsEl.replaceChildren(
      ...ghosts.map((/** @type {any} */ w) =>
        h('tr', { class: 'ghost' }, [
          h('td', { class: 'c-sel' }),
          h('td', { class: 'c-port' }, [
            h('div', { class: 'port-line' }, [
              h('span', { class: 'port', text: String(w.port) }),
              h('button', { class: 'icon edit-label', text: '✎', title: 'Give this port a name', 'aria-label': `Label port ${w.port}`, onclick: () => vscode.postMessage({ type: 'editLabel', port: w.port }) }),
              starButton(w.port, true),
            ]),
            labels[w.port] && h('div', { class: 'port-label', title: labels[w.port], text: labels[w.port] }),
          ]),
          h('td', { class: 'c-down', colspan: '7' } /* process … actions */, [h('span', { class: 'down', text: '● not listening' })]),
        ]),
      ),
      ...entries.map((/** @type {any} */ e) => {
        const c = e.container;
        const isRuntime = !!e.isContainerRuntime;
        const isProtected = !c && protectedPids.has(e.pid);
        const ws = workspaceOf(e.cwd);
        const addr = describeAddresses(e.addresses || []);
        // One program on IPv4 and another on IPv6 on the same port: say which is which.
        const sh = (data.shared || []).find((/** @type {any} */ x) => x.port === e.port);
        const fam = sh ? (sh.ipv4.includes(e.pid) ? 'ipv4' : sh.ipv6.includes(e.pid) ? 'ipv6' : undefined) : undefined;
        if (fam) {
          addr.text += fam === 'ipv4' ? ' · IPv4' : ' · IPv6';
          addr.title += fam === 'ipv4'
            ? `\nIPv4 only. http://127.0.0.1:${e.port} reaches this one; http://localhost:${e.port} usually reaches the other program (IPv6 is tried first).`
            : `\nIPv6. http://localhost:${e.port} usually reaches this one (IPv6 is tried first); http://127.0.0.1:${e.port} reaches the other program.`;
        }
        const unknownPid = !c && !e.pid;
        const killable = canKill(e);
        const isSelected = killable && selected.has(keyOf(e));
        const label = labels[e.port];
        const verb = c ? 'Stop' : 'Kill';
        const killTitle = c
          ? `Stop container ${c.name} (docker stop). Shift+click to force (docker kill).`
          : isRuntime
            ? 'This is the container runtime itself (Docker Desktop / OrbStack). Killing it would stop every container.'
            : unknownPid
              ? 'The owning process is not visible (it belongs to another user or root)'
              : isProtected
                ? 'This is VS Code itself or a system process'
                : `Kill ${e.processName} (pid ${e.pid}). Shift+click to force kill.`;
        const procTitle = c
          ? [`Container: ${c.name}`, `Image: ${c.image}`, c.composeProject && `Compose: ${c.composeProject} / ${c.composeService || '?'}`, `Forwarded by ${e.processName} (pid ${e.pid})`].filter(Boolean).join('\n')
          : e.processName;

        const uptime = e.startedAt
          ? h('span', {
              // Docker only reports rough uptime ("Up 2 hours"), so show its own words on hover.
              title: c ? `Docker: ${c.status}` : `Started ${new Date(e.startedAt).toLocaleString()}`,
              text: (c ? '~' : '') + formatDuration(Date.now() - e.startedAt),
            })
          : c?.status
            ? h('span', { title: c.status, text: c.status })
            : undefined;
        const memory = e.memoryKB !== undefined
          ? h('span', {
              title: e.cpuPercent !== undefined ? `${formatMemory(e.memoryKB)} memory, ${e.cpuPercent}% CPU` : `${formatMemory(e.memoryKB)} memory`,
            }, [
              formatMemory(e.memoryKB),
              e.cpuPercent !== undefined && e.cpuPercent >= 1 && h('span', { class: 'cpu', text: ` · ${Math.round(e.cpuPercent)}%` }),
            ])
          : undefined;

        return h('tr', { class: [ws && 'in-workspace', isSelected && 'selected'].filter(Boolean).join(' ') }, [
          h('td', { class: 'c-sel' }, [
            h('input', {
              type: 'checkbox',
              checked: isSelected,
              disabled: !killable,
              title: killable ? 'Select to kill several at once' : killTitle,
              'aria-label': `Select port ${e.port}`,
              onchange: (/** @type {Event} */ ev) => {
                if (/** @type {HTMLInputElement} */ (ev.target).checked) selected.add(keyOf(e));
                else selected.delete(keyOf(e));
                render();
              },
            }),
          ]),
          h('td', { class: 'c-port' }, [
            h('div', { class: 'port-line' }, [
              e.http
                ? h('a', {
                    class: 'port open',
                    href: '#',
                    text: `${e.port} ↗`,
                    title: `Open ${e.http}://${fam === 'ipv4' ? '127.0.0.1' : 'localhost'}:${e.port}`,
                    onclick: (/** @type {Event} */ ev) => {
                      ev.preventDefault();
                      vscode.postMessage({ type: 'open', port: e.port, scheme: e.http, host: fam === 'ipv4' ? '127.0.0.1' : 'localhost' });
                    },
                  })
                : h('span', { class: 'port', text: String(e.port) }),
              h('button', {
                class: 'icon move',
                text: '⇄',
                title: c
                  ? "A container's ports are fixed when it is created: change the mapping in docker-compose.yml"
                  : killable
                    ? `Move to another port: restart it on e.g. ${e.port + 1}`
                    : killTitle,
                'aria-label': `Move the server on port ${e.port} to another port`,
                disabled: !killable || !!c,
                onclick: () => vscode.postMessage({ type: 'switchPort', port: e.port, pid: e.pid }),
              }),
              h('button', {
                class: 'icon edit-label',
                text: '✎',
                title: label ? `Rename "${label}"` : 'Give this port a name',
                'aria-label': `Label port ${e.port}`,
                onclick: () => vscode.postMessage({ type: 'editLabel', port: e.port }),
              }),
              starButton(e.port, watchedSet.has(e.port)),
            ]),
            label && h('div', { class: 'port-label', title: label, text: label }),
          ]),
          h('td', { class: 'c-proc', title: procTitle }, [
            h('span', { text: c ? (c.composeService || c.name) : e.processName }),
            c && h('span', { class: 'badge muted', text: 'container' }),
            isRuntime && h('span', { class: 'badge muted', text: 'runtime' }),
            isProtected && h('span', { class: 'badge muted', text: 'VS Code', title: 'Part of this VS Code process tree' }),
            fam &&
              h('span', {
                class: 'badge warn',
                text: '⚠ shared',
                title: `Two programs listen on port ${e.port}: one on IPv4, one on IPv6. The OS allows it, so neither got "port in use", but localhost:${e.port} and 127.0.0.1:${e.port} reach different apps. Move one of them (⇄).`,
              }),
            e.terminal &&
              h('button', {
                class: 'badge terminal',
                text: `⌨ ${e.terminal}`,
                title: `Started in the VS Code terminal "${e.terminal}". Click to show it.`,
                onclick: () => vscode.postMessage({ type: 'showTerminal', pid: e.pid, port: e.port }),
              }),
          ]),
          h('td', { class: 'c-pid', text: e.pid ? String(e.pid) : '?' }),
          h('td', { class: 'c-addr', title: addr.title, text: addr.text }),
          h('td', { class: 'c-up' }, [uptime]),
          h('td', { class: 'c-mem' }, [memory]),
          h('td', { class: 'c-where' }, [
            e.cwd &&
              h('div', { class: 'cwd' }, [
                ws && h('span', { class: 'badge', text: 'this workspace', title: ws }),
                h('a', {
                  href: '#',
                  title: e.cwdGuessed ? `Reveal ${e.cwd}\n(Folder inferred from the command line or terminal: Windows doesn't report it)` : `Reveal ${e.cwd}`,
                  text: tildify(e.cwd),
                  onclick: (/** @type {Event} */ ev) => {
                    ev.preventDefault();
                    vscode.postMessage({ type: 'openFolder', cwd: e.cwd });
                  },
                }),
              ]),
            c && h('div', { class: 'cmd', title: `${c.image}\n${c.id}`, text: `${c.name} · ${c.image}` }),
            !c && e.command &&
              h('div', {
                class: 'cmd',
                title: `${e.command}\n\nClick to copy`,
                text: e.command,
                onclick: () => vscode.postMessage({ type: 'copy', text: e.command }),
              }),
          ]),
          h('td', { class: 'c-act' }, [
            h('button', {
              class: 'kill',
              text: verb,
              title: killTitle,
              'aria-label': `${verb} ${c ? 'container' : 'process'} on port ${e.port}`,
              disabled: !killable,
              onclick: (/** @type {MouseEvent} */ ev) => vscode.postMessage({ type: 'kill', pid: e.pid, port: e.port, force: ev.shiftKey }),
            }),
          ]),
        ]);
      }),
    );

    emptyEl.hidden = entries.length > 0 || ghosts.length > 0 || (data.loading && !data.updatedAt);
    emptyEl.textContent = q
      ? `No ports match "${filterEl.value}".`
      : filters.workspaceOnly ? 'No servers from this workspace are listening.' : 'No listening ports found.';

    // What the switches hide, with a one-click way to show it.
    const hidden = data.hidden || { apps: 0, otherFolders: 0 };
    /** @type {(Node | string)[]} */
    const notes = [];
    const showLink = (/** @type {string} */ text, /** @type {string} */ key) =>
      h('a', {
        href: '#',
        text,
        onclick: (/** @type {Event} */ ev) => {
          ev.preventDefault();
          setFilter(key, false);
        },
      });
    if (hidden.otherFolders) notes.push(`${hidden.otherFolders} from other folders hidden · `, showLink('Show', 'workspaceOnly'));
    if (hidden.otherFolders && hidden.apps) notes.push('   ');
    if (hidden.apps) notes.push(`${hidden.apps} desktop app & system port${hidden.apps === 1 ? '' : 's'} hidden · `, showLink('Show', 'hideAppsAndSystem'));
    hiddenNoteEl.hidden = notes.length === 0;
    hiddenNoteEl.replaceChildren(...notes);
  }

  render();
  vscode.postMessage({ type: 'ready' });
})();
