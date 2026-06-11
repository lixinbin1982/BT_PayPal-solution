/* LumenX shared store logic: catalog rendering + localStorage cart */

/**
 * Google Pay base library loader with ad-blocker fallback.
 * The CDN <script> tag (pay.google.com/gp/p/js/pay.js) is often blocked by
 * ad/privacy extensions; if window.google.payments is missing we retry via
 * the same-origin proxy /js/gpay.js served by our own server.
 */
const GPayLoader = (() => {
  let loading = null;
  function ensure() {
    if (window.google && window.google.payments) return Promise.resolve(true);
    if (!loading) {
      loading = new Promise((resolve) => {
        const s = document.createElement("script");
        s.src = "/js/gpay.js"; // same-origin proxy of pay.js
        s.onload = () => resolve(!!(window.google && window.google.payments));
        s.onerror = () => resolve(false);
        document.head.appendChild(s);
      });
    }
    return loading;
  }
  return { ensure };
})();

const Store = (() => {
  const CART_KEY = "lumenx_cart";
  let catalog = [];

  async function loadCatalog() {
    if (catalog.length) return catalog;
    catalog = await fetch("/api/products").then((r) => r.json());
    return catalog;
  }

  function getCart() {
    try { return JSON.parse(localStorage.getItem(CART_KEY)) || {}; }
    catch { return {}; }
  }
  function saveCart(cart) {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    renderCartCount();
  }
  function addToCart(id, qty = 1) {
    const cart = getCart();
    cart[id] = (cart[id] || 0) + qty;
    saveCart(cart);
  }
  function setQty(id, qty) {
    const cart = getCart();
    if (qty <= 0) delete cart[id]; else cart[id] = qty;
    saveCart(cart);
  }
  function clearCart() { saveCart({}); }
  function cartItems() {
    return Object.entries(getCart()).map(([id, qty]) => ({ id, qty }));
  }
  function cartCount() {
    return Object.values(getCart()).reduce((a, b) => a + b, 0);
  }

  function renderCartCount() {
    const el = document.querySelector(".cart-count");
    if (el) el.textContent = cartCount();
  }

  /** Stylized SVG "product photo" so the demo needs no image assets. */
  function thumbSVG(p, w = 400, h = 300) {
    return `
    <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
      <defs>
        <radialGradient id="g-${p.id}" cx="30%" cy="25%" r="90%">
          <stop offset="0%" stop-color="${p.color2}" stop-opacity="0.55"/>
          <stop offset="55%" stop-color="${p.color1}"/>
          <stop offset="100%" stop-color="#0b0f14"/>
        </radialGradient>
        <linearGradient id="b-${p.id}" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#39424d"/><stop offset="35%" stop-color="#0f1418"/>
          <stop offset="65%" stop-color="#39424d"/><stop offset="100%" stop-color="#11161b"/>
        </linearGradient>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#g-${p.id})"/>
      <g transform="translate(${w / 2} ${h / 2}) rotate(-28)">
        <rect x="-26" y="-110" width="52" height="64" rx="10" fill="url(#b-${p.id})" stroke="#000" stroke-opacity=".4"/>
        <rect x="-20" y="-46" width="40" height="118" rx="9" fill="url(#b-${p.id})" stroke="#000" stroke-opacity=".4"/>
        <rect x="-20" y="-30" width="40" height="6" fill="${p.color2}" opacity=".9"/>
        <rect x="-20" y="60" width="40" height="14" rx="6" fill="#06090c"/>
        <ellipse cx="0" cy="-112" rx="24" ry="7" fill="${p.color2}" opacity=".95"/>
        <polygon points="-24,-116 24,-116 64,-220 -64,-220" fill="${p.color2}" opacity=".16"/>
      </g>
      <text x="20" y="${h - 20}" font-family="Segoe UI, sans-serif" font-size="13" font-weight="700"
        fill="#ffffff" opacity=".5" letter-spacing="2">LUMENX</text>
    </svg>`;
  }

  function money(n) { return `$${Number(n).toFixed(2)}`; }

  function productCard(p) {
    return `
    <a class="card" href="/product.html?id=${p.id}">
      <div class="thumb-wrap">
        ${p.badge ? `<span class="badge">${p.badge}</span>` : ""}
        <div class="thumb">${thumbSVG(p)}</div>
      </div>
      <div class="body">
        <div class="name">${p.name}</div>
        <div class="tagline">${p.tagline}</div>
        <div class="row">
          <span class="price">${money(p.price)}</span>
          <button class="btn secondary" style="padding:8px 16px;font-size:13px"
            onclick="event.preventDefault();Store.addToCart('${p.id}');Store.toast('Added to cart')">Add to Cart</button>
        </div>
      </div>
    </a>`;
  }

  function toast(msg) {
    let t = document.getElementById("toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast";
      t.style.cssText =
        "position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:#2ecc71;color:#fff;padding:11px 24px;border-radius:999px;font-weight:700;font-size:14px;z-index:99;transition:opacity .3s";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = "1";
    clearTimeout(t._h);
    t._h = setTimeout(() => (t.style.opacity = "0"), 1800);
  }

  document.addEventListener("DOMContentLoaded", renderCartCount);

  return { loadCatalog, getCart, addToCart, setQty, clearCart, cartItems, cartCount, thumbSVG, money, productCard, toast };
})();
