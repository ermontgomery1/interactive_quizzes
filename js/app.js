// Ties the page together: the list of sets, switching between them, the shared header
// controls (Shuffle, Restart) and the progress bar. Loaded last; starts the app on load.

// Each quiz set is a folder containing questions.json and any images it references.
// Flashcard decks (kind: "flashcards") point at a text file with one "term<TAB>definition" per line.
const QUIZ_SETS = [
    { dir: "quiz5/", name: "Quiz 5 (Routing)" },
    { dir: "quiz6/", name: "Quiz 6 (Link Layer & MAC)" },
    { dir: "quiz7/", name: "Quiz 7 (ARP, Switches & VLANs)" },
    { dir: "flashcards/", file: "flashcards.txt", kind: "flashcards", name: "Flashcards (Quizzes 5–7)" }
];
let mode = "quiz";

let DATA_DIR = QUIZ_SETS[0].dir;   // folder (or local:<id>/) of the open set, for its images
let currentDir = "";                // value of the open set in the set dropdown

// ---------- Shuffle ----------
let shuffled = false;

function updateShuffleButton() {
    const btn = document.getElementById("shuffle-btn");
    btn.innerText = shuffled ? "Unshuffle" : "Shuffle";
    btn.setAttribute("aria-pressed", String(shuffled));
    btn.classList.toggle("bg-indigo-600", shuffled);
    btn.classList.toggle("hover:bg-indigo-500", shuffled);
    btn.classList.toggle("bg-slate-700", !shuffled);
    btn.classList.toggle("hover:bg-slate-600", !shuffled);
}

// Shuffles the current quiz or deck, or restores the original order if already shuffled.
// Quiz answers and score travel with their questions, so shuffling never loses progress.
function toggleShuffle() {
    shuffled = !shuffled;
    if (mode === "flashcards") rebuildDeck(); else shuffleQuestions();
    updateShuffleButton();
}

// ---------- End shuffle ----------

// Switches the page between quiz and flashcard layouts
function setMode(newMode) {
    mode = newMode;
    // Every newly loaded quiz or deck starts in its original order
    shuffled = false;
    updateShuffleButton();
    const flash = newMode === "flashcards";
    // Lock page scrolling while studying flashcards
    document.documentElement.classList.toggle("fc-mode", flash);
    const track = document.getElementById("progress-track");
    track.setAttribute("role", "slider");
    track.setAttribute("aria-label", flash ? "Jump to card" : "Jump to question");
    track.setAttribute("aria-valuemin", "1");
    track.tabIndex = 0;
    if (flash) window.scrollTo(0, 0);
    document.getElementById("flashcard-view").classList.toggle("hidden", !flash);
    document.getElementById("quiz-card").classList.toggle("hidden", flash);
    document.getElementById("nav-panel").classList.toggle("hidden", flash);
    // Answer shuffling only applies to quizzes
    document.getElementById("shuffle-answers-btn").classList.toggle("hidden", flash);
}

async function initApp() {
    updateShuffleAnswersButton();
    setupImport();
    await loadImportedSets();
    // A set can be preselected with ?set=quiz5 (imported sets use ?set=local:<id>)
    const requested = new URLSearchParams(location.search).get("set");
    const initial = QUIZ_SETS.find(s => s.dir.replace(/\/$/, "") === requested) || QUIZ_SETS[0];
    currentDir = initial.dir;
    buildSetSelect();
    loadSet(initial.dir);
}

function switchSet(dir) {
    if (dir === IMPORT_OPTION) {
        document.getElementById("set-select").value = currentDir;
        openImportDialog();
        return;
    }
    const url = new URL(location.href);
    url.searchParams.set("set", dir.replace(/\/$/, ""));
    history.replaceState(null, "", url);
    loadSet(dir);
}

// Opens a set: flashcard decks go to flashcards.js, quizzes to quizzes.js
function loadSet(dir) {
    const set = QUIZ_SETS.find(s => s.dir === dir);
    currentDir = dir;
    document.getElementById("set-select").value = dir;
    DATA_DIR = dir;
    prepareAssets(set);
    if (set && set.kind === "flashcards") loadFlashcards(set);
    else loadQuiz(set || { dir });
}

// The Restart button: back to the first card, or reset the quiz after confirming
function resetQuiz() {
    if (mode === "flashcards") showCard(0); else restartQuiz();
}

// ---------- Progress bar scrubber ----------
// Tap or drag along the progress bar to jump to a card or question; the bar fills up to the finger
(function setupScrubber() {
    const track = document.getElementById("progress-track");
    const bar = document.getElementById("progress-bar");
    let scrubbing = false;
    const flash = () => mode === "flashcards";
    const count = () => flash() ? cards.length : questions.length;
    const current = () => flash() ? cardIndex : currentIndex;
    const show = i => flash() ? showCard(i) : loadQuestion(i);
    const indexAt = x => {
        const r = track.getBoundingClientRect();
        const f = Math.min(1, Math.max(0, (x - r.left) / r.width));
        return Math.max(0, Math.min(count() - 1, Math.ceil(f * count()) - 1));
    };
    const move = e => { const i = indexAt(e.clientX); if (i !== current()) show(i); };
    track.addEventListener("pointerdown", e => {
        if (!count()) return;
        e.preventDefault();
        scrubbing = true;
        track.setPointerCapture(e.pointerId);
        bar.classList.add("scrubbing");
        if (flash()) {
            // Drop any card slide in progress so the jump shows immediately
            const scene = sceneEl();
            scene.getAnimations().forEach(a => a.cancel());
            scene.style.transform = "";
        }
        move(e);
    });
    // Quiz mode: arrow keys / Home / End on the focused bar (flashcards already use global arrow keys)
    track.addEventListener("keydown", e => {
        if (flash() || !questions.length) return;
        const last = questions.length - 1;
        const target = { ArrowRight: currentIndex + 1, ArrowUp: currentIndex + 1,
            ArrowLeft: currentIndex - 1, ArrowDown: currentIndex - 1, Home: 0, End: last }[e.key];
        if (target === undefined) return;
        e.preventDefault();
        const i = Math.max(0, Math.min(last, target));
        if (i !== currentIndex) loadQuestion(i);
    });
    track.addEventListener("pointermove", e => { if (scrubbing) move(e); });
    const end = () => { scrubbing = false; bar.classList.remove("scrubbing"); };
    track.addEventListener("pointerup", end);
    track.addEventListener("pointercancel", end);
    track.addEventListener("lostpointercapture", end);
})();
// ---------- End progress bar scrubber ----------

window.onload = initApp;
