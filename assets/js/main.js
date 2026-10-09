// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

async function compress(text) {
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  writer.write(new TextEncoder().encode(text));
  writer.close();
  const buf   = await new Response(stream.readable).arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary  = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function decompress(b64url) {
  const b64    = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bytes  = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new TextDecoder().decode(
    await new Response(stream.readable).arrayBuffer(),
  );
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const editor      = document.getElementById("editor");      // <textarea>
const display     = document.getElementById("display");     // render layer
const urlBar      = document.getElementById("url-bar");
const qrOverlay   = document.getElementById("qr-overlay");
const qrContainer = document.getElementById("qr-container");
const toast       = document.getElementById("toast");
const printUrl    = document.getElementById("print-url");

const DEFAULT_TITLE    = document.title;
const DEFAULT_FILENAME = "TxtUrl";
const URL_LIMIT        = 60_000;

// ---------------------------------------------------------------------------
// Markdown renderer
//
// Rules are tested against the raw line text in order (most-specific first).
// Code blocks (``` delimiters) take priority over all other rules.
// ---------------------------------------------------------------------------

const MD_RULES = [
  [/^######\s/, "md-h6"],
  [/^#####\s/,  "md-h5"],
  [/^####\s/,   "md-h4"],
  [/^###\s/,    "md-h3"],
  [/^##\s/,     "md-h2"],
  [/^#\s/,      "md-h1"],
  [/^>\s/,      "md-quote"],
  [/^[-*]\s/,   "md-li"],
  [/^\d+\.\s/,  "md-oli"],
  [/^-{3,}$/,   "md-hr"],
];

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Rebuild #display from the current textarea value.
 *
 * One <div class="line [md-class]"> is created per text line.
 * Empty lines get a <br> so they maintain their visual height.
 *
 * Code-block tracking:
 *   A line starting with ``` is always a delimiter (md-code-delim).
 *   Lines between two delimiters receive md-code.
 *   The inCode toggle happens AFTER classifying the delimiter line so
 *   the ``` line itself always gets md-code-delim, never md-code.
 */
function renderDisplay() {
  const lines    = editor.value.split("\n");
  const fragment = document.createDocumentFragment();
  let inCode     = false;

  for (const line of lines) {
    const isDelim = /^`{3}/.test(line);

    let cls;
    if (isDelim) {
      cls = "md-code-delim";
    } else if (inCode) {
      cls = "md-code";
    } else {
      cls = MD_RULES.find(([re]) => re.test(line))?.[1] ?? "";
    }

    if (isDelim) inCode = !inCode;

    const div = document.createElement("div");
    div.className = cls ? `line ${cls}` : "line";
    if (cls === "md-hr") {
      // Render the "---" prefix dimmed, then a line filling the rest of the row.
      div.innerHTML = `<span class="hr-dashes">${escapeHtml(line)}</span><span class="hr-line"></span>`;
    } else {
      div.innerHTML = escapeHtml(line) || "<br>";
    }
    fragment.appendChild(div);
  }

  display.replaceChildren(fragment);
  syncScroll();
}

// ---------------------------------------------------------------------------
// Scroll sync
//
// The display layer never scrolls on its own (overflow: visible).
// Instead, its top edge is shifted by the textarea's scrollTop so the
// visible region always matches what the textarea is showing.
// ---------------------------------------------------------------------------

let _scrollRafId = null;

function syncScroll() {
  if (_scrollRafId) return;
  _scrollRafId = requestAnimationFrame(() => {
    display.style.transform = `translateY(${-editor.scrollTop}px)`;
    _scrollRafId = null;
  });
}

editor.addEventListener("scroll", syncScroll);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getRawText() {
  return editor.value;
}

function getFirstTitle(text) {
  for (const line of text.split("\n")) {
    const m = line.match(/^#+\s+(.*\S)/);
    if (m) return m[1].replace(/ #+\s*$/, "").trim();
  }
  return "";
}

function sanitizeFilename(name) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getFilenameBase() {
  return sanitizeFilename(getFirstTitle(getRawText())) || DEFAULT_FILENAME;
}

function updateUrlBar(length) {
  const ratio = Math.min(length / URL_LIMIT, 1);
  urlBar.style.width      = `${ratio * 100}%`;
  urlBar.style.background = length > URL_LIMIT ? "var(--error)" : "var(--text)";
}

function showToast(msg, type) {
  toast.textContent  = msg;
  toast.dataset.type = type;
  toast.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("show"), 2000);
}

async function saveToHash() {
  const text = getRawText();
  if (!text.trim()) {
    history.replaceState(null, "", location.pathname);
    printUrl.href = location.href;
    updateUrlBar(0);
    return true;
  }
  const compressed = await compress(text);
  const fullUrl    = `${location.origin}${location.pathname}#${compressed}`;
  updateUrlBar(fullUrl.length);
  if (fullUrl.length > URL_LIMIT) {
    showToast("Text too long to save in URL", "error");
    return false;
  }
  history.replaceState(null, "", `#${compressed}`);
  printUrl.href = location.href;
  return true;
}

// ---------------------------------------------------------------------------
// QR modal
// ---------------------------------------------------------------------------

function closeQr() {
  qrOverlay.classList.remove("open");
  qrOverlay.addEventListener("transitionend", () => {
    qrContainer.innerHTML = "";
  }, { once: true });
}

// ---------------------------------------------------------------------------
// Editor — input and keyboard
// ---------------------------------------------------------------------------

// Re-render display on every keystroke, paste, cut, undo, redo, etc.
editor.addEventListener("input", renderDisplay);

// Tab inserts four spaces instead of moving focus.
editor.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  e.preventDefault();
  const start = editor.selectionStart;
  const end   = editor.selectionEnd;
  editor.value =
    editor.value.slice(0, start) + "    " + editor.value.slice(end);
  editor.selectionStart = editor.selectionEnd = start + 4;
  renderDisplay();
});

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

window.addEventListener("beforeprint", () => {
  saveToHash();
  document.title = getFilenameBase();
});

window.addEventListener("afterprint", () => {
  document.title = DEFAULT_TITLE;
});

// ---------------------------------------------------------------------------
// Load / init
// ---------------------------------------------------------------------------

function loadText(text) {
  editor.value = text.replace(/\r\n?/g, "\n");
  renderDisplay();
}

const hash = location.hash.slice(1);
if (hash) {
  decompress(hash)
    .then((text) => {
      loadText(text);
      updateUrlBar(location.href.length);
      editor.focus();
      editor.setSelectionRange(0, 0);
      editor.scrollTop = 0;
    })
    .catch(() => {
      history.replaceState(null, "", location.pathname);
      loadText("");
      showToast("Invalid URL", "error");
      editor.focus();
    });
} else {
  renderDisplay();
  editor.focus();
}

// ---------------------------------------------------------------------------
// Toolbar buttons
// ---------------------------------------------------------------------------

document.getElementById("btn-save").addEventListener("click", async () => {
  if (await saveToHash()) showToast("File saved", "info");
});

document.getElementById("btn-trash").addEventListener("click", () => {
  loadText("");
  history.replaceState(null, "", location.pathname);
  printUrl.href = location.href;
  updateUrlBar(0);
  editor.focus();
});

document.getElementById("btn-download").addEventListener("click", async () => {
  await saveToHash();
  const a = Object.assign(document.createElement("a"), {
    href:     URL.createObjectURL(
      new Blob([getRawText()], { type: "text/plain" }),
    ),
    download: `${getFilenameBase()}.md`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById("btn-print").addEventListener("click", async () => {
  if (!(await saveToHash())) return;
  document.title = getFilenameBase();
  window.print();
});

document.getElementById("btn-share").addEventListener("click", async () => {
  if (!(await saveToHash())) return;
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(location.href);
    showToast("Link copied", "info");
  } else {
    showToast("Copy from address bar", "info");
  }
  if (navigator.share) navigator.share({ url: location.href }).catch(() => {});
});

document.getElementById("btn-qr").addEventListener("click", async () => {
  if (!(await saveToHash())) return;
  try {
    const qr = qrcode(0, "L");
    qr.addData(location.href);
    qr.make();
    qrContainer.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0 });
    requestAnimationFrame(() =>
      requestAnimationFrame(() => qrOverlay.classList.add("open")),
    );
  } catch {
    showToast("Text too long for QR code", "error");
  }
});

document.getElementById("qr-download").addEventListener("click", () => {
  const svg    = qrContainer.querySelector("svg");
  const svgUrl = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(svg)], {
      type: "image/svg+xml;charset=utf-8",
    }),
  );
  const img = new Image();
  img.onload = () => {
    const canvas = Object.assign(document.createElement("canvas"), {
      width:  img.width,
      height: img.height,
    });
    canvas.getContext("2d").drawImage(img, 0, 0);
    canvas.toBlob((blob) => {
      const a = Object.assign(document.createElement("a"), {
        href:     URL.createObjectURL(blob),
        download: "qrcode.png",
      });
      a.click();
      URL.revokeObjectURL(a.href);
      URL.revokeObjectURL(svgUrl);
    });
  };
  img.src = svgUrl;
});

document.getElementById("qr-close").addEventListener("click", closeQr);

qrOverlay.addEventListener("click", (e) => {
  if (e.target === qrOverlay) closeQr();
});

// ---------------------------------------------------------------------------
// Global keyboard shortcuts
// ---------------------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === "s") {
    e.preventDefault();
    document.getElementById("btn-save").click();
  }
  if (ctrl && e.key.toLowerCase() === "p") {
    e.preventDefault();
    document.getElementById("btn-print").click();
  }
  if (e.key === "Escape") closeQr();
});

// ---------------------------------------------------------------------------
// Service worker
// ---------------------------------------------------------------------------

if ("serviceWorker" in navigator) {
  const base = window.location.pathname.replace(/\/[^/]*$/, "/");
  navigator.serviceWorker.register(`${base}service-worker.js`);
}
