/**
 * API History Console — slide-up drawer available on every page.
 * Toggled via the "API Console" header link (ApiConsole.toggle()).
 * Polls GET /api/logs every 2s while open; click a row to expand the
 * request/response JSON. Server keeps the last 300 /api/* calls in memory.
 */
const ApiConsole = (() => {
  let logs = [];
  let visible = false;
  let timer = null;
  const expanded = new Set();

  const css = `
  #api-console-drawer {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 1000;
    height: 46vh; display: flex; flex-direction: column;
    background: var(--bg-card, #161c24); border-top: 2px solid var(--accent, #ff6a00);
    box-shadow: 0 -8px 30px rgba(0,0,0,.5);
    transform: translateY(100%); transition: transform .25s ease;
  }
  #api-console-drawer.open { transform: translateY(0); }
  #api-console-drawer .ac-bar {
    display: flex; align-items: center; gap: 10px; padding: 10px 16px;
    border-bottom: 1px solid var(--border, #2a3441); font-size: 13px;
  }
  #api-console-drawer .ac-title { font-weight: 800; letter-spacing: 1px; }
  #api-console-drawer .ac-btn {
    padding: 5px 12px; border-radius: 999px; border: 1px solid var(--border, #2a3441);
    background: var(--bg-elev, #1d2530); color: var(--text-dim, #8b97a5);
    font-size: 12px; font-weight: 700; cursor: pointer;
  }
  #api-console-drawer .ac-btn:hover { color: var(--text, #e6edf3); }
  #api-console-drawer .ac-body { flex: 1; overflow: auto; padding: 4px 16px 16px; }
  #api-console-drawer .ac-row {
    display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; padding: 7px 8px; cursor: pointer;
    border-bottom: 1px solid var(--border, #2a3441); font-size: 12.5px; white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  #api-console-drawer .ac-route {
    width: 100%; font-size: 11px; color: var(--text-dim, #8b97a5);
    white-space: normal; padding-left: 2px;
  }
  #api-console-drawer .ac-route b { color: var(--accent-2, #ffb648); font-weight: 700; }
  #api-console-drawer .ac-row:hover { background: var(--bg-elev, #1d2530); }
  #api-console-drawer .ac-method { font-weight: 800; width: 52px; }
  #api-console-drawer .ac-path { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  #api-console-drawer .ac-via { color: var(--text-dim, #8b97a5); font-size: 11px; }
  #api-console-drawer .ac-ok { color: var(--green, #2ecc71); font-weight: 700; }
  #api-console-drawer .ac-err { color: var(--red, #ff5b5b); font-weight: 700; }
  #api-console-drawer pre.ac-json {
    margin: 8px 0; padding: 10px; background: var(--bg, #0d1117);
    border: 1px solid var(--border, #2a3441); border-radius: 8px;
    color: var(--accent-2, #ffb648); font-size: 11.5px; line-height: 1.5;
    max-height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-all;
  }
  #api-console-drawer .ac-label {
    font-size: 10px; color: var(--text-dim, #8b97a5);
    text-transform: uppercase; letter-spacing: 1px;
  }
  #api-console-drawer .ac-detail { padding: 4px 8px 10px; background: var(--bg-elev, #1d2530); }
  #api-console-drawer .ac-empty { color: var(--text-dim, #8b97a5); text-align: center; padding: 30px 0; }`;

  function build() {
    if (document.getElementById("api-console-drawer")) return;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const d = document.createElement("div");
    d.id = "api-console-drawer";
    d.innerHTML = `
      <div class="ac-bar">
        <span class="ac-title">📜 API HISTORY</span>
        <span class="ac-via" id="ac-count"></span>
        <span style="flex:1"></span>
        <button class="ac-btn" id="ac-clear">🗑 Clear</button>
        <button class="ac-btn" id="ac-close">✕ Hide</button>
      </div>
      <div class="ac-body" id="ac-body"></div>`;
    document.body.appendChild(d);
    d.querySelector("#ac-close").addEventListener("click", toggle);
    d.querySelector("#ac-clear").addEventListener("click", async () => {
      await fetch("/api/logs", { method: "DELETE" });
      logs = [];
      expanded.clear();
      render();
    });
  }

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pretty = (o) => (o === null || o === undefined) ? "—" : esc(JSON.stringify(o, null, 2));

  function render() {
    const body = document.getElementById("ac-body");
    if (!body) return;
    document.getElementById("ac-count").textContent = `${logs.length} calls`;
    if (!logs.length) {
      body.innerHTML = `<div class="ac-empty">No API calls logged yet — browse the store or run a checkout.<br/>
        (If this stays empty, restart the server to enable /api/logs.)</div>`;
      return;
    }
    body.innerHTML = logs.slice().reverse().map((l) => {
      const stCls = l.status >= 200 && l.status < 300 ? "ac-ok" : "ac-err";
      const open = expanded.has(l.id);
      return `
      <div class="ac-row" data-id="${l.id}">
        <span class="ac-via">#${l.id} ${new Date(l.time).toLocaleTimeString()}</span>
        <span class="ac-method">${l.method}</span>
        <span class="ac-path">${esc(l.path)}</span>
        <span class="ac-via">${esc(l.via || "")}</span>
        <span class="${stCls}">${l.status}</span>
        <span class="ac-via">${l.durationMs}ms</span>
        ${l.from || l.to ? `<div class="ac-route"><b>${esc(l.from || "?")}</b> ➜ <b>${esc(l.to || "?")}</b></div>` : ""}
      </div>
      ${open ? `<div class="ac-detail">
        <span class="ac-label">Request body</span>
        <pre class="ac-json">${pretty(l.requestBody)}</pre>
        <span class="ac-label">Response body (${l.status})</span>
        <pre class="ac-json">${pretty(l.responseBody)}</pre>
      </div>` : ""}`;
    }).join("");
    body.querySelectorAll(".ac-row").forEach((row) =>
      row.addEventListener("click", () => {
        const id = Number(row.dataset.id);
        expanded.has(id) ? expanded.delete(id) : expanded.add(id);
        render();
      })
    );
  }

  async function poll() {
    try {
      const since = logs.length ? logs[logs.length - 1].id : 0;
      const data = await fetch(`/api/logs?since=${since}`).then((r) => r.json());
      if (data.logs && data.logs.length) {
        logs = logs.concat(data.logs).slice(-300);
        render();
      }
    } catch (e) { /* endpoint missing (old server) — drawer shows hint */ }
  }

  function toggle() {
    build();
    visible = !visible;
    document.getElementById("api-console-drawer").classList.toggle("open", visible);
    if (visible) {
      render();
      poll();
      timer = setInterval(poll, 2000);
    } else {
      clearInterval(timer);
    }
  }

  return { toggle };
})();
