// Importing your own quizzes and flashcard decks: reading picked/dropped files, checking them
// against the file format, saving them in IndexedDB, and the import dialog.

// ---------- Imported sets (saved only in this browser) ----------
// Imported quizzes/decks live in IndexedDB as { id, name, kind, text, files, count }:
// "text" is the questions.json or flashcard file as written, "files" maps image paths
// (relative to questions.json) to Blobs. In the set list they look like built-in sets
// with dir "local:<id>/", and their images are served from blob: URLs.
const IMPORT_PREFIX = "local:";
const IMPORT_OPTION = "__import__";
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", avif: "image/avif", svg: "image/svg+xml" };
const importedRecords = new Map();
let assetUrls = new Map();

const isImportedDir = dir => String(dir).startsWith(IMPORT_PREFIX);
const idFromDir = dir => dir.slice(IMPORT_PREFIX.length).replace(/\/$/, "");
const extOf = path => (path.match(/\.([^./]+)$/) || ["", ""])[1].toLowerCase();
const dirOf = path => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const stripBom = text => text.replace(/^\uFEFF/, "");

// --- IndexedDB ---
let dbPromise = null;
function openDb() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
        const req = indexedDB.open("ccn-imports", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("sets", { keyPath: "id" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}
async function dbRun(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction("sets", mode);
        const req = fn(tx.objectStore("sets"));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error("storage error"));
    });
}

function setEntry(rec) {
    const flash = rec.kind === "flashcards";
    return { dir: `${IMPORT_PREFIX}${rec.id}/`, name: rec.name, imported: true,
        kind: flash ? "flashcards" : undefined, file: flash ? "cards.txt" : undefined };
}
function registerImported(rec) {
    importedRecords.set(rec.id, rec);
    const entry = setEntry(rec);
    const i = QUIZ_SETS.findIndex(s => s.dir === entry.dir);
    if (i >= 0) QUIZ_SETS[i] = entry; else QUIZ_SETS.push(entry);
}
async function loadImportedSets() {
    try {
        const all = await dbRun("readonly", s => s.getAll());
        all.sort((a, b) => a.name.localeCompare(b.name)).forEach(registerImported);
    } catch { /* storage unavailable: imports only last for this visit */ }
}

function buildSetSelect() {
    const select = document.getElementById("set-select");
    select.innerHTML = "";
    const label = s => s.imported ? `${s.name} (${s.kind === "flashcards" ? "flashcards" : "quiz"})` : s.name;
    const builtIn = QUIZ_SETS.filter(s => !s.imported);
    const mine = QUIZ_SETS.filter(s => s.imported);
    const group = (title, sets) => {
        const g = document.createElement("optgroup");
        g.label = title;
        sets.forEach(s => g.appendChild(new Option(label(s), s.dir)));
        select.appendChild(g);
    };
    if (mine.length) { group("Built-in", builtIn); group("Imported (this browser)", mine); }
    else builtIn.forEach(s => select.add(new Option(label(s), s.dir)));
    select.add(new Option("+ Import or manage your own sets…", IMPORT_OPTION));
    select.value = currentDir;
}

// Images of the open imported set, looked up by path (case-insensitive) or just by file name
function prepareAssets(set) {
    assetUrls.forEach(url => URL.revokeObjectURL(url));
    assetUrls = new Map();
    const rec = set && set.imported && importedRecords.get(idFromDir(set.dir));
    if (!rec) return;
    Object.entries(rec.files || {}).forEach(([path, blob]) => {
        const url = URL.createObjectURL(blob);
        const key = path.toLowerCase();
        assetUrls.set(key, url);
        const base = key.split("/").pop();
        if (!assetUrls.has(base)) assetUrls.set(base, url);
    });
}
function assetUrl(file) {
    if (!isImportedDir(DATA_DIR)) return DATA_DIR + encodeURI(file);
    const key = String(file).replace(/^\.\//, "").toLowerCase();
    return assetUrls.get(key) || assetUrls.get(key.split("/").pop()) || "";
}

// --- Reading what the user picked: a list of { path, file } ---
async function entriesFromDrop(dataTransfer) {
    // Entries must be taken synchronously, before the first await
    const roots = [...(dataTransfer.items || [])]
        .map(item => item.webkitGetAsEntry && item.webkitGetAsEntry()).filter(Boolean);
    if (!roots.length) return [...dataTransfer.files].map(file => ({ path: file.name, file }));
    const out = [];
    const walk = async (entry, prefix) => {
        if (entry.isFile) {
            out.push({ path: prefix + entry.name, file: await new Promise((res, rej) => entry.file(res, rej)) });
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            let batch;
            do {
                batch = await new Promise((res, rej) => reader.readEntries(res, rej));
                for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
            } while (batch.length);
        }
    };
    for (const root of roots) await walk(root, "");
    return out;
}

// Turns picked files into sets: every questions.json is a quiz (with the images in its
// folder); every .txt/.tsv file is a flashcard deck (inside a quiz folder only if it has cards)
async function buildImports(entries) {
    entries = entries.filter(e => !e.path.split("/").some(p => p.startsWith(".") || p === "__MACOSX"));
    const results = [];
    const quizEntries = entries.filter(e => e.path.split("/").pop().toLowerCase() === "questions.json");
    const quizDirs = quizEntries.map(e => dirOf(e.path));
    for (const entry of quizEntries) {
        const dir = dirOf(entry.path);
        const prefix = dir ? dir + "/" : "";
        const images = entries.filter(e => e.path.startsWith(prefix) && IMAGE_TYPES[extOf(e.path)]);
        results.push(await buildQuiz(entry, dir, images));
    }
    const noCards = [];
    for (const entry of entries.filter(e => ["txt", "tsv"].includes(extOf(e.path)))) {
        const result = await buildDeck(entry);
        // A notes/readme .txt next to a quiz isn't a deck: skip it quietly
        if (result.cardCount === 0 && quizDirs.includes(dirOf(entry.path))) continue;
        (result.cardCount === 0 ? noCards : results).push(result);
    }
    // Text files without cards only count as failures when nothing else was found
    if (results.length) {
        if (noCards.length) results[0].warnings.push(`Skipped ${noCards.map(r => r.name).join(", ")}: no Tab-separated cards, so not a flashcard deck.`);
    } else {
        results.push(...noCards);
    }
    const strayJson = entries.filter(e => extOf(e.path) === "json" && !quizEntries.includes(e));
    if (!results.length) {
        results.push({ name: "Nothing imported", errors: [strayJson.length
            ? `Found ${strayJson.map(e => e.file.name).join(", ")}, but a quiz file must be named exactly questions.json.`
            : "No questions.json or flashcard .txt file was found in what you picked."], warnings: [] });
    } else if (strayJson.length) {
        results[0].warnings.push(`Ignored ${strayJson.map(e => e.path).join(", ")}: only files named questions.json are read.`);
    }
    return results;
}

// Turns a JSON.parse error into "line X, column Y" with the offending line shown
function jsonErrorMessage(err, text) {
    let line, col;
    const lc = err.message.match(/line (\d+) column (\d+)/i);
    const pos = err.message.match(/position (\d+)/i);
    if (lc) { line = +lc[1]; col = +lc[2]; }
    else if (pos) {
        const before = text.slice(0, +pos[1]).split("\n");
        line = before.length; col = before[before.length - 1].length + 1;
    }
    let msg = `questions.json is not valid JSON (${err.message.replace(/^JSON\.parse: /, "")}).`;
    if (line) {
        const src = (text.split("\n")[line - 1] || "").trim();
        msg += ` Look near line ${line}, column ${col}` + (src ? `: ${src.length > 90 ? src.slice(0, 90) + "…" : src}` : ".");
    }
    return msg + " Common causes: a missing or extra comma, or a \" or \\ inside text that isn't written as \\\" or \\\\.";
}

async function buildQuiz(entry, dir, images) {
    const folderName = dir.split("/").pop();
    const r = { kind: "quiz", name: folderName || "Imported quiz", errors: [], warnings: [] };
    // Picked as loose files there's no folder name; without a "title" each import gets its own name
    r.genericName = !folderName;
    const text = stripBom(await entry.file.text());
    let data;
    try { data = JSON.parse(text); }
    catch (err) { r.errors.push(jsonErrorMessage(err, text)); return r; }
    if (data && !Array.isArray(data) && typeof data.title === "string" && data.title.trim()) {
        r.name = data.title.trim();
        r.genericName = false;
    }
    if (r.genericName) r.warnings.push('Tip: add a "title" to questions.json (see the guide) to name this quiz; re-importing a titled quiz then updates it instead of adding a copy.');
    const prefix = dir ? dir + "/" : "";
    const files = {};
    images.forEach(e => { files[e.path.slice(prefix.length)] = e.file; });
    const used = validateQuestions(data, files, r);
    // Keep only images a question uses, stored with an image type taken from the extension
    const stored = {};
    Object.entries(files).forEach(([path, file]) => {
        if (used.has(path.toLowerCase()) || used.has(path.toLowerCase().split("/").pop()))
            stored[path] = new Blob([file], { type: IMAGE_TYPES[extOf(path)] });
    });
    const list = questionList(data);
    r.record = { kind: "quiz", name: r.name, text, files: stored, count: list ? list.length : 0 };
    return r;
}

// Checks every question against the format the quiz page expects; returns the image names used
function validateQuestions(data, files, r) {
    const used = new Set();
    const list = questionList(data);
    if (!list) {
        r.errors.push('The file must contain a list of questions, [ { ... }, { ... } ], or { "title": "...", "questions": [ ... ] }.');
        return used;
    }
    if (!list.length) { r.errors.push("The list of questions is empty."); return used; }
    const have = new Set(Object.keys(files).flatMap(k => [k.toLowerCase(), k.toLowerCase().split("/").pop()]));
    const ids = new Set();
    const text = v => typeof v === "string" && v.trim() !== "";
    let noExplanation = 0, noHint = 0, missingImages = 0;
    list.forEach((q, i) => {
        const where = `Question ${i + 1}` + (q && typeof q === "object" && q.id !== undefined ? ` (id ${JSON.stringify(q.id)})` : "");
        const err = m => r.errors.push(`${where}: ${m}`);
        if (!q || typeof q !== "object" || Array.isArray(q)) { err("must be an object written as { ... }."); return; }
        if (typeof q.id !== "number") err('needs a number "id", e.g. "id": 1.');
        else if (ids.has(q.id)) err(`"id" ${q.id} is used by more than one question.`);
        else ids.add(q.id);
        if (!text(q.question)) err('needs "question" text.');
        ["explanation", "hint", "figure", "lecture"].forEach(k => {
            if (q[k] !== undefined && typeof q[k] !== "string") err(`"${k}" must be text in quotes.`);
        });
        if (q.fixed_order !== undefined && typeof q.fixed_order !== "boolean") err('"fixed_order" must be true or false (no quotes).');
        if (!q.explanation) noExplanation++;
        if (!q.hint) noHint++;
        if (q.images !== undefined) {
            if (!Array.isArray(q.images) || !q.images.every(text)) err('"images" must be a list of file names, e.g. ["diagram.png"].');
            else q.images.forEach(f => {
                const key = f.replace(/^\.\//, "").toLowerCase();
                used.add(key);
                if (!IMAGE_TYPES[extOf(key)]) err(`image "${f}" isn't a supported type (use ${Object.keys(IMAGE_TYPES).join(", ")}).`);
                else if (!have.has(key) && !have.has(key.split("/").pop())) { err(`image "${f}" wasn't found.`); missingImages++; }
            });
        }
        if (q.type === "multiple_choice") {
            const opts = q.options;
            if (!opts || typeof opts !== "object" || Array.isArray(opts) || !Object.keys(opts).length) {
                err('needs "options", e.g. { "A": "first choice", "B": "second choice" }.');
                return;
            }
            if (!Object.values(opts).every(v => typeof v === "string")) err("every option must be text in quotes.");
            const keys = Object.keys(opts);
            const answers = Array.isArray(q.answer) ? q.answer : [q.answer];
            if (!answers.length || !answers.every(a => typeof a === "string"))
                err('"answer" must be one option letter like "B", or a list like ["A", "C"] for select-all-that-apply.');
            else answers.filter(a => !keys.includes(a))
                .forEach(a => err(`"answer" "${a}" isn't one of the options (${keys.join(", ")}).`));
        } else if (q.type === "matching") {
            if (!Array.isArray(q.prompts) || !q.prompts.length || !q.prompts.every(text)) {
                err('needs "prompts": a list of the items to match, e.g. ["Router 3c", "Router 3a"].');
                return;
            }
            if (!Array.isArray(q.answer) || q.answer.length !== q.prompts.length || !q.answer.every(text)) {
                err(`"answer" must be a list of ${q.prompts.length} text item(s): the correct choice for each prompt, in the same order.`);
                return;
            }
            if (q.choices !== undefined) {
                if (!Array.isArray(q.choices) || !q.choices.every(text)) { err('"choices" must be a list of text items.'); return; }
                q.answer.forEach((a, k) => {
                    if (!q.choices.includes(a)) err(`the answer for prompt ${k + 1} ("${a}") must match one of the "choices" exactly.`);
                });
            }
        } else if (q.type === "short_answer") {
            if (!text(q.answer)) err('needs a sample "answer" (shown after answering).');
            if (!Array.isArray(q.keywords) || !q.keywords.length || !q.keywords.every(text))
                err('needs "keywords": a list of words or phrases that count as correct, e.g. ["B", "7"].');
        } else {
            err(`"type" must be "multiple_choice", "matching" or "short_answer"` +
                (q.type === undefined ? " (it's missing)." : ` (found ${JSON.stringify(q.type)}).`));
        }
    });
    if (missingImages) r.errors.push("Images go in the same folder as questions.json (or a folder inside it) and must be included when importing: pick the whole folder, or select the images along with questions.json. Names must match, including spaces.");
    if (noExplanation) r.warnings.push(`${noExplanation} question(s) have no "explanation", so only the correct answer is shown after submitting.`);
    if (noHint) r.warnings.push(`${noHint} question(s) have no "hint", so the Show Hint button is hidden for them.`);
    const unused = Object.keys(files).filter(k => !used.has(k.toLowerCase()) && !used.has(k.toLowerCase().split("/").pop()));
    if (unused.length) r.warnings.push(`${unused.length} image(s) aren't used by any question and weren't saved: ${unused.join(", ")}.`);
    return used;
}

async function buildDeck(entry) {
    const text = stripBom(await entry.file.text());
    const r = { kind: "flashcards", name: entry.file.name.replace(/\.(txt|tsv)$/i, "") || "Imported deck", errors: [], warnings: [] };
    const cards = parseFlashcards(text);
    r.cardCount = cards.length;
    const lines = text.split(/\r?\n/);
    const skipped = [];
    lines.forEach((l, i) => { if (l.trim() && !l.trim().includes("\t")) skipped.push(i + 1); });
    const lineList = nums => nums.slice(0, 10).join(", ") + (nums.length > 10 ? `, … (${nums.length} in all)` : "");
    if (!cards.length) {
        r.errors.push(`${entry.path}: no cards found. Each line must be the term, one Tab character, then the definition.` +
            (/ {2,}/.test(text) ? " This file has runs of spaces where Tabs may have been expected; some editors turn Tab into spaces." : ""));
        return r;
    }
    if (skipped.length) r.warnings.push(`${skipped.length} line(s) have no Tab and were skipped: line ${lineList(skipped)}.`);
    const blank = cards.map((c, i) => (!c.term || !c.definition) ? i + 1 : 0).filter(Boolean);
    if (blank.length) r.warnings.push(`${blank.length} card(s) have an empty term or definition.`);
    const seen = new Set(), dupes = new Set();
    cards.forEach(c => { if (seen.has(c.term)) dupes.add(c.term); seen.add(c.term); });
    if (dupes.size) r.warnings.push(`Some terms appear more than once and will share a star: ${[...dupes].slice(0, 5).join(", ")}${dupes.size > 5 ? ", …" : ""}.`);
    r.record = { kind: "flashcards", name: r.name, text, files: {}, count: cards.length };
    return r;
}

// Saves a checked set (replacing an earlier import of the same name and kind)
async function saveImport(r) {
    const recs = [...importedRecords.values()];
    const taken = name => recs.some(x => x.kind === r.record.kind && x.name.toLowerCase() === name.toLowerCase());
    if (r.genericName) {
        // "Imported quiz", "Imported quiz 2", ...: never replaces an earlier untitled import
        let n = 1, name = r.record.name;
        while (taken(name)) name = `${r.record.name} ${++n}`;
        r.record.name = r.name = name;
    }
    const old = recs.find(x => x.kind === r.record.kind && x.name.toLowerCase() === r.record.name.toLowerCase());
    const id = old ? old.id
        : (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    const rec = { ...r.record, id, importedAt: Date.now() };
    r.replaced = !!old;
    try {
        await dbRun("readwrite", s => s.put(rec));
    } catch (err) {
        r.warnings.push(err && err.name === "QuotaExceededError"
            ? "There isn't enough browser storage to keep this set, so it will be gone after you reload the page."
            : "This browser isn't letting the page save data (private browsing?), so this set will be gone after you reload the page.");
    }
    registerImported(rec);
    r.dir = setEntry(rec).dir;
}

async function handleImport(entries) {
    const box = document.getElementById("import-results");
    box.innerHTML = `<p class="text-sm text-slate-400">Reading files…</p>`;
    let results;
    try { results = await buildImports(entries); }
    catch (err) { results = [{ name: "Import failed", errors: [`Couldn't read the files (${err.message}).`], warnings: [] }]; }
    const ok = results.filter(r => !r.errors.length && r.record);
    for (const r of ok) await saveImport(r);
    if (ok.length && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    buildSetSelect();
    // Open the first new set behind the dialog so it's ready when the dialog closes
    if (ok.length) switchSet(ok[0].dir);
    renderImportResults(results);
    renderImportList();
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function issueList(items, color) {
    const ul = el("ul", `list-disc pl-5 space-y-1 text-xs ${color}`);
    items.slice(0, 25).forEach(m => ul.appendChild(el("li", "", m)));
    if (items.length > 25) ul.appendChild(el("li", "", `…and ${items.length - 25} more.`));
    return ul;
}

function renderImportResults(results) {
    const box = document.getElementById("import-results");
    box.innerHTML = "";
    results.forEach(r => {
        const failed = r.errors.length > 0;
        const card = el("div", `rounded-lg border p-3 flex flex-col gap-2 ${failed ? "border-rose-600/40 bg-rose-950/20" : "border-emerald-600/40 bg-emerald-950/20"}`);
        const head = el("div", "flex flex-wrap items-center justify-between gap-2");
        const kind = r.kind === "flashcards" ? "flashcards" : r.kind === "quiz" ? "quiz" : "";
        head.appendChild(el("span", `text-sm font-semibold ${failed ? "text-rose-300" : "text-emerald-300"}`,
            `${failed ? "✗" : "✓"} ${r.name}${kind ? ` (${kind})` : ""}`));
        const status = failed ? "Not imported. Fix the problems below and import again."
            : `${r.replaced ? "Updated" : "Imported"}: ${r.record.count} ${r.kind === "flashcards" ? "card" : "question"}${r.record.count === 1 ? "" : "s"}`;
        head.appendChild(el("span", "text-xs text-slate-400", status));
        card.appendChild(head);
        if (r.errors.length) card.appendChild(issueList(r.errors, "text-rose-300"));
        if (r.warnings.length) card.appendChild(issueList(r.warnings, "text-amber-300"));
        box.appendChild(card);
    });
}

function renderImportList() {
    const list = document.getElementById("import-list");
    list.innerHTML = "";
    const recs = [...importedRecords.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!recs.length) { list.appendChild(el("li", "text-sm text-slate-500", "None yet.")); return; }
    recs.forEach(rec => {
        const dir = setEntry(rec).dir;
        const li = el("li", "flex flex-wrap items-center gap-2 p-2 rounded-lg bg-slate-900/50 border border-slate-700");
        const info = el("div", "flex-1 min-w-0");
        info.appendChild(el("div", "text-sm text-slate-200 truncate", rec.name));
        info.appendChild(el("div", "text-xs text-slate-500",
            `${rec.kind === "flashcards" ? "Flashcards" : "Quiz"} • ${rec.count || 0} ${rec.kind === "flashcards" ? "cards" : "questions"}` +
            (dir === currentDir ? " • open now" : "")));
        li.appendChild(info);
        const open = el("button", "bg-slate-700 hover:bg-slate-600 px-3 py-2 rounded-md text-xs font-medium", "Open");
        open.type = "button";
        open.onclick = () => { switchSet(dir); closeImportDialog(); };
        const remove = el("button", "bg-rose-900/50 hover:bg-rose-800/60 text-rose-200 px-3 py-2 rounded-md text-xs font-medium", "Remove");
        remove.type = "button";
        remove.onclick = () => removeImport(rec.id);
        li.append(open, remove);
        list.appendChild(li);
    });
}

async function removeImport(id) {
    const rec = importedRecords.get(id);
    if (!rec || !confirm(`Remove "${rec.name}" from this browser? This can't be undone (you can import it again).`)) return;
    try { await dbRun("readwrite", s => s.delete(id)); } catch { /* storage unavailable */ }
    importedRecords.delete(id);
    const entry = setEntry(rec);
    QUIZ_SETS.splice(QUIZ_SETS.findIndex(s => s.dir === entry.dir), 1);
    try { localStorage.removeItem(`ccn-starred:${entry.dir}${entry.file}`); } catch { /* storage unavailable */ }
    if (currentDir === entry.dir) switchSet(QUIZ_SETS[0].dir);
    buildSetSelect();
    renderImportList();
}

const importDialogOpen = () => document.getElementById("import-dialog").classList.contains("open");
function openImportDialog() {
    document.getElementById("import-results").innerHTML = "";
    renderImportList();
    document.getElementById("import-dialog").classList.add("open");
    document.getElementById("import-folder-btn").focus();
}
function closeImportDialog() {
    document.getElementById("import-dialog").classList.remove("open");
    document.getElementById("set-select").focus();
}

function setupImport() {
    ["import-folder", "import-files"].forEach(id => {
        const input = document.getElementById(id);
        input.addEventListener("change", () => {
            const entries = [...input.files].map(file => ({ path: file.webkitRelativePath || file.name, file }));
            input.value = "";
            if (entries.length) handleImport(entries);
        });
    });
    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && importDialogOpen()) closeImportDialog();
    });
    // Files or folders can be dropped anywhere on the page
    const zone = document.getElementById("import-drop");
    let dragTimer = null;
    const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    window.addEventListener("dragover", e => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        zone.classList.add("drop-active");
        clearTimeout(dragTimer);
        dragTimer = setTimeout(() => zone.classList.remove("drop-active"), 150);
    });
    window.addEventListener("drop", e => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        zone.classList.remove("drop-active");
        if (!importDialogOpen()) openImportDialog();
        const pending = entriesFromDrop(e.dataTransfer);
        pending.then(entries => { if (entries.length) handleImport(entries); })
            .catch(err => renderImportResults([{ name: "Import failed", errors: [`Couldn't read the dropped files (${err.message}).`], warnings: [] }]));
    });
}
// ---------- End imported sets ----------
