// Flashcard mode: loading a deck, flipping, stars, settings, swiping and keyboard controls.

// ---------- Flashcards ----------
let originalCards = [];

let cards = [];
let cardIndex = 0;
let definitionFirst = true;

// ---------- Saved settings ----------
// Flashcard settings ("Show definition first", "Starred only") are remembered in this browser
const SETTINGS_KEY = "ccn-flashcard-settings";
function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {}; }
    catch { return {}; }
}
function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ definitionFirst, starredOnly })); }
    catch { /* storage unavailable */ }
}
// ---------- End saved settings ----------

// ---------- Starred cards ----------
// Stars are remembered per deck in this browser, keyed by the card's term
let starred = new Set();
let starredOnly = false;
let starKey = "";

function loadStars(set) {
    starKey = `ccn-starred:${set.dir}${set.file}`;
    try { starred = new Set(JSON.parse(localStorage.getItem(starKey) || "[]")); }
    catch { starred = new Set(); }
}
function saveStars() {
    try { localStorage.setItem(starKey, JSON.stringify([...starred])); } catch { /* storage unavailable */ }
}

// Rebuilds the visible deck from the full deck: optionally only starred cards, optionally shuffled
function rebuildDeck() {
    // Every starred card was unstarred mid-pass: fall back to the whole deck
    if (starredOnly && !originalCards.some(c => starred.has(c.term))) starredOnly = false;
    const base = starredOnly ? originalCards.filter(c => starred.has(c.term)) : [...originalCards];
    cards = shuffled ? randomOrder(base.length).map(i => base[i]) : base;
    updateStarUI();
    showCard(0);
}

function toggleStarredOnly(checked) {
    starredOnly = checked;
    saveSettings();
    rebuildDeck();
}

// Unstarring a card while studying starred cards keeps it in the current pass;
// it drops out the next time the deck is rebuilt (shuffle, toggle, reload)
function toggleStar(e) {
    if (e) e.stopPropagation(); // don't flip the card
    const card = cards[cardIndex];
    if (!card) return;
    if (starred.has(card.term)) starred.delete(card.term); else starred.add(card.term);
    saveStars();
    updateStarUI();
}

function updateStarUI() {
    const card = cards[cardIndex];
    const on = !!card && starred.has(card.term);
    document.querySelectorAll(".fc-star").forEach(btn => {
        btn.setAttribute("aria-pressed", String(on));
        btn.setAttribute("aria-label", on ? "Unstar this card" : "Star this card");
        btn.title = on ? "Unstar this card (S)" : "Star this card (S)";
    });
    const count = originalCards.filter(c => starred.has(c.term)).length;
    document.getElementById("fc-starred-count").innerText = count;
    const box = document.getElementById("fc-starred-only");
    box.checked = starredOnly;
    // Can't switch into starred-only with nothing starred (but can always switch out)
    box.disabled = !starredOnly && count === 0;
    document.getElementById("fc-starred-label").classList.toggle("opacity-50", box.disabled);
    document.getElementById("fc-starred-label").title = box.disabled ? "Star some cards first" : "";
    if (mode === "flashcards") {
        document.getElementById("score-display").innerText =
            `${originalCards.length} cards` + (count ? ` • ${count} ★` : "");
    }
}
// ---------- End starred cards ----------

function parseFlashcards(text) {
    return text.split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && line.includes("\t"))
        .map(line => {
            const tab = line.indexOf("\t");
            return { term: line.slice(0, tab).trim(), definition: line.slice(tab + 1).trim() };
        });
}

async function loadFlashcards(set) {
    setMode("flashcards");
    try {
        let text;
        if (set.imported) {
            text = importedRecords.get(idFromDir(set.dir)).text;
        } else {
            const response = await fetch(set.dir + set.file);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            text = await response.text();
        }
        cards = parseFlashcards(text);
        if (!cards.length) throw new Error("no tab-separated cards found");
    } catch (err) {
        cards = [{ term: "Could not load flashcards",
            definition: set.imported
                ? `This imported deck couldn't be read (${err.message}). Try importing it again.`
                : `${set.dir}${set.file}: ${err.message}. Serve this folder with a local web server (e.g. python -m http.server).` }];
    }
    originalCards = [...cards];
    loadStars(set);
    // Restore saved settings (starred-only falls back to all cards if none are starred)
    const saved = loadSettings();
    if (typeof saved.definitionFirst === "boolean") definitionFirst = saved.definitionFirst;
    starredOnly = saved.starredOnly === true;
    document.getElementById("fc-def-first").checked = definitionFirst;
    rebuildDeck();
}

function showCard(index) {
    cardIndex = Math.max(0, Math.min(cards.length - 1, Number(index)));
    const card = cards[cardIndex];
    const cardEl = document.getElementById("fc-card");
    // Jump back to the starting side without animating the flip
    const animated = [cardEl, ...cardEl.querySelectorAll(".fc-face")];
    animated.forEach(el => { el.style.transition = "none"; });
    cardEl.classList.remove("flipped");
    void cardEl.offsetWidth;
    animated.forEach(el => { el.style.transition = ""; });

    const front = document.getElementById("fc-front");
    const back = document.getElementById("fc-back");
    front.textContent = definitionFirst ? card.definition : card.term;
    back.textContent = definitionFirst ? card.term : card.definition;
    // Size text by what it is (short term = big, long definition = smaller), whichever side it's on
    front.className = `${FC_TEXT_BASE} ${definitionFirst ? FC_DEF_TEXT : FC_TERM_TEXT}`;
    back.className = `${FC_TEXT_BASE} ${definitionFirst ? FC_TERM_TEXT : FC_DEF_TEXT}`;
    document.getElementById("fc-front-label").innerText = definitionFirst ? "Definition" : "Term";
    document.getElementById("fc-back-label").innerText = definitionFirst ? "Term" : "Definition";
    document.getElementById("fc-counter").innerText = `Card ${cardIndex + 1} of ${cards.length}`;
    document.getElementById("progress-text").innerText = `Card ${cardIndex + 1} of ${cards.length}`;
    document.getElementById("progress-bar").style.width = `${((cardIndex + 1) / cards.length) * 100}%`;
    const track = document.getElementById("progress-track");
    track.setAttribute("aria-valuemax", cards.length);
    track.setAttribute("aria-valuenow", cardIndex + 1);
    track.setAttribute("aria-valuetext", `Card ${cardIndex + 1} of ${cards.length}`);
    document.getElementById("fc-prev").disabled = cardIndex === 0;
    document.getElementById("fc-next").disabled = cardIndex === cards.length - 1;
    updateStarUI();
}

function flipCard() { document.getElementById("fc-card").classList.toggle("flipped"); }

// ---------- Slide animation between cards ----------
// The whole scene slides (not #fc-card itself, whose transform is used by the flip)
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const SLIDE_OUT = (dir, from) => [
    { transform: from || "none", opacity: 1 },
    { transform: `translateX(${-dir * 110}%) rotate(${-dir * 8}deg)`, opacity: 0 }
];
const SLIDE_IN = dir => [
    { transform: `translateX(${dir * 60}%) rotate(${dir * 5}deg) scale(0.92)`, opacity: 0 },
    { transform: "none", opacity: 1 }
];

function sceneEl() { return document.querySelector("#flashcard-view .fc-scene"); }

// dir: +1 = moving forward (old card leaves to the left), -1 = moving back
function slideToCard(index, dir, fromTransform) {
    const scene = sceneEl();
    if (reduceMotion.matches || !scene.animate) { scene.style.transform = ""; showCard(index); return; }
    const busy = scene.getAnimations().length > 0;
    scene.getAnimations().forEach(a => a.cancel());
    const target = Math.max(0, Math.min(cards.length - 1, index));
    cardIndex = target; // update now so rapid taps keep advancing

    const slideIn = () => {
        scene.style.transform = "";
        showCard(target);
        scene.animate(SLIDE_IN(dir), { duration: 280, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    };
    // If a slide is already running, skip straight to bringing in the new card
    if (busy && !fromTransform) { slideIn(); return; }

    const out = scene.animate(SLIDE_OUT(dir, fromTransform), { duration: 180, easing: "ease-in", fill: "forwards" });
    out.finished.then(() => { out.cancel(); slideIn(); }).catch(() => {});
}

// Card bounces back to the centre (end of a short drag, or swiping past the first/last card)
function snapBack(fromTransform) {
    const scene = sceneEl();
    scene.style.transform = "";
    if (!fromTransform || reduceMotion.matches || !scene.animate) return;
    scene.animate([{ transform: fromTransform }, { transform: "none" }],
        { duration: 300, easing: "cubic-bezier(0.3, 1.4, 0.5, 1)" });
}

// Swipe left = next card, right = previous card; the card follows the finger while dragging.
// A tap (no real movement) still flips it.
let touchStart = null;
let dragging = false;
let swipedRecently = false;
function onCardClick() {
    if (swipedRecently) { swipedRecently = false; return; }
    flipCard();
}
function dragTransform(dx) {
    // Resist the drag when there's no card in that direction
    const atEdge = (dx < 0 && cardIndex >= cards.length - 1) || (dx > 0 && cardIndex <= 0);
    const x = atEdge ? dx * 0.25 : dx;
    return `translateX(${x}px) rotate(${x / 25}deg)`;
}
(function setupSwipe() {
    const el = document.getElementById("fc-card");
    el.addEventListener("touchstart", e => {
        const t = e.changedTouches[0];
        touchStart = { x: t.clientX, y: t.clientY };
        dragging = false;
        sceneEl().getAnimations().forEach(a => a.finish());
    }, { passive: true });
    el.addEventListener("touchmove", e => {
        if (!touchStart) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - touchStart.x;
        const dy = t.clientY - touchStart.y;
        // Decide once whether this is a horizontal drag; vertical moves stay as scrolling
        if (!dragging) {
            if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy)) return;
            dragging = true;
        }
        // Once it's a sideways drag, keep the browser from also moving anything vertically
        if (e.cancelable) e.preventDefault();
        if (!reduceMotion.matches) sceneEl().style.transform = dragTransform(dx);
    }, { passive: false });
    const end = e => {
        if (!touchStart) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - touchStart.x;
        const dy = t.clientY - touchStart.y;
        touchStart = null;
        const current = sceneEl().style.transform;
        if (!dragging) return;
        dragging = false;
        // Any real drag shouldn't also count as a tap-to-flip
        swipedRecently = true;
        setTimeout(() => { swipedRecently = false; }, 400);
        const dir = dx < 0 ? 1 : -1;
        const canMove = dir > 0 ? cardIndex < cards.length - 1 : cardIndex > 0;
        if (e.type === "touchend" && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && canMove) {
            slideToCard(cardIndex + dir, dir, current);
        } else {
            snapBack(current);
        }
    };
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", end, { passive: true });
})();

function nextCard() { if (cardIndex < cards.length - 1) slideToCard(cardIndex + 1, 1); }
function prevCard() { if (cardIndex > 0) slideToCard(cardIndex - 1, -1); }
// ---------- End slide animation ----------

const FC_TEXT_BASE = "flex-1 flex items-center justify-center text-center text-slate-100 overflow-y-auto";
const FC_TERM_TEXT = "text-3xl md:text-4xl font-semibold";
const FC_DEF_TEXT = "text-xl md:text-2xl leading-relaxed";

// ---------- Mobile settings sheet ----------
function openSettings() {
    document.getElementById("fc-settings").classList.add("open");
    document.querySelector("#fc-settings button").focus();
}
function closeSettings() {
    document.getElementById("fc-settings").classList.remove("open");
    document.getElementById("fc-settings-btn").focus();
}
// ---------- End mobile settings sheet ----------

function toggleDefinitionFirst(checked) {
    definitionFirst = checked;
    saveSettings();
    showCard(cardIndex);
}

document.addEventListener("keydown", e => {
    if (mode !== "flashcards" || importDialogOpen()) return;
    if (document.getElementById("fc-settings").classList.contains("open")) {
        if (e.key === "Escape") closeSettings();
        return;
    }
    const tag = (e.target.tagName || "").toLowerCase();
    if (["textarea", "select", "input"].includes(tag) && e.target.type !== "range" && e.target.type !== "checkbox") return;
    if (e.key === "ArrowRight") { e.preventDefault(); nextCard(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); prevCard(); }
    else if (e.key === " " || e.key === "Enter" || e.key === "ArrowUp") {
        // Let Space/Enter activate a focused button (e.g. the star) instead of flipping
        if (tag === "button" && e.key !== "ArrowUp") return;
        e.preventDefault(); flipCard();
    }
    else if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); toggleStar(); }
});
// ---------- End flashcards ----------
