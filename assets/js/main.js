// --- Compression ---
async function compress(text) {
    const stream = new CompressionStream("deflate-raw");
    const writer = stream.writable.getWriter();
    writer.write(new TextEncoder().encode(text));
    writer.close();
    const buf = await new Response(stream.readable).arrayBuffer();
    return btoa(
        Array.from(new Uint8Array(buf), (b) => String.fromCharCode(b)).join(""),
    );
}

async function decompress(b64) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const stream = new DecompressionStream("deflate-raw");
    const writer = stream.writable.getWriter();
    writer.write(bytes);
    writer.close();
    return new TextDecoder().decode(
        await new Response(stream.readable).arrayBuffer(),
    );
}

// --- DOM refs ---
const editor = document.getElementById("editor");
const qrContainer = document.getElementById("qr-container");
const qrOverlay = document.getElementById("qr-overlay");
const toast = document.getElementById("toast");

// --- Utilities ---
function updatePrintUrl() {
    const el = document.getElementById("print-url");
    el.href = location.href;
}

async function printPage() {
    await saveToHash();
    updatePrintUrl();
    window.print();
}

function getRawText() {
    return [...editor.children].map((d) => d.textContent).join("\n");
}

function escapeHtml(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function buildHtml(lines) {
    return lines
        .map((line) => `<div>${escapeHtml(line) || "<br>"}</div>`)
        .join("");
}

async function saveToHash() {
    const text = getRawText();
    history.replaceState(
        null,
        "",
        text.trim() ? "#" + (await compress(text)) : window.location.pathname,
    );
    updatePrintUrl();
}

function showToast(msg, type) {
    toast.textContent = msg;
    toast.dataset.type = type;
    toast.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toast.classList.remove("show"), 3000);
}

function closeQr() {
    qrOverlay.classList.remove("open");
    qrContainer.innerHTML = "";
}

// --- Cursor ---
function saveCursor() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return { divIdx: 0, offset: 0 };
    const range = sel.getRangeAt(0);
    let node = range.startContainer;
    while (node && node.parentNode !== editor) node = node.parentNode;
    return {
        divIdx: Math.max(0, [...editor.children].indexOf(node)),
        offset:
            range.startContainer.nodeType === Node.TEXT_NODE
                ? range.startOffset
                : 0,
    };
}

function restoreCursor({ divIdx, offset }) {
    const div = editor.children[divIdx] || editor.lastChild;
    if (!div) return;
    const r = document.createRange();
    if (div.firstChild?.nodeType === Node.TEXT_NODE) {
        r.setStart(div.firstChild, Math.min(offset, div.firstChild.length));
    } else {
        r.setStart(div, 0);
    }
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    editor.focus();
}

// --- Undo/Redo ---
const undoStack = [
    { html: "<div><br></div>", cursor: { divIdx: 0, offset: 0 } },
];
const redoStack = [];

function pushUndo() {
    const html = editor.innerHTML;
    if (undoStack.at(-1)?.html === html) return;
    undoStack.push({ html, cursor: saveCursor() });
    redoStack.length = 0;
}

function applySnap(snap) {
    editor.innerHTML = snap.html;
    mdRender(editor);
    restoreCursor(snap.cursor);
    scheduleSave();
}

function applyUndo() {
    if (undoStack.length <= 1) return;
    redoStack.push(undoStack.pop());
    applySnap(undoStack.at(-1));
}

function applyRedo() {
    if (!redoStack.length) return;
    undoStack.push(redoStack.pop());
    applySnap(undoStack.at(-1));
}

// --- Schedule ---
let undoTimer, saveTimer;

function scheduleCommit() {
    clearTimeout(undoTimer);
    undoTimer = setTimeout(pushUndo, 300);
}

function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveToHash, 300);
}

// --- Paste helper ---
function pasteLines(lines) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    sel.deleteFromDocument();
    const range = sel.getRangeAt(0);

    let currentDiv = range.startContainer;
    while (currentDiv && currentDiv.parentNode !== editor)
        currentDiv = currentDiv.parentNode;

    const divs = [...editor.children];
    const idx = Math.max(
        0,
        currentDiv ? divs.indexOf(currentDiv) : divs.length - 1,
    );
    const offset =
        range.startContainer.nodeType === Node.TEXT_NODE
            ? range.startOffset
            : 0;
    const before = (currentDiv?.textContent ?? "").slice(0, offset);
    const after = (currentDiv?.textContent ?? "").slice(offset);

    const newLines = divs.slice(0, idx).map((d) => d.textContent);
    lines.forEach((line, i) => newLines.push(i === 0 ? before + line : line));
    newLines[newLines.length - 1] += after;
    divs.slice(idx + 1).forEach((d) => newLines.push(d.textContent));

    const cursorDivIndex = idx + lines.length - 1;
    editor.innerHTML = buildHtml(newLines);
    restoreCursor({
        divIdx: cursorDivIndex,
        offset: newLines[cursorDivIndex].length - after.length,
    });
    mdRender(editor);
    scheduleCommit();
    scheduleSave();
}

// --- Editor events ---
editor.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (ctrl && key === "z" && !e.shiftKey) {
        e.preventDefault();
        applyUndo();
        return;
    }
    if (ctrl && (key === "y" || (key === "z" && e.shiftKey))) {
        e.preventDefault();
        applyRedo();
        return;
    }
    if (e.key === "Tab") {
        e.preventDefault();
        pasteLines(["    "]);
        return;
    }

    if (e.key !== "Backspace" && e.key !== "Delete") return;
    if (editor.children.length > 1) return;
    if (!editor.firstChild.textContent) {
        e.preventDefault();
        return;
    }
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const atStart =
        range.collapsed &&
        range.startOffset === 0 &&
        (range.startContainer === editor.firstChild ||
            range.startContainer === editor.firstChild?.firstChild);
    if (atStart) e.preventDefault();
});

editor.addEventListener("input", () => {
    requestAnimationFrame(() => {
        [...editor.childNodes].forEach((node) => {
            if (node.nodeType !== Node.ELEMENT_NODE || node.nodeName !== "DIV")
                editor.removeChild(node);
        });
        if (
            !editor.children.length ||
            (editor.children.length === 1 && !editor.firstChild.textContent)
        ) {
            editor.innerHTML = "<div><br></div>";
            restoreCursor({ divIdx: 0, offset: 0 });
        }
        mdRender(editor);
    });
    scheduleCommit();
    scheduleSave();
});

editor.addEventListener("paste", (e) => {
    e.preventDefault();
    pasteLines(
        e.clipboardData
            .getData("text/plain")
            .replace(/\r\n?/g, "\n")
            .replace(/\t/g, "    ")
            .split("\n"),
    );
});

window.addEventListener("beforeprint", async (e) => {
    await saveToHash();
    updatePrintUrl();
});

// --- Load from hash ---
const hash = window.location.hash.slice(1);
if (hash) {
    decompress(hash).then((text) => {
        editor.innerHTML = buildHtml(text.replace(/\r\n?/g, "\n").split("\n"));
        mdRender(editor);
        undoStack[0] = {
            html: editor.innerHTML,
            cursor: { divIdx: 0, offset: 0 },
        };
        restoreCursor({ divIdx: editor.children.length - 1, offset: Infinity });
    });
} else {
    editor.focus();
}

// --- Buttons ---
document.getElementById("btn-trash").addEventListener("click", () => {
    editor.innerHTML = "<div><br></div>";
    scheduleCommit();
    scheduleSave();
    editor.focus();
});

document.getElementById("btn-download").addEventListener("click", () => {
    const a = Object.assign(document.createElement("a"), {
        href: URL.createObjectURL(
            new Blob([getRawText()], { type: "text/plain" }),
        ),
        download: "TxtUrl.md",
    });
    a.click();
    URL.revokeObjectURL(a.href);
});

document.getElementById("btn-share").addEventListener("click", async () => {
    await saveToHash();
    if (navigator.clipboard) {
        await navigator.clipboard.writeText(location.href);
        showToast("Link copied!", "info");
    } else {
        showToast("Copy from address bar.", "info");
    }
    if (navigator.share)
        navigator.share({ url: location.href }).catch(() => {});
});

document.getElementById("btn-qr").addEventListener("click", async () => {
    await saveToHash();
    try {
        const qr = qrcode(0, "L");
        qr.addData(location.href);
        qr.make();
        qrContainer.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0 });
        qrOverlay.classList.add("open");
    } catch (e) {
        showToast("Text too long for QR code.", "error");
    }
});

document.getElementById("btn-print").addEventListener("click", printPage);

document.getElementById("qr-close").addEventListener("click", closeQr);
qrOverlay.addEventListener("click", (e) => {
    if (e.target === qrOverlay) closeQr();
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeQr();
});

document.addEventListener("DOMContentLoaded", updatePrintUrl);
